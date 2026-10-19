// ampi app's hub (ampi-gui/hub.ts): the session list with each session's
// live host, the per-session routes that forward to a worker's own GUI
// server (event streams included) or read the file when no worker of the
// hub runs it, and the single-writer rule: no worker for a file another
// live process has open, and a hosted session gives way when one opens it.
// The hub is a real server on loopback; the workers are real session
// servers (ampi-gui hosted as `ampi app --worker` hosts it) or a recording
// server, started by a fake startSession. A terminal session is ampi-core's
// live registry writer and ampi-gui in Pi's tui mode on a stub Pi, so its
// entry and token file are the real ones. Timers and the clock are injected.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const HUB_TOKEN = ["hub", "test", "token"].join("-");
const WORKER_TOKEN = ["worker", "test", "token"].join("-");
const TERMINAL_TOKEN = ["terminal", "test", "token"].join("-");
const HUB_PID = 7_100_001;
const WORKER_PID = 7_100_002;
const TERMINAL_PID = 7_100_003;
const LATE_PID = 7_100_004;
const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const CHECK_MS = 2_000;
const IDLE_MS = 15 * 60_000;

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

let hostKey;
let liveRegistry;
let hubModule;
let sessionsModule;
before(async () => {
  hostKey = (await importSource("extensions/ampi-core/gui-host.ts")).MMR_GUI_HOST_GLOBAL_KEY;
  liveRegistry = await importSource("extensions/ampi-core/live-registry.ts");
  hubModule = await importSource("extensions/ampi-gui/hub.ts");
  sessionsModule = await importSource("extensions/ampi-gui/sessions.ts");
});
afterEach(() => {
  delete globalThis[hostKey];
});

/** A saved session file: a header, a prompt and a reply; an imported one starts with the import entry. */
function sessionFile(id, prompt, { imported = false } = {}) {
  const importEntry = { type: "custom", id: "e0", parentId: null, timestamp: "2026-10-18T09:00:00.500Z", customType: "ampi-import", data: { agent: "claude-code", sourceId: "src-1" } };
  return [
    { type: "session", version: 3, id, timestamp: "2026-10-18T09:00:00.000Z", cwd: "/work/lib" },
    ...(imported ? [importEntry] : []),
    { type: "message", id: "e1", parentId: imported ? "e0" : null, timestamp: "2026-10-18T09:00:01.000Z", message: { role: "user", content: [{ type: "text", text: prompt }], timestamp: 1 } },
    { type: "message", id: "e2", parentId: "e1", timestamp: "2026-10-18T09:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "Saved reply" }], timestamp: 2, stopReason: "stop" } },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
}

/** A raw request with exactly the headers given (no default Host). */
function send(port, { method = "GET", target = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path: target, headers, setHost: false, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: text, json: () => JSON.parse(text) }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Open an event stream; `text()` is what arrived so far, `next(pattern)` waits for it, `ended` settles when it closes. */
function openStream(port, target, headers) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: target, headers, setHost: false, agent: false }, (res) => {
      let text = "";
      const waiters = [];
      let endedResolve;
      const ended = new Promise((done) => {
        endedResolve = done;
      });
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
        for (const waiter of waiters.splice(0)) {
          if (waiter.pattern.test(text)) waiter.resolve(text);
          else waiters.push(waiter);
        }
      });
      res.on("close", () => endedResolve(text));
      resolve({
        status: res.statusCode,
        headers: res.headers,
        text: () => text,
        ended,
        next: (pattern) => (pattern.test(text) ? Promise.resolve(text) : new Promise((done) => waiters.push({ pattern, resolve: done }))),
        close: () => req.destroy(),
      });
    });
    req.on("error", (error) => (error.code === "ECONNRESET" ? undefined : reject(error)));
    req.end();
  });
}

function parseEvents(text) {
  return text
    .split("\n\n")
    .filter((block) => block.includes("event: "))
    .map((block) => {
      const fields = Object.fromEntries(block.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]));
      return { id: fields.id, event: fields.event, data: JSON.parse(fields.data) };
    });
}

/**
 * A worker's session server, as `ampi app --worker` runs it: ampi-gui with a
 * session host record, in Pi's RPC mode, on the stub Pi.
 */
async function startSessionServer(sessionId) {
  const ready = [];
  globalThis[hostKey] = { role: "session", token: WORKER_TOKEN, ownerPid: HUB_PID, ready: (info) => ready.push(info) };
  const { createMmrGuiExtension } = await importSource("extensions/ampi-gui/index.ts");
  const mock = createMockPi();
  const registryDir = path.join(mkdtempSync(path.join(tmpdir(), "ampi-hub-worker-")), "live");
  dirs.push(path.dirname(registryDir));
  createMmrGuiExtension({ loadSettings: () => ({ enabled: false }), registryDir })(mock.pi);
  const { ctx } = createMockExtensionContext({ mode: "rpc", hasUI: false, cwd: "/work/lib", sessionId, sessionFile: `/sessions/${sessionId}.jsonl` });
  const fire = (name, event = {}) => mock.handlers.get(name)({ type: name, ...event }, ctx);
  await fire("session_start", { reason: "startup" });
  delete globalThis[hostKey];
  return { port: ready[0].port, mock, fire, stop: () => fire("session_shutdown", { reason: "quit" }) };
}

/** A worker stand-in that records every request and answers with a Set-Cookie of its own. */
async function startRecorder() {
  const requests = [];
  let streamClosed;
  const closed = new Promise((resolve) => {
    streamClosed = resolve;
  });
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: { ...req.headers }, body: Buffer.concat(chunks).toString("utf8") });
      if (req.url.startsWith("/api/events")) {
        res.on("close", streamClosed);
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Set-Cookie": "worker=1" });
        res.write("retry: 2000\n\nid: 4\nevent: status\ndata: {\"phase\":\"idle\"}\n\n");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Set-Cookie": "worker=1", "X-Worker": "yes" });
      res.end(JSON.stringify({ ok: true, from: "recorder" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    requests,
    /** Settles when the first event stream's connection closes. */
    closed,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}

/** A hub over fixture sessions, a temporary live registry and a fake startSession. */
async function startHub({ upstream = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "ampi-hub-"));
  dirs.push(dir);
  const registryDir = path.join(dir, "live");
  // This process plays the terminal sessions that run ampi-gui (startTerminal).
  const alive = new Set([HUB_PID, WORKER_PID, TERMINAL_PID, LATE_PID, process.pid]);
  const probes = { onProbe: undefined };
  const registry = {
    dir: registryDir,
    isAlive: (pid) => {
      probes.onProbe?.(pid);
      return alive.has(pid);
    },
    procStart: () => null,
  };
  const infos = ["s-c", "s-held", "s-rec", "s-busy", "s-imp"].map((id) => {
    const file = path.join(dir, `${id}.jsonl`);
    writeFileSync(file, sessionFile(id, `Prompt of ${id}`, { imported: id === "s-imp" }));
    return { path: file, id, cwd: "/work/lib", created: new Date(NOW - 60_000), modified: new Date(NOW - 60_000), messageCount: 2, firstMessage: `Prompt of ${id}`, allMessagesText: "" };
  });
  const byId = Object.fromEntries(infos.map((info) => [info.id, info]));
  const sessions = sessionsModule.createMmrGuiSessions({
    source: { listSessions: async () => infos },
    current: () => undefined,
    elsewhere: async () => (await liveRegistry.readMmrLiveEntries(registry)).flatMap((entry) => (entry.sessionPath ? [entry.sessionPath] : [])),
    hosts: async () => hubModule.mmrGuiRowHosts(await liveRegistry.readMmrLiveEntries(registry)),
    threadIndex: () => undefined,
    now: () => NOW,
  });

  const clock = { now: NOW };
  const timers = new Set();
  const workers = [];
  const starts = [];
  /** By session id: `{ port, token }` of the server a started worker serves, or a promise of it. */
  const startSession = async (request) => {
    starts.push(request);
    const id = infos.find((info) => info.path === request.path)?.id;
    const target = await upstream[id];
    if (target instanceof Error) throw target;
    const exits = [];
    const activity = [];
    const worker = {
      pid: WORKER_PID,
      port: target.port,
      token: WORKER_TOKEN,
      sessionId: id,
      sessionPath: request.path,
      stops: 0,
      async stop() {
        worker.stops++;
        worker.exit();
      },
      onExit: (listener) => exits.push(listener),
      onActivity: (listener) => activity.push(listener),
      exit: () => {
        for (const listener of exits.splice(0)) listener();
      },
      activity: (state) => {
        for (const listener of activity) listener(state);
      },
    };
    workers.push(worker);
    return worker;
  };
  const renamedInFile = [];
  const commands = {
    markdown: async (body) => ({ status: 200, body: { ok: true, markdown: `# ${body.sessionId}` } }),
    archive: async (body) => ({ status: 200, body: { ok: true, archived: body.archived } }),
    // The session server's rename of a session nobody runs (tests/mmr-gui-actions.test.mjs covers it).
    rename: async (body) => {
      renamedInFile.push(body.sessionId);
      return { status: 200, body: { ok: true, name: body.name } };
    },
    // The session server's delete, which checks the live registry itself.
    delete: async (body) => {
      renamedInFile.push(`deleted ${body.sessionId}`);
      return { status: 200, body: { ok: true } };
    },
    // A composer route the hub must not serve at /api/.
    send: async () => ({ status: 200, body: { ok: true } }),
  };
  const exportSession = async (sessionId, format) => ({ status: 200, filename: `${sessionId}.md`, contentType: "text/markdown; charset=utf-8", text: `# ${sessionId} as ${format}` });
  const hub = await hubModule.startMmrGuiHub({
    token: HUB_TOKEN,
    clientDir: path.join(getPreparedSourceRoot(), "extensions/ampi-gui/client"),
    startSession,
    sessions,
    commands,
    exportSession,
    registry,
    pid: HUB_PID,
    now: () => clock.now,
    setTimer: (callback, ms) => {
      const timer = { callback, ms };
      timers.add(timer);
      return timer;
    },
    clearTimer: (timer) => timers.delete(timer),
  });
  const port = hub.port;
  const headers = (extra = {}) => ({ Host: `127.0.0.1:${port}`, Cookie: `ampi_gui_${port}=${HUB_TOKEN}`, ...extra });
  const post = (target, body, extra = {}) =>
    send(port, {
      method: "POST",
      target,
      headers: headers({ Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json", ...extra }),
      body: JSON.stringify(body),
    });
  /** Run the timers waiting for `ms`, as if that much time passed; returns once their work is done. */
  const fire = async (ms) => {
    for (const timer of [...timers]) {
      if (timer.ms !== ms) continue;
      timers.delete(timer);
      await timer.callback();
    }
  };
  /** Write a live entry of another process that has session `id` open. */
  const hold = (id, pid, kind = "tui") => {
    mkdirSync(registryDir, { recursive: true });
    const entry = {
      version: 2,
      pid,
      procStart: null,
      kind,
      sessionId: id,
      sessionPath: byId[id].path,
      cwd: "/work/lib",
      title: null,
      mode: null,
      status: { phase: "runningTools", label: "Running Tools" },
      startedAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
      gui: null,
    };
    writeFileSync(path.join(registryDir, `${pid}.json`), JSON.stringify(entry));
  };
  return { hub, port, headers, post, fire, clock, starts, workers, byId, hold, probes, alive, registryDir, renamedInFile, close: () => hub.close() };
}

/**
 * A terminal session with the web GUI on, as Pi runs ampi in a terminal:
 * ampi-core's live registry writer and ampi-gui on one stub Pi in tui mode,
 * with the hub's registry, so the entry (pid: this process) and the token
 * file are what a real terminal writes.
 */
async function startTerminal(ctx, id) {
  const { createMmrGuiExtension } = await importSource("extensions/ampi-gui/index.ts");
  const mock = createMockPi();
  const renamed = [];
  mock.pi.setSessionName = (name) => renamed.push(name);
  const timers = [];
  const writer = liveRegistry.registerMmrLiveRegistry(mock.pi, {
    dir: ctx.registryDir,
    now: () => 0,
    setTimer: (callback) => timers.push(callback),
    clearTimer: () => {},
  });
  createMmrGuiExtension({ loadSettings: () => ({ enabled: true }), registryDir: ctx.registryDir, createToken: () => TERMINAL_TOKEN })(mock.pi);
  const session = createMockExtensionContext({ mode: "tui", cwd: "/work/lib", sessionId: id, sessionFile: ctx.byId[id].path });
  const fire = (name, event = {}) => mock.handlers.get(name)({ type: name, ...event }, session.ctx);
  await fire("session_start", { reason: "startup" });
  for (const run of timers.splice(0)) run();
  await writer.idle();
  const port = Number(/^Web GUI: http:\/\/127\.0\.0\.1:(\d+)\//.exec(session.notifications[0].message)[1]);
  return { port, mock, renamed, fire, stop: () => fire("session_shutdown", { reason: "quit" }) };
}

describe("ampi app hub: pages and the session list", () => {
  it("answers /api/app, which a session server does not, and lists every session with its live host", async () => {
    const worker = await startSessionServer("s-own");
    const ctx = await startHub();
    try {
      const app = await send(ctx.port, { target: "/api/app", headers: ctx.headers() });
      assert.equal(app.status, 200);
      assert.deepEqual(app.json(), { app: true });
      const sessionServer = await send(worker.port, { target: "/api/app", headers: { Host: `127.0.0.1:${worker.port}`, Cookie: `ampi_gui_${worker.port}=${WORKER_TOKEN}` } });
      assert.equal(sessionServer.status, 404, "the page tells the hub from a session server by this route");

      for (const target of ["/", "/s/s-c"]) {
        const page = await send(ctx.port, { target, headers: ctx.headers() });
        assert.equal(page.status, 200, target);
        assert.match(page.headers["content-type"], /^text\/html/);
      }

      ctx.hold("s-held", TERMINAL_PID);
      const list = (await send(ctx.port, { target: "/api/sessions", headers: ctx.headers() })).json();
      const rows = Object.fromEntries(list.groups.flatMap((group) => group.sessions).map((row) => [row.id, row]));
      assert.equal(list.currentId, null);
      assert.deepEqual(rows["s-held"].host, { kind: "tui", pid: TERMINAL_PID, gui: false, phase: "runningTools" });
      assert.equal(rows["s-held"].elsewhere, true);
      assert.equal(rows["s-c"].host, null);
      assert.equal(rows["s-c"].elsewhere, false);
      // Two processes with one file: the first entry is the host, as it is the holder the hub answers with.
      const entry = (pid, kind) => ({ pid, kind, sessionPath: "/s/x.jsonl", gui: null, status: null });
      assert.equal(hubModule.mmrGuiRowHosts([entry(TERMINAL_PID, "tui"), entry(LATE_PID, "execute")]).get("/s/x.jsonl").pid, TERMINAL_PID);

      const view = await send(ctx.port, { target: "/api/sessions/s-c", headers: ctx.headers() });
      assert.equal(view.status, 200);
      assert.equal(view.json().session.id, "s-c");
    } finally {
      await ctx.close();
      await worker.stop();
    }
  });

  it("serves More Actions for any session, and renames a session where it runs or, when nothing runs it, in its file", async () => {
    const recorder = await startRecorder();
    const ctx = await startHub({ upstream: { "s-rec": recorder } });
    try {
      assert.deepEqual((await ctx.post("/api/markdown", { sessionId: "s-held" })).json(), { ok: true, markdown: "# s-held" });
      assert.deepEqual((await ctx.post("/api/archive", { sessionId: "s-c", archived: true })).json(), { ok: true, archived: true });
      assert.equal((await ctx.post("/api/send", { text: "x" })).status, 404, "the composer's routes are per session");

      const notRunning = await ctx.post("/api/rename", { sessionId: "s-c", name: "New name" });
      assert.equal(notRunning.status, 200);
      assert.deepEqual(ctx.renamedInFile, ["s-c"], "the session server's rename writes a file nobody holds");
      ctx.hold("s-held", TERMINAL_PID);
      const held = await ctx.post("/api/rename", { sessionId: "s-held", name: "New name" });
      assert.equal(held.status, 409);
      assert.match(held.json().error, /rename it there/);
      assert.equal(held.json().pid, TERMINAL_PID);
      assert.deepEqual(ctx.renamedInFile, ["s-c"]);
      assert.equal((await ctx.post("/api/rename", { sessionId: "s-unknown", name: "x" })).status, 404);

      assert.equal((await ctx.post("/s/s-rec/api/send", { text: "start it" })).status, 200);
      const renamed = await ctx.post("/api/rename", { sessionId: "s-rec", name: "New name" });
      assert.equal(renamed.status, 200);
      const forwarded = recorder.requests.at(-1);
      assert.equal(forwarded.url, "/api/rename");
      assert.deepEqual(JSON.parse(forwarded.body), { sessionId: "s-rec", name: "New name" });

      const hosted = await ctx.post("/api/delete", { sessionId: "s-rec" });
      assert.equal(hosted.status, 409, "a session a worker runs is never deleted");
      assert.match(hosted.json().error, /ampi app runs this session/);
      assert.equal((await ctx.post("/api/delete", { sessionId: "s-c" })).status, 200);
      assert.deepEqual(ctx.renamedInFile, ["s-c", "deleted s-c"], "a session nothing runs goes to the session server's delete");

      const download = await send(ctx.port, { target: "/api/export?sessionId=s-c&format=markdown", headers: ctx.headers() });
      assert.equal(download.status, 200);
      assert.equal(download.headers["content-disposition"], 'attachment; filename="s-c.md"');
      assert.equal(download.body, "# s-c as markdown");
    } finally {
      await ctx.close();
      await recorder.close();
    }
  });
});

describe("ampi app hub: forwarding to a worker", () => {
  it("forwards GET, POST and event streams with only the worker's Host, cookie and Origin and three request headers", async () => {
    const recorder = await startRecorder();
    const ctx = await startHub({ upstream: { "s-rec": recorder } });
    const upstreamHost = `127.0.0.1:${recorder.port}`;
    const upstreamCookie = `ampi_gui_${recorder.port}=${WORKER_TOKEN}`;
    try {
      const body = JSON.stringify({ text: "hello" });
      const sent = await send(ctx.port, {
        method: "POST",
        target: "/s/s-rec/api/send",
        headers: ctx.headers({
          Origin: `http://127.0.0.1:${ctx.port}`,
          "Content-Type": "application/json",
          "User-Agent": "test-browser",
          "X-Requested-With": "page",
          Authorization: "Basic eA==",
        }),
        body,
      });
      assert.equal(sent.status, 200);
      assert.deepEqual(sent.json(), { ok: true, from: "recorder" });
      assert.equal(sent.headers["set-cookie"], undefined, "the worker's cookie never reaches the browser");
      assert.equal(sent.headers["x-worker"], undefined);
      assert.equal(sent.headers["x-frame-options"], "DENY", "the hub's security headers");
      assert.match(sent.headers["content-security-policy"], /default-src 'none'/);
      assert.equal(sent.headers["access-control-allow-origin"], undefined);
      assert.deepEqual(ctx.starts, [{ path: ctx.byId["s-rec"].path }]);
      assert.deepEqual(recorder.requests[0], {
        method: "POST",
        url: "/api/send",
        headers: {
          host: upstreamHost,
          cookie: upstreamCookie,
          "content-type": "application/json",
          origin: `http://${upstreamHost}`,
          "content-length": String(Buffer.byteLength(body)),
          connection: "close",
        },
        body,
      });

      const got = await send(ctx.port, {
        target: "/s/s-rec/api/transcript?x=1",
        headers: ctx.headers({ Accept: "application/json", "Last-Event-ID": "7", "User-Agent": "test-browser" }),
      });
      assert.equal(got.status, 200);
      assert.equal(got.headers["set-cookie"], undefined);
      assert.deepEqual(recorder.requests[1], {
        method: "GET",
        url: "/api/transcript?x=1",
        headers: { host: upstreamHost, cookie: upstreamCookie, accept: "application/json", "last-event-id": "7", connection: "close" },
        body: "",
      });

      const stream = await openStream(ctx.port, "/s/s-rec/api/events?after=3", ctx.headers({ Accept: "text/event-stream" }));
      await stream.next(/event: status/);
      assert.equal(stream.status, 200);
      assert.equal(stream.headers["content-type"], "text/event-stream; charset=utf-8");
      assert.equal(stream.headers["set-cookie"], undefined);
      assert.deepEqual(parseEvents(stream.text()), [{ id: "4", event: "status", data: { phase: "idle" } }]);
      assert.deepEqual(recorder.requests[2], {
        method: "GET",
        url: "/api/events?after=3",
        headers: { host: upstreamHost, cookie: upstreamCookie, accept: "text/event-stream", connection: "close" },
        body: "",
      });
      stream.close();
    } finally {
      await ctx.close();
      await recorder.close();
    }
  });

  it("refuses a bad Host, Origin or token before forwarding anything", async () => {
    const recorder = await startRecorder();
    const ctx = await startHub({ upstream: { "s-rec": recorder } });
    try {
      assert.equal((await ctx.post("/s/s-rec/api/send", { text: "start it" })).status, 200);
      const before = recorder.requests.length;
      const json = { "Content-Type": "application/json" };
      const origin = { Origin: `http://127.0.0.1:${ctx.port}` };
      const cases = [
        ["foreign Host", { target: "/s/s-rec/api/transcript", headers: ctx.headers({ Host: "attacker.example" }) }, 403],
        ["another port", { target: "/s/s-rec/api/transcript", headers: ctx.headers({ Host: `127.0.0.1:${recorder.port}` }) }, 403],
        ["foreign Origin", { target: "/s/s-rec/api/events", headers: ctx.headers({ Origin: "http://attacker.example" }) }, 403],
        ["the worker's origin", { target: "/s/s-rec/api/transcript", headers: ctx.headers({ Origin: `http://127.0.0.1:${recorder.port}` }) }, 403],
        ["no cookie", { target: "/s/s-rec/api/transcript", headers: { Host: `127.0.0.1:${ctx.port}` } }, 401],
        ["the worker's token", { target: "/s/s-rec/api/transcript", headers: ctx.headers({ Cookie: `ampi_gui_${ctx.port}=${WORKER_TOKEN}` }) }, 401],
        ["POST without Origin", { method: "POST", target: "/s/s-rec/api/send", headers: ctx.headers(json), body: "{\"text\":\"x\"}" }, 403],
        ["POST without cookie", { method: "POST", target: "/s/s-rec/api/send", headers: { Host: `127.0.0.1:${ctx.port}`, ...origin, ...json }, body: "{\"text\":\"x\"}" }, 403],
        ["POST that is not JSON", { method: "POST", target: "/s/s-rec/api/send", headers: ctx.headers({ ...origin, "Content-Type": "text/plain" }), body: "x" }, 415],
      ];
      for (const [label, options, status] of cases) assert.equal((await send(ctx.port, options)).status, status, label);
      assert.equal(recorder.requests.length, before, "nothing reached the worker");
    } finally {
      await ctx.close();
      await recorder.close();
    }
  });

  it("starts a worker for a session nobody runs and forwards the send and its event stream", async () => {
    const worker = await startSessionServer("s-c");
    const ctx = await startHub({ upstream: { "s-c": worker } });
    try {
      const notRunning = await send(ctx.port, { target: "/s/s-c/api/events", headers: ctx.headers() });
      assert.equal(notRunning.status, 409);
      assert.equal(notRunning.json().state, "not-running");
      const fromDisk = (await send(ctx.port, { target: "/s/s-c/api/transcript", headers: ctx.headers() })).json();
      assert.deepEqual(fromDisk.state, { state: "not-running" });
      assert.equal(fromDisk.items.length, 2, "the transcript comes from the file");
      assert.equal((await ctx.post("/s/s-c/api/interrupt", {})).status, 409, "only send starts a worker");
      assert.equal((await ctx.post("/s/s-c/api/send", { text: "  " })).status, 400);
      assert.deepEqual(ctx.starts, []);

      const sent = await ctx.post("/s/s-c/api/send", { text: "hello worker" });
      assert.equal(sent.status, 200);
      assert.deepEqual(sent.json(), { ok: true, delivered: "prompt" });
      assert.deepEqual(ctx.starts, [{ path: ctx.byId["s-c"].path }]);
      assert.equal(worker.mock.calls.sendUserMessage.at(-1)?.content, "hello worker");

      const snapshot = (await send(ctx.port, { target: "/s/s-c/api/transcript", headers: ctx.headers() })).json();
      assert.equal(snapshot.session.id, "s-c", "now the worker's live snapshot");
      assert.equal(typeof snapshot.lastEventId, "number");
      const stream = await openStream(ctx.port, "/s/s-c/api/events", ctx.headers());
      await stream.next(/retry: 2000/);
      worker.fire("session_info_changed");
      await stream.next(/event: session/);
      const [event] = parseEvents(stream.text());
      assert.equal(event.event, "session");
      assert.equal(event.data.id, "s-c");
      stream.close();
    } finally {
      await ctx.close();
      await worker.stop();
    }
  });

  it("tells the pages' event streams when a worker starts and when it stops", async () => {
    const recorder = await startRecorder();
    const ctx = await startHub({ upstream: { "s-rec": recorder } });
    try {
      assert.equal((await send(ctx.port, { target: "/api/events", headers: { Host: `127.0.0.1:${ctx.port}` } })).status, 401);
      const foreign = await send(ctx.port, { target: "/api/events", headers: ctx.headers({ Origin: "http://127.0.0.1:1" }) });
      assert.equal(foreign.status, 403);

      const stream = await openStream(ctx.port, "/api/events", ctx.headers());
      assert.equal(stream.status, 200);
      assert.match(stream.headers["content-type"], /^text\/event-stream/);
      assert.equal(stream.headers["access-control-allow-origin"], undefined);
      await stream.next(/retry: 2000/);
      assert.equal((await ctx.post("/s/s-rec/api/send", { text: "start it" })).status, 200);
      await stream.next(/event: sessions/);
      assert.deepEqual(parseEvents(stream.text()), [{ id: undefined, event: "sessions", data: {} }]);
      ctx.workers[0].exit();
      await stream.next(/event: sessions[\s\S]*event: sessions/);
      assert.equal(parseEvents(stream.text()).length, 2);
      stream.close();
    } finally {
      await ctx.close();
      await recorder.close();
    }
  });

  it("starts one worker for sends that race", async () => {
    const recorder = await startRecorder();
    let release;
    const ctx = await startHub({ upstream: { "s-rec": new Promise((resolve) => (release = () => resolve(recorder))) } });
    try {
      const first = ctx.post("/s/s-rec/api/send", { text: "one" });
      const second = ctx.post("/s/s-rec/api/send", { text: "two" });
      while (ctx.starts.length === 0) await new Promise((resolve) => setImmediate(resolve));
      release();
      assert.deepEqual([(await first).status, (await second).status], [200, 200]);
      assert.equal(ctx.starts.length, 1);
      assert.deepEqual(recorder.requests.map((entry) => JSON.parse(entry.body).text).sort(), ["one", "two"]);
    } finally {
      await ctx.close();
      await recorder.close();
    }
  });

  it("answers 504 when the worker is slow, and sends to it once it is ready", async () => {
    const recorder = await startRecorder();
    let release;
    const ctx = await startHub({ upstream: { "s-rec": new Promise((resolve) => (release = () => resolve(recorder))) } });
    try {
      const slow = ctx.post("/s/s-rec/api/send", { text: "early" });
      while (ctx.starts.length === 0) await new Promise((resolve) => setImmediate(resolve));
      await ctx.fire(30_000);
      const answer = await slow;
      assert.equal(answer.status, 504);
      assert.match(answer.json().error, /still starting/);
      assert.equal(recorder.requests.length, 0, "the message was not sent");
      release();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal((await ctx.post("/s/s-rec/api/send", { text: "again" })).status, 200);
      assert.equal(ctx.starts.length, 1, "the same worker");
      assert.equal(JSON.parse(recorder.requests[0].body).text, "again");
    } finally {
      await ctx.close();
      await recorder.close();
    }
  });

  it("answers 502 when the worker has gone, and treats the session as not running once it exited", async () => {
    const recorder = await startRecorder();
    const ctx = await startHub({ upstream: { "s-rec": recorder } });
    try {
      assert.equal((await ctx.post("/s/s-rec/api/send", { text: "start it" })).status, 200);
      await recorder.close();
      const gone = await send(ctx.port, { target: "/s/s-rec/api/transcript", headers: ctx.headers() });
      assert.equal(gone.status, 502);
      assert.equal(gone.json().state, "gone");
      assert.match(gone.headers["content-type"], /^application\/json/);

      ctx.workers[0].exit();
      const events = await send(ctx.port, { target: "/s/s-rec/api/events", headers: ctx.headers() });
      assert.equal(events.status, 409);
      assert.equal(events.json().state, "not-running");
    } finally {
      await ctx.close();
    }
  });
});

describe("ampi app hub: one writer per session file", () => {
  it("never starts a worker for a file another live process has open", async () => {
    const ctx = await startHub({ upstream: { "s-held": { port: 1 } } });
    try {
      ctx.hold("s-held", TERMINAL_PID);
      const file = ctx.byId["s-held"].path;
      const bytes = readFileSync(file);

      const sent = await ctx.post("/s/s-held/api/send", { text: "may I?" });
      assert.equal(sent.status, 409);
      assert.deepEqual(
        { state: sent.json().state, kind: sent.json().kind, pid: sent.json().pid },
        { state: "elsewhere", kind: "tui", pid: TERMINAL_PID },
      );
      const events = await send(ctx.port, { target: "/s/s-held/api/events", headers: ctx.headers() });
      assert.equal(events.status, 409);
      assert.equal(events.json().state, "elsewhere");
      assert.equal((await ctx.post("/s/s-held/api/interrupt", {})).status, 409);
      const transcript = (await send(ctx.port, { target: "/s/s-held/api/transcript", headers: ctx.headers() })).json();
      assert.deepEqual(transcript.state, { state: "elsewhere", kind: "tui", pid: TERMINAL_PID, gui: false }, "a terminal without the GUI");

      assert.deepEqual(ctx.starts, [], "startSession was never called");
      assert.deepEqual(readFileSync(file), bytes, "the file is unchanged");
    } finally {
      await ctx.close();
    }
  });

  it("never starts a worker for an imported session, which is read-only wherever it is open", async () => {
    const ctx = await startHub({ upstream: { "s-imp": { port: 1 } } });
    try {
      const file = ctx.byId["s-imp"].path;
      const bytes = readFileSync(file);
      const notice =
        "This session was imported from another coding agent and is read-only. To continue the work, start a new session and mention this one with @@, or ask the agent to use find_session and read_session.";

      const transcript = (await send(ctx.port, { target: "/s/s-imp/api/transcript", headers: ctx.headers() })).json();
      assert.deepEqual(transcript.state, { state: "imported" });
      assert.equal(transcript.items.length, 2, "the transcript comes from the file");
      const sent = await ctx.post("/s/s-imp/api/send", { text: "carry on" });
      assert.equal(sent.status, 409);
      assert.deepEqual(sent.json(), { state: "imported", error: notice });
      assert.equal((await send(ctx.port, { target: "/s/s-imp/api/events", headers: ctx.headers() })).status, 409);

      ctx.hold("s-imp", TERMINAL_PID);
      assert.deepEqual((await ctx.post("/s/s-imp/api/send", { text: "carry on" })).json().state, "imported", "open in a terminal, it is still imported");

      assert.deepEqual(ctx.starts, [], "startSession was never called");
      assert.deepEqual(readFileSync(file), bytes, "the file is unchanged");
    } finally {
      await ctx.close();
    }
  });

  it("reads the registry again just before it starts a worker", async () => {
    const ctx = await startHub({ upstream: { "s-c": { port: 1 } } });
    try {
      ctx.hold("s-busy", TERMINAL_PID);
      // A terminal opens s-c while the hub reads the registry for the first time.
      ctx.probes.onProbe = () => {
        ctx.probes.onProbe = undefined;
        ctx.hold("s-c", LATE_PID);
      };
      const sent = await ctx.post("/s/s-c/api/send", { text: "race" });
      assert.equal(sent.status, 409);
      assert.equal(sent.json().pid, LATE_PID);
      assert.deepEqual(ctx.starts, []);
    } finally {
      await ctx.close();
    }
  });

  it("answers 409 when the worker finds the file held itself", async () => {
    const held = Object.assign(new Error("held"), { code: "held", holder: { kind: "execute", pid: TERMINAL_PID } });
    const ctx = await startHub({ upstream: { "s-c": held } });
    try {
      const sent = await ctx.post("/s/s-c/api/send", { text: "race" });
      assert.equal(sent.status, 409);
      assert.equal(sent.json().kind, "execute");
      assert.equal(sent.json().pid, TERMINAL_PID);
    } finally {
      await ctx.close();
    }
  });

  it("stops an idle worker when another process opens its file, and only warns while it works", async () => {
    const worker = await startSessionServer("s-c");
    const ctx = await startHub({ upstream: { "s-c": worker } });
    try {
      assert.equal((await ctx.post("/s/s-c/api/send", { text: "hello" })).status, 200);
      const [hosted] = ctx.workers;
      const stream = await openStream(ctx.port, "/s/s-c/api/events", ctx.headers());
      await stream.next(/retry: 2000/);

      hosted.activity("busy");
      ctx.hold("s-c", TERMINAL_PID);
      await ctx.fire(CHECK_MS);
      await stream.next(/event: warning/);
      assert.equal(hosted.stops, 0, "a busy worker keeps running");
      await ctx.fire(CHECK_MS);
      assert.equal((stream.text().match(/event: warning/g) ?? []).length, 1, "one warning per holder");

      hosted.activity("idle");
      await ctx.fire(CHECK_MS);
      const text = await stream.ended;
      assert.equal(hosted.stops, 1);
      const events = parseEvents(text).filter((event) => event.event === "warning" || event.event === "session");
      assert.deepEqual(
        events.map((event) => [event.event, event.data.state, event.data.kind, event.data.pid]),
        [
          ["warning", "elsewhere", "tui", TERMINAL_PID],
          ["session", "elsewhere", "tui", TERMINAL_PID],
        ],
      );
      assert.equal(events[0].id, undefined, "the hub's own events leave the replay position alone");
      const after = await send(ctx.port, { target: "/s/s-c/api/events", headers: ctx.headers() });
      assert.equal(after.status, 409);
      assert.equal(after.json().state, "elsewhere");
    } finally {
      await ctx.close();
      await worker.stop();
    }
  });

  it("stops a worker after 15 idle minutes without an open event stream", async () => {
    const recorder = await startRecorder();
    const ctx = await startHub({ upstream: { "s-rec": recorder } });
    try {
      assert.equal((await ctx.post("/s/s-rec/api/send", { text: "hello" })).status, 200);
      const [hosted] = ctx.workers;
      const stream = await openStream(ctx.port, "/s/s-rec/api/events", ctx.headers());
      await stream.next(/event: status/);
      ctx.clock.now += IDLE_MS * 2;
      await ctx.fire(CHECK_MS);
      assert.equal(hosted.stops, 0, "an open event stream keeps it");

      stream.close();
      // The hub closes the worker's stream when the browser's closes, after it noted the time.
      await recorder.closed;
      ctx.clock.now += IDLE_MS - 1;
      await ctx.fire(CHECK_MS);
      assert.equal(hosted.stops, 0, "not idle long enough");
      ctx.clock.now += 1;
      await ctx.fire(CHECK_MS);
      assert.equal(hosted.stops, 1);
    } finally {
      await ctx.close();
      await recorder.close();
    }
  });
});

describe("ampi app hub: terminal sessions", () => {
  it("forwards GET, POST and the event stream to a terminal's own GUI with the token from its token file", async () => {
    const ctx = await startHub();
    const terminal = await startTerminal(ctx, "s-held");
    try {
      const list = (await send(ctx.port, { target: "/api/sessions", headers: ctx.headers() })).json();
      const row = list.groups.flatMap((group) => group.sessions).find((candidate) => candidate.id === "s-held");
      assert.deepEqual(row.host, { kind: "tui", pid: process.pid, gui: true, phase: "idle" });

      const snapshot = await send(ctx.port, { target: "/s/s-held/api/transcript", headers: ctx.headers() });
      assert.equal(snapshot.status, 200);
      assert.equal(snapshot.json().session.id, "s-held", "the terminal's live snapshot");
      assert.equal("state" in snapshot.json(), false);
      assert.equal(typeof snapshot.json().lastEventId, "number");
      assert.equal(snapshot.headers["set-cookie"], undefined, "the terminal's cookie never reaches the browser");
      assert.equal(snapshot.body.includes(TERMINAL_TOKEN), false);

      const sent = await ctx.post("/s/s-held/api/send", { text: "from the page" });
      assert.equal(sent.status, 200);
      assert.equal(terminal.mock.calls.sendUserMessage.at(-1)?.content, "from the page", "the terminal's session got the message");

      const stream = await openStream(ctx.port, "/s/s-held/api/events", ctx.headers());
      await stream.next(/retry: 2000/);
      terminal.fire("session_info_changed");
      await stream.next(/event: session/);
      assert.equal(parseEvents(stream.text()).find((event) => event.event === "session")?.data.id, "s-held");
      stream.close();

      assert.equal((await ctx.post("/api/rename", { sessionId: "s-held", name: "Renamed here" })).status, 200);
      assert.deepEqual(terminal.renamed, ["Renamed here"], "a rename goes to the terminal too");
      assert.deepEqual(ctx.starts, [], "no worker for a session a terminal runs");
    } finally {
      await ctx.close();
      await terminal.stop();
    }
  });

  it("keeps a terminal session read-only when its token file is missing or names another token", async () => {
    const ctx = await startHub();
    const terminal = await startTerminal(ctx, "s-held");
    const tokenFile = path.join(ctx.registryDir, `${process.pid}.token`);
    try {
      for (const [label, spoil] of [
        ["another token", () => writeFileSync(tokenFile, ["not", "the", "token"].join("-"))],
        ["no token file", () => rmSync(tokenFile)],
      ]) {
        spoil();
        const transcript = await send(ctx.port, { target: "/s/s-held/api/transcript", headers: ctx.headers() });
        assert.equal(transcript.status, 200, label);
        assert.deepEqual(transcript.json().state, { state: "elsewhere", kind: "tui", pid: process.pid, gui: true }, label);
        assert.equal(transcript.json().items.length, 2, `${label}: read from the file`);
        const sent = await ctx.post("/s/s-held/api/send", { text: "may I?" });
        assert.equal(sent.status, 409, label);
        assert.equal(sent.json().gui, true, label);
        assert.equal((await send(ctx.port, { target: "/s/s-held/api/events", headers: ctx.headers() })).status, 409, label);
      }
      assert.deepEqual(terminal.mock.calls.sendUserMessage, [], "nothing reached the terminal");
      assert.deepEqual(ctx.starts, []);
    } finally {
      await ctx.close();
      await terminal.stop();
    }
  });

  it("keeps a session another ampi app runs read-only although its entry names a GUI with a matching token file", async () => {
    const ctx = await startHub();
    const terminal = await startTerminal(ctx, "s-held");
    const entryFile = path.join(ctx.registryDir, `${process.pid}.json`);
    try {
      writeFileSync(entryFile, JSON.stringify({ ...JSON.parse(readFileSync(entryFile, "utf8")), kind: "app-session", ownerPid: LATE_PID }));
      const transcript = await send(ctx.port, { target: "/s/s-held/api/transcript", headers: ctx.headers() });
      assert.equal(transcript.status, 200);
      assert.deepEqual(transcript.json().state, { state: "elsewhere", kind: "app-session", pid: process.pid, gui: true });
      assert.equal(transcript.json().items.length, 2, "read from the file");
      const sent = await ctx.post("/s/s-held/api/send", { text: "may I?" });
      assert.equal(sent.status, 409);
      assert.equal(sent.json().kind, "app-session");
      assert.equal((await send(ctx.port, { target: "/s/s-held/api/events", headers: ctx.headers() })).status, 409);
      assert.deepEqual(terminal.mock.calls.sendUserMessage, [], "nothing reached the GUI the entry names");
      assert.deepEqual(ctx.starts, []);
    } finally {
      await ctx.close();
      await terminal.stop();
    }
  });

  it("answers 502 once the terminal's GUI has gone, reads the registry again and tells the pages", async () => {
    const ctx = await startHub();
    const terminal = await startTerminal(ctx, "s-held");
    const files = [`${process.pid}.json`, `${process.pid}.token`].map((name) => path.join(ctx.registryDir, name));
    const saved = files.map((file) => readFileSync(file));
    const page = await openStream(ctx.port, "/api/events", ctx.headers());
    try {
      await page.next(/retry: 2000/);
      await terminal.stop();
      // As after a crash: the process still runs, its files are there, its server is not.
      for (const [index, file] of files.entries()) writeFileSync(file, saved[index]);
      const gone = await send(ctx.port, { target: "/s/s-held/api/transcript", headers: ctx.headers() });
      assert.equal(gone.status, 502);
      assert.equal(gone.json().state, "gone");
      await page.next(/event: sessions/);

      ctx.alive.delete(process.pid);
      const after = await send(ctx.port, { target: "/s/s-held/api/transcript", headers: ctx.headers() });
      assert.deepEqual(after.json().state, { state: "not-running" });
      assert.deepEqual(readdirSync(ctx.registryDir), [], "the dead process's entry and token file are removed");
    } finally {
      page.close();
      await ctx.close();
    }
  });
});

describe("ampi-gui with a hub host", () => {
  it("serves the hub in RPC mode, tells the host its port once and records the app without a file", async () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), "ampi-hub-ext-")), "live");
    dirs.push(path.dirname(dir));
    const ready = [];
    globalThis[hostKey] = {
      role: "hub",
      token: HUB_TOKEN,
      ownerPid: process.pid,
      ready: (info) => ready.push(info),
      startSession: async () => {
        throw new Error("not in this test");
      },
    };
    const { createMmrGuiExtension } = await importSource("extensions/ampi-gui/index.ts");
    const mock = createMockPi();
    const timers = [];
    const writer = liveRegistry.registerMmrLiveRegistry(mock.pi, { dir, now: () => 0, setTimer: (callback) => timers.push(callback), clearTimer: () => {} });
    createMmrGuiExtension({ loadSettings: () => ({ enabled: false }), registryDir: dir })(mock.pi);
    const { ctx } = createMockExtensionContext({ mode: "rpc", hasUI: false, cwd: "/work/app", sessionId: "s-app" });
    const emit = (name, event) => mock.handlers.get(name)({ type: name, ...event }, ctx);
    assert.deepEqual(liveRegistry.resolveMmrLiveKind(ctx), { kind: "app" });

    await emit("session_start", { reason: "startup" });
    assert.equal(ready.length, 1);
    const { port } = ready[0];
    const app = await send(port, { target: "/api/app", headers: { Host: `127.0.0.1:${port}`, Cookie: `ampi_gui_${port}=${HUB_TOKEN}` } });
    assert.deepEqual(app.json(), { app: true });
    for (const run of timers.splice(0)) run();
    await writer.idle();
    const entry = JSON.parse(readFileSync(path.join(dir, `${process.pid}.json`), "utf8"));
    assert.equal(entry.kind, "app");
    assert.equal(entry.sessionPath, null);
    assert.equal(entry.gui.port, port);
    assert.equal(entry.ownerPid, undefined);
    assert.equal(readFileSync(path.join(dir, `${process.pid}.token`), "utf8"), HUB_TOKEN, "a second ampi app reads the link from here");

    await emit("session_shutdown", { reason: "quit" });
    assert.deepEqual(readdirSync(dir), []);
    await assert.rejects(send(port, { headers: { Host: `127.0.0.1:${port}` } }), { code: "ECONNREFUSED" });
  });
});
