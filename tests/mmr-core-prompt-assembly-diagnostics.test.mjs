// Batch A (P0): prompt-assembly drift + active-tool reconciliation diagnostics.
//
// Pins:
//   - assembleActiveSurface() reports WHY it passed Pi's prompt through
//     unchanged via `passthroughReason` (and leaves it undefined on a
//     successful splice).
//   - buildPromptAssemblyObservation() classifies an unexpected passthrough
//     (anchor drift / section reorder) only when Pi supplied structured
//     options and there is no custom system prompt, and reconciles the
//     resolved active tool set against Pi's rendered `selectedTools`.
//   - getMmrPolicyDiagnostics() surfaces both as structured warnings.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const promptFixtureDir = path.join(import.meta.dirname, "fixtures/mmr-core-prompts");
const BASE_PROMPT = readFileSync(path.join(promptFixtureDir, "base.md"), "utf8");

const ASSEMBLY_MODULE = "extensions/mmr-core/prompt-assembly.ts";
const DIAGNOSTICS_MODULE = "extensions/mmr-core/diagnostics.ts";

function makeState(overrides = {}) {
  return {
    version: 1,
    mode: "deep",
    displayName: "Deep",
    source: "settings",
    targetModel: "claude-opus-4-8",
    requestedModels: ["claude-opus-4-8"],
    provider: "claude-subscription",
    model: "claude-opus-4-8",
    modelFound: true,
    modelApplied: true,
    modelFallbackApplied: false,
    modelCandidates: [],
    thinkingLevel: "high",
    promptRoute: "deep",
    requestedTools: ["read", "bash"],
    activeTools: ["read", "bash"],
    missingTools: [],
    deferredTools: [],
    gatedTools: [],
    disabledTools: [],
    featureGates: [],
    availabilityNotes: [],
    resolution: {
      selectedSource: "settings",
      rejectedSources: [],
      modelDecision: { fallbackApplied: false },
      toolDecisions: [],
      featureGateDecisions: [],
    },
    appliedAt: "2026-05-08T00:00:00.000Z",
    ...overrides,
  };
}

describe("assembleActiveSurface(): passthroughReason", () => {
  it("leaves passthroughReason undefined on a successful splice", async () => {
    const { assembleActiveSurface } = await importSource(ASSEMBLY_MODULE);
    const result = assembleActiveSurface({
      state: makeState({ mode: "smart" }),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: [],
    });
    assert.equal(result.passthroughReason, undefined);
    assert.notEqual(result.systemPrompt, BASE_PROMPT);
  });

  it("reports not-prompted-mode for free mode", async () => {
    const { assembleActiveSurface } = await importSource(ASSEMBLY_MODULE);
    const result = assembleActiveSurface({
      state: makeState({ mode: "free" }),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: [],
    });
    assert.equal(result.passthroughReason, "not-prompted-mode");
    assert.equal(result.systemPrompt, BASE_PROMPT);
  });

  it("reports identity-anchor-missing when Pi's identity line is absent", async () => {
    const { assembleActiveSurface } = await importSource(ASSEMBLY_MODULE);
    const result = assembleActiveSurface({
      state: makeState({ mode: "smart" }),
      baseSystemPrompt: "A custom system prompt with no Pi-style head.",
      activeToolManifest: [],
    });
    assert.equal(result.passthroughReason, "identity-anchor-missing");
  });

  it("reports section-anchor-missing when a head section is absent", async () => {
    const { assembleActiveSurface, MMR_IDENTITY_LINE } = await importSource(ASSEMBLY_MODULE);
    // Identity line present, but no Available tools:/Guidelines:/Pi docs sections.
    const base = `${MMR_IDENTITY_LINE} You help users.\n\nSomething else entirely.`;
    const result = assembleActiveSurface({
      state: makeState({ mode: "smart" }),
      baseSystemPrompt: base,
      activeToolManifest: [],
    });
    assert.equal(result.passthroughReason, "section-anchor-missing");
  });

  it("reports section-order-invalid when head sections are out of order", async () => {
    const { assembleActiveSurface, MMR_IDENTITY_LINE } = await importSource(ASSEMBLY_MODULE);
    // Guidelines appears before Available tools -> invalid order.
    const base = [
      `${MMR_IDENTITY_LINE} You help users.`,
      "",
      "Guidelines:",
      "- be nice",
      "",
      "Available tools:",
      "- read: x",
      "",
      "Pi documentation (read only):",
      "- docs",
      "",
      "Current date: 2026-01-01",
    ].join("\n");
    const result = assembleActiveSurface({
      state: makeState({ mode: "smart" }),
      baseSystemPrompt: base,
      activeToolManifest: [],
    });
    assert.equal(result.passthroughReason, "section-order-invalid");
  });
});

describe("buildPromptAssemblyObservation()", () => {
  it("returns undefined for free mode", async () => {
    const { buildPromptAssemblyObservation } = await importSource(DIAGNOSTICS_MODULE);
    const obs = buildPromptAssemblyObservation(
      makeState({ mode: "free" }),
      { passthroughReason: "identity-anchor-missing" },
      { selectedTools: ["read"], customPrompt: undefined },
    );
    assert.equal(obs, undefined);
  });

  it("returns undefined on a clean splice with matching tool selection", async () => {
    const { buildPromptAssemblyObservation } = await importSource(DIAGNOSTICS_MODULE);
    const obs = buildPromptAssemblyObservation(
      makeState({ activeTools: ["read", "bash"] }),
      { passthroughReason: undefined },
      { selectedTools: ["bash", "read"] },
    );
    assert.equal(obs, undefined);
  });

  it("flags an unexpected passthrough when options are present and no custom prompt", async () => {
    const { buildPromptAssemblyObservation } = await importSource(DIAGNOSTICS_MODULE);
    const obs = buildPromptAssemblyObservation(
      makeState({ activeTools: ["read", "bash"] }),
      { passthroughReason: "identity-anchor-missing" },
      { selectedTools: ["read", "bash"] },
    );
    assert.deepEqual(obs, { unexpectedPassthroughReason: "identity-anchor-missing" });
  });

  it("suppresses passthrough drift when a custom system prompt is in use", async () => {
    const { buildPromptAssemblyObservation } = await importSource(DIAGNOSTICS_MODULE);
    const obs = buildPromptAssemblyObservation(
      makeState({ activeTools: ["read", "bash"] }),
      { passthroughReason: "identity-anchor-missing" },
      { selectedTools: ["read", "bash"], customPrompt: "You are a custom assistant." },
    );
    assert.equal(obs, undefined);
  });

  it("does not flag the benign not-prompted-mode passthrough as drift", async () => {
    const { buildPromptAssemblyObservation } = await importSource(DIAGNOSTICS_MODULE);
    const obs = buildPromptAssemblyObservation(
      makeState({ activeTools: ["read", "bash"] }),
      { passthroughReason: "not-prompted-mode" },
      { selectedTools: ["read", "bash"] },
    );
    assert.equal(obs, undefined);
  });

  it("stays silent when the host omits structured options", async () => {
    const { buildPromptAssemblyObservation } = await importSource(DIAGNOSTICS_MODULE);
    const obs = buildPromptAssemblyObservation(
      makeState({ activeTools: ["read", "bash"] }),
      { passthroughReason: "identity-anchor-missing" },
      undefined,
    );
    assert.equal(obs, undefined);
  });

  it("reports tools active but absent from the prompt selection", async () => {
    const { buildPromptAssemblyObservation } = await importSource(DIAGNOSTICS_MODULE);
    const obs = buildPromptAssemblyObservation(
      makeState({ activeTools: ["read", "bash", "edit"] }),
      { passthroughReason: undefined },
      { selectedTools: ["read", "bash"] },
    );
    assert.deepEqual(obs, { selectedToolsMissingFromPrompt: ["edit"] });
  });

  it("reports tools in the prompt selection that the mode did not resolve as active", async () => {
    const { buildPromptAssemblyObservation } = await importSource(DIAGNOSTICS_MODULE);
    const obs = buildPromptAssemblyObservation(
      makeState({ activeTools: ["read"] }),
      { passthroughReason: undefined },
      { selectedTools: ["read", "write", "bash"] },
    );
    assert.deepEqual(obs, { selectedToolsExtraInPrompt: ["bash", "write"] });
  });
});

describe("getMmrPolicyDiagnostics(): prompt-assembly observations", () => {
  it("emits prompt.head-not-applied for an unexpected passthrough", async () => {
    const { getMmrPolicyDiagnostics } = await importSource(DIAGNOSTICS_MODULE);
    const diagnostics = getMmrPolicyDiagnostics(
      makeState({ promptAssembly: { unexpectedPassthroughReason: "identity-anchor-missing" } }),
    );
    assert.deepEqual(diagnostics.map((d) => d.code), ["prompt.head-not-applied"]);
    assert.equal(diagnostics[0].severity, "warning");
    assert.equal(diagnostics[0].source, "mmr-core");
    assert.match(diagnostics[0].message, /not applied/);
    assert.deepEqual(diagnostics[0].data, { reason: "identity-anchor-missing" });
  });

  it("emits tools.prompt-selection-mismatch with missing and extra tools", async () => {
    const { getMmrPolicyDiagnostics } = await importSource(DIAGNOSTICS_MODULE);
    const diagnostics = getMmrPolicyDiagnostics(
      makeState({
        promptAssembly: {
          selectedToolsMissingFromPrompt: ["edit"],
          selectedToolsExtraInPrompt: ["write"],
        },
      }),
    );
    assert.deepEqual(diagnostics.map((d) => d.code), ["tools.prompt-selection-mismatch"]);
    assert.match(diagnostics[0].message, /edit/);
    assert.match(diagnostics[0].message, /write/);
    assert.deepEqual(diagnostics[0].data, { missingFromPrompt: ["edit"], extraInPrompt: ["write"] });
  });

  it("emits nothing extra for a clean state", async () => {
    const { getMmrPolicyDiagnostics } = await importSource(DIAGNOSTICS_MODULE);
    assert.deepEqual(getMmrPolicyDiagnostics(makeState()), []);
  });
});
