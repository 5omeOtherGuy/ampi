import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { getMmrModeState, onMmrStateChanged } from "../../ampi-core/runtime.js";
import { readAssistantUsage } from "../../ampi-core/status.js";
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
 * current: the mode from ampi-core, the cost from the session's assistant
 * messages, the turn status from the status feed (with the wave glyph
 * stepping while a turn runs), and the working directory with the branch
 * Pi's footer data reports.
 */

export interface MmrPromptBoxInstallOptions {
  readonly setInterval?: (callback: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

export interface MmrPromptBoxInstall {
  /** Replace Pi's editor for this session. Safe to call again on the next session start. */
  start(ctx: ExtensionContext, getFooterData: () => ReadonlyFooterDataProvider | undefined): void;
  stop(): void;
  /** The status feed changed: redraw, and step the wave glyph while busy. */
  statusChanged(): void;
  /** Clear the prompt text (the first Esc of Esc Esc while a turn runs). */
  clearPrompt(): void;
  /** Rows the box drew last, or `undefined` before its first render. */
  renderedHeight(): number | undefined;
  /** Draw the frame dim while an overlay covers the prompt. */
  setOverlayOpen(open: boolean): void;
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
  let unsubscribeMode: (() => void) | undefined;
  let costCache: { length: number; last: unknown; cost: number | undefined } = { length: -1, last: undefined, cost: undefined };

  function requestRender(): void {
    tui?.requestRender();
  }

  /** Total cost of the session's assistant messages; `undefined` while there are none. */
  function sessionCost(): number | undefined {
    const entries = ctx?.sessionManager.getEntries() ?? [];
    const last = entries.at(-1);
    if (entries.length !== costCache.length || last !== costCache.last) {
      let cost: number | undefined;
      for (const entry of entries) {
        const usage = readAssistantUsage(entry);
        if (usage) cost = (cost ?? 0) + usage.cost;
      }
      costCache = { length: entries.length, last, cost };
    }
    return costCache.cost;
  }

  function slots(): MmrPromptBoxSlots {
    const status = feed.status;
    const cost = sessionCost();
    // A fresh session shows no gauge; during its first turn the cost is not known yet.
    const gauge = cost === undefined && !status.busy ? undefined : formatMmrSessionCost(cost);
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
  };

  function stopWave(): void {
    if (waveTimer !== undefined) stopInterval(waveTimer);
    waveTimer = undefined;
    waveFrame = 0;
  }

  return {
    start(nextCtx, nextGetFooterData) {
      ctx = nextCtx;
      getFooterData = nextGetFooterData;
      // The box shows the turn status itself; Pi's working row would repeat it.
      nextCtx.ui.setWorkingVisible(false);
      nextCtx.ui.setEditorComponent((editorTui, theme, keybindings) => {
        tui = editorTui;
        box = new MmrPromptBox(editorTui, theme, keybindings, host);
        return box;
      });
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
      if (feed.status.busy && waveTimer === undefined) {
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
      if (ctx && ctx.ui.getEditorText().length > 0) ctx.ui.setEditorText("");
    },
    renderedHeight() {
      const height = box?.renderedHeight();
      return height ? height : undefined;
    },
    setOverlayOpen(open) {
      if (overlay === open) return;
      overlay = open;
      requestRender();
    },
  };
}
