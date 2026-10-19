import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MmrGuiDialogAnswer, MmrGuiDialogOptions, MmrGuiDialogRequest } from "../ampi-core/gui-host.js";
import { getMmrPromptQueue, type MmrQueuedPrompts, onMmrPromptQueueChanged } from "../ampi-core/prompt-queue.js";
import { getMmrModeState, onMmrApproval, onMmrStateChanged } from "../ampi-core/runtime.js";
import {
  createMmrThreadStatusReducer,
  type MmrThreadStatus,
  type MmrThreadStatusEvent,
  type MmrThreadStatusReducer,
} from "../ampi-core/thread-status.js";
import { createMmrGuiDialogQueue, type MmrGuiDialog, type MmrGuiDialogCloser } from "./dialogs.js";
import {
  buildMmrGuiGroups,
  buildMmrGuiItem,
  buildMmrGuiToolPart,
  collectMmrGuiToolResults,
  type MmrGuiGroup,
  type MmrGuiItem,
  type MmrGuiToolResult,
  mmrGuiBranchMessages,
  mmrGuiItemId,
  mmrGuiSessionTitle,
} from "./view-model.js";

/**
 * Mirrors the running Pi session for the web client.
 *
 * The bridge listens to Pi's agent events, feeds them to ampi-core's thread
 * status reducer the way the terminal's prompt box does, and turns them into
 * numbered events for the client:
 *
 * | Pi event                                   | Client event                          |
 * | ------------------------------------------ | ------------------------------------- |
 * | `message_start` (user or assistant)        | `item`: the whole message             |
 * | `message_update` text or thinking delta    | `delta`: the appended text            |
 * | `message_update` new block, finished call  | `item`                                |
 * | `message_end` (assistant)                  | `item`                                |
 * | `tool_execution_start` / `_end`            | `tool`: the call's row                |
 * | `turn_end`                                 | `turn_end`                            |
 * | any of the above that changes a work group | `groups`: the changed groups, the removed ids |
 * | `mmr-core:approval` request / answer       | `status` (waiting for approval, and back) |
 * | any change of the thread status            | `status` (phase, label, queue count)  |
 * | `session_info_changed`, `model_select`, mode change, first prompt | `session` |
 * | a change of the prompt queue (ampi-core's seam) | `queue`: the texts, or `null` |
 * | an extension's `ctx.ui` question, hosted sessions only (`ask`) | `dialog`, then `dialog_closed` (see `dialogs.ts`) |
 * | an extension's `ctx.ui.notify`, hosted sessions only (`notice`) | `notice`: `{ message, level }` |
 *
 * Pi's streaming message is one object that the provider keeps filling, so
 * by the time an event is handled it may already hold text from later
 * deltas. The bridge therefore never reads a streaming text or thinking
 * block from it: it builds each block's text from the deltas it has seen and
 * shows only the blocks whose start it has seen, in `item` events and in the
 * snapshot alike. A client that applies the deltas after either one ends up
 * with each delta once. The finished message from `message_end` replaces the
 * copy; when Pi ends a message early (an interrupt) it has a new id, and its
 * `item` event names the streamed one in `replaces`.
 *
 * Work groups are computed over the same messages as the snapshot, after
 * every event that can add a call, end one or split a run, and sent before
 * the `item` or `tool` event that caused the change, so the client draws a
 * new call inside its group at once.
 *
 * It keeps the last {@link MMR_GUI_REPLAY_LIMIT} events, so a client that
 * reconnects with the id of the last event it saw gets what it missed. A
 * snapshot (`snapshot()`) joins the saved branch with the messages of the
 * current run that Pi has not written yet, and names the id of the last
 * event it includes, so a client can load it and then follow the events
 * after that id without gaps or repeats.
 *
 * The queued messages come from ampi-core's prompt-queue seam, which
 * `ampi-tui` owns while it can read Pi's queue; their number is then the
 * queue count. Without an owner the texts are unknown (`null`) and the count
 * is counted as in the terminal: one more for each input sent while a turn
 * runs, one less for each user message that starts, and checked against
 * `hasPendingMessages()` on every agent event.
 */

export const MMR_GUI_REPLAY_LIMIT = 1000;

export interface MmrGuiEvent {
  id: number;
  event: "status" | "item" | "delta" | "tool" | "groups" | "turn_end" | "session" | "queue" | "dialog" | "dialog_closed" | "notice";
  data: unknown;
}

export interface MmrGuiStatusView {
  phase: MmrThreadStatus["phase"];
  label: string;
  detail: string;
  busy: boolean;
  queued: number;
}

export interface MmrGuiSessionInfo {
  id: string;
  title: string;
  cwd: string;
  /**
   * ampi mode key, e.g. `medium`, a registered mode's label (its key for a
   * session read from its file), or `null` outside a locked mode.
   */
  mode: string | null;
  /** `provider/model`, or `null` when none is selected. */
  model: string | null;
}

export interface MmrGuiSnapshot {
  session: MmrGuiSessionInfo;
  status: MmrGuiStatusView;
  items: MmrGuiItem[];
  /** The work groups of `items`, in transcript order. */
  groups: MmrGuiGroup[];
  /** The queued messages, or `null` when no extension can read Pi's queue. */
  queue: MmrQueuedPrompts | null;
  /** The open questions the page answers, or `null` when extensions ask in the terminal. */
  dialogs: MmrGuiDialog[] | null;
  /** Id of the last event the snapshot includes. */
  lastEventId: number;
}

export interface MmrGuiBridge {
  /** Start mirroring this session. Events before the first `start` are ignored. */
  /** Start mirroring this session; with `dialogs`, extensions' questions are asked on the page (a session `ampi app` hosts). */
  start(ctx: ExtensionContext, options?: { dialogs?: boolean }): void;
  /** Stop mirroring and drop every listener. */
  stop(): void;
  /** The context of the mirrored session, between `start` and `stop`. */
  context(): ExtensionContext | undefined;
  /** Note that the user asked to interrupt the running turn. */
  interrupted(): void;
  readonly lastEventId: number;
  session(): MmrGuiSessionInfo;
  status(): MmrGuiStatusView;
  snapshot(): MmrGuiSnapshot;
  /** The buffered events after `id`, or `undefined` when some of them are no longer buffered. */
  eventsAfter(id: number): MmrGuiEvent[] | undefined;
  /** Call `listener` with every new event. Returns the unsubscribe function. */
  subscribe(listener: (event: MmrGuiEvent) => void): () => void;
  /** Ask the page; resolves cancelled at once when the bridge was not started with `dialogs`. See `dialogs.ts`. */
  ask(request: MmrGuiDialogRequest, options?: MmrGuiDialogOptions): Promise<MmrGuiDialogAnswer>;
  /** The page's answer to an open question. */
  answerDialog(id: string, answer: { cancelled: true } | { value: unknown }): "answered" | "unknown" | "invalid";
  /** Cancel every open question; returns how many there were. */
  cancelDialogs(by: MmrGuiDialogCloser): number;
  /** Show an extension's notification on the page (a `notice` event). */
  notice(message: string, level: "info" | "warning" | "error"): void;
  /** A page opened the event stream; call the returned function when it closes. */
  watch(): () => void;
}

export interface MmrGuiBridgeOptions {
  now?: () => number;
  home?: string;
  replayLimit?: number;
  /** Timers of the dialogs' timeouts and of the unattended cancel; default `setTimeout`, unref'd. */
  setTimer?: (callback: () => unknown, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Ids of new questions; default random (see `dialogs.ts`). */
  createDialogId?: () => string;
}

type Content = "text" | "thinking" | "toolCall";

function contentOf(eventType: unknown): Content | undefined {
  if (typeof eventType !== "string") return undefined;
  if (eventType.startsWith("thinking_")) return "thinking";
  if (eventType.startsWith("text_")) return "text";
  if (eventType.startsWith("toolcall_")) return "toolCall";
  return undefined;
}

const BYTES_PER_TOKEN = 4;

function roleOf(message: unknown): unknown {
  return (message as { role?: unknown } | undefined)?.role;
}

function statusView(status: MmrThreadStatus): MmrGuiStatusView {
  return { phase: status.phase, label: status.label, detail: status.detail, busy: status.busy, queued: status.queued };
}

export function createMmrGuiBridge(pi: ExtensionAPI, options: MmrGuiBridgeOptions = {}): MmrGuiBridge {
  const now = options.now ?? Date.now;
  const home = options.home ?? homedir();
  const replayLimit = options.replayLimit ?? MMR_GUI_REPLAY_LIMIT;
  const dialogs = createMmrGuiDialogQueue({
    emit: (event, data) => emit(event, data),
    now,
    setTimer:
      options.setTimer ??
      ((callback, ms) => {
        const handle = setTimeout(callback, ms);
        handle.unref();
        return handle;
      }),
    clearTimer: options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
    createId: options.createDialogId,
  });
  /** Whether the page answers extensions' questions (a hosted session). */
  let asksPage = false;
  let ctx: ExtensionContext | undefined;
  let reducer: MmrThreadStatusReducer = createMmrThreadStatusReducer();
  let queued = 0;
  /** Whether the count follows the published queue rather than being counted. */
  let exact = false;
  let stageBytes = 0;
  let stage: "thinking" | "streaming" | undefined;
  let nextId = 1;
  const buffer: MmrGuiEvent[] = [];
  const listeners = new Set<(event: MmrGuiEvent) => void>();
  /** Messages of the current run, by item id, in the order they started. */
  const live = new Map<string, unknown>();
  /** Tool results of the current run, by call id. */
  const liveResults = new Map<string, MmrGuiToolResult>();
  /** Streaming assistant messages, by item id: the blocks started so far and their text from the deltas. */
  const streams = new Map<string, { started: number; text: Map<number, string> }>();
  /** The work groups clients know, as JSON by group id. */
  let sentGroups = new Map<string, string>();
  let titled = false;

  function emit(event: MmrGuiEvent["event"], data: unknown): void {
    const entry: MmrGuiEvent = { id: nextId++, event, data };
    buffer.push(entry);
    if (buffer.length > replayLimit) buffer.splice(0, buffer.length - replayLimit);
    for (const listener of [...listeners]) {
      try {
        listener(entry);
      } catch {}
    }
  }

  function apply(event: MmrThreadStatusEvent): void {
    const before = reducer.status;
    const after = reducer.apply({ now: now(), ...event });
    if (after !== before) emit("status", statusView(after));
  }

  function setQueued(count: number): void {
    if (count === queued) return;
    queued = count;
    apply({ type: "queue", count });
  }

  function syncQueue(): void {
    if (!ctx || exact) return;
    if (!ctx.hasPendingMessages()) setQueued(0);
    else if (queued === 0) setQueued(1);
  }

  function viewOptions() {
    const busy = reducer.status.busy;
    return { cwd: ctx?.cwd, home, pending: (id: string) => busy && !liveResults.has(id) };
  }

  /** A streaming message as far as the events so far describe it. */
  function streamed(message: unknown): unknown {
    const id = mmrGuiItemId(message);
    const stream = id ? streams.get(id) : undefined;
    const content = (message as { content?: unknown }).content;
    if (!stream || !Array.isArray(content)) return message;
    const blocks = content.slice(0, stream.started).map((block, index) => {
      const text = stream.text.get(index);
      if (text === undefined) return block;
      return block?.type === "thinking" ? { ...block, thinking: text } : { ...block, text };
    });
    return { ...(message as object), content: blocks };
  }

  function buildItem(message: unknown): MmrGuiItem | undefined {
    return buildMmrGuiItem(streamed(message), liveResults, viewOptions());
  }

  /** The saved branch, then the messages of the current run Pi has not written yet; the results of both. */
  function merged(): { messages: unknown[]; results: Map<string, MmrGuiToolResult> } {
    const messages = ctx ? mmrGuiBranchMessages(ctx.sessionManager.getBranch()) : [];
    const saved = new Set(messages.map(mmrGuiItemId));
    for (const [id, message] of live) if (!saved.has(id)) messages.push(streamed(message));
    const results = collectMmrGuiToolResults(messages);
    for (const [id, result] of liveResults) results.set(id, result);
    return { messages, results };
  }

  function currentGroups(): MmrGuiGroup[] {
    const { messages, results } = merged();
    const busy = reducer.status.busy;
    return buildMmrGuiGroups(messages, results, { cwd: ctx?.cwd, home, pending: (id) => busy && !results.has(id) });
  }

  /** Send the work groups that changed since clients last heard of them. */
  function syncGroups(): void {
    if (!ctx) return;
    const groups = currentGroups();
    const next = new Map(groups.map((group) => [group.id, JSON.stringify(group)]));
    const changed = groups.filter((group) => sentGroups.get(group.id) !== next.get(group.id));
    const removed = [...sentGroups.keys()].filter((id) => !next.has(id));
    sentGroups = next;
    if (changed.length > 0 || removed.length > 0) emit("groups", { groups: changed, removed });
  }

  function sessionInfo(): MmrGuiSessionInfo {
    if (!ctx) return { id: "", title: "New thread", cwd: "", mode: null, model: null };
    const manager = ctx.sessionManager;
    const firstUser = mmrGuiBranchMessages(manager.getBranch()).find((message) => roleOf(message) === "user");
    const liveUser = [...live.values()].find((message) => roleOf(message) === "user");
    const firstItem = buildMmrGuiItem(firstUser ?? liveUser, new Map());
    const mode = getMmrModeState();
    return {
      id: manager.getSessionId(),
      title: mmrGuiSessionTitle(manager.getSessionName(), firstItem ? [firstItem] : []),
      cwd: ctx.cwd,
      // A registered mode shows by its label.
      mode: mode?.registeredMode?.label ?? mode?.mode ?? null,
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
    };
  }

  /** The live message holding tool call `id`, and that call. */
  function findCall(id: string): { message: unknown; call: { id: string; name: string; arguments?: unknown } } | undefined {
    for (const message of [...live.values()].reverse()) {
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      const call = content.find((block) => block?.type === "toolCall" && block.id === id);
      if (call) return { message, call };
    }
    return undefined;
  }

  function emitTool(toolCallId: string): void {
    const found = findCall(toolCallId);
    const itemId = found && mmrGuiItemId(found.message);
    if (!found || !itemId) return;
    const { pending } = viewOptions();
    const part = buildMmrGuiToolPart(found.call, liveResults.get(toolCallId), { cwd: ctx?.cwd, home, pending: pending(toolCallId) });
    syncGroups();
    emit("tool", { itemId, part });
  }

  /** Send `message` as an item; `replaces` names the item it takes the place of. */
  function upsert(message: unknown, replaces?: string): void {
    const id = mmrGuiItemId(message);
    if (!id) return;
    live.set(id, message);
    syncGroups();
    const item = buildItem(message);
    if (item) emit("item", replaces ? { ...item, replaces } : item);
  }

  // Events arrive for every run mode; the bridge only acts between start and stop.
  const active = (context: ExtensionContext): boolean => {
    if (!ctx) return false;
    ctx = context;
    return true;
  };

  pi.on("turn_start", (_event, context) => {
    if (!active(context)) return;
    stage = undefined;
    stageBytes = 0;
    apply({ type: "turnStart" });
    syncQueue();
  });
  pi.on("message_start", (event, context) => {
    if (!active(context)) return;
    const role = roleOf(event.message);
    if (role === "assistant") {
      stage = undefined;
      stageBytes = 0;
      const id = mmrGuiItemId(event.message);
      if (id) streams.set(id, { started: 0, text: new Map() });
    }
    if (role === "user" && queued > 0 && !exact) setQueued(queued - 1);
    if (role !== "user" && role !== "assistant") return;
    upsert(event.message);
    if (role === "user" && !titled && !ctx?.sessionManager.getSessionName()) {
      titled = true;
      emit("session", sessionInfo());
    }
  });
  pi.on("message_update", (event, context) => {
    if (!active(context)) return;
    syncQueue();
    const update = event.assistantMessageEvent as { type?: unknown; delta?: unknown; contentIndex?: unknown } | undefined;
    const content = contentOf(update?.type);
    const id = mmrGuiItemId(event.message);
    if (id) live.set(id, event.message);
    if (content) {
      const nextStage = content === "thinking" ? "thinking" : "streaming";
      if (nextStage !== stage) {
        stage = nextStage;
        stageBytes = 0;
      }
      if (typeof update?.delta === "string") stageBytes += Buffer.byteLength(update.delta, "utf8");
      apply({ type: "messageUpdate", content, outputTokens: Math.ceil(stageBytes / BYTES_PER_TOKEN) });
    }
    if (!id) return;
    const type = String(update?.type ?? "");
    const index = update?.contentIndex;
    const stream = streams.get(id);
    if (stream && content && typeof index === "number") {
      stream.started = Math.max(stream.started, index + 1);
      if (type === "text_start" || type === "thinking_start") stream.text.set(index, "");
    }
    if ((type === "text_delta" || type === "thinking_delta") && typeof update?.delta === "string") {
      if (stream && typeof index === "number") {
        const before = stream.text.get(index) ?? "";
        stream.text.set(index, before + update.delta);
        // The first visible text of a message ends the run of calls before it.
        if (type === "text_delta" && before.trim() === "" && update.delta.trim() !== "") syncGroups();
      }
      emit("delta", { itemId: id, part: index, text: update.delta });
    } else if (type.endsWith("_start") || type === "start" || type === "toolcall_end") {
      syncGroups();
      const item = buildItem(event.message);
      if (item) emit("item", item);
    }
  });
  pi.on("message_end", (event, context) => {
    if (!active(context)) return;
    if (roleOf(event.message) !== "assistant") return;
    const id = mmrGuiItemId(event.message);
    // A message Pi ends early, on an interrupt, carries a new timestamp and
    // so a new id: it takes the place of the copy that streamed.
    const streamed = [...streams.keys()].find((key) => key !== id);
    if (streamed) {
      streams.delete(streamed);
      live.delete(streamed);
    }
    if (id) streams.delete(id);
    upsert(event.message, streamed);
  });
  pi.on("tool_execution_start", (event, context) => {
    if (!active(context)) return;
    stage = undefined;
    stageBytes = 0;
    apply({ type: "toolStart", toolCallId: event.toolCallId, toolName: event.toolName });
    syncQueue();
    emitTool(event.toolCallId);
  });
  pi.on("tool_execution_end", (event, context) => {
    if (!active(context)) return;
    const result = (event.result ?? {}) as { content?: unknown; details?: unknown };
    liveResults.set(event.toolCallId, {
      content: Array.isArray(result.content) ? result.content : [],
      details: result.details,
      isError: event.isError,
      timestamp: now(),
    });
    apply({ type: "toolEnd", toolCallId: event.toolCallId, outcome: event.isError ? "error" : "success" });
    syncQueue();
    emitTool(event.toolCallId);
  });
  pi.on("session_before_compact", (_event, context) => {
    if (active(context)) apply({ type: "compactionStart" });
  });
  pi.on("session_compact", (_event, context) => {
    if (active(context)) apply({ type: "compactionEnd" });
  });
  pi.on("session_compact_failed", (_event, context) => {
    if (active(context)) apply({ type: "compactionFailed" });
  });
  pi.on("turn_end", (event, context) => {
    if (!active(context)) return;
    const message = event.message as { role?: unknown; stopReason?: unknown } | undefined;
    if (message?.role === "assistant" && message.stopReason === "error") apply({ type: "error" });
    apply({ type: "turnEnd" });
    syncQueue();
    emit("turn_end", { turnIndex: event.turnIndex });
  });
  pi.on("agent_settled", (_event, context) => {
    if (!active(context)) return;
    apply({ type: "settled" });
    syncQueue();
    // Pi has written every message of the run by now.
    live.clear();
    liveResults.clear();
    streams.clear();
    // Calls that never got a result now count as cancelled.
    syncGroups();
  });
  pi.on("input", (event, context) => {
    if (!active(context)) return;
    if (event.streamingBehavior && !exact) setQueued(queued + 1);
  });
  pi.on("session_info_changed", (_event, context) => {
    if (active(context)) emit("session", sessionInfo());
  });
  pi.on("model_select", (_event, context) => {
    if (active(context)) emit("session", sessionInfo());
  });
  let releaseMode: (() => void) | undefined;
  let releaseQueue: (() => void) | undefined;
  let releaseApproval: (() => void) | undefined;

  function queueView(): MmrQueuedPrompts | null {
    return getMmrPromptQueue() ?? null;
  }

  function followQueue(): void {
    const queue = queueView();
    exact = queue !== null;
    if (queue) setQueued(queue.steering.length + queue.followUp.length);
    else syncQueue();
    emit("queue", queue);
  }

  return {
    start(context, startOptions = {}) {
      ctx = context;
      asksPage = startOptions.dialogs === true;
      reducer = createMmrThreadStatusReducer();
      queued = 0;
      titled = false;
      live.clear();
      liveResults.clear();
      streams.clear();
      // Clients start from a snapshot, which holds the groups so far.
      sentGroups = new Map(currentGroups().map((group) => [group.id, JSON.stringify(group)]));
      releaseMode ??= onMmrStateChanged(pi, () => {
        if (ctx) emit("session", sessionInfo());
      });
      releaseQueue ??= onMmrPromptQueueChanged(() => {
        if (ctx) followQueue();
      });
      releaseApproval ??= onMmrApproval(pi, (event) => {
        if (ctx) apply({ type: event.phase === "request" ? "approvalRequest" : "approvalAnswer", requestId: event.requestId });
      });
      const queue = queueView();
      exact = queue !== null;
      if (queue) setQueued(queue.steering.length + queue.followUp.length);
    },
    stop() {
      // An extension still waiting for an answer gets a cancel, and the pages hear of it.
      dialogs.cancelAll("shutdown");
      asksPage = false;
      ctx = undefined;
      listeners.clear();
      releaseMode?.();
      releaseMode = undefined;
      releaseQueue?.();
      releaseQueue = undefined;
      releaseApproval?.();
      releaseApproval = undefined;
    },
    context: () => ctx,
    interrupted() {
      if (ctx) apply({ type: "abort" });
    },
    get lastEventId() {
      return nextId - 1;
    },
    session: sessionInfo,
    status: () => statusView(reducer.status),
    snapshot() {
      // Clients that follow the events get any change first, so the snapshot and the events agree.
      syncGroups();
      const { messages, results } = merged();
      const pending = (id: string) => reducer.status.busy && !results.has(id);
      const items: MmrGuiItem[] = [];
      const seen = new Set<string>();
      for (const message of messages) {
        const item = buildMmrGuiItem(message, results, { cwd: ctx?.cwd, home, pending });
        if (item && !seen.has(item.id)) {
          seen.add(item.id);
          items.push(item);
        }
      }
      const groups = buildMmrGuiGroups(messages, results, { cwd: ctx?.cwd, home, pending });
      return {
        session: sessionInfo(),
        status: statusView(reducer.status),
        items,
        groups,
        queue: queueView(),
        dialogs: asksPage ? dialogs.pending() : null,
        lastEventId: nextId - 1,
      };
    },
    eventsAfter(id) {
      const last = nextId - 1;
      if (id === last) return [];
      // An id this bridge never issued: the client saw another server.
      if (id > last || id < 0) return undefined;
      const first = buffer[0]?.id ?? nextId;
      if (id < first - 1) return undefined;
      return buffer.filter((event) => event.id > id);
    },
    ask(request, dialogOptions) {
      if (!ctx || !asksPage) return Promise.resolve({ cancelled: true });
      return dialogs.ask(request, dialogOptions);
    },
    answerDialog: (id, answer) => dialogs.answer(id, answer),
    cancelDialogs: (by) => dialogs.cancelAll(by),
    notice(message, level) {
      if (ctx) emit("notice", { message, level });
    },
    watch: () => dialogs.watch(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
