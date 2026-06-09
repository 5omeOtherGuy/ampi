import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMmrOwnedExtensionPath } from "../mmr-core/owned-tools.js";
import { registerMmrFeatureGateProvider, registerMmrToolProvider } from "../mmr-core/runtime.js";
import { loadMmrHistorySettings, type MmrHistorySettings } from "./config.js";
import { createMmrHistoryFeatureGateProvider, createMmrHistoryToolProvider } from "./provider.js";
import { createDefaultMmrHistoryToolDeps, registerMmrHistoryTools, type MmrHistoryToolDeps } from "./tools.js";

registerMmrOwnedExtensionPath(fileURLToPath(import.meta.url));

export interface MmrHistoryFactoryOverrides {
  loadSettings?: () => MmrHistorySettings;
  deps?: (getSettings: () => MmrHistorySettings) => MmrHistoryToolDeps;
}

export function createMmrHistoryExtension(overrides: MmrHistoryFactoryOverrides = {}) {
  return function mmrHistoryExtension(pi: ExtensionAPI): void {
    const settings = overrides.loadSettings ? overrides.loadSettings() : loadMmrHistorySettings();
    const getSettings = () => settings;
    const deps = overrides.deps ? overrides.deps(getSettings) : createDefaultMmrHistoryToolDeps(getSettings);

    registerMmrFeatureGateProvider(createMmrHistoryFeatureGateProvider(getSettings));
    registerMmrToolProvider(createMmrHistoryToolProvider(getSettings));
    registerMmrHistoryTools(pi, deps);

    pi.on("session_start", async (_event, ctx) => {
      if (!settings.enabled) return undefined;
      ctx.ui.notify(
        "mmr-history enabled: global local Pi session lookup is on; read_session sends a tool-activity-rich packet to the model-backed history-reader subagent (content raw by default; set MMR_HISTORY_REDACT=true to redact) with a deterministic lexical fallback.",
        "info",
      );
      return undefined;
    });
  };
}

const mmrHistoryExtension = createMmrHistoryExtension();

export default mmrHistoryExtension;
