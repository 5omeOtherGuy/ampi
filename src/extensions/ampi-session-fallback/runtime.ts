import type { MmrSessionFallbackTransientState } from "./escalation.js";
import type { PersistedMmrSessionFallbackOverride } from "./state.js";

export type MmrSessionFallbackOverride = PersistedMmrSessionFallbackOverride;

interface MmrSessionFallbackRuntime {
  overrides: Map<string, MmrSessionFallbackOverride>;
  transients: Map<string, MmrSessionFallbackTransientState>;
  promptInFlight?: Promise<unknown>;
}

// Bumped to v3 when the runtime gained per-session transient-error tracking.
// The predicate below also rebuilds the singleton if an older build's instance
// is still on `globalThis`.
const AMPI_RUNTIME_KEY = "__pi_ampi_session_fallback_runtime_v3__";
const RUNTIME_KEY = "__pi_mmr_session_fallback_runtime_v3__";

const globalStore = globalThis as typeof globalThis & {
  [AMPI_RUNTIME_KEY]?: MmrSessionFallbackRuntime;
  [RUNTIME_KEY]?: MmrSessionFallbackRuntime;
};

/**
 * True when a value stored on `globalThis` is a usable session-fallback
 * runtime. Pi may load extension entrypoints with isolated module caches and
 * can reload an extension in-place, which can leave a stale-shape singleton on
 * `globalThis` (for example a plain object where `overrides` is no longer a
 * `Map`). Unlike `ampi-core`'s method-bag runtime, this runtime is a data
 * holder, so the guard checks the data shape it relies on (`overrides` is a
 * `Map`) rather than a method allowlist.
 */
function isMmrSessionFallbackRuntimeCompatible(value: unknown): value is MmrSessionFallbackRuntime {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { overrides?: unknown; transients?: unknown };
  return candidate.overrides instanceof Map && candidate.transients instanceof Map;
}

/**
 * Resolve the process-global runtime singleton, rebuilding it when the stored
 * instance has a stale shape. Rebuilding drops transient session overrides held
 * only on the prior instance, but that is preferable to throwing
 * `overrides.*` errors from every fallback hook after an in-place reload. The
 * override state is process-local and non-persistent, so the blast radius is
 * one session's in-memory fallback overrides.
 */
function getRuntime(): MmrSessionFallbackRuntime {
  const existing = globalStore[AMPI_RUNTIME_KEY] ?? globalStore[RUNTIME_KEY];
  if (isMmrSessionFallbackRuntimeCompatible(existing)) {
    globalStore[AMPI_RUNTIME_KEY] = existing;
    globalStore[RUNTIME_KEY] = existing;
    return existing;
  }
  const fresh: MmrSessionFallbackRuntime = { overrides: new Map(), transients: new Map() };
  globalStore[AMPI_RUNTIME_KEY] = fresh;
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
  runtime.transients.clear();
  runtime.promptInFlight = undefined;
}

export function getMmrSessionFallbackTransientState(sessionId?: string): MmrSessionFallbackTransientState | undefined {
  const found = getRuntime().transients.get(fallbackKey(sessionId));
  return found ? { ...found } : undefined;
}

export function setMmrSessionFallbackTransientState(sessionId: string | undefined, state: MmrSessionFallbackTransientState): void {
  getRuntime().transients.set(fallbackKey(sessionId), { ...state });
}

export function clearMmrSessionFallbackTransientState(sessionId?: string): void {
  getRuntime().transients.delete(fallbackKey(sessionId));
}

export function getMmrSessionFallbackPromptInFlight(): Promise<unknown> | undefined {
  return getRuntime().promptInFlight;
}

export function setMmrSessionFallbackPromptInFlight(promise: Promise<unknown> | undefined): void {
  getRuntime().promptInFlight = promise;
}
