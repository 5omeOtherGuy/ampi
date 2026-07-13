import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

describe("mmr-core shared runtime API", () => {
  it("exports MMR helper functions without exposing the live singleton object", async () => {
    const root = await importSource("index.ts");

    assert.equal(typeof root.getMmrModeState, "function");
    assert.equal(typeof root.resolveMmrModel, "function");
    assert.equal(typeof root.resolveMmrTools, "function");
    assert.equal(typeof root.isToolAllowed, "function");
    assert.equal(typeof root.registerMmrToolProvider, "function");
    // The alias helper was removed; tools must be referenced by their
    // exact Pi tool name. /mmr-status credits ownership via the
    // canonical exact-name catalog plus provider claims.
    assert.equal(root.registerMmrToolAlias, undefined);
    assert.equal("mmrCoreRuntime" in root, false);
  });

  it("freezes the live mode-state object so accidental mutation throws in strict mode", async () => {
    const { createMmrCoreRuntime } = await importSource("extensions/ampi-core/runtime.ts");
    const { createMmrModeState } = await importSource("extensions/ampi-core/state.ts");
    const { getMmrMode } = await importSource("extensions/ampi-core/modes.ts");

    const runtime = createMmrCoreRuntime();
    const built = createMmrModeState({
      mode: getMmrMode("medium"),
      source: "command",
      modelResolution: {
        targetModel: "gpt-5.5",
        requestedModels: ["gpt-5.5"],
        selectedProvider: "openai",
        selectedModel: "gpt-5.5",
        modelFound: true,
        modelApplied: true,
        fallbackApplied: false,
        candidates: [],
      },
      tools: { requestedTools: ["read"], activeTools: ["read"], missingTools: [], decisions: [] },
      appliedAt: "2026-05-08T00:00:00.000Z",
    });

    runtime.setMmrModeState(built);
    const live = runtime.getMmrModeState();
    assert.ok(live, "expected a live state to be returned");
    assert.equal(Object.isFrozen(live), true, "top-level state must be frozen");
    assert.equal(Object.isFrozen(live.activeTools), true, "nested arrays must also be frozen");
    assert.equal(Object.isFrozen(live.resolution), true, "nested objects must also be frozen");

    assert.throws(() => { live.activeTools.push("bash"); }, /read only|object is not extensible|Cannot add property/i);
    assert.throws(() => { live.mode = "high"; }, /read only|Cannot assign/i);

    // Snapshot returns an unfrozen deep clone, safe for callers to mutate.
    const snapshot = runtime.getMmrModeStateSnapshot();
    assert.ok(snapshot);
    assert.equal(Object.isFrozen(snapshot), false);
    snapshot.activeTools.push("bash");
    assert.deepEqual(runtime.getMmrModeState()?.activeTools, ["read"], "snapshot mutation must not affect the live state");
  });

  it("resolves per-mode model and tools through isolated runtime instances", async () => {
    const { createMmrCoreRuntime } = await importSource("extensions/ampi-core/runtime.ts");
    const runtime = createMmrCoreRuntime();

    assert.deepEqual(runtime.resolveMmrModel("low"), {
      targetModel: "gpt-5.6-terra",
      requestedModels: ["gpt-5.6-terra", "gpt-5.5"],
      modelFound: false,
      modelApplied: false,
      fallbackApplied: false,
      candidates: [],
    });

    runtime.registerToolProvider({
      name: "mmr-subagents-test",
      resolve: (toolName) => (toolName === "oracle" ? { kind: "active" } : undefined),
    });
    const resolved = runtime.resolveMmrTools("high", ["read", "bash", "edit", "write", "oracle"]);

    assert.equal(resolved.activeTools.includes("oracle"), true);
  });
});
