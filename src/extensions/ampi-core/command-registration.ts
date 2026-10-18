import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runMmrConfigFlow } from "./config-flow.js";
import { formatMmrModeList, MMR_MODE_KEYS, resolveMmrModeKey } from "./modes.js";
import { getMmrModeHistory, getMmrModeState } from "./runtime.js";
import { showMmrChangelogCommand } from "./changelog.js";
import { getMmrChromeOwner } from "./chrome-owner.js";
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
 * mode shortcuts (mode-picker pair, `ctrl+s` cycle with its deprecated
 * `ctrl+space` alias, `alt+d` thinking toggle). Registration order is
 * load-bearing and verified by the registration-order characterization test;
 * keep commands-before-shortcuts and the picker→cycle→toggle sequence intact.
 * Every handler body delegates to the controller.
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
        const state = getMmrModeState();
        ctx.ui.notify(
          formatMmrStatus(state, {
            debug,
            modeHistory: debug ? getMmrModeHistory() : undefined,
            autoCompact: debug ? controller.getAutoCompactor().getStatus(state?.mode) : undefined,
          }),
          "info",
        );
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

  // `ctrl+s` is the Amp-compatible mode key. Pi binds it to non-reserved
  // picker actions (save model selection, save thinking level, session sort),
  // so an extension may take it in the main editor; Pi reports the override as
  // a startup warning. An extension that owns ampi's terminal chrome (such as
  // `ampi-tui`, whose mode dial takes Ctrl+S) also owns the mode keys, so both
  // cycle shortcuts do nothing while one is registered.
  pi.registerShortcut("ctrl+s", {
    description: "Cycle ampi mode",
    handler: async (ctx) => {
      if (getMmrChromeOwner() !== undefined) return;
      await controller.cycleModeFromShortcut(ctx);
    },
  });

  // Deprecated alias kept for one minor release after the move to `ctrl+s`.
  pi.registerShortcut("ctrl+space", {
    description: "Cycle ampi mode (deprecated: use ctrl+s)",
    handler: async (ctx) => {
      if (getMmrChromeOwner() !== undefined) return;
      await controller.cycleModeFromShortcut(ctx);
    },
  });

  // `alt+d` is the Amp-compatible reasoning-effort key; `alt+r` stays free for
  // a future fast-speed toggle. Pi's editor binds `alt+d` to delete-word-forward
  // (not reserved, and `alt+delete` keeps that action), so the extension wins.
  pi.registerShortcut("alt+d", {
    description: "Toggle ampi thinking level (medium/high/ultra)",
    handler: async (ctx) => {
      await controller.toggleThinkingFromShortcut(ctx);
    },
  });
}
