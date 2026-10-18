import type { Theme } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * The box every ampi overlay is drawn in:
 *
 * ```
 * ╭─ Title ────────────────────────╮
 * │                                │  one blank row of top padding (optional)
 * │ content                       █│  the column before the right border
 * │ content                        │  is a gutter: a scrollbar or a space
 * ╰────────── Esc close · ↑↓ move ─╯
 * ```
 *
 * Rounded corners, the title in bold in the theme's `warning` color inside
 * the top border, and optional key hints right-aligned inside the bottom
 * border (key in `accent`, text and the ` · ` separators in `dim`; a hint
 * without a key is all text). Content
 * starts after one space and ends one column before the gutter, so a line
 * has {@link mmrFrameInnerWidth} columns. The border itself takes the
 * terminal's default color.
 */

/** The theme methods the frame and its scrollbar use; Pi's `Theme` provides them. */
export type MmrFrameTheme = Pick<Theme, "fg" | "bold" | "style" | "colors">;

export interface MmrFrameHint {
  /** Key in display form, e.g. `Esc`; leave it out for a hint that is only text. */
  readonly key?: string;
  readonly text: string;
}

export interface MmrFrameContent {
  readonly title?: string;
  readonly hints?: readonly MmrFrameHint[];
  /** Content lines; each is cut or padded to the inner width. */
  readonly lines: readonly string[];
  /** One cell per content line for the gutter column, such as a scrollbar; a space where missing. */
  readonly gutter?: readonly string[];
  /** Draw the blank row under the top border. Defaults to true. */
  readonly topPadding?: boolean;
}

/** Narrowest box the frame draws; a smaller width is widened to this. */
export const MMR_FRAME_MIN_WIDTH = 8;

const HINT_SEPARATOR = " · ";
/** Lower eighth blocks, indexed by how many eighths of the cell they fill. */
const LOWER_BLOCKS = ["", "▁", "▂", "▃", "▄", "▅", "▆", "▇"];

/**
 * Cut unstyled text to `width` columns, ending in "…" when it is cut.
 * Unlike pi-tui's `truncateToWidth` it adds no escape codes, so the result
 * can be styled afterwards without a reset in the middle.
 */
export function fitMmrText(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  if (width <= 0) return "";
  return `${sliceByColumn(text, 0, width - 1, true)}…`;
}

/** Columns a content line gets in a box `width` columns wide. */
export function mmrFrameInnerWidth(width: number): number {
  return Math.max(MMR_FRAME_MIN_WIDTH, width) - 4;
}

function renderHints(hints: readonly MmrFrameHint[], room: number, theme: MmrFrameTheme): string {
  // Drop hints from the end until the rest fits.
  for (let count = hints.length; count > 0; count--) {
    const shown = hints.slice(0, count);
    const plain = shown.map((hint) => (hint.key ? `${hint.key} ${hint.text}` : hint.text)).join(HINT_SEPARATOR);
    if (visibleWidth(plain) + 2 > room) continue;
    const styled = shown
      .map((hint) => `${hint.key ? `${theme.fg("accent", hint.key)} ` : ""}${theme.fg("dim", hint.text)}`)
      .join(theme.fg("dim", HINT_SEPARATOR));
    return ` ${styled} `;
  }
  return "";
}

/** Render `content` into a box exactly `width` columns wide (at least {@link MMR_FRAME_MIN_WIDTH}). */
export function renderMmrFrame(content: MmrFrameContent, width: number, theme: MmrFrameTheme): string[] {
  const total = Math.max(MMR_FRAME_MIN_WIDTH, width);
  const inner = mmrFrameInnerWidth(total);

  // `╭─` + title + dashes + `╮`.
  let top = "─".repeat(total - 3);
  if (content.title) {
    const title = fitMmrText(content.title, total - 5);
    top = ` ${theme.bold(theme.fg("warning", title))} ${"─".repeat(Math.max(0, total - 5 - visibleWidth(title)))}`;
  }

  // `╰` + dashes + hints + `─╯`.
  const hints = renderHints(content.hints ?? [], total - 4, theme);
  const bottom = `╰${"─".repeat(total - 3 - visibleWidth(hints))}${hints}─╯`;

  const body = content.lines.map((line, index) => {
    const gutter = content.gutter?.[index] ?? " ";
    return `│ ${truncateToWidth(line, inner, "…", true)}${gutter}│`;
  });

  const padding = content.topPadding === false ? [] : [`│${" ".repeat(total - 2)}│`];
  return [`╭─${top}╮`, ...padding, ...body, bottom];
}

export interface MmrScrollbarInput {
  /** Number of rows in the whole list. */
  readonly total: number;
  /** Rows of the list on screen, which is also the scrollbar's height. */
  readonly visible: number;
  /** Index of the first row on screen. */
  readonly offset: number;
}

/**
 * A one-column scrollbar, one cell per visible row, or `undefined` when the
 * whole list fits. The thumb is a block in the theme's `scrollbarThumb`
 * color on a `scrollbarTrack` background; its ends are drawn in eighths of
 * a cell, so its size and position follow the list closely.
 */
export function renderMmrScrollbar(input: MmrScrollbarInput, theme: MmrFrameTheme): string[] | undefined {
  const { total, visible } = input;
  if (visible <= 0 || total <= visible) return undefined;
  const units = visible * 8;
  const thumb = Math.max(8, Math.round((visible / total) * units));
  const offset = Math.min(Math.max(0, input.offset), total - visible);
  const start = Math.round((offset / (total - visible)) * (units - thumb));
  const end = start + thumb;
  const paint = (glyph: string, inverse = false) =>
    theme.style(glyph, { fg: "scrollbarThumb", bg: theme.colors.scrollbarTrack, inverse });

  const cells: string[] = [];
  for (let row = 0; row < visible; row++) {
    const cellStart = row * 8;
    const cellEnd = cellStart + 8;
    const covered = Math.max(0, Math.min(end, cellEnd) - Math.max(start, cellStart));
    if (covered === 8) cells.push(paint("█"));
    else if (covered === 0) cells.push(paint(" "));
    // The thumb starts inside this cell and fills its lower part.
    else if (start > cellStart) cells.push(paint(LOWER_BLOCKS[covered]));
    // The thumb ends inside this cell and fills its upper part: draw the
    // uncovered lower part in the track color by swapping the colors.
    else cells.push(paint(LOWER_BLOCKS[8 - covered], true));
  }
  return cells;
}
