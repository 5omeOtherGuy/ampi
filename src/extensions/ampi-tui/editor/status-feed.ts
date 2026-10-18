import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createMmrThreadStatusReducer,
  type MmrThreadStatus,
  type MmrThreadStatusEvent,
  type MmrThreadStatusReducer,
} from "../../ampi-core/thread-status.js";
import { onMmrThreadStatusEvents } from "../../ampi-core/thread-status-events.js";

/**
 * Feeds Pi's agent events into ampi-core's thread status reducer, so the
 * prompt box can show what the running turn is doing.
 *
 * Pi's agent events reach the reducer through ampi-core's mapping
 * (`ampi-core/thread-status-events.ts`, which also estimates the streamed
 * tokens). On top of it the feed starts over at each session start
 * (`reset()`) and keeps the queue count:
 *
 * | Pi event                         | Queue change                               |
 * | -------------------------------- | ------------------------------------------ |
 * | `input` while a turn runs        | one more queued message                    |
 * | `message_start` (user)           | one queued message delivered               |
 * | Pi's queue changed (`followQueue`) | the queue's length                       |
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

  /** Events after which the count is checked against Pi. */
  const syncAfter: ReadonlySet<string> = new Set(["turn_start", "tool_execution_start", "tool_execution_end", "turn_end", "agent_settled"]);
  const mapper = onMmrThreadStatusEvents(pi, ({ name, event, ctx: context, events }) => {
    track(context);
    if (name === "message_update") syncQueue();
    if (name === "message_start" && (event as { message?: { role?: unknown } }).message?.role === "user" && queued > 0 && !exact) {
      setQueued(queued - 1);
    }
    for (const mapped of events) apply(mapped);
    if (syncAfter.has(name)) syncQueue();
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
      mapper.reset();
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
