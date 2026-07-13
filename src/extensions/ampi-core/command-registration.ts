import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runMmrConfigFlow } from "./config-flow.js";
import { formatMmrModeList, MMR_MODE_KEYS, resolveMmrModeKey } from "./modes.js";
import { getMmrModeHistory, getMmrModeState } from "./runtime.js";
import { showMmrChangelogCommand } from "./changelog.js";
import { formatMmrStatus } from "./status.js";
import type { MmrModeController } from "./mode-controller.js";

const MMR_MODE_PICKER_SHORTCUTS = ["ctrl+shift+s", "alt+m"] as const;

function modeCompletions(prefix: string) {
  return MMR_MODE_KEYS.filter((mode) => mode.startsWith(prefix)).map((mode) => ({ value: mode, label: mode }));
}

function parseMmrStatusDebugFlag(args: unknown): boolean {
  if (typeof args !== "string") return false;
  return args
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .some((token) => token === "debug" || token === "--debug");
}

/**
 * Register the ampi commands (`/mode`, `/ampi-status`, `/ampi-changelog`,
 * `/ampi-config`) plus legacy `/mmr-*` compatibility aliases, followed by the
 * four mode shortcuts (mode-picker pair, `ctrl+space` cycle, `alt+r` thinking
 * toggle). Registration order is load-bearing and verified by the
 * registration-order characterization test; keep commands-before-shortcuts and
 * the picker→cycle→toggle sequence intact. Every handler body delegates to the
 * controller.
 */
export function registerMmrCommands(pi: ExtensionAPI, controller: MmrModeController): void {
  pi.registerCommand("mode", {
    description: "Show or switch ampi mode",
    getArgumentCompletions: modeCompletions,
    handler: async (args, ctx) => {
      const requested = args.trim();
      if (!requested || requested === "list") {
        ctx.ui.notify(`Available ampi modes:\n${formatMmrModeList()}\n\nCurrent:\n${formatMmrStatus(getMmrModeState())}`, "info");
        return;
      }

      const mode = resolveMmrModeKey(requested);
      if (!mode) {
        ctx.ui.notify(`Unknown ampi mode "${requested}". Available modes: ${MMR_MODE_KEYS.join(", ")}`, "error");
        return;
      }

      await controller.applyMode(mode, ctx, { source: "command", persist: true, notify: true });
    },
  });

  const registerStatusCommand = (name: "ampi-status" | "mmr-status") => {
    pi.registerCommand(name, {
      description: "Show current ampi locked-mode status. Pass 'debug' or '--debug' for model/tool resolution detail.",
      handler: async (args, ctx) => {
        const debug = parseMmrStatusDebugFlag(args);
        ctx.ui.notify(formatMmrStatus(getMmrModeState(), { debug, modeHistory: debug ? getMmrModeHistory() : undefined }), "info");
      },
    });
  };

  registerStatusCommand("ampi-status");
  registerStatusCommand("mmr-status");

  const registerChangelogCommand = (name: "ampi-changelog" | "mmr-changelog") => {
    pi.registerCommand(name, {
      description: "Show ampi changelog entries",
      handler: async (_args, ctx) => {
        showMmrChangelogCommand(ctx);
      },
    });
  };

  registerChangelogCommand("ampi-changelog");
  registerChangelogCommand("mmr-changelog");

  const registerConfigCommand = (name: "ampi-config" | "mmr-config") => {
    pi.registerCommand(name, {
      description: "Pick the model used for an ampi mode or subagent, or configure ampi-web, and persist to project settings.",
      handler: async (_args, ctx) => {
        await runMmrConfigFlow(ctx, {
          getConfiguredModelPreferences: () => controller.getConfiguredModelPreferences(),
          getConfiguredSubagentModelPreferences: () => controller.getConfiguredSubagentModelPreferences(),
          setConfiguredModePreferences: (mode, preferences) => {
            controller.setConfiguredModePreferences(mode, preferences);
          },
          setConfiguredSubagentPreferences: (profile, preferences) => {
            controller.setConfiguredSubagentPreferences(profile, preferences);
          },
          getAvailableTools: () => pi.getAllTools().map((tool) => tool.name),
        });
      },
    });
  };

  registerConfigCommand("ampi-config");
  registerConfigCommand("mmr-config");

  for (const shortcut of MMR_MODE_PICKER_SHORTCUTS) {
    pi.registerShortcut(shortcut, {
      description: "Select ampi mode",
      handler: async (ctx) => {
        await controller.selectModeFromShortcut(ctx);
      },
    });
  }

  pi.registerShortcut("ctrl+space", {
    description: "Cycle ampi mode",
    handler: async (ctx) => {
      await controller.cycleModeFromShortcut(ctx);
    },
  });

  // `alt+r` (reasoning), not `alt+t`: ampi-toolbox already defaults its
  // task-list widget toggle to `alt+t`, and Pi's loader resolves duplicate
  // extension shortcut keys as last-registered-wins, so sharing `alt+t` would
  // silently shadow one of them. `alt+r` is free across ampi and is not a
  // Pi default binding.
  pi.registerShortcut("alt+r", {
    description: "Toggle ampi thinking level (medium/high/ultra)",
    handler: async (ctx) => {
      await controller.toggleThinkingFromShortcut(ctx);
    },
  });
}
