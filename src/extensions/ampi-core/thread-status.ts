/**
 * Amp-compatible thread status model owned by ampi-core.
 *
 * Turns the events of an agent run into the short status shown at the
 * bottom-left of the prompt box: a phase, its label, an optional detail, and
 * a key hint. The reducer is pure and synchronous. It starts no timers; time
 * only enters through the optional `now` field every event carries, which is
 * what expires the ctrl+c quit hint. A terminal UI owns the instance, maps
 * Pi's extension events onto `MmrThreadStatusEvent`, and renders the result.
 *
 * The reducer keeps independent facts (model activity, running tools,
 * pending approvals, compaction, cancellation, error) and derives the phase
 * from them by priority. Compaction therefore never overwrites the phase it
 * interrupts: when it finishes, the phase underneath shows again.
 *
 * Phase priority, highest first:
 *
 * | Phase             | Shown while                                         |
 * | ----------------- | --------------------------------------------------- |
 * | `compacting`      | a compaction is between start and finish/failure    |
 * | `cancelling`      | an abort was requested and the turn has not ended   |
 * | `error`           | the last run failed and no new turn has started     |
 * | `waitingApproval` | at least one approval request is unanswered         |
 * | `runningTools`    | at least one started tool has not finished          |
 * | `thinking`        | the latest model output was reasoning               |
 * | `streaming`       | the latest model output was text or a tool call     |
 * | `sending`         | a turn is open and the model has produced no output |
 * | `idle`            | nothing of the above                                |
 *
 * Transitions:
 *
 * | Event               | Effect                                                         |
 * | ------------------- | -------------------------------------------------------------- |
 * | `turnStart`         | clears error and cancellation; model activity becomes sending   |
 * |                     | (ignored while an aborted run winds down, see `turnEnd`)       |
 * | `messageUpdate`     | thinking or streaming; records the output-token count if given |
 * | `toolStart`         | adds the tool; activity drops back to sending for the next call |
 * | `toolEnd`           | removes that tool, whatever its outcome; unknown ids are ignored |
 * | `compactionStart`   | sets compacting                                                |
 * | `compactionEnd`     | clears compacting (also on `compactionFailed`); with no turn   |
 * |                     | open it also clears cancellation                               |
 * | `approvalRequest`   | adds a pending approval                                        |
 * | `approvalAnswer`    | removes that approval                                          |
 * | `abort`             | sets cancelling, only while busy                               |
 * | `turnEnd`           | clears tools and approvals; after an abort the thread goes idle |
 * |                     | and stays idle until `settled`                                 |
 * | `settled`           | everything idle except a sticky error and the queue count;     |
 * |                     | ends an aborted run                                            |
 * | `error`             | sets error and stops all activity until the next `turnStart`   |
 * | `queue`             | replaces the queued-message count; survives every phase        |
 * | `quitPressed`       | shows the force-quit hint until `expiresAt`                    |
 * | `tick`              | only advances time                                             |
 *
 * Pi streams one assistant message per turn and runs its tools afterwards, so
 * `turnStart` also resets the output-token count and there is no separate
 * message-start event. Pi emits `turn_end` before `agent_end` and
 * `agent_settled`, even for an aborted or failed response; between turns of
 * one run the next provider request is about to go out, so a normal
 * `turnEnd` leaves the thread `sending` until the next turn or `settled`.
 * After an abort during tools, Pi's loop still runs one more (aborted) turn
 * before `agent_end`, so the reducer ignores `turnStart`, `messageUpdate`
 * and `toolStart` from the end of the aborted turn until `agent_settled`,
 * which Pi emits at the end of every run. A manual compaction runs outside
 * any run and is never followed by `agent_settled`, so its end clears an
 * abort requested during it.
 */

import { formatMmrCompactTokens } from "./token-format.js";

export type MmrThreadPhase =
  | "idle"
  | "sending"
  | "thinking"
  | "streaming"
  | "runningTools"
  | "compacting"
  | "waitingApproval"
  | "cancelling"
  | "error";

/** Fields every status event may carry. */
interface MmrThreadStatusEventBase {
  /** Current time in epoch milliseconds; expires the quit hint when present. */
  now?: number;
}

/**
 * Inputs to the thread status reducer. Each member mirrors one Pi extension
 * event (or a UI action) so a caller can map them one to one.
 */
export type MmrThreadStatusEvent = MmrThreadStatusEventBase &
  (
    /** Pi `turn_start` (or `agent_start`): a new provider request begins. */
    | { type: "turnStart" }
    /**
     * Pi `message_update` for the assistant message. `content` is the kind of
     * delta (`thinking_*` -> `thinking`, `text_*` -> `text`, `toolcall_*` ->
     * `toolCall`). `outputTokens` is the running count of tokens streamed in
     * the current stage. Providers do not update a partial message's usage
     * while it streams, so callers estimate it from the streamed deltas; the
     * status shows it only once it is above zero. Omitted, the last count
     * stays.
     */
    | { type: "messageUpdate"; content: "text" | "thinking" | "toolCall"; outputTokens?: number }
    /** Pi `tool_execution_start`. */
    | { type: "toolStart"; toolCallId: string; toolName: string }
    /** Pi `tool_execution_end`. A failed or cancelled tool does not make the thread fail. */
    | { type: "toolEnd"; toolCallId: string; outcome: "success" | "error" | "cancelled" }
    /** Pi `session_before_compact`. */
    | { type: "compactionStart" }
    /** Pi `session_compact`. */
    | { type: "compactionEnd" }
    /** Pi `session_compact_failed`. */
    | { type: "compactionFailed" }
    /** A tool call is waiting for the user to allow or deny it. */
    | { type: "approvalRequest"; requestId: string }
    /** The user answered the approval request with this id. */
    | { type: "approvalAnswer"; requestId: string }
    /** The user asked to interrupt the running turn. */
    | { type: "abort" }
    /** Pi `turn_end`. */
    | { type: "turnEnd" }
    /** Pi `agent_settled`: no retry, compaction, or queued continuation follows. */
    | { type: "settled" }
    /** The provider request or the run failed (not a single tool). */
    | { type: "error" }
    /** Number of messages waiting to be sent. */
    | { type: "queue"; count: number }
    /** The first ctrl+c; a second one before `expiresAt` force-quits. */
    | { type: "quitPressed"; expiresAt: number }
    /** Advances time without any other change. */
    | { type: "tick"; now: number }
  );

export interface MmrThreadStatus {
  phase: MmrThreadPhase;
  /** Status words for the phase; empty when idle. */
  label: string;
  /** Output-token count while thinking or streaming, or the running tool's name. */
  detail: string;
  /** Key hint for the prompt box; empty when none applies. */
  hint: string;
  /** True while an agent run (or compaction) is in progress. */
  busy: boolean;
  /** Messages waiting to be sent. */
  queued: number;
  /** True when the user is needed: waiting for approval, or after an error. */
  attention: boolean;
}

export interface MmrThreadStatusReducer {
  /** The current status. */
  readonly status: MmrThreadStatus;
  /**
   * Apply one event and return the new status. The returned object is frozen
   * and is the previous object itself when nothing visible changed.
   */
  apply(event: MmrThreadStatusEvent): MmrThreadStatus;
}

interface ThreadState {
  activity: "idle" | "sending" | "thinking" | "streaming";
  outputTokens: number | undefined;
  /** Running tools in start order. */
  tools: ReadonlyArray<{ id: string; name: string }>;
  approvals: readonly string[];
  compacting: boolean;
  cancelling: boolean;
  /** An aborted turn ended; the run is winding down until `settled`. */
  runAborted: boolean;
  error: boolean;
  queued: number;
  quitHintUntil: number | undefined;
}

const LABELS: Readonly<Record<MmrThreadPhase, string>> = {
  idle: "",
  sending: "Sending",
  thinking: "Thinking",
  streaming: "Streaming",
  runningTools: "Running Tools",
  compacting: "Auto-Compacting",
  waitingApproval: "Waiting for Approval",
  cancelling: "Cancelling",
  error: "Error",
};

/** Phases in which Enter queues a steering message for the running agent. */
const STEERABLE_PHASES: ReadonlySet<MmrThreadPhase> = new Set([
  "sending",
  "thinking",
  "streaming",
  "runningTools",
  "compacting",
]);

const INITIAL_STATE: ThreadState = {
  activity: "idle",
  outputTokens: undefined,
  tools: [],
  approvals: [],
  compacting: false,
  cancelling: false,
  runAborted: false,
  error: false,
  queued: 0,
  quitHintUntil: undefined,
};

function phaseOf(state: ThreadState): MmrThreadPhase {
  if (state.compacting) return "compacting";
  if (state.cancelling) return "cancelling";
  if (state.error) return "error";
  if (state.approvals.length > 0) return "waitingApproval";
  if (state.tools.length > 0) return "runningTools";
  return state.activity;
}

function isBusy(state: ThreadState): boolean {
  return state.compacting || state.cancelling || state.approvals.length > 0 || state.tools.length > 0 || state.activity !== "idle";
}

function transition(state: ThreadState, event: MmrThreadStatusEvent): ThreadState {
  if (state.runAborted && (event.type === "turnStart" || event.type === "messageUpdate" || event.type === "toolStart")) {
    return state;
  }
  switch (event.type) {
    case "turnStart":
      return { ...state, activity: "sending", outputTokens: undefined, cancelling: false, error: false };
    case "messageUpdate":
      return {
        ...state,
        activity: event.content === "thinking" ? "thinking" : "streaming",
        outputTokens: typeof event.outputTokens === "number" && Number.isFinite(event.outputTokens) ? event.outputTokens : state.outputTokens,
      };
    case "toolStart":
      if (state.tools.some((tool) => tool.id === event.toolCallId)) return state;
      return {
        ...state,
        activity: "sending",
        outputTokens: undefined,
        tools: [...state.tools, { id: event.toolCallId, name: event.toolName }],
      };
    case "toolEnd":
      return { ...state, tools: state.tools.filter((tool) => tool.id !== event.toolCallId) };
    case "compactionStart":
      return { ...state, compacting: true };
    case "compactionEnd":
    case "compactionFailed": {
      const turnOpen = state.activity !== "idle" || state.tools.length > 0;
      return { ...state, compacting: false, cancelling: state.cancelling && turnOpen };
    }
    case "approvalRequest":
      if (state.approvals.includes(event.requestId)) return state;
      return { ...state, approvals: [...state.approvals, event.requestId] };
    case "approvalAnswer":
      return { ...state, approvals: state.approvals.filter((id) => id !== event.requestId) };
    case "abort":
      return isBusy(state) ? { ...state, cancelling: true } : state;
    case "turnEnd": {
      const runAborted = state.runAborted || state.cancelling;
      return {
        ...state,
        activity: runAborted || state.error ? "idle" : "sending",
        outputTokens: undefined,
        tools: [],
        approvals: [],
        cancelling: false,
        runAborted,
      };
    }
    case "settled":
      return { ...INITIAL_STATE, error: state.error, queued: state.queued, quitHintUntil: state.quitHintUntil };
    case "error":
      return { ...state, activity: "idle", outputTokens: undefined, tools: [], approvals: [], cancelling: false, error: true };
    case "queue":
      return { ...state, queued: Number.isFinite(event.count) ? Math.max(0, Math.floor(event.count)) : 0 };
    case "quitPressed":
      return { ...state, quitHintUntil: event.expiresAt };
    case "tick":
      return state;
  }
}

function expireQuitHint(state: ThreadState, now: number | undefined): ThreadState {
  if (now === undefined || state.quitHintUntil === undefined || now < state.quitHintUntil) return state;
  return { ...state, quitHintUntil: undefined };
}

function deriveStatus(state: ThreadState): MmrThreadStatus {
  const phase = phaseOf(state);
  let detail = "";
  if ((phase === "thinking" || phase === "streaming") && state.outputTokens !== undefined && state.outputTokens > 0) {
    detail = `${formatMmrCompactTokens(state.outputTokens)} tok`;
  } else if (phase === "runningTools") {
    // The oldest running tool is the one the user has waited on longest.
    detail = state.tools[0]?.name ?? "";
  }
  let hint = "";
  if (state.quitHintUntil !== undefined) {
    hint = "ctrl+c again to force quit";
  } else if (STEERABLE_PHASES.has(phase)) {
    hint = state.queued > 0 ? "Enter to steer, Backspace to dequeue" : "Enter to steer";
  }
  return Object.freeze({
    phase,
    label: LABELS[phase],
    detail,
    hint,
    busy: isBusy(state),
    queued: state.queued,
    attention: phase === "waitingApproval" || phase === "error",
  });
}

function sameStatus(a: MmrThreadStatus, b: MmrThreadStatus): boolean {
  return (
    a.phase === b.phase &&
    a.label === b.label &&
    a.detail === b.detail &&
    a.hint === b.hint &&
    a.busy === b.busy &&
    a.queued === b.queued &&
    a.attention === b.attention
  );
}

/**
 * Create a thread status reducer, starting idle with nothing queued.
 */
export function createMmrThreadStatusReducer(): MmrThreadStatusReducer {
  let state = INITIAL_STATE;
  let status = deriveStatus(state);
  return {
    get status() {
      return status;
    },
    apply(event) {
      state = expireQuitHint(transition(state, event), event.now);
      const next = deriveStatus(state);
      if (!sameStatus(status, next)) status = next;
      return status;
    },
  };
}
