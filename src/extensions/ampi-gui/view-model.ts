import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { activityRunRecord, groupActivityRuns, standsAlone, toolCallBlocks } from "../ampi-core/activity-runs.js";
import {
  type Activity,
  type ActivityStatus,
  activityTitle,
  type ClassifyOptions,
  classifyToolCall,
  resultStatus,
  resultText,
  summarizeActivities,
  type TitlePart,
} from "../ampi-core/tool-activity.js";

/**
 * The transcript as the web client draws it: one item per user or assistant
 * message, the assistant's content kept in order (thinking, text, tool
 * calls), and each tool call labelled with the same activity words as the
 * terminal's tool rows. Text stays Markdown source; the client renders it.
 *
 * Consecutive tool calls fold into work groups by the rules the terminal's
 * activity groups use (ampi-core's `activity-runs.ts`), each with the same
 * summary as the terminal's group row ("Ran 3 commands, read 4 files").
 *
 * Items are keyed by role and message timestamp, so an item built from a
 * live event and the same message read back from the session file get the
 * same id.
 */

export type MmrGuiToolResult = NonNullable<ClassifyOptions["result"]> & { isError?: boolean; timestamp?: number };

export interface MmrGuiTextPart {
  type: "text";
  text: string;
}

export interface MmrGuiThinkingPart {
  type: "thinking";
  text: string;
  redacted?: boolean;
}

export interface MmrGuiToolPart {
  type: "tool";
  toolCallId: string;
  name: string;
  status: ActivityStatus;
  /** One-line title: verb, object, detail, diff stat or exit code. */
  title: TitlePart[];
  /** Text output of a finished call, cut to {@link MMR_GUI_OUTPUT_LIMIT} characters. */
  output?: string;
  outputTruncated?: boolean;
  /** The full shell command of a `bash` call. */
  command?: string;
  /** The change of a file edit that did not fail: lines starting with `+`, `-` or a space. */
  diff?: string;
  /** The arguments of a tool without a row of its own words, as indented JSON. */
  args?: string;
}

/** A run of consecutive tool calls that the client folds into one line. */
export interface MmrGuiGroup {
  /** The id of the group's first call. */
  id: string;
  callIds: string[];
  /** "Ran 3 commands, read 4 files, edited 2 files (+265 -4)", as the terminal's group row says it. */
  label: string;
  /** Running while a call runs, cancelled when one was cancelled, otherwise done, also when a call failed. */
  status: "running" | "done" | "cancelled";
  /** When the message holding the first call started. */
  startedAt?: number;
  /** When the last call ended; absent while a call runs. */
  endedAt?: number;
}

export type MmrGuiPart = MmrGuiTextPart | MmrGuiThinkingPart | MmrGuiToolPart;

export interface MmrGuiUserItem {
  type: "user";
  id: string;
  text: string;
  /** Number of attached images, which the client does not show. */
  images: number;
  timestamp: number;
}

export interface MmrGuiAssistantItem {
  type: "assistant";
  id: string;
  /** One part per content block, in the message's order. */
  parts: MmrGuiPart[];
  timestamp: number;
  /** `error` or `aborted` when the response did not finish. */
  stopReason?: string;
  error?: string;
}

export type MmrGuiItem = MmrGuiUserItem | MmrGuiAssistantItem;

/** Longest tool output the view model carries. */
export const MMR_GUI_OUTPUT_LIMIT = 8000;

export interface MmrGuiViewOptions {
  cwd?: string;
  home?: string;
}

/** The parts of a Pi message the view model reads. */
interface MessageLike {
  role?: unknown;
  content?: unknown;
  timestamp?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  toolCallId?: unknown;
  isError?: unknown;
  details?: unknown;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** The item id for a message: role and timestamp. */
export function mmrGuiItemId(message: unknown): string | undefined {
  const { role, timestamp } = record(message) as MessageLike;
  if ((role !== "user" && role !== "assistant") || typeof timestamp !== "number") return undefined;
  return `${role === "user" ? "u" : "a"}${timestamp}`;
}

/** A call's status: from its result, else running while the run may still go on, else cancelled. */
function callStatus(result: MmrGuiToolResult | undefined, pending: boolean): ActivityStatus {
  return result ? resultStatus(result.isError === true, result) : pending ? "running" : "cancelled";
}

function cut(text: string): string {
  return text.length > MMR_GUI_OUTPUT_LIMIT ? `${text.slice(0, MMR_GUI_OUTPUT_LIMIT)}\n…` : text;
}

/** The change a file edit made, as `+`/`-`/context lines: Pi's edit diff, a new file's content, a patch's text. */
function changeText(activity: Activity, args: Record<string, unknown>, result: MmrGuiToolResult | undefined): string | undefined {
  const details = record(result?.details);
  if (activity.toolName === "edit" && typeof details.diff === "string") return details.diff;
  if (activity.toolName === "write" && typeof args.content === "string") {
    return args.content.replace(/\n$/, "").split("\n").map((line) => `+${line}`).join("\n");
  }
  if (activity.toolName === "apply_patch" && typeof args.patchText === "string") return args.patchText;
  return undefined;
}

const OWN_WORDS = new Set(["read", "search", "list", "command", "edit", "create", "web-read"]);

/** A tool part for a call, running until a result is given. */
export function buildMmrGuiToolPart(
  call: { id: string; name: string; arguments?: unknown },
  result: MmrGuiToolResult | undefined,
  options: MmrGuiViewOptions & { pending?: boolean } = {},
): MmrGuiToolPart {
  const status = callStatus(result, options.pending === true);
  const activity = classifyToolCall(call.name, call.arguments ?? {}, { cwd: options.cwd, home: options.home, result });
  const part: MmrGuiToolPart = { type: "tool", toolCallId: call.id, name: call.name, status, title: activityTitle(activity, status) };
  if (result) {
    const output = resultText(result);
    if (output.length > MMR_GUI_OUTPUT_LIMIT) {
      part.output = output.slice(0, MMR_GUI_OUTPUT_LIMIT);
      part.outputTruncated = true;
    } else if (output !== "") {
      part.output = output;
    }
  }
  const args = record(call.arguments);
  if (call.name === "bash" && activity.command) part.command = cut(activity.command);
  // A failed or cancelled edit changed nothing; its row shows the error instead.
  const change = status === "error" || status === "cancelled" ? undefined : changeText(activity, args, result);
  if (change) part.diff = cut(change);
  if (!OWN_WORDS.has(activity.kind) && Object.keys(args).length > 0) part.args = cut(JSON.stringify(args, null, 2));
  return part;
}

/**
 * The work groups among `messages`, in transcript order: runs of
 * consecutive calls as the terminal folds them, each labelled by
 * `summarizeActivities`. Calls that stand alone (subagents, results with
 * images) belong to no group and keep their own row. `results` maps call
 * ids to their results; `pending` says whether a call without one may still
 * run.
 */
export function buildMmrGuiGroups(
  messages: Iterable<unknown>,
  results: ReadonlyMap<string, MmrGuiToolResult>,
  options: MmrGuiViewOptions & { pending?: (toolCallId: string) => boolean } = {},
): MmrGuiGroup[] {
  const calls = new Map<string, { name: string; args: unknown; startedAt?: number }>();
  const records = [];
  for (const message of messages) {
    const msg = record(message);
    const run = activityRunRecord(msg);
    if (!run) continue;
    records.push(run);
    const startedAt = typeof msg.timestamp === "number" ? msg.timestamp : undefined;
    for (const block of msg.role === "assistant" ? toolCallBlocks(msg) : []) calls.set(block.id, { name: block.name, args: block.args, startedAt });
  }
  // A browser can show a result's image, so such a call keeps its own row.
  const alone = (id: string) => standsAlone(calls.get(id)?.name ?? "", results.get(id), true);
  return groupActivityRuns(records, alone).map((callIds) => {
    const entries = callIds.map((id) => {
      const call = calls.get(id) ?? { name: "", args: {} };
      const result = results.get(id);
      const activity = classifyToolCall(call.name, call.args ?? {}, { cwd: options.cwd, home: options.home, result });
      return { activity, status: callStatus(result, options.pending?.(id) === true) };
    });
    const statuses = new Set(entries.map((entry) => entry.status));
    const status = statuses.has("running") ? "running" : statuses.has("cancelled") ? "cancelled" : "done";
    const group: MmrGuiGroup = { id: callIds[0] as string, callIds, label: summarizeActivities(entries), status };
    const startedAt = calls.get(group.id)?.startedAt;
    if (startedAt !== undefined) group.startedAt = startedAt;
    const ends = callIds.map((id) => results.get(id)?.timestamp).filter((time): time is number => typeof time === "number");
    if (status !== "running" && ends.length > 0) group.endedAt = Math.max(...ends);
    return group;
  });
}

function userText(content: unknown): { text: string; images: number } {
  if (typeof content === "string") return { text: content, images: 0 };
  if (!Array.isArray(content)) return { text: "", images: 0 };
  const texts: string[] = [];
  let images = 0;
  for (const block of content) {
    const entry = record(block);
    if (entry.type === "text" && typeof entry.text === "string") texts.push(entry.text);
    else if (entry.type === "image") images++;
  }
  return { text: texts.join("\n"), images };
}

/**
 * The item for one user or assistant message, or `undefined` for any other
 * role. `results` maps tool call ids to their results. A call without a
 * result shows as running when `pending` says it may still run (the agent
 * run is still going), and as cancelled otherwise.
 */
export function buildMmrGuiItem(
  message: unknown,
  results: ReadonlyMap<string, MmrGuiToolResult>,
  options: MmrGuiViewOptions & { pending?: (toolCallId: string) => boolean } = {},
): MmrGuiItem | undefined {
  const msg = record(message) as MessageLike;
  const id = mmrGuiItemId(msg);
  if (!id) return undefined;
  const timestamp = msg.timestamp as number;
  if (msg.role === "user") return { type: "user", id, timestamp, ...userText(msg.content) };

  const parts: MmrGuiPart[] = [];
  for (const block of Array.isArray(msg.content) ? msg.content : []) {
    const entry = record(block);
    if (entry.type === "thinking") {
      parts.push({ type: "thinking", text: typeof entry.thinking === "string" ? entry.thinking : "", ...(entry.redacted === true ? { redacted: true } : {}) });
    } else if (entry.type === "toolCall" && typeof entry.id === "string" && typeof entry.name === "string") {
      const call = { id: entry.id, name: entry.name, arguments: entry.arguments };
      parts.push(buildMmrGuiToolPart(call, results.get(entry.id), { cwd: options.cwd, home: options.home, pending: options.pending?.(entry.id) === true }));
    } else {
      parts.push({ type: "text", text: typeof entry.text === "string" ? entry.text : "" });
    }
  }
  const item: MmrGuiAssistantItem = { type: "assistant", id, timestamp, parts };
  if (msg.stopReason === "error" || msg.stopReason === "aborted") item.stopReason = msg.stopReason;
  if (typeof msg.errorMessage === "string" && msg.errorMessage !== "") item.error = msg.errorMessage;
  return item;
}

/** The tool results among `messages`, by tool call id. */
export function collectMmrGuiToolResults(messages: Iterable<unknown>): Map<string, MmrGuiToolResult> {
  const results = new Map<string, MmrGuiToolResult>();
  for (const message of messages) {
    const msg = record(message) as MessageLike;
    if (msg.role !== "toolResult" || typeof msg.toolCallId !== "string") continue;
    results.set(msg.toolCallId, {
      content: Array.isArray(msg.content) ? msg.content : [],
      details: msg.details,
      isError: msg.isError === true,
      ...(typeof msg.timestamp === "number" ? { timestamp: msg.timestamp } : {}),
    });
  }
  return results;
}

/**
 * The messages on a session branch, in order, as Pi's context holds them:
 * the `message` entries' payloads, and the summaries and custom messages
 * other entries stand for, which end a run of tool calls when shown.
 */
export function mmrGuiBranchMessages(entries: readonly unknown[]): unknown[] {
  const messages: unknown[] = [];
  for (const entry of entries) {
    const value = record(entry);
    if (value.type === "message" && !value.message) continue;
    messages.push(...sessionEntryToContextMessages(value as unknown as Parameters<typeof sessionEntryToContextMessages>[0]));
  }
  return messages;
}

/** The items and work groups for a session branch. */
export function buildMmrGuiTranscript(
  entries: readonly unknown[],
  options: MmrGuiViewOptions & { pending?: (toolCallId: string) => boolean } = {},
): { items: MmrGuiItem[]; groups: MmrGuiGroup[] } {
  const messages = mmrGuiBranchMessages(entries);
  const results = collectMmrGuiToolResults(messages);
  const items: MmrGuiItem[] = [];
  for (const message of messages) {
    const item = buildMmrGuiItem(message, results, options);
    if (item) items.push(item);
  }
  return { items, groups: buildMmrGuiGroups(messages, results, options) };
}

/** A title for the session: its name, else the first line of the first prompt. */
export function mmrGuiSessionTitle(name: string | undefined, items: readonly MmrGuiItem[]): string {
  if (name?.trim()) return name.trim();
  const first = items.find((item): item is MmrGuiUserItem => item.type === "user" && item.text.trim() !== "");
  if (!first) return "New thread";
  const line = first.text.trim().split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
