import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

describe("mmr-core internal JSON helpers", () => {
  it("matches the existing record predicate semantics", async () => {
    const { isRecord } = await importSource("extensions/ampi-core/internal/json.ts");

    assert.equal(isRecord({}), true);
    assert.equal(isRecord({ a: 1 }), true);
    assert.equal(isRecord(new Date("2026-05-28T00:00:00Z")), true);
    assert.equal(isRecord(null), false);
    assert.equal(isRecord(undefined), false);
    assert.equal(isRecord([]), false);
    assert.equal(isRecord("value"), false);
    assert.equal(isRecord(1), false);
    assert.equal(isRecord(true), false);
  });
});
