import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { getMmrMode, isMmrModeKey } from "../mmr-core/modes.js";
import {
  MMR_EVENT_STATE_CHANGED,
  clearMmrManagedModelOverride,
  getMmrModeState,
  getMmrModeStateSnapshot,
  getMmrSubagentState,
  isMmrManagedModelUpdateActive,
  runMmrManagedModelUpdate,
  setMmrManagedModelOverride,
  setMmrModeState,
} from "../mmr-core/runtime.js";
import { updateMmrStatus } from "../mmr-core/status.js";
import { buildMmrSessionFallbackCandidates } from "./candidates.js";
import { classifyMmrSessionFallbackError } from "./classifier.js";
import {
  isMmrSessionFallbackTransientSustained,
  nextMmrSessionFallbackTransientState,
} from "./escalation.js";
import { createMmrSessionFallbackRetryMessage, type MmrSessionFallbackAssistantMessage } from "./retry-message.js";
import {
  clearMmrSessionFallbackOverride,
  clearMmrSessionFallbackTransientState,
  getMmrSessionFallbackOverrideSnapshot,
  getMmrSessionFallbackPromptInFlight,
  getMmrSessionFallbackTransientState,
  setMmrSessionFallbackOverride,
  setMmrSessionFallbackPromptInFlight,
  setMmrSessionFallbackTransientState,
} from "./runtime.js";
import {
  MMR_SESSION_FALLBACK_ENTRY,
  findLatestPersistedMmrSessionFallbackEntry,
  findLatestPersistedMmrSessionFallbackOverride,
  toPersistedMmrSessionFallbackClear,
  toPersistedMmrSessionFallbackOverride,
  type PersistedMmrSessionFallbackOverride,
} from "./state.js";
import { promptForMmrSessionFallback } from "./ui.js";

type MmrMessageEndReplacement = Extract<ExtensionEvent, { type: "message_end" }>["message"];

function getSessionId(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionId?.();
  } catch {
    return undefined;
  }
}

function getSessionEntries(ctx: ExtensionContext): unknown[] {
  try {
    return ctx.sessionManager.getEntries?.() ?? [];
  } catch {
    return [];
  }
}

function isAssistantErrorMessage(message: unknown): message is MmrSessionFallbackAssistantMessage {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as Partial<MmrSessionFallbackAssistantMessage>;
  return candidate.role === "assistant" && candidate.stopReason === "error";
}

function isAssistantNonErrorMessage(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as Partial<MmrSessionFallbackAssistantMessage>;
  return candidate.role === "assistant" && candidate.stopReason !== "error";
}

function findRegisteredModel(ctx: ExtensionContext, provider: string, model: string): Parameters<ExtensionAPI["setModel"]>[0] | undefined {
  try {
    return ctx.modelRegistry.find(provider, model) as Parameters<ExtensionAPI["setModel"]>[0] | undefined;
  } catch {
    return undefined;
  }
}

function hasConfiguredAuth(ctx: ExtensionContext, model: Parameters<ExtensionAPI["setModel"]>[0]): boolean {
  try {
    return ctx.modelRegistry.hasConfiguredAuth ? ctx.modelRegistry.hasConfiguredAuth(model) : true;
  } catch {
    return false;
  }
}

function fallbackReason(override: PersistedMmrSessionFallbackOverride): string {
  return `Session fallback selected after ${override.reasonKind}.`;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function publishFallbackModeState(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  override: PersistedMmrSessionFallbackOverride,
  model: Parameters<ExtensionAPI["setModel"]>[0],
): void {
  const state = getMmrModeStateSnapshot();
  if (!state || state.mode === "free") return;
  const registeredContextWindow = numberField((model as { contextWindow?: unknown }).contextWindow);
  const nextState = {
    ...state,
    provider: override.selectedProvider,
    model: override.selectedModel,
    thinkingLevel: override.thinkingLevel,
    modelFallbackApplied: true,
    modelFallbackReason: fallbackReason(override),
    effectiveContextWindow: registeredContextWindow,
    effectiveMaxOutputTokens: undefined,
    effectiveMaxInputTokens: undefined,
    registeredContextWindow,
    resolution: {
      ...state.resolution,
      modelDecision: {
        fallbackApplied: true,
        reason: fallbackReason(override),
      },
    },
  };
  setMmrModeState(nextState);
  pi.events.emit(MMR_EVENT_STATE_CHANGED, getMmrModeState());
  updateMmrStatus(ctx, nextState);
}

function stateMatchesPersistedFallback(override: PersistedMmrSessionFallbackOverride): boolean {
  const state = getMmrModeState();
  if (!state || state.mode === "free" || !state.modelApplied) return false;
  if (override.mode && override.mode !== state.mode) return false;
  return state.provider === override.failingProvider && state.model === override.failingModel;
}

function clearSessionFallback(pi: ExtensionAPI, ctx: ExtensionContext, reason: string): void {
  const sessionId = getSessionId(ctx);
  const runtimeOverride = getMmrSessionFallbackOverrideSnapshot(sessionId);
  const latest = findLatestPersistedMmrSessionFallbackEntry(getSessionEntries(ctx), sessionId);
  clearMmrSessionFallbackOverride(sessionId);
  clearMmrSessionFallbackTransientState(sessionId);
  clearMmrManagedModelOverride();
  if (!runtimeOverride && (!latest || latest.cleared === true)) return;
  try {
    pi.appendEntry(MMR_SESSION_FALLBACK_ENTRY, toPersistedMmrSessionFallbackClear({
      sessionId,
      reason,
      clearedAt: new Date().toISOString(),
    }));
  } catch {
    // Clearing is best-effort; runtime state is already cleared.
  }
}

async function applyPersistedOverride(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  override: PersistedMmrSessionFallbackOverride,
): Promise<boolean> {
  const model = findRegisteredModel(ctx, override.selectedProvider, override.selectedModel);
  if (!model || !hasConfiguredAuth(ctx, model)) return false;

  try {
    return await runMmrManagedModelUpdate(async () => {
      const applied = await pi.setModel(model);
      if (!applied) return false;
      pi.setThinkingLevel(override.thinkingLevel);
      setMmrManagedModelOverride({
        kind: "session-fallback",
        provider: override.selectedProvider,
        model: override.selectedModel,
        thinkingLevel: override.thinkingLevel,
        appliedAt: override.appliedAt,
      });
      publishFallbackModeState(pi, ctx, override, model);
      return true;
    });
  } catch (error) {
    ctx.ui.notify(`Failed to reapply session fallback: ${error instanceof Error ? error.message : String(error)}`, "warning");
    return false;
  }
}

async function handleSessionStart(pi: ExtensionAPI, event: { reason?: string }, ctx: ExtensionContext): Promise<void> {
  const sessionId = getSessionId(ctx);
  if (event.reason === "new" || event.reason === "fork") {
    clearMmrSessionFallbackOverride(sessionId);
    clearMmrSessionFallbackTransientState(sessionId);
    clearMmrManagedModelOverride();
    return;
  }

  if (getMmrSubagentState()) return;
  const state = getMmrModeState();
  if (!state || state.mode === "free") return;

  const persisted = findLatestPersistedMmrSessionFallbackOverride(getSessionEntries(ctx), sessionId);
  if (!persisted || !stateMatchesPersistedFallback(persisted)) return;
  const applied = await applyPersistedOverride(pi, ctx, persisted);
  if (applied) setMmrSessionFallbackOverride(sessionId, persisted);
}

async function handleMessageEnd(pi: ExtensionAPI, event: { message?: unknown }, ctx: ExtensionContext): Promise<{ message: MmrMessageEndReplacement } | undefined> {
  if (!ctx.hasUI) return undefined;
  if (getMmrSubagentState()) return undefined;
  if (!isAssistantErrorMessage(event.message)) {
    // A turn that completed without error means the route recovered; any
    // pending transient streak is no longer sustained.
    if (isAssistantNonErrorMessage(event.message)) clearMmrSessionFallbackTransientState(getSessionId(ctx));
    return undefined;
  }

  const state = getMmrModeState();
  if (!state || state.mode === "free" || !isMmrModeKey(state.mode) || !state.modelApplied || !state.provider || !state.model) return undefined;
  const sessionId = getSessionId(ctx);
  if (getMmrSessionFallbackOverrideSnapshot(sessionId)) return undefined;
  if (getMmrSessionFallbackPromptInFlight()) return undefined;

  const originalError = event.message.errorMessage;
  const classification = classifyMmrSessionFallbackError({ provider: state.provider, errorMessage: originalError });
  if (!classification.shouldPrompt) return undefined;

  if (classification.retryable) {
    const transient = nextMmrSessionFallbackTransientState(getMmrSessionFallbackTransientState(sessionId), Date.now());
    setMmrSessionFallbackTransientState(sessionId, transient);
    if (!isMmrSessionFallbackTransientSustained(transient)) {
      ctx.ui.notify(`${classification.friendlyMessage} A fallback model will be offered if it persists.`, "warning");
      return undefined;
    }
  }
  clearMmrSessionFallbackTransientState(sessionId);

  const mode = getMmrMode(state.mode);
  const candidates = buildMmrSessionFallbackCandidates({
    registry: ctx.modelRegistry,
    modePreferences: mode.modelPreferences,
    failingProvider: state.provider,
    failingModel: state.model,
  });
  if (candidates.length === 0) {
    ctx.ui.notify("No authenticated fallback models are available for this session.", "warning");
    return undefined;
  }

  const promptPromise = promptForMmrSessionFallback({ ctx, candidates, reason: classification.friendlyMessage });
  setMmrSessionFallbackPromptInFlight(promptPromise);
  let selection: Awaited<typeof promptPromise>;
  try {
    selection = await promptPromise;
  } catch (error) {
    ctx.ui.notify(`Fallback selection failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    return undefined;
  } finally {
    setMmrSessionFallbackPromptInFlight(undefined);
  }

  if (!selection) return undefined;

  const override = toPersistedMmrSessionFallbackOverride({
    sessionId,
    mode: state.mode,
    failingProvider: state.provider,
    failingModel: state.model,
    selectedProvider: selection.candidate.provider,
    selectedModel: selection.candidate.model,
    thinkingLevel: selection.thinkingLevel,
    reasonKind: classification.kind,
    appliedAt: new Date().toISOString(),
  });

  let applied = false;
  try {
    applied = await runMmrManagedModelUpdate(async () => {
      const modelApplied = await pi.setModel(selection.candidate.registeredModel as Parameters<ExtensionAPI["setModel"]>[0]);
      if (!modelApplied) return false;
      pi.setThinkingLevel(selection.thinkingLevel);
      setMmrManagedModelOverride({
        kind: "session-fallback",
        provider: override.selectedProvider,
        model: override.selectedModel,
        thinkingLevel: override.thinkingLevel,
        appliedAt: override.appliedAt,
      });
      publishFallbackModeState(pi, ctx, override, selection.candidate.registeredModel as Parameters<ExtensionAPI["setModel"]>[0]);
      return true;
    });
  } catch (error) {
    ctx.ui.notify(`Failed to apply fallback model: ${error instanceof Error ? error.message : String(error)}`, "error");
    return undefined;
  }

  if (!applied) {
    ctx.ui.notify("Pi rejected the selected fallback model.", "error");
    return undefined;
  }

  setMmrSessionFallbackOverride(sessionId, override);
  try {
    pi.appendEntry(MMR_SESSION_FALLBACK_ENTRY, override);
  } catch (error) {
    ctx.ui.notify(`Fallback was applied but could not be persisted: ${error instanceof Error ? error.message : String(error)}`, "warning");
  }

  return { message: createMmrSessionFallbackRetryMessage(event.message, override, originalError) as unknown as MmrMessageEndReplacement };
}

export function createMmrSessionFallbackExtension() {
  return function mmrSessionFallbackExtension(pi: ExtensionAPI): void {
    pi.on("session_start", async (event, ctx) => {
      await handleSessionStart(pi, event, ctx);
    });

    pi.on("message_end", async (event, ctx) => {
      try {
        return await handleMessageEnd(pi, event, ctx);
      } catch (error) {
        ctx.ui.notify(`Session fallback failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        return undefined;
      }
    });

    pi.on("model_select", (event, ctx) => {
      if (isMmrManagedModelUpdateActive() || event.source === "restore") return;
      clearSessionFallback(pi, ctx, "model-select");
    });

    pi.on("thinking_level_select", (_event, ctx) => {
      if (isMmrManagedModelUpdateActive()) return;
      clearSessionFallback(pi, ctx, "thinking-level-select");
    });
  };
}

export default createMmrSessionFallbackExtension();
