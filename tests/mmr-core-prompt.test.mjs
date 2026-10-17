import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const fixtureDir = path.join(import.meta.dirname, "fixtures/mmr-core-prompts");
const BASE_PROMPT = readFileSync(path.join(fixtureDir, "base.md"), "utf8");

const UPDATE_FIXTURES = process.env.PI_MMR_UPDATE_FIXTURES === "1";

function readModeFixture(mode) {
  return readFileSync(path.join(fixtureDir, `${mode}.md`), "utf8");
}

function createState(overrides = {}) {
  return {
    mode: "medium",
    displayName: "Smart",
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
    requestedTools: ["Read", "Bash"],
    activeTools: ["read", "bash"],
    missingTools: [],
    deferredTools: [],
    featureGates: [],
    availabilityNotes: [],
    appliedAt: "2026-05-08T00:00:00.000Z",
    ...overrides,
  };
}

const MODES = ["medium", "ultra", "low", "high"];

const PI_IDENTITY_LINE = "You are an expert coding assistant operating inside pi, a coding agent harness.";

const MODE_MARKER_OPENINGS = {
  medium: '<mmr_mode name="medium">You are ampi\'s autonomous coding agent.',
  low: '<mmr_mode name="low">You are ampi\'s coding agent, working directly in the user\'s repository.',
  high: '<mmr_mode name="high">You are ampi\'s autonomous coding agent.',
  ultra: '<mmr_mode name="ultra">You are ampi\'s autonomous coding agent.',
};

function repeatedLongInstructionLines(prompt) {
  const counts = new Map();
  for (const line of prompt.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length < 80) continue;
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([line, count]) => `${count}x ${line}`);
}

async function importRuntime() {
  const runtimeUrl = pathToFileURL(path.join(getPreparedSourceRoot(), "extensions/ampi-core/runtime.ts")).href;
  return import(runtimeUrl);
}

function buildExtensionStub(handlers) {
  return {
    registerFlag: () => {},
    getFlag: () => undefined,
    getAllTools: () => [],
    getActiveTools: () => ["read", "bash"],
    setActiveTools: () => {},
    setModel: async () => true,
    setThinkingLevel: () => {},
    appendEntry: () => {},
    registerCommand: () => {},
    registerShortcut: () => {},
    on: (name, handler) => handlers.set(name, handler),
  };
}

describe("mmr-core prompt layer", () => {
  it("renders each mode prompt against the fixture base prompt and matches its snapshot", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/ampi-core/prompt.ts");

    for (const mode of MODES) {
      const state = createState({ mode, displayName: mode[0].toUpperCase() + mode.slice(1) });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: BASE_PROMPT });
      if (UPDATE_FIXTURES) writeFileSync(path.join(fixtureDir, `${mode}.md`), result);
      assert.equal(result, readModeFixture(mode), `${mode}: rendered prompt must match fixture`);
      assert.equal(result.startsWith(`${PI_IDENTITY_LINE} ${MODE_MARKER_OPENINGS[mode]}`), true);
    }
  });

  it("emits the shared tool-use posture only once per locked-mode prompt", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/ampi-core/prompt.ts");
    const { MMR_TOOL_USE_POSTURE_LINE } = await importSource("extensions/ampi-core/prompt-assembly.ts");

    for (const mode of MODES) {
      const state = createState({ mode, displayName: mode[0].toUpperCase() + mode.slice(1) });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: BASE_PROMPT });
      assert.equal(
        result.split(MMR_TOOL_USE_POSTURE_LINE).length - 1,
        1,
        `${mode}: duplicated prompt guidance reinforces repetitive tool-use behavior`,
      );
    }
  });

  it("does not duplicate long instruction lines in locked-mode prompts", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/ampi-core/prompt.ts");

    for (const mode of MODES) {
      const state = createState({ mode, displayName: mode[0].toUpperCase() + mode.slice(1) });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: BASE_PROMPT });
      assert.deepEqual(
        repeatedLongInstructionLines(result),
        [],
        `${mode}: long model-visible instruction lines must not be emitted more than once`,
      );
    }
  });

  it("does not duplicate shared guidance when reassembling an already MMR-rewritten prompt", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/ampi-core/prompt.ts");

    for (const mode of MODES) {
      const state = createState({ mode, displayName: mode[0].toUpperCase() + mode.slice(1) });
      const first = buildMmrPromptLayer({ state, baseSystemPrompt: BASE_PROMPT });
      const second = buildMmrPromptLayer({ state, baseSystemPrompt: first });
      assert.deepEqual(
        repeatedLongInstructionLines(second),
        [],
        `${mode}: reassembly must replace prior MMR-owned blocks instead of preserving and duplicating them`,
      );
    }
  });

  it("limits MMR-owned XML-style markers to the initial mode role marker", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/ampi-core/prompt.ts");
    const forbiddenMarkers = [
      "<smart>",
      "</smart>",
      "<rush>",
      "</rush>",
      "<test>",
      "</test>",
      "<large>",
      "</large>",
      "<deep>",
      "</deep>",
      "<tool_use>",
      "</tool_use>",
      "<autonomy_and_persistence>",
      "</autonomy_and_persistence>",
      "<investigate_before_acting>",
      "</investigate_before_acting>",
      "<pragmatism_and_scope>",
      "</pragmatism_and_scope>",
      "<verification>",
      "</verification>",
      "<executing_actions_with_care>",
      "</executing_actions_with_care>",
      "<using_subagents>",
      "</using_subagents>",
      "<diagrams>",
      "</diagrams>",
      "<file_links>",
      "</file_links>",
      "<deep_mode>",
      "</deep_mode>",
      "<diagnostic_gate>",
      "</diagnostic_gate>",
      "<discovery_discipline>",
      "</discovery_discipline>",
      "<working_with_the_user>",
      "</working_with_the_user>",
    ];

    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: BASE_PROMPT });
      assert.equal(result.includes(MODE_MARKER_OPENINGS[mode]), true, `${mode}: initial mode marker must describe the mode role`);
      assert.equal(result.includes("</mmr_mode>"), true, `${mode}: mode marker must close with a parseable XML-style close tag`);
      assert.equal(result.split("<mmr_mode ").length - 1, 1, `${mode}: must contain exactly one opening mmr_mode marker`);
      assert.equal(result.split("</mmr_mode>").length - 1, 1, `${mode}: must contain exactly one closing mmr_mode marker`);
      for (const marker of forbiddenMarkers) {
        assert.equal(result.includes(marker), false, `${mode}: must not include legacy marker ${marker}`);
      }
      assert.equal(result.includes("## Tool use"), true, `${mode}: Tool use must be a Markdown heading`);
      assert.equal(result.includes("## Response style"), true, `${mode}: response style must be a Markdown heading`);
    }
  });

  it("keeps diagram guidance in the full new system prompts and omits it from compact Low", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/ampi-core/prompt.ts");
    const diagramSentence =
      "When a picture beats prose for architecture, flow, state, or relationships, draw it with box-drawing characters";

    for (const mode of ["medium", "high", "ultra"]) {
      const result = buildMmrPromptLayer({ state: createState({ mode }), baseSystemPrompt: BASE_PROMPT });
      assert.equal(result.includes(diagramSentence), true, `${mode}: diagrams fragment must render`);
      assert.equal(result.includes("## Diagrams"), true, `${mode}: diagrams section must render`);
      assert.equal(result.includes("```diagram"), false, `${mode}: must not force diagram code fences`);
    }
    const low = buildMmrPromptLayer({ state: createState({ mode: "low" }), baseSystemPrompt: BASE_PROMPT });
    assert.equal(low.includes("## Diagrams"), false);
    assert.equal(low.includes(diagramSentence), false);
  });

  it("embeds Pi's <tools> list verbatim under the Tool use heading for every mode", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/ampi-core/prompt.ts");
    const expectedToolsBlock = [
      "<tools>",
      "- read: Read file contents",
      "- bash: Execute bash commands (ls, grep, find, etc.)",
      "- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
      "- write: Create or overwrite files",
      "- grep: Search file contents for patterns (respects .gitignore)",
      "- find: Find files by glob pattern (respects .gitignore)",
      "- ls: List directory contents",
      "",
      "In addition to the tools above, you may have access to other custom tools depending on the project.",
      "</tools>",
    ].join("\n");

    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: BASE_PROMPT });
      const toolsIdx = result.indexOf(expectedToolsBlock);
      const toolUseIdx = result.indexOf("## Tool use");
      const tailIdx = result.indexOf("\n\n<project_context>\n");
      assert.notEqual(toolsIdx, -1, `${mode}: <tools> section must appear`);
      assert.notEqual(tailIdx, -1, `${mode}: Pi tail must appear`);
      assert.equal(toolUseIdx < toolsIdx && toolsIdx < tailIdx, true, `${mode}: tools must be embedded under ## Tool use before the Pi tail`);
      const lastToolsIdx = result.lastIndexOf("<tools>\n");
      assert.equal(lastToolsIdx < tailIdx, true, `${mode}: <tools> must not appear in the Pi tail`);
    }
  });

  it("preserves Pi-emitted registered-tool snippets and guidelines in the mode prompt", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/ampi-core/prompt.ts");
    const registeredToolLines = [
      "- apply_patch: Apply a Codex-format patch to workspace files",
      "- web_search: Search the public web through Brave Search for a research objective",
      "- read_web_page: Fetch a public http(s) page through mmr-web's custom reader and return Markdown text",
    ];
    const registeredGuidelines = [
      "- Use apply_patch with `*** Begin Patch` / `*** End Patch` envelopes for multi-hunk or multi-file edits.",
      "- Use web_search only for public, non-sensitive research; do not include secrets, API keys, or private data in web_search.objective or web_search.search_queries.",
      "- Use read_web_page only for public http(s) pages; do not use read_web_page for localhost, private IPs, link-local hosts, or non-Internet URLs.",
    ];
    const baseWithRegisteredTools = BASE_PROMPT
      .replace(
        "- bash: Execute bash commands (ls, grep, find, etc.)",
        ["- bash: Execute bash commands (ls, grep, find, etc.)", ...registeredToolLines].join("\n"),
      )
      .replace("<rules>\n", `<rules>\n${registeredGuidelines.join("\n")}\n`);

    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: baseWithRegisteredTools });
      const toolsIdx = result.indexOf("<tools>\n");
      const guidelinesIdx = result.indexOf("<rules>\n");
      const piDocsIdx = result.indexOf("<docs>\n");
      assert.notEqual(toolsIdx, -1, `${mode}: <tools> must appear`);

      for (const line of registeredToolLines) {
        assert.equal(result.split(line).length - 1, 1, `${mode}: registered tool snippet must appear exactly once: ${line}`);
        const lineIdx = result.indexOf(line);
        assert.equal(toolsIdx < lineIdx && lineIdx < guidelinesIdx, true, `${mode}: registered tool snippet must stay in <tools>`);
      }
      for (const line of registeredGuidelines) {
        assert.equal(result.split(line).length - 1, 1, `${mode}: registered tool guideline must appear exactly once: ${line}`);
        const lineIdx = result.indexOf(line);
        assert.equal(guidelinesIdx < lineIdx && lineIdx < piDocsIdx, true, `${mode}: registered tool guideline must stay in <rules>`);
      }
    }
  });

  it("embeds the Pi <rules> section under the Tool use heading and passes every Pi-authored bullet through verbatim", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/ampi-core/prompt.ts");
    // Phase D policy: never edit Pi-authored blocks. The two bullets that
    // earlier versions stripped now pass through alongside the rest.
    const allBullets = [
      "- Be concise in your responses",
      "- Show file paths clearly when working with files",
      "- You can inspect PI_* environment variables for current model and session details.",
      "- Use read to examine files instead of cat or sed.",
      "- Use edit for precise changes (edits[].oldText must match exactly)",
      "- Use write only for new files or complete rewrites.",
    ];

    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: BASE_PROMPT });
      const guidelinesIdx = result.indexOf("<rules>\n");
      const guidelinesEndIdx = result.indexOf("\n</rules>");
      const toolUseIdx = result.indexOf("## Tool use");
      const piDocsIdx = result.indexOf("<docs>\n");
      assert.notEqual(guidelinesIdx, -1, `${mode}: <rules> must appear`);
      assert.equal(toolUseIdx < guidelinesIdx && guidelinesIdx < piDocsIdx, true, `${mode}: <rules> must sit under ## Tool use before <docs>`);
      const rulesSlice = result.slice(guidelinesIdx, guidelinesEndIdx);
      for (const bullet of allBullets) {
        assert.equal(rulesSlice.includes(bullet), true, `${mode}: Pi-authored bullet must pass through verbatim inside <rules>: ${bullet}`);
      }
    }
  });

  it("preserves the Pi tail (project_context, skills, cwd) verbatim from the boundary onward", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/ampi-core/prompt.ts");
    const tailStartIdx = BASE_PROMPT.indexOf("\n\n<project_context>\n");
    assert.notEqual(tailStartIdx, -1, "base.md must contain a <project_context> section");
    const expectedTail = BASE_PROMPT.slice(tailStartIdx);
    assert.match(expectedTail, /\n\n<skills>\n[\s\S]*\n\n<cwd>\n\/test\/cwd\n<\/cwd>\n$/);

    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: BASE_PROMPT });
      assert.equal(result.endsWith(expectedTail), true, `${mode}: tail must be preserved verbatim`);
    }
  });

  it("does not duplicate the <tools> or <rules> sections", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/ampi-core/prompt.ts");

    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: BASE_PROMPT });
      for (const tag of ["<tools>\n", "\n</tools>", "<rules>\n", "\n</rules>"]) {
        const count = result.split(tag).length - 1;
        assert.equal(count, 1, `${mode}: ${JSON.stringify(tag)} must appear exactly once, got ${count}`);
      }
    }
  });

  it("does not emit legacy MMR markers or generated routing/policy sections", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/ampi-core/prompt.ts");
    const forbidden = [
      "<!-- mmr-core",
      "## MMR routing context",
      "## MMR mode prompt",
      "### Routing",
      "### Tool policy",
      "### Unavailable/deferred tools",
      "Active resolved tools:",
      "Missing tools:",
      "Deferred tools:",
    ];
    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: BASE_PROMPT });
      for (const phrase of forbidden) {
        assert.equal(result.includes(phrase), false, `${mode}: must not include ${phrase}`);
      }
    }
  });

  it("returns Pi's prompt unchanged in free mode", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/ampi-core/prompt.ts");
    const state = createState({ mode: "free", displayName: "Free", promptRoute: "default" });
    const result = buildMmrPromptLayer({ state, baseSystemPrompt: BASE_PROMPT });
    assert.equal(result, BASE_PROMPT);
  });

  it("returns Pi's prompt unchanged when boundary anchors are missing", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/ampi-core/prompt.ts");
    const customPrompt = "You are a custom assistant.\n\nNo Pi-style sections here.";
    const state = createState({ mode: "medium" });
    const result = buildMmrPromptLayer({ state, baseSystemPrompt: customPrompt });
    assert.equal(result, customPrompt);
  });

  it("does not emit an MMR prompt block while free mode is active in before_agent_start", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const runtime = await importRuntime();
    const handlers = new Map();
    runtime.setMmrModeState(createState({ mode: "free", displayName: "Free", promptRoute: "default" }));
    extension(buildExtensionStub(handlers));

    const result = await handlers.get("before_agent_start")({
      systemPrompt: BASE_PROMPT,
      systemPromptOptions: { selectedTools: ["read", "bash"] },
    });

    assert.equal(result, undefined);
  });

  it("returns the new system prompt from before_agent_start when mode rewrites Pi's prompt", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const runtime = await importRuntime();
    const handlers = new Map();
    runtime.setMmrModeState(createState({ mode: "high", displayName: "High", promptRoute: "deep", thinkingLevel: "xhigh" }));
    extension(buildExtensionStub(handlers));

    const result = await handlers.get("before_agent_start")({
      systemPrompt: BASE_PROMPT,
      // The selection matches BASE_PROMPT's rendered `<tools>` section,
      // so built-in guidance is identical to the buildMmrPromptLayer fixture.
      systemPromptOptions: {
        selectedTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      },
    });

    assert.equal(result.systemPrompt, readModeFixture("high"));
  });

  it("records and then clears a tool-selection mismatch on the live mode state across turns", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const runtime = await importRuntime();
    const handlers = new Map();
    runtime.setMmrModeState(createState({ mode: "high", displayName: "Deep", promptRoute: "deep", activeTools: ["read", "bash"] }));
    extension(buildExtensionStub(handlers));

    // Pi rendered the prompt from only `read`; `bash` is active but absent
    // from the prompt's tool selection -> reconciliation should flag it.
    await handlers.get("before_agent_start")({
      systemPrompt: BASE_PROMPT,
      systemPromptOptions: { selectedTools: ["read"] },
    });
    assert.deepEqual(runtime.getMmrModeState().promptAssembly, {
      selectedToolsMissingFromPrompt: ["bash"],
    });

    // A clean turn (selection matches active set) clears the observation.
    await handlers.get("before_agent_start")({
      systemPrompt: BASE_PROMPT,
      systemPromptOptions: { selectedTools: ["bash", "read"] },
    });
    assert.equal(runtime.getMmrModeState().promptAssembly, undefined);
  });

  it("drives built-in tool guidance from the prompt's tool selection, not the rendered tools block", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const runtime = await importRuntime();
    const handlers = new Map();
    runtime.setMmrModeState(createState({ mode: "high", displayName: "Deep", promptRoute: "deep", activeTools: ["read", "grep"] }));
    extension(buildExtensionStub(handlers));

    // Pi rendered `<tools>` without grep (snippet-gated), but grep is
    // in the callable selection -> guidance must still cover grep.
    const baseWithoutGrep = BASE_PROMPT.replace(
      "- grep: Search file contents for patterns (respects .gitignore)\n",
      "",
    );
    assert.ok(!baseWithoutGrep.includes("- grep:"));
    const result = await handlers.get("before_agent_start")({
      systemPrompt: baseWithoutGrep,
      systemPromptOptions: { selectedTools: ["read", "grep"] },
    });
    const start = result.systemPrompt.indexOf("## Built-in tool guidance");
    const block = result.systemPrompt.slice(start, result.systemPrompt.indexOf("\n## ", start + 1));
    assert.deepEqual([...block.matchAll(/^([a-z]+):$/gm)].map((m) => m[1]), ["read", "grep"]);
  });

  it("preserves Pi's appendSystemPrompt <addendum> section inserted between the <docs> section and the tail", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/ampi-core/prompt.ts");
    // Pi 1.x renders appendSystemPrompt as its own `<addendum>` section right
    // after `<docs>` and before `<project_context>`.
    const piDocsEnd = BASE_PROMPT.indexOf("\n\n<project_context>\n");
    assert.notEqual(piDocsEnd, -1, "base.md must contain a <project_context> section");
    const beforeTail = BASE_PROMPT.slice(0, piDocsEnd);
    const tail = BASE_PROMPT.slice(piDocsEnd);
    const APPEND_BLOCK = "<addendum>\n## EXTRA APPENDED INSTRUCTIONS\n\nDo something extra.\n</addendum>";
    const promptWithAppend = `${beforeTail}\n\n${APPEND_BLOCK}${tail}`;

    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: promptWithAppend });
      assert.equal(result.includes(APPEND_BLOCK), true, `${mode}: <addendum> section must be preserved`);
      assert.equal(result.endsWith(`\n\n${APPEND_BLOCK}${tail}`), true, `${mode}: <addendum> plus tail must be preserved verbatim`);
      const responseStyleIdx = result.indexOf("## Response style");
      const appendIdx = result.indexOf(APPEND_BLOCK);
      const tailIdx = result.indexOf("<project_context>\n");
      assert.equal(responseStyleIdx < appendIdx && appendIdx < tailIdx, true, `${mode}: append must sit between mode prompt content and tail`);
    }
  });

  it("preserves content prepended by earlier extension handlers before Pi's identity line", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/ampi-core/prompt.ts");
    const PREPENDED = "<!-- earlier-extension:start -->\nEARLIER EXTENSION HEADER\n<!-- earlier-extension:end -->\n\n";
    const promptWithPrepend = `${PREPENDED}${BASE_PROMPT}`;

    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: promptWithPrepend });
      assert.equal(result.startsWith(PREPENDED), true, `${mode}: prepended extension content must be preserved at the start`);
      const identityIdx = result.indexOf("You are an expert coding assistant operating inside pi");
      assert.equal(identityIdx > 0, true, `${mode}: Pi identity line must follow prepended content`);
    }
  });

  it("preserves content appended by extensions after Pi's tail", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/ampi-core/prompt.ts");
    const APPENDED = "\n\n<!-- footer-extension -->\nFOOTER EXTENSION CONTENT";
    const promptWithAppend = `${BASE_PROMPT}${APPENDED}`;

    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: promptWithAppend });
      assert.equal(result.endsWith(APPENDED), true, `${mode}: appended extension content must be preserved at the end`);
    }
  });

  it("preserves the <cwd> section when it directly follows <docs> (no append, no context, no skills)", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/ampi-core/prompt.ts");
    // Minimal Pi 1.x prompt: with no appendSystemPrompt, no context files and
    // no skills, `<cwd>` is the only section after `<docs>`.
    const docsSection = [
      "<docs>",
      "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
      "- Main documentation: /pi/README.md",
      "- Additional docs: /pi/docs",
      "</docs>",
    ].join("\n");
    const cwdSection = "<cwd>\n/test/cwd\n</cwd>";
    const minimalBase = [
      "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
      "",
      "<tools>",
      "- read: Read file contents",
      "- bash: Execute bash commands (ls, grep, find, etc.)",
      "",
      "In addition to the tools above, you may have access to other custom tools depending on the project.",
      "</tools>",
      "",
      "<rules>",
      "- Be concise in your responses",
      "- Show file paths clearly when working with files",
      "</rules>",
      "",
      docsSection,
      "",
      cwdSection,
    ].join("\n");

    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: minimalBase });

      assert.notEqual(result, minimalBase, `${mode}: minimal Pi prompt must still be rewritten`);
      assert.equal(result.endsWith(`\n\n${cwdSection}`), true, `${mode}: <cwd> section must be preserved verbatim at the end`);
      assert.equal(result.split("<cwd>\n").length - 1, 1, `${mode}: <cwd> must appear exactly once`);

      const responseStyleIdx = result.indexOf("## Response style");
      const cwdIdx = result.indexOf("<cwd>\n");
      assert.notEqual(responseStyleIdx, -1, `${mode}: response style heading must appear`);
      assert.equal(responseStyleIdx < cwdIdx, true, `${mode}: <cwd> must come after mode prompt content`);

      const piDocsIdx = result.indexOf("<docs>\n");
      assert.notEqual(piDocsIdx, -1, `${mode}: <docs> section must be embedded`);
      assert.equal(result.slice(piDocsIdx, piDocsIdx + docsSection.length), docsSection, `${mode}: <docs> must be embedded byte-for-byte`);
      const modePostureStartIdx = result.indexOf("## ", piDocsIdx + 1);
      const piDocsSlice = result.slice(piDocsIdx, modePostureStartIdx);
      assert.equal(piDocsSlice.includes("<cwd>"), false, `${mode}: <cwd> must not be embedded inside <docs>`);
      assert.equal(piDocsSlice.includes("/test/cwd"), false, `${mode}: cwd path must not be embedded inside <docs>`);
    }
  });

  it("ignores prepended <tools> / <rules> / <docs> sections that come before Pi's identity line", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/ampi-core/prompt.ts");
    const PREPENDED = [
      "EARLIER EXTENSION HEADER",
      "",
      "<tools>",
      "- fake_tool: fake description",
      "</tools>",
      "",
      "<rules>",
      "- fake guideline",
      "</rules>",
      "",
      "<docs>",
      "Pi documentation (fake):",
      "- fake docs entry",
      "</docs>",
      "",
      "",
    ].join("\n");
    const promptWithPrepend = `${PREPENDED}${BASE_PROMPT}`;

    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: promptWithPrepend });

      const identityIdx = result.indexOf(PI_IDENTITY_LINE);
      const tailIdx = result.indexOf("<project_context>\n");
      assert.notEqual(identityIdx, -1, `${mode}: mode prompt content must be present`);
      assert.notEqual(tailIdx, -1, `${mode}: preserved tail must be present`);
      assert.notEqual(result, promptWithPrepend, `${mode}: prompt must still be rewritten`);

      const modePromptContent = result.slice(identityIdx, tailIdx);
      assert.equal(modePromptContent.includes("- fake_tool: fake description"), false, `${mode}: prepended fake tool must not be embedded as Pi tool`);
      assert.equal(modePromptContent.includes("- fake guideline"), false, `${mode}: prepended fake guideline must not be embedded as Pi guideline`);
      assert.equal(modePromptContent.includes("- fake docs entry"), false, `${mode}: prepended fake docs must not be embedded as Pi docs`);
      // Real Pi tool from BASE_PROMPT must be embedded.
      assert.equal(modePromptContent.includes("- read: Read file contents"), true, `${mode}: real Pi tool must be embedded`);

      // Prepended fake content must still be preserved before the mode prompt.
      const beforeMode = result.slice(0, identityIdx);
      assert.equal(beforeMode, PREPENDED, `${mode}: prepended sections must be preserved verbatim before mode block`);
    }
  });

  it("passes prompt through unchanged when Pi auto-section order is invalid", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/ampi-core/prompt.ts");
    const corrupted = [
      "You are an expert coding assistant operating inside pi, a coding agent harness. You help users.",
      "",
      "<docs>",
      "Pi documentation (out of order):",
      "- doc bullet",
      "</docs>",
      "",
      "<tools>",
      "- read: Read file contents",
      "",
      "In addition to the tools above, you may have access to other custom tools depending on the project.",
      "</tools>",
      "",
      "<rules>",
      "- a guideline",
      "</rules>",
      "",
      "<project_context>",
      "Project-specific instructions and guidelines:",
      "</project_context>",
      "",
      "<cwd>",
      "/test/cwd",
      "</cwd>",
    ].join("\n");

    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: corrupted });
      assert.equal(result, corrupted, `${mode}: invalid section order must pass through unchanged`);
    }
    // Control: the same sections in Pi's real order are rewritten, so the
    // passthrough above is caused by the order, not by missing anchors.
    const reordered = corrupted
      .replace("<docs>\nPi documentation (out of order):\n- doc bullet\n</docs>\n\n", "")
      .replace("</rules>\n\n", "</rules>\n\n<docs>\nPi documentation (out of order):\n- doc bullet\n</docs>\n\n");
    assert.notEqual(buildMmrPromptLayer({ state: createState({ mode: "medium" }), baseSystemPrompt: reordered }), reordered);
  });

  it("does not treat '<docs>' text inside a rule bullet as the start of Pi's <docs> section", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/ampi-core/prompt.ts");
    // The Pi rule body contains the literal substrings `<docs>` and
    // `Pi documentation (`. The parser must anchor to the line-start
    // `\n\n<docs>\n` section opener instead of the substring.
    const poisonRule = "- Do not edit the <docs> section or Pi documentation (README, docs/) unless asked";
    const baseWithPoisonGuideline = [
      "You are an expert coding assistant operating inside pi, a coding agent harness. You help users.",
      "",
      "<tools>",
      "- read: Read file contents",
      "- bash: Execute bash commands (ls, grep, find, etc.)",
      "",
      "In addition to the tools above, you may have access to other custom tools depending on the project.",
      "</tools>",
      "",
      "<rules>",
      poisonRule,
      "- Be concise in your responses",
      "- Show file paths clearly when working with files",
      "</rules>",
      "",
      "<docs>",
      "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
      "- Main documentation: /pi/README.md",
      "- Additional docs: /pi/docs",
      "</docs>",
      "",
      "<project_context>",
      "Project-specific instructions and guidelines:",
      "",
      '<project_instructions path="/test/AGENTS.md">',
      "Test project content.",
      "</project_instructions>",
      "</project_context>",
      "",
      "<cwd>",
      "/test/cwd",
      "</cwd>",
    ].join("\n");

    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: baseWithPoisonGuideline });
      assert.notEqual(result, baseWithPoisonGuideline, `${mode}: prompt must still be rewritten`);

      const tailIdx = result.indexOf("<project_context>\n");
      const realDocsIdx = result.indexOf("<docs>\nPi documentation (read only when the user asks about pi itself");
      assert.notEqual(tailIdx, -1, `${mode}: preserved tail must appear`);
      assert.notEqual(realDocsIdx, -1, `${mode}: real Pi <docs> section must appear`);
      assert.equal(realDocsIdx < tailIdx, true, `${mode}: real Pi <docs> section must be embedded inside mode prompt content, not left in tail`);
      // Tail must not contain a stray Pi docs section.
      const tailSlice = result.slice(tailIdx);
      assert.equal(tailSlice.includes("Pi documentation (read only"), false, `${mode}: real Pi docs header must not survive in the tail`);
      assert.equal(tailSlice.includes("<docs>"), false, `${mode}: no <docs> text may survive in the tail`);
      // The poisoning rule must remain inside the embedded <rules> section.
      const rulesSlice = result.slice(result.indexOf("<rules>\n"), result.indexOf("\n</rules>"));
      assert.equal(rulesSlice.includes(poisonRule), true, `${mode}: poisoning rule must remain in the embedded <rules> section`);
      assert.equal(result.split(poisonRule).length - 1, 1, `${mode}: poisoning rule must appear exactly once`);
    }
  });

  it("does not treat '<tools>' or '<rules>' text inside tool or rule lines as section starts", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/ampi-core/prompt.ts");
    const poisonToolLine = "- read: Read file contents (never rewrite the <rules> or <docs> sections)";
    const poisonRules = [
      "- Reference the <tools> section when in doubt",
      "- See <rules> above for Pi-rendered rules",
    ];
    const baseWithSubstringPoisons = [
      "You are an expert coding assistant operating inside pi, a coding agent harness. You help users.",
      "",
      "<tools>",
      poisonToolLine,
      "",
      "In addition to the tools above, you may have access to other custom tools depending on the project.",
      "</tools>",
      "",
      "<rules>",
      ...poisonRules,
      "- Be concise in your responses",
      "- Show file paths clearly when working with files",
      "</rules>",
      "",
      "<docs>",
      "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
      "- Main documentation: /pi/README.md",
      "</docs>",
      "",
      "<project_context>",
      "Project-specific instructions and guidelines:",
      "",
      '<project_instructions path="/test/AGENTS.md">',
      "Test project content.",
      "</project_instructions>",
      "</project_context>",
      "",
      "<cwd>",
      "/test/cwd",
      "</cwd>",
    ].join("\n");

    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: baseWithSubstringPoisons });
      assert.notEqual(result, baseWithSubstringPoisons, `${mode}: prompt must still be rewritten`);

      // <tools> and <rules> sections must each appear exactly once (no
      // duplication from substring matches inside tool or rule bodies).
      const toolsHeaderCount = result.split(/\n<tools>\n/).length - 1;
      const guidelinesHeaderCount = result.split(/\n<rules>\n/).length - 1;
      assert.equal(toolsHeaderCount, 1, `${mode}: <tools> opener line must appear exactly once`);
      assert.equal(guidelinesHeaderCount, 1, `${mode}: <rules> opener line must appear exactly once`);

      // The poisoning bodies must remain inside their embedded sections, not
      // be misinterpreted as new section openers.
      const toolsSlice = result.slice(result.indexOf("\n<tools>\n"), result.indexOf("\n</tools>"));
      assert.equal(toolsSlice.includes(poisonToolLine), true, `${mode}: substring-poison tool line must remain in <tools>`);
      const rulesSlice = result.slice(result.indexOf("\n<rules>\n"), result.indexOf("\n</rules>"));
      for (const rule of poisonRules) {
        assert.equal(rulesSlice.includes(rule), true, `${mode}: substring-poison rule must remain in <rules>: ${rule}`);
      }
      const tailIdx = result.indexOf("<project_context>\n");
      assert.equal(result.slice(tailIdx).includes(poisonToolLine), false, `${mode}: poison tool line must not leak into the tail`);
    }
  });

  it("never includes future tool advertisements from templates (no static tool name lists from mode templates)", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/ampi-core/prompt.ts");
    const futureToolNames = [
      "finder",
      "oracle",
      "librarian",
      "handoff",
      "read_session",
      "find_session",
    ];
    for (const mode of MODES) {
      const state = createState({ mode });
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: BASE_PROMPT });
      for (const name of futureToolNames) {
        assert.equal(result.includes(name), false, `${mode}: must not include future tool name ${name}`);
      }
    }
  });
});
