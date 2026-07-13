import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

async function importContextCap() {
  return importSource("extensions/ampi-core/context-cap.ts");
}

async function importRuntime() {
  const runtimeUrl = pathToFileURL(path.join(getPreparedSourceRoot(), "extensions/ampi-core/runtime.ts")).href;
  return import(runtimeUrl);
}

beforeEach(async () => {
  const runtime = await importRuntime();
  runtime.setMmrModeState(undefined);
  runtime.setMmrSubagentState?.(undefined);
  runtime.setMmrManagedModelOverride?.(undefined);
});

describe("withMmrModeContextCap (pure)", () => {
  it("moves the legacy Smart 300k window to Medium", async () => {
    const { MMR_SMART_CONTEXT_WINDOW, getMmrModeContextWindowCap } = await importContextCap();
    assert.equal(MMR_SMART_CONTEXT_WINDOW, 300_000);
    assert.equal(getMmrModeContextWindowCap("medium"), 300_000);
  });

  it("caps Medium while leaving Low, High, Ultra, and Free on their registered windows", async () => {
    const { getMmrModeContextWindowCap } = await importContextCap();
    assert.equal(getMmrModeContextWindowCap("medium"), 300_000);
    for (const mode of ["low", "high", "ultra", "free", "nonsense"]) {
      assert.equal(getMmrModeContextWindowCap(mode), undefined, `${mode} has no ampi context cap`);
    }
  });

  it("caps Medium by cloning the model and passes the other tiers through unchanged", async () => {
    const { withMmrModeContextCap } = await importContextCap();
    const mediumModel = { provider: "openai-codex", id: "gpt-5.5", contextWindow: 372_000, maxTokens: 128_000 };
    const capped = withMmrModeContextCap("medium", mediumModel);
    assert.notEqual(capped, mediumModel);
    assert.equal(capped.contextWindow, 300_000);

    for (const mode of ["low", "high", "ultra"]) {
      const model = { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 372_000, maxTokens: 128_000 };
      assert.equal(withMmrModeContextCap(mode, model), model);
    }
  });

  it("does not cap Low, High, or Ultra", async () => {
    const { withMmrModeContextCap } = await importContextCap();
    for (const mode of ["ultra", "low", "high"]) {
      const model = { provider: "openai", id: "gpt-5.5", contextWindow: 1_000_000, maxTokens: 128_000 };
      const result = withMmrModeContextCap(mode, model);
      assert.equal(result, model, `expected the untouched model for mode=${mode}`);
      assert.equal(result.contextWindow, 1_000_000, `expected the native window for mode=${mode}`);
    }
  });

  it("no-ops (returns same reference) for free and unknown modes", async () => {
    const { withMmrModeContextCap } = await importContextCap();
    // free (and unknown modes) have no policy window, so they never cap.
    const model = { provider: "claude-subscription", id: "claude-opus-4-6", contextWindow: 1_000_000 };
    for (const mode of ["free", "nonsense"]) {
      assert.equal(withMmrModeContextCap(mode, model), model, `expected no-op for mode=${mode}`);
    }
  });

  it("no-ops when the window is already at or below the cap", async () => {
    const { withMmrModeContextCap } = await importContextCap();
    const atCap = { provider: "p", id: "m", contextWindow: 300_000 };
    assert.equal(withMmrModeContextCap("medium", atCap), atCap);
    const below = { provider: "p", id: "m", contextWindow: 200_000 };
    assert.equal(withMmrModeContextCap("medium", below), below);
    // A custom provider with a smaller window than an uncapped mode stays authoritative.
    const smallGpt = { provider: "openai", id: "m", contextWindow: 250_000 };
    assert.equal(withMmrModeContextCap("ultra", smallGpt), smallGpt);
  });

  it("no-ops when the window is missing or non-finite", async () => {
    const { withMmrModeContextCap } = await importContextCap();
    const noWindow = { provider: "p", id: "m" };
    assert.equal(withMmrModeContextCap("medium", noWindow), noWindow);
    const infinite = { provider: "p", id: "m", contextWindow: Number.POSITIVE_INFINITY };
    assert.equal(withMmrModeContextCap("medium", infinite), infinite);
    const nan = { provider: "p", id: "m", contextWindow: Number.NaN };
    assert.equal(withMmrModeContextCap("medium", nan), nan);
  });
});

function createTempCwd() {
  return mkdtempSync(path.join(tmpdir(), "ampi-context-cap-"));
}

function buildPi(setModelCalls, handlers, flagValue) {
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

function buildCtx(models, setModelCalls, notifications = []) {
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
    // Mirror Pi: ctx.model reflects the last applied model (the capped clone).
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

describe("mmr-core activation context cap", () => {
  it("ultra mode passes GPT-5.6 Sol through at its registered window", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const models = [
      { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 372_000, maxTokens: 128_000 },
    ];
    const handlers = new Map();
    const setModelCalls = [];
    const pi = buildPi(setModelCalls, handlers, "ultra");
    const ctx = buildCtx(models, setModelCalls);

    extension(pi);
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    assert.equal(setModelCalls.length, 1);
    assert.equal(setModelCalls[0], models[0]);
    assert.equal(setModelCalls[0].contextWindow, 372_000);
  });
});

describe("mmr-core defensive reassertion", () => {
  it("reasserts Medium's inherited 300k cap after provider registration drift", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const models = [
      { provider: "claude-subscription", id: "claude-opus-4-8", contextWindow: 1_000_000, maxTokens: 32_000 },
    ];
    const handlers = new Map();
    const setModelCalls = [];
    const pi = buildPi(setModelCalls, handlers, undefined);
    const ctx = buildCtx(models, setModelCalls);

    extension(pi);
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    assert.equal(setModelCalls.length, 1, "session_start applies the selected model once");
    assert.notEqual(setModelCalls.at(-1), models[0]);
    assert.equal(setModelCalls.at(-1).contextWindow, 300_000);

    // Simulate a provider (re)registration wiping the override: the active model
    // is now the uncapped 1M registry object again.
    setModelCalls.push(models[0]);
    assert.equal(ctx.model.contextWindow, 1_000_000);

    await handlers.get("input")({ type: "input", text: "hi", source: "interactive" }, ctx);
    assert.equal(setModelCalls.length, 3, "input hook reapplies the cap");
    assert.notEqual(setModelCalls.at(-1), models[0]);
    assert.equal(setModelCalls.at(-1).contextWindow, 300_000);
    assert.equal(setModelCalls.at(-1).provider, "claude-subscription");
    assert.equal(setModelCalls.at(-1).id, "claude-opus-4-8");
  });

  it("leaves High at Pi's native window through session_start and input", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    // High routes to an OpenAI model; give it a 1M native window to prove
    // uncapped tiers preserve Pi's registered window.
    const models = [
      { provider: "openai", id: "gpt-5.5", contextWindow: 1_000_000, maxTokens: 128_000 },
    ];
    const handlers = new Map();
    const setModelCalls = [];
    const pi = buildPi(setModelCalls, handlers, "high");
    const ctx = buildCtx(models, setModelCalls);

    extension(pi);
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    assert.equal(setModelCalls.at(-1).contextWindow, 1_000_000, "session_start keeps High at the native window");

    // Simulate a provider (re)registration; the native window must be preserved.
    setModelCalls.push(models[0]);
    assert.equal(ctx.model.contextWindow, 1_000_000);

    await handlers.get("input")({ type: "input", text: "hi", source: "interactive" }, ctx);
    assert.equal(setModelCalls.at(-1).contextWindow, 1_000_000, "input hook keeps the native window");
    assert.equal(setModelCalls.at(-1).id, "gpt-5.5");
  });

  it("does not reassert while a subagent worker is active", async () => {
    const runtime = await importRuntime();
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const models = [
      { provider: "claude-subscription", id: "claude-opus-4-8", contextWindow: 1_000_000, maxTokens: 32_000 },
    ];
    const handlers = new Map();
    const setModelCalls = [];
    const pi = buildPi(setModelCalls, handlers, undefined);
    const ctx = buildCtx(models, setModelCalls);

    extension(pi);
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    const baseline = setModelCalls.length;

    // Drift back to uncapped, then mark a subagent active.
    setModelCalls.push(models[0]);
    runtime.setMmrSubagentState({ profile: "finder", provider: "openai-codex", model: "gpt-5.5", activeTools: ["read"] });

    await handlers.get("input")({ type: "input", text: "hi", source: "interactive" }, ctx);
    // Only the manual drift push happened; the input hook must not re-cap.
    assert.equal(setModelCalls.length, baseline + 1);
    assert.equal(setModelCalls.at(-1), models[0]);
  });

  it("does not reassert when the active model drifted to a different provider/id (genuine native change)", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const models = [
      { provider: "openai", id: "gpt-5.5", contextWindow: 1_000_000, maxTokens: 32_000 },
      { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 372_000, maxTokens: 128_000 },
    ];
    const handlers = new Map();
    const setModelCalls = [];
    const pi = buildPi(setModelCalls, handlers, undefined);
    const ctx = buildCtx(models, setModelCalls);

    extension(pi);
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    const baseline = setModelCalls.length;

    // Drift to a DIFFERENT model than the locked-mode state (provider/id differ).
    setModelCalls.push(models[1]);
    await handlers.get("input")({ type: "input", text: "hi", source: "interactive" }, ctx);

    assert.equal(setModelCalls.length, baseline + 1, "must not fight a genuine native model change");
    assert.equal(setModelCalls.at(-1), models[1]);
  });

  it("does not reassert while an MMR-managed model override is in effect", async () => {
    const runtime = await importRuntime();
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const models = [
      { provider: "claude-subscription", id: "claude-opus-4-8", contextWindow: 1_000_000, maxTokens: 32_000 },
    ];
    const handlers = new Map();
    const setModelCalls = [];
    const pi = buildPi(setModelCalls, handlers, undefined);
    const ctx = buildCtx(models, setModelCalls);

    extension(pi);
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    const baseline = setModelCalls.length;

    // Drift back to uncapped, then install a managed override (another MMR path
    // owns the active model). Reassertion must defer to the override owner even
    // though provider/id still match the locked-mode state.
    setModelCalls.push(models[0]);
    runtime.setMmrManagedModelOverride({
      kind: "session-fallback",
      provider: "claude-subscription",
      model: "claude-opus-4-8",
      appliedAt: "2026-06-08T00:00:00.000Z",
    });

    await handlers.get("input")({ type: "input", text: "hi", source: "interactive" }, ctx);
    assert.equal(setModelCalls.length, baseline + 1, "must not re-cap under a managed override");
    assert.equal(setModelCalls.at(-1), models[0]);
  });
});
