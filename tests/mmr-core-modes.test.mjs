import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

describe("mmr-core mode table", () => {
  it("defines the low-to-ultra model and prompt split", async () => {
    const { getMmrMode } = await importSource("extensions/ampi-core/modes.ts");

    assert.deepEqual(getMmrMode("low").modelPreferences, [
      { model: "gpt-5.6-terra" },
      { model: "gpt-5.5" },
    ]);
    assert.equal(getMmrMode("low").thinkingLevel, "medium");
    assert.equal(getMmrMode("low").promptRoute, "default");

    assert.deepEqual(getMmrMode("medium").modelPreferences, [
      { model: "gpt-5.5" },
      { model: "claude-opus-4-8" },
    ]);
    assert.equal(getMmrMode("medium").thinkingLevel, "medium");
    assert.equal(getMmrMode("medium").promptRoute, "default");

    assert.deepEqual(getMmrMode("high").modelPreferences, [
      { model: "gpt-5.5" },
      { model: "claude-opus-4-8" },
    ]);
    assert.equal(getMmrMode("high").thinkingLevel, "xhigh");
    assert.equal(getMmrMode("high").promptRoute, "deep");

    assert.deepEqual(getMmrMode("ultra").modelPreferences, [
      { model: "gpt-5.6-sol" },
      { model: "gpt-5.5" },
    ]);
    assert.equal(getMmrMode("ultra").thinkingLevel, "xhigh");
    assert.equal(getMmrMode("ultra").promptRoute, "deep");
  });

  it("normalizes legacy mode names to canonical tiers", async () => {
    const { resolveMmrModeKey } = await importSource("extensions/ampi-core/modes.ts");
    assert.deepEqual(
      ["rush", "smart", "deep", "fable"].map(resolveMmrModeKey),
      ["low", "medium", "high", "ultra"],
    );
  });

  it("renders mode list using per-mode request thinking and context metadata", async () => {
    const { formatMmrModeList } = await importSource("extensions/ampi-core/modes.ts");

    const list = formatMmrModeList();

    assert.match(list, /low\s+gpt-5\.6-terra → gpt-5\.5 — thinking: OpenAI Responses medium \(summary auto\); context: 128k max out/);
    assert.match(list, /medium\s+gpt-5\.5 → claude-opus-4-8 — thinking: OpenAI Responses medium \(summary auto\); context: 300k total \/ 128k max out \/ 172k max in/);
    assert.match(list, /high\s+gpt-5\.5 → claude-opus-4-8 — thinking: OpenAI Responses xhigh \(summary auto\); context: 128k max out/);
    assert.match(list, /ultra\s+gpt-5\.6-sol → gpt-5\.5 — thinking: OpenAI Responses xhigh \(summary auto\); context: 128k max out/);
  });

  it("does not warn that shipped librarian support is still reserved", async () => {
    const { MMR_MODE_KEYS, getMmrMode } = await importSource("extensions/ampi-core/modes.ts");

    for (const key of MMR_MODE_KEYS) {
      const notes = getMmrMode(key).availabilityNotes ?? [];
      assert.equal(
        notes.some((note) => /librarian.*reserved|reserved.*librarian|future mmr-subagents work/i.test(note)),
        false,
        `${key} must not claim librarian is still future-only`,
      );
    }
  });

  it("keeps task_list in every enforced mode until a mode explicitly adopts Task as replacement", async () => {
    const { MMR_MODE_KEYS, getMmrMode } = await importSource("extensions/ampi-core/modes.ts");

    for (const key of MMR_MODE_KEYS) {
      const mode = getMmrMode(key);
      if (mode.tools.length === 0) continue; // free mode runs without tool enforcement
      assert.ok(
        mode.tools.includes("task_list"),
        `${key} mode must keep task_list until it explicitly adopts Task as replacement`,
      );
    }
  });

  it("defines free as pure native Pi controls", async () => {
    const { formatMmrModeList, getMmrMode, isMmrModeKey, MMR_MODE_KEYS } = await importSource("extensions/ampi-core/modes.ts");

    const free = getMmrMode("free");

    assert.deepEqual(MMR_MODE_KEYS, ["low", "medium", "high", "ultra", "free"]);
    assert.equal(isMmrModeKey("free"), true);
    assert.equal(isMmrModeKey("open"), false);
    assert.equal(free.displayName, "Free");
    assert.deepEqual(free.modelPreferences, []);
    assert.equal(free.thinkingLevel, undefined);
    assert.deepEqual(free.tools, []);
    assert.match(free.description, /native Pi/i);
    assert.match(formatMmrModeList(), /free\s+native Pi controls/i);
  });
});
