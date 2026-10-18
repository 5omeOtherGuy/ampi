import { type ExtensionContext, parseSkillBlock, type SessionEntry, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import { withMmrLiveOffsetY } from "../pi-compat/overlay.js";
import { fitMmrText, mmrFrameInnerWidth, renderMmrFrame } from "../ui/frame.js";

/**
 * The outline: a small box at the right edge, just above the prompt box,
 * listing the headings of the last response under the message it answers.
 *
 * ```
 * ╭─ Outline ────────────────────────────────────────────────╮
 * │ ↑  Explain how the cache works                           │
 * │ Cache layout                                             │
 * │   Keys                                                   │
 * │   Eviction                                               │
 * ╰──────────────────────────────────────────────────────────╯
 * ```
 *
 * It takes no keys, so typing goes on in the prompt while it is open, and
 * it follows the session: it is read again when a response ends and after
 * the thread moves to another point of its tree.
 */

/** A Markdown heading of the response. */
export interface MmrOutlineHeading {
  /** 1 to 6. */
  readonly level: number;
  readonly text: string;
}

export interface MmrOutline {
  /** First line of the user message the response answers; missing before the first message. */
  readonly prompt?: string;
  readonly headings: readonly MmrOutlineHeading[];
}

/** The part of a session entry the outline reads: a message entry's message. */
export type MmrOutlineEntry = Pick<SessionEntry, "type"> & { readonly message?: unknown };

/** The theme methods the outline uses; Pi's `Theme` provides them. */
export type MmrOutlineTheme = Pick<Theme, "fg" | "bold" | "style" | "colors">;

export const MMR_OUTLINE_TITLE = "Outline";
/** Box width; a narrower terminal gets a box four columns narrower than itself. */
export const MMR_OUTLINE_WIDTH = 60;
/** Narrowest terminal the outline shows in. */
export const MMR_OUTLINE_MIN_COLUMNS = 40;

const EMPTY_TEXT = "No headings";
const PROMPT_MARK = "↑  ";

interface Block {
  readonly type?: unknown;
  readonly text?: unknown;
}

interface Message {
  readonly role?: unknown;
  readonly content?: unknown;
}

function messageOf(entry: MmrOutlineEntry): Message | undefined {
  if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) return undefined;
  return entry.message as Message;
}

function textBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return (content as Block[]).flatMap((block) => (block?.type === "text" && typeof block.text === "string" ? [block.text] : []));
}

/** The user message's first line with text, or a skill call's own words, as the transcript shows them. */
function promptLine(content: unknown): string | undefined {
  const text = textBlocks(content).join("");
  const skill = parseSkillBlock(text);
  const shown = skill ? skill.userMessage : text;
  const line = (shown ?? "")
    .split("\n")
    .map((part) => stripTerminalSequences(part).replace(/\s+/g, " ").trim())
    .find((part) => part.length > 0);
  return line || undefined;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const ATX = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const ATX_CLOSING = /(?:^|[ \t]+)#+[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
/** Lines that start a block quote or a list item; they never continue a paragraph into a heading. */
const OTHER_BLOCK = /^ {0,3}(?:>|[-+*](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$))/;
const INDENTED_CODE = /^(?: {4}|\t)/;

/** A backslash escape or a code span; the text between them gets its emphasis marks removed. */
const INLINE_TOKEN = /\\([!-/:-@[-`{-~])|(`+)(.+?)(?<!`)\2(?!`)/g;
const IMAGE_OR_LINK = /!?\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])/g;
const AUTOLINK = /<((?:https?|mailto):[^>\s]+)>/g;
/** Runs of `*`, `_` or `~` that open or close emphasis: next to text on one side and not inside a word. */
const EMPHASIS = /(?<![\p{L}\p{N}])[*_~]+(?=\S)|(?<=\S)[*_~]+(?![\p{L}\p{N}])/gu;

function stripMarks(text: string): string {
  return text.replace(IMAGE_OR_LINK, "$1").replace(AUTOLINK, "$1").replace(EMPHASIS, "");
}

/** Heading text without inline Markdown: emphasis and code marks go, a link keeps its label. */
function plainInline(text: string): string {
  let plain = "";
  let last = 0;
  for (const match of text.matchAll(INLINE_TOKEN)) {
    plain += stripMarks(text.slice(last, match.index));
    plain += match[1] ?? match[3].replace(/^ (.+) $/, "$1");
    last = match.index + match[0].length;
  }
  plain += stripMarks(text.slice(last));
  return stripTerminalSequences(plain).replace(/\s+/g, " ").trim();
}

/**
 * The headings of one Markdown text: ATX headings (`#` to `######` and a
 * space) and setext headings (a paragraph underlined with `=` or `-`),
 * outside fenced code blocks.
 */
function headingsOf(markdown: string): MmrOutlineHeading[] {
  const headings: MmrOutlineHeading[] = [];
  const add = (level: number, raw: string) => {
    const text = plainInline(raw);
    if (text) headings.push({ level, text });
  };
  let fence: { readonly char: string; readonly length: number } | undefined;
  let paragraph: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = undefined;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    // A backtick fence's info string has no backticks; with them the line is inline code.
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = { char: open[1][0], length: open[1].length };
      paragraph = [];
      continue;
    }
    const underline = paragraph.length > 0 ? SETEXT_UNDERLINE.exec(line) : null;
    if (underline) {
      add(underline[1][0] === "=" ? 1 : 2, paragraph.join(" "));
      paragraph = [];
      continue;
    }
    const atx = ATX.exec(line);
    if (atx) {
      add(atx[1].length, atx[2].replace(ATX_CLOSING, ""));
      paragraph = [];
      continue;
    }
    if (line.trim() === "" || THEMATIC_BREAK.test(line) || OTHER_BLOCK.test(line)) {
      paragraph = [];
      continue;
    }
    if (paragraph.length === 0 && INDENTED_CODE.test(line)) continue;
    paragraph.push(line.trim());
  }
  return headings;
}

/**
 * The outline of the last response on the session's branch, oldest entry
 * first. The response is the text of every assistant message after the
 * newest user message that has any, up to the next user message; thinking
 * and tool calls do not count. A turn that has produced no text yet leaves
 * the response before it in place. Before any response, the newest user
 * message stands alone; before any user message there is no prompt.
 */
export function extractMmrOutline(entries: readonly MmrOutlineEntry[]): MmrOutline {
  interface Turn {
    readonly prompt?: string;
    readonly texts: string[];
  }
  let latest: Turn | undefined;
  let answered: Turn | undefined;
  for (const entry of entries) {
    const message = messageOf(entry);
    if (message?.role === "user") {
      latest = { prompt: promptLine(message.content), texts: [] };
    } else if (message?.role === "assistant" && latest) {
      const texts = textBlocks(message.content).filter((text) => text.trim().length > 0);
      if (texts.length === 0) continue;
      latest.texts.push(...texts);
      answered = latest;
    }
  }
  const turn = answered ?? latest;
  if (!turn) return { headings: [] };
  // Each text block is its own Markdown document: a fence left open in one does not hide the next one's headings.
  return { prompt: turn.prompt, headings: turn.texts.flatMap(headingsOf) };
}

/**
 * The outline's rows, each at most `innerWidth` columns: `↑` and the prompt
 * in dim heading colour, then the headings, indented two columns for each
 * level below the shallowest present, level 1 in bold; or one dim line when
 * there are none. With more rows than `maxRows`, the last one shown says how
 * many are left out.
 */
export function renderMmrOutlineLines(
  outline: MmrOutline,
  innerWidth: number,
  theme: Pick<MmrOutlineTheme, "fg" | "bold" | "style">,
  maxRows = Number.POSITIVE_INFINITY,
): string[] {
  const rows: string[] = [];
  if (outline.prompt !== undefined) {
    rows.push(theme.style(fitMmrText(`${PROMPT_MARK}${outline.prompt}`, innerWidth), { fg: "mdHeading", dim: true }));
  }
  if (outline.headings.length === 0) rows.push(theme.fg("dim", fitMmrText(EMPTY_TEXT, innerWidth)));
  const top = Math.min(...outline.headings.map((heading) => heading.level));
  for (const heading of outline.headings) {
    const text = fitMmrText(`${"  ".repeat(heading.level - top)}${heading.text}`, innerWidth);
    rows.push(heading.level === 1 ? theme.bold(text) : text);
  }
  const limit = Math.max(1, maxRows);
  if (rows.length <= limit) return rows;
  const kept = limit - 1;
  return [...rows.slice(0, kept), theme.fg("dim", fitMmrText(`… ${rows.length - kept} more`, innerWidth))];
}

export interface MmrOutlineOptions {
  /** Rows from the bottom that put the box's bottom border just above the prompt box; read on every frame. */
  readonly offsetY: () => number;
  /** True while another popup takes the outline's place (the mode dial, the key hint popup); it hides meanwhile. */
  readonly yields?: () => boolean;
}

export interface MmrOutlineController {
  /** Show the outline of `ctx`'s session; nothing happens when it is open. */
  open(ctx: ExtensionContext): void;
  close(): void;
  /** Open when closed, close when open. */
  toggle(ctx: ExtensionContext): void;
  /**
   * Read the session again while open. `pending` is an assistant message
   * that has ended but is not yet in the session (Pi stores it after the
   * extensions' `message_end` handlers ran).
   */
  refresh(ctx: ExtensionContext, pending?: unknown): void;
  isOpen(): boolean;
}

function readOutline(ctx: ExtensionContext, pending?: unknown): MmrOutline {
  let entries: MmrOutlineEntry[];
  try {
    entries = ctx.sessionManager.buildContextEntries();
  } catch {
    entries = [];
  }
  return extractMmrOutline(pending === undefined ? entries : [...entries, { type: "message", message: pending }]);
}

/** The outline overlay: opened and closed by the `thread.toggleOutline` command, kept current by the host's events. */
export function createMmrOutline(options: MmrOutlineOptions): MmrOutlineController {
  interface OpenOutline {
    outline: MmrOutline;
    tui?: TUI;
    done?: (result: undefined) => void;
    closed: boolean;
  }
  let current: OpenOutline | undefined;

  function open(ctx: ExtensionContext): void {
    if (current) return;
    const state: OpenOutline = { outline: readOutline(ctx), closed: false };
    current = state;
    const placement = withMmrLiveOffsetY(
      {
        anchor: "bottom-right",
        width: MMR_OUTLINE_WIDTH,
        // Two columns on either side: 60 wide with a two-column right margin, or the terminal less four.
        margin: { left: 2, right: 2 },
        nonCapturing: true,
        visible: (columns) => columns >= MMR_OUTLINE_MIN_COLUMNS && !options.yields?.(),
      },
      options.offsetY,
    );
    void ctx.ui
      .custom<undefined>(
        (tui, theme, _keybindings, finish) => {
          state.tui = tui;
          state.done = finish;
          if (state.closed) queueMicrotask(() => finish(undefined));
          return {
            render: (width: number) => {
              const rows = tui?.terminal?.rows;
              // At most a third of the terminal's rows, borders included.
              const maxRows = typeof rows === "number" ? Math.floor(rows / 3) - 2 : undefined;
              const lines = renderMmrOutlineLines(state.outline, mmrFrameInnerWidth(width), theme, maxRows);
              return renderMmrFrame({ title: MMR_OUTLINE_TITLE, titleColor: "mdHeading", lines, topPadding: false }, width, theme);
            },
            invalidate() {},
          };
        },
        { overlay: true, overlayOptions: () => placement },
      )
      .catch(() => {})
      .finally(() => {
        if (current === state) current = undefined;
      });
  }

  function close(): void {
    const state = current;
    if (!state) return;
    current = undefined;
    state.closed = true;
    state.done?.(undefined);
  }

  return {
    open,
    close,
    toggle(ctx) {
      if (current) close();
      else open(ctx);
    },
    refresh(ctx, pending) {
      if (!current) return;
      current.outline = readOutline(ctx, pending);
      current.tui?.requestRender();
    },
    isOpen: () => current !== undefined,
  };
}
