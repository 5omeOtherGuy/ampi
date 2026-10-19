import { isRecord } from "./internal/json.js";
import { MMR_PERMISSIONS_DEFAULT_RULES } from "./permission-defaults.js";
import { type ShellToken, tokenizeShell } from "./tool-activity.js";

/**
 * Permission rules for tool calls: the rule shape, its validation, matching
 * and evaluation. Pure: no settings files, no UI. `ampi-permissions` reads the
 * rules from settings and asks the user; this module only decides.
 *
 * A rule names a tool (a glob), optional input patterns, and what happens to
 * a call it matches: `allow`, `reject`, `ask`, or `delegate` to a program.
 * The first matching rule wins; project rules come first, then user rules,
 * then ampi's defaults. A call no rule matches is allowed.
 *
 * Shell tools (`bash`, `shell_command`) are judged per simple command: the
 * line is split at `;`, `&&`, `||`, `|`, `&` and newlines, and each part is
 * evaluated with the input's `command` replaced by that part's text.
 *
 * A `delegate` decision only names the program; running it is the caller's
 * job (`ampi-permissions` does it), so this module never starts a process.
 */

export type MmrPermissionAction = "allow" | "reject" | "ask" | "delegate";
export type MmrPermissionContext = "thread" | "subagent";
export type MmrPermissionRuleSource = "project" | "user" | "default";

/**
 * What an input field must look like. A string is a glob over the whole value
 * (`*` any run of characters, `?` one character) or a `/source/flags` regular
 * expression that is searched; a list matches when any entry does; an object
 * recurses into the field; booleans, numbers and null compare strictly.
 */
export type MmrPermissionPattern =
  | string
  | boolean
  | number
  | null
  | readonly MmrPermissionPattern[]
  | { readonly [field: string]: MmrPermissionPattern };

export interface MmrPermissionRule {
  /** Glob over the tool name. */
  readonly tool: string;
  /** Input field name to pattern; every field must match. */
  readonly matches?: { readonly [field: string]: MmrPermissionPattern };
  readonly action: MmrPermissionAction;
  /** Where the rule applies; without it, everywhere. */
  readonly context?: MmrPermissionContext;
  /** The program a `delegate` rule hands the decision to. */
  readonly to?: string;
  /** The reason a `reject` rule gives the agent. */
  readonly message?: string;
}

export interface MmrPermissionDecision {
  readonly action: MmrPermissionAction;
  /** The rule that decided; absent when no rule matched or ampi asked on its own. */
  readonly rule?: MmrPermissionRule;
  readonly source?: MmrPermissionRuleSource;
  /** For a shell line split into parts: the part that decided. */
  readonly command?: string;
  /** Why ampi asks when no rule asked (an opaque or unreadable command). */
  readonly reason?: string;
  /**
   * For a shell line of more than one simple command: every part's decision,
   * in line order, each with its `command`. A `delegate` decision for such a
   * line means at least one part waits for its program and none is rejected.
   */
  readonly parts?: readonly MmrPermissionDecision[];
}

export interface MmrPermissionRuleSources {
  readonly project?: readonly MmrPermissionRule[];
  readonly user?: readonly MmrPermissionRule[];
  /** ampi's defaults unless given. */
  readonly defaults?: readonly MmrPermissionRule[];
}

export interface MmrPermissionCall {
  readonly toolName: string;
  readonly input: unknown;
}

export interface EvaluateMmrPermissionOptions {
  /** Where the call runs; `thread` unless given. */
  readonly context?: MmrPermissionContext;
}

/** Tools whose `command` is split into simple commands before matching. */
export const MMR_PERMISSIONS_SHELL_TOOLS: readonly string[] = Object.freeze(["bash", "shell_command"]);

const ACTIONS: ReadonlySet<string> = new Set(["allow", "reject", "ask", "delegate"]);
const CONTEXTS: ReadonlySet<string> = new Set(["thread", "subagent"]);
const RULE_KEYS: ReadonlySet<string> = new Set(["tool", "matches", "action", "context", "to", "message"]);
const REGEX_FORM = /^\/(.+)\/([dgimsuyv]*)$/s;

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const compiled = new Map<string, RegExp>();

function globToRegExp(glob: string): RegExp {
  let source = "";
  for (const ch of glob) {
    if (ch === "*") source += "[\\s\\S]*";
    else if (ch === "?") source += "[\\s\\S]";
    else source += ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "u");
}

/** The regular expression a string pattern stands for; throws for an invalid `/regex/`. */
function compilePattern(pattern: string): RegExp {
  const cached = compiled.get(pattern);
  if (cached) return cached;
  const regex = REGEX_FORM.exec(pattern);
  // `g` and `y` would make `test` remember where it stopped.
  const result = regex ? new RegExp(regex[1] as string, (regex[2] as string).replace(/[gy]/g, "")) : globToRegExp(pattern);
  compiled.set(pattern, result);
  return result;
}

function matchesPattern(pattern: MmrPermissionPattern, value: unknown): boolean {
  if (Array.isArray(pattern)) return pattern.some((entry) => matchesPattern(entry, value));
  if (typeof pattern === "string") return typeof value === "string" && compilePattern(pattern).test(value);
  if (pattern === null || typeof pattern !== "object") return pattern === value;
  return isRecord(value) && matchesFields(pattern as Record<string, MmrPermissionPattern>, value);
}

function matchesFields(fields: { readonly [field: string]: MmrPermissionPattern }, input: Record<string, unknown>): boolean {
  for (const [field, pattern] of Object.entries(fields)) {
    if (!Object.hasOwn(input, field) || input[field] === undefined) return false;
    if (!matchesPattern(pattern, input[field])) return false;
  }
  return true;
}

/**
 * Whether `rule` applies to a call of `toolName` with `input` in `context`.
 * A field the rule names but the input lacks never matches.
 */
export function matchesMmrPermissionRule(
  rule: MmrPermissionRule,
  toolName: string,
  input: unknown,
  context: MmrPermissionContext = "thread",
): boolean {
  if (rule.context !== undefined && rule.context !== context) return false;
  if (!compilePattern(rule.tool).test(toolName)) return false;
  if (rule.matches === undefined) return true;
  return isRecord(input) && matchesFields(rule.matches, input);
}

// ---------------------------------------------------------------------------
// Delegate programs
// ---------------------------------------------------------------------------

export interface MmrPermissionProgramWord {
  /** The word with quotes and escapes removed. */
  readonly value: string;
  /** The word as written in `to`, quotes included. */
  readonly raw: string;
}

/**
 * Split a delegate rule's `to` into the program and its arguments, the way a
 * shell would split a simple command, but without running one: operators,
 * redirections, subshells, `$(...)`, backticks, variables and brace
 * expansions are problems, because nothing would expand or run them.
 */
export function parseMmrPermissionProgram(to: string): { words?: MmrPermissionProgramWord[]; problem?: string } {
  const tokens = tokenizeShell(to);
  if (!tokens) return { problem: "ampi cannot read this program line (a comment, a heredoc or unbalanced quotes)" };
  const operator = tokens.find((token) => token.type === "op");
  if (operator) return { problem: `a program and its arguments only, without operators or redirections (found ${operator.value})` };
  if (tokens.some((token) => token.type === "word" && token.opaque === true)) {
    return { problem: "a program and its arguments only, without a subshell, $(...) or backticks" };
  }
  const words = tokens.map((token) => ({ value: token.value, raw: to.slice(token.start, token.end) }));
  if (words.some((word) => expandsAtRunTime(word.raw))) {
    return { problem: "variables, $'...' quoting and brace expansions are not expanded; write the value out" };
  }
  if (words.length === 0) return { problem: "a delegate rule needs to: the program to run" };
  return { words };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function patternProblems(pattern: unknown, at: string): string[] {
  if (typeof pattern === "string") {
    if (!REGEX_FORM.test(pattern)) return [];
    try {
      compilePattern(pattern);
      return [];
    } catch (error) {
      return [`${at}: invalid regular expression ${pattern} (${error instanceof Error ? error.message : String(error)})`];
    }
  }
  if (typeof pattern === "boolean" || pattern === null) return [];
  if (typeof pattern === "number") return Number.isFinite(pattern) ? [] : [`${at}: expected a finite number`];
  if (Array.isArray(pattern)) {
    if (pattern.length === 0) return [`${at}: an empty list matches nothing`];
    return pattern.flatMap((entry, index) => patternProblems(entry, `${at}[${index}]`));
  }
  if (isRecord(pattern)) {
    const fields = Object.entries(pattern);
    if (fields.length === 0) return [`${at}: an empty object matches every object; leave the field out instead`];
    return fields.flatMap(([field, entry]) => patternProblems(entry, `${at}.${field}`));
  }
  return [`${at}: expected a string, true or false, a number, null, a list or an object`];
}

/**
 * What is wrong with `value` as a permission rule; empty when it is valid.
 * Unknown keys are problems too, so a misspelt `matches` cannot widen a rule.
 */
export function validateMmrPermissionRule(value: unknown): string[] {
  if (!isRecord(value)) return ["a rule must be an object"];
  const problems: string[] = [];
  for (const key of Object.keys(value)) {
    if (!RULE_KEYS.has(key)) problems.push(`unknown field "${key}"`);
  }
  if (typeof value.tool !== "string" || value.tool.length === 0) problems.push("tool must be a non-empty string");
  if (typeof value.action !== "string" || !ACTIONS.has(value.action)) {
    problems.push(`action must be allow, reject, ask or delegate (got ${JSON.stringify(value.action) ?? "nothing"})`);
  }
  if (value.matches !== undefined) {
    if (!isRecord(value.matches)) problems.push("matches must be an object of input field names to patterns");
    else problems.push(...Object.entries(value.matches).flatMap(([field, pattern]) => patternProblems(pattern, `matches.${field}`)));
  }
  if (value.context !== undefined && (typeof value.context !== "string" || !CONTEXTS.has(value.context))) {
    problems.push("context must be thread or subagent");
  }
  if (value.action === "delegate") {
    if (typeof value.to !== "string" || value.to.trim().length === 0) problems.push("a delegate rule needs to: the program to run");
    else {
      const program = parseMmrPermissionProgram(value.to);
      if (program.problem !== undefined) problems.push(`to: ${program.problem}`);
    }
  } else if (value.to !== undefined) {
    problems.push("to is allowed only on a delegate rule");
  }
  if (value.message !== undefined) {
    if (value.action !== "reject") problems.push("message is allowed only on a reject rule");
    else if (typeof value.message !== "string") problems.push("message must be a string");
  }
  return problems;
}

export interface MmrPermissionRuleProblem {
  /** Position of the rule in the list. */
  readonly index: number;
  readonly problems: readonly string[];
}

/** Split a settings list into its valid rules and the problems of the others. */
export function parseMmrPermissionRules(value: readonly unknown[]): {
  rules: MmrPermissionRule[];
  problems: MmrPermissionRuleProblem[];
} {
  const rules: MmrPermissionRule[] = [];
  const problems: MmrPermissionRuleProblem[] = [];
  for (const [index, entry] of value.entries()) {
    const found = validateMmrPermissionRule(entry);
    if (found.length > 0) problems.push({ index, problems: found });
    else rules.push(entry as unknown as MmrPermissionRule);
  }
  return { rules, problems };
}

// ---------------------------------------------------------------------------
// Text form
// ---------------------------------------------------------------------------

function quote(text: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

function formatPatternFlags(field: string, pattern: MmrPermissionPattern): string[] {
  if (Array.isArray(pattern)) return pattern.flatMap((entry) => formatPatternFlags(field, entry));
  if (typeof pattern === "string") return [`--${field} ${quote(pattern)}`];
  if (pattern !== null && typeof pattern === "object") {
    return Object.entries(pattern).flatMap(([key, entry]) => formatPatternFlags(`${field}.${key}`, entry));
  }
  return [`--${field} ${JSON.stringify(pattern)}`];
}

/**
 * A rule as one line: `<action> <tool> --<field> <pattern>...`, then
 * `--context`, `--to` and `--message` when set. A list repeats its field.
 */
export function formatMmrPermissionRule(rule: MmrPermissionRule): string {
  const parts = [rule.action, quote(rule.tool)];
  for (const [field, pattern] of Object.entries(rule.matches ?? {})) parts.push(...formatPatternFlags(field, pattern));
  if (rule.context !== undefined) parts.push(`--context ${rule.context}`);
  if (rule.to !== undefined) parts.push(`--to ${quote(rule.to)}`);
  if (rule.message !== undefined) parts.push(`--message ${quote(rule.message)}`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Shell splitting
// ---------------------------------------------------------------------------

export interface MmrShellCommandPart {
  /** The part's original text. */
  readonly text: string;
  /** Contains a subshell, `$(...)` or backticks, whose inside ampi does not read. */
  readonly opaque: boolean;
}

const SEPARATORS: ReadonlySet<string> = new Set([";", "&&", "||", "|", "&"]);

const WRITES_FILE = "this command writes its output into a file";
const EXPANDS = "this command has a variable, $'...' quoting or a brace expansion, so ampi cannot read its words";

interface ShellPartDetail extends MmrShellCommandPart {
  /** The part with quotes and escapes removed: its words and operators joined by single spaces. */
  readonly literal: string;
  /** Why ampi's defaults cannot allow the part, when they cannot. */
  readonly unsafe?: string;
}

/**
 * Whether a word's original text can turn into other words when the shell
 * runs it: a variable (`$X`, `${X:-y}`), `$'...'` or `$"..."` quoting, or a
 * brace expansion such as `{a,b}`. Subshells and `$(...)` are opaque words
 * and handled on their own.
 */
function expandsAtRunTime(raw: string): boolean {
  let quote: string | undefined;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] as string;
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === '"' || (ch === "'" && !quote)) {
      quote = quote === ch ? undefined : quote ?? ch;
      continue;
    }
    const next = raw[i + 1] ?? "";
    // Inside double quotes a `$` right before the closing quote is literal.
    if (ch === "$" && /[\w{@*#?$!'"-]/.test(next) && !(quote && next === '"')) return true;
    if (ch === "{" && !quote) {
      const close = raw.indexOf("}", i);
      if (close > i && /,|\.\./.test(raw.slice(i, close))) return true;
    }
  }
  return false;
}

/** Why the defaults cannot allow a part: it writes into a file, or its words are not literal. */
function unsafeReason(command: string, tokens: readonly ShellToken[]): string | undefined {
  for (const [index, token] of tokens.entries()) {
    if (token.type !== "op" || !token.value.includes(">")) continue;
    const target = tokens[index + 1];
    const value = target?.type === "word" && !target.opaque ? target.value : undefined;
    // `2>&1` and `>&-` copy or close a descriptor; /dev/null is no file.
    if (value === "/dev/null" || (token.value.endsWith("&") && value !== undefined && /^(\d+|-)$/.test(value))) continue;
    return WRITES_FILE;
  }
  const words = tokens.filter((token) => token.type === "word");
  if (words.some((word) => expandsAtRunTime(command.slice(word.start, word.end)))) return EXPANDS;
  return undefined;
}

function describePart(command: string, tokens: readonly ShellToken[]): ShellPartDetail {
  const opaque = tokens.some((token) => token.type === "word" && token.opaque === true);
  return {
    text: command.slice((tokens[0] as ShellToken).start, (tokens.at(-1) as ShellToken).end),
    opaque,
    literal: tokens.map((token) => token.value).join(" "),
    // An opaque part asks anyway, for its own reason.
    unsafe: opaque ? undefined : unsafeReason(command, tokens),
  };
}

function readShellParts(command: string): ShellPartDetail[] | undefined {
  const tokens = tokenizeShell(command);
  if (!tokens) return undefined;
  const parts: ShellPartDetail[] = [];
  let current: ShellToken[] = [];
  for (const token of tokens) {
    if (token.type !== "op" || !SEPARATORS.has(token.value)) {
      current.push(token);
      continue;
    }
    if (current.length > 0) parts.push(describePart(command, current));
    current = [];
  }
  if (current.length > 0) parts.push(describePart(command, current));
  return parts;
}

/**
 * Split a shell line into simple commands at `;`, `&&`, `||`, `|`, `&` and
 * newlines. Returns undefined for a line the shell tokenizer cannot follow
 * (heredocs, comments, unbalanced quotes or parentheses).
 */
export function splitMmrShellCommand(command: string): MmrShellCommandPart[] | undefined {
  return readShellParts(command)?.map(({ text, opaque }) => ({ text, opaque }));
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

const ALLOW: MmrPermissionDecision = Object.freeze({ action: "allow" });

function findRule(
  source: MmrPermissionRuleSource,
  rules: readonly MmrPermissionRule[] | undefined,
  toolName: string,
  input: unknown,
  context: MmrPermissionContext,
): MmrPermissionDecision | undefined {
  const rule = rules?.find((candidate) => matchesMmrPermissionRule(candidate, toolName, input, context));
  return rule ? { action: rule.action, rule, source } : undefined;
}

function firstMatch(
  sources: MmrPermissionRuleSources,
  toolName: string,
  input: unknown,
  context: MmrPermissionContext,
): MmrPermissionDecision {
  return (
    findRule("project", sources.project, toolName, input, context) ??
    findRule("user", sources.user, toolName, input, context) ??
    findRule("default", sources.defaults ?? MMR_PERMISSIONS_DEFAULT_RULES, toolName, input, context) ??
    ALLOW
  );
}

/**
 * ampi's defaults judge a part on its original text and on its literal words,
 * so quotes or escapes cannot hide an option an exception looks for
 * (`find . '-delete'`). They allow it only when both forms are allowed and it
 * neither writes into a file nor has words that change when the shell runs it.
 */
function decideByDefaults(
  defaults: readonly MmrPermissionRule[],
  toolName: string,
  input: Record<string, unknown>,
  part: ShellPartDetail,
  context: MmrPermissionContext,
): MmrPermissionDecision {
  const original = findRule("default", defaults, toolName, input, context) ?? ALLOW;
  if (original.action !== "allow") return original;
  const literal = findRule("default", defaults, toolName, { ...input, command: part.literal }, context) ?? ALLOW;
  if (literal.action !== "allow") return literal;
  if (part.unsafe !== undefined && original.rule) return { action: "ask", reason: part.unsafe };
  return original;
}

function evaluateShellLine(
  sources: MmrPermissionRuleSources,
  call: MmrPermissionCall,
  command: string,
  context: MmrPermissionContext,
): MmrPermissionDecision {
  const input = call.input as Record<string, unknown>;
  const parts = readShellParts(command);
  if (!parts) {
    const whole = firstMatch(sources, call.toolName, input, context);
    if (whole.action === "reject") return whole;
    return { action: "ask", reason: "ampi cannot split this command line into simple commands" };
  }
  if (parts.length === 0) return firstMatch(sources, call.toolName, input, context);

  const decisions = parts.map((part): MmrPermissionDecision => {
    // Project and user rules match the part's original text.
    const partInput = { ...input, command: part.text };
    const decision = {
      ...(findRule("project", sources.project, call.toolName, partInput, context) ??
        findRule("user", sources.user, call.toolName, partInput, context) ??
        decideByDefaults(sources.defaults ?? MMR_PERMISSIONS_DEFAULT_RULES, call.toolName, partInput, part, context)),
      command: part.text,
    };
    if (!part.opaque || decision.action === "reject") return decision;
    if (decision.action === "ask") return decision;
    return { action: "ask", command: part.text, reason: "this command runs a subshell or command substitution" };
  });
  if (parts.length === 1) {
    const [only] = decisions as [MmrPermissionDecision];
    return only.action === "allow" ? ALLOW : only;
  }
  // A rejected part decides without running any program; delegated parts
  // come next, since one of their programs may still reject the line.
  const decided =
    decisions.find((decision) => decision.action === "reject") ??
    decisions.find((decision) => decision.action === "delegate") ??
    decisions.find((decision) => decision.action === "ask");
  return { ...(decided ?? ALLOW), parts: decisions };
}

/**
 * Decide a tool call: the first matching rule of the project, then the user,
 * then ampi's defaults; no match allows. Shell lines are judged per simple
 * command (see the module comment): any rejected part rejects the line; else
 * a delegated part makes the line `delegate`, with every part's decision in
 * `parts`; else any asking part asks; else the line is allowed.
 */
export function evaluateMmrPermission(
  call: MmrPermissionCall,
  sources: MmrPermissionRuleSources = {},
  options: EvaluateMmrPermissionOptions = {},
): MmrPermissionDecision {
  const context = options.context ?? "thread";
  const command = isRecord(call.input) ? call.input.command : undefined;
  if (MMR_PERMISSIONS_SHELL_TOOLS.includes(call.toolName) && typeof command === "string") {
    return evaluateShellLine(sources, call, command, context);
  }
  return firstMatch(sources, call.toolName, call.input, context);
}

// ---------------------------------------------------------------------------
// Session override
// ---------------------------------------------------------------------------

const SESSION_ALLOW_ALL_KEY = "__pi_ampi_permissions_session_allow_all_v1__";

/**
 * Allow every tool call for the rest of this session (the approval dialog's
 * "Allow All for This Session"). Kept on a process global so every copy of
 * ampi-core, and the worker runner, sees the same answer.
 */
export function setMmrPermissionsSessionAllowAll(value: boolean): void {
  (globalThis as Record<string, unknown>)[SESSION_ALLOW_ALL_KEY] = value;
}

/** Whether the user allowed every tool call for this session. */
export function isMmrPermissionsSessionAllowAll(): boolean {
  return (globalThis as Record<string, unknown>)[SESSION_ALLOW_ALL_KEY] === true;
}

const PROJECT_TRUSTED_KEY = "__pi_ampi_permissions_project_trusted_v1__";

/**
 * Whether this session reads the project's permission rules: Pi trusts the
 * project, or (in a subagent child) the parent did. Kept on a process global
 * like the session override, so the worker runner can pass it on.
 */
export function setMmrPermissionsProjectTrusted(value: boolean): void {
  (globalThis as Record<string, unknown>)[PROJECT_TRUSTED_KEY] = value;
}

/** Whether this session reads the project's permission rules. */
export function isMmrPermissionsProjectTrusted(): boolean {
  return (globalThis as Record<string, unknown>)[PROJECT_TRUSTED_KEY] === true;
}

/** Set to `1` in a worker child's environment while the parent allows every tool call. */
export const AMPI_PERMISSIONS_ALLOW_ALL_ENV = "AMPI_PERMISSIONS_ALLOW_ALL";
/** Set to `1` in a worker child's environment while the parent reads the project's rules. */
export const AMPI_PERMISSIONS_PROJECT_RULES_ENV = "AMPI_PERMISSIONS_PROJECT_RULES";

/**
 * Write this process's permission answers into a worker child's environment:
 * each variable is `1` while its answer holds and removed otherwise, so a
 * value inherited from this process never reaches a child on its own.
 */
export function writeMmrPermissionsChildEnv(env: Record<string, string | undefined>): void {
  if (isMmrPermissionsSessionAllowAll()) env[AMPI_PERMISSIONS_ALLOW_ALL_ENV] = "1";
  else delete env[AMPI_PERMISSIONS_ALLOW_ALL_ENV];
  if (isMmrPermissionsProjectTrusted()) env[AMPI_PERMISSIONS_PROJECT_RULES_ENV] = "1";
  else delete env[AMPI_PERMISSIONS_PROJECT_RULES_ENV];
}
