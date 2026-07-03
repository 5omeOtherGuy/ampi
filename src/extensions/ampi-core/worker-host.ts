/**
 * Core-owned worker-host seam (inversion, not imports).
 *
 * `ampi-workers` self-registers the host implementation at activation;
 * sibling extensions (`ampi-custom-subagents`, `ampi-history`) consume the
 * seam through {@link getMmrWorkerHost} / {@link registerMmrWorkerBinding}
 * with ZERO direct `ampi-workers` imports. Same pattern as
 * `config-flow-registry.ts`: globalThis-anchored, replace-by-id, survives
 * cache-isolated module loads.
 *
 * The host surface is EXACTLY four capabilities — `registerWorkerBinding`,
 * `prepareWorkerRun`, `runWorker`, `defaultWorkerRenderers` — and must not
 * become a grab-bag; anything else a sibling wants goes through the
 * worker-run details envelope / view model. Additions require a design
 * review.
 *
 * Fail-closed posture when no host is registered (same as the in-process
 * runner placeholder in `subagent-runner-contract.ts`): consumers get an
 * explicit unavailability error, never a silent no-op.
 */
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  MmrPreparedWorkerRunResult,
  MmrSubagentRunner,
  MmrWorkerContractPreset,
  MmrWorkerRunMode,
  MmrWorkerToolSpec,
} from "./worker-contract.js";

/** How a worker binding is exposed to consumption surfaces. */
export type MmrWorkerBindingExposure = "tool" | "background" | "internal";

/**
 * A worker binding: the declarative spec plus the binding metadata the
 * WorkerBindingRegistry needs (exposure, contract preset, background-surface
 * hints, and runtime deps for dynamically registered workers).
 */
export interface MmrWorkerBindingSpec<TParams = unknown, TDetails = unknown, TRun = void> {
  /** The declarative worker-tool spec (validated/executed by the host's factory). */
  spec: MmrWorkerToolSpec<TParams, TDetails, TRun>;
  /** Which consumption surfaces may resolve this binding. */
  exposure: readonly MmrWorkerBindingExposure[];
  /** Behavior-named pinned-contract preset this binding declares. */
  contractPreset: MmrWorkerContractPreset;
  /** Params shape shown in the start_task schema text, e.g. `"{task}"`. */
  paramsHint: string;
  /** Params key holding the worker's primary prompt/query, for summaries. */
  promptParamKey: string;
  /** Params key a top-level start_task `description` folds into, when accepted. */
  descriptionParamKey?: string;
  /** Worker tool names stamped on the background board record for display. */
  boardWorkerTools?: readonly string[];
  /**
   * Whether runs wrap the shared session-scoped model-fallback wrapper.
   * Dynamically registered workers (custom `sa__*`) pin `"disabled"` to
   * preserve their pre-seam behavior; built-ins default to `"shared"`.
   */
  modelFallback?: "shared" | "disabled";
  /** Runner override (deterministic tests / bespoke runners). */
  runner?: MmrSubagentRunner;
  /** Worker output byte-cap override. */
  outputByteLimit?: number;
}

/** A registered binding: the host-built tool plus its per-call run preparer. */
export interface MmrRegisteredWorkerBinding<TDetails = unknown> {
  tool: ToolDefinition;
  prepareRun(
    rawParams: unknown,
    ctx: ExtensionContext,
  ): MmrPreparedWorkerRunResult<TDetails>;
}

/** Input for {@link MmrWorkerHost.prepareWorkerRun}. */
export interface MmrPrepareWorkerRunInput {
  /** Public agent/tool name of a registered binding. */
  agent: string;
  rawParams: unknown;
  ctx: ExtensionContext;
  /** How the caller intends to consume the prepared run. */
  runMode?: MmrWorkerRunMode;
}

/**
 * The worker host: exactly these four capabilities. Provided by
 * `ampi-workers` at activation.
 */
export interface MmrWorkerHost {
  /** Register (or replace, by tool name) a worker binding; returns the built tool. */
  registerWorkerBinding<TParams, TDetails, TRun = void>(
    binding: MmrWorkerBindingSpec<TParams, TDetails, TRun>,
  ): MmrRegisteredWorkerBinding<TDetails>;
  /** Prepare a registry-ready run from a registered binding. */
  prepareWorkerRun(input: MmrPrepareWorkerRunInput): MmrPreparedWorkerRunResult;
  /** The shared subagent runner (child-CLI today). */
  runWorker: MmrSubagentRunner["run"];
  /** Default worker call/result renderers for host-built tools. */
  defaultWorkerRenderers: {
    renderCall(toolName: string, args: unknown, theme: unknown, context?: unknown): unknown;
    renderResult(toolName: string, result: unknown, options: unknown, theme: unknown, context?: unknown): unknown;
  };
}

interface RegisteredHost {
  id: string;
  host: MmrWorkerHost;
}

// globalThis-anchored so registration survives cache-isolated module loads
// (parent and child Pi processes can each load these modules under distinct
// module identities; the seam must be process-global, not module-local).
const AMPI_WORKER_HOST_GLOBAL_KEY = "__pi_ampi_worker_host_v1__";
const globalStore = globalThis as typeof globalThis & {
  [AMPI_WORKER_HOST_GLOBAL_KEY]?: RegisteredHost;
};

/**
 * Register (or replace, by id) THE process-wide worker host. Idempotent:
 * `ampi-workers` calls this once at activation; re-activation with the same
 * id replaces the prior host. A DIFFERENT id while a host is already live is
 * rejected loudly (throws naming both ids) rather than silently clobbering it.
 */
export function registerMmrWorkerHost(id: string, host: MmrWorkerHost): void {
  const trimmed = id.trim();
  if (trimmed.length === 0) throw new Error("registerMmrWorkerHost requires a non-empty id");
  const existing = globalStore[AMPI_WORKER_HOST_GLOBAL_KEY];
  if (existing !== undefined && existing.id !== trimmed) {
    throw new Error(
      `registerMmrWorkerHost: a worker host is already registered with id "${existing.id}"; refusing to replace it with id "${trimmed}".`,
    );
  }
  globalStore[AMPI_WORKER_HOST_GLOBAL_KEY] = { id: trimmed, host };
}

/** The registered worker host, or `undefined` when none is registered. */
export function getMmrWorkerHost(): MmrWorkerHost | undefined {
  return globalStore[AMPI_WORKER_HOST_GLOBAL_KEY]?.host;
}

export class MmrWorkerHostUnavailableError extends Error {
  constructor(message = "The ampi worker host is not registered in this session (ampi-workers is not active).") {
    super(message);
    this.name = "MmrWorkerHostUnavailableError";
  }
}

/** The registered worker host; throws {@link MmrWorkerHostUnavailableError} when absent (fail closed). */
export function requireMmrWorkerHost(): MmrWorkerHost {
  const host = getMmrWorkerHost();
  if (!host) throw new MmrWorkerHostUnavailableError();
  return host;
}

/**
 * Convenience seam for sibling extensions: register a worker binding with
 * the process-wide host. Fails closed when no host is registered.
 */
export function registerMmrWorkerBinding<TParams, TDetails, TRun = void>(
  binding: MmrWorkerBindingSpec<TParams, TDetails, TRun>,
): MmrRegisteredWorkerBinding<TDetails> {
  return requireMmrWorkerHost().registerWorkerBinding(binding);
}

/** Test-only: clear the registered host. Production code must not call this. */
export function __resetMmrWorkerHostForTests(): void {
  delete globalStore[AMPI_WORKER_HOST_GLOBAL_KEY];
}
