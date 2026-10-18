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
 * | `message_update` (assistant)     | `messageUpdate`: thinking, text or tool call, with the output tokens the provider reports so far |
 * | `tool_execution_start` / `_end`  | `toolStart` / `toolEnd`                    |
 * | `session_before_compact`         | `compactionStart`                          |
 * | `session_compact` / `_failed`    | `compactionEnd` / `compactionFailed`       |
 * | `turn_end`                       | `error` first when the response failed, then `turnEnd` |
 * | `agent_settled`                  | `settled`                                  |
 * | `input` while a turn runs        | one more queued message                    |
 * | `message_start` (user)           | one queued message delivered               |
 *
 * Pi reports only whether messages are queued, not how many, so the feed
 * counts them and drops the count to zero whenever Pi says none are left.
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
}

type AssistantContent = "text" | "thinking" | "toolCall";

function contentOf(eventType: unknown): AssistantContent | undefined {
  if (typeof eventType !== "string") return undefined;
  if (eventType.startsWith("thinking_")) return "thinking";
  if (eventType.startsWith("text_")) return "text";
  if (eventType.startsWith("toolcall_")) return "toolCall";
  return undefined;
}

function outputTokensOf(message: unknown): number | undefined {
  const usage = (message as { usage?: { output?: unknown } } | undefined)?.usage;
  const output = usage?.output;
  return typeof output === "number" && output > 0 ? output : undefined;
}

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
  let quitTimer: unknown;

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

  /** Pi says nothing is queued: the count can only be stale. */
  function syncQueue(): void {
    if (queued > 0 && ctx && !ctx.hasPendingMessages()) setQueued(0);
  }

  function track(context: ExtensionContext): void {
    ctx = context;
  }

  pi.on("turn_start", (_event, context) => {
    track(context);
    apply({ type: "turnStart" });
    syncQueue();
  });
  pi.on("message_start", (event, context) => {
    track(context);
    if ((event.message as { role?: unknown }).role === "user" && queued > 0) setQueued(queued - 1);
  });
  pi.on("message_update", (event, context) => {
    track(context);
    const content = contentOf(event.assistantMessageEvent?.type);
    if (!content) return;
    apply({ type: "messageUpdate", content, outputTokens: outputTokensOf(event.message) });
  });
  pi.on("tool_execution_start", (event, context) => {
    track(context);
    apply({ type: "toolStart", toolCallId: event.toolCallId, toolName: event.toolName });
  });
  pi.on("tool_execution_end", (event, context) => {
    track(context);
    apply({ type: "toolEnd", toolCallId: event.toolCallId, outcome: event.isError ? "error" : "success" });
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
    if (event.streamingBehavior) setQueued(queued + 1);
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
  };
}
