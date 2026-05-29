import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

// Direct tests for the per-mode prompt template data. The full prompt
// rendering pipeline is exercised against fixtures in mmr-core-prompt; here we
// pin the structural invariants of MMR_MODE_PROMPT_TEMPLATES so accidental
// deletion or key drift fails loudly without requiring a fixture refresh.

const PROMPTED_MODES = ["smart", "smartGPT", "rush", "large", "deep"];

describe("mmr-core prompt templates - structural invariants", () => {
  it("exports exactly one template per prompted (non-free) locked mode", async () => {
    const { MMR_MODE_PROMPT_TEMPLATES } = await importSource("extensions/mmr-core/prompt-templates.ts");
    assert.deepEqual(Object.keys(MMR_MODE_PROMPT_TEMPLATES).sort(), [...PROMPTED_MODES].sort());
    assert.equal("free" in MMR_MODE_PROMPT_TEMPLATES, false, "free mode must not have a prompt template");
  });

  it("every template has a non-empty tag, intro, postureSections, and closingLine", async () => {
    const { MMR_MODE_PROMPT_TEMPLATES } = await importSource("extensions/mmr-core/prompt-templates.ts");
    for (const mode of PROMPTED_MODES) {
      const template = MMR_MODE_PROMPT_TEMPLATES[mode];
      assert.ok(template, `${mode}: template must exist`);
      assert.equal(typeof template.tag, "string", `${mode}: tag is a string`);
      assert.ok(template.tag.length > 0, `${mode}: tag is non-empty`);
      assert.equal(typeof template.intro, "string");
      assert.ok(template.intro.length > 20, `${mode}: intro is non-trivial`);
      assert.equal(typeof template.postureSections, "string");
      assert.ok(template.postureSections.length > 100, `${mode}: postureSections is non-trivial`);
      assert.equal(typeof template.closingLine, "string");
      assert.ok(template.closingLine.length > 10, `${mode}: closingLine is non-trivial`);
    }
  });

  it("tag matches the mode key for every template", async () => {
    const { MMR_MODE_PROMPT_TEMPLATES } = await importSource("extensions/mmr-core/prompt-templates.ts");
    for (const mode of PROMPTED_MODES) {
      assert.equal(MMR_MODE_PROMPT_TEMPLATES[mode].tag, mode, `${mode}: tag must equal the mode key`);
    }
  });

  it("shared prompt modules carry common tool/coding guidance", async () => {
    const { SHARED_CODING_GUIDANCE, SHARED_TOOL_GUIDANCE } = await importSource("extensions/mmr-core/prompt-modules.ts");
    assert.match(SHARED_TOOL_GUIDANCE, /## Tool execution policy/);
    assert.match(SHARED_TOOL_GUIDANCE, /Run independent read-only calls in parallel/);
    assert.match(SHARED_TOOL_GUIDANCE, /purpose-built worker or subagent tool/);
    assert.match(SHARED_TOOL_GUIDANCE, /direct tools for exact file\/path\/symbol lookups or single-step actions/);
    assert.match(SHARED_CODING_GUIDANCE, /## Executing actions with care/);
    assert.match(SHARED_CODING_GUIDANCE, /Destructive: deleting files\/branches/);
    assert.match(SHARED_CODING_GUIDANCE, /## Diagrams/);
    assert.match(SHARED_CODING_GUIDANCE, /No Mermaid/);
    assert.match(SHARED_CODING_GUIDANCE, /## File links/);
  });

  it("mode templates do not duplicate shared module-only guidance sections", async () => {
    const { MMR_MODE_PROMPT_TEMPLATES } = await importSource("extensions/mmr-core/prompt-templates.ts");
    for (const mode of PROMPTED_MODES) {
      const posture = MMR_MODE_PROMPT_TEMPLATES[mode].postureSections;
      assert.doesNotMatch(posture, /## Executing actions with care/, `${mode}: shared guardrail must live in prompt modules`);
      assert.doesNotMatch(posture, /## Diagrams/, `${mode}: diagram guidance must live in prompt modules`);
      assert.doesNotMatch(posture, /## File links/, `${mode}: file-link guidance must live in prompt modules`);
    }
  });

  it("mode-specific posture headings are present (autonomy/execution/large/deep)", async () => {
    const { MMR_MODE_PROMPT_TEMPLATES } = await importSource("extensions/mmr-core/prompt-templates.ts");
    assert.match(MMR_MODE_PROMPT_TEMPLATES.smart.postureSections, /## Smart mode/);
    assert.match(MMR_MODE_PROMPT_TEMPLATES.smart.postureSections, /balanced autonomy/);

    assert.match(MMR_MODE_PROMPT_TEMPLATES.rush.postureSections, /## Rush contract/);
    assert.match(MMR_MODE_PROMPT_TEMPLATES.rush.postureSections, /## Rush discovery/);
    assert.match(MMR_MODE_PROMPT_TEMPLATES.rush.postureSections, /## Rush communication/);
    assert.match(MMR_MODE_PROMPT_TEMPLATES.rush.postureSections, /Do not compensate for no reasoning/);

    assert.match(MMR_MODE_PROMPT_TEMPLATES.large.postureSections, /## Large mode/);
    assert.match(MMR_MODE_PROMPT_TEMPLATES.large.postureSections, /Broader context should reduce risk/);

    assert.match(MMR_MODE_PROMPT_TEMPLATES.deep.postureSections, /## Deep mode/);
    assert.match(MMR_MODE_PROMPT_TEMPLATES.deep.postureSections, /## Diagnostic gate/);
  });

  it("introductions identify the mode by name or role to avoid silent mis-routing", async () => {
    const { MMR_MODE_PROMPT_TEMPLATES } = await importSource("extensions/mmr-core/prompt-templates.ts");
    // Each intro must mention its mode or a unique role marker so a copy-paste
    // bug between entries fails loudly.
    assert.match(MMR_MODE_PROMPT_TEMPLATES.rush.intro, /fewest useful tool loops/i);
    assert.match(MMR_MODE_PROMPT_TEMPLATES.large.intro, /Large mode/i);
    assert.match(MMR_MODE_PROMPT_TEMPLATES.deep.intro, /Deep mode/i);
    // smart intentionally does not name itself (default mode); just verify
    // it carries the pair-programming framing it's known for.
    assert.match(MMR_MODE_PROMPT_TEMPLATES.smart.intro, /pair programming/i);
  });

  it("closingLine differs between modes (each carries mode-specific response style)", async () => {
    const { MMR_MODE_PROMPT_TEMPLATES } = await importSource("extensions/mmr-core/prompt-templates.ts");
    const closings = PROMPTED_MODES.map((mode) => MMR_MODE_PROMPT_TEMPLATES[mode].closingLine);
    assert.equal(new Set(closings).size, closings.length, "each mode must define a unique closingLine");
  });

  it("postureSections never re-introduces a leading or trailing blank line that the renderer would double", async () => {
    const { MMR_MODE_PROMPT_TEMPLATES } = await importSource("extensions/mmr-core/prompt-templates.ts");
    for (const mode of PROMPTED_MODES) {
      const sections = MMR_MODE_PROMPT_TEMPLATES[mode].postureSections;
      assert.equal(sections.startsWith("\n"), false, `${mode}: postureSections must not start with a newline`);
      assert.equal(sections.endsWith("\n"), false, `${mode}: postureSections must not end with a newline`);
    }
  });
});
