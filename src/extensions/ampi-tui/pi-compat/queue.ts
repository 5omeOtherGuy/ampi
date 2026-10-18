/**
 * Pi's message queue. Pi's extension API says only whether messages are
 * queued (`ctx.hasPendingMessages()`); the queued texts live on Pi's
 * `InteractiveMode`. Its `updatePendingMessagesDisplay()` runs on every
 * change of the queue (Pi calls it on each `queue_update` session event, after
 * a dequeue and around compaction) and draws Pi's own list of queued messages
 * above the editor; `getAllQueuedMessages()` reads the queue and
 * `clearAllQueues()` empties it and returns what it held. None of this is part
 * of Pi's extension API.
 *
 * While a watch is installed, ampi replaces `updatePendingMessagesDisplay`:
 * Pi's own list stays empty and the listener receives the queue instead.
 * When a Pi release changes the class, `probeMmrPiQueue` names the
 * difference, the watch is not installed, and Pi keeps drawing its own list.
 */
import { InteractiveMode } from "@earendil-works/pi-coding-agent";

/** Pi's queued messages: those that steer the running turn, then those that follow it. */
export interface MmrPiQueuedMessages {
  readonly steering: readonly string[];
  readonly followUp: readonly string[];
}

export interface MmrPiQueueWatch {
  /**
   * Empty Pi's queue and return what it held. `undefined` until Pi has
   * reported its queue once since the watch was installed.
   */
  take(): MmrPiQueuedMessages | undefined;
  /** Give the list back to Pi. */
  stop(): void;
}

type QueueLists = { steering: readonly string[]; followUp: readonly string[] };

interface ModeInstance {
  pendingMessagesContainer: { clear(): void };
  getAllQueuedMessages(): QueueLists;
  clearAllQueues(): QueueLists;
  updatePendingMessagesDisplay(): void;
}

interface PatchState {
  readonly original: (this: ModeInstance) => void;
  readonly listener: (queue: MmrPiQueuedMessages) => void;
  mode: ModeInstance | undefined;
}

type ModePrototype = Record<PropertyKey, unknown> & {
  updatePendingMessagesDisplay: (this: ModeInstance) => void;
  [PATCH_KEY]?: PatchState;
};

// Symbol.for, so a module loaded again by /reload finds the state an earlier
// copy left on the shared prototype instead of wrapping its own patch.
const PATCH_KEY = Symbol.for("ampi.tui.queuePatch.v1");

const METHODS = ["updatePendingMessagesDisplay", "getAllQueuedMessages", "clearAllQueues"] as const;

function copy(lists: QueueLists): MmrPiQueuedMessages {
  return { steering: [...lists.steering], followUp: [...lists.followUp] };
}

/**
 * Check that `target` still has the shape the watch relies on. Returns
 * `undefined` when it does, or a sentence naming what changed.
 */
export function probeMmrPiQueue(target: unknown = InteractiveMode): string | undefined {
  if (typeof target !== "function") return "InteractiveMode is no longer exported as a class";
  const proto = target.prototype as Record<string, unknown> | undefined;
  for (const method of METHODS) {
    if (typeof proto?.[method] !== "function") return `InteractiveMode.prototype.${method} is missing`;
  }
  return undefined;
}

/**
 * Report every change of Pi's queue to `listener` instead of drawing Pi's
 * list. Returns `undefined` (and changes nothing) when the class shape no
 * longer matches. Installing again replaces the previous listener.
 */
export function watchMmrPiQueue(
  listener: (queue: MmrPiQueuedMessages) => void,
  target: unknown = InteractiveMode,
): MmrPiQueueWatch | undefined {
  if (probeMmrPiQueue(target) !== undefined) return undefined;
  const proto = (target as { prototype: ModePrototype }).prototype;
  const state: PatchState = {
    original: proto[PATCH_KEY]?.original ?? proto.updatePendingMessagesDisplay,
    listener,
    mode: proto[PATCH_KEY]?.mode,
  };
  proto[PATCH_KEY] = state;
  proto.updatePendingMessagesDisplay = function reportQueueToAmpi(this: ModeInstance) {
    state.mode = this;
    this.pendingMessagesContainer?.clear();
    try {
      state.listener(copy(this.getAllQueuedMessages()));
    } catch {
      // A failing listener must not break Pi's queue handling.
    }
  };
  return {
    take() {
      const mode = state.mode;
      if (!mode || proto[PATCH_KEY] !== state) return undefined;
      const taken = copy(mode.clearAllQueues());
      // Pi's session reports its cleared queue before the compaction queue is emptied.
      mode.updatePendingMessagesDisplay();
      return taken;
    },
    stop() {
      if (proto[PATCH_KEY] !== state) return;
      proto.updatePendingMessagesDisplay = state.original;
      delete proto[PATCH_KEY];
      try {
        if (state.mode) state.original.call(state.mode);
      } catch {}
    },
  };
}
