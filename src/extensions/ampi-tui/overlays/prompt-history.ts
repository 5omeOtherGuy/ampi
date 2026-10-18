import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, getKeybindings, Input, indexedColor, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { MmrPromptHistory, MmrPromptHistoryEntry, MmrPromptHistoryScope } from "../../ampi-core/prompt-history.js";
import { fitMmrText, type MmrFrameTheme, mmrFrameInnerWidth, renderMmrFrame, renderMmrScrollbar } from "../ui/frame.js";

/**
 * The prompt history picker: a capturing overlay that lists the prompts you
 * sent, newest first, and puts the one picked back into the prompt.
 *
 * ```
 * ╭─ Prompt History ───────────────────────────────────────────────╮
 * │                                                                │
 * │ > parser                                                       │
 * │                                                                │
 * │   Rename the parser module and update its imports              │  selected row
 * │   Why does the parser drop trailing comments?                 █│  scrollbar
 * ╰────── Alt+W/Ctrl+T toggle filter · Showing: current workspace ─╯
 * ```
 *
 * - 110 columns wide and centred, or the terminal width less four. The list
 *   shows 21 rows, fewer on a terminal too short for them.
 * - One prompt per row, indented two columns; line breaks show as spaces
 *   and a long prompt is cut with an ellipsis. The selected row is black
 *   text on the theme's `warning` color (yellow in Pi's themes).
 * - Typing filters the list to the prompts that contain the text, ignoring
 *   case. ↑/↓ or Ctrl+P/Ctrl+N move without wrapping, Enter closes the
 *   picker and hands back the selected prompt, Esc closes it.
 * - Alt+W or Ctrl+T switches between this workspace's prompts and those of
 *   every workspace; the bottom border names the one shown, and keeps that
 *   name over the key hint when the box is narrow.
 */

export const MMR_PROMPT_HISTORY_TITLE = "Prompt History";
/** Preferred width; Pi narrows the box to the terminal width less four. */
export const MMR_PROMPT_HISTORY_WIDTH = 110;
/** List rows shown on a terminal tall enough for them. */
export const MMR_PROMPT_HISTORY_ROWS = 21;
/** Rows besides the list: two borders, the padding row, the filter row and the blank row under it. */
const CHROME_ROWS = 5;
/** Columns before a prompt, and kept free after it. */
const INDENT = 2;
/** Text on the selected row: the terminal's black, on the theme's `warning` color. */
const SELECTED_TEXT = indexedColor(0);
const TOGGLE_HINT = { key: "Alt+W/Ctrl+T", text: "toggle filter" } as const;
const SCOPE_LABEL: Readonly<Record<MmrPromptHistoryScope, string>> = {
  workspace: "current workspace",
  all: "all workspaces",
};

function emptyText(scope: MmrPromptHistoryScope, query: string): string {
  if (query.trim().length > 0) return `No prompt contains "${query.trim()}"`;
  return scope === "workspace" ? "No history for this workspace" : "No history in any workspace";
}

/** A prompt on one row: runs of whitespace, line breaks included, become one space. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export interface MmrPromptHistoryPickerOptions {
  readonly theme: MmrFrameTheme;
  /** This workspace's prompts, newest first; the picker opens on them. */
  readonly entries: readonly MmrPromptHistoryEntry[];
  /** Loads a scope's prompts, newest first, the first time the picker switches to it. */
  readonly load: (scope: MmrPromptHistoryScope) => Promise<readonly MmrPromptHistoryEntry[]>;
  /** Called once, with the prompt picked or `undefined` when the picker was dismissed. */
  readonly onClose: (text: string | undefined) => void;
  /** Terminal height, to shorten the list on short terminals. */
  readonly terminalRows?: () => number | undefined;
  /** Asks Pi to draw again, after a scope has loaded. */
  readonly requestRender?: () => void;
  /** Receives a scope that failed to load. */
  readonly onError?: (error: unknown) => void;
}

export class MmrPromptHistoryPicker implements Component, Focusable {
  private readonly input = new Input({ prompt: "> " });
  private readonly options: MmrPromptHistoryPickerOptions;
  private readonly loaded = new Map<MmrPromptHistoryScope, readonly MmrPromptHistoryEntry[]>();
  private scope: MmrPromptHistoryScope = "workspace";
  private rows: readonly MmrPromptHistoryEntry[] = [];
  private query = "";
  private selected = 0;
  private offset = 0;
  private closed = false;

  constructor(options: MmrPromptHistoryPickerOptions) {
    this.options = options;
    this.loaded.set("workspace", options.entries);
    this.refilter();
  }

  get focused(): boolean {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  getScope(): MmrPromptHistoryScope {
    return this.scope;
  }

  getQuery(): string {
    return this.query;
  }

  /** The prompts the filter matches, newest first. */
  getRows(): readonly MmrPromptHistoryEntry[] {
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
    } else if (matchesKey(data, "alt+w") || matchesKey(data, "ctrl+t")) {
      this.toggleScope();
    } else if (keybindings.matches(data, "tui.select.up") || matchesKey(data, "ctrl+p")) {
      this.move(-1);
    } else if (keybindings.matches(data, "tui.select.down") || matchesKey(data, "ctrl+n")) {
      this.move(1);
    } else if (keybindings.matches(data, "tui.select.confirm")) {
      const row = this.rows[this.selected];
      if (row) this.close(row.text);
    } else {
      this.input.handleInput(data);
      if (this.input.getValue() !== this.query) {
        this.query = this.input.getValue();
        this.refilter();
      }
    }
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    const inner = mmrFrameInnerWidth(width);
    const terminalRows = this.options.terminalRows?.();
    const visible =
      terminalRows === undefined
        ? MMR_PROMPT_HISTORY_ROWS
        : Math.max(1, Math.min(MMR_PROMPT_HISTORY_ROWS, terminalRows - CHROME_ROWS));

    if (this.selected < this.offset) this.offset = this.selected;
    if (this.selected >= this.offset + visible) this.offset = this.selected - visible + 1;
    this.offset = Math.max(0, Math.min(this.offset, this.rows.length - visible));

    const slots: string[] = [];
    for (let index = 0; index < visible; index++) {
      const row = this.rows[this.offset + index];
      slots.push(row ? this.renderRow(row, inner, this.offset + index === this.selected) : "");
    }
    if (this.rows.length === 0) {
      const text = fitMmrText(emptyText(this.scope, this.query), inner);
      // Centred; an odd spare column goes to the left.
      slots[0] = `${" ".repeat(Math.max(0, Math.ceil((inner - visibleWidth(text)) / 2)))}${this.options.theme.fg("dim", text)}`;
    }

    const scrollbar = renderMmrScrollbar({ total: this.rows.length, visible, offset: this.offset }, this.options.theme);
    // The frame drops hints from the end when they do not fit; the scope
    // matters more than the key hint, so a narrow box shows only the scope.
    // Both fit when their text and a space each side leave the corners free.
    const scope = { text: `Showing: ${SCOPE_LABEL[this.scope]}` };
    const both = visibleWidth(`${TOGGLE_HINT.key} ${TOGGLE_HINT.text} · ${scope.text}`) + 2 <= width - 4;
    return renderMmrFrame(
      {
        title: MMR_PROMPT_HISTORY_TITLE,
        hints: both ? [TOGGLE_HINT, scope] : [scope],
        lines: [this.input.render(inner)[0] ?? "", "", ...slots],
        gutter: scrollbar ? [" ", " ", ...scrollbar] : undefined,
      },
      width,
      this.options.theme,
    );
  }

  private toggleScope(): void {
    const next: MmrPromptHistoryScope = this.scope === "workspace" ? "all" : "workspace";
    this.scope = next;
    // Until a scope has loaded its list is empty, so Enter cannot pick a
    // prompt from the scope the footer no longer names.
    this.refilter();
    if (this.loaded.has(next)) return;
    this.options.load(next).then(
      (entries) => {
        this.loaded.set(next, entries);
        if (this.scope === next && !this.closed) {
          this.refilter();
          this.options.requestRender?.();
        }
      },
      (error: unknown) => this.options.onError?.(error),
    );
  }

  private refilter(): void {
    const needle = this.query.trim().toLowerCase();
    const entries = this.loaded.get(this.scope) ?? [];
    this.rows = needle.length === 0 ? entries : entries.filter((entry) => entry.text.toLowerCase().includes(needle));
    this.selected = 0;
    this.offset = 0;
  }

  private move(delta: number): void {
    this.selected = Math.max(0, Math.min(this.rows.length - 1, this.selected + delta));
  }

  private close(text: string | undefined): void {
    this.closed = true;
    this.options.onClose(text);
  }

  private renderRow(row: MmrPromptHistoryEntry, inner: number, selected: boolean): string {
    const theme = this.options.theme;
    const text = fitMmrText(oneLine(row.text), Math.max(0, inner - 2 * INDENT));
    const line = `${" ".repeat(INDENT)}${selected ? theme.style(text, { fg: SELECTED_TEXT }) : text}`;
    const padded = `${line}${" ".repeat(Math.max(0, inner - INDENT - visibleWidth(text)))}`;
    return selected ? theme.style(padded, { bg: theme.colors.warning }) : padded;
  }
}

/**
 * Open the prompt history picker for `ctx`'s workspace as a capturing
 * overlay. Resolves with the prompt picked, after the overlay has closed and
 * focus is back where it was, or with `undefined` when it was dismissed.
 */
export async function openMmrPromptHistory(ctx: ExtensionContext, history: MmrPromptHistory): Promise<string | undefined> {
  const entries = await history.read(ctx.cwd, "workspace");
  return ctx.ui.custom<string | undefined>(
    (tui, theme, _keybindings, done) =>
      new MmrPromptHistoryPicker({
        theme,
        entries,
        load: (scope) => history.read(ctx.cwd, scope),
        onClose: done,
        terminalRows: () => tui?.terminal?.rows,
        requestRender: () => tui?.requestRender(),
        onError: (error) =>
          ctx.ui.notify(`Could not read the prompt history: ${error instanceof Error ? error.message : String(error)}`, "error"),
      }),
    {
      overlay: true,
      overlayOptions: { width: MMR_PROMPT_HISTORY_WIDTH, margin: { left: 2, right: 2 }, anchor: "center" },
    },
  );
}
