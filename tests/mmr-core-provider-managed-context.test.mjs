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
  it("caps the smart Opus route to a 300k context window via a shallow clone", async () => {
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
    // smart caps the active model to 300k so Pi's native compaction/footer run
    // at 300k. The cap is a shallow clone: provider/id preserved, original
    // registry object left untouched.
    assert.notEqual(setModelCalls[0], models[0], "smart must pass a capped clone, not the registry object");
    assert.equal(setModelCalls[0].provider, "claude-subscription");
    assert.equal(setModelCalls[0].id, "claude-opus-4-8");
    assert.equal(setModelCalls[0].contextWindow, 300_000);
    assert.equal(models[0].contextWindow, 1_000_000, "registry model object must not be mutated");
  });

  it("falls back to GPT when the smart Opus route is absent", async () => {
    const runtime = await importRuntime();
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;

    const models = [
      { provider: "openai-codex", id: "gpt-5.5", contextWindow: 400_000, maxTokens: 128_000 },
    ];
    const handlers = new Map();
    const setModelCalls = [];
    const notifications = [];
    const pi = buildPi(setModelCalls, notifications, handlers, "smart");
    const ctx = buildCtx(models, notifications, setModelCalls);

    extension(pi);
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    assert.equal(setModelCalls.length, 1);
    // The smart cap is mode-keyed, so the GPT fallback's 400k window is also
    // capped down to 300k (a shallow clone), not the registry object.
    assert.notEqual(setModelCalls[0], models[0]);
    assert.equal(setModelCalls[0].provider, "openai-codex");
    assert.equal(setModelCalls[0].id, "gpt-5.5");
    assert.equal(setModelCalls[0].contextWindow, 300_000);
    assert.equal(models[0].contextWindow, 400_000, "registry model object must not be mutated");

    const state = runtime.getMmrModeState();
    assert.equal(state?.mode, "smart");
    assert.equal(state?.provider, "openai-codex");
    assert.equal(state?.model, "gpt-5.5");
    assert.equal(state?.thinkingLevel, "medium");
    // smart caps the active window to 300k regardless of route, so the display
    // profile is min(300k profile, 300k capped) = 300k.
    assert.equal(state?.effectiveContextWindow, 300_000, "smart caps the active window to 300k on any route");

    const activation = notifications.find((entry) => /MMR mode activated: Smart/.test(entry.message));
    assert.ok(activation, "activation notification must be emitted on flag source");
    assert.equal(activation.level, "warning");
    assert.match(activation.message, /model fallback applied/);
  });

  it("does not emit the context.registered-exceeds-profile diagnostic when the selected route matches the mode profile", async () => {
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
    // smart caps the active Opus window to 300k, so both the recorded window
    // and the display profile collapse to 300k and the mismatch diagnostic
    // stays quiet.
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
