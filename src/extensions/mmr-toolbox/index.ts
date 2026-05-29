import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMmrOwnedExtensionPath, registerMmrOwnedTool } from "../mmr-core/owned-tools.js";

// Pi stamps every tool registered through `pi.registerTool` with the
// `sourceInfo.path` of the extension entrypoint that called it. Recording
// our entrypoint path here lets `mmr-core` Free mode confirm ownership of
// active registrations by source, not just by name, so a third-party
// extension that later re-registers `apply_patch` would be preserved.
registerMmrOwnedExtensionPath(fileURLToPath(import.meta.url));
import { registerMmrToolProvider } from "../mmr-core/runtime.js";
import type { MmrToolProvider, MmrToolRule } from "../mmr-core/types.js";
import { createApplyPatchTool } from "./apply-patch-tool.js";
export {
  APPLY_PATCH_DESCRIPTION,
  APPLY_PATCH_PARAMS,
  APPLY_PATCH_PROMPT_GUIDELINES,
  APPLY_PATCH_PROMPT_SNIPPET,
  unifiedDiffToEditRenderableDiff,
} from "./apply-patch-tool.js";
import { registerTaskListWiring } from "./task-list-wiring.js";

/**
 * Shipped mmr-toolbox tools.
 *
 * Tracks the concrete Pi tool names this extension registers so the tool
 * provider can claim ownership through `{ kind: "active" }`. The exact
 * names also appear in mmr-core's status catalog so `/mmr-status` credits
 * `mmr-toolbox` for them even when extension entrypoints load with
 * isolated module caches and the provider call cannot reach mmr-core's
 * registry.
 *
 * Other catalog entries owned by mmr-toolbox (for example `chart`) are
 * intentionally omitted from this set: those tools have not shipped yet,
 * so the provider does not claim them and they stay `deferred` against
 * the catalog owner.
 *
 * Tracking the supported names as a `Set<string>` instead of a plain
 * object avoids prototype-chain leaks (`constructor`, `toString`, ...) and
 * keeps the literal types tight.
 */
const TOOLBOX_SHIPPED_TOOL_NAMES = ["apply_patch", "task_list"] as const;
type ToolboxShippedTool = (typeof TOOLBOX_SHIPPED_TOOL_NAMES)[number];
// Widened deliberately: the Set seed remains typed as ToolboxShippedTool
// (so typos in TOOLBOX_SHIPPED_TOOL_NAMES are caught), but provider.resolve
// accepts an arbitrary string and TS rejects Set<"apply_patch">.has(string).
const TOOLBOX_LOGICAL_TOOL_SET: ReadonlySet<string> = new Set<ToolboxShippedTool>(
  TOOLBOX_SHIPPED_TOOL_NAMES,
);

const TOOLBOX_PROVIDER_NAME = "mmr-toolbox";

function createToolboxProvider(): MmrToolProvider {
  return {
    name: TOOLBOX_PROVIDER_NAME,
    resolve(toolName): MmrToolRule | undefined {
      if (!TOOLBOX_LOGICAL_TOOL_SET.has(toolName)) return undefined;
      // mmr-toolbox registers each owned tool as a concrete Pi tool with
      // the same name. Claim ownership; the registry confirms by identity
      // match against the live Pi inventory.
      return { kind: "active" };
    },
  };
}

/**
 * Register mmr-toolbox tool providers on a tool registry. Exported so tests
 * (and future consumers building isolated registries) can wire the provider
 * into a fresh `MmrToolRegistry` without touching the runtime singleton.
 */
export function registerMmrToolboxProviders(registry: { registerProvider(provider: MmrToolProvider): void }): void {
  registry.registerProvider(createToolboxProvider());
}

export default function mmrToolboxExtension(pi: ExtensionAPI): void {
  // Mark apply_patch as MMR-owned before registering it with Pi so the
  // free-mode baseline can drop it. Task-list wiring marks task_list the
  // same way before registering its tool.
  registerMmrOwnedTool("apply_patch");
  pi.registerTool(createApplyPatchTool());
  registerTaskListWiring(pi);

  // Claim ownership of mmr-toolbox tools on mmr-core's tool registry so
  // /mmr-status credits this extension as owner. Identity resolution
  // against the live Pi inventory still decides activity; the catalog in
  // mmr-core covers cache-isolated loads where this provider call cannot
  // reach the central registry.
  registerMmrToolProvider(createToolboxProvider());
}
