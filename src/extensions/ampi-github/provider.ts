import type { MmrFeatureGateProvider, MmrToolProvider, MmrToolRule } from "../ampi-core/types.js";
import type { MmrGithubSettings } from "./config.js";
import { MMR_GITHUB_TOOL_NAMES } from "./tool-ownership.js";

export const AMPI_GITHUB_PROVIDER_NAME = "ampi-github";
export const AMPI_GITHUB_FEATURE_GATE = "ampi-github";
/** Legacy provider id kept for callers that compare the old string. */
export const MMR_GITHUB_PROVIDER_NAME = "mmr-github";
/** Legacy gate id accepted by the provider while callers migrate. */
export const MMR_GITHUB_FEATURE_GATE = "mmr-github";

const GITHUB_FEATURE_GATES: ReadonlySet<string> = new Set([AMPI_GITHUB_FEATURE_GATE, MMR_GITHUB_FEATURE_GATE]);

const OWNED_TOOLS: ReadonlySet<string> = new Set<string>(MMR_GITHUB_TOOL_NAMES);

/**
 * Feature gate + tool provider for `ampi-github`. When network access is
 * disabled the GitHub tools resolve as `gated` with a shared reason so
 * `/ampi-status` always explains why they are unavailable; when enabled the
 * provider claims ownership of each GitHub tool name and the registry
 * confirms by identity match against the live Pi inventory.
 */
export function createMmrGithubFeatureGateProvider(getSettings: () => MmrGithubSettings): MmrFeatureGateProvider {
  return {
    name: AMPI_GITHUB_PROVIDER_NAME,
    evaluate(gate) {
      if (!GITHUB_FEATURE_GATES.has(gate)) return undefined;
      const settings = getSettings();
      if (!settings.enabled) {
        return {
          gate,
          status: "disabled",
          reason: "ampi-github access is disabled (set AMPI_GITHUB_ENABLE=true or legacy MMR_GITHUB_ENABLE=true to enable read-only GitHub tools).",
        };
      }
      const auth = settings.token ? "authenticated" : "anonymous (set AMPI_GITHUB_TOKEN, legacy MMR_GITHUB_TOKEN, or GITHUB_TOKEN for private repos, code search, and higher limits)";
      return {
        gate,
        status: "enabled",
        reason: `ampi-github access is enabled; requests are ${auth}.`,
      };
    },
  };
}

export const createAmpiGithubFeatureGateProvider = createMmrGithubFeatureGateProvider;

export function createMmrGithubToolProvider(getSettings: () => MmrGithubSettings): MmrToolProvider {
  return {
    name: AMPI_GITHUB_PROVIDER_NAME,
    resolve(toolName): MmrToolRule | undefined {
      if (!OWNED_TOOLS.has(toolName)) return undefined;
      const settings = getSettings();
      if (!settings.enabled) {
        return {
          kind: "gated",
          gate: AMPI_GITHUB_FEATURE_GATE,
          reason: "ampi-github access is disabled (set AMPI_GITHUB_ENABLE=true or legacy MMR_GITHUB_ENABLE=true).",
        };
      }
      return { kind: "active" };
    },
  };
}

export const createAmpiGithubToolProvider = createMmrGithubToolProvider;
