import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

async function importRuntime() {
  const runtimeUrl = pathToFileURL(path.join(getPreparedSourceRoot(), "extensions/ampi-core/runtime.ts")).href;
  return import(runtimeUrl);
}

beforeEach(async () => {
  const runtime = await importRuntime();
  runtime.setMmrModeState(undefined);
});

function createTempCwd() {
  return mkdtempSync(path.join(tmpdir(), "ampi-provider-context-"));
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

function buildCtx(models, notifications, setModelCalls = []) {
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
    // Mirror Pi: the active model reflects the last pi.setModel(...) call (the
    // capped clone), so the defensive reassertion sees the capped window and
    // is a no-op rather than re-applying the cap.
    get model() {
      return setModelCalls.at(-1) ?? models[0];
    },
    getContextUsage: () => ({ tokens: 0, contextWindow: 300_000, percent: 0 }),
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
      setStatus: () => {},
      theme: { fg: (_name, value) => value },
    },
  };
}

describe("mmr-core provider-managed context selection", () => {
  it("caps the Medium fallback model to the inherited 300k safety window", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const models = [
      { provider: "claude-subscription", id: "claude-opus-4-8", contextWindow: 1_000_000, maxTokens: 128_000 },
    ];
    const handlers = new Map();
    const setModelCalls = [];
    const notifications = [];
    const pi = buildPi(setModelCalls, notifications, handlers, undefined);
    const ctx = buildCtx(models, notifications, setModelCalls);

    extension(pi);
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    assert.equal(handlers.has("turn_end"), false, "MMR must not use extension manual compaction after turns");
    assert.equal(handlers.has("agent_end"), false, "MMR must leave auto-compaction to Pi and the selected provider route");
    assert.equal(setModelCalls.length, 1);
    assert.notEqual(setModelCalls[0], models[0]);
    assert.equal(setModelCalls[0].provider, "claude-subscription");
    assert.equal(setModelCalls[0].id, "claude-opus-4-8");
    assert.equal(setModelCalls[0].contextWindow, 300_000);
    assert.equal(models[0].contextWindow, 1_000_000, "registered model remains unchanged");
  });

  it("uses GPT-5.5 as Medium's primary route with the inherited 300k safety window", async () => {
    const runtime = await importRuntime();
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;

    const models = [
      { provider: "openai-codex", id: "gpt-5.5", contextWindow: 400_000, maxTokens: 128_000 },
    ];
    const handlers = new Map();
    const setModelCalls = [];
    const notifications = [];
    const pi = buildPi(setModelCalls, notifications, handlers, "medium");
    const ctx = buildCtx(models, notifications, setModelCalls);

    extension(pi);
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    assert.equal(setModelCalls.length, 1);
    assert.notEqual(setModelCalls[0], models[0]);
    assert.equal(setModelCalls[0].provider, "openai-codex");
    assert.equal(setModelCalls[0].id, "gpt-5.5");
    assert.equal(setModelCalls[0].contextWindow, 300_000);
    assert.equal(models[0].contextWindow, 400_000, "registered model remains unchanged");

    const state = runtime.getMmrModeState();
    assert.equal(state?.mode, "medium");
    assert.equal(state?.provider, "openai-codex");
    assert.equal(state?.model, "gpt-5.5");
    assert.equal(state?.thinkingLevel, "medium");
    assert.equal(state?.effectiveContextWindow, 300_000);

    const activation = notifications.find((entry) => /MMR mode activated: Medium/.test(entry.message));
    assert.ok(activation, "activation notification must be emitted on flag source");
    assert.equal(activation.level, "warning", "deferred tools still produce a warning notification");
    assert.doesNotMatch(activation.message, /model fallback applied/);
  });

  it("does not emit a context profile diagnostic after Medium applies its 300k cap", async () => {
    const runtime = await importRuntime();
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const { getMmrPolicyDiagnostics } = await importSource("extensions/ampi-core/diagnostics.ts");

    const models = [
      { provider: "claude-subscription", id: "claude-opus-4-8", contextWindow: 1_000_000, maxTokens: 128_000 },
    ];
    const handlers = new Map();
    const setModelCalls = [];
    const notifications = [];
    const pi = buildPi(setModelCalls, notifications, handlers, undefined);
    const ctx = buildCtx(models, notifications, setModelCalls);

    extension(pi);
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    const state = runtime.getMmrModeState();
    assert.equal(state?.registeredContextWindow, 300_000);
    assert.equal(state?.effectiveContextWindow, 300_000);
    const diagnostics = getMmrPolicyDiagnostics(state);
    assert.equal(
      diagnostics.find((diag) => diag.code === "context.registered-exceeds-profile"),
      undefined,
      "diagnostic must not fire when the capped window matches the mode profile",
    );
  });
});
