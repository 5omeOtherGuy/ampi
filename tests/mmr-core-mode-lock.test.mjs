import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const MODELS = [
  { provider: "claude-subscription", id: "claude-opus-4-8", contextWindow: 1_000_000, maxTokens: 128_000, reasoning: true },
  { provider: "openai-codex", id: "gpt-5.5", contextWindow: 400_000, maxTokens: 128_000, reasoning: true },
  { provider: "openai-codex", id: "gpt-5.6-terra", contextWindow: 372_000, maxTokens: 128_000, reasoning: true },
  { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 372_000, maxTokens: 128_000, reasoning: true },
];
const LOCK_REASON = "the mode is fixed once a session has messages; start a new session to change it";
const USER_MESSAGE = { type: "message", id: "u1", parentId: null, message: { role: "user", content: "hello", timestamp: 1 } };

let runtime;
let coreExtension;
let fallbackExtension;
let formatMmrStatus;
let loadMmrCoreSettings;
let home;
const previousHome = process.env.HOME;

before(async () => {
  runtime = await importSource("extensions/ampi-core/runtime.ts");
  coreExtension = (await importSource("extensions/ampi-core/index.ts")).default;
  fallbackExtension = (await importSource("extensions/ampi-session-fallback/index.ts")).default;
  ({ formatMmrStatus } = await importSource("extensions/ampi-core/status.ts"));
  ({ loadMmrCoreSettings } = await importSource("extensions/ampi-core/settings.ts"));
  // Settings come from `~/.pi/agent/settings.json` and `<cwd>/.pi/settings.json`; keep both in a temporary tree.
  home = mkdtempSync(path.join(tmpdir(), "ampi-mode-lock-"));
  process.env.HOME = home;
});

after(() => {
  process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  runtime.setMmrModeState(undefined);
  runtime.setMmrSubagentState(undefined);
  runtime.clearMmrManagedModelOverride();
  (await importSource("extensions/ampi-session-fallback/runtime.ts")).clearMmrSessionFallbackOverrides();
});

/** A project directory whose `.pi/settings.json` holds `settings`. */
function projectWith(settings) {
  const cwd = mkdtempSync(path.join(home, "project-"));
  mkdirSync(path.join(cwd, ".pi"));
  writeFileSync(path.join(cwd, ".pi/settings.json"), JSON.stringify(settings));
  return cwd;
}

/** ampi-core on a mock Pi, started on a session with `entries`. */
async function start({ entries = [], cwd = home, extensions = [coreExtension] } = {}) {
  const host = createMockPi({ activeTools: ["read", "bash"], allTools: ["read", "bash", "edit", "write", "grep", "find", "ls"] });
  const context = createMockExtensionContext({ models: MODELS, entries, cwd, sessionId: "session-1" });
  for (const extension of extensions) extension(host.pi);
  await host.handlers.get("session_start")({ type: "session_start", reason: entries.length > 0 ? "resume" : "new" }, context.ctx);
  const press = (key) => host.shortcuts.get(key).handler(context.ctx);
  const send = (text) => host.handlers.get("input")({ type: "input", text, source: "interactive" }, context.ctx);
  const lockEmits = () => host.emits.filter((emit) => emit.name === "mmr-core:state-changed").map((emit) => emit.data?.modeLock?.locked);
  return { ...host, ...context, press, send, lockEmits };
}

const mode = () => runtime.getMmrModeState()?.mode;

describe("mmr-core mode lock", () => {
  it("lets Ctrl+S change the mode until the first message, then refuses with the reason", async () => {
    const t = await start();
    assert.equal(mode(), "medium");
    assert.deepEqual(runtime.getMmrModeState().modeLock, { enabled: true, locked: false });
    assert.equal(runtime.isMmrModeLocked(), false);

    await t.press("ctrl+s");
    assert.equal(mode(), "high");

    await t.send("first message");
    assert.deepEqual(runtime.getMmrModeState().modeLock, { enabled: true, locked: true, reason: LOCK_REASON });
    assert.equal(runtime.isMmrModeLocked(), true);
    assert.equal(t.lockEmits().at(-1), true, "listeners hear about the lock");

    const setModelCalls = t.calls.setModel.length;
    const entries = t.calls.appendEntry.length;
    await t.press("ctrl+s");
    await t.press("ctrl+space");
    assert.equal(mode(), "high");
    assert.equal(t.calls.setModel.length, setModelCalls, "a refused change touches no model");
    assert.equal(t.calls.appendEntry.length, entries, "a refused change persists nothing");
    assert.deepEqual(t.notifications.at(-1), {
      message: `Mode stays high: ${LOCK_REASON}. /mode <key> still switches it.`,
      level: "warning",
    });

    // The mode picker refuses before it opens.
    await t.press("alt+m");
    assert.equal(t.selectCalls.length, 0);
    assert.match(t.notifications.at(-1).message, /^Mode stays high:/);
  });

  it("keeps the thinking toggle working in a locked session, because it keeps the mode", async () => {
    const t = await start();
    await t.send("first message");
    await t.press("alt+d");
    assert.equal(mode(), "medium");
    assert.equal(runtime.getMmrModeState().thinkingLevel, "high");
    assert.equal(runtime.getMmrModeState().modeLock.locked, true);
  });

  it("starts a resumed session that has messages locked, on its saved mode", async () => {
    const saved = { type: "custom", customType: "ampi-core.mode-state", data: { version: 1, mode: "low" } };
    const t = await start({ entries: [saved, USER_MESSAGE] });
    assert.equal(mode(), "low");
    assert.equal(runtime.isMmrModeLocked(), true);

    await t.press("ctrl+s");
    assert.equal(mode(), "low");
    assert.match(t.notifications.at(-1).message, /^Mode stays low:/);
  });

  it("does not lock a session whose entries hold no user message", async () => {
    const assistantOnly = { type: "message", id: "a1", parentId: null, message: { role: "assistant", content: [] } };
    const t = await start({ entries: [assistantOnly] });
    assert.equal(runtime.isMmrModeLocked(), false);
    await t.press("ctrl+s");
    assert.equal(mode(), "high");
  });

  it("lets /mode override the lock, between managed modes and free, and says so", async () => {
    const t = await start();
    await t.send("first message");

    await t.commands.get("mode").handler("ultra", t.ctx);
    assert.equal(mode(), "ultra");
    assert.equal(t.calls.appendEntry.at(-1)[1].mode, "ultra");
    assert.deepEqual(t.notifications.at(-1), {
      message: "/mode overrode the mode lock: this session now runs in ultra.",
      level: "info",
    });
    assert.equal(runtime.isMmrModeLocked(), true, "the session stays locked after the override");

    await t.commands.get("mode").handler("free", t.ctx);
    assert.equal(mode(), "free");
    assert.match(t.notifications.at(-1).message, /overrode the mode lock: this session now runs in free/);

    // Free follows the same rule: the cycle cannot leave it.
    await t.press("ctrl+s");
    assert.equal(mode(), "free");
    assert.match(t.notifications.at(-1).message, /^Mode stays free:/);

    // Asking /mode for the current mode is no override.
    const count = t.notifications.length;
    await t.commands.get("mode").handler("free", t.ctx);
    assert.ok(t.notifications.slice(count).every((note) => !/overrode/.test(note.message)));
  });

  it("follows a native Pi model change to free in a locked session", async () => {
    const t = await start();
    await t.send("first message");
    await t.handlers.get("model_select")({ type: "model_select", model: MODELS[0], source: "set" }, t.ctx);
    assert.equal(mode(), "free");
    assert.equal(runtime.isMmrModeLocked(), true);
  });

  it("restores the old behaviour when ampiCore.modeLock is false", async () => {
    const t = await start({ cwd: projectWith({ ampiCore: { modeLock: false } }) });
    await t.send("first message");
    assert.deepEqual(runtime.getMmrModeState().modeLock, { enabled: false, locked: false });
    assert.equal(runtime.isMmrModeLocked(), false);

    await t.press("ctrl+s");
    assert.equal(mode(), "high");
    assert.ok(t.notifications.every((note) => !/Mode stays/.test(note.message)));
  });

  it("warns about a modeLock value that is not a boolean and keeps the lock on", () => {
    const cwd = projectWith({ ampiCore: { modeLock: "no" } });
    const loaded = loadMmrCoreSettings(cwd, home);
    assert.equal(loaded.settings.modeLock, undefined);
    assert.match(loaded.warnings.join("\n"), /Ignoring ampiCore\.modeLock in .*: expected true or false\./);
  });

  it("keeps a session-fallback route when the lock refuses a mode change", async () => {
    const t = await start({ extensions: [coreExtension, fallbackExtension] });
    await t.send("first message");
    assert.equal(runtime.getMmrModeState().model, "gpt-5.6-sol");

    t.ctx.model = MODELS.find((model) => model.id === "gpt-5.6-sol");
    t.ctx.ui.select = async (title, options) =>
      /fallback model/i.test(title) ? options.find((option) => option.includes("claude-subscription/claude-opus-4-8")) : options[0];
    const rateLimit = {
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "rate_limit_error: HTTP 429" },
    };
    await t.handlers.get("message_end")(rateLimit, t.ctx);
    await t.handlers.get("message_end")(rateLimit, t.ctx);

    const state = runtime.getMmrModeState();
    assert.deepEqual([state.mode, state.provider, state.model], ["medium", "claude-subscription", "claude-opus-4-8"]);
    assert.equal(state.modeLock.locked, true, "the fallback changes the route and keeps the lock");
    assert.equal(runtime.getMmrManagedModelOverride()?.model, "claude-opus-4-8");

    await t.press("ctrl+s");
    assert.equal(mode(), "medium");
    assert.equal(runtime.getMmrManagedModelOverride()?.model, "claude-opus-4-8", "a refused cycle leaves the fallback in place");
  });

  it("shows the lock in /ampi-status", async () => {
    const t = await start();
    const status = async () => {
      await t.commands.get("ampi-status").handler("", t.ctx);
      return t.notifications.at(-1).message;
    };
    assert.match(await status(), /^Mode lock: open until the first message$/m);
    await t.send("first message");
    assert.match(await status(), new RegExp(`^Mode lock: locked - ${LOCK_REASON}; /mode overrides it$`, "m"));

    const free = { ...runtime.getMmrModeState(), mode: "free", modeLock: { enabled: false, locked: false } };
    assert.match(formatMmrStatus(free), /^Mode lock: off \(ampiCore\.modeLock is false\)$/m);
  });
});
