import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

describe("mmr-core internal env helpers", () => {
  it("parseBoolEnv treats undefined and trimmed-empty as not set", async () => {
    const { parseBoolEnv } = await importSource("extensions/mmr-core/internal/env.ts");
    assert.equal(parseBoolEnv(undefined), undefined);
    assert.equal(parseBoolEnv(""), undefined);
    assert.equal(parseBoolEnv("   "), undefined);
  });

  it("parseBoolEnv recognizes the documented truthy strings (case-insensitive)", async () => {
    const { parseBoolEnv } = await importSource("extensions/mmr-core/internal/env.ts");
    for (const value of ["true", "TRUE", "1", "yes", "YES", "on", "On", "  true  "]) {
      assert.equal(parseBoolEnv(value), true, `expected ${JSON.stringify(value)} to parse true`);
    }
  });

  it("parseBoolEnv recognizes the documented falsy strings (case-insensitive)", async () => {
    const { parseBoolEnv } = await importSource("extensions/mmr-core/internal/env.ts");
    for (const value of ["false", "FALSE", "0", "no", "NO", "off", "Off", "  false  "]) {
      assert.equal(parseBoolEnv(value), false, `expected ${JSON.stringify(value)} to parse false`);
    }
  });

  it("parseBoolEnv returns undefined for unrecognized strings", async () => {
    const { parseBoolEnv } = await importSource("extensions/mmr-core/internal/env.ts");
    for (const value of ["maybe", "2", "truthy", "garbage", "y", "n"]) {
      assert.equal(parseBoolEnv(value), undefined, `expected ${JSON.stringify(value)} to parse undefined`);
    }
  });

  it("mmr-history loadMmrHistorySettings preserves default-false semantics via the shared helper", async () => {
    const { loadMmrHistorySettings } = await importSource("extensions/mmr-history/config.ts");
    // undefined / empty / unrecognized → false
    assert.equal(loadMmrHistorySettings({}).enabled, false);
    assert.equal(loadMmrHistorySettings({ MMR_HISTORY_ENABLE: "" }).enabled, false);
    assert.equal(loadMmrHistorySettings({ MMR_HISTORY_ENABLE: "garbage" }).enabled, false);
    // explicit falsy → false
    assert.equal(loadMmrHistorySettings({ MMR_HISTORY_ENABLE: "false" }).enabled, false);
    assert.equal(loadMmrHistorySettings({ MMR_HISTORY_ENABLE: "0" }).enabled, false);
    assert.equal(loadMmrHistorySettings({ MMR_HISTORY_ENABLE: "no" }).enabled, false);
    assert.equal(loadMmrHistorySettings({ MMR_HISTORY_ENABLE: "off" }).enabled, false);
    // truthy → true
    for (const value of ["true", "1", "yes", "on", "TRUE", "On"]) {
      assert.equal(
        loadMmrHistorySettings({ MMR_HISTORY_ENABLE: value }).enabled,
        true,
        `expected ${JSON.stringify(value)} to enable mmr-history`,
      );
    }
  });

  it("mmr-web loadMmrWebSettings continues to treat empty env as not set", async () => {
    const { loadMmrWebSettings } = await importSource("extensions/mmr-web/config.ts");
    // No project/home files; the empty MMR_WEB_ENABLE value must not flip the default-false to true.
    const result = loadMmrWebSettings("/tmp/__pi_mmr_refactor_nonexistent__", {
      homeDirectory: "/tmp/__pi_mmr_refactor_nonexistent_home__",
      env: { MMR_WEB_ENABLE: "" },
    });
    assert.equal(result.settings.enabled, false);
    // Unrecognized value also falls through to the default (no warning emitted by the parser).
    const garbage = loadMmrWebSettings("/tmp/__pi_mmr_refactor_nonexistent__", {
      homeDirectory: "/tmp/__pi_mmr_refactor_nonexistent_home__",
      env: { MMR_WEB_ENABLE: "garbage" },
    });
    assert.equal(garbage.settings.enabled, false);
  });
});
