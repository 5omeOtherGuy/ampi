/**
 * What stays in the terminal after you quit: ampi's small mark with the
 * session title and the working directory beside it.
 *
 * ```text
 *    ●  ·  ·
 *  •         ·   Parser rename
 * •     ●     ·  /work/repo
 *  ·         ·
 *    ·  ·  ·
 * ```
 *
 * On an interactive quit (Ctrl+C Ctrl+C, Ctrl+D, `/quit`) Pi stops its UI,
 * hands the terminal back, then runs `session_shutdown` handlers and prints
 * its own "To resume this session: pi --session <id>" line. The summary is
 * printed from that handler, so it lands in the normal scrollback right
 * above Pi's resume line, which stays the only resume command. When Pi shuts
 * down on a signal it runs the handlers while its UI still owns the screen;
 * the terminal is then still in raw mode and the summary is skipped.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { mmrSessionTitle } from "./title-notify.js";
import { renderMmrRestingMark } from "./welcome.js";

/** Columns between the mark and the text beside it. */
const GAP = "  ";

export interface MmrQuitSummaryInput {
  readonly title: string;
  readonly cwd: string;
  readonly theme: Pick<Theme, "fg" | "bold">;
}

/** The summary's lines: the resting mark, with the title and the path beside its middle rows. */
export function formatMmrQuitSummary({ title, cwd, theme }: MmrQuitSummaryInput): string[] {
  const mark = renderMmrRestingMark(theme);
  const text = [theme.bold(title), theme.fg("dim", cwd)];
  const top = Math.floor((mark.length - text.length) / 2);
  return mark.map((row, index) => {
    const beside = text[index - top];
    return beside === undefined ? row.trimEnd() : `${row}${GAP}${beside}`;
  });
}

export interface MmrQuitSummaryOptions {
  readonly write?: (text: string) => void;
  /** Whether Pi has handed the terminal back; by default, stdin is a terminal no longer in raw mode. */
  readonly terminalReleased?: () => boolean;
}

function terminalReleased(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true && !process.stdin.isRaw;
}

/** Print the summary for `ctx`'s session once Pi has left its UI; true when it was printed. */
export function printMmrQuitSummary(ctx: ExtensionContext, options: MmrQuitSummaryOptions = {}): boolean {
  if (!(options.terminalReleased ?? terminalReleased)()) return false;
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const lines = formatMmrQuitSummary({ title: mmrSessionTitle(ctx), cwd: ctx.sessionManager.getCwd(), theme: ctx.ui.theme });
  try {
    write(`${lines.join("\n")}\n`);
  } catch {
    // The terminal went away; there is nothing left to show.
  }
  return true;
}
