/**
 * Pi's message queue. Pi's extension API says only whether messages are
 * queued (`ctx.hasPendingMessages()`); the queued texts live on Pi's
 * `InteractiveMode`. Its `updatePendingMessagesDisplay()` runs on every
 * change of the queue (Pi calls it on each `queue_update` session event, after
 * a dequeue and around compaction) and draws Pi's own list of queued messages
 * above the editor; `getAllQueuedMessages()` reads the queue. None of this is
 * part of Pi's extension API.
 *
 * While a watch is installed, ampi replaces `updatePendingMessagesDisplay`:
 * Pi's own list stays empty and the listener receives the queue instead.
 * When a Pi release changes the class, `probeMmrPiQueue` names the
 * difference, the watch is not installed, and Pi keeps drawing its own list.
 *
 * Steering a queued follow-up moves one message inside Pi's session: the
 * session keeps the texts of the messages the user queued
 * (`_steeringMessages`, `_followUpMessages`) and announces changes with
 * `_emitQueueUpdate()`; its agent keeps the messages themselves, images
 * included, in `steeringQueue` and `followUpQueue`, next to the custom
 * messages extensions queue with `pi.sendMessage`. Only the user's message
 * moves, so nothing else in the queue is lost or sent twice. Removing one
 * queued message (`removeMmrPiQueuedMessage`) takes it out of both lists the
 * same way. `probeMmrPiQueueSession` checks that shape on a live session.
 */
import { InteractiveMode } from "@earendil-works/pi-coding-agent";

/** Pi's queued messages: those that steer the running turn, then those that follow it. */
export interface MmrPiQueuedMessages {
  readonly steering: readonly string[];
  readonly followUp: readonly string[];
}

export interface MmrPiQueueWatch {
  /**
   * Why {@link steerNext} cannot move a message now, or `undefined` when it
   * can.
   */
  steerBlocked(): string | undefined;
  /**
   * Move the next follow-up the user queued to Pi's steering queue, so it
   * reaches the running turn before its next model call. Returns false when
   * {@link steerBlocked} names a reason.
   */
  steerNext(): boolean;
  /** Take one queued message out of Pi's queue; see {@link removeMmrPiQueuedMessage}. */
  remove(kind: "steering" | "followUp", index: number, text: string): boolean;
  /** Give the list back to Pi. */
  stop(): void;
}

type QueueLists = { steering: readonly string[]; followUp: readonly string[] };

interface ModeInstance {
  pendingMessagesContainer: { clear(): void };
  readonly session: unknown;
  getAllQueuedMessages(): QueueLists;
  updatePendingMessagesDisplay(): void;
}

interface QueuedAgentMessage {
  readonly role?: unknown;
  readonly content?: unknown;
}

interface SessionQueue {
  _steeringMessages: string[];
  _followUpMessages: string[];
  _emitQueueUpdate(): void;
  readonly agent: {
    steer(message: QueuedAgentMessage): void;
    readonly steeringQueue: { messages: QueuedAgentMessage[] };
    readonly followUpQueue: { messages: QueuedAgentMessage[] };
  };
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

const METHODS = ["updatePendingMessagesDisplay", "getAllQueuedMessages"] as const;

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

/** The text Pi records for a user message it queued: its text parts, joined. */
function messageText(message: QueuedAgentMessage): string | undefined {
  if (message.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  return message.content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

/**
 * Check that `session`, a live Pi `AgentSession`, still keeps its queue the
 * way {@link steerMmrPiFollowUp} relies on. Returns `undefined` when it does,
 * or a sentence naming what changed.
 */
export function probeMmrPiQueueSession(session: unknown): string | undefined {
  const s = session as Partial<SessionQueue> | null | undefined;
  if (!Array.isArray(s?._steeringMessages) || !Array.isArray(s?._followUpMessages)) {
    return "AgentSession no longer keeps the queued texts in _steeringMessages and _followUpMessages";
  }
  if (typeof s._emitQueueUpdate !== "function") return "AgentSession._emitQueueUpdate is missing";
  if (typeof s.agent?.steer !== "function") return "Agent.steer is missing";
  if (!Array.isArray(s.agent.steeringQueue?.messages) || !Array.isArray(s.agent.followUpQueue?.messages)) {
    return "Agent no longer keeps queued messages in steeringQueue.messages and followUpQueue.messages";
  }
  return undefined;
}

/**
 * Move the session's next user follow-up to its steering queue: the message
 * keeps its images and its place after the messages already steering, and
 * the session reports the new queue. Custom messages and later follow-ups
 * stay where they are. Returns false, changing nothing, when there is no
 * user follow-up or the session's shape has changed.
 */
export function steerMmrPiFollowUp(session: unknown): boolean {
  if (probeMmrPiQueueSession(session) !== undefined) return false;
  const s = session as SessionQueue;
  const text = s._followUpMessages[0];
  if (text === undefined) return false;
  const queued = s.agent.followUpQueue.messages;
  const index = queued.findIndex((message) => messageText(message) === text);
  if (index === -1) return false;
  const [message] = queued.splice(index, 1);
  s._followUpMessages.splice(0, 1);
  s._steeringMessages.push(text);
  s.agent.steer(message);
  s._emitQueueUpdate();
  return true;
}

/**
 * Take one message the user queued out of the session's queue: the
 * `index`-th text of its steering or follow-up list, which must still read
 * `text`, together with the agent's copy of that message. The session then
 * reports the new queue. Returns false, changing nothing, when that message
 * is no longer there (it started, or the queue changed) or the session's
 * shape has changed.
 */
export function removeMmrPiQueuedMessage(session: unknown, kind: "steering" | "followUp", index: number, text: string): boolean {
  if (probeMmrPiQueueSession(session) !== undefined) return false;
  const s = session as SessionQueue;
  const texts = kind === "steering" ? s._steeringMessages : s._followUpMessages;
  if (texts[index] !== text) return false;
  // Equal texts may repeat: the n-th equal text is the n-th equal message.
  const nth = texts.slice(0, index).filter((queued) => queued === text).length;
  const messages = (kind === "steering" ? s.agent.steeringQueue : s.agent.followUpQueue).messages;
  const at = messages.map((message, i) => (messageText(message) === text ? i : -1)).filter((i) => i >= 0)[nth];
  if (at === undefined) return false;
  messages.splice(at, 1);
  texts.splice(index, 1);
  s._emitQueueUpdate();
  return true;
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
  const steerBlocked = (): string | undefined => {
    const session = proto[PATCH_KEY] === state ? state.mode?.session : undefined;
    if (session === undefined) return "Pi has not shown ampi its queue yet";
    const changed = probeMmrPiQueueSession(session);
    if (changed !== undefined) return "this Pi version does not let ampi move a queued message";
    // Messages queued during compaction wait in Pi's interactive mode, not in the session.
    return (session as SessionQueue)._followUpMessages.length === 0 ? "the queued message waits for compaction to finish" : undefined;
  };
  return {
    steerBlocked,
    steerNext() {
      return steerBlocked() === undefined && steerMmrPiFollowUp(state.mode?.session);
    },
    remove(kind, index, text) {
      return proto[PATCH_KEY] === state && removeMmrPiQueuedMessage(state.mode?.session, kind, index, text);
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
