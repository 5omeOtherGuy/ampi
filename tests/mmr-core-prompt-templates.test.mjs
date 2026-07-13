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

  it("every template has a non-empty tag, intro, and closingLine; only high and ultra carry a deep posture", async () => {
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
    // Low and Medium use the Smart prompt; High and Ultra use Deep.
    for (const mode of ["low", "medium"]) {
      assert.equal(MMR_MODE_PROMPT_TEMPLATES[mode].postureSections, "", `${mode}: smart-family modes render no posture section`);
    }
    for (const mode of ["high", "ultra"]) {
      assert.ok(MMR_MODE_PROMPT_TEMPLATES[mode].postureSections.length > 100, `${mode}: deep-family postureSections is non-trivial`);
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

  it("deep-family posture headings are present for high and ultra", async () => {
    const { MMR_MODE_PROMPT_TEMPLATES } = await importSource("extensions/ampi-core/prompt-templates.ts");
    for (const mode of ["high", "ultra"]) {
      assert.match(MMR_MODE_PROMPT_TEMPLATES[mode].postureSections, /## Deep mode/);
      assert.match(MMR_MODE_PROMPT_TEMPLATES[mode].postureSections, /## Diagnostic gate/);
    }
  });

  it("introductions identify the mode by name or role to avoid silent mis-routing", async () => {
    const { MMR_MODE_PROMPT_TEMPLATES } = await importSource("extensions/ampi-core/prompt-templates.ts");
    // Each intro must mention its mode or a unique role marker so a copy-paste
    // bug between entries fails loudly.
    assert.match(MMR_MODE_PROMPT_TEMPLATES.low.intro, /pair programming/i);
    assert.match(MMR_MODE_PROMPT_TEMPLATES.medium.intro, /pair programming/i);
    assert.match(MMR_MODE_PROMPT_TEMPLATES.high.intro, /Deep mode/i);
    assert.match(MMR_MODE_PROMPT_TEMPLATES.ultra.intro, /Deep mode/i);
  });

  it("each prompt family renders verbatim apart from the mode tag", async () => {
    const { MMR_MODE_PROMPT_TEMPLATES } = await importSource("extensions/ampi-core/prompt-templates.ts");
    for (const [variant, base] of [["low", "medium"], ["ultra", "high"]]) {
      assert.equal(MMR_MODE_PROMPT_TEMPLATES[variant].intro, MMR_MODE_PROMPT_TEMPLATES[base].intro, `${variant}: intro matches ${base}`);
      assert.equal(MMR_MODE_PROMPT_TEMPLATES[variant].postureSections, MMR_MODE_PROMPT_TEMPLATES[base].postureSections, `${variant}: posture matches ${base}`);
      assert.equal(MMR_MODE_PROMPT_TEMPLATES[variant].closingLine, MMR_MODE_PROMPT_TEMPLATES[base].closingLine, `${variant}: closing matches ${base}`);
    }
  });

  it("Smart and Deep families use distinct closing lines", async () => {
    const { MMR_MODE_PROMPT_TEMPLATES } = await importSource("extensions/ampi-core/prompt-templates.ts");
    assert.notEqual(MMR_MODE_PROMPT_TEMPLATES.medium.closingLine, MMR_MODE_PROMPT_TEMPLATES.high.closingLine);
    assert.equal(MMR_MODE_PROMPT_TEMPLATES.low.closingLine, MMR_MODE_PROMPT_TEMPLATES.medium.closingLine);
    assert.equal(MMR_MODE_PROMPT_TEMPLATES.ultra.closingLine, MMR_MODE_PROMPT_TEMPLATES.high.closingLine);
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
