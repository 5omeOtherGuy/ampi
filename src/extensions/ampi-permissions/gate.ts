import path from "node:path";
import type { MmrGuardedFile } from "../ampi-core/guarded-files.js";
import { isRecord } from "../ampi-core/internal/json.js";
import { formatMmrPermissionRule, type MmrPermissionDecision } from "../ampi-core/permissions.js";

/**
 * The words of the approval dialog, of the guarded file dialog and of the
 * reasons a blocked tool call gives the agent. The option labels are Amp-compatible; every sentence is
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

export const MMR_GUARDED_FILES_DIALOG_TITLE = "Guarded File Modification";
export const MMR_GUARDED_FILES_ALWAYS_ALLOW = "Always Allow This Path";
export const MMR_GUARDED_FILES_REJECT = "Reject";

/** The guarded file dialog's options, in the order it shows them. */
export const MMR_GUARDED_FILES_DIALOG_OPTIONS: readonly string[] = Object.freeze([
  MMR_PERMISSIONS_ALLOW_ONCE,
  MMR_GUARDED_FILES_ALWAYS_ALLOW,
  MMR_GUARDED_FILES_REJECT,
]);

export const MMR_PERMISSIONS_FEEDBACK_TITLE = "What should the agent do instead?";

/** Summary lines under the title, the tool name included. */
const SUMMARY_LINES = 4;

/** Path lines the guarded file dialog shows, the "more" line included. */
const GUARDED_PATH_LINES = 6;

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

/** How the guarded file dialog shows a path: relative to `cwd` inside it, `~/` inside `home`, else absolute. */
function shownPath(filePath: string, cwd: string, home: string): string {
  const inside = (root: string) => {
    const relative = path.relative(root, filePath);
    const outside = relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    return outside ? undefined : relative;
  };
  const fromCwd = inside(cwd);
  if (fromCwd !== undefined) return fromCwd;
  const fromHome = inside(home);
  return fromHome !== undefined ? `~${path.sep}${fromHome}` : filePath;
}

/** The real path, when only the path its links lead to is guarded. */
function linkTarget(file: MmrGuardedFile): string | undefined {
  return file.realPath !== undefined && !file.guardedForms.includes(file.path) ? file.realPath : undefined;
}

/**
 * The guarded file dialog's title: "Guarded File Modification", the tool
 * name, then one line per guarded path with its category (and where a link
 * leads, when that is what is guarded), each cut to `width` columns; more
 * paths than fit end with a line that says how many more there are.
 */
export function formatMmrGuardedFilesDialogTitle(
  toolName: string,
  files: readonly MmrGuardedFile[],
  width: number,
  where: { cwd: string; home: string },
): string {
  const lines = files.map((file) => {
    const target = linkTarget(file);
    const shown = shownPath(file.path, where.cwd, where.home);
    const via = target === undefined ? "" : ` → ${shownPath(target, where.cwd, where.home)}`;
    return `${shown}${via} (${file.category.description})`;
  });
  if (lines.length > GUARDED_PATH_LINES) {
    const more = lines.length - (GUARDED_PATH_LINES - 1);
    lines.splice(GUARDED_PATH_LINES - 1, lines.length, `… and ${more} more guarded paths`);
  }
  return [MMR_GUARDED_FILES_DIALOG_TITLE, `Tool: ${toolName}`, ...lines].map((line) => cut(line, width)).join("\n");
}

/** The guarded paths of a call for a block reason, each with its category. */
function guardedList(files: readonly MmrGuardedFile[]): string {
  const items = files.map((file) => {
    const target = linkTarget(file);
    return `${file.path}${target === undefined ? "" : `, which leads to ${target},`} (${file.category.description})`;
  });
  return `${files.length === 1 ? "a guarded file" : "guarded files"}: ${items.join("; ")}`;
}

/** Why a call the user rejected in the guarded file dialog did not run. */
export function formatMmrGuardedFilesRejectReason(toolName: string, files: readonly MmrGuardedFile[]): string {
  return `The user rejected the ${toolName} call, which changes ${guardedList(files)}.`;
}

/** Why a call did not run when the guarded file dialog was closed without an answer. */
export function formatMmrGuardedFilesDismissedReason(toolName: string, files: readonly MmrGuardedFile[]): string {
  return `The guarded file dialog was closed without an answer, so the ${toolName} call did not run. It changes ${guardedList(files)}.`;
}

/** Why a call that changes a guarded file did not run in a session that cannot ask. */
export function formatMmrGuardedFilesNoUiReason(toolName: string, files: readonly MmrGuardedFile[]): string {
  return `The ${toolName} call changes ${guardedList(files)}. Changes to guarded files need the user's approval, even when a rule allows the tool, and this run cannot ask for it. A path in ampi.guardedFiles.allowlist in the user settings lets such calls run without asking.`;
}

/** Why a call that changes a guarded file did not run in a subagent, which never opens a dialog. */
export function formatMmrGuardedFilesSubagentReason(toolName: string, files: readonly MmrGuardedFile[]): string {
  return `The ${toolName} call changes ${guardedList(files)}. Changes to guarded files need the user's approval, even when a rule allows the tool, and a subagent cannot ask the user for it. Tell the main session: the change has to be made there, where the user can approve it, or the path has to be in ampi.guardedFiles.allowlist in the user settings.`;
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

/** Which rule, or which reason, made a call need approval. */
function approvalCause(decision: MmrPermissionDecision): string {
  if (decision.rule?.action === "delegate") {
    return `The permissions rule ${ruleText(decision)} asks for approval${forPart(decision)}, because its program did not allow the call.`;
  }
  return decision.rule
    ? `The permissions rule ${ruleText(decision)} asks for approval${forPart(decision)}.`
    : `It needs approval because ${decision.reason ?? "a permissions rule asks for it"}${forPart(decision)}.`;
}

/**
 * Why a call that needs approval did not run in a session that cannot ask
 * (print and JSON runs). The one place this text lives.
 */
export function formatMmrPermissionsNoUiReason(toolName: string, decision: MmrPermissionDecision): string {
  return `The ${toolName} call needs the user's approval, and this run cannot ask for it. ${approvalCause(decision)} An allow rule in ampi.permissions lets such calls run without asking.`;
}

/**
 * Why a call that needs approval did not run in a subagent, which never
 * opens a dialog. The subagent passes it on to the agent that started it.
 */
export function formatMmrPermissionsSubagentReason(toolName: string, decision: MmrPermissionDecision): string {
  return `The ${toolName} call needs the user's approval, and a subagent cannot ask the user for it. ${approvalCause(decision)} Tell the main session: the call has to run there, where the user can approve it, or a rule in ampi.permissions has to allow it.`;
}

/** The warning for a delegate program that gave no answer; the call then asks. */
export function formatMmrPermissionsDelegateWarning(program: string, problem: string): string {
  return `ampi-permissions: the delegate program "${program}" ${problem}, so its calls ask for approval as an ask rule would.`;
}

export function formatMmrPermissionsFeedbackReason(feedback: string | undefined): string {
  const text = feedback?.trim();
  return text ? `The user rejected this tool call and said: ${text}` : "The user rejected this tool call.";
}

export const MMR_PERMISSIONS_DISMISSED_REASON = "The approval dialog was closed without an answer, so the tool call did not run.";
export const MMR_PERMISSIONS_ABORTED_REASON = "The turn was interrupted while the tool call waited for approval, so it did not run.";
