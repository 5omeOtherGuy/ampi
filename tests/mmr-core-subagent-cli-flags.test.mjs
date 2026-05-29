// Pure helper: extract explicit `--model`, `--tools`, and parent-mode
// values from the child Pi process argv so subagent activation can
// distinguish between runner-supplied flags and Pi defaults.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const MODULE = "extensions/mmr-core/worker-cli-flags.ts";

describe("extractExplicitWorkerCliFlags", () => {
  it("returns undefined fields when neither flag is present", async () => {
    const { extractExplicitWorkerCliFlags } = await importSource(MODULE);
    const result = extractExplicitWorkerCliFlags(["--mmr-subagent", "finder", "Task: noop"]);
    assert.equal(result.explicitModel, undefined);
    assert.equal(result.explicitTools, undefined);
    assert.equal(result.parentMode, undefined);
  });

  it("extracts `--model <value>` from space-separated argv", async () => {
    const { extractExplicitWorkerCliFlags } = await importSource(MODULE);
    const { explicitModel } = extractExplicitWorkerCliFlags([
      "--mmr-subagent",
      "finder",
      "--model",
      "openai-codex/gpt-5.4-mini",
    ]);
    assert.equal(explicitModel, "openai-codex/gpt-5.4-mini");
  });

  it("extracts `--model=<value>` from joined argv", async () => {
    const { extractExplicitWorkerCliFlags } = await importSource(MODULE);
    const { explicitModel } = extractExplicitWorkerCliFlags([
      "--model=anthropic/claude-haiku-4-5:high",
    ]);
    assert.equal(explicitModel, "anthropic/claude-haiku-4-5:high");
  });

  it("extracts `--tools <a,b,c>` and `-t <a,b,c>` as a trimmed string list", async () => {
    const { extractExplicitWorkerCliFlags } = await importSource(MODULE);
    const longForm = extractExplicitWorkerCliFlags(["--tools", "grep, find ,read"]);
    assert.deepEqual([...(longForm.explicitTools ?? [])], ["grep", "find", "read"]);
    const shortForm = extractExplicitWorkerCliFlags(["-t", "read,find,grep"]);
    assert.deepEqual([...(shortForm.explicitTools ?? [])], ["read", "find", "grep"]);
  });

  it("extracts `--tools=<a,b,c>` from joined argv", async () => {
    const { extractExplicitWorkerCliFlags } = await importSource(MODULE);
    const { explicitTools } = extractExplicitWorkerCliFlags(["--tools=grep,find,read"]);
    assert.deepEqual([...(explicitTools ?? [])], ["grep", "find", "read"]);
  });

  it("extracts `--mmr-parent-mode <value>` and `--mmr-parent-mode=<value>`", async () => {
    const { extractExplicitWorkerCliFlags } = await importSource(MODULE);
    const spaceSeparated = extractExplicitWorkerCliFlags(["--mmr-parent-mode", "rush"]);
    assert.equal(spaceSeparated.parentMode, "rush");
    const joined = extractExplicitWorkerCliFlags(["--mmr-parent-mode=smart"]);
    assert.equal(joined.parentMode, "smart");
  });

  it("returns explicitTools as an empty list (not undefined) when --tools is supplied with no entries", async () => {
    // Distinguishes 'runner explicitly asked for no tools' from 'flag not set'.
    const { extractExplicitWorkerCliFlags } = await importSource(MODULE);
    const { explicitTools } = extractExplicitWorkerCliFlags(["--tools", ""]);
    assert.ok(Array.isArray(explicitTools));
    assert.equal(explicitTools.length, 0);
  });

  it("does not confuse other flags whose names start with `--model`/`--tools`", async () => {
    const { extractExplicitWorkerCliFlags } = await importSource(MODULE);
    const result = extractExplicitWorkerCliFlags([
      "--models",
      "claude,gpt-4o",
      "--no-tools",
      "--no-builtin-tools",
      "--mmr-parent",
      "rush",
    ]);
    assert.equal(result.explicitModel, undefined);
    assert.equal(result.explicitTools, undefined);
    assert.equal(result.parentMode, undefined);
  });

  it("when a flag appears multiple times, the last occurrence wins", async () => {
    const { extractExplicitWorkerCliFlags } = await importSource(MODULE);
    const { explicitModel, explicitTools, parentMode } = extractExplicitWorkerCliFlags([
      "--model",
      "a/b",
      "--tools",
      "x,y",
      "--mmr-parent-mode",
      "smart",
      "--model",
      "c/d",
      "--tools",
      "p,q",
      "--mmr-parent-mode",
      "rush",
    ]);
    assert.equal(explicitModel, "c/d");
    assert.deepEqual([...(explicitTools ?? [])], ["p", "q"]);
    assert.equal(parentMode, "rush");
  });
});
