// Fast speed: the payload transform and provider table, the per-session speed
// (session entries, --ampi-fast, ampi.speed), the request hook, the
// speed.toggleFast command and Alt+R shortcut, and the /ampi-status line.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

const SOL = { provider: "openai", id: "gpt-5.6-sol", contextWindow: 400_000, maxTokens: 128_000 };
const GPT_55 = { provider: "openai", id: "gpt-5.5", contextWindow: 400_000, maxTokens: 128_000 };
const CODEX_SOL = { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 400_000, maxTokens: 128_000 };
const OPUS = { provider: "anthropic", id: "claude-opus-4-8", contextWindow: 1_000_000, maxTokens: 128_000 };

const responsesPayload = () => ({ model: "gpt-5.6-sol", input: [], max_output_tokens: 4096, reasoning: { effort: "low" } });
const codexPayload = () => ({ model: "gpt-5.6-sol", input: [], instructions: "system", text: { verbosity: "low" } });
const anthropicPayload = () => ({ model: "claude-opus-4-8", messages: [], max_tokens: 4096, system: "system" });
const speedEntry = (speed) => ({ type: "custom", customType: "ampi-speed", data: { speed } });

let speed;
let runtime;
let registry;
let chromeOwner;
let home;
const previousHome = process.env.HOME;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "ampi-speed-"));
  process.env.HOME = home;
  speed = await importSource("extensions/ampi-core/speed.ts");
  registry = await importSource("extensions/ampi-core/command-registry.ts");
  chromeOwner = await importSource("extensions/ampi-core/chrome-owner.ts");
  runtime = await import(pathToFileURL(path.join(getPreparedSourceRoot(), "extensions/ampi-core/runtime.ts")).href);
});

after(() => {
  process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  cleanupLoadedSource();
});

beforeEach(() => {
  runtime.setMmrModeState(undefined);
  runtime.setMmrSubagentState(undefined);
  runtime.clearMmrManagedModelOverride();
  speed.setMmrSpeed("standard");
  rmSync(path.join(home, ".pi"), { recursive: true, force: true });
});

/** A project directory under the test home, with `.pi/settings.json` when `settings` is given. */
function project(settings) {
  const cwd = mkdtempSync(path.join(home, "project-"));
  if (settings) {
    mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify(settings));
  }
  return cwd;
}

function globalSettings(settings) {
  mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify(settings));
}

async function startSession({ model = SOL, entries = [], cwd = project(), flags = {}, mode } = {}) {
  const extension = (await importSource("extensions/ampi-core/index.ts")).default;
  const mock = createMockPi({
    activeTools: ["read", "bash", "grep"],
    allTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    thinkingLevel: "medium",
    initialModel: model,
    flags: { ...(mode ? { "ampi-mode": mode } : {}), ...flags },
  });
  const context = createMockExtensionContext({ models: [SOL, GPT_55, CODEX_SOL, OPUS], model, entries, cwd });
  extension(mock.pi);
  await mock.handlers.get("session_start")({ type: "session_start", reason: "new" }, context.ctx);
  const request = (payload) => mock.handlers.get("before_provider_request")({ type: "before_provider_request", payload }, context.ctx);
  return { ...mock, ...context, request };
}

describe("fast speed payload transform", () => {
  it("asks OpenAI Responses payloads for the priority tier on openai and openai-codex, without mutating the input", () => {
    const payload = responsesPayload();
    const result = speed.applyMmrSpeedToPayload(payload, "fast", { providerId: "openai" });
    assert.notEqual(result, payload);
    assert.equal(result.service_tier, "priority");
    assert.deepEqual(result.reasoning, { effort: "low" });
    assert.equal("service_tier" in payload, false, "the input is not mutated");

    const codex = codexPayload();
    const codexResult = speed.applyMmrSpeedToPayload(codex, "fast", { providerId: "openai-codex" });
    assert.equal(codexResult.service_tier, "priority");
    assert.equal(codexResult.instructions, "system");
    assert.equal("service_tier" in codex, false);
  });

  it("returns every other payload as the same reference", () => {
    const anthropic = anthropicPayload();
    assert.equal(speed.applyMmrSpeedToPayload(anthropic, "fast", { providerId: "anthropic" }), anthropic);
    // A supported provider id does not make an Anthropic or unknown shape Responses-shaped.
    assert.equal(speed.applyMmrSpeedToPayload(anthropic, "fast", { providerId: "openai" }), anthropic);
    const unknown = { model: "gpt-5.6-sol", input: [] };
    assert.equal(speed.applyMmrSpeedToPayload(unknown, "fast", { providerId: "openai" }), unknown);
    // A Responses payload bound for a provider without a priority tier.
    const azure = responsesPayload();
    assert.equal(speed.applyMmrSpeedToPayload(azure, "fast", { providerId: "azure-openai-responses" }), azure);
    assert.equal(speed.applyMmrSpeedToPayload(azure, "fast", {}), azure);
  });

  it("never writes service_tier at standard speed, leaving a configured tier alone", () => {
    const flex = { ...responsesPayload(), service_tier: "flex" };
    const result = speed.applyMmrSpeedToPayload(flex, "standard", { providerId: "openai" });
    assert.equal(result, flex);
    assert.equal(result.service_tier, "flex");
  });

  it("prices the priority tier at 2x, and 2.5x for gpt-5.5", () => {
    assert.deepEqual(speed.getMmrFastSupport("openai", "gpt-5.6-sol"), { supported: true, serviceTier: "priority", costMultiple: 2 });
    assert.equal(speed.getMmrFastSupport("openai", "gpt-5.5").costMultiple, 2.5);
    assert.equal(speed.getMmrFastSupport("openai-codex", "gpt-5.5").costMultiple, 2.5);
    assert.equal(speed.getMmrFastSupport("openai-codex", "gpt-5.5-mini").costMultiple, 2);
    assert.equal(speed.getMmrFastSupport("openai", "constructor").costMultiple, 2);
    assert.deepEqual(speed.getMmrFastSupport("anthropic", "claude-opus-4-8"), {
      supported: false,
      reason: "anthropic offers no priority tier ampi can request",
    });
    assert.deepEqual(speed.getMmrFastSupport(undefined), { supported: false, reason: "no model is selected" });
  });
});

describe("fast speed per session", () => {
  it("restores the newest ampi-speed entry of the branch", async () => {
    await startSession({ entries: [speedEntry("fast"), speedEntry("standard")] });
    assert.equal(speed.getMmrSpeed(), "standard");
    // An entry with an unknown speed is skipped.
    await startSession({ entries: [speedEntry("standard"), speedEntry("fast"), speedEntry("turbo")] });
    assert.equal(speed.getMmrSpeed(), "fast");
  });

  it("ignores an ampi-speed entry on another branch", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const mock = createMockPi({ initialModel: SOL });
    const { ctx } = createMockExtensionContext({ models: [SOL], model: SOL, entries: [speedEntry("fast")], cwd: project() });
    ctx.sessionManager.getBranch = () => [];
    extension(mock.pi);
    await mock.handlers.get("session_start")({ type: "session_start", reason: "resume" }, ctx);
    assert.equal(speed.getMmrSpeed(), "standard");
  });

  it("starts a new session from --ampi-fast before ampi.speed, and a session entry before both", async () => {
    await startSession({ cwd: project({ ampi: { speed: "standard" } }), flags: { "ampi-fast": true } });
    assert.equal(speed.getMmrSpeed(), "fast");
    await startSession({ cwd: project({ ampi: { speed: "fast" } }), entries: [speedEntry("standard")], flags: { "ampi-fast": true } });
    assert.equal(speed.getMmrSpeed(), "standard");
  });

  it("reads ampi.speed with the project file winning over the global one", async () => {
    globalSettings({ ampi: { speed: "standard" } });
    await startSession({ cwd: project({ ampi: { speed: "fast" } }) });
    assert.equal(speed.getMmrSpeed(), "fast");

    globalSettings({ ampi: { speed: "fast" } });
    await startSession({ cwd: project() });
    assert.equal(speed.getMmrSpeed(), "fast");
    await startSession({ cwd: project({ ampi: { speed: "standard" } }) });
    assert.equal(speed.getMmrSpeed(), "standard");

    const { loadMmrCoreSettings } = await importSource("extensions/ampi-core/settings.ts");
    const loaded = loadMmrCoreSettings(project({ ampi: { speed: "turbo" } }), home);
    assert.equal(loaded.settings.speed, "fast", "an invalid project value leaves the global one");
    assert.match(loaded.warnings.join("\n"), /Ignoring ampi\.speed .*expected "standard" or "fast"/);
  });
});

describe("fast speed in the request hook", () => {
  it("applies fast under a locked mode after the mode policy", async () => {
    const session = await startSession({ entries: [speedEntry("fast")] });
    assert.equal(runtime.getMmrModeState()?.mode, "medium");
    const result = await session.request(responsesPayload());
    assert.equal(result.service_tier, "priority");
    assert.deepEqual(result.reasoning, { effort: "medium", summary: "auto" }, "the mode policy still applies");
  });

  it("applies fast in free mode, where no mode policy runs", async () => {
    const session = await startSession({ entries: [speedEntry("fast")], mode: "free" });
    assert.equal(runtime.getMmrModeState()?.mode, "free");
    const payload = responsesPayload();
    const result = await session.request(payload);
    assert.deepEqual(result, { ...payload, service_tier: "priority" });
    // At standard speed free mode leaves the payload alone, as before.
    speed.setMmrSpeed("standard");
    assert.equal(await session.request(responsesPayload()), undefined);
  });

  it("applies fast under a session fallback route", async () => {
    const session = await startSession({ entries: [speedEntry("fast")] });
    runtime.setMmrManagedModelOverride({ kind: "session-fallback", provider: "openai", model: "gpt-5.6-sol", appliedAt: "2026-10-18T00:00:00.000Z" });
    const result = await session.request(responsesPayload());
    assert.equal(result.service_tier, "priority");
    assert.deepEqual(result.reasoning, { effort: "low" }, "no mode policy under a fallback");
  });

  it("leaves Anthropic routes alone at fast speed", async () => {
    const session = await startSession({ model: OPUS, entries: [speedEntry("fast")], mode: "free" });
    assert.equal(await session.request(anthropicPayload()), undefined);
  });

  it("never applies fast in a subagent worker", async () => {
    const session = await startSession({ entries: [speedEntry("fast")], mode: "free" });
    runtime.setMmrSubagentState({
      profile: "finder",
      provider: "openai",
      model: "gpt-5.6-sol",
      promptRoute: "subagent",
      activeTools: ["read"],
      activatedAt: "2026-10-18T00:00:00.000Z",
    });
    assert.equal(await session.request(responsesPayload()), undefined);
    assert.equal(speed.getMmrSpeed(), "standard");
    assert.equal(registry.getMmrCommand("speed.toggleFast").availability(session.ctx).state, "hidden");
  });
});

describe("speed.toggleFast", () => {
  const command = () => registry.getMmrCommand("speed.toggleFast");

  it("names the cost multiple in its verb and is available for openai and openai-codex", async () => {
    const session = await startSession({ model: SOL });
    assert.equal(command().noun, "speed");
    assert.equal(command().verb, "use fast (2x cost)");
    assert.equal(command().defaultKey, "alt+r");
    assert.deepEqual(command().keywords, ["fast", "priority", "speed"]);
    assert.deepEqual(command().availability(session.ctx), { state: "available" });

    await session.handlers.get("model_select")({ type: "model_select", model: GPT_55, source: "set" }, session.ctx);
    assert.equal(command().verb, "use fast (2.5x cost)");

    session.ctx.model = CODEX_SOL;
    await session.handlers.get("model_select")({ type: "model_select", model: CODEX_SOL, source: "set" }, session.ctx);
    assert.equal(command().verb, "use fast (2x cost)");
    assert.deepEqual(command().availability(session.ctx), { state: "available" });
  });

  it("is unavailable with the reason for anthropic and without a model", async () => {
    const session = await startSession({ model: OPUS, mode: "free" });
    assert.equal(command().verb, "use fast");
    assert.deepEqual(command().availability(session.ctx), {
      state: "unavailable",
      reason: "anthropic offers no priority tier ampi can request",
    });
    session.ctx.model = undefined;
    assert.deepEqual(command().availability(session.ctx), { state: "unavailable", reason: "no model is selected" });
  });

  it("turns fast on and off, records it, tells state listeners and names the mode and cost", async () => {
    const session = await startSession({ model: SOL });
    const emitted = session.emits.length;
    await command().run(session.ctx);
    assert.equal(speed.getMmrSpeed(), "fast");
    assert.deepEqual(session.calls.appendEntry.at(-1), ["ampi-speed", { speed: "fast" }]);
    assert.equal(session.notifications.at(-1)?.message, "Fast speed on for medium: priority serving at about 2x the price.");
    assert.equal(command().verb, "disable fast");
    assert.ok(session.emits.slice(emitted).some((emit) => emit.name === "mmr-core:state-changed"));

    // Turning it off works after a move to a provider without a priority tier.
    session.ctx.model = OPUS;
    assert.deepEqual(command().availability(session.ctx), { state: "available" });
    await command().run(session.ctx);
    assert.equal(speed.getMmrSpeed(), "standard");
    assert.deepEqual(session.calls.appendEntry.at(-1), ["ampi-speed", { speed: "standard" }]);
    assert.equal(session.notifications.at(-1)?.message, "Fast speed off for medium: standard serving at the standard price.");
    assert.equal(command().verb, "use fast");
  });
});

describe("the alt+r shortcut", () => {
  it("toggles fast speed without a chrome owner and does nothing while one is registered", async () => {
    const session = await startSession({ model: SOL });
    const release = chromeOwner.registerMmrChromeOwner("ampi-tui");
    try {
      await session.shortcuts.get("alt+r").handler(session.ctx);
      assert.equal(speed.getMmrSpeed(), "standard");
      assert.equal(session.calls.appendEntry.some(([type]) => type === "ampi-speed"), false);
    } finally {
      release();
    }
    await session.shortcuts.get("alt+r").handler(session.ctx);
    assert.equal(speed.getMmrSpeed(), "fast");
  });

  it("says why when the provider has no priority tier, also while a chrome owner passes the key on", async () => {
    const session = await startSession({ model: OPUS, mode: "free" });
    const notice = "Fast speed is not available: anthropic offers no priority tier ampi can request.";
    await session.shortcuts.get("alt+r").handler(session.ctx);
    assert.equal(speed.getMmrSpeed(), "standard");
    assert.equal(session.notifications.at(-1)?.message, notice);

    const release = chromeOwner.registerMmrChromeOwner("ampi-tui");
    try {
      const before = session.notifications.length;
      await session.shortcuts.get("alt+r").handler(session.ctx);
      assert.equal(session.notifications.length, before + 1);
      assert.equal(session.notifications.at(-1)?.message, notice);
    } finally {
      release();
    }
  });
});

describe("/ampi-status speed line", () => {
  const status = async (session) => {
    await session.commands.get("ampi-status").handler("", session.ctx);
    return session.notifications.at(-1)?.message.split("\n").find((line) => line.startsWith("Speed:"));
  };

  it("shows standard, fast with the multiple, or fast that the provider cannot serve", async () => {
    const session = await startSession({ model: GPT_55 });
    assert.equal(await status(session), "Speed: standard");
    speed.setMmrSpeed("fast");
    assert.equal(await status(session), "Speed: fast (priority tier, about 2.5x the price)");
    session.ctx.model = OPUS;
    assert.equal(await status(session), "Speed: fast (not available for anthropic)");

    const free = await startSession({ model: OPUS, mode: "free", entries: [speedEntry("fast")] });
    assert.equal(await status(free), "Speed: fast (not available for anthropic)");
  });
});
