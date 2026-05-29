import type { MmrFeatureGateProvider, MmrToolProvider, MmrToolRule } from "../mmr-core/types.js";
import type { MmrGithubSettings } from "./config.js";
import { MMR_GITHUB_TOOL_NAMES } from "./tool-ownership.js";

export const MMR_GITHUB_PROVIDER_NAME = "mmr-github";
export const MMR_GITHUB_FEATURE_GATE = "mmr-github";

const OWNED_TOOLS: ReadonlySet<string> = new Set<string>(MMR_GITHUB_TOOL_NAMES);

/**
 * Feature gate + tool provider for `mmr-github`. When network access is
 * disabled the GitHub tools resolve as `gated` with a shared reason so
 * `/mmr-status` always explains why they are unavailable; when enabled the
 * provider claims ownership of each GitHub tool name and the registry
 * confirms by identity match against the live Pi inventory.
 */
export function createMmrGithubFeatureGateProvider(getSettings: () => MmrGithubSettings): MmrFeatureGateProvider {
  return {
    name: MMR_GITHUB_PROVIDER_NAME,
    evaluate(gate) {
      if (gate !== MMR_GITHUB_FEATURE_GATE) return undefined;
      const settings = getSettings();
      if (!settings.enabled) {
        return {
          gate,
          status: "disabled",
          reason: "mmr-github access is disabled (set MMR_GITHUB_ENABLE=true to enable read-only GitHub tools).",
        };
      }
      const auth = settings.token ? "authenticated" : "anonymous (set MMR_GITHUB_TOKEN for private repos, code search, and higher limits)";
      return {
        gate,
        status: "enabled",
        reason: `mmr-github access is enabled; requests are ${auth}.`,
      };
    },
  };
}

export function createMmrGithubToolProvider(getSettings: () => MmrGithubSettings): MmrToolProvider {
  return {
    name: MMR_GITHUB_PROVIDER_NAME,
    resolve(toolName): MmrToolRule | undefined {
      if (!OWNED_TOOLS.has(toolName)) return undefined;
      const settings = getSettings();
      if (!settings.enabled) {
        return {
          kind: "gated",
          gate: MMR_GITHUB_FEATURE_GATE,
          reason: "mmr-github access is disabled (set MMR_GITHUB_ENABLE=true).",
        };
      }
      return { kind: "active" };
    },
  };
}
