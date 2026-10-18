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

/** The scroller for `tui`, or `undefined` when the current renderer cannot scroll. */
export function getMmrTranscriptScroller(tui: TUI | undefined): MmrTranscriptScroller | undefined {
  const candidate = tui as (TUI & ScrollableTui) | undefined;
  if (typeof candidate?.scrollToTop !== "function" || typeof candidate.scrollToBottom !== "function") return undefined;
  return {
    toTop: () => (candidate.scrollToTop as () => void)(),
    toBottom: () => (candidate.scrollToBottom as () => void)(),
  };
}
