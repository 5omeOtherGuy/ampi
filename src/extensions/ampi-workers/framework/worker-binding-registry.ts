/**
 * The WorkerBindingRegistry: one registry of worker bindings keyed by
 * profile name. It replaces the former background-agent descriptor table —
 * every binding is the SAME prepared-run contract regardless of consumption
 * surface, and carries its exposure and behavior-named contract preset.
 *
 * The set of agents the background surface (`start_task`, and each named
 * tool's `background: true` path) offers is DERIVED, not hardcoded: a
 * profile appears as a background agent exactly when
 *   1. it is registered in ampi-core's subagent-profile registry
 *      (`listMmrSubagentProfiles()`, static ∪ dynamic), AND
 *   2. its profile does not declare `backgroundable: false`, AND
 *   3. a binding is registered here, AND its exposure allows background.
 *
 * ampi-workers registers the built-in bindings (Task, finder, librarian,
 * reviewer) at module load; seam-registered workers (custom Markdown
 * subagents via ampi-core's `registerMmrWorkerBinding`) are added at
 * activation, which is what makes them backgroundable without any per-agent
 * branch in the async-task tools. There is no tool-execute adapter and no
 * terminal-status string sniffing: every binding prepares a registry-ready
 * run through the shared worker-tool factory preparer.
 *
 * This module is intentionally internal (not exported from src/index.ts):
 * the public contract is the derived `start_task` surface, not the registry.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type {
  MmrWorkerContractPreset,
} from "../../ampi-core/worker-contract.js";
import type { MmrWorkerBindingExposure } from "../../ampi-core/worker-host.js";
import {
  getMmrSubagentProfile,
  listMmrSubagentProfiles,
} from "../../ampi-core/subagent-profiles.js";
import type {
  MmrPreparedWorkerRunResult,
} from "./worker-tool-factory.js";
import {
  createFinderRunPreparer,
  FINDER_PARAMETERS_SCHEMA,
  FINDER_TOOL_NAME,
  FINDER_WORKER_TOOLS,
  type FinderToolDeps,
} from "../builtin-workers/finder.js";
import {
  createLibrarianRunPreparer,
  LIBRARIAN_PARAMETERS_SCHEMA,
  LIBRARIAN_TOOL_NAME,
  LIBRARIAN_WORKER_TOOLS,
  type LibrarianToolDeps,
} from "../builtin-workers/librarian.js";
import {
  createTaskRunPreparer,
  TASK_SUBAGENT_PROFILE,
  TASK_TOOL_NAME,
  type TaskToolDeps,
} from "../builtin-workers/task.js";
import {
  REVIEWER_PARAMETERS_SCHEMA,
  REVIEWER_SUBAGENT_PROFILE,
  REVIEWER_TOOL_NAME,
  REVIEWER_WORKER_TOOLS,
  createReviewerRunPreparer,
  type ReviewerToolDeps,
} from "../builtin-workers/reviewer.js";

/** The agent `start_task` launches when the caller omits `agent`. */
export const DEFAULT_MMR_BACKGROUND_AGENT = TASK_TOOL_NAME;

/**
 * Per-call inputs forwarded to a descriptor's {@link MmrBackgroundAgentStart.prepareRun}.
 */
export interface MmrBackgroundAgentPrepareOptions {
  /** Originating Pi tool-call id (tool-execute adapters derive child call ids from it). */
  toolCallId: string;
}

/**
 * How a background agent's run is built. ONE strategy for every agent: the
 * binding prepares a registry-ready run (validation → invocation
 * resolution → run thunk + result projection) and `executeBackgroundStart`
 * registers it. Factory-built workers (finder, librarian, Task, reviewer)
 * plug their run preparers in directly, and seam-registered workers (custom
 * Markdown subagents) share the SAME factory preparer, so the background
 * surface shares the blocking tools' preparation path verbatim for every
 * agent — no tool-execute adapter, no per-agent strategy branch.
 */
export interface MmrBackgroundAgentStart {
  /**
   * Pre-spawn parameters schema validated by the start path BEFORE
   * `prepareRun`; an invalid start creates no record. Omitted for agents
   * whose preparer owns the full deterministic validation surface (Task's
   * byte caps and pinned messages).
   */
  readonly parametersSchema?: TSchema;
  /** Worker tool names stamped on the background record for display/projection. */
  readonly workerTools: readonly string[];
  /** `AsyncTaskToolDeps` key holding this agent's tool-specific seams. */
  readonly depsKey?: string;
  /**
   * Prepare a registry-ready run from validated params. A `{ok: false}`
   * outcome is a pre-spawn failure (no record, no group); a throw is
   * treated as a validation failure by the start path.
   */
  prepareRun(
    deps: Record<string, unknown>,
    params: unknown,
    ctx: ExtensionContext,
    opts: MmrBackgroundAgentPrepareOptions,
  ): MmrPreparedWorkerRunResult;
}

export interface MmrBackgroundAgentDescriptor {
  /** Public agent name accepted by `start_task` (a stable worker tool name). */
  readonly agent: string;
  /**
   * Which consumption surfaces may resolve this binding. Defaults to
   * `["tool", "background"]` when omitted (the historical descriptor
   * behavior).
   */
  readonly exposure?: readonly MmrWorkerBindingExposure[];
  /** Behavior-named pinned-contract preset this binding declares. */
  readonly contractPreset?: MmrWorkerContractPreset;
  /** Backing subagent profile (policy source: backgroundable, capabilityProfile, output policy). */
  readonly profileName: string;
  /** Tool name used as the validation-error prefix for this agent's params. */
  readonly toolName: string;
  /**
   * The agent's params shape as shown in the start_task schema text, e.g.
   * `"{query, context?}"`. Whitespace is compacted where the surrounding
   * text calls for the compact form.
   */
  readonly paramsHint: string;
  /** Params key holding the worker's primary prompt/query, for summaries. */
  readonly promptParamKey: string;
  /**
   * Params key a top-level start_task `description` folds into when the
   * agent's params accept one (Task). Drives member normalization data-only,
   * with no agent-name or strategy branch.
   */
  readonly descriptionParamKey?: string;
  readonly start: MmrBackgroundAgentStart;
}

const BUILTIN_BACKGROUND_AGENTS: ReadonlyMap<string, MmrBackgroundAgentDescriptor> = new Map(
  (
    [
      {
        agent: TASK_TOOL_NAME,
        profileName: TASK_SUBAGENT_PROFILE,
        toolName: TASK_TOOL_NAME,
        exposure: ["tool", "background"],
        contractPreset: "strict-delegated",
        paramsHint: "{prompt, description}",
        promptParamKey: "prompt",
        descriptionParamKey: "description",
        start: {
          // No parametersSchema: coerceTaskParams owns Task's deterministic
          // validation order and pinned message surface (byte caps, control
          // characters), and the preparer reports through it.
          workerTools: [],
          depsKey: "taskDeps",
          prepareRun: (deps, params, ctx) => createTaskRunPreparer(deps as TaskToolDeps)(params, ctx),
        },
      },
      {
        agent: FINDER_TOOL_NAME,
        profileName: "finder",
        toolName: FINDER_TOOL_NAME,
        exposure: ["tool", "background"],
        contractPreset: "degrading-advisory",
        paramsHint: "{query}",
        promptParamKey: "query",
        start: {
          parametersSchema: FINDER_PARAMETERS_SCHEMA,
          workerTools: FINDER_WORKER_TOOLS,
          depsKey: "finderDeps",
          prepareRun: (deps, params, ctx) => createFinderRunPreparer(deps as FinderToolDeps)(params, ctx),
        },
      },
      {
        agent: LIBRARIAN_TOOL_NAME,
        profileName: "librarian",
        toolName: LIBRARIAN_TOOL_NAME,
        exposure: ["tool", "background"],
        contractPreset: "strict-delegated",
        paramsHint: "{query, context?}",
        promptParamKey: "query",
        start: {
          parametersSchema: LIBRARIAN_PARAMETERS_SCHEMA,
          workerTools: LIBRARIAN_WORKER_TOOLS,
          depsKey: "librarianDeps",
          prepareRun: (deps, params, ctx) => createLibrarianRunPreparer(deps as LibrarianToolDeps)(params, ctx),
        },
      },
      {
        agent: REVIEWER_TOOL_NAME,
        profileName: REVIEWER_SUBAGENT_PROFILE,
        toolName: REVIEWER_TOOL_NAME,
        exposure: ["tool", "background"],
        contractPreset: "degrading-advisory",
        paramsHint: "{diff_description, files?, instructions?}",
        promptParamKey: "diff_description",
        start: {
          parametersSchema: REVIEWER_PARAMETERS_SCHEMA,
          workerTools: REVIEWER_WORKER_TOOLS,
          depsKey: "reviewerDeps",
          prepareRun: (deps, params, ctx) => createReviewerRunPreparer(deps as ReviewerToolDeps)(params, ctx),
        },
      },
    ] satisfies MmrBackgroundAgentDescriptor[]
  ).map((descriptor) => [descriptor.profileName, descriptor]),
);

// Dynamic descriptors live on globalThis, mirroring the dynamic subagent
// profile registry, so duplicate module instantiations in one process share
// one table.
const AMPI_DYNAMIC_BACKGROUND_AGENTS_GLOBAL_KEY = "__pi_ampi_dynamic_background_agents_v1__";
const MMR_DYNAMIC_BACKGROUND_AGENTS_GLOBAL_KEY = "__pi_mmr_dynamic_background_agents_v1__";

const globalAgentStore = globalThis as typeof globalThis & {
  [AMPI_DYNAMIC_BACKGROUND_AGENTS_GLOBAL_KEY]?: Map<string, MmrBackgroundAgentDescriptor>;
  [MMR_DYNAMIC_BACKGROUND_AGENTS_GLOBAL_KEY]?: Map<string, MmrBackgroundAgentDescriptor>;
};

function resolveDynamicAgentRegistry(): Map<string, MmrBackgroundAgentDescriptor> {
  const existing = globalAgentStore[AMPI_DYNAMIC_BACKGROUND_AGENTS_GLOBAL_KEY]
    ?? globalAgentStore[MMR_DYNAMIC_BACKGROUND_AGENTS_GLOBAL_KEY];
  if (existing instanceof Map) {
    globalAgentStore[AMPI_DYNAMIC_BACKGROUND_AGENTS_GLOBAL_KEY] = existing;
    globalAgentStore[MMR_DYNAMIC_BACKGROUND_AGENTS_GLOBAL_KEY] = existing;
    return existing;
  }
  const fresh = new Map<string, MmrBackgroundAgentDescriptor>();
  globalAgentStore[AMPI_DYNAMIC_BACKGROUND_AGENTS_GLOBAL_KEY] = fresh;
  globalAgentStore[MMR_DYNAMIC_BACKGROUND_AGENTS_GLOBAL_KEY] = fresh;
  return fresh;
}

/**
 * Register or replace a runtime background-agent descriptor, keyed by its
 * backing profile name. Used by ampi-custom-subagents for custom Markdown
 * subagents. Built-in descriptors cannot be replaced.
 */
export function registerMmrBackgroundAgent(descriptor: MmrBackgroundAgentDescriptor): void {
  if (typeof descriptor.profileName !== "string" || descriptor.profileName.length === 0) {
    throw new Error("registerMmrBackgroundAgent requires a non-empty profileName");
  }
  if (BUILTIN_BACKGROUND_AGENTS.has(descriptor.profileName)) {
    throw new Error(
      `registerMmrBackgroundAgent cannot replace built-in background agent "${descriptor.profileName}"`,
    );
  }
  resolveDynamicAgentRegistry().set(descriptor.profileName, descriptor);
}

/** Remove a runtime descriptor. Intended for tests and profile reloads. */
export function unregisterMmrBackgroundAgent(profileName: string): void {
  resolveDynamicAgentRegistry().delete(profileName);
}

/** Test seam: clear runtime descriptors without touching built-ins. */
export function clearMmrDynamicBackgroundAgents(): void {
  resolveDynamicAgentRegistry().clear();
}

function descriptorForProfile(profileName: string): MmrBackgroundAgentDescriptor | undefined {
  return BUILTIN_BACKGROUND_AGENTS.get(profileName) ?? resolveDynamicAgentRegistry().get(profileName);
}

/**
 * The background agents `start_task` offers, derived from the live profile
 * registry: every registered profile that is backgroundable and has a
 * descriptor. The default agent leads (it heads the public enum and the
 * docs); the rest keep profile-registry order, so the built-in set yields
 * `Task, finder, librarian` and custom subagents append in registration
 * order.
 */
export function listMmrBackgroundAgents(): readonly MmrBackgroundAgentDescriptor[] {
  const ordered: MmrBackgroundAgentDescriptor[] = [];
  for (const profileName of listMmrSubagentProfiles()) {
    const profile = getMmrSubagentProfile(profileName);
    if (!profile || profile.backgroundable === false) continue;
    const descriptor = descriptorForProfile(profileName);
    if (!descriptor) continue;
    if (descriptor.exposure !== undefined && !descriptor.exposure.includes("background")) continue;
    ordered.push(descriptor);
  }
  return Object.freeze([
    ...ordered.filter((descriptor) => descriptor.agent === DEFAULT_MMR_BACKGROUND_AGENT),
    ...ordered.filter((descriptor) => descriptor.agent !== DEFAULT_MMR_BACKGROUND_AGENT),
  ]);
}

/** Resolve one background agent by its public agent name (exact match). */
export function getMmrBackgroundAgent(agent: string): MmrBackgroundAgentDescriptor | undefined {
  return listMmrBackgroundAgents().find((descriptor) => descriptor.agent === agent);
}

/**
 * Normalize a raw `agent` input to a registered agent's public name:
 * `undefined` selects the default agent; strings match the agent name or its
 * backing profile name case-insensitively (so `task` and `task-subagent`
 * both resolve to `Task`). Returns `undefined` for unknown agents.
 */
export function normalizeMmrBackgroundAgentName(raw: unknown): string | undefined {
  if (raw === undefined) return DEFAULT_MMR_BACKGROUND_AGENT;
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase();
  for (const descriptor of listMmrBackgroundAgents()) {
    if (normalized === descriptor.agent.toLowerCase() || normalized === descriptor.profileName.toLowerCase()) {
      return descriptor.agent;
    }
  }
  return undefined;
}
