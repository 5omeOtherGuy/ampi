import type { SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import { createGitIdentityResolver, matchesRepoToken, type GitIdentityResolver, type RepoIdentity } from "./git-identity.js";
import { includesCaseInsensitive, parseSessionQuery, type SessionQuery } from "./query.js";
import { maybeRedact, projectRefFromCwd } from "./redaction.js";
import { createSessionIndex, type SessionIndex, type SessionIndexDeps, type SessionMetadata } from "./session-index.js";

export interface SessionCatalogDeps {
  /**
   * Enumerate every local Pi session across all project cwds. The
   * legacy current-project enumeration is gone: the catalog now reads
   * every encoded-cwd directory under `~/.pi/agent/sessions/`. Tests
   * may still supply a parameterless function that returns a curated
   * fixture list.
   */
  listSessions(): Promise<SessionInfo[]>;
  openSession(path: string): SessionManager;
  gitIdentity?: GitIdentityResolver;
}

export interface SessionSearchMatch {
  sessionId: string;
  /** Opaque 8-char hex hash of the session's project cwd. Never the raw cwd. */
  projectRef: string;
  name?: string;
  createdAt: string;
  modifiedAt: string;
  messageCount: number;
  firstMessage: string;
  preview: string;
  matchedTerms: string[];
  unsupportedFilters: string[];
}

export type QueryDiagnosticStatus = "applied" | "unsupported" | "non_applicable" | "invalid";

export interface QueryDiagnostic {
  filter: string;
  status: QueryDiagnosticStatus;
  reason?: string;
}

export interface SessionSearchResult {
  matches: SessionSearchMatch[];
  queryDiagnostics: QueryDiagnostic[];
  /** Total matches after filters, before pagination. */
  totalCount: number;
  /** Number of sorted matches skipped before `matches`. */
  offset: number;
  /** True when another page exists after this result page. */
  hasMore: boolean;
}

export interface ResolvedSession {
  info: SessionInfo;
  ambiguous: boolean;
  candidateIds: string[];
}

function sessionSearchText(info: SessionInfo): string {
  return [info.id, info.name ?? "", info.firstMessage, info.allMessagesText].join("\n");
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function buildPreview(info: SessionInfo, query: SessionQuery, redactionEnabled: boolean): string {
  const chunks = [info.firstMessage, ...info.allMessagesText.split(/\n{2,}/g)].map(compactWhitespace).filter(Boolean);
  const firstMatched = chunks.find((chunk) => query.terms.some((term) => includesCaseInsensitive(chunk, term)));
  const raw = (firstMatched ?? chunks[0] ?? "").slice(0, 280);
  return maybeRedact(raw, redactionEnabled);
}

function matchesLexical(info: SessionInfo, query: SessionQuery): string[] | undefined {
  if (query.id && !includesCaseInsensitive(info.id, query.id)) return undefined;
  if (query.name && !includesCaseInsensitive(info.name ?? "", query.name)) return undefined;
  if (query.modifiedAfter && info.modified < query.modifiedAfter) return undefined;
  if (query.modifiedBefore && info.modified > query.modifiedBefore) return undefined;
  if (query.createdAfter && info.created < query.createdAfter) return undefined;
  if (query.createdBefore && info.created > query.createdBefore) return undefined;
  const cwd = (info.cwd || "").toLowerCase();
  const projectRef = projectRefFromCwd(info.cwd || "").toLowerCase();
  if (!query.project.every((token) => cwd.includes(token) || projectRef.includes(token))) return undefined;
  if (!query.cwd.every((token) => cwd.includes(token))) return undefined;
  if (!query.projectRef.every((token) => projectRef.includes(token))) return undefined;

  const text = sessionSearchText(info);
  const matchedTerms = query.terms.filter((term) => includesCaseInsensitive(text, term));
  if (matchedTerms.length !== query.terms.length) return undefined;
  return matchedTerms;
}

function matchesSetValues(values: ReadonlySet<string>, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  if (values.size === 0) return false;
  for (const token of tokens) {
    let found = false;
    for (const value of values) {
      if (value.includes(token)) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

function matchesTouchedFiles(touched: ReadonlySet<string>, fileTokens: readonly string[]): boolean {
  return matchesSetValues(touched, fileTokens);
}

function matchesMetadata(metadata: SessionMetadata, query: SessionQuery): boolean {
  if (!matchesSetValues(metadata.providers, query.provider)) return false;
  if (!matchesSetValues(metadata.models, query.model)) return false;
  if (!matchesSetValues(metadata.tools, query.tool)) return false;
  if (!matchesSetValues(metadata.labels, query.label)) return false;
  for (const token of query.has) {
    if (token === "tools" && !metadata.hasTools) return false;
    if (token === "errors" && !metadata.hasErrors) return false;
  }
  return true;
}

function hasMetadataFilters(query: SessionQuery): boolean {
  return query.provider.length > 0 || query.model.length > 0 || query.tool.length > 0 || query.label.length > 0 || query.has.length > 0;
}

function metadataDiagnosticFilter(filter: string): boolean {
  return filter.startsWith("provider:") || filter.startsWith("model:") || filter.startsWith("tool:") || filter.startsWith("label:") || filter.startsWith("has:");
}

function buildQueryDiagnostics(query: SessionQuery, redactionEnabled: boolean): QueryDiagnostic[] {
  // Diagnostic filter strings are reproduced from user-typed query
  // tokens, which can carry secrets, home paths, or credentialed
  // URLs (e.g. `repo:https://user:tok@…`). When CONTENT redaction is
  // opted in, route every filter through the same deterministic
  // redaction the rest of the surface uses before it leaves the local
  // catalog. `project:` / `cwd:` are always redacted because the public
  // contract promises raw project roots are never surfaced. Idempotent.
  const diagnostics: QueryDiagnostic[] = [];
  for (const term of query.terms) diagnostics.push({ filter: maybeRedact(`keyword:${term}`, redactionEnabled), status: "applied" });
  for (const token of query.appliedFilterTokens) diagnostics.push({ filter: maybeRedact(token, redactionEnabled), status: "applied" });
  for (const token of query.fileTokens) diagnostics.push({ filter: maybeRedact(token, redactionEnabled), status: "applied" });
  for (const token of query.repoTokens) diagnostics.push({ filter: maybeRedact(token, redactionEnabled), status: "applied" });
  for (const token of query.projectTokens) diagnostics.push({ filter: maybeRedact(token, true), status: "applied" });
  for (const token of query.cwdTokens) diagnostics.push({ filter: maybeRedact(token, true), status: "applied" });
  for (const token of query.projectRefTokens) diagnostics.push({ filter: maybeRedact(token, redactionEnabled), status: "applied" });
  for (const token of query.providerTokens) diagnostics.push({ filter: maybeRedact(token, redactionEnabled), status: "applied" });
  for (const token of query.modelTokens) diagnostics.push({ filter: maybeRedact(token, redactionEnabled), status: "applied" });
  for (const token of query.toolTokens) diagnostics.push({ filter: maybeRedact(token, redactionEnabled), status: "applied" });
  for (const token of query.labelTokens) diagnostics.push({ filter: maybeRedact(token, redactionEnabled), status: "applied" });
  for (const token of query.hasTokens) diagnostics.push({ filter: maybeRedact(token, redactionEnabled), status: "applied" });
  for (const token of query.unsupportedFilters) diagnostics.push({ filter: maybeRedact(token, redactionEnabled), status: "unsupported" });
  // Invalid filters are recorded so the tool can tell the user the token was
  // ignored rather than silently dropping it.
  for (const token of query.invalidFilters) diagnostics.push({ filter: maybeRedact(token, redactionEnabled), status: "invalid" });
  return diagnostics;
}

function buildMatch(info: SessionInfo, query: SessionQuery, matchedTerms: string[], redactionEnabled: boolean): SessionSearchMatch {
  // `matchedTerms` and `unsupportedFilters` echo back substrings of
  // the user-typed query. When CONTENT redaction is opted in, route
  // each through the same deterministic redaction the rest of the
  // match shape uses so a sensitive token in the query cannot reappear
  // raw in the result. `projectRef` hashing is ALWAYS on regardless.
  return {
    sessionId: info.id,
    projectRef: projectRefFromCwd(info.cwd || ""),
    name: info.name ? maybeRedact(info.name, redactionEnabled) : undefined,
    createdAt: info.created.toISOString(),
    modifiedAt: info.modified.toISOString(),
    messageCount: info.messageCount,
    firstMessage: maybeRedact(compactWhitespace(info.firstMessage).slice(0, 280), redactionEnabled),
    preview: buildPreview(info, query, redactionEnabled),
    matchedTerms: matchedTerms.map((term) => maybeRedact(term, redactionEnabled)),
    unsupportedFilters: query.unsupportedFilters.map((token) => maybeRedact(token, redactionEnabled)),
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

function dedupeById(sessions: readonly SessionInfo[]): SessionInfo[] {
  const byId = new Map<string, SessionInfo>();
  for (const session of sessions) {
    const existing = byId.get(session.id);
    byId.set(session.id, existing ? preferDedupCandidate(existing, session) : session);
  }
  return [...byId.values()];
}

function defaultIndexFromCatalogDeps(deps: Pick<SessionCatalogDeps, "listSessions" | "openSession">): SessionIndex {
  const indexDeps: SessionIndexDeps = {
    listSessions: deps.listSessions,
    openSession: deps.openSession,
  };
  return createSessionIndex(indexDeps);
}

function promoteToNonApplicable(
  diagnostics: QueryDiagnostic[],
  predicate: (entry: QueryDiagnostic) => boolean,
  reason: string,
): void {
  for (const entry of diagnostics) {
    if (entry.status === "applied" && predicate(entry)) {
      entry.status = "non_applicable";
      entry.reason = reason;
    }
  }
}

export interface SearchSessionsOptions {
  /** Hard cap on returned matches. */
  limit: number;
  /** Number of sorted matches to skip before returning a page. */
  offset?: number;
  /** Clock source for relative date filters (e.g. `after:7d`). */
  now?: Date;
  /**
   * Optional shared {@link SessionIndex}. When omitted, a transient
   * index is built from `deps` only if `openSession` is available. The
   * default-deps factory in `tools.ts` caches a single index so the
   * built-in TTL actually engages in production.
   */
  index?: SessionIndex;
  /**
   * Opt-in CONTENT redaction toggle. When `true`, result strings
   * (names, previews, matched terms, diagnostics) are run through the
   * deterministic sanitizer. Omitted defaults to `true` (safe) for
   * direct callers/tests; the tools seam passes the resolved product
   * setting, whose default is OFF (raw). `projectRef` hashing is always
   * applied regardless of this flag.
   */
  redactionEnabled?: boolean;
}

/**
 * Search every local Pi session. The default lexical fast path uses
 * only `SessionInfo` fields and never opens individual sessions; the
 * keyword-only path therefore does no per-session I/O. When the query
 * contains `file:` tokens, the optional {@link SessionIndex} (default
 * built from `deps`) opens candidate sessions and inspects structured
 * tool-call arguments to derive each session's own touched-file set.
 *
 * For backwards compatibility this returns `SessionSearchMatch[]`.
 * Use {@link searchSessionsWithDiagnostics} to also retrieve
 * `queryDiagnostics`.
 */
export async function searchSessions(
  deps: Pick<SessionCatalogDeps, "listSessions"> & Partial<Pick<SessionCatalogDeps, "openSession">>,
  queryText: string,
  options: SearchSessionsOptions,
): Promise<SessionSearchMatch[]> {
  const result = await searchSessionsWithDiagnostics(deps, queryText, options);
  return result.matches;
}

export async function searchSessionsWithDiagnostics(
  deps: Pick<SessionCatalogDeps, "listSessions" | "gitIdentity"> & Partial<Pick<SessionCatalogDeps, "openSession">>,
  queryText: string,
  options: SearchSessionsOptions,
): Promise<SessionSearchResult> {
  const { limit, now = new Date(), index, redactionEnabled = true } = options;
  const query = parseSessionQuery(queryText, now);
  const requestedOffset = Math.max(0, Math.trunc(options.offset ?? query.offset));
  const diagnostics = buildQueryDiagnostics(query, redactionEnabled);

  const effectiveIndex: SessionIndex | undefined =
    index ?? (deps.openSession ? defaultIndexFromCatalogDeps(deps as SessionCatalogDeps) : undefined);
  const rawSessions = effectiveIndex ? await effectiveIndex.list() : await deps.listSessions();
  const sessions = dedupeById(rawSessions);

  const lexical = sessions
    .map((info) => ({ info, matchedTerms: matchesLexical(info, query) }))
    .filter((entry): entry is { info: SessionInfo; matchedTerms: string[] } => entry.matchedTerms !== undefined);

  let filtered = lexical;
  // `repo:` evaluation. Identity is resolved per candidate session's own
  // cwd; if no candidate yields an identity, the filter is `non_applicable`
  // for this query (zero matches, never a silent lexical fallthrough). A
  // single shared resolver is sufficient: it caches per cwd internally.
  if (query.repo.length > 0) {
    const resolver = deps.gitIdentity ?? createGitIdentityResolver();
    const identityCache = new Map<string, Promise<RepoIdentity | undefined>>();
    const resolveFor = (sessionCwd: string): Promise<RepoIdentity | undefined> => {
      const key = sessionCwd || "";
      if (!key) return Promise.resolve(undefined);
      let pending = identityCache.get(key);
      if (!pending) {
        pending = resolver.resolve(key).catch(() => undefined);
        identityCache.set(key, pending);
      }
      return pending;
    };
    const repoChecks = await Promise.all(
      filtered.map(async (entry) => {
        const identity = await resolveFor(entry.info.cwd ?? "");
        if (!identity) return { entry, identity: undefined, matched: false };
        const matched = query.repo.every((token) => matchesRepoToken(identity, token));
        return { entry, identity, matched };
      }),
    );
    const anyIdentity = repoChecks.some((check) => check.identity !== undefined);
    if (!anyIdentity) {
      promoteToNonApplicable(
        diagnostics,
        (entry) => entry.filter.startsWith("repo:"),
        "no candidate sessions have a resolvable repo identity",
      );
      return { matches: [], queryDiagnostics: diagnostics, totalCount: 0, offset: requestedOffset, hasMore: false };
    }
    filtered = repoChecks.filter((check) => check.matched).map((check) => check.entry);
  }

  if (query.file.length > 0) {
    if (!effectiveIndex) {
      // Cannot evaluate file: without an index. Fail closed, non_applicable.
      promoteToNonApplicable(
        diagnostics,
        (entry) => entry.filter.startsWith("file:"),
        "no session index available to evaluate file: filter",
      );
      return { matches: [], queryDiagnostics: diagnostics, totalCount: 0, offset: requestedOffset, hasMore: false };
    }
    const fileChecks = await Promise.all(
      filtered.map(async (entry) => {
        const touched = await effectiveIndex.getTouchedFiles(entry.info);
        return { entry, touched, matched: matchesTouchedFiles(touched, query.file) };
      }),
    );
    const anyTouched = fileChecks.some((check) => check.touched.size > 0);
    if (!anyTouched) {
      promoteToNonApplicable(
        diagnostics,
        (entry) => entry.filter.startsWith("file:"),
        "no candidate sessions carry structured tool-call evidence",
      );
      return { matches: [], queryDiagnostics: diagnostics, totalCount: 0, offset: requestedOffset, hasMore: false };
    }
    filtered = fileChecks.filter((check) => check.matched).map((check) => check.entry);
  }

  if (hasMetadataFilters(query)) {
    if (!effectiveIndex) {
      promoteToNonApplicable(
        diagnostics,
        (entry) => metadataDiagnosticFilter(entry.filter),
        "no session index available to evaluate metadata filters",
      );
      return { matches: [], queryDiagnostics: diagnostics, totalCount: 0, offset: requestedOffset, hasMore: false };
    }
    const metadataChecks = await Promise.all(
      filtered.map(async (entry) => {
        const metadata = await effectiveIndex.getMetadata(entry.info);
        return { entry, metadata, matched: matchesMetadata(metadata, query) };
      }),
    );
    const anyMetadata = metadataChecks.some(
      (check) => check.metadata.providers.size > 0 || check.metadata.models.size > 0 || check.metadata.tools.size > 0 || check.metadata.labels.size > 0 || check.metadata.hasTools || check.metadata.hasErrors,
    );
    if (!anyMetadata) {
      promoteToNonApplicable(
        diagnostics,
        (entry) => metadataDiagnosticFilter(entry.filter),
        "no candidate sessions carry structured metadata for these filters",
      );
      return { matches: [], queryDiagnostics: diagnostics, totalCount: 0, offset: requestedOffset, hasMore: false };
    }
    filtered = metadataChecks.filter((check) => check.matched).map((check) => check.entry);
  }

  const sorted = filtered.sort((a, b) => {
    const primary = query.sort === "created"
      ? b.info.created.getTime() - a.info.created.getTime()
      : b.info.modified.getTime() - a.info.modified.getTime();
    if (primary !== 0) return primary;
    const secondary = query.sort === "created"
      ? b.info.modified.getTime() - a.info.modified.getTime()
      : b.info.created.getTime() - a.info.created.getTime();
    if (secondary !== 0) return secondary;
    return a.info.id.localeCompare(b.info.id);
  });
  const totalCount = sorted.length;
  const matches = sorted
    .slice(requestedOffset, requestedOffset + limit)
    .map(({ info, matchedTerms }) => buildMatch(info, query, matchedTerms, redactionEnabled));

  return { matches, queryDiagnostics: diagnostics, totalCount, offset: requestedOffset, hasMore: requestedOffset + matches.length < totalCount };
}

export async function resolveSessionById(
  deps: Pick<SessionCatalogDeps, "listSessions">,
  sessionId: string,
  sessionIndex?: SessionIndex,
): Promise<ResolvedSession | undefined> {
  const id = sessionId.trim().replace(/^@/, "");
  if (!id) return undefined;
  // Prefer the shared `SessionIndex` so its TTL cache is honoured. Fall
  // back to the raw `deps.listSessions()` for test/dependency-free paths.
  const raw = sessionIndex ? await sessionIndex.list() : await deps.listSessions();
  const sessions = dedupeById(raw);
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
