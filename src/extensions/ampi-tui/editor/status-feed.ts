import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createMmrThreadStatusReducer,
  type MmrThreadStatus,
  type MmrThreadStatusEvent,
  type MmrThreadStatusReducer,
} from "../../ampi-core/thread-status.js";

/**
 * Feeds Pi's agent events into ampi-core's thread status reducer, so the
 * prompt box can show what the running turn is doing.
 *
 * | Pi event                         | Reducer event                              |
 * | -------------------------------- | ------------------------------------------ |
 * | session start (`reset()`)        | starts over with a fresh reducer           |
 * | `turn_start`                    | `turnStart`                                |
 * | `message_update` (assistant)     | `messageUpdate`: thinking, text or tool call, with the tokens streamed in the current stage |
 * | `tool_execution_start` / `_end`  | `toolStart` / `toolEnd`                    |
 * | `session_before_compact`         | `compactionStart`                          |
 * | `session_compact` / `_failed`    | `compactionEnd` / `compactionFailed`       |
 * | `turn_end`                       | `error` first when the response failed, then `turnEnd` |
 * | `agent_settled`                  | `settled`                                  |
 * | `input` while a turn runs        | one more queued message                    |
 * | `message_start` (user)           | one queued message delivered               |
 * | Pi's queue changed (`followQueue`) | the queue's length                       |
 *
 * The token count is an estimate: the UTF-8 bytes of the deltas streamed
 * since the stage began (thinking, or text and tool calls), four bytes to a
 * token. Pi's providers fill in a message's output usage when it starts or
 * when it ends, not while it streams (the faux model sets its whole total up
 * front), so the partial message's usage cannot count up during a stage.
 *
 * Pi's extension API reports only whether messages are queued, not how
 * many. Where ampi can read Pi's queue (`pi-compat/queue.ts`), it hands the
 * length to `followQueue()` on every change, and from then on that is the
 * count. Otherwise the feed counts them: one more for each input sent while
 * a turn runs, one less for each user message that starts. On every agent
 * event it then checks the count against Pi: zero when Pi has none left, at
 * least one when Pi has some. A queue changed some other way (Pi's own
 * dequeue key, or an input another extension handled) then shows the right
 * hint by the next event.
 *
 * Two signals come from ampi's keys rather than from Pi: `abort()` when the
 * user interrupts the turn, and `setQuitHint()` while the quit chord waits
 * for its second Ctrl+C.
 */

export interface MmrStatusFeedOptions {
  /** Called after each change of the visible status. */
  readonly onChange?: (status: MmrThreadStatus) => void;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export interface MmrStatusFeed {
  readonly status: MmrThreadStatus;
  /** Start over for a new session: idle, nothing queued, no hint. */
  reset(ctx: ExtensionContext): void;
  /** The user asked to interrupt the running turn. */
  abort(): void;
  /** Show the force-quit hint until `until` (epoch ms); `undefined` removes it now. */
  setQuitHint(until: number | undefined): void;
  /** Re-read whether messages are still queued (after the user took them back). */
  refreshQueue(): void;
  /** Pi's queue now holds `count` messages. From the first call on, the count follows these reports alone. */
  followQueue(count: number): void;
}

type AssistantContent = "text" | "thinking" | "toolCall";

function contentOf(eventType: unknown): AssistantContent | undefined {
  if (typeof eventType !== "string") return undefined;
  if (eventType.startsWith("thinking_")) return "thinking";
  if (eventType.startsWith("text_")) return "text";
  if (eventType.startsWith("toolcall_")) return "toolCall";
  return undefined;
}

/** Bytes per token for the streamed-token estimate. */
const BYTES_PER_TOKEN = 4;

function failed(message: unknown): boolean {
  const record = message as { role?: unknown; stopReason?: unknown } | undefined;
  return record?.role === "assistant" && record.stopReason === "error";
}

export function createMmrStatusFeed(pi: ExtensionAPI, options: MmrStatusFeedOptions = {}): MmrStatusFeed {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let reducer: MmrThreadStatusReducer = createMmrThreadStatusReducer();
  let ctx: ExtensionContext | undefined;
  let queued = 0;
  /** Pi reports its queue length: no counting, no checking. */
  let exact = false;
  let quitTimer: unknown;
  /** The stage being counted (`thinking` or `streaming`) and the bytes streamed in it. */
  let stage: "thinking" | "streaming" | undefined;
  let stageBytes = 0;

  function apply(event: MmrThreadStatusEvent): void {
    const before = reducer.status;
    const after = reducer.apply({ now: now(), ...event });
    if (after !== before) options.onChange?.(after);
  }

  function setQueued(count: number): void {
    if (count === queued) return;
    queued = count;
    apply({ type: "queue", count });
  }

  /** Match the count to what Pi says: none left, or at least one. */
  function syncQueue(): void {
    if (!ctx || exact) return;
    if (!ctx.hasPendingMessages()) setQueued(0);
    else if (queued === 0) setQueued(1);
  }

  function track(context: ExtensionContext): void {
    ctx = context;
  }

  function newStage(): void {
    stage = undefined;
    stageBytes = 0;
  }

  pi.on("turn_start", (_event, context) => {
    track(context);
    newStage();
    apply({ type: "turnStart" });
    syncQueue();
  });
  pi.on("message_start", (event, context) => {
    track(context);
    const role = (event.message as { role?: unknown }).role;
    if (role === "assistant") newStage();
    if (role === "user" && queued > 0 && !exact) setQueued(queued - 1);
  });
  pi.on("message_update", (event, context) => {
    track(context);
    syncQueue();
    const update = event.assistantMessageEvent;
    const content = contentOf(update?.type);
    if (!content) return;
    const nextStage = content === "thinking" ? "thinking" : "streaming";
    if (nextStage !== stage) {
      stage = nextStage;
      stageBytes = 0;
    }
    const delta = (update as { delta?: unknown }).delta;
    if (typeof delta === "string") stageBytes += Buffer.byteLength(delta, "utf8");
    apply({ type: "messageUpdate", content, outputTokens: Math.ceil(stageBytes / BYTES_PER_TOKEN) });
  });
  pi.on("tool_execution_start", (event, context) => {
    track(context);
    newStage();
    apply({ type: "toolStart", toolCallId: event.toolCallId, toolName: event.toolName });
    syncQueue();
  });
  pi.on("tool_execution_end", (event, context) => {
    track(context);
    apply({ type: "toolEnd", toolCallId: event.toolCallId, outcome: event.isError ? "error" : "success" });
    syncQueue();
  });
  pi.on("session_before_compact", (_event, context) => {
    track(context);
    apply({ type: "compactionStart" });
  });
  pi.on("session_compact", (_event, context) => {
    track(context);
    apply({ type: "compactionEnd" });
  });
  pi.on("session_compact_failed", (_event, context) => {
    track(context);
    apply({ type: "compactionFailed" });
  });
  pi.on("turn_end", (event, context) => {
    track(context);
    if (failed(event.message)) apply({ type: "error" });
    apply({ type: "turnEnd" });
    syncQueue();
  });
  pi.on("agent_settled", (_event, context) => {
    track(context);
    apply({ type: "settled" });
    syncQueue();
  });
  pi.on("input", (event, context) => {
    track(context);
    if (event.streamingBehavior && !exact) setQueued(queued + 1);
  });

  return {
    get status() {
      return reducer.status;
    },
    reset(context) {
      track(context);
      if (quitTimer !== undefined) clearTimer(quitTimer);
      quitTimer = undefined;
      queued = 0;
      newStage();
      const before = JSON.stringify(reducer.status);
      reducer = createMmrThreadStatusReducer();
      if (JSON.stringify(reducer.status) !== before) options.onChange?.(reducer.status);
    },
    abort() {
      apply({ type: "abort" });
    },
    setQuitHint(until) {
      if (quitTimer !== undefined) clearTimer(quitTimer);
      quitTimer = undefined;
      const at = now();
      // An expiry at or before now removes the hint at once.
      apply({ type: "quitPressed", expiresAt: until ?? at });
      if (until === undefined || until <= at) return;
      quitTimer = setTimer(() => {
        quitTimer = undefined;
        apply({ type: "tick", now: now() });
      }, until - at);
    },
    refreshQueue: syncQueue,
    followQueue(count) {
      exact = true;
      setQueued(count);
    },
  };
}
