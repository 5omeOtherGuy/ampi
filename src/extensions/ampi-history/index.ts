import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAmpiOwnedExtensionPath } from "../ampi-core/owned-tools.js";
import { registerMmrFeatureGateProvider, registerMmrToolProvider } from "../ampi-core/runtime.js";
import { loadMmrHistorySettings, type MmrHistorySettings } from "./config.js";
import { createMmrHistoryFeatureGateProvider, createMmrHistoryToolProvider } from "./provider.js";
import { registerMmrHistoryPromptBuilders } from "./prompts.js";
import { createDefaultMmrHistoryToolDeps, registerMmrHistoryTools, type MmrHistoryToolDeps } from "./tools.js";

registerAmpiOwnedExtensionPath(fileURLToPath(import.meta.url));

export interface MmrHistoryFactoryOverrides {
  loadSettings?: () => MmrHistorySettings;
  deps?: (getSettings: () => MmrHistorySettings) => MmrHistoryToolDeps;
}

export function createMmrHistoryExtension(overrides: MmrHistoryFactoryOverrides = {}) {
  return function ampiHistoryExtension(pi: ExtensionAPI): void {
    const settings = overrides.loadSettings ? overrides.loadSettings() : loadMmrHistorySettings();
    const getSettings = () => settings;
    const deps = overrides.deps ? overrides.deps(getSettings) : createDefaultMmrHistoryToolDeps(getSettings);

    registerMmrFeatureGateProvider(createMmrHistoryFeatureGateProvider(getSettings));
    registerMmrToolProvider(createMmrHistoryToolProvider(getSettings));
    registerMmrHistoryPromptBuilders();
    registerMmrHistoryTools(pi, deps);

    pi.on("session_start", async (_event, ctx) => {
      if (!settings.enabled) return undefined;
      ctx.ui.notify(
        "ampi-history enabled: global local Pi session lookup is on; read_session sends a tool-activity-rich packet to the model-backed history-reader subagent (content raw by default; set AMPI_HISTORY_REDACT=true or legacy MMR_HISTORY_REDACT=true to redact) with a deterministic lexical fallback.",
        "info",
      );
      return undefined;
    });
  };
}

export const createAmpiHistoryExtension = createMmrHistoryExtension;

const ampiHistoryExtension = createMmrHistoryExtension();

export default ampiHistoryExtension;
