/**
 * Pure classification of tool calls into transcript activities.
 *
 * An activity says what a call does in user terms: its kind (read, search,
 * list, command, edit, create, ...), a present and past verb ("Reading" /
 * "Read"), the object it acts on (a path, a pattern, a command) and, when the
 * result is known, an exit code or a diff stat. The tool renderers draw one
 * row from it, and `summarizeActivities` folds a run of them into one phrase
 * ("Ran 3 commands, read 4 files, edited 2 files (+265 -4)").
 *
 * Shell commands are parsed with a small tokenizer, so `sed -n '1,220p' x.ts`
 * reads as "Read x.ts L1-220" and `rg foo src` as a search for `foo`.
 * Anything the tokenizer cannot follow (heredocs, comments, unbalanced
 * quotes) or that runs another program stays a plain command.
 */

import path from "node:path";

export type ActivityKind =
  | "read"
  | "search"
  | "list"
  | "command"
  | "edit"
  | "create"
  | "web-search"
  | "web-read"
  | "subagent"
  | "tool";

export type ActivityStatus = "running" | "done" | "error" | "cancelled";

export interface DiffStat {
  added: number;
  removed: number;
}

export interface Activity {
  kind: ActivityKind;
  toolName: string;
  /** Verb while the call runs, e.g. "Reading". */
  present: string;
  /** Verb once it finished, e.g. "Read". */
  past: string;
  /** What the call acts on, drawn in the default colour: a path, a pattern, a command. */
  object: string;
  /** Secondary text drawn muted after the object: a line range, a search path, a query. */
  detail?: string;
  /** Text between object and detail: a space for ranges, " · " for free-form details. */
  detailSeparator?: string;
  /** Path as the tool received it, for links. */
  path?: string;
  /** Every path a multi-file call touches (apply_patch). */
  paths?: string[];
  /** Full shell command, for the expanded card. */
  command?: string;
  /** Directory a leading `cd <dir> &&` switched to. */
  workdir?: string;
  diff?: DiffStat;
  exitCode?: number;
  /** Why a command ended without an exit code: "timed out after 30s" or "killed". */
  ended?: string;
  /** MCP server name for `mcp__<server>__<tool>` tools. */
  server?: string;
}

export interface ClassifyOptions {
  /** Working directory paths are shown relative to. */
  cwd?: string;
  /** Home directory shown as `~`. */
  home?: string;
  /** Final or partial result, when one exists. */
  result?: { content?: readonly unknown[]; details?: unknown };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function firstLine(value: string): string {
  const lines = value.trim().split("\n");
  return lines.length > 1 ? `${lines[0]} …` : (lines[0] ?? "");
}

function countLines(value: string): number {
  if (value === "") return 0;
  return value.replace(/\n$/, "").split("\n").length;
}

/** Text content of a tool result, joined. */
export function resultText(result: ClassifyOptions["result"]): string {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content
    .map((item) => {
      const entry = record(item);
      return entry.type === "text" && typeof entry.text === "string" ? entry.text : "";
    })
    .filter((part) => part !== "")
    .join("\n");
}

/** Status of a finished call: an error result whose last line reports an abort counts as cancelled. */
export function resultStatus(isError: boolean, result: ClassifyOptions["result"]): ActivityStatus {
  if (!isError) return "done";
  const last = resultText(result).trim().split("\n").at(-1) ?? "";
  return /\b(aborted|cancell?ed)\b/i.test(last) ? "cancelled" : "error";
}

/**
 * Path for display: relative to `cwd` when inside it, `~/…` when inside
 * `home`, otherwise as given. Relative paths resolve against `workdir` first.
 */
export function displayPath(raw: string, options: { cwd?: string; home?: string; workdir?: string } = {}): string {
  let resolved = raw;
  if (options.workdir && !path.isAbsolute(raw) && !raw.startsWith("~")) {
    resolved = path.join(options.workdir, raw);
  }
  if (path.isAbsolute(resolved)) {
    const { cwd, home } = options;
    if (cwd && (resolved === cwd || resolved.startsWith(`${cwd}${path.sep}`))) {
      return path.relative(cwd, resolved) || ".";
    }
    if (home && (resolved === home || resolved.startsWith(`${home}${path.sep}`))) {
      return `~${resolved.slice(home.length)}`;
    }
  }
  return resolved;
}

/** `L<a>` or `L<a>-<b>`; undefined for ranges that start below 1 or end before they start. */
export function formatLineRange(start: number, end: number | undefined): string | undefined {
  if (!Number.isInteger(start) || start < 1) return undefined;
  if (end === undefined) return `L${start}-end`;
  if (!Number.isInteger(end) || end < start) return undefined;
  return start === end ? `L${start}` : `L${start}-${end}`;
}

// ---------------------------------------------------------------------------
// Shell tokenizer
// ---------------------------------------------------------------------------

export interface ShellWord {
  type: "word";
  /** Unquoted value. */
  value: string;
  start: number;
  end: number;
  /** Contains a subshell, command substitution or backticks, kept as one opaque word. */
  opaque?: boolean;
}

export interface ShellOperator {
  type: "op";
  /** `|`, `||`, `&&`, `;`, `&`, or a redirection such as `>`, `>>`, `2>`, `<`. */
  value: string;
  start: number;
  end: number;
}

export type ShellToken = ShellWord | ShellOperator;

/** Index just past the `)` that closes the `(` at `open`, honouring quotes; -1 when unbalanced. */
function matchParen(input: string, open: number): number {
  let depth = 0;
  for (let i = open; i < input.length; i++) {
    const ch = input[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const close = input.indexOf(ch, i + 1);
      if (close === -1) return -1;
      i = close;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")" && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * Split a shell command into words and operators. Quotes are removed from
 * word values; subshells, `$(...)` and backticks stay inside one opaque
 * word. Returns undefined for input it does not follow: heredocs, comments
 * and unbalanced quotes or parentheses.
 */
export function tokenizeShell(input: string): ShellToken[] | undefined {
  const tokens: ShellToken[] = [];
  let i = 0;
  let word: ShellWord | undefined;

  const flush = () => {
    if (word) tokens.push(word);
    word = undefined;
  };
  const extend = (chars: string, start: number, end: number, opaque = false) => {
    word ??= { type: "word", value: "", start, end };
    word.value += chars;
    word.end = end;
    if (opaque) word.opaque = true;
  };

  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === " " || ch === "\t") {
      flush();
      i++;
      continue;
    }
    if (ch === "\n") {
      flush();
      tokens.push({ type: "op", value: ";", start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === "#" && !word) return undefined;
    if (ch === "\\") {
      if (input[i + 1] === "\n") {
        i += 2;
        continue;
      }
      extend(input[i + 1] ?? "", i, Math.min(i + 2, input.length));
      i += 2;
      continue;
    }
    if (ch === "'") {
      const close = input.indexOf("'", i + 1);
      if (close === -1) return undefined;
      extend(input.slice(i + 1, close), i, close + 1);
      i = close + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = "";
      let opaque = false;
      while (j < input.length && input[j] !== '"') {
        // Inside double quotes a backslash escapes only $ ` " \ and a newline.
        if (input[j] === "\\" && j + 1 < input.length && '$`"\\\n'.includes(input[j + 1] as string)) {
          if (input[j + 1] !== "\n") value += input[j + 1];
          j += 2;
          continue;
        }
        if (input[j] === "`" || (input[j] === "$" && input[j + 1] === "(")) {
          const end = input[j] === "`" ? input.indexOf("`", j + 1) + 1 : matchParen(input, j + 1);
          if (end <= 0) return undefined;
          value += input.slice(j, end);
          opaque = true;
          j = end;
          continue;
        }
        value += input[j];
        j++;
      }
      if (j >= input.length) return undefined;
      extend(value, i, j + 1, opaque);
      i = j + 1;
      continue;
    }
    if (ch === "`" || (ch === "$" && input[i + 1] === "(") || (ch === "(" && !word)) {
      const end = ch === "`" ? input.indexOf("`", i + 1) + 1 : matchParen(input, ch === "$" ? i + 1 : i);
      if (end <= 0) return undefined;
      extend(input.slice(i, end), i, end, true);
      i = end;
      continue;
    }
    const two = input.slice(i, i + 2);
    if (two === "<<") return undefined;
    if (ch === ">" || ch === "<" || two === "&>") {
      // A word made only of digits right before `>` is a file descriptor: `2>`.
      let start = i;
      let prefix = "";
      if (word && /^\d+$/.test(word.value) && word.end === i) {
        prefix = word.value;
        start = word.start;
        word = undefined;
      }
      flush();
      let op = two === "&>" || two === ">>" || two === ">&" || two === ">|" ? two : ch;
      if (op === "&>" && input[i + 2] === ">") op = "&>>";
      tokens.push({ type: "op", value: `${prefix}${op}`, start, end: i + op.length });
      i += op.length;
      continue;
    }
    if (two === "&&" || two === "||") {
      flush();
      tokens.push({ type: "op", value: two, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "&") {
      flush();
      tokens.push({ type: "op", value: ch, start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === ")") return undefined;
    extend(ch, i, i + 1);
    i++;
  }
  flush();
  return tokens;
}

// ---------------------------------------------------------------------------
// Shell classification
// ---------------------------------------------------------------------------

interface ShellStage {
  words: ShellWord[];
  /** Output redirections that write somewhere other than /dev/null or stderr. */
  writes: boolean;
}

type PartKind = "read" | "search" | "list" | "command" | "edit" | "noise";

interface ShellPart {
  kind: PartKind;
  path?: string;
  range?: string;
  pattern?: string;
}

const SEARCH_PROGRAMS = new Set(["rg", "ripgrep", "grep", "egrep", "fgrep", "ag", "ack"]);
const READ_PROGRAMS = new Set(["cat", "bat", "head", "tail", "less", "more", "nl", "sed", "awk", "jq", "wc", "stat", "file"]);
const LIST_PROGRAMS = new Set(["ls", "tree", "fd", "find"]);
/** Programs that may follow a read, search or list in a pipeline without changing what it is. */
const FILTER_PROGRAMS = new Set([
  "awk", "cat", "column", "cut", "head", "jq", "nl", "sed", "sort", "tail", "tr", "uniq", "wc", "rev", "tac", "fold",
]);
/** Flags whose next word is their value, for grep-family programs. */
const SEARCH_VALUE_FLAGS = new Set([
  "-A", "-B", "-C", "-m", "-g", "-t", "-T", "-f", "--context", "--after-context", "--before-context", "--glob",
  "--iglob", "--type", "--type-not", "--max-count", "--include", "--exclude", "--exclude-dir", "--exclude-from",
  "--file",
]);
const FIND_ACTIONS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);

function stagesOf(tokens: readonly ShellToken[]): ShellStage[][] {
  const pipelines: ShellStage[][] = [];
  let stages: ShellStage[] = [];
  let stage: ShellStage = { words: [], writes: false };
  let redirect: string | undefined;
  const endStage = () => {
    stages.push(stage);
    stage = { words: [], writes: false };
  };
  for (const token of tokens) {
    if (token.type === "word") {
      if (redirect !== undefined) {
        // `2>`, `>&2` and `> /dev/null` write nowhere a reader would look.
        const quiet = redirect.startsWith("2") || redirect.endsWith("&") || token.value === "/dev/null";
        if (/>/.test(redirect) && !quiet) stage.writes = true;
        redirect = undefined;
      } else {
        stage.words.push(token);
      }
      continue;
    }
    if (/[<>]/.test(token.value)) {
      redirect = token.value;
      continue;
    }
    if (token.value === "|") {
      endStage();
      continue;
    }
    endStage();
    pipelines.push(stages);
    stages = [];
  }
  endStage();
  pipelines.push(stages);
  return pipelines.map((p) => p.filter((s) => s.words.length > 0 || s.writes)).filter((p) => p.length > 0);
}

/** Words after leading `VAR=value` assignments. */
function commandWords(stage: ShellStage): string[] {
  const words = stage.words.map((w) => w.value);
  let first = 0;
  while (first < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[first] as string)) first++;
  return words.slice(first);
}

function programName(word: string): string {
  return path.basename(word).toLowerCase();
}

function searchPart(args: readonly string[], kind: "search" | "list" = "search"): ShellPart {
  const positional: string[] = [];
  let pattern: string | undefined;
  let afterDashes = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (afterDashes || !arg.startsWith("-") || arg === "-") {
      positional.push(arg);
      continue;
    }
    if (arg === "--") {
      afterDashes = true;
      continue;
    }
    if (arg === "-e" || arg === "--regexp") {
      pattern ??= args[++i];
      continue;
    }
    if (arg.startsWith("--regexp=")) {
      pattern ??= arg.slice("--regexp=".length);
      continue;
    }
    if (SEARCH_VALUE_FLAGS.has(arg)) i++;
  }
  const paths = pattern === undefined ? positional.slice(1) : positional;
  return { kind, pattern: pattern ?? positional[0], path: paths.at(-1) };
}

function lastPositional(args: readonly string[], valueFlags: ReadonlySet<string> = new Set()): string | undefined {
  let last: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (valueFlags.has(arg)) i++;
    else if (!arg.startsWith("-") || arg === "-") last = arg;
  }
  return last;
}

function headTailPart(program: "head" | "tail", args: readonly string[]): ShellPart {
  let count: string | undefined = "10";
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "-n" || arg === "--lines") count = args[++i];
    else if (arg.startsWith("--lines=")) count = arg.slice("--lines=".length);
    else if (/^-n[+\d]/.test(arg)) count = arg.slice(2);
    else if (/^-\d+$/.test(arg)) count = arg.slice(1);
    else if (arg === "-c" || arg === "--bytes") {
      count = undefined;
      i++;
    } else if (arg.startsWith("-c") || arg.startsWith("--bytes=")) count = undefined;
    else if (!arg.startsWith("-")) positional.push(arg);
  }
  const part: ShellPart = { kind: "read", path: positional.at(-1) };
  if (count === undefined) return part;
  if (program === "head") {
    const n = Number(count);
    part.range = formatLineRange(1, n);
  } else if (count.startsWith("+")) {
    part.range = formatLineRange(Number(count.slice(1)), undefined);
  } else if (/^\d+$/.test(count)) {
    part.range = `last ${count}`;
  }
  return part;
}

function sedPart(args: readonly string[]): ShellPart {
  let quiet = false;
  let inPlace = false;
  const scripts: string[] = [];
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "-n" || arg === "--quiet" || arg === "--silent") quiet = true;
    else if (arg === "-e" || arg === "--expression") scripts.push(args[++i] ?? "");
    else if (arg === "-f" || arg === "--file") i++;
    else if (arg.startsWith("-i") || arg.startsWith("--in-place")) inPlace = true;
    else if (/^-[a-zA-Z]+$/.test(arg)) {
      if (arg.includes("n")) quiet = true;
      if (arg.includes("i")) inPlace = true;
      if (arg.endsWith("e")) scripts.push(args[++i] ?? "");
    } else if (!arg.startsWith("-")) positional.push(arg);
  }
  if (scripts.length === 0 && positional.length > 0) scripts.push(positional.shift() as string);
  const file = positional.at(-1);
  if (inPlace) return { kind: file ? "edit" : "command", path: file };
  if (!file) return { kind: "command" };
  const part: ShellPart = { kind: "read", path: file };
  if (!quiet) return part;
  const ranges: string[] = [];
  for (const command of scripts.join(";").split(/[;\n]/)) {
    if (command.trim() === "") continue;
    const match = /^\s*(\d+)\s*(?:,\s*(\d+)\s*)?p\s*$/.exec(command);
    const range = match ? formatLineRange(Number(match[1]), Number(match[2] ?? match[1])) : undefined;
    if (!range) return part;
    ranges.push(range);
  }
  if (ranges.length > 0) part.range = ranges.join(",");
  return part;
}

function classifyStage(stage: ShellStage): ShellPart {
  const words = commandWords(stage);
  if (stage.words.some((w) => w.opaque)) return { kind: "command" };
  if (words.length === 0) return { kind: stage.writes ? "command" : "noise" };
  const program = programName(words[0] as string);
  const args = words.slice(1);
  if (stage.writes || program === "tee") return { kind: "command" };
  if (program === "true" || program === ":" || program === "echo" || program === "printf") return { kind: "noise" };

  if (program === "git") {
    let i = 0;
    while (i < args.length && (args[i] as string).startsWith("-")) i += args[i] === "-C" || args[i] === "-c" ? 2 : 1;
    const sub = args[i];
    if (sub === "grep") return searchPart(args.slice(i + 1));
    if (sub === "ls-files") return { kind: "list", path: lastPositional(args.slice(i + 1)) ?? "." };
    return { kind: "command" };
  }
  if (SEARCH_PROGRAMS.has(program)) {
    if (program === "rg" && args.includes("--files")) {
      return { kind: "list", path: lastPositional(args, SEARCH_VALUE_FLAGS) ?? "." };
    }
    return searchPart(args);
  }
  if (LIST_PROGRAMS.has(program)) {
    if (program === "find") {
      if (args.some((arg) => FIND_ACTIONS.has(arg))) return { kind: "command" };
      const nameAt = args.findIndex((arg) => arg === "-name" || arg === "-iname");
      const pattern = nameAt === -1 ? undefined : args[nameAt + 1];
      const first = args[0];
      return { kind: "list", path: first && !first.startsWith("-") ? first : ".", pattern };
    }
    if (program === "fd") {
      const part = searchPart(args, "list");
      return { ...part, path: part.path ?? "." };
    }
    return { kind: "list", path: lastPositional(args, new Set(["-I", "-L", "--ignore"])) ?? "." };
  }
  if (program === "head" || program === "tail") return headTailPart(program, args);
  if (program === "sed") return sedPart(args);
  if (program === "perl" && args.some((arg) => /^-\w*i/.test(arg))) {
    const file = lastPositional(args, new Set(["-e", "-E"]));
    return { kind: file ? "edit" : "command", path: file };
  }
  if (READ_PROGRAMS.has(program)) {
    // awk and jq take a program first; a lone argument means they read stdin.
    const positional = args.filter((arg) => !arg.startsWith("-"));
    const needsTwo = program === "awk" || program === "jq";
    const file = positional.length >= (needsTwo ? 2 : 1) ? positional.at(-1) : undefined;
    return file ? { kind: "read", path: file } : { kind: "command" };
  }
  return { kind: "command" };
}

function classifyPipeline(stages: readonly ShellStage[]): ShellPart {
  const first = classifyStage(stages[0] as ShellStage);
  if (stages.length === 1) return first;
  if (first.kind !== "read" && first.kind !== "search" && first.kind !== "list") return { kind: "command" };
  let part = first;
  for (const stage of stages.slice(1)) {
    const words = commandWords(stage);
    const program = programName(words[0] ?? "");
    let next = classifyStage(stage);
    if (program === "xargs" && part.kind === "list") {
      const inner = classifyStage({ words: stage.words.slice(1), writes: stage.writes });
      if (inner.kind === "search") next = { ...inner, path: inner.path ?? part.path };
    }
    if (next.kind === "search" && part.kind !== "search") {
      // `cat f | grep q` and `rg --files | rg q` search what the producer read or listed.
      part = { kind: "search", pattern: next.pattern, path: next.path ?? part.path };
      continue;
    }
    if (part.kind === "search" && next.kind === "search") continue;
    if (stage.writes || !FILTER_PROGRAMS.has(program)) return { kind: "command" };
  }
  return part;
}

/** Split off a leading `cd <dir> &&`: the directory and the command that follows. */
export function splitLeadingCd(command: string): { dir: string; rest: string } | undefined {
  const tokens = tokenizeShell(command);
  if (!tokens || tokens.length < 4) return undefined;
  const [cd, dir, and, next] = tokens;
  if (cd?.type !== "word" || cd.value !== "cd" || dir?.type !== "word" || dir.opaque) return undefined;
  if (and?.type !== "op" || and.value !== "&&" || !next) return undefined;
  return { dir: dir.value, rest: command.slice(next.start).trim() };
}

export interface ShellClassification {
  kind: "read" | "search" | "list" | "command" | "edit";
  path?: string;
  range?: string;
  pattern?: string;
}

/**
 * What a shell command does: a read, search, list or edit when every part of
 * it is one (ignoring `echo`, `true` and bare assignments), otherwise a
 * command. A read reports its path and line range, a search its pattern and
 * path.
 */
export function classifyShellCommand(command: string): ShellClassification {
  const tokens = tokenizeShell(command);
  if (!tokens) return { kind: "command" };
  const parts = stagesOf(tokens)
    .map(classifyPipeline)
    .filter((part) => part.kind !== "noise");
  if (parts.length === 0 || parts.some((part) => part.kind === "command")) return { kind: "command" };
  if (parts.length === 1 && parts[0]?.kind === "edit") return { kind: "edit", path: parts[0].path };
  if (parts.some((part) => part.kind === "edit")) return { kind: "command" };
  const pick =
    parts.find((part) => part.kind === "search") ??
    parts.find((part) => part.kind === "read") ??
    (parts[0] as ShellPart);
  const result: ShellClassification = { kind: pick.kind as ShellClassification["kind"] };
  if (pick.path !== undefined) result.path = pick.path;
  if (pick.range !== undefined) result.range = pick.range;
  if (pick.pattern !== undefined) result.pattern = pick.pattern;
  return result;
}

// ---------------------------------------------------------------------------
// Diff stats
// ---------------------------------------------------------------------------

/**
 * Count added and removed lines in a numbered display diff (`+12 text`,
 * `-12 text`, ` 12 text`) or a unified diff (`+text`, `-text`, without the
 * `+++`/`---` headers).
 */
export function diffStatFromText(diff: string): DiffStat {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/** Paths and line counts named by apply_patch text (`*** Add File:`, `*** Update File:`, `*** Delete File:`). */
function patchTextFiles(patchText: string): { path: string; op: string; added: number; removed: number }[] {
  const files: { path: string; op: string; added: number; removed: number }[] = [];
  let current: (typeof files)[number] | undefined;
  for (const line of patchText.split("\n")) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      current = { op: (header[1] as string).toLowerCase(), path: (header[2] as string).trim(), added: 0, removed: 0 };
      files.push(current);
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move && current) {
      current.path = (move[1] as string).trim();
      continue;
    }
    if (!current || line.startsWith("***")) continue;
    if (line.startsWith("+")) current.added++;
    else if (line.startsWith("-")) current.removed++;
  }
  return files;
}

// ---------------------------------------------------------------------------
// Tool classification
// ---------------------------------------------------------------------------

/** First non-empty string among the argument fields that usually say what a call is about. */
const DETAIL_FIELDS = [
  "path",
  "filePattern",
  "pattern",
  "query",
  "url",
  "objective",
  "question",
  "task",
  "description",
  "diff_description",
  "prompt",
  "task_id",
  "group_id",
];

export function genericDetail(args: unknown): string | undefined {
  const fields = record(args);
  for (const key of DETAIL_FIELDS) {
    const value = text(fields[key]);
    if (value) return firstLine(value);
  }
  return undefined;
}

interface Verbs {
  kind: ActivityKind;
  present: string;
  past: string;
}

/** Fixed verbs for ampi's own tools that read best as a phrase of their own. */
const NAMED_TOOLS: Record<string, Verbs & { object?: string }> = {
  web_search: { kind: "web-search", present: "Searching the web", past: "Searched the web" },
  task_list: { kind: "tool", present: "Updating", past: "Updated", object: "task list" },
};

/**
 * ampi-workers' tools: its subagents, custom Markdown subagents (`sa__<name>`)
 * and background task tools. They draw their own rows, because a worker's
 * outcome is in its result details, which only its own renderer reads (see
 * `tool-renderers.ts`); here they are only named so a run of calls never
 * folds one into a group.
 */
const WORKER_TOOLS = new Set(["finder", "oracle", "librarian", "reviewer", "Task", "start_task", "task_poll", "task_wait", "task_cancel"]);

function isWorkerTool(toolName: string): boolean {
  return WORKER_TOOLS.has(toolName) || toolName.startsWith("sa__");
}

function shellActivity(args: Record<string, unknown>, options: ClassifyOptions): Activity {
  const raw = text(args.command) ?? "";
  const leadingCd = splitLeadingCd(raw);
  const command = leadingCd?.rest ?? raw;
  const workdir = leadingCd
    ? path.isAbsolute(leadingCd.dir) || !options.cwd
      ? leadingCd.dir
      : path.join(options.cwd, leadingCd.dir)
    : undefined;
  const shell = classifyShellCommand(command);
  const output = resultText(options.result);
  const exitCode = /(?:^|\n)Command exited with code (\d+)\s*$/.exec(output)?.[1];
  const timeout = /(?:^|\n)Command timed out after (\d+) seconds\s*$/.exec(output)?.[1];
  const killed = /(?:^|\n)Command terminated without an exit code\s*$/.test(output);
  const ended = timeout !== undefined ? `timed out after ${timeout}s` : killed ? "killed" : undefined;
  const base = {
    toolName: "bash",
    command: raw,
    ...(workdir ? { workdir } : {}),
    ...(exitCode !== undefined ? { exitCode: Number(exitCode) } : {}),
    ...(ended ? { ended } : {}),
  };
  const show = (p: string) => displayPath(p, { cwd: options.cwd, home: options.home, workdir });
  switch (shell.kind) {
    case "read":
      return {
        ...base,
        kind: "read",
        present: "Reading",
        past: "Read",
        object: show(shell.path ?? ""),
        path: shell.path,
        ...(shell.range ? { detail: shell.range, detailSeparator: " " } : {}),
      };
    case "search":
      return {
        ...base,
        kind: "search",
        present: "Grep",
        past: "Grep",
        object: grepObject(shell.pattern, shell.path ? show(shell.path) : undefined),
      };
    case "list":
      return {
        ...base,
        kind: "list",
        present: "Listing",
        past: "Listed",
        object: show(shell.path ?? "."),
        ...(shell.pattern ? { detail: shell.pattern, detailSeparator: " " } : {}),
      };
    case "edit":
      return { ...base, kind: "edit", present: "Editing", past: "Edited", object: show(shell.path ?? ""), path: shell.path };
    default:
      return {
        ...base,
        kind: "command",
        present: "Running",
        past: "Ran",
        object: firstLine(command),
      };
  }
}

function grepObject(pattern: string | undefined, where: string | undefined): string {
  const quoted = pattern !== undefined ? `"${pattern}"` : "";
  return [where, quoted].filter(Boolean).join(" ");
}

/**
 * Classify one tool call. `options.result`, when present, adds what only the
 * result knows: a shell exit code and the diff stat of an edit.
 */
export function classifyToolCall(toolName: string, rawArgs: unknown, options: ClassifyOptions = {}): Activity {
  const args = record(rawArgs);
  const show = (p: string) => displayPath(p, options);
  const details = record(options.result?.details);

  switch (toolName) {
    case "read": {
      const file = text(args.path) ?? "";
      const offset = typeof args.offset === "number" ? args.offset : undefined;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      const range =
        offset === undefined && limit === undefined
          ? undefined
          : formatLineRange(offset ?? 1, limit === undefined ? undefined : (offset ?? 1) + limit - 1);
      return {
        kind: "read",
        toolName,
        present: "Reading",
        past: "Read",
        object: show(file),
        path: file,
        ...(range ? { detail: range, detailSeparator: " " } : {}),
      };
    }
    case "bash":
      return shellActivity(args, options);
    case "grep": {
      const where = text(args.path);
      return {
        kind: "search",
        toolName,
        present: "Grep",
        past: "Grep",
        object: grepObject(text(args.pattern) ?? "", where ? show(where) : undefined),
        ...(text(args.glob) ? { detail: text(args.glob), detailSeparator: " · " } : {}),
      };
    }
    case "find": {
      const where = text(args.path);
      return {
        kind: "search",
        toolName,
        present: "Glob",
        past: "Glob",
        object: text(args.pattern) ?? "",
        ...(where ? { detail: `in ${show(where)}`, detailSeparator: " " } : {}),
      };
    }
    case "ls":
      return { kind: "list", toolName, present: "Listing", past: "Listed", object: show(text(args.path) ?? ".") };
    case "edit": {
      const file = text(args.path) ?? "";
      let diff: DiffStat | undefined;
      if (typeof details.diff === "string") diff = diffStatFromText(details.diff);
      else if (Array.isArray(args.edits)) {
        diff = { added: 0, removed: 0 };
        for (const edit of args.edits) {
          const entry = record(edit);
          diff.added += countLines(typeof entry.newText === "string" ? entry.newText : "");
          diff.removed += countLines(typeof entry.oldText === "string" ? entry.oldText : "");
        }
      }
      return { kind: "edit", toolName, present: "Editing", past: "Edited", object: show(file), path: file, ...(diff ? { diff } : {}) };
    }
    case "write": {
      const file = text(args.path) ?? "";
      const content = typeof args.content === "string" ? args.content : undefined;
      return {
        kind: "create",
        toolName,
        present: "Creating",
        past: "Created",
        object: show(file),
        path: file,
        ...(content !== undefined ? { diff: { added: countLines(content), removed: 0 } } : {}),
      };
    }
    case "apply_patch":
      return patchActivity(args, details, options);
    case "read_web_page": {
      const url = text(args.url) ?? "";
      return { kind: "web-read", toolName, present: "Reading", past: "Read", object: url };
    }
    default:
      break;
  }

  const named = NAMED_TOOLS[toolName];
  if (named) {
    const detail = toolName === "task_list" ? taskListDetail(args) : genericDetail(args);
    return {
      kind: named.kind,
      toolName,
      present: named.present,
      past: named.past,
      object: named.object ?? "",
      ...(detail ? { detail, detailSeparator: " · " } : {}),
    };
  }

  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  const detail = genericDetail(args);
  return {
    kind: isWorkerTool(toolName) ? "subagent" : "tool",
    toolName,
    present: "Running",
    past: "Ran",
    object: mcp ? `${mcp[1]}/${mcp[2]}` : toolName,
    ...(mcp ? { server: mcp[1] } : {}),
    ...(detail ? { detail, detailSeparator: " · " } : {}),
  };
}

function taskListDetail(args: Record<string, unknown>): string | undefined {
  if (!Array.isArray(args.tasks)) return undefined;
  return `${args.tasks.length} ${args.tasks.length === 1 ? "item" : "items"}`;
}

function patchActivity(args: Record<string, unknown>, details: Record<string, unknown>, options: ClassifyOptions): Activity {
  const fromResult = Array.isArray(details.files)
    ? details.files.map((file) => {
        const entry = record(file);
        return {
          path: typeof entry.path === "string" ? entry.path : "",
          op: typeof entry.type === "string" ? entry.type : "update",
          added: typeof entry.additions === "number" ? entry.additions : 0,
          removed: typeof entry.deletions === "number" ? entry.deletions : 0,
        };
      })
    : undefined;
  const files = fromResult ?? patchTextFiles(text(args.patchText) ?? "");
  const diff = files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), {
    added: 0,
    removed: 0,
  });
  const allAdded = files.length > 0 && files.every((file) => file.op === "add");
  const verbs = allAdded
    ? { kind: "create" as const, present: "Creating", past: "Created" }
    : { kind: "edit" as const, present: "Editing", past: "Edited" };
  const only = files.length === 1 ? files[0] : undefined;
  return {
    ...verbs,
    toolName: "apply_patch",
    object: only ? displayPath(only.path, options) : `${files.length} files`,
    ...(only ? { path: only.path } : {}),
    paths: files.map((file) => file.path),
    ...(files.length > 0 ? { diff } : {}),
  };
}

// ---------------------------------------------------------------------------
// Titles and summaries
// ---------------------------------------------------------------------------

export type TitleRole = "verb" | "object" | "muted" | "added" | "removed" | "error";

export interface TitlePart {
  text: string;
  role: TitleRole;
}

/** `+N -M` as title parts; zero counts are left out. */
export function diffStatParts(diff: DiffStat | undefined): TitlePart[] {
  if (!diff) return [];
  const parts: TitlePart[] = [];
  if (diff.added > 0) parts.push({ text: `+${diff.added}`, role: "added" });
  if (diff.removed > 0) parts.push({ text: `-${diff.removed}`, role: "removed" });
  return parts.flatMap((part, i) => (i === 0 ? [part] : [{ text: " ", role: "muted" as const }, part]));
}

/**
 * The one-line title of an activity: verb, object, detail, then the diff
 * stat of a call that did not fail, or the exit code of a failed command.
 */
export function activityTitle(activity: Activity, status: ActivityStatus): TitlePart[] {
  const parts: TitlePart[] = [{ text: status === "running" ? activity.present : activity.past, role: "verb" }];
  if (activity.object) parts.push({ text: ` ${activity.object}`, role: "object" });
  if (activity.detail) {
    const separator = activity.detailSeparator ?? " ";
    parts.push({ text: `${separator}${activity.detail}`, role: "muted" });
  }
  // A failed or cancelled edit changed nothing, so it shows no stat.
  const stat = status === "error" || status === "cancelled" ? [] : diffStatParts(activity.diff);
  if (stat.length > 0) parts.push({ text: " ", role: "muted" }, ...stat);
  if (activity.exitCode !== undefined && activity.exitCode !== 0) {
    parts.push({ text: " (exit code: ", role: "muted" }, { text: String(activity.exitCode), role: "error" }, { text: ")", role: "muted" });
  }
  if (activity.ended) parts.push({ text: ` (${activity.ended})`, role: "muted" });
  return parts;
}

export interface ActivityEntry {
  activity: Activity;
  status: ActivityStatus;
}

interface Category {
  present: string;
  past: string;
  noun: [string, string];
}

const CATEGORIES: Record<string, Category> = {
  command: { present: "Running", past: "Ran", noun: ["command", "commands"] },
  search: { present: "Running", past: "Ran", noun: ["search", "searches"] },
  "web-search": { present: "Running", past: "Ran", noun: ["web search", "web searches"] },
  read: { present: "Reading", past: "Read", noun: ["file", "files"] },
  "web-read": { present: "Reading", past: "Read", noun: ["web page", "web pages"] },
  files: { present: "Editing", past: "Edited", noun: ["file", "files"] },
  tool: { present: "Running", past: "Ran", noun: ["tool", "tools"] },
};

function categoryOf(kind: ActivityKind): string {
  if (kind === "list") return "search";
  if (kind === "edit" || kind === "create") return "files";
  if (kind === "subagent") return "tool";
  return kind;
}

/**
 * One phrase for a run of activities, e.g. "Ran 3 commands, read 4 files,
 * edited 2 files (+265 -4)". Clauses follow the order in which their kind
 * first appears; a clause uses its present verb while any of its calls
 * runs. Files changed by several calls count once, and the diff stat leaves
 * out failed and cancelled calls, as their rows do. Cancelled calls are
 * counted in parentheses.
 */
export function summarizeActivities(entries: readonly ActivityEntry[]): string {
  const groups = new Map<string, ActivityEntry[]>();
  for (const entry of entries) {
    const key = categoryOf(entry.activity.kind);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  const clauses: string[] = [];
  for (const [key, group] of groups) {
    const category = CATEGORIES[key] as Category;
    const running = group.some((entry) => entry.status === "running");
    let present = category.present;
    let past = category.past;
    let count = group.length;
    const tail: string[] = [];
    if (key === "files") {
      const kinds = new Set(group.map((entry) => entry.activity.kind));
      if (!kinds.has("edit")) [present, past] = ["Creating", "Created"];
      else if (kinds.has("create")) [present, past] = ["Changing", "Changed"];
      const paths = new Set<string>();
      let unnamed = 0;
      const diff = { added: 0, removed: 0 };
      for (const { activity, status } of group) {
        const touched = activity.paths ?? (activity.path ? [activity.path] : []);
        if (touched.length === 0) unnamed++;
        for (const p of touched) paths.add(p);
        if (status !== "error" && status !== "cancelled" && activity.diff) {
          diff.added += activity.diff.added;
          diff.removed += activity.diff.removed;
        }
      }
      count = paths.size + unnamed;
      const stat = diffStatParts(diff)
        .map((part) => part.text)
        .join("");
      if (stat) tail.push(stat);
    }
    const cancelled = group.filter((entry) => entry.status === "cancelled").length;
    if (cancelled > 0) tail.push(`${cancelled} cancelled`);
    const verb = running ? present : past;
    const noun = count === 1 ? category.noun[0] : category.noun[1];
    clauses.push(`${verb} ${count} ${noun}${tail.length > 0 ? ` (${tail.join(", ")})` : ""}`);
  }
  return clauses.map((clause, i) => (i === 0 ? clause : clause[0]?.toLowerCase() + clause.slice(1))).join(", ");
}
