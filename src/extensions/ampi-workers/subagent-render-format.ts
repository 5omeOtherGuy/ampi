import { type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { MMR_SUBAGENT_DETAILS_STATUS_VALUES, type MmrWorkerTrailItem, type MmrWorkerUsageStats } from "./framework/runner.js";
import {
  formatMmrWorkerTokens,
  stripMmrWorkerModelProvider,
} from "./worker-usage-format.js";

type TrailToolStatus = Extract<MmrWorkerTrailItem, { type: "tool" }>["status"];

/**
 * Subagent-tool status discriminator the producing tool may set on
 * `result.details.status` to make the rendered row reflect the tool's
 * own outcome policy (e.g. Task's §9.4 precedence). The set of trusted
 * values is the canonical `MMR_SUBAGENT_DETAILS_STATUS_VALUES` from the
 * shared outcome classifier, so the producing and consuming sides can
 * never drift.
 *
 * `"success"` is rendered as the green succeeded row even when the
 * underlying `exitCode` or `signal` would otherwise look like a
 * failure (e.g. Task non-zero exit with usable final text). Any other
 * known value renders as failed. Unknown strings (and tools that leave
 * `status` unset) fall back to the raw-field heuristic, which is the
 * existing behavior.
 */
const SUBAGENT_DETAILS_STATUS_VALUES: ReadonlySet<string> = new Set(MMR_SUBAGENT_DETAILS_STATUS_VALUES);

/**
 * Legacy blocking-subagent details shape. Dual-write window: producers now
 * also stamp the canonical `{kind:"worker-run", version:1}` envelope
 * (`ampi-core/worker-contract.ts`) on the same details object, and the
 * renderer classifies through `worker-run-view.ts` (envelope preferred,
 * this shape as fallback). Scheduled for removal one release after the
 * dual-write began.
 */
export interface SubagentProgressDetails {
  model?: string;
  reportedModel?: string;
  contextWindow?: number;
  usage?: MmrWorkerUsageStats;
  errorMessage?: string;
  stopReason?: string;
  subagentActivationError?: string;
  spawnError?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  aborted?: boolean;
  trail?: readonly MmrWorkerTrailItem[];
  description?: string;
  prompt?: string;
  task?: string;
  query?: string;
  /**
   * Producing tool's outcome discriminator. When set to a known
   * `TaskStatus`-shaped value, the renderer prefers it over deriving
   * status from raw exit fields. Tools that do not set it (finder /
   * oracle / history-reader today) keep the legacy raw-field path.
   */
  status?: string;
  /**
   * User-facing advisory shown only in the rendered result (never placed
   * in the model-consumed `content`). Custom Markdown subagents set this
   * when they relied on a fallback for `model`, thinking level, or
   * `tools`. Other subagents leave it unset.
   */
  fallbackNotice?: string;
}

/**
 * Legacy background-task details shape. See {@link SubagentProgressDetails}
 * for the dual-write/removal plan; classification for this shape lives in
 * `worker-run-view.ts`, never inline in a renderer.
 */
export interface BackgroundTaskDetails {
  worker?: string;
  tool?: string;
  /** Set when a NAMED worker tool started this background run (v2 surface). */
  backgroundStart?: boolean;
  agent?: string;
  taskId?: string;
  groupId?: string;
  /**
   * Set on the `start_task` call that minted the group (`group_id:'new'`). Only
   * the opener renders the consolidated inline group card; sibling starts in the
   * same group render nothing inline so a swarm is one card, not N.
   */
  groupOpener?: boolean;
  /**
   * Registry partition key for the live inline card. Renderer-only metadata (it
   * is not placed in the model-consumed `content`); lets the card read the live
   * group/board snapshot so rows animate ⠋→✓ in place. Absent on replayed
   * transcripts, where the card falls back to the static `details` snapshot.
   */
  sessionKey?: string;
  status?: string;
  terminalOutcome?: string;
  board?: unknown;
  group?: unknown;
  /** Frozen fleet declaration (start_task.fleet); renders all group cards up front. */
  fleet?: unknown;
  description?: string;
  /** Full worker prompt/query, used as the rendered Markdown task body. */
  prompt?: string;
  finalOutput?: string;
  /** Projected subagent details (model, usage, trail) for the rich card. */
  final?: unknown;
  /** Resolved worker model id; header/usage fallback before first progress. */
  resolvedModel?: string;
  /** Worker context window; usage-line fallback before first progress. */
  contextWindow?: number;
  errorMessage?: string;
}

export interface SubagentTheme {
  fg(color: string, text: string): string;
  bg?(color: string, text: string): string;
  bold(text: string): string;
  italic?(text: string): string;
}

export interface RenderContextLike {
  args?: unknown;
  isError?: boolean;
  isPartial?: boolean;
  showImages?: boolean;
  cwd?: string;
  state?: unknown;
  executionStarted?: boolean;
  argsComplete?: boolean;
  expanded?: boolean;
  lastComponent?: unknown;
}

export type RenderStatus = "running" | "succeeded" | "failed";

export function textContent(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((entry): entry is { type: "text"; text: string } => entry.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text)
    .filter((text) => text.length > 0)
    .join("\n");
}

// One-line truncation shares the background-view vocabulary module so the
// inline cards, the pinned widget, and the trail components compact text the
// same way (single copy; re-exported here for the ampi-workers call sites).
export { compactOneLine } from "./background-task-view.js";

// Token / model-name formatting is shared with ampi-history's
// history-reader render path via worker-usage-format.ts. Local aliases
// keep the existing call-site names short.
export const stripProvider = stripMmrWorkerModelProvider;
export const formatTokens = formatMmrWorkerTokens;

function subagentStatusName(toolName: string): string {
  return toolName === "Task" ? "task" : toolName;
}

function formatWorkerContextUsage(
  usage: MmrWorkerUsageStats | undefined,
  contextWindow: number | undefined,
): string | undefined {
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
  const contextTokens = usage?.contextTokens ?? 0;
  return `${((contextTokens / contextWindow) * 100).toFixed(1)}%/${formatTokens(contextWindow)}`;
}

function formatWorkerStatusLeft(
  usage: MmrWorkerUsageStats | undefined,
  contextWindow: number | undefined,
): string {
  const parts: string[] = [];
  if (usage) {
    if (usage.turns > 0) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
    if (usage.input > 0) parts.push(`↑${formatTokens(usage.input)}`);
    if (usage.output > 0) parts.push(`↓${formatTokens(usage.output)}`);
    if (usage.cacheRead > 0) parts.push(`R${formatTokens(usage.cacheRead)}`);
    if (usage.cacheWrite > 0) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  }
  const context = formatWorkerContextUsage(usage, contextWindow);
  if (context) parts.push(context);
  return parts.join(" ");
}

export function formatWorkerStatusLine(
  toolName: string,
  usage: MmrWorkerUsageStats | undefined,
  contextWindow: number | undefined,
  model: string | undefined,
  width: number,
): string {
  if (width <= 0) return "";
  let left = formatWorkerStatusLeft(usage, contextWindow);
  const right = [model, subagentStatusName(toolName)].filter((part): part is string => typeof part === "string" && part.length > 0).join(" • ");

  let leftWidth = visibleWidth(left);
  if (leftWidth > width) {
    left = truncateToWidth(left, width, "...");
    leftWidth = visibleWidth(left);
  }

  if (!right) return left;
  if (!left) return `${" ".repeat(Math.max(0, width - visibleWidth(right)))}${truncateToWidth(right, width, "")}`;

  const rightWidth = visibleWidth(right);
  const minPadding = 2;
  if (leftWidth + minPadding + rightWidth <= width) {
    return `${left}${" ".repeat(width - leftWidth - rightWidth)}${right}`;
  }

  const availableRight = width - leftWidth - minPadding;
  if (availableRight > 0) {
    const truncatedRight = truncateToWidth(right, availableRight, "");
    return `${left}${" ".repeat(Math.max(0, width - leftWidth - visibleWidth(truncatedRight)))}${truncatedRight}`;
  }

  return left;
}

function isSuccessfulStopReason(stopReason: string | undefined): boolean {
  if (!stopReason) return true;
  return stopReason === "end_turn" || stopReason === "stop" || stopReason === "toolUse";
}

export function statusFromDetails(
  details: SubagentProgressDetails | undefined,
  isPartial: boolean,
  context: RenderContextLike | undefined,
): RenderStatus {
  if (isPartial) return "running";
  // When the producing tool stamped a known outcome discriminator on
  // `details.status`, trust it. This lets Task's §9.4 policy (non-zero
  // exit with usable final text == success) render correctly without
  // the renderer recomputing failure from raw exit fields. Unknown
  // string values fall through to the legacy heuristic.
  if (typeof details?.status === "string" && SUBAGENT_DETAILS_STATUS_VALUES.has(details.status)) {
    return details.status === "success" ? "succeeded" : "failed";
  }
  if (details?.aborted || details?.stopReason === "aborted") return "failed";
  if (context?.isError === true || details?.subagentActivationError) return "failed";
  if (details?.exitCode !== undefined && details.exitCode !== null && details.exitCode !== 0) return "failed";
  if (details?.signal) return "failed";
  if (details?.errorMessage) return "failed";
  if (!isSuccessfulStopReason(details?.stopReason)) return "failed";
  return "succeeded";
}

export function statusColor(status: RenderStatus | TrailToolStatus): string {
  if (status === "failed") return "error";
  if (status === "running") return "warning";
  return "success";
}

function statusBgColor(status: RenderStatus): string {
  if (status === "failed") return "toolErrorBg";
  if (status === "running") return "toolPendingBg";
  return "toolSuccessBg";
}

export function statusBgFn(status: RenderStatus, theme: SubagentTheme): (text: string) => string {
  return (text: string) => theme.bg?.(statusBgColor(status), text) ?? text;
}

export function successBgFn(theme: SubagentTheme): (text: string) => string {
  return (text: string) => theme.bg?.("toolSuccessBg", text) ?? text;
}

export function statusLabel(status: RenderStatus | TrailToolStatus): string {
  if (status === "running") return "running...";
  if (status === "succeeded" || status === "completed") return "completed";
  return status;
}

export function formatTitle(toolName: string, model: string | undefined, theme: SubagentTheme): string {
  const title = theme.fg("toolTitle", theme.bold(toolName));
  return model ? `${title} ${theme.fg("muted", "•")} ${theme.fg("accent", model)}` : title;
}

export function diagnosticMessage(details: SubagentProgressDetails | undefined, status: RenderStatus): string | undefined {
  // Diagnostic precedence: spawn-error is the most specific and most
  // user-actionable (typically a missing/broken `pi` binary on PATH),
  // so surface it explicitly before the generic errorMessage that the
  // runner mirrors from the same Error.
  if (details?.spawnError) return `Spawn failed: ${details.spawnError}`;
  if (details?.subagentActivationError) return details.subagentActivationError;
  if (details?.errorMessage) return details.errorMessage;
  if (status === "failed" && !isSuccessfulStopReason(details?.stopReason)) return details?.stopReason ?? "Worker failed.";
  return undefined;
}
