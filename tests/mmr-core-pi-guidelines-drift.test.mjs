// Drift guard for Pi's constant `<rules>` composition and section layout.
//
// Mode-derived subagent workers rebuild their `<rules>` section from the
// worker's profile-filtered manifest (see
// src/extensions/ampi-core/subagent-prompt-assembly.ts:buildWorkerGuidelinesBlock),
// reproducing Pi's `buildRules` composition. Per-tool bullets are Pi's own
// data flowing through the manifest, but the conditional shell-exploration
// bullets and the two always-on bullets are Pi-owned *constants* reproduced
// from a pinned Pi version. The worker prompt has no runtime drift validator
// (unlike the parent path), so this test is the tripwire: if Pi changes those
// constant rules on a dependency bump, this fails loudly instead of letting
// the worker prompt diverge silently.
//
// The second test renders a prompt with the installed Pi's real
// `buildSystemPrompt` and runs ampi's parent splice over it, so a Pi layout
// change that would make ampi silently fall back to passthrough fails here.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

// Resolve the installed Pi package via its ESM entry (the package's
// `exports` map does not expose `package.json`, `dist/core/*` or a CJS
// `require`, so `import.meta.resolve` is the robust hoisting-agnostic lookup).
function resolvePiRoot() {
  const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  return path.resolve(path.dirname(piEntry), "..");
}

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
    requestedTools: ["Read", "Bash"],
    activeTools: ["read", "bash"],
    missingTools: [],
    deferredTools: [],
    featureGates: [],
    availabilityNotes: [],
    appliedAt: "2026-05-08T00:00:00.000Z",
  };
}

/** Return the whole `<name>…</name>` section of a Pi-rendered prompt. */
function piSection(prompt, name) {
  const open = `\n\n<${name}>\n`;
  const close = `\n</${name}>`;
  const start = prompt.indexOf(open);
  assert.notEqual(start, -1, `Pi prompt has no <${name}> section`);
  const end = prompt.indexOf(close, start);
  assert.notEqual(end, -1, `Pi prompt has an unterminated <${name}> section`);
  return prompt.slice(start + 2, end + close.length);
}

describe("Pi rules composition drift guard", () => {
  it("our reproduced constant rules still match Pi's buildRules", async () => {
    const { PI_CONSTANT_GUIDELINES, PI_ALWAYS_ON_GUIDELINES } = await importSource(
      "extensions/ampi-core/subagent-prompt-assembly.ts",
    );

    const mapPath = path.join(resolvePiRoot(), "dist/core/system-prompt.js.map");

    // Match against the sourcemap's `sourcesContent` (the unminified original,
    // the same source we extracted the algorithm from) so dist minification
    // cannot defeat the check.
    let raw;
    try {
      raw = readFileSync(mapPath, "utf8");
    } catch (err) {
      assert.fail(
        "Pi system-prompt sourcemap not found at " + mapPath + " (" + (err?.code ?? err) + "); " +
          "the drift guard can no longer verify Pi's constant rules — re-evaluate " +
          "buildWorkerGuidelinesBlock against the installed Pi build.",
      );
    }
    const map = JSON.parse(raw);
    const src = (map.sourcesContent ?? []).join("\n");
    assert.ok(
      src.includes("buildSystemPrompt") && src.includes("function buildRules"),
      "could not locate Pi system-prompt source (buildSystemPrompt/buildRules); re-evaluate drift guard",
    );

    // Every literal `addRule("…")` call is one of Pi's constant rules. The
    // per-tool and prompt-guideline loops call `addRule(<variable>)`, so they
    // are not captured by this string-literal scan.
    const literals = [...src.matchAll(/addRule\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g)].map((m) =>
      JSON.parse(`"${m[1]}"`),
    );
    assert.ok(literals.length > 0, "found no addRule(\"…\") literals; Pi renamed its rule helper");
    assert.deepEqual(
      new Set(literals),
      new Set(PI_CONSTANT_GUIDELINES),
      "Pi's constant rules changed; re-sync buildWorkerGuidelinesBlock (PI_CONSTANT_GUIDELINES constants + the shell-exploration conditional)",
    );

    // The literal scan ignores ordering and the conditional logic. Pin the
    // shell-exploration condition, its three variants, and the always-on
    // bullet order too, so a change to those (without changing the literal
    // strings) still trips.
    const condensed = src.replace(/\s+/g, " ");
    assert.ok(
      condensed.includes("(hasBash || hasPowerShell) && !hasGrep && !hasFind && !hasLs"),
      "Pi changed the shell-exploration conditional; re-sync buildWorkerGuidelinesBlock's tool-name guard",
    );
    const variantChain = [
      'if (hasBash && hasPowerShell) { addRule("Use bash or PowerShell for file operations like listing, searching, and finding files"); }',
      'else if (hasPowerShell) { addRule("Use PowerShell for file operations like listing, searching, and finding files"); }',
      'else { addRule("Use bash for file operations like ls, rg, find"); }',
    ].join(" ");
    assert.ok(
      condensed.includes(variantChain),
      "Pi changed which shell-exploration variant applies to which tool set; re-sync buildWorkerGuidelinesBlock",
    );
    const alwaysOnIdx = PI_ALWAYS_ON_GUIDELINES.map((rule) => src.indexOf(`addRule("${rule}")`));
    for (const [i, idx] of alwaysOnIdx.entries()) {
      assert.notEqual(idx, -1, `Pi no longer always-adds "${PI_ALWAYS_ON_GUIDELINES[i]}"`);
    }
    assert.deepEqual(
      [...alwaysOnIdx].sort((a, b) => a - b),
      alwaysOnIdx,
      "Pi reordered its always-on rules; re-sync PI_ALWAYS_ON_GUIDELINES order",
    );
    assert.ok(
      alwaysOnIdx[0] > src.indexOf("for (const rule of promptGuidelines) addRule(rule);"),
      "Pi's always-on rules no longer follow the per-tool/prompt rules; re-sync buildWorkerGuidelinesBlock",
    );
  });

  it("ampi splices the installed Pi's real buildSystemPrompt output for every prompted mode", async () => {
    const piRoot = resolvePiRoot();
    const systemPromptUrl = pathToFileURL(path.join(piRoot, "dist/core/system-prompt.js")).href;
    const { buildSystemPrompt } = await import(systemPromptUrl);
    const { assembleActiveSurface } = await importSource("extensions/ampi-core/prompt-assembly.ts");

    const appendSystemPrompt = "Append prompt from the real-Pi drift guard.";
    const contextContent = "Real-Pi drift guard project instructions.";
    // Section bodies may contain blank lines: a multi-paragraph tool rule and,
    // in the second variant, a multi-paragraph `sections.docs` override.
    for (const docsOverride of [undefined, "Docs override first paragraph.\n\nDocs override second paragraph."]) {
      const base = buildSystemPrompt({
        cwd: "/drift/cwd",
        selectedTools: ["read", "bash", "edit", "write"],
        toolSnippets: {
          read: "Read file contents",
          bash: "Execute bash commands",
          edit: "Edit files",
          write: "Write files",
        },
        toolGuidelines: {
          read: ["Use read to examine files instead of cat or sed."],
          edit: ["Use edit for precise changes.\n\nSecond paragraph of the edit rule."],
        },
        promptGuidelines: ["Drift guard prompt rule."],
        appendSystemPrompt,
        contextFiles: [{ path: "/drift/AGENTS.md", content: contextContent }],
        ...(docsOverride ? { sections: { docs: docsOverride } } : {}),
      });

      const tools = piSection(base, "tools");
      const rules = piSection(base, "rules");
      const docs = piSection(base, "docs");
      // Sanity: the inputs actually reached Pi's sections.
      assert.match(tools, /^<tools>\n- read: Read file contents\n/);
      assert.match(rules, /\n- Use bash for file operations like ls, rg, find\n/);
      assert.match(rules, /\n- Drift guard prompt rule\.\n/);
      assert.match(rules, /precise changes\.\n\nSecond paragraph of the edit rule\.\n/);
      if (docsOverride) assert.equal(docs, `<docs>\n${docsOverride}\n</docs>`);
      else assert.match(docs, /^<docs>\nPi documentation \(/);
      const tailStart = base.indexOf("\n\n<addendum>\n");
      assert.notEqual(tailStart, -1, "Pi prompt has no <addendum> section");
      const tail = base.slice(tailStart);
      assert.ok(tail.includes(`<addendum>\n${appendSystemPrompt}\n</addendum>`));
      assert.ok(tail.includes(`<project_instructions path="/drift/AGENTS.md">\n${contextContent}\n</project_instructions>`));
      assert.ok(tail.endsWith("\n\n<cwd>\n/drift/cwd\n</cwd>"), "Pi prompt must end with its <cwd> section");

      for (const mode of ["low", "medium", "high", "ultra"]) {
        const result = assembleActiveSurface({
          state: createState(mode),
          baseSystemPrompt: base,
          activeToolManifest: [],
        });
        assert.equal(
          result.passthroughReason,
          undefined,
          `${mode}: ampi fell back to passthrough on the installed Pi's prompt layout`,
        );
        assert.notEqual(result.systemPrompt, base, `${mode}: prompt must be rewritten`);
        assert.match(result.systemPrompt, new RegExp(`<mmr_mode name="${mode}">`));

        const byKind = Object.fromEntries(result.blocks.map((block) => [block.kind, block]));
        assert.equal(byKind["active-tools"].text, `${tools}\n\n`, `${mode}: <tools> must be byte-identical`);
        assert.equal(byKind["active-guidelines"].text, `${rules}\n\n`, `${mode}: <rules> must be byte-identical`);
        assert.equal(byKind["pi-docs"].text, `${docs}\n\n`, `${mode}: <docs> must be byte-identical`);
        assert.equal(byKind["preserved-tail"].text, tail, `${mode}: Pi's tail must be preserved byte-for-byte`);
        assert.ok(result.systemPrompt.endsWith(tail), `${mode}: assembled prompt must end with Pi's tail`);

        const order = ["<tools>\n", "<rules>\n", "<docs>\n", "<addendum>\n", "<project_context>\n", "<cwd>\n"].map(
          (marker) => result.systemPrompt.indexOf(marker),
        );
        for (const idx of order) assert.notEqual(idx, -1, `${mode}: missing Pi section`);
        assert.deepEqual([...order].sort((a, b) => a - b), order, `${mode}: Pi sections out of order`);
        assert.equal(result.blocks.map((block) => block.text).join(""), result.systemPrompt);
      }
    }
  });
});
