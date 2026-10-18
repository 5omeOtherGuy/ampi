import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { MmrCommandDefinition } from "../../ampi-core/command-registry.js";
import { formatMmrKeyChord, formatMmrKeymapJsonc, type MmrResolvedKeymap, parseMmrKeyChord } from "../../ampi-core/keymap.js";
import { displayMmrCommandKeys } from "../editor/help.js";
import { displayMmrKeyChord, formatMmrKeyCombo } from "../keys/dispatcher.js";
import { type MmrFrameHint, type MmrFrameTheme, mmrFrameInnerWidth, renderMmrFrame, renderMmrScrollbar } from "../ui/frame.js";

/**
 * The Help & Keymap screen and the keymap as JSONC: two read-only, scrolling
 * overlays in the shared frame, centred, 100 columns wide (or the terminal
 * width less four) and two rows shorter than the terminal.
 *
 * ```
 * ╭─ ampi — Help & Keymap ─────────────────────────────────────────╮
 * │                                                                │
 * │  Editor Shortcuts                                             █│
 * │     Enter                Send the prompt; while a turn runs,  █│
 * │                          steer it                             █│
 * │     …                                                          │
 * │  Scrolling & Navigation                                        │
 * │     Home                 Jump to the start of the transcript   │
 * │     …                                                          │
 * │  Command Palette Commands                                      │
 * │     ampi help        —        List every key and command with  │
 * ╰─────────────────────────────────── Esc close · ↑↓/j/k scroll ─╯
 * ```
 *
 * - Editor Shortcuts: the prompt box's own keys (newline, Esc, Backspace on
 *   an empty prompt, `@`, the leader, ampi-core's Alt+D) and the Pi editing
 *   keys that still reach the editor, with the keys Pi's keybindings give
 *   them. A Pi key that ampi always takes first is left out.
 * - Scrolling & Navigation: the bound navigation commands from the registry,
 *   then Pi's transcript keys while the transcript scrolls (fullscreen mode).
 * - Command Palette Commands: every registry command, sorted by category and
 *   name, with its keys in effect or "—" when it has none.
 * - ↑/↓ or k/j scroll a row, PageUp/PageDown a page less one row; Esc closes.
 */

export const MMR_HELP_KEYMAP_TITLE = "ampi — Help & Keymap";
export const MMR_KEYMAP_JSON_TITLE = "ampi — Keymap (JSONC)";
/** Preferred width; Pi narrows the box to the terminal width less four. */
export const MMR_HELP_KEYMAP_WIDTH = 100;
/** Shown under a key column for a command that has no key. */
export const MMR_HELP_UNBOUND = "—";
/**
 * Registry commands listed under Scrolling & Navigation when they have a key.
 * Commands that move through the transcript belong here.
 */
export const MMR_HELP_NAVIGATION_COMMAND_IDS: readonly string[] = ["thread.scrollToTop", "thread.scrollToBottom"];

const HINTS: readonly MmrFrameHint[] = [
  { key: "Esc", text: "close" },
  { key: "↑↓/j/k", text: "scroll" },
];
/** Terminal height assumed before Pi reports one. */
const DEFAULT_TERMINAL_ROWS = 24;
/** Rows of the frame besides its content: two borders and the padding row. */
const FRAME_ROWS = 3;
const HEADER_INDENT = 1;
const ROW_INDENT = 4;
const COLUMN_GAP = 2;
/** Below this many columns for a row, a command's keys go under its name instead of in a column of their own. */
const THREE_COLUMN_MIN = 56;

export interface MmrHelpKeymapRow {
  /** Keys in display form, joined with ", "; {@link MMR_HELP_UNBOUND} for an unbound command. */
  readonly keys: string;
  readonly text: string;
  /** For a registry command: its category and name, shown before the keys. */
  readonly command?: { readonly noun: string; readonly verb: string };
}

export interface MmrHelpKeymapSection {
  readonly title: string;
  readonly rows: readonly MmrHelpKeymapRow[];
}

export interface MmrHelpKeymapSources {
  /** The keymap in effect. */
  readonly keymap: Pick<MmrResolvedKeymap, "bindings" | "byChord" | "leader">;
  /** Registered commands, in registration order. */
  readonly commands: readonly Pick<MmrCommandDefinition, "id" | "noun" | "verb" | "description" | "availability">[];
  /** Pi's keys for one of its keybinding ids, as Pi writes them (`ctrl+a`, `pageUp`). */
  readonly piKeys: (id: string) => readonly string[];
  /** ampi-core is loaded, so Alt+D switches the mode's thinking preset. */
  readonly modeKeys: boolean;
  /** The transcript scrolls (Pi's fullscreen mode), so Pi's transcript keys apply. */
  readonly scrolling: boolean;
}

/** A row from fixed keys and Pi keybinding ids; left out when it ends up with no key. */
interface KeyRow {
  readonly fixed?: readonly string[];
  readonly pi?: readonly string[];
  readonly text: string;
}

const EDITOR_ROWS: readonly KeyRow[] = [
  { pi: ["tui.input.submit"], text: "Send the prompt; while a turn runs, steer it" },
  { fixed: ["Alt+Enter"], pi: ["tui.input.newLine"], text: "Insert a newline" },
  { fixed: ["Esc"], text: "Clear the prompt, or close the shortcuts help" },
  { fixed: ["Backspace"], text: "On an empty prompt, take queued messages back for editing" },
  {
    pi: ["tui.editor.cursorUp", "tui.editor.cursorDown"],
    text: "Move between lines; on an empty prompt, step through earlier prompts",
  },
  { pi: ["tui.editor.historyPrevious", "tui.editor.historyNext"], text: "Step through earlier prompts" },
  { pi: ["tui.editor.cursorLeft", "tui.editor.cursorRight"], text: "Move the cursor left or right" },
  { pi: ["tui.editor.cursorWordLeft", "tui.editor.cursorWordRight"], text: "Move one word left or right" },
  { pi: ["tui.editor.cursorLineStart"], text: "Go to the start of the line" },
  { pi: ["tui.editor.cursorLineEnd"], text: "Go to the end of the line" },
  { pi: ["tui.editor.jumpForward", "tui.editor.jumpBackward"], text: "Jump forward or back to the next character you type" },
  { pi: ["tui.editor.deleteCharBackward"], text: "Delete the character before the cursor" },
  { pi: ["tui.editor.deleteCharForward"], text: "Delete the character under the cursor" },
  { pi: ["tui.editor.deleteWordBackward"], text: "Delete the word before the cursor" },
  { pi: ["tui.editor.deleteWordForward"], text: "Delete the word after the cursor" },
  { pi: ["tui.editor.deleteToLineStart"], text: "Delete to the start of the line" },
  { pi: ["tui.editor.deleteToLineEnd"], text: "Delete to the end of the line" },
  { pi: ["tui.editor.yank"], text: "Paste the text deleted last" },
  { pi: ["tui.editor.yankPop"], text: "Right after a paste, swap in an earlier deletion" },
  { pi: ["tui.editor.undo"], text: "Undo the last edit" },
  { pi: ["app.clipboard.pasteImage"], text: "Paste an image or files from the clipboard" },
  { pi: ["tui.input.tab"], text: "Complete a file path or command" },
  { fixed: ["@"], text: "Mention files" },
];

const SCROLL_ROWS: readonly KeyRow[] = [
  { pi: ["tui.altScreen.pageUp", "tui.altScreen.pageDown"], text: "Scroll the transcript a page up or down" },
  { pi: ["tui.altScreen.halfPageUp", "tui.altScreen.halfPageDown"], text: "Scroll the transcript half a page" },
  { pi: ["tui.altScreen.lineUp", "tui.altScreen.lineDown"], text: "Scroll the transcript one line" },
  { pi: ["tui.altScreen.previousPrompt", "tui.altScreen.nextPrompt"], text: "Jump to the previous or next prompt" },
  { pi: ["tui.altScreen.top", "tui.altScreen.bottom"], text: "Scroll to the top or bottom of the transcript" },
  { pi: ["tui.altScreen.search"], text: "Search the transcript" },
  { fixed: ["Mouse wheel"], text: "Scroll the transcript" },
];

/** ampi-core's thinking key, a Pi shortcut that wins over Pi's editor. */
const THINKING_KEY = "alt+d";

/**
 * Keys ampi takes before Pi's editor sees them: the leader, ampi-core's
 * thinking key, and the first key of every chord whose command has no
 * availability check, which therefore always runs.
 */
function takenKeys(sources: MmrHelpKeymapSources): Set<string> {
  const always = new Set(sources.commands.filter((command) => !command.availability).map((command) => command.id));
  const taken = new Set([formatMmrKeyCombo(sources.keymap.leader)]);
  if (sources.modeKeys) taken.add(THINKING_KEY);
  for (const [chord, id] of sources.keymap.byChord) if (always.has(id)) taken.add(chord.split(" ")[0]);
  return taken;
}

function keyRow(row: KeyRow, sources: MmrHelpKeymapSources, taken: ReadonlySet<string>): MmrHelpKeymapRow | undefined {
  const keys = [...(row.fixed ?? [])];
  for (const id of row.pi ?? []) {
    for (const key of sources.piKeys(id)) {
      const parsed = parseMmrKeyChord(key);
      const canonical = "error" in parsed ? key : formatMmrKeyChord(parsed);
      if (taken.has(canonical)) continue;
      const shown = displayMmrKeyChord(canonical);
      if (!keys.includes(shown)) keys.push(shown);
    }
  }
  return keys.length > 0 ? { keys: keys.join(", "), text: row.text } : undefined;
}

function keyRows(rows: readonly KeyRow[], sources: MmrHelpKeymapSources, taken: ReadonlySet<string>): MmrHelpKeymapRow[] {
  return rows.flatMap((row) => keyRow(row, sources, taken) ?? []);
}

/** The three sections of the help screen; Scrolling & Navigation is left out when it has no row. */
export function buildMmrHelpKeymapSections(sources: MmrHelpKeymapSources): MmrHelpKeymapSection[] {
  const { keymap } = sources;
  const taken = takenKeys(sources);
  const editor = keyRows(EDITOR_ROWS, sources, taken);
  if (sources.modeKeys) editor.push({ keys: displayMmrKeyChord(THINKING_KEY), text: "Toggle the thinking preset of the active mode" });
  editor.push({ keys: formatMmrKeyCombo(keymap.leader, "display"), text: "Leader key; a popup lists the keys that can follow" });

  const navigation: MmrHelpKeymapRow[] = [];
  for (const id of MMR_HELP_NAVIGATION_COMMAND_IDS) {
    const command = sources.commands.find((candidate) => candidate.id === id);
    const keys = command ? displayMmrCommandKeys(keymap, id, ", ") : "";
    if (command && keys) navigation.push({ keys, text: command.description });
  }
  if (sources.scrolling) navigation.push(...keyRows(SCROLL_ROWS, sources, taken));

  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const commands = [...sources.commands]
    .sort((a, b) => order(a.noun, b.noun) || order(a.verb, b.verb))
    .map((command) => ({
      keys: displayMmrCommandKeys(keymap, command.id, ", ") || MMR_HELP_UNBOUND,
      text: command.description,
      command: { noun: command.noun, verb: command.verb },
    }));

  return [
    { title: "Editor Shortcuts", rows: editor },
    ...(navigation.length > 0 ? [{ title: "Scrolling & Navigation", rows: navigation }] : []),
    { title: "Command Palette Commands", rows: commands },
  ];
}

/** One table cell: segments that each start on a new line and wrap within the column. */
type Cell = readonly string[];

/**
 * Lay out one row of cells in columns of the given widths, `indent` columns
 * in. The last cell takes what is left of `width`.
 */
function layoutRow(row: readonly Cell[], widths: readonly number[], indent: number, width: number): string[] {
  const last = Math.max(1, width - indent - widths.reduce((sum, columnWidth) => sum + columnWidth + COLUMN_GAP, 0));
  const all = [...widths, last];
  const columns = row.map((cell, index) => cell.flatMap((segment) => wrapTextWithAnsi(segment, all[index])));
  const height = Math.max(1, ...columns.map((column) => column.length));
  const lines: string[] = [];
  for (let line = 0; line < height; line++) {
    const parts = columns.map((column, index) =>
      index < columns.length - 1 ? `${truncateToWidth(column[line] ?? "", all[index], "", true)}${" ".repeat(COLUMN_GAP)}` : (column[line] ?? ""),
    );
    lines.push(`${" ".repeat(indent)}${parts.join("")}`.trimEnd());
  }
  return lines;
}

/** Width of a column: its widest cell segment, at most `share` of `room`, at least one column. */
function columnWidth(cells: readonly Cell[], room: number, share: number): number {
  const widest = Math.max(1, ...cells.flatMap((cell) => cell.map((segment) => visibleWidth(segment))));
  return Math.max(1, Math.min(widest, Math.floor(room * share)));
}

/**
 * Render the sections into lines `width` columns wide at most (the frame's
 * inner width): bold section titles, a blank line between sections, keys in
 * the accent color. Key rows share one key column. Command rows show the
 * category (dim) and name, the keys and the description in three columns, or
 * on a narrow screen the keys under the name.
 */
export function renderMmrHelpKeymapLines(
  sections: readonly MmrHelpKeymapSection[],
  width: number,
  theme: MmrFrameTheme,
): string[] {
  const room = Math.max(1, width - ROW_INDENT);
  const keyCell = (row: MmrHelpKeymapRow): string =>
    row.keys === MMR_HELP_UNBOUND ? theme.fg("dim", row.keys) : theme.fg("accent", row.keys);
  const keyRowsAll = sections.flatMap((section) => section.rows.filter((row) => !row.command));
  const keyWidth = columnWidth(
    keyRowsAll.map((row) => [row.keys]),
    room,
    0.4,
  );
  const commandRows = sections.flatMap((section) => section.rows.filter((row) => row.command));
  const threeColumns = room >= THREE_COLUMN_MIN;
  const nameOf = (row: MmrHelpKeymapRow) => `${theme.fg("dim", row.command?.noun ?? "")} ${row.command?.verb ?? ""}`;
  const nameWidth = columnWidth(
    commandRows.map((row) => [nameOf(row), ...(threeColumns ? [] : [row.keys])]),
    room,
    threeColumns ? 0.34 : 0.45,
  );
  const commandKeyWidth = columnWidth(
    commandRows.map((row) => [row.keys]),
    room,
    0.2,
  );

  const lines: string[] = [];
  for (const [index, section] of sections.entries()) {
    if (index > 0) lines.push("");
    lines.push(`${" ".repeat(HEADER_INDENT)}${theme.bold(section.title)}`);
    for (const row of section.rows) {
      if (!row.command) {
        lines.push(...layoutRow([[keyCell(row)], [row.text]], [keyWidth], ROW_INDENT, width));
      } else if (threeColumns) {
        lines.push(...layoutRow([[nameOf(row)], [keyCell(row)], [row.text]], [nameWidth, commandKeyWidth], ROW_INDENT, width));
      } else {
        lines.push(...layoutRow([[nameOf(row), keyCell(row)], [row.text]], [nameWidth], ROW_INDENT, width));
      }
    }
  }
  return lines;
}

/** Index of the `//` that starts a line comment, outside strings, or -1. */
function commentStart(line: string): number {
  let inString = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (inString) {
      if (character === "\\") index++;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === "/" && line[index + 1] === "/") return index;
  }
  return -1;
}

/** Narrowest room a wrapped comment keeps beside its code before it moves under it. */
const MIN_COMMENT_WIDTH = 16;

/**
 * One JSONC line, its comment dim. A comment too long for the line wraps onto
 * lines of their own that start with `//` too, so copied text stays JSONC.
 */
function jsoncLines(line: string, width: number, theme: MmrFrameTheme): string[] {
  const start = commentStart(line);
  if (start < 0) return [line];
  const code = line.slice(0, start).trimEnd();
  const comment = line.slice(start + 2).trim();
  if (visibleWidth(line) <= width) return [`${code} ${theme.fg("dim", `// ${comment}`)}`];
  const besideCode = visibleWidth(code) + 1;
  const column = width - besideCode - 3 >= MIN_COMMENT_WIDTH ? besideCode : ROW_INDENT;
  const chunks = wrapTextWithAnsi(comment, Math.max(1, width - column - 3));
  const commentLines = chunks.map((chunk) => `${" ".repeat(column)}${theme.fg("dim", `// ${chunk}`)}`);
  if (column === ROW_INDENT) return [code, ...commentLines];
  return [`${code} ${commentLines[0].trimStart()}`, ...commentLines.slice(1)];
}

/** Says where the JSONC goes; shown above it. */
export const MMR_KEYMAP_JSON_NOTE =
  'To change a key, copy its line under "ampi.keymap" in Pi\'s settings (~/.pi/agent/settings.json, or .pi/settings.json in a project) and edit it: a key string, an array of key strings, or null to unbind. Then run /reload.';

/** The keymap screen's lines: the note, a blank line, then the JSONC. */
export function renderMmrKeymapJsonLines(jsonc: string, width: number, theme: MmrFrameTheme): string[] {
  const note = wrapTextWithAnsi(MMR_KEYMAP_JSON_NOTE, width).map((line) => theme.fg("dim", line));
  return [...note, "", ...jsonc.split("\n").flatMap((line) => jsoncLines(line, width, theme))];
}

export interface MmrScrollOverlayOptions {
  readonly title: string;
  /** The content lines for a given inner width. */
  readonly content: (width: number, theme: MmrFrameTheme) => readonly string[];
  readonly theme: MmrFrameTheme;
  /** Called once, when the overlay closes. */
  readonly onClose: () => void;
  /** Terminal height; the box is two rows shorter. */
  readonly terminalRows?: () => number | undefined;
}

/** A read-only, scrolling text box in the shared frame. */
export class MmrScrollOverlay implements Component {
  private readonly options: MmrScrollOverlayOptions;
  private cache: { width: number; lines: readonly string[] } | undefined;
  private offset = 0;
  /** Rows a page moves and the largest offset, as of the last render. */
  private page = 1;
  private maxOffset = Number.POSITIVE_INFINITY;
  private closed = false;

  constructor(options: MmrScrollOverlayOptions) {
    this.options = options;
  }

  /** Index of the first content line on screen. */
  getOffset(): number {
    return this.offset;
  }

  handleInput(data: string): void {
    if (this.closed) return;
    const keybindings = getKeybindings();
    if (keybindings.matches(data, "tui.select.cancel")) {
      this.closed = true;
      this.options.onClose();
    } else if (keybindings.matches(data, "tui.select.up") || matchesKey(data, "k")) {
      this.scroll(-1);
    } else if (keybindings.matches(data, "tui.select.down") || matchesKey(data, "j")) {
      this.scroll(1);
    } else if (keybindings.matches(data, "tui.select.pageUp")) {
      this.scroll(-this.page);
    } else if (keybindings.matches(data, "tui.select.pageDown")) {
      this.scroll(this.page);
    }
  }

  invalidate(): void {
    this.cache = undefined;
  }

  render(width: number): string[] {
    const inner = mmrFrameInnerWidth(width);
    if (this.cache?.width !== inner) this.cache = { width: inner, lines: this.options.content(inner, this.options.theme) };
    const lines = this.cache.lines;
    const rows = this.options.terminalRows?.() ?? DEFAULT_TERMINAL_ROWS;
    const visible = Math.max(1, rows - 2 - FRAME_ROWS);
    // A page keeps the last row of the previous one on screen.
    this.page = Math.max(1, visible - 1);
    this.maxOffset = Math.max(0, lines.length - visible);
    this.offset = Math.min(this.offset, this.maxOffset);
    const body = Array.from({ length: visible }, (_, index) => lines[this.offset + index] ?? "");
    const scrollbar = renderMmrScrollbar({ total: lines.length, visible, offset: this.offset }, this.options.theme);
    return renderMmrFrame({ title: this.options.title, hints: HINTS, lines: body, gutter: scrollbar }, width, this.options.theme);
  }

  private scroll(delta: number): void {
    this.offset = Math.max(0, Math.min(this.maxOffset, this.offset + delta));
  }
}

function openScrollOverlay(ctx: ExtensionContext, title: string, content: MmrScrollOverlayOptions["content"]): Promise<void> {
  return ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) =>
      new MmrScrollOverlay({ title, content, theme, onClose: () => done(undefined), terminalRows: () => tui?.terminal?.rows }),
    {
      overlay: true,
      overlayOptions: { width: MMR_HELP_KEYMAP_WIDTH, margin: { left: 2, right: 2, top: 1, bottom: 1 }, anchor: "center" },
    },
  );
}

/** Open the Help & Keymap screen; resolves when it closes. */
export function openMmrHelpKeymap(ctx: ExtensionContext, sources: MmrHelpKeymapSources): Promise<void> {
  const sections = buildMmrHelpKeymapSections(sources);
  return openScrollOverlay(ctx, MMR_HELP_KEYMAP_TITLE, (width, theme) => renderMmrHelpKeymapLines(sections, width, theme));
}

/** Open the keymap in effect as JSONC; resolves when it closes. */
export function openMmrKeymapJson(
  ctx: ExtensionContext,
  commands: readonly Pick<MmrCommandDefinition, "id" | "description">[],
  keymap: MmrResolvedKeymap,
): Promise<void> {
  const jsonc = formatMmrKeymapJsonc(commands, keymap);
  return openScrollOverlay(ctx, MMR_KEYMAP_JSON_TITLE, (width, theme) => renderMmrKeymapJsonLines(jsonc, width, theme));
}
