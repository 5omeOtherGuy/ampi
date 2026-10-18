import type { TUI } from "@earendil-works/pi-tui";

/**
 * The transcript's mouse selection. Pi's fullscreen renderer
 * (`tuiMode: "fullscreen"`, the default) lets you select transcript text
 * with the mouse and offers `hasActiveSelection()` and
 * `copyActiveSelectionToClipboard()` on the TUI object that component
 * factories receive; the copy goes the way Pi's copy on select goes and
 * shows Pi's own "Copied!" flash. The regular renderer leaves selection to
 * the terminal and has neither. Pi's prompt editor has no text selection.
 * Not part of Pi's extension API.
 */
export interface MmrTranscriptSelection {
  /** Whether some transcript text is selected. */
  has(): boolean;
  /** Copy the selected text to the clipboard. Resolves false when nothing was copied. */
  copy(): Promise<boolean>;
}

interface SelectingTui {
  hasActiveSelection?: unknown;
  copyActiveSelectionToClipboard?: unknown;
}

/** The selection of `tui`'s transcript, or `undefined` when the current renderer has none. */
export function getMmrTranscriptSelection(tui: TUI | undefined): MmrTranscriptSelection | undefined {
  const candidate = tui as (TUI & SelectingTui) | undefined;
  if (typeof candidate?.hasActiveSelection !== "function" || typeof candidate.copyActiveSelectionToClipboard !== "function") {
    return undefined;
  }
  return {
    has: () => (candidate.hasActiveSelection as () => boolean).call(candidate) === true,
    copy: async () => (await (candidate.copyActiveSelectionToClipboard as () => Promise<boolean>).call(candidate)) === true,
  };
}
