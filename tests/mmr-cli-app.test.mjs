// `ampi app` (packages/ampi-cli/src/app.js): the argument routes, the hub
// host record it writes for ampi-gui, the workers it forks through
// startSession, the refusal to run twice, and the shutdown that stops every
// worker. Pi, the session builder and the worker processes are fakes; one
// test runs the real executable against a temporary live registry.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { registerAmpiGuiHub, runApp, WORKER_STOP_TIMEOUT_MS } from "../packages/ampi-cli/src/app.js";
import { AMPI_GUI_HOST_GLOBAL_KEY } from "../packages/ampi-cli/src/app-worker.js";
import { formatAmpiHelp, routeAmpiArgv } from "../packages/ampi-cli/src/argv.js";
import { readProcStart } from "../packages/ampi-cli/src/live-registry.js";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const repoRoot = path.resolve(import.meta.dirname, "..");
const bin = path.join(repoRoot, "packages", "ampi-cli", "bin", "ampi.js");
const APP_PID = 7_200_001;
const PORT = 41_234;
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  delete globalThis[AMPI_GUI_HOST_GLOBAL_KEY];
});

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "ampi-app-"));
  dirs.push(dir);
  return dir;
}

/** A live registry entry of `kind` for `pid`, which must be a running process. */
function writeEntry(dir, pid, kind, extra = {}) {
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    path.join(dir, `${pid}.json`),
    JSON.stringify({
      version: 2,
      pid,
      procStart: readProcStart(pid),
      kind,
      sessionId: null,
      sessionPath: null,
      cwd: "/work",
      title: null,
      mode: null,
      status: null,
      startedAt: now,
      updatedAt: now,
      gui: null,
      ...extra,
    }),
  );
}

/**
 * A forked worker in memory. It answers start with ready (or `answer`), and
 * stop by exiting unless `ignoreStop` is set.
 */
function createChild(pid, { answer, ignoreStop = false } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.connected = true;
  child.sent = [];
  child.killed = [];
  const exit = () => {
    child.connected = false;
    child.emit("exit", 0, null);
  };
  child.send = (message) => {
    child.sent.push(message);
    queueMicrotask(() => {
      if (message.type === "start") {
        for (const reply of answer ?? [{ type: "ready", pid, port: PORT + pid, sessionId: `s-${pid}`, sessionPath: message.session.path ?? null }]) {
          child.emit("message", reply);
        }
        if (answer?.some((reply) => reply.type === "error")) exit();
      } else if (message.type === "stop" && !ignoreStop) exit();
    });
    return true;
  };
  child.kill = (signal) => {
    child.killed.push(signal);
    exit();
    return true;
  };
  return child;
}

/** runApp with fakes; `stop()` plays Ctrl+C. */
function startApp({ registryDir = path.join(tempDir(), "live"), children = [], open = false, openUrl, ready = true } = {}) {
  const out = [];
  const err = [];
  const sessions = [];
  const timers = [];
  let disposed = 0;
  let stop;
  const stopped = new Promise((resolve) => {
    stop = resolve;
  });
  const forked = [];
  const pi = { getAgentDir: () => path.dirname(registryDir), SessionManager: { inMemory: (cwd) => ({ inMemory: true, cwd }) } };
  const createSession = async (options) => {
    sessions.push({ options, host: globalThis[AMPI_GUI_HOST_GLOBAL_KEY] });
    // What ampi-gui does at session start with a hub host.
    if (ready) globalThis[AMPI_GUI_HOST_GLOBAL_KEY].ready({ port: PORT });
    return {
      diagnostics: ready ? [] : [{ type: "error", message: "ampi-gui failed to load" }],
      dispose: async () => {
        disposed++;
      },
    };
  };
  const exit = runApp({
    pi,
    open,
    cwd: "/work/here",
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    stopped,
    registryDir,
    pid: APP_PID,
    createSession,
    forkWorker: () => {
      const child = children.shift() ?? createChild(9_000 + forked.length);
      forked.push(child);
      return child;
    },
    openUrl,
    createToken: () => ["token", forked.length].join("-"),
    setTimer: (callback, ms) => {
      const timer = { callback, ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  return { exit, out, err, sessions, timers, forked, stop: () => stop(), disposed: () => disposed, registryDir };
}

/** Wait until `predicate` holds, letting promises and queued microtasks run. */
async function until(predicate) {
  while (!predicate()) await new Promise((resolve) => setImmediate(resolve));
}

describe("ampi app: argument routes", () => {
  it("routes app, app --open and the hidden app --worker, and keeps app out of the help", () => {
    assert.deepEqual(
      ["app", "app --open", "app --worker"].map((line) => {
        const route = routeAmpiArgv(line.split(" "));
        return [route.command, route.open];
      }),
      [
        ["app", false],
        ["app", true],
        ["app-worker", undefined],
      ],
    );
    for (const line of ["app --bogus", "app --worker hello", "app --open --open"]) {
      const route = routeAmpiArgv(line.split(" "));
      assert.equal(route.command, "error", line);
      assert.equal(route.error, "ampi app takes only --open.");
    }
    assert.doesNotMatch(formatAmpiHelp(), /\bapp\b/);
  });

  it("runs: a second ampi app finds the first and exits 1", () => {
    const agentDir = path.join(tempDir(), "agent");
    // This test process plays the running app.
    writeEntry(path.join(agentDir, "data", "ampi", "live"), process.pid, "app");
    const result = spawnSync(process.execPath, [bin, "app"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `ampi: ampi app already runs in process ${process.pid}. Use that one, or stop it first.\n`);
  });
});

describe("ampi app: the hub", () => {
  it("creates an unsaved session in RPC mode with the hub record, prints the link and stops cleanly", async () => {
    const app = startApp();
    await until(() => app.out.length === 2);
    const [{ options, host }] = app.sessions;
    assert.equal(options.mode, "rpc");
    assert.equal(options.connectMcp, false);
    assert.equal(options.uiContext, undefined);
    assert.deepEqual(options.sessionManager, { inMemory: true, cwd: "/work/here" });
    assert.equal(host.role, "hub");
    assert.equal(host.ownerPid, APP_PID);
    assert.equal(typeof host.startSession, "function");
    assert.deepEqual(app.out, [`ampi app: http://127.0.0.1:${PORT}/?t=${host.token}\n`, "Ctrl+C stops ampi app and every session it runs.\n"]);

    // The app's own entry, as ampi-core writes it; the app removes it when it stops.
    writeEntry(app.registryDir, process.pid, "tui");
    const own = path.join(app.registryDir, `${APP_PID}.json`);
    writeFileSync(own, "{}");
    app.stop();
    assert.equal(await app.exit, 0);
    assert.equal(app.disposed(), 1);
    assert.equal(existsSync(own), false);
    assert.equal(existsSync(path.join(app.registryDir, `${process.pid}.json`)), true, "only its own entry");
  });

  it("refuses to start while another ampi app runs", async () => {
    const registryDir = path.join(tempDir(), "live");
    writeEntry(registryDir, process.pid, "app");
    const app = startApp({ registryDir });
    assert.equal(await app.exit, 1);
    assert.deepEqual(app.err, [`ampi: ampi app already runs in process ${process.pid}. Use that one, or stop it first.\n`]);
    assert.deepEqual(app.sessions, [], "no session was created");
  });

  it("opens the link with --open and says so when no browser starts", async () => {
    const opened = [];
    const app = startApp({ open: true, openUrl: async (url) => (opened.push(url), false) });
    await until(() => app.out.length === 3);
    assert.deepEqual(opened, [app.out[0].slice("ampi app: ".length, -1)]);
    assert.equal(app.out[2], "No browser could be started; open the link above.\n");
    app.stop();
    assert.equal(await app.exit, 0);
  });

  it("exits 1 when ampi-gui does not serve the app", async () => {
    const app = startApp({ ready: false });
    assert.equal(await app.exit, 1);
    assert.match(app.err[0], /^ampi: ampi app needs an ampi whose web GUI serves the app; update @skippermissions\/ampi\. ampi-gui failed to load\n$/);
    assert.equal(app.disposed(), 1);
  });
});

describe("ampi app: workers", () => {
  it("forks a worker per session with its own token and resolves once it is ready", async () => {
    const app = startApp();
    await until(() => app.sessions.length === 1);
    const { host } = app.sessions[0];
    const session = await host.startSession({ path: "/sessions/a.jsonl" });
    const [child] = app.forked;
    assert.deepEqual(child.sent, [{ type: "start", token: session.token, session: { path: "/sessions/a.jsonl" } }]);
    assert.notEqual(session.token, host.token, "each worker has a token of its own");
    assert.deepEqual(
      { pid: session.pid, port: session.port, sessionId: session.sessionId, sessionPath: session.sessionPath },
      { pid: 9_000, port: PORT + 9_000, sessionId: "s-9000", sessionPath: "/sessions/a.jsonl" },
    );

    const activity = [];
    session.onActivity((state) => activity.push(state));
    child.emit("message", { type: "activity", state: "busy" });
    child.emit("message", { type: "activity", state: "idle" });
    assert.deepEqual(activity, ["busy", "idle"]);

    let exited = 0;
    session.onExit(() => exited++);
    await session.stop();
    assert.deepEqual(child.sent.at(-1), { type: "stop" });
    assert.equal(exited, 1);
    assert.deepEqual(child.killed, []);
    app.stop();
    assert.equal(await app.exit, 0);
  });

  it("rejects with the holder when the worker finds the file held", async () => {
    const holder = { kind: "tui", pid: 4_321 };
    const app = startApp({ children: [createChild(9_100, { answer: [{ type: "error", code: "held", message: "held elsewhere", holder }] })] });
    await until(() => app.sessions.length === 1);
    await assert.rejects(app.sessions[0].host.startSession({ path: "/sessions/held.jsonl" }), (error) => {
      assert.equal(error.code, "held");
      assert.deepEqual(error.holder, holder);
      return true;
    });
    app.stop();
    assert.equal(await app.exit, 0);
  });

  it("stops every worker at shutdown and kills only the one that does not stop within 5 s", async () => {
    const stubborn = createChild(9_200, { ignoreStop: true });
    const app = startApp({ children: [createChild(9_201), stubborn] });
    await until(() => app.sessions.length === 1);
    const { host } = app.sessions[0];
    await host.startSession({ path: "/sessions/a.jsonl" });
    await host.startSession({ path: "/sessions/b.jsonl" });

    app.stop();
    await until(() => app.timers.length === 1);
    const [first] = app.forked;
    assert.deepEqual(first.sent.at(-1), { type: "stop" });
    assert.deepEqual(stubborn.sent.at(-1), { type: "stop" });
    assert.deepEqual(first.killed, []);
    assert.deepEqual(stubborn.killed, [], "not before the timer");
    assert.equal(app.timers[0].ms, WORKER_STOP_TIMEOUT_MS);
    app.timers[0].callback();
    assert.equal(await app.exit, 0);
    assert.deepEqual(stubborn.killed, ["SIGKILL"]);
    assert.deepEqual(first.killed, []);
    assert.equal(app.disposed(), 1);
  });
});

describe("hub host record", () => {
  it("is written by the command where ampi-core reads it, and makes the session an app entry", async () => {
    const { MMR_GUI_HOST_GLOBAL_KEY, getMmrGuiHost } = await importSource("extensions/ampi-core/gui-host.ts");
    const { resolveMmrLiveKind } = await importSource("extensions/ampi-core/live-registry.ts");
    assert.equal(AMPI_GUI_HOST_GLOBAL_KEY, MMR_GUI_HOST_GLOBAL_KEY);
    const ctx = createMockExtensionContext({ mode: "rpc", hasUI: false }).ctx;
    assert.equal(resolveMmrLiveKind(ctx), undefined, "an in-memory session writes no entry");

    const ports = [];
    const startSession = async () => ({});
    registerAmpiGuiHub({ token: "t", ownerPid: APP_PID, ready: (info) => ports.push(info.port), startSession });
    const host = getMmrGuiHost();
    assert.equal(host?.role, "hub");
    assert.equal(host.startSession, startSession);
    host.ready({ port: PORT });
    assert.deepEqual(ports, [PORT]);
    assert.deepEqual(resolveMmrLiveKind(ctx), { kind: "app" });

    globalThis[AMPI_GUI_HOST_GLOBAL_KEY] = { ...globalThis[AMPI_GUI_HOST_GLOBAL_KEY], startSession: undefined };
    assert.equal(getMmrGuiHost(), undefined, "a hub record needs startSession");
  });
});
