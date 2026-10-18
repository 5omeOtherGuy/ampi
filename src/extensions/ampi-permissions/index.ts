import path from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, type ToolCallEvent, type ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../ampi-core/internal/json.js";
import { rewriteJsonSettingsFile } from "../ampi-core/internal/settings-file.js";
import { MMR_PERMISSIONS_DEFAULT_RULES } from "../ampi-core/permission-defaults.js";
import {
  evaluateMmrPermission,
  isMmrPermissionsSessionAllowAll,
  type MmrPermissionDecision,
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
import {
  formatMmrPermissionsDialogTitle,
  formatMmrPermissionsFeedbackReason,
  formatMmrPermissionsNoUiReason,
  formatMmrPermissionsRejectReason,
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

const INERT: MmrPermissionsSettings = Object.freeze({ enabled: false, allowAll: false, projectRules: [], userRules: [], warnings: [] });

export interface MmrPermissionsFactoryOverrides {
  /** Pi's agent directory, which holds the user settings file; `getAgentDir()` unless given. */
  agentDir?: () => string;
  /** Columns the dialog title may use; the terminal's width unless given. */
  columns?: () => number;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function createFeatureGateProvider(getSettings: () => MmrPermissionsSettings): MmrFeatureGateProvider {
  return {
    name: "ampi-permissions",
    evaluate(gate) {
      if (!FEATURE_GATES.has(gate)) return undefined;
      const settings = getSettings();
      if (!settings.enabled) {
        return { gate, status: "disabled", reason: "off; set ampi.permissions, or ampi.dangerouslyAllowAll to false, in settings to turn it on" };
      }
      let reason = `on: ${plural(settings.projectRules.length, "project rule")}, ${plural(settings.userRules.length, "user rule")}, ${plural(MMR_PERMISSIONS_DEFAULT_RULES.length, "default rule")}`;
      if (settings.allowAll) reason += "; ampi.dangerouslyAllowAll is true, so every tool call runs without asking";
      else if (isMmrPermissionsSessionAllowAll()) reason += "; every tool call is allowed for this session";
      if (settings.failClosed) reason += `; every tool call asks because ${settings.failClosed}`;
      return { gate, status: "enabled", reason };
    },
  };
}

/**
 * ampi-permissions: asks before risky tool calls. Inert until the user's or
 * the trusted project's settings set `ampi.permissions` or
 * `ampi.dangerouslyAllowAll: false`.
 */
export function createMmrPermissionsExtension(overrides: MmrPermissionsFactoryOverrides = {}) {
  return function ampiPermissionsExtension(pi: ExtensionAPI): void {
    const agentDir = overrides.agentDir ?? getAgentDir;
    const columns = overrides.columns ?? (() => process.stdout.columns || 80);
    let settings = INERT;
    let warned = new Set<string>();
    /** Dialogs run one at a time; this is the end of the line. */
    let queue: Promise<unknown> = Promise.resolve();

    const userFile = () => path.join(agentDir(), "settings.json");

    function load(ctx: ExtensionContext): void {
      settings = loadMmrPermissionsSettings({
        userFile: userFile(),
        projectFile: ctx.isProjectTrusted() ? path.join(ctx.cwd, ".pi", "settings.json") : undefined,
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

    function ask(event: ToolCallEvent, decision: MmrPermissionDecision, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
      const requestId = event.toolCallId;
      // Waiting in the queue already counts as waiting for approval.
      emitApproval({ phase: "request", requestId });
      const turn = queue.then(() => askUser(event, decision, ctx));
      queue = turn.catch(() => undefined);
      return turn.finally(() => emitApproval({ phase: "answer", requestId }));
    }

    registerMmrFeatureGateProvider(createFeatureGateProvider(() => settings));

    pi.on("session_start", async (event, ctx) => {
      // A new, resumed or forked session starts asking again; a reload keeps the answer.
      if (event.reason !== "reload") setMmrPermissionsSessionAllowAll(false);
      warned = new Set();
      // Subagent workers are not gated yet.
      if (getMmrSubagentState()) {
        settings = INERT;
        return;
      }
      load(ctx);
    });

    pi.on("tool_call", async (event, ctx) => {
      if (!settings.enabled || getMmrSubagentState() || allowedWithoutAsking()) return undefined;
      const decision: MmrPermissionDecision = settings.failClosed
        ? { action: "ask", reason: settings.failClosed }
        : evaluateMmrPermission(
            { toolName: event.toolName, input: event.input },
            { project: settings.projectRules, user: settings.userRules },
          );
      if (decision.action === "allow") return undefined;
      if (decision.action === "reject") return { block: true, reason: formatMmrPermissionsRejectReason(event.toolName, decision) };
      // `delegate` asks until delegate programs are supported.
      if (!ctx.hasUI) return { block: true, reason: formatMmrPermissionsNoUiReason(event.toolName, decision) };
      return ask(event, decision, ctx);
    });
  };
}

export const createAmpiPermissionsExtension = createMmrPermissionsExtension;

const ampiPermissionsExtension = createMmrPermissionsExtension();

export default ampiPermissionsExtension;
