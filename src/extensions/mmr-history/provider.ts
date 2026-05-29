import type { MmrFeatureGateProvider, MmrToolProvider, MmrToolRule } from "../mmr-core/types.js";
import type { MmrHistorySettings } from "./config.js";

export const MMR_HISTORY_PROVIDER_NAME = "mmr-history";
export const MMR_HISTORY_FEATURE_GATE = "mmr-history";

const OWNED_LOGICAL_TOOLS = new Set(["read_session", "find_session"]);

export function createMmrHistoryFeatureGateProvider(getSettings: () => MmrHistorySettings): MmrFeatureGateProvider {
  return {
    name: MMR_HISTORY_PROVIDER_NAME,
    evaluate(gate) {
      if (gate !== MMR_HISTORY_FEATURE_GATE) return undefined;
      const settings = getSettings();
      if (!settings.enabled) {
        return {
          gate,
          status: "disabled",
          reason: "mmr-history session access is disabled (set MMR_HISTORY_ENABLE=true to enable global local Pi session lookup).",
        };
      }
      return {
        gate,
        status: "enabled",
        reason: "mmr-history global local Pi session lookup is enabled; read_session uses the model-backed history-reader with redacted packets and lexical fallback.",
      };
    },
  };
}

export function createMmrHistoryToolProvider(getSettings: () => MmrHistorySettings): MmrToolProvider {
  return {
    name: MMR_HISTORY_PROVIDER_NAME,
    resolve(toolName): MmrToolRule | undefined {
      if (!OWNED_LOGICAL_TOOLS.has(toolName)) return undefined;
      const settings = getSettings();
      if (!settings.enabled) {
        return {
          kind: "gated",
          gate: MMR_HISTORY_FEATURE_GATE,
          reason: "session-history tools are disabled; set MMR_HISTORY_ENABLE=true to enable global local Pi session lookup.",
        };
      }
      // Enabled: claim ownership and let the registry confirm by identity
      // match against the live Pi inventory.
      return { kind: "active" };
    },
  };
}
