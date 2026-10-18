// ampi-gui extension: off by default, a no-op outside the interactive
// terminal, and in it a server, its port in ampi-core's live registry entry
// and the `thread.openInBrowser` command for the session's lifetime.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const repoRoot = path.resolve(import.meta.dirname, "..");
const TOKEN = ["extension", "test", "token"].join("-");
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "ampi-gui-ext-"));
  dirs.push(dir);
  return dir;
}

function get(port, target, headers = {}) {
  return new Promise((resolve, reject) => {
    // A new connection each time: a pooled keep-alive socket would outlive the server.
    request({ host: "127.0.0.1", port, path: target, headers, agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    })
      .on("error", reject)
      .end();
  });
}

/** Load ampi-gui, after ampi-core's live registry writer when `live` names its directory. */
async function load(overrides, live) {
  const { createMmrGuiExtension } = await importSource("extensions/ampi-gui/index.ts");
  const mock = createMockPi();
  if (live) {
    const { registerMmrLiveRegistry } = await importSource("extensions/ampi-core/live-registry.ts");
    // A clock that never moves and timers run by hand, so throttled writes need no waiting.
    live.timers = [];
    live.writer = registerMmrLiveRegistry(mock.pi, {
      dir: live.dir,
      now: () => 0,
      setTimer: (callback) => live.timers.push(callback),
      clearTimer: () => {},
    });
  }
  createMmrGuiExtension(overrides)(mock.pi);
  return mock;
}

describe("ampi-gui settings", () => {
  it("is off by default and follows ampiGui.enabled, then AMPI_GUI_ENABLE", async () => {
    const { loadMmrGuiSettings } = await importSource("extensions/ampi-gui/config.ts");
    const home = tempDir();
    const cwd = tempDir();
    assert.deepEqual(loadMmrGuiSettings(cwd, { homeDirectory: home, env: {} }), { enabled: false });

    mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
    writeFileSync(path.join(home, ".pi/agent/settings.json"), JSON.stringify({ ampiGui: { enabled: true } }));
    assert.equal(loadMmrGuiSettings(cwd, { homeDirectory: home, env: {} }).enabled, true);

    mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    writeFileSync(path.join(cwd, ".pi/settings.json"), JSON.stringify({ ampi: { gui: { enabled: false } } }));
    assert.equal(loadMmrGuiSettings(cwd, { homeDirectory: home, env: {} }).enabled, false, "the project file wins");

    assert.equal(loadMmrGuiSettings(cwd, { homeDirectory: home, env: { AMPI_GUI_ENABLE: "true" } }).enabled, true, "the variable wins");
    assert.equal(loadMmrGuiSettings(tempDir(), { homeDirectory: home, env: { AMPI_GUI_ENABLE: "0" } }).enabled, false);
    assert.equal(loadMmrGuiSettings(tempDir(), { homeDirectory: home, env: { AMPI_GUI_ENABLE: "" } }).enabled, true, "an empty variable is unset");
  });
});

describe("ampi-gui extension", () => {
  it("registers nothing when disabled", async () => {
    const { handlers, commands } = await load({ loadSettings: () => ({ enabled: false }) });
    assert.equal(handlers.size, 0);
    assert.equal(commands.size, 0);
  });

  it("opens no port outside the interactive terminal", async () => {
    const registryDir = path.join(tempDir(), "live");
    const { handlers } = await load({ loadSettings: () => ({ enabled: true }), registryDir, createToken: () => TOKEN });
    const { getMmrCommand } = await importSource("extensions/ampi-core/command-registry.ts");
    for (const mode of ["print", "json", "rpc"]) {
      const { ctx, notifications } = createMockExtensionContext({ mode, hasUI: mode === "rpc" });
      await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
      assert.deepEqual(notifications, [], mode);
    }
    assert.equal(getMmrCommand("thread.openInBrowser"), undefined);
    assert.throws(() => readdirSync(registryDir), { code: "ENOENT" });
  });

  it("serves the session in the terminal, adds its port to the live registry entry, and cleans up at shutdown", async () => {
    const registryDir = path.join(tempDir(), "live");
    const live = { dir: registryDir };
    const opened = [];
    let opener = true;
    const { handlers } = await load(
      {
        loadSettings: () => ({ enabled: true }),
        registryDir,
        createToken: () => TOKEN,
        openUrl: async (url) => {
          opened.push(url);
          return opener;
        },
      },
      live,
    );
    const { getMmrCommand } = await importSource("extensions/ampi-core/command-registry.ts");
    const { ctx, notifications } = createMockExtensionContext({ mode: "tui", cwd: "/work/app", sessionId: "s-1", sessionFile: "/sessions/s-1.jsonl" });
    await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);

    assert.equal(notifications.length, 1, "the URL is printed once");
    const match = /^Web GUI: (http:\/\/127\.0\.0\.1:(\d+)\/\?t=(.+))$/.exec(notifications[0].message);
    assert.ok(match, notifications[0].message);
    const [, url, portText, token] = match;
    const port = Number(portText);
    assert.equal(token, TOKEN);
    assert.equal(await get(port, `/?t=${TOKEN}`), 303);

    // Read before any throttled write runs: the entry names the GUI once session_start returns.
    const file = path.join(registryDir, `${process.pid}.json`);
    const recorded = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(recorded.gui, { port, tokenHash: createHash("sha256").update(TOKEN).digest("hex") });
    assert.equal(recorded.kind, "tui");
    assert.equal(recorded.sessionPath, "/sessions/s-1.jsonl");
    assert.equal(recorded.cwd, "/work/app");
    assert.equal(readFileSync(file, "utf8").includes(TOKEN), false, "the registry never holds the token");

    const command = getMmrCommand("thread.openInBrowser");
    assert.equal(command.noun, "thread");
    assert.equal(command.verb, "open in browser");
    await command.run(ctx);
    assert.deepEqual(opened, [url]);
    assert.equal(notifications.at(-1).message, `Opening the web GUI: ${url}`);
    opener = false;
    await command.run(ctx);
    assert.equal(notifications.at(-1).message, `Open this link in a browser: ${url}`, "no browser: show the link");

    await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx);
    await assert.rejects(get(port, "/"), { code: "ECONNREFUSED" });
    assert.deepEqual(readdirSync(registryDir), []);
    assert.equal(getMmrCommand("thread.openInBrowser"), undefined);
  });

  it("does not open the opener without a desktop", async () => {
    const { openMmrGuiUrl } = await importSource("extensions/ampi-gui/index.ts");
    assert.equal(await openMmrGuiUrl("http://127.0.0.1:1/", {}, "linux"), false);
    assert.equal(await openMmrGuiUrl("http://127.0.0.1:1/", { DISPLAY: ":9" }, "win32"), false);
  });
});

describe("ampi-gui package wiring", () => {
  it("auto-loads after ampi-threads and before ampi-history, which stays last", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const order = pkg.pi.extensions;
    const gui = order.indexOf("./src/extensions/ampi-gui/index.ts");
    assert.equal(order[gui - 1], "./src/extensions/ampi-threads/index.ts");
    assert.equal(order[gui + 1], "./src/extensions/ampi-history/index.ts");
    assert.equal(order.at(-1), "./src/extensions/ampi-history/index.ts");
    assert.equal(pkg.exports["./extensions/ampi-gui"], "./src/extensions/ampi-gui/index.ts");
    assert.equal(pkg.exports["./extensions/mmr-gui"], "./src/extensions/ampi-gui/index.ts");
  });
});
