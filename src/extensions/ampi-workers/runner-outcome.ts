import { isRecord } from "../ampi-core/internal/json.js";
import { hasUsableMmrWorkerFinalOutput } from "../ampi-core/worker-outcome.js";
import type { MmrWorkerMessage, MmrWorkerResult } from "./runner.js";

// Outcome classification moved to core (`ampi-core/worker-outcome.ts`) as
// part of the subagent unification so seam consumers classify worker
// results without importing ampi-workers; this module re-exports it and
// keeps the runner-internal output shaping + retry predicate.
export {
  DEFAULT_MMR_WORKER_PARTIAL_OUTPUT_POLICY,
  MMR_SUBAGENT_DETAILS_STATUS_VALUES,
  MMR_WORKER_OUTCOME_STATUS_VALUES,
  classifyMmrWorkerOutcome,
  classifyMmrWorkerOutcomeForProfile,
  deriveAsyncTerminalOutcome,
  hasUsableMmrWorkerFinalOutput,
  resolveMmrWorkerPartialOutputPolicy,
} from "../ampi-core/worker-outcome.js";
export type {
  ClassifyMmrWorkerOutcomeOptions,
  MmrAsyncTerminalOutcome,
  MmrSubagentDetailsStatus,
  MmrWorkerOutcomeStatus,
} from "../ampi-core/worker-outcome.js";

/**
 * Pure outcome classification and final-output shaping for subagent worker
 * results: the shared precedence-ordered outcome classifier, its async
 * terminal-outcome projection, final-output extraction/truncation, and the
 * restricted-child retry predicate. No process, stream, or filesystem state
 * lives here. `runner.ts` re-exports this module's public surface, so the
 * runner entry file remains the stable import path.
 *
 * This module is a leaf at runtime: the `import type` references back to
 * `./runner.js` are erased and create no runtime cycle.
 */

export { DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT } from "../ampi-core/worker-contract.js";
import { DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT } from "../ampi-core/worker-contract.js";

export function getMmrWorkerFinalOutput(messages: readonly MmrWorkerMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const content = Array.isArray(message.content) ? message.content : [];
    for (const part of content) {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") return part.text;
    }
  }
  return "";
}

export function truncateMmrWorkerOutput(output: string, byteLimit = DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT): {
  text: string;
  truncated: boolean;
} {
  const limit = Math.max(0, Math.floor(byteLimit));
  const byteLength = Buffer.byteLength(output, "utf8");
  if (byteLength <= limit) return { text: output, truncated: false };

  let truncated = output.slice(0, limit);
  while (Buffer.byteLength(truncated, "utf8") > limit) truncated = truncated.slice(0, -1);
  const omitted = byteLength - Buffer.byteLength(truncated, "utf8");
  return {
    text: `${truncated}\n\n[Output truncated: ${omitted} bytes omitted. Full output preserved in worker details.]`,
    truncated: true,
  };
}

/**
 * Decide whether a restricted-child run should be retried once with full
 * discovery. Only structured discriminators are read; free-form `errorMessage`
 * text is never inspected.
 *
 * Retries when the run was restricted (non-empty `childExtensionScope`) and the
 * failure is one a missing extension would explain:
 *  - `subagentActivationError` — the child's activation guard failed closed
 *    (e.g. `--model`/`--tools` could not be honored against the restricted
 *    registry); or
 *  - the child exited non-zero BEFORE the agent loop with no usable output,
 *    the signature of Pi rejecting an unknown `--model` provider ("Model not
 *    found").
 *
 * Never retries: unrestricted runs, aborts, spawn failures (the binary path is
 * unchanged by the keep set), in-loop worker errors, or clean empty output.
 */
export function shouldRetryMmrChildWithFullDiscovery(
  result: Pick<
    MmrWorkerResult,
    | "spawnError"
    | "subagentActivationError"
    | "aborted"
    | "exitCode"
    | "finalOutput"
    | "truncatedFinalOutput"
  > & { agentStarted?: boolean },
  childExtensionScope: readonly string[] | undefined,
): boolean {
  if (!childExtensionScope || childExtensionScope.length === 0) return false;
  if (result.aborted) return false;
  if (result.spawnError) return false;
  if (result.subagentActivationError) return true;
  return (
    result.agentStarted === false &&
    result.exitCode !== null &&
    result.exitCode !== 0 &&
    !hasUsableMmrWorkerFinalOutput(result)
  );
}
