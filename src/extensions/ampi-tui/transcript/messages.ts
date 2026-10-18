import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { installMmrUserMessageDraw } from "../pi-compat/messages.js";

/** Bar drawn in front of every physical line of a user message. */
export const MMR_USER_MESSAGE_BAR = "┃ ";

type MessageTheme = Pick<Theme, "fg" | "italic">;

/**
 * Draw a user message the Amp-compatible way: the raw text (no Markdown
 * rendering), wrapped to the width, with a bar in front of every physical
 * line, wrapped ones included. The bar and the text use the theme's
 * `userMessageText` colour, the text is italic, and nothing gets a background.
 * A blank row above separates the message from the one before it.
 */
export function renderMmrUserMessage(text: string, width: number, outputPad: number, theme: MessageTheme): string[] {
  const margin = " ".repeat(Math.max(0, Math.min(outputPad, Math.floor((width - 3) / 2))));
  // The margin applies on both sides, like Pi's Markdown, so the fullscreen
  // scrollbar column never covers text.
  const contentWidth = Math.max(1, width - 2 * margin.length - MMR_USER_MESSAGE_BAR.length);
  const bar = theme.fg("userMessageText", MMR_USER_MESSAGE_BAR);
  const lines = [""];
  for (const sourceLine of text.replace(/\t/g, "   ").split("\n")) {
    const wrapped = sourceLine.length === 0 ? [""] : wrapTextWithAnsi(sourceLine, contentWidth);
    for (const line of wrapped) {
      lines.push(line.length === 0 ? `${margin}${bar}` : `${margin}${bar}${theme.italic(theme.fg("userMessageText", line))}`);
    }
  }
  return lines;
}

export interface MmrTuiMessageStyle {
  /** Pick up the session's theme and hide the label Pi shows for collapsed thinking. */
  start(ctx: ExtensionContext): void;
  /** Give user messages back to Pi's own drawing. */
  dispose(): void;
}

/**
 * Install ampi's transcript styling. The user message patch goes in at once,
 * before Pi rebuilds the chat on reload; it draws without colour until the
 * first session start hands it the theme. Assistant messages keep Pi's
 * renderer and follow the theme tokens only.
 */
export function createMmrTuiMessageStyle(): MmrTuiMessageStyle {
  let theme: MessageTheme | undefined;
  const plain: MessageTheme = { fg: (_token, text) => text, italic: (text) => text };
  const restore = installMmrUserMessageDraw((text, width, outputPad) =>
    renderMmrUserMessage(text, width, outputPad, theme ?? plain),
  );
  return {
    start(ctx) {
      // `ctx.ui.theme` follows theme switches, so reading it once is enough.
      theme = ctx.ui.theme;
      // Collapsed thinking shows nothing at all; expanded thinking is Pi's
      // header-less italic block in the theme's `thinkingText` colour.
      ctx.ui.setHiddenThinkingLabel("");
    },
    dispose() {
      restore?.();
    },
  };
}
