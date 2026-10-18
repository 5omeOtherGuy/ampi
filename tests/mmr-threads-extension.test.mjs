import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
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
let reportsSeam;
/** Text the extension put on the clipboard, and an error to fail the next copy with. */
let copied;
let copyError;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "ampi-threads-ext-"));
  registry = await importSource("extensions/ampi-core/command-registry.ts");
  seam = await importSource("extensions/ampi-core/thread-index.ts");
  historySeam = await importSource("extensions/ampi-core/prompt-history.ts");
  reportsSeam = await importSource("extensions/ampi-core/thread-reports.ts");
  registry.__resetMmrCommandsForTests();
  copied = [];
  copyError = undefined;
});

afterEach(() => {
  registry.__resetMmrCommandsForTests();
  assert.equal(seam.getMmrThreadIndex(), undefined, "each case must release the thread index");
  assert.equal(historySeam.getMmrPromptHistory(), undefined, "each case must release the prompt history");
  assert.equal(reportsSeam.getMmrThreadReports(), undefined, "each case must release the thread reports");
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
    loadSettings: () => ({ enabled: true, autoArchiveOnQuit: false, showCosts: true, ...settings }),
    createStore: (options) => createMmrThreadIndexStore({ ...options, baseDir: path.join(dir, "threads") }),
    createHistoryStore: () =>
      createMmrPromptHistoryStore({
        baseDir: path.join(dir, "threads", "history"),
        now: () => new Date(Date.UTC(2026, 9, 18, 10, 0, second++)).toISOString(),
      }),
    now: () => ARCHIVED_AT,
    copyText: async (text) => {
      if (copyError) throw copyError;
      copied.push(text);
    },
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
      "thread.rename": undefined,
      "thread.archive": "ctrl+c ctrl+n",
      "thread.unarchive": undefined,
      "thread.archiveAndQuit": "ctrl+c ctrl+e",
      "thread.switchToPrevious": undefined,
      "thread.switchToNext": undefined,
      "thread.copyMarkdown": undefined,
      "thread.copyURL": undefined,
    });
    assert.deepEqual(
      registry.getMmrCommands().map((c) => `${c.noun} ${c.verb}`),
      [
        "thread new",
        "thread rename",
        "thread archive and new",
        "thread unarchive",
        "thread archive and quit",
        "thread switch to previous",
        "thread switch to next",
        "thread copy markdown",
        "thread copy resume command",
      ],
    );
    assert.ok(t.commands.has("ampi-thread"));
    assert.equal(seam.getMmrThreadIndex()?.path, indexFile());
    assert.equal(historySeam.getMmrPromptHistory()?.dir, path.join(dir, "threads", "history"));
    assert.equal(reportsSeam.getMmrThreadReports()?.showCosts, true);

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
    const usage = { message: "Usage: /ampi-thread new | archive | switch <session id> | previous | next", level: "warning" };
    for (const args of ["delete", "switch", "switch a b", "new now", "previous 2"]) {
      await t.commands.get("ampi-thread").handler(args, t.ctx);
      assert.deepEqual(t.notifications.at(-1), usage, args);
    }
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

/** Pi session files with one exchange each, in `dir/sessions`, newest last; returns `{ id, path }` per title. */
function writeSessions(titles, cwd = "/work/parser") {
  const sessionDir = path.join(dir, "sessions");
  const written = {};
  titles.forEach((title, index) => {
    const manager = SessionManager.create(cwd, sessionDir);
    const timestamp = Date.UTC(2026, 9, 18, 9, index);
    manager.appendMessage({ role: "user", content: title, timestamp });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `Done: ${title}` }],
      timestamp: timestamp + 1000,
      api: "faux",
      provider: "faux",
      model: "faux-1",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
    });
    written[title] = { id: manager.getSessionId(), path: manager.getSessionFile() };
  });
  return { sessionDir, sessions: written };
}

/**
 * A context in the session `current` of `sessionDir`, with the command-only
 * `switchSession`, recording its calls; `cancel` makes Pi refuse the switch.
 */
function switchContext(sessionDir, current, { entries = [MESSAGE], cancel = false } = {}) {
  const context = sessionContext({ sessionId: current?.id ?? "unsaved", entries, cwd: "/work/parser" });
  context.ctx.sessionManager.getSessionFile = () => current?.path ?? path.join(sessionDir, "unsaved.jsonl");
  context.ctx.sessionManager.getSessionDir = () => sessionDir;
  context.switches = [];
  context.ctx.switchSession = async (target) => {
    context.switches.push(target);
    return { cancelled: cancel };
  };
  return context;
}

describe("ampi-threads session switching", () => {
  let history;
  beforeEach(async () => {
    history = await importSource("extensions/ampi-threads/switch-history.ts");
    history.__resetMmrThreadSwitchHistoryForTests();
  });
  afterEach(() => history.__resetMmrThreadSwitchHistoryForTests());

  it("switches by id, then back and forth through previous and next, the way a browser's history does", async () => {
    const mock = await loadExtension();
    const { sessionDir, sessions } = writeSessions(["Parser", "Imports", "Docs"]);
    const { Parser, Imports, Docs } = sessions;
    const route = (args, context) => mock.commands.get("ampi-thread").handler(args, context.ctx);
    const at = (session) => switchContext(sessionDir, session);

    const parser = at(Parser);
    await mock.handlers.get("session_start")(startEvent, parser.ctx);
    assert.deepEqual(availability("thread.switchToPrevious", parser.ctx), { state: "unavailable", reason: "no session to go back to" });
    assert.deepEqual(availability("thread.switchToNext", parser.ctx), { state: "unavailable", reason: "no session to go forward to" });
    await route("previous", parser);
    assert.deepEqual(parser.notifications.at(-1), { message: "Nothing to switch to: no session to go back to.", level: "info" });
    assert.deepEqual(parser.switches, []);

    await route(`switch ${Imports.id}`, parser);
    assert.deepEqual(parser.switches, [Imports.path], "Pi's switch path, with the session file");
    await route(`switch ${Docs.id}`, at(Imports));
    assert.deepEqual(history.getMmrThreadSwitchHistory(), { previous: [Imports.path, Parser.path], next: [] });

    const docs = at(Docs);
    assert.deepEqual(availability("thread.switchToPrevious", docs.ctx), { state: "available" });
    assert.deepEqual(availability("thread.switchToNext", docs.ctx), { state: "unavailable", reason: "no session to go forward to" });
    command("thread.switchToPrevious").run(docs.ctx);
    assert.deepEqual(mock.calls.sendUserMessage.at(-1), { content: "/ampi-thread previous", options: { expandPromptTemplates: true } });
    await route("previous", docs);
    assert.deepEqual(docs.switches, [Imports.path]);

    const imports = at(Imports);
    assert.deepEqual(availability("thread.switchToNext", imports.ctx), { state: "available" });
    await route("previous", imports);
    assert.deepEqual(imports.switches, [Parser.path]);
    assert.deepEqual(history.getMmrThreadSwitchHistory(), { previous: [], next: [Imports.path, Docs.path] });

    const back = at(Parser);
    command("thread.switchToNext").run(back.ctx);
    assert.deepEqual(mock.calls.sendUserMessage.at(-1), { content: "/ampi-thread next", options: { expandPromptTemplates: true } });
    await route("next", back);
    assert.deepEqual(back.switches, [Imports.path]);
    assert.deepEqual(history.getMmrThreadSwitchHistory(), { previous: [Parser.path], next: [Docs.path] });

    // A new switch starts a new branch: there is nothing to go forward to.
    await route(`switch ${Parser.id}`, at(Imports));
    assert.deepEqual(history.getMmrThreadSwitchHistory(), { previous: [Imports.path, Parser.path], next: [] });
    await mock.handlers.get("session_shutdown")(quitEvent, parser.ctx);
  });

  it("refuses an unknown id and the current session, and records nothing when Pi cancels the switch", async () => {
    const mock = await loadExtension();
    const { sessionDir, sessions } = writeSessions(["Parser", "Imports"]);
    const route = (args, context) => mock.commands.get("ampi-thread").handler(args, context.ctx);
    const parser = switchContext(sessionDir, sessions.Parser);
    await mock.handlers.get("session_start")(startEvent, parser.ctx);

    await route("switch 0000", parser);
    assert.deepEqual(parser.notifications.at(-1), { message: "No session has the id 0000.", level: "warning" });
    await route(`switch ${sessions.Parser.id}`, parser);
    assert.deepEqual(parser.notifications.at(-1), { message: "That is the current session.", level: "info" });
    assert.deepEqual(parser.switches, []);

    const refused = switchContext(sessionDir, sessions.Parser, { cancel: true });
    await route(`switch ${sessions.Imports.id}`, refused);
    assert.deepEqual(refused.switches, [sessions.Imports.path]);
    assert.deepEqual(history.getMmrThreadSwitchHistory(), { previous: [], next: [] });
    await mock.handlers.get("session_shutdown")(quitEvent, parser.ctx);
  });

  it("finds a session of another workspace by id", async () => {
    const mock = await loadExtension();
    const { sessionDir, sessions } = writeSessions(["Parser"]);
    const { Website } = writeSessions(["Website"], "/work/website").sessions;
    const parser = switchContext(sessionDir, sessions.Parser);
    await mock.handlers.get("session_start")(startEvent, parser.ctx);
    await mock.commands.get("ampi-thread").handler(`switch ${Website.id}`, parser.ctx);
    assert.deepEqual(parser.switches, [Website.path]);
    await mock.handlers.get("session_shutdown")(quitEvent, parser.ctx);
  });

  it("does not offer an unsaved session to go back to, and forgets a session file that is gone", async () => {
    const mock = await loadExtension();
    const { sessionDir, sessions } = writeSessions(["Parser", "Imports"]);
    const route = (args, context) => mock.commands.get("ampi-thread").handler(args, context.ctx);
    const empty = switchContext(sessionDir, undefined, { entries: [] });
    await mock.handlers.get("session_start")(startEvent, empty.ctx);
    await route(`switch ${sessions.Parser.id}`, empty);
    assert.deepEqual(history.getMmrThreadSwitchHistory(), { previous: [], next: [] }, "a session without messages has no file to reopen");

    await route(`switch ${sessions.Imports.id}`, switchContext(sessionDir, sessions.Parser));
    rmSync(sessions.Parser.path);
    const imports = switchContext(sessionDir, sessions.Imports);
    await route("previous", imports);
    assert.deepEqual(imports.switches, [], "Pi would start a new session at a missing path");
    assert.deepEqual(imports.notifications.at(-1), { message: "That session no longer exists.", level: "warning" });
    assert.deepEqual(availability("thread.switchToPrevious", imports.ctx), { state: "unavailable", reason: "no session to go back to" });
    await mock.handlers.get("session_shutdown")(quitEvent, empty.ctx);
  });

  it("reports a switch Pi could not make", async () => {
    const mock = await loadExtension();
    const { sessionDir, sessions } = writeSessions(["Parser", "Imports"]);
    const parser = switchContext(sessionDir, sessions.Parser);
    await mock.handlers.get("session_start")(startEvent, parser.ctx);
    parser.ctx.switchSession = async () => {
      throw new Error("the session's working directory is gone");
    };
    await mock.commands.get("ampi-thread").handler(`switch ${sessions.Imports.id}`, parser.ctx);
    assert.deepEqual(parser.notifications.at(-1), {
      message: "Could not switch sessions: the session's working directory is gone",
      level: "error",
    });
    assert.deepEqual(history.getMmrThreadSwitchHistory(), { previous: [], next: [] });
    await mock.handlers.get("session_shutdown")(quitEvent, parser.ctx);
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

/**
 * Run `open` and resolve with the overlay it shows in `context`, once the
 * session files are read however long that takes; a notification before the
 * overlay opens rejects instead.
 */
function overlayOpenedBy(context, open) {
  const { custom, notify } = context.ctx.ui;
  const opened = new Promise((resolve, reject) => {
    const restore = () => Object.assign(context.ctx.ui, { custom, notify });
    context.ctx.ui.custom = (factory, options) => {
      restore();
      const result = custom(factory, options);
      resolve(context.overlays.at(-1));
      return result;
    };
    context.ctx.ui.notify = (message, level) => {
      restore();
      notify(message, level);
      reject(new Error(`no overlay opened: ${message}`));
    };
  });
  open();
  return opened;
}

describe("ampi-threads thread switcher in ampi-tui", () => {
  it("lists this workspace's sessions from Pi's session files, and Enter switches through /ampi-thread switch", async () => {
    const mock = await loadExtension();
    const { sessionDir, sessions } = writeSessions(["Rename the parser", "Fix the imports", "Write the docs"]);
    writeThreads({ [sessions["Write the docs"].id]: { archived: ARCHIVED_AT } });
    const context = switchContext(sessionDir, sessions["Rename the parser"]);
    await mock.handlers.get("session_start")(startEvent, context.ctx);
    const { createMmrTuiKeys } = await importSource("extensions/ampi-tui/keys/install.ts");
    const keys = createMmrTuiKeys(mock.pi, { now: () => 0, setTimer: () => ({}), clearTimer: () => {} });
    keys.start(context.ctx, () => undefined);
    try {
      assert.deepEqual(availability("thread.switch", context.ctx), { state: "available" });
      const overlay = await overlayOpenedBy(context, () => command("thread.switch").run(context.ctx));
      assert.equal(context.overlays.length, 1);
      assert.deepEqual(
        overlay.component.getRows().map((row) => [row.title, row.current]),
        [
          ["Rename the parser", true],
          ["Fix the imports", false],
        ],
        "the current session first; the archived one hidden",
      );
      overlay.component.handleInput("\x1b[B");
      overlay.component.handleInput("\r");
      await new Promise((resolve) => setImmediate(resolve));
      const sent = `/ampi-thread switch ${sessions["Fix the imports"].id}`;
      assert.deepEqual(mock.calls.sendUserMessage, [{ content: sent, options: { expandPromptTemplates: true } }]);
      await mock.commands.get("ampi-thread").handler(sent.slice("/ampi-thread ".length), context.ctx);
      assert.deepEqual(context.switches, [sessions["Fix the imports"].path]);

      // Picking the current session switches nowhere.
      const again = await overlayOpenedBy(context, () => command("thread.switch").run(context.ctx));
      assert.equal(context.overlays.length, 2);
      again.component.handleInput("\r");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(mock.calls.sendUserMessage.length, 1);
    } finally {
      keys.stop();
      await mock.handlers.get("session_shutdown")(quitEvent, context.ctx);
    }
  });
});

describe("ampi-threads Markdown, cost and context", () => {
  const fixtures = path.join(repoRoot, "tests", "fixtures", "ampi-threads-markdown");
  const MODEL = { provider: "anthropic", id: "claude-sonnet-4-5", contextWindow: 200000 };

  /** A context in the fixture session: its header, its entries (one abandoned branch), its model. */
  function fixtureContext() {
    const [header, ...entries] = readFileSync(path.join(fixtures, "session.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const context = sessionContext({
      entries,
      cwd: "/work/demo",
      model: MODEL,
      models: [MODEL],
      getContextUsage: () => ({ tokens: 1505, contextWindow: 200000, percent: 0.75 }),
    });
    context.ctx.sessionManager.getHeader = () => header;
    context.ctx.sessionManager.getBranch = () => entries;
    context.ctx.getSystemPrompt = () => "You are a coding agent.";
    return context;
  }

  it("copies the session as Markdown and says so; a failed copy says why", async () => {
    const t = await started();
    try {
      assert.deepEqual(availability("thread.copyMarkdown", sessionContext({ entries: [] }).ctx), {
        state: "unavailable",
        reason: "this session has no messages yet",
      });
      const context = fixtureContext();
      assert.deepEqual(availability("thread.copyMarkdown", context.ctx), { state: "available" });
      await command("thread.copyMarkdown").run(context.ctx);
      assert.deepEqual(copied, [readFileSync(path.join(fixtures, "session.md"), "utf8")]);
      assert.deepEqual(context.notifications, [{ message: "Copied the thread as Markdown", level: "info" }]);

      copyError = new Error("Clipboard unavailable");
      await command("thread.copyMarkdown").run(context.ctx);
      assert.deepEqual(context.notifications.at(-1), { message: "Could not copy the thread: Clipboard unavailable", level: "error" });
      assert.equal(copied.length, 1);
    } finally {
      await t.handlers.get("session_shutdown")(quitEvent, t.ctx);
    }
  });

  it("copies the command that continues a saved session, and is unavailable before a message or without a session file", async () => {
    const t = await started();
    const sessionId = "0193f1c2-7a4e-7b10-9c3d-5e6f7a8b9c0d";
    try {
      assert.deepEqual(availability("thread.copyURL", sessionContext({ sessionId, entries: [], sessionFile: "/s/a.jsonl" }).ctx), {
        state: "unavailable",
        reason: "this session has no messages yet",
      });
      // Pi run with --no-session keeps the session in memory, with no file.
      assert.deepEqual(availability("thread.copyURL", sessionContext({ sessionId }).ctx), {
        state: "unavailable",
        reason: "this session is not saved (Pi runs with --no-session)",
      });
      const context = sessionContext({ sessionId, sessionFile: "/s/a.jsonl" });
      assert.deepEqual(availability("thread.copyURL", context.ctx), { state: "available" });
      await command("thread.copyURL").run(context.ctx);
      assert.deepEqual(copied, ["ampi threads continue 0193f1c2-7a4e-7b10-9c3d-5e6f7a8b9c0d"]);
      assert.deepEqual(context.notifications, [
        { message: "Copied the resume command: ampi threads continue 0193f1c2-7a4e-7b10-9c3d-5e6f7a8b9c0d", level: "info" },
      ]);

      copyError = new Error("Clipboard unavailable");
      await command("thread.copyURL").run(context.ctx);
      assert.deepEqual(context.notifications.at(-1), {
        message: "Could not copy the resume command: Clipboard unavailable",
        level: "error",
      });
      assert.equal(copied.length, 1);
    } finally {
      await t.handlers.get("session_shutdown")(quitEvent, t.ctx);
    }
  });

  it("shows the session's cost and what fills its context in ampi-tui's overlays", async () => {
    const mock = await loadExtension();
    const context = fixtureContext();
    await mock.handlers.get("session_start")(startEvent, context.ctx);
    const { createMmrTuiKeys } = await importSource("extensions/ampi-tui/keys/install.ts");
    const keys = createMmrTuiKeys(mock.pi, { now: () => 0, setTimer: () => ({}), clearTimer: () => {} });
    keys.start(context.ctx, () => undefined);
    try {
      assert.deepEqual(availability("thread.showCost", context.ctx), { state: "available" });
      command("thread.showCost").run(context.ctx);
      const cost = context.overlays.at(-1).component.render(100);
      assert.match(cost[0], /^╭─ Thread Cost ─/);
      assert.match(cost[2], /^│ Total: \$0\.02 +│$/);
      assert.match(cost[4], /^│ anthropic\/claude-sonnet-4-5 +\$0\.02 │$/);
      assert.match(cost[5], /^│ {3}7\.5k in · 135 out +│$/);
      assert.match(cost.at(-1), / Esc close ─╯$/);

      assert.deepEqual(availability("thread.analyzeContext", context.ctx), { state: "available" });
      command("thread.analyzeContext").run(context.ctx);
      const analysis = context.overlays.at(-1).component.render(100).join("\n");
      assert.match(analysis, /^╭─ Analyze Context ─/);
      assert.match(analysis, /│ anthropic\/claude-sonnet-4-5 · 200k context window +│/);
      assert.match(analysis, /│ Compactions: 0 +│/);
      assert.match(analysis, /│ Pi counted 1\.5k tokens at the last response\. +│/);
    } finally {
      keys.stop();
      await mock.handlers.get("session_shutdown")(quitEvent, context.ctx);
    }
  });

  it("turns the cost overlay off with showCosts: false, and tells ampi-tui's gauge", async () => {
    const t = await started({ showCosts: false });
    try {
      assert.equal(reportsSeam.getMmrThreadReports()?.showCosts, false);
      const { createMmrTuiCommands } = await importSource("extensions/ampi-tui/keys/commands.ts");
      const commands = createMmrTuiCommands({ getTui: () => undefined, pi: t.pi });
      const check = (id) => commands.find((candidate) => candidate.id === id).availability(t.ctx);
      assert.deepEqual(check("thread.showCost"), { state: "unavailable", reason: "costs are turned off (ampiThreads.showCosts)" });
      assert.deepEqual(check("thread.analyzeContext"), { state: "available" });
    } finally {
      await t.handlers.get("session_shutdown")(quitEvent, t.ctx);
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
      assert.deepEqual(loadMmrThreadsSettings(cwd, { homeDirectory: home, env: {} }), {
        enabled: true,
        autoArchiveOnQuit: false,
        showCosts: true,
        titles: true,
      });
    });
  });

  it("reads ampiThreads globally, lets the project override each key, and accepts nested ampi.threads", async () => {
    const { loadMmrThreadsSettings } = await importSource("extensions/ampi-threads/config.ts");
    await withDirs(({ home, cwd, writeGlobal, writeProject }) => {
      const load = () => loadMmrThreadsSettings(cwd, { homeDirectory: home, env: {} });
      writeGlobal({ ampiThreads: { enabled: false, autoArchiveOnQuit: true, showCosts: false, titles: false } });
      assert.deepEqual(load(), { enabled: false, autoArchiveOnQuit: true, showCosts: false, titles: false });
      writeProject({ ampi: { threads: { enabled: true } } });
      assert.deepEqual(
        load(),
        { enabled: true, autoArchiveOnQuit: true, showCosts: false, titles: false },
        "a key the project leaves out keeps the global value",
      );
      writeProject({ ampiThreads: { autoArchiveOnQuit: "yes", showCosts: true, titles: true } });
      assert.deepEqual(
        load(),
        { enabled: false, autoArchiveOnQuit: true, showCosts: true, titles: true },
        "a non-boolean value is ignored",
      );
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
  it("auto-loads after ampi-tui and before ampi-gui and ampi-history, which stays last", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const order = pkg.pi.extensions;
    const threads = order.indexOf("./src/extensions/ampi-threads/index.ts");
    assert.equal(order[threads - 1], "./src/extensions/ampi-tui/index.ts");
    assert.equal(order[threads + 1], "./src/extensions/ampi-gui/index.ts");
    assert.equal(order.at(-1), "./src/extensions/ampi-history/index.ts");
    assert.equal(pkg.exports["./extensions/ampi-threads"], "./src/extensions/ampi-threads/index.ts");
    assert.equal(pkg.exports["./extensions/mmr-threads"], "./src/extensions/ampi-threads/index.ts");
  });
});
