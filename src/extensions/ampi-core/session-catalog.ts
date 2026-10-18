import path from "node:path";
import { getAgentDir, SessionManager, type SessionEntry, type SessionInfo } from "@earendil-works/pi-coding-agent";

/**
 * Read-only catalogue of the local Pi sessions on disk, shared by every
 * extension that lists, resolves or inspects sessions. It reads through
 * Pi's own `SessionManager` and never writes a session file.
 *
 * - {@link createMmrPiSessionSource} lists every session across all project
 *   cwds (every encoded-cwd directory under `~/.pi/agent/sessions/`) and
 *   opens one by path.
 * - {@link createMmrSessionIndex} layers a lazy enrichment cache on top of a
 *   source. It only opens a session and walks its entries when an
 *   enrichment that needs per-entry inspection (`getTouchedFiles`,
 *   `getMetadata`) is requested; plain listing never opens a session. The
 *   index holds a single global TTL cache rather than a per-cwd one.
 * - {@link resolveMmrSessionById} and {@link dedupeMmrSessionsById} turn a
 *   listing into one session per id.
 * - {@link listMmrSessionsInScope} lists the sessions of the current
 *   working directory, or of all of them, the way Pi's own session picker
 *   does.
 *
 * Cache invalidation:
 * - global list cache: invalidated when the set of
 *   `id|modified|messageCount|path|cwd` tuples changes, or when its short TTL
 *   expires.
 * - per-session enrichment cache: keyed by `id|modified|messageCount|path|cwd`,
 *   so modified or moved sessions evict naturally on the next list.
 *
 * No filesystem watchers, no persisted state, no cross-process cache.
 */

export interface MmrSessionSource {
  /** Enumerate every local Pi session across all project cwds. */
  listSessions(): Promise<SessionInfo[]>;
  openSession(path: string): SessionManager;
}

/** The default source: Pi's `SessionManager.listAll()` and `SessionManager.open(path)`. */
export function createMmrPiSessionSource(): MmrSessionSource {
  return {
    listSessions: () => SessionManager.listAll(),
    openSession: (path) => SessionManager.open(path),
  };
}

/** `workspace`: the sessions started in one working directory; `all`: every session. */
export type MmrSessionScope = "workspace" | "all";

/**
 * List the sessions Pi's own session picker shows, newest activity first:
 * those of the session manager's working directory, or every session for
 * `all`. A custom session directory (`--session-dir`, the `sessionDir`
 * setting) is followed the same way: `all` then lists that directory. A custom
 * directory placed directly in `<agentDir>/sessions` looks like Pi's default
 * layout, so `all` lists every directory there; the extension API offers no
 * check that tells the two apart.
 */
export function listMmrSessionsInScope(
  sessionManager: { getCwd(): string; getSessionDir(): string },
  scope: MmrSessionScope,
): Promise<SessionInfo[]> {
  const sessionDir = sessionManager.getSessionDir();
  if (scope === "workspace") return SessionManager.list(sessionManager.getCwd(), sessionDir);
  // Pi's default layout keeps one directory per working directory under
  // `<agentDir>/sessions`; any other directory is a custom one.
  const usesDefault = path.dirname(path.resolve(sessionDir)) === path.resolve(getAgentDir(), "sessions");
  return usesDefault ? SessionManager.listAll() : SessionManager.listAll(sessionDir);
}

export interface MmrSessionIndexDeps {
  /** Enumerate every local Pi session across all project cwds. */
  listSessions(): Promise<SessionInfo[]>;
  openSession(path: string): Pick<SessionManager, "getEntries">;
}

export interface MmrSessionMetadata {
  providers: ReadonlySet<string>;
  models: ReadonlySet<string>;
  tools: ReadonlySet<string>;
  labels: ReadonlySet<string>;
  hasTools: boolean;
  hasErrors: boolean;
}

export interface MmrSessionIndex {
  /** Delegates to the global session listing with a small TTL cache. */
  list(): Promise<SessionInfo[]>;
  /**
   * Return the set of files referenced by structured tool calls in the
   * given session. Paths are normalized to lowercase POSIX form,
   * cwd-relative when inside the session's own cwd; absolute paths
   * outside the session cwd are dropped. Bash stdout, prose, and
   * tool-result content are never parsed.
   */
  getTouchedFiles(info: SessionInfo): Promise<ReadonlySet<string>>;
  /** Structured per-entry metadata: providers, models, tools, labels, tool use and errors. */
  getMetadata(info: SessionInfo): Promise<MmrSessionMetadata>;
}

const DEFAULT_LIST_TTL_MS = 10_000;

interface GlobalCache {
  fingerprint: string;
  sessions: SessionInfo[];
  expiresAt: number;
  touched: Map<string, ReadonlySet<string>>;
  metadata: Map<string, MmrSessionMetadata>;
}

function sessionCacheKey(info: SessionInfo): string {
  return `${info.id}|${info.modified.toISOString()}|${info.messageCount}|${toPosix(info.path || "")}|${toPosix(info.cwd || "")}`;
}

function listFingerprint(sessions: readonly SessionInfo[]): string {
  return sessions.map(sessionCacheKey).sort().join("\n");
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

function isErrorLikeValue(value: unknown): boolean {
  return typeof value === "string" && /error|fail|cancel|abort/i.test(value);
}

function stripLeadingDot(value: string): string {
  return value.replace(/^(?:\.\/)+/, "");
}

/** Remove trailing `/` characters without an unanchored-quantifier regex. */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end--;
  return value.slice(0, end);
}

/**
 * Normalize a raw path argument seen in a tool call to a cwd-relative POSIX
 * string suitable for case-insensitive substring matching. Returns undefined
 * for paths that should be ignored (empty, outside cwd, non-string).
 */
export function normalizeTouchedPath(raw: unknown, cwd: string): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const posix = toPosix(trimmed);
  const cwdPosix = stripTrailingSlashes(toPosix(cwd));
  // Absolute path: must be inside session cwd to count as a touched file.
  if (/^([a-zA-Z]:)?\//.test(posix)) {
    if (!cwdPosix) return undefined;
    if (posix === cwdPosix) return undefined;
    const prefix = `${cwdPosix}/`;
    if (!posix.toLowerCase().startsWith(prefix.toLowerCase())) return undefined;
    return stripLeadingDot(posix.slice(prefix.length)).toLowerCase();
  }
  return stripLeadingDot(posix).toLowerCase();
}

const PATCH_HEADER_RE = /^\*\*\*\s+(?:Update|Add|Delete|Move)\s+File:\s*(.+?)\s*(?:->\s*(.+?)\s*)?$/gim;

function extractPatchPaths(patchText: unknown): string[] {
  if (typeof patchText !== "string" || !patchText) return [];
  const paths: string[] = [];
  for (const match of patchText.matchAll(PATCH_HEADER_RE)) {
    if (match[1]) paths.push(match[1]);
    if (match[2]) paths.push(match[2]);
  }
  return paths;
}

/**
 * Pull candidate path strings from a single structured tool-call argument
 * object. Only path-bearing tools that operate on one file are considered
 * (`read`/`edit`/`write`/`apply_patch`). Search-directory args from `grep` /
 * `find` are intentionally excluded: those are directories, not touched files,
 * and including them would create false-positive `file:` matches.
 */
export function collectToolCallPaths(toolName: string, args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const record = args as Record<string, unknown>;
  switch (toolName) {
    case "read":
    case "edit":
    case "write": {
      const path = typeof record.path === "string" ? record.path : typeof record.file_path === "string" ? record.file_path : undefined;
      return path ? [path] : [];
    }
    case "apply_patch":
      return extractPatchPaths(record.patchText ?? record.patch);
    default:
      return [];
  }
}

function addLowercase(out: Set<string>, value: unknown): void {
  if (typeof value === "string" && value.trim()) out.add(value.toLowerCase());
}

export function extractSessionMetadataFromEntries(entries: readonly SessionEntry[]): MmrSessionMetadata {
  const providers = new Set<string>();
  const models = new Set<string>();
  const tools = new Set<string>();
  const labels = new Set<string>();
  let hasTools = false;
  let hasErrors = false;

  for (const entry of entries) {
    if (entry.type === "model_change") {
      const record = entry as { provider?: unknown; modelId?: unknown };
      addLowercase(providers, record.provider);
      addLowercase(models, record.modelId);
      continue;
    }
    if (entry.type === "label") {
      addLowercase(labels, (entry as { label?: unknown }).label);
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!message || typeof message !== "object") continue;
    const msg = message as {
      role?: unknown;
      provider?: unknown;
      model?: unknown;
      toolName?: unknown;
      isError?: unknown;
      exitCode?: unknown;
      content?: unknown;
      stopReason?: unknown;
      errorMessage?: unknown;
      cancelled?: unknown;
    };
    addLowercase(providers, msg.provider);
    addLowercase(models, msg.model);
    if (msg.isError === true || msg.cancelled === true || isErrorLikeValue(msg.stopReason) || isErrorLikeValue(msg.errorMessage)) {
      hasErrors = true;
    }
    if (msg.role === "toolResult") {
      addLowercase(tools, msg.toolName);
      hasTools = true;
    } else if (msg.role === "bashExecution") {
      tools.add("bash");
      hasTools = true;
      if (typeof msg.exitCode === "number" && msg.exitCode !== 0) hasErrors = true;
    }
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || typeof block !== "object") continue;
        const blockRecord = block as { type?: unknown; name?: unknown };
        if (blockRecord.type !== "toolCall") continue;
        addLowercase(tools, blockRecord.name);
        hasTools = true;
      }
    }
  }

  return { providers, models, tools, labels, hasTools, hasErrors };
}

export function extractTouchedFilesFromEntries(entries: readonly SessionEntry[], cwd: string): Set<string> {
  const out = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!message || typeof message !== "object") continue;
    if ((message as { role?: string }).role !== "assistant") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const blockRecord = block as { type?: unknown; name?: unknown; arguments?: unknown };
      if (blockRecord.type !== "toolCall") continue;
      const name = typeof blockRecord.name === "string" ? blockRecord.name : "";
      if (!name) continue;
      for (const raw of collectToolCallPaths(name, blockRecord.arguments)) {
        const normalized = normalizeTouchedPath(raw, cwd);
        if (normalized) out.add(normalized);
      }
    }
  }
  return out;
}

export interface MmrSessionIndexOptions {
  /** TTL for the global session list cache, in milliseconds. Defaults to 10s. */
  listTtlMs?: number;
  /** Clock source for tests. */
  now?: () => number;
}

export function createMmrSessionIndex(deps: MmrSessionIndexDeps, options: MmrSessionIndexOptions = {}): MmrSessionIndex {
  const ttl = options.listTtlMs ?? DEFAULT_LIST_TTL_MS;
  const now = options.now ?? (() => Date.now());
  let cache: GlobalCache | undefined;

  async function refreshList(): Promise<GlobalCache> {
    const sessions = await deps.listSessions();
    const fingerprint = listFingerprint(sessions);
    if (cache && cache.fingerprint === fingerprint) {
      // Same content; just renew the TTL and reuse the touched cache.
      cache.sessions = sessions;
      cache.expiresAt = now() + ttl;
      return cache;
    }
    // Cache fingerprint change discards per-session touched-file
    // enrichment for every session, not just the changed ones.
    // Acceptable trade-off given the short TTL and small local scope;
    // revisit with per-session retention if `file:` query latency
    // becomes visible.
    cache = {
      fingerprint,
      sessions,
      expiresAt: now() + ttl,
      touched: new Map(),
      metadata: new Map(),
    };
    return cache;
  }

  async function getCache(): Promise<GlobalCache> {
    if (cache && cache.expiresAt > now()) return cache;
    return refreshList();
  }

  return {
    async list() {
      const cached = await getCache();
      return cached.sessions;
    },
    async getTouchedFiles(info) {
      const cached = await getCache();
      const key = sessionCacheKey(info);
      const cachedTouched = cached.touched.get(key);
      if (cachedTouched) return cachedTouched;
      const manager = deps.openSession(info.path);
      const touched = extractTouchedFilesFromEntries(manager.getEntries(), info.cwd || "");
      const frozen: ReadonlySet<string> = touched;
      cached.touched.set(key, frozen);
      return frozen;
    },
    async getMetadata(info) {
      const cached = await getCache();
      const key = sessionCacheKey(info);
      const cachedMetadata = cached.metadata.get(key);
      if (cachedMetadata) return cachedMetadata;
      const manager = deps.openSession(info.path);
      const metadata = extractSessionMetadataFromEntries(manager.getEntries());
      cached.metadata.set(key, metadata);
      return metadata;
    },
  };
}

/**
 * Dedupe by session id, keeping the newest mtime. A renamed encoded-cwd
 * directory or a moved session file can leave two physical paths for
 * the same logical session; only one should reach the result list.
 *
 * Tie-break order when two records share the same id is fully
 * deterministic across reordered fixture inputs and reshuffled
 * filesystem reads:
 *   1. higher `modified.getTime()` wins
 *   2. higher `created.getTime()` wins
 *   3. lower `path` (lexical ascending) wins
 *   4. lower `id` (lexical ascending) wins
 */
function preferDedupCandidate(a: SessionInfo, b: SessionInfo): SessionInfo {
  const dm = b.modified.getTime() - a.modified.getTime();
  if (dm !== 0) return dm > 0 ? b : a;
  const dc = b.created.getTime() - a.created.getTime();
  if (dc !== 0) return dc > 0 ? b : a;
  const dp = a.path.localeCompare(b.path);
  if (dp !== 0) return dp < 0 ? a : b;
  return a.id.localeCompare(b.id) <= 0 ? a : b;
}

/** One record per session id, in first-seen order; see {@link preferDedupCandidate} for which record wins. */
export function dedupeMmrSessionsById(sessions: readonly SessionInfo[]): SessionInfo[] {
  const byId = new Map<string, SessionInfo>();
  for (const session of sessions) {
    const existing = byId.get(session.id);
    byId.set(session.id, existing ? preferDedupCandidate(existing, session) : session);
  }
  return [...byId.values()];
}

export interface MmrResolvedSession {
  info: SessionInfo;
  ambiguous: boolean;
  candidateIds: string[];
}

/**
 * Resolve a session by exact id, `@id` or id prefix. An exact id wins; a
 * prefix shared by several sessions resolves to the first one and is flagged
 * `ambiguous` with every candidate id. Returns `undefined` for an empty id or
 * no match.
 */
export async function resolveMmrSessionById(
  source: Pick<MmrSessionSource, "listSessions">,
  sessionId: string,
  sessionIndex?: MmrSessionIndex,
): Promise<MmrResolvedSession | undefined> {
  const id = sessionId.trim().replace(/^@/, "");
  if (!id) return undefined;
  // Prefer the shared index so its TTL cache is honoured. Fall back to the
  // raw `source.listSessions()` for test/dependency-free paths.
  const raw = sessionIndex ? await sessionIndex.list() : await source.listSessions();
  const sessions = dedupeMmrSessionsById(raw);
  const exact = sessions.find((session) => session.id === id);
  if (exact) return { info: exact, ambiguous: false, candidateIds: [exact.id] };
  const matches = sessions.filter((session) => session.id.startsWith(id));
  if (matches.length === 0) return undefined;
  return {
    info: matches[0]!,
    ambiguous: matches.length > 1,
    candidateIds: matches.map((session) => session.id),
  };
}
