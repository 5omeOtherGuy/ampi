import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const MMR_SESSION_FALLBACK_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function getMmrSessionFallbackThinkingLevels(model: { reasoning?: boolean; thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>> }): ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return MMR_SESSION_FALLBACK_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh") return mapped !== undefined;
    return true;
  });
}
