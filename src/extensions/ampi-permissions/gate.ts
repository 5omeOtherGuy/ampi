import { isRecord } from "../ampi-core/internal/json.js";
import { formatMmrPermissionRule, type MmrPermissionDecision } from "../ampi-core/permissions.js";

/**
 * The words of the approval dialog and of the reasons a blocked tool call
 * gives the agent. The option labels are Amp-compatible; every sentence is
 * ampi's own.
 */

export const MMR_PERMISSIONS_DIALOG_TITLE = "Approval Required";
export const MMR_PERMISSIONS_ALLOW_ONCE = "Allow Once";
export const MMR_PERMISSIONS_REJECT_WITH_FEEDBACK = "Reject with feedback";
export const MMR_PERMISSIONS_ALLOW_SESSION = "Allow All for This Session";
export const MMR_PERMISSIONS_ALLOW_ALWAYS = "Allow All for Every Session";

/** The dialog's options, in the order it shows them. */
export const MMR_PERMISSIONS_DIALOG_OPTIONS: readonly string[] = Object.freeze([
  MMR_PERMISSIONS_ALLOW_ONCE,
  MMR_PERMISSIONS_REJECT_WITH_FEEDBACK,
  MMR_PERMISSIONS_ALLOW_SESSION,
  MMR_PERMISSIONS_ALLOW_ALWAYS,
]);

export const MMR_PERMISSIONS_FEEDBACK_TITLE = "What should the agent do instead?";

/** Summary lines under the title, the tool name included. */
const SUMMARY_LINES = 4;

function cut(text: string, width: number): string {
  // Control characters (escape sequences among them) would act on the terminal.
  const chars = Array.from(text.replace(/\p{Cc}/gu, " "));
  if (chars.length <= width) return chars.join("");
  // Keep both ends, so the tail of a long command line stays visible.
  const head = Math.ceil((width - 1) / 2);
  const tail = Math.max(0, width - 1 - head);
  return `${chars.slice(0, head).join("")}…${tail > 0 ? chars.slice(-tail).join("") : ""}`;
}

function fieldText(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
}

function detailLines(input: unknown): string[] {
  if (!isRecord(input)) return [];
  if (typeof input.command === "string") return input.command.split("\n").filter((line) => line.trim().length > 0);
  const path = input.path ?? input.file_path;
  if (typeof path === "string") return [`Path: ${path}`];
  return Object.entries(input).map(([field, value]) => `${field}: ${fieldText(value)}`);
}

/**
 * The dialog title: "Approval Required", then the tool name, the part of a
 * shell line that asked (when it is not the first line), then the command
 * (one line per command line), the path, or the input fields, up to four
 * lines in all, each cut to `width` columns in the middle.
 */
export function formatMmrPermissionsDialogTitle(
  toolName: string,
  input: unknown,
  width: number,
  decision?: MmrPermissionDecision,
): string {
  const details = detailLines(input);
  const part = decision?.command?.trim();
  const lines = [`Tool: ${toolName}`];
  if (part && part !== details[0]?.trim()) lines.push(`Needs approval: ${part}`);
  lines.push(...details);
  const shown = lines.slice(0, SUMMARY_LINES);
  if (lines.length > SUMMARY_LINES) shown[SUMMARY_LINES - 1] = `${shown[SUMMARY_LINES - 1]} …`;
  return [MMR_PERMISSIONS_DIALOG_TITLE, ...shown.map((line) => cut(line, width))].join("\n");
}

function ruleText(decision: MmrPermissionDecision): string {
  return decision.rule ? `"${formatMmrPermissionRule(decision.rule)}"` : "";
}

function forPart(decision: MmrPermissionDecision): string {
  return decision.command === undefined ? "" : ` (for "${decision.command}")`;
}

/** Why a call a rule rejected did not run: the rule's message, or the rule itself. */
export function formatMmrPermissionsRejectReason(toolName: string, decision: MmrPermissionDecision): string {
  if (decision.rule?.message) return decision.rule.message;
  return `The ${toolName} call was rejected by the permissions rule ${ruleText(decision)}${forPart(decision)}.`;
}

/**
 * Why a call that needs approval did not run in a session that cannot ask
 * (print and JSON runs). The one place this text lives.
 */
export function formatMmrPermissionsNoUiReason(toolName: string, decision: MmrPermissionDecision): string {
  const why = decision.rule
    ? `The permissions rule ${ruleText(decision)} asks for approval${forPart(decision)}.`
    : `It needs approval because ${decision.reason ?? "a permissions rule asks for it"}${forPart(decision)}.`;
  return `The ${toolName} call needs the user's approval, and this run cannot ask for it. ${why} An allow rule in ampi.permissions lets such calls run without asking.`;
}

export function formatMmrPermissionsFeedbackReason(feedback: string | undefined): string {
  const text = feedback?.trim();
  return text ? `The user rejected this tool call and said: ${text}` : "The user rejected this tool call.";
}

export const MMR_PERMISSIONS_DISMISSED_REASON = "The approval dialog was closed without an answer, so the tool call did not run.";
export const MMR_PERMISSIONS_ABORTED_REASON = "The turn was interrupted while the tool call waited for approval, so it did not run.";
