import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

// Mirror the constant in src/extensions/ampi-core/runtime.ts. The key is part
// of the global singleton's ABI; bumping it would change this test too.
const MMR_CORE_RUNTIME_GLOBAL_KEY = "__pi_mmr_core_runtime_v2__";

describe("mmr-core runtime singleton shape guard", () => {
  it("rebuilds the global runtime when a previously stored instance is missing methods", async () => {
    const g = /** @type {Record<string, unknown>} */ (globalThis);
    const previous = g[MMR_CORE_RUNTIME_GLOBAL_KEY];

    // Simulate an older build of mmr-core that ran first in this process and
    // left a singleton predating getMmrSubagentState / setMmrSubagentState.
    // Calling those wrappers against this object would otherwise throw
    // "runtime.getMmrSubagentState is not a function" from every
    // before_provider_request hook.
    const stale = {
      getMmrModeState() {},
      setMmrModeState() {},
    };
    g[MMR_CORE_RUNTIME_GLOBAL_KEY] = stale;

    try {
      const mod = await importSource("extensions/ampi-core/runtime.ts");

      assert.notEqual(
        g[MMR_CORE_RUNTIME_GLOBAL_KEY],
        stale,
        "stale singleton must be replaced when the expected method set is missing",
      );
      assert.equal(typeof mod.getMmrSubagentState, "function");
      assert.equal(mod.getMmrSubagentState(), undefined);
      assert.doesNotThrow(() => mod.setMmrSubagentState(undefined));
      assert.equal(mod.getMmrModeState(), undefined);
      assert.equal(mod.getMmrSessionIdentity(), undefined);
    } finally {
      if (previous === undefined) delete g[MMR_CORE_RUNTIME_GLOBAL_KEY];
      else g[MMR_CORE_RUNTIME_GLOBAL_KEY] = previous;
    }
  });

  it("reuses the existing global runtime when its shape already matches", async () => {
    const g = /** @type {Record<string, unknown>} */ (globalThis);
    const previous = g[MMR_CORE_RUNTIME_GLOBAL_KEY];
    delete g[MMR_CORE_RUNTIME_GLOBAL_KEY];

    try {
      // First import publishes a compatible runtime.
      const first = await importSource("extensions/ampi-core/runtime.ts");
      const published = g[MMR_CORE_RUNTIME_GLOBAL_KEY];
      assert.ok(published, "first import must publish a runtime on globalThis");

      // Second import (fresh module cache, same globalThis) must keep the same
      // singleton object so sibling extensions share one runtime/registry.
      const second = await importSource("extensions/ampi-core/runtime.ts");
      assert.equal(
        g[MMR_CORE_RUNTIME_GLOBAL_KEY],
        published,
        "second import must reuse the existing compatible runtime",
      );

      // Both module copies' wrappers should observe the same live state.
      first.setMmrSubagentState({ name: "shape-guard-test", activeTools: [] });
      try {
        const observed = second.getMmrSubagentState();
        assert.ok(observed, "second module copy must read state through the shared runtime");
        assert.equal(observed.name, "shape-guard-test");
      } finally {
        first.setMmrSubagentState(undefined);
      }
    } finally {
      if (previous === undefined) delete g[MMR_CORE_RUNTIME_GLOBAL_KEY];
      else g[MMR_CORE_RUNTIME_GLOBAL_KEY] = previous;
    }
  });
});
