import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { Type } from "typebox";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

describe("mmr-core tool parameter helpers", () => {
  it("returns typed params when the schema accepts the raw input", async () => {
    const { checkMmrToolParams } = await importSource("extensions/ampi-core/tool-params.ts");
    const schema = Type.Object({ query: Type.String() }, { additionalProperties: false });
    const raw = { query: "find auth checks" };

    const params = checkMmrToolParams("finder", schema, raw);

    assert.deepEqual(params, raw);
  });

  it("reports a deterministic error for missing required fields", async () => {
    const { checkMmrToolParams, MmrToolParamsError } = await importSource("extensions/ampi-core/tool-params.ts");
    const schema = Type.Object({ query: Type.String() }, { additionalProperties: false });

    assert.throws(
      () => checkMmrToolParams("finder", schema, {}),
      (error) => {
        assert.ok(error instanceof MmrToolParamsError);
        assert.equal(error.name, "MmrToolParamsError");
        assert.equal(error.message, "finder: invalid parameters: must have required properties query at /");
        return true;
      },
    );
  });

  it("rejects extra fields when the schema is strict", async () => {
    const { checkMmrToolParams } = await importSource("extensions/ampi-core/tool-params.ts");
    const schema = Type.Object({ query: Type.String() }, { additionalProperties: false });

    assert.throws(
      () => checkMmrToolParams("finder", schema, { query: "find auth checks", extra: true }),
      /finder: invalid parameters: must not have additional properties at \/$/,
    );
  });
});
