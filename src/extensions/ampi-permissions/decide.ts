import { findMmrGuardedFiles, type MmrGuardedFile, type MmrGuardedFilesEnvironment } from "../ampi-core/guarded-files.js";
import {
  evaluateMmrPermission,
  type MmrPermissionAction,
  type MmrPermissionCall,
  type MmrPermissionContext,
  type MmrPermissionDecision,
  type MmrPermissionRuleSource,
} from "../ampi-core/permissions.js";
import type { MmrPermissionsSettings } from "./config.js";

/**
 * Where a decision comes from: a rule's source, a guarded file, an allow-all
 * setting or answer, a gate that is off, or `none` when no rule decided (no
 * rule matched, or ampi asks on its own, with a `reason`).
 */
export type MmrPermissionsDecisionSource = MmrPermissionRuleSource | "guarded" | "allow-all" | "off" | "none";

/** What a session decides about a tool call before any dialog opens or delegate program runs. */
export interface MmrPermissionsCallDecision {
  /** `ask` for a guarded file; otherwise the rules' action. */
  readonly action: MmrPermissionAction;
  readonly source: MmrPermissionsDecisionSource;
  /**
   * The rules' decision, or an `ask` with a `reason` when the settings fail
   * closed. Absent when the gate is off or allows everything. Under a guarded
   * file it is what follows a yes in the guarded file dialog.
   */
  readonly rules?: MmrPermissionDecision;
  /** The guarded files the call changes that the allowlist does not cover; empty unless `source` is `guarded`. */
  readonly guarded: readonly MmrGuardedFile[];
}

export interface DecideMmrPermissionsCallOptions {
  /** Where the call runs; `thread` unless given. */
  readonly context?: MmrPermissionContext;
  /** "Allow All for This Session" was answered. */
  readonly sessionAllowAll?: boolean;
  /** What the guarded file check reads from the machine: the session's cwd and Pi's agent directory at least. */
  readonly guardedFiles?: MmrGuardedFilesEnvironment;
}

const OFF: MmrPermissionsCallDecision = Object.freeze({ action: "allow", source: "off", guarded: Object.freeze([]) });
const ALLOW_ALL: MmrPermissionsCallDecision = Object.freeze({ action: "allow", source: "allow-all", guarded: Object.freeze([]) });

/**
 * Decide a tool call as a session does before it asks anyone: allow-all
 * (the user's `ampi.dangerouslyAllowAll: true` or the session's answer)
 * allows; a gate no setting turns on allows; otherwise the rules decide (or
 * every call asks when the settings fail closed), a `reject` blocks, and a
 * call that changes a guarded file the allowlist does not cover asks about
 * that file first. Delegate programs, dialogs and the refusals of subagents
 * and runs without UI are the caller's: `ampi-permissions`' `tool_call`
 * handler and `ampi permissions test` both start from this decision.
 */
export function decideMmrPermissionsCall(
  call: MmrPermissionCall,
  settings: MmrPermissionsSettings,
  options: DecideMmrPermissionsCallOptions = {},
): MmrPermissionsCallDecision {
  if (settings.allowAll || options.sessionAllowAll === true) return ALLOW_ALL;
  if (!settings.enabled) return OFF;
  const rules: MmrPermissionDecision = settings.failClosed
    ? { action: "ask", reason: settings.failClosed }
    : evaluateMmrPermission(call, { project: settings.projectRules, user: settings.userRules }, { context: options.context ?? "thread" });
  if (rules.action !== "reject") {
    const guarded = findMmrGuardedFiles(call.toolName, call.input, settings.guardedFilesAllowlist, options.guardedFiles);
    if (guarded.length > 0) return { action: "ask", source: "guarded", rules, guarded };
  }
  return { action: rules.action, source: rules.source ?? "none", rules, guarded: [] };
}
