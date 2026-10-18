// ampi-gui HTTP server: Host, Origin and token checks, the static file
// policy, the JSON endpoints and the event stream with reconnect replay.
// Everything runs against a real server on 127.0.0.1 with a random port.

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
  const { pi, handlers } = createMockPi();
  const { ctx } = createMockExtensionContext({ cwd: "/work/app", sessionId: "s-1", sessionName: "Server test" });
  const bridge = createMmrGuiBridge(pi, { replayLimit: 4 });
  bridge.start(ctx);
  fire = (name) => handlers.get(name)({ type: name, name }, ctx);
  server = await startMmrGuiServer({
    bridge,
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

  it("reserves POST endpoints: same-origin JSON only, and not implemented yet", async () => {
    const origin = { Origin: `http://127.0.0.1:${port}` };
    const json = { "Content-Type": "application/json" };
    const body = JSON.stringify({ text: "hi" });
    assert.equal((await send({ method: "POST", path: "/api/commands", headers: { ...cookie(), ...json }, body })).status, 403, "no Origin");
    assert.equal((await send({ method: "POST", path: "/api/commands", headers: { ...cookie(), ...origin, "Content-Type": "text/plain" }, body })).status, 415);
    assert.equal((await send({ method: "POST", path: "/api/commands", headers: { ...origin, ...json }, body })).status, 401, "no token");
    const res = await send({ method: "POST", path: "/api/commands", headers: { ...cookie(), ...origin, ...json }, body });
    assert.equal(res.status, 501);
    assert.equal((await send({ method: "PUT", path: "/api/commands", headers: cookie() })).status, 405);
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
    const second = await startMmrGuiServer({
      bridge: createMmrGuiBridge(pi),
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
