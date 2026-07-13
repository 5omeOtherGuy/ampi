import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const MEDIUM_MODEL = { provider: "openai-codex", id: "gpt-5.5" };
const LOW_MODEL = { provider: "openai-codex", id: "gpt-5.6-terra" };
const ULTRA_MODEL = { provider: "openai-codex", id: "gpt-5.6-sol" };
const MODELS = [LOW_MODEL, MEDIUM_MODEL, ULTRA_MODEL];

function createState(mode) {
  const displayName = mode[0].toUpperCase() + mode.slice(1);
  return {
    mode,
    displayName,
    source: "command",
    targetModel: "",
    requestedModels: [],
    provider: "",
    model: "",
    modelFound: true,
    modelApplied: true,
    modelFallbackApplied: false,
    modelCandidates: [],
    thinkingLevel: "medium",
    promptRoute: "default",
    requestedTools: [],
    activeTools: ["read", "bash"],
    missingTools: [],
    deferredTools: [],
    featureGates: [],
    availabilityNotes: [],
    appliedAt: "2026-05-08T00:00:00.000Z",
  };
}

function createContext() {
  return createMockExtensionContext({ models: MODELS });
}

function createPi() {
  return createMockPi({
    activeTools: ["read", "bash", "grep"],
    allTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  });
}

async function importRuntime() {
  const runtimeUrl = pathToFileURL(path.join(getPreparedSourceRoot(), "extensions/ampi-core/runtime.ts")).href;
  return import(runtimeUrl);
}

beforeEach(async () => {
  const runtime = await importRuntime();
  runtime.setMmrModeState(undefined);
});

describe("mmr-core mode shortcuts", () => {
  it("registers picker and cycle shortcuts", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const { pi, shortcuts } = createPi();

    extension(pi);

    assert.equal(shortcuts.get("ctrl+shift+s")?.description, "Select ampi mode");
    assert.equal(shortcuts.get("alt+m")?.description, "Select ampi mode");
    assert.equal(shortcuts.get("ctrl+space")?.description, "Cycle ampi mode");
    assert.match(shortcuts.get("alt+r")?.description ?? "", /Toggle ampi thinking level/);
  });

  it("toggles the thinking level in place via alt+r without releasing the mode", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrModeState(createState("medium"));
    const { ctx, notifications } = createContext();
    const { pi, calls, shortcuts } = createPi();
    extension(pi);

    // Medium toggles from its default medium effort to high.
    await shortcuts.get("alt+r").handler(ctx);

    assert.equal(runtime.getMmrModeState()?.mode, "medium");
    assert.equal(runtime.getMmrModeState()?.thinkingLevel, "high");
    assert.equal(runtime.getMmrModeState()?.effectiveMaxOutputTokens, 128000);
    assert.deepEqual(calls.setThinkingLevel, ["high"]);
    assert.equal(calls.appendEntry.at(-1)?.[1].mode, "medium");
    assert.match(notifications.at(-1)?.message ?? "", /MMR thinking: medium → high, max out 128k/);
    assert.equal(notifications.some((n) => /mode activated/i.test(n.message)), false);

    // Pressing again toggles back to medium with the same budget.
    await shortcuts.get("alt+r").handler(ctx);
    assert.equal(runtime.getMmrModeState()?.mode, "medium");
    assert.equal(runtime.getMmrModeState()?.thinkingLevel, "medium");
    assert.equal(runtime.getMmrModeState()?.effectiveMaxOutputTokens, 128000);
  });

  it("cycles ultra's thinking level through xhigh, high, and medium via alt+r", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrModeState(createState("ultra"));
    const { ctx, notifications } = createContext();
    const { pi, calls, shortcuts } = createPi();
    extension(pi);

    // The synthetic state starts at medium, so the cycle wraps to xhigh.
    await shortcuts.get("alt+r").handler(ctx);
    assert.equal(runtime.getMmrModeState()?.mode, "ultra");
    assert.equal(runtime.getMmrModeState()?.thinkingLevel, "xhigh");
    assert.deepEqual(calls.setThinkingLevel, ["xhigh"]);
    assert.match(notifications.at(-1)?.message ?? "", /MMR thinking: ultra → xhigh, max out 128k/);

    await shortcuts.get("alt+r").handler(ctx);
    assert.equal(runtime.getMmrModeState()?.thinkingLevel, "high");
    assert.deepEqual(calls.setThinkingLevel, ["xhigh", "high"]);
    assert.match(notifications.at(-1)?.message ?? "", /MMR thinking: ultra → high, max out 128k/);

    await shortcuts.get("alt+r").handler(ctx);
    assert.equal(runtime.getMmrModeState()?.thinkingLevel, "medium");
    assert.deepEqual(calls.setThinkingLevel, ["xhigh", "high", "medium"]);
    assert.match(notifications.at(-1)?.message ?? "", /MMR thinking: ultra → medium, max out 128k/);
  });

  it("alt+r is a no-op notice in non-toggleable modes", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrModeState(createState("low"));
    const { ctx, notifications } = createContext();
    const { pi, calls, shortcuts } = createPi();
    extension(pi);

    await shortcuts.get("alt+r").handler(ctx);

    assert.equal(runtime.getMmrModeState()?.mode, "low");
    assert.deepEqual(calls.setThinkingLevel, []);
    assert.match(notifications.at(-1)?.message ?? "", /only available in medium, high, or ultra/);
  });

  it("opens a picker with every canonical tier and free", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrModeState(createState("medium"));
    const { ctx, selectCalls } = createContext();
    ctx.ui.select = async (title, options) => {
      selectCalls.push({ title, options });
      return "high";
    };
    const { pi, calls, shortcuts } = createPi();
    extension(pi);

    await shortcuts.get("alt+m").handler(ctx);

    assert.deepEqual(selectCalls[0].options, ["low", "medium", "high", "ultra", "free"]);
    assert.match(selectCalls[0].title, /current: medium/);
    assert.equal(runtime.getMmrModeState()?.mode, "high");
    assert.equal(calls.setModel.length, 1);
    assert.equal(calls.setModel[0].id, MEDIUM_MODEL.id);
    assert.equal(calls.appendEntry.at(-1)?.[1].mode, "high");
  });

  it("cycles managed modes forward in tier order, skipping free", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrModeState(createState("medium"));
    const { ctx } = createContext();
    const { pi, calls, shortcuts } = createPi();
    extension(pi);

    // medium -> high; free is not in the rotation.
    await shortcuts.get("ctrl+space").handler(ctx);

    assert.equal(runtime.getMmrModeState()?.mode, "high");
    assert.equal(calls.appendEntry.at(-1)?.[1].mode, "high");
  });

  it("applies ultra via /mode with GPT-5.6 Sol", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrModeState(createState("medium"));
    const { ctx } = createContext();
    const { pi, calls, commands } = createPi();
    extension(pi);

    await commands.get("mode").handler("ultra", ctx);

    assert.equal(runtime.getMmrModeState()?.mode, "ultra");
    assert.equal(calls.setModel.at(-1)?.id, ULTRA_MODEL.id);
    assert.equal(calls.appendEntry.at(-1)?.[1].mode, "ultra");
  });

  it("cycles from free to low instead of including free in rotation", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrModeState(createState("free"));
    const { ctx } = createContext();
    const { pi, calls, shortcuts } = createPi();
    extension(pi);

    await shortcuts.get("ctrl+space").handler(ctx);

    assert.equal(runtime.getMmrModeState()?.mode, "low");
    assert.equal(calls.setModel.length, 1);
    assert.equal(calls.setModel[0].id, LOW_MODEL.id);
    assert.equal(calls.appendEntry.at(-1)?.[1].mode, "low");
  });
});
