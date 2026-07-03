/**
 * Pure display formatters for the worker-metadata footer rendered by the
 * `ampi-workers` progress rendering and the `ampi-history`
 * history-reader-backed read tools.
 *
 * Core-owned (moved from `ampi-workers/worker-usage-format.ts`, which
 * re-exports this module) so both consumers agree on token / cost /
 * model-name presentation without a sibling → `ampi-workers` import edge.
 * Kept narrow on purpose: string formatting only; the Pi-TUI Container
 * assembly stays in each extension's own progress-rendering module.
 */
import { formatMmrCompactTokens } from "./token-format.js";
import type { MmrWorkerUsageStats } from "./worker-contract.js";

/** Strip a leading `provider/` from a worker model id so the footer shows a short name. */
export function stripMmrWorkerModelProvider(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  return trimmed.split("/").filter(Boolean).pop() ?? trimmed;
}

/**
 * Format a non-negative token count for the worker metadata footer. Routes
 * through the shared compact formatter so this and the /ampi-status footer
 * stay byte-for-byte identical (see token-format.ts).
 */
export function formatMmrWorkerTokens(count: number): string {
  return formatMmrCompactTokens(count);
}

/**
 * Format the worker metadata footer for a subagent or history-reader run.
 * Returns `undefined` when there is nothing meaningful to show (no usage
 * and no model), so callers can simply skip rendering the footer row.
 *
 * The model argument should already be stripped to a bare model name (see
 * {@link stripMmrWorkerModelProvider}).
 */
export function formatMmrWorkerUsage(
  usage: MmrWorkerUsageStats | undefined,
  model: string | undefined,
): string | undefined {
  if (!usage) return model;
  const parts: string[] = [];
  if (usage.turns > 0) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
  if (usage.input > 0) parts.push(`↑${formatMmrWorkerTokens(usage.input)}`);
  if (usage.output > 0) parts.push(`↓${formatMmrWorkerTokens(usage.output)}`);
  if (usage.cacheRead > 0) parts.push(`R${formatMmrWorkerTokens(usage.cacheRead)}`);
  if (usage.cacheWrite > 0) parts.push(`W${formatMmrWorkerTokens(usage.cacheWrite)}`);
  if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens > 0) parts.push(`ctx:${formatMmrWorkerTokens(usage.contextTokens)}`);
  if (model) parts.push(model);
  return parts.length > 0 ? parts.join(" ") : undefined;
}
