import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const MODELS = [
  { provider: "claude-subscription", id: "claude-opus-4-8", contextWindow: 1_000_000, maxTokens: 128_000, reasoning: true },
  { provider: "openai-codex", id: "gpt-5.5", contextWindow: 400_000, maxTokens: 128_000, reasoning: true },
  { provider: "openai-codex", id: "gpt-5.6-terra", contextWindow: 372_000, maxTokens: 128_000, reasoning: true },
  { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 372_000, maxTokens: 128_000, reasoning: true },
];
const TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const USER_MESSAGE = { type: "message", id: "u1", parentId: null, message: { role: "user", content: "hello", timestamp: 1 } };
const REVIEW = { key: "review", label: "Review", color: "#d97706", baseMode: "high", description: "Reads a change and reports what is wrong", source: "tests" };
const SKETCH = { key: "sketch", color: "#22c55e", baseMode: "low", source: "sketch-modes", modelPreferences: [{ model: "gpt-5.5", providers: ["openai-codex"] }] };
const BASE_PROMPT = readFileSync(path.join(import.meta.dirname, "fixtures/mmr-core-prompts/base.md"), "utf8");

let registry;
let runtime;
let state;
let coreExtension;
let home;
const previousHome = process.env.HOME;

before(async () => {
  registry = await importSource("extensions/ampi-core/mode-registry.ts");
  runtime = await importSource("extensions/ampi-core/runtime.ts");
  state = await importSource("extensions/ampi-core/state.ts");
  coreExtension = (await importSource("extensions/ampi-core/index.ts")).default;
  // Settings come from `~/.pi/agent/settings.json` and `<cwd>/.pi/settings.json`; keep both in a temporary tree.
  home = mkdtempSync(path.join(tmpdir(), "ampi-mode-registry-"));
  process.env.HOME = home;
});

after(() => {
  process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  registry.__resetMmrModesForTests();
  runtime.setMmrModeState(undefined);
  runtime.setMmrSubagentState(undefined);
  runtime.clearMmrManagedModelOverride();
});

/** A project directory whose `.pi/settings.json` holds `settings`. */
function projectWith(settings) {
  const cwd = mkdtempSync(path.join(home, "project-"));
  mkdirSync(path.join(cwd, ".pi"));
  writeFileSync(path.join(cwd, ".pi/settings.json"), JSON.stringify(settings));
  return cwd;
}

/** An extension that registers `definitions` over pi.events only, as one that does not import ampi would. */
function busModes(...definitions) {
  return (pi) => {
    const send = () => {
      for (const definition of definitions) pi.events.emit("ampi-core:register-mode", definition);
    };
    pi.events.on("ampi-core:modes-ready", send);
    send();
  };
}

/**
 * A mock Pi carrying Pi's real event bus, with `before` loaded ahead of
 * ampi-core and `after` behind it, started on a session with `entries`.
 */
async function start({ before: early = [], after: late = [], entries = [], cwd = home, flags = {}, reason } = {}) {
  const host = createMockPi({ activeTools: ["read", "bash"], allTools: TOOLS, flags });
  const bus = createEventBus();
  host.pi.events = {
    emit: (name, data) => {
      host.emits.push({ name, data });
      bus.emit(name, data);
    },
    on: bus.on,
  };
  for (const extension of early) extension(host.pi);
  coreExtension(host.pi);
  for (const extension of late) extension(host.pi);
  const context = createMockExtensionContext({ models: MODELS, entries, cwd, sessionId: "session-1" });
  await host.handlers.get("session_start")({ type: "session_start", reason: reason ?? (entries.length > 0 ? "resume" : "new") }, context.ctx);
  const press = (key) => host.shortcuts.get(key).handler(context.ctx);
  const send = (text) => host.handlers.get("input")({ type: "input", text, source: "interactive" }, context.ctx);
  const mode = (text) => host.commands.get("mode").handler(text, context.ctx);
  const status = async () => {
    await host.commands.get("ampi-status").handler("", context.ctx);
    return context.notifications.at(-1).message;
  };
  const shutdown = () => host.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "reload" }, context.ctx);
  return { ...host, ...context, bus, press, send, mode, status, shutdown };
}

const current = () => runtime.getMmrModeState();
/** Lets a mode apply that a registry listener started run to its end; no timer is involved. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("mode registry validation", () => {
  const refuses = (definition, pattern) => assert.throws(() => registry.registerMmrMode({ color: "#d97706", ...definition }), pattern);

  it("takes keys of 1 to 32 lowercase letters, digits and dashes", () => {
    registry.registerMmrMode({ key: "a".repeat(32), color: "#d97706" });
    registry.registerMmrMode({ key: "x", color: "#d97706" });
    registry.registerMmrMode({ key: "code-review-2", color: "#d97706" });
    refuses({ key: "a".repeat(33) }, /Invalid mode key/);
    refuses({ key: "" }, /Invalid mode key/);
    refuses({ key: "Review" }, /Invalid mode key/);
    refuses({ key: "re_view" }, /Invalid mode key/);
    refuses({ key: "re view" }, /Invalid mode key/);
    refuses({ key: 7 }, /Invalid mode key/);
    assert.deepEqual(registry.listMmrModes().map((mode) => mode.key), ["a".repeat(32), "x", "code-review-2"]);
  });

  it("refuses every built-in key, alias and Pi output mode as a key or a label", () => {
    for (const name of ["low", "medium", "high", "ultra", "free", "rush", "smart", "deep", "fable", "text", "json", "rpc"]) {
      refuses({ key: name }, /reserved/);
      refuses({ key: "custom", label: name.toUpperCase() }, /names a built-in mode/);
    }
    assert.equal(registry.listMmrModes().length, 0);
  });

  it("refuses a key or label another registration holds, compared case-insensitively", () => {
    registry.registerMmrMode({ key: "review", label: "Critic", color: "#d97706", source: "a" });
    refuses({ key: "review", source: "b" }, /already registered by a/);
    refuses({ key: "other", label: "REVIEW" }, /already taken by mode "review"/);
    refuses({ key: "other", label: "critic" }, /already taken by mode "review"/);
    refuses({ key: "critic" }, /already the label of mode "review"/);
    assert.deepEqual(registry.listMmrModes().map((mode) => mode.key), ["review"]);
  });

  it("takes labels of up to 24 characters, defaulting to the key", () => {
    registry.registerMmrMode({ key: "short", color: "#d97706" });
    registry.registerMmrMode({ key: "long", label: "L".repeat(24), color: "#d97706" });
    refuses({ key: "longer", label: "L".repeat(25) }, /at most 24 characters/);
    refuses({ key: "blank", label: "  " }, /non-empty string/);
    assert.equal(registry.getMmrRegisteredMode("short").label, "short");
    assert.equal(registry.getMmrRegisteredMode("long").label, "L".repeat(24));
  });

  it("wants the colour as #rrggbb and stores it in lowercase", () => {
    for (const color of ["#fff", "d97706", "#gggggg", "#d977061", undefined]) refuses({ key: "c", color }, /#rrggbb/);
    registry.registerMmrMode({ key: "c", color: "#D97706" });
    assert.equal(registry.getMmrRegisteredMode("c").color, "#d97706");
  });

  it("refuses a description with a line break, an unknown base mode and other malformed overrides", () => {
    refuses({ key: "d", description: "first line\nsecond line" }, /one line/);
    refuses({ key: "d", description: "carriage\rreturn" }, /one line/);
    for (const baseMode of ["free", "turbo", "HIGH"]) refuses({ key: "d", baseMode }, /baseMode .* must be low, medium, high or ultra/);
    refuses({ key: "d", thinkingLevel: "max" }, /thinkingLevel/);
    refuses({ key: "d", tools: [] }, /tools must be a non-empty array/);
    refuses({ key: "d", tools: ["read", ""] }, /non-empty strings/);
    refuses({ key: "d", modelPreferences: [] }, /modelPreferences must be a non-empty array/);
    refuses({ key: "d", modelPreferences: [{ providers: ["x"] }] }, /model must be a non-empty string/);
    refuses({ key: "d", promptAppend: 3 }, /promptAppend must be a string/);
    assert.throws(() => registry.registerMmrMode("review"), /must be an object/);
    registry.registerMmrMode({ key: "d", color: "#d97706" });
    const stored = registry.getMmrRegisteredMode("d");
    assert.equal(stored.baseMode, "medium", "the base mode defaults to medium");
    assert.equal(stored.source, "extension", "the source reads extension when unset");
    assert.equal(Object.isFrozen(stored), true);
  });
});

describe("mode registry API", () => {
  it("registers, lists in order, looks up by key and resolves keys and labels case-insensitively", () => {
    registry.registerMmrMode(REVIEW);
    registry.registerMmrMode(SKETCH);
    assert.deepEqual(registry.listMmrModes().map((mode) => mode.key), ["review", "sketch"]);
    assert.equal(registry.getMmrRegisteredMode("REVIEW").key, "review");
    assert.equal(registry.resolveMmrRegisteredMode("rEvIeW").key, "review");
    assert.equal(registry.resolveMmrRegisteredMode(" Sketch ").key, "sketch");
    assert.equal(registry.resolveMmrRegisteredMode("high"), undefined, "built-in names never resolve here");
    assert.deepEqual(registry.resolveMmrModeName("high"), { mode: "high" });
    assert.equal(registry.resolveMmrModeName("Review").mode, "high", "a registered mode resolves to its base mode");
  });

  it("unregisters through the returned function once, and tells listeners, skipping one that throws", () => {
    const events = [];
    registry.onMmrModesChanged(() => {
      throw new Error("listener failure");
    });
    const stop = registry.onMmrModesChanged((event) => events.push(event));
    const unregister = registry.registerMmrMode(REVIEW);
    unregister();
    unregister();
    assert.equal(registry.getMmrRegisteredMode("review"), undefined);
    assert.deepEqual(events, [
      { change: "registered", key: "review" },
      { change: "unregistered", key: "review" },
    ]);
    stop();
    registry.registerMmrMode(SKETCH);
    assert.equal(events.length, 2, "an unsubscribed listener hears nothing");
  });

  it("replaces a registration of the same key and source, and the replaced one's function then does nothing", () => {
    const events = [];
    registry.onMmrModesChanged((event) => events.push(event));
    const first = registry.registerMmrMode(REVIEW);
    registry.registerMmrMode(REVIEW);
    assert.equal(events.length, 1, "an identical registration changes nothing");
    registry.registerMmrMode({ ...REVIEW, description: "Second wording" });
    assert.equal(registry.getMmrRegisteredMode("review").description, "Second wording");
    first();
    assert.equal(registry.getMmrRegisteredMode("review").description, "Second wording");
    assert.deepEqual(events.map((event) => event.change), ["registered", "registered"]);
  });

  it("shares one store between two copies of the module", async () => {
    const copy = await importSource("extensions/ampi-core/mode-registry.ts");
    assert.notEqual(copy, registry);
    copy.registerMmrMode(REVIEW);
    assert.equal(registry.getMmrRegisteredMode("review").label, "Review");
    assert.throws(() => registry.registerMmrMode({ ...REVIEW, source: "other" }), /already registered/);
  });
});

describe("mode registry over pi.events", () => {
  it("collects a definition emitted before ampi-core loads, through modes-ready", async () => {
    const t = await start({ before: [busModes(REVIEW)] });
    assert.deepEqual(registry.listMmrModes().map((mode) => mode.key), ["review"]);
    assert.equal(t.emits.filter((emit) => emit.name === "ampi-core:modes-ready").length, 2, "from the factory and at session start");
  });

  it("collects a definition emitted after ampi-core loads", async () => {
    await start({ after: [busModes(REVIEW, SKETCH)] });
    assert.deepEqual(registry.listMmrModes().map((mode) => mode.key), ["review", "sketch"]);
  });

  it("starts in a mode registered over the bus, in either load order", async () => {
    for (const order of ["before", "after"]) {
      registry.__resetMmrModesForTests();
      await start({ [order]: [busModes(REVIEW)], flags: { "ampi-mode": "review" } });
      assert.equal(current().registeredMode?.key, "review", order);
    }
  });

  it("removes a bus registration on an unregister message, but not one made through the API", async () => {
    const t = await start({ after: [busModes(REVIEW)] });
    registry.registerMmrMode(SKETCH);
    t.pi.events.emit("ampi-core:unregister-mode", { key: "sketch" });
    t.pi.events.emit("ampi-core:unregister-mode", { key: "REVIEW" });
    t.pi.events.emit("ampi-core:unregister-mode", "review");
    assert.deepEqual(registry.listMmrModes().map((mode) => mode.key), ["sketch"]);
  });

  it("reports a refused bus registration once, at session start, and lists it in /ampi-status", async () => {
    const t = await start({ after: [busModes({ key: "high", color: "#d97706" }, { key: "good", color: "nope" })] });
    const warnings = t.notifications.filter((note) => note.level === "warning" && /Refused a mode registration/.test(note.message));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /Mode key "high" is reserved/);
    assert.match(warnings[0].message, /Mode "good": color "nope" must be written as #rrggbb/);
    await t.send("hello");
    assert.equal(t.notifications.filter((note) => /Refused a mode registration/.test(note.message)).length, 1, "reported once");
    assert.match(await t.status(), /Mode registration warnings:\n {2}- Refused a mode registration: Mode key "high" is reserved/);
    assert.equal(registry.listMmrModes().length, 0);
  });
});

describe("mode registry across a reload", () => {
  it("empties the registry when the session shuts down, so a reload leaves no stale mode", async () => {
    const first = await start({ after: [busModes(REVIEW)], flags: { "ampi-mode": "review" } });
    registry.registerMmrMode(SKETCH);
    const events = [];
    registry.onMmrModesChanged((event) => events.push(event));
    await first.shutdown();
    assert.equal(registry.listMmrModes().length, 0);
    assert.deepEqual(events.map((event) => `${event.change}:${event.key}`), ["unregistered:review", "unregistered:sketch"]);
    assert.equal(first.notifications.some((note) => /not registered any more/.test(note.message)), false, "shutting down is not a mid-session unregistration");

    // Pi runs every factory again on a fresh bus; the extension is gone now.
    const saved = { type: "custom", customType: "ampi-core.mode-state", data: first.calls.appendEntry.at(-1)[1] };
    const reloaded = await start({ entries: [saved], reason: "reload" });
    assert.equal(registry.listMmrModes().length, 0);
    assert.equal(current().mode, "high");
    assert.equal(current().registeredMode, undefined);
    assert.match(reloaded.notifications.map((note) => note.message).join("\n"), /Mode "review" is not registered any more/);
  });

  it("takes the same extension's registrations again after a reload, through the bus or the API", async () => {
    const extension = (pi) => {
      busModes(REVIEW)(pi);
      registry.registerMmrMode(SKETCH);
    };
    const first = await start({ after: [extension] });
    await first.shutdown();
    await start({ before: [extension], reason: "reload" });
    assert.deepEqual(registry.listMmrModes().map((mode) => mode.key).sort(), ["review", "sketch"]);
    // Without a shutdown in between (a host that skips it), the same source still re-registers.
    assert.doesNotThrow(() => registry.registerMmrMode(SKETCH));
  });
});

describe("applying a registered mode", () => {
  it("runs the base mode's policy with the registered mode recorded beside it", async () => {
    registry.registerMmrMode(REVIEW);
    const t = await start({ flags: { "ampi-mode": "review" } });
    assert.equal(current().mode, "high");
    assert.equal(current().promptRoute, "deep");
    assert.deepEqual(current().registeredMode, { key: "review", label: "Review", color: "#d97706", source: "tests" });
    assert.equal(current().thinkingLevel, "xhigh", "without its own level the base mode's applies");
    assert.equal(t.calls.setModel.at(-1).id, "gpt-5.6-sol");
    assert.match(t.notifications.at(-1).message, /^MMR mode activated: Review \(review, based on high\)/);
    const published = t.emits.filter((emit) => emit.name === "mmr-core:state-changed").at(-1).data;
    assert.equal(published.registeredMode.key, "review");
  });

  it("uses its own model preferences, or else the base mode's configured ones", async () => {
    registry.registerMmrMode(SKETCH);
    registry.registerMmrMode(REVIEW);
    const cwd = projectWith({ ampiCore: { modelPreferences: { high: ["claude-subscription/claude-opus-4-8"], low: ["openai-codex/gpt-5.6-terra"] } } });
    const t = await start({ cwd, flags: { "ampi-mode": "sketch" } });
    assert.equal(t.calls.setModel.at(-1).id, "gpt-5.5", "its own preferences replace the configured low ones");
    await t.mode("review");
    assert.equal(`${current().provider}/${current().model}`, "claude-subscription/claude-opus-4-8");
  });

  it("sets its own thinking level, on a base mode with a toggle and on one without", async () => {
    registry.registerMmrMode({ ...REVIEW, thinkingLevel: "medium" });
    registry.registerMmrMode({ ...SKETCH, thinkingLevel: "high" });
    const t = await start({ flags: { "ampi-mode": "review" } });
    assert.equal(current().thinkingLevel, "medium");
    assert.equal(t.calls.setThinkingLevel.at(-1), "medium");
    await t.mode("sketch");
    assert.equal(current().thinkingLevel, "high");
    assert.match(await t.status(), /Thinking: high \(request policy: OpenAI Responses high /);
  });

  it("keeps the thinking toggle on the base mode's presets, starting from its own level", async () => {
    registry.registerMmrMode({ ...REVIEW, thinkingLevel: "medium" });
    const t = await start({ flags: { "ampi-mode": "review" } });
    await t.press("alt+d");
    assert.equal(current().thinkingLevel, "xhigh");
    assert.equal(current().registeredMode.key, "review");
    assert.equal(t.notifications.at(-1).message, "MMR thinking: review → xhigh, max out 128k");
  });

  it("replaces the tool list, still adding the edit tool and honouring ampi.tools.disable", async () => {
    registry.registerMmrMode({ ...REVIEW, tools: ["read", "write", "grep", "find"], modelPreferences: [{ model: "claude-opus-4-8" }] });
    const cwd = projectWith({ ampi: { tools: { disable: ["find"] } } });
    await start({ cwd, flags: { "ampi-mode": "review" } });
    assert.deepEqual(current().activeTools, ["read", "write", "edit", "grep"]);
    assert.equal(current().editTools.family, "edit");
  });

  it("refuses to start when its own tool list resolves no active tool", async () => {
    registry.registerMmrMode({ ...REVIEW, tools: ["no_such_tool"] });
    const t = await start();
    await t.mode("review");
    assert.equal(current().mode, "medium");
    assert.equal(current().registeredMode, undefined);
    assert.match(t.notifications.at(-1).message, /^Could not activate Review mode\.[\s\S]*Requested tools: no_such_tool/);
  });

  it("appends its prompt text after the assembled prompt in before_agent_start", async () => {
    registry.registerMmrMode({ ...REVIEW, promptAppend: "Report findings as a numbered list." });
    const t = await start({ flags: { "ampi-mode": "review" } });
    const result = await t.handlers.get("before_agent_start")({ systemPrompt: BASE_PROMPT, systemPromptOptions: {} });
    assert.match(result.systemPrompt, /<mmr_mode name="high">/);
    assert.ok(result.systemPrompt.endsWith("\n\nReport findings as a numbered list."));
    await t.mode("high");
    const plain = await t.handlers.get("before_agent_start")({ systemPrompt: BASE_PROMPT, systemPromptOptions: {} });
    assert.doesNotMatch(plain.systemPrompt, /numbered list/);
  });

  it("is a mode of its own to the lock: the lock names it, and /mode to its base overrides the lock", async () => {
    registry.registerMmrMode(REVIEW);
    const t = await start({ flags: { "ampi-mode": "review" } });
    await t.send("first message");
    await t.press("ctrl+s");
    assert.equal(current().registeredMode.key, "review");
    assert.match(t.notifications.at(-1).message, /^Mode stays review: the mode is fixed/);
    await t.press("alt+m");
    assert.match(t.notifications.at(-1).message, /^Mode stays review:/);
    await t.mode("high");
    assert.equal(current().registeredMode, undefined);
    assert.equal(t.notifications.at(-1).message, "/mode overrode the mode lock: this session now runs in high.");
  });

  it("falls back to its base mode when it is unregistered during the session", async () => {
    const unregister = registry.registerMmrMode(REVIEW);
    const t = await start({ flags: { "ampi-mode": "review" } });
    unregister();
    await settle();
    assert.equal(current().mode, "high");
    assert.equal(current().registeredMode, undefined);
    assert.equal(t.emits.filter((emit) => emit.name === "mmr-core:state-changed").at(-1).data.registeredMode, undefined);
    assert.equal(t.calls.appendEntry.at(-1)[1].registeredModeKey, undefined);
    assert.equal(t.notifications.at(-1).message, 'Mode "review" is not registered any more; this session continues in its base mode high.');
  });
});

describe("persisting a registered mode", () => {
  it("stores the base key in mode and the registered key beside it, at version 1", async () => {
    registry.registerMmrMode(REVIEW);
    const t = await start({ flags: { "ampi-mode": "review" } });
    const [type, data] = t.calls.appendEntry.at(-1);
    assert.equal(type, "ampi-core.mode-state");
    assert.equal(data.version, 1);
    assert.equal(data.mode, "high");
    assert.equal(data.registeredModeKey, "review");

    // A reader that knows nothing of registered modes still reads a valid base mode.
    const entry = { type: "custom", customType: "ampi-core.mode-state", data: JSON.parse(JSON.stringify(data)) };
    assert.equal(state.findLatestPersistedModeState([entry]).mode, "high");
    const { registeredModeKey: _ignored, ...older } = data;
    assert.equal(state.findLatestPersistedModeState([{ ...entry, data: older }]).mode, "high");
    assert.equal(state.findLatestPersistedModeState([{ ...entry, data: { ...data, registeredModeKey: "Bad Key" } }]).registeredModeKey, undefined);
  });

  it("restores a resumed session's registered mode while it is registered", async () => {
    registry.registerMmrMode(REVIEW);
    const saved = { type: "custom", customType: "ampi-core.mode-state", data: { version: 1, mode: "high", registeredModeKey: "review" } };
    await start({ entries: [saved, USER_MESSAGE] });
    assert.equal(current().registeredMode.key, "review");
    assert.equal(current().source, "session");
    assert.equal(runtime.isMmrModeLocked(), true);
  });

  it("resumes in the saved base mode with a notice when the registered mode is gone", async () => {
    const saved = { type: "custom", customType: "ampi-core.mode-state", data: { version: 1, mode: "high", registeredModeKey: "review" } };
    const t = await start({ entries: [saved, USER_MESSAGE] });
    assert.equal(current().mode, "high");
    assert.equal(current().registeredMode, undefined);
    assert.ok(t.notifications.some((note) => note.message === 'Mode "review" is not registered any more; this session continues in its base mode high.'));
  });
});

describe("choosing a registered mode by name", () => {
  it("/mode takes the key or the label in any case, and lists and completes registered keys after the built-ins", async () => {
    registry.registerMmrMode(REVIEW);
    registry.registerMmrMode(SKETCH);
    const t = await start();
    await t.mode("REVIEW");
    assert.equal(current().registeredMode.key, "review");
    await t.mode("SkEtCh");
    assert.equal(current().registeredMode.key, "sketch");
    assert.equal(current().mode, "low");
    await t.mode("smart");
    assert.equal(current().mode, "medium", "aliases resolve first, as before");

    const complete = t.commands.get("mode").getArgumentCompletions;
    assert.deepEqual(complete("").map((item) => item.value), ["low", "medium", "high", "ultra", "free", "review", "sketch"]);
    assert.deepEqual(complete("re").map((item) => item.value), ["review"]);

    await t.mode("nope");
    assert.equal(t.notifications.at(-1).message, 'Unknown ampi mode "nope". Available modes: low, medium, high, ultra, free, review, sketch');
    await t.mode("");
    assert.match(
      t.notifications.at(-1).message,
      /Registered modes:\nreview "Review" — based on high; from tests — Reads a change and reports what is wrong\nsketch — based on low; from sketch-modes\n\nCurrent:/,
    );
  });

  it("--ampi-mode takes a registered label, and an unknown name warns and gives way to the next source", async () => {
    registry.registerMmrMode(REVIEW);
    let t = await start({ flags: { "ampi-mode": "Review" } });
    assert.equal(current().registeredMode.key, "review");
    assert.equal(current().source, "flag");
    t = await start({ flags: { "mmr-mode": "nope" }, cwd: projectWith({ ampiCore: { defaultMode: "review" } }) });
    assert.ok(t.notifications.some((note) => note.message.includes('Ignoring invalid --ampi-mode/--mmr-mode ampi mode "nope".')));
    assert.equal(current().registeredMode.key, "review");
    assert.equal(current().source, "settings");
  });

  it("the defaultMode setting takes a registered key, and an unknown one falls back to medium", async () => {
    registry.registerMmrMode(SKETCH);
    await start({ cwd: projectWith({ ampiCore: { defaultMode: "sketch" } }) });
    assert.equal(current().registeredMode.key, "sketch");
    const t = await start({ cwd: projectWith({ ampiCore: { defaultMode: "nope" } }) });
    assert.ok(t.notifications.some((note) => note.message.includes('Ignoring invalid settings ampi mode "nope".')));
    assert.equal(current().mode, "medium");
    assert.equal(current().source, "default");
  });

  it("the picker lists registered keys between ultra and free; the cycle skips them", async () => {
    registry.registerMmrMode(REVIEW);
    registry.registerMmrMode(SKETCH);
    const t = await start({ flags: { "ampi-mode": "review" } });
    t.ctx.ui.select = async (title, options) => {
      t.selectCalls.push({ title, options });
      return "sketch";
    };
    await t.press("alt+m");
    assert.deepEqual(t.selectCalls.at(-1), { title: "MMR mode (current: review)", options: ["low", "medium", "high", "ultra", "review", "sketch", "free"] });
    assert.equal(current().registeredMode.key, "sketch");
    await t.press("ctrl+s");
    assert.equal(current().mode, "medium", "the cycle continues from the base mode, low");
    assert.equal(current().registeredMode, undefined);
  });
});

describe("registered mode diagnostics", () => {
  it("/ampi-status names the key, label, source and base mode, and the footer shows the key", async () => {
    registry.registerMmrMode(REVIEW);
    const t = await start({ flags: { "ampi-mode": "review" } });
    const text = await t.status();
    assert.match(text, /^Mode: Review \(review\)\nRegistered mode: review, label Review, from tests, base mode high\n/);
    const footer = t.footers.at(-1)(
      { requestRender: () => {} },
      { fg: (_name, value) => value },
      { getGitBranch: () => "main", onBranchChange: () => () => {}, getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 1 },
    );
    assert.match(footer.render(100)[1], /gpt-5\.6-sol • review$/);
  });

  it("children get the base mode as --ampi-parent-mode", async () => {
    registry.registerMmrMode(REVIEW);
    await start({ flags: { "ampi-mode": "review" } });
    const { createTaskTool } = await importSource("extensions/ampi-workers/builtin-workers/task.ts");
    (await importSource("extensions/ampi-workers/profiles/prompts.ts")).registerMmrSubagentsPromptBuilders();
    const { buildMmrWorkerArgs } = await importSource("extensions/ampi-workers/framework/runner-invocation.ts");
    const registered = { provider: "claude-subscription", id: "claude-opus-4-8", authenticated: true };
    const modelRegistry = {
      getAll: () => [registered],
      find: (provider, id) => (provider === registered.provider && id === registered.id ? registered : undefined),
      getAvailable: () => ["claude-subscription/claude-opus-4-8"],
    };
    const pi = {
      getActiveTools: () => ["read", "bash"],
      getAllTools: () => [
        { name: "read", description: "Read files.", parameters: {} },
        { name: "bash", description: "Run shell commands.", parameters: {} },
      ],
    };
    const runs = [];
    const tool = createTaskTool({
      pi,
      getBaseSystemPrompt: () => BASE_PROMPT,
      runner: {
        async run(options) {
          runs.push(options);
          return { exitCode: 0, finalOutput: "done", stderr: "", messages: [], usage: undefined };
        },
      },
    });
    await tool.execute("call-1", { prompt: "Look around", description: "Look" }, undefined, undefined, { cwd: home, modelRegistry });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].parentMode, "high");
    const args = buildMmrWorkerArgs({ prompt: "Look around", parentMode: runs[0].parentMode });
    assert.deepEqual(args.slice(args.indexOf("--ampi-parent-mode"), args.indexOf("--ampi-parent-mode") + 2), ["--ampi-parent-mode", "high"]);
  });
});
