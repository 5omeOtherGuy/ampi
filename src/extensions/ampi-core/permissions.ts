import { isRecord } from "./internal/json.js";
import { MMR_PERMISSIONS_DEFAULT_RULES } from "./permission-defaults.js";
import { tokenizeShell } from "./tool-activity.js";

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

/**
 * Split a shell line into simple commands at `;`, `&&`, `||`, `|`, `&` and
 * newlines. Returns undefined for a line the shell tokenizer cannot follow
 * (heredocs, comments, unbalanced quotes or parentheses).
 */
export function splitMmrShellCommand(command: string): MmrShellCommandPart[] | undefined {
  const tokens = tokenizeShell(command);
  if (!tokens) return undefined;
  const parts: MmrShellCommandPart[] = [];
  let start: number | undefined;
  let end = 0;
  let opaque = false;
  const close = () => {
    if (start !== undefined) parts.push({ text: command.slice(start, end), opaque });
    start = undefined;
    opaque = false;
  };
  for (const token of tokens) {
    if (token.type === "op" && SEPARATORS.has(token.value)) {
      close();
      continue;
    }
    start ??= token.start;
    end = token.end;
    if (token.type === "word" && token.opaque) opaque = true;
  }
  close();
  return parts;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function firstMatch(
  sources: MmrPermissionRuleSources,
  toolName: string,
  input: unknown,
  context: MmrPermissionContext,
): MmrPermissionDecision {
  const ordered: [MmrPermissionRuleSource, readonly MmrPermissionRule[]][] = [
    ["project", sources.project ?? []],
    ["user", sources.user ?? []],
    ["default", sources.defaults ?? MMR_PERMISSIONS_DEFAULT_RULES],
  ];
  for (const [source, rules] of ordered) {
    for (const rule of rules) {
      if (matchesMmrPermissionRule(rule, toolName, input, context)) return { action: rule.action, rule, source };
    }
  }
  return { action: "allow" };
}

function evaluateShellLine(
  sources: MmrPermissionRuleSources,
  call: MmrPermissionCall,
  command: string,
  context: MmrPermissionContext,
): MmrPermissionDecision {
  const input = call.input as Record<string, unknown>;
  const parts = splitMmrShellCommand(command);
  if (!parts) {
    const whole = firstMatch(sources, call.toolName, input, context);
    if (whole.action === "reject") return whole;
    return { action: "ask", reason: "ampi cannot split this command line into simple commands" };
  }
  if (parts.length === 0) return firstMatch(sources, call.toolName, input, context);

  const decisions = parts.map((part): MmrPermissionDecision => {
    const decision = { ...firstMatch(sources, call.toolName, { ...input, command: part.text }, context), command: part.text };
    if (!part.opaque || decision.action === "reject") return decision;
    if (decision.action === "ask") return decision;
    return { action: "ask", command: part.text, reason: "this command runs a subshell or command substitution" };
  });
  const rejected = decisions.find((decision) => decision.action === "reject");
  if (rejected) return rejected;
  const pending = decisions.find((decision) => decision.action !== "allow");
  if (!pending) return { action: "allow" };
  if (parts.length === 1) return pending;
  return pending.action === "ask" ? pending : { ...pending, action: "ask" };
}

/**
 * Decide a tool call: the first matching rule of the project, then the user,
 * then ampi's defaults; no match allows. Shell lines are judged per simple
 * command (see the module comment): any rejected part rejects the line, all
 * allowed parts allow it, anything else asks.
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
