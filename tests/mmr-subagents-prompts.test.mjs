// Phase 3: mmr-subagents prompt-builder registration.
//
// Pins the contract that concrete subagent prompt text lives in
// `mmr-subagents` (not in `mmr-core`) and is wired into the
// prompt-assembly registry via `registerMmrSubagentsPromptBuilders()`.
//
// Behavior pinned here:
//   - mmr-subagents exposes `buildFinderWorkerSystemPrompt(cwd)` and
//     `registerMmrSubagentsPromptBuilders()` from its `prompts.ts`.
//   - After registration, mmr-core's `assembleMmrSubagentSurface` returns
//     the finder builder's output byte-for-byte as the standalone
//     systemPrompt for the canonical finder profile.
//   - Before registration, `assembleMmrSubagentSurface` for finder fails
//     closed (no silent fallback to an empty prompt).
//   - The text the registered builder produces is identical to the legacy
//     `buildFinderWorkerSystemPrompt(cwd)` so the existing finder behavior
//     is preserved exactly.

import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const PROMPTS_MODULE = "extensions/ampi-workers/prompts.ts";
const ASSEMBLY_MODULE = "extensions/ampi-core/subagent-prompt-assembly.ts";
const PROFILES_MODULE = "extensions/ampi-core/subagent-profiles.ts";

describe("mmr-subagents prompts.ts public surface", () => {
  it("exports buildFinderWorkerSystemPrompt and registerMmrSubagentsPromptBuilders", async () => {
    const mod = await importSource(PROMPTS_MODULE);
    assert.equal(typeof mod.buildFinderWorkerSystemPrompt, "function");
    assert.equal(typeof mod.registerMmrSubagentsPromptBuilders, "function");
  });

  it("exports buildOracleWorkerSystemPrompt", async () => {
    const mod = await importSource(PROMPTS_MODULE);
    assert.equal(typeof mod.buildOracleWorkerSystemPrompt, "function");
  });

  it("exports buildLibrarianWorkerSystemPrompt", async () => {
    const mod = await importSource(PROMPTS_MODULE);
    assert.equal(typeof mod.buildLibrarianWorkerSystemPrompt, "function");
  });

  it("buildOracleWorkerSystemPrompt produces the canonical oracle prompt text", async () => {
    const { buildOracleWorkerSystemPrompt } = await importSource(PROMPTS_MODULE);
    const prompt = buildOracleWorkerSystemPrompt("/abs/repo");
    assert.match(prompt, /You are the Oracle - an expert AI advisor with advanced reasoning capabilities\./);
    assert.match(prompt, /You are a subagent inside an AI coding system/);
    assert.match(prompt, /invoked in a zero-shot manner/);
    assert.match(prompt, /Key responsibilities:/);
    assert.match(prompt, /Working directory: \/abs\/repo/);
    assert.match(prompt, /Workspace root: \/abs\/repo/);
    assert.match(prompt, /Operating principles \(simplicity-first\):/);
    assert.match(prompt, /Apply YAGNI and KISS/);
    assert.match(prompt, /S <1h, M 1\u20133h, L 1\u20132d, XL >2d/);
    assert.match(prompt, /Tool usage:/);
    assert.match(prompt, /Never invent placeholder roots like \/workspace, \/repo, or \/project/);
    assert.match(prompt, /Response format \(keep it concise and action-oriented\):/);
    assert.match(prompt, /TL;DR/);
    assert.match(prompt, /Recommended approach \(simple path\)/);
    assert.match(prompt, /Rationale and trade-offs/);
    assert.match(prompt, /Risks and guardrails/);
    assert.match(prompt, /When to consider the advanced path/);
    assert.match(prompt, /Optional advanced path/);
    assert.match(prompt, /IMPORTANT: Only your last message is returned/);
  });

  it("buildOracleWorkerSystemPrompt falls back to a safe placeholder when cwd is missing", async () => {
    const { buildOracleWorkerSystemPrompt } = await importSource(PROMPTS_MODULE);
    const prompt = buildOracleWorkerSystemPrompt("");
    assert.doesNotMatch(prompt, /Working directory: \n/);
    assert.match(prompt, /Working directory:\s+\S/);
    assert.match(prompt, /Workspace root:\s+\S/);
  });

  it("buildLibrarianWorkerSystemPrompt produces the canonical repository research prompt", async () => {
    const { buildLibrarianWorkerSystemPrompt } = await importSource(PROMPTS_MODULE);
    const prompt = buildLibrarianWorkerSystemPrompt("/abs/repo");
    assert.match(prompt, /You are Librarian, a specialized repository research worker\./);
    assert.match(prompt, /## Responsibilities/);
    assert.match(prompt, /Explore remote repository code and directory structure/);
    assert.match(prompt, /Use commit history, diffs, and file revisions/);
    assert.match(prompt, /## Available tools and coverage/);
    assert.match(prompt, /reads public GitHub repositories/);
    assert.match(prompt, /Search code inside a repository/);
    assert.match(prompt, /Compare two refs/);
    assert.match(prompt, /github\.com\/<owner>\/<repo>\/blob\/<revision>/);
    assert.match(prompt, /Do not invent findings or provide a[\s\n]+memory-based summary/);
    assert.match(prompt, /Every code block must include a language identifier/);
    assert.match(prompt, /Never name tools in the user-facing answer/);
    assert.match(prompt, /Use fluent links/);
    assert.doesNotMatch(prompt, /Working directory:/);
  });

  it("buildFinderWorkerSystemPrompt produces the canonical finder prompt text", async () => {
    const { buildFinderWorkerSystemPrompt } = await importSource(PROMPTS_MODULE);
    const prompt = buildFinderWorkerSystemPrompt("/abs/repo");
    // Same assertions the existing finder.ts suite pins.
    assert.match(prompt, /\/abs\/repo/);
    assert.match(prompt, /Workspace root: \/abs\/repo/);
    assert.match(prompt, /\bgrep\b/);
    assert.match(prompt, /\bfind\b/);
    assert.match(prompt, /\bread\b/);
    assert.match(prompt, /8\+ parallel tool calls/);
    assert.match(prompt, /within 3 turns/);
    assert.match(prompt, /Ultra concise/);
  });
});

describe("registerMmrSubagentsPromptBuilders wiring", () => {
  let assembleMmrSubagentSurface;
  let clearMmrSubagentPromptBuilders;
  let getMmrSubagentProfile;
  let registerMmrSubagentsPromptBuilders;
  let buildFinderWorkerSystemPrompt;

  beforeEach(async () => {
    const assembly = await importSource(ASSEMBLY_MODULE);
    const profiles = await importSource(PROFILES_MODULE);
    const prompts = await importSource(PROMPTS_MODULE);
    assembleMmrSubagentSurface = assembly.assembleMmrSubagentSurface;
    clearMmrSubagentPromptBuilders = assembly.clearMmrSubagentPromptBuilders;
    getMmrSubagentProfile = profiles.getMmrSubagentProfile;
    registerMmrSubagentsPromptBuilders = prompts.registerMmrSubagentsPromptBuilders;
    buildFinderWorkerSystemPrompt = prompts.buildFinderWorkerSystemPrompt;
    clearMmrSubagentPromptBuilders();
  });

  it("fails closed when assembleMmrSubagentSurface is called for finder before registration", () => {
    assert.throws(
      () =>
        assembleMmrSubagentSurface({
          profile: getMmrSubagentProfile("finder"),
          baseSystemPrompt: "",
          activeToolManifest: [],
          cwd: "/abs/repo",
        }),
      /finder|prompt builder|not registered/i,
    );
  });

  it("wires the finder prompt builder into the mmr-core registry", () => {
    registerMmrSubagentsPromptBuilders();
    const result = assembleMmrSubagentSurface({
      profile: getMmrSubagentProfile("finder"),
      baseSystemPrompt: "",
      activeToolManifest: [],
      cwd: "/abs/repo",
    });
    assert.equal(result.subagent, "finder");
    // Builder output must match the canonical legacy prompt exactly.
    assert.equal(result.systemPrompt, buildFinderWorkerSystemPrompt("/abs/repo"));
  });

  it("is idempotent (registering twice does not change observable output)", () => {
    registerMmrSubagentsPromptBuilders();
    registerMmrSubagentsPromptBuilders();
    const result = assembleMmrSubagentSurface({
      profile: getMmrSubagentProfile("finder"),
      baseSystemPrompt: "",
      activeToolManifest: [],
      cwd: "/abs/repo",
    });
    assert.equal(result.systemPrompt, buildFinderWorkerSystemPrompt("/abs/repo"));
  });

  it("fails closed when assembleMmrSubagentSurface is called for oracle before registration", async () => {
    const profile = getMmrSubagentProfile("oracle");
    assert.ok(profile, "oracle profile must be present in mmr-core for this test to apply");
    assert.throws(
      () =>
        assembleMmrSubagentSurface({
          profile,
          baseSystemPrompt: "",
          activeToolManifest: [],
          cwd: "/abs/repo",
        }),
      /oracle|prompt builder|not registered/i,
    );
  });

  it("wires the oracle prompt builder into the mmr-core registry", async () => {
    const { buildOracleWorkerSystemPrompt } = await importSource(PROMPTS_MODULE);
    registerMmrSubagentsPromptBuilders();
    const result = assembleMmrSubagentSurface({
      profile: getMmrSubagentProfile("oracle"),
      baseSystemPrompt: "",
      activeToolManifest: [],
      cwd: "/abs/repo",
    });
    assert.equal(result.subagent, "oracle");
    assert.equal(result.systemPrompt, buildOracleWorkerSystemPrompt("/abs/repo"));
  });

  it("wires the librarian prompt builder into the mmr-core registry", async () => {
    const { buildLibrarianWorkerSystemPrompt } = await importSource(PROMPTS_MODULE);
    registerMmrSubagentsPromptBuilders();
    const result = assembleMmrSubagentSurface({
      profile: getMmrSubagentProfile("librarian"),
      baseSystemPrompt: "",
      activeToolManifest: [],
      cwd: "/abs/repo",
    });
    assert.equal(result.subagent, "librarian");
    assert.equal(result.systemPrompt, buildLibrarianWorkerSystemPrompt("/abs/repo"));
  });
});
