import { homedir } from "node:os";
import path from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, type ToolCallEvent, type ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { MmrGuardedFile } from "../ampi-core/guarded-files.js";
import { isRecord } from "../ampi-core/internal/json.js";
import { rewriteJsonSettingsFile } from "../ampi-core/internal/settings-file.js";
import { MMR_PERMISSIONS_DEFAULT_RULES } from "../ampi-core/permission-defaults.js";
import {
  AMPI_PERMISSIONS_ALLOW_ALL_ENV,
  AMPI_PERMISSIONS_PROJECT_RULES_ENV,
  isMmrPermissionsNonInteractive,
  isMmrPermissionsSessionAllowAll,
  MMR_PERMISSIONS_SHELL_TOOLS,
  type MmrPermissionContext,
  type MmrPermissionDecision,
  recordMmrPermissionsDenial,
  setMmrPermissionsProjectTrusted,
  setMmrPermissionsSessionAllowAll,
} from "../ampi-core/permissions.js";
import {
  getMmrSubagentState,
  MMR_EVENT_APPROVAL,
  type MmrApprovalEvent,
  registerMmrFeatureGateProvider,
} from "../ampi-core/runtime.js";
import type { MmrFeatureGateProvider } from "../ampi-core/types.js";
import { loadMmrPermissionsSettings, type MmrPermissionsSettings } from "./config.js";
import { decideMmrPermissionsCall } from "./decide.js";
import {
  type MmrPermissionsDelegateSpawn,
  type MmrPermissionsDelegateTimer,
  MMR_PERMISSIONS_DELEGATE_TIMEOUT_MS,
  runMmrPermissionsDelegate,
} from "./delegate.js";
import {
  formatMmrGuardedFilesDialogTitle,
  formatMmrGuardedFilesDismissedReason,
  formatMmrGuardedFilesNoUiReason,
  formatMmrGuardedFilesRejectReason,
  formatMmrGuardedFilesSubagentReason,
  formatMmrPermissionsDelegateWarning,
  formatMmrPermissionsDialogTitle,
  formatMmrPermissionsFeedbackReason,
  formatMmrPermissionsNoUiReason,
  formatMmrPermissionsRejectReason,
  formatMmrPermissionsSubagentReason,
  MMR_GUARDED_FILES_ALWAYS_ALLOW,
  MMR_GUARDED_FILES_DIALOG_OPTIONS,
  MMR_GUARDED_FILES_REJECT,
  MMR_PERMISSIONS_ABORTED_REASON,
  MMR_PERMISSIONS_ALLOW_ALWAYS,
  MMR_PERMISSIONS_ALLOW_ONCE,
  MMR_PERMISSIONS_ALLOW_SESSION,
  MMR_PERMISSIONS_DIALOG_OPTIONS,
  MMR_PERMISSIONS_DISMISSED_REASON,
  MMR_PERMISSIONS_FEEDBACK_TITLE,
  MMR_PERMISSIONS_REJECT_WITH_FEEDBACK,
} from "./gate.js";

const FEATURE_GATES: ReadonlySet<string> = new Set(["ampi-permissions", "mmr-permissions"]);

/** The Pi flag that allows every tool call of the run; `ampi --dangerously-allow-all` passes it on. */
const MMR_PERMISSIONS_ALLOW_ALL_FLAG = "ampi-dangerously-allow-all";

const INERT: MmrPermissionsSettings = Object.freeze({
  enabled: false,
  allowAll: false,
  projectRules: [],
  userRules: [],
  guardedFilesAllowlist: [],
  warnings: [],
});

export interface MmrPermissionsFactoryOverrides {
  /** Pi's agent directory, which holds the user settings file; `getAgentDir()` unless given. */
  agentDir?: () => string;
  /** Columns the dialog title may use; the terminal's width unless given. */
  columns?: () => number;
  /** How long a delegate program may take; 10 seconds unless given. */
  delegateTimeoutMs?: number;
  /** Starts a delegate program's timeout; `setTimeout` unless given. */
  delegateTimer?: MmrPermissionsDelegateTimer;
  /** Starts a delegate program; `child_process.spawn` unless given. */
  delegateSpawn?: MmrPermissionsDelegateSpawn;
}

function plural(count: number, noun: string, nouns = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : nouns}`;
}

function createFeatureGateProvider(getSettings: () => MmrPermissionsSettings, flagged: () => boolean): MmrFeatureGateProvider {
  return {
    name: "ampi-permissions",
    evaluate(gate) {
      if (!FEATURE_GATES.has(gate)) return undefined;
      const settings = getSettings();
      if (!settings.enabled) {
        return {
          gate,
          status: "disabled",
          reason: "off; set ampi.permissions, ampi.dangerouslyAllowAll to false, or ampi.guardedFiles.allowlist in settings to turn it on",
        };
      }
      let reason = `on: ${plural(settings.projectRules.length, "project rule")}, ${plural(settings.userRules.length, "user rule")}, ${plural(MMR_PERMISSIONS_DEFAULT_RULES.length, "default rule")}, ${plural(settings.guardedFilesAllowlist.length, "guarded file allowlist entry", "guarded file allowlist entries")}`;
      if (settings.allowAll) reason += "; ampi.dangerouslyAllowAll is true, so every tool call runs without asking";
      else if (flagged()) reason += `; --${MMR_PERMISSIONS_ALLOW_ALL_FLAG} is set, so every tool call runs without asking`;
      else if (isMmrPermissionsSessionAllowAll()) reason += "; every tool call is allowed for this session";
      if (settings.failClosed) reason += `; every tool call asks because ${settings.failClosed}`;
      return { gate, status: "enabled", reason };
    },
  };
}

/**
 * ampi-permissions: asks before risky tool calls and before changes to
 * guarded files. Inert until the user's or the trusted project's settings
 * set `ampi.permissions` or `ampi.dangerouslyAllowAll: false`, or the user's
 * set `ampi.guardedFiles.allowlist`. The `--ampi-dangerously-allow-all` flag
 * allows every call of the run, and a run that cannot ask (no UI, or an
 * execute run of the `ampi` command) refuses calls that need approval.
 */
export function createMmrPermissionsExtension(overrides: MmrPermissionsFactoryOverrides = {}) {
  return function ampiPermissionsExtension(pi: ExtensionAPI): void {
    const agentDir = overrides.agentDir ?? getAgentDir;
    const columns = overrides.columns ?? (() => process.stdout.columns || 80);
    let settings = INERT;
    /** Whether `--ampi-dangerously-allow-all` was given. */
    let flagged = false;
    let warned = new Set<string>();
    /** Delegate programs already warned about this session. */
    let programsWarned = new Set<string>();
    /** Dialogs run one at a time; this is the end of the line. */
    let queue: Promise<unknown> = Promise.resolve();

    const userFile = () => path.join(agentDir(), "settings.json");

    function load(ctx: ExtensionContext): void {
      // A subagent child also reads the project's rules when its parent did:
      // a child in print or JSON mode may not decide trust as its parent did,
      // and project rules can only tighten.
      const trusted = ctx.isProjectTrusted() || (getMmrSubagentState() !== undefined && process.env[AMPI_PERMISSIONS_PROJECT_RULES_ENV] === "1");
      setMmrPermissionsProjectTrusted(trusted);
      settings = loadMmrPermissionsSettings({
        userFile: userFile(),
        projectFile: trusted ? path.join(ctx.cwd, ".pi", "settings.json") : undefined,
      });
      const fresh = settings.warnings.filter((warning) => !warned.has(warning));
      for (const warning of fresh) warned.add(warning);
      if (fresh.length > 0) ctx.ui.notify(`ampi-permissions:\n${fresh.join("\n")}`, "warning");
    }

    const allowedWithoutAsking = () => settings.allowAll || isMmrPermissionsSessionAllowAll();

    function emitApproval(event: MmrApprovalEvent): void {
      pi.events.emit(MMR_EVENT_APPROVAL, event);
    }

    function allowEverySession(ctx: ExtensionContext): void {
      setMmrPermissionsSessionAllowAll(true);
      const file = userFile();
      try {
        rewriteJsonSettingsFile(file, (existing) => {
          if (!isRecord(existing)) throw new Error("it does not hold a JSON object");
          const ampi = isRecord(existing.ampi) ? existing.ampi : {};
          return { ...existing, ampi: { ...ampi, dangerouslyAllowAll: true } };
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not save ampi.dangerouslyAllowAll to ${file} (${message}). Tool calls run without asking for this session only.`, "error");
        return;
      }
      ctx.ui.notify(`Saved ampi.dangerouslyAllowAll: true to ${file}; tool calls no longer ask for approval.`, "info");
      load(ctx);
    }

    async function askUser(
      event: ToolCallEvent,
      decision: MmrPermissionDecision,
      ctx: ExtensionContext,
    ): Promise<ToolCallEventResult | undefined> {
      // An earlier answer in the queue may have allowed everything.
      if (allowedWithoutAsking()) return undefined;
      if (ctx.signal?.aborted) return { block: true, reason: MMR_PERMISSIONS_ABORTED_REASON };
      const title = formatMmrPermissionsDialogTitle(event.toolName, event.input, Math.max(20, columns() - 2), decision);
      const choice = await ctx.ui.select(title, [...MMR_PERMISSIONS_DIALOG_OPTIONS], { signal: ctx.signal });
      if (ctx.signal?.aborted) return { block: true, reason: MMR_PERMISSIONS_ABORTED_REASON };
      switch (choice) {
        case MMR_PERMISSIONS_ALLOW_ONCE:
          return undefined;
        case MMR_PERMISSIONS_REJECT_WITH_FEEDBACK: {
          const feedback = await ctx.ui.input(MMR_PERMISSIONS_FEEDBACK_TITLE, undefined, { signal: ctx.signal });
          if (ctx.signal?.aborted) return { block: true, reason: MMR_PERMISSIONS_ABORTED_REASON };
          return { block: true, reason: formatMmrPermissionsFeedbackReason(feedback) };
        }
        case MMR_PERMISSIONS_ALLOW_SESSION:
          setMmrPermissionsSessionAllowAll(true);
          return undefined;
        case MMR_PERMISSIONS_ALLOW_ALWAYS:
          allowEverySession(ctx);
          return undefined;
        default:
          return { block: true, reason: MMR_PERMISSIONS_DISMISSED_REASON };
      }
    }

    /** Run one dialog in the queue, with the approval events around it. */
    function inQueue<T>(event: ToolCallEvent, dialog: () => Promise<T>): Promise<T> {
      const requestId = event.toolCallId;
      // Waiting in the queue already counts as waiting for approval.
      emitApproval({ phase: "request", requestId });
      const turn = queue.then(dialog);
      queue = turn.catch(() => undefined);
      return turn.finally(() => emitApproval({ phase: "answer", requestId }));
    }

    function ask(event: ToolCallEvent, decision: MmrPermissionDecision, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
      return inQueue(event, () => askUser(event, decision, ctx));
    }

    /**
     * Add the guarded forms of each path, and the path itself, to the user's
     * `ampi.guardedFiles.allowlist` as exact `{ path }` entries, so glob
     * characters in a name match only themselves.
     */
    function allowPaths(files: readonly MmrGuardedFile[], ctx: ExtensionContext): void {
      const paths = [...new Set(files.flatMap((file) => [file.path, ...file.guardedForms]))];
      const file = userFile();
      try {
        rewriteJsonSettingsFile(file, (existing) => {
          if (!isRecord(existing)) throw new Error("it does not hold a JSON object");
          const ampi = isRecord(existing.ampi) ? existing.ampi : {};
          const guarded = isRecord(ampi.guardedFiles) ? ampi.guardedFiles : {};
          const allowlist: unknown[] = Array.isArray(guarded.allowlist) ? guarded.allowlist : [];
          const added = paths.filter((entry) => !allowlist.some((item) => isRecord(item) && item.path === entry)).map((entry) => ({ path: entry }));
          return { ...existing, ampi: { ...ampi, guardedFiles: { ...guarded, allowlist: [...allowlist, ...added] } } };
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(
          `Could not save ${paths.join(", ")} to ampi.guardedFiles.allowlist in ${file} (${message}). This call runs once; the next change there asks again.`,
          "error",
        );
        return;
      }
      ctx.ui.notify(`Saved ${paths.join(", ")} to ampi.guardedFiles.allowlist in ${file}; changes there no longer ask.`, "info");
      load(ctx);
    }

    /** The guarded file dialog; `undefined` when the call may go on to the rules. */
    async function askGuarded(
      event: ToolCallEvent,
      files: readonly MmrGuardedFile[],
      ctx: ExtensionContext,
    ): Promise<ToolCallEventResult | undefined> {
      if (allowedWithoutAsking()) return undefined;
      if (ctx.signal?.aborted) return { block: true, reason: MMR_PERMISSIONS_ABORTED_REASON };
      const title = formatMmrGuardedFilesDialogTitle(event.toolName, files, Math.max(20, columns() - 2), { cwd: ctx.cwd, home: homedir() });
      const choice = await ctx.ui.select(title, [...MMR_GUARDED_FILES_DIALOG_OPTIONS], { signal: ctx.signal });
      if (ctx.signal?.aborted) return { block: true, reason: MMR_PERMISSIONS_ABORTED_REASON };
      switch (choice) {
        case MMR_PERMISSIONS_ALLOW_ONCE:
          return undefined;
        case MMR_GUARDED_FILES_ALWAYS_ALLOW:
          allowPaths(files, ctx);
          return undefined;
        case MMR_GUARDED_FILES_REJECT:
          return { block: true, reason: formatMmrGuardedFilesRejectReason(event.toolName, files) };
        default:
          return { block: true, reason: formatMmrGuardedFilesDismissedReason(event.toolName, files) };
      }
    }

    /**
     * Run the programs of a `delegate` decision, part by part in line order.
     * A program that rejects ends the call; otherwise the first part that
     * asks, by its rule or its program, decides; otherwise the call runs.
     */
    async function delegate(
      event: ToolCallEvent,
      decision: MmrPermissionDecision,
      context: MmrPermissionContext,
      ctx: ExtensionContext,
    ): Promise<ToolCallEventResult | MmrPermissionDecision | undefined> {
      const parts = decision.parts ?? [decision];
      const asked = new Set<MmrPermissionDecision>();
      const shell = MMR_PERMISSIONS_SHELL_TOOLS.includes(event.toolName) && isRecord(event.input);
      for (const part of parts) {
        if (part.action !== "delegate") continue;
        const program = part.rule?.to;
        // A delegate rule always names a program; one that does not asks.
        if (program === undefined) {
          asked.add(part);
          continue;
        }
        const input = shell && part.command !== undefined ? { ...(event.input as Record<string, unknown>), command: part.command } : event.input;
        const outcome = await runMmrPermissionsDelegate({
          program,
          request: { tool: event.toolName, input, context, cwd: ctx.cwd },
          timeoutMs: overrides.delegateTimeoutMs ?? MMR_PERMISSIONS_DELEGATE_TIMEOUT_MS,
          ...(overrides.delegateTimer ? { timer: overrides.delegateTimer } : {}),
          ...(overrides.delegateSpawn ? { spawn: overrides.delegateSpawn } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        if (outcome.kind === "aborted") return { block: true, reason: MMR_PERMISSIONS_ABORTED_REASON };
        if (outcome.kind === "reject") return { block: true, reason: outcome.reason };
        if (outcome.kind === "allow") continue;
        if (outcome.kind === "failed" && !programsWarned.has(program)) {
          programsWarned.add(program);
          ctx.ui.notify(formatMmrPermissionsDelegateWarning(program, outcome.problem), "warning");
        }
        asked.add(part);
      }
      const asking = parts.find((part) => part.action === "ask" || asked.has(part));
      return asking ? { ...asking, action: "ask" } : undefined;
    }

    pi.registerFlag(MMR_PERMISSIONS_ALLOW_ALL_FLAG, {
      description: "Let every tool call of this run go ahead without asking: ampi-permissions skips its rules, guarded files and delegate programs, in subagents too",
      type: "boolean",
      default: false,
    });

    registerMmrFeatureGateProvider(createFeatureGateProvider(() => settings, () => flagged));

    /** Whether nobody can answer a dialog in this run. */
    const cannotAsk = (ctx: ExtensionContext) => !ctx.hasUI || isMmrPermissionsNonInteractive();

    pi.on("session_start", async (event, ctx) => {
      // A new, resumed or forked session starts asking again; a reload keeps the answer.
      if (event.reason !== "reload") setMmrPermissionsSessionAllowAll(false);
      // A subagent child takes its parent's "allow all" answer from the environment.
      if (getMmrSubagentState() && process.env[AMPI_PERMISSIONS_ALLOW_ALL_ENV] === "1") setMmrPermissionsSessionAllowAll(true);
      // The flag holds for the whole process, through /new, /resume and /fork,
      // and reaches subagent children as the override does.
      flagged = pi.getFlag(MMR_PERMISSIONS_ALLOW_ALL_FLAG) === true;
      if (flagged) setMmrPermissionsSessionAllowAll(true);
      warned = new Set();
      programsWarned = new Set();
      load(ctx);
    });

    pi.on("tool_call", async (event, ctx) => {
      const context: MmrPermissionContext = getMmrSubagentState() ? "subagent" : "thread";
      const result = await gate(event, ctx, context);
      // A child's refusals reach its parent in the worker's report, not here.
      if (result?.block && context === "thread") recordMmrPermissionsDenial(event.toolName);
      return result;
    });

    async function gate(event: ToolCallEvent, ctx: ExtensionContext, context: MmrPermissionContext): Promise<ToolCallEventResult | undefined> {
      const decided = decideMmrPermissionsCall({ toolName: event.toolName, input: event.input }, settings, {
        context,
        sessionAllowAll: isMmrPermissionsSessionAllowAll(),
        guardedFiles: { cwd: ctx.cwd, agentDir: agentDir() },
      });
      if (decided.rules === undefined) return undefined;
      let decision = decided.rules;
      if (decision.action === "reject") return { block: true, reason: formatMmrPermissionsRejectReason(event.toolName, decision) };
      // Guarded files ask even when a rule allows the tool. A yes here stands
      // in for the approval a rule asks for, so a call shows one dialog at most.
      const guarded = decided.guarded;
      let approved = false;
      if (guarded.length > 0) {
        if (context === "subagent") return { block: true, reason: formatMmrGuardedFilesSubagentReason(event.toolName, guarded) };
        if (cannotAsk(ctx)) return { block: true, reason: formatMmrGuardedFilesNoUiReason(event.toolName, guarded) };
        const answer = await inQueue(event, () => askGuarded(event, guarded, ctx));
        if (answer) return answer;
        // An answer in the queue may have allowed everything.
        if (allowedWithoutAsking()) return undefined;
        approved = true;
      }
      if (decision.action === "delegate") {
        const answer = await delegate(event, decision, context, ctx);
        if (answer === undefined) return undefined;
        if (!("action" in answer)) return answer;
        decision = answer;
      }
      if (decision.action === "allow" || approved) return undefined;
      // A subagent never opens a dialog: nobody is there to answer it.
      if (context === "subagent") return { block: true, reason: formatMmrPermissionsSubagentReason(event.toolName, decision) };
      if (cannotAsk(ctx)) return { block: true, reason: formatMmrPermissionsNoUiReason(event.toolName, decision) };
      return ask(event, decision, ctx);
    }
  };
}

export const createAmpiPermissionsExtension = createMmrPermissionsExtension;

const ampiPermissionsExtension = createMmrPermissionsExtension();

export default ampiPermissionsExtension;
