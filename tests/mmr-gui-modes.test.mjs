// ampi-gui mode picker: GET /api/modes over ampi-core's mode table and a
// fixture model registry, the mode, model and fast commands with their busy
// and locked refusals and the explicit override, the hub's new-thread
// answer, and the picker's pure helpers (rows, notices, escaping, the
// Ctrl+S and palette commands). Servers run on 127.0.0.1 with a random
// port; Pi is the test stub; HOME is a temporary directory, so no user
// settings are read.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const TOKEN = ["modes", "test", "token"].join("-");
const STATE_CHANGED = "mmr-core:state-changed";
const LOCK_REASON = "the session has a message";

/** The registry's models; low's preferences are missing on purpose. */
const MODELS = [
  { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
  { provider: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8" },
];

let runtime;
let commandRegistry;
let home;
let previousHome;
let previousAgentDir;

/** A minimal ampi-core mode state: the fields the routes read. */
function modeState(mode, { locked = false, provider = "openai-codex", model = "gpt-5.6-sol" } = {}) {
  return {
    mode,
    modelApplied: mode !== "free",
    provider: mode === "free" ? "" : provider,
    model: mode === "free" ? "" : model,
    thinkingLevel: mode === "free" ? undefined : "medium",
    modeLock: locked ? { enabled: true, locked: true, reason: LOCK_REASON } : { enabled: true, locked: false },
  };
}

function registry(models) {
  return {
    getAll: () => models,
    getAvailable: () => models,
    find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
    hasConfiguredAuth: () => true,
    isUsingOAuth: () => false,
  };
}

/** Pi's event bus, enough for ampi-core's state-changed subscriptions. */
function eventBus() {
  const listeners = new Map();
  return {
    on(name, listener) {
      const list = listeners.get(name) ?? new Set();
      list.add(listener);
      listeners.set(name, list);
      return () => list.delete(listener);
    },
    emit(name, data) {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(data);
    },
  };
}

function send(port, { method = "GET", target, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path: target, headers: { Host: `127.0.0.1:${port}`, ...headers }, setHost: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => {
        let json;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, body: json, text });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const cookie = (port) => ({ Cookie: `ampi_gui_${port}=${TOKEN}` });
const get = (port, target) => send(port, { target, headers: cookie(port) });
const post = (port, target, body) =>
  send(port, {
    method: "POST",
    target,
    headers: { ...cookie(port), Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

before(async () => {
  runtime = await importSource("extensions/ampi-core/runtime.ts");
  commandRegistry = await importSource("extensions/ampi-core/command-registry.ts");
});

beforeEach(() => {
  previousHome = process.env.HOME;
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  home = mkdtempSync(path.join(tmpdir(), "ampi-gui-modes-"));
  process.env.HOME = home;
  delete process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
  runtime.setMmrModeState(undefined);
  commandRegistry.unregisterMmrCommand("speed.toggleFast");
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(home, { recursive: true, force: true });
});

/** A session server over the stub; `/mode <key>` and `setModel` behave as ampi-core makes them. */
async function startSession({ state = modeState("medium") } = {}) {
  const { startMmrGuiServer } = await importSource("extensions/ampi-gui/server.ts");
  const { createMmrGuiBridge } = await importSource("extensions/ampi-gui/bridge.ts");
  const { createMmrGuiCommands } = await importSource("extensions/ampi-gui/commands.ts");
  const events = eventBus();
  const setState = (next) => {
    runtime.setMmrModeState(next);
    events.emit(STATE_CHANGED, next);
  };
  const mock = createMockPi({
    // ampi-core's /mode command: apply the mode and report it.
    onSendUserMessage: (content) => {
      const match = /^\/mode (\S+)$/.exec(content);
      if (match) setState({ ...modeState(match[1]), modeLock: runtime.getMmrModeState()?.modeLock });
    },
    // ampi-core's answer to a native model change: the session leaves its mode for free.
    onModelSet: async () => setState({ ...modeState("free"), modeLock: runtime.getMmrModeState()?.modeLock }),
  });
  mock.pi.events = events;
  const context = createMockExtensionContext({ cwd: home, sessionId: "s-1", sessionName: "Modes", model: MODELS[0] });
  context.ctx.modelRegistry = registry(MODELS);
  runtime.setMmrModeState(state);
  const bridge = createMmrGuiBridge(mock.pi);
  bridge.start(context.ctx);
  const sessions = {
    list: async () => ({ currentId: "s-1", groups: [], actions: {} }),
    view: async () => undefined,
    find: async () => undefined,
    searchable: async () => ({ now: 0, home, rows: [] }),
  };
  const commands = createMmrGuiCommands(mock.pi, bridge, sessions, {
    // The short wait after ampi-core reports the mode runs at once; the switch timeout never fires.
    modes: { setTimer: (callback, ms) => (ms === 0 ? queueMicrotask(callback) : { ms }), clearTimer: () => {} },
  });
  const server = await startMmrGuiServer({
    bridge,
    commands,
    exportSession: async () => ({ status: 404, body: {} }),
    sessions,
    token: TOKEN,
    clientDir: path.join(getPreparedSourceRoot(), "extensions/ampi-gui/client"),
  });
  return { port: server.port, mock, context, bridge, close: () => server.close().then(() => bridge.stop()) };
}

describe("ampi-gui GET /api/modes", () => {
  it("lists ampi's modes in order with the models they would run, and the models Pi has credentials for", async () => {
    const session = await startSession();
    try {
      const { status, body } = await get(session.port, "/api/modes");
      assert.equal(status, 200);
      assert.deepEqual(Object.keys(body), ["current", "locked", "lockReason", "model", "fast", "modes", "models"]);
      assert.deepEqual(
        body.modes.map((mode) => [mode.key, mode.label]),
        [
          ["low", "Low"],
          ["medium", "Medium"],
          ["high", "High"],
          ["ultra", "Ultra"],
          ["free", "Free"],
        ],
      );
      assert.deepEqual(Object.keys(body.modes[0]), ["key", "label", "description", "color", "agentModel", "oracleModel", "available", "reason"]);
      assert.equal(body.modes[1].description, "Balanced intelligence, speed, and cost for most tasks.");
      assert.equal(body.current, "medium");
      assert.equal(body.locked, false);
      assert.equal(body.lockReason, null);
      assert.equal(body.model, "openai-codex/gpt-5.6-sol");
      assert.equal(body.fast, null, "no speed.toggleFast command is registered");
      // The active mode reports the route ampi-core applied, by the registry's name.
      assert.deepEqual(body.modes[1].agentModel, { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", thinkingLevel: "medium" });
      // Low's models are not in the registry: switching to it would fail.
      assert.equal(body.modes[0].available, false);
      assert.equal(body.modes[0].agentModel, null);
      assert.match(body.modes[0].reason, /None of this mode's models is set up/);
      assert.equal(body.modes[2].available, true);
      assert.deepEqual(body.models, MODELS);
    } finally {
      await session.close();
    }
  });

  it("lists free last, as a row of the list only: Pi's own model and no oracle", async () => {
    const session = await startSession({ state: modeState("free") });
    try {
      const { body } = await get(session.port, "/api/modes");
      const free = body.modes.at(-1);
      assert.equal(free.key, "free");
      assert.equal(body.modes.filter((mode) => mode.key === "free").length, 1);
      assert.equal(free.available, true);
      assert.equal(free.oracleModel, null);
      assert.equal(free.agentModel.id, "gpt-5.6-sol", "the model Pi has selected");
      assert.equal(body.current, "free");
    } finally {
      await session.close();
    }
  });

  it("reports the lock and its reason, and the Fast row only while speed.toggleFast is registered", async () => {
    const session = await startSession({ state: modeState("high", { locked: true }) });
    commandRegistry.registerMmrCommand({
      id: "speed.toggleFast",
      noun: "speed",
      verb: "use fast",
      description: "Fast speed",
      availability: () => ({ state: "unavailable", reason: "no priority tier here" }),
      run: () => {},
    });
    try {
      const { body } = await get(session.port, "/api/modes");
      assert.equal(body.locked, true);
      assert.equal(body.lockReason, LOCK_REASON);
      assert.deepEqual(body.fast, { on: false, available: false, reason: "no priority tier here" });
    } finally {
      await session.close();
    }
  });

  it("needs the token like every other route", async () => {
    const session = await startSession();
    try {
      assert.equal((await send(session.port, { target: "/api/modes" })).status, 401);
      const noOrigin = await send(session.port, {
        method: "POST",
        target: "/api/mode",
        headers: { ...cookie(session.port), "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(noOrigin.status, 403);
    } finally {
      await session.close();
    }
  });
});

describe("ampi-gui POST /api/mode, /api/model and /api/fast", () => {
  it("switches the mode through /mode and answers with the new mode", async () => {
    const session = await startSession();
    try {
      const result = await post(session.port, "/api/mode", { mode: "high" });
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, { ok: true, mode: "high" });
      assert.deepEqual(
        session.mock.calls.sendUserMessage.map((call) => call.content),
        ["/mode high"],
      );
      assert.equal(session.bridge.session().mode, "high", "the title bar's session event follows");
    } finally {
      await session.close();
    }
  });

  it("answers 409 while a turn runs, and sends nothing", async () => {
    const session = await startSession();
    const runs = [];
    commandRegistry.registerMmrCommand({ id: "speed.toggleFast", noun: "speed", verb: "use fast", description: "Fast", run: (ctx) => runs.push(ctx.sessionId) });
    session.context.state.idle = false;
    try {
      const mode = await post(session.port, "/api/mode", { mode: "high" });
      assert.equal(mode.status, 409);
      assert.equal(mode.body.state, "busy");
      const model = await post(session.port, "/api/model", { provider: "anthropic", id: "claude-opus-4-8" });
      assert.equal(model.status, 409);
      const fast = await post(session.port, "/api/fast", {});
      assert.equal(fast.status, 409, "fast speed waits for the turn too");
      assert.equal(fast.body.state, "busy");
      assert.equal(session.mock.calls.sendUserMessage.length, 0);
      assert.equal(session.mock.calls.setModel.length, 0);
      assert.deepEqual(runs, []);
    } finally {
      await session.close();
    }
  });

  it("answers 409 with the reason while the mode is locked, and passes an explicit override on to /mode", async () => {
    const session = await startSession({ state: modeState("medium", { locked: true }) });
    try {
      const refused = await post(session.port, "/api/mode", { mode: "ultra" });
      assert.equal(refused.status, 409);
      assert.deepEqual(refused.body, { state: "locked", error: LOCK_REASON });
      assert.equal(session.mock.calls.sendUserMessage.length, 0);

      const overridden = await post(session.port, "/api/mode", { mode: "ultra", override: true });
      assert.equal(overridden.status, 200);
      assert.equal(overridden.body.mode, "ultra");
      assert.deepEqual(
        session.mock.calls.sendUserMessage.map((call) => call.content),
        ["/mode ultra"],
      );
    } finally {
      await session.close();
    }
  });

  it("refuses a mode with no usable model, an unknown mode and a malformed override", async () => {
    const session = await startSession();
    try {
      const low = await post(session.port, "/api/mode", { mode: "low" });
      assert.equal(low.status, 409);
      assert.match(low.body.error, /None of this mode's models is set up/);
      assert.equal((await post(session.port, "/api/mode", { mode: "turbo" })).status, 400);
      assert.equal((await post(session.port, "/api/mode", { mode: "high", override: "yes" })).status, 400);
      assert.deepEqual(await post(session.port, "/api/mode", { mode: "medium" }).then((result) => result.body), { ok: true, mode: "medium" });
      assert.equal(session.mock.calls.sendUserMessage.length, 0, "the current mode needs no switch");
    } finally {
      await session.close();
    }
  });

  it("selects a raw model through Pi, which drops a locked mode to free only with the override", async () => {
    const session = await startSession({ state: modeState("high", { locked: true }) });
    try {
      const refused = await post(session.port, "/api/model", { provider: "anthropic", id: "claude-opus-4-8" });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.state, "locked");

      const result = await post(session.port, "/api/model", { provider: "anthropic", id: "claude-opus-4-8", override: true });
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, { ok: true, model: "anthropic/claude-opus-4-8", mode: "free" });
      assert.deepEqual(session.mock.calls.setModel, [MODELS[1]]);

      // In free, another model changes no mode, so the lock does not apply.
      const again = await post(session.port, "/api/model", { provider: "openai-codex", id: "gpt-5.6-sol" });
      assert.equal(again.status, 200);
    } finally {
      await session.close();
    }
  });

  it("tells a model the registry does not know from one Pi has no credentials for", async () => {
    const session = await startSession();
    // The registry knows both models; Pi can sign in to the first only.
    session.context.ctx.modelRegistry.getAvailable = () => [MODELS[0]];
    try {
      const unknown = await post(session.port, "/api/model", { provider: "nobody", id: "none" });
      assert.equal(unknown.status, 400);
      assert.equal(unknown.body.error, "There is no model nobody/none.");
      const signedOut = await post(session.port, "/api/model", { provider: "anthropic", id: "claude-opus-4-8" });
      assert.equal(signedOut.status, 409);
      assert.equal(signedOut.body.error, "Pi has no credentials for anthropic/claude-opus-4-8.");
      assert.equal(session.mock.calls.setModel.length, 0);
    } finally {
      await session.close();
    }
  });

  it("toggles fast speed through the registered command", async () => {
    const session = await startSession();
    const runs = [];
    try {
      assert.equal((await post(session.port, "/api/fast", {})).status, 409, "no command, no fast speed");
      commandRegistry.registerMmrCommand({ id: "speed.toggleFast", noun: "speed", verb: "use fast", description: "Fast", run: (ctx) => runs.push(ctx.sessionId) });
      const result = await post(session.port, "/api/fast", {});
      assert.equal(result.status, 200);
      assert.deepEqual(runs, ["s-1"]);
    } finally {
      await session.close();
    }
  });

  it("refuses a second change while fast speed is still switching, and fast speed while the mode is locked passes", async () => {
    const session = await startSession({ state: modeState("medium", { locked: true }) });
    const pending = [];
    const finish = () => {
      for (const resolve of pending.splice(0)) resolve();
    };
    const runs = [];
    commandRegistry.registerMmrCommand({
      id: "speed.toggleFast",
      noun: "speed",
      verb: "use fast",
      description: "Fast",
      // The first run waits until the test lets it finish; a second one, if it ran at all, would not.
      run: (ctx) => {
        runs.push(ctx.sessionId);
        return runs.length === 1 ? new Promise((resolve) => pending.push(resolve)) : undefined;
      },
    });
    try {
      const first = post(session.port, "/api/fast", {});
      while (runs.length === 0) await new Promise(setImmediate);
      const second = await post(session.port, "/api/fast", {});
      assert.equal(second.status, 409);
      assert.equal(second.body.error, "Another change is still under way.");
      const mode = await post(session.port, "/api/mode", { mode: "high", override: true });
      assert.equal(mode.status, 409, "a mode change waits for it too");
      assert.equal(mode.body.state, "busy");
      finish();
      assert.equal((await first).status, 200, "the lock does not apply to fast speed");
      assert.deepEqual(runs, ["s-1"]);
      assert.equal(session.mock.calls.sendUserMessage.length, 0);
    } finally {
      finish();
      await session.close();
    }
  });
});

describe("ampi-gui hub: modes", () => {
  it("answers the new-thread view without a current mode, and 409 for a session nothing runs", async () => {
    const hubModule = await importSource("extensions/ampi-gui/hub.ts");
    const { createMmrGuiSessions } = await importSource("extensions/ampi-gui/sessions.ts");
    const { describeMmrGuiModes } = await importSource("extensions/ampi-gui/modes.ts");
    runtime.setMmrModeState(modeState("ultra", { locked: true }));
    const file = path.join(home, "s-saved.jsonl");
    writeFileSync(
      file,
      `${[
        { type: "session", version: 3, id: "s-saved", timestamp: "2026-10-18T09:00:00.000Z", cwd: home },
        { type: "message", id: "e1", parentId: null, timestamp: "2026-10-18T09:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Saved" }], timestamp: 1 } },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
    );
    const info = { path: file, id: "s-saved", cwd: home, created: new Date(0), modified: new Date(0), messageCount: 1, firstMessage: "Saved", allMessagesText: "" };
    const registryOptions = { dir: path.join(home, "live"), isAlive: () => false, procStart: () => null };
    const sessions = createMmrGuiSessions({ source: { listSessions: async () => [info] }, current: () => undefined, threadIndex: () => undefined, now: () => 0 });
    const ctx = { cwd: home, model: undefined, modelRegistry: registry(MODELS) };
    const hub = await hubModule.startMmrGuiHub({
      token: TOKEN,
      clientDir: path.join(getPreparedSourceRoot(), "extensions/ampi-gui/client"),
      startSession: async () => {
        throw new Error("no worker in this test");
      },
      sessions,
      commands: {},
      exportSession: async () => ({ status: 404, body: {} }),
      modes: () => describeMmrGuiModes(ctx, { live: false }),
      registry: registryOptions,
      setTimer: () => ({}),
      clearTimer: () => {},
    });
    try {
      const { status, body } = await get(hub.port, "/api/modes");
      assert.equal(status, 200);
      assert.equal(body.current, null, "a new thread has no mode yet");
      assert.equal(body.locked, false, "whatever the app's own session holds");
      assert.equal(body.model, null);
      assert.equal(body.fast, null);
      assert.deepEqual(
        body.modes.map((mode) => mode.key),
        ["low", "medium", "high", "ultra", "free"],
      );
      assert.deepEqual(body.models, MODELS);

      const dormant = await get(hub.port, "/s/s-saved/api/modes");
      assert.equal(dormant.status, 409);
      assert.equal(dormant.body.state, "not-running");
      assert.equal((await post(hub.port, "/api/mode", { mode: "high" })).status, 404, "the hub has no session to switch");
    } finally {
      await hub.close();
    }
  });
});

describe("ampi-gui mode picker helpers", () => {
  const picker = () => importSource("extensions/ampi-gui/client/mode-picker.js");
  const DATA = {
    current: "medium",
    locked: false,
    lockReason: null,
    model: "openai-codex/gpt-5.6-sol",
    fast: null,
    modes: [
      { key: "low", label: "Low", description: "Small tasks", color: null, agentModel: null, oracleModel: null, available: false, reason: "No model" },
      { key: "medium", label: "Medium", description: "Most tasks", color: null, agentModel: { provider: "p", id: "a", name: "Alpha", thinkingLevel: "medium" }, oracleModel: { provider: "p", id: "b", name: "Beta", thinkingLevel: null }, available: true, reason: null },
      { key: "free", label: "Free", description: "Pi's own controls", color: null, agentModel: null, oracleModel: null, available: true, reason: null },
    ],
    models: [
      { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
      { provider: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8" },
      { provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5" },
    ],
  };

  it("marks the current mode and filters by name, description and model", async () => {
    const { modeRows } = await picker();
    assert.deepEqual(
      modeRows(DATA).map((row) => [row.key, row.current]),
      [
        ["low", false],
        ["medium", true],
        ["free", false],
      ],
    );
    assert.deepEqual(
      modeRows(DATA, "beta").map((row) => row.key),
      ["medium"],
      "the oracle's name matches",
    );
    assert.deepEqual(
      modeRows(DATA, "pi own").map((row) => row.key),
      ["free"],
    );
  });

  it("groups the models by provider in the registry's order, with a check on the selected one", async () => {
    const { modelGroups } = await picker();
    assert.deepEqual(
      modelGroups(DATA).map((group) => [group.provider, group.rows.map((row) => `${row.id}${row.current ? " ✓" : ""}`)]),
      [
        ["openai-codex", ["gpt-5.6-sol ✓", "gpt-5.5"]],
        ["anthropic", ["claude-opus-4-8"]],
      ],
    );
    assert.deepEqual(
      modelGroups(DATA, "opus").map((group) => group.provider),
      ["anthropic"],
    );
  });

  it("says why rows are read-only: busy, locked with Change anyway, then the override; and that a model leaves the mode", async () => {
    const { pickerNotice, rowsWritable } = await picker();
    assert.equal(pickerNotice(DATA), null);
    assert.equal(pickerNotice(DATA, { busy: "Working" }).kind, "busy");
    assert.equal(rowsWritable(DATA, { busy: "Working" }), false);
    const locked = { ...DATA, locked: true, lockReason: "the session has a message" };
    assert.deepEqual(pickerNotice(locked), { kind: "locked", text: "The session has a message.", action: "Change anyway" });
    assert.equal(rowsWritable(locked), false);
    assert.equal(pickerNotice({ ...locked, lockReason: null }).text, "The mode is locked.");
    assert.equal(pickerNotice(locked, { override: true }).kind, "override");
    assert.match(pickerNotice(locked, { override: true }).text, /as \/mode does/);
    assert.equal(rowsWritable(locked, { override: true }), true);
    // Past Change anyway the Models tab still warns about free, and names no override for /model, which needs none.
    const models = pickerNotice(locked, { tab: "models", override: true });
    assert.equal(models.kind, "free");
    assert.match(models.text, /^Your next choice overrides the lock and switches this session from medium to free:/);
    assert.doesNotMatch(models.text, /\/model/);
    assert.equal(rowsWritable(locked, { tab: "models", override: true }), true);
    assert.equal(pickerNotice(DATA, { tab: "models" }).kind, "free", "a model switches medium to free");
    assert.match(pickerNotice(DATA, { tab: "models" }).text, /from medium to free/);
    // In free a model changes no mode: neither the lock nor the warning applies.
    assert.equal(pickerNotice({ ...locked, current: "free" }, { tab: "models" }), null);
  });

  it("escapes descriptions and model names in the rows it draws", async () => {
    const { modeOptionHtml, modelOptionHtml, fastOptionHtml } = await picker();
    const hostile = {
      ...DATA.modes[1],
      label: 'Med"ium',
      description: "<script>alert(1)</script>",
      agentModel: { provider: "p", id: "a", name: "<img src=x onerror=alert(1)>", thinkingLevel: null },
    };
    const row = modeOptionHtml({ ...hostile, current: true }, 0);
    assert.doesNotMatch(row, /<script>|<img/);
    assert.match(row, /&#60;script&#62;alert\(1\)&#60;\/script&#62;/);
    assert.match(row, /&#60;img src=x onerror=alert\(1\)&#62;/);
    assert.match(row, /Med&#34;ium/);
    assert.match(row, /aria-current="true"/);
    const model = modelOptionHtml({ provider: "<p>", id: "x&y", name: "<b>bold</b>", current: false }, 1, { readOnly: true });
    assert.doesNotMatch(model, /<b>|<p>/);
    assert.match(model, /&#60;b&#62;bold&#60;\/b&#62;/);
    assert.match(model, /&#60;p&#62;\/x&#38;y/);
    assert.match(model, /aria-disabled="true"/);
    assert.doesNotMatch(fastOptionHtml({ on: false, available: false, reason: "<i>no</i>" }, 2), /<i>/);
    assert.doesNotMatch(fastOptionHtml({ on: false, available: true, reason: null }, 2), /aria-disabled/);
    assert.match(fastOptionHtml({ on: false, available: true, reason: null }, 2, { readOnly: true }), /aria-disabled="true"/);
  });

  it("opens from Change Mode… in the palette, and from Ctrl+S only in the prompt before the mode is locked", async () => {
    const { DEFAULT_COMMANDS } = await importSource("extensions/ampi-gui/client/commands.js");
    const change = DEFAULT_COMMANDS.find((command) => command.id === "change-mode");
    const key = DEFAULT_COMMANDS.find((command) => command.id === "choose-mode");
    assert.equal(change.palette.title, "Change Mode…");
    assert.deepEqual(key.keys, ["ctrl+s"]);
    const page = { threadPage: true, promptFocused: true, modes: { locked: false } };
    assert.equal(change.when(page).state, "available");
    assert.equal(change.when({ ...page, modes: null }).state, "unavailable", "a read-only session");
    assert.equal(key.when(page).state, "available");
    assert.equal(key.when({ ...page, promptFocused: false }).state, "hidden", "Ctrl+S elsewhere stays the browser's");
    const locked = key.when({ ...page, modes: { locked: true } });
    assert.equal(locked.state, "unavailable");
    assert.match(locked.reason, /Change Mode… in the palette/);
    assert.equal(change.when({ ...page, modes: { locked: true } }).state, "available", "the palette keeps the override one step away");
  });
});

describe("ampi-gui mode picker: the dialog in a document", () => {
  const PAGE =
    '<dialog class="mode-picker" id="mode-picker"><div class="mode-picker-head"><input class="mode-picker-input"><kbd class="mode-picker-key"></kbd>' +
    '<div class="mode-picker-tabs" role="tablist"><button type="button" role="tab" data-tab="modes">Modes</button><button type="button" role="tab" data-tab="models">Models</button></div></div>' +
    '<div class="mode-picker-notice" role="status" hidden><span class="mode-picker-notice-text"></span><button class="button mode-picker-override" type="button" hidden>Change anyway</button></div>' +
    '<div class="mode-picker-body"><div class="mode-picker-list" role="listbox"></div><p class="mode-picker-empty" hidden></p></div></dialog>';
  const MODES = {
    current: "medium",
    locked: false,
    lockReason: null,
    model: "openai-codex/gpt-5.6-sol",
    fast: { on: false, available: true, reason: null },
    modes: [
      { key: "medium", label: "Medium", description: "Most tasks", color: null, agentModel: null, oracleModel: null, available: true, reason: null },
      { key: "free", label: "Free", description: "Pi's own controls", color: null, agentModel: null, oracleModel: null, available: true, reason: null },
    ],
    models: [],
  };
  const settle = () => new Promise(setImmediate);

  /** A linkedom page with the picker open on `source`; the global document is the page's while `run` runs. */
  async function withPicker(source, run) {
    const { mountModePicker } = await importSource("extensions/ampi-gui/client/mode-picker.js");
    const { parseHTML } = await import("linkedom");
    const { window, document } = parseHTML(`<!doctype html><html><body>${PAGE}</body></html>`);
    window.HTMLElement.prototype.focus = () => {};
    window.HTMLElement.prototype.scrollIntoView = () => {};
    const dialog = document.getElementById("mode-picker");
    dialog.showModal = () => {
      dialog.open = true;
    };
    dialog.close = () => {
      dialog.open = false;
    };
    const saved = globalThis.document;
    globalThis.document = document;
    try {
      const picker = mountModePicker({ dialog, notify: () => {} });
      picker.open(null, source);
      await settle();
      const input = dialog.querySelector(".mode-picker-input");
      const key = (name) => input.dispatchEvent(Object.assign(new window.Event("keydown", { bubbles: true }), { key: name }));
      await run({ dialog, key, picker });
    } finally {
      globalThis.document = saved;
    }
  }

  it("shows a lock the server reports after the picker loaded as it shows a loaded one, with Change anyway", async () => {
    const answers = [MODES, { ...MODES, locked: true, lockReason: LOCK_REASON }];
    const changes = [];
    const source = {
      load: async () => ({ ok: true, body: answers.shift() }),
      change: async (route, body) => {
        changes.push([route, body]);
        return { ok: false, body: { state: "locked", error: LOCK_REASON } };
      },
      busy: () => null,
    };
    await withPicker(source, async ({ dialog, key }) => {
      assert.equal(dialog.querySelector(".mode-picker-notice").hidden, true, "unlocked when it opened");
      key("ArrowDown");
      key("Enter");
      await settle();
      assert.deepEqual(changes, [["mode", { mode: "free" }]]);
      assert.equal(dialog.open, true);
      const notice = dialog.querySelector(".mode-picker-notice");
      assert.equal(notice.hidden, false);
      assert.equal(notice.dataset.kind, "locked");
      assert.equal(dialog.querySelector(".mode-picker-notice-text").textContent, "The session has a message.");
      assert.equal(dialog.querySelector(".mode-picker-override").hidden, false);
      assert.equal(dialog.querySelector('[data-kind="mode"]').getAttribute("aria-disabled"), "true", "the rows are read-only again");
    });
  });

  it("keeps the Fast row read-only while a turn runs", async () => {
    let busy = "Pi is working on a turn.";
    const changes = [];
    const source = {
      load: async () => ({ ok: true, body: MODES }),
      change: async (route) => {
        changes.push(route);
        return { ok: true, body: { fast: true } };
      },
      busy: () => busy,
    };
    await withPicker(source, async ({ dialog, key, picker }) => {
      const fast = () => dialog.querySelector('[data-kind="fast"]');
      assert.equal(fast().getAttribute("aria-disabled"), "true");
      key("ArrowDown");
      key("ArrowDown");
      assert.equal(fast().getAttribute("aria-selected"), "true");
      key("Enter");
      await settle();
      assert.deepEqual(changes, [], "nothing is sent while the turn runs");
      // The turn ends: the page redraws the picker, and Fast can be chosen again.
      busy = null;
      picker.refresh();
      assert.equal(fast().hasAttribute("aria-disabled"), false);
      key("ArrowDown");
      key("ArrowDown");
      key("Enter");
      await settle();
      assert.deepEqual(changes, ["fast"]);
    });
  });
});
