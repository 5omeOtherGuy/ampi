import type { Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { MmrChangelogDisplay } from "../../ampi-core/changelog.js";

/** Milliseconds between two frames of the welcome mark. */
export const MMR_WELCOME_FRAME_MS = 150;
/** Frames the mark plays before it rests: three turns of the large outer ring. */
export const MMR_WELCOME_FRAME_COUNT = 60;

type WelcomeTheme = Pick<Theme, "fg" | "bold">;
type RingColor = "success" | "accent";
type Point = readonly [row: number, column: number];

interface Ring {
  readonly points: readonly Point[];
  /** +1 turns clockwise, -1 counter-clockwise. */
  readonly step: 1 | -1;
  /** Dots behind the head drawn bright. */
  readonly trail: number;
  readonly color: RingColor;
}

interface Mark {
  readonly rows: number;
  readonly columns: number;
  readonly rings: readonly Ring[];
}

/** `count` points on an ellipse filling `rows` x `columns` cells, clockwise from the top. */
function ellipse(rows: number, columns: number, count: number, top = 0, left = 0): Point[] {
  const ry = (rows - 1) / 2;
  const rx = (columns - 1) / 2;
  return Array.from({ length: count }, (_, index) => {
    const angle = (2 * Math.PI * index) / count;
    return [top + Math.round(ry - ry * Math.cos(angle)), left + Math.round(rx + rx * Math.sin(angle))] as const;
  });
}

// ampi's mark: two rings of dots turning against each other, a bright head
// with a short trail on each. The point tables below are the whole frame
// table; frame `n` only moves each ring's head `n` steps along its points.
const LARGE_MARK: Mark = {
  rows: 9,
  columns: 21,
  rings: [
    { points: ellipse(9, 21, 20), step: 1, trail: 3, color: "success" },
    { points: ellipse(5, 11, 10, 2, 5), step: -1, trail: 2, color: "accent" },
  ],
};

const COMPACT_MARK: Mark = {
  rows: 5,
  columns: 13,
  rings: [
    { points: ellipse(5, 13, 12), step: 1, trail: 2, color: "success" },
    { points: [[2, 6]], step: 1, trail: 0, color: "accent" },
  ],
};

function renderMark(mark: Mark, frame: number, theme: WelcomeTheme): string[] {
  const cells: string[][] = Array.from({ length: mark.rows }, () => Array<string>(mark.columns).fill(" "));
  for (const ring of mark.rings) {
    const count = ring.points.length;
    const head = (((ring.step * frame) % count) + count) % count;
    ring.points.forEach(([row, column], index) => {
      // Distance behind the head, against the direction of travel.
      const behind = (((ring.step > 0 ? head - index : index - head) % count) + count) % count;
      cells[row][column] =
        behind === 0
          ? theme.bold(theme.fg(ring.color, "●"))
          : behind <= ring.trail
            ? theme.fg(ring.color, "•")
            : theme.fg("dim", "·");
    });
  }
  return cells.map((row) => row.join(""));
}

/** The changelog item shown in the welcome card. */
export interface MmrWelcomeCard {
  readonly title: string;
  readonly summary: string;
}

/** A top-level list item: hand-written entries use `- `, release-please writes `* `. */
const BULLET = /^[-*] /;

/**
 * Plain text of the first bullet in a changelog section, without Markdown
 * markup and without the pull request and commit references release-please
 * appends (`([#12](url)) ([abc1234](url))`, `, closes [#3](url)`).
 */
function firstBullet(markdown: string): string | undefined {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const start = lines.findIndex((line) => BULLET.test(line));
  if (start === -1) return undefined;
  const parts = [lines[start].slice(2)];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || BULLET.test(line) || line.startsWith("#")) break;
    parts.push(line.trim());
  }
  const text = parts
    .join(" ")
    .replace(/(?:,\s*closes\s+\[#\d+\]\([^)]*\))+\s*$/, "")
    .replace(/(?:\s*\(\[(?:#\d+|[0-9a-f]{7,40})\]\([^)]*\)\))+\s*$/, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
}

/** Build the welcome card from the changelog notice ampi-core would otherwise show. */
export function buildMmrWelcomeCard(display: MmrChangelogDisplay): MmrWelcomeCard | undefined {
  const summary = firstBullet(display.markdown);
  if (!summary) return undefined;
  return { title: display.kind === "versioned" ? `New in ampi ${display.displayVersion}` : "New in ampi", summary };
}

const GAP = 4;
const LARGE_CARD_WIDTH = 52;
const COMPACT_CARD_WIDTH = 50;
const CARD_SUMMARY_ROWS = 3;

function padTo(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function cardRows(card: MmrWelcomeCard, width: number, collapsed: boolean, theme: WelcomeTheme): string[] {
  const bar = `${theme.fg("success", "▍")} `;
  const dismiss = theme.fg("dim", "dismiss");
  const inner = width - 2;
  if (collapsed) {
    const head = `${theme.bold(card.title)}${theme.fg("dim", " · ")}`;
    const room = Math.max(1, inner - visibleWidth(head) - 1 - visibleWidth("dismiss"));
    const summary = theme.fg("dim", truncateToWidth(card.summary, room, "…"));
    return [`${bar}${padTo(`${head}${summary}`, inner - visibleWidth("dismiss"))}${dismiss}`];
  }
  const title = theme.bold(theme.fg("success", card.title));
  const wrapped = wrapTextWithAnsi(card.summary, inner);
  const summary = wrapped.slice(0, CARD_SUMMARY_ROWS);
  if (wrapped.length > CARD_SUMMARY_ROWS) {
    summary[CARD_SUMMARY_ROWS - 1] = truncateToWidth(`${summary[CARD_SUMMARY_ROWS - 1]} …`, inner, "…");
  }
  return [
    `${bar}${padTo(title, inner - visibleWidth("dismiss"))}${dismiss}`,
    ...summary.map((line) => `${bar}${line}`),
    `${bar}${theme.fg("dim", "/ampi-changelog lists every change")}`,
  ];
}

export interface MmrWelcomeRenderInput {
  width: number;
  /** Terminal height; small terminals get the compact layout. */
  rows?: number;
  frame: number;
  card?: MmrWelcomeCard;
  theme: WelcomeTheme;
}

/**
 * Lay out the welcome header: the mark on the left, centred with the text
 * column beside it ("Welcome to ampi", the key hints and the card). Wide and
 * tall terminals get the large mark and the full card; from 80x24 down the
 * mark shrinks and the card collapses to one line; below 60 columns the mark
 * is left out.
 */
export function renderMmrWelcome({ width, rows, frame, card, theme }: MmrWelcomeRenderInput): string[] {
  const narrow = width < 60;
  const large = !narrow && width >= 100 && (rows === undefined || rows >= 30);
  const mark = narrow ? undefined : large ? LARGE_MARK : COMPACT_MARK;
  const markColumns = mark ? mark.columns + GAP : 0;
  const cardWidth = Math.min(large ? LARGE_CARD_WIDTH : COMPACT_CARD_WIDTH, width - markColumns - 2);

  const key = (text: string) => theme.bold(theme.fg("accent", text));
  const text = [
    `${theme.bold("Welcome to ")}${theme.bold(theme.fg("success", "ampi"))}`,
    `${key("ctrl+o")}${theme.fg("dim", " for commands · ")}${key("?")}${theme.fg("dim", " for shortcuts")}`,
    ...(card ? ["", ...cardRows(card, cardWidth, !large, theme)] : []),
  ];
  const markRows = mark ? renderMark(mark, frame, theme) : [];
  const height = Math.max(markRows.length, text.length);
  const markTop = Math.floor((height - markRows.length) / 2);
  const textTop = Math.floor((height - text.length) / 2);
  const textWidth = Math.max(...text.map((line) => visibleWidth(line)));
  const left = " ".repeat(Math.max(0, Math.floor((width - markColumns - textWidth) / 2)));
  const blankMark = " ".repeat(markColumns);

  return Array.from({ length: height }, (_, row) => {
    const markRow = mark ? padTo(markRows[row - markTop] ?? "", mark.columns) + " ".repeat(GAP) : blankMark;
    return truncateToWidth(`${left}${markRow}${text[row - textTop] ?? ""}`, width);
  });
}

/** Timer functions the header animates with; tests pass a fake clock. */
export interface MmrWelcomeTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimers: MmrWelcomeTimers = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface MmrWelcomeHeaderOptions {
  theme: WelcomeTheme;
  card?: MmrWelcomeCard;
  /** Play the mark's animation; off for resumed sessions. */
  animate: boolean;
  rows?: () => number;
  requestRender?: () => void;
  timers?: MmrWelcomeTimers;
}

/**
 * Pi header component for the welcome screen. It sits at the top of the
 * transcript and scrolls away with it. The mark plays
 * `MMR_WELCOME_FRAME_COUNT` frames and then rests; the card stays until a key
 * is pressed or the first message is sent.
 */
export class MmrWelcomeHeader {
  private frameIndex = 0;
  private card: MmrWelcomeCard | undefined;
  private timer: unknown;
  private readonly timers: MmrWelcomeTimers;
  private readonly options: MmrWelcomeHeaderOptions;

  constructor(options: MmrWelcomeHeaderOptions) {
    this.options = options;
    this.card = options.card;
    this.timers = options.timers ?? realTimers;
    if (options.animate) this.timer = this.timers.setInterval(() => this.tick(), MMR_WELCOME_FRAME_MS);
  }

  get frame(): number {
    return this.frameIndex;
  }

  get animating(): boolean {
    return this.timer !== undefined;
  }

  get cardVisible(): boolean {
    return this.card !== undefined;
  }

  private tick(): void {
    this.frameIndex += 1;
    if (this.frameIndex >= MMR_WELCOME_FRAME_COUNT - 1) this.stop();
    this.options.requestRender?.();
  }

  private stop(): void {
    if (this.timer === undefined) return;
    this.timers.clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Hide the card. */
  dismiss(): void {
    if (!this.card) return;
    this.card = undefined;
    this.options.requestRender?.();
  }

  /** The first message went out: stop the animation and hide the card. */
  settle(): void {
    this.stop();
    this.dismiss();
  }

  render(width: number): string[] {
    return renderMmrWelcome({
      width,
      rows: this.options.rows?.(),
      frame: this.frameIndex,
      card: this.card,
      theme: this.options.theme,
    });
  }

  invalidate(): void {}

  dispose(): void {
    this.stop();
  }
}

/**
 * Whether raw terminal input is a key press rather than a mouse report, a
 * focus change, a terminal reply or a key release (kitty keyboard protocol),
 * so moving the mouse does not dismiss the card.
 */
export function isMmrKeyInput(data: string): boolean {
  return !isKeyRelease(data) && !/^\x1b(?:\[<|\[M|\[I|\[O|\[\?|\[\d+;\d+;\d+t|\]|P|_)/.test(data);
}
