import type { PersistedMmrSessionFallbackOverride } from "./state.js";

export type MmrSessionFallbackOverride = PersistedMmrSessionFallbackOverride;

interface MmrSessionFallbackRuntime {
  overrides: Map<string, MmrSessionFallbackOverride>;
  promptInFlight?: Promise<unknown>;
}

const RUNTIME_KEY = "__pi_mmr_session_fallback_runtime_v1__";

const globalStore = globalThis as typeof globalThis & {
  [RUNTIME_KEY]?: MmrSessionFallbackRuntime;
};

function getRuntime(): MmrSessionFallbackRuntime {
  const existing = globalStore[RUNTIME_KEY];
  if (existing) return existing;
  const fresh: MmrSessionFallbackRuntime = { overrides: new Map() };
  globalStore[RUNTIME_KEY] = fresh;
  return fresh;
}

function cloneOverride(override: MmrSessionFallbackOverride): MmrSessionFallbackOverride {
  return { ...override };
}

function fallbackKey(sessionId: string | undefined): string {
  return sessionId && sessionId.length > 0 ? sessionId : "__unknown_session__";
}

export function getMmrSessionFallbackOverrideSnapshot(sessionId?: string): MmrSessionFallbackOverride | undefined {
  const found = getRuntime().overrides.get(fallbackKey(sessionId));
  return found ? cloneOverride(found) : undefined;
}

export function setMmrSessionFallbackOverride(sessionId: string | undefined, override: MmrSessionFallbackOverride): void {
  getRuntime().overrides.set(fallbackKey(sessionId), cloneOverride(override));
}

export function clearMmrSessionFallbackOverride(sessionId?: string): void {
  getRuntime().overrides.delete(fallbackKey(sessionId));
}

export function clearMmrSessionFallbackOverrides(): void {
  const runtime = getRuntime();
  runtime.overrides.clear();
  runtime.promptInFlight = undefined;
}

export function getMmrSessionFallbackPromptInFlight(): Promise<unknown> | undefined {
  return getRuntime().promptInFlight;
}

export function setMmrSessionFallbackPromptInFlight(promise: Promise<unknown> | undefined): void {
  getRuntime().promptInFlight = promise;
}
