// `ampi app --worker`: the IPC protocol of a worker that runs one session
// for `ampi app` (packages/ampi-cli/src/app-worker.js), with a fake Pi
// module and session builder, plus the executable's refusal to run without
// an IPC channel and the agreement between the command's GUI host record
// and ampi-core's reader.
import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { AMPI_GUI_HOST_GLOBAL_KEY, HOSTED_SESSIONS_MIN_AMPI_VERSION, registerAmpiGuiHost, runAppWorker } from "../packages/ampi-cli/src/app-worker.js";
import { formatAmpiHelp, routeAmpiArgv } from "../packages/ampi-cli/src/argv.js";
import { readProcStart } from "../packages/ampi-cli/src/live-registry.js";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const repoRoot = path.resolve(import.meta.dirname, "..");
const bin = path.join(repoRoot, "packages", "ampi-cli", "bin", "ampi.js");
const TOKEN = ["worker", "test", "token"].join("-");
const WORKER_PID = 7_000_001;
const OWNER_PID = 7_000_002;
const PORT = 45_678;
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  delete globalThis[AMPI_GUI_HOST_GLOBAL_KEY];
});

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "ampi-app-worker-"));
  dirs.push(dir);
  return dir;
}

/** An IPC channel in memory: `sent` holds what the worker sent; `next(type)` waits for one. */
function createChannel() {
  const channel = new EventEmitter();
  channel.connected = true;
  channel.sent = [];
  channel.send = (message, callback) => {
    channel.sent.push(message);
    channel.emit("sent", message);
    callback(null);
  };
  channel.next = (type) =>
    new Promise((resolve) => {
      const found = channel.sent.find((message) => message.type === type);
      if (found) return resolve(found);
      const listener = (message) => {
        if (message.type !== type) return;
        channel.off("sent", listener);
        resolve(message);
      };
      channel.on("sent", listener);
    });
  channel.close = () => {
    channel.connected = false;
    channel.emit("disconnect");
  };
  return channel;
}

/**
 * A fake Pi module and session builder. Opening a file appends to it, the
 * way Pi rewrites a file it migrates, so a test can tell whether it was opened.
 */
function createFakes(cwd) {
  const calls = { open: [], create: [], sessions: [], disposed: 0 };
  let listener;
  const pi = {
    getAgentDir: () => path.join(cwd, "agent"),
    SessionManager: {
      open: (file) => {
        calls.open.push(file);
        writeFileSync(file, "{}\n", { flag: "a" });
        return { getCwd: () => cwd, file };
      },
      create: (dir) => {
        calls.create.push(dir);
        return { getCwd: () => dir };
      },
    },
  };
  const createSession = async (options) => {
    calls.sessions.push(options);
    // What ampi-gui does at session start when the host is registered.
    globalThis[AMPI_GUI_HOST_GLOBAL_KEY].ready({ port: PORT });
    return {
      diagnostics: [],
      session: {
        sessionId: "s-new",
        sessionFile: path.join(cwd, "s-new.jsonl"),
        subscribe: (next) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
      },
      dispose: async () => {
        calls.disposed++;
      },
    };
  };
  const locateAmpi = async () => ({ load: true, ampi: { root: repoRoot, version: "0.3.1" } });
  return { pi, calls, createSession, locateAmpi, emit: (event) => listener?.(event) };
}

function startWorker(channel, fakes, registryDir, extra = {}) {
  return runAppWorker({
    channel,
    pi: fakes.pi,
    createSession: fakes.createSession,
    locateAmpi: fakes.locateAmpi,
    registryDir,
    pid: WORKER_PID,
    ownerPid: OWNER_PID,
    chdir: () => {},
    ...extra,
  });
}

describe("ampi app worker protocol", () => {
  it("starts a session in RPC mode with the host's token, reports ready and activity, and disposes it on stop", async () => {
    const cwd = tempDir();
    const fakes = createFakes(cwd);
    const channel = createChannel();
    const exit = startWorker(channel, fakes, path.join(cwd, "live"));
    channel.emit("message", { type: "start", token: TOKEN, session: { cwd } });

    const ready = await channel.next("ready");
    assert.deepEqual(ready, { type: "ready", pid: WORKER_PID, port: PORT, sessionId: "s-new", sessionPath: path.join(cwd, "s-new.jsonl") });
    assert.deepEqual(fakes.calls.create, [cwd]);
    const [options] = fakes.calls.sessions;
    assert.equal(options.mode, "rpc");
    assert.equal(options.connectMcp, true);
    assert.equal(typeof options.uiContext?.confirm, "function", "a UI context, so extensions see hasUI");
    assert.equal(options.cwd, cwd);
    const host = globalThis[AMPI_GUI_HOST_GLOBAL_KEY];
    assert.equal(host.role, "session");
    assert.equal(host.token, TOKEN);
    assert.equal(host.ownerPid, OWNER_PID);

    fakes.emit({ type: "agent_start" });
    fakes.emit({ type: "turn_end" });
    fakes.emit({ type: "agent_settled" });
    assert.deepEqual(
      channel.sent.filter((message) => message.type === "activity"),
      [
        { type: "activity", state: "busy" },
        { type: "activity", state: "idle" },
      ],
    );

    assert.equal(fakes.calls.disposed, 0);
    channel.emit("message", { type: "stop" });
    assert.equal(await exit, 0);
    assert.equal(fakes.calls.disposed, 1);
  });

  it("binds a UI context whose dialogs ask the handler ampi-gui sets, and are cancelled without one", async () => {
    const cwd = tempDir();
    const fakes = createFakes(cwd);
    const channel = createChannel();
    const exit = startWorker(channel, fakes, path.join(cwd, "live"));
    channel.emit("message", { type: "start", token: TOKEN, session: { cwd } });
    await channel.next("ready");
    const ui = fakes.calls.sessions[0].uiContext;
    const host = globalThis[AMPI_GUI_HOST_GLOBAL_KEY];

    // Before ampi-gui sets its handler, every dialog is cancelled and notify goes nowhere.
    assert.equal(await ui.confirm("Delete?", "It is gone for good."), false);
    assert.equal(await ui.select("Pick", ["a", "b"]), undefined);
    assert.equal(await ui.input("Name"), undefined);
    assert.equal(await ui.editor("Edit", "text"), undefined);
    ui.notify("nobody hears this");

    const asked = [];
    const notices = [];
    const answers = [{ value: true }, { value: "b" }, { value: "typed" }, { value: "edited" }, { cancelled: true }];
    host.dialog = async (request, options) => {
      asked.push({ request, options });
      return answers.shift();
    };
    host.notice = (message, level) => notices.push([message, level]);
    const signal = new AbortController().signal;
    assert.equal(await ui.confirm("Delete?", "It is gone for good.", { timeout: 500 }), true);
    assert.equal(await ui.select("Pick", ["a", "b"], { signal }), "b");
    assert.equal(await ui.input("Name", "e.g. main"), "typed");
    assert.equal(await ui.editor("Edit", "text"), "edited");
    assert.equal(await ui.confirm("Again?", "Cancelled this time."), false);
    assert.deepEqual(
      asked.map((entry) => entry.request),
      [
        { kind: "confirm", title: "Delete?", message: "It is gone for good." },
        { kind: "select", title: "Pick", options: ["a", "b"] },
        { kind: "input", title: "Name", placeholder: "e.g. main" },
        { kind: "editor", title: "Edit", initial: "text" },
        { kind: "confirm", title: "Again?", message: "Cancelled this time." },
      ],
    );
    assert.deepEqual(asked[0].options, { timeout: 500 }, "Pi's timeout goes to the handler");
    assert.equal(asked[1].options.signal, signal, "and its abort signal");

    // A failing handler, or an answer of the wrong type, is a cancel.
    host.dialog = async () => {
      throw new Error("page gone");
    };
    assert.equal(await ui.confirm("Delete?", "?"), false);
    host.dialog = async () => ({ value: 42 });
    assert.equal(await ui.input("Name"), undefined);

    ui.notify("Saved", "warning");
    ui.notify("Plain");
    assert.deepEqual(notices, [
      ["Saved", "warning"],
      ["Plain", "info"],
    ]);

    // The rest answers as Pi's RPC mode does without a client.
    assert.equal(await ui.custom(() => ({})), undefined);
    assert.equal(ui.getEditorText(), "");
    assert.equal(ui.getToolsExpanded(), false);
    assert.deepEqual(ui.getAllThemes(), []);
    assert.equal(ui.setTheme("dark").success, false);
    assert.equal(typeof ui.onTerminalInput(() => {}), "function");
    for (const name of ["setStatus", "setWidget", "setTitle", "setEditorText", "setFooter", "setHeader", "setWorkingMessage"]) {
      assert.equal(ui[name]("key", ["line"]), undefined, name);
    }

    channel.emit("message", { type: "stop" });
    assert.equal(await exit, 0);
  });

  it("answers held without opening a file another live process has open", async () => {
    const cwd = tempDir();
    const registryDir = path.join(cwd, "live");
    const file = path.join(cwd, "held.jsonl");
    writeFileSync(file, "");
    // This test process is the live holder: a terminal session on the file.
    mkdirSync(registryDir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      path.join(registryDir, `${process.pid}.json`),
      JSON.stringify({
        version: 2,
        pid: process.pid,
        procStart: readProcStart(process.pid),
        kind: "tui",
        sessionId: "s-held",
        sessionPath: file,
        cwd,
        title: null,
        mode: null,
        status: null,
        startedAt: now,
        updatedAt: now,
        gui: null,
      }),
    );
    const before = { bytes: readFileSync(file), mtime: statSync(file).mtimeMs };
    const fakes = createFakes(cwd);
    const channel = createChannel();
    const exit = startWorker(channel, fakes, registryDir);
    channel.emit("message", { type: "start", token: TOKEN, session: { path: file } });

    assert.equal(await exit, 3);
    const [error] = channel.sent;
    assert.equal(error.type, "error");
    assert.equal(error.code, "held");
    assert.deepEqual(error.holder, { kind: "tui", pid: process.pid });
    assert.equal(channel.sent.length, 1);
    assert.deepEqual(fakes.calls.open, []);
    assert.deepEqual(fakes.calls.sessions, []);
    assert.deepEqual(readFileSync(file), before.bytes);
    assert.equal(statSync(file).mtimeMs, before.mtime);

    // Once nobody holds it, the same start opens it.
    rmSync(path.join(registryDir, `${process.pid}.json`));
    const second = createChannel();
    const running = startWorker(second, fakes, registryDir);
    second.emit("message", { type: "start", token: TOKEN, session: { path: file } });
    await second.next("ready");
    assert.deepEqual(fakes.calls.open, [file]);
    second.emit("message", { type: "stop" });
    assert.equal(await running, 0);
  });

  it("stops and disposes the session when the channel closes", async () => {
    const cwd = tempDir();
    const fakes = createFakes(cwd);
    const channel = createChannel();
    const exit = startWorker(channel, fakes, path.join(cwd, "live"));
    channel.emit("message", { type: "start", token: TOKEN, session: { cwd } });
    await channel.next("ready");
    channel.close();
    assert.equal(await exit, 0);
    assert.equal(fakes.calls.disposed, 1);
  });

  it("answers failed and exits 1 when Pi cannot open the session file", async () => {
    const cwd = tempDir();
    const file = path.join(cwd, "broken.jsonl");
    writeFileSync(file, "not json\n");
    const fakes = createFakes(cwd);
    fakes.pi.SessionManager.open = () => {
      throw new Error(`Session file is not a valid pi session: ${file}`);
    };
    const channel = createChannel();
    const exit = startWorker(channel, fakes, path.join(cwd, "live"));
    channel.emit("message", { type: "start", token: TOKEN, session: { path: file } });

    assert.equal(await exit, 1);
    assert.equal(channel.sent.length, 1);
    assert.equal(channel.sent[0].type, "error");
    assert.equal(channel.sent[0].code, "failed");
    assert.match(channel.sent[0].message, /not a valid pi session/);
    assert.deepEqual(fakes.calls.sessions, []);
  });

  it("builds no session when stop arrives while it locates ampi", async () => {
    const cwd = tempDir();
    const fakes = createFakes(cwd);
    const channel = createChannel();
    const exit = startWorker(channel, fakes, path.join(cwd, "live"), {
      locateAmpi: async (...args) => {
        channel.emit("message", { type: "stop" });
        return fakes.locateAmpi(...args);
      },
    });
    channel.emit("message", { type: "start", token: TOKEN, session: { cwd } });

    assert.equal(await exit, 0);
    assert.deepEqual(channel.sent, []);
    assert.deepEqual(fakes.calls.sessions, []);
    assert.equal(fakes.calls.disposed, 0);
  });

  it("refuses a malformed start and an ampi without the GUI host seam", async () => {
    const cwd = tempDir();
    const fakes = createFakes(cwd);
    const malformed = createChannel();
    const exit = startWorker(malformed, fakes, path.join(cwd, "live"));
    malformed.emit("message", { type: "start", token: TOKEN, session: { cwd, path: path.join(cwd, "a.jsonl") } });
    assert.equal(await exit, 1);
    assert.equal(malformed.sent[0].code, "bad-start");

    const old = createChannel();
    const oldAmpi = tempDir();
    const refused = startWorker(old, fakes, path.join(cwd, "live"), { locateAmpi: async () => ({ load: true, ampi: { root: oldAmpi, version: "0.3.1" } }) });
    old.emit("message", { type: "start", token: TOKEN, session: { cwd } });
    assert.equal(await refused, 1);
    assert.equal(old.sent[0].code, "ampi-too-old");
    assert.ok(old.sent[0].message.includes(`@skippermissions/ampi ${HOSTED_SESSIONS_MIN_AMPI_VERSION} or later`), old.sent[0].message);
    assert.deepEqual(fakes.calls.sessions, []);
  });
});

describe("ampi app --worker executable", () => {
  it("is not in the help and is routed only as `app --worker`", () => {
    assert.equal(formatAmpiHelp().includes("--worker"), false);
    assert.equal(routeAmpiArgv(["app", "--worker"]).command, "app-worker");
    assert.equal(routeAmpiArgv(["app", "--worker", "hello"]).command, "error");
  });

  it("refuses to run without an IPC channel", () => {
    const result = spawnSync(process.execPath, [bin, "app", "--worker"], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^ampi: app --worker is started by ampi app/);
  });

  it("answers over a real IPC channel and exits when it closes", async () => {
    const agentDir = path.join(tempDir(), "agent");
    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
    const run = (send) =>
      new Promise((resolve, reject) => {
        const child = fork(bin, ["app", "--worker"], { cwd: repoRoot, env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
        const messages = [];
        child.on("message", (message) => messages.push(message));
        child.on("error", reject);
        child.on("exit", (code) => resolve({ code, messages }));
        child.on("spawn", () => send(child));
      });

    const bad = await run((child) => child.send({ type: "start", session: { cwd: repoRoot } }));
    assert.equal(bad.code, 1);
    assert.equal(bad.messages[0]?.code, "bad-start");

    const closed = await run((child) => child.disconnect());
    assert.equal(closed.code, 0);
    assert.deepEqual(closed.messages, []);
  });
});

describe("GUI host record", () => {
  it("is written by the command where ampi-core reads it, in the shape it accepts", async () => {
    const { MMR_GUI_HOST_GLOBAL_KEY, getMmrGuiHost } = await importSource("extensions/ampi-core/gui-host.ts");
    const { resolveMmrLiveKind } = await importSource("extensions/ampi-core/live-registry.ts");
    assert.equal(AMPI_GUI_HOST_GLOBAL_KEY, MMR_GUI_HOST_GLOBAL_KEY);
    const ctx = createMockExtensionContext({ mode: "rpc", hasUI: false, sessionFile: "/sessions/a.jsonl" }).ctx;
    assert.equal(getMmrGuiHost(), undefined);
    assert.deepEqual(resolveMmrLiveKind(ctx), { kind: "execute" });

    const ports = [];
    registerAmpiGuiHost({ token: TOKEN, ownerPid: OWNER_PID, ready: (info) => ports.push(info.port) });
    const host = getMmrGuiHost();
    assert.ok(host, "ampi-core accepts the command's record");
    assert.equal(host.role, "session");
    assert.equal(host.token, TOKEN);
    assert.equal(host.ownerPid, OWNER_PID);
    host.ready({ port: PORT });
    assert.deepEqual(ports, [PORT]);
    assert.deepEqual(resolveMmrLiveKind(ctx), { kind: "app-session", ownerPid: OWNER_PID });
  });
});
