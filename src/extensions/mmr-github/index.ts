import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMmrOwnedExtensionPath } from "../mmr-core/owned-tools.js";
import { registerMmrFeatureGateProvider, registerMmrToolProvider } from "../mmr-core/runtime.js";
import { loadMmrGithubSettings, type MmrGithubSettings } from "./config.js";
import { createMmrGithubFeatureGateProvider, createMmrGithubToolProvider } from "./provider.js";
import { registerMmrGithubToolSourcePath } from "./tool-ownership.js";
import { type MmrGithubToolDeps, registerMmrGithubTools } from "./tools.js";

// Pi stamps every tool registered through `pi.registerTool` with the
// `sourceInfo.path` of the extension entrypoint that called it. Recording our
// entrypoint path here lets `mmr-core` Free mode and `mmr-subagents` librarian
// gating confirm ownership of the GitHub tool names by source path, not just
// by name, so a third-party extension that later re-registers any of them is
// preserved.
const MMR_GITHUB_EXTENSION_ENTRYPOINT_PATH = fileURLToPath(import.meta.url);
registerMmrOwnedExtensionPath(MMR_GITHUB_EXTENSION_ENTRYPOINT_PATH);
registerMmrGithubToolSourcePath(MMR_GITHUB_EXTENSION_ENTRYPOINT_PATH);

/**
 * Internal hooks for tests; not part of the public API. Tests can inject a
 * `loadSettings` function to bypass on-disk settings and a `createClient`
 * factory to avoid live GitHub calls.
 */
export interface MmrGithubFactoryOverrides {
  loadSettings?: (cwd: string) => MmrGithubSettings | { settings: MmrGithubSettings; warnings?: string[] };
  createClient?: MmrGithubToolDeps["createClient"];
}

function normalizeOverrideResult(
  result: MmrGithubSettings | { settings: MmrGithubSettings; warnings?: string[] },
): { settings: MmrGithubSettings; warnings: string[] } {
  if ("settings" in result && typeof result.settings === "object") {
    return { settings: result.settings, warnings: [...(result.warnings ?? [])] };
  }
  return { settings: result as MmrGithubSettings, warnings: [] };
}

/**
 * Build a Pi extension factory for `mmr-github` with optional test seams.
 *
 * The default export of this module calls this with no overrides; package
 * code and Pi extension wiring should always use the default export.
 *
 * Settings are sampled once at extension load, matching `mmr-web`: the Pi
 * tool registry is one-direction (no public `unregisterTool`), so toggling
 * access mid-process would desync the live provider gate from the registered
 * tools. Enabling/disabling GitHub access requires restarting the Pi process.
 */
export function createMmrGithubExtension(overrides: MmrGithubFactoryOverrides = {}) {
  return function mmrGithubExtension(pi: ExtensionAPI): void {
    const initialCwd = process.cwd();
    const initial = overrides.loadSettings
      ? normalizeOverrideResult(overrides.loadSettings(initialCwd))
      : loadMmrGithubSettings(initialCwd);
    const settings: MmrGithubSettings = initial.settings;
    const pendingWarnings = [...initial.warnings];

    const deps: MmrGithubToolDeps = {
      getSettings: () => settings,
      ...(overrides.createClient ? { createClient: overrides.createClient } : {}),
    };

    registerMmrFeatureGateProvider(createMmrGithubFeatureGateProvider(deps.getSettings));
    registerMmrToolProvider(createMmrGithubToolProvider(deps.getSettings));
    registerMmrGithubTools(pi, deps, MMR_GITHUB_EXTENSION_ENTRYPOINT_PATH);

    pi.on("session_start", async (_event, ctx) => {
      while (pendingWarnings.length > 0) {
        const warning = pendingWarnings.shift();
        if (warning !== undefined) ctx.ui.notify(warning, "warning");
      }
    });
  };
}

const mmrGithubExtension = createMmrGithubExtension();

export default mmrGithubExtension;
