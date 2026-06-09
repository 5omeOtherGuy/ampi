import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerMmrFeatureGateProvider, registerMmrToolProvider } from "../mmr-core/runtime.js";
import { registerMmrOwnedExtensionPath } from "../mmr-core/owned-tools.js";
import { type RegisterMmrCustomSubagentToolsOptions, countLegacyClaudeSubagentCandidates, registerMmrCustomSubagentTools } from "./custom-runtime.js";
import { resolveEnabledMmrCustomSubagents } from "./custom-config.js";
import { createMmrCustomSubagentsFeatureGateProvider, createMmrCustomSubagentsToolProvider, type MmrCustomSubagentsCapabilities } from "./provider.js";

registerMmrOwnedExtensionPath(fileURLToPath(import.meta.url));

export interface MmrCustomSubagentsFactoryOverrides {
  customSubagents?: RegisterMmrCustomSubagentToolsOptions;
}

export function createMmrCustomSubagentsExtension(overrides: MmrCustomSubagentsFactoryOverrides = {}) {
  return function mmrCustomSubagentsExtension(pi: ExtensionAPI): void {
    const customSubagentTools = registerMmrCustomSubagentTools(pi, overrides.customSubagents ?? {});
    const capabilities: MmrCustomSubagentsCapabilities = {
      customTools: () => customSubagentTools.map((tool) => tool.name),
    };
    registerMmrFeatureGateProvider(createMmrCustomSubagentsFeatureGateProvider(capabilities));
    registerMmrToolProvider(createMmrCustomSubagentsToolProvider(capabilities));

    pi.on("session_start", (_event, ctx) => {
      maybeNotifyLegacyClaudeMigration(ctx);
    });
  };
}

// Per-cwd sentinel so the migration notice / config warnings are surfaced at
// most once per process per project, even if Pi emits several session_start
// events for the same session. In-memory and process-local by design.
const mmrCustomSubagentStartupNotified = new Set<string>();

function maybeNotifyLegacyClaudeMigration(ctx: ExtensionContext): void {
  try {
    if (ctx.hasUI === false) return;
    const key = ctx.cwd;
    if (mmrCustomSubagentStartupNotified.has(key)) return;
    mmrCustomSubagentStartupNotified.add(key);

    const { resolved, warnings } = resolveEnabledMmrCustomSubagents({ cwd: ctx.cwd });
    if (warnings.length > 0) {
      ctx.ui.notify(`Custom subagent config warnings:\n- ${warnings.join("\n- ")}`, "warning");
    }
    if (resolved.length > 0) return;
    if (countLegacyClaudeSubagentCandidates(ctx.cwd) === 0) return;
    ctx.ui.notify(
      "Claude-style agents are no longer auto-loaded by pi-mmr. Run /mmr-config → \"subagent (setup/import custom)\" to review and enable selected agents.",
      "info",
    );
  } catch {
    // Best-effort advisory; never block session start.
  }
}

const mmrCustomSubagentsExtension = createMmrCustomSubagentsExtension();

export default mmrCustomSubagentsExtension;
