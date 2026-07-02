import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

function fakeRegistry(models, authenticatedProviders = new Set(models.map((model) => `${model.provider}/${model.id}`))) {
  return {
    getAll() {
      return models;
    },
    find(provider, modelId) {
      return models.find((model) => model.provider === provider && model.id === modelId);
    },
    hasConfiguredAuth(model) {
      return authenticatedProviders.has(`${model.provider}/${model.id}`);
    },
    isUsingOAuth(model) {
      return model.provider.endsWith("subscription") || model.provider.endsWith("codex");
    },
  };
}

describe("mmr-core model resolver", () => {
  it("prefers subscription providers over API equivalents for the same model", async () => {
    const { resolveAndApplyMmrModel } = await importSource("extensions/mmr-core/model-resolver.ts");
    const registry = fakeRegistry([
      { provider: "openai", id: "gpt-5.5" },
      { provider: "openai-codex", id: "gpt-5.5" },
    ]);
    const attempted = [];

    const resolved = await resolveAndApplyMmrModel({
      modeThinkingLevel: "xhigh",
      modelPreferences: [{ model: "gpt-5.5" }],
      registry,
      setModel: async (model) => {
        attempted.push(`${model.provider}/${model.id}`);
        return true;
      },
    });

    assert.equal(resolved.selectedProvider, "openai-codex");
    assert.equal(resolved.selectedModel, "gpt-5.5");
    assert.equal(resolved.selectedThinkingLevel, "xhigh");
    assert.equal(resolved.modelApplied, true);
    assert.equal(resolved.fallbackApplied, false);
    assert.deepEqual(attempted, ["openai-codex/gpt-5.5"]);
  });

  it("falls back across clearly defined model families when preferred targets are not usable", async () => {
    const { resolveAndApplyMmrModel } = await importSource("extensions/mmr-core/model-resolver.ts");
    const registry = fakeRegistry(
      [
        { provider: "openai-codex", id: "gpt-5.5" },
        { provider: "openai", id: "gpt-5.5" },
        { provider: "claude-subscription", id: "claude-opus-4-8" },
      ],
      new Set(["claude-subscription/claude-opus-4-8"]),
    );

    const resolved = await resolveAndApplyMmrModel({
      modeThinkingLevel: "xhigh",
      modelPreferences: [
        { model: "gpt-5.5", thinkingLevel: "xhigh" },
        { model: "claude-opus-4-8", thinkingLevel: "xhigh" },
      ],
      registry,
      setModel: async () => true,
    });

    assert.equal(resolved.targetModel, "gpt-5.5");
    assert.deepEqual(resolved.requestedModels, ["gpt-5.5", "claude-opus-4-8"]);
    assert.equal(resolved.selectedProvider, "claude-subscription");
    assert.equal(resolved.selectedModel, "claude-opus-4-8");
    assert.equal(resolved.selectedThinkingLevel, "xhigh");
    assert.equal(resolved.modelApplied, true);
    assert.equal(resolved.fallbackApplied, true);
    assert.match(resolved.fallbackReason, /openai-codex\/gpt-5\.5/);
  });

  it("resolves haiku-4-5 against a registry entry that uses the date-suffixed id (and vice versa)", async () => {
    const { resolveAndApplyMmrModel } = await importSource("extensions/mmr-core/model-resolver.ts");

    const subscriptionRegistry = fakeRegistry([
      { provider: "claude-subscription", id: "claude-haiku-4-5" },
    ]);
    const datedRegistry = fakeRegistry([
      { provider: "anthropic", id: "claude-haiku-4-5-20251001" },
    ]);
    const bothRegistry = fakeRegistry([
      { provider: "anthropic", id: "claude-haiku-4-5-20251001" },
      { provider: "claude-subscription", id: "claude-haiku-4-5" },
    ]);

    const resolvedSubscription = await resolveAndApplyMmrModel({
      modeThinkingLevel: "low",
      modelPreferences: [{ model: "claude-haiku-4-5-20251001" }],
      registry: subscriptionRegistry,
      setModel: async () => true,
    });
    assert.equal(resolvedSubscription.selectedProvider, "claude-subscription");
    assert.equal(resolvedSubscription.selectedModel, "claude-haiku-4-5");
    assert.equal(resolvedSubscription.modelApplied, true);

    const resolvedDated = await resolveAndApplyMmrModel({
      modeThinkingLevel: "low",
      modelPreferences: [{ model: "claude-haiku-4-5" }],
      registry: datedRegistry,
      setModel: async () => true,
    });
    assert.equal(resolvedDated.selectedProvider, "anthropic");
    assert.equal(resolvedDated.selectedModel, "claude-haiku-4-5-20251001");
    assert.equal(resolvedDated.modelApplied, true);

    const attempted = [];
    const resolvedBoth = await resolveAndApplyMmrModel({
      modeThinkingLevel: "low",
      modelPreferences: [{ model: "claude-haiku-4-5-20251001" }],
      registry: bothRegistry,
      setModel: async (model) => {
        attempted.push(`${model.provider}/${model.id}`);
        return true;
      },
    });
    assert.equal(resolvedBoth.selectedProvider, "claude-subscription");
    assert.equal(resolvedBoth.selectedModel, "claude-haiku-4-5");
    assert.deepEqual(attempted, ["claude-subscription/claude-haiku-4-5"]);
  });

  it("selects the shipped Fable Claude subscription route", async () => {
    const { getMmrMode } = await importSource("extensions/mmr-core/modes.ts");
    const { resolveAndApplyMmrModel } = await importSource("extensions/mmr-core/model-resolver.ts");
    const registry = fakeRegistry([
      { provider: "claude-subscription", id: "claude-fable-5" },
    ]);

    const resolved = await resolveAndApplyMmrModel({
      modeThinkingLevel: getMmrMode("fable").thinkingLevel,
      modelPreferences: getMmrMode("fable").modelPreferences,
      registry,
      setModel: async () => true,
    });

    assert.equal(resolved.selectedProvider, "claude-subscription");
    assert.equal(resolved.selectedModel, "claude-fable-5");
    assert.equal(resolved.modelApplied, true);
  });

  it("surfaces registry exceptions in candidate.reason instead of silently treating models as unauthenticated", async () => {
    const { resolveAndApplyMmrModel } = await importSource("extensions/mmr-core/model-resolver.ts");
    const models = [{ provider: "openai", id: "gpt-5.5" }];
    const registry = {
      getAll() { return models; },
      find(provider, modelId) { return models.find((m) => m.provider === provider && m.id === modelId); },
      hasConfiguredAuth() { throw new Error("auth backend offline"); },
      isUsingOAuth() { throw new Error("oauth probe failed"); },
    };

    const resolved = await resolveAndApplyMmrModel({
      modeThinkingLevel: "medium",
      modelPreferences: [{ model: "gpt-5.5" }],
      registry,
      setModel: async () => true,
    });

    assert.equal(resolved.modelApplied, false);
    const candidate = resolved.candidates.find((c) => c.provider === "openai" && c.model === "gpt-5.5");
    assert.ok(candidate, "expected an openai/gpt-5.5 candidate");
    assert.equal(candidate.authenticated, false);
    assert.match(
      candidate.reason ?? "",
      /registry threw.*auth backend offline/i,
      `candidate.reason should surface the underlying registry error, got: ${candidate.reason}`,
    );
  });

  it("continues to the next usable route when Pi rejects an authenticated candidate", async () => {
    const { resolveAndApplyMmrModel } = await importSource("extensions/mmr-core/model-resolver.ts");
    const registry = fakeRegistry([
      { provider: "openai-codex", id: "gpt-5.5" },
      { provider: "openai", id: "gpt-5.5" },
    ]);

    const resolved = await resolveAndApplyMmrModel({
      modeThinkingLevel: "xhigh",
      modelPreferences: [{ model: "gpt-5.5" }],
      registry,
      setModel: async (model) => model.provider !== "openai-codex",
    });

    assert.equal(resolved.selectedProvider, "openai");
    assert.equal(resolved.selectedModel, "gpt-5.5");
    assert.equal(resolved.modelApplied, true);
    assert.equal(resolved.fallbackApplied, true);
    assert.equal(
      resolved.candidates.find((candidate) => candidate.provider === "openai-codex")?.reason,
      "Pi rejected model selection",
    );
  });

  // Item 1: the canonical subscription-provider id list is owned once by
  // mmr-core and exposed only as a predicate (no mutable Set export).
  it("identifies the canonical subscription providers via the shared predicate", async () => {
    const { isMmrSubscriptionProvider } = await importSource("extensions/mmr-core/provider-constants.ts");
    for (const provider of ["claude-subscription", "openai-codex", "github-copilot"]) {
      assert.equal(isMmrSubscriptionProvider(provider), true, provider);
    }
    for (const provider of ["anthropic", "openai", "google", "", "claude-subscription "]) {
      assert.equal(isMmrSubscriptionProvider(provider), false, provider);
    }
  });
});
