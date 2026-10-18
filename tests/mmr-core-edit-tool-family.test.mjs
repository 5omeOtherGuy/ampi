import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const CODEX_SOL = { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 400000 };
const CLAUDE_OPUS = { provider: "claude-subscription", id: "claude-opus-4-8", contextWindow: 200000 };
const PI_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "apply_patch"].map((name) => ({ name }));

async function importRuntime() {
  const runtimeUrl = pathToFileURL(path.join(getPreparedSourceRoot(), "extensions/ampi-core/runtime.ts")).href;
  return import(runtimeUrl);
}

// The shared stub records emits only; these tests need ampi-core's own
// state-change subscription to run, as it does on Pi's event bus.
function withEventBus(pi) {
  const listeners = new Map();
  pi.events = {
    emit: (name, data) => {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(data);
    },
    on: (name, listener) => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
      return () => listeners.set(name, (listeners.get(name) ?? []).filter((entry) => entry !== listener));
    },
  };
  return pi;
}

function writeProjectSettings(cwd, ampiCore) {
  mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  writeFileSync(path.join(cwd, ".pi/settings.json"), JSON.stringify({ ampiCore }));
}

beforeEach(async () => {
  const runtime = await importRuntime();
  runtime.setMmrModeState(undefined);
  runtime.setMmrSubagentState(undefined);
  runtime.clearMmrManagedModelOverride();
});

describe("ampi-core edit tool family - provider routing", () => {
  it("gives OpenAI-family providers apply_patch and every other provider edit", async () => {
    const { resolveMmrEditToolFamily } = await importSource("extensions/ampi-core/modes.ts");
    const expected = {
      openai: "patch",
      "openai-codex": "patch",
      azure: "patch",
      anthropic: "edit",
      "claude-subscription": "edit",
      "github-copilot": "edit",
      "some-new-provider": "edit",
      "": "edit",
    };
    for (const [provider, family] of Object.entries(expected)) {
      assert.deepEqual(resolveMmrEditToolFamily(provider), { family, source: "provider", provider }, provider);
      assert.deepEqual(resolveMmrEditToolFamily(provider, "auto"), { family, source: "provider", provider }, provider);
    }
  });

  it("lets a forced setting override the provider in both directions", async () => {
    const { resolveMmrEditToolFamily } = await importSource("extensions/ampi-core/modes.ts");
    assert.deepEqual(resolveMmrEditToolFamily("openai-codex", "edit"), { family: "edit", source: "setting", provider: "openai-codex" });
    assert.deepEqual(resolveMmrEditToolFamily("anthropic", "patch"), { family: "patch", source: "setting", provider: "anthropic" });
  });

  it("puts the family's tool right after write and lists no tool nothing provides", async () => {
    const { getMmrModeToolNames } = await importSource("extensions/ampi-core/modes.ts");
    for (const mode of ["low", "medium", "high", "ultra"]) {
      for (const [family, tool, other] of [["patch", "apply_patch", "edit"], ["edit", "edit", "apply_patch"]]) {
        const names = getMmrModeToolNames(mode, family);
        assert.equal(names[names.indexOf("write") + 1], tool, `${mode}/${family}`);
        assert.equal(names.includes(other), false, `${mode}/${family}`);
        for (const unbacked of ["handoff", "chart", "skill"]) {
          assert.equal(names.includes(unbacked), false, `${mode}/${family} must not list ${unbacked}`);
        }
      }
    }
    assert.deepEqual(getMmrModeToolNames("free", "patch"), []);
  });

  it("reads ampiCore.editTools and warns about an unknown value", async () => {
    const { loadMmrCoreSettings } = await importSource("extensions/ampi-core/settings.ts");
    const root = mkdtempSync(path.join(tmpdir(), "ampi-edit-tools-"));
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    try {
      mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
      writeFileSync(path.join(home, ".pi/agent/settings.json"), JSON.stringify({ ampiCore: { editTools: "patch" } }));
      writeProjectSettings(cwd, { editTools: "edit" });
      assert.equal(loadMmrCoreSettings(cwd, home).settings.editTools, "edit", "project overrides global");

      writeProjectSettings(cwd, { editTools: "apply_patch" });
      const loaded = loadMmrCoreSettings(cwd, home);
      assert.equal(loaded.settings.editTools, "patch", "an invalid project value leaves the global one");
      assert.match(loaded.warnings.join("\n"), /ampiCore\.editTools .*expected "auto", "patch", or "edit"/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("ampi-core edit tool family - activation", () => {
  async function activate(mode, models, settings) {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const runtime = await importRuntime();
    const { formatMmrStatus } = await importSource("extensions/ampi-core/status.ts");
    const cwd = mkdtempSync(path.join(tmpdir(), "ampi-edit-tools-"));
    try {
      if (settings) writeProjectSettings(cwd, settings);
      const { pi, calls, commands, handlers } = createMockPi({ allTools: PI_TOOLS, setModelResult: true });
      withEventBus(pi);
      const { ctx } = createMockExtensionContext({ cwd, models, authenticated: true });
      extension(pi);
      if (settings) await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
      await commands.get("mode").handler(mode, ctx);
      const state = runtime.getMmrModeState();
      return { active: calls.setActiveTools.at(-1), state, status: formatMmrStatus(state) };
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  it("activates apply_patch on an OpenAI-family route and says why in /ampi-status", async () => {
    const { active, state, status } = await activate("medium", [CODEX_SOL]);
    assert.equal(state.provider, "openai-codex");
    assert.equal(active.includes("apply_patch"), true);
    assert.equal(active.includes("edit"), false);
    assert.equal(active.includes("write"), true);
    assert.deepEqual(state.editTools, { family: "patch", source: "provider", provider: "openai-codex" });
    assert.match(status, /^Edit tools: apply_patch, write \(auto: openai-codex is an OpenAI-family provider\)$/m);
  });

  it("activates edit on an Anthropic route", async () => {
    const { active, state, status } = await activate("high", [CLAUDE_OPUS]);
    assert.equal(state.provider, "claude-subscription");
    assert.equal(active.includes("edit"), true);
    assert.equal(active.includes("apply_patch"), false);
    assert.match(status, /^Edit tools: edit, write \(auto: claude-subscription is not an OpenAI-family provider\)$/m);
  });

  it("follows a forced ampiCore.editTools over the route's provider", async () => {
    const { active, state, status } = await activate("high", [CODEX_SOL], { editTools: "edit" });
    assert.equal(state.provider, "openai-codex");
    assert.equal(active.includes("edit"), true);
    assert.equal(active.includes("apply_patch"), false);
    assert.match(status, /^Edit tools: edit, write \(ampiCore\.editTools is "edit"\)$/m);
  });
});

describe("ampi-core edit tool family - session fallback", () => {
  it("swaps apply_patch for edit when a resumed session fallback moves the route to Anthropic", async () => {
    const core = (await importSource("extensions/ampi-core/index.ts")).default;
    const fallback = (await importSource("extensions/ampi-session-fallback/index.ts")).default;
    const { AMPI_SESSION_FALLBACK_ENTRY, toPersistedMmrSessionFallbackOverride } = await importSource(
      "extensions/ampi-session-fallback/state.ts",
    );
    const fallbackRuntime = await importSource("extensions/ampi-session-fallback/runtime.ts");
    fallbackRuntime.clearMmrSessionFallbackOverrides();
    const runtime = await importRuntime();

    const { pi, calls, handlers } = createMockPi({ allTools: PI_TOOLS, setModelResult: true });
    withEventBus(pi);
    const { ctx, entries } = createMockExtensionContext({
      sessionId: "session-1",
      models: [CODEX_SOL, CLAUDE_OPUS],
      authenticated: true,
    });
    entries.push({ type: "custom", customType: "ampi-core.mode-state", data: { version: 1, mode: "medium", source: "command" } });
    entries.push({
      type: "custom",
      customType: AMPI_SESSION_FALLBACK_ENTRY,
      data: toPersistedMmrSessionFallbackOverride({
        sessionId: "session-1",
        mode: "medium",
        failingProvider: "openai-codex",
        failingModel: "gpt-5.6-sol",
        selectedProvider: "claude-subscription",
        selectedModel: "claude-opus-4-8",
        thinkingLevel: "medium",
        reasonKind: "openai-usage-limit",
        appliedAt: "2026-10-18T00:00:00.000Z",
      }),
    });
    core(pi);
    fallback(pi);

    await handlers.get("session_start")({ type: "session_start", reason: "resume" }, ctx);

    const [modeApply, fallbackApply] = calls.setActiveTools.slice(-2);
    assert.equal(modeApply.includes("apply_patch"), true, "medium starts on the Codex route");
    assert.equal(fallbackApply.includes("edit"), true, "the fallback route gets edit");
    assert.equal(fallbackApply.includes("apply_patch"), false);
    assert.deepEqual(
      fallbackApply.filter((name) => name !== "edit"),
      modeApply.filter((name) => name !== "apply_patch"),
      "only the file-editing tool changes",
    );

    const state = runtime.getMmrModeState();
    assert.equal(state.provider, "claude-subscription");
    assert.equal(state.modelFallbackApplied, true);
    assert.deepEqual(state.editTools, { family: "edit", source: "provider", provider: "claude-subscription" });
    assert.deepEqual(state.activeTools, fallbackApply);
    assert.equal(runtime.isToolAllowed("edit"), true);
    assert.equal(runtime.isToolAllowed("apply_patch"), false);
  });
});
