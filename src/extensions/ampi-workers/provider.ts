import type { MmrFeatureGateProvider, MmrToolProvider, MmrToolRule } from "../ampi-core/types.js";
import { LIBRARIAN_GATING_REASON } from "./librarian.js";

export const AMPI_SUBAGENTS_PROVIDER_NAME = "ampi-subagents";
export const AMPI_SUBAGENTS_FEATURE_GATE = "ampi-subagents";
/** Legacy provider id kept for callers that compare the old string. */
export const MMR_SUBAGENTS_PROVIDER_NAME = "mmr-subagents";
/** Legacy gate id accepted by the provider while callers migrate. */
export const MMR_SUBAGENTS_FEATURE_GATE = "mmr-subagents";

const SUBAGENT_FEATURE_GATES: ReadonlySet<string> = new Set([
  AMPI_SUBAGENTS_FEATURE_GATE,
  MMR_SUBAGENTS_FEATURE_GATE,
]);

/**
 * Logical tool names owned by the ampi-subagents compatibility surface.
 * Mirrors the deferred entries in `ampi-core`'s default tool rules so the
 * runtime override stays narrow: the provider returns `undefined` for any
 * other logical name and never shadows unrelated providers.
 */
export const MMR_SUBAGENTS_OWNED_TOOLS: ReadonlyArray<
  | "Task"
  | "finder"
  | "oracle"
  | "librarian"
  | "reviewer"
> = [
  "Task",
  "finder",
  "oracle",
  "librarian",
  "reviewer",
];
export const AMPI_SUBAGENTS_OWNED_TOOLS = MMR_SUBAGENTS_OWNED_TOOLS;

const OWNED_TOOLS_SET: ReadonlySet<string> = new Set<string>(MMR_SUBAGENTS_OWNED_TOOLS);

/**
 * Per-tool ship state. Each entry is `true` when the matching concrete Pi
 * tool is registered by this extension; the provider then claims the
 * name with `{ kind: "active" }` so the registry credits ampi-subagents
 * as owner and confirms by identity match against the live Pi inventory.
 * The default value of every flag is `false`, which preserves the
 * shell-slice behavior for callers that build the providers without
 * arguments (every owned tool reports `gated`).
 */
type MmrSubagentsCapability = boolean | (() => boolean);

export interface MmrSubagentsCapabilities {
  finder?: MmrSubagentsCapability;
  oracle?: MmrSubagentsCapability;
  Task?: MmrSubagentsCapability;
  librarian?: MmrSubagentsCapability;
  reviewer?: MmrSubagentsCapability;
}

function readCapability(value: MmrSubagentsCapability | undefined): boolean {
  if (typeof value === "function") {
    try {
      return Boolean(value());
    } catch {
      return false;
    }
  }
  return Boolean(value);
}

function isCapabilityActive(capabilities: MmrSubagentsCapabilities, name: string): boolean {
  switch (name) {
    case "finder":
      return readCapability(capabilities.finder);
    case "oracle":
      return readCapability(capabilities.oracle);
    case "Task":
      return readCapability(capabilities.Task);
    case "librarian":
      return readCapability(capabilities.librarian);
    case "reviewer":
      return readCapability(capabilities.reviewer);
    default:
      return false;
  }
}

function formatActiveCapabilities(capabilities: MmrSubagentsCapabilities): string {
  const active: string[] = MMR_SUBAGENTS_OWNED_TOOLS.filter((name) => isCapabilityActive(capabilities, name));
  return active.length === 0 ? "" : active.join(", ");
}

/**
 * Feature-gate provider for `ampi-subagents` and legacy `mmr-subagents`.
 *
 * Returns `enabled` when at least one owned worker tool has shipped (per
 * the `capabilities` argument); otherwise reports `disabled` with the
 * shell-slice reason. Default-args callers get the shell behavior so the
 * provider works the same way for tests that exercise an empty extension.
 */
export function createMmrSubagentsFeatureGateProvider(
  capabilities: MmrSubagentsCapabilities = {},
): MmrFeatureGateProvider {
  return {
    name: AMPI_SUBAGENTS_PROVIDER_NAME,
    evaluate(gate) {
      if (!SUBAGENT_FEATURE_GATES.has(gate)) return undefined;
      const active = formatActiveCapabilities(capabilities);
      if (active.length === 0) {
        return {
          gate,
          status: "disabled",
          reason: "ampi-subagents compatibility surface is loaded; worker tools are not yet implemented.",
        };
      }
      return {
        gate,
        status: "enabled",
        reason: `ampi-subagents worker tools available: ${active}.`,
      };
    },
  };
}

export const createAmpiSubagentsFeatureGateProvider = createMmrSubagentsFeatureGateProvider;

/**
 * Tool provider for `ampi-subagents` and legacy `mmr-subagents`.
 *
 * For every owned tool, the rule returned depends on whether the matching
 * capability is active. Active capabilities defer to identity-match
 * resolution against Pi's live tool inventory (the ampi-core status
 * catalog credits ampi-subagents as the owner); inactive capabilities
 * return `gated` against `ampi-subagents` with a per-tool reason.
 * `librarian` is active only while its required ampi-github-owned tools are
 * registered; execute-time checks still fail closed if those tools are not
 * currently active in the parent process. Future repository-provider variants
 * can add their own provider rules.
 */
export function createMmrSubagentsToolProvider(
  capabilities: MmrSubagentsCapabilities = {},
): MmrToolProvider {
  return {
    name: AMPI_SUBAGENTS_PROVIDER_NAME,
    resolve(toolName): MmrToolRule | undefined {
      if (!OWNED_TOOLS_SET.has(toolName)) return undefined;
      if (isCapabilityActive(capabilities, toolName)) {
        return { kind: "active" };
      }
      return {
        kind: "gated",
        gate: AMPI_SUBAGENTS_FEATURE_GATE,
        reason: toolName === "librarian"
          ? LIBRARIAN_GATING_REASON
          : `${toolName}: implementation pending in ampi-subagents.`,
      };
    },
  };
}

export const createAmpiSubagentsToolProvider = createMmrSubagentsToolProvider;


// ---------------------------------------------------------------------------
// ampi-async-tasks compatibility surface (the extension is merged into
// ampi-workers; legacy names remain for callers that compose providers
// manually and for the legacy feature-gate ids).
// ---------------------------------------------------------------------------

export const AMPI_ASYNC_TASKS_PROVIDER_NAME = "ampi-async-tasks";
export const AMPI_ASYNC_TASKS_FEATURE_GATE = "ampi-async-tasks";
/** Legacy provider id kept for callers that compare the old string. */
export const MMR_ASYNC_TASKS_PROVIDER_NAME = "mmr-async-tasks";
/** Legacy gate id accepted by the provider while callers migrate. */
export const MMR_ASYNC_TASKS_FEATURE_GATE = "mmr-async-tasks";
export const AMPI_SUBAGENTS_ASYNC_TASKS_FEATURE_GATE = "ampi-subagents.async-tasks";
/** Deprecated compatibility gate retained while callers migrate. */
export const MMR_SUBAGENTS_ASYNC_TASKS_FEATURE_GATE = "mmr-subagents.async-tasks";

const ASYNC_TASK_FEATURE_GATES: ReadonlySet<string> = new Set([
  AMPI_ASYNC_TASKS_FEATURE_GATE,
  AMPI_SUBAGENTS_ASYNC_TASKS_FEATURE_GATE,
  MMR_ASYNC_TASKS_FEATURE_GATE,
  MMR_SUBAGENTS_ASYNC_TASKS_FEATURE_GATE,
]);

export const MMR_ASYNC_TASK_TOOLS: ReadonlyArray<
  "start_task" | "task_poll" | "task_wait" | "task_cancel"
> = ["start_task", "task_poll", "task_wait", "task_cancel"];
export const AMPI_ASYNC_TASK_TOOLS = MMR_ASYNC_TASK_TOOLS;

/** @deprecated Use AMPI_ASYNC_TASK_TOOLS. */
export const MMR_SUBAGENTS_ASYNC_TASK_TOOLS = MMR_ASYNC_TASK_TOOLS;

const ASYNC_TASK_TOOLS_SET: ReadonlySet<string> = new Set<string>(MMR_ASYNC_TASK_TOOLS);

type MmrAsyncTasksCapability = boolean | (() => boolean);

export interface MmrAsyncTasksCapabilities {
  asyncTasks?: MmrAsyncTasksCapability;
}

function readAsyncCapability(value: MmrAsyncTasksCapability | undefined): boolean {
  if (typeof value === "function") {
    try {
      return Boolean(value());
    } catch {
      return false;
    }
  }
  return Boolean(value);
}

export function createMmrAsyncTasksFeatureGateProvider(
  capabilities: MmrAsyncTasksCapabilities = {},
): MmrFeatureGateProvider {
  return {
    name: AMPI_ASYNC_TASKS_PROVIDER_NAME,
    evaluate(gate) {
      if (!ASYNC_TASK_FEATURE_GATES.has(gate)) return undefined;
      const enabled = readAsyncCapability(capabilities.asyncTasks);
      return enabled
        ? {
            gate,
            status: "enabled",
            reason: `${AMPI_ASYNC_TASKS_PROVIDER_NAME} background task tools available: ${MMR_ASYNC_TASK_TOOLS.join(", ")}.`,
          }
        : {
            gate,
            status: "disabled",
            reason: `${AMPI_ASYNC_TASKS_PROVIDER_NAME} background task tools are not enabled.`,
          };
    },
  };
}

export const createAmpiAsyncTasksFeatureGateProvider = createMmrAsyncTasksFeatureGateProvider;

export function createMmrAsyncTasksToolProvider(
  capabilities: MmrAsyncTasksCapabilities = {},
): MmrToolProvider {
  return {
    name: AMPI_ASYNC_TASKS_PROVIDER_NAME,
    resolve(toolName): MmrToolRule | undefined {
      if (!ASYNC_TASK_TOOLS_SET.has(toolName)) return undefined;
      if (readAsyncCapability(capabilities.asyncTasks)) return { kind: "active" };
      return {
        kind: "gated",
        gate: AMPI_ASYNC_TASKS_FEATURE_GATE,
        reason: `${toolName}: async background task tools are not enabled.`,
      };
    },
  };
}

export const createAmpiAsyncTasksToolProvider = createMmrAsyncTasksToolProvider;

// ---------------------------------------------------------------------------
// Unified ampi-workers provider: ONE feature gate (with the legacy ids kept
// as accepted aliases) and ONE tool provider covering the whole worker
// surface — blocking tools and the background task tools.
// ---------------------------------------------------------------------------

export const AMPI_WORKERS_PROVIDER_NAME = "ampi-workers";
export const AMPI_WORKERS_FEATURE_GATE = "ampi-workers";
/** Legacy provider id kept for callers that compare the old string. */
export const MMR_WORKERS_PROVIDER_NAME = "mmr-workers";
/** Legacy gate id accepted by the provider while callers migrate. */
export const MMR_WORKERS_FEATURE_GATE = "mmr-workers";

/**
 * Legacy gate ids the unified provider keeps answering for, so settings,
 * docs, or callers still querying the pre-merge gates keep working.
 */
export const MMR_WORKERS_LEGACY_FEATURE_GATES: readonly string[] = [
  AMPI_SUBAGENTS_FEATURE_GATE,
  AMPI_ASYNC_TASKS_FEATURE_GATE,
  AMPI_SUBAGENTS_ASYNC_TASKS_FEATURE_GATE,
  MMR_WORKERS_FEATURE_GATE,
  MMR_SUBAGENTS_FEATURE_GATE,
  MMR_ASYNC_TASKS_FEATURE_GATE,
  MMR_SUBAGENTS_ASYNC_TASKS_FEATURE_GATE,
];
export const AMPI_WORKERS_LEGACY_FEATURE_GATES = MMR_WORKERS_LEGACY_FEATURE_GATES;

export const MMR_WORKERS_OWNED_TOOLS: readonly string[] = [
  ...MMR_SUBAGENTS_OWNED_TOOLS,
  ...MMR_ASYNC_TASK_TOOLS,
];
export const AMPI_WORKERS_OWNED_TOOLS = MMR_WORKERS_OWNED_TOOLS;

/** Capabilities for the merged extension: the blocking workers plus the background surface. */
export interface MmrWorkersCapabilities extends MmrSubagentsCapabilities, MmrAsyncTasksCapabilities {}

const WORKERS_GATES_SET: ReadonlySet<string> = new Set<string>([
  AMPI_WORKERS_FEATURE_GATE,
  ...MMR_WORKERS_LEGACY_FEATURE_GATES,
]);

/**
 * Feature-gate provider for the merged `ampi-workers` extension. Answers the
 * unified `ampi-workers` gate and every legacy id with one status derived
 * from the merged capability set.
 */
export function createMmrWorkersFeatureGateProvider(
  capabilities: MmrWorkersCapabilities = {},
): MmrFeatureGateProvider {
  return {
    name: AMPI_WORKERS_PROVIDER_NAME,
    evaluate(gate) {
      if (!WORKERS_GATES_SET.has(gate)) return undefined;
      const activeWorkers = formatActiveCapabilities(capabilities);
      const asyncActive = readAsyncCapability(capabilities.asyncTasks);
      const active = [
        ...(activeWorkers.length > 0 ? [activeWorkers] : []),
        ...(asyncActive ? [MMR_ASYNC_TASK_TOOLS.join(", ")] : []),
      ].join(", ");
      if (active.length === 0) {
        return {
          gate,
          status: "disabled",
          reason: "ampi-workers is loaded; worker tools are not yet implemented.",
        };
      }
      return {
        gate,
        status: "enabled",
        reason: `ampi-workers worker tools available: ${active}.`,
      };
    },
  };
}

export const createAmpiWorkersFeatureGateProvider = createMmrWorkersFeatureGateProvider;

/**
 * Tool provider for the merged `ampi-workers` extension: one rule source for
 * the blocking worker tools and the background task tools.
 */
export function createMmrWorkersToolProvider(
  capabilities: MmrWorkersCapabilities = {},
): MmrToolProvider {
  const subagents = createMmrSubagentsToolProvider(capabilities);
  const asyncTasks = createMmrAsyncTasksToolProvider(capabilities);
  return {
    name: AMPI_WORKERS_PROVIDER_NAME,
    resolve(toolName): MmrToolRule | undefined {
      return subagents.resolve(toolName) ?? asyncTasks.resolve(toolName);
    },
  };
}

export const createAmpiWorkersToolProvider = createMmrWorkersToolProvider;
