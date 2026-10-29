import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { markAmpiPartLoaded } from "../ampi-core/parts.js";
import type { TUI } from "@earendil-works/pi-tui";
import { registerMmrChromeOwner } from "../ampi-core/chrome-owner.js";
import { getMmrCommands } from "../ampi-core/command-registry.js";
import { getMmrModeState } from "../ampi-core/runtime.js";
import { installMmrTuiLook } from "./chrome/look.js";
import { printMmrQuitSummary } from "./chrome/quit-summary.js";
import { createMmrTitleNotify } from "./chrome/title-notify.js";
import { loadMmrTuiSettings, type MmrTuiSettings } from "./config.js";
import { buildMmrShortcutHelpEntries } from "./editor/help.js";
import { createMmrPromptBoxInstall } from "./editor/install.js";
import { createMmrPromptQueue } from "./editor/queue.js";
import { createMmrStatusFeed } from "./editor/status-feed.js";
import { canMmrSetDetailsExpanded, setMmrDetailsExpanded } from "./keys/commands.js";
import { createMmrTuiKeys } from "./keys/install.js";
import { createMmrIntroLauncher } from "./overlays/intro.js";
import { createMmrMessageNavigation } from "./transcript/navigation.js";
import { installToolRenderers } from "./transcript/tool-renderers.js";

/** Name `ampi-tui` registers under in ampi-core's chrome-owner seam. */
const MMR_TUI_CHROME_OWNER = "ampi-tui";

/** Session starts that open a transcript; a reload keeps the details as they were. */
const DETAILS_DEFAULT_REASONS: ReadonlySet<string> = new Set(["startup", "new", "resume", "fork"]);

export interface MmrTuiFactoryOverrides {
  loadSettings?: () => MmrTuiSettings;
  /** File that records the onboarding intro as seen; defaults to `<agentDir>/data/ampi/tui/intro.json`. */
  introRecordPath?: string;
}

export function createMmrTuiExtension(overrides: MmrTuiFactoryOverrides = {}) {
  return function ampiTuiExtension(pi: ExtensionAPI): void {
    markAmpiPartLoaded(pi, "ampi-tui");
    const settings = overrides.loadSettings ? overrides.loadSettings() : loadMmrTuiSettings(process.cwd());
    // Disabled: register nothing, so ampi-core's footer shows as before.
    if (!settings.enabled) return;

    // Renderers only draw in the interactive transcript (and HTML exports),
    // so registering them is harmless in print, JSON and RPC runs.
    installToolRenderers(pi);

    let releaseChrome: (() => void) | undefined;
    let tui: TUI | undefined;
    let footerData: ReadonlyFooterDataProvider | undefined;
    /** The session whose details still wait to be expanded (`ampi.terminal.detailsExpandedByDefault`). */
    let expandDetailsFor: ExtensionContext | undefined;

    /**
     * Expand the details once the prompt editor can be reached: showing
     * thinking runs its thinking toggle, and at session start the editor may
     * not be mounted or focused yet. Tried at session start and after each
     * frame until it has run once.
     */
    function expandDetailsWhenReady(): void {
      const ctx = expandDetailsFor;
      const detailsHost = { getTui: () => tui, pi };
      if (!ctx || !canMmrSetDetailsExpanded(detailsHost)) return;
      expandDetailsFor = undefined;
      setMmrDetailsExpanded(detailsHost, ctx, true);
    }
    const navigation = createMmrMessageNavigation(pi);
    const look = installMmrTuiLook(pi, settings, navigation.isSelected);
    const feed = createMmrStatusFeed(pi, {
      onChange: () => {
        promptBox.statusChanged();
        titleNotify.statusChanged();
      },
    });
    const promptBox = createMmrPromptBoxInstall(pi, feed, {
      helpEntries: () =>
        buildMmrShortcutHelpEntries({ keymap: keys.keymap(), commands: getMmrCommands(), modeKeys: getMmrModeState() !== undefined }),
      steerQueued: () => queue.steerNext(),
      alwaysIncludePaths: settings.alwaysIncludePaths,
    });
    const titleNotify = createMmrTitleNotify(pi, feed, { settings: settings.notifications });
    const queue = createMmrPromptQueue(pi, { feed, getTui: () => tui });
    const keys = createMmrTuiKeys(pi, {
      editorHeight: () => promptBox.renderedHeight(),
      onEscapePending: () => promptBox.clearPrompt(),
      onQuitPending: (until) => feed.setQuitHint(until),
      onInterrupt: () => feed.abort(),
      onPaletteOpen: (open) => promptBox.setOverlayOpen(open),
      onToggleHelp: () => promptBox.toggleHelp(),
      onKeyCommand: () => promptBox.closeHelp(),
      onEscape: () => navigation.clear(),
      onShowWelcome: (ctx) => void intro.open(ctx).catch(() => {}),
    });
    const intro = createMmrIntroLauncher({ settings, keymap: () => keys.keymap(), recordPath: overrides.introRecordPath });

    pi.on("session_start", (event, ctx) => {
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
        return {
          render: () => {
            // After the frame, not during it: the thinking toggle rebuilds the transcript.
            if (expandDetailsFor) queueMicrotask(expandDetailsWhenReady);
            return [];
          },
          invalidate() {},
          dispose: unsubscribe,
        };
      });
      // The theme and header go first, so the prompt box draws in the ampi
      // theme from its first frame and the welcome card's key listener sees
      // keys the dispatcher consumes.
      look.start(ctx);
      feed.reset(ctx);
      promptBox.start(ctx, () => footerData);
      queue.start(ctx);
      keys.start(ctx, () => tui);
      navigation.start(ctx, () => tui);
      titleNotify.start(ctx);
      expandDetailsFor = settings.detailsExpandedByDefault && DETAILS_DEFAULT_REASONS.has(event.reason) ? ctx : undefined;
      expandDetailsWhenReady();
      // Last, so the intro names the keys of the keymap just resolved and opens over the finished screen.
      intro.start(ctx);
    });

    pi.on("session_shutdown", (event, ctx) => {
      expandDetailsFor = undefined;
      intro.stop();
      navigation.stop();
      keys.stop();
      queue.stop();
      promptBox.stop();
      look.stop();
      titleNotify.stop();
      // On quit Pi has left its UI by now and prints its resume line next.
      if (releaseChrome && event.reason === "quit") printMmrQuitSummary(ctx);
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
