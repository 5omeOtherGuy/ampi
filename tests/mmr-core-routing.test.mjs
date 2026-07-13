import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

describe("mmr-core mode routing", () => {
  it("chooses explicit flag mode before session, settings, and default", async () => {
    const { resolveMmrModeSelection } = await importSource("extensions/ampi-core/routing.ts");

    assert.deepEqual(
      resolveMmrModeSelection({
        flagValue: "low",
        persistedMode: "high",
        settingsMode: "ultra",
      }),
      { mode: "low", source: "flag", warnings: [], rejectedSources: [] },
    );
  });

  it("chooses session mode before settings and default when no flag is provided", async () => {
    const { resolveMmrModeSelection } = await importSource("extensions/ampi-core/routing.ts");

    assert.deepEqual(
      resolveMmrModeSelection({
        persistedMode: "high",
        settingsMode: "ultra",
      }),
      { mode: "high", source: "session", warnings: [], rejectedSources: [] },
    );
  });

  it("chooses settings mode before default and reports invalid settings", async () => {
    const { resolveMmrModeSelection } = await importSource("extensions/ampi-core/routing.ts");

    assert.deepEqual(resolveMmrModeSelection({ settingsMode: "ultra" }), {
      mode: "ultra",
      source: "settings",
      warnings: [],
      rejectedSources: [],
    });

    assert.deepEqual(resolveMmrModeSelection({ settingsMode: "high" }), {
      mode: "high",
      source: "settings",
      warnings: [],
      rejectedSources: [],
    });

    assert.deepEqual(resolveMmrModeSelection({ settingsMode: "fast" }), {
      mode: "medium",
      source: "default",
      warnings: ['Ignoring invalid settings ampi mode "fast".'],
      rejectedSources: [{ source: "settings", value: "fast", reason: "invalid mode" }],
    });
  });

  it("captures all invalid sources as rejectedSources", async () => {
    const { resolveMmrModeSelection } = await importSource("extensions/ampi-core/routing.ts");

    const result = resolveMmrModeSelection({
      flagValue: "warp",
      persistedMode: "bogus",
      settingsMode: "fast",
    });

    assert.equal(result.mode, "medium");
    assert.equal(result.source, "default");
    assert.deepEqual(result.rejectedSources, [
      { source: "flag", value: "warp", reason: "invalid mode" },
      { source: "session", value: "bogus", reason: "invalid mode" },
      { source: "settings", value: "fast", reason: "invalid mode" },
    ]);
  });

  it("normalizes legacy names at flag, session, and settings boundaries", async () => {
    const { resolveMmrModeSelection } = await importSource("extensions/ampi-core/routing.ts");
    assert.equal(resolveMmrModeSelection({ flagValue: "rush" }).mode, "low");
    assert.equal(resolveMmrModeSelection({ persistedMode: "smart" }).mode, "medium");
    assert.equal(resolveMmrModeSelection({ settingsMode: "deep" }).mode, "high");
    assert.equal(resolveMmrModeSelection({ settingsMode: "fable" }).mode, "ultra");
  });

  it("accepts free from flags and persisted session state", async () => {
    const { resolveMmrModeSelection } = await importSource("extensions/ampi-core/routing.ts");

    assert.deepEqual(resolveMmrModeSelection({ flagValue: "free", persistedMode: "high" }), {
      mode: "free",
      source: "flag",
      warnings: [],
      rejectedSources: [],
    });

    assert.deepEqual(resolveMmrModeSelection({ persistedMode: "free", settingsMode: "medium" }), {
      mode: "free",
      source: "session",
      warnings: [],
      rejectedSources: [],
    });
  });
});
