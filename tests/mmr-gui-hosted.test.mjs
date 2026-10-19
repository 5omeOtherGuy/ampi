// ampi-gui in a session `ampi app` hosts: with a session host registered
// (ampi-core's gui-host.ts), the GUI serves Pi's RPC mode with the host's
// token whatever its setting says, reports its port to the host once instead
// of printing a link, and the live registry records the session as an
// `app-session` of the host. It sets the host's dialog and notice handlers,
// so extensions' questions are answered on the page. The server's Host,
// Origin and token checks hold unchanged. Without a host nothing changes.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const HOST_TOKEN = ["hosted", "session", "token"].join("-");
const OWN_TOKEN = ["own", "token"].join("-");
const OWNER_PID = 4242;
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function hostKey() {
  return (await importSource("extensions/ampi-core/gui-host.ts")).MMR_GUI_HOST_GLOBAL_KEY;
}

afterEach(async () => {
  delete globalThis[await hostKey()];
});

/** Register a session host the way `ampi app --worker` does; returns the ports it was told. */
async function registerHost(onReady = () => {}) {
  const ready = [];
  const record = (info) => {
    ready.push(info);
    onReady(info);
  };
  globalThis[await hostKey()] = { role: "session", token: HOST_TOKEN, ownerPid: OWNER_PID, ready: record };
  return ready;
}

/** ampi-core's live registry writer, then ampi-gui, on one stub Pi; timers run by hand. */
async function load(settings) {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "ampi-gui-hosted-")), "live");
  dirs.push(path.dirname(dir));
  const { registerMmrLiveRegistry } = await importSource("extensions/ampi-core/live-registry.ts");
  const { createMmrGuiExtension } = await importSource("extensions/ampi-gui/index.ts");
  const mock = createMockPi();
  const timers = [];
  const writer = registerMmrLiveRegistry(mock.pi, { dir, now: () => 0, setTimer: (callback) => timers.push(callback), clearTimer: () => {} });
  createMmrGuiExtension({ loadSettings: () => settings, registryDir: dir, createToken: () => OWN_TOKEN })(mock.pi);
  const ctx = createMockExtensionContext({ mode: "rpc", hasUI: false, cwd: "/work/app", sessionId: "s-1", sessionFile: "/sessions/s-1.jsonl" });
  const emit = (name, event) => mock.handlers.get(name)({ type: name, ...event }, ctx.ctx);
  const entry = async () => {
    for (const run of timers.splice(0)) run();
    await writer.idle();
    return JSON.parse(readFileSync(path.join(dir, `${process.pid}.json`), "utf8"));
  };
  return { dir, ctx, emit, entry };
}

/** A raw request with exactly the headers given (no default Host). */
function send(port, { method = "GET", target = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path: target, headers, setHost: false, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (res.headers["content-type"]?.startsWith("text/event-stream")) req.destroy();
        text += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
      res.on("close", () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

describe("ampi-gui in a hosted session", () => {
  it("serves RPC mode with the host's token and tells the host its port once, without a notice", async () => {
    const ready = await registerHost();
    const { ctx, emit } = await load({ enabled: true });
    await emit("session_start", { reason: "startup" });

    assert.equal(ready.length, 1);
    const { port } = ready[0];
    assert.ok(Number.isInteger(port) && port > 0);
    assert.deepEqual(ctx.notifications, [], "no Web GUI notice");
    const host = `127.0.0.1:${port}`;
    assert.equal((await send(port, { target: `/?t=${HOST_TOKEN}`, headers: { Host: host } })).status, 303);
    assert.equal((await send(port, { target: `/?t=${OWN_TOKEN}`, headers: { Host: host } })).status, 401, "the GUI's own token is not used");

    // A second session in the same worker serves again but does not report again.
    await emit("session_shutdown", { reason: "quit" });
    await emit("session_start", { reason: "startup" });
    assert.equal(ready.length, 1);
    await emit("session_shutdown", { reason: "quit" });
  });

  it("records the session as an app-session of the host, with the GUI's port, before it tells the host", async () => {
    let atReady;
    const ready = await registerHost(() => {
      atReady = JSON.parse(readFileSync(path.join(dir, `${process.pid}.json`), "utf8"));
    });
    const { dir, emit, entry } = await load({ enabled: true });
    await emit("session_start", { reason: "startup" });
    const tokenHash = createHash("sha256").update(HOST_TOKEN).digest("hex");
    assert.deepEqual(atReady?.gui, { port: ready[0].port, tokenHash }, "the entry has the GUI when ready fires");
    const recorded = await entry();
    assert.equal(recorded.kind, "app-session");
    assert.equal(recorded.ownerPid, OWNER_PID);
    assert.equal(recorded.sessionPath, "/sessions/s-1.jsonl");
    assert.deepEqual(recorded.gui, { port: ready[0].port, tokenHash });
    await emit("session_shutdown", { reason: "quit" });
  });

  it("starts when hosted although ampiGui.enabled is false", async () => {
    const ready = await registerHost();
    const { emit } = await load({ enabled: false });
    await emit("session_start", { reason: "startup" });
    assert.equal(ready.length, 1);
    assert.equal((await send(ready[0].port, { target: `/?t=${HOST_TOKEN}`, headers: { Host: `127.0.0.1:${ready[0].port}` } })).status, 303);
    await emit("session_shutdown", { reason: "quit" });
  });

  it("keeps the Host, Origin and token checks", async () => {
    const ready = await registerHost();
    const { emit } = await load({ enabled: true });
    await emit("session_start", { reason: "startup" });
    const { port } = ready[0];
    const host = { Host: `127.0.0.1:${port}` };
    const cookie = { Cookie: `ampi_gui_${port}=${HOST_TOKEN}` };
    const json = { "Content-Type": "application/json" };

    assert.equal((await send(port, { headers: { Host: "evil.example" } })).status, 403, "foreign Host");
    assert.equal((await send(port, { headers: { Host: `127.0.0.1:${port + 1}`, ...cookie } })).status, 403, "another port in Host");
    assert.equal((await send(port, { headers: {} })).status, 400, "no Host");
    assert.equal((await send(port, { headers: { ...host, ...cookie, Origin: "http://evil.example" } })).status, 403, "foreign Origin");
    assert.equal((await send(port, { headers: host })).status, 401, "no token");
    assert.equal((await send(port, { headers: { ...host, Cookie: `ampi_gui_${port}=${OWN_TOKEN}` } })).status, 401, "wrong token");
    const noOrigin = await send(port, { method: "POST", target: "/api/interrupt", headers: { ...host, ...cookie, ...json }, body: "{}" });
    assert.equal(noOrigin.status, 403, "a POST needs the server's Origin");

    const page = await send(port, { headers: { ...host, ...cookie } });
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"], /^text\/html/);
    assert.equal(page.headers["access-control-allow-origin"], undefined, "no CORS");
    const events = await send(port, { target: "/api/events", headers: { ...host, ...cookie } });
    assert.match(events.headers["content-type"], /^text\/event-stream/);
    const idle = await send(port, {
      method: "POST",
      target: "/api/interrupt",
      headers: { ...host, ...cookie, ...json, Origin: `http://127.0.0.1:${port}` },
      body: "{}",
    });
    assert.equal(idle.status, 409, "the command endpoint answers: nothing is running");
    await emit("session_shutdown", { reason: "quit" });
  });

  it("sets the host's dialog and notice handlers, which ask the page, and takes them back at shutdown", async () => {
    const ready = await registerHost();
    const { emit } = await load({ enabled: true });
    await emit("session_start", { reason: "startup" });
    const host = globalThis[await hostKey()];
    assert.equal(typeof host.dialog, "function");
    assert.equal(typeof host.notice, "function");

    const { port } = ready[0];
    const headers = { Host: `127.0.0.1:${port}`, Cookie: `ampi_gui_${port}=${HOST_TOKEN}` };
    const answer = host.dialog({ kind: "select", title: "Approval Required", options: ["Allow Once", "Reject"] }, {});
    host.notice("Saved", "info");
    const transcript = JSON.parse((await send(port, { target: "/api/transcript", headers })).body);
    assert.deepEqual(
      transcript.dialogs.map((dialog) => [dialog.id, dialog.kind, dialog.title]),
      [["dialog-1", "select", "Approval Required"]],
    );
    const posted = await send(port, {
      method: "POST",
      target: "/api/dialog",
      headers: { ...headers, "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ id: "dialog-1", value: "Reject" }),
    });
    assert.equal(posted.status, 200);
    assert.deepEqual(await answer, { value: "Reject" });

    // A question still open at shutdown is cancelled, and the worker answers later ones itself.
    const open = host.dialog({ kind: "confirm", title: "Continue?", message: "" }, {});
    await emit("session_shutdown", { reason: "quit" });
    assert.deepEqual(await open, { cancelled: true });
    assert.equal(host.dialog, undefined);
    assert.equal(host.notice, undefined);
  });

  it("closes the server and removes the entry at shutdown", async () => {
    const ready = await registerHost();
    const { dir, emit } = await load({ enabled: true });
    await emit("session_start", { reason: "startup" });
    await emit("session_shutdown", { reason: "quit" });
    await assert.rejects(send(ready[0].port, { headers: { Host: `127.0.0.1:${ready[0].port}` } }), { code: "ECONNREFUSED" });
    assert.deepEqual(readdirSync(dir), []);
  });
});

describe("ampi-gui in RPC mode without a host", () => {
  it("opens no port and the entry stays an execute run without a GUI", async () => {
    const { ctx, emit, entry } = await load({ enabled: true });
    await emit("session_start", { reason: "startup" });
    const recorded = await entry();
    assert.equal(recorded.kind, "execute");
    assert.equal(recorded.gui, null);
    assert.equal(recorded.ownerPid, undefined);
    assert.deepEqual(ctx.notifications, []);
    const { getMmrCommand } = await importSource("extensions/ampi-core/command-registry.ts");
    assert.equal(getMmrCommand("thread.openInBrowser"), undefined);
    await emit("session_shutdown", { reason: "quit" });
  });
});
