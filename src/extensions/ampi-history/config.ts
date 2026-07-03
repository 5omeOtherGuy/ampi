import { parseBoolEnv, readPreferredEnv } from "../ampi-core/internal/env.js";

export interface MmrHistorySettings {
  enabled: boolean;
  maxResults: number;
  maxExcerptBytes: number;
  /**
   * Whether outgoing session CONTENT is run through the deterministic
   * `redactText` sanitizer before it leaves the local catalog.
   *
   * Default OFF (opt-in). For the local same-user case `read_session` /
   * `find_session` exist to recover a user's own artifacts (file paths,
   * config values, identifiers); redacting them by default is lossy and
   * mangles the very text the user asked for. So raw content passes
   * through unless the operator explicitly sets `AMPI_HISTORY_REDACT`
   * (legacy `MMR_HISTORY_REDACT`) to a truthy value.
   *
   * This toggle gates CONTENT redaction only. Two things stay on
   * regardless: `projectRefFromCwd` hashing (a raw cwd must never be
   * surfaced) and error/fallback-reason redaction (worker spawn/route
   * errors are not user-requested content and can carry incidental
   * secrets or paths).
   */
  redactionEnabled: boolean;
  /**
   * Byte budget for the sanitized packet sent to the history-reader worker.
   * Sized for a large-context extraction model so most of a session survives;
   * see DEFAULT_MMR_HISTORY_PACKET_BYTE_BUDGET.
   */
  packetByteBudget: number;
}

export const AMPI_HISTORY_ENABLE_ENV = "AMPI_HISTORY_ENABLE";
/** Legacy env alias accepted while callers migrate. */
export const MMR_HISTORY_ENABLE_ENV = "MMR_HISTORY_ENABLE";
// Opt-in CONTENT redaction toggle. Unset / falsy => raw content (default).
export const AMPI_HISTORY_REDACT_ENV = "AMPI_HISTORY_REDACT";
/** Legacy env alias accepted while callers migrate. */
export const MMR_HISTORY_REDACT_ENV = "MMR_HISTORY_REDACT";
export const DEFAULT_MMR_HISTORY_MAX_RESULTS = 10;
export const MAX_MMR_HISTORY_RESULTS = 20;
export const DEFAULT_MMR_HISTORY_MAX_EXCERPT_BYTES = 24_000;
// Default packet byte budget for the history-reader worker. 512KB of sanitized
// JSON is roughly 100-150K tokens, which a large-context extraction model
// handles comfortably while leaving room for the system prompt and worker
// output. The ceiling allows operators on very large windows to go further.
export const AMPI_HISTORY_PACKET_BYTE_BUDGET_ENV = "AMPI_HISTORY_PACKET_BYTE_BUDGET";
/** Legacy env alias accepted while callers migrate. */
export const MMR_HISTORY_PACKET_BYTE_BUDGET_ENV = "MMR_HISTORY_PACKET_BYTE_BUDGET";
export const DEFAULT_MMR_HISTORY_PACKET_BYTE_BUDGET = 512_000;
export const MAX_MMR_HISTORY_PACKET_BYTE_BUDGET = 4_000_000;

// Keeps ampi-history's positive-integer parser (parseInt + cap-to-max with a
// numeric fallback) distinct from ampi-web's strict Number-based variant: the
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
    enabled: parseBoolEnv(readPreferredEnv(env, AMPI_HISTORY_ENABLE_ENV, MMR_HISTORY_ENABLE_ENV)?.value) ?? false,
    maxResults: parsePositiveInteger(
      readPreferredEnv(env, "AMPI_HISTORY_MAX_RESULTS", "MMR_HISTORY_MAX_RESULTS")?.value,
      DEFAULT_MMR_HISTORY_MAX_RESULTS,
      MAX_MMR_HISTORY_RESULTS,
    ),
    maxExcerptBytes: parsePositiveInteger(
      readPreferredEnv(env, "AMPI_HISTORY_MAX_EXCERPT_BYTES", "MMR_HISTORY_MAX_EXCERPT_BYTES")?.value,
      DEFAULT_MMR_HISTORY_MAX_EXCERPT_BYTES,
      100_000,
    ),
    // Opt-in: redaction stays OFF (raw content) unless explicitly enabled.
    redactionEnabled: parseBoolEnv(readPreferredEnv(env, AMPI_HISTORY_REDACT_ENV, MMR_HISTORY_REDACT_ENV)?.value) ?? false,
    packetByteBudget: parsePositiveInteger(
      readPreferredEnv(env, AMPI_HISTORY_PACKET_BYTE_BUDGET_ENV, MMR_HISTORY_PACKET_BYTE_BUDGET_ENV)?.value,
      DEFAULT_MMR_HISTORY_PACKET_BYTE_BUDGET,
      MAX_MMR_HISTORY_PACKET_BYTE_BUDGET,
    ),
  };
}
