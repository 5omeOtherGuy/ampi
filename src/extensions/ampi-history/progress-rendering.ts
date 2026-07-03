/**
 * Pi-TUI `renderCall` / `renderResult` implementations for the
 * `ampi-history` tools (`find_session` and `read_session`).
 *
 * Mirrors the conventions used by `ampi-workers`'
 * `progress-rendering.ts`: tools return `Container` trees built from
 * `Text`, `Markdown`, and `Spacer` primitives, and worker metadata
 * (usage / model) is formatted through the shared
 * `worker-usage-format.ts` helpers so finder / oracle / Task and the
 * history-reader read tools agree on token / cost / model presentation.
 *
 * `read_session`'s worker analysis returns a `ReadSessionDetails`
 * shape (not `MmrWorkerResult`), so `renderMmrSubagentResult` is not
 * directly reusable; this module supplies the small amount of
 * `ampi-history`-specific structure on top of the shared formatters.
 */
import { getMarkdownTheme, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { isRecord } from "../ampi-core/internal/json.js";
import {
  formatMmrWorkerUsage,
  stripMmrWorkerModelProvider,
} from "../ampi-workers/worker-usage-format.js";
import type { FindSessionDetails, ReadSessionDetails } from "./tools.js";

interface HistoryTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
  italic?(text: string): string;
}

interface HistoryRenderContextLike {
  args?: unknown;
  isError?: boolean;
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value[key];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function textContent(result: AgentToolResult<unknown>): string {
  const blocks = result.content;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b) => isRecord(b) && b.type === "text" && typeof b.text === "string")
    .map((b) => (b as { text: string }).text)
    .join("\n");
}

function compactOneLine(value: string, limit = 160): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, Math.max(0, limit - 1))}…`;
}

function formatTitle(toolName: string, theme: HistoryTheme, detail?: string): string {
  const title = theme.fg("toolTitle", theme.bold(toolName));
  if (!detail) return title;
  return `${title} ${theme.fg("dim", compactOneLine(detail, 140))}`;
}

/**
 * Compact call rendering. For `find_session` we show the search
 * query; for `read_session` we show the goal. The sessionId, when
 * present, is rendered as a separate dim row to keep the title line
 * readable for long IDs.
 */
export function renderMmrHistoryCall(
  toolName: string,
  args: unknown,
  theme: HistoryTheme,
): Component {
  switch (toolName) {
    case "find_session": {
      const query = readStringField(args, "query");
      return new Text(formatTitle(toolName, theme, query ? `query: ${query}` : undefined), 0, 0);
    }
    case "read_session": {
      const goal = readStringField(args, "goal");
      const sessionId = readStringField(args, "sessionId") ?? readStringField(args, "threadID");
      const container = new Container();
      container.addChild(new Text(formatTitle(toolName, theme, goal ? `goal: ${goal}` : undefined), 0, 0));
      if (sessionId) {
        container.addChild(new Text(theme.fg("dim", `sessionId: ${sessionId}`), 1, 0));
      }
      return container;
    }
    default:
      return new Text(formatTitle(toolName, theme), 0, 0);
  }
}

function statusLabel(theme: HistoryTheme, label: string, color: string): string {
  return theme.fg(color, label);
}

function buildReadFooter(
  details: ReadSessionDetails | undefined,
  theme: HistoryTheme,
): readonly string[] {
  if (!details) return [];
  const lines: string[] = [];
  if (details.analysisUsed === "worker") {
    lines.push(statusLabel(theme, "analysis: worker", "ok"));
  } else {
    lines.push(statusLabel(theme, "analysis: lexical", "dim"));
  }
  if (details.analysisUsed === "lexical" && details.analysisFallbackReason) {
    lines.push(theme.fg("dim", `lexical fallback: ${compactOneLine(details.analysisFallbackReason, 140)}`));
  }
  const worker = details.worker;
  if (worker) {
    const model = stripMmrWorkerModelProvider(worker.reportedModel ?? worker.model);
    const usage = formatMmrWorkerUsage(worker.usage, model);
    if (usage) lines.push(theme.fg("dim", usage));
    if (worker.errorMessage) {
      lines.push(theme.fg("warn", `worker error: ${compactOneLine(worker.errorMessage, 140)}`));
    }
    if (worker.subagentActivationError) {
      lines.push(theme.fg("warn", `activation: ${compactOneLine(worker.subagentActivationError, 140)}`));
    }
  }
  return lines;
}

function renderCollapsedLine(
  toolName: string,
  _result: AgentToolResult<unknown>,
  details: FindSessionDetails | ReadSessionDetails | undefined,
  theme: HistoryTheme,
  context: HistoryRenderContextLike | undefined,
): string {
  const isError = context?.isError === true;
  const status = isError ? "failed" : "succeeded";
  const color = isError ? "err" : "ok";
  const label = isError ? "error" : status;
  let detail: string | undefined;
  if (!isError && details && "resultCount" in details) {
    detail = `${details.resultCount} match${details.resultCount === 1 ? "" : "es"}`;
  } else if (!isError && details && "analysisUsed" in details) {
    detail = `analysis: ${details.analysisUsed}`;
  }
  const title = formatTitle(toolName, theme, detail);
  return `${title}  ${theme.fg(color, label)}`;
}

/**
 * Result rendering. Renders the tool's text content as Markdown
 * (ampi-history tools already produce markdown-shaped text) and
 * appends a small worker / analysis footer for the read tools when
 * worker analysis ran.
 */
export function renderMmrHistoryResult(
  toolName: string,
  result: AgentToolResult<unknown>,
  options: { expanded?: boolean; isPartial?: boolean },
  theme: HistoryTheme,
  context?: HistoryRenderContextLike,
): Component {
  const expanded = options.expanded === true;
  const details = result.details as FindSessionDetails | ReadSessionDetails | undefined;
  const container = new Container();

  if (!expanded) {
    container.addChild(new Text(renderCollapsedLine(toolName, result, details, theme, context), 0, 0));
    return container;
  }

  const text = textContent(result).trim();
  if (text.length > 0) {
    container.addChild(new Markdown(text, 0, 0, getMarkdownTheme()));
  } else {
    container.addChild(new Text(theme.fg("dim", "(no result content)"), 0, 0));
  }

  if (toolName === "read_session") {
    const footer = buildReadFooter(details as ReadSessionDetails | undefined, theme);
    if (footer.length > 0) {
      container.addChild(new Spacer(1));
      for (const line of footer) container.addChild(new Text(line, 0, 0));
    }
  }

  return container;
}
