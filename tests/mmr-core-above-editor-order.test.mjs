import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

const MODULE = "extensions/mmr-core/above-editor-order.ts";

after(cleanupLoadedSource);

describe("above-editor ordering coordinator", () => {
  let mod;
  beforeEach(async () => {
    mod = await importSource(MODULE);
    mod.resetLowerAboveEditorWidgetsForTest();
  });

  it("invokes every registered lower widget with the forwarded ctx", () => {
    const seen = [];
    mod.registerLowerAboveEditorWidget("a", (ctx) => seen.push(["a", ctx]));
    mod.registerLowerAboveEditorWidget("b", (ctx) => seen.push(["b", ctx]));
    const ctx = { marker: 1 };
    mod.reassertLowerAboveEditorWidgets(ctx);
    assert.deepEqual(seen, [["a", ctx], ["b", ctx]]);
  });

  it("overwrites a re-registered id rather than running it twice", () => {
    let calls = 0;
    mod.registerLowerAboveEditorWidget("a", () => { calls += 1; });
    mod.registerLowerAboveEditorWidget("a", () => { calls += 10; });
    mod.reassertLowerAboveEditorWidgets({});
    assert.equal(calls, 10, "only the latest registration for an id runs");
  });

  it("is best-effort: a throwing callback never blocks the others", () => {
    const ran = [];
    mod.registerLowerAboveEditorWidget("boom", () => { throw new Error("nope"); });
    mod.registerLowerAboveEditorWidget("ok", () => ran.push("ok"));
    assert.doesNotThrow(() => mod.reassertLowerAboveEditorWidgets({}));
    assert.deepEqual(ran, ["ok"]);
  });

  it("reset clears all registrations", () => {
    let calls = 0;
    mod.registerLowerAboveEditorWidget("a", () => { calls += 1; });
    mod.resetLowerAboveEditorWidgetsForTest();
    mod.reassertLowerAboveEditorWidgets({});
    assert.equal(calls, 0);
  });
});
