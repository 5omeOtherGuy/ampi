import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

const PROMPT_MODULE = "extensions/ampi-workers/builtin-workers/oracle-prompt.ts";
const ORACLE_MODULE = "extensions/ampi-workers/builtin-workers/oracle.ts";

after(cleanupLoadedSource);

describe("mmr-subagents oracle-prompt", () => {
  it("coerces advisor params and normalizes files[]", async () => {
    const { coerceAdvisorParams } = await importSource(PROMPT_MODULE);

    assert.throws(() => coerceAdvisorParams("oracle", null), /expects an object/);
    assert.throws(() => coerceAdvisorParams("oracle", "task"), /expects an object/);
    assert.throws(() => coerceAdvisorParams("oracle", { task: "   " }), /non-empty string/);

    const full = coerceAdvisorParams("oracle", {
      task: "review the design",
      context: "background",
      files: ["  a.ts  ", "", "b.ts", "   "],
    });
    assert.deepEqual(full, { task: "review the design", context: "background", files: ["a.ts", "b.ts"] });

    const minimal = coerceAdvisorParams("oracle", { task: "plan it" });
    assert.deepEqual(minimal, { task: "plan it" });
    assert.equal("files" in minimal, false);
    assert.equal("context" in minimal, false);
  });

  it("contains paths to the working directory", async () => {
    const { pathInsideCwd } = await importSource(PROMPT_MODULE);

    assert.equal(pathInsideCwd("/repo/src/a.ts", "/repo"), true);
    assert.equal(pathInsideCwd("/repo", "/repo"), true);
    assert.equal(pathInsideCwd("/repo/../etc/passwd", "/repo"), false);
    assert.equal(pathInsideCwd("/etc/passwd", "/repo"), false);
  });

  it("classifies common image extensions", async () => {
    const { IMAGE_EXTENSIONS } = await importSource(PROMPT_MODULE);

    for (const ext of [".png", ".jpg", ".jpeg", ".webp", ".svg"]) {
      assert.ok(IMAGE_EXTENSIONS.has(ext), `${ext} should classify as image`);
    }
    assert.equal(IMAGE_EXTENSIONS.has(".ts"), false);
  });

  it("builds the worker user prompt from task, context, and attachments", async () => {
    const { buildOracleUserPrompt } = await importSource(PROMPT_MODULE);

    assert.equal(buildOracleUserPrompt({ task: " review this " }, []), "Task: review this");

    const withContext = buildOracleUserPrompt({ task: "review", context: " background " }, []);
    assert.match(withContext, /^Task: review\n\nContext:\nbackground$/);

    const attachments = [
      {
        record: { kind: "text", path: "a.ts", bytes: 5, truncated: false, originalBytes: 5 },
        text: "const",
      },
      {
        record: { kind: "text", path: "big.ts", bytes: 10, truncated: true, originalBytes: 99 },
        text: "truncated…",
      },
      { record: { kind: "image", path: "shot.png", bytes: 1024 } },
      { record: { kind: "skipped", path: "../out.ts", reason: "outside the working directory; not attached" } },
    ];
    const prompt = buildOracleUserPrompt({ task: "review" }, attachments);
    assert.match(prompt, /Attached files:/);
    assert.match(prompt, /### File: a\.ts\n```\nconst\n```/);
    assert.match(prompt, /### File: big\.ts \(truncated to first 10 bytes of 99\)/);
    assert.match(prompt, /### Image: shot\.png\n\(Binary image — open with the `read` tool/);
    assert.match(prompt, /### File: \.\.\/out\.ts \(outside the working directory; not attached\)/);
  });

  it("keeps the schema surface resolving through the oracle entry file", async () => {
    const prompt = await importSource(PROMPT_MODULE);
    const oracle = await importSource(ORACLE_MODULE);

    // `importSource` cache-busts per call: compare shape, not identity.
    assert.deepEqual(oracle.ORACLE_PARAMETERS_SCHEMA, prompt.ORACLE_PARAMETERS_SCHEMA);
    assert.deepEqual(oracle.oracleParameters, prompt.ORACLE_PARAMETERS_SCHEMA);
  });
});
