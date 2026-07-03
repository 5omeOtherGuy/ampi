import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MmrSessionFallbackCandidate } from "./candidates.js";

const THINKING_DESCRIPTIONS: Record<ThinkingLevel, string> = {
  off: "No reasoning",
  minimal: "Very brief reasoning",
  low: "Light reasoning",
  medium: "Moderate reasoning",
  high: "Deep reasoning",
  xhigh: "Maximum reasoning",
};

export interface MmrSessionFallbackSelection<TModel> {
  candidate: MmrSessionFallbackCandidate<TModel & { provider: string; id: string }>;
  thinkingLevel: ThinkingLevel;
}

export async function promptForMmrSessionFallback<TModel extends { provider: string; id: string }>(args: {
  ctx: ExtensionContext;
  candidates: readonly MmrSessionFallbackCandidate<TModel>[];
  reason: string;
}): Promise<MmrSessionFallbackSelection<TModel> | undefined> {
  if (args.candidates.length === 0) return undefined;

  const byLabel = new Map(args.candidates.map((candidate) => [candidate.label, candidate]));
  const pickedLabel = await args.ctx.ui.select(
    `Select fallback model — ${args.reason}`,
    args.candidates.map((candidate) => candidate.label),
  );
  if (!pickedLabel) return undefined;
  const candidate = byLabel.get(pickedLabel);
  if (!candidate) return undefined;

  const thinkingLabels = candidate.thinkingLevels.map((level) => `${level} — ${THINKING_DESCRIPTIONS[level]}`);
  const byThinkingLabel = new Map(candidate.thinkingLevels.map((level, index) => [thinkingLabels[index], level]));
  const pickedThinking = await args.ctx.ui.select(
    `Select thinking for ${candidate.provider}/${candidate.model}`,
    thinkingLabels,
  );
  if (!pickedThinking) return undefined;
  const thinkingLevel = byThinkingLabel.get(pickedThinking);
  if (!thinkingLevel) return undefined;

  return { candidate, thinkingLevel };
}
