import { isRecord } from "../ampi-core/internal/json.js";
import type { MmrSubagentPartialOutputPolicy, MmrSubagentProfile } from "../ampi-core/subagent-profiles.js";
import type { MmrWorkerMessage, MmrWorkerResult } from "./runner.js";

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

export const DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT = 50 * 1024;

/**
 * Shared outcome status produced by {@link classifyMmrWorkerOutcome}.
 * Concrete tools may narrow this to a tool-specific status union
 * (e.g. {@link import("./task.js").TaskStatus}) by handling additional
 * pre-classification states such as `validation-error`.
 *
 * Precedence (top wins):
 *  1. `spawn-error`      — runner failed before/while spawning the child.
 *  2. `activation-error` — child wrote the ampi-core activation-failure marker.
 *  3. `aborted`          — parent abort signal arrived.
 *  4. `worker-error`     — signal-killed without usable final text, or
 *                          nonzero exit (see `partialOutputPolicy`).
 *  5. `no-agent-start`   — clean exit with no usable final text AND the
 *                          child never emitted `agent_start`. This is the
 *                          signature of a sibling input-event handler
 *                          (sibling extension) consuming the prompt before
 *                          the model is consulted; surfacing it as a
 *                          distinct outcome lets consumers replace the
 *                          cheerful "no results" message with a diagnostic
 *                          that points operators at extension stderr.
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
 * `statusFromDetails` (subagent-render-format.ts) trusts exactly this set
 * when deciding how a finished worker row renders, so the producing and
 * consuming sides can never drift.
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
 * text is present. The policy bit itself is declared on the subagent
 * profile (see {@link MmrSubagentPartialOutputPolicy} in ampi-core):
 * profiles default to `"fail-on-nonzero"`, and only `task-subagent`
 * declares `"prefer-usable-output"` (spec §9.4). Callers that hold the
 * profile should prefer {@link classifyMmrWorkerOutcomeForProfile} over
 * passing the policy literal here.
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
 * Deterministic precedence-ordered classifier for `MmrWorkerResult`
 * outcomes. Replaces the per-tool ad-hoc precedence each subagent had
 * to spell out independently. Consumers that need additional
 * pre-classification states (Task's `validation-error`) wrap this
 * function and short-circuit before calling it.
 *
 * The classifier never inspects free-form `errorMessage` text; only
 * structured discriminators (`spawnError`, `subagentActivationError`,
 * `aborted`, `signal`, `exitCode`, `agentStarted`) and final-output
 * usability are read.
 *
 * `agentStarted` is optional and defaults to `true` for backward
 * compatibility with callers that did not previously thread it through.
 * Production callers (the spawned-worker runner) always pass the
 * observed value; older test fixtures and ad-hoc callers therefore stay
 * on the pre-existing `empty-output` path until they opt into the new
 * signal.
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
