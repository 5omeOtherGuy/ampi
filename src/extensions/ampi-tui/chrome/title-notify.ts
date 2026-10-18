/**
 * Terminal title and notifications for interactive sessions.
 *
 * The title names the session and the working directory, with the status
 * slot's wave glyph in front while a turn runs:
 *
 * | State      | Title                                               |
 * | ---------- | --------------------------------------------------- |
 * | idle       | `<title> - ampi - <cwd>`                            |
 * | busy       | `≈ <title> - ampi - <cwd>` (the glyph steps)        |
 * | attention  | `! Waiting for Approval: <title> - ampi - <cwd>`    |
 *
 * `<title>` is the session's name, else its first user message cut to 40
 * columns, else "new session". The title is written at most four times a
 * second, so the glyph steps every 250 ms.
 *
 * Notifications go out when a run settles without an abort ("ampi is ready",
 * or the error text when it failed) and when the status starts waiting for
 * an approval. They use an OSC 777 desktop notification, or a bell over SSH
 * and with `AMPI_FORCE_BEL=1`, plus an optional `paplay` sound, and at most
 * one every two seconds. Pi gives extensions no terminal focus state (its
 * own input listener takes the focus reports), so they go out whether or not
 * the terminal has focus.
 */

import { spawn as spawnProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import { parseBoolEnv } from "../../ampi-core/internal/env.js";
import type { MmrThreadStatus } from "../../ampi-core/thread-status.js";
import { MMR_TUI_NOTIFICATION_DEFAULTS, type MmrTuiNotificationSettings } from "../config.js";
import { MMR_STATUS_WAVE_FRAMES } from "../editor/prompt-box.js";
import type { MmrStatusFeed } from "../editor/status-feed.js";

/** Columns the first user message keeps in the title. */
export const MMR_TITLE_COLUMNS = 40;
/** Shortest time between two title writes: at most four a second. */
export const MMR_TITLE_MIN_INTERVAL_MS = 250;
/** Shortest time between two notifications. */
export const MMR_NOTIFY_MIN_INTERVAL_MS = 2000;

/** Text without escape sequences or control characters, whitespace collapsed to single spaces. */
function plain(text: string): string {
  return stripTerminalSequences(text)
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The session's name, else its first user message cut to {@link MMR_TITLE_COLUMNS}, else "new session". */
export function formatMmrSessionTitle(name: string | undefined, firstMessage: string | undefined): string {
  const named = plain(name ?? "");
  if (named) return named;
  const first = plain(firstMessage ?? "");
  if (first) return stripTerminalSequences(truncateToWidth(first, MMR_TITLE_COLUMNS, "…"));
  return "new session";
}

/** Text of the first user message among session entries, or `undefined` when there is none. */
export function firstMmrUserMessage(entries: readonly unknown[]): string | undefined {
  for (const entry of entries) {
    const record = entry as { type?: unknown; message?: { role?: unknown; content?: unknown } } | undefined;
    if (record?.type !== "message" || record.message?.role !== "user") continue;
    const content = record.message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return undefined;
    return content
      .map((part: { type?: unknown; text?: unknown }) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
      .join(" ");
  }
  return undefined;
}

/** The title of the session `ctx` belongs to (see {@link formatMmrSessionTitle}). */
export function mmrSessionTitle(ctx: ExtensionContext): string {
  return formatMmrSessionTitle(ctx.sessionManager.getSessionName(), firstMmrUserMessage(ctx.sessionManager.getEntries()));
}

export interface MmrTerminalTitleInput {
  readonly status: Pick<MmrThreadStatus, "busy" | "attention" | "label">;
  /** Step of the wave glyph shown while busy. */
  readonly waveFrame: number;
  /** The session title (see {@link formatMmrSessionTitle}). */
  readonly title: string;
  readonly cwd: string;
}

export function formatMmrTerminalTitle({ status, waveFrame, title, cwd }: MmrTerminalTitleInput): string {
  const tail = `${title} - ampi - ${plain(cwd)}`;
  if (status.attention) return `! ${status.label}: ${tail}`;
  if (!status.busy) return tail;
  const count = MMR_STATUS_WAVE_FRAMES.length;
  return `${MMR_STATUS_WAVE_FRAMES[((waveFrame % count) + count) % count]} ${tail}`;
}

export type MmrNotificationKind = "ready" | "approval" | "error";

const NOTIFICATION_TEXT: Readonly<Record<MmrNotificationKind, string>> = {
  ready: "ampi is ready",
  approval: "ampi needs your approval",
  error: "ampi stopped on an error",
};

/** freedesktop sound theme names, played from {@link SOUND_DIRECTORY}. */
const NOTIFICATION_SOUND: Readonly<Record<MmrNotificationKind, string>> = {
  ready: "complete",
  approval: "dialog-warning",
  error: "dialog-warning",
};
const SOUND_DIRECTORY = "/usr/share/sounds/freedesktop/stereo";
const SOUND_PLAYER = "paplay";

/** OSC 777 desktop notification, titled "ampi". */
export function formatMmrNotification(text: string): string {
  return `\u001b]777;notify;ampi;${plain(text)}\u001b\\`;
}

export interface MmrNotifierOptions {
  readonly settings?: MmrTuiNotificationSettings;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  /** Writes to the terminal; by default to stdout when it is a terminal. */
  readonly write?: (data: string) => void;
  /** Starts a sound player without waiting for it. */
  readonly spawn?: (command: string, args: readonly string[]) => void;
  readonly exists?: (file: string) => boolean;
}

export interface MmrNotifier {
  /** Notify unless notifications are off or the last one was under two seconds ago; true when something went out. */
  notify(kind: MmrNotificationKind): boolean;
}

function writeToTerminal(data: string): void {
  try {
    if (process.stdout.isTTY) process.stdout.write(data);
  } catch {
    // A notification is never worth a crash.
  }
}

function spawnDetached(command: string, args: readonly string[]): void {
  try {
    const child = spawnProcess(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No player, no sound.
  }
}

function findOnPath(command: string, env: NodeJS.ProcessEnv, exists: (file: string) => boolean): string | undefined {
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

export function createMmrNotifier(options: MmrNotifierOptions = {}): MmrNotifier {
  const settings = options.settings ?? MMR_TUI_NOTIFICATION_DEFAULTS;
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const write = options.write ?? writeToTerminal;
  const spawn = options.spawn ?? spawnDetached;
  const exists = options.exists ?? existsSync;
  let lastAt = Number.NEGATIVE_INFINITY;

  return {
    notify(kind) {
      if (!settings.enabled) return false;
      const at = now();
      if (at - lastAt < MMR_NOTIFY_MIN_INTERVAL_MS) return false;
      // Over SSH a desktop notification would show on the remote machine, if anywhere.
      const remote = Boolean(env.SSH_CONNECTION || env.SSH_TTY);
      let sent = false;
      if (settings.system) {
        const bell = remote || parseBoolEnv(env.AMPI_FORCE_BEL) === true;
        write(bell ? "\u0007" : formatMmrNotification(NOTIFICATION_TEXT[kind]));
        sent = true;
      }
      if (settings.sound && !remote) {
        const player = findOnPath(SOUND_PLAYER, env, exists);
        const file = path.join(SOUND_DIRECTORY, `${NOTIFICATION_SOUND[kind]}.oga`);
        if (player && exists(file)) {
          spawn(player, [file]);
          sent = true;
        }
      }
      if (sent) lastAt = at;
      return sent;
    },
  };
}

export interface MmrTitleNotifyOptions extends MmrNotifierOptions {
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export interface MmrTitleNotify {
  /** Own the title for this interactive session. Safe to call again on the next session start. */
  start(ctx: ExtensionContext): void;
  /** Stop and clear the title. */
  stop(): void;
  /** The status feed changed. */
  statusChanged(): void;
}

export function createMmrTitleNotify(
  pi: ExtensionAPI,
  feed: MmrStatusFeed,
  options: MmrTitleNotifyOptions = {},
): MmrTitleNotify {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const notifier = createMmrNotifier({ ...options, now });

  let ctx: ExtensionContext | undefined;
  let timer: unknown;
  let lastTitle: string | undefined;
  let lastWriteAt = Number.NEGATIVE_INFINITY;
  let waveFrame = 0;
  let waitingApproval = false;

  function cancel(): void {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  }

  /** Write the title when it changed; while busy, come back for the next wave step. */
  function tick(): void {
    timer = undefined;
    if (!ctx) return;
    const title = formatMmrTerminalTitle({
      status: feed.status,
      waveFrame,
      title: mmrSessionTitle(ctx),
      cwd: ctx.sessionManager.getCwd(),
    });
    if (title !== lastTitle) {
      ctx.ui.setTitle(title);
      lastTitle = title;
      lastWriteAt = now();
    }
    if (feed.status.busy) {
      waveFrame = (waveFrame + 1) % MMR_STATUS_WAVE_FRAMES.length;
      timer = setTimer(tick, MMR_TITLE_MIN_INTERVAL_MS);
    } else {
      waveFrame = 0;
    }
  }

  /** Write now, or once the last write is far enough back. */
  function request(): void {
    if (!ctx || timer !== undefined) return;
    const wait = lastWriteAt + MMR_TITLE_MIN_INTERVAL_MS - now();
    if (wait <= 0) tick();
    else timer = setTimer(tick, wait);
  }

  pi.on("agent_settled", (event) => {
    // The status feed handles this event first, so the status is already settled.
    if (!ctx || event.aborted || feed.status.busy) return;
    notifier.notify(feed.status.phase === "error" ? "error" : "ready");
  });
  pi.on("session_info_changed", () => {
    // Pi has just written its own title with the new name.
    if (!ctx) return;
    lastTitle = undefined;
    request();
  });

  return {
    start(context) {
      cancel();
      ctx = context;
      lastTitle = undefined;
      waveFrame = 0;
      waitingApproval = false;
      // Pi writes its own title once session start handlers are done, so the
      // first title waits one interval to land after it.
      lastWriteAt = now();
      timer = setTimer(tick, MMR_TITLE_MIN_INTERVAL_MS);
    },
    stop() {
      cancel();
      ctx?.ui.setTitle("");
      ctx = undefined;
    },
    statusChanged() {
      if (!ctx) return;
      const approval = feed.status.phase === "waitingApproval";
      if (approval && !waitingApproval) notifier.notify("approval");
      waitingApproval = approval;
      request();
    },
  };
}
