import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { isMmrAnimationDisabled } from "../../ampi-core/animation.js";
import { getMmrModeState, onMmrStateChanged } from "../../ampi-core/runtime.js";
import { mmrEntryCost, readMmrEntryUsage } from "../../ampi-core/session-usage.js";
import { getMmrThreadReports } from "../../ampi-core/thread-reports.js";
import { MMR_SHORTCUT_HELP_TMUX_NOTE, type MmrShortcutHelpEntry } from "./help.js";
import { createMmrMentionProvider, pickMmrThreadMention, readMmrRecentCommits } from "./mentions.js";
import {
  formatMmrSessionCost,
  MMR_STATUS_WAVE_FRAMES,
  MMR_STATUS_WAVE_INTERVAL_MS,
  MmrPromptBox,
  type MmrPromptBoxHost,
  type MmrPromptBoxSlots,
} from "./prompt-box.js";
import type { MmrStatusFeed } from "./status-feed.js";

/**
 * Installs the prompt box in place of Pi's editor and keeps its borders
 * current: the mode from ampi-core, the cost from the session's model usage
 * (hidden when `ampiThreads.showCosts` is off), the turn status from the status feed (with the wave glyph
 * stepping while a turn runs), and the working directory with the branch
 * Pi's footer data reports. It also opens and closes the box's shortcuts
 * help; inside tmux the help adds a note when tmux's `extended-keys` option
 * is off, checked once, the first time the help opens. It also adds the
 * `@:` commit and `@@` session mentions to the prompt's autocomplete.
 */

export interface MmrPromptBoxInstallOptions {
  readonly setInterval?: (callback: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
  /** Rows of the shortcuts help, read each time it is drawn. */
  readonly helpEntries?: () => readonly MmrShortcutHelpEntry[];
  /** tmux's `extended-keys` value, or `undefined` outside tmux or when it cannot be read. */
  readonly tmuxExtendedKeys?: () => Promise<string | undefined>;
  /** Enter on an empty prompt: steer with the next queued message. False when there is none. */
  readonly steerQueued?: () => boolean;
  /** Opens the Mention Thread picker; resolves with the reference to insert. */
  readonly pickThread?: (ctx: ExtensionContext) => Promise<string | undefined>;
}

export interface MmrPromptBoxInstall {
  /** Replace Pi's editor for this session. Safe to call again on the next session start. */
  start(ctx: ExtensionContext, getFooterData: () => ReadonlyFooterDataProvider | undefined): void;
  stop(): void;
  /** The status feed changed: redraw, and step the wave glyph while busy. */
  statusChanged(): void;
  /** Clear the prompt text and close the help (the first Esc of Esc Esc while a turn runs). */
  clearPrompt(): void;
  /** Open the shortcuts help, or close it when open. */
  toggleHelp(): void;
  /** Close the shortcuts help if it is open. */
  closeHelp(): void;
  /** Rows the box drew last, or `undefined` before its first render. */
  renderedHeight(): number | undefined;
  /** Draw the frame dim while an overlay covers the prompt. */
  setOverlayOpen(open: boolean): void;
}

/** Ask the tmux server this session runs in for its `extended-keys` option. */
function readTmuxExtendedKeys(): Promise<string | undefined> {
  if (!process.env.TMUX) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile("tmux", ["show", "-gv", "extended-keys"], { timeout: 2000 }, (error, stdout) => {
      resolve(error ? undefined : stdout.trim());
    });
  });
}

export function createMmrPromptBoxInstall(
  pi: ExtensionAPI,
  feed: MmrStatusFeed,
  options: MmrPromptBoxInstallOptions = {},
): MmrPromptBoxInstall {
  const startInterval = options.setInterval ?? ((callback: () => void, ms: number) => setInterval(callback, ms));
  const stopInterval = options.clearInterval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));

  let ctx: ExtensionContext | undefined;
  let getFooterData: () => ReadonlyFooterDataProvider | undefined = () => undefined;
  let box: MmrPromptBox | undefined;
  let tui: TUI | undefined;
  let overlay = false;
  let waveFrame = 0;
  let waveTimer: unknown;
  /** Whether the wave steps; asked at each session start. */
  let animate = true;
  let unsubscribeMode: (() => void) | undefined;
  let mentionOpen = false;
  let tmuxChecked = false;
  let tmuxNote = false;
  let costCache: { length: number; last: unknown; cost: number | undefined } = { length: -1, last: undefined, cost: undefined };

  function requestRender(): void {
    tui?.requestRender();
  }

  /**
   * What the session's model usage cost so far, counting the entries whose
   * cost is known, as `thread show cost` does; `undefined` while no entry
   * records usage.
   */
  function sessionCost(): number | undefined {
    const entries = ctx?.sessionManager.getEntries() ?? [];
    const last = entries.at(-1);
    if (entries.length !== costCache.length || last !== costCache.last) {
      let cost: number | undefined;
      for (const entry of entries) {
        const usage = readMmrEntryUsage(entry);
        if (!usage) continue;
        const price = usage.provider && usage.model ? ctx?.modelRegistry.find(usage.provider, usage.model)?.cost : undefined;
        cost = (cost ?? 0) + (mmrEntryCost(usage, price) ?? 0);
      }
      costCache = { length: entries.length, last, cost };
    }
    return costCache.cost;
  }

  function slots(): MmrPromptBoxSlots {
    const status = feed.status;
    // ampiThreads.showCosts turns the gauge off; a fresh session shows none,
    // and during its first turn the cost is not known yet.
    const showCosts = getMmrThreadReports()?.showCosts ?? true;
    const cost = showCosts ? sessionCost() : undefined;
    const gauge = !showCosts || (cost === undefined && !status.busy) ? undefined : formatMmrSessionCost(cost);
    const cwd = ctx ? ctx.sessionManager.getCwd() : undefined;
    const branch = getFooterData()?.getGitBranch();
    return {
      mode: getMmrModeState()?.mode,
      gauge,
      status,
      waveFrame,
      location: cwd && branch ? `${cwd} (${branch})` : cwd,
      overlay,
    };
  }

  const host: MmrPromptBoxHost = {
    slots,
    theme: () => ctx?.ui.theme ?? { fg: (_token: string, text: string) => text },
    dequeued: () => feed.refreshQueue(),
    steerQueued: () => options.steerQueued?.() ?? false,
    help: () => ({ entries: options.helpEntries?.() ?? [], note: tmuxNote ? MMR_SHORTCUT_HELP_TMUX_NOTE : undefined }),
    mentionThread,
  };

  function setOverlayOpen(open: boolean): void {
    if (overlay === open) return;
    overlay = open;
    requestRender();
  }

  /**
   * Open the Mention Thread picker for the second `@` the box held back,
   * dimming the frame while it is open. The `@` already in the prompt starts
   * the reference, so a pick adds `<session id> ` after it; Esc types the
   * held-back `@` after all.
   */
  function mentionThread(): boolean {
    const current = ctx;
    if (!current || mentionOpen) return false;
    mentionOpen = true;
    setOverlayOpen(true);
    const insert = (text: string) => {
      current.ui.pasteToEditor(text);
      requestRender();
    };
    void (options.pickThread ?? pickMmrThreadMention)(current)
      .finally(() => {
        mentionOpen = false;
        setOverlayOpen(false);
      })
      .then(
        (reference) => insert(reference?.slice(1) ?? "@"),
        (error: unknown) => {
          insert("@");
          current.ui.notify(`Could not read the sessions: ${error instanceof Error ? error.message : String(error)}`, "error");
        },
      );
    return true;
  }

  function checkTmux(): void {
    if (tmuxChecked) return;
    tmuxChecked = true;
    (options.tmuxExtendedKeys ?? readTmuxExtendedKeys)().then(
      (value) => {
        tmuxNote = value !== undefined && value !== "on" && value !== "always";
        if (tmuxNote) requestRender();
      },
      () => {},
    );
  }

  function closeHelp(): void {
    if (!box?.isHelpOpen()) return;
    box.setHelpOpen(false);
    requestRender();
  }

  function stopWave(): void {
    if (waveTimer !== undefined) stopInterval(waveTimer);
    waveTimer = undefined;
    waveFrame = 0;
  }

  return {
    start(nextCtx, nextGetFooterData) {
      ctx = nextCtx;
      getFooterData = nextGetFooterData;
      animate = !isMmrAnimationDisabled({ cwd: nextCtx.cwd });
      // The box shows the turn status itself; Pi's working row would repeat it.
      nextCtx.ui.setWorkingVisible(false);
      nextCtx.ui.setEditorComponent((editorTui, theme, keybindings) => {
        tui = editorTui;
        box = new MmrPromptBox(editorTui, theme, keybindings, host);
        return box;
      });
      // Pi drops autocomplete wrappers when the session goes, so each session adds its own.
      nextCtx.ui.addAutocompleteProvider((base) =>
        createMmrMentionProvider(base, {
          listCommits: () => readMmrRecentCommits(nextCtx.sessionManager.getCwd()),
          now: Date.now,
          dim: (text) => nextCtx.ui.theme.fg("dim", text),
          typeKey: (char) => {
            box?.handleInput(char);
            requestRender();
          },
          visibleRows: () => box?.getAutocompleteMaxVisible(),
          suppressed: () => mentionOpen,
        }),
      );
      unsubscribeMode ??= onMmrStateChanged(pi, requestRender);
    },
    stop() {
      stopWave();
      unsubscribeMode?.();
      unsubscribeMode = undefined;
      box = undefined;
      tui = undefined;
      ctx = undefined;
    },
    statusChanged() {
      // With animations off the wave rests on its first glyph.
      if (feed.status.busy && waveTimer === undefined && animate) {
        waveTimer = startInterval(() => {
          waveFrame = (waveFrame + 1) % MMR_STATUS_WAVE_FRAMES.length;
          requestRender();
        }, MMR_STATUS_WAVE_INTERVAL_MS);
      } else if (!feed.status.busy) {
        stopWave();
      }
      requestRender();
    },
    clearPrompt() {
      closeHelp();
      if (ctx && ctx.ui.getEditorText().length > 0) ctx.ui.setEditorText("");
    },
    toggleHelp() {
      if (!box) return;
      box.setHelpOpen(!box.isHelpOpen());
      if (box.isHelpOpen()) checkTmux();
      requestRender();
    },
    closeHelp,
    renderedHeight() {
      const height = box?.renderedHeight();
      return height ? height : undefined;
    },
    setOverlayOpen,
  };
}
