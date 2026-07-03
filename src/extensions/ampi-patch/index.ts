import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAmpiOwnedExtensionPath, registerAmpiOwnedTool } from "../ampi-core/owned-tools.js";

// Pi stamps every tool registered through `pi.registerTool` with the
// `sourceInfo.path` of the extension entrypoint that called it. Recording
// our entrypoint path here lets `ampi-core` Free mode confirm ownership of
// active registrations by source, not just by name, so a third-party
// extension that later re-registers `apply_patch` would be preserved.
registerAmpiOwnedExtensionPath(fileURLToPath(import.meta.url));
import { registerMmrToolProvider } from "../ampi-core/runtime.js";
import type { MmrToolProvider, MmrToolRule } from "../ampi-core/types.js";
import { createApplyPatchTool } from "./apply-patch-tool.js";
export {
  APPLY_PATCH_DESCRIPTION,
  APPLY_PATCH_PARAMS,
  APPLY_PATCH_PROMPT_GUIDELINES,
  APPLY_PATCH_PROMPT_SNIPPET,
  unifiedDiffToEditRenderableDiff,
} from "./apply-patch-tool.js";

/**
 * Shipped ampi-patch tools.
 *
 * Tracks the concrete Pi tool names this extension registers so the tool
 * provider can claim ownership through `{ kind: "active" }`. The exact
 * names also appear in ampi-core's status catalog so `/ampi-status` credits
 * `ampi-patch` for them even when extension entrypoints load with isolated
 * module caches and the provider call cannot reach ampi-core's registry.
 *
 * Tracking the supported names as a `Set<string>` instead of a plain
 * object avoids prototype-chain leaks (`constructor`, `toString`, ...) and
 * keeps the literal types tight.
 */
const PATCH_SHIPPED_TOOL_NAMES = ["apply_patch"] as const;
type PatchShippedTool = (typeof PATCH_SHIPPED_TOOL_NAMES)[number];
// Widened deliberately: the Set seed remains typed as PatchShippedTool (so
// typos in PATCH_SHIPPED_TOOL_NAMES are caught), but provider.resolve
// accepts an arbitrary string and TS rejects Set<"apply_patch">.has(string).
const PATCH_LOGICAL_TOOL_SET: ReadonlySet<string> = new Set<PatchShippedTool>(
  PATCH_SHIPPED_TOOL_NAMES,
);

const PATCH_PROVIDER_NAME = "ampi-patch";

function createPatchProvider(): MmrToolProvider {
  return {
    name: PATCH_PROVIDER_NAME,
    resolve(toolName): MmrToolRule | undefined {
      if (!PATCH_LOGICAL_TOOL_SET.has(toolName)) return undefined;
      // ampi-patch registers its owned tool as a concrete Pi tool with the
      // same name. Claim ownership; the registry confirms by identity
      // match against the live Pi inventory.
      return { kind: "active" };
    },
  };
}

/**
 * Register ampi-patch tool providers on a tool registry. Exported so tests
 * (and future consumers building isolated registries) can wire the provider
 * into a fresh `MmrToolRegistry` without touching the runtime singleton.
 */
export function registerMmrPatchProviders(registry: { registerProvider(provider: MmrToolProvider): void }): void {
  registry.registerProvider(createPatchProvider());
}

export const registerAmpiPatchProviders = registerMmrPatchProviders;

export default function ampiPatchExtension(pi: ExtensionAPI): void {
  // Mark apply_patch as ampi-owned before registering it with Pi so the
  // free-mode baseline can drop it.
  registerAmpiOwnedTool("apply_patch");
  pi.registerTool(createApplyPatchTool());

  // Claim ownership of the apply_patch tool on ampi-core's tool registry so
  // /ampi-status credits this extension as owner. Identity resolution against
  // the live Pi inventory still decides activity; the catalog in ampi-core
  // covers cache-isolated loads where this provider call cannot reach the
  // central registry.
  registerMmrToolProvider(createPatchProvider());
}
