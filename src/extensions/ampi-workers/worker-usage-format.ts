/**
 * Compatibility re-export: the worker usage/model formatters moved to
 * `ampi-core/worker-usage-format.ts` (core-owned pure display formatters)
 * as part of the subagent unification. This shim keeps the historical
 * `ampi-workers` import path stable for one release.
 */
export {
  formatMmrWorkerTokens,
  formatMmrWorkerUsage,
  stripMmrWorkerModelProvider,
} from "../ampi-core/worker-usage-format.js";
