import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAmpiOwnedExtensionPath, registerAmpiOwnedTool } from "../ampi-core/owned-tools.js";

// Pi stamps each tool with the path of the extension entrypoint that
// registered it; recording ours lets Free mode recognise these tools by
// source as well as by name.
registerAmpiOwnedExtensionPath(fileURLToPath(import.meta.url));
import { registerMmrToolProvider } from "../ampi-core/runtime.js";
import type { MmrToolProvider, MmrToolRule } from "../ampi-core/types.js";
import { loadMmrShellSettings, type MmrShellSettings } from "./config.js";
import { MmrShellProcessRegistry, type MmrShellRegistryOptions } from "./processes.js";
import { createMmrShellTools, MMR_SHELL_TOOL_NAMES } from "./tools.js";

export { loadMmrShellSettings, MMR_SHELL_DEFAULTS, type MmrShellSettings } from "./config.js";
export { MMR_SHELL_MAX_UNREAD_BYTES, MmrShellProcessRegistry, type MmrShellRegistryOptions } from "./processes.js";
export {
  MMR_SHELL_STATUS_MAX_WAIT_MS,
  MMR_SHELL_TOOL_NAMES,
  SHELL_COMMAND_DESCRIPTION,
  SHELL_COMMAND_KILL_DESCRIPTION,
  SHELL_COMMAND_KILL_PARAMS,
  SHELL_COMMAND_KILL_PROMPT_SNIPPET,
  SHELL_COMMAND_PARAMS,
  SHELL_COMMAND_PROMPT_GUIDELINES,
  SHELL_COMMAND_PROMPT_SNIPPET,
  SHELL_COMMAND_STATUS_DESCRIPTION,
  SHELL_COMMAND_STATUS_PARAMS,
  SHELL_COMMAND_STATUS_PROMPT_SNIPPET,
} from "./tools.js";

const SHELL_PROVIDER_NAME = "ampi-shell";
const SHELL_TOOL_SET: ReadonlySet<string> = new Set<string>(MMR_SHELL_TOOL_NAMES);

export interface MmrShellFactoryOverrides {
  loadSettings?: () => MmrShellSettings;
  /** Stop timings and clock for the process registry. */
  registryOptions?: MmrShellRegistryOptions;
}

/** Claims exactly the three tool names; reports them disabled when the user turned `ampi-shell` off. */
function createShellProvider(enabled: boolean): MmrToolProvider {
  return {
    name: SHELL_PROVIDER_NAME,
    resolve(toolName): MmrToolRule | undefined {
      if (!SHELL_TOOL_SET.has(toolName)) return undefined;
      return enabled ? { kind: "active" } : { kind: "disabled", reason: "ampiShell.enabled is false" };
    },
  };
}

export function createMmrShellExtension(overrides: MmrShellFactoryOverrides = {}) {
  return function ampiShellExtension(pi: ExtensionAPI): void {
    const settings = overrides.loadSettings ? overrides.loadSettings() : loadMmrShellSettings(process.cwd());
    registerMmrToolProvider(createShellProvider(settings.enabled));
    if (!settings.enabled) return;

    const registry = new MmrShellProcessRegistry(overrides.registryOptions);
    const tools = createMmrShellTools({
      registry,
      settings: () => settings,
      piSettings: () => {
        try {
          return pi.getSettings();
        } catch {
          return undefined;
        }
      },
    });
    for (const tool of tools) {
      registerAmpiOwnedTool(tool.name);
      pi.registerTool(tool);
    }

    // Quit, reload, a new, resumed or forked session: nothing started here
    // outlives the session.
    pi.on("session_shutdown", async () => {
      await registry.shutdown();
    });
  };
}

export const createAmpiShellExtension = createMmrShellExtension;

const ampiShellExtension = createMmrShellExtension();

export default ampiShellExtension;
