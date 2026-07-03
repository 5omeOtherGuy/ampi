/**
 * Core-owned, type-only worker contracts shared by every subagent surface.
 *
 * `ampi-core` owns the cross-extension worker contract the same way it owns
 * `subagent-runner-contract.ts`: pure type declarations (plus inert literal
 * constants) with NO execution preparers, renderers, or runtime behavior.
 * `ampi-workers` provides the implementations and re-exports these names
 * from its existing modules, so sibling extensions (`ampi-custom-subagents`,
 * `ampi-history`) can type against the contract without importing
 * `ampi-workers`.
 *
 * The shapes here are the wire/detail shapes already produced by the child
 * CLI runner and the worker-tool factory; moving the declarations does not
 * change any payload.
 */
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { MmrSubagentPartialOutputPolicy } from "./subagent-profiles.js";
import type { MmrSubagentInvocation } from "./subagent-resolver.js";
import type { MmrModelPreference } from "./types.js";

// ---------------------------------------------------------------------------
// Worker run payloads
// ---------------------------------------------------------------------------

export interface MmrWorkerUsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface MmrWorkerMessage {
  role?: string;
  content?: unknown;
  usage?: unknown;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

/** Bounded worker activity trail rendered when a worker row is expanded. */
export type MmrWorkerTrailItem =
  | { type: "user"; text: string; imageCount?: number }
  | { type: "assistant"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool";
      toolCallId: string;
      toolName: string;
      status: "running" | "completed" | "failed";
      args?: unknown;
      argsPreview?: string;
      updatePreview?: string;
      resultPreview?: string;
      isError?: boolean;
    }
  | { type: "toolResult"; toolCallId?: string; toolName?: string; text?: string; imageCount?: number; isError?: boolean }
  | { type: "bashExecution"; command?: string; output?: string; exitCode?: number; cancelled?: boolean; truncated?: boolean }
  | { type: "compactionSummary"; summary: string; tokensBefore?: number }
  | { type: "branchSummary"; summary: string }
  | { type: "custom"; customType?: string; text?: string; imageCount?: number }
  | { type: "skillInvocation"; name?: string; location?: string; text?: string };

export interface MmrWorkerProgressSnapshot {
  messages: MmrWorkerMessage[];
  finalOutput: string;
  truncatedFinalOutput: string;
  usage: MmrWorkerUsageStats;
  trail: MmrWorkerTrailItem[];
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

/** Terminal result of one worker run (see `ampi-workers/framework/runner.ts` for field docs). */
export interface MmrWorkerResult extends MmrWorkerProgressSnapshot {
  prompt: string;
  cwd: string;
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  aborted: boolean;
  outputTruncated: boolean;
  ignoredJsonLines: number;
  subagentActivationError?: string;
  spawnError?: string;
  agentStarted: boolean;
}

/**
 * Minimal worker-details surface every worker-backed details type exposes
 * (see `ampi-workers/framework/runner.ts` for the field-level docs; the wire shape of
 * existing `result.details` payloads is unchanged by this declaration move).
 */
export interface MmrSubagentWorkerDetailsBase {
  /** Discriminator literal owned by the concrete tool (e.g. `"ampi-workers.Task"`). */
  worker: string;
  model?: string;
  reportedModel?: string;
  contextWindow?: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  aborted: boolean;
  outputTruncated: boolean;
  ignoredJsonLines: number;
  usage: MmrWorkerUsageStats;
  stopReason?: string;
  errorMessage?: string;
  subagentActivationError?: string;
  workerTools: readonly string[];
}

/**
 * Worker-details base for spawned-subagent tools that run a child Pi process
 * via the shared runner. In-process workers extend
 * {@link MmrSubagentWorkerDetailsBase} directly.
 */
export interface MmrSpawnedSubagentWorkerDetailsBase extends MmrSubagentWorkerDetailsBase {
  stderr: string;
  command: string;
  args: string[];
  cwd: string;
  spawnError?: string;
  trail: readonly MmrWorkerTrailItem[];
  /** Renderer-only board reference; never part of model-consumed `content`. */
  sessionKey?: string;
  taskId?: string;
}

// ---------------------------------------------------------------------------
// Runner interface
// ---------------------------------------------------------------------------

/** Default cap (bytes) on a worker's truncated final output. */
export const DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT = 50 * 1024;

export type MmrSubagentRunProgress = MmrWorkerProgressSnapshot;
export type MmrSubagentWorkerRunResult = MmrWorkerResult;

/** Generic subagent run options (see `ampi-workers/framework/runner.ts` for field docs). */
export interface MmrSubagentRunOptions {
  profileName: string;
  parentMode?: string;
  prompt: string;
  cwd: string;
  model?: string;
  tools?: readonly string[];
  childExtensionScope?: readonly string[];
  systemPrompt?: string;
  systemPromptDelivery?: "append" | "replace";
  modelPreferencesOverride?: readonly MmrModelPreference[];
  signal?: AbortSignal;
  outputByteLimit?: number;
  killTimeoutMs?: number;
  onProgress?: (snapshot: MmrSubagentRunProgress) => void;
}

/**
 * Generic subagent runner interface. Tool implementations depend on this
 * instead of the child-CLI worker function so alternate runners (e.g. a
 * future in-process host seam) can drop in without rewriting callers.
 */
export interface MmrSubagentRunner {
  run(options: MmrSubagentRunOptions): Promise<MmrSubagentWorkerRunResult>;
}

// ---------------------------------------------------------------------------
// Prepared-run contract (the convergence point of every consumption surface)
// ---------------------------------------------------------------------------

export type MmrWorkerRunMode = "blocking" | "background" | "internal";

export type MmrWorkerTerminalOutcome = "success" | "partial" | "failed";

/** Lifecycle status of a registered worker run (async-task registry vocabulary). */
export type MmrWorkerRunStatus =
  | "ready"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled";

/** Completed result from a run that delegates to a Pi tool definition. */
export interface MmrWorkerToolRunResult {
  toolResult: AgentToolResult<unknown>;
  status?: MmrWorkerRunStatus;
  terminalOutcome?: MmrWorkerTerminalOutcome;
  errorMessage?: string;
}

/** Terminal payload produced by a run thunk (raw worker or tool-delegating). */
export type MmrWorkerRunThunkResult = MmrWorkerResult | MmrWorkerToolRunResult;

/** Progress payload reported by a run thunk while it is still live. */
export type MmrWorkerRunThunkProgress = MmrWorkerProgressSnapshot | AgentToolResult<unknown>;

/** Run thunk: the consuming registry supplies its own signal + progress sink. */
export type MmrWorkerRunThunk = (ctx: {
  signal: AbortSignal;
  onProgress: (snapshot: MmrWorkerRunThunkProgress) => void;
}) => Promise<MmrWorkerRunThunkResult>;

/**
 * A fully prepared worker run: board identity + policy bits, the run thunk,
 * and the ONE projection from the raw worker result to the final tool
 * result. Every consumption surface (blocking-await, background-start,
 * internal-call) consumes this same shape.
 */
export interface MmrPreparedWorkerRun<TDetails = unknown> {
  /** Public worker name (the tool name); the registry record's `agent`. */
  agent: string;
  /** Backing subagent profile name (envelope identity). */
  profileName?: string;
  /** Producing tool name (envelope identity; equals `agent` for worker tools). */
  toolName?: string;
  /**
   * How the registrant consumes this run. Stamped by the consuming surface
   * (blocking execute / background start / internal caller) before the run
   * fires so envelope dual-writes carry the honest mode.
   */
  runMode?: MmrWorkerRunMode;
  /** Short display label for the board record. */
  description: string;
  /** Display prompt stamped on the board record (the worker's primary input). */
  displayPrompt: string;
  cwd: string;
  workerTools: readonly string[];
  resolvedModel?: string;
  contextWindow?: number;
  capabilityProfile?: string;
  /** Profile-declared nonzero-exit policy for registry classification. */
  partialOutputPolicy?: MmrSubagentPartialOutputPolicy;
  /** Never rejects; a runner/fallback throw is captured in {@link runError}. */
  run: MmrWorkerRunThunk;
  /** Project a raw terminal worker result into the tool's final content/details. */
  projectResult?: (result: MmrWorkerResult) => AgentToolResult<TDetails>;
  /** Runner/fallback throw captured by {@link run} (throw-to-host specs rethrow it). */
  runError?: unknown;
  /** Board reference, stamped by the registrant right after start. */
  sessionKey?: string;
  taskId?: string;
}

export type MmrPreparedWorkerRunResult<TDetails = unknown> =
  | { ok: true; prepared: MmrPreparedWorkerRun<TDetails> }
  | { ok: false; result: AgentToolResult<TDetails> };

// ---------------------------------------------------------------------------
// Worker-tool spec (the declarative contract every worker binding supplies)
// ---------------------------------------------------------------------------

/** Resolver seam input shared by every worker tool's invocation resolution. */
export interface MmrWorkerToolResolveInput {
  ctx: ExtensionContext | undefined;
  registeredTools?: readonly string[];
  modelPreferencesOverride?: readonly MmrModelPreference[];
}

/**
 * Mutable per-execute run context threaded through a spec's progress/final
 * builders (see `ampi-workers/framework/worker-tool-factory.ts` for behavior docs).
 */
export interface MmrWorkerToolRunContext<TParams, TRun = void> {
  params: TParams;
  cwd: string;
  runData: TRun;
  invocation: (MmrSubagentInvocation & { ok: true }) | undefined;
  workerTools: readonly string[];
  resolvedModel: string | undefined;
  contextWindow: number | undefined;
}

/**
 * Declarative spec for a spawned-subagent worker tool. The execution
 * skeleton lives in `ampi-workers/framework/worker-tool-factory.ts`; this declaration
 * is core-owned so sibling extensions can construct specs and register them
 * through the worker-host seam without importing `ampi-workers`. Field-level
 * behavior documentation lives with the factory implementation.
 */
export interface MmrWorkerToolSpec<TParams, TDetails, TRun = void> {
  toolName: string;
  profileName: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: readonly string[];
  parameters: TSchema;
  /** Set for workflow workers that must not run concurrently. */
  executionMode?: "sequential";
  /**
   * Whether runs wrap the shared session-scoped model-fallback wrapper.
   * Built-ins default to `"shared"`; dynamically registered workers
   * (custom `sa__*`) pin `"disabled"` so they never inherit the fallback
   * prompt/override machinery silently.
   */
  modelFallback?: "shared" | "disabled";
  renderCall?(args: unknown, theme: unknown, context: unknown): unknown;
  renderResult?(result: unknown, options: unknown, theme: unknown, context: unknown): unknown;
  progressPlaceholder: string;
  /** v2 background surface: `background`/`group`/`notify` accepted and dispatched. */
  backgroundCapable?: boolean;
  coerceParams(raw: unknown): TParams;
  paramsFailure?(message: string, raw: unknown, cwd: string): AgentToolResult<TDetails>;
  preSpawnGate?(params: TParams, cwd: string): AgentToolResult<TDetails> | undefined;
  computeRunData?(params: TParams, cwd: string): TRun;
  resolveInvocation(input: MmrWorkerToolResolveInput, params: TParams, runData: TRun): MmrSubagentInvocation;
  resolutionFailure: "fail-closed" | "degrade";
  resolutionFailureResult?(
    invocation: MmrSubagentInvocation & { ok: false },
    params: TParams,
    cwd: string,
  ): AgentToolResult<TDetails>;
  mirrorWorkerTools: boolean;
  detailsWorkerTools: "profile-constant" | "invocation";
  workerToolsConstant: readonly string[];
  progressModelBinding: "per-attempt" | "initial";
  describeRun(params: TParams, runData: TRun): { description: string; displayPrompt: string };
  buildUserPrompt(params: TParams, runData: TRun): string;
  assembleSystemPrompt(
    cwd: string,
    workerTools: readonly string[] | undefined,
    runCtx: MmrWorkerToolRunContext<TParams, TRun>,
  ): string;
  resolveContextWindow?(
    ctx: ExtensionContext | undefined,
    model: string | undefined,
    invocation: (MmrSubagentInvocation & { ok: true }) | undefined,
  ): number | undefined;
  extraRunnerOptions?(runCtx: MmrWorkerToolRunContext<TParams, TRun>): Partial<MmrSubagentRunOptions>;
  candidatePreferences(runCtx: MmrWorkerToolRunContext<TParams, TRun>): readonly MmrModelPreference[];
  fallbackParentMode?(runCtx: MmrWorkerToolRunContext<TParams, TRun>): string | undefined;
  buildProgressDetails(snapshot: MmrWorkerProgressSnapshot, runCtx: MmrWorkerToolRunContext<TParams, TRun>): TDetails;
  buildFinalDetails(result: MmrWorkerResult, runCtx: MmrWorkerToolRunContext<TParams, TRun>): TDetails;
  buildFinalContent(result: MmrWorkerResult, runCtx: MmrWorkerToolRunContext<TParams, TRun>): string;
  mapRunError?(err: unknown, runCtx: MmrWorkerToolRunContext<TParams, TRun>): AgentToolResult<TDetails>;
}

// ---------------------------------------------------------------------------
// Contract presets (behavior-named bundles of the orthogonal spec knobs)
// ---------------------------------------------------------------------------

export type MmrWorkerContractPreset = "degrading-advisory" | "strict-delegated";

/** The spec knobs a contract preset pins. */
export interface MmrWorkerContractPresetKnobs {
  /** Params errors throw to host (`"throw-to-host"`) or map to a structured result (`"structured"`). */
  paramsFailure: "throw-to-host" | "structured";
  resolutionFailure: "fail-closed" | "degrade";
  mirrorWorkerTools: boolean;
  detailsWorkerTools: "profile-constant" | "invocation";
  progressModelBinding: "per-attempt" | "initial";
  /** Runner/fallback throws map to a structured result (`"structured"`) or rethrow (`"throw-to-host"`). */
  runError: "throw-to-host" | "structured";
}

/**
 * The two behavior-named contract presets:
 *  - `degrading-advisory` (finder, oracle, reviewer): params errors throw to
 *    host; resolution failure degrades (child resolves the route); no
 *    mirrored `--tools`; profile-constant tools in details; per-attempt
 *    progress model binding; run errors rethrow.
 *  - `strict-delegated` (Task, librarian, custom `sa__*`, history-reader):
 *    structured params failure; fail-closed activation; mirrored worker
 *    tools; invocation-derived tools in details; structured run-error
 *    mapping.
 *
 * Presets are the pinned-contract vocabulary; a binding may declare
 * `compatOverrides` during migration, and every override requires a pinned
 * deterministic test.
 */
export const MMR_WORKER_CONTRACT_PRESETS: Readonly<Record<MmrWorkerContractPreset, MmrWorkerContractPresetKnobs>> = Object.freeze({
  "degrading-advisory": Object.freeze({
    paramsFailure: "throw-to-host",
    resolutionFailure: "degrade",
    mirrorWorkerTools: false,
    detailsWorkerTools: "profile-constant",
    progressModelBinding: "per-attempt",
    runError: "throw-to-host",
  } as const),
  "strict-delegated": Object.freeze({
    paramsFailure: "structured",
    resolutionFailure: "fail-closed",
    mirrorWorkerTools: true,
    detailsWorkerTools: "invocation",
    progressModelBinding: "initial",
    runError: "structured",
  } as const),
});

// ---------------------------------------------------------------------------
// Canonical worker-run details envelope (versioned)
// ---------------------------------------------------------------------------

export const MMR_WORKER_RUN_ENVELOPE_KIND = "worker-run" as const;
export const MMR_WORKER_RUN_ENVELOPE_VERSION = 1 as const;

/**
 * Canonical, versioned details envelope every worker surface will converge
 * on. Dual-written alongside the legacy details shapes for one release; the
 * renderer dual-reads (envelope preferred, legacy fallback). MUST carry
 * enough frozen snapshot data to render a replayed transcript with no live
 * registry — registry lookups are an overlay, never a requirement.
 */
export interface MmrWorkerRunEnvelopeV1 {
  kind: typeof MMR_WORKER_RUN_ENVELOPE_KIND;
  version: typeof MMR_WORKER_RUN_ENVELOPE_VERSION;
  run: {
    profileName: string;
    toolName: string;
    agent: string;
    runMode: MmrWorkerRunMode;
    sessionKey?: string;
    taskId?: string;
    groupId?: string;
    status: string;
    terminalOutcome?: MmrWorkerTerminalOutcome;
    resolvedModel?: string;
    contextWindow?: number;
    workerTools: readonly string[];
    description?: string;
    promptPreview?: string;
  };
  snapshot: {
    row?: unknown;
    group?: unknown;
    fleet?: unknown;
    final?: unknown;
    trail?: readonly MmrWorkerTrailItem[];
    usage?: MmrWorkerUsageStats;
    errorMessage?: string;
  };
  render: {
    gated?: boolean;
    completionNotice?: boolean;
  };
}
