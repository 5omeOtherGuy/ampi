import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

describe("mmr-session-fallback persisted state", () => {
  it("round-trips valid session fallback overrides", async () => {
    const {
      MMR_SESSION_FALLBACK_ENTRY,
      MMR_SESSION_FALLBACK_STATE_VERSION,
      findLatestPersistedMmrSessionFallbackOverride,
      toPersistedMmrSessionFallbackOverride,
    } = await importSource("extensions/ampi-session-fallback/state.ts");

    const persisted = toPersistedMmrSessionFallbackOverride({
      sessionId: "session-1",
      mode: "medium",
      failingProvider: "claude-subscription",
      failingModel: "claude-opus-4-8",
      selectedProvider: "anthropic",
      selectedModel: "claude-opus-4-6",
      thinkingLevel: "high",
      reasonKind: "anthropic-rate-limit",
      appliedAt: "2026-05-26T00:00:00.000Z",
    });

    const found = findLatestPersistedMmrSessionFallbackOverride([
      { type: "custom", customType: "other", data: { nope: true } },
      { type: "custom", customType: MMR_SESSION_FALLBACK_ENTRY, data: persisted },
    ], "session-1");

    assert.equal(persisted.version, MMR_SESSION_FALLBACK_STATE_VERSION);
    assert.deepEqual(found, persisted);
  });

  it("honors clear tombstones and rejects missing or mismatched session ids", async () => {
    const {
      MMR_SESSION_FALLBACK_ENTRY,
      findLatestPersistedMmrSessionFallbackOverride,
      toPersistedMmrSessionFallbackClear,
      toPersistedMmrSessionFallbackOverride,
    } = await importSource("extensions/ampi-session-fallback/state.ts");

    const override = toPersistedMmrSessionFallbackOverride({
      sessionId: "session-1",
      mode: "medium",
      failingProvider: "claude-subscription",
      failingModel: "claude-opus-4-8",
      selectedProvider: "anthropic",
      selectedModel: "claude-opus-4-6",
      thinkingLevel: "high",
      reasonKind: "anthropic-rate-limit",
      appliedAt: "2026-05-26T00:00:00.000Z",
    });
    const clear = toPersistedMmrSessionFallbackClear({
      sessionId: "session-1",
      reason: "model-select",
      clearedAt: "2026-05-26T00:01:00.000Z",
    });

    assert.equal(findLatestPersistedMmrSessionFallbackOverride([
      { type: "custom", customType: MMR_SESSION_FALLBACK_ENTRY, data: override },
      { type: "custom", customType: MMR_SESSION_FALLBACK_ENTRY, data: clear },
    ], "session-1"), undefined);

    assert.equal(findLatestPersistedMmrSessionFallbackOverride([
      { type: "custom", customType: MMR_SESSION_FALLBACK_ENTRY, data: { ...override, sessionId: undefined } },
    ], "session-1"), undefined);
  });

  it("skips invalid, future-version, and other-session entries", async () => {
    const { MMR_SESSION_FALLBACK_ENTRY, findLatestPersistedMmrSessionFallbackOverride } = await importSource("extensions/ampi-session-fallback/state.ts");

    const found = findLatestPersistedMmrSessionFallbackOverride([
      { type: "custom", customType: MMR_SESSION_FALLBACK_ENTRY, data: { version: 999, sessionId: "session-1" } },
      { type: "custom", customType: MMR_SESSION_FALLBACK_ENTRY, data: { version: 1, sessionId: "session-2", selectedProvider: "openai", selectedModel: "gpt-5.5", thinkingLevel: "medium", failingProvider: "openai-codex", failingModel: "gpt-5.5", reasonKind: "openai-usage-limit", appliedAt: "2026-05-26T00:00:00.000Z" } },
    ], "session-1");

    assert.equal(found, undefined);
  });
});
