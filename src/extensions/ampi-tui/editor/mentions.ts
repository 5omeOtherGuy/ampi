import { execFile } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  decodeKittyPrintable,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { formatMmrRelativeTime, openMmrThreadPicker, type MmrThreadPickerSources } from "../overlays/thread-picker.js";

/**
 * Mentions in the prompt: `@` for a file, `@:` for a commit, `@@` for a
 * session.
 *
 * - `@` keeps Pi's file and directory rows and adds two dim hint rows under
 *   them, `@: mention a commit` and `@@ mention a thread`, showing only as
 *   many of Pi's rows as leave the hints in view. Picking a hint row types
 *   its second character. Once a name is typed, Pi's rows show alone.
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
        base.getSuggestions(lines, cursorLine, cursorCol, request),
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
