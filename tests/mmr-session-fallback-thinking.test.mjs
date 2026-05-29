import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

describe("mmr-session-fallback thinking levels", () => {
  it("offers only off for non-reasoning models", async () => {
    const { getMmrSessionFallbackThinkingLevels } = await importSource("extensions/mmr-session-fallback/thinking.ts");

    assert.deepEqual(getMmrSessionFallbackThinkingLevels({ reasoning: false }), ["off"]);
  });

  it("offers xhigh only when explicitly mapped by the selected model", async () => {
    const { getMmrSessionFallbackThinkingLevels } = await importSource("extensions/mmr-session-fallback/thinking.ts");

    assert.equal(getMmrSessionFallbackThinkingLevels({ reasoning: true }).includes("xhigh"), false);
    assert.equal(getMmrSessionFallbackThinkingLevels({ reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } }).includes("xhigh"), true);
    assert.equal(getMmrSessionFallbackThinkingLevels({ reasoning: true, thinkingLevelMap: { xhigh: null } }).includes("xhigh"), false);
  });
});
