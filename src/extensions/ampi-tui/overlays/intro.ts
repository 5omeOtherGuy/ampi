import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, isKeyRelease, matchesKey, rgbColor, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { isMmrAnimationDisabled } from "../../ampi-core/animation.js";
import { getMmrCommand } from "../../ampi-core/command-registry.js";
import { formatMmrKeyChord, type MmrResolvedKeymap } from "../../ampi-core/keymap.js";
import { markMmrIntroSeen, readMmrIntroRecord, resolveDefaultMmrIntroRecordPath } from "../chrome/intro-record.js";
import { isMmrFreshSession } from "../chrome/look.js";
import {
  MMR_WELCOME_FRAME_COUNT,
  MMR_WELCOME_FRAME_MS,
  type MmrMarkSize,
  type MmrWelcomeTimers,
  renderMmrMark,
} from "../chrome/welcome.js";
import type { MmrTuiSettings } from "../config.js";
import { MMR_MODE_LABEL_COLORS } from "../editor/prompt-box.js";
import { displayMmrKeyChord, formatMmrKeyCombo } from "../keys/dispatcher.js";

/**
 * The onboarding intro: a full-screen overlay that walks through ampi in
 * seven stages, a welcome, five numbered topics and a closing stage.
 *
 * ```text
 *                 ·  ·  ●  •  •          ampi's mark, in the stage's colour
 *              ·                 ·
 *                 ...
 *
 *                     Choose a mode first           bold, in the stage's colour
 *
 *      low, medium, high and ultra trade speed for depth and cost.
 *        Ctrl+S turns the mode dial before your first message;      keys in the key colour
 *
 *                                 1/5                               numbered stages only
 *                          Space to continue
 * ```
 *
 * - Space, Enter, → and l go to the next stage; ←, h and Backspace go back.
 *   Esc closes from any stage, Enter closes from the last one. Space does
 *   not close the last stage, so a quick run of Spaces stops on it.
 * - Key names in the text come from the keymap in effect, overrides
 *   included. A command without a key shows its palette name instead.
 * - The mark plays {@link MMR_WELCOME_FRAME_COUNT} frames on each stage and
 *   rests; with animations off it rests on its first frame and no timer runs.
 * - From 32 rows and 60 columns the mark is drawn large; from 16 rows the
 *   compact mark is used and blank rows go; below 60 columns or 16 rows only
 *   the text shows.
 */

/** A stage's text. In `lines`, `{<command id>}` becomes that command's key, `{leader}` the leader key and `[Esc]` a key named as written. */
export interface MmrIntroStage {
  readonly title: string;
  readonly lines: readonly string[];
}

/** Every title and sentence here is ampi's own. */
export const MMR_INTRO_STAGES: readonly MmrIntroStage[] = [
  {
    title: "A quick tour of ampi",
    lines: ["Five short pages on getting around ampi in Pi's terminal.", "[Esc] closes the tour at any point."],
  },
  {
    title: "Choose a mode first",
    lines: [
      "low, medium, high and ultra trade speed for depth and cost.",
      "{mode.toggle} turns the mode dial before your first message;",
      "from then on the session keeps the mode it started with.",
    ],
  },
  {
    title: "Sessions that keep going",
    lines: [
      "Pi compacts a long session by itself, so the work carries on.",
      "Move between sessions with {thread.switch}, archive with {thread.archive},",
      "and type @@ to point the model at another session.",
    ],
  },
  {
    title: "Talk to a running turn",
    lines: [
      "[Enter] while a turn runs steers it with your new message.",
      "Queue one for after the turn with {prompt.queue};",
      "{thread.interrupt} stops the turn altogether.",
    ],
  },
  {
    title: "Call in a subagent",
    lines: [
      "oracle reviews plans, librarian reads other repositories,",
      "finder searches this one and Task takes a bounded job of its own.",
      "Name the one you want in your message and the agent hands it over.",
    ],
  },
  {
    title: "Every action is a command",
    lines: [
      "{ampi.palette} opens the palette: every command, with its key.",
      "{prompt.toggleHelp} on an empty prompt lists the shortcuts in effect;",
      "{leader} starts longer chords and shows what can follow it.",
    ],
  },
  {
    title: "Make it yours",
    lines: [
      "Rebind any command under ampi.keymap in your or the project's settings;",
      "ampi config keymap prints the keys in effect, ready to copy.",
      "ampi show welcome in the palette replays this tour.",
    ],
  },
];

/** Numbered stages: all but the first and the last. */
export const MMR_INTRO_NUMBERED_STAGES = MMR_INTRO_STAGES.length - 2;

/** Stage colours, in order: the mode label colours, from low to ultra and round again. */
const STAGE_COLORS = ["low", "medium", "high", "ultra"] as const;

const MAX_TEXT_WIDTH = 80;

type IntroTheme = Pick<Theme, "fg" | "bold" | "style">;

/** Names the key for a `{…}` placeholder: a command id, or `leader`. */
export type MmrIntroKeyName = (id: string) => string;

/**
 * Key names from the keymap in effect: a command's first key in display
 * form, or its palette name (noun and verb) when it has no key, or the id
 * when no such command is registered. Without a keymap, the defaults.
 */
export function createMmrIntroKeyNames(keymap: MmrResolvedKeymap | undefined): MmrIntroKeyName {
  return (id) => {
    if (id === "leader") return keymap ? formatMmrKeyCombo(keymap.leader, "display") : "Ctrl+X";
    const command = getMmrCommand(id);
    const chord = keymap?.bindings.get(id)?.[0];
    if (chord && keymap) return displayMmrKeyChord(formatMmrKeyChord(chord, { leader: keymap.leader }));
    if (!keymap && typeof command?.defaultKey === "string") return displayMmrKeyChord(command.defaultKey);
    return command ? `${command.noun} ${command.verb}` : id;
  };
}

export interface MmrIntroRenderInput {
  width: number;
  /** Terminal rows; the result has exactly this many lines. */
  rows: number;
  /** 0 to 6. */
  stage: number;
  frame: number;
  keyName: MmrIntroKeyName;
  theme: IntroTheme;
}

function stageColor(stage: number): readonly [number, number, number] {
  return MMR_MODE_LABEL_COLORS[STAGE_COLORS[stage % STAGE_COLORS.length]] ?? [0xff, 0xff, 0xff];
}

function paintKey(theme: IntroTheme, text: string): string {
  return theme.bold(theme.fg("accent", text));
}

function paintLine(line: string, keyName: MmrIntroKeyName, theme: IntroTheme): string {
  return line.replace(/\{([^}]+)\}|\[([^\]]+)\]/g, (_match, id: string | undefined, literal: string | undefined) =>
    paintKey(theme, id ? keyName(id) : (literal ?? "")),
  );
}

function center(line: string, width: number): string {
  const left = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
  return truncateToWidth(`${" ".repeat(left)}${line}`, width);
}

interface Layout {
  readonly mark?: MmrMarkSize;
  /** Blank row between the title and the text. */
  readonly titleGap: boolean;
  /** Blank rows below the key hint. */
  readonly bottom: number;
  /** Title on the middle row instead of the whole block centred. */
  readonly middleTitle: boolean;
}

const LARGE: Layout = { mark: "intro", titleGap: true, bottom: 2, middleTitle: true };
const COMPACT: Layout = { mark: "compact", titleGap: false, bottom: 1, middleTitle: false };
const TEXT: Layout = { titleGap: true, bottom: 1, middleTitle: false };

/** Draw one stage of the intro: exactly `rows` lines, none wider than `width`. */
export function renderMmrIntro({ width, rows, stage, frame, keyName, theme }: MmrIntroRenderInput): string[] {
  const index = Math.max(0, Math.min(MMR_INTRO_STAGES.length - 1, stage));
  const content = MMR_INTRO_STAGES[index];
  const final = index === MMR_INTRO_STAGES.length - 1;
  const [r, g, b] = stageColor(index);
  const paint = (text: string, bold: boolean) => theme.style(text, { fg: rgbColor(r, g, b), bold });

  const textWidth = Math.max(1, Math.min(width - 4, MAX_TEXT_WIDTH));
  const title = wrapTextWithAnsi(content.title, textWidth).map((line) => paint(line, true));
  const text = content.lines.flatMap((line) => wrapTextWithAnsi(paintLine(line, keyName, theme), textWidth));
  const counter = index > 0 && !final ? theme.fg("dim", `${index}/${MMR_INTRO_NUMBERED_STAGES}`) : undefined;
  const hint = final
    ? `${paintKey(theme, "Enter")}${theme.fg("dim", " to start")}`
    : `${paintKey(theme, "Space")}${theme.fg("dim", " to continue")}`;

  const candidates = width < 60 || rows < 16 ? [TEXT] : rows >= 32 ? [LARGE, COMPACT, TEXT] : [COMPACT, TEXT];
  const lines: string[] = Array.from({ length: Math.max(0, rows) }, () => "");
  const put = (row: number, line: string) => {
    if (row >= 0 && row < lines.length) lines[row] = center(line, width);
  };

  for (const layout of candidates) {
    const hintRow = rows - 1 - layout.bottom;
    const counterRow = hintRow - 1;
    // Rows above the counter, less one blank row before it.
    const room = Math.max(0, counterRow - 1);
    const mark = layout.mark ? renderMmrMark(layout.mark, frame, theme, paint) : [];
    const words = [...title, ...(layout.titleGap ? [""] : []), ...text];
    const block = mark.length > 0 ? [...mark, "", ...words] : words;
    let top = layout.middleTitle ? Math.floor(rows / 2) - mark.length - 1 : Math.floor((room - block.length) / 2);
    let fitted = block;
    if (top < 0 || top + block.length > room) {
      if (layout !== TEXT) continue;
      // Text only and still too tall: drop the blank row, then the lines that do not fit.
      fitted = [...title, ...text].slice(0, room);
      top = Math.max(0, Math.floor((room - fitted.length) / 2));
    }
    for (const [offset, line] of fitted.entries()) put(top + offset, line);
    if (counter) put(counterRow, counter);
    put(hintRow, hint);
    break;
  }
  return lines;
}

export interface MmrIntroOptions {
  theme: IntroTheme;
  keyName: MmrIntroKeyName;
  /** Terminal rows, read on each render. */
  rows: () => number;
  /** Play the mark's animation; off when animations are turned off. */
  animate: boolean;
  onClose: () => void;
  requestRender?: () => void;
  timers?: MmrWelcomeTimers;
}

const realTimers: MmrWelcomeTimers = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** The intro component: stage navigation, the mark's animation and the close. */
export class MmrIntro implements Component {
  private stageIndex = 0;
  private frameIndex = 0;
  private timer: unknown;
  private closed = false;
  private readonly timers: MmrWelcomeTimers;
  private readonly options: MmrIntroOptions;

  constructor(options: MmrIntroOptions) {
    this.options = options;
    this.timers = options.timers ?? realTimers;
    this.play();
  }

  get stage(): number {
    return this.stageIndex;
  }

  get frame(): number {
    return this.frameIndex;
  }

  get animating(): boolean {
    return this.timer !== undefined;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Go to the next stage; on the last one, close when `fromEnter`. */
  advance(fromEnter = false): void {
    if (this.stageIndex < MMR_INTRO_STAGES.length - 1) this.show(this.stageIndex + 1);
    else if (fromEnter) this.close();
  }

  back(): void {
    if (this.stageIndex > 0) this.show(this.stageIndex - 1);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stop();
    this.options.onClose();
  }

  handleInput(data: string): void {
    if (this.closed || isKeyRelease(data)) return;
    if (matchesKey(data, "escape")) this.close();
    else if (matchesKey(data, "enter") || matchesKey(data, "return")) this.advance(true);
    else if (matchesKey(data, "space") || matchesKey(data, "right") || matchesKey(data, "l")) this.advance();
    else if (matchesKey(data, "left") || matchesKey(data, "h") || matchesKey(data, "backspace")) this.back();
  }

  render(width: number): string[] {
    return renderMmrIntro({
      width,
      rows: this.options.rows(),
      stage: this.stageIndex,
      frame: this.frameIndex,
      keyName: this.options.keyName,
      theme: this.options.theme,
    });
  }

  invalidate(): void {}

  dispose(): void {
    this.stop();
  }

  private show(stage: number): void {
    this.stageIndex = stage;
    this.play();
    this.options.requestRender?.();
  }

  /** Start the mark from its first frame. */
  private play(): void {
    this.frameIndex = 0;
    if (!this.options.animate || this.timer !== undefined) return;
    this.timer = this.timers.setInterval(() => this.tick(), MMR_WELCOME_FRAME_MS);
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
}

/** Rows assumed when Pi hands over no terminal. */
const FALLBACK_ROWS = 24;

export interface MmrIntroLauncherOptions {
  settings: Pick<MmrTuiSettings, "quietStartup" | "intro">;
  /** The keymap in effect, for the key names in the text. */
  keymap: () => MmrResolvedKeymap | undefined;
  /** The record file; defaults to `<agentDir>/data/ampi/tui/intro.json`. */
  recordPath?: string;
  now?: () => Date;
  timers?: MmrWelcomeTimers;
  /** Called with the component once Pi has created it. */
  onOpen?: (intro: MmrIntro) => void;
}

export interface MmrIntroLauncher {
  /** Open the intro, unless it is open already. Resolves when it closes. */
  open(ctx: ExtensionContext): Promise<void>;
  /** At an interactive session start: open the intro when this user has not seen it. */
  start(ctx: ExtensionContext): void;
  /** Close the intro if it is open. */
  stop(): void;
}

/**
 * Opens the intro from `ampi.showWelcome` and, once per user, by itself:
 * at the start of a fresh interactive session (no messages yet), with Pi's
 * `quietStartup` off, `ampiTui.intro` not `false` and no intro record. The
 * record is written when the intro closes, however it closes; an unreadable
 * record counts as seen and stays as it is.
 */
export function createMmrIntroLauncher(options: MmrIntroLauncherOptions): MmrIntroLauncher {
  /** The open intro's slot: set from the call to `open` until it closes, so a second call waits its turn. */
  let showing: { intro?: MmrIntro } | undefined;
  const recordPath = () => options.recordPath ?? resolveDefaultMmrIntroRecordPath();

  async function open(ctx: ExtensionContext): Promise<void> {
    if (showing) return;
    const slot: { intro?: MmrIntro } = {};
    showing = slot;
    const release = () => {
      if (showing === slot) showing = undefined;
    };
    const keyName = createMmrIntroKeyNames(options.keymap());
    const animate = !isMmrAnimationDisabled({ cwd: ctx.cwd });
    try {
      await ctx.ui.custom<undefined>(
        (tui, theme, _keybindings, done) => {
          slot.intro = new MmrIntro({
            theme,
            keyName,
            rows: () => tui?.terminal?.rows ?? FALLBACK_ROWS,
            animate,
            timers: options.timers,
            requestRender: () => tui?.requestRender(),
            onClose: () => {
              release();
              markMmrIntroSeen(recordPath(), options.now);
              done(undefined);
            },
          });
          options.onOpen?.(slot.intro);
          return slot.intro;
        },
        { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0 } },
      );
    } finally {
      release();
    }
  }

  return {
    open,
    start(ctx) {
      if (ctx.mode !== "tui" || options.settings.intro === false || options.settings.quietStartup) return;
      if (!isMmrFreshSession(ctx) || readMmrIntroRecord(recordPath()) !== "missing") return;
      void open(ctx).catch(() => {});
    },
    stop() {
      showing?.intro?.close();
    },
  };
}
