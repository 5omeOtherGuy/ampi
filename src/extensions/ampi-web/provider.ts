import type { MmrFeatureGateProvider, MmrToolProvider, MmrToolRule } from "../ampi-core/types.js";
import { resolveBackend, type ResolvedTool } from "./backend.js";
import type { MmrWebSettings } from "./config.js";

export const AMPI_WEB_PROVIDER_NAME = "ampi-web";
export const AMPI_WEB_FEATURE_GATE = "ampi-web";
/** Legacy provider id kept for callers that compare the old string. */
export const MMR_WEB_PROVIDER_NAME = "mmr-web";
/** Legacy gate id accepted by the provider while callers migrate. */
export const MMR_WEB_FEATURE_GATE = "mmr-web";

const WEB_FEATURE_GATES: ReadonlySet<string> = new Set([AMPI_WEB_FEATURE_GATE, MMR_WEB_FEATURE_GATE]);

const OWNED_LOGICAL_TOOLS: ReadonlySet<ResolvedTool> = new Set<ResolvedTool>([
  "web_search",
  "read_web_page",
]);

/**
 * Tool provider mapping logical `web_search` / `read_web_page` to concrete Pi
 * tools owned by `ampi-web`. Backed by {@link resolveBackend}, so `/ampi-status`
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
    name: AMPI_WEB_PROVIDER_NAME,
    evaluate(gate) {
      if (!WEB_FEATURE_GATES.has(gate)) return undefined;
      const settings = getSettings();
      if (!settings.enabled) {
        return {
          gate,
          status: "disabled",
          reason: "ampi-web network access is disabled (set AMPI_WEB_ENABLE=true or legacy MMR_WEB_ENABLE=true to enable).",
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
        reason: `ampi-web network access is enabled; ${searchPart}; ${readerPart}.`,
      };
    },
  };
}

export const createAmpiWebFeatureGateProvider = createMmrWebFeatureGateProvider;

export function createMmrWebToolProvider(getSettings: () => MmrWebSettings): MmrToolProvider {
  return {
    name: AMPI_WEB_PROVIDER_NAME,
    resolve(toolName): MmrToolRule | undefined {
      if (!OWNED_LOGICAL_TOOLS.has(toolName as ResolvedTool)) return undefined;
      const settings = getSettings();
      const decision = resolveBackend(toolName as ResolvedTool, settings);
      if (!decision.backend) {
        return {
          kind: "gated",
          gate: AMPI_WEB_FEATURE_GATE,
          reason: decision.message,
        };
      }
      // Backend resolves: claim ownership and let the registry confirm by
      // identity match against the live Pi inventory.
      return { kind: "active" };
    },
  };
}

export const createAmpiWebToolProvider = createMmrWebToolProvider;
