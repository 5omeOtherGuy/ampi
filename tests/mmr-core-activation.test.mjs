import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

function createContext(models = [], options = {}) {
  return createMockExtensionContext({ models, authenticated: Boolean(options.authenticated) });
}

function createPi(options = {}) {
  return createMockPi({
    activeTools: options.activeTools ?? ["read", "bash"],
    allTools: options.allTools ?? ["read", "bash"],
    setModelResult: options.setModelResult ?? false,
  });
}

async function importRuntime() {
  const runtimeUrl = pathToFileURL(path.join(getPreparedSourceRoot(), "extensions/ampi-core/runtime.ts")).href;
  return import(runtimeUrl);
}

describe("mmr-core mode activation", () => {
  it("fails clear and keeps previous mode state/tools when no high model route is usable", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const runtime = await importRuntime();
    const previousState = {
      mode: "medium",
      displayName: "Medium",
      source: "command",
      targetModel: "claude-opus-4-8",
      requestedModels: ["claude-opus-4-8"],
      provider: "claude-subscription",
      model: "claude-opus-4-8",
      modelFound: true,
      modelApplied: true,
      modelFallbackApplied: false,
      modelCandidates: [],
      thinkingLevel: "high",
      promptRoute: "default",
      requestedTools: ["Read"],
      activeTools: ["read"],
      missingTools: [],
      deferredTools: [],
      featureGates: [],
      availabilityNotes: [],
      appliedAt: "2026-05-08T00:00:00.000Z",
    };
    runtime.setMmrModeState(previousState);

    const { pi, calls, commands } = createPi();
    const { ctx, notifications } = createContext();
    extension(pi);

    await commands.get("mode").handler("high", ctx);

    assert.equal(runtime.getMmrModeState(), previousState);
    assert.deepEqual(calls.setActiveTools, []);
    assert.deepEqual(calls.setThinkingLevel, []);
    assert.deepEqual(calls.appendEntry, []);
    assert.equal(notifications.at(-1)?.level, "error");
    assert.match(notifications.at(-1)?.message, /Could not activate High mode/);
    assert.match(notifications.at(-1)?.message, /gpt-5\.5/);
    assert.match(notifications.at(-1)?.message, /claude-opus-4-8/);
    assert.doesNotMatch(notifications.at(-1)?.message, /gpt-5\.4/);
  });

  it("fails closed and keeps previous state/tools/model when no active tools resolve", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const runtime = await importRuntime();
    const previousState = {
      mode: "medium",
      displayName: "Medium",
      source: "command",
      targetModel: "claude-opus-4-8",
      requestedModels: ["claude-opus-4-8"],
      provider: "claude-subscription",
      model: "claude-opus-4-8",
      modelFound: true,
      modelApplied: true,
      modelFallbackApplied: false,
      modelCandidates: [],
      thinkingLevel: "high",
      promptRoute: "default",
      requestedTools: ["Read"],
      activeTools: ["read"],
      missingTools: [],
      deferredTools: [],
      featureGates: [],
      availabilityNotes: [],
      appliedAt: "2026-05-08T00:00:00.000Z",
    };
    runtime.setMmrModeState(previousState);

    const { pi, calls, commands } = createPi({
      allTools: [{ name: "unrelated" }],
      setModelResult: true,
    });
    const { ctx, notifications } = createContext([{ provider: "openai-codex", id: "gpt-5.5" }], { authenticated: true });
    extension(pi);

    await commands.get("mode").handler("high", ctx);

    assert.equal(runtime.getMmrModeState(), previousState);
    assert.deepEqual(calls.setModel, []);
    assert.deepEqual(calls.setActiveTools, []);
    assert.deepEqual(calls.setThinkingLevel, []);
    assert.deepEqual(calls.appendEntry, []);
    assert.equal(notifications.at(-1)?.level, "error");
    assert.match(notifications.at(-1)?.message, /Could not activate High mode/);
    assert.match(notifications.at(-1)?.message, /no active tools/i);
    assert.match(notifications.at(-1)?.message, /Current MMR mode unchanged: Medium \(medium\)/);
  });

  it("includes write but not edit when High activates with its Pi-native tools", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrModeState(undefined);

    const { pi, calls, commands } = createPi({
      allTools: [
        { name: "read" },
        { name: "bash" },
        { name: "edit" },
        { name: "write" },
        { name: "grep" },
        { name: "find" },
        { name: "ls" },
      ],
      setModelResult: true,
    });
    const { ctx } = createContext([{ provider: "openai-codex", id: "gpt-5.5" }], { authenticated: true });
    extension(pi);

    await commands.get("mode").handler("high", ctx);

    assert.equal(calls.setActiveTools.length, 1);
    assert.equal(calls.setActiveTools[0].includes("edit"), false);
    assert.equal(calls.setActiveTools[0].includes("write"), true);
  });

  it("applies the per-mode thinking level for each locked mode", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrModeState(undefined);

    const models = [
      { provider: "claude-subscription", id: "claude-opus-4-8" },
      { provider: "claude-subscription", id: "claude-haiku-4-5" },
      { provider: "openai-codex", id: "gpt-5.4" },
      { provider: "openai-codex", id: "gpt-5.5" },
    ];
    const { pi, calls, commands } = createPi({
      allTools: [
        { name: "read" },
        { name: "bash" },
        { name: "edit" },
        { name: "write" },
        { name: "grep" },
        { name: "find" },
        { name: "ls" },
      ],
      setModelResult: true,
    });
    const { ctx } = createContext(models, { authenticated: true });
    extension(pi);

    await commands.get("mode").handler("medium", ctx);
    await commands.get("mode").handler("low", ctx);
    await commands.get("mode").handler("high", ctx);

    assert.deepEqual(calls.setThinkingLevel, ["medium", "medium", "xhigh"]);
  });

  it("falls low back to GPT-5.5 at medium effort when Terra is unavailable", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrModeState(undefined);

    const { pi, calls, commands } = createPi({
      allTools: [
        { name: "read" },
        { name: "bash" },
        { name: "edit" },
        { name: "write" },
        { name: "grep" },
        { name: "find" },
      ],
      setModelResult: true,
    });
    const { ctx } = createContext([
      { provider: "openai-codex", id: "gpt-5.5" },
    ], { authenticated: true });
    extension(pi);

    await commands.get("mode").handler("low", ctx);

    assert.equal(calls.setModel.at(-1)?.provider, "openai-codex");
    assert.equal(calls.setModel.at(-1)?.id, "gpt-5.5");
    assert.equal(calls.setThinkingLevel.at(-1), "medium");
    assert.equal(runtime.getMmrModeState()?.modelFallbackApplied, true);
    assert.match(runtime.getMmrModeState()?.modelFallbackReason ?? "", /gpt-5\.6-terra/);
  });

  it("surfaces deferred tool diagnostics in the activation notification warnings list", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrModeState(undefined);

    const { pi, commands } = createPi({
      allTools: [
        { name: "read" },
        { name: "bash" },
        { name: "edit" },
        { name: "write" },
        { name: "grep" },
        { name: "find" },
        { name: "ls" },
      ],
      setModelResult: true,
    });
    const { ctx, notifications } = createContext([{ provider: "openai-codex", id: "gpt-5.5" }], { authenticated: true });
    extension(pi);

    await commands.get("mode").handler("high", ctx);

    const activation = notifications.at(-1);
    assert.equal(activation.level, "warning");
    // Built-in deferred rules name the owning extension in the diagnostic.
    assert.match(activation.message, /oracle: deferred until ampi-workers ships/);
    assert.match(activation.message, /finder: deferred until ampi-workers ships/);
    assert.match(activation.message, /web_search: deferred until ampi-web ships/);
    assert.match(activation.message, /chart: deferred until ampi-tasks ships/);
    assert.match(activation.message, /reviewer: deferred until ampi-workers ships/);
  });
});
