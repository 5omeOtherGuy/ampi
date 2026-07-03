import type { MmrFeatureGateProvider, MmrToolProvider, MmrToolRule } from "../ampi-core/types.js";
import { MMR_CUSTOM_SUBAGENT_TOOL_PREFIX } from "./custom-loader.js";

export const AMPI_CUSTOM_SUBAGENTS_PROVIDER_NAME = "ampi-custom-subagents";
export const AMPI_CUSTOM_SUBAGENTS_FEATURE_GATE = "ampi-custom-subagents";
/** Legacy provider id kept for callers that compare the old string. */
export const MMR_CUSTOM_SUBAGENTS_PROVIDER_NAME = "mmr-custom-subagents";
/** Legacy gate id accepted by the provider while callers migrate. */
export const MMR_CUSTOM_SUBAGENTS_FEATURE_GATE = "mmr-custom-subagents";

const CUSTOM_SUBAGENT_FEATURE_GATES: ReadonlySet<string> = new Set([
  AMPI_CUSTOM_SUBAGENTS_FEATURE_GATE,
  MMR_CUSTOM_SUBAGENTS_FEATURE_GATE,
]);

type MmrCustomSubagentsCapability = readonly string[] | (() => readonly string[]);

export interface MmrCustomSubagentsCapabilities {
  customTools?: MmrCustomSubagentsCapability;
}

function readCustomTools(capabilities: MmrCustomSubagentsCapabilities): readonly string[] {
  const tools = capabilities.customTools;
  if (typeof tools === "function") {
    try {
      return tools();
    } catch {
      return [];
    }
  }
  return tools ?? [];
}

export function createMmrCustomSubagentsFeatureGateProvider(
  capabilities: MmrCustomSubagentsCapabilities = {},
): MmrFeatureGateProvider {
  return {
    name: AMPI_CUSTOM_SUBAGENTS_PROVIDER_NAME,
    evaluate(gate) {
      if (!CUSTOM_SUBAGENT_FEATURE_GATES.has(gate)) return undefined;
      const tools = readCustomTools(capabilities);
      return tools.length > 0
        ? {
            gate,
            status: "enabled",
            reason: `${AMPI_CUSTOM_SUBAGENTS_PROVIDER_NAME} custom Markdown subagents available: ${tools.join(", ")}.`,
          }
        : {
            gate,
            status: "disabled",
            reason: `${AMPI_CUSTOM_SUBAGENTS_PROVIDER_NAME} is loaded; no enabled custom Markdown subagents are in scope.`,
          };
    },
  };
}

export const createAmpiCustomSubagentsFeatureGateProvider = createMmrCustomSubagentsFeatureGateProvider;

export function createMmrCustomSubagentsToolProvider(
  capabilities: MmrCustomSubagentsCapabilities = {},
): MmrToolProvider {
  return {
    name: AMPI_CUSTOM_SUBAGENTS_PROVIDER_NAME,
    resolve(toolName): MmrToolRule | undefined {
      if (!toolName.startsWith(MMR_CUSTOM_SUBAGENT_TOOL_PREFIX)) return undefined;
      return readCustomTools(capabilities).includes(toolName) ? { kind: "active" } : undefined;
    },
  };
}

export const createAmpiCustomSubagentsToolProvider = createMmrCustomSubagentsToolProvider;
