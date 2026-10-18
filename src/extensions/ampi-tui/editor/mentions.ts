import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  decodeKittyPrintable,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { globToRegExp, matchGlob } from "../../ampi-core/glob.js";
import { formatMmrRelativeTime, openMmrThreadPicker, type MmrThreadPickerSources } from "../overlays/thread-picker.js";

/**
 * Mentions in the prompt: `@` for a file, `@:` for a commit, `@@` for a
 * session.
 *
 * - `@` keeps Pi's file and directory rows and adds two dim hint rows under
 *   them, `@: mention a commit` and `@@ mention a thread`, showing only as
 *   many of Pi's rows as leave the hints in view. Picking a hint row types
 *   its second character. Once a name is typed, Pi's rows show alone.
 *   Pi's file search leaves out what git ignores; paths that match the
 *   `ampi.fuzzy.alwaysIncludePaths` globs are found by a walk of the
 *   directories the globs start in, ranked as Pi ranks its rows and merged
 *   into them, within the number of rows Pi lists.
 * - `@:` lists the last {@link MMR_COMMIT_MENTION_LIMIT} commits of the
 *   working directory's repository as `<short sha> <subject>` with a dim
 *   relative time. Typing after `@:` filters them by sha prefix or subject.
 *   Picking one inserts `@:<short sha> `. Each list reads git afresh, so a
 *   commit made a moment ago is listed.
 * - `@@` (typing a second `@` right after an `@` that starts a word) opens
 *   the Mention Thread picker; picking a session inserts `@<session id> `,
 *   Esc types the `@` after all.
 *
 * The inserted references are plain text: the model sees `@:<sha>` or
 * `@<session id>`.
 */

/** Commits `@:` lists. */
export const MMR_COMMIT_MENTION_LIMIT = 30;
/** How long `git log` may take before `@:` shows no commits. */
export const MMR_COMMIT_MENTION_TIMEOUT_MS = 1500;
/** How long an open `@:` list may go without a request before its commits are read again. */
export const MMR_COMMIT_MENTION_REUSE_MS = 3000;
/** Widest `<short sha> <subject>` before the subject is cut; the times line up after it. */
const COMMIT_COLUMN = 60;
const TIME_GAP = "   ";

/** The hint rows under Pi's file rows: what each completes to, and its text. */
export const MMR_MENTION_HINTS: readonly { readonly value: string; readonly text: string }[] = [
  { value: "@:", text: "@: mention a commit" },
  { value: "@@", text: "@@ mention a thread" },
];

export interface MmrCommit {
  /** Abbreviated hash, as `git log %h` prints it. */
  readonly sha: string;
  readonly subject: string;
  /** Committer date. */
  readonly time: Date;
}

/** Parse `git log --format=%h%x09%s%x09%ct` output; lines that do not fit are skipped. */
export function parseMmrGitLog(stdout: string): MmrCommit[] {
  const commits: MmrCommit[] = [];
  for (const line of stdout.split("\n")) {
    const fields = line.split("\t");
    if (fields.length < 3) continue;
    const sha = fields[0]?.trim() ?? "";
    const seconds = Number(fields.at(-1));
    if (!sha || !Number.isFinite(seconds)) continue;
    commits.push({ sha, subject: fields.slice(1, -1).join("\t").trim(), time: new Date(seconds * 1000) });
  }
  return commits;
}

/**
 * The newest commits of the repository `cwd` is in, newest first. Empty
 * when `cwd` is not in a repository, the repository has no commits, git is
 * missing or `git log` does not finish within the timeout.
 */
export function readMmrRecentCommits(cwd: string, options: { git?: string; timeoutMs?: number } = {}): Promise<MmrCommit[]> {
  const args = ["log", "--no-color", "--format=%h%x09%s%x09%ct", "-n", String(MMR_COMMIT_MENTION_LIMIT)];
  return new Promise((resolve) => {
    execFile(
      options.git ?? "git",
      args,
      { cwd, timeout: options.timeoutMs ?? MMR_COMMIT_MENTION_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => resolve(error ? [] : parseMmrGitLog(String(stdout))),
    );
  });
}

/** Entries one walk for `ampi.fuzzy.alwaysIncludePaths` reads at most. */
export const MMR_INCLUDED_PATHS_MAX_ENTRIES = 5000;
/** Directory levels one such walk descends at most. */
export const MMR_INCLUDED_PATHS_MAX_DEPTH = 12;
/** How long `@` file completions may go without a request before the paths are walked again. */
export const MMR_INCLUDED_PATHS_REUSE_MS = 3000;
/** File rows Pi's `@` completion lists at most; the merged rows keep to it. */
export const MMR_PI_FILE_ROWS = 20;

/** A path an `ampi.fuzzy.alwaysIncludePaths` glob matched, relative to the working directory with `/` separators. */
export interface MmrIncludedPath {
  readonly path: string;
  readonly isDirectory: boolean;
}

const GLOB_SEGMENT = /[*?[{]/;

/**
 * Where the walk for `pattern` starts (its leading segments without glob
 * characters) and how many levels below it the rest of the pattern reaches.
 * A pattern without glob characters names one path: its parent is read one
 * level deep. `undefined` for a pattern that leaves the working directory.
 */
function walkRoot(pattern: string): { dir: string; depth: number } | undefined {
  const segments = pattern.split("/");
  if (pattern === "" || pattern.startsWith("/") || segments.includes("..")) return undefined;
  let fixed = segments.findIndex((segment) => GLOB_SEGMENT.test(segment));
  if (fixed === -1) fixed = segments.length - 1;
  const rest = segments.slice(fixed);
  const depth = rest.some((segment) => segment.includes("**")) ? MMR_INCLUDED_PATHS_MAX_DEPTH : rest.length;
  return { dir: segments.slice(0, fixed).join("/"), depth: Math.min(depth, MMR_INCLUDED_PATHS_MAX_DEPTH) };
}

/**
 * The paths under `cwd` that match one of `patterns` (globs relative to
 * `cwd`, as `ampi-core`'s glob matcher reads them). Only the directories the
 * patterns start in are walked, breadth first and in name order, each walk
 * reading at most `maxEntries` entries and {@link MMR_INCLUDED_PATHS_MAX_DEPTH}
 * levels. Symbolic links are listed but never followed, `.git` is skipped,
 * and patterns that leave `cwd` or do not parse are ignored.
 */
export async function walkMmrIncludedPaths(
  cwd: string,
  patterns: readonly string[],
  options: { maxEntries?: number } = {},
): Promise<MmrIncludedPath[]> {
  const maxEntries = options.maxEntries ?? MMR_INCLUDED_PATHS_MAX_ENTRIES;
  const globs: string[] = [];
  const roots = new Map<string, number>();
  for (const raw of patterns) {
    const pattern = raw.trim().replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
    const root = walkRoot(pattern);
    if (!root) continue;
    try {
      globToRegExp(pattern);
    } catch {
      continue;
    }
    globs.push(pattern);
    roots.set(root.dir, Math.max(roots.get(root.dir) ?? 0, root.depth));
  }
  const found = new Map<string, boolean>();
  for (const [dir, depth] of roots) {
    let budget = maxEntries;
    const pending = [{ dir, level: 0 }];
    for (let next = pending.shift(); next && budget > 0; next = pending.shift()) {
      let entries: Dirent[];
      try {
        entries = await readdir(path.join(cwd, next.dir), { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        if (entry.name === ".git") continue;
        if (budget <= 0) break;
        budget -= 1;
        const child = next.dir ? `${next.dir}/${entry.name}` : entry.name;
        // A directory entry is never a symbolic link, so links are not followed.
        const isDirectory = entry.isDirectory();
        if (globs.some((glob) => matchGlob(glob, child))) found.set(child, isDirectory);
        if (isDirectory && next.level + 1 < depth) pending.push({ dir: child, level: next.level + 1 });
      }
    }
  }
  return [...found].map(([entryPath, isDirectory]) => ({ path: entryPath, isDirectory }));
}

/**
 * Pi's ranking of a file row against what follows the `@`: the name equal to
 * it, starting with it, containing it, then the path containing it, with a
 * bonus for directories; 0 for no match.
 */
function scoreFileRow(filePath: string, query: string, isDirectory: boolean): number {
  const name = path.posix.basename(filePath).toLowerCase();
  const needle = query.toLowerCase();
  let score = 0;
  if (name === needle) score = 100;
  else if (name.startsWith(needle)) score = 80;
  else if (name.includes(needle)) score = 50;
  else if (filePath.toLowerCase().includes(needle)) score = 30;
  return isDirectory && score > 0 ? score + 10 : score;
}

interface FileRow {
  readonly item: AutocompleteItem;
  /** The path relative to the typed directory, with a trailing `/` for a directory, as Pi ranks it. */
  readonly ranked: string;
  readonly score: number;
}

/** Pi's order: higher score, then fewer path segments, then the shorter path, then by name. */
function compareFileRows(a: FileRow, b: FileRow): number {
  const depth = (row: FileRow) => row.ranked.split("/").filter(Boolean).length;
  return b.score - a.score || depth(a) - depth(b) || a.ranked.length - b.ranked.length || a.ranked.localeCompare(b.ranked);
}

/**
 * Merge the always-included `paths` into Pi's rows for the `@` token
 * `token`: those that match what was typed and are not among Pi's rows yet,
 * ranked together with Pi's rows, at most {@link MMR_PI_FILE_ROWS}. A path
 * typed with a directory (`@dist/b`) offers only paths in that directory.
 */
function mergeIncludedRows(
  piRows: AutocompleteSuggestions | null,
  token: string,
  paths: readonly MmrIncludedPath[],
): AutocompleteSuggestions | null {
  const quoted = token.startsWith('@"');
  const typed = token.slice(quoted ? 2 : 1);
  const base = typed.slice(0, typed.lastIndexOf("/") + 1);
  const query = typed.slice(base.length);
  const row = (item: AutocompleteItem, entryPath: string): FileRow => {
    const ranked = entryPath.startsWith(base) ? entryPath.slice(base.length) : entryPath;
    const isDirectory = ranked.endsWith("/");
    return { item, ranked, score: query ? scoreFileRow(isDirectory ? ranked.slice(0, -1) : ranked, query, isDirectory) : 1 };
  };
  // Pi's values are `@<path>` or `@"<path>"`, with a trailing `/` for a directory.
  const rows = (piRows?.items ?? []).map((item) => row(item, item.value.replace(/^@"?|"$/g, "")));
  const seen = new Set(rows.map(({ item }) => item.value));
  for (const entry of paths) {
    if (!entry.path.startsWith(base) || entry.path.length === base.length) continue;
    const completion = entry.isDirectory ? `${entry.path}/` : entry.path;
    const value = quoted || /\s/u.test(completion) ? `@"${completion}"` : `@${completion}`;
    if (seen.has(value)) continue;
    const name = path.posix.basename(entry.path);
    const added = row({ value, label: entry.isDirectory ? `${name}/` : name, description: entry.path }, completion);
    if (added.score === 0) continue;
    seen.add(value);
    rows.push(added);
  }
  if (rows.length === (piRows?.items.length ?? 0)) return piRows;
  return { items: rows.sort(compareFileRows).slice(0, MMR_PI_FILE_ROWS).map(({ item }) => item), prefix: piRows?.prefix ?? token };
}

/** The `@` token that ends `textBeforeCursor`, and the column it starts at. */
function mentionToken(textBeforeCursor: string): { token: string; start: number } | undefined {
  const match = /(?:^|\s)[([{<`]*(@\S*)$/u.exec(textBeforeCursor);
  const token = match?.[1];
  return token === undefined ? undefined : { token, start: textBeforeCursor.length - token.length };
}

/**
 * Whether typing `data` with `textBeforeCursor` before the cursor starts a
 * thread mention: an `@` right after an `@` that starts a word.
 */
export function isMmrThreadMentionKey(data: string, textBeforeCursor: string): boolean {
  return (decodeKittyPrintable(data) ?? data) === "@" && mentionToken(textBeforeCursor)?.token === "@";
}

export interface MmrMentionProviderOptions {
  /** The newest commits of the working directory's repository. */
  readonly listCommits: () => Promise<readonly MmrCommit[]>;
  /** Current time, for the commits' relative times. */
  readonly now: () => number;
  /** Draws text dim. */
  readonly dim: (text: string) => string;
  /** Types `char` into the prompt, as a key press would; picking a hint row calls it after the completion. */
  readonly typeKey: (char: string) => void;
  /** Rows the prompt's autocomplete list shows at once; Pi's rows for a bare `@` leave room for the hints. */
  readonly visibleRows?: () => number | undefined;
  /** True while `@` tokens get no rows, such as while the Mention Thread picker is open. */
  readonly suppressed?: () => boolean;
  /** `ampi.fuzzy.alwaysIncludePaths`: globs relative to `cwd` that `@` file rows include even when git ignores them. */
  readonly alwaysInclude?: { readonly cwd: string; readonly patterns: readonly string[] };
}

type MentionItem = AutocompleteItem & { mention: "hint" | "commit" };

function isMentionItem(item: AutocompleteItem): item is MentionItem {
  return (item as Partial<MentionItem>).mention !== undefined;
}

/** Wrap Pi's autocomplete provider with the `@:` and `@@` mentions. */
export function createMmrMentionProvider(base: AutocompleteProvider, options: MmrMentionProviderOptions): AutocompleteProvider {
  // One `git log` per open `@:` list: refilling the rows as you type reuses
  // it. A pick, a request for anything but `@:`, or a pause longer than
  // MMR_COMMIT_MENTION_REUSE_MS ends the list, so the next one reads again.
  let commits: { key: string; used: number; list: Promise<readonly MmrCommit[]> } | undefined;
  // One walk serves the `@` file completions that follow each other while
  // you type; a pause longer than MMR_INCLUDED_PATHS_REUSE_MS walks again.
  let included: { used: number; list: Promise<readonly MmrIncludedPath[]> } | undefined;

  function includedPaths(cwd: string, patterns: readonly string[]): Promise<readonly MmrIncludedPath[]> {
    const now = options.now();
    if (!included || now - included.used > MMR_INCLUDED_PATHS_REUSE_MS) {
      included = { used: now, list: walkMmrIncludedPaths(cwd, patterns).catch(() => []) };
    } else {
      included.used = now;
    }
    return included.list;
  }

  /** Pi's file rows for `token`, with the always-included paths merged in when the setting lists any. */
  async function fileRows(
    token: string,
    files: () => Promise<AutocompleteSuggestions | null>,
    signal: AbortSignal | undefined,
  ): Promise<AutocompleteSuggestions | null> {
    const piRows = await files();
    const include = options.alwaysInclude;
    if (!include || include.patterns.length === 0 || signal?.aborted) return piRows;
    return mergeIncludedRows(piRows, token, await includedPaths(include.cwd, include.patterns));
  }

  function hintItems(token: string): MentionItem[] {
    return MMR_MENTION_HINTS.filter((hint) => hint.value.startsWith(token)).map((hint) => ({
      value: hint.value,
      label: options.dim(hint.text),
      mention: "hint",
    }));
  }

  async function commitItems(key: string, query: string): Promise<MentionItem[]> {
    const now = options.now();
    if (commits?.key !== key || now - commits.used > MMR_COMMIT_MENTION_REUSE_MS) {
      commits = { key, used: now, list: options.listCommits().catch(() => []) };
    } else {
      commits.used = now;
    }
    const needle = query.toLowerCase();
    const shown = (await commits.list).filter(
      (commit) => commit.sha.toLowerCase().startsWith(needle) || commit.subject.toLowerCase().includes(needle),
    );
    const heads = shown.map((commit) => truncateToWidth(`${commit.sha} ${commit.subject}`, COMMIT_COLUMN, "…"));
    const column = Math.max(0, ...heads.map((head) => visibleWidth(head)));
    return shown.map((commit, index) => {
      const head = heads[index] ?? "";
      const pad = " ".repeat(column - visibleWidth(head));
      return {
        value: `@:${commit.sha}`,
        label: `${head}${pad}${TIME_GAP}${options.dim(formatMmrRelativeTime(commit.time, now))}`,
        mention: "commit",
      };
    });
  }

  /** The rows for the `@` token `token`; `key` names where it starts, `files` asks Pi for its rows. */
  async function mentionSuggestions(
    token: string,
    key: string,
    files: () => Promise<AutocompleteSuggestions | null>,
  ): Promise<AutocompleteSuggestions | null> {
    if (token.startsWith("@:")) {
      const items = await commitItems(key, token.slice(2));
      return items.length > 0 ? { items, prefix: token } : null;
    }
    // `@@` itself offers its hint row (Tab opens the picker); text after it
    // is no file name.
    if (token.startsWith("@@")) return token === "@@" ? { items: hintItems(token), prefix: token } : null;
    const piRows = await files();
    const hints = hintItems(token);
    if (hints.length === 0) return piRows;
    // The list opens on its first rows: keep the hints among them. Typing
    // a name searches Pi's files again.
    const visible = options.visibleRows?.();
    const shown = piRows?.items.slice(0, visible === undefined ? undefined : Math.max(1, visible - hints.length)) ?? [];
    return { items: [...shown, ...hints], prefix: piRows?.prefix ?? token };
  }

  return {
    triggerCharacters: [":"],
    async getSuggestions(lines, cursorLine, cursorCol, request) {
      const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
      const found = mentionToken(before);
      if (!found?.token.startsWith("@:")) commits = undefined;
      if (!found) return base.getSuggestions(lines, cursorLine, cursorCol, request);
      const result = await mentionSuggestions(found.token, `${cursorLine}\u0000${before.slice(0, found.start)}`, () =>
        fileRows(found.token, () => base.getSuggestions(lines, cursorLine, cursorCol, request), request?.signal),
      );
      // A request that started before the Mention Thread picker opened
      // finishes with no list under it.
      return options.suppressed?.() ? null : result;
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      commits = undefined;
      if (!isMentionItem(item)) return base.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      const line = lines[cursorLine] ?? "";
      const head = line.slice(0, cursorCol - prefix.length);
      // A hint row leaves the `@` and types its second character, which then
      // shows the commits or opens the thread picker.
      const text = item.mention === "hint" ? "@" : `${item.value} `;
      if (item.mention === "hint") queueMicrotask(() => options.typeKey(item.value.slice(1)));
      const next = [...lines];
      next[cursorLine] = `${head}${text}${line.slice(cursorCol)}`;
      return { lines: next, cursorLine, cursorCol: head.length + text.length };
    },
    shouldTriggerFileCompletion: base.shouldTriggerFileCompletion?.bind(base),
  };
}

/**
 * Open the Mention Thread picker. Resolves with the reference to insert,
 * `@<session id> ` followed by a space, or `undefined` when it was dismissed.
 */
export async function pickMmrThreadMention(ctx: ExtensionContext, sources?: MmrThreadPickerSources): Promise<string | undefined> {
  const row = await openMmrThreadPicker(ctx, "mention", sources);
  return row ? `@${row.id} ` : undefined;
}
