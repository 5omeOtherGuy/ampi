import { type ExtensionContext, getMarkdownTheme, type SessionInfo, SessionManager, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  getKeybindings,
  Input,
  indexedColor,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { dedupeMmrSessionsById, listMmrSessionsInScope, type MmrSessionScope } from "../../ampi-core/session-catalog.js";
import { getMmrThreadIndex, type MmrThreadRecord } from "../../ampi-core/thread-index.js";
import { renderMmrUserMessage } from "../transcript/messages.js";
import { fitMmrText, type MmrFrameHint, type MmrFrameTheme, mmrFrameInnerWidth, renderMmrFrame, renderMmrScrollbar } from "../ui/frame.js";

/**
 * The thread picker: a capturing overlay that fills the screen less two
 * columns and rows on each side, lists Pi sessions with how long ago each
 * was last active, and shows the selected one's latest exchanges beside or
 * below the list.
 *
 * ```
 * ╭─ Switch Thread ──────────────────────────────────────────────────────────╮
 * │                                                                          │
 * │ > parser                            ╭──────────────────────────────────╮ │
 * │                                     │                                  │ │
 * │   (current) Rename the…    2d ago   │          Thread Preview          │ │
 * │   Parser cleanup          51m ago   │                                  │ │
 * │                                     │  ┃ Rename the parser           █ │ │
 * │                                     │                                  │ │
 * │                                     ╰──────────────────────────────────╯ │
 * │                                                                          │
 * ╰────────── Alt+W/Ctrl+T all workspaces · Alt+A show archived · Esc close ─╯
 * ```
 *
 * - Two variants share the component: "Switch Thread" marks the current
 *   session with a green "(current) " and lists it first; "Mention Thread"
 *   leaves the current session out. Either hands the selected row back on
 *   Enter; the caller decides what to do with it.
 * - Rows: two columns of indent, the session's title (its name, else its
 *   first message on one line, else "untitled", cut with an ellipsis), and
 *   the time since its last activity at the right ("51m ago"). Newest
 *   first. The selected row is black text on the theme's `warning` color.
 * - Typing filters by title, ignoring case. ↑/↓ or Ctrl+P/Ctrl+N move,
 *   PageUp/PageDown scroll the preview, Enter picks, Esc closes.
 * - Alt+W or Ctrl+T switches between this workspace's sessions and every
 *   session; Alt+A shows archived sessions too. The bottom border names
 *   what each key does next.
 * - The preview box shows the last few exchanges: user messages with the
 *   transcript's bar, assistant text rendered as Markdown with Pi's
 *   Markdown theme. It opens scrolled to the end. It sits to the right of
 *   the list on a terminal 120 columns or wider, and under it otherwise.
 */

export type MmrThreadPickerVariant = "switch" | "mention";

export const MMR_THREAD_PICKER_TITLES: Readonly<Record<MmrThreadPickerVariant, string>> = {
  switch: "Switch Thread",
  mention: "Mention Thread",
};
/** Narrowest box (terminal width less four) that puts the preview beside the list. */
export const MMR_THREAD_PICKER_SIDE_BY_SIDE_WIDTH = 116;
/** Exchanges (a user message and the replies after it) the preview shows. */
export const MMR_THREAD_PREVIEW_EXCHANGES = 3;

/** Rows Pi leaves free above and below the box, and columns on each side. */
const MARGIN = 2;
/** Terminal height assumed when Pi does not report one. */
const DEFAULT_TERMINAL_ROWS = 24;
/** Content rows that are not list rows: the filter row, the blank row under it and the blank last row. */
const FIXED_ROWS = 3;
/** Preview box rows besides the scrolling text: two borders, the title row and a blank row around it, and the bottom padding. */
const PREVIEW_CHROME_ROWS = 6;
const INDENT = 2;
/** Columns kept free after the relative time. */
const TRAILING = 2;
const CURRENT_PREFIX = "(current) ";
const PREVIEW_TITLE = "Thread Preview";
const NO_THREADS = "No Threads";
const NO_PREVIEW = "No messages to preview";
const UNTITLED = "untitled";
/** Text on the selected row: the terminal's black, on the theme's `warning` color. */
const SELECTED_TEXT = indexedColor(0);
const SCOPE_KEY = "Alt+W/Ctrl+T";
const SCOPE_HINT: Readonly<Record<MmrSessionScope, string>> = { workspace: "all workspaces", all: "filter by workspace" };

/** The theme methods the picker uses; Pi's `Theme` provides them. */
export type MmrThreadPickerTheme = MmrFrameTheme & Pick<Theme, "italic">;

export interface MmrThreadPickerRow {
  readonly id: string;
  /** The session file. */
  readonly path: string;
  readonly title: string;
  /** Last activity. */
  readonly modified: Date;
  /** Whether this is the session the picker was opened from. */
  readonly current: boolean;
}

export interface MmrThreadPreviewMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

/** A session's title: its name, else its first message on one line, else "untitled". */
export function mmrThreadTitle(session: Pick<SessionInfo, "name" | "firstMessage">): string {
  return session.name?.trim() || session.firstMessage.replace(/\s+/g, " ").trim() || UNTITLED;
}

/** How long ago `then` was, as "now", "51m ago", "3h ago", "2d ago", "4mo ago" or "1y ago". */
export function formatMmrRelativeTime(then: Date, now: number): string {
  const minutes = Math.floor(Math.max(0, now - then.getTime()) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export interface MmrThreadPickerListOptions {
  readonly variant: MmrThreadPickerVariant;
  /** The thread index's records, for the archived flags. */
  readonly threads: Readonly<Record<string, MmrThreadRecord>>;
  /** List archived sessions too. */
  readonly showArchived: boolean;
  /** The session the picker was opened from. */
  readonly currentId?: string;
}

/**
 * The picker's rows for a listing: one per session id, archived sessions
 * left out unless asked for, newest activity first. The switch variant
 * puts the current session first (archived or not); the mention variant
 * leaves it out.
 */
export function buildMmrThreadPickerRows(
  sessions: readonly SessionInfo[],
  options: MmrThreadPickerListOptions,
): MmrThreadPickerRow[] {
  const isArchived = (id: string) => (Object.hasOwn(options.threads, id) ? options.threads[id]?.archived !== undefined : false);
  const rows = dedupeMmrSessionsById(sessions)
    .filter((session) => {
      if (session.id === options.currentId) return options.variant === "switch";
      return options.showArchived || !isArchived(session.id);
    })
    .map((session) => ({
      id: session.id,
      path: session.path,
      title: mmrThreadTitle(session),
      modified: session.modified,
      current: session.id === options.currentId,
    }));
  return rows.sort(
    (a, b) => Number(b.current) - Number(a.current) || b.modified.getTime() - a.modified.getTime() || a.id.localeCompare(b.id),
  );
}

function messageText(content: unknown, separator: string): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text.trim())
    .filter((text) => text.length > 0)
    .join(separator);
}

/**
 * The last `exchanges` exchanges of a session's messages: user messages and
 * the assistant text after them. Tool calls, tool results, thinking and
 * other entries are left out.
 */
export function lastMmrThreadExchanges(messages: readonly unknown[], exchanges = MMR_THREAD_PREVIEW_EXCHANGES): MmrThreadPreviewMessage[] {
  const shown: MmrThreadPreviewMessage[] = [];
  for (const message of messages) {
    const { role, content } = (message ?? {}) as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") continue;
    const text = messageText(content, role === "user" ? "\n" : "\n\n");
    if (text) shown.push({ role, text });
  }
  let start = shown.length;
  for (let users = 0; start > 0 && users < exchanges; ) {
    start--;
    if (shown[start]?.role === "user") users++;
  }
  return shown.slice(start);
}

/**
 * Read the preview of the session stored in `path`, following its current
 * branch. `SessionManager.open` migrates a file in an older session format
 * and writes it back, as every Pi load does.
 */
export function readMmrThreadPreview(path: string): MmrThreadPreviewMessage[] {
  return lastMmrThreadExchanges(SessionManager.open(path).buildSessionContext().messages);
}

/** `line` cut or padded to exactly `width` columns. */
function fit(line: string, width: number): string {
  const cut = truncateToWidth(line, width, "…", true);
  return `${cut}${" ".repeat(Math.max(0, width - visibleWidth(cut)))}`;
}

/** `text` centred in `width` columns; an odd spare column goes to the right. */
function centre(text: string, width: number): string {
  return " ".repeat(Math.max(0, Math.floor((width - visibleWidth(text)) / 2))) + text;
}

export interface MmrThreadPickerOptions {
  readonly variant: MmrThreadPickerVariant;
  readonly theme: MmrThreadPickerTheme;
  /** Renders assistant text in the preview. */
  readonly markdownTheme: MarkdownTheme;
  /** This workspace's sessions; the picker opens on them. */
  readonly sessions: readonly SessionInfo[];
  /** Lists a scope's sessions the first time the picker switches to it. */
  readonly load: (scope: MmrSessionScope) => Promise<readonly SessionInfo[]>;
  /** The thread index's records, for the archived flags. */
  readonly threads: Readonly<Record<string, MmrThreadRecord>>;
  readonly currentId?: string;
  /** Current time, for the relative times. */
  readonly now: () => number;
  /** The selected session's latest exchanges. */
  readonly loadPreview: (row: MmrThreadPickerRow) => readonly MmrThreadPreviewMessage[];
  /** Called once, with the row picked or `undefined` when the picker was dismissed. */
  readonly onClose: (row: MmrThreadPickerRow | undefined) => void;
  /** Terminal height; the box is four rows shorter. */
  readonly terminalRows?: () => number | undefined;
  /** Asks Pi to draw again, after a scope has loaded. */
  readonly requestRender?: () => void;
  /** Receives a scope or preview that failed to load. */
  readonly onError?: (error: unknown) => void;
}

export class MmrThreadPicker implements Component, Focusable {
  private readonly input = new Input({ prompt: "> " });
  private readonly options: MmrThreadPickerOptions;
  private readonly loaded = new Map<MmrSessionScope, readonly SessionInfo[]>();
  private readonly previews = new Map<string, string[]>();
  private scope: MmrSessionScope = "workspace";
  private showArchived = false;
  private rows: readonly MmrThreadPickerRow[] = [];
  private query = "";
  private selected = 0;
  private offset = 0;
  /** First preview line shown, or `undefined` to follow the end. */
  private previewOffset: number | undefined;
  /** Scrolling rows of the preview box, and its last scroll position, as last drawn; for PageUp/PageDown. */
  private previewRows = 1;
  private previewLast = 0;
  private closed = false;

  constructor(options: MmrThreadPickerOptions) {
    this.options = options;
    this.loaded.set("workspace", options.sessions);
    this.refilter();
  }

  get focused(): boolean {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  getScope(): MmrSessionScope {
    return this.scope;
  }

  isShowingArchived(): boolean {
    return this.showArchived;
  }

  getQuery(): string {
    return this.query;
  }

  /** The rows the filter matches, in list order. */
  getRows(): readonly MmrThreadPickerRow[] {
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
    } else if (matchesKey(data, "alt+a")) {
      this.showArchived = !this.showArchived;
      this.refilter();
    } else if (keybindings.matches(data, "tui.select.up") || matchesKey(data, "ctrl+p")) {
      this.move(-1);
    } else if (keybindings.matches(data, "tui.select.down") || matchesKey(data, "ctrl+n")) {
      this.move(1);
    } else if (keybindings.matches(data, "tui.select.pageUp")) {
      this.scrollPreview(-1);
    } else if (keybindings.matches(data, "tui.select.pageDown")) {
      this.scrollPreview(1);
    } else if (keybindings.matches(data, "tui.select.confirm")) {
      const row = this.rows[this.selected];
      if (row) this.close(row);
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
    this.previews.clear();
  }

  render(width: number): string[] {
    const inner = mmrFrameInnerWidth(width);
    const height = Math.max(FIXED_ROWS + 4, (this.options.terminalRows?.() ?? DEFAULT_TERMINAL_ROWS) - 2 * MARGIN);
    const contentRows = height - 3;
    const lines: string[] = [];
    const gutter: string[] = [];

    if (width >= MMR_THREAD_PICKER_SIDE_BY_SIDE_WIDTH) {
      // List on the left, preview box on the right from the filter row down.
      const listWidth = Math.floor(inner / 2);
      const list = this.renderList(listWidth - 1, contentRows - FIXED_ROWS);
      const preview = this.renderPreview(inner - listWidth, contentRows - 1);
      const rows = list.lines.map((line, index) => `${fit(line, listWidth - 1)}${list.scrollbar?.[index] ?? " "}`);
      const left = [this.renderFilter(listWidth), "", ...rows];
      for (let index = 0; index < contentRows; index++) lines.push(`${fit(left[index] ?? "", listWidth)}${preview[index] ?? ""}`);
    } else {
      // Preview box under the list; on a short terminal only the list.
      const room = contentRows - FIXED_ROWS;
      const previewHeight = room >= PREVIEW_CHROME_ROWS + 2 ? Math.ceil(room / 2) + 1 : 0;
      const list = this.renderList(inner, previewHeight > 0 ? room - previewHeight - 1 : room);
      lines.push(this.renderFilter(inner), "", ...list.lines);
      gutter.push(" ", " ", ...(list.scrollbar ?? []));
      if (previewHeight > 0) lines.push("", ...this.renderPreview(inner, previewHeight));
      lines.push("");
    }

    const hints: MmrFrameHint[] = [
      { key: SCOPE_KEY, text: SCOPE_HINT[this.scope] },
      { key: "Alt+A", text: this.showArchived ? "hide archived" : "show archived" },
      { key: "Esc", text: "close" },
    ];
    return renderMmrFrame({ title: MMR_THREAD_PICKER_TITLES[this.options.variant], hints, lines, gutter }, width, this.options.theme);
  }

  private renderFilter(width: number): string {
    return this.input.render(width)[0] ?? "";
  }

  /** `count` list rows `width` columns wide, and a scrollbar for them when the list does not fit. */
  private renderList(width: number, count: number): { lines: string[]; scrollbar: string[] | undefined } {
    const visible = Math.max(1, count);
    if (this.selected < this.offset) this.offset = this.selected;
    if (this.selected >= this.offset + visible) this.offset = this.selected - visible + 1;
    this.offset = Math.max(0, Math.min(this.offset, this.rows.length - visible));

    const lines: string[] = [];
    for (let index = 0; index < visible; index++) {
      const row = this.rows[this.offset + index];
      lines.push(row ? this.renderRow(row, width, this.offset + index === this.selected) : "");
    }
    if (this.rows.length === 0 && this.loaded.has(this.scope)) {
      const theme = this.options.theme;
      lines[0] = theme.fg("dim", NO_THREADS);
      // The way out of an empty workspace: every workspace's sessions.
      if (this.scope === "workspace" && visible > 2) {
        lines[2] = `${theme.fg("dim", theme.fg("accent", SCOPE_KEY))}${theme.fg("dim", ` ${SCOPE_HINT.workspace}`)}`;
      }
    }
    const scrollbar = renderMmrScrollbar({ total: this.rows.length, visible, offset: this.offset }, this.options.theme);
    return { lines, scrollbar };
  }

  private renderRow(row: MmrThreadPickerRow, width: number, selected: boolean): string {
    const theme = this.options.theme;
    const time = formatMmrRelativeTime(row.modified, this.options.now());
    const prefix = row.current ? CURRENT_PREFIX : "";
    const room = width - INDENT - visibleWidth(prefix) - visibleWidth(time) - TRAILING - 1;
    const title = fitMmrText(row.title, Math.max(0, room));
    const gap = Math.max(1, room - visibleWidth(title) + 1);
    const text = (value: string) => (selected ? theme.style(value, { fg: SELECTED_TEXT }) : value);
    const line = `${" ".repeat(INDENT)}${prefix ? theme.fg("success", prefix) : ""}${text(title)}${" ".repeat(gap)}${text(time)}${" ".repeat(TRAILING)}`;
    const cut = fit(line, width);
    return selected ? theme.style(cut, { bg: theme.colors.warning }) : cut;
  }

  /** The preview box, `width` columns by `height` rows. */
  private renderPreview(width: number, height: number): string[] {
    const theme = this.options.theme;
    const inside = width - 2;
    if (height < PREVIEW_CHROME_ROWS + 1 || inside < 8) return [];
    const side = (content: string) => `│${fit(content, inside)}│`;
    const textWidth = inside - 4;
    const scrolling = height - PREVIEW_CHROME_ROWS;
    this.previewRows = scrolling;
    this.previewLast = 0;

    const row = this.rows[this.selected];
    const content = row ? this.previewLines(row, textWidth) : [];
    const body: string[] = [];
    if (content.length === 0) {
      body.push(side(theme.fg("dim", centre(NO_PREVIEW, inside))));
      while (body.length < scrolling) body.push(side(""));
    } else {
      const last = Math.max(0, content.length - scrolling);
      this.previewLast = last;
      const offset = Math.min(this.previewOffset ?? last, last);
      this.previewOffset = this.previewOffset === undefined || offset >= last ? undefined : offset;
      const scrollbar = renderMmrScrollbar({ total: content.length, visible: scrolling, offset }, theme);
      for (let index = 0; index < scrolling; index++) {
        body.push(`│  ${fit(content[offset + index] ?? "", textWidth)}${scrollbar?.[index] ?? " "} │`);
      }
    }
    return [
      `╭${"─".repeat(inside)}╮`,
      side(""),
      side(centre(PREVIEW_TITLE, inside)),
      side(""),
      ...body,
      side(""),
      `╰${"─".repeat(inside)}╯`,
    ];
  }

  /** The selected session's preview drawn `width` columns wide, starting with a blank line; empty when it has no messages. */
  private previewLines(row: MmrThreadPickerRow, width: number): string[] {
    const key = `${row.path}\n${row.modified.getTime()}\n${width}`;
    const cached = this.previews.get(key);
    if (cached) return cached;
    let messages: readonly MmrThreadPreviewMessage[] = [];
    try {
      messages = this.options.loadPreview(row);
    } catch (error) {
      this.options.onError?.(error);
    }
    const lines: string[] = [];
    for (const message of messages) {
      if (message.role === "user") {
        lines.push(...renderMmrUserMessage(message.text, width, 0, this.options.theme));
      } else {
        const rendered = new Markdown(message.text, 0, 0, this.options.markdownTheme).render(width);
        while (rendered.length > 0 && rendered[rendered.length - 1]?.trim() === "") rendered.pop();
        lines.push("", ...rendered);
      }
    }
    this.previews.set(key, lines);
    return lines;
  }

  private toggleScope(): void {
    const next: MmrSessionScope = this.scope === "workspace" ? "all" : "workspace";
    this.scope = next;
    // Until a scope has loaded its list is empty, so Enter cannot pick a
    // session from the scope the footer no longer offers.
    this.refilter();
    if (this.loaded.has(next)) return;
    this.options.load(next).then(
      (sessions) => {
        this.loaded.set(next, sessions);
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
    const rows = buildMmrThreadPickerRows(this.loaded.get(this.scope) ?? [], {
      variant: this.options.variant,
      threads: this.options.threads,
      showArchived: this.showArchived,
      currentId: this.options.currentId,
    });
    this.rows = needle.length === 0 ? rows : rows.filter((row) => row.title.toLowerCase().includes(needle));
    this.selected = 0;
    this.offset = 0;
    this.previewOffset = undefined;
  }

  private move(delta: number): void {
    const next = Math.max(0, Math.min(this.rows.length - 1, this.selected + delta));
    if (next !== this.selected) this.previewOffset = undefined;
    this.selected = next;
  }

  private scrollPreview(direction: -1 | 1): void {
    // A page less one row, so a line of context stays on screen.
    const offset = (this.previewOffset ?? this.previewLast) + direction * Math.max(1, this.previewRows - 1);
    this.previewOffset = offset >= this.previewLast ? undefined : Math.max(0, offset);
  }

  private close(row: MmrThreadPickerRow | undefined): void {
    this.closed = true;
    this.options.onClose(row);
  }
}

export interface MmrThreadPickerSources {
  /** Lists a scope's sessions; defaults to Pi's session listing for `ctx`'s session directory. */
  readonly list?: (scope: MmrSessionScope) => Promise<readonly SessionInfo[]>;
  /** Reads a session's preview; defaults to {@link readMmrThreadPreview}. */
  readonly readPreview?: (row: MmrThreadPickerRow) => readonly MmrThreadPreviewMessage[];
  readonly now?: () => number;
}

/**
 * Open the thread picker for `ctx`'s workspace as a capturing overlay.
 * Resolves with the row picked, after the overlay has closed and focus is
 * back where it was, or with `undefined` when it was dismissed. Without
 * `ampi-threads` every session counts as unarchived.
 */
export async function openMmrThreadPicker(
  ctx: ExtensionContext,
  variant: MmrThreadPickerVariant,
  sources: MmrThreadPickerSources = {},
): Promise<MmrThreadPickerRow | undefined> {
  const list = sources.list ?? ((scope: MmrSessionScope) => listMmrSessionsInScope(ctx.sessionManager, scope));
  const index = getMmrThreadIndex();
  const [sessions, threads] = await Promise.all([list("workspace"), index ? index.list() : {}]);
  const report = (error: unknown) =>
    ctx.ui.notify(`Could not read the sessions: ${error instanceof Error ? error.message : String(error)}`, "error");
  return ctx.ui.custom<MmrThreadPickerRow | undefined>(
    (tui, theme, _keybindings, done) =>
      new MmrThreadPicker({
        variant,
        theme,
        markdownTheme: getMarkdownTheme(),
        sessions,
        load: list,
        threads,
        currentId: ctx.sessionManager.getSessionId(),
        now: sources.now ?? Date.now,
        loadPreview: sources.readPreview ?? ((row) => readMmrThreadPreview(row.path)),
        onClose: done,
        terminalRows: () => tui?.terminal?.rows,
        requestRender: () => tui?.requestRender(),
        onError: report,
      }),
    {
      overlay: true,
      overlayOptions: { width: "100%", maxHeight: "100%", margin: MARGIN, anchor: "center" },
    },
  );
}
