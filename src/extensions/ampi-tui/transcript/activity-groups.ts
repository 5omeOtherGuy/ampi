/**
 * Groups of consecutive tool calls in the transcript.
 *
 * Pi draws one row per tool call and hands a renderer only its own call, so
 * this store follows the session's messages to know which calls sit next to
 * each other. Where a run of calls ends is decided by ampi-core's
 * `activity-runs.ts`, which the web GUI shares: an assistant message with
 * text (Pi draws a message's text above all of its calls), a user or steered
 * message, a summary or a custom message, and a call that stands alone: a
 * subagent call, a question to the user, or a call whose result shows an
 * image where the terminal shows images. Thinking, failed calls and a change
 * of kind do not end a run.
 *
 * The store is fed from Pi's events while a session runs, checked against
 * the session's messages when an assistant message starts, and rebuilt from
 * them when a session starts or reloads, is compacted or moves to another
 * branch. Rows register their redraw callback, and the
 * store redraws the rows a change affects: the first row of a group, which
 * draws the summary, and rows that moved to another group or position.
 */

import {
  type ExtensionAPI,
  type ExtensionContext,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities } from "@earendil-works/pi-tui";
import { endsActivityRun, groupActivityRuns, shownOnItsOwn, standsAlone as callStandsAlone, toolCallBlocks } from "../../ampi-core/activity-runs.js";
import {
  type ActivityEntry,
  type ActivityStatus,
  type ClassifyOptions,
  classifyToolCall,
  resultStatus,
  summarizeActivities,
} from "../../ampi-core/tool-activity.js";

type ToolResult = NonNullable<ClassifyOptions["result"]>;

/** The parts of a Pi message the store reads. */
export interface GroupMessage {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  display?: boolean;
  toolCallId?: string;
  isError?: boolean;
  details?: unknown;
}

export interface GroupedCall {
  readonly id: string;
  toolName: string;
  args: unknown;
  result?: ToolResult;
  isError: boolean;
  /** Execution started while this store listened; a call restored from the session never runs again. */
  started: boolean;
  /** Expansion of the call's row when it last drew. */
  expanded?: boolean;
}

export interface ActivityGroup {
  readonly calls: readonly GroupedCall[];
}

export interface GroupPosition {
  group: ActivityGroup;
  index: number;
}

export interface GroupAggregate {
  entries: ActivityEntry[];
  /** "Ran 3 commands, read 4 files, edited 2 files (+265 -4)". */
  summary: string;
  /** Running while a call runs, cancelled when one was cancelled, otherwise done, also when a call failed. */
  status: ActivityStatus;
  /** A call that started while the store listened still runs, so the summary row animates. */
  live: boolean;
}

/** The calls of one assistant message, or a message drawn between calls (`boundary` without calls). */
interface MessageRecord {
  /** Something is drawn between the calls before this record and its own calls. */
  boundary: boolean;
  callIds: string[];
}

/** The result Pi shows on the calls of an assistant message that was aborted or failed. */
function interruptedResult(message: GroupMessage): ToolResult | undefined {
  if (message.stopReason === "aborted") return { content: [{ type: "text", text: "Operation aborted" }] };
  if (message.stopReason === "error") return { content: [{ type: "text", text: message.errorMessage || "Error" }] };
  return undefined;
}

/**
 * Subagent calls, questions to the user, and calls whose result shows an
 * image: Pi draws the image below the call's row even when the row draws
 * nothing, so the row keeps its own title above it.
 */
function standsAlone(call: GroupedCall): boolean {
  return callStandsAlone(call.toolName, call.result, Boolean(getCapabilities().images));
}

function callStatus(call: GroupedCall): ActivityStatus {
  return call.result ? resultStatus(call.isError, call.result) : "running";
}

export class ActivityGroupStore {
  private records: MessageRecord[] = [];
  private readonly calls = new Map<string, GroupedCall>();
  /** The assistant message being streamed. */
  private current?: MessageRecord;
  private positions = new Map<string, GroupPosition>();
  private readonly redraws = new Map<string, () => void>();

  /** Forget everything, including the rows' redraw callbacks. */
  clear(): void {
    this.records = [];
    this.calls.clear();
    this.current = undefined;
    this.positions = new Map();
    this.redraws.clear();
  }

  /** Replace the store's contents with the messages the transcript shows, in order, and redraw every known row. */
  rebuild(messages: readonly GroupMessage[]): void {
    this.calls.clear();
    this.load(messages);
    this.regroup();
    for (const [id, redraw] of [...this.redraws]) {
      if (this.calls.has(id)) redraw();
      else this.redraws.delete(id);
    }
  }

  /**
   * Bring the runs in line with the messages the transcript shows, keeping
   * what is known about each call, and redraw the rows whose place changed.
   * Pi adds some messages to the transcript without an event extensions
   * hear, such as a custom message sent while the agent streams.
   */
  resync(messages: readonly GroupMessage[]): void {
    this.load(messages);
    this.refresh([], true);
  }

  private load(messages: readonly GroupMessage[]): void {
    this.records = [];
    this.current = undefined;
    for (const message of messages) {
      if (message.role === "assistant") {
        const record: MessageRecord = { boundary: false, callIds: [] };
        this.records.push(record);
        this.updateRecord(record, message);
        this.interrupt(record, message);
      } else if (message.role === "toolResult") {
        const call = message.toolCallId ? this.calls.get(message.toolCallId) : undefined;
        if (call && !call.result) this.finish(call, message, Boolean(message.isError));
      } else if (shownOnItsOwn(message)) {
        this.records.push({ boundary: true, callIds: [] });
      }
    }
  }

  messageStart(message: GroupMessage): void {
    if (message.role === "assistant") {
      this.current = { boundary: false, callIds: [] };
      this.records.push(this.current);
      this.updateCurrent(message);
    } else if (shownOnItsOwn(message)) {
      // Splits the run only for calls that follow, which regroup when they arrive.
      this.current = undefined;
      this.records.push({ boundary: true, callIds: [] });
    }
  }

  messageUpdate(message: GroupMessage): void {
    if (message.role === "assistant") this.updateCurrent(message);
  }

  messageEnd(message: GroupMessage): void {
    if (message.role !== "assistant") return;
    const record = this.updateCurrent(message);
    this.current = undefined;
    this.refresh(this.interrupt(record, message), false);
  }

  toolStart(id: string, toolName: string, args: unknown): void {
    let call = this.calls.get(id);
    const known = call !== undefined;
    if (!call) {
      // Pi draws a call it saw no message block for at the end of the transcript.
      call = { id, toolName, args, isError: false, started: false };
      this.calls.set(id, call);
      this.records.push({ boundary: false, callIds: [id] });
    }
    call.toolName = toolName;
    call.args = args;
    call.started = true;
    this.refresh([id], !known);
  }

  toolEnd(id: string, result: ToolResult | undefined, isError: boolean): void {
    const call = this.calls.get(id);
    if (!call) return;
    const alone = standsAlone(call);
    this.finish(call, result, isError);
    this.refresh([id], standsAlone(call) !== alone);
  }

  /** The group a call belongs to and its index there; undefined for unknown calls and calls that stand alone. */
  lookup(id: string): GroupPosition | undefined {
    return this.positions.get(id);
  }

  aggregate(group: ActivityGroup): GroupAggregate {
    const entries = group.calls.map((call) => ({
      activity: classifyToolCall(call.toolName, call.args, call.result ? { result: call.result } : {}),
      status: callStatus(call),
    }));
    const statuses = new Set(entries.map((entry) => entry.status));
    const status: ActivityStatus = statuses.has("running") ? "running" : statuses.has("cancelled") ? "cancelled" : "done";
    return {
      entries,
      summary: summarizeActivities(entries),
      status,
      live: group.calls.some((call) => call.started && !call.result),
    };
  }

  /** Remember how to redraw a call's row. */
  attach(id: string, redraw: () => void): void {
    this.redraws.set(id, redraw);
  }

  /**
   * Record the expansion of a call's row. The first row of a group decides
   * for the whole group, so the other rows redraw when it changes.
   */
  setExpanded(id: string, expanded: boolean): void {
    const call = this.calls.get(id);
    if (!call || call.expanded === expanded) return;
    call.expanded = expanded;
    const position = this.positions.get(id);
    if (position?.index !== 0) return;
    for (const follower of position.group.calls.slice(1)) this.redraws.get(follower.id)?.();
  }

  private updateCurrent(message: GroupMessage): MessageRecord {
    if (!this.current) {
      this.current = { boundary: false, callIds: [] };
      this.records.push(this.current);
    }
    const { structural, changed } = this.updateRecord(this.current, message);
    this.refresh(changed, structural);
    return this.current;
  }

  /** Read an assistant message's calls into its record. */
  private updateRecord(record: MessageRecord, message: GroupMessage): { structural: boolean; changed: string[] } {
    const found = toolCallBlocks(message);
    const boundary = endsActivityRun(message, found.length);
    let structural = boundary !== record.boundary || found.length !== record.callIds.length;
    const changed: string[] = [];
    for (const [i, block] of found.entries()) {
      if (record.callIds[i] !== block.id) structural = true;
      const call = this.calls.get(block.id);
      if (!call) {
        this.calls.set(block.id, { id: block.id, toolName: block.name, args: block.args, isError: false, started: false });
      } else if (!call.started && call.args !== block.args) {
        // Arguments stream in until the call starts; then the started call's arguments are final.
        call.args = block.args;
        changed.push(block.id);
      }
    }
    record.boundary = boundary;
    record.callIds = found.map((block) => block.id);
    return { structural, changed };
  }

  /** Give the unfinished calls of an aborted or failed message the result Pi shows on them. */
  private interrupt(record: MessageRecord, message: GroupMessage): string[] {
    const result = interruptedResult(message);
    if (!result) return [];
    const changed: string[] = [];
    for (const id of record.callIds) {
      const call = this.calls.get(id);
      if (call && !call.result) {
        this.finish(call, result, true);
        changed.push(id);
      }
    }
    return changed;
  }

  private finish(call: GroupedCall, result: { content?: unknown; details?: unknown } | undefined, isError: boolean): void {
    call.result = { content: Array.isArray(result?.content) ? result.content : [], details: result?.details };
    call.isError = isError;
  }

  private regroup(): void {
    this.positions = new Map();
    const records = this.records.map((record) => ({ ...record, callIds: record.callIds.filter((id) => this.calls.has(id)) }));
    for (const run of groupActivityRuns(records, (id) => standsAlone(this.calls.get(id) as GroupedCall))) {
      const group = { calls: run.map((id) => this.calls.get(id) as GroupedCall) };
      for (const [index, call] of group.calls.entries()) this.positions.set(call.id, { group, index });
    }
  }

  /**
   * Redraw what a change affects. Pi redraws the changed calls' own rows
   * after this store has seen the event, so only the first rows of their
   * groups are redrawn here, plus every row whose place changed when the
   * grouping did.
   */
  private refresh(changed: readonly string[], structural: boolean): void {
    const redraw = new Set<string>();
    const first = (position: GroupPosition | undefined) => position?.group.calls[0]?.id;
    if (structural) {
      const before = this.positions;
      this.regroup();
      for (const id of new Set([...before.keys(), ...this.positions.keys()])) {
        const was = before.get(id);
        const now = this.positions.get(id);
        if (was?.index === now?.index && first(was) === first(now)) continue;
        // The call moved: its own row, and the summaries of the groups it left and joined.
        for (const target of [id, first(was), first(now)]) if (target !== undefined) redraw.add(target);
      }
    }
    for (const id of changed) {
      const target = first(this.positions.get(id));
      if (target !== undefined && target !== id) redraw.add(target);
    }
    for (const id of redraw) this.redraws.get(id)?.();
  }
}

/**
 * Feed a store from Pi's events in interactive sessions, the only ones with
 * a transcript, and rebuild it from the session whenever the transcript is
 * drawn anew.
 */
export function trackActivityGroups(pi: Pick<ExtensionAPI, "on">, store: ActivityGroupStore): void {
  let interactive = false;
  const messages = (ctx: ExtensionContext) =>
    ctx.sessionManager.buildContextEntries().flatMap((entry) => sessionEntryToContextMessages(entry));
  const rebuild = (_event: unknown, ctx: ExtensionContext) => {
    if (interactive) store.rebuild(messages(ctx));
  };
  pi.on("session_start", (event, ctx) => {
    interactive = ctx.mode === "tui";
    rebuild(event, ctx);
  });
  pi.on("session_tree", rebuild);
  pi.on("session_compact", rebuild);
  pi.on("session_shutdown", () => {
    interactive = false;
    store.clear();
  });
  pi.on("message_start", (event, ctx) => {
    if (!interactive) return;
    // Every earlier message is in the session by now, also those Pi drew without an event.
    if (event.message.role === "assistant") store.resync(messages(ctx));
    store.messageStart(event.message);
  });
  pi.on("message_update", (event) => {
    if (interactive) store.messageUpdate(event.message);
  });
  pi.on("message_end", (event) => {
    if (interactive) store.messageEnd(event.message);
  });
  // Calls made by another tool are drawn inside that tool's row.
  pi.on("tool_execution_start", (event) => {
    if (interactive && !event.parentToolCallId) store.toolStart(event.toolCallId, event.toolName, event.args);
  });
  pi.on("tool_execution_end", (event) => {
    if (interactive && !event.parentToolCallId) store.toolEnd(event.toolCallId, event.result, event.isError);
  });
}
