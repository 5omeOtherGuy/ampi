import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  getKeybindings,
  Input,
  indexedColor,
  matchesKey,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  type MmrCommandAvailability,
  type MmrCommandDefinition,
  type MmrRankedCommand,
  rankMmrCommands,
} from "../../ampi-core/command-registry.js";
import { fitMmrText, type MmrFrameTheme, mmrFrameInnerWidth, renderMmrFrame, renderMmrScrollbar } from "../ui/frame.js";

/**
 * The command palette: a capturing overlay that lists commands and runs the
 * one picked.
 *
 * ```
 * ╭─ Command Palette ──────────────────────────────────────╮
 * │                                                        │
 * │ > sw                                                   │
 * │                                                        │
 * │         thread  switch                       Ctrl+X s  │  selected row
 * │           mode  use low                               █│  scrollbar
 * │             pi  /resume                                │
 * ╰────────────────────────────────────────────────────────╯
 * ```
 *
 * - 80 columns wide and centred, or the terminal width less four. The list
 *   shows 15 rows, fewer on a terminal too short for them.
 * - A row is the command's noun right-aligned in the first 15 columns (dim),
 *   its verb (bold) and its key (bold, accent color) at the right edge. Rows
 *   never wrap: a long verb is cut with an ellipsis. The selected row is
 *   black text on the theme's `warning` color (yellow in Pi's themes).
 * - Typing edits the filter. Commands are ranked with `rankMmrCommands`:
 *   available ones first, best match first; unavailable ones last, marked
 *   "(unavailable)". When an unavailable row is selected, its reason shows
 *   under the list.
 * - ↑/↓ or Ctrl+P/Ctrl+N move the selection without wrapping, Enter closes
 *   the palette and hands back the selected command, Esc closes it.
 * - Availability is checked once, when the palette opens, so a command that
 *   needs the prompt focused is judged before the palette takes focus.
 * - Pi draws overlays over the screen as it is; the palette cannot dim the
 *   transcript and prompt behind it.
 */

export interface MmrPaletteItem {
  readonly command: MmrCommandDefinition;
  /** The command's key in display form, e.g. `Ctrl+X s`. */
  readonly key?: string;
}

export interface MmrPaletteOptions {
  readonly items: readonly MmrPaletteItem[];
  /** Passed to each command's availability check. Without it, every command counts as available. */
  readonly ctx?: ExtensionContext;
  readonly theme: MmrFrameTheme;
  /** Called once, with the command to run or `undefined` when the palette was dismissed. */
  readonly onClose: (command: MmrCommandDefinition | undefined) => void;
  /** Terminal height, to shorten the list on short terminals. */
  readonly terminalRows?: () => number | undefined;
}

export const MMR_PALETTE_TITLE = "Command Palette";
/** Preferred width; Pi narrows the box to the terminal width less four. */
export const MMR_PALETTE_WIDTH = 80;
/** List rows shown on a terminal tall enough for them. */
export const MMR_PALETTE_ROWS = 15;
/** Rows besides the list: two borders, the padding row, the filter row and the blank row under it. */
const CHROME_ROWS = 5;
/** With the frame's one-column padding, the category ends 15 columns after the left border. */
const CATEGORY_WIDTH = 14;
const UNAVAILABLE_SUFFIX = " (unavailable)";
/** Text on the selected row: the terminal's black, on the theme's `warning` color. */
const SELECTED_TEXT = indexedColor(0);

function noMatchText(query: string): string {
  return query.trim().length === 0 ? "No commands to show" : `No command matches "${query.trim()}"`;
}

function centre(text: string, width: number, theme: MmrFrameTheme): string {
  const shown = fitMmrText(text, width);
  return `${" ".repeat(Math.max(0, Math.floor((width - visibleWidth(shown)) / 2)))}${theme.fg("dim", shown)}`;
}

export class MmrPalette implements Component, Focusable {
  private readonly input = new Input({ prompt: "> " });
  private readonly items: readonly MmrPaletteItem[];
  private readonly ctx: ExtensionContext | undefined;
  private readonly theme: MmrFrameTheme;
  private readonly onClose: MmrPaletteOptions["onClose"];
  private readonly terminalRows: () => number | undefined;
  private readonly keys = new Map<MmrCommandDefinition, string | undefined>();
  private rows: MmrRankedCommand[] = [];
  private query = "";
  private selected = 0;
  private offset = 0;
  private closed = false;

  constructor(options: MmrPaletteOptions) {
    this.items = options.items;
    this.ctx = options.ctx;
    this.theme = options.theme;
    this.onClose = options.onClose;
    this.terminalRows = options.terminalRows ?? (() => undefined);
    for (const item of this.items) this.keys.set(item.command, item.key);
    this.rank();
  }

  get focused(): boolean {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  /** The filter text. */
  getQuery(): string {
    return this.query;
  }

  /** The rows the filter currently matches, in display order. */
  getRows(): readonly MmrRankedCommand[] {
    return this.rows;
  }

  getSelectedIndex(): number {
    return this.selected;
  }

  handleInput(data: string): void {
    if (this.closed) return;
    const keybindings = getKeybindings();
    if (keybindings.matches(data, "tui.select.cancel")) {
      this.close(undefined);
    } else if (keybindings.matches(data, "tui.select.up") || matchesKey(data, "ctrl+p")) {
      this.move(-1);
    } else if (keybindings.matches(data, "tui.select.down") || matchesKey(data, "ctrl+n")) {
      this.move(1);
    } else if (keybindings.matches(data, "tui.select.confirm")) {
      const row = this.rows[this.selected];
      if (row?.state === "available") this.close(row.command);
    } else {
      this.input.handleInput(data);
      this.refilter();
    }
  }

  private refilter(): void {
    if (this.input.getValue() !== this.query) {
      this.query = this.input.getValue();
      this.rank();
    }
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    const inner = mmrFrameInnerWidth(width);
    const terminalRows = this.terminalRows();
    const visible =
      terminalRows === undefined ? MMR_PALETTE_ROWS : Math.max(1, Math.min(MMR_PALETTE_ROWS, terminalRows - CHROME_ROWS));
    const current = this.rows[this.selected];
    const reason = current?.state === "unavailable" && visible >= 3 ? current.reason : undefined;
    const listRows = reason ? visible - 2 : visible;

    if (this.selected < this.offset) this.offset = this.selected;
    if (this.selected >= this.offset + listRows) this.offset = this.selected - listRows + 1;
    this.offset = Math.max(0, Math.min(this.offset, this.rows.length - listRows));

    const slots: string[] = [];
    for (let index = 0; index < listRows; index++) {
      const row = this.rows[this.offset + index];
      slots.push(row ? this.renderRow(row, inner, this.offset + index === this.selected) : "");
    }
    if (this.rows.length === 0) slots[0] = centre(noMatchText(this.query), inner, this.theme);
    if (reason) slots.push("", centre(reason, inner, this.theme));

    const scrollbar = renderMmrScrollbar({ total: this.rows.length, visible: listRows, offset: this.offset }, this.theme);
    return renderMmrFrame(
      {
        title: MMR_PALETTE_TITLE,
        lines: [this.input.render(inner)[0] ?? "", "", ...slots],
        gutter: scrollbar ? [" ", " ", ...scrollbar] : undefined,
      },
      width,
      this.theme,
    );
  }

  private rank(): void {
    this.rows = rankMmrCommands(
      this.items.map((item) => item.command),
      this.query,
      { ctx: this.ctx },
    );
    this.selected = 0;
    this.offset = 0;
  }

  private move(delta: number): void {
    this.selected = Math.max(0, Math.min(this.rows.length - 1, this.selected + delta));
  }

  private close(command: MmrCommandDefinition | undefined): void {
    this.closed = true;
    this.onClose(command);
  }

  private renderRow(row: MmrRankedCommand, inner: number, selected: boolean): string {
    const theme = this.theme;
    const unavailable = row.state === "unavailable";
    const key = this.keys.get(row.command);
    const categoryWidth = Math.min(CATEGORY_WIDTH, Math.floor(inner / 3));
    const category = fitMmrText(row.command.noun, categoryWidth);
    const keyWidth = key ? visibleWidth(key) + 1 : 0;
    const labelRoom = Math.max(0, inner - categoryWidth - 2 - (key ? keyWidth + 2 : 0));
    const label = fitMmrText(`${row.command.verb}${unavailable ? UNAVAILABLE_SUFFIX : ""}`, labelRoom);
    const gap = Math.max(0, inner - categoryWidth - 2 - visibleWidth(label) - keyWidth);

    const styledCategory = selected ? theme.style(category, { fg: SELECTED_TEXT }) : theme.fg("dim", category);
    const styledLabel = selected
      ? theme.style(label, { fg: SELECTED_TEXT, bold: true })
      : theme.bold(unavailable ? theme.fg("dim", label) : label);
    const styledKey = key ? `${theme.bold(theme.fg("accent", key))} ` : "";
    const line = `${" ".repeat(categoryWidth - visibleWidth(category))}${styledCategory}  ${styledLabel}${" ".repeat(gap)}${styledKey}`;
    return selected ? theme.style(line, { bg: theme.colors.warning }) : line;
  }
}

/**
 * Fix each item's availability as it is now, so ranking inside the open
 * palette reports what was true when it opened.
 */
function snapshotItems(items: readonly MmrPaletteItem[], ctx: ExtensionContext): {
  items: MmrPaletteItem[];
  originals: Map<MmrCommandDefinition, MmrCommandDefinition>;
} {
  const originals = new Map<MmrCommandDefinition, MmrCommandDefinition>();
  const snapshot = items.map((item) => {
    let availability: MmrCommandAvailability | undefined;
    try {
      availability = item.command.availability?.(ctx);
    } catch (error) {
      availability = {
        state: "unavailable",
        reason: `availability check failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const fixed = availability;
    const command: MmrCommandDefinition = { ...item.command, availability: fixed ? () => fixed : undefined };
    originals.set(command, item.command);
    return { ...item, command };
  });
  return { items: snapshot, originals };
}

/**
 * Open the palette as a capturing overlay. Resolves with the command picked,
 * after the overlay has closed and focus is back where it was, or with
 * `undefined` when the palette was dismissed.
 */
export async function openMmrPalette(
  ctx: ExtensionContext,
  items: readonly MmrPaletteItem[],
): Promise<MmrCommandDefinition | undefined> {
  const snapshot = snapshotItems(items, ctx);
  const picked = await ctx.ui.custom<MmrCommandDefinition | undefined>(
    (tui, theme, _keybindings, done) =>
      new MmrPalette({
        items: snapshot.items,
        ctx,
        theme,
        onClose: done,
        terminalRows: () => tui?.terminal?.rows,
      }),
    { overlay: true, overlayOptions: { width: MMR_PALETTE_WIDTH, margin: { left: 2, right: 2 }, anchor: "center" } },
  );
  return picked ? snapshot.originals.get(picked) : undefined;
}
