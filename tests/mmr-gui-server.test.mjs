// ampi-gui HTTP server: Host, Origin and token checks, the static file
// policy, the JSON endpoints, the composer's command endpoints and the event
// stream with reconnect replay. Everything runs against a real server on
// 127.0.0.1 with a random port; Pi is the test stub.

import assert from "node:assert/strict";
import { request } from "node:http";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

// A test token built from parts, so no token-shaped literal sits in the source.
const TOKEN = ["test", "token", "for", "the", "gui"].join("-");

let server;
let fire;
let port;
let mock;
let context;
let registry;
let promptQueue;

function send(options) {
  const { method = "GET", path: target = "/", headers = {}, body } = options;
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method, path: target, headers: { Host: `127.0.0.1:${port}`, ...headers }, setHost: false },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const cookie = () => ({ Cookie: `ampi_gui_${port}=${TOKEN}` });

/** Open an event stream and resolve with its text once `until` matches it. */
function stream(headers, until, trigger) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: headers.path ?? "/api/events", headers: { Host: `127.0.0.1:${port}`, ...cookie(), ...headers.headers }, setHost: false },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
          if (until(text)) {
            req.destroy();
            resolve({ status: res.statusCode, headers: res.headers, body: text });
          }
        });
        trigger?.();
      },
    );
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
      return { id: fields.id === undefined ? undefined : Number(fields.id), event: fields.event, data: JSON.parse(fields.data) };
    });
}

before(async () => {
  const { startMmrGuiServer } = await importSource("extensions/ampi-gui/server.ts");
  const { createMmrGuiBridge } = await importSource("extensions/ampi-gui/bridge.ts");
  const { createMmrGuiCommands } = await importSource("extensions/ampi-gui/commands.ts");
  registry = await importSource("extensions/ampi-core/command-registry.ts");
  promptQueue = await importSource("extensions/ampi-core/prompt-queue.ts");
  mock = createMockPi();
  context = createMockExtensionContext({ cwd: "/work/app", sessionId: "s-1", sessionName: "Server test" });
  const { ctx } = context;
  const bridge = createMmrGuiBridge(mock.pi, { replayLimit: 4 });
  bridge.start(ctx);
  fire = (name, event = { name }) => mock.handlers.get(name)({ type: name, ...event }, ctx);
  server = await startMmrGuiServer({
    bridge,
    commands: createMmrGuiCommands(mock.pi, bridge),
    token: TOKEN,
    clientDir: path.join(getPreparedSourceRoot(), "extensions/ampi-gui/client"),
  });
  port = server.port;
});

after(async () => {
  await server?.close();
});

describe("ampi-gui server: request policy", () => {
  it("listens on 127.0.0.1 and prints a URL with the token", () => {
    assert.ok(port > 0);
    assert.equal(server.url, `http://127.0.0.1:${port}/?t=${TOKEN}`);
  });

  it("refuses a missing or unexpected Host, which blocks DNS rebinding", async () => {
    assert.equal((await send({ headers: { Host: "" } })).status, 400);
    assert.equal((await send({ path: `/?t=${TOKEN}`, headers: { Host: `attacker.example:${port}` } })).status, 403);
    assert.equal((await send({ headers: { Host: `127.0.0.1:${port + 1}`, ...cookie() } })).status, 403);
    assert.equal((await send({ headers: { Host: "127.0.0.1", ...cookie() } })).status, 403);
    assert.equal((await send({ headers: { Host: `localhost:${port}`, ...cookie() } })).status, 200);
  });

  it("refuses a foreign Origin even with a valid cookie", async () => {
    const res = await send({ path: "/api/session", headers: { ...cookie(), Origin: "http://attacker.example" } });
    assert.equal(res.status, 403);
    const sibling = await send({ path: "/api/session", headers: { ...cookie(), Origin: `http://127.0.0.1:${port + 1}` } });
    assert.equal(sibling.status, 403, "another local port is another origin");
    const own = await send({ path: "/api/session", headers: { ...cookie(), Origin: `http://127.0.0.1:${port}` } });
    assert.equal(own.status, 200);
  });

  it("requires the token on every route", async () => {
    for (const target of ["/", "/api/session", "/api/transcript", "/api/events", "/client/app.js"]) {
      assert.equal((await send({ path: target })).status, 401, target);
      assert.equal((await send({ path: target, headers: { Cookie: `ampi_gui_${port}=wrong` } })).status, 401, target);
      assert.equal((await send({ path: target, headers: { Cookie: `ampi_gui_1=${TOKEN}` } })).status, 401, `${target}: another port's cookie`);
    }
    assert.equal((await send({ path: "/?t=wrong" })).status, 401);
    assert.equal((await send({ path: "/?t=" })).status, 401);
  });

  it("trades the URL token for an HttpOnly, SameSite=Strict cookie and drops it from the address", async () => {
    const res = await send({ path: `/?t=${encodeURIComponent(TOKEN)}` });
    assert.equal(res.status, 303);
    assert.equal(res.headers.location, "/");
    const [setCookie] = res.headers["set-cookie"];
    assert.equal(setCookie, `ampi_gui_${port}=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`);

    const page = await send({ headers: cookie() });
    assert.equal(page.status, 200);
    assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
    assert.match(page.body, /<main class="chat"/);
    assert.match(page.headers["content-security-policy"], /default-src 'none'; script-src 'self'/);
    assert.equal(page.headers["x-frame-options"], "DENY");
  });

  it("sets no CORS headers", async () => {
    const res = await send({ path: "/api/session", headers: { ...cookie(), Origin: `http://127.0.0.1:${port}` } });
    assert.deepEqual(
      Object.keys(res.headers).filter((name) => name.startsWith("access-control-")),
      [],
    );
  });
});

describe("ampi-gui server: static files", () => {
  it("serves client files with explicit content types", async () => {
    const js = await send({ path: "/client/app.js", headers: cookie() });
    assert.equal(js.status, 200);
    assert.equal(js.headers["content-type"], "text/javascript; charset=utf-8");
    const css = await send({ path: "/client/tokens.css", headers: cookie() });
    assert.equal(css.headers["content-type"], "text/css; charset=utf-8");
    assert.match(css.body, /--ampi-bg: light-dark\(/);
  });

  it("refuses paths that leave the client directory", async () => {
    for (const target of [
      "/client/../server.ts",
      "/client/%2e%2e/server.ts",
      "/client/..%2fserver.ts",
      "/client/..%5cserver.ts",
      "/client/%2fetc%2fpasswd",
      "/client/./app.js",
      "/client//app.js",
      "/client/app.js%00.css",
    ]) {
      const res = await send({ path: target, headers: cookie() });
      assert.equal(res.status, 400, target);
    }
  });

  it("answers 404 for missing files and unknown routes", async () => {
    assert.equal((await send({ path: "/client/missing.js", headers: cookie() })).status, 404);
    assert.equal((await send({ path: "/client/index", headers: cookie() })).status, 404, "no extension, no content type");
    assert.equal((await send({ path: "/server.ts", headers: cookie() })).status, 404);
  });
});

describe("ampi-gui server: API", () => {
  it("returns the session and the transcript snapshot as JSON", async () => {
    const session = await send({ path: "/api/session", headers: cookie() });
    assert.equal(session.headers["content-type"], "application/json; charset=utf-8");
    const info = JSON.parse(session.body);
    assert.equal(info.title, "Server test");
    assert.equal(info.cwd, "/work/app");
    assert.equal(info.status.phase, "idle");
    const transcript = JSON.parse((await send({ path: "/api/transcript", headers: cookie() })).body);
    assert.deepEqual(transcript.items, []);
    assert.equal(typeof transcript.lastEventId, "number");
  });

});

const ORIGIN = () => ({ Origin: `http://127.0.0.1:${port}` });
const JSON_TYPE = { "Content-Type": "application/json" };

/** POST `body` to `/api/<route>` with the cookie and the server's own Origin unless `headers` says otherwise. */
async function command(route, body = {}, headers = {}) {
  const res = await send({ method: "POST", path: `/api/${route}`, headers: { ...cookie(), ...ORIGIN(), ...JSON_TYPE, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  let json;
  try {
    json = JSON.parse(res.body);
  } catch {}
  return { status: res.status, json };
}

/** Make the stub session busy (a turn runs) or idle. */
function setBusy(busy) {
  context.state.idle = !busy;
  if (busy) fire("turn_start", {});
  else fire("agent_settled", {});
}

describe("ampi-gui server: command requests (CSRF policy)", () => {
  it("refuses a POST without the cookie, without an Origin or with a foreign Origin (403)", async () => {
    const body = { text: "hi" };
    assert.equal((await command("send", body, { Cookie: "" })).status, 403, "no cookie");
    assert.equal((await command("send", body, { Cookie: `ampi_gui_${port}=wrong` })).status, 403, "wrong token");
    assert.equal((await command("send", body, { Origin: "http://attacker.example" })).status, 403, "foreign Origin");
    assert.equal((await command("send", body, { Origin: `http://127.0.0.1:${port + 1}` })).status, 403, "another local port");
    const noOrigin = await send({ method: "POST", path: "/api/send", headers: { ...cookie(), ...JSON_TYPE }, body: JSON.stringify(body) });
    assert.equal(noOrigin.status, 403, "no Origin");
    assert.deepEqual(mock.calls.sendUserMessage, [], "nothing reached Pi");
  });

  it("takes only JSON on known routes", async () => {
    assert.equal((await command("send", { text: "hi" }, { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await command("send", "not json")).status, 400);
    assert.equal((await command("send", JSON.stringify({ text: "x".repeat(600 * 1024) }))).status, 400, "a body past the limit");
    for (const route of ["commands", "constructor", "__proto__", "send/x"]) assert.equal((await command(route)).status, 404, route);
    assert.equal((await send({ path: "/api/send", headers: cookie() })).status, 404, "commands are POST only");
    assert.equal((await send({ method: "PUT", path: "/api/send", headers: cookie() })).status, 405);
    assert.deepEqual(mock.calls.sendUserMessage, []);
  });
});

describe("ampi-gui server: composer commands", () => {
  it("sends a prompt while idle, and steers or queues while a turn runs", async () => {
    mock.calls.sendUserMessage.length = 0;
    const idle = await command("send", { text: "  review the parser  " });
    assert.equal(idle.status, 200);
    assert.equal(idle.json.delivered, "prompt");
    setBusy(true);
    assert.equal((await command("send", { text: "also the lexer" })).json.delivered, "steer", "steer is the default while busy");
    assert.equal((await command("send", { text: "then the docs", deliverAs: "followUp" })).json.delivered, "followUp");
    setBusy(false);
    assert.deepEqual(mock.calls.sendUserMessage, [
      { content: "review the parser", options: { deliverAs: "steer", expandPromptTemplates: true } },
      { content: "also the lexer", options: { deliverAs: "steer", expandPromptTemplates: true } },
      { content: "then the docs", options: { deliverAs: "followUp", expandPromptTemplates: true } },
    ]);
  });

  it("refuses an empty message, an unknown delivery and a send while Pi compacts", async () => {
    mock.calls.sendUserMessage.length = 0;
    assert.equal((await command("send", { text: "   " })).status, 400);
    assert.equal((await command("send", {})).status, 400);
    assert.equal((await command("send", { text: "hi", deliverAs: "nextTurn" })).status, 400);
    fire("session_before_compact", {});
    const compacting = await command("send", { text: "hi" });
    assert.equal(compacting.status, 409);
    assert.match(compacting.json.error, /compacting/);
    fire("session_compact", {});
    assert.deepEqual(mock.calls.sendUserMessage, []);
  });

  it("takes one queued message back through ampi-core's prompt queue", async () => {
    assert.equal((await command("dequeue", { kind: "followUp", index: 0, text: "later" })).status, 409, "no owner of the queue");
    const removed = [];
    const owner = promptQueue.registerMmrPromptQueue({
      remove: (kind, index, text) => {
        removed.push([kind, index, text]);
        return text === "later";
      },
    });
    try {
      owner.update({ steering: [], followUp: ["later"] });
      const transcript = JSON.parse((await send({ path: "/api/transcript", headers: cookie() })).body);
      assert.deepEqual(transcript.queue, { steering: [], followUp: ["later"] });
      const ok = await command("dequeue", { kind: "followUp", index: 0, text: "later" });
      assert.equal(ok.status, 200);
      assert.equal(ok.json.text, "later");
      assert.equal((await command("dequeue", { kind: "followUp", index: 0, text: "gone" })).status, 409);
      assert.equal((await command("dequeue", { kind: "other", index: 0, text: "later" })).status, 400);
      assert.equal((await command("dequeue", { kind: "followUp", index: -1, text: "later" })).status, 400);
      assert.deepEqual(removed, [
        ["followUp", 0, "later"],
        ["followUp", 0, "gone"],
      ]);
    } finally {
      owner.release();
    }
  });

  it("steers the next queued message through the terminal's command, with its reason when it cannot", async () => {
    assert.equal((await command("steer-next")).status, 409, "without the command");
    let reason = "no message is queued";
    let runs = 0;
    registry.registerMmrCommand({
      id: "prompt.steerQueuedMessage",
      noun: "prompt",
      verb: "steer queued message",
      description: "test",
      availability: () => (reason ? { state: "unavailable", reason } : { state: "available" }),
      run: () => {
        runs += 1;
      },
    });
    try {
      const refused = await command("steer-next");
      assert.equal(refused.status, 409);
      assert.equal(refused.json.error, "no message is queued");
      reason = undefined;
      assert.equal((await command("steer-next")).status, 200);
      assert.equal(runs, 1);
    } finally {
      registry.unregisterMmrCommand("prompt.steerQueuedMessage");
    }
  });

  it("interrupts a running turn, through the terminal's command when there is one", async () => {
    const before = context.lifecycle.abort;
    assert.equal((await command("interrupt")).status, 409, "nothing is running");
    setBusy(true);
    assert.equal((await command("interrupt")).status, 200);
    assert.equal(context.lifecycle.abort, before + 1, "ctx.abort() without ampi-tui");
    assert.equal(JSON.parse((await send({ path: "/api/session", headers: cookie() })).body).status.phase, "cancelling");
    let runs = 0;
    registry.registerMmrCommand({ id: "thread.interrupt", noun: "thread", verb: "interrupt", description: "test", run: () => (runs += 1) });
    try {
      assert.equal((await command("interrupt")).status, 200);
      assert.equal(runs, 1);
      assert.equal(context.lifecycle.abort, before + 1, "the command aborts, not the server");
    } finally {
      registry.unregisterMmrCommand("thread.interrupt");
      setBusy(false);
    }
  });
});

describe("ampi-gui server: event stream", () => {
  it("streams bridged events as text/event-stream", async () => {
    const res = await stream(
      { path: "/api/events" },
      (text) => text.includes("event: session"),
      () => fire("session_info_changed"),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "text/event-stream; charset=utf-8");
    const [event] = parseEvents(res.body);
    assert.equal(event.event, "session");
    assert.equal(event.data.id, "s-1");
  });

  it("replays what a reconnecting client missed, from Last-Event-ID", async () => {
    const start = JSON.parse((await send({ path: "/api/transcript", headers: cookie() })).body).lastEventId;
    fire("session_info_changed");
    fire("session_info_changed");
    const res = await stream({ headers: { "Last-Event-ID": String(start) } }, (text) => (text.match(/event: session/g) ?? []).length === 2);
    assert.deepEqual(
      parseEvents(res.body).map((event) => event.id),
      [start + 1, start + 2],
    );
    const viaQuery = await stream({ path: `/api/events?after=${start + 1}` }, (text) => text.includes("event: session"));
    assert.deepEqual(
      parseEvents(viaQuery.body).map((event) => event.id),
      [start + 2],
    );
  });

  it("tells a client that fell too far behind to reload the snapshot", async () => {
    for (let i = 0; i < 6; i++) fire("session_info_changed");
    const res = await stream({ headers: { "Last-Event-ID": "1" } }, (text) => text.includes("event: reset"));
    assert.equal(parseEvents(res.body)[0].event, "reset");
  });

  it("ends open streams when the server closes", async () => {
    const { startMmrGuiServer } = await importSource("extensions/ampi-gui/server.ts");
    const { createMmrGuiBridge } = await importSource("extensions/ampi-gui/bridge.ts");
    const { pi } = createMockPi();
    const bridge = createMmrGuiBridge(pi);
    const second = await startMmrGuiServer({
      bridge,
      commands: {},
      token: TOKEN,
      clientDir: path.join(getPreparedSourceRoot(), "extensions/ampi-gui/client"),
    });
    const ended = new Promise((resolve) => {
      request({ host: "127.0.0.1", port: second.port, path: "/api/events", headers: { Host: `127.0.0.1:${second.port}`, Cookie: `ampi_gui_${second.port}=${TOKEN}` }, setHost: false }, (res) => {
        res.resume();
        res.on("end", resolve);
        res.on("close", resolve);
        second.close();
      }).end();
    });
    await ended;
  });
});
