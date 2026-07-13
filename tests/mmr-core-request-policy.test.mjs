import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

function anthropicPayload(overrides = {}) {
  return {
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    max_tokens: 1024,
    system: [{ type: "text", text: "Pi baseline system prompt." }],
    tools: [{ name: "read" }],
    ...overrides,
  };
}

function openaiPayload(overrides = {}) {
  return {
    model: "gpt-5.5",
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    stream: true,
    store: false,
    ...overrides,
  };
}

describe("mmr-core request policy", () => {
  it("pins the low-to-ultra OpenAI reasoning split", async () => {
    const { MMR_REQUEST_POLICIES } = await importSource("extensions/ampi-core/request-policy.ts");

    assert.deepEqual(Object.keys(MMR_REQUEST_POLICIES), ["low", "medium", "high", "ultra"]);
    assert.equal(MMR_REQUEST_POLICIES.low.openaiResponses.reasoning.effort, "medium");
    assert.equal(MMR_REQUEST_POLICIES.medium.openaiResponses.reasoning.effort, "medium");
    assert.equal(MMR_REQUEST_POLICIES.high.openaiResponses.reasoning.effort, "xhigh");
    assert.equal(MMR_REQUEST_POLICIES.ultra.openaiResponses.reasoning.effort, "xhigh");
    for (const policy of [MMR_REQUEST_POLICIES.low, MMR_REQUEST_POLICIES.high, MMR_REQUEST_POLICIES.ultra]) {
      assert.equal(policy.openaiResponses.maxOutputTokens, 128000);
      assert.equal(policy.contextWindow, undefined);
      assert.equal(policy.effectiveMaxInputTokens, undefined);
    }
    assert.equal(MMR_REQUEST_POLICIES.medium.openaiResponses.maxOutputTokens, 128000);
    assert.equal(MMR_REQUEST_POLICIES.medium.contextWindow, 300000);
    assert.equal(MMR_REQUEST_POLICIES.medium.effectiveMaxInputTokens, 172000);
  });

  it("applies each mode's OpenAI Responses effort without mutating messages or tools", async () => {
    const { applyMmrRequestPolicy, MMR_REQUEST_POLICIES } = await importSource("extensions/ampi-core/request-policy.ts");
    for (const [mode, effort] of [["low", "medium"], ["medium", "medium"], ["high", "xhigh"], ["ultra", "xhigh"]]) {
      const payload = openaiPayload({ max_output_tokens: 4096, reasoning: { effort: "low", encrypted: true } });
      const result = applyMmrRequestPolicy(payload, MMR_REQUEST_POLICIES[mode]);
      assert.notEqual(result, payload);
      assert.equal(result.max_output_tokens, 128000);
      assert.deepEqual(result.reasoning, { effort, encrypted: true, summary: "auto" });
      assert.deepEqual(result.input, payload.input);
      assert.deepEqual(payload.reasoning, { effort: "low", encrypted: true });
    }
  });

  it("leaves Anthropic fallback payloads to Pi's selected thinking level", async () => {
    const { applyMmrRequestPolicy, MMR_REQUEST_POLICIES } = await importSource("extensions/ampi-core/request-policy.ts");
    const payload = anthropicPayload({ thinking: { type: "adaptive" }, output_config: { effort: "high" } });
    for (const policy of Object.values(MMR_REQUEST_POLICIES)) {
      assert.equal(applyMmrRequestPolicy(payload, policy), payload);
    }
  });

  it("still supports Anthropic-shaped worker policies without touching system/messages/tools", async () => {
    const { applyMmrRequestPolicy } = await importSource("extensions/ampi-core/request-policy.ts");
    const payload = anthropicPayload({
      anthropic_beta: ["interleaved-thinking-2025-05-14"],
      output_config: { future: true },
    });
    const result = applyMmrRequestPolicy(payload, {
      anthropic: {
        maxTokens: 64000,
        thinking: { type: "adaptive", display: "summarized", outputConfigEffort: "xhigh" },
      },
    });

    assert.equal(result.max_tokens, 64000);
    assert.deepEqual(result.thinking, { type: "adaptive", display: "summarized" });
    assert.deepEqual(result.output_config, { future: true, effort: "xhigh" });
    assert.equal("anthropic_beta" in result, false);
    assert.deepEqual(result.system, payload.system);
    assert.deepEqual(result.messages, payload.messages);
    assert.deepEqual(result.tools, payload.tools);
    assert.equal(payload.max_tokens, 1024);
  });

  it("strips max_output_tokens for Codex variants while retaining mode reasoning", async () => {
    const { applyMmrRequestPolicy, MMR_REQUEST_POLICIES } = await importSource("extensions/ampi-core/request-policy.ts");
    for (const overrides of [
      { instructions: "sys", max_output_tokens: 4096, reasoning: { effort: "low" } },
      { text: { verbosity: "low" }, max_output_tokens: 4096, reasoning: { effort: "low" } },
    ]) {
      const result = applyMmrRequestPolicy(openaiPayload(overrides), MMR_REQUEST_POLICIES.ultra);
      assert.equal("max_output_tokens" in result, false);
      assert.deepEqual(result.reasoning, { effort: "xhigh", summary: "auto" });
    }

    const providerResult = applyMmrRequestPolicy(
      openaiPayload({ max_output_tokens: 4096, reasoning: { effort: "low" } }),
      MMR_REQUEST_POLICIES.medium,
      { providerId: "openai-codex" },
    );
    assert.equal("max_output_tokens" in providerResult, false);
    assert.deepEqual(providerResult.reasoning, { effort: "medium", summary: "auto" });
  });

  it("leaves free, unknown, and lookalike payload shapes untouched", async () => {
    const { applyMmrRequestPolicy, MMR_REQUEST_POLICIES } = await importSource("extensions/ampi-core/request-policy.ts");
    const unknown = { model: "future-provider-model", data: { prompt: "hi" } };
    const chatLike = { model: "gpt-4.1", messages: [{ role: "user", content: "hi" }], max_tokens: 4096 };
    const customInput = { model: "future-provider-model", input: [{ role: "user", content: "hi" }] };

    assert.equal(applyMmrRequestPolicy(unknown, undefined), unknown);
    assert.equal(applyMmrRequestPolicy(unknown, MMR_REQUEST_POLICIES.medium), unknown);
    assert.equal(applyMmrRequestPolicy(chatLike, MMR_REQUEST_POLICIES.medium), chatLike);
    assert.equal(applyMmrRequestPolicy(customInput, MMR_REQUEST_POLICIES.high), customInput);
  });

  it("does not write runtime-only context metadata into provider payloads", async () => {
    const { applyMmrRequestPolicy, MMR_REQUEST_POLICIES } = await importSource("extensions/ampi-core/request-policy.ts");
    const result = applyMmrRequestPolicy(
      openaiPayload({ max_output_tokens: 4096, reasoning: { effort: "low" } }),
      MMR_REQUEST_POLICIES.medium,
    );
    assert.equal("effectiveMaxInputTokens" in result, false);
    assert.equal("contextWindow" in result, false);
  });

  it("preserves Medium's inherited 300k context safety profile", async () => {
    const { clampPolicyToRegisteredModel, MMR_REQUEST_POLICIES } = await importSource("extensions/ampi-core/request-policy.ts");
    const medium = clampPolicyToRegisteredModel(MMR_REQUEST_POLICIES.medium, { contextWindow: 372000, maxTokens: 128000 });
    assert.equal(medium.contextWindow, 300000);
    assert.equal(medium.effectiveMaxInputTokens, 172000);

    for (const mode of ["low", "high", "ultra"]) {
      const clamped = clampPolicyToRegisteredModel(MMR_REQUEST_POLICIES[mode], { contextWindow: 372000, maxTokens: 128000 });
      assert.equal(clamped.contextWindow, undefined, `${mode} stays native after clamping`);
      assert.equal(clamped.effectiveMaxInputTokens, undefined, `${mode} carries no input cap`);
    }
  });

  it("formats request-policy token counts byte-for-byte across boundary values", async () => {
    const { formatMmrPolicyContext, MMR_REQUEST_POLICIES } = await importSource("extensions/ampi-core/request-policy.ts");
    const cases = [
      [999, "999"], [1000, "1k"], [1500, "1.5k"], [12345, "12.3k"],
      [999999, "1000.0k"], [1000000, "1M"], [1500000, "1.5M"],
      [9999999, "10.0M"], [10000000, "10M"],
    ];
    for (const [input, expected] of cases) {
      const rendered = formatMmrPolicyContext(MMR_REQUEST_POLICIES.medium, { contextWindow: input });
      assert.ok(rendered.startsWith(`${expected} total`), `formatTokenCount(${input})`);
    }
  });
});

describe("mmr-core thinking-level toggle", () => {
  it("pins toggle defaults to each mode's configured default", async () => {
    const { getDefaultToggleThinkingLevel, getMmrModeThinkingOptions, isToggleableMmrMode } =
      await importSource("extensions/ampi-core/request-policy.ts");

    assert.equal(isToggleableMmrMode("low"), false);
    assert.equal(isToggleableMmrMode("free"), false);
    assert.deepEqual(getMmrModeThinkingOptions("medium"), [{ level: "medium" }, { level: "high" }]);
    assert.deepEqual(getMmrModeThinkingOptions("high"), [{ level: "xhigh" }, { level: "medium" }]);
    assert.deepEqual(getMmrModeThinkingOptions("ultra"), [{ level: "xhigh" }, { level: "high" }, { level: "medium" }]);
    assert.equal(getDefaultToggleThinkingLevel("medium"), "medium");
    assert.equal(getDefaultToggleThinkingLevel("high"), "xhigh");
    assert.equal(getDefaultToggleThinkingLevel("ultra"), "xhigh");
  });

  it("cycles each configured toggle in order and wraps", async () => {
    const { getOtherToggleThinkingLevel } = await importSource("extensions/ampi-core/request-policy.ts");
    assert.equal(getOtherToggleThinkingLevel("medium", "medium"), "high");
    assert.equal(getOtherToggleThinkingLevel("medium", "high"), "medium");
    assert.equal(getOtherToggleThinkingLevel("high", "xhigh"), "medium");
    assert.equal(getOtherToggleThinkingLevel("high", "medium"), "xhigh");
    assert.equal(getOtherToggleThinkingLevel("ultra", "xhigh"), "high");
    assert.equal(getOtherToggleThinkingLevel("ultra", "high"), "medium");
    assert.equal(getOtherToggleThinkingLevel("ultra", "medium"), "xhigh");
  });

  it("applies toggled OpenAI effort without mutating shared policy", async () => {
    const { applyMmrThinkingLevelToPolicy, MMR_REQUEST_POLICIES } =
      await importSource("extensions/ampi-core/request-policy.ts");
    const toggled = applyMmrThinkingLevelToPolicy("medium", MMR_REQUEST_POLICIES.medium, "high");
    assert.equal(toggled.openaiResponses.reasoning.effort, "high");
    assert.equal(MMR_REQUEST_POLICIES.medium.openaiResponses.reasoning.effort, "medium");
  });
});
