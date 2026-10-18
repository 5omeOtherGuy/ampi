/**
 * Drawing of one-line worker rows: the row line and, expanded, the trail,
 * answer and usage below it. The phrases and glyphs come from
 * `worker-row.ts`; this module turns a {@link WorkerRowView} into lines.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { MmrWorkerTrailItem, MmrWorkerUsageStats } from "../framework/runner.js";
import { compactOneLine, formatWorkerStatusLine, type SubagentTheme } from "./subagent-render-format.js";
import { isRecord } from "../../ampi-core/internal/json.js";
import { finalAssistantTrailIndex, formatToolArguments, isWorkerPromptEcho, structuredArgsFromPreview } from "./tool-argument-display.js";
import {
  WORKER_ROW_ANSWER_LINES,
  WORKER_ROW_PROMPT_LINES,
  WORKER_ROW_TRAIL_EVENTS,
  workerRowColor,
  workerRowDetail,
  workerRowGlyph,
  workerRowPhrase,
  type WorkerRowStatus,
} from "./worker-row.js";

function clip(line: string, width: number): string {
  return truncateToWidth(line, Math.max(1, width), "…");
}

/** Everything one row draws, already resolved from the result. */
export interface WorkerRowView {
  /** Worker or tool name the phrase is chosen by. */
  agent: string;
  /** `Task` capability profile or custom subagent name, shown in parentheses. */
  variant?: string;
  status: WorkerRowStatus;
  /** Muted text after ` · `: what the worker was asked. */
  detail?: string;
  /** Muted tail after the detail, such as `(partial)`. */
  tail?: string;
  /** Full prompt, shown dim when expanded and the row does not show all of it. */
  prompt?: string;
  trail: readonly MmrWorkerTrailItem[];
  /** Prompt the worker received, so its echo in the trail is skipped. */
  workerPrompt?: string;
  /** Final answer; drawn once the worker finished. */
  output?: string;
  /** Skip the last assistant trail item when it repeats the answer. */
  suppressDuplicateFinalOutput: boolean;
  /** Draw the answer and the usage line (the worker finished). */
  finished: boolean;
  usage?: MmrWorkerUsageStats;
  contextWindow?: number;
  model?: string;
  /** Name on the right of the usage line. */
  usageName: string;
  diagnostic?: string;
  /** Diagnostic colour: `error` for a failed run, `warning` for a note on a finished one. */
  diagnosticColor?: string;
  fallbackNotice?: string;
}

/** `<pad><glyph> <phrase> · <detail> <tail>`, before it is clipped to the width. */
function fullRowLine(view: WorkerRowView, theme: SubagentTheme, pad: string, spinner: string): string {
  const glyph = theme.fg(workerRowColor(view.status), workerRowGlyph(view.status, spinner));
  const phrase = theme.fg("toolTitle", workerRowPhrase(view.agent, view.status === "running", view.variant));
  const detail = view.detail ? theme.fg("muted", ` · ${view.detail}`) : "";
  const tail = view.tail ? theme.fg("muted", ` ${view.tail}`) : "";
  return `${pad}${glyph} ${phrase}${detail}${tail}`;
}

/** `<pad><glyph> <phrase> · <detail> <tail>`, clipped to the width; `spinner` is the running glyph. */
export function workerRowLine(view: WorkerRowView, theme: SubagentTheme, pad: string, spinner: string, width: number): string {
  return clip(fullRowLine(view, theme, pad, spinner), width);
}

/** Tools whose arguments `formatToolArguments` knows how to show. */
const FORMATTED_TOOLS = new Set(["read", "bash", "grep", "find"]);
/** Argument fields that usually say what another tool call is about, in order. */
const TOOL_DETAIL_FIELDS = ["path", "file_path", "pattern", "query", "command", "url", "objective", "task", "description", "prompt"];

/** What a child tool call acted on: `src/a.ts:1-40` for a read, the first telling argument for other tools. */
function toolArgumentsText(item: Extract<MmrWorkerTrailItem, { type: "tool" }>): string {
  if (FORMATTED_TOOLS.has(item.toolName)) return formatToolArguments(item);
  const args = isRecord(item.args) ? item.args : structuredArgsFromPreview(item.toolName, item.argsPreview);
  if (!isRecord(args)) return item.argsPreview ?? "";
  for (const key of TOOL_DETAIL_FIELDS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

/** One plain-text line per trail event worth showing; tool calls lead with their status glyph. */
function trailEventLine(item: MmrWorkerTrailItem, spinner: string | undefined): string | undefined {
  switch (item.type) {
    case "assistant":
      return workerRowDetail(item.text);
    case "tool": {
      const status: WorkerRowStatus = item.status === "running" ? "running" : item.status === "failed" || item.isError ? "error" : "done";
      const args = compactOneLine(toolArgumentsText(item), 160);
      return `${workerRowGlyph(status, spinner)} ${item.toolName}${args ? ` ${args}` : ""}`;
    }
    case "bashExecution": {
      if (!item.command) return undefined;
      const exit = item.exitCode !== undefined && item.exitCode !== 0 ? ` (exit code: ${item.exitCode})` : "";
      return `$ ${compactOneLine(item.command, 160)}${exit}${item.cancelled ? " (cancelled)" : ""}`;
    }
    case "skillInvocation":
      return `Loaded skill ${item.name?.trim() || "skill"}`;
    case "compactionSummary":
      return "Compacted context";
    case "branchSummary":
      return "Summarized branch";
    case "custom": {
      const text = workerRowDetail(item.text);
      return `[${item.customType?.trim() || "custom"}]${text ? ` ${text}` : ""}`;
    }
    // The prompt (user), tool results already shown on their call, and thinking stay out of the trail.
    case "user":
    case "toolResult":
    case "thinking":
      return undefined;
    default: {
      const _exhaustive: never = item;
      void _exhaustive;
      return undefined;
    }
  }
}

/** The latest {@link WORKER_ROW_TRAIL_EVENTS} trail events, after "… N earlier events" when some are left out. */
export function workerTrailLines(view: Pick<WorkerRowView, "trail" | "workerPrompt" | "output" | "suppressDuplicateFinalOutput">, spinner?: string): string[] {
  const duplicate = view.suppressDuplicateFinalOutput ? finalAssistantTrailIndex(view.trail, view.output ?? "") : undefined;
  const lines: string[] = [];
  view.trail.forEach((item, index) => {
    if (index === duplicate) return;
    if (item.type === "user" && isWorkerPromptEcho(item.text, view.workerPrompt)) return;
    const line = trailEventLine(item, spinner);
    if (line) lines.push(line);
  });
  const hidden = lines.length - WORKER_ROW_TRAIL_EVENTS;
  if (hidden <= 0) return lines;
  return [`… ${hidden} earlier ${hidden === 1 ? "event" : "events"}`, ...lines.slice(hidden)];
}

function limited(lines: readonly string[], max: number): { shown: string[]; more: string | undefined } {
  const hidden = lines.length - max;
  return { shown: lines.slice(0, max), more: hidden > 0 ? `… ${hidden} more ${hidden === 1 ? "line" : "lines"}` : undefined };
}

function sameText(a: string | undefined, b: string | undefined): boolean {
  const norm = (value: string | undefined) => (value ?? "").replace(/\s+/g, " ").replace(/ …$/, "").trim();
  return norm(a) === norm(b) || norm(b).startsWith(norm(a));
}

/**
 * Lines below an expanded row, indented under its phrase: the diagnostic,
 * the full prompt (wrapped, cut after {@link WORKER_ROW_PROMPT_LINES} lines)
 * when the row shows only part of it, the trail,
 * a fallback notice, then for a finished worker its answer (Markdown, cut
 * after {@link WORKER_ROW_ANSWER_LINES} source lines) and the usage line.
 */
export function workerRowBody(view: WorkerRowView, theme: SubagentTheme, pad: string, spinner: string, width: number): string[] {
  const indent = `${pad}  `;
  const out: string[] = [];
  const dim = (text: string) => clip(`${indent}${theme.fg("dim", text)}`, width);
  if (view.diagnostic) out.push(clip(`${indent}${theme.fg(view.diagnosticColor ?? "error", compactOneLine(view.diagnostic, 400))}`, width));
  const prompt = view.prompt?.trim();
  const rowClipped = visibleWidth(fullRowLine(view, theme, pad, spinner)) > width;
  if (prompt && (rowClipped || !sameText(prompt, view.detail))) {
    const wrapped = prompt.split(/\r?\n/).flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width - indent.length)));
    const { shown, more } = limited(wrapped, WORKER_ROW_PROMPT_LINES);
    out.push(...shown.map((line) => dim(line)));
    if (more) out.push(clip(`${indent}${theme.fg("muted", more)}`, width));
  }
  out.push(...workerTrailLines(view, spinner).map((line) => dim(line)));
  if (view.fallbackNotice?.trim()) out.push(clip(`${indent}${theme.fg("warning", compactOneLine(view.fallbackNotice, 400))}`, width));
  if (!view.finished) return out;
  const answer = view.output?.trim();
  if (answer) {
    const { shown, more } = limited(answer.split(/\r?\n/), WORKER_ROW_ANSWER_LINES);
    // Markdown pads both sides; the left padding aligns the answer under the phrase.
    const markdown = new Markdown(shown.join("\n"), indent.length, 0, getMarkdownTheme());
    out.push(...markdown.render(Math.max(indent.length + 10, width)).map((line) => clip(line.trimEnd(), width)));
    if (more) out.push(clip(`${indent}${theme.fg("muted", more)}`, width));
  }
  // A run that never reached the model has no usage to show.
  const used = view.usage !== undefined && (view.usage.turns > 0 || view.usage.input > 0 || view.usage.output > 0);
  if (used || view.model) {
    const usage = formatWorkerStatusLine(view.usageName, view.usage, view.contextWindow, view.model, Math.max(1, width - indent.length));
    if (usage.trim()) out.push(`${indent}${theme.fg("dim", usage)}`);
  }
  return out;
}
