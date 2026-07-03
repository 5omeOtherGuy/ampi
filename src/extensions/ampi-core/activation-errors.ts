import type { MmrModeDefinition, MmrModeState, MmrModelCandidateResolution, MmrModelResolution, MmrToolResolution } from "./types.js";

function candidateFailureReason(candidate: MmrModelCandidateResolution): string {
  if (candidate.reason) return candidate.reason;
  if (!candidate.registered) return "not registered";
  if (!candidate.authenticated) return "registered but not authenticated";
  if (candidate.attempted && !candidate.applied) return "Pi rejected model selection";
  return "not selected";
}

export function formatFailedModelTargets(modelResolution: MmrModelResolution): string {
  const groups = new Map<string, { model: string; thinkingLevel?: string; candidates: MmrModelCandidateResolution[] }>();
  for (const candidate of modelResolution.candidates) {
    const key = `${candidate.requestedModel}\u0000${candidate.thinkingLevel ?? ""}`;
    const group = groups.get(key) ?? { model: candidate.requestedModel, thinkingLevel: candidate.thinkingLevel, candidates: [] };
    group.candidates.push(candidate);
    groups.set(key, group);
  }

  if (groups.size === 0) {
    return modelResolution.requestedModels.map((model) => `- ${model}: no candidate provider routes`).join("\n");
  }

  return [...groups.values()].map((group) => {
    const routeDetails = group.candidates.map((candidate) => `${candidate.provider}: ${candidateFailureReason(candidate)}`).join("; ");
    const thinking = group.thinkingLevel ? ` ${group.thinkingLevel}` : "";
    return `- ${group.model}${thinking}: ${routeDetails}`;
  }).join("\n");
}

export function formatActivationFailure(mode: MmrModeDefinition, modelResolution: MmrModelResolution, previousState: MmrModeState | undefined): string {
  const previousMode = previousState ? `${previousState.displayName} (${previousState.mode})` : "none";
  return [
    `Could not activate ${mode.displayName} mode.`,
    "",
    "Targets tried:",
    formatFailedModelTargets(modelResolution),
    "",
    `Current MMR mode unchanged: ${previousMode}.`,
    "Current Pi model unchanged.",
  ].join("\n");
}

export function formatZeroToolActivationFailure(mode: MmrModeDefinition, toolResolution: MmrToolResolution, previousState: MmrModeState | undefined): string {
  const previousMode = previousState ? `${previousState.displayName} (${previousState.mode})` : "none";
  const requestedTools = toolResolution.requestedTools.join(", ") || "none";
  const missingTools = toolResolution.missingTools.join(", ") || "none";

  return [
    `Could not activate ${mode.displayName} mode.`,
    "",
    "No active tools resolved for this mode; refusing to apply the locked mode with zero usable tools.",
    `Requested tools: ${requestedTools}`,
    `Missing tools: ${missingTools}`,
    "",
    `Current MMR mode unchanged: ${previousMode}.`,
    "Current Pi model unchanged.",
    "Current active tools unchanged.",
  ].join("\n");
}
