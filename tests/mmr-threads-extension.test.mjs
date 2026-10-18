import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const repoRoot = path.resolve(import.meta.dirname, "..");
const ARCHIVED_AT = "2026-10-18T10:00:00.000Z";
const MESSAGE = { type: "message", message: { role: "user", content: "hello" } };
const startEvent = { type: "session_start", reason: "startup" };
const quitEvent = { type: "session_shutdown", reason: "quit" };

let dir;
let registry;
let seam;
let historySeam;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "ampi-threads-ext-"));
  registry = await importSource("extensions/ampi-core/command-registry.ts");
  seam = await importSource("extensions/ampi-core/thread-index.ts");
  historySeam = await importSource("extensions/ampi-core/prompt-history.ts");
  registry.__resetMmrCommandsForTests();
});

afterEach(() => {
  registry.__resetMmrCommandsForTests();
  assert.equal(seam.getMmrThreadIndex(), undefined, "each case must release the thread index");
  assert.equal(historySeam.getMmrPromptHistory(), undefined, "each case must release the prompt history");
  rmSync(dir, { recursive: true, force: true });
});

const indexFile = () => path.join(dir, "threads", "index.json");
const readThreads = () => (existsSync(indexFile()) ? JSON.parse(readFileSync(indexFile(), "utf8")).threads : {});

function writeThreads(threads) {
  mkdirSync(path.dirname(indexFile()), { recursive: true });
  writeFileSync(indexFile(), JSON.stringify({ version: 1, threads }));
}

async function loadExtension(settings = {}, mock = createMockPi()) {
  const { createMmrThreadsExtension } = await importSource("extensions/ampi-threads/index.ts");
  const { createMmrThreadIndexStore } = await importSource("extensions/ampi-threads/index-store.ts");
  const { createMmrPromptHistoryStore } = await importSource("extensions/ampi-threads/history-store.ts");
  let second = 0;
  createMmrThreadsExtension({
    loadSettings: () => ({ enabled: true, autoArchiveOnQuit: false, ...settings }),
    createStore: (options) => createMmrThreadIndexStore({ ...options, baseDir: path.join(dir, "threads") }),
    createHistoryStore: () =>
      createMmrPromptHistoryStore({
        baseDir: path.join(dir, "threads", "history"),
        now: () => new Date(Date.UTC(2026, 9, 18, 10, 0, second++)).toISOString(),
      }),
    now: () => ARCHIVED_AT,
  })(mock.pi);
  return mock;
}

/** Prompts recorded for `cwd`, newest first, read through the registered seam. */
async function recorded(cwd) {
  return (await historySeam.getMmrPromptHistory().read(cwd, "workspace")).map((entry) => entry.text);
}

/** A session context that also carries the command-only `newSession`, recording its calls. */
function sessionContext({ sessionId = "s-1", entries = [MESSAGE], ...options } = {}) {
  const context = createMockExtensionContext({ sessionId, entries, ...options });
  context.newSessions = [];
  context.ctx.newSession = async (newSessionOptions) => {
    context.newSessions.push(newSessionOptions);
    return { cancelled: false };
  };
  return context;
}

const command = (id) => registry.getMmrCommand(id);
const availability = (id, ctx) => command(id).availability?.(ctx) ?? { state: "available" };

async function started(settings, contextOptions) {
  const mock = await loadExtension(settings);
  const context = sessionContext(contextOptions);
  await mock.handlers.get("session_start")(startEvent, context.ctx);
  return { ...mock, ...context };
}

describe("ampi-threads extension", () => {
  it("registers the thread commands, their slash route and the index, and releases them on shutdown", async () => {
    const t = await started();
    const keys = Object.fromEntries(registry.getMmrCommands().map((c) => [c.id, c.defaultKey]));
    assert.deepEqual(keys, {
      "thread.new": undefined,
      "thread.archive": "ctrl+c ctrl+n",
      "thread.unarchive": undefined,
      "thread.archiveAndQuit": "ctrl+c ctrl+e",
    });
    assert.deepEqual(
      registry.getMmrCommands().map((c) => `${c.noun} ${c.verb}`),
      ["thread new", "thread archive and new", "thread unarchive", "thread archive and quit"],
    );
    assert.ok(t.commands.has("ampi-thread"));
    assert.equal(seam.getMmrThreadIndex()?.path, indexFile());
    assert.equal(historySeam.getMmrPromptHistory()?.dir, path.join(dir, "threads", "history"));

    await t.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "new" }, t.ctx);
    assert.deepEqual(registry.getMmrCommands(), []);
  });

  it("starts a new session for thread new through /ampi-thread", async () => {
    const t = await started();
    command("thread.new").run(t.ctx);
    assert.deepEqual(t.calls.sendUserMessage, [{ content: "/ampi-thread new", options: { expandPromptTemplates: true } }]);
    await t.commands.get("ampi-thread").handler("new", t.ctx);
    assert.equal(t.newSessions.length, 1);
    assert.deepEqual(readThreads(), {}, "a new session archives nothing");
    await t.handlers.get("session_shutdown")(quitEvent, t.ctx);
  });

  it("archives the session and starts a new one for thread archive", async () => {
    const t = await started();
    assert.deepEqual(availability("thread.archive", t.ctx), { state: "available" });
    assert.deepEqual(availability("thread.unarchive", t.ctx), { state: "unavailable", reason: "this session is not archived" });

    command("thread.archive").run(t.ctx);
    assert.deepEqual(t.calls.sendUserMessage, [{ content: "/ampi-thread archive", options: { expandPromptTemplates: true } }]);
    await t.commands.get("ampi-thread").handler("archive", t.ctx);

    assert.deepEqual(readThreads(), { "s-1": { archived: ARCHIVED_AT } });
    assert.equal(t.newSessions.length, 1);
    const next = createMockExtensionContext();
    await t.newSessions[0].withSession(next.ctx);
    assert.deepEqual(next.notifications, [{ message: "Archived the previous session.", level: "info" }]);

    assert.deepEqual(availability("thread.archive", t.ctx), { state: "unavailable", reason: "this session is already archived" });
    assert.deepEqual(availability("thread.archiveAndQuit", t.ctx), { state: "unavailable", reason: "this session is already archived" });
    assert.deepEqual(availability("thread.unarchive", t.ctx), { state: "available" });
    await t.handlers.get("session_shutdown")(quitEvent, t.ctx);
  });

  it("refuses to archive an archived session again, keeping its date and the session", async () => {
    writeThreads({ "s-1": { archived: "2026-01-01T00:00:00.000Z", pinned: true } });
    const t = await started();
    assert.deepEqual(availability("thread.archive", t.ctx), { state: "unavailable", reason: "this session is already archived" });
    await t.commands.get("ampi-thread").handler("archive", t.ctx);
    assert.equal(t.newSessions.length, 0);
    assert.deepEqual(t.notifications.at(-1), { message: "This session is already archived.", level: "info" });
    assert.deepEqual(readThreads(), { "s-1": { archived: "2026-01-01T00:00:00.000Z", pinned: true } });
    await t.handlers.get("session_shutdown")(quitEvent, t.ctx);
  });

  it("hides the archive commands in a session with no messages, and the route refuses it", async () => {
    const t = await started({}, { entries: [{ type: "model_change" }] });
    assert.deepEqual(availability("thread.archive", t.ctx), { state: "hidden" });
    assert.deepEqual(availability("thread.archiveAndQuit", t.ctx), { state: "hidden" });
    assert.deepEqual(availability("thread.new", t.ctx), { state: "available" });
    await t.commands.get("ampi-thread").handler("archive", t.ctx);
    assert.equal(t.newSessions.length, 0);
    assert.equal(existsSync(indexFile()), false);
    await t.handlers.get("session_shutdown")(quitEvent, t.ctx);
  });

  it("unarchives the session, keeping its other fields", async () => {
    writeThreads({ "s-1": { archived: ARCHIVED_AT, labels: ["keep"] }, "s-2": { archived: ARCHIVED_AT } });
    const t = await started();
    assert.deepEqual(availability("thread.unarchive", t.ctx), { state: "available" });
    await command("thread.unarchive").run(t.ctx);
    assert.deepEqual(readThreads(), { "s-1": { labels: ["keep"] }, "s-2": { archived: ARCHIVED_AT } });
    assert.deepEqual(availability("thread.unarchive", t.ctx), { state: "unavailable", reason: "this session is not archived" });
    assert.deepEqual(availability("thread.archive", t.ctx), { state: "available" });
    await t.handlers.get("session_shutdown")(quitEvent, t.ctx);
  });

  it("answers an unknown /ampi-thread action with its usage", async () => {
    const t = await started();
    await t.commands.get("ampi-thread").handler("delete", t.ctx);
    assert.deepEqual(t.notifications.at(-1), { message: "Usage: /ampi-thread new | archive", level: "warning" });
    assert.equal(t.newSessions.length, 0);
    await t.handlers.get("session_shutdown")(quitEvent, t.ctx);
  });

  describe("archive and quit", () => {
    it("archives, then stops a running turn and shuts Pi down when ampi-tui's quit is absent", async () => {
      const t = await started({}, { idle: false });
      await command("thread.archiveAndQuit").run(t.ctx);
      assert.deepEqual(readThreads(), { "s-1": { archived: ARCHIVED_AT } });
      assert.deepEqual(t.lifecycle, { abort: 1, shutdown: 1 });
      await t.handlers.get("session_shutdown")(quitEvent, t.ctx);
    });

    it("ends through the ampi.quit command when one is registered", async () => {
      const t = await started();
      const quits = [];
      registry.registerMmrCommand({
        id: "ampi.quit",
        noun: "ampi",
        verb: "quit",
        description: "Quit",
        run: (ctx) => {
          quits.push(readThreads());
          ctx.shutdown();
        },
      });
      await command("thread.archiveAndQuit").run(t.ctx);
      assert.deepEqual(quits, [{ "s-1": { archived: ARCHIVED_AT } }], "the session is archived before quitting");
      assert.deepEqual(t.lifecycle, { abort: 0, shutdown: 1 });
      await t.handlers.get("session_shutdown")(quitEvent, t.ctx);
    });
  });

  describe("auto-archive on quit", () => {
    it("archives an interactive session that quits when the setting is on", async () => {
      const t = await started({ autoArchiveOnQuit: true });
      await t.handlers.get("session_shutdown")(quitEvent, t.ctx);
      assert.deepEqual(readThreads(), { "s-1": { archived: ARCHIVED_AT } });
    });

    for (const [label, settings, event, contextOptions] of [
      ["the setting is off", { autoArchiveOnQuit: false }, quitEvent, {}],
      ["the session is replaced", { autoArchiveOnQuit: true }, { type: "session_shutdown", reason: "new" }, {}],
      ["Pi reloads", { autoArchiveOnQuit: true }, { type: "session_shutdown", reason: "reload" }, {}],
      ["a print or JSON run ends", { autoArchiveOnQuit: true }, quitEvent, { hasUI: false }],
      ["the session has no messages", { autoArchiveOnQuit: true }, quitEvent, { entries: [] }],
    ]) {
      it(`leaves the session alone when ${label}`, async () => {
        const t = await started(settings, contextOptions);
        await t.handlers.get("session_shutdown")(event, t.ctx);
        assert.deepEqual(readThreads(), {});
      });
    }
  });

  it("does nothing at all when disabled", async () => {
    const { createMmrThreadsExtension } = await importSource("extensions/ampi-threads/index.ts");
    const mock = createMockPi();
    createMmrThreadsExtension({ loadSettings: () => ({ enabled: false, autoArchiveOnQuit: true }) })(mock.pi);
    assert.deepEqual([...mock.handlers.keys()], []);
    assert.deepEqual([...mock.commands.keys()], []);
    assert.deepEqual(registry.getMmrCommands(), []);
    assert.equal(seam.getMmrThreadIndex(), undefined);
    assert.equal(historySeam.getMmrPromptHistory(), undefined);
  });
});

describe("ampi-threads prompt history recording", () => {
  const input = (text, source = "interactive") => ({ type: "input", text, source });

  it("records the prompts typed into the terminal, per working directory", async () => {
    const t = await started({}, { cwd: "/work/parser" });
    try {
      await t.handlers.get("input")(input("Rename the parser"), t.ctx);
      await t.handlers.get("input")(input("Now fix the imports"), t.ctx);
      const other = createMockExtensionContext({ cwd: "/work/website" });
      await t.handlers.get("input")(input("Deploy the preview"), other.ctx);
      assert.deepEqual(await recorded("/work/parser"), ["Now fix the imports", "Rename the parser"]);
      assert.deepEqual(await recorded("/work/website"), ["Deploy the preview"]);
    } finally {
      await t.handlers.get("session_shutdown")(quitEvent, t.ctx);
    }
  });

  it("leaves out slash commands, prompts from extensions and RPC clients, and runs outside the terminal UI", async () => {
    const t = await started({}, { cwd: "/work/parser" });
    try {
      await t.handlers.get("input")(input("/model"), t.ctx);
      await t.handlers.get("input")(input("  /review the parser"), t.ctx);
      await t.handlers.get("input")(input("sent by an extension", "extension"), t.ctx);
      await t.handlers.get("input")(input("sent over RPC", "rpc"), t.ctx);
      const print = createMockExtensionContext({ cwd: "/work/parser", hasUI: false });
      await t.handlers.get("input")(input("a print run"), print.ctx);
      assert.deepEqual(await recorded("/work/parser"), []);
      await t.handlers.get("input")(input("typed by you"), t.ctx);
      assert.deepEqual(await recorded("/work/parser"), ["typed by you"]);
    } finally {
      await t.handlers.get("session_shutdown")(quitEvent, t.ctx);
    }
  });
});

describe("ampi-threads keys in the ampi-tui dispatcher", () => {
  it("lists both archive rows after Ctrl+C in a session with messages, and Ctrl+N archives", async () => {
    const mock = await loadExtension();
    const context = sessionContext();
    await mock.handlers.get("session_start")(startEvent, context.ctx);
    const { createMmrTuiKeys } = await importSource("extensions/ampi-tui/keys/install.ts");
    const keys = createMmrTuiKeys(mock.pi, { now: () => 0, setTimer: () => ({}), clearTimer: () => {} });
    keys.start(context.ctx, () => undefined);
    try {
      assert.equal(context.terminalInput.send("\x03"), true);
      const popup = context.overlays.at(-1).component.render(48).join("\n");
      assert.match(popup, /Ctrl\+N {2}Archive and start a new session/);
      assert.match(popup, /Ctrl\+E {2}Archive and quit/);
      assert.match(popup, /Ctrl\+C {2}Quit/);

      assert.equal(context.terminalInput.send("\x0e"), true);
      assert.deepEqual(mock.calls.sendUserMessage, [{ content: "/ampi-thread archive", options: { expandPromptTemplates: true } }]);
    } finally {
      keys.stop();
      await mock.handlers.get("session_shutdown")(quitEvent, context.ctx);
    }
  });

  it("shows only Quit after Ctrl+C in a session with no messages", async () => {
    const mock = await loadExtension();
    const context = sessionContext({ entries: [] });
    await mock.handlers.get("session_start")(startEvent, context.ctx);
    const { createMmrTuiKeys } = await importSource("extensions/ampi-tui/keys/install.ts");
    const keys = createMmrTuiKeys(mock.pi, { now: () => 0, setTimer: () => ({}), clearTimer: () => {} });
    keys.start(context.ctx, () => undefined);
    try {
      context.terminalInput.send("\x03");
      const popup = context.overlays.at(-1).component.render(48).join("\n");
      assert.doesNotMatch(popup, /Archive/);
      assert.match(popup, /Ctrl\+C {2}Quit/);
    } finally {
      keys.stop();
      await mock.handlers.get("session_shutdown")(quitEvent, context.ctx);
    }
  });
});

describe("ampi-threads prompt history in ampi-tui", () => {
  it("opens on Ctrl+R with this workspace's prompts, and Enter puts the one picked into the prompt unsent", async () => {
    const mock = await loadExtension();
    const context = sessionContext({ cwd: "/work/parser" });
    await mock.handlers.get("session_start")(startEvent, context.ctx);
    const { createMmrTuiKeys } = await importSource("extensions/ampi-tui/keys/install.ts");
    const keys = createMmrTuiKeys(mock.pi, { now: () => 0, setTimer: () => ({}), clearTimer: () => {} });
    keys.start(context.ctx, () => undefined);
    try {
      await mock.handlers.get("input")({ type: "input", text: "Rename the parser", source: "interactive" }, context.ctx);
      await mock.handlers.get("input")({ type: "input", text: "Now fix the imports", source: "interactive" }, context.ctx);
      context.state.editorText = "half-typed";

      assert.equal(context.terminalInput.send("\x12"), true, "Ctrl+R is taken");
      // The picker reads the file before it opens; a later read on the same file queues behind that one.
      await recorded("/work/parser");
      await new Promise((resolve) => setImmediate(resolve));
      const overlay = context.overlays.at(-1);
      const rows = overlay.component.render(106);
      assert.equal(rows[0].startsWith("╭─ Prompt History "), true);
      assert.match(rows[4], /^│ {3}Now fix the imports +│$/);
      assert.match(rows[5], /^│ {3}Rename the parser +│$/);

      overlay.component.handleInput("\x1b[B");
      overlay.component.handleInput("\r");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(context.state.editorText, "Rename the parser");
      assert.deepEqual(mock.calls.sendUserMessage, [], "nothing is sent");
    } finally {
      keys.stop();
      await mock.handlers.get("session_shutdown")(quitEvent, context.ctx);
    }
  });
});

describe("ampi-threads settings", () => {
  function withDirs(run) {
    const root = mkdtempSync(path.join(os.tmpdir(), "ampi-threads-settings-"));
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
    mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    const writeGlobal = (value) => writeFileSync(path.join(home, ".pi/agent/settings.json"), JSON.stringify(value));
    const writeProject = (value) => writeFileSync(path.join(cwd, ".pi/settings.json"), JSON.stringify(value));
    return Promise.resolve(run({ home, cwd, writeGlobal, writeProject })).finally(() =>
      rmSync(root, { recursive: true, force: true }),
    );
  }

  it("is on, without auto-archive, by default", async () => {
    const { loadMmrThreadsSettings } = await importSource("extensions/ampi-threads/config.ts");
    await withDirs(({ home, cwd }) => {
      assert.deepEqual(loadMmrThreadsSettings(cwd, { homeDirectory: home, env: {} }), { enabled: true, autoArchiveOnQuit: false });
    });
  });

  it("reads ampiThreads globally, lets the project override each key, and accepts nested ampi.threads", async () => {
    const { loadMmrThreadsSettings } = await importSource("extensions/ampi-threads/config.ts");
    await withDirs(({ home, cwd, writeGlobal, writeProject }) => {
      const load = () => loadMmrThreadsSettings(cwd, { homeDirectory: home, env: {} });
      writeGlobal({ ampiThreads: { enabled: false, autoArchiveOnQuit: true } });
      assert.deepEqual(load(), { enabled: false, autoArchiveOnQuit: true });
      writeProject({ ampi: { threads: { enabled: true } } });
      assert.deepEqual(load(), { enabled: true, autoArchiveOnQuit: true }, "a key the project leaves out keeps the global value");
      writeProject({ ampiThreads: { autoArchiveOnQuit: "yes" } });
      assert.deepEqual(load(), { enabled: false, autoArchiveOnQuit: true }, "a non-boolean value is ignored");
    });
  });

  it("lets AMPI_THREADS_ENABLE (legacy MMR_THREADS_ENABLE) override settings files", async () => {
    const { loadMmrThreadsSettings } = await importSource("extensions/ampi-threads/config.ts");
    await withDirs(({ home, cwd, writeGlobal }) => {
      writeGlobal({ ampiThreads: { enabled: true } });
      const load = (env) => loadMmrThreadsSettings(cwd, { homeDirectory: home, env }).enabled;
      assert.equal(load({ AMPI_THREADS_ENABLE: "false" }), false);
      assert.equal(load({ MMR_THREADS_ENABLE: "0" }), false);
      assert.equal(load({ AMPI_THREADS_ENABLE: "true", MMR_THREADS_ENABLE: "false" }), true);
    });
  });
});

describe("ampi-threads package wiring", () => {
  it("auto-loads after ampi-tui and before ampi-history, which stays last", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const order = pkg.pi.extensions;
    const threads = order.indexOf("./src/extensions/ampi-threads/index.ts");
    assert.equal(order[threads - 1], "./src/extensions/ampi-tui/index.ts");
    assert.equal(order[threads + 1], "./src/extensions/ampi-history/index.ts");
    assert.equal(order.at(-1), "./src/extensions/ampi-history/index.ts");
    assert.equal(pkg.exports["./extensions/ampi-threads"], "./src/extensions/ampi-threads/index.ts");
    assert.equal(pkg.exports["./extensions/mmr-threads"], "./src/extensions/ampi-threads/index.ts");
  });
});
