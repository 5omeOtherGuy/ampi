/**
 * Transcript rows for tool calls.
 *
 * Collapsed, every call is one line: a status glyph and the activity title
 * from `activity.ts` ("✓ Read src/index.ts L1-120", "✗ Ran npm test (exit
 * code: 1)"). Expanded (Pi's global tool expansion, Ctrl+O), ampi draws a
 * card for shell commands, file edits, reads, searches and MCP tools: the
 * command with its output, the edited path with a numbered diff, or the
 * arguments and result of a generic tool. Other tools that bring their own
 * renderers (ampi's task list, other extensions' tools) keep their own card
 * when expanded and only get the one-line row. ampi-workers' tools draw
 * their rows themselves, collapsed and expanded: a worker's outcome is in
 * its result details, which only its own renderer reads.
 *
 * A run of consecutive calls (see `activity-groups.ts`) folds into one
 * summary row ("✓ Ran 3 commands, read 4 files ▸") drawn by the run's first
 * call; the other calls draw nothing, so Pi leaves no gap for them. Expanded,
 * the summary row ends in "▾" and every call draws its row and card below it,
 * indented by two columns.
 *
 * Rows draw their own framing (`renderShell: "self"`), use theme colours
 * for text only and never a background.
 */

import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ExtensionAPI,
  ThemeColor,
  ToolRendererResolver,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { type Component, getCapabilities, hyperlink, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  type Activity,
  type ActivityStatus,
  activityTitle,
  classifyToolCall,
  diffStatParts,
  displayPath,
  resultStatus,
  resultText,
  splitLeadingCd,
  type TitlePart,
  type TitleRole,
  tokenizeShell,
} from "../../ampi-core/tool-activity.js";
import { isMmrAnimationDisabled } from "../../ampi-core/animation.js";
import { createMmrSpinner, MMR_SPINNER_INTERVAL_MS, type MmrSpinner } from "../../ampi-core/spinner.js";
import { ActivityGroupStore, type GroupAggregate, trackActivityGroups } from "./activity-groups.js";

type CallRenderer = NonNullable<ToolRenderers["renderCall"]>;
type ResultRenderer = NonNullable<ToolRenderers["renderResult"]>;
type RenderTheme = Parameters<CallRenderer>[1];
type RenderContext = Parameters<CallRenderer>[2];
type ToolResult = Parameters<ResultRenderer>[0];

/** Output lines an expanded card shows before "… N more lines". */
export const CARD_OUTPUT_LINES = 15;
/** Diff lines an expanded edit card shows before "… N more lines". */
export const CARD_DIFF_LINES = 60;
/** Columns an expanded group indents its calls by, under the summary row. */
const GROUP_INDENT = 2;

/** Tools whose expanded card ampi draws itself. Others keep their own renderers when expanded. */
const OWN_CARDS = new Set([
  "bash",
  "shell_command",
  "shell_command_status",
  "shell_command_kill",
  "read",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "apply_patch",
]);

/** Tools whose expanded card starts with the `$ command` line. */
const SHELL_TOOLS = new Set(["bash", "shell_command"]);

const STATUS_GLYPH: Record<Exclude<ActivityStatus, "running">, string> = { done: "✓", error: "✗", cancelled: "⊘" };
const STATUS_COLOR: Record<ActivityStatus, ThemeColor> = {
  running: "accent",
  done: "success",
  error: "error",
  cancelled: "warning",
};
const ROLE_COLOR: Record<TitleRole, ThemeColor> = {
  verb: "toolTitle",
  object: "toolTitle",
  muted: "muted",
  added: "toolDiffAdded",
  removed: "toolDiffRemoved",
  error: "error",
};

interface RowState {
  /** The running glyph, stepped by `timer`. */
  spinner: MmrSpinner;
  timer?: ReturnType<typeof setInterval>;
  /** Asked once, when the row first runs: false keeps the glyph still and starts no timer. */
  animate?: boolean;
  result?: ToolResult;
  /**
   * The row is drawn once and never redrawn, as in Pi's HTML export: its call
   * is first rendered with execution already started, before its result.
   * A live row is always rendered first while its arguments arrive.
   */
  snapshot?: boolean;
}

const EMPTY: Component = { render: () => [], invalidate() {} };

/**
 * A component that builds its lines on the first render and keeps them for
 * that width. Lines are built at render time because Pi runs the result
 * renderer after the call renderer in the same pass, so the call row sees
 * the latest result. Every change to a row (a new result, a spinner frame,
 * the expand toggle, a theme change) makes Pi ask for new components, so
 * the kept lines never go stale.
 */
class LazyLines implements Component {
  private readonly build: (width: number) => string[];
  private width?: number;
  private lines: string[] = [];
  constructor(build: (width: number) => string[]) {
    this.build = build;
  }
  render(width: number): string[] {
    if (width !== this.width) {
      this.lines = this.build(width);
      this.width = width;
    }
    return this.lines;
  }
  invalidate(): void {
    this.width = undefined;
  }
}

function rowState(context: RenderContext): RowState {
  const state = context.state as { ampiRow?: RowState };
  state.ampiRow ??= { spinner: createMmrSpinner(), ...(context.executionStarted ? { snapshot: true } : {}) };
  return state.ampiRow;
}

/** Keep the running glyph moving while the call runs; stop the timer once it finished. */
function syncSpinner(state: RowState, context: RenderContext, running: boolean, home: string): void {
  if (running && !state.timer && (state.animate ??= !isMmrAnimationDisabled({ cwd: context.cwd, homeDirectory: home }))) {
    state.timer = setInterval(() => {
      state.spinner.step();
      context.invalidate();
    }, MMR_SPINNER_INTERVAL_MS);
    state.timer.unref?.();
  } else if (!running && state.timer) {
    clearInterval(state.timer);
    state.timer = undefined;
  }
}

/** Running while the result is partial; cancelled when an error result reports an abort. */
export function rowStatus(context: Pick<RenderContext, "isPartial" | "isError">, result?: ToolResult): ActivityStatus {
  return context.isPartial ? "running" : resultStatus(context.isError, result);
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function cleanText(value: string): string {
  return value
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\r/g, "")
    .replace(/\t/g, "   ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

function styleParts(parts: readonly TitlePart[], theme: RenderTheme): string {
  return parts.map((part) => theme.fg(ROLE_COLOR[part.role], part.text)).join("");
}

function glyph(status: ActivityStatus, state: RowState, theme: RenderTheme): string {
  return theme.fg(STATUS_COLOR[status], status === "running" ? state.spinner.glyph() : STATUS_GLYPH[status]);
}

/** Underlined path with an OSC 8 `file://` link when the terminal supports links. */
function linkedPath(
  display: string,
  rawPath: string,
  row: Pick<Row, "context" | "home">,
  theme: RenderTheme,
  range?: string,
): string {
  const styled = theme.underline(theme.fg("mdLink", display));
  if (!getCapabilities().hyperlinks) return styled;
  const expanded = rawPath.startsWith("~/") ? path.join(row.home, rawPath.slice(2)) : rawPath;
  const absolute = path.resolve(row.context.cwd, expanded);
  const lines = range ? /^L(\d+)(?:-(\d+))?$/.exec(range) : null;
  const anchor = lines ? `#L${lines[1]}${lines[2] ? `-L${lines[2]}` : ""}` : "";
  return hyperlink(styled, `${pathToFileURL(absolute).href}${anchor}`);
}

function clip(line: string, width: number): string {
  return truncateToWidth(line, Math.max(1, width), "…");
}

/** Up to `max` lines, each clipped, then a muted "… N more lines". */
function limitedLines(
  lines: readonly string[],
  max: number,
  indent: string,
  width: number,
  theme: RenderTheme,
  style: (line: string) => string,
): string[] {
  const shown = lines.slice(0, max).map((line) => clip(`${indent}${style(line)}`, width));
  const hidden = lines.length - max;
  if (hidden > 0) shown.push(clip(`${indent}${theme.fg("muted", `… ${hidden} more ${hidden === 1 ? "line" : "lines"}`)}`, width));
  return shown;
}

// ---------------------------------------------------------------------------
// Shell commands
// ---------------------------------------------------------------------------

/** Program words bold, flags and quoted strings in syntax colours, operators muted. */
export function highlightShell(command: string, theme: RenderTheme): string {
  const tokens = tokenizeShell(command);
  if (!tokens) return theme.bold(command);
  let out = "";
  let at = 0;
  let commandPosition = true;
  for (const token of tokens) {
    out += command.slice(at, token.start);
    const raw = command.slice(token.start, token.end);
    at = token.end;
    if (token.type === "op") {
      out += token.value === ";" && raw === "\n" ? raw : theme.fg("syntaxOperator", raw);
      commandPosition = !/[<>]/.test(token.value);
      continue;
    }
    if (commandPosition && /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) out += raw;
    else if (commandPosition) {
      out += theme.bold(raw);
      commandPosition = false;
    } else if (raw.startsWith("-")) out += theme.fg("syntaxVariable", raw);
    else if (raw.startsWith("'") || raw.startsWith('"')) out += theme.fg("syntaxString", raw);
    else out += raw;
  }
  return out + command.slice(at);
}

function shellOutput(result: ToolResult | undefined): string[] {
  const output = cleanText(resultText(result))
    .replace(/\n*Command exited with code \d+\s*$/, "")
    .replace(
      /\n*Command (?:aborted|timed out after \d+(?:\.\d+)? seconds|terminated without an exit code|(?:terminated by|stopped with) SIG[A-Z0-9]+|is still running (?:in the background )?as pid \d+\..*)\s*$/,
      "",
    )
    .replace(/\s+$/, "");
  return output === "" || output === "(no new output)" ? [] : output.split("\n");
}

function shellHeader(row: Row, activity: Activity, status: ActivityStatus, width: number): string[] {
  const { state, context, theme } = row;
  const pad = " ".repeat(context.outputPad);
  const raw = activity.command ?? "";
  const command = (activity.workdir ? splitLeadingCd(raw)?.rest : undefined) ?? raw;
  const failed = status === "error";
  const prompt =
    status === "running" ? glyph("running", state, theme) : theme.bold(theme.fg(failed ? "error" : status === "cancelled" ? "warning" : "success", "$"));
  let body = highlightShell(command.trim(), theme);
  if (status === "cancelled") body = theme.strikethrough(body);
  let suffix = "";
  if (activity.workdir && path.resolve(activity.workdir) !== path.resolve(context.cwd)) {
    suffix += theme.fg("muted", theme.italic(` (in ${displayPath(activity.workdir, { home: row.home })})`));
  }
  if (activity.exitCode !== undefined && activity.exitCode !== 0) {
    suffix += theme.italic(` (exit code: ${theme.fg("error", String(activity.exitCode))})`);
  }
  if (activity.ended) suffix += theme.fg("muted", theme.italic(` (${activity.ended})`));
  if (status === "cancelled") suffix += theme.fg("warning", " (cancelled)");
  const indent = `${pad}  `;
  const lines: string[] = [];
  const wrapWidth = Math.max(10, width - indent.length);
  for (const [i, line] of `${body}${suffix}`.split("\n").entries()) {
    const lead = i === 0 ? `${pad}${prompt} ` : `${pad}    `;
    for (const [j, piece] of wrapTextWithAnsi(line, wrapWidth).entries()) {
      lines.push(clip(j === 0 ? `${lead}${piece}` : `${indent}${piece}`, width));
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

interface DiffLine {
  sign: "+" | "-" | " " | "gap";
  number: string;
  text: string;
}

/** Lines of a numbered display diff (`+12 text`, `-12 text`, ` 12 text`, `    ...`). */
function parseDisplayDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const line of diff.split("\n")) {
    if (/^\s+\.\.\.\s*$/.test(line)) {
      lines.push({ sign: "gap", number: "", text: "" });
      continue;
    }
    const match = /^([+\- ])\s*(\d+) ?(.*)$/.exec(line);
    if (match) lines.push({ sign: match[1] as DiffLine["sign"], number: match[2] as string, text: match[3] as string });
  }
  return lines;
}

/** Lines of a unified diff, numbered from its hunk headers; hunks are separated by a gap. */
function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      if (inHunk) lines.push({ sign: "gap", number: "", text: "" });
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith("\\") || line === "") continue;
    const sign = line[0];
    if (sign === "+") lines.push({ sign: "+", number: String(newLine++), text: line.slice(1) });
    else if (sign === "-") lines.push({ sign: "-", number: String(oldLine++), text: line.slice(1) });
    else if (sign === " ") {
      lines.push({ sign: " ", number: String(oldLine++), text: line.slice(1) });
      newLine++;
    }
  }
  return lines;
}

function renderDiffLines(lines: readonly DiffLine[], indent: string, width: number, theme: RenderTheme): string[] {
  const numberWidth = Math.max(0, ...lines.map((line) => line.number.length));
  const rendered = lines.map((line) => {
    if (line.sign === "gap") return theme.fg("muted", "...");
    const number = theme.fg("muted", line.number.padStart(numberWidth));
    const content = cleanText(line.text);
    if (line.sign === "+") return `${number} ${theme.fg("toolDiffAdded", `+  ${content}`)}`;
    if (line.sign === "-") return `${number} ${theme.fg("toolDiffRemoved", `-  ${content}`)}`;
    return `${number}    ${theme.fg("toolDiffContext", content)}`;
  });
  return limitedLines(rendered, CARD_DIFF_LINES, indent, width, theme, (line) => line);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function editCardBody(row: Row, indent: string, width: number): string[] {
  const { toolName, context, theme } = row;
  const args = record(row.args);
  const details = record(row.state.result?.details);
  if (toolName === "edit") {
    return typeof details.diff === "string" ? renderDiffLines(parseDisplayDiff(details.diff), indent, width, theme) : [];
  }
  if (toolName === "write") {
    if (typeof args.content !== "string") return [];
    const content = args.content.replace(/\n$/, "");
    const lines: DiffLine[] = content === "" ? [] : content.split("\n").map((text, i) => ({ sign: "+", number: String(i + 1), text }));
    return renderDiffLines(lines, indent, width, theme);
  }
  // apply_patch: one section per file, with its own path line when several files changed.
  const files = Array.isArray(details.files) ? details.files.map(record) : [];
  const out: string[] = [];
  for (const file of files) {
    const filePath = typeof file.path === "string" ? file.path : "";
    if (files.length > 1) {
      const stat = diffStatParts({
        added: typeof file.additions === "number" ? file.additions : 0,
        removed: typeof file.deletions === "number" ? file.deletions : 0,
      });
      const shown = displayPath(filePath, { cwd: context.cwd, home: row.home });
      const statText = stat.length > 0 ? ` ${styleParts(stat, theme)}` : "";
      out.push(clip(`${indent}${linkedPath(shown, filePath, row, theme)}${statText}`, width));
    }
    if (typeof file.diff === "string") out.push(...renderDiffLines(parseUnifiedDiff(file.diff), indent, width, theme));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rows and cards
// ---------------------------------------------------------------------------

interface Row {
  toolName: string;
  args: unknown;
  context: RenderContext;
  theme: RenderTheme;
  state: RowState;
  home: string;
}

function rowActivity(row: Row): Activity {
  return classifyToolCall(row.toolName, row.args, { cwd: row.context.cwd, home: row.home, result: row.state.result });
}

function titleLine(row: Row, activity: Activity, status: ActivityStatus, width: number, linked: boolean): string {
  const { context, theme, state } = row;
  const pad = " ".repeat(context.outputPad);
  let parts = activityTitle(activity, status);
  let title = styleParts(parts, theme);
  if (linked && activity.path && (activity.kind === "read" || activity.kind === "edit" || activity.kind === "create")) {
    // The expanded card links the path: verb, linked path, then the rest of the title.
    const [verb, , ...rest] = parts;
    parts = rest;
    const link = linkedPath(activity.object, activity.path, row, theme, activity.detail);
    title = `${styleParts(verb ? [verb] : [], theme)} ${link}${styleParts(parts, theme)}`;
  }
  return clip(`${pad}${glyph(status, state, theme)} ${title}`, width);
}

/** Header lines of a row: the one-line title, or the `$ command` line of an expanded shell card. */
function renderHeader(row: Row, width: number): string[] {
  const activity = rowActivity(row);
  const status = rowStatus(row.context, row.state.result);
  if (row.context.expanded && SHELL_TOOLS.has(row.toolName)) {
    return shellHeader(row, activity, status, width);
  }
  return [titleLine(row, activity, status, width, row.context.expanded)];
}

function genericArgs(args: unknown, indent: string, width: number, theme: RenderTheme): string[] {
  return Object.entries(record(args)).map(([key, value]) => {
    const shown = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
    const first = cleanText(shown).split("\n");
    const more = first.length > 1 ? " …" : "";
    return clip(`${indent}${theme.fg("muted", `${key}: ${first[0]}${more}`)}`, width);
  });
}

/** Body lines of an expanded card. */
function renderBody(row: Row, width: number): string[] {
  const { toolName, context, theme, state } = row;
  const indent = `${" ".repeat(context.outputPad)}  `;
  const result = state.result;
  const status = rowStatus(context, result);
  const failure = status === "error" || status === "cancelled";
  const output = cleanText(resultText(result)).replace(/\s+$/, "");
  const outputLines = output === "" ? [] : output.split("\n");
  const errorLines = () => limitedLines(outputLines, CARD_OUTPUT_LINES, indent, width, theme, (line) => theme.fg("error", line));
  const mutedLines = (lines: readonly string[]) =>
    limitedLines(lines, CARD_OUTPUT_LINES, indent, width, theme, (line) => theme.fg("toolOutput", line));

  switch (toolName) {
    case "bash":
    case "shell_command":
    case "shell_command_status":
    case "shell_command_kill":
      return mutedLines(shellOutput(result));
    case "read":
      return failure ? errorLines() : [];
    case "edit":
    case "write":
    case "apply_patch":
      return failure ? errorLines() : editCardBody(row, indent, width);
    case "grep":
    case "find":
    case "ls":
      return failure ? errorLines() : mutedLines(outputLines);
    default: {
      const lines = genericArgs(row.args, indent, width, theme);
      if (outputLines.length > 0) lines.push(...(failure ? errorLines() : mutedLines(outputLines)));
      return lines;
    }
  }
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

interface GroupPlace {
  /** The group's expansion, which its first row decides. */
  expanded: boolean;
  /** Only on the first row of a group, which draws the summary. */
  aggregate?: GroupAggregate;
}

/** Where a row sits in its group; undefined for rows drawn on their own. */
function groupPlace(groups: ActivityGroupStore | undefined, context: RenderContext, state: RowState): GroupPlace | undefined {
  if (!groups || state.snapshot) return undefined;
  groups.attach(context.toolCallId, context.invalidate);
  const position = groups.lookup(context.toolCallId);
  if (!position) return undefined;
  if (position.index > 0) return { expanded: position.group.calls[0]?.expanded ?? context.expanded };
  groups.setExpanded(context.toolCallId, context.expanded);
  return { expanded: context.expanded, aggregate: groups.aggregate(position.group) };
}

/** The summary row animates while any call of its group runs; a later row only shows its own spinner once expanded. */
function groupSpinner(place: GroupPlace, context: RenderContext): boolean {
  return place.aggregate ? place.aggregate.live : place.expanded && context.executionStarted && context.isPartial;
}

/** A call drawn inside an expanded group: indented under the summary row. */
function groupChild(context: RenderContext): RenderContext {
  return { ...context, expanded: true, outputPad: context.outputPad + GROUP_INDENT };
}

/** `✓ Ran 3 commands, read 4 files ▸`: the phrase in the title colour, its commas and parentheses muted. */
function summaryLine(
  aggregate: GroupAggregate,
  expanded: boolean,
  context: RenderContext,
  state: RowState,
  theme: RenderTheme,
  width: number,
): string {
  const lead = `${" ".repeat(context.outputPad)}${glyph(aggregate.status, state, theme)} `;
  // Cut the phrase rather than the arrow.
  const phrase = truncateToWidth(aggregate.summary, Math.max(1, width - visibleWidth(lead) - 2), "…");
  const styled = phrase
    .split(/(, | \(|\))/)
    .map((piece, i) => (piece === "" ? "" : theme.fg(i % 2 === 1 ? "muted" : "toolTitle", piece)))
    .join("");
  return clip(`${lead}${styled} ${theme.fg("muted", expanded ? "▾" : "▸")}`, width);
}

export interface ToolRendererOptions {
  /** Home directory shown as `~`. Default: the user's home. */
  home?: string;
  /** Groups of consecutive calls. Without one, every call draws its own row. */
  groups?: ActivityGroupStore;
}

/**
 * Resolver for `pi.registerToolRenderer`: one-line rows for every tool, and
 * ampi's own expanded cards for Pi's built-in tools, `apply_patch`, MCP tools
 * and tools without renderers of their own. ampi-workers' tools keep their
 * own renderers, which draw the same kind of row. With a group store, a run of
 * calls folds into one summary row drawn by its first call; the later calls
 * draw nothing until the group is expanded.
 */
export function createToolRendererResolver(options: ToolRendererOptions = {}): ToolRendererResolver {
  const home = options.home ?? homedir();
  const { groups } = options;
  return (toolName, next) => {
    const own = OWN_CARDS.has(toolName) || toolName.startsWith("mcp__");
    const fallback = own ? undefined : next();
    if (fallback && classifyToolCall(toolName, {}).kind === "subagent") return fallback;
    const renderCall: CallRenderer = (args, theme, context) => {
      const state = rowState(context);
      // A snapshot's call comes before its result, so its status is unknown here:
      // the result side draws its title instead.
      if (state.snapshot) return EMPTY;
      const place = groupPlace(groups, context, state);
      if (place) {
        syncSpinner(state, context, groupSpinner(place, context), home);
        const { aggregate } = place;
        const summary = (width: number) => (aggregate ? [summaryLine(aggregate, place.expanded, context, state, theme, width)] : []);
        if (!place.expanded) return aggregate ? new LazyLines(summary) : EMPTY;
        const child = groupChild(context);
        if (fallback?.renderCall) {
          const card = fallback.renderCall(args, theme, child);
          return aggregate ? new LazyLines((width) => [...summary(width), ...card.render(width)]) : card;
        }
        const row: Row = { toolName, args, context: child, theme, state, home };
        return new LazyLines((width) => [...summary(width), ...renderHeader(row, width)]);
      }
      syncSpinner(state, context, context.executionStarted && context.isPartial, home);
      if (context.expanded && fallback?.renderCall) return fallback.renderCall(args, theme, context);
      const row: Row = { toolName, args, context, theme, state, home };
      return new LazyLines((width) => renderHeader(row, width));
    };
    const renderResult: ResultRenderer = (result, renderOptions, theme, context) => {
      const state = rowState(context);
      state.result = result;
      const place = groupPlace(groups, context, state);
      if (place) {
        syncSpinner(state, context, groupSpinner(place, context), home);
        if (!place.expanded) return EMPTY;
        const child = groupChild(context);
        if (fallback?.renderResult) return fallback.renderResult(result, { ...renderOptions, expanded: true }, theme, child);
        const row: Row = { toolName, args: context.args, context: child, theme, state, home };
        return new LazyLines((width) => renderBody(row, width));
      }
      syncSpinner(state, context, !state.snapshot && context.executionStarted && renderOptions.isPartial, home);
      const row: Row = { toolName, args: context.args, context, theme, state, home };
      const header = (width: number) => (state.snapshot ? renderHeader(row, width) : []);
      if (!renderOptions.expanded) return state.snapshot ? new LazyLines(header) : EMPTY;
      if (fallback?.renderResult) return fallback.renderResult(result, renderOptions, theme, context);
      return new LazyLines((width) => [...header(width), ...renderBody(row, width)]);
    };
    return { renderShell: "self", renderCall, renderResult };
  };
}

/** Draw every tool call in the transcript as an ampi row, with runs of calls folded into one summary row. */
export function installToolRenderers(pi: Pick<ExtensionAPI, "registerToolRenderer" | "on">, options?: ToolRendererOptions): void {
  const groups = new ActivityGroupStore();
  trackActivityGroups(pi, groups);
  pi.registerToolRenderer(createToolRendererResolver({ ...options, groups }));
}
