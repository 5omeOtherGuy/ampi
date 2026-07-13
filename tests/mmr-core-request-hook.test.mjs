import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const MEDIUM_MODEL = { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 400_000, maxTokens: 128_000 };
const LOW_MODEL = { provider: "openai-codex", id: "gpt-5.6-terra", contextWindow: 372_000, maxTokens: 128_000 };
const HIGH_MODEL = MEDIUM_MODEL;

function createContext(models = [MEDIUM_MODEL]) {
  return createMockExtensionContext({ models, hasUI: false, model: models[0] });
}

function createPi(options = {}) {
  return createMockPi({
    activeTools: ["read", "bash", "grep"],
    allTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    thinkingLevel: "medium",
    initialModel: options.model,
  });
}

async function importRuntime() {
  const runtimeUrl = pathToFileURL(path.join(getPreparedSourceRoot(), "extensions/ampi-core/runtime.ts")).href;
  return import(runtimeUrl);
}

beforeEach(async () => {
  const runtime = await importRuntime();
  runtime.setMmrModeState(undefined);
  runtime.clearMmrManagedModelOverride();
});

describe("mmr-core before_provider_request hook", () => {
  it("applies Medium's request policy to OpenAI Responses payloads", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const { ctx } = createContext([MEDIUM_MODEL]);
    const { pi, handlers } = createPi({ model: MEDIUM_MODEL });
    extension(pi);

    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    const payload = {
      model: "gpt-5.6-sol",
      input: [],
      instructions: "system",
      max_output_tokens: 4096,
      reasoning: { effort: "low" },
    };
    const result = await handlers.get("before_provider_request")({ type: "before_provider_request", payload }, ctx);

    assert.equal("max_output_tokens" in result, false);
    assert.deepEqual(result.reasoning, { effort: "medium", summary: "auto" });
    assert.equal(result.instructions, payload.instructions);
    assert.deepEqual(payload.reasoning, { effort: "low" }, "original payload is not mutated");
  });

  it("emits high effort after Medium's alt+r toggle", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const { ctx } = createContext([MEDIUM_MODEL]);
    const { pi, handlers, shortcuts } = createPi({ model: MEDIUM_MODEL });
    extension(pi);

    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    await shortcuts.get("alt+r").handler(ctx);

    const payload = { model: "gpt-5.6-sol", input: [], instructions: "system", reasoning: { effort: "low" } };
    const result = await handlers.get("before_provider_request")({ type: "before_provider_request", payload }, ctx);

    assert.deepEqual(result.reasoning, { effort: "high", summary: "auto" });
    assert.equal(result.instructions, payload.instructions);
  });

  it("managed model overrides disable locked-mode request-policy rewriting", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const runtime = await importRuntime();
    const { ctx } = createContext([MEDIUM_MODEL]);
    const { pi, handlers } = createPi({ model: MEDIUM_MODEL });
    extension(pi);

    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    runtime.setMmrManagedModelOverride({
      kind: "session-fallback",
      provider: "anthropic",
      model: "claude-opus-4-6",
      thinkingLevel: "low",
      appliedAt: "2026-05-26T00:00:00.000Z",
    });

    const payload = {
      model: "claude-opus-4-6",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      system: [{ type: "text", text: "minimalcc shaped system" }],
      max_tokens: 4096,
    };
    const result = await handlers.get("before_provider_request")({ type: "before_provider_request", payload }, ctx);

    assert.equal(result, undefined);
    assert.deepEqual(payload, {
      model: "claude-opus-4-6",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      system: [{ type: "text", text: "minimalcc shaped system" }],
      max_tokens: 4096,
    });
  });

  it("switching to free disables request-policy rewriting", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const { ctx } = createContext([MEDIUM_MODEL]);
    const { pi, commands, handlers } = createPi({ model: MEDIUM_MODEL });
    extension(pi);

    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    await commands.get("mode").handler("free", ctx);

    const payload = { model: "claude-opus-4-8", messages: [], max_tokens: 4096 };
    const result = await handlers.get("before_provider_request")({ type: "before_provider_request", payload }, ctx);

    assert.equal(result, undefined);
    assert.deepEqual(payload, { model: "claude-opus-4-8", messages: [], max_tokens: 4096 });
  });

  it("low applies medium reasoning to GPT-5.6 Terra", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const { ctx } = createContext([LOW_MODEL]);
    const { pi, commands, handlers } = createPi({ model: LOW_MODEL });
    extension(pi);

    await commands.get("mode").handler("low", ctx);

    const payload = { model: "gpt-5.6-terra", input: [], stream: true, instructions: "system", text: { verbosity: "low" }, max_output_tokens: 4096, reasoning: { effort: "low" } };
    const result = await handlers.get("before_provider_request")({ type: "before_provider_request", payload }, ctx);

    assert.equal("max_output_tokens" in result, false, "Codex-backed Responses payloads must not carry max_output_tokens");
    assert.deepEqual(result.reasoning, { effort: "medium", summary: "auto" });
  });

  it("high strips max output while applying xhigh reasoning to openai-codex", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const { ctx } = createContext([HIGH_MODEL]);
    const { pi, commands, handlers } = createPi({ model: HIGH_MODEL });
    extension(pi);

    await commands.get("mode").handler("high", ctx);

    const payload = { model: "gpt-5.6-sol", input: [], stream: true, max_output_tokens: 4096 };
    const result = await handlers.get("before_provider_request")({ type: "before_provider_request", payload }, ctx);

    assert.equal("max_output_tokens" in result, false, "openai-codex rejects max_output_tokens even when Pi omits Codex-only payload markers");
    assert.deepEqual(result.reasoning, { effort: "xhigh", summary: "auto" });
  });
});
