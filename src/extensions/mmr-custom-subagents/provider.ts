import type { MmrFeatureGateProvider, MmrToolProvider, MmrToolRule } from "../mmr-core/types.js";
import { MMR_CUSTOM_SUBAGENT_TOOL_PREFIX } from "./custom-loader.js";

export const MMR_CUSTOM_SUBAGENTS_PROVIDER_NAME = "mmr-custom-subagents";
export const MMR_CUSTOM_SUBAGENTS_FEATURE_GATE = "mmr-custom-subagents";

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
    name: MMR_CUSTOM_SUBAGENTS_PROVIDER_NAME,
    evaluate(gate) {
      if (gate !== MMR_CUSTOM_SUBAGENTS_FEATURE_GATE) return undefined;
      const tools = readCustomTools(capabilities);
      return tools.length > 0
        ? {
            gate,
            status: "enabled",
            reason: `${MMR_CUSTOM_SUBAGENTS_PROVIDER_NAME} custom Markdown subagents available: ${tools.join(", ")}.`,
          }
        : {
            gate,
            status: "disabled",
            reason: `${MMR_CUSTOM_SUBAGENTS_PROVIDER_NAME} is loaded; no enabled custom Markdown subagents are in scope.`,
          };
    },
  };
}

export function createMmrCustomSubagentsToolProvider(
  capabilities: MmrCustomSubagentsCapabilities = {},
): MmrToolProvider {
  return {
    name: MMR_CUSTOM_SUBAGENTS_PROVIDER_NAME,
    resolve(toolName): MmrToolRule | undefined {
      if (!toolName.startsWith(MMR_CUSTOM_SUBAGENT_TOOL_PREFIX)) return undefined;
      return readCustomTools(capabilities).includes(toolName) ? { kind: "active" } : undefined;
    },
  };
}
