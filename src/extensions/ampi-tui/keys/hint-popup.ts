import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { MmrKeyHintRow } from "./dispatcher.js";

/**
 * The "then" popup shown while a chord prefix is pending:
 *
 * ```
 * ╭─ Ctrl+C then ─────╮
 * │ Ctrl+C  Quit      │
 * │    Esc cancel     │
 * ╰───────────────────╯
 * ```
 *
 * It is 48 columns wide, or the terminal width when that is smaller, and is
 * drawn by the host as a non-capturing overlay at the bottom right, just
 * above the prompt. Rows that do not fit end in an ellipsis.
 */

export interface MmrHintPopupTheme {
  fg(color: "accent" | "warning" | "dim", text: string): string;
  bold(text: string): string;
}

export interface MmrHintPopupContent {
  readonly prefix: string;
  readonly rows: readonly MmrKeyHintRow[];
}

const KEY_GAP = 2;
const CANCEL_KEY = "Esc";
const CANCEL_LABEL = "cancel";

const plainTheme: MmrHintPopupTheme = { fg: (_color, text) => text, bold: (text) => text };

function emptyLine(prefix: string): string {
  return `Nothing is bound to ${prefix} yet`;
}

/** Popup width in columns. Pi narrows it to fit a smaller terminal. */
export const MMR_HINT_POPUP_WIDTH = 48;

/** Render the popup into exactly `width` columns (minimum 12). */
export function renderMmrHintPopup(content: MmrHintPopupContent, width: number, theme: MmrHintPopupTheme = plainTheme): string[] {
  const total = Math.max(12, width);
  const inner = total - 4;
  const keyWidth = Math.max(0, ...content.rows.map((row) => visibleWidth(row.key)));
  const line = (text: string) => `│ ${truncateToWidth(text, inner, "…", true)} │`;

  const title = `${theme.bold(theme.fg("warning", content.prefix))} ${theme.fg("dim", "then")}`;
  const titleText = truncateToWidth(` ${title} `, total - 3, "…");
  const top = `╭─${titleText}${"─".repeat(Math.max(0, total - 3 - visibleWidth(titleText)))}╮`;

  const body =
    content.rows.length === 0
      ? [line(theme.fg("dim", emptyLine(content.prefix)))]
      : content.rows.map((row) => {
          const key = theme.bold(theme.fg("accent", row.key));
          return line(`${key}${" ".repeat(keyWidth - visibleWidth(row.key) + KEY_GAP)}${row.description}`);
        });

  const cancelWidth = visibleWidth(`${CANCEL_KEY} ${CANCEL_LABEL}`);
  const left = Math.max(0, Math.floor((inner - cancelWidth) / 2));
  const cancel = `${" ".repeat(left)}${theme.bold(theme.fg("accent", CANCEL_KEY))} ${theme.fg("dim", CANCEL_LABEL)}`;

  return [top, ...body, line(cancel), `╰${"─".repeat(total - 2)}╯`];
}
