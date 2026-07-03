/**
 * Sustained-transient escalation policy for session fallback (issue #130).
 *
 * Retryable provider errors (overload, rate limit) are usually transient and
 * already covered by Pi's same-model auto-retry. A single such error reaching
 * `message_end` should not trigger a cross-model fallback prompt; only a
 * repeat within a short window counts as sustained. Non-retryable hard-quota
 * errors bypass this policy and escalate immediately.
 */

export const MMR_SESSION_FALLBACK_SUSTAINED_WINDOW_MS = 5 * 60_000;
export const MMR_SESSION_FALLBACK_SUSTAINED_THRESHOLD = 2;

export interface MmrSessionFallbackTransientState {
  count: number;
  lastAt: number;
}

export function nextMmrSessionFallbackTransientState(
  previous: MmrSessionFallbackTransientState | undefined,
  now: number,
): MmrSessionFallbackTransientState {
  if (!previous || now - previous.lastAt > MMR_SESSION_FALLBACK_SUSTAINED_WINDOW_MS) {
    return { count: 1, lastAt: now };
  }
  return { count: previous.count + 1, lastAt: now };
}

export function isMmrSessionFallbackTransientSustained(state: MmrSessionFallbackTransientState): boolean {
  return state.count >= MMR_SESSION_FALLBACK_SUSTAINED_THRESHOLD;
}
