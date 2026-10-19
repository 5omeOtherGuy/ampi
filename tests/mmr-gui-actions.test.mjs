// ampi-gui More Actions on real files: each route against a session server
// on 127.0.0.1, with sessions written by Pi's SessionManager in a temporary
// agent directory, the real ampi-threads extension (its thread index store
// and reports) on a stub Pi, and a private live registry whose processes
// are declared alive. Covers validation and 404s, the live-holder 409 for
// rename and delete with the file left as it was, a rename forwarded to the
// terminal that holds the session, a rename and a delete of a session
// nobody holds, the exports against `ampi threads export`, the cost through
// the reports seam, where a session runs, the snooze and unread rules, the
// index fields through the store and the CLI's copy, and the client's
// pure helpers (preferences cookie, label rules, dialog escaping, page
// addresses).

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";
import * as pi from "@earendil-works/pi-coding-agent";
import { readThreadIndex, threadIndexPath, updateThreadRecord } from "../packages/ampi-cli/src/thread-index.js";
import { runThreadsCommand } from "../packages/ampi-cli/src/threads.js";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

const TOKEN = ["actions", "test", "token"].join("-");
const TERMINAL_TOKEN = ["terminal", "gui", "token"].join("-");
const NOW_ISO = "2026-10-18T12:00:00.000Z";
const NOW = Date.parse(NOW_ISO);
const FIXTURE_ID = "0199a0de-5c1e-7a00-8000-000000000001";
const LIVE = "019a1111-0000-7000-8000-000000000001";
const FREE = "019a1111-0000-7000-8000-0000000000f1";
const DOOMED = "019a1111-0000-7000-8000-0000000000f2";
const HELD_EXEC = "019a1111-0000-7000-8000-0000000000e1";
const HELD_TUI = "019a1111-0000-7000-8000-0000000000d1";
const HELD_HERE = "019a1111-0000-7000-8000-0000000000c1";
const EXEC_PID = 7_300_001;
const TUI_PID = 7_300_002;
/** Dollars per million tokens for the fixture's model. */
const PRICE = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

const savedEnv = { agentDir: process.env.PI_CODING_AGENT_DIR, sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR };
const temporary = mkdtempSync(path.join(tmpdir(), "ampi-gui-actions-"));
const agentDir = path.join(temporary, "agent");
const registryDir = path.join(temporary, "live");
const indexFile = threadIndexPath(agentDir);
const alive = new Set([process.pid, EXEC_PID, TUI_PID]);
const registry = { dir: registryDir, isAlive: (pid) => alive.has(pid), procStart: () => null };

let server;
let port;
let store;
let bridge;
let liveContext;
let terminal;
let liveRegistry;
let threadReports;
let releaseThreads;
const renamed = [];
const files = {};

after(async () => {
  await server?.close();
  await new Promise((resolve) => (terminal ? terminal.server.close(resolve) : resolve()));
  await releaseThreads?.();
  for (const [name, value] of [
    ["PI_CODING_AGENT_DIR", savedEnv.agentDir],
    ["PI_CODING_AGENT_SESSION_DIR", savedEnv.sessionDir],
  ]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(temporary, { recursive: true, force: true });
  cleanupLoadedSource();
});

const at = (iso) => Date.parse(iso);
const user = (text, iso) => ({ role: "user", content: text, timestamp: at(iso) });
const assistant = (text, iso) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "faux",
  provider: "faux",
  model: "faux-1",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop",
  timestamp: at(iso),
});

/** Write a session through Pi on a fixed clock; returns its file. */
function writeSession(cwd, id, prompt, iso) {
  mock.timers.enable({ apis: ["Date"], now: at(iso) });
  try {
    const manager = pi.SessionManager.create(cwd, undefined, { id });
    manager.appendMessage(user(prompt, iso));
    manager.appendMessage(assistant(`Answered: ${prompt}`, iso.replace(/:00\.000Z$/, ":30.000Z")));
    return manager.getSessionFile();
  } finally {
    mock.timers.reset();
  }
}

/** A stand-in for another terminal's web GUI: records each request, answers 200 to a rename. */
async function startTerminalGui() {
  const requests = [];
  const http = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: JSON.parse(body).name }));
    });
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  return { server: http, port: http.address().port, requests };
}

function send({ method = "GET", target, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: target,
        setHost: false,
        headers: { Host: `127.0.0.1:${port}`, Cookie: `ampi_gui_${port}=${TOKEN}`, ...headers },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const post = (route, body) =>
  send({
    method: "POST",
    target: `/api/${route}`,
    body: JSON.stringify(body),
    headers: { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" },
  });

const rows = async () => (await send({ target: "/api/sessions" })).json().groups.flatMap((group) => group.sessions);

before(async () => {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  files[FREE] = writeSession("/work/free", FREE, "Free prompt", "2026-10-18T09:00:00.000Z");
  files[DOOMED] = writeSession("/work/free", DOOMED, "Doomed prompt", "2026-10-18T09:10:00.000Z");
  files[HELD_EXEC] = writeSession("/work/held", HELD_EXEC, "Held by a run", "2026-10-18T09:20:00.000Z");
  files[HELD_TUI] = writeSession("/work/held", HELD_TUI, "Held by a terminal", "2026-10-18T09:30:00.000Z");
  files[HELD_HERE] = writeSession("/work/held", HELD_HERE, "Held by this process", "2026-10-18T09:40:00.000Z");
  const fixtureDir = path.join(agentDir, "sessions", "--work-fixture--");
  mkdirSync(fixtureDir, { recursive: true });
  files[FIXTURE_ID] = path.join(fixtureDir, `2026-10-18T10-00-00-000Z_${FIXTURE_ID}.jsonl`);
  copyFileSync(path.join(import.meta.dirname, "fixtures", "ampi-threads-markdown", "session.jsonl"), files[FIXTURE_ID]);

  // The other processes: a print run without the web GUI, a terminal with it, and this process holding a file it does not run.
  liveRegistry = await importSource("extensions/ampi-core/live-registry.ts");
  terminal = await startTerminalGui();
  const entry = (pid, kind, id, gui = null) => ({
    pid,
    procStart: null,
    kind,
    sessionId: id,
    sessionPath: files[id],
    cwd: "/work/held",
    title: null,
    mode: null,
    status: { phase: "runningTools", label: "Running Tools" },
    startedAt: NOW_ISO,
    updatedAt: NOW_ISO,
    gui,
  });
  await liveRegistry.writeMmrLiveEntry(entry(EXEC_PID, "execute", HELD_EXEC), registry);
  await liveRegistry.writeMmrLiveEntry(
    entry(TUI_PID, "tui", HELD_TUI, { port: terminal.port, tokenHash: liveRegistry.hashMmrLiveToken(TERMINAL_TOKEN) }),
    registry,
  );
  writeFileSync(path.join(registryDir, `${TUI_PID}.token`), TERMINAL_TOKEN, { mode: 0o600 });
  await liveRegistry.writeMmrLiveEntry(entry(process.pid, "tui", HELD_HERE), registry);

  // ampi-threads, as Pi loads it: the index store, the reports with Pi's model registry for prices.
  const { createMmrThreadsExtension } = await importSource("extensions/ampi-threads/index.ts");
  const { createMmrThreadIndexStore } = await importSource("extensions/ampi-threads/index-store.ts");
  const { createMmrPromptHistoryStore } = await importSource("extensions/ampi-threads/history-store.ts");
  const threadsMock = createMockPi();
  createMmrThreadsExtension({
    loadSettings: () => ({ enabled: true, autoArchiveOnQuit: false, showCosts: true, titles: false }),
    createStore: (options) => createMmrThreadIndexStore({ ...options, baseDir: path.dirname(indexFile) }),
    createHistoryStore: () => createMmrPromptHistoryStore({ baseDir: path.join(temporary, "history") }),
    now: () => NOW_ISO,
  })(threadsMock.pi);
  liveContext = createMockExtensionContext({
    cwd: "/work/live",
    sessionId: LIVE,
    sessionName: "Live session",
    models: [{ provider: "anthropic", id: "claude-sonnet-4-5", cost: PRICE }],
  });
  liveContext.ctx.sessionManager.getHeader = () => ({ type: "session", version: 3, id: LIVE, timestamp: NOW_ISO, cwd: "/work/live" });
  await threadsMock.handlers.get("session_start")({ type: "session_start", reason: "startup" }, liveContext.ctx);
  releaseThreads = () => threadsMock.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, liveContext.ctx);
  store = createMmrThreadIndexStore({ baseDir: path.dirname(indexFile) });
  threadReports = await importSource("extensions/ampi-core/thread-reports.ts");

  const { createMmrGuiBridge } = await importSource("extensions/ampi-gui/bridge.ts");
  const { createMmrGuiCommands, createMmrGuiExporter } = await importSource("extensions/ampi-gui/commands.ts");
  const { createMmrGuiSessions } = await importSource("extensions/ampi-gui/sessions.ts");
  const { startMmrGuiServer } = await importSource("extensions/ampi-gui/server.ts");
  const guiMock = createMockPi();
  guiMock.pi.setSessionName = (name) => renamed.push(name);
  bridge = createMmrGuiBridge(guiMock.pi);
  bridge.start(liveContext.ctx);
  const sessions = createMmrGuiSessions({
    source: { listSessions: () => pi.SessionManager.listAll() },
    current: () => bridge.session(),
    elsewhere: async () => (await liveRegistry.readMmrLiveEntries(registry)).filter((e) => e.pid !== process.pid).map((e) => e.sessionPath),
    now: () => NOW,
  });
  server = await startMmrGuiServer({
    bridge,
    commands: createMmrGuiCommands(guiMock.pi, bridge, sessions, {
      now: () => NOW_ISO,
      registry,
      gitBranch: async (cwd) => `branch-in:${cwd}`,
    }),
    exportSession: createMmrGuiExporter(bridge, sessions),
    sessions,
    token: TOKEN,
    clientDir: path.join(getPreparedSourceRoot(), "extensions/ampi-gui/client"),
  });
  port = server.port;
});

describe("ampi-gui More Actions: the thread index routes", () => {
  it("answers 400 without a session id and 404 for a session nobody lists, on every route", async () => {
    const { MMR_GUI_SESSION_ACTIONS } = await importSource("extensions/ampi-gui/commands.ts");
    const fields = { pinned: true, archived: true, color: null, labels: [], snoozed: true, unread: true, name: "x" };
    for (const route of MMR_GUI_SESSION_ACTIONS) {
      assert.equal((await post(route, { sessionId: "019a-nobody", ...fields })).status, 404, route);
      assert.equal((await post(route, fields)).status, 400, route);
    }
    assert.equal((await send({ target: "/api/export?sessionId=019a-nobody&format=json" })).status, 404);
    assert.equal((await send({ target: `/api/export?sessionId=${FREE}&format=pdf` })).status, 400);
  });

  it("pins, colours, labels, snoozes and marks any listed session, with the index's rules", async () => {
    assert.equal((await post("pin", { sessionId: FREE, pinned: "yes" })).status, 400);
    assert.equal((await post("pin", { sessionId: FREE, pinned: true })).status, 200);
    assert.equal((await post("color", { sessionId: FREE, color: "#ABCDEF" })).status, 200);
    const mauve = await post("color", { sessionId: FREE, color: "mauve" });
    assert.equal(mauve.status, 400);
    assert.match(mauve.json().error, /blue, purple/, "the store's reason");
    const upper = await post("labels", { sessionId: FREE, labels: ["Docs"] });
    assert.equal(upper.status, 400);
    assert.match(upper.json().error, /lowercase/);
    const many = Array.from({ length: 21 }, (_, i) => `l${i}`);
    assert.match((await post("labels", { sessionId: FREE, labels: many })).json().error, /at most 20/);
    assert.equal((await post("labels", { sessionId: FREE, labels: ["docs", "docs", "api"] })).status, 200);
    assert.equal((await post("snooze", { sessionId: FREE, snoozed: true })).status, 200);
    assert.equal((await post("unread", { sessionId: FREE, unread: true })).status, 200);
    assert.deepEqual(await store.get(FREE), {
      pinned: true,
      color: "#abcdef",
      labels: ["docs", "api"],
      snoozed: NOW_ISO,
      unread: true,
    });
    const row = (await rows()).find((candidate) => candidate.id === FREE);
    assert.deepEqual([row.pinned, row.color, row.labels, row.snoozed, row.unread], [true, "#abcdef", ["docs", "api"], true, true]);

    // Reading marks it read and moves the read date on; the rest goes back to how it was.
    assert.equal((await post("unread", { sessionId: FREE, unread: false })).status, 200);
    for (const [route, body] of [
      ["pin", { pinned: false }],
      ["color", { color: null }],
      ["labels", { labels: [] }],
      ["snooze", { snoozed: false }],
    ]) {
      assert.equal((await post(route, { sessionId: FREE, ...body })).status, 200, route);
    }
    assert.deepEqual(await store.get(FREE), { readAt: NOW_ISO });
  });
});

describe("ampi-gui More Actions: rename and delete", () => {
  it("refuses to rename or delete a session another live process holds, and leaves its file as it was", async () => {
    const before = readFileSync(files[HELD_EXEC]);
    const deleted = await post("delete", { sessionId: HELD_EXEC });
    assert.equal(deleted.status, 409);
    assert.deepEqual([deleted.json().kind, deleted.json().pid, deleted.json().gui], ["execute", EXEC_PID, false]);
    assert.match(deleted.json().error, /close it there/);
    const renaming = await post("rename", { sessionId: HELD_EXEC, name: "Not here" });
    assert.equal(renaming.status, 409);
    assert.match(renaming.json().error, /rename it there/);
    assert.deepEqual(readFileSync(files[HELD_EXEC]), before);

    // A terminal with the web GUI holds this one: it may be renamed there, never deleted.
    const tuiBefore = readFileSync(files[HELD_TUI]);
    assert.equal((await post("delete", { sessionId: HELD_TUI })).status, 409);
    assert.deepEqual(readFileSync(files[HELD_TUI]), tuiBefore);

    // Delete counts this process too: the session it runs, and a file its live entry names.
    const live = await post("delete", { sessionId: LIVE });
    assert.equal(live.status, 409);
    assert.match(live.json().error, /This process runs this session/);
    const here = readFileSync(files[HELD_HERE]);
    const ownEntry = await post("delete", { sessionId: HELD_HERE });
    assert.equal(ownEntry.status, 409);
    assert.equal(ownEntry.json().pid, process.pid);
    assert.deepEqual(readFileSync(files[HELD_HERE]), here);
  });

  it("forwards a rename to the web GUI of the terminal that holds the session, with that server's token", async () => {
    const before = readFileSync(files[HELD_TUI]);
    const res = await post("rename", { sessionId: HELD_TUI, name: "  Renamed   there " });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), { ok: true, name: "Renamed there" });
    const forwarded = terminal.requests.at(-1);
    assert.equal(forwarded.url, "/api/rename");
    assert.equal(forwarded.headers.host, `127.0.0.1:${terminal.port}`);
    assert.equal(forwarded.headers.origin, `http://127.0.0.1:${terminal.port}`);
    assert.equal(forwarded.headers.cookie, `ampi_gui_${terminal.port}=${TERMINAL_TOKEN}`);
    assert.deepEqual(JSON.parse(forwarded.body), { sessionId: HELD_TUI, name: "Renamed there" });
    assert.deepEqual(readFileSync(files[HELD_TUI]), before, "the holder writes its own file");
  });

  it("renames the session this process runs through Pi, and one nobody holds in its file, read back through Pi", async () => {
    assert.equal((await post("rename", { sessionId: LIVE, name: "Live renamed" })).status, 200);
    assert.deepEqual(renamed, ["Live renamed"]);
    const before = (await rows()).find((row) => row.id === FREE).title;
    assert.equal(before, "Free prompt");
    const res = await post("rename", { sessionId: FREE, name: "Renamed in its file" });
    assert.equal(res.status, 200);
    assert.equal(pi.SessionManager.open(files[FREE]).getSessionName(), "Renamed in its file");
    assert.equal((await store.get(FREE)).titleSource, "user");
    assert.equal((await rows()).find((row) => row.id === FREE).title, "Renamed in its file", "the list is read again");
  });

  it("deletes a session nobody holds: its file and its whole thread record", async () => {
    updateThreadRecord(indexFile, DOOMED, { labels: ["old"], fieldOfALaterVersion: 1 });
    assert.ok((await rows()).some((row) => row.id === DOOMED));
    const res = await post("delete", { sessionId: DOOMED });
    assert.equal(res.status, 200);
    assert.equal(existsSync(files[DOOMED]), false);
    assert.equal(Object.hasOwn(readThreadIndex(indexFile), DOOMED), false);
    assert.equal((await rows()).some((row) => row.id === DOOMED), false);
    assert.equal((await post("delete", { sessionId: DOOMED })).status, 404);
  });
});

describe("ampi-gui More Actions: export, cost and where a session runs", () => {
  it("exports the JSON ampi threads export prints, and the Markdown ampi-threads formats, as downloads", async () => {
    await store.update(FIXTURE_ID, { labels: ["parser"], color: "blue", pinned: true, snoozed: NOW_ISO, unread: true });
    let out = "";
    const cli = await runThreadsCommand(["threads", "export", FIXTURE_ID], {
      pi,
      cwd: "/work/demo",
      env: {},
      now: () => NOW,
      columns: 80,
      out: (text) => {
        out += text;
      },
      err: (text) => assert.fail(text),
      confirm: async () => false,
      locateAmpi: async () => undefined,
    });
    assert.deepEqual(cli, { code: 0 });
    const json = await send({ target: `/api/export?sessionId=${FIXTURE_ID}&format=json` });
    assert.equal(json.status, 200);
    assert.equal(json.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(json.headers["content-disposition"], `attachment; filename="${FIXTURE_ID}.json"`);
    assert.equal(json.text, out, "byte for byte what the command prints");
    assert.equal(JSON.parse(json.text).entries.length, readFileSync(files[FIXTURE_ID], "utf8").trim().split("\n").length);

    const markdown = await send({ target: `/api/export?sessionId=${FIXTURE_ID}&format=markdown` });
    assert.equal(markdown.headers["content-type"], "text/markdown; charset=utf-8");
    assert.equal(markdown.headers["content-disposition"], `attachment; filename="${FIXTURE_ID}.md"`);
    assert.equal(markdown.text, (await post("markdown", { sessionId: FIXTURE_ID })).json().markdown);
    assert.match(markdown.text, /reader/);
    assert.equal((await send({ target: `/api/export?sessionId=${LIVE}&format=json` })).status, 409, "the live session has no file yet");
    assert.equal((await send({ target: `/api/export?sessionId=${LIVE}&format=markdown` })).status, 200);
  });

  it("costs a saved session with costOfEntries, which is summarizeMmrThreadCost with ampi-threads' prices", async () => {
    const entries = readFileSync(files[FIXTURE_ID], "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const priceOf = (provider, model) => (provider === "anthropic" && model === "claude-sonnet-4-5" ? PRICE : undefined);
    const expected = threadReports.summarizeMmrThreadCost(entries, priceOf);
    assert.deepEqual(threadReports.getMmrThreadReports().costOfEntries(entries), expected);
    assert.ok(expected.total > 0 && expected.models.length > 0, "the fixture costs something");
    const res = await post("cost", { sessionId: FIXTURE_ID });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json().cost, expected);
    assert.deepEqual((await post("cost", { sessionId: LIVE })).json().cost, { total: 0, unknown: 0, models: [] }, "the live session, from Pi");
  });

  it("says where a session runs: this terminal, another process with its pid and phase, or nowhere", async () => {
    assert.deepEqual((await post("running", { sessionId: LIVE })).json(), {
      ok: true,
      where: "this-terminal",
      pid: process.pid,
      phase: "idle",
      cwd: "/work/live",
      branch: "branch-in:/work/live",
    });
    assert.deepEqual((await post("running", { sessionId: HELD_EXEC })).json(), {
      ok: true,
      where: "execute",
      pid: EXEC_PID,
      phase: "runningTools",
      cwd: "/work/held",
      branch: "branch-in:/work/held",
    });
    const nowhere = (await post("running", { sessionId: FIXTURE_ID })).json();
    assert.deepEqual([nowhere.where, nowhere.pid, nowhere.phase, nowhere.cwd], ["none", null, null, "/work/demo"]);
  });

  it("reads the Git branch without optional locks, a detached head's commit, and nothing outside a repository", async (t) => {
    if (spawnSync("git", ["--version"]).status !== 0) return t.skip("git is not installed");
    const { readMmrGuiGitBranch } = await importSource("extensions/ampi-gui/commands.ts");
    const repo = path.join(temporary, "repo");
    const plain = path.join(temporary, "plain");
    mkdirSync(plain, { recursive: true });
    const git = (...args) => execFileSync("git", ["-C", repo, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    mkdirSync(repo, { recursive: true });
    git("init", "-q", "-b", "trunk");
    const ceiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = temporary;
    try {
      assert.equal(await readMmrGuiGitBranch(repo), "trunk");
      assert.equal(await readMmrGuiGitBranch(plain), null);
      assert.equal(await readMmrGuiGitBranch(""), null);
      git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "first");
      git("checkout", "-q", "--detach");
      assert.match(await readMmrGuiGitBranch(repo), /^[0-9a-f]{7,}$/);
    } finally {
      if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = ceiling;
    }
  });
});

describe("ampi-gui More Actions: snooze and unread", () => {
  it("snoozes while the last activity is not newer than the snooze, and is unread when marked or active after reading", async () => {
    const { isMmrThreadSnoozed, isMmrThreadUnread } = await importSource("extensions/ampi-core/thread-index.ts");
    const mark = "2026-10-18T10:00:00.000Z";
    const t = Date.parse(mark);
    assert.equal(isMmrThreadSnoozed({ snoozed: mark }, t - 1), true);
    assert.equal(isMmrThreadSnoozed({ snoozed: mark }, t), true, "a message at the snooze itself does not end it");
    assert.equal(isMmrThreadSnoozed({ snoozed: mark }, t + 1), false, "the next message ends it");
    assert.equal(isMmrThreadSnoozed({}, 0), false);
    assert.equal(isMmrThreadSnoozed(undefined, 0), false);
    assert.equal(isMmrThreadUnread({ readAt: mark }, t - 1), false);
    assert.equal(isMmrThreadUnread({ readAt: mark }, t), false, "activity at the moment it was read was seen");
    assert.equal(isMmrThreadUnread({ readAt: mark }, t + 1), true);
    assert.equal(isMmrThreadUnread({ unread: true, readAt: mark }, t - 1), true, "marked unread whatever the dates");
    assert.equal(isMmrThreadUnread({}, t), false, "never opened in a page: not unread");
  });

  it("groups snoozed sessions between Inactive Last 72h and Archived, until their next message", async () => {
    const { groupMmrGuiSessions } = await importSource("extensions/ampi-gui/sessions.ts");
    const info = (id, iso) => ({ id, path: `/s/${id}.jsonl`, cwd: "/work/a", created: new Date(iso), modified: new Date(iso), messageCount: 1, firstMessage: id });
    const sessions = [
      info("recent", "2026-10-18T11:00:00.000Z"),
      info("old", "2026-10-10T11:00:00.000Z"),
      info("asleep", "2026-10-18T10:00:00.000Z"),
      info("woken", "2026-10-18T10:00:00.001Z"),
      info("asleep-pinned", "2026-10-17T10:00:00.000Z"),
      info("gone", "2026-10-18T09:00:00.000Z"),
    ];
    const threads = {
      asleep: { snoozed: "2026-10-18T10:00:00.000Z" },
      woken: { snoozed: "2026-10-18T10:00:00.000Z", readAt: "2026-10-18T09:00:00.000Z" },
      "asleep-pinned": { snoozed: "2026-10-18T10:00:00.000Z", pinned: true },
      gone: { snoozed: "2026-10-18T10:00:00.000Z", archived: "2026-10-18T10:00:00.000Z" },
    };
    const groups = groupMmrGuiSessions({ sessions, threads, now: NOW, home: "/home/u" });
    assert.deepEqual(
      groups.map((group) => [group.id, group.sessions.map((row) => row.id)]),
      [
        ["project:/work/a", ["recent", "woken"]],
        ["inactive-72h", ["old"]],
        ["snoozed", ["asleep", "asleep-pinned"]],
        ["archived", ["gone"]],
      ],
    );
    const woken = groups[0].sessions.find((row) => row.id === "woken");
    assert.deepEqual([woken.snoozed, woken.unread], [false, true], "its message came after the snooze and after it was read");
    // A session Pi has not saved has no activity yet: reading it never makes it unread.
    const unsaved = groupMmrGuiSessions({
      sessions: [],
      threads: { fresh: { readAt: "2026-10-18T11:59:00.000Z" } },
      current: { id: "fresh", title: "New", cwd: "/work/a" },
      now: NOW,
    });
    assert.equal(unsaved[0].sessions[0].unread, false);
  });
});

describe("ampi-gui More Actions: the index fields in the store and the CLI's copy", () => {
  it("keeps snoozed, unread and readAt through ampi threads archive and label, and checks them in the store", async () => {
    const id = HELD_EXEC;
    await store.update(id, { snoozed: "2026-10-18T10:00:00.000Z", unread: true, readAt: "2026-10-18T09:00:00.000Z" });
    assert.deepEqual(readThreadIndex(indexFile)[id], { snoozed: "2026-10-18T10:00:00.000Z", unread: true, readAt: "2026-10-18T09:00:00.000Z" });
    const host = {
      pi,
      cwd: "/work/held",
      env: {},
      now: () => NOW,
      columns: 80,
      out: () => {},
      err: (text) => assert.fail(text),
      confirm: async () => false,
      locateAmpi: async () => undefined,
    };
    assert.deepEqual(await runThreadsCommand(["threads", "archive", id], host), { code: 0 });
    assert.deepEqual(await runThreadsCommand(["threads", "label", id, "kept"], host), { code: 0 });
    assert.deepEqual(await store.get(id), {
      snoozed: "2026-10-18T10:00:00.000Z",
      unread: true,
      readAt: "2026-10-18T09:00:00.000Z",
      archived: NOW_ISO,
      labels: ["kept"],
    });
    for (const patch of [{ snoozed: "soon" }, { unread: "yes" }, { readAt: 5 }]) {
      await assert.rejects(store.update(id, patch), { name: "MmrThreadIndexError" }, JSON.stringify(patch));
    }
    await store.remove(id);
    assert.equal(await store.get(id), undefined);
  });

  it("sets aside an index whose new fields have the wrong type, as for any other field", async () => {
    const { createMmrThreadIndexStore } = await importSource("extensions/ampi-threads/index-store.ts");
    const dir = path.join(temporary, "bad-index");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "index.json"), JSON.stringify({ version: 1, threads: { a: { unread: "yes" } } }));
    const warnings = [];
    const bad = createMmrThreadIndexStore({ baseDir: dir, randomId: () => "x", onWarning: (text) => warnings.push(text) });
    assert.deepEqual(await bad.list(), {});
    assert.equal(existsSync(path.join(dir, "index.json.x.corrupt")), true);
    assert.equal(warnings.length, 1);
  });
});

describe("ampi-gui More Actions: client helpers", () => {
  it("stores the preferences in one cookie and reads back only known, valid values", async () => {
    const { decodePrefs, encodePrefs, defaultPrefs, PREFS_COOKIE } = await importSource("extensions/ampi-gui/client/prefs.js");
    assert.deepEqual(defaultPrefs(), { sidebarWidth: 256, sidebarOpen: true, fullWidth: false });
    const cookie = encodePrefs({ sidebarWidth: 320, sidebarOpen: false, fullWidth: true, secret: "no" });
    assert.equal(cookie, `${PREFS_COOKIE}=${encodeURIComponent('{"sidebarWidth":320,"sidebarOpen":false,"fullWidth":true}')}; Path=/; Max-Age=31536000; SameSite=Strict`);
    const header = `ampi_gui_4100=token; ${cookie.split(";")[0]}; other=1`;
    assert.deepEqual(decodePrefs(header), { sidebarWidth: 320, sidebarOpen: false, fullWidth: true });
    const tampered = `${PREFS_COOKIE}=${encodeURIComponent('{"sidebarWidth":"wide","fullWidth":1,"__proto__":{"x":1}}')}`;
    assert.deepEqual(decodePrefs(tampered), defaultPrefs(), "wrong types fall back to the defaults");
    assert.deepEqual(decodePrefs(`${PREFS_COOKIE}=%E0%A4%A`), defaultPrefs(), "a cookie that does not decode");
    assert.deepEqual(decodePrefs(`${PREFS_COOKIE}=[1]`), defaultPrefs());
    assert.deepEqual(decodePrefs(undefined), defaultPrefs());
    assert.equal(encodePrefs({ sidebarWidth: Number.NaN }), `${PREFS_COOKIE}=%7B%7D; Path=/; Max-Age=31536000; SameSite=Strict`);
  });

  it("accepts and refuses the same labels as the thread index", async () => {
    const { addLabel } = await importSource("extensions/ampi-gui/client/titlebar.js");
    const { validateMmrThreadLabels } = await importSource("extensions/ampi-threads/index-store.ts");
    const storeAccepts = (labels) => {
      try {
        validateMmrThreadLabels(labels);
        return true;
      } catch {
        return false;
      }
    };
    for (const text of ["docs", "a-1", "x".repeat(32), "x".repeat(33), "with space", "ünï", "under_score", "-", "9"]) {
      const result = addLabel([], text);
      assert.equal(result.error === undefined, storeAccepts([text]), text);
    }
    assert.deepEqual(addLabel(["docs"], "  DOCS "), { labels: ["docs"] }, "trimmed, lowercased and not added twice");
    const twenty = Array.from({ length: 20 }, (_, i) => `l${i}`);
    assert.match(addLabel(twenty, "one-more").error, /at most 20/);
    assert.equal(storeAccepts([...twenty, "one-more"]), false);
  });

  it("escapes the title in the delete confirmation and every name in the cost dialog", async () => {
    const { costDialogHtml, deleteDialogHtml, formatCost } = await importSource("extensions/ampi-gui/client/titlebar.js");
    const title = `<img src=x onerror="alert(1)"> & 'quotes'`;
    const html = deleteDialogHtml(title);
    assert.equal(html.includes("<img"), false);
    assert.match(html, /<strong>&#60;img src=x onerror=&#34;alert\(1\)&#34;&#62; &#38; &#39;quotes&#39;<\/strong>/);
    assert.match(deleteDialogHtml(""), /<strong>This session<\/strong>/);
    const cost = costDialogHtml(title, {
      total: 0.0042,
      unknown: 1,
      models: [
        { label: "acme/<b>bold</b>", cost: 0.0042, input: 1200, output: 30, cacheRead: 0, cacheWrite: 0 },
        { label: "other/free", cost: undefined, input: 1, output: 1, cacheRead: 5, cacheWrite: 0 },
      ],
    });
    assert.equal(cost.includes("<img") || cost.includes("<b>"), false);
    assert.match(cost, /acme\/&#60;b&#62;bold/);
    assert.match(cost, /<strong>\$0\.004<\/strong>/);
    assert.match(cost, /Not counting 1 model without a price/);
    assert.match(cost, /1,200 in · 30 out/);
    assert.match(cost, /5 cache read/);
    assert.deepEqual([formatCost(0), formatCost(0.0042), formatCost(1.234), formatCost(undefined)], ["$0.00", "$0.004", "$1.23", "unknown"]);
  });

  it("copies a session's page address without the token, in either kind of server", async () => {
    const { sessionPageUrl } = await importSource("extensions/ampi-gui/client/app-mode.js");
    const here = "http://127.0.0.1:4100/?t=secret#/s/old";
    assert.equal(sessionPageUrl(here, { app: false, id: "live", liveId: "live" }), "http://127.0.0.1:4100/");
    assert.equal(sessionPageUrl(here, { app: false, id: "other", liveId: "live" }), "http://127.0.0.1:4100/#/s/other");
    assert.equal(sessionPageUrl("http://127.0.0.1:4200/s/a?t=secret", { app: true, id: "b c" }), "http://127.0.0.1:4200/s/b%20c");
  });
});
