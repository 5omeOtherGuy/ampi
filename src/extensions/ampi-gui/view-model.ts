import {
  type ActivityStatus,
  activityTitle,
  type ClassifyOptions,
  classifyToolCall,
  resultStatus,
  resultText,
  type TitlePart,
} from "../ampi-core/tool-activity.js";

/**
 * The transcript as the web client draws it: one item per user or assistant
 * message, the assistant's content kept in order (thinking, text, tool
 * calls), and each tool call labelled with the same activity words as the
 * terminal's tool rows. Text stays Markdown source; the client renders it.
 *
 * Items are keyed by role and message timestamp, so an item built from a
 * live event and the same message read back from the session file get the
 * same id.
 */

export type MmrGuiToolResult = NonNullable<ClassifyOptions["result"]> & { isError?: boolean };

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

/** A tool part for a call, running until a result is given. */
export function buildMmrGuiToolPart(
  call: { id: string; name: string; arguments?: unknown },
  result: MmrGuiToolResult | undefined,
  options: MmrGuiViewOptions & { pending?: boolean } = {},
): MmrGuiToolPart {
  const status: ActivityStatus = result ? resultStatus(result.isError === true, result) : options.pending ? "running" : "cancelled";
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
  return part;
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
    });
  }
  return results;
}

/** The messages on a session branch, in order: the `message` entries' payloads. */
export function mmrGuiBranchMessages(entries: readonly unknown[]): unknown[] {
  const messages: unknown[] = [];
  for (const entry of entries) {
    const value = record(entry);
    if (value.type === "message" && value.message) messages.push(value.message);
  }
  return messages;
}

/** The items for a session branch. */
export function buildMmrGuiTranscript(
  entries: readonly unknown[],
  options: MmrGuiViewOptions & { pending?: (toolCallId: string) => boolean } = {},
): MmrGuiItem[] {
  const messages = mmrGuiBranchMessages(entries);
  const results = collectMmrGuiToolResults(messages);
  const items: MmrGuiItem[] = [];
  for (const message of messages) {
    const item = buildMmrGuiItem(message, results, options);
    if (item) items.push(item);
  }
  return items;
}

/** A title for the session: its name, else the first line of the first prompt. */
export function mmrGuiSessionTitle(name: string | undefined, items: readonly MmrGuiItem[]): string {
  if (name?.trim()) return name.trim();
  const first = items.find((item): item is MmrGuiUserItem => item.type === "user" && item.text.trim() !== "");
  if (!first) return "New thread";
  const line = first.text.trim().split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
