import { parseBoolEnv } from "../mmr-core/internal/env.js";

export interface MmrHistorySettings {
  enabled: boolean;
  maxResults: number;
  maxExcerptBytes: number;
}

export const MMR_HISTORY_ENABLE_ENV = "MMR_HISTORY_ENABLE";
export const DEFAULT_MMR_HISTORY_MAX_RESULTS = 10;
export const MAX_MMR_HISTORY_RESULTS = 20;
export const DEFAULT_MMR_HISTORY_MAX_EXCERPT_BYTES = 24_000;

// Keeps mmr-history's positive-integer parser (parseInt + cap-to-max with a
// numeric fallback) distinct from mmr-web's strict Number-based variant: the
// two extensions have diverged here historically and unifying them would
// change observable behavior for inputs like "12abc" or "0x10".
function parsePositiveInteger(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

export function loadMmrHistorySettings(env: NodeJS.ProcessEnv = process.env): MmrHistorySettings {
  return {
    enabled: parseBoolEnv(env[MMR_HISTORY_ENABLE_ENV]) ?? false,
    maxResults: parsePositiveInteger(env.MMR_HISTORY_MAX_RESULTS, DEFAULT_MMR_HISTORY_MAX_RESULTS, MAX_MMR_HISTORY_RESULTS),
    maxExcerptBytes: parsePositiveInteger(env.MMR_HISTORY_MAX_EXCERPT_BYTES, DEFAULT_MMR_HISTORY_MAX_EXCERPT_BYTES, 100_000),
  };
}
