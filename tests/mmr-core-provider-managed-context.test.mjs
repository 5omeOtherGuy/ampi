import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

async function importRuntime() {
  const runtimeUrl = pathToFileURL(path.join(getPreparedSourceRoot(), "extensions/mmr-core/runtime.ts")).href;
  return import(runtimeUrl);
}

beforeEach(async () => {
  const runtime = await importRuntime();
  runtime.setMmrModeState(undefined);
});

function createTempCwd() {
  return mkdtempSync(path.join(tmpdir(), "pi-mmr-provider-context-"));
}

function buildPi(setModelCalls, notifications, handlers, flagValue) {
  return {
    registerFlag: () => {},
    getFlag: (name) => (name === "mmr-mode" ? flagValue : undefined),
    getActiveTools: () => ["read", "bash"],
    getAllTools: () => ["read", "bash", "edit", "write", "grep", "find", "ls"].map((name) => ({ name })),
    setActiveTools: () => {},
    setModel: async (model) => {
      setModelCalls.push(model);
      return true;
    },
    getThinkingLevel: () => "medium",
    setThinkingLevel: () => {},
    appendEntry: () => {},
    registerCommand: () => {},
    registerShortcut: () => {},
    on: (name, handler) => handlers.set(name, handler),
    events: { emit: () => {}, on: () => {}, off: () => {} },
  };
}

function buildCtx(models, notifications) {
  return {
    cwd: createTempCwd(),
    hasUI: false,
    sessionManager: { getEntries: () => [] },
    modelRegistry: {
      getAll: () => models,
      find: (provider, modelId) => models.find((model) => model.provider === provider && model.id === modelId),
      hasConfiguredAuth: () => true,
      isUsingOAuth: () => true,
    },
    model: models[0],
    getContextUsage: () => ({ tokens: 0, contextWindow: 300_000, percent: 0 }),
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
      setStatus: () => {},
      theme: { fg: (_name, value) => value },
    },
  };
}

describe("mmr-core provider-managed context selection", () => {
  it("selects the registered smart Opus route without cloning or shimmed context windows", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const models = [
      { provider: "claude-subscription", id: "claude-opus-4-8", contextWindow: 1_000_000, maxTokens: 128_000 },
    ];
    const handlers = new Map();
    const setModelCalls = [];
    const notifications = [];
    const pi = buildPi(setModelCalls, notifications, handlers, undefined);
    const ctx = buildCtx(models, notifications);

    extension(pi);
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    assert.equal(handlers.has("turn_end"), false, "MMR must not use extension manual compaction after turns");
    assert.equal(handlers.has("agent_end"), false, "MMR must leave auto-compaction to Pi and the selected provider route");
    assert.equal(setModelCalls.length, 1);
    assert.equal(setModelCalls[0], models[0], "smart must pass the provider-registered Opus model through unchanged");
    assert.equal(setModelCalls[0].contextWindow, 1_000_000);
  });

  it("falls back to GPT when the smart Opus route is absent", async () => {
    const runtime = await importRuntime();
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;

    const models = [
      { provider: "openai-codex", id: "gpt-5.5", contextWindow: 400_000, maxTokens: 128_000 },
    ];
    const handlers = new Map();
    const setModelCalls = [];
    const notifications = [];
    const pi = buildPi(setModelCalls, notifications, handlers, "smart");
    const ctx = buildCtx(models, notifications);

    extension(pi);
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    assert.equal(setModelCalls.length, 1);
    assert.equal(setModelCalls[0], models[0]);

    const state = runtime.getMmrModeState();
    assert.equal(state?.mode, "smart");
    assert.equal(state?.provider, "openai-codex");
    assert.equal(state?.model, "gpt-5.5");
    assert.equal(state?.thinkingLevel, "medium");
    assert.equal(state?.effectiveContextWindow, 400_000, "smart fallback clamps to the selected GPT route's registered context");

    const activation = notifications.find((entry) => /MMR mode activated: Smart/.test(entry.message));
    assert.ok(activation, "activation notification must be emitted on flag source");
    assert.equal(activation.level, "warning");
    assert.match(activation.message, /model fallback applied/);
  });

  it("does not emit the context.registered-exceeds-profile diagnostic when the selected route matches the mode profile", async () => {
    const runtime = await importRuntime();
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const { getMmrPolicyDiagnostics } = await importSource("extensions/mmr-core/diagnostics.ts");

    const models = [
      { provider: "claude-subscription", id: "claude-opus-4-8", contextWindow: 1_000_000, maxTokens: 128_000 },
    ];
    const handlers = new Map();
    const setModelCalls = [];
    const notifications = [];
    const pi = buildPi(setModelCalls, notifications, handlers, undefined);
    const ctx = buildCtx(models, notifications);

    extension(pi);
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    const state = runtime.getMmrModeState();
    assert.equal(state?.registeredContextWindow, 1_000_000);
    assert.equal(state?.effectiveContextWindow, 1_000_000);
    const diagnostics = getMmrPolicyDiagnostics(state);
    assert.equal(
      diagnostics.find((diag) => diag.code === "context.registered-exceeds-profile"),
      undefined,
      "diagnostic must not fire when registered window matches the mode profile",
    );
  });
});
