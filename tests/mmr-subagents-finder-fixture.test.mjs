// Effective-surface snapshot for the finder slice.
//
// Captures the renderer-flattened model-facing system prompt + active tool
// manifest for smart mode with the finder Pi tool active. Uses the same
// fixture machinery as `tests/mmr-core-prompt-baseline.test.mjs` and the
// Phase F matrix: PI_MMR_UPDATE_FIXTURES=1 rewrites the snapshot, every
// other run pins it.
//
// The structural assertions below are independent of the snapshot text:
// they guarantee the finder tool actually surfaces in the rendered prompt
// (and in the Tools section) regardless of how the prompt assembly chooses
// to format individual lines.

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { buildBasePromptForActiveManifest } from "./helpers/manifest-fixtures.mjs";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const promptFixtureDir = path.join(import.meta.dirname, "fixtures/mmr-core-prompts");
const effectiveSurfaceFixtureDir = path.join(
  import.meta.dirname,
  "fixtures/mmr-effective-surface",
);
const BASE_PROMPT = readFileSync(path.join(promptFixtureDir, "base.md"), "utf8");
const UPDATE_FIXTURES = process.env.PI_MMR_UPDATE_FIXTURES === "1";

function createState(mode) {
  return {
    mode,
    displayName: mode,
    source: "settings",
    targetModel: "claude-opus-4-8",
    requestedModels: ["claude-opus-4-8"],
    provider: "claude-subscription",
    model: "claude-opus-4-8",
    modelFound: true,
    modelApplied: true,
    modelFallbackApplied: false,
    modelFallbackReason: undefined,
    modelCandidates: [],
    thinkingLevel: "medium",
    promptRoute: "default",
    requestedTools: ["Read", "Bash", "finder"],
    activeTools: ["read", "bash", "finder"],
    missingTools: [],
    deferredTools: [],
    featureGates: [],
    availabilityNotes: [],
    appliedAt: "2026-05-08T00:00:00.000Z",
  };
}

async function finderManifestEntry() {
  const mod = await importSource("extensions/ampi-workers/builtin-workers/finder.ts");
  return {
    name: "finder",
    owner: "ampi-workers",
    promptSnippet: mod.FINDER_PROMPT_SNIPPET,
    promptGuidelines: [...mod.FINDER_PROMPT_GUIDELINES],
    description: mod.FINDER_DESCRIPTION,
    schema: mod.FINDER_PARAMETERS_SCHEMA,
  };
}

function assertFixtureMatches(filename, actual) {
  const fixturePath = path.join(effectiveSurfaceFixtureDir, filename);
  if (UPDATE_FIXTURES || !existsSync(fixturePath)) {
    writeFileSync(fixturePath, actual);
    if (!UPDATE_FIXTURES) {
      console.log(`[finder-fixture] wrote new fixture ${fixturePath}`);
    }
    return;
  }
  const expected = readFileSync(fixturePath, "utf8");
  assert.equal(
    actual,
    expected,
    `fixture ${filename} drift; rerun with PI_MMR_UPDATE_FIXTURES=1 to refresh`,
  );
}

describe("ampi-workers effective surface: medium mode with finder active", () => {
  it("renders an active-tools section that names finder and pins the manifest snapshot", async () => {
    const { assembleActiveSurface } = await importSource("extensions/ampi-core/prompt-assembly.ts");
    const { renderMmrPromptDebugFixture } = await importSource(
      "extensions/ampi-core/prompt-debug-renderer.ts",
    );
    const activeToolManifest = [await finderManifestEntry()];
    const baseSystemPrompt = buildBasePromptForActiveManifest(BASE_PROMPT, activeToolManifest);
    const result = assembleActiveSurface({
      state: createState("medium"),
      baseSystemPrompt,
      activeToolManifest,
      provider: "claude-subscription",
      model: "claude-opus-4-8",
    });

    // Structural guarantees independent of exact wording.
    assert.match(result.systemPrompt, /\nAvailable tools:[\s\S]*\bfinder\b/);
    assert.match(result.systemPrompt, /\nGuidelines:[\s\S]*\bfinder\b/);
    // None of the still-gated subagent worker names should be visible.
    for (const stillGated of ["Task", "oracle", "librarian"]) {
      assert.doesNotMatch(
        result.systemPrompt,
        new RegExp(`\\b${stillGated}\\b`),
        `${stillGated} must not leak into the model-facing prompt while gated`,
      );
    }

    const rendered = renderMmrPromptDebugFixture(result);
    assertFixtureMatches("medium.core+subagents.md", rendered);
  });
});
