import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
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
 * | `POST /api/threads` | `{ prompt, cwd, mode?, labels?, worktree? }` checked by {@link parseMmrGuiNewThread}; see `hub.ts` |
 *
 * The directory list reads Git from the files, never by running `git`: the
 * `.git` directory or file of the directory or its nearest parent, and its
 * `HEAD`. Only New Worktree runs `git`, on an explicit create
 * ({@link createMmrGuiWorktree}).
 */

/** The most directories `GET /api/directories` lists. */
export const MMR_GUI_DIRECTORY_LIMIT = 50;

export interface MmrGuiNewThread {
  prompt: string;
  cwd: string;
  /** A mode key the worker starts in, or `null` for the mode a new session in `cwd` starts in. */
  mode: string | null;
  labels: string[];
  /** Whether the thread starts in a new Git worktree of `cwd`'s checkout. */
  worktree: boolean;
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
 * are set up (or none), labels the thread index takes, and `worktree` as a
 * boolean (or none). A mode that is
 * listed but has no usable model answers 409 with its reason.
 */
export async function parseMmrGuiNewThread(
  body: unknown,
  { modes, pathKind = mmrGuiPathKind }: { modes: Pick<MmrGuiModes, "modes">; pathKind?: (file: string) => Promise<MmrGuiPathKind> },
): Promise<MmrGuiNewThreadCheck> {
  const { prompt, cwd, mode, labels, worktree } = record(body);
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
  if (worktree !== undefined && typeof worktree !== "boolean") return invalid("worktree must be true or false.");
  return {
    ok: true,
    value: { prompt: prompt.trim(), cwd: path.resolve(cwd), mode: typeof mode === "string" ? mode : null, labels: checked, worktree: worktree === true },
  };
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

/** The longest kebab-case part of a worktree's slug, before its random suffix. */
const SLUG_WORDS_MAX = 32;

/** How long `git` may take to create a worktree. */
export const MMR_GUI_WORKTREE_TIMEOUT_MS = 30_000;

/**
 * A worktree's slug: the prompt's first words in kebab case (ASCII letters
 * and digits, accents dropped, at most 32 characters, cut between words when
 * one fits), `thread` when no word is left, then `-` and four hex characters.
 */
export function mmrGuiWorktreeSlug(prompt: string, suffix: string = randomBytes(2).toString("hex")): string {
  const words = prompt
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let base = "";
  for (const word of words) {
    const next = base === "" ? word : `${base}-${word}`;
    if (next.length > SLUG_WORDS_MAX) {
      if (base === "") base = word.slice(0, SLUG_WORDS_MAX);
      break;
    }
    base = next;
  }
  return `${base || "thread"}-${suffix}`;
}

/** `child_process.execFile`'s shape as New Worktree and the Changes list call it: never through a shell. */
export type MmrGuiExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number; windowsHide: boolean; env: NodeJS.ProcessEnv; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

const execFileText = promisify(execFile);
/** `child_process.execFile` with UTF-8 output, as {@link MmrGuiExecFile}. */
export const runMmrGuiFile: MmrGuiExecFile = (file, args, options) => execFileText(file, [...args], { ...options, encoding: "utf8" });

/**
 * Variables that point `git` at a repository; `-C` does not override them, so
 * a hub started from a Git hook would otherwise act on that hook's repository.
 */
const GIT_REPOSITORY_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"];

/** The hub's environment without {@link GIT_REPOSITORY_ENV}, so `git -C <cwd>` finds the checkout of `cwd`. */
export function mmrGuiGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of GIT_REPOSITORY_ENV) delete env[name];
  return env;
}

export type MmrGuiWorktreeResult = { ok: true; path: string; branch: string } | { ok: false; status: number; body: { error: string } };

/** What `git` said on stderr: its `fatal:` and `error:` lines when it wrote any. */
function gitMessage(error: unknown): string {
  const failure = error as { stderr?: unknown; killed?: boolean; message?: unknown };
  if (failure.killed) return `git did not finish within ${MMR_GUI_WORKTREE_TIMEOUT_MS / 1000} seconds.`;
  const text = String(failure.stderr ?? "").trim();
  const lines = text.split("\n").filter((line) => /^(fatal|error):/.test(line));
  return (lines.length > 0 ? lines.join("\n") : text) || String(failure.message ?? "git failed.");
}

/**
 * Create a worktree for a new thread started in `cwd`: from the checkout's
 * current `HEAD`, on a new branch `ampi/<slug>`, at
 * `<parent of the main checkout>/<its name>-worktrees/<slug>`. Runs `git`
 * twice through `execFile` with fixed arguments: `rev-parse` to find the
 * checkout (400 outside one, with git's message when it refuses the
 * directory for another reason; 409 for a git older than 2.31, which does
 * not know `--path-format`), then `worktree add` (409 with git's message
 * when it fails). ampi never removes the worktrees it creates.
 */
export async function createMmrGuiWorktree(
  cwd: string,
  prompt: string,
  { run = runMmrGuiFile, suffix }: { run?: MmrGuiExecFile; suffix?: string } = {},
): Promise<MmrGuiWorktreeResult> {
  const options = { timeout: MMR_GUI_WORKTREE_TIMEOUT_MS, windowsHide: true, env: mmrGuiGitEnv() };
  const notCheckout = `${cwd} is not in a Git checkout, so it has no worktrees.`;
  let lines: string[];
  try {
    const { stdout } = await run("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], options);
    lines = stdout.replace(/\r?\n$/, "").split(/\r?\n/);
  } catch (error) {
    const failure = error as { code?: unknown; killed?: boolean };
    if (failure.code === "ENOENT") return { ok: false, status: 409, body: { error: "New Worktree needs git, and git is not on PATH." } };
    const message = gitMessage(error);
    if (failure.killed) return { ok: false, status: 409, body: { error: message } };
    if (/not a git repository/i.test(message)) return { ok: false, status: 400, body: { error: notCheckout } };
    return { ok: false, status: 400, body: { error: `${cwd} cannot have worktrees: ${message}` } };
  }
  if (lines[0] === "") return { ok: false, status: 400, body: { error: notCheckout } };
  // A git older than 2.31 echoes the `--path-format` it does not know and prints relative paths.
  const [top = "", common = ""] = lines;
  if (lines.length !== 2 || !path.isAbsolute(top) || !path.isAbsolute(common)) {
    return { ok: false, status: 409, body: { error: "New Worktree needs git 2.31 or later." } };
  }
  // Worktrees of a worktree go beside the main checkout's, which owns the shared Git directory.
  const root = path.basename(common) === ".git" ? path.dirname(common) : top;
  const slug = mmrGuiWorktreeSlug(prompt, suffix);
  const branch = `ampi/${slug}`;
  const target = path.join(path.dirname(root), `${path.basename(root)}-worktrees`, slug);
  try {
    await run("git", ["-C", cwd, "worktree", "add", "-b", branch, "--", target, "HEAD"], options);
  } catch (error) {
    return { ok: false, status: 409, body: { error: gitMessage(error) } };
  }
  return { ok: true, path: target, branch };
}
