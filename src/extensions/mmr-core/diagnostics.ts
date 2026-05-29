import type { MmrModeState, MmrPolicyDiagnostic } from "./types.js";

const SOURCE = "mmr-core";
const FALLBACK_PROVIDER_WARNING =
  "Using only one provider is not recommended because MMR modes are optimized around model-specific strengths and weaknesses.";

/**
 * Structured policy diagnostics for the current MMR mode state.
 *
 * `/mmr-status` and the activation notification's "Warnings:" block both render
 * `message` verbatim, so the two surfaces stay in sync. Worker tools and later
 * extensions can branch on the stable `code` field.
 *
 * Deferred-tool messages (e.g. "oracle: deferred until mmr-subagents ships")
 * are intentionally **not** policy diagnostics: they are informational "what
 * is coming" announcements rather than active warnings, and surface as a
 * separate `Deferred tools:` section in `/mmr-status` and as their own bullets
 * appended after policy warnings in the activation notification.
 *
 * The compact status bar in `status.ts` summarizes mode/model state only and
 * does not re-render diagnostic messages.
 *
 * Free mode never emits diagnostics: native Pi controls are in charge and
 * MMR-specific routing/tool/policy state is intentionally absent.
 */
export function getMmrPolicyDiagnostics(state: MmrModeState): MmrPolicyDiagnostic[] {
  if (state.mode === "free") return [];

  const diagnostics: MmrPolicyDiagnostic[] = [];

  if (!state.modelApplied) {
    diagnostics.push({
      code: "model.not-applied",
      severity: "warning",
      source: SOURCE,
      message: state.modelFound ? "model was found but not applied" : "no usable model found",
      data: { modelFound: state.modelFound, requestedModels: [...state.requestedModels] },
    });
  } else if (state.modelFallbackApplied) {
    const reason = state.modelFallbackReason ?? "fallback route selected";
    diagnostics.push({
      code: "model.fallback-applied",
      severity: "warning",
      source: SOURCE,
      message: `model fallback applied: ${reason} ${FALLBACK_PROVIDER_WARNING}`,
      data: {
        provider: state.provider,
        model: state.model,
        reason: state.modelFallbackReason,
      },
    });
  }

  if (state.activeTools.length === 0) {
    diagnostics.push({
      code: "tools.none-active",
      severity: "warning",
      source: SOURCE,
      message: "no active tools resolved",
    });
  }

  if (state.missingTools.length > 0) {
    diagnostics.push({
      code: "tools.missing",
      severity: "warning",
      source: SOURCE,
      message: `missing tools: ${state.missingTools.join(", ")}`,
      data: { tools: [...state.missingTools] },
    });
  }

  if (state.gatedTools.length > 0) {
    diagnostics.push({
      code: "tools.gated",
      severity: "warning",
      source: SOURCE,
      message: `gated tools: ${state.gatedTools.join(", ")}`,
      data: { tools: [...state.gatedTools] },
    });
  }

  if (state.disabledTools.length > 0) {
    diagnostics.push({
      code: "tools.disabled",
      severity: "warning",
      source: SOURCE,
      message: `disabled tools: ${state.disabledTools.join(", ")}`,
      data: { tools: [...state.disabledTools] },
    });
  }

  if (
    typeof state.effectiveContextWindow === "number"
    && Number.isFinite(state.effectiveContextWindow)
    && state.effectiveContextWindow > 0
    && typeof state.registeredContextWindow === "number"
    && Number.isFinite(state.registeredContextWindow)
    && state.registeredContextWindow > state.effectiveContextWindow
  ) {
    const profile = state.effectiveContextWindow;
    const registered = state.registeredContextWindow;
    const route = state.provider && state.model ? `${state.provider}/${state.model}` : "selected route";
    diagnostics.push({
      code: "context.registered-exceeds-profile",
      severity: "warning",
      source: SOURCE,
      message: `mode profile ${profile} tokens is smaller than registered window ${registered} tokens for ${route}; Pi-native compaction follows the registered window, so the mode profile is a display budget only`,
      data: {
        provider: state.provider || undefined,
        model: state.model || undefined,
        effectiveContextWindow: profile,
        registeredContextWindow: registered,
      },
    });
  }

  for (const note of state.availabilityNotes) {
    diagnostics.push({
      code: "availability",
      severity: "warning",
      source: SOURCE,
      message: note,
      data: { note },
    });
  }

  return diagnostics;
}
