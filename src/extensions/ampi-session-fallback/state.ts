import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { isRecord } from "../ampi-core/internal/json.js";
import { isThinkingLevel } from "../ampi-core/settings.js";

export const AMPI_SESSION_FALLBACK_ENTRY = "ampi-session-fallback.override";
/** Legacy persisted entry key read for existing sessions. */
export const MMR_SESSION_FALLBACK_ENTRY = "mmr-session-fallback.override";
const SESSION_FALLBACK_ENTRY_KEYS: ReadonlySet<string> = new Set([
  AMPI_SESSION_FALLBACK_ENTRY,
  MMR_SESSION_FALLBACK_ENTRY,
]);
export const MMR_SESSION_FALLBACK_STATE_VERSION = 1;

export interface PersistedMmrSessionFallbackOverride {
  version: typeof MMR_SESSION_FALLBACK_STATE_VERSION;
  cleared?: false;
  sessionId?: string;
  mode?: string;
  failingProvider: string;
  failingModel: string;
  selectedProvider: string;
  selectedModel: string;
  thinkingLevel: ThinkingLevel;
  reasonKind: string;
  appliedAt: string;
}

export interface PersistedMmrSessionFallbackClear {
  version: typeof MMR_SESSION_FALLBACK_STATE_VERSION;
  cleared: true;
  sessionId?: string;
  reason: string;
  clearedAt: string;
}

export type PersistedMmrSessionFallbackEntry = PersistedMmrSessionFallbackOverride | PersistedMmrSessionFallbackClear;
export type MmrSessionFallbackOverrideInput = Omit<PersistedMmrSessionFallbackOverride, "version" | "cleared">;

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sessionMatches(parsedSessionId: string | undefined, currentSessionId: string | undefined): boolean {
  if (!currentSessionId) return true;
  return parsedSessionId === currentSessionId;
}

export function parsePersistedMmrSessionFallbackClear(value: unknown): PersistedMmrSessionFallbackClear | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== MMR_SESSION_FALLBACK_STATE_VERSION || value.cleared !== true) return undefined;
  const reason = readString(value, "reason");
  const clearedAt = readString(value, "clearedAt");
  if (!reason || !clearedAt) return undefined;
  return {
    version: MMR_SESSION_FALLBACK_STATE_VERSION,
    cleared: true,
    sessionId: readString(value, "sessionId"),
    reason,
    clearedAt,
  };
}

export function parsePersistedMmrSessionFallbackOverride(value: unknown): PersistedMmrSessionFallbackOverride | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== MMR_SESSION_FALLBACK_STATE_VERSION || value.cleared === true) return undefined;

  const failingProvider = readString(value, "failingProvider");
  const failingModel = readString(value, "failingModel");
  const selectedProvider = readString(value, "selectedProvider");
  const selectedModel = readString(value, "selectedModel");
  const reasonKind = readString(value, "reasonKind");
  const appliedAt = readString(value, "appliedAt");
  const thinkingLevel = value.thinkingLevel;

  if (!failingProvider || !failingModel || !selectedProvider || !selectedModel || !reasonKind || !appliedAt) return undefined;
  if (!isThinkingLevel(thinkingLevel)) return undefined;

  return {
    version: MMR_SESSION_FALLBACK_STATE_VERSION,
    sessionId: readString(value, "sessionId"),
    mode: readString(value, "mode"),
    failingProvider,
    failingModel,
    selectedProvider,
    selectedModel,
    thinkingLevel,
    reasonKind,
    appliedAt,
  };
}

export function parsePersistedMmrSessionFallbackEntry(value: unknown): PersistedMmrSessionFallbackEntry | undefined {
  return parsePersistedMmrSessionFallbackClear(value) ?? parsePersistedMmrSessionFallbackOverride(value);
}

export function toPersistedMmrSessionFallbackOverride(
  override: MmrSessionFallbackOverrideInput,
): PersistedMmrSessionFallbackOverride {
  return {
    version: MMR_SESSION_FALLBACK_STATE_VERSION,
    ...override,
  };
}

export function toPersistedMmrSessionFallbackClear(args: {
  sessionId?: string;
  reason: string;
  clearedAt: string;
}): PersistedMmrSessionFallbackClear {
  return {
    version: MMR_SESSION_FALLBACK_STATE_VERSION,
    cleared: true,
    sessionId: args.sessionId,
    reason: args.reason,
    clearedAt: args.clearedAt,
  };
}

export function findLatestPersistedMmrSessionFallbackEntry(
  entries: readonly unknown[],
  sessionId?: string,
): PersistedMmrSessionFallbackEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry)) continue;
    if (entry.type !== "custom" || !SESSION_FALLBACK_ENTRY_KEYS.has(String(entry.customType ?? ""))) continue;
    const parsed = parsePersistedMmrSessionFallbackEntry(entry.data);
    if (!parsed || !sessionMatches(parsed.sessionId, sessionId)) continue;
    return parsed;
  }
  return undefined;
}

export function findLatestPersistedMmrSessionFallbackOverride(
  entries: readonly unknown[],
  sessionId?: string,
): PersistedMmrSessionFallbackOverride | undefined {
  const latest = findLatestPersistedMmrSessionFallbackEntry(entries, sessionId);
  return latest && latest.cleared !== true ? latest : undefined;
}
