import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { installMmrUserMessageDraw } from "../pi-compat/messages.js";

/** Bar drawn in front of every physical line of a user message. */
export const MMR_USER_MESSAGE_BAR = "┃ ";

/** Key and words of the hint in the bottom border of a selected user message. */
export const MMR_SELECTED_MESSAGE_HINT = { key: "e", label: " to edit" } as const;

type MessageTheme = Pick<Theme, "fg" | "italic">;

function wrapUserText(text: string, width: number): string[] {
  return text
    .replace(/\t/g, "   ")
    .split("\n")
    .flatMap((sourceLine) => (sourceLine.length === 0 ? [""] : wrapTextWithAnsi(sourceLine, width)));
}

/**
 * Draw a user message the Amp-compatible way: the raw text (no Markdown
 * rendering), wrapped to the width, with a bar in front of every physical
 * line, wrapped ones included. The bar and the text use the theme's
 * `userMessageText` colour, the text is italic, and nothing gets a background.
 * A blank row above separates the message from the one before it.
 *
 * A `selected` message is drawn in a heavy frame instead of the bar, with the
 * edit hint in its bottom border:
 *
 * ```text
 *  ┏━━━━━━━━━━━━━━━━━━━━┓
 *  ┃ rename the parser  ┃
 *  ┗━e to edit━━━━━━━━━━┛
 * ```
 */
export function renderMmrUserMessage(
  text: string,
  width: number,
  outputPad: number,
  theme: MessageTheme,
  selected = false,
): string[] {
  // The frame needs two more columns than the bar.
  const chrome = selected ? 5 : 3;
  const margin = " ".repeat(Math.max(0, Math.min(outputPad, Math.floor((width - chrome) / 2))));
  // The margin applies on both sides, like Pi's Markdown, so the fullscreen
  // scrollbar column never covers text.
  const contentWidth = Math.max(1, width - 2 * margin.length - chrome + 1);
  const paint = (line: string) => theme.italic(theme.fg("userMessageText", line));
  if (!selected) {
    const bar = theme.fg("userMessageText", MMR_USER_MESSAGE_BAR);
    return ["", ...wrapUserText(text, contentWidth).map((line) => (line.length === 0 ? `${margin}${bar}` : `${margin}${bar}${paint(line)}`))];
  }
  const frame = (part: string) => theme.fg("userMessageText", part);
  const rule = contentWidth + 2;
  const { key, label } = MMR_SELECTED_MESSAGE_HINT;
  const hintWidth = key.length + label.length;
  const bottom =
    rule >= hintWidth + 2
      ? `${frame("┗━")}${theme.fg("accent", key)}${theme.fg("dim", label)}${frame(`${"━".repeat(rule - hintWidth - 1)}┛`)}`
      : frame(`┗${"━".repeat(rule)}┛`);
  return [
    "",
    `${margin}${frame(`┏${"━".repeat(rule)}┓`)}`,
    ...wrapUserText(text, contentWidth).map((line) => {
      const fill = " ".repeat(Math.max(0, contentWidth - visibleWidth(line)));
      return `${margin}${frame("┃ ")}${line.length === 0 ? "" : paint(line)}${fill}${frame(" ┃")}`;
    }),
    `${margin}${bottom}`,
  ];
}

/** Tells the drawing which user message is selected, by its number and text. */
export type MmrUserMessageSelected = (number: number, text: string) => boolean;

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
export function createMmrTuiMessageStyle(isSelected: MmrUserMessageSelected = () => false): MmrTuiMessageStyle {
  let theme: MessageTheme | undefined;
  const plain: MessageTheme = { fg: (_token, text) => text, italic: (text) => text };
  const restore = installMmrUserMessageDraw((text, width, outputPad, number) =>
    renderMmrUserMessage(text, width, outputPad, theme ?? plain, isSelected(number, text)),
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
