import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

// Direct tests for the per-mode prompt template data. The full prompt
// rendering pipeline is exercised against fixtures in mmr-core-prompt; here we
// pin the structural invariants of MMR_MODE_PROMPT_TEMPLATES so accidental
// deletion or key drift fails loudly without requiring a fixture refresh.

const PROMPTED_MODES = ["medium", "ultra", "low", "high"];

describe("mmr-core prompt templates - structural invariants", () => {
  it("exports exactly one template per prompted (non-free) locked mode", async () => {
    const { MMR_MODE_PROMPT_TEMPLATES } = await importSource("extensions/ampi-core/prompt-templates.ts");
    assert.deepEqual(Object.keys(MMR_MODE_PROMPT_TEMPLATES).sort(), [...PROMPTED_MODES].sort());
    assert.equal("free" in MMR_MODE_PROMPT_TEMPLATES, false, "free mode must not have a prompt template");
  });

  it("every template has a non-empty tag, intro, and closingLine; captured levels carry no synthetic mode posture", async () => {
    const { MMR_MODE_PROMPT_TEMPLATES } = await importSource("extensions/ampi-core/prompt-templates.ts");
    for (const mode of PROMPTED_MODES) {
      const template = MMR_MODE_PROMPT_TEMPLATES[mode];
      assert.ok(template, `${mode}: template must exist`);
      assert.equal(typeof template.tag, "string", `${mode}: tag is a string`);
      assert.ok(template.tag.length > 0, `${mode}: tag is non-empty`);
      assert.equal(typeof template.intro, "string");
      assert.ok(template.intro.length > 20, `${mode}: intro is non-trivial`);
      assert.equal(typeof template.postureSections, "string");
      assert.equal(typeof template.closingLine, "string");
      assert.ok(template.closingLine.length > 10, `${mode}: closingLine is non-trivial`);
    }
    for (const mode of PROMPTED_MODES) {
      assert.equal(MMR_MODE_PROMPT_TEMPLATES[mode].postureSections, "", `${mode}: captured prompt renders no synthetic posture section`);
    }
  });

  it("tag matches the mode key for every template", async () => {
    const { MMR_MODE_PROMPT_TEMPLATES } = await importSource("extensions/ampi-core/prompt-templates.ts");
    for (const mode of PROMPTED_MODES) {
      assert.equal(MMR_MODE_PROMPT_TEMPLATES[mode].tag, mode, `${mode}: tag must equal the mode key`);
    }
  });

  it("shared prompt modules carry common tool/coding guidance", async () => {
    const { SHARED_CODING_GUIDANCE, SHARED_TOOL_GUIDANCE } = await importSource("extensions/ampi-core/prompt-modules.ts");
    assert.match(SHARED_TOOL_GUIDANCE, /## Tool execution policy/);
    assert.doesNotMatch(SHARED_TOOL_GUIDANCE, /Run independent read-only calls in parallel/);
    assert.match(SHARED_TOOL_GUIDANCE, /purpose-built worker fits the job/);
    assert.match(SHARED_TOOL_GUIDANCE, /direct tools for exact file, path, or symbol lookups and single-step actions/);
    assert.match(SHARED_CODING_GUIDANCE, /## Executing actions with care/);
    assert.match(SHARED_CODING_GUIDANCE, /Destructive: deleting files or branches/);
    assert.match(SHARED_CODING_GUIDANCE, /## Diagrams/);
    assert.match(SHARED_CODING_GUIDANCE, /No Mermaid/);
    assert.match(SHARED_CODING_GUIDANCE, /## File links/);
  });

  it("mode templates do not duplicate shared module-only guidance sections", async () => {
    const { MMR_MODE_PROMPT_TEMPLATES } = await importSource("extensions/ampi-core/prompt-templates.ts");
    for (const mode of PROMPTED_MODES) {
      const posture = MMR_MODE_PROMPT_TEMPLATES[mode].postureSections;
      assert.doesNotMatch(posture, /## Executing actions with care/, `${mode}: shared guardrail must live in prompt modules`);
      assert.doesNotMatch(posture, /## Diagrams/, `${mode}: diagram guidance must live in prompt modules`);
      assert.doesNotMatch(posture, /## File links/, `${mode}: file-link guidance must live in prompt modules`);
    }
  });

  it("captured templates do not add legacy Deep posture sections", async () => {
    const { MMR_MODE_PROMPT_TEMPLATES } = await importSource("extensions/ampi-core/prompt-templates.ts");
    for (const mode of PROMPTED_MODES) {
      assert.doesNotMatch(MMR_MODE_PROMPT_TEMPLATES[mode].postureSections, /## Deep mode/);
      assert.doesNotMatch(MMR_MODE_PROMPT_TEMPLATES[mode].postureSections, /## Diagnostic gate/);
    }
  });

  it("introductions distinguish the compact medium level from the shared low/high/ultra role", async () => {
    const { MMR_MODE_PROMPT_TEMPLATES } = await importSource("extensions/ampi-core/prompt-templates.ts");
    assert.match(MMR_MODE_PROMPT_TEMPLATES.medium.intro, /ampi's coding agent/i);
    for (const mode of ["low", "high", "ultra"]) {
      assert.match(MMR_MODE_PROMPT_TEMPLATES[mode].intro, /autonomous coding agent/i);
    }
  });

  it("low, high, and ultra share the captured base template apart from the mode tag", async () => {
    const { MMR_MODE_PROMPT_TEMPLATES } = await importSource("extensions/ampi-core/prompt-templates.ts");
    for (const mode of ["high", "ultra"]) {
      assert.equal(MMR_MODE_PROMPT_TEMPLATES[mode].intro, MMR_MODE_PROMPT_TEMPLATES.low.intro, `${mode}: intro matches low`);
      assert.equal(MMR_MODE_PROMPT_TEMPLATES[mode].postureSections, MMR_MODE_PROMPT_TEMPLATES.low.postureSections, `${mode}: posture matches low`);
      assert.equal(MMR_MODE_PROMPT_TEMPLATES[mode].closingLine, MMR_MODE_PROMPT_TEMPLATES.low.closingLine, `${mode}: closing matches low`);
    }
  });

  it("medium keeps its distinct compact response style", async () => {
    const { MMR_MODE_PROMPT_TEMPLATES } = await importSource("extensions/ampi-core/prompt-templates.ts");
    assert.notEqual(MMR_MODE_PROMPT_TEMPLATES.medium.closingLine, MMR_MODE_PROMPT_TEMPLATES.low.closingLine);
    assert.equal(MMR_MODE_PROMPT_TEMPLATES.low.closingLine, MMR_MODE_PROMPT_TEMPLATES.high.closingLine);
    assert.equal(MMR_MODE_PROMPT_TEMPLATES.low.closingLine, MMR_MODE_PROMPT_TEMPLATES.ultra.closingLine);
  });

  it("medium uses the compact task-framing sections while low/high/ultra share the full guidance", async () => {
    const { resolveModeCodingGuidanceFragment } = await importSource("extensions/ampi-core/prompt-content.ts");
    const mediumAutonomy = resolveModeCodingGuidanceFragment("medium", "autonomy");
    const mediumDiscovery = resolveModeCodingGuidanceFragment("medium", "discovery-discipline");
    const mediumPragmatism = resolveModeCodingGuidanceFragment("medium", "pragmatism");
    const mediumCollaboration = resolveModeCodingGuidanceFragment("medium", "collaboration");
    assert.match(mediumAutonomy, /^## Operating principles/);
    assert.match(mediumDiscovery, /## Frame the task/);
    assert.match(mediumDiscovery, /## Plan before acting/);
    assert.match(mediumDiscovery, /## Codebase discovery/);
    assert.match(mediumPragmatism, /^## Implementation style/);
    assert.match(mediumCollaboration, /^## Communication/);

    for (const fragmentId of ["autonomy", "discovery-discipline", "pragmatism", "verification", "collaboration"]) {
      const low = resolveModeCodingGuidanceFragment("low", fragmentId);
      assert.equal(resolveModeCodingGuidanceFragment("high", fragmentId), low, `high: ${fragmentId} matches low`);
      assert.equal(resolveModeCodingGuidanceFragment("ultra", fragmentId), low, `ultra: ${fragmentId} matches low`);
      assert.notEqual(resolveModeCodingGuidanceFragment("medium", fragmentId), low, `medium: ${fragmentId} stays distinct`);
    }
  });

  it("postureSections never re-introduces a leading or trailing blank line that the renderer would double", async () => {
    const { MMR_MODE_PROMPT_TEMPLATES } = await importSource("extensions/ampi-core/prompt-templates.ts");
    for (const mode of PROMPTED_MODES) {
      const sections = MMR_MODE_PROMPT_TEMPLATES[mode].postureSections;
      assert.equal(sections.startsWith("\n"), false, `${mode}: postureSections must not start with a newline`);
      assert.equal(sections.endsWith("\n"), false, `${mode}: postureSections must not end with a newline`);
    }
  });
});
