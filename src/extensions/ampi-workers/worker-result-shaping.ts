/**
 * Compatibility re-export: the pure spawned-subagent result-shaping helpers
 * moved to `ampi-core/worker-result-shaping.ts` as part of the subagent
 * unification (so seam consumers can build worker details without importing
 * `ampi-workers`). This shim keeps the historical import path stable.
 */
export {
  buildSpawnedFinalDetailsBase,
  buildSpawnedProgressDetailsBase,
  progressTextOrPlaceholder,
} from "../ampi-core/worker-result-shaping.js";
export type {
  SpawnedFinalDetailsBaseInput,
  SpawnedProgressDetailsBaseInput,
  SpawnedSubagentDetailsFields,
} from "../ampi-core/worker-result-shaping.js";
