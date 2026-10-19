import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { type MmrGuiExecFile, mmrGuiGitEnv, runMmrGuiFile } from "./new-thread.js";

/**
 * The right pane's Changes list, `GET /api/changes?sessionId=&range=`
 * (`server.ts` and `hub.ts` serve it): the files that differ in the
 * session's working directory, read with `git` and never written.
 *
 * | `range` | Sections | From |
 * | --- | --- | --- |
 * | `uncommitted` (default) | `staged`, `unstaged` | `git status --porcelain=v2 -z --untracked-files=all`, `git diff --cached --numstat -z` and `git diff-files --numstat -z`; untracked files count as added, with their lines |
 * | `last-commit` | `commits` | `HEAD` against its first parent (the empty tree for a root commit) |
 * | `branch` | `commits` | `HEAD` against its merge base with the upstream branch, else with `origin`'s default branch |
 *
 * Every `git` runs through `execFile` with fixed arguments (a `--` before
 * the paths where the command takes any), a {@link MMR_GUI_CHANGES_TIMEOUT_MS}
 * timeout, `GIT_OPTIONAL_LOCKS=0` so `git status` never rewrites the index,
 * `core.fsmonitor` off so a repository's config starts no hook, and without
 * the variables that would point it at another repository. The unstaged
 * counts come from `git diff-files`, because `git diff` refreshes the index
 * and writes it back even with optional locks off. A range the
 * checkout does not have (`last-commit` before the first commit, `branch`
 * without a base) answers `uncommitted`, which the answer's `range` says.
 */

/** The most files one answer lists; past it, `truncated` is set. */
export const MMR_GUI_CHANGES_FILE_LIMIT = 2_000;
/** How long one `git` call may take. */
export const MMR_GUI_CHANGES_TIMEOUT_MS = 10_000;
/** How much of an untracked file is read to count its lines. */
export const MMR_GUI_UNTRACKED_READ_BYTES = 1024 * 1024;
/** Largest output one `git` call may print; `git status` lists every untracked file. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** Bytes git reads to tell a binary file by a NUL, as it does itself. */
const BINARY_PROBE_BYTES = 8_000;

export const MMR_GUI_CHANGES_RANGES = ["uncommitted", "last-commit", "branch"] as const;
export type MmrGuiChangesRange = (typeof MMR_GUI_CHANGES_RANGES)[number];

export function isMmrGuiChangesRange(value: unknown): value is MmrGuiChangesRange {
  return typeof value === "string" && (MMR_GUI_CHANGES_RANGES as readonly string[]).includes(value);
}

/** `A` added (untracked and copied files too), `M` modified (type changes and conflicts too), `D` deleted, `R` renamed. */
export type MmrGuiChangeStatus = "A" | "M" | "D" | "R";

export interface MmrGuiChangedFile {
  /** Relative to the checkout's root, `/`-separated. */
  path: string;
  /** The path before a rename or copy, else `null`. */
  oldPath: string | null;
  status: MmrGuiChangeStatus;
  added: number;
  removed: number;
  binary: boolean;
}

export interface MmrGuiChangesSection {
  id: "staged" | "unstaged" | "commits";
  label: string;
  files: MmrGuiChangedFile[];
}

export interface MmrGuiChanges {
  repo: boolean;
  /** The checkout's root, or `null` outside one. */
  root: string | null;
  /** The branch checked out, the short commit on a detached head, or `null`. */
  branch: string | null;
  range: MmrGuiChangesRange;
  /** The ranges this checkout has, for the range menu. */
  ranges: { id: MmrGuiChangesRange; label: string }[];
  /** Only the sections with files, in this order: staged, unstaged; or commits. */
  sections: MmrGuiChangesSection[];
  /** Over the listed files; `files` counts each path once. */
  totals: { added: number; removed: number; files: number };
  /** Whether more than {@link MMR_GUI_CHANGES_FILE_LIMIT} files differ, so only that many are listed. */
  truncated: boolean;
}

export type MmrGuiChangesResult = { status: 200; body: MmrGuiChanges } | { status: number; body: { error: string } };

// ---------------------------------------------------------------------------
// Parsing `-z` output

/** One `git diff --numstat -z` entry; `binary` files have no line counts. */
export interface MmrGuiNumstat {
  path: string;
  oldPath: string | null;
  added: number;
  removed: number;
  binary: boolean;
}

/**
 * `git diff --numstat -z`: `added\tremoved\tpath\0`, or for a rename or copy
 * `added\tremoved\t\0old\0new\0`; a binary file has `-` for both counts.
 */
export function parseMmrGuiNumstat(text: string): MmrGuiNumstat[] {
  const fields = text.split("\0");
  const entries: MmrGuiNumstat[] = [];
  for (let index = 0; index < fields.length; index++) {
    const head = fields[index] as string;
    if (head === "") continue;
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(head);
    if (!match) continue;
    const [, added = "", removed = "", rest = ""] = match;
    let file = rest;
    let oldPath: string | null = null;
    if (rest === "") {
      oldPath = fields[++index] ?? "";
      file = fields[++index] ?? "";
    }
    const binary = added === "-" || removed === "-";
    entries.push({ path: file, oldPath, added: binary ? 0 : Number(added), removed: binary ? 0 : Number(removed), binary });
  }
  return entries;
}

/** One `git status --porcelain=v2 -z` entry: a tracked change (with its index and worktree letters) or an untracked file. */
export type MmrGuiStatusEntry =
  | { kind: "tracked"; path: string; oldPath: string | null; staged: MmrGuiChangeStatus | null; unstaged: MmrGuiChangeStatus | null }
  | { kind: "untracked"; path: string };

/** A status letter of `git status` or `git diff --name-status` as one of the list's four. */
function statusOf(letter: string | undefined): MmrGuiChangeStatus | null {
  switch (letter) {
    case "A":
    case "C":
      return "A";
    case "M":
    case "T":
    case "U":
      return "M";
    case "D":
      return "D";
    case "R":
      return "R";
    default:
      return null;
  }
}

/** The text after the first `count` space-separated fields: the path, which may hold spaces. */
function afterFields(line: string, count: number): string {
  let at = 0;
  for (let field = 0; field < count; field++) {
    const space = line.indexOf(" ", at);
    if (space < 0) return "";
    at = space + 1;
  }
  return line.slice(at);
}

/**
 * `git status --porcelain=v2 -z`: `1 XY …8 fields… path`, `2 XY …9 fields…
 * path\0origPath` for a rename or copy in the index, `u XY …10 fields… path`
 * for a conflict, `? path` untracked. `X` is the index's letter and `Y` the
 * worktree's, `.` for none; a conflict counts as modified in the worktree.
 */
export function parseMmrGuiStatus(text: string): MmrGuiStatusEntry[] {
  const fields = text.split("\0");
  const entries: MmrGuiStatusEntry[] = [];
  for (let index = 0; index < fields.length; index++) {
    const line = fields[index] as string;
    const kind = line[0];
    if (kind === "?") entries.push({ kind: "untracked", path: line.slice(2) });
    else if (kind === "1" || kind === "2") {
      const file = afterFields(line, kind === "1" ? 8 : 9);
      const oldPath = kind === "2" ? (fields[++index] ?? null) : null;
      entries.push({ kind: "tracked", path: file, oldPath, staged: statusOf(line[2]), unstaged: statusOf(line[3]) });
    } else if (kind === "u") entries.push({ kind: "tracked", path: afterFields(line, 10), oldPath: null, staged: null, unstaged: "M" });
  }
  return entries;
}

/** `git diff --name-status -z`: `X\0path\0`, or `R086\0old\0new\0` and `C…` for renames and copies. */
export function parseMmrGuiNameStatus(text: string): { path: string; oldPath: string | null; status: MmrGuiChangeStatus }[] {
  const fields = text.split("\0");
  const entries: { path: string; oldPath: string | null; status: MmrGuiChangeStatus }[] = [];
  for (let index = 0; index < fields.length; index++) {
    const code = fields[index] as string;
    if (code === "") continue;
    const status = statusOf(code[0]) ?? "M";
    if (code[0] === "R" || code[0] === "C") {
      const oldPath = fields[++index] ?? "";
      entries.push({ path: fields[++index] ?? "", oldPath, status });
    } else entries.push({ path: fields[++index] ?? "", oldPath: null, status });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Reading a checkout

export interface MmrGuiChangesOptions {
  /** Runs `git`; defaults to `child_process.execFile`. */
  run?: MmrGuiExecFile;
}

/** Lines of an untracked file, and whether it is binary, from its first {@link MMR_GUI_UNTRACKED_READ_BYTES}; 0 for anything but a regular file. */
async function untrackedLines(file: string): Promise<{ added: number; binary: boolean }> {
  try {
    // A symbolic link is never followed out of the checkout.
    if (!(await lstat(file)).isFile()) return { added: 0, binary: false };
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(MMR_GUI_UNTRACKED_READ_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const bytes = buffer.subarray(0, bytesRead);
      if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return { added: 0, binary: true };
      let lines = 0;
      for (const byte of bytes) if (byte === 0x0a) lines++;
      if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) lines++;
      return { added: lines, binary: false };
    } finally {
      await handle.close();
    }
  } catch {
    return { added: 0, binary: false };
  }
}

/** Why `git` failed, in its own words when it wrote any. */
function gitFailure(error: unknown): string {
  const failure = error as { stderr?: unknown; killed?: boolean; message?: unknown };
  if (failure.killed) return `git did not finish within ${MMR_GUI_CHANGES_TIMEOUT_MS / 1000} seconds.`;
  const text = String(failure.stderr ?? "").trim();
  const lines = text.split("\n").filter((line) => /^(fatal|error):/.test(line));
  return (lines.length > 0 ? lines.join("\n") : text) || String(failure.message ?? "git failed.");
}

class GitError extends Error {}

const byPath = (a: MmrGuiChangedFile, b: MmrGuiChangedFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * The Changes list for `cwd`; see the module comment. Outside a Git checkout
 * it answers `repo: false`; without `git` on PATH, or when `git` fails in a
 * checkout, 409 with the reason.
 */
export async function readMmrGuiChanges(cwd: string, requested: MmrGuiChangesRange, options: MmrGuiChangesOptions = {}): Promise<MmrGuiChangesResult> {
  const run = options.run ?? runMmrGuiFile;
  const env = { ...mmrGuiGitEnv(), GIT_OPTIONAL_LOCKS: "0" };
  const execOptions = { timeout: MMR_GUI_CHANGES_TIMEOUT_MS, windowsHide: true, env, maxBuffer: MAX_OUTPUT_BYTES };
  const git = async (args: readonly string[]): Promise<string> => {
    try {
      return (await run("git", ["-C", cwd, "-c", "core.fsmonitor=false", ...args], execOptions)).stdout;
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") throw new GitError("The Changes list needs git, and git is not on PATH.");
      throw new GitError(gitFailure(error));
    }
  };
  /** Output of a query that fails when there is nothing to find (no upstream, no commit): `null` then. */
  const maybe = async (args: readonly string[]): Promise<string | null> => {
    try {
      return (await git(args)).trim() || null;
    } catch (error) {
      if (error instanceof GitError && /not on PATH/.test(error.message)) throw error;
      return null;
    }
  };

  const outside: MmrGuiChanges = {
    repo: false,
    root: null,
    branch: null,
    range: "uncommitted",
    ranges: [],
    sections: [],
    totals: { added: 0, removed: 0, files: 0 },
    truncated: false,
  };
  try {
    let root: string;
    try {
      root = (await git(["rev-parse", "--show-toplevel"])).replace(/\r?\n$/, "");
    } catch (error) {
      const message = (error as Error).message;
      // Outside a checkout, or in a Git directory with no worktree.
      if (/not a git repository|must be run in a work tree/i.test(message)) return { status: 200, body: outside };
      throw error;
    }
    if (root === "") return { status: 200, body: outside };

    const head = await maybe(["rev-parse", "-q", "--verify", "HEAD^{commit}"]);
    const branch = (await maybe(["symbolic-ref", "-q", "--short", "HEAD"])) ?? (head ? head.slice(0, 7) : null);
    // The base of `branch`: the upstream, else origin's default branch, as Git abbreviates it.
    const base = head
      ? ((await maybe(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])) ??
        (await maybe(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"])))
      : null;
    const mergeBase = base ? await maybe(["merge-base", "HEAD", base, "--"]) : null;
    const ranges: MmrGuiChanges["ranges"] = [{ id: "uncommitted", label: "Uncommitted" }];
    if (head) ranges.push({ id: "last-commit", label: "Last commit" });
    if (mergeBase) ranges.push({ id: "branch", label: `Branch vs ${base}` });
    const range = ranges.some((entry) => entry.id === requested) ? requested : "uncommitted";

    const numstat = ["diff", "--numstat", "-z", "--find-renames", "--no-ext-diff", "--no-textconv", "--no-color"];
    let sections: MmrGuiChangesSection[];
    if (range === "uncommitted") {
      const [statusText, stagedText, unstagedText] = await Promise.all([
        git(["status", "--porcelain=v2", "-z", "--untracked-files=all", "--"]),
        git([...numstat, "--cached", "--"]),
        git(["diff-files", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "--"]),
      ]);
      const staged = new Map(parseMmrGuiNumstat(stagedText).map((entry) => [entry.path, entry]));
      const unstaged = new Map(parseMmrGuiNumstat(unstagedText).map((entry) => [entry.path, entry]));
      const counts = (entry: MmrGuiNumstat | undefined) => ({ added: entry?.added ?? 0, removed: entry?.removed ?? 0, binary: entry?.binary ?? false });
      const stagedFiles: MmrGuiChangedFile[] = [];
      const unstagedFiles: MmrGuiChangedFile[] = [];
      for (const entry of parseMmrGuiStatus(statusText)) {
        if (entry.kind === "untracked") {
          // Counted once listed: reading every untracked file of a large tree would outlast the request.
          unstagedFiles.push({ path: entry.path, oldPath: null, status: "A", added: -1, removed: 0, binary: false });
          continue;
        }
        if (entry.staged) stagedFiles.push({ path: entry.path, oldPath: entry.oldPath, status: entry.staged, ...counts(staged.get(entry.path)) });
        if (entry.unstaged) unstagedFiles.push({ path: entry.path, oldPath: null, status: entry.unstaged, ...counts(unstaged.get(entry.path)) });
      }
      sections = [
        { id: "staged", label: "Staged", files: stagedFiles.sort(byPath) },
        { id: "unstaged", label: "Unstaged", files: unstagedFiles.sort(byPath) },
      ];
    } else {
      // A root commit has no parent: compare it with the empty tree.
      const from = range === "branch" ? (mergeBase as string) : ((await maybe(["rev-parse", "-q", "--verify", "HEAD^^{commit}"])) ?? (await git(["hash-object", "-t", "tree", "/dev/null"])).trim());
      const [namesText, statsText] = await Promise.all([
        git(["diff", "--name-status", "-z", "--find-renames", "--no-ext-diff", "--no-color", from, "HEAD", "--"]),
        git([...numstat, from, "HEAD", "--"]),
      ]);
      const stats = new Map(parseMmrGuiNumstat(statsText).map((entry) => [entry.path, entry]));
      const files = parseMmrGuiNameStatus(namesText).map((entry): MmrGuiChangedFile => {
        const stat = stats.get(entry.path);
        return { ...entry, added: stat?.added ?? 0, removed: stat?.removed ?? 0, binary: stat?.binary ?? false };
      });
      sections = [{ id: "commits", label: "Committed", files: files.sort(byPath) }];
    }

    // The first files up to the limit, in section order; untracked ones get their lines now.
    let room = MMR_GUI_CHANGES_FILE_LIMIT;
    let truncated = false;
    for (const section of sections) {
      if (section.files.length > room) {
        truncated = true;
        section.files = section.files.slice(0, room);
      }
      room -= section.files.length;
      for (const file of section.files) if (file.added < 0) Object.assign(file, await untrackedLines(path.join(root, file.path)));
    }
    sections = sections.filter((section) => section.files.length > 0);
    const totals = { added: 0, removed: 0, files: 0 };
    const paths = new Set<string>();
    for (const file of sections.flatMap((section) => section.files)) {
      totals.added += file.added;
      totals.removed += file.removed;
      paths.add(file.path);
    }
    totals.files = paths.size;
    return { status: 200, body: { repo: true, root, branch, range, ranges, sections, totals, truncated } };
  } catch (error) {
    if (error instanceof GitError) return { status: 409, body: { error: error.message } };
    throw error;
  }
}
