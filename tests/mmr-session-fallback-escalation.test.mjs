import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

describe("mmr-session-fallback sustained-transient escalation", () => {
  it("counts a first transient error as not sustained", async () => {
    const {
      isMmrSessionFallbackTransientSustained,
      nextMmrSessionFallbackTransientState,
    } = await importSource("extensions/ampi-session-fallback/escalation.ts");

    const state = nextMmrSessionFallbackTransientState(undefined, 1_000);
    assert.deepEqual(state, { count: 1, lastAt: 1_000 });
    assert.equal(isMmrSessionFallbackTransientSustained(state), false);
  });

  it("treats a repeat within the window as sustained", async () => {
    const {
      MMR_SESSION_FALLBACK_SUSTAINED_WINDOW_MS,
      isMmrSessionFallbackTransientSustained,
      nextMmrSessionFallbackTransientState,
    } = await importSource("extensions/ampi-session-fallback/escalation.ts");

    const first = nextMmrSessionFallbackTransientState(undefined, 1_000);
    const second = nextMmrSessionFallbackTransientState(first, 1_000 + MMR_SESSION_FALLBACK_SUSTAINED_WINDOW_MS);
    assert.deepEqual(second, { count: 2, lastAt: 1_000 + MMR_SESSION_FALLBACK_SUSTAINED_WINDOW_MS });
    assert.equal(isMmrSessionFallbackTransientSustained(second), true);
  });

  it("restarts the streak when the repeat falls outside the window", async () => {
    const {
      MMR_SESSION_FALLBACK_SUSTAINED_WINDOW_MS,
      isMmrSessionFallbackTransientSustained,
      nextMmrSessionFallbackTransientState,
    } = await importSource("extensions/ampi-session-fallback/escalation.ts");

    const first = nextMmrSessionFallbackTransientState(undefined, 1_000);
    const late = nextMmrSessionFallbackTransientState(first, 1_001 + MMR_SESSION_FALLBACK_SUSTAINED_WINDOW_MS);
    assert.deepEqual(late, { count: 1, lastAt: 1_001 + MMR_SESSION_FALLBACK_SUSTAINED_WINDOW_MS });
    assert.equal(isMmrSessionFallbackTransientSustained(late), false);
  });
});
