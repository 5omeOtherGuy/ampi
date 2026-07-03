import type { MmrFeatureGateProvider, MmrToolProvider, MmrToolRule } from "../ampi-core/types.js";
import type { MmrHistorySettings } from "./config.js";

export const AMPI_HISTORY_PROVIDER_NAME = "ampi-history";
export const AMPI_HISTORY_FEATURE_GATE = "ampi-history";
/** Legacy provider id kept for callers that compare the old string. */
export const MMR_HISTORY_PROVIDER_NAME = "mmr-history";
/** Legacy gate id accepted by the provider while callers migrate. */
export const MMR_HISTORY_FEATURE_GATE = "mmr-history";

const HISTORY_FEATURE_GATES: ReadonlySet<string> = new Set([AMPI_HISTORY_FEATURE_GATE, MMR_HISTORY_FEATURE_GATE]);

const OWNED_LOGICAL_TOOLS = new Set(["read_session", "find_session"]);

export function createMmrHistoryFeatureGateProvider(getSettings: () => MmrHistorySettings): MmrFeatureGateProvider {
  return {
    name: AMPI_HISTORY_PROVIDER_NAME,
    evaluate(gate) {
      if (!HISTORY_FEATURE_GATES.has(gate)) return undefined;
      const settings = getSettings();
      if (!settings.enabled) {
        return {
          gate,
          status: "disabled",
          reason: "ampi-history session access is disabled (set AMPI_HISTORY_ENABLE=true or legacy MMR_HISTORY_ENABLE=true to enable global local Pi session lookup).",
        };
      }
      return {
        gate,
        status: "enabled",
        reason: "ampi-history global local Pi session lookup is enabled; read_session uses the model-backed history-reader (tool calls and results included; content sent raw by default, set AMPI_HISTORY_REDACT=true or legacy MMR_HISTORY_REDACT=true to redact) with a deterministic lexical fallback.",
      };
    },
  };
}

export const createAmpiHistoryFeatureGateProvider = createMmrHistoryFeatureGateProvider;

export function createMmrHistoryToolProvider(getSettings: () => MmrHistorySettings): MmrToolProvider {
  return {
    name: AMPI_HISTORY_PROVIDER_NAME,
    resolve(toolName): MmrToolRule | undefined {
      if (!OWNED_LOGICAL_TOOLS.has(toolName)) return undefined;
      const settings = getSettings();
      if (!settings.enabled) {
        return {
          kind: "gated",
          gate: AMPI_HISTORY_FEATURE_GATE,
          reason: "session-history tools are disabled; set AMPI_HISTORY_ENABLE=true or legacy MMR_HISTORY_ENABLE=true to enable global local Pi session lookup.",
        };
      }
      // Enabled: claim ownership and let the registry confirm by identity
      // match against the live Pi inventory.
      return { kind: "active" };
    },
  };
}

export const createAmpiHistoryToolProvider = createMmrHistoryToolProvider;
