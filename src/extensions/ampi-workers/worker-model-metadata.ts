/**
 * Compatibility re-export: the pure model-registry introspection helpers
 * moved to `ampi-core/worker-model-metadata.ts` as part of the subagent
 * unification. This shim keeps the historical import path stable.
 */
export {
  listAvailableMmrWorkerModelsFromCtx,
  readMmrModelContextWindow,
  resolveCtxMmrModelRegistry,
  resolveMmrWorkerModelContextWindowFromCtx,
} from "../ampi-core/worker-model-metadata.js";
