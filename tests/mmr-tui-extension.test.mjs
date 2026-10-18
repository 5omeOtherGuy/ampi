import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const repoRoot = path.resolve(import.meta.dirname, "..");

async function loadExtension(settings) {
  const { createMmrTuiExtension } = await importSource("extensions/ampi-tui/index.ts");
  const mock = createMockPi();
  createMmrTuiExtension({ loadSettings: () => settings })(mock.pi);
  return mock;
}

async function chromeOwner() {
  const { getMmrChromeOwner } = await importSource("extensions/ampi-core/chrome-owner.ts");
  return getMmrChromeOwner();
}

const startEvent = { type: "session_start", reason: "startup" };
const shutdownEvent = { type: "session_shutdown", reason: "quit" };

describe("ampi-tui extension", () => {
  afterEach(async () => {
    // Leave no owner behind for the next case (the seam is process-global).
    assert.equal(await chromeOwner(), undefined, "each case must release the chrome owner");
  });

  it("takes the chrome and removes the footer in an interactive terminal session", async () => {
    const { handlers } = await loadExtension({ enabled: true });
    const { ctx, footers, headers } = createMockExtensionContext({ hasUI: true });

    await handlers.get("session_start")(startEvent, ctx);

    assert.equal(await chromeOwner(), "ampi-tui");
    assert.equal(headers.length, 1, "the welcome header replaces Pi's");
    assert.equal(footers.length, 1);
    const footer = footers[0]();
    assert.deepEqual(footer.render(140), []);
    assert.deepEqual(footer.render(80), []);

    await handlers.get("session_shutdown")(shutdownEvent, ctx);
    assert.equal(await chromeOwner(), undefined);
  });

  it("registers once across repeated session starts and releases on one shutdown", async () => {
    const { handlers } = await loadExtension({ enabled: true });
    const { ctx, footers } = createMockExtensionContext({ hasUI: true });

    await handlers.get("session_start")(startEvent, ctx);
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    assert.equal(footers.length, 2, "each session start removes the footer again");

    await handlers.get("session_shutdown")(shutdownEvent, ctx);
    assert.equal(await chromeOwner(), undefined);
  });

  it("does nothing at all when disabled", async () => {
    const { handlers } = await loadExtension({ enabled: false });
    assert.deepEqual([...handlers.keys()], []);
    assert.equal(await chromeOwner(), undefined);
  });

  for (const [label, options] of [
    ["print or JSON (no UI)", { hasUI: false }],
    ["RPC (dialogs but no terminal)", { hasUI: true, mode: "rpc" }],
  ]) {
    it(`leaves ${label} sessions untouched`, async () => {
      const { handlers } = await loadExtension({ enabled: true });
      const { ctx, footers, headers, statuses, notifications } = createMockExtensionContext(options);

      await handlers.get("session_start")(startEvent, ctx);

      assert.equal(footers.length, 0);
      assert.equal(headers.length, 0);
      assert.equal(statuses.length, 0);
      assert.equal(notifications.length, 0);
      assert.equal(await chromeOwner(), undefined);
      await handlers.get("session_shutdown")(shutdownEvent, ctx);
    });
  }
});

describe("ampi-tui settings", () => {
  function withDirs(run) {
    const root = mkdtempSync(path.join(os.tmpdir(), "ampi-tui-settings-"));
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

  it("is on by default", async () => {
    const { loadMmrTuiSettings } = await importSource("extensions/ampi-tui/config.ts");
    await withDirs(({ home, cwd }) => {
      assert.deepEqual(loadMmrTuiSettings(cwd, { homeDirectory: home, env: {} }), { enabled: true, quietStartup: false });
    });
  });

  it("reads ampiTui.enabled globally, lets the project override it, and accepts nested ampi.tui", async () => {
    const { loadMmrTuiSettings } = await importSource("extensions/ampi-tui/config.ts");
    await withDirs(({ home, cwd, writeGlobal, writeProject }) => {
      const load = () => loadMmrTuiSettings(cwd, { homeDirectory: home, env: {} }).enabled;
      writeGlobal({ ampiTui: { enabled: false } });
      assert.equal(load(), false);
      writeProject({ ampi: { tui: { enabled: true } } });
      assert.equal(load(), true);
      writeProject({ ampiTui: { enabled: "no" } });
      assert.equal(load(), false, "a non-boolean value is ignored, so the global value stands");
    });
  });

  it("reads Pi's quietStartup, where only true silences the header and the project file wins", async () => {
    const { loadMmrTuiSettings } = await importSource("extensions/ampi-tui/config.ts");
    await withDirs(({ home, cwd, writeGlobal, writeProject }) => {
      const load = () => loadMmrTuiSettings(cwd, { homeDirectory: home, env: {} }).quietStartup;
      writeGlobal({ quietStartup: true });
      assert.equal(load(), true);
      writeProject({ quietStartup: "header" });
      assert.equal(load(), false, "\"header\" keeps Pi's header, so ampi's welcome shows too");
      writeProject({});
      assert.equal(load(), true, "a project file without the key keeps the global value");
    });
  });

  it("lets AMPI_TUI_ENABLE (legacy MMR_TUI_ENABLE) override settings files", async () => {
    const { loadMmrTuiSettings } = await importSource("extensions/ampi-tui/config.ts");
    await withDirs(({ home, cwd, writeGlobal }) => {
      writeGlobal({ ampiTui: { enabled: true } });
      const load = (env) => loadMmrTuiSettings(cwd, { homeDirectory: home, env }).enabled;
      assert.equal(load({ AMPI_TUI_ENABLE: "false" }), false);
      assert.equal(load({ MMR_TUI_ENABLE: "0" }), false);
      assert.equal(load({ AMPI_TUI_ENABLE: "true", MMR_TUI_ENABLE: "false" }), true);
    });
  });
});

describe("ampi-tui package wiring", () => {
  it("auto-loads after ampi-custom-subagents and before ampi-history, which stays last", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const order = pkg.pi.extensions;
    const tui = order.indexOf("./src/extensions/ampi-tui/index.ts");
    assert.equal(order[tui - 1], "./src/extensions/ampi-custom-subagents/index.ts");
    assert.equal(order[tui + 1], "./src/extensions/ampi-history/index.ts");
    assert.equal(order.at(-1), "./src/extensions/ampi-history/index.ts");
  });
});
