/**
 * Pure, core-owned outcome classification for subagent worker results: the
 * shared precedence-ordered classifier, its async terminal-outcome
 * projection, and the nonzero-exit output policy resolution.
 *
 * Moved from `ampi-workers/framework/runner-outcome.ts` (which re-exports this module
 * as its stable import path) so sibling extensions — `ampi-custom-subagents`
 * and `ampi-history` — can classify worker results without importing
 * `ampi-workers`. Pure policy only: no process, stream, or filesystem state.
 */
import type { MmrSubagentPartialOutputPolicy, MmrSubagentProfile } from "./subagent-profiles.js";
import type { MmrWorkerResult } from "./worker-contract.js";

/**
 * Shared outcome status produced by {@link classifyMmrWorkerOutcome}.
 *
 * Precedence (top wins):
 *  1. `spawn-error`      — runner failed before/while spawning the child.
 *  2. `activation-error` — child wrote the ampi-core activation-failure marker.
 *  3. `aborted`          — parent abort signal arrived.
 *  4. `worker-error`     — signal-killed without usable final text, or
 *                          nonzero exit (see `partialOutputPolicy`).
 *  5. `no-agent-start`   — clean exit with no usable final text AND the
 *                          child never emitted `agent_start` (the signature
 *                          of a sibling input-event handler consuming the
 *                          prompt before the model is consulted).
 *  6. `empty-output`     — clean exit with no usable final text but the
 *                          agent loop did run.
 *  7. `success`          — otherwise.
 */
export const MMR_WORKER_OUTCOME_STATUS_VALUES = [
  "success",
  "spawn-error",
  "activation-error",
  "aborted",
  "worker-error",
  "no-agent-start",
  "empty-output",
] as const;

export type MmrWorkerOutcomeStatus = (typeof MMR_WORKER_OUTCOME_STATUS_VALUES)[number];

/**
 * Canonical `details.status` discriminator set a subagent tool may stamp
 * on its result details: every classifier outcome plus the pre-spawn
 * `validation-error` state tools assign before any worker result exists.
 * The render-side `statusFromDetails` trusts exactly this set, so the
 * producing and consuming sides can never drift.
 */
export const MMR_SUBAGENT_DETAILS_STATUS_VALUES = [
  ...MMR_WORKER_OUTCOME_STATUS_VALUES,
  "validation-error",
] as const;

export type MmrSubagentDetailsStatus = (typeof MMR_SUBAGENT_DETAILS_STATUS_VALUES)[number];

/** Terminal outcome projection used by the async background-task layer. */
export type MmrAsyncTerminalOutcome = "success" | "partial" | "failed";

/**
 * Policy controlling how nonzero exits are classified when usable final
 * text is present. Declared on the subagent profile; callers that hold the
 * profile should prefer {@link classifyMmrWorkerOutcomeForProfile}.
 */
export interface ClassifyMmrWorkerOutcomeOptions {
  partialOutputPolicy: MmrSubagentPartialOutputPolicy;
}

/** Default nonzero-exit policy for profiles that do not declare the bit. */
export const DEFAULT_MMR_WORKER_PARTIAL_OUTPUT_POLICY: MmrSubagentPartialOutputPolicy = "fail-on-nonzero";

/**
 * Resolve a profile's nonzero-exit output policy, applying the
 * `"fail-on-nonzero"` default for profiles (or absent profiles) that do
 * not declare the bit.
 */
export function resolveMmrWorkerPartialOutputPolicy(
  profile: Pick<MmrSubagentProfile, "partialOutputPolicy"> | undefined,
): MmrSubagentPartialOutputPolicy {
  return profile?.partialOutputPolicy ?? DEFAULT_MMR_WORKER_PARTIAL_OUTPUT_POLICY;
}

/**
 * Predicate shared with consumers that want to mirror the classifier's
 * notion of “usable final text.” The truncated form wins when present
 * so partial responses still count.
 */
export function hasUsableMmrWorkerFinalOutput(
  result: Pick<MmrWorkerResult, "finalOutput" | "truncatedFinalOutput">,
): boolean {
  const text =
    result.truncatedFinalOutput && result.truncatedFinalOutput.length > 0
      ? result.truncatedFinalOutput
      : (result.finalOutput ?? "");
  return text.trim().length > 0;
}

/**
 * Deterministic precedence-ordered classifier for worker results. Never
 * inspects free-form `errorMessage` text; only structured discriminators
 * and final-output usability are read. `agentStarted` is optional and
 * defaults to `true` for backward compatibility.
 */
export function classifyMmrWorkerOutcome(
  result: Pick<
    MmrWorkerResult,
    | "spawnError"
    | "subagentActivationError"
    | "aborted"
    | "signal"
    | "exitCode"
    | "finalOutput"
    | "truncatedFinalOutput"
  > & { agentStarted?: boolean },
  options: ClassifyMmrWorkerOutcomeOptions,
): MmrWorkerOutcomeStatus {
  if (result.spawnError) return "spawn-error";
  if (result.subagentActivationError) return "activation-error";
  if (result.aborted) return "aborted";
  const usable = hasUsableMmrWorkerFinalOutput(result);
  if (result.signal !== null && !usable) return "worker-error";
  if (result.exitCode !== null && result.exitCode !== 0) {
    if (options.partialOutputPolicy === "fail-on-nonzero") return "worker-error";
    if (!usable) return "worker-error";
  }
  if (usable) return "success";
  if (result.agentStarted === false) return "no-agent-start";
  return "empty-output";
}

/**
 * Profile-driven entry point for {@link classifyMmrWorkerOutcome}: reads
 * the nonzero-exit policy from the worker's subagent profile (default
 * `"fail-on-nonzero"`) so call sites never restate the policy literal.
 */
export function classifyMmrWorkerOutcomeForProfile(
  result: Parameters<typeof classifyMmrWorkerOutcome>[0],
  profile: Pick<MmrSubagentProfile, "partialOutputPolicy"> | undefined,
): MmrWorkerOutcomeStatus {
  return classifyMmrWorkerOutcome(result, {
    partialOutputPolicy: resolveMmrWorkerPartialOutputPolicy(profile),
  });
}

/** Project a worker result onto the async terminal-outcome triple (undefined when aborted). */
export function deriveAsyncTerminalOutcome(
  result: Pick<
    MmrWorkerResult,
    | "spawnError"
    | "subagentActivationError"
    | "aborted"
    | "signal"
    | "exitCode"
    | "finalOutput"
    | "truncatedFinalOutput"
    | "outputTruncated"
  > & { agentStarted?: boolean },
  options: ClassifyMmrWorkerOutcomeOptions,
): MmrAsyncTerminalOutcome | undefined {
  const status = classifyMmrWorkerOutcome(result, options);
  if (status === "aborted") return undefined;
  if (status !== "success") return "failed";
  return result.outputTruncated ? "partial" : "success";
}
