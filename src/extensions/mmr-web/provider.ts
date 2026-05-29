import type { MmrFeatureGateProvider, MmrToolProvider, MmrToolRule } from "../mmr-core/types.js";
import { resolveBackend, type ResolvedTool } from "./backend.js";
import type { MmrWebSettings } from "./config.js";

export const MMR_WEB_PROVIDER_NAME = "mmr-web";
export const MMR_WEB_FEATURE_GATE = "mmr-web";

const OWNED_LOGICAL_TOOLS: ReadonlySet<ResolvedTool> = new Set<ResolvedTool>([
  "web_search",
  "read_web_page",
]);

/**
 * Tool provider mapping logical `web_search` / `read_web_page` to concrete Pi
 * tools owned by `mmr-web`. Backed by {@link resolveBackend}, so `/mmr-status`
 * always reports a meaningful reason:
 *
 * - Network disabled: both tools resolve as `gated` with a single shared reason.
 * - Network enabled: `web_search` resolves through Brave Search and
 *   `read_web_page` resolves through the custom in-process reader. A missing
 *   `BRAVE_API_KEY` does not hide `web_search`; the tool execution reports the
 *   setup error directly.
 */
export function createMmrWebFeatureGateProvider(getSettings: () => MmrWebSettings): MmrFeatureGateProvider {
  return {
    name: MMR_WEB_PROVIDER_NAME,
    evaluate(gate) {
      if (gate !== MMR_WEB_FEATURE_GATE) return undefined;
      const settings = getSettings();
      if (!settings.enabled) {
        return {
          gate,
          status: "disabled",
          reason: "mmr-web network access is disabled (set MMR_WEB_ENABLE=true to enable).",
        };
      }
      const searchDecision = resolveBackend("web_search", settings);
      const readerDecision = resolveBackend("read_web_page", settings);
      const searchPart = searchDecision.backend
        ? `web_search via ${searchDecision.backend} (${searchDecision.message})`
        : `web_search gated (${searchDecision.message})`;
      const readerPart = readerDecision.backend
        ? `read_web_page via ${readerDecision.backend} (${readerDecision.message})`
        : `read_web_page gated (${readerDecision.message})`;
      return {
        gate,
        status: "enabled",
        reason: `mmr-web network access is enabled; ${searchPart}; ${readerPart}.`,
      };
    },
  };
}

export function createMmrWebToolProvider(getSettings: () => MmrWebSettings): MmrToolProvider {
  return {
    name: MMR_WEB_PROVIDER_NAME,
    resolve(toolName): MmrToolRule | undefined {
      if (!OWNED_LOGICAL_TOOLS.has(toolName as ResolvedTool)) return undefined;
      const settings = getSettings();
      const decision = resolveBackend(toolName as ResolvedTool, settings);
      if (!decision.backend) {
        return {
          kind: "gated",
          gate: MMR_WEB_FEATURE_GATE,
          reason: decision.message,
        };
      }
      // Backend resolves: claim ownership and let the registry confirm by
      // identity match against the live Pi inventory.
      return { kind: "active" };
    },
  };
}
