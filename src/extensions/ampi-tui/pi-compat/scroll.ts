import type { TUI } from "@earendil-works/pi-tui";

/**
 * Transcript scrolling. Pi's fullscreen renderer (`tuiMode: "fullscreen"`,
 * the default) exposes `scrollToTop()` and `scrollToBottom()` on the TUI
 * object that component factories receive; the regular renderer leaves
 * scrolling to the terminal and has neither. Not part of Pi's extension API.
 */
export interface MmrTranscriptScroller {
  toTop(): void;
  toBottom(): void;
}

interface ScrollableTui {
  scrollToTop?: unknown;
  scrollToBottom?: unknown;
}

/** Rows of the transcript, first and last included, counted from its top. */
export interface MmrTranscriptRows {
  readonly start: number;
  readonly end: number;
}

/** The parts of Pi's transcript scroll view that revealing rows reads. */
interface TranscriptView {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  render(width: number): string[];
  scrollTo(scrollTop: number): void;
}

interface ViewportTui {
  getPrimaryScrollView?: unknown;
  terminal?: { columns?: unknown };
  requestRender?: unknown;
}

/**
 * Scroll the transcript so the rows `locate` picks are in view. Pi offers no
 * way to scroll to a component, so this draws the transcript once more at
 * the terminal's width (the transcript spans the whole width), lets `locate`
 * find the rows in those lines, and scrolls the least distance that shows
 * them: their top at the top of the view when they come from above or do
 * not fit, their bottom at the bottom when they come from below.
 *
 * Reads the fullscreen renderer's private `getPrimaryScrollView()`; the
 * scroll view itself is Pi's exported `ScrollView`. Returns false, and
 * scrolls nothing, when the renderer has no scroll view or `locate` finds
 * nothing.
 */
export function revealMmrTranscriptRows(
  tui: TUI | undefined,
  locate: (lines: readonly string[]) => MmrTranscriptRows | undefined,
): boolean {
  const candidate = tui as (TUI & ViewportTui) | undefined;
  const columns = candidate?.terminal?.columns;
  if (typeof candidate?.getPrimaryScrollView !== "function" || typeof columns !== "number") return false;
  const view = (candidate.getPrimaryScrollView as () => TranscriptView | undefined).call(candidate);
  if (typeof view?.render !== "function" || typeof view.scrollTo !== "function") return false;
  const rows = locate(view.render(columns));
  if (!rows) return false;
  const top = view.scrollTop;
  const height = Math.max(1, view.viewportHeight);
  if (rows.start < top || rows.end - rows.start + 1 > height) view.scrollTo(rows.start);
  else if (rows.end >= top + height) view.scrollTo(rows.end - height + 1);
  return true;
}

/** The scroller for `tui`, or `undefined` when the current renderer cannot scroll. */
export function getMmrTranscriptScroller(tui: TUI | undefined): MmrTranscriptScroller | undefined {
  const candidate = tui as (TUI & ScrollableTui) | undefined;
  if (typeof candidate?.scrollToTop !== "function" || typeof candidate.scrollToBottom !== "function") return undefined;
  return {
    toTop: () => (candidate.scrollToTop as () => void)(),
    toBottom: () => (candidate.scrollToBottom as () => void)(),
  };
}
