import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { type EditorTheme, matchesKey, type TUI, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import type { MmrThreadStatus } from "../../ampi-core/thread-status.js";
import { mmrTuiWithEditorMaxLines } from "../pi-compat/editor-height.js";
import { type MmrShortcutHelp, renderMmrShortcutHelp } from "./help.js";

/**
 * The prompt box: Pi's prompt editor inside a rounded frame whose borders
 * carry the session's state.
 *
 * ```text
 * ╭────────────────────────────────────── $0.02 ─ medium ─╮
 * │ prompt text, wrapped like Pi's editor                 │
 * │                                                       │
 * │                                                       │
 * ╰ ≈ Streaming 23 tok · Enter to steer ─── /repo (main) ─╯
 * ```
 *
 * - Top border, right: the session cost so far (dim) and the active ampi
 *   mode in its colour.
 * - Bottom border, left: the turn status (a wave glyph while busy, the
 *   label, a detail such as a token count or tool name, then a key hint).
 * - Bottom border, right: the working directory and git branch (dim). When
 *   the borders get crowded the path is shortened from the left first; the
 *   status keeps its room.
 * - The text area keeps at least 3 rows, grows with its content up to a
 *   third of the terminal height, then scrolls with the cursor.
 * - The shortcuts help, while open, sits above the text with a rule under
 *   it. The box grows by its height; when that would pass the maximum, the
 *   text area shrinks to one row and the help drops its note, then rows.
 *
 * Text editing, wrapping, scrolling, autocomplete and Pi's app keys come
 * from Pi's `CustomEditor`. The box adds Alt+Enter for a newline, Esc to
 * clear the prompt (or close the help), and Backspace on an empty prompt to
 * take queued messages back. Any key that reaches the box closes the help;
 * one that is not Esc then does what it always does.
 */

/** Truecolor of each mode label. Other modes (`free`, unknown keys) use the border colour. */
export const MMR_MODE_LABEL_COLORS: Readonly<Record<string, readonly [number, number, number]>> = {
  low: [0xff, 0xd7, 0x00],
  medium: [0x3d, 0xff, 0xa6],
  high: [0x3d, 0xd4, 0xff],
  ultra: [0xd8, 0xb3, 0xff],
};

/** Glyphs the status slot cycles through while a turn runs, one step per {@link MMR_STATUS_WAVE_INTERVAL_MS}. */
export const MMR_STATUS_WAVE_FRAMES = ["∼", "≈", "≋"] as const;
export const MMR_STATUS_WAVE_INTERVAL_MS = 200;

/** Text rows the box shows at least, even when empty. */
export const MMR_PROMPT_BOX_MIN_ROWS = 3;

/** Most text rows the box grows to before its text scrolls: a third of the terminal height. */
export function mmrPromptBoxMaxRows(terminalRows: number): number {
  return Math.max(MMR_PROMPT_BOX_MIN_ROWS, Math.floor(terminalRows / 3));
}

/** Session cost for the gauge: `$····` while unknown, three decimals below one cent, two above. */
export function formatMmrSessionCost(cost: number | undefined): string {
  if (cost === undefined || !Number.isFinite(cost)) return "$····";
  return cost > 0 && cost < 0.01 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(2)}`;
}

/** What the borders show. */
export interface MmrPromptBoxSlots {
  /** Active ampi mode key; no label when undefined. */
  mode?: string;
  /** Formatted cost gauge; hidden when undefined. */
  gauge?: string;
  status: MmrThreadStatus;
  /** Step of the wave glyph shown while `status.busy`. */
  waveFrame: number;
  /** Working directory with the branch in parentheses; hidden when undefined. */
  location?: string;
  /** An overlay is open over the prompt: the frame is drawn dim. */
  overlay: boolean;
}

export type MmrPromptBoxTheme = Pick<Theme, "fg">;

export interface MmrPromptBoxHost {
  slots(): MmrPromptBoxSlots;
  theme(): MmrPromptBoxTheme;
  /** Called after Backspace took the queued messages back into the prompt. */
  dequeued?(): void;
  /** What the shortcuts help lists; read on each render while it is open. */
  help?(): MmrShortcutHelp;
}

type Token = "border" | "dim" | "muted" | "accent" | "error" | "warning";
interface Segment {
  text: string;
  token?: Token;
  /** Raw truecolor foreground; wins over `token`. */
  rgb?: readonly [number, number, number];
}

const segmenter = new Intl.Segmenter();

/** Cut plain `text` to `width` columns, ending in "…" when something was cut. */
function clipEnd(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  if (width <= 0) return "";
  let out = "";
  for (const { segment } of segmenter.segment(text)) {
    if (visibleWidth(out + segment) > width - 1) break;
    out += segment;
  }
  return `${out}…`;
}

/** Cut plain `text` to `width` columns from the left, starting with "…" when something was cut. */
function clipStart(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  if (width <= 0) return "";
  const graphemes = [...segmenter.segment(text)].map((entry) => entry.segment);
  let out = "";
  for (let index = graphemes.length - 1; index >= 0; index--) {
    if (visibleWidth(graphemes[index] + out) > width - 1) break;
    out = graphemes[index] + out;
  }
  return `…${out}`;
}

function widthOf(segments: readonly Segment[]): number {
  return segments.reduce((sum, segment) => sum + visibleWidth(segment.text), 0);
}

/** Cut a run of segments to `width` columns, ending in "…" in the style of the last kept segment. */
function clipSegments(segments: readonly Segment[], width: number): Segment[] {
  if (widthOf(segments) <= width) return [...segments];
  const out: Segment[] = [];
  let used = 0;
  for (const segment of segments) {
    const room = width - used;
    const segmentWidth = visibleWidth(segment.text);
    if (segmentWidth < room) {
      out.push(segment);
      used += segmentWidth;
      continue;
    }
    out.push({ ...segment, text: clipEnd(segment.text, room) });
    break;
  }
  return out;
}

function paint(segments: readonly Segment[], theme: MmrPromptBoxTheme, overlay: boolean): string {
  // Neighbours in the same style share one colour run.
  const runs: Segment[] = [];
  for (const segment of segments) {
    const last = runs.at(-1);
    if (last && !last.rgb && !segment.rgb && last.token === segment.token) runs[runs.length - 1] = { ...last, text: last.text + segment.text };
    else runs.push(segment);
  }
  const body = runs
    .map((segment) => {
      if (segment.text.length === 0) return "";
      if (segment.rgb) return `\x1b[38;2;${segment.rgb.join(";")}m${segment.text}\x1b[39m`;
      // Under an overlay the whole line is dim; theme colours would end the dim early.
      if (overlay || !segment.token) return segment.text;
      return theme.fg(segment.token, segment.text);
    })
    .join("");
  return overlay ? `\x1b[2m${body}\x1b[22m` : body;
}

function line(text: string): Segment {
  return { text, token: "border" };
}

function modeSegment(mode: string): Segment {
  const rgb = MMR_MODE_LABEL_COLORS[mode];
  return rgb ? { text: mode, rgb } : { text: mode, token: "border" };
}

/** `╭───── $0.02 ─ medium ─╮`. The gauge goes first when the border is too narrow, then the mode. */
export function renderMmrPromptBoxTopBorder(width: number, slots: MmrPromptBoxSlots, theme: MmrPromptBoxTheme): string {
  if (width < 2) return paint([line("─".repeat(Math.max(0, width)))], theme, slots.overlay);
  const room = width - 3; // corners and at least one line cell
  const gauge: Segment[] = slots.gauge ? [line(" "), { text: slots.gauge, token: "dim" }, line(" ─")] : [];
  const mode: Segment[] = slots.mode ? [line(" "), modeSegment(slots.mode), line(" ─")] : [];
  let right = [...gauge, ...mode];
  if (widthOf(right) > room) right = mode;
  if (widthOf(right) > room) right = [];
  const fill = width - 2 - widthOf(right);
  return paint([line(`╭${"─".repeat(fill)}`), ...right, line("╮")], theme, slots.overlay);
}

function labelToken(status: MmrThreadStatus): Token {
  if (status.phase === "error") return "error";
  if (status.phase === "waitingApproval") return "warning";
  return "muted";
}

/** The status slot's segments: wave glyph while busy, label, detail, then the hint. */
function statusSegments(status: MmrThreadStatus, waveFrame: number): Segment[] {
  const out: Segment[] = [];
  if (status.busy && status.label) {
    const glyph = MMR_STATUS_WAVE_FRAMES[((waveFrame % 3) + 3) % 3];
    out.push({ text: glyph, token: "accent" }, { text: " " });
  }
  if (status.label) out.push({ text: status.label, token: labelToken(status) });
  if (status.detail) out.push({ text: ` ${status.detail}`, token: "muted" });
  if (status.hint) {
    if (out.length > 0) out.push({ text: " · ", token: "dim" });
    out.push({ text: status.hint, token: "dim" });
  }
  return out;
}

/** `╰ ≈ Thinking 23 tok ───── /repo (main) ─╯`. The path shrinks first, then disappears; then the status is cut. */
export function renderMmrPromptBoxBottomBorder(width: number, slots: MmrPromptBoxSlots, theme: MmrPromptBoxTheme): string {
  if (width < 2) return paint([line("─".repeat(Math.max(0, width)))], theme, slots.overlay);
  const room = width - 3; // corners and at least one line cell
  let status = statusSegments(slots.status, slots.waveFrame);
  if (status.length > 0) status = clipSegments(status, room - 2);
  const left: Segment[] = status.length > 0 ? [line(" "), ...status, line(" ")] : [];
  const leftWidth = widthOf(left);
  let right: Segment[] = [];
  const pathRoom = room - leftWidth - 3; // " " before, " ─" after
  // Keep at least "…" and one character of the path.
  if (slots.location && pathRoom >= 2) {
    right = [line(" "), { text: clipStart(slots.location, pathRoom), token: "dim" }, line(" ─")];
  }
  const fill = width - 2 - leftWidth - widthOf(right);
  return paint([line("╰"), ...left, line("─".repeat(fill)), ...right, line("╯")], theme, slots.overlay);
}

/** Marks the bottom border in the lines Pi's editor renders, so the box can find it. */
const BOTTOM_MARK = "\u0000ampi-prompt-box-bottom";

export class MmrPromptBox extends CustomEditor {
  private readonly host: MmrPromptBoxHost;
  private textRows = 0;
  private innerRows = MMR_PROMPT_BOX_MIN_ROWS;
  private helpRows = 0;
  private helpOpen = false;
  private height = 0;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, host: MmrPromptBoxHost) {
    super(tui, theme, keybindings, { paddingX: 1 });
    this.host = host;
  }

  /** The box keeps its one-column padding; Pi copies its own editor's padding onto a new editor. */
  override setPaddingX(_padding: number): void {}

  /** Rows the last render drew: frame, help, text rows and an open autocomplete list. */
  renderedHeight(): number {
    return this.height;
  }

  isHelpOpen(): boolean {
    return this.helpOpen;
  }

  /** Open or close the shortcuts help. The caller redraws. */
  setHelpOpen(open: boolean): void {
    this.helpOpen = open;
  }

  protected override renderTopBorder(): string {
    return "";
  }

  protected override renderBottomBorder(): string {
    return BOTTOM_MARK;
  }

  /** Run `action` while Pi's editor sees the box's maximum text rows (for its scrolling and page keys). */
  private withBoxRows<T>(action: () => T): T {
    const tui = this.tui;
    this.tui = mmrTuiWithEditorMaxLines(tui, mmrPromptBoxMaxRows(tui.terminal.rows));
    try {
      return action();
    } finally {
      this.tui = tui;
    }
  }

  override render(width: number): string[] {
    if (width < 4) {
      // No room for a frame: the text rows and any autocomplete list alone.
      const out = super.render(width).filter((row, index) => index > 0 && row !== BOTTOM_MARK);
      this.helpRows = 0;
      this.height = out.length;
      return out;
    }
    const slots = this.host.slots();
    const hostTheme = this.host.theme();
    // Pi colours its editor border for a `!` shell command; the frame keeps that cue.
    const bashMode = this.getText().trimStart().startsWith("!");
    const theme: MmrPromptBoxTheme = bashMode
      ? { fg: (token, text) => (token === "border" ? this.borderColor(text) : hostTheme.fg(token, text)) }
      : hostTheme;
    const lines = this.withBoxRows(() => super.render(width - 2));
    const bottom = lines.indexOf(BOTTOM_MARK);
    const text = lines.slice(1, bottom);
    const autocomplete = lines.slice(bottom + 1);
    this.textRows = text.length;
    // The help belongs to an empty prompt: text set from elsewhere (the
    // external editor, a dequeue) closes it.
    if (this.helpOpen && this.getText().length > 0) this.helpOpen = false;
    const maxRows = mmrPromptBoxMaxRows(this.tui.terminal.rows);
    const help = this.helpOpen && this.host.help ? renderMmrShortcutHelp(this.host.help(), width - 4, theme, maxRows - 1) : [];
    this.helpRows = help.length;
    this.innerRows = Math.max(text.length, Math.min(MMR_PROMPT_BOX_MIN_ROWS, maxRows - help.length));

    const side = paint([line("│")], theme, slots.overlay);
    const blank = " ".repeat(width - 2);
    const out = [renderMmrPromptBoxTopBorder(width, slots, theme)];
    for (const row of help) out.push(`${side} ${row} ${side}`);
    for (let row = 0; row < this.innerRows; row++) out.push(`${side}${text[row] ?? blank}${side}`);
    out.push(renderMmrPromptBoxBottomBorder(width, slots, theme));
    for (const row of autocomplete) out.push(` ${row} `);
    this.height = out.length;
    return out;
  }

  override handleMouse(event: TuiMouseEvent) {
    // Pi's editor counts rows from its own top border and has no side borders,
    // help or padding rows; the autocomplete list sits below the padding rows.
    let y = event.y - this.helpRows;
    if (y > this.innerRows) y -= this.innerRows - this.textRows;
    return super.handleMouse({ ...event, x: event.x - 1, y, width: event.width - 2 });
  }

  override handleInput(data: string): void {
    if (this.helpOpen) {
      this.helpOpen = false;
      if (matchesKey(data, "escape")) return;
    }
    // Pi queues a follow-up message on Alt+Enter; the box inserts a newline,
    // like Shift+Enter and Ctrl+J.
    if (matchesKey(data, "alt+enter")) {
      this.insertTextAtCursor("\n");
      return;
    }
    if (matchesKey(data, "escape") && !this.isShowingAutocomplete() && this.getText().length > 0) {
      this.setText("");
      return;
    }
    if (matchesKey(data, "backspace") && this.getText().length === 0 && this.host.slots().status.queued > 0) {
      const dequeue = this.actionHandlers.get("app.message.dequeue");
      if (dequeue) {
        dequeue();
        this.host.dequeued?.();
        return;
      }
    }
    this.withBoxRows(() => super.handleInput(data));
  }
}
