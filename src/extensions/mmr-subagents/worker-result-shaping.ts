import type {
  MmrSpawnedSubagentWorkerDetailsBase,
  MmrWorkerProgressSnapshot,
  MmrWorkerResult,
  MmrWorkerTrailItem,
} from "./runner.js";

/**
 * Internal helper for spawned-subagent tools (`finder`, `oracle`,
 * `Task`, `librarian`). Concentrates the small, behavior-preserving
 * pieces of result shaping that previously appeared as near-duplicates
 * in every concrete tool file:
 *
 *  - {@link progressTextOrPlaceholder}: pick the worker's partial final
 *    output for progress events, or a tool-specific placeholder when
 *    no usable text has arrived yet.
 *  - {@link buildSpawnedProgressDetailsBase}: build the shared
 *    progress-time details fields (exitCode null, signal null, aborted
 *    false, stderr/command/args empty, usage from snapshot, plus
 *    optional model / contextWindow / reportedModel / stopReason /
 *    errorMessage propagation).
 *  - {@link buildSpawnedFinalDetailsBase}: build the shared final
 *    details fields populated from a complete {@link MmrWorkerResult}
 *    (exit/signal/aborted/usage/stderr/command/args/trail + optional
 *    model / reportedModel / stopReason / errorMessage /
 *    subagentActivationError / spawnError).
 *
 * The helper deliberately does NOT own:
 *  - the per-tool `worker` discriminator literal
 *    (`"mmr-subagents.finder"`, `"mmr-subagents.oracle"`, etc.);
 *  - per-tool extension fields (`attachments` for oracle; `status` /
 *    `prompt` / `description` for Task; `status` / `query` /
 *    `context` for librarian);
 *  - final-content message formatting (success / error templates);
 *  - outcome / status classification.
 *
 * Per-tool wrappers continue to own those concerns. This module is
 * intentionally internal: no extension entry point re-exports it, and
 * it is not part of the package-level public API surface.
 */

/** Shared spawned-subagent details fields, minus the `worker` discriminator. */
export type SpawnedSubagentDetailsFields = Omit<MmrSpawnedSubagentWorkerDetailsBase, "worker">;

export interface SpawnedProgressDetailsBaseInput {
  snapshot: MmrWorkerProgressSnapshot;
  cwd: string;
  workerTools: readonly string[];
  /** Parent-side selected model (provider-qualified or bare). */
  resolvedModel?: string;
  /** Parent-side context window for the selected model, when known. */
  contextWindow?: number;
  /**
   * Optional trail override. When omitted, the snapshot's trail is
   * used verbatim. Finder passes its sanitized trail here so finder
   * link sanitization stays local to `finder.ts`.
   */
  trail?: readonly MmrWorkerTrailItem[];
}

/**
 * Build the common spawned-subagent progress details fields from a
 * {@link MmrWorkerProgressSnapshot}. The worker has not exited yet, so
 * exit-related fields stay at their typed placeholders
 * (`exitCode: null`, `signal: null`, `aborted: false`,
 * `outputTruncated: false`, `ignoredJsonLines: 0`, `stderr: ""`,
 * `command: ""`, `args: []`) and `usage` mirrors the in-flight snapshot.
 *
 * Optional fields (`model`, `contextWindow`, `reportedModel`,
 * `stopReason`, `errorMessage`) are assigned only when truthy so the
 * resulting object matches what each per-tool builder produced before
 * the refactor.
 */
export function buildSpawnedProgressDetailsBase(
  input: SpawnedProgressDetailsBaseInput,
): SpawnedSubagentDetailsFields {
  const { snapshot, cwd, workerTools, resolvedModel, contextWindow, trail } = input;
  const base: SpawnedSubagentDetailsFields = {
    exitCode: null,
    signal: null,
    aborted: false,
    outputTruncated: false,
    ignoredJsonLines: 0,
    usage: snapshot.usage,
    stderr: "",
    command: "",
    args: [],
    cwd,
    workerTools,
    trail: trail ?? snapshot.trail ?? [],
  };
  if (resolvedModel) base.model = resolvedModel;
  if (contextWindow) base.contextWindow = contextWindow;
  if (snapshot.model) base.reportedModel = snapshot.model;
  if (snapshot.stopReason) base.stopReason = snapshot.stopReason;
  if (snapshot.errorMessage) base.errorMessage = snapshot.errorMessage;
  return base;
}

export interface SpawnedFinalDetailsBaseInput {
  result: MmrWorkerResult;
  cwd: string;
  workerTools: readonly string[];
  /** Parent-side selected model (provider-qualified or bare). */
  resolvedModel?: string;
  /** Parent-side context window for the selected model, when known. */
  contextWindow?: number;
  /**
   * Optional trail override. When omitted, the result's trail is used
   * verbatim. Finder passes its sanitized trail here so finder link
   * sanitization stays local to `finder.ts`.
   */
  trail?: readonly MmrWorkerTrailItem[];
}

/**
 * Build the common spawned-subagent final details fields from a
 * complete {@link MmrWorkerResult}. Propagates the runner-observable
 * exit / signal / aborted / output-truncation / ignored-json-lines /
 * usage / stderr / command / args / trail fields verbatim. Optional
 * fields (`model`, `contextWindow`, `reportedModel`, `stopReason`,
 * `errorMessage`, `subagentActivationError`, `spawnError`) are
 * assigned only when truthy so the resulting object matches what each
 * per-tool builder produced before the refactor.
 *
 * The structured `spawnError` discriminator is forwarded verbatim so
 * the progress renderer (which prefers `details.spawnError` over
 * `details.errorMessage`) keeps producing deterministic spawn-failed
 * lines for runner spawn errors.
 */
export function buildSpawnedFinalDetailsBase(
  input: SpawnedFinalDetailsBaseInput,
): SpawnedSubagentDetailsFields {
  const { result, cwd, workerTools, resolvedModel, contextWindow, trail } = input;
  const base: SpawnedSubagentDetailsFields = {
    exitCode: result.exitCode,
    signal: result.signal,
    aborted: result.aborted,
    outputTruncated: result.outputTruncated,
    ignoredJsonLines: result.ignoredJsonLines,
    usage: result.usage,
    stderr: result.stderr,
    command: result.command,
    args: result.args,
    cwd,
    workerTools,
    trail: trail ?? result.trail ?? [],
  };
  if (resolvedModel) base.model = resolvedModel;
  if (contextWindow) base.contextWindow = contextWindow;
  if (result.model) base.reportedModel = result.model;
  if (result.stopReason) base.stopReason = result.stopReason;
  if (result.errorMessage) base.errorMessage = result.errorMessage;
  if (result.subagentActivationError) {
    base.subagentActivationError = result.subagentActivationError;
  }
  if (result.spawnError) base.spawnError = result.spawnError;
  return base;
}

/**
 * Return the partial worker output suitable for a spawned-subagent
 * progress event, or the supplied placeholder when the worker has not
 * produced any usable text yet. Mirrors the inline helper that
 * `finder`, `oracle`, `Task`, and `librarian` each defined separately.
 */
export function progressTextOrPlaceholder(
  snapshot: Pick<MmrWorkerProgressSnapshot, "finalOutput" | "truncatedFinalOutput">,
  placeholder: string,
): string {
  const partial = snapshot.truncatedFinalOutput || snapshot.finalOutput;
  return partial && partial.trim().length > 0 ? partial : placeholder;
}
