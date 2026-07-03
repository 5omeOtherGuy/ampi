import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAmpiOwnedExtensionPath } from "../ampi-core/owned-tools.js";

// Pi stamps every tool registered through `pi.registerTool` with the
// `sourceInfo.path` of the extension entrypoint that called it. Recording
// our entrypoint path here lets `ampi-core` Free mode confirm ownership of
// active registrations by source, not just by name, so a third-party
// extension that later re-registers `task_list` would be preserved.
registerAmpiOwnedExtensionPath(fileURLToPath(import.meta.url));
import { registerMmrToolProvider } from "../ampi-core/runtime.js";
import type { MmrToolProvider, MmrToolRule } from "../ampi-core/types.js";
import { registerTaskListWiring } from "./task-list-wiring.js";

/**
 * Shipped ampi-tasks tools.
 *
 * Tracks the concrete Pi tool names this extension registers so the tool
 * provider can claim ownership through `{ kind: "active" }`. The exact
 * names also appear in ampi-core's status catalog so `/ampi-status` credits
 * `ampi-tasks` for them even when extension entrypoints load with isolated
 * module caches and the provider call cannot reach ampi-core's registry.
 *
 * Other catalog entries owned by ampi-tasks (for example `chart`) are
 * intentionally omitted from this set: those tools have not shipped yet, so
 * the provider does not claim them and they stay `deferred` against the
 * catalog owner.
 *
 * Tracking the supported names as a `Set<string>` instead of a plain object
 * avoids prototype-chain leaks (`constructor`, `toString`, ...) and keeps
 * the literal types tight.
 */
const TASKS_SHIPPED_TOOL_NAMES = ["task_list"] as const;
type TasksShippedTool = (typeof TASKS_SHIPPED_TOOL_NAMES)[number];
// Widened deliberately: the Set seed remains typed as TasksShippedTool (so
// typos in TASKS_SHIPPED_TOOL_NAMES are caught), but provider.resolve
// accepts an arbitrary string and TS rejects Set<"task_list">.has(string).
const TASKS_LOGICAL_TOOL_SET: ReadonlySet<string> = new Set<TasksShippedTool>(
  TASKS_SHIPPED_TOOL_NAMES,
);

const TASKS_PROVIDER_NAME = "ampi-tasks";

function createTasksProvider(): MmrToolProvider {
  return {
    name: TASKS_PROVIDER_NAME,
    resolve(toolName): MmrToolRule | undefined {
      if (!TASKS_LOGICAL_TOOL_SET.has(toolName)) return undefined;
      // ampi-tasks registers its owned tool as a concrete Pi tool with the
      // same name. Claim ownership; the registry confirms by identity match
      // against the live Pi inventory.
      return { kind: "active" };
    },
  };
}

/**
 * Register ampi-tasks tool providers on a tool registry. Exported so tests
 * (and future consumers building isolated registries) can wire the provider
 * into a fresh `MmrToolRegistry` without touching the runtime singleton.
 */
export function registerMmrTasksProviders(registry: { registerProvider(provider: MmrToolProvider): void }): void {
  registry.registerProvider(createTasksProvider());
}

export const registerAmpiTasksProviders = registerMmrTasksProviders;

export default function ampiTasksExtension(pi: ExtensionAPI): void {
  // Task-list wiring marks task_list as ampi-owned before registering its
  // tool, so the free-mode baseline can drop it.
  registerTaskListWiring(pi);

  // Claim ownership of the task_list tool on ampi-core's tool registry so
  // /ampi-status credits this extension as owner. Identity resolution against
  // the live Pi inventory still decides activity; the catalog in ampi-core
  // covers cache-isolated loads where this provider call cannot reach the
  // central registry.
  registerMmrToolProvider(createTasksProvider());
}
