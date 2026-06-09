import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMmrOwnedExtensionPath } from "../mmr-core/owned-tools.js";
import { registerMmrConfigFlowSection } from "../mmr-core/config-flow-registry.js";
import { registerMmrFeatureGateProvider, registerMmrToolProvider } from "../mmr-core/runtime.js";
import { loadMmrWebSettings, type MmrWebSettings } from "./config.js";
import { runMmrWebConfigFlow } from "./config-flow.js";
import { registerMmrWebToolSourcePath } from "./tool-ownership.js";

// Pi stamps every tool registered through `pi.registerTool` with the
// `sourceInfo.path` of the extension entrypoint that called it (this
// file, even for tools registered indirectly through `./tools`).
// Recording our entrypoint path here lets `mmr-core` Free mode and
// `mmr-subagents` librarian gating confirm ownership of `web_search` /
// `read_web_page` by source, not just by name, so a third-party extension
// that later re-registers either name would be preserved.
const MMR_WEB_EXTENSION_ENTRYPOINT_PATH = fileURLToPath(import.meta.url);
registerMmrOwnedExtensionPath(MMR_WEB_EXTENSION_ENTRYPOINT_PATH);
registerMmrWebToolSourcePath(MMR_WEB_EXTENSION_ENTRYPOINT_PATH);

// Own the `web` section of `/mmr-config` by registering it with mmr-core,
// rather than mmr-core importing this flow (inverts the core->sibling import).
registerMmrConfigFlowSection({
  id: "mmr-web",
  label: "web",
  order: 20,
  run: (ctx) => runMmrWebConfigFlow(ctx),
});
import type { BraveClientOptions, DnsLookup } from "./brave.js";
import { createMmrWebFeatureGateProvider, createMmrWebToolProvider } from "./provider.js";
import {
  ensureSearxngSidecarRunning,
  noteSearxngSidecarUse,
  shutdownSearxngSidecar,
  type SidecarSettings,
} from "./search/searxng-sidecar.js";
import { type MmrWebToolDeps, registerMmrWebTools } from "./tools.js";

/**
 * Internal hooks for tests; not part of the public API. Tests can inject a
 * `loadSettings` function to bypass on-disk settings, an alternate `fetch`,
 * and override the Brave Search endpoint without monkey-patching globals.
 *
 * The override may return either a bare `MmrWebSettings` value (most tests)
 * or a `{ settings, warnings }` pair to exercise the initial-warnings drain.
 */
export interface MmrWebFactoryOverrides {
  loadSettings?: (cwd: string) => MmrWebSettings | { settings: MmrWebSettings; warnings?: string[] };
  fetchImpl?: typeof fetch;
  /** Override the Brave web search endpoint. Tests use this to inject a mock URL. */
  braveSearchBase?: string;
  /**
   * Override DNS lookup used by the Brave reader fallback to enforce
   * private-address rejection. Tests inject a deterministic resolver so
   * suites stay offline.
   */
  lookup?: DnsLookup;
  userAgent?: string;
}

function normalizeOverrideResult(
  result: MmrWebSettings | { settings: MmrWebSettings; warnings?: string[] },
): { settings: MmrWebSettings; warnings: string[] } {
  if ("settings" in result && typeof result.settings === "object") {
    return { settings: result.settings, warnings: [...(result.warnings ?? [])] };
  }
  return { settings: result as MmrWebSettings, warnings: [] };
}

/**
 * Build a Pi extension factory for mmr-web with optional test seams.
 *
 * The default export of this module calls this with no overrides; package
 * code and Pi extension wiring should always use the default export.
 */
export function createMmrWebExtension(overrides: MmrWebFactoryOverrides = {}) {
  return function mmrWebExtension(pi: ExtensionAPI): void {
    const initialCwd = process.cwd();
    const initial = overrides.loadSettings
      ? normalizeOverrideResult(overrides.loadSettings(initialCwd))
      : loadMmrWebSettings(initialCwd);
    // Settings are sampled exactly once at extension load. The Pi tool
    // registry is one-direction (no public `unregisterTool`), so reloading
    // settings mid-process would desync the live `mmr-web` provider gate
    // (which re-evaluates settings on every resolve) from the actually
    // registered Pi tools. Re-enabling/disabling network access requires
    // restarting the Pi process. See src/extensions/mmr-web/README.md.
    const settings: MmrWebSettings = initial.settings;
    const pendingWarnings = [...initial.warnings];

    const sidecarSettings = (): SidecarSettings => ({
      managed: settings.searxngManaged,
      startCommand: settings.searxngStartCommand,
      stopCommand: settings.searxngStopCommand,
      url: settings.searxngUrl,
      healthUrl: settings.searxngHealthUrl,
      idleTimeoutMs: settings.searxngIdleTimeoutMs,
      startTimeoutMs: settings.searxngStartTimeoutMs,
    });

    const deps: MmrWebToolDeps = {
      getSettings: () => settings,
      getBraveOptions: (): BraveClientOptions & {
        searxngEnsureRunning?: () => Promise<void>;
        searxngNoteUse?: () => void;
      } => {
        const base: BraveClientOptions = {
          apiKey: settings.braveApiKey,
          fetchImpl: overrides.fetchImpl,
          searchBase: overrides.braveSearchBase,
          userAgent: overrides.userAgent,
          lookup: overrides.lookup,
        };
        // Only attach sidecar hooks when the user opted in. Keeps the
        // happy path identical for users who never enable the sidecar.
        if (settings.searxngManaged) {
          return {
            ...base,
            searxngEnsureRunning: () => ensureSearxngSidecarRunning(sidecarSettings()),
            searxngNoteUse: () => noteSearxngSidecarUse(),
          };
        }
        return base;
      },
    };

    registerMmrFeatureGateProvider(createMmrWebFeatureGateProvider(deps.getSettings));
    registerMmrToolProvider(createMmrWebToolProvider(deps.getSettings));
    registerMmrWebTools(pi, deps);

    pi.on("session_start", async (_event, ctx) => {
      // Drain any warnings captured during the synchronous initial load.
      // We cannot call `ctx.ui.notify` at extension-factory time because the
      // UI surface is only available once a session has started.
      while (pendingWarnings.length > 0) {
        const warning = pendingWarnings.shift();
        if (warning !== undefined) ctx.ui.notify(warning, "warning");
      }
    });

    pi.on("session_shutdown", async () => {
      // Best-effort: stop any managed SearXNG sidecar this process spawned
      // so we don't leak a daemon across a session swap or quit. On Pi
      // 0.77.0+ this handler also runs on SIGTERM/SIGHUP signal exits, so
      // signal-terminated sessions stop the sidecar too. Errors are
      // swallowed inside shutdownSearxngSidecar; the lifecycle handler
      // must not throw.
      if (settings.searxngManaged) {
        await shutdownSearxngSidecar({ reason: "shutdown" });
      }
    });
  };
}



const mmrWebExtension = createMmrWebExtension();

export default mmrWebExtension;
