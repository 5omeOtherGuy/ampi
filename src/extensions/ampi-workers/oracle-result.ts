import { getMmrSubagentProfile } from "../ampi-core/subagent-profiles.js";
import {
  classifyMmrWorkerOutcomeForProfile,
  type MmrSpawnedSubagentWorkerDetailsBase,
  type MmrWorkerOutcomeStatus,
  type MmrWorkerProgressSnapshot,
  type MmrWorkerResult,
} from "./runner.js";
import {
  buildSpawnedFinalDetailsBase,
  buildSpawnedProgressDetailsBase,
  progressTextOrPlaceholder,
} from "./worker-result-shaping.js";
import type { InternalAttachment } from "./oracle-prompt.js";
import type { MmrAdvisorToolConfig } from "./oracle.js";

/**
 * Pure result/details shaping for the oracle/advisor tools: the
 * `OracleDetails` payload and attachment-record shapes, the progress
 * placeholder, and the progress/final details and content builders driven
 * by the shared worker-outcome classifier (fail-on-nonzero policy). No
 * worker, settings, or prompt-registry state lives here. `oracle.ts`
 * re-exports the public surface, so the entry file remains the stable
 * import path.
 *
 * This module is a leaf at runtime: the `import type` references back to
 * `./oracle.js` and `./oracle-prompt.js` are erased and create no runtime
 * cycle.
 */

/** Worker-details payload attached to every oracle/advisor AgentToolResult. */
export interface OracleDetails extends MmrSpawnedSubagentWorkerDetailsBase {
  worker: string;
  // Final-run outcome from the shared classifier. The renderer reads this
  // first, so a successful run that merely preserved a non-fatal provider
  // `errorMessage` still renders as completed instead of failed.
  status?: MmrWorkerOutcomeStatus;
  /** Summary of how each requested `files[]` entry was handled. */
  attachments: readonly OracleAttachmentRecord[];
}

/** Per-file record of how a requested files[] entry was handled. */
export type OracleAttachmentRecord =
  | {
      kind: "text";
      path: string;
      bytes: number;
      truncated: boolean;
      originalBytes: number;
    }
  | { kind: "image"; path: string; bytes: number }
  | { kind: "skipped"; path: string; reason: string };

/** Compact progress status surfaced to the model before the worker finishes. */
export const ORACLE_PROGRESS_PLACEHOLDER = "oracle: consulting…";

/** Latest streamed worker text, or the configured placeholder before any output. */
export function progressContent(snapshot: MmrWorkerProgressSnapshot, placeholder: string): string {
  return progressTextOrPlaceholder(snapshot, placeholder);
}

/** Build the in-flight OracleDetails for a progress snapshot. */
export function buildProgressDetails(
  config: MmrAdvisorToolConfig,
  snapshot: MmrWorkerProgressSnapshot,
  resolvedModel: string | undefined,
  cwd: string,
  attachments: readonly InternalAttachment[],
  contextWindow: number | undefined,
): OracleDetails {
  const base = buildSpawnedProgressDetailsBase({
    snapshot,
    cwd,
    workerTools: config.workerTools,
    ...(resolvedModel !== undefined ? { resolvedModel } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  });
  return { worker: config.workerDiscriminator, ...base, attachments: attachments.map((a) => a.record) };
}

/** Build the final OracleDetails for a completed worker result. */
export function buildDetails(
  config: MmrAdvisorToolConfig,
  result: MmrWorkerResult,
  resolvedModel: string | undefined,
  cwd: string,
  attachments: readonly InternalAttachment[],
  contextWindow: number | undefined,
): OracleDetails {
  const base = buildSpawnedFinalDetailsBase({
    result,
    cwd,
    workerTools: config.workerTools,
    ...(resolvedModel !== undefined ? { resolvedModel } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  });
  const status = classifyMmrWorkerOutcomeForProfile(result, getMmrSubagentProfile(config.profileName));
  return { worker: config.workerDiscriminator, status, ...base, attachments: attachments.map((a) => a.record) };
}

/**
 * Model-visible final content text for a completed worker result.
 * `profileName` selects the advisor profile whose nonzero-exit policy
 * drives classification; omitted (or unknown) profiles classify under
 * the `fail-on-nonzero` default, which is every advisor profile today.
 */
export function buildFinalContent(label: string, result: MmrWorkerResult, profileName?: string): string {
  // Failure-state precedence is owned by the shared worker-outcome
  // classifier under the advisor profile's nonzero-exit policy. The
  // classifier guarantees `spawn-error` / `activation-error` / `aborted`
  // / `worker-error` win over output rendering, and the structured
  // `result.spawnError` field takes precedence over `result.errorMessage`
  // text so spawn-failure reasons (`spawn ENOENT`, `EACCES`, etc.) are
  // not lost when stderr is empty.
  const outcome = classifyMmrWorkerOutcomeForProfile(
    result,
    profileName !== undefined ? getMmrSubagentProfile(profileName) : undefined,
  );
  if (outcome === "spawn-error") {
    const reason = result.spawnError ?? result.errorMessage ?? "unknown spawn error";
    return `${label}: worker spawn failed: ${reason}`;
  }
  if (outcome === "activation-error") {
    return `${label}: subagent activation failed: ${result.subagentActivationError}`;
  }
  if (outcome === "aborted") {
    return `${label}: consultation was cancelled before producing a result.`;
  }
  if (outcome === "worker-error") {
    const tail = result.stderr.trim().split("\n").slice(-3).join("\n");
    const detailText = tail.length > 0 ? tail : (result.errorMessage ?? "");
    const detail = detailText.length > 0 ? `\n\n${detailText}` : "";
    return `${label}: worker exited with code ${result.exitCode ?? "null"}.${detail}`;
  }
  if (outcome === "no-agent-start") {
    // Mirrors finder's diagnostic: the worker exited cleanly without ever
    // entering the agent loop. Almost always means another Pi extension's
    // `input` event hook consumed the prompt before any provider call
    // could happen. Surface the actionable hint instead of the empty
    // advisory message.
    const tail = result.stderr.trim().split("\n").slice(-3).join("\n");
    const detail = tail.length > 0 ? `\n\n${tail}` : "";
    return `${label}: worker exited before the agent loop started. No advisory output was produced; another Pi extension's input handler likely consumed the prompt. Check stderr for extension diagnostics.${detail}`;
  }
  if (outcome === "success") {
    return result.truncatedFinalOutput || result.finalOutput;
  }
  // empty-output
  if (result.errorMessage && result.errorMessage.length > 0) {
    return `${label}: worker reported an error: ${result.errorMessage}`;
  }
  return `${label}: no advisory output was produced. Re-run with a more specific task or attached files.`;
}
