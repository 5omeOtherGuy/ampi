import type { ExtensionAPI, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { registerMmrChromeOwner } from "../ampi-core/chrome-owner.js";
import { getMmrCommands } from "../ampi-core/command-registry.js";
import { getMmrModeState } from "../ampi-core/runtime.js";
import { installMmrTuiLook } from "./chrome/look.js";
import { loadMmrTuiSettings, type MmrTuiSettings } from "./config.js";
import { buildMmrShortcutHelpEntries } from "./editor/help.js";
import { createMmrPromptBoxInstall } from "./editor/install.js";
import { createMmrStatusFeed } from "./editor/status-feed.js";
import { createMmrTuiKeys } from "./keys/install.js";
import { installToolRenderers } from "./transcript/tool-renderers.js";

/** Name `ampi-tui` registers under in ampi-core's chrome-owner seam. */
const MMR_TUI_CHROME_OWNER = "ampi-tui";

export interface MmrTuiFactoryOverrides {
  loadSettings?: () => MmrTuiSettings;
}

export function createMmrTuiExtension(overrides: MmrTuiFactoryOverrides = {}) {
  return function ampiTuiExtension(pi: ExtensionAPI): void {
    const settings = overrides.loadSettings ? overrides.loadSettings() : loadMmrTuiSettings(process.cwd());
    // Disabled: register nothing, so ampi-core's footer shows as before.
    if (!settings.enabled) return;

    // Renderers only draw in the interactive transcript (and HTML exports),
    // so registering them is harmless in print, JSON and RPC runs.
    installToolRenderers(pi);

    let releaseChrome: (() => void) | undefined;
    let tui: TUI | undefined;
    let footerData: ReadonlyFooterDataProvider | undefined;
    const look = installMmrTuiLook(pi, settings);
    const feed = createMmrStatusFeed(pi, { onChange: () => promptBox.statusChanged() });
    const promptBox = createMmrPromptBoxInstall(pi, feed, {
      helpEntries: () =>
        buildMmrShortcutHelpEntries({ keymap: keys.keymap(), commands: getMmrCommands(), modeKeys: getMmrModeState() !== undefined }),
    });
    const keys = createMmrTuiKeys(pi, {
      editorHeight: () => promptBox.renderedHeight(),
      onEscapePending: () => promptBox.clearPrompt(),
      onQuitPending: (until) => feed.setQuitHint(until),
      onInterrupt: () => feed.abort(),
      onPaletteOpen: (open) => promptBox.setOverlayOpen(open),
      onToggleHelp: () => promptBox.toggleHelp(),
    });

    pi.on("session_start", (_event, ctx) => {
      // Only the interactive terminal has chrome to own. Print, JSON and RPC
      // runs, subagent workers included, stay untouched.
      if (ctx.mode !== "tui") return;
      releaseChrome ??= registerMmrChromeOwner(MMR_TUI_CHROME_OWNER);
      // The single-screen layout has no footer: an empty component removes
      // Pi's footer and replaces ampi-core's, which now yields to this owner.
      // The factory is also where Pi hands over its TUI handle and the git
      // branch the prompt box shows.
      ctx.ui.setFooter((footerTui, _theme, data) => {
        tui = footerTui;
        footerData = data;
        const unsubscribe = data.onBranchChange(() => footerTui.requestRender());
        return { render: () => [], invalidate() {}, dispose: unsubscribe };
      });
      // The theme and header go first, so the prompt box draws in the ampi
      // theme from its first frame and the welcome card's key listener sees
      // keys the dispatcher consumes.
      look.start(ctx);
      feed.reset(ctx);
      promptBox.start(ctx, () => footerData);
      keys.start(ctx, () => tui);
    });

    pi.on("session_shutdown", () => {
      keys.stop();
      promptBox.stop();
      look.stop();
      // Release the seam so a reload with ampi-tui disabled hands the footer
      // back to ampi-core, which sets it again on the next session start.
      releaseChrome?.();
      releaseChrome = undefined;
    });
  };
}

export const createAmpiTuiExtension = createMmrTuiExtension;

const ampiTuiExtension = createMmrTuiExtension();

export default ampiTuiExtension;
