/**
 * Where a run of consecutive tool calls ends: the rules the terminal's
 * activity groups and the web GUI's work groups share, so both fold the same
 * calls into one group and label it with `summarizeActivities`.
 *
 * A run ends where the transcript shows something else between two calls: an
 * assistant message with text (the transcript draws a message's text above
 * all of its calls), a message cut off at the length limit, an interrupted
 * message without calls, a user or steered message, a summary or a custom
 * message that is shown, and a call that stands alone: a subagent call, or a
 * call whose result shows an image where images can be shown. Thinking,
 * failed calls and a change of kind do not end a run.
 */

import { classifyToolCall } from "./tool-activity.js";

/** The parts of a Pi message the rules read. */
export interface ActivityRunMessage {
  role?: unknown;
  content?: unknown;
  stopReason?: unknown;
  display?: unknown;
}

/** One message's place in a run: whether something is drawn before its calls, and the calls. */
export interface ActivityRunRecord {
  boundary: boolean;
  callIds: string[];
}

export interface ToolCallBlock {
  id: string;
  name: string;
  args: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function blocks(message: ActivityRunMessage): Record<string, unknown>[] {
  return Array.isArray(message.content) ? message.content.filter(isRecord) : [];
}

/** The tool calls of an assistant message, in order. */
export function toolCallBlocks(message: ActivityRunMessage): ToolCallBlock[] {
  return blocks(message)
    .filter((block) => block.type === "toolCall" && typeof block.id === "string")
    .map((block) => ({ id: block.id as string, name: typeof block.name === "string" ? block.name : "", args: block.arguments }));
}

/** Whether an assistant message with `callCount` calls draws something above them: text, a truncation notice, or the error of a message without calls. */
export function endsActivityRun(message: ActivityRunMessage, callCount: number): boolean {
  const text = blocks(message).some((block) => block.type === "text" && typeof block.text === "string" && block.text.trim() !== "");
  if (text || message.stopReason === "length") return true;
  return callCount === 0 && (message.stopReason === "aborted" || message.stopReason === "error");
}

/** Messages other than assistant messages and tool results that the transcript shows on their own. */
export function shownOnItsOwn(message: ActivityRunMessage): boolean {
  switch (message.role) {
    case "user":
    case "bashExecution":
    case "compactionSummary":
    case "branchSummary":
      return true;
    case "custom":
      return Boolean(message.display);
    default:
      return false;
  }
}

/** The run record of one message, or undefined for a message that neither holds calls nor splits a run. */
export function activityRunRecord(message: ActivityRunMessage): ActivityRunRecord | undefined {
  if (message.role === "assistant") {
    const callIds = toolCallBlocks(message).map((call) => call.id);
    return { boundary: endsActivityRun(message, callIds.length), callIds };
  }
  return shownOnItsOwn(message) ? { boundary: true, callIds: [] } : undefined;
}

/**
 * A subagent call, or a call whose result shows an image where `images` says
 * images can be shown: the image is drawn below the call, so the call keeps
 * its own row.
 */
export function standsAlone(toolName: string, result: { content?: unknown } | undefined, images: boolean): boolean {
  if (classifyToolCall(toolName, {}).kind === "subagent") return true;
  const content = result?.content;
  return images && Array.isArray(content) && content.some((block) => isRecord(block) && block.type === "image");
}

/** Fold the calls of consecutive records into runs, in transcript order; calls that stand alone belong to none. */
export function groupActivityRuns(records: readonly ActivityRunRecord[], alone: (callId: string) => boolean): string[][] {
  const runs: string[][] = [];
  let run: string[] | undefined;
  for (const record of records) {
    if (record.boundary) run = undefined;
    for (const id of record.callIds) {
      if (alone(id)) {
        run = undefined;
        continue;
      }
      if (!run) {
        run = [];
        runs.push(run);
      }
      run.push(id);
    }
  }
  return runs;
}
