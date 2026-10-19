import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { MmrLiveEntry } from "../ampi-core/live-registry.js";
import { checkMmrThreadLabels, MMR_THREAD_LABEL_MAX_LENGTH, MMR_THREAD_LABELS_MAX } from "../ampi-core/thread-index.js";
import { MMR_GUI_MAX_PROMPT_LENGTH } from "./commands.js";
import type { MmrGuiModes } from "./modes.js";
import { mmrGuiProjectLabel, type MmrGuiSessionRow } from "./sessions.js";

/**
 * The new-thread composer's server side in `ampi app` (`hub.ts` serves it):
 *
 * | Route | Answer |
 * | --- | --- |
 * | `GET /api/directories?q=` | `{ directories, typed }`: the working directories of the catalogued sessions and of the live processes, most recently used first, each `{ path, label, git, branch, lastUsed, sessions }`; `q` keeps those whose path or name holds every word of it. `typed` is the directory `q` names when it is an absolute path, `~` or `~/…`, to a directory not listed, else `null` (`~name` searches for `name`) |
 * | `POST /api/threads` | `{ prompt, cwd, mode?, labels? }` checked by {@link parseMmrGuiNewThread}; see `hub.ts` |
 *
 * Git is read from the files, never by running `git`: the `.git` directory
 * or file of the directory or its nearest parent, and its `HEAD`.
 */

/** The most directories `GET /api/directories` lists. */
export const MMR_GUI_DIRECTORY_LIMIT = 50;

export interface MmrGuiNewThread {
  prompt: string;
  cwd: string;
  /** A mode key the worker starts in, or `null` for the mode a new session in `cwd` starts in. */
  mode: string | null;
  labels: string[];
}

export type MmrGuiNewThreadCheck = { ok: true; value: MmrGuiNewThread } | { ok: false; status: number; body: { error: string } };

export interface MmrGuiDirectory {
  path: string;
  /** The last segment of the path, `~` for the home directory. */
  label: string;
  /** Whether the directory is in a Git checkout. */
  git: boolean;
  /** The branch checked out there, the short commit on a detached head, or `null`. */
  branch: string | null;
  /** The newest activity of a session there (ISO 8601), or `null` for a typed path. */
  lastUsed: string | null;
  /** How many sessions ran there. */
  sessions: number;
}

/** What `fs.stat` says about a path: a directory, something else, or nothing. */
export type MmrGuiPathKind = "directory" | "other" | "missing";

export async function mmrGuiPathKind(file: string): Promise<MmrGuiPathKind> {
  try {
    return (await stat(file)).isDirectory() ? "directory" : "other";
  } catch {
    return "missing";
  }
}

function record(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

const invalid = (error: string): MmrGuiNewThreadCheck => ({ ok: false, status: 400, body: { error } });

/** Labels as the thread index takes them (`checkMmrThreadLabels`), without duplicates, or the reason they are refused. */
export function checkMmrGuiLabels(labels: unknown): string[] | string {
  if (labels === undefined || labels === null) return [];
  const checked = checkMmrThreadLabels(labels);
  if (checked.ok) return checked.labels;
  if (checked.problem === "list") return "labels must be a list of strings.";
  if (checked.problem === "characters") return `${JSON.stringify(checked.label)} is not a label: use lowercase letters, digits and hyphens.`;
  if (checked.problem === "length") return `A label has at most ${MMR_THREAD_LABEL_MAX_LENGTH} characters.`;
  return `A thread takes at most ${MMR_THREAD_LABELS_MAX} labels.`;
}

/**
 * Check a `POST /api/threads` body: a prompt of 1 to 100,000 characters, an
 * absolute path to an existing directory, a mode `modes` lists whose models
 * are set up (or none), and labels the thread index takes. A mode that is
 * listed but has no usable model answers 409 with its reason.
 */
export async function parseMmrGuiNewThread(
  body: unknown,
  { modes, pathKind = mmrGuiPathKind }: { modes: Pick<MmrGuiModes, "modes">; pathKind?: (file: string) => Promise<MmrGuiPathKind> },
): Promise<MmrGuiNewThreadCheck> {
  const { prompt, cwd, mode, labels } = record(body);
  if (typeof prompt !== "string" || prompt.trim() === "") return invalid("Type a prompt for the new thread.");
  if (prompt.length > MMR_GUI_MAX_PROMPT_LENGTH) return invalid("The prompt is too long.");
  if (typeof cwd !== "string" || cwd === "") return invalid("Choose a directory for the new thread.");
  if (!path.isAbsolute(cwd)) return invalid("Name the directory by its absolute path.");
  const kind = await pathKind(cwd);
  if (kind === "missing") return invalid(`There is no directory at ${cwd}.`);
  if (kind === "other") return invalid(`${cwd} is not a directory.`);
  if (mode !== undefined && mode !== null) {
    const row = typeof mode === "string" ? modes.modes.find((candidate) => candidate.key === mode) : undefined;
    if (!row) return invalid(`${JSON.stringify(mode)} is not one of ampi's modes.`);
    if (!row.available) return { ok: false, status: 409, body: { error: row.reason ?? `${row.label} cannot run now.` } };
  }
  const checked = checkMmrGuiLabels(labels);
  if (typeof checked === "string") return invalid(checked);
  return { ok: true, value: { prompt: prompt.trim(), cwd: path.resolve(cwd), mode: typeof mode === "string" ? mode : null, labels: checked } };
}

/**
 * `{ git, branch }` for a directory, from the `.git` of it or its nearest
 * parent, looking no higher than `ceiling` when one is given; never runs `git`.
 */
export async function readMmrGuiGitHead(dir: string, ceiling?: string): Promise<{ git: boolean; branch: string | null }> {
  const top = ceiling === undefined ? undefined : path.resolve(ceiling);
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    const dotGit = path.join(current, ".git");
    const kind = await mmrGuiPathKind(dotGit);
    if (kind !== "missing") {
      let gitDir = dotGit;
      try {
        // A worktree or submodule has a `.git` file naming its Git directory.
        if (kind === "other") gitDir = path.resolve(current, /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, "utf8"))?.[1]?.trim() ?? "");
        const head = (await readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        return { git: true, branch: ref ? (ref[1] as string) : /^[0-9a-f]{7,}$/i.test(head) ? head.slice(0, 7) : null };
      } catch {
        return { git: true, branch: null };
      }
    }
    if (path.dirname(current) === current || current === top) return { git: false, branch: null };
  }
}

/** `~` and `~/…` as the home directory; anything else as written. */
export function expandMmrGuiHome(text: string, home: string): string {
  return text === "~" ? home : text.startsWith("~/") ? path.join(home, text.slice(2)) : text;
}

export interface MmrGuiDirectoryInput {
  /** Every listed session's row. */
  rows: readonly Pick<MmrGuiSessionRow, "id" | "cwd" | "modified">[];
  /** The live registry's entries; the app's own (no session) is left out. */
  live: readonly Pick<MmrLiveEntry, "kind" | "sessionId" | "cwd" | "updatedAt">[];
  query?: string;
  home: string;
  pathKind?: (file: string) => Promise<MmrGuiPathKind>;
  gitHead?: (dir: string) => Promise<{ git: boolean; branch: string | null }>;
}

/** The `GET /api/directories` answer; see the module comment. */
export async function listMmrGuiDirectories(input: MmrGuiDirectoryInput): Promise<{ directories: MmrGuiDirectory[]; typed: MmrGuiDirectory | null }> {
  const { home } = input;
  const pathKind = input.pathKind ?? mmrGuiPathKind;
  const gitHead = input.gitHead ?? readMmrGuiGitHead;
  const known = new Map<string, { lastUsed: string; ids: Set<string> }>();
  const note = (cwd: string, id: string | null, at: string) => {
    if (cwd === "" || !path.isAbsolute(cwd)) return;
    const key = path.resolve(cwd);
    const entry = known.get(key) ?? { lastUsed: at, ids: new Set<string>() };
    if (at > entry.lastUsed) entry.lastUsed = at;
    if (id) entry.ids.add(id);
    known.set(key, entry);
  };
  for (const row of input.rows) note(row.cwd, row.id, row.modified);
  for (const entry of input.live) if (entry.kind !== "app") note(entry.cwd, entry.sessionId, entry.updatedAt);

  const query = (input.query ?? "").trim();
  // Only `~` and `~/…` name the home directory; `~name` searches for `name`.
  const typedPath = query.startsWith("/") || query === "~" || query.startsWith("~/") ? path.resolve(expandMmrGuiHome(query, home)) : undefined;
  const words = (typedPath ?? query.replace(/^~/, "")).toLowerCase().split(/\s+/).filter(Boolean);
  const describe = async (dir: string, lastUsed: string | null, sessions: number): Promise<MmrGuiDirectory> => ({
    path: dir,
    label: mmrGuiProjectLabel(dir, home),
    ...(await gitHead(dir)),
    lastUsed,
    sessions,
  });

  const candidates = [...known]
    .filter(([dir]) => words.every((word) => `${dir} ${mmrGuiProjectLabel(dir, home)}`.toLowerCase().includes(word)))
    .sort(([a, x], [b, y]) => y.lastUsed.localeCompare(x.lastUsed) || a.localeCompare(b));
  const directories: MmrGuiDirectory[] = [];
  for (const [dir, entry] of candidates) {
    if (directories.length >= MMR_GUI_DIRECTORY_LIMIT) break;
    // A directory removed since a session ran there is not offered.
    if ((await pathKind(dir)) === "directory") directories.push(await describe(dir, entry.lastUsed, entry.ids.size));
  }
  const typed =
    typedPath && !directories.some((entry) => entry.path === typedPath) && (await pathKind(typedPath)) === "directory"
      ? await describe(typedPath, null, known.get(typedPath)?.ids.size ?? 0)
      : null;
  return { directories, typed };
}
