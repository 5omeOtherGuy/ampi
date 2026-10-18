import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { MmrContextAnalysis, MmrThreadCostReport } from "../../ampi-core/thread-reports.js";
import { formatMmrCompactTokens } from "../../ampi-core/token-format.js";
import { formatMmrSessionCost } from "../editor/prompt-box.js";
import type { MmrFrameTheme } from "../ui/frame.js";
import { openMmrScrollOverlay } from "./help-keymap.js";

/**
 * The Thread Cost and Analyze Context overlays: read-only boxes in the
 * shared frame, centred, 100 columns wide (or the terminal width less
 * four), as tall as their content. Esc closes them; a box taller than the
 * screen scrolls with ↑/↓ or k/j.
 *
 * ```
 * ╭─ Thread Cost ──────────────────────────────────────────╮
 * │                                                        │
 * │ Total: $0.08                                           │
 * │                                                        │
 * │ anthropic/claude-sonnet-4-5                      $0.08 │
 * │   13k in · 116 out · 26k cache read                    │
 * │ local/qwen                                     unknown │
 * │   2.1k in · 40 out                                     │
 * ╰───────────────────────────────────────────── Esc close ─╯
 * ```
 *
 * ```
 * ╭─ Analyze Context ──────────────────────────────────────╮
 * │                                                        │
 * │ anthropic/claude-sonnet-4-5 · 200k context window      │
 * │                                                        │
 * │ System prompt              3.1k     1.6%               │
 * │ Built-in tools (15)        5.2k     2.6%               │
 * │ …                                                      │
 * │ Total                     10.4k     5.2%               │
 * │ Free space               189.6k    94.8%               │
 * │                                                        │
 * │ Compactions: 0                                         │
 * ╰───────────────────────────────────────────── Esc close ─╯
 * ```
 */

export const MMR_THREAD_COST_TITLE = "Thread Cost";
export const MMR_CONTEXT_ANALYSIS_TITLE = "Analyze Context";

const UNKNOWN = "unknown";
const SEPARATOR = " · ";
const DETAIL_INDENT = 2;

/** `left`, cut where it would reach `right`, and `right` aligned to the end of a line `width` columns wide. */
function spread(left: string, right: string, width: number): string {
  const room = Math.max(1, width - visibleWidth(right) - 1);
  const shown = truncateToWidth(left, room, "…");
  return `${shown}${" ".repeat(Math.max(1, width - visibleWidth(shown) - visibleWidth(right)))}${right}`;
}

function tokenParts(model: MmrThreadCostReport["models"][number]): string {
  const parts = [`${formatMmrCompactTokens(model.input)} in`, `${formatMmrCompactTokens(model.output)} out`];
  if (model.cacheRead > 0) parts.push(`${formatMmrCompactTokens(model.cacheRead)} cache read`);
  if (model.cacheWrite > 0) parts.push(`${formatMmrCompactTokens(model.cacheWrite)} cache write`);
  return parts.join(SEPARATOR);
}

/**
 * The Thread Cost lines for an inner width: the total in bold, then one row
 * per model with its cost at the right ("unknown" when it has no price)
 * and its tokens under it, dim.
 */
export function renderMmrThreadCostLines(report: MmrThreadCostReport, width: number, theme: MmrFrameTheme): string[] {
  if (report.models.length === 0) return [theme.fg("dim", "No model has answered in this session yet.")];
  const allUnknown = report.unknown === report.models.length;
  let total = `Total: ${theme.bold(allUnknown ? UNKNOWN : formatMmrSessionCost(report.total))}`;
  if (report.unknown > 0 && !allUnknown) {
    total += theme.fg("dim", `, not counting ${report.unknown} ${report.unknown === 1 ? "model" : "models"} without a price`);
  }
  const lines = [truncateToWidth(total, width, "…"), ""];
  for (const model of report.models) {
    const cost = model.cost === undefined ? theme.fg("dim", UNKNOWN) : formatMmrSessionCost(model.cost);
    lines.push(spread(model.label, cost, width));
    lines.push(truncateToWidth(`${" ".repeat(DETAIL_INDENT)}${theme.fg("dim", tokenParts(model))}`, width, "…"));
  }
  return lines;
}

function percent(tokens: number, window: number | undefined): string {
  return window === undefined ? "—" : `${((tokens / window) * 100).toFixed(1)}%`;
}

/**
 * The Analyze Context lines for an inner width: the model and its window,
 * one row per section with its estimated tokens and share of the window,
 * the total and the free space, then the compaction count and how the
 * numbers were made.
 */
export function renderMmrContextAnalysisLines(analysis: MmrContextAnalysis, width: number, theme: MmrFrameTheme): string[] {
  const window = analysis.contextWindow;
  const heading = [analysis.model ?? "No model selected", window === undefined ? "context window unknown" : `${formatMmrCompactTokens(window)} context window`];
  const rows: [string, number][] = analysis.sections.map((section) => [
    section.count === undefined ? section.name : `${section.name} (${section.count})`,
    section.tokens,
  ]);
  const totals: [string, number][] = [["Total", analysis.totalTokens]];
  if (window !== undefined) totals.push(["Free space", Math.max(0, window - analysis.totalTokens)]);
  const nameWidth = Math.max(...[...rows, ...totals].map(([name]) => visibleWidth(name)));
  const tokenWidth = Math.max(...[...rows, ...totals].map(([, tokens]) => formatMmrCompactTokens(tokens).length));
  const row = ([name, tokens]: [string, number]) =>
    truncateToWidth(
      `${name.padEnd(nameWidth)}  ${formatMmrCompactTokens(tokens).padStart(tokenWidth)}  ${percent(tokens, window).padStart(6)}`,
      width,
      "…",
    );

  const notes = [`Estimates at four characters to a token.`];
  if (analysis.measuredTokens !== undefined) {
    notes.unshift(`Pi counted ${formatMmrCompactTokens(analysis.measuredTokens)} tokens at the last response.`);
  }
  return [
    truncateToWidth(heading.join(SEPARATOR), width, "…"),
    "",
    ...rows.map(row),
    "",
    ...totals.map((total) => theme.bold(row(total))),
    "",
    `Compactions: ${analysis.compactionCount}`,
    ...notes.map((note) => truncateToWidth(theme.fg("dim", note), width, "…")),
  ];
}

/** Open the Thread Cost overlay; resolves when it closes. */
export function openMmrThreadCost(ctx: ExtensionContext, report: MmrThreadCostReport): Promise<void> {
  return openMmrScrollOverlay(ctx, MMR_THREAD_COST_TITLE, (width, theme) => renderMmrThreadCostLines(report, width, theme), { fit: true });
}

/** Open the Analyze Context overlay; resolves when it closes. */
export function openMmrContextAnalysis(ctx: ExtensionContext, analysis: MmrContextAnalysis): Promise<void> {
  return openMmrScrollOverlay(ctx, MMR_CONTEXT_ANALYSIS_TITLE, (width, theme) => renderMmrContextAnalysisLines(analysis, width, theme), {
    fit: true,
  });
}
