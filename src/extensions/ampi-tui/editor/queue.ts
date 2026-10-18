import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
  type MmrCommandAvailability,
  type MmrCommandDefinition,
  registerMmrCommand,
  unregisterMmrCommand,
} from "../../ampi-core/command-registry.js";
import { hasMmrEditorAction, runMmrEditorAction } from "../pi-compat/editor.js";
import { type MmrPiQueuedMessages, type MmrPiQueueWatch, watchMmrPiQueue } from "../pi-compat/queue.js";
import { MMR_FRAME_MIN_WIDTH, type MmrFrameTheme, renderMmrFrame } from "../ui/frame.js";
import type { MmrStatusFeed } from "./status-feed.js";

/**
 * The prompt queue: messages waiting for the running turn, listed in a small
 * box directly above the prompt box, and the commands that queue, take back
 * and steer them.
 *
 * ```text
 *  ╭────────────────────────────────────────────╮
 *  │ steering: also cover the error path         │
 *  │ queued:   then update the changelog         │
 *  │           and run the whole suite           │
 *  ╰────────────────────────────────────────────╯
 * ╭──────────────────────────────── $0.02 ─ medium ─╮
 * ```
 *
 * The messages stay in Pi's own queue. Enter while a turn runs puts a
 * message in Pi's steering queue (shown as `steering:`); `prompt.queue` puts
 * one in Pi's follow-up queue (shown as `queued:`), to run after the turn.
 * `prompt.steerQueuedMessage`, and Enter on an empty prompt, moves the next
 * follow-up into the steering queue. `prompt.dequeue`, and Backspace on an
 * empty prompt, run Pi's dequeue action, which puts every queued message
 * back into the prompt. Pi's own list of queued messages is not drawn while
 * the box is installed (see `pi-compat/queue.ts`).
 */

/** Widget key of the queue box. */
export const MMR_QUEUE_WIDGET_ID = "ampi-tui-queue";

const DEQUEUE_ACTION = "app.message.dequeue";
const STEERING_LABEL = "steering:";
const QUEUED_LABEL = "queued:";

/** One line of a queued message: whitespace runs, line breaks included, become one space. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The queue box for `queue` in `width` columns: steering messages first, then
 * follow-ups, one per row, inset one column from each side. No rows when
 * nothing is queued or the width leaves no room for a frame.
 */
export function renderMmrQueueBox(queue: MmrPiQueuedMessages, width: number, theme: MmrFrameTheme): string[] {
  if (queue.steering.length + queue.followUp.length === 0 || width < MMR_FRAME_MIN_WIDTH + 2) return [];
  const labelWidth = (queue.steering.length > 0 ? STEERING_LABEL.length : QUEUED_LABEL.length) + 1;
  const pad = (label: string) => " ".repeat(labelWidth - label.length);
  const lines = [
    ...queue.steering.map((text) => `${theme.fg("accent", STEERING_LABEL)}${pad(STEERING_LABEL)}${oneLine(text)}`),
    ...queue.followUp.map((text, index) => {
      const label = index === 0 ? theme.fg("dim", QUEUED_LABEL) + pad(QUEUED_LABEL) : " ".repeat(labelWidth);
      return `${label}${theme.fg("muted", oneLine(text))}`;
    }),
  ];
  return renderMmrFrame({ lines, topPadding: false }, width - 2, theme).map((line) => ` ${line} `);
}

export interface MmrPromptQueueOptions {
  readonly feed: MmrStatusFeed;
  /** The TUI handle, once Pi has handed one to a component factory. */
  readonly getTui: () => TUI | undefined;
  /** Reads Pi's queue; defaults to the `pi-compat` watch. */
  readonly watch?: (listener: (queue: MmrPiQueuedMessages) => void) => MmrPiQueueWatch | undefined;
}

export interface MmrPromptQueue {
  /** Install for a TUI session. Safe to call again on the next session start. */
  start(ctx: ExtensionContext): void;
  stop(): void;
  /** Send the next queued follow-up as a steering message now. False when there is none to steer. */
  steerNext(): boolean;
}

const AVAILABLE: MmrCommandAvailability = { state: "available" };
const NOTHING_QUEUED: MmrCommandAvailability = { state: "unavailable", reason: "no message is queued" };

export function createMmrPromptQueue(pi: Pick<ExtensionAPI, "sendUserMessage">, options: MmrPromptQueueOptions): MmrPromptQueue {
  const empty: MmrPiQueuedMessages = { steering: [], followUp: [] };
  let ctx: ExtensionContext | undefined;
  let watch: MmrPiQueueWatch | undefined;
  let queue = empty;
  let unregister: (() => void) | undefined;

  function showBox(current: ExtensionContext): void {
    if (queue.steering.length + queue.followUp.length === 0) {
      current.ui.setWidget(MMR_QUEUE_WIDGET_ID, undefined, { placement: "aboveEditor" });
      return;
    }
    const shown = queue;
    // Set anew on each change: Pi draws the widget set last nearest the editor.
    current.ui.setWidget(
      MMR_QUEUE_WIDGET_ID,
      (_tui, theme) => ({ render: (width: number) => renderMmrQueueBox(shown, width, theme), invalidate() {} }),
      { placement: "aboveEditor" },
    );
  }

  function onQueue(next: MmrPiQueuedMessages): void {
    queue = next;
    options.feed.followQueue(next.steering.length + next.followUp.length);
    if (ctx) showBox(ctx);
  }

  /** Why the queue cannot change right now, or `undefined` when it can. */
  function blocked(current: ExtensionContext): MmrCommandAvailability | undefined {
    if (current.isIdle()) return { state: "unavailable", reason: "nothing is running" };
    if (options.feed.status.phase === "compacting") return { state: "unavailable", reason: "Pi is compacting the conversation" };
    return undefined;
  }

  function steerNext(): boolean {
    if (queue.followUp.length === 0 || !ctx || blocked(ctx)) return false;
    const taken = watch?.take();
    if (!taken) return false;
    // Pi takes messages out only all at once; put them back with the next follow-up moved to steer.
    const [next, ...rest] = taken.followUp;
    for (const text of [...taken.steering, ...(next === undefined ? [] : [next])]) pi.sendUserMessage(text, { deliverAs: "steer" });
    for (const text of rest) pi.sendUserMessage(text, { deliverAs: "followUp" });
    return next !== undefined;
  }

  const commands: MmrCommandDefinition[] = [
    {
      id: "prompt.queue",
      noun: "prompt",
      verb: "queue message",
      description: "Run the prompt as a follow-up message after the current turn instead of steering it",
      keywords: ["follow-up", "later"],
      availability: (current) => {
        const reason = blocked(current);
        if (reason) return reason;
        return current.ui.getEditorText().trim().length === 0 ? { state: "unavailable", reason: "type a prompt to queue it" } : AVAILABLE;
      },
      run: (current) => {
        const text = current.ui.getEditorText().trim();
        if (!text) return;
        current.ui.setEditorText("");
        // Expanded like a typed prompt, so templates and skills work as they do on Enter.
        pi.sendUserMessage(text, { deliverAs: "followUp", expandPromptTemplates: true });
        options.getTui()?.requestRender();
      },
    },
    {
      id: "prompt.dequeue",
      noun: "prompt",
      verb: "dequeue",
      // No "message" here: the palette query "queue message" must rank prompt.queue first.
      description: "Take everything that waits to run back into the prompt",
      availability: () => {
        if (options.feed.status.queued === 0) return NOTHING_QUEUED;
        return hasMmrEditorAction(options.getTui(), DEQUEUE_ACTION) ? AVAILABLE : { state: "unavailable", reason: "the prompt is not focused" };
      },
      run: () => {
        runMmrEditorAction(options.getTui(), DEQUEUE_ACTION);
        options.feed.refreshQueue();
      },
    },
    {
      id: "prompt.steerQueuedMessage",
      noun: "prompt",
      verb: "steer queued message",
      description: "Send the next waiting follow-up now, to steer the running turn",
      availability: (current) => {
        if (!watch) return { state: "unavailable", reason: "this Pi version does not show ampi its queue" };
        if (queue.followUp.length === 0) return NOTHING_QUEUED;
        return blocked(current) ?? AVAILABLE;
      },
      run: () => {
        steerNext();
      },
    },
  ];

  return {
    start(nextCtx) {
      ctx = nextCtx;
      queue = empty;
      watch ??= (options.watch ?? watchMmrPiQueue)(onQueue);
      if (!unregister) {
        for (const command of commands) registerMmrCommand(command);
        unregister = () => {
          for (const command of commands) unregisterMmrCommand(command.id);
        };
      }
    },
    stop() {
      watch?.stop();
      watch = undefined;
      unregister?.();
      unregister = undefined;
      queue = empty;
      ctx = undefined;
    },
    steerNext,
  };
}
