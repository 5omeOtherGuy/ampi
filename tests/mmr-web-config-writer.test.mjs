import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

function setupTempEnv() {
  const root = mkdtempSync(path.join(tmpdir(), "ampi-web-writer-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
  mkdirSync(path.join(project, ".pi"), { recursive: true });
  return {
    root,
    home,
    project,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("mmr-web config-writer", () => {
  it("applies a single-field update on a clean slate (flat ampiWeb layout)", async () => {
    const { applyMmrWebConfigUpdate } = await importSource("extensions/ampi-web/config-writer.ts");
    const next = applyMmrWebConfigUpdate({}, { enabled: true });
    assert.deepEqual(next, { ampiWeb: { enabled: true } });
  });

  it("preserves unrelated top-level keys (mmrCore) and unrelated mmrWeb fields", async () => {
    const { applyMmrWebConfigUpdate } = await importSource("extensions/ampi-web/config-writer.ts");
    const existing = {
      mmrCore: { defaultMode: "high" },
      mmrWeb: { enabled: true, maxResultBytes: 12345 },
    };
    const next = applyMmrWebConfigUpdate(existing, { backend: "brave" });
    assert.deepEqual(next.mmrCore, { defaultMode: "high" });
    assert.deepEqual(next.mmrWeb, { enabled: true, maxResultBytes: 12345, backend: "brave" });
    // Input is not mutated.
    assert.deepEqual(existing.mmrWeb, { enabled: true, maxResultBytes: 12345 });
  });

  it("supports the nested mmr.web layout and keeps it nested if that's how the file is shaped", async () => {
    const { applyMmrWebConfigUpdate } = await importSource("extensions/ampi-web/config-writer.ts");
    const existing = {
      mmr: { core: { defaultMode: "high" }, web: { enabled: true } },
    };
    const next = applyMmrWebConfigUpdate(existing, { searchBackend: "brave" });
    assert.deepEqual(next.mmr.core, { defaultMode: "high" });
    assert.deepEqual(next.mmr.web, { enabled: true, searchBackend: "brave" });
    assert.equal(next.mmrWeb, undefined, "must not invent a flat block when nested layout was in use");
  });

  it("clears a field by passing 'clear' (string sentinel)", async () => {
    const { applyMmrWebConfigUpdate } = await importSource("extensions/ampi-web/config-writer.ts");
    const existing = {
      mmrWeb: { enabled: true, backend: "brave", searchBackend: "brave" },
    };
    const next = applyMmrWebConfigUpdate(existing, { searchBackend: "clear" });
    assert.deepEqual(next.mmrWeb, { enabled: true, backend: "brave" });
  });

  it("drops the mmrWeb block entirely when the last field is cleared", async () => {
    const { applyMmrWebConfigUpdate } = await importSource("extensions/ampi-web/config-writer.ts");
    const existing = {
      mmrCore: { defaultMode: "high" },
      mmrWeb: { backend: "brave" },
    };
    const next = applyMmrWebConfigUpdate(existing, { backend: "clear" });
    assert.deepEqual(next, { mmrCore: { defaultMode: "high" } });
    assert.equal("mmrWeb" in next, false);
  });

  it("does the same drop in the nested mmr.web layout (and drops mmr entirely if no other branches)", async () => {
    const { applyMmrWebConfigUpdate } = await importSource("extensions/ampi-web/config-writer.ts");
    const existing = { mmr: { web: { backend: "brave" } } };
    const next = applyMmrWebConfigUpdate(existing, { backend: "clear" });
    assert.deepEqual(next, {});
  });

  it("accepts every public field name (enabled, backend, searchBackend, readerBackend, searchTimeoutMs, readTimeoutMs, maxResultBytes)", async () => {
    const { applyMmrWebConfigUpdate } = await importSource("extensions/ampi-web/config-writer.ts");
    const next = applyMmrWebConfigUpdate({}, {
      enabled: true,
      backend: "auto",
      searchBackend: "brave",
      readerBackend: "brave",
      searchTimeoutMs: 5000,
      readTimeoutMs: 12345,
      maxResultBytes: 999999,
    });
    assert.deepEqual(next.ampiWeb, {
      enabled: true,
      backend: "auto",
      searchBackend: "brave",
      readerBackend: "brave",
      searchTimeoutMs: 5000,
      readTimeoutMs: 12345,
      maxResultBytes: 999999,
    });
  });

  it("writeMmrWebConfigFile creates the file and round-trips through loadMmrWebSettings", async () => {
    const { writeMmrWebConfigFile } = await importSource("extensions/ampi-web/config-writer.ts");
    const { loadMmrWebSettings } = await importSource("extensions/ampi-web/config.ts");
    const env = setupTempEnv();
    try {
      const filePath = path.join(env.project, ".pi/settings.json");
      writeMmrWebConfigFile(filePath, {
        enabled: true,
        backend: "brave",
        searchBackend: "brave",
      });
      const result = loadMmrWebSettings(env.project, { homeDirectory: env.home, env: {} });
      assert.equal(result.settings.enabled, true);
      assert.equal(result.settings.backend, "brave");
      assert.equal(result.settings.searchBackend, "brave");
      assert.equal(result.settings.readerBackend, undefined);
    } finally {
      env.cleanup();
    }
  });

  it("writeMmrWebConfigFile refuses to overwrite a settings file whose contents are not valid JSON", async () => {
    const { writeMmrWebConfigFile } = await importSource("extensions/ampi-web/config-writer.ts");
    const env = setupTempEnv();
    try {
      const filePath = path.join(env.project, ".pi/settings.json");
      writeFileSync(filePath, "{ not valid json");
      assert.throws(
        () => writeMmrWebConfigFile(filePath, { enabled: true }),
        /Refusing to overwrite/,
      );
      // File contents unchanged.
      assert.equal(readFileSync(filePath, "utf8"), "{ not valid json");
    } finally {
      env.cleanup();
    }
  });

  it("does not write API-key fields even if they were somehow set in the update payload", async () => {
    // Defense in depth: the writer's typed signature does not accept these
    // fields, but a callsite that hand-builds an unknown object should not
    // accidentally persist secrets to .pi/settings.json.
    const { applyMmrWebConfigUpdate } = await importSource("extensions/ampi-web/config-writer.ts");
    const next = applyMmrWebConfigUpdate({}, /** @type {any} */ ({
      jinaApiKey: "leaked-jina",
      braveApiKey: "leaked-brave",
      enabled: true,
    }));
    assert.equal(next.ampiWeb?.jinaApiKey, undefined);
    assert.equal(next.ampiWeb?.braveApiKey, undefined);
    assert.equal(next.ampiWeb?.enabled, true);
  });

  it("runMmrWebConfigFlow refuses to run without an interactive UI", async () => {
    const { runMmrWebConfigFlow } = await importSource("extensions/ampi-web/config-flow.ts");
    const notifications = [];
    await runMmrWebConfigFlow({
      cwd: process.cwd(),
      hasUI: false,
      ui: {
        select: async () => { throw new Error("select must not be called without UI"); },
        input: async () => { throw new Error("input must not be called without UI"); },
        confirm: async () => { throw new Error("confirm must not be called without UI"); },
        notify: (message, level) => { notifications.push({ message, level }); },
      },
    });
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].message, /requires an interactive UI/);
    assert.equal(notifications[0].level, "warning");
  });

  it("runMmrWebConfigFlow hides readerBackend because read_web_page always uses the custom reader", async () => {
    const { runMmrWebConfigFlow } = await importSource("extensions/ampi-web/config-flow.ts");
    const optionsSeen = [];
    await runMmrWebConfigFlow({
      cwd: process.cwd(),
      hasUI: true,
      ui: {
        select: async (_title, options) => {
          optionsSeen.push(...options);
          return "— cancel —";
        },
        input: async () => undefined,
        confirm: async () => false,
        notify: () => {},
      },
    });
    assert.ok(optionsSeen.length > 0, "expected the web config menu options to be shown");
    assert.equal(optionsSeen.some((option) => String(option).startsWith("readerBackend")), false);
  });

  it("runMmrWebConfigFlow tells users every saved change requires a Pi restart", async () => {
    const { runMmrWebConfigFlow } = await importSource("extensions/ampi-web/config-flow.ts");
    const env = setupTempEnv();
    const notifications = [];
    try {
      await runMmrWebConfigFlow({
        cwd: env.project,
        hasUI: true,
        ui: {
          select: async (title) => title.includes("what do you want to set")
            ? "enabled (network master switch)"
            : "true (enable)",
          input: async () => undefined,
          confirm: async () => false,
          notify: (message, level) => { notifications.push({ message, level }); },
        },
      });
      const saved = notifications.find((n) => /Saved ampi-web config/.test(n.message));
      assert.ok(saved, `expected a saved notification, got ${JSON.stringify(notifications)}`);
      assert.match(saved.message, /Restart Pi/i);
      assert.doesNotMatch(saved.message, /next tool call/i);
    } finally {
      env.cleanup();
    }
  });

  it("/mmr-config offers a 'web' branch that dispatches to runMmrWebConfigFlow", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    // mmr-core no longer imports the web flow; loading mmr-web registers its
    // `web` section into the core /mmr-config registry (as it does at runtime).
    await importSource("extensions/ampi-web/index.ts");
    const commands = new Map();
    const pi = {
      registerFlag: () => {},
      getFlag: () => undefined,
      getActiveTools: () => [],
      getAllTools: () => [],
      setActiveTools: () => {},
      setModel: async () => true,
      setThinkingLevel: () => {},
      appendEntry: () => {},
      registerCommand: (name, command) => commands.set(name, command),
      registerShortcut: () => {},
      on: () => {},
      events: { emit: () => {}, on: () => {}, off: () => {} },
    };
    extension(pi);

    assert.ok(commands.has("mmr-config"), `expected /mmr-config to be registered, got ${[...commands.keys()].join(", ")}`);
    const descriptor = commands.get("mmr-config");
    assert.match(descriptor.description, /ampi-web/i, "description should mention ampi-web after the merge");

    // Drive the command: top-level select returns 'web' → must dispatch into
    // runMmrWebConfigFlow, which then issues its own select titled
    // "ampi-web config: what do you want to set?".
    const selectTitles = [];
    const notifications = [];
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      ui: {
        select: async (title, _options) => {
          selectTitles.push(title);
          if (selectTitles.length === 1) return "web";
          return undefined; // cancel the sub-flow
        },
        input: async () => undefined,
        confirm: async () => false,
        notify: (message, level) => { notifications.push({ message, level }); },
        setStatus: () => {},
        theme: { fg: (_color, value) => value },
      },
    };
    await descriptor.handler("", ctx);
    assert.ok(selectTitles.length >= 2, `expected /mmr-config to dispatch into the web flow (>=2 selects), got ${selectTitles.length}`);
    assert.match(selectTitles[1], /ampi-web config/i, `expected web flow's select title, got ${JSON.stringify(selectTitles[1])}`);
  });

  it("rejects out-of-range numeric updates (non-positive integers)", async () => {
    const { applyMmrWebConfigUpdate } = await importSource("extensions/ampi-web/config-writer.ts");
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      assert.throws(
        () => applyMmrWebConfigUpdate({}, { searchTimeoutMs: bad }),
        new RegExp(`searchTimeoutMs`),
      );
    }
  });

  it("writes a valid searxngUrl (http(s) only)", async () => {
    const { applyMmrWebConfigUpdate } = await importSource("extensions/ampi-web/config-writer.ts");
    const next = applyMmrWebConfigUpdate({}, { searxngUrl: "http://127.0.0.1:8080" });
    assert.deepEqual(next.ampiWeb, { searxngUrl: "http://127.0.0.1:8080" });
  });

  it("clears searxngUrl via the \"clear\" sentinel", async () => {
    const { applyMmrWebConfigUpdate } = await importSource("extensions/ampi-web/config-writer.ts");
    const existing = { mmrWeb: { enabled: true, searxngUrl: "http://127.0.0.1:8080" } };
    const next = applyMmrWebConfigUpdate(existing, { searxngUrl: "clear" });
    assert.deepEqual(next.mmrWeb, { enabled: true });
  });

  it("rejects non-http(s) searxngUrl values", async () => {
    const { applyMmrWebConfigUpdate } = await importSource("extensions/ampi-web/config-writer.ts");
    for (const bad of ["file:///tmp/x", "javascript:alert(1)", "ftp://example.com/"]) {
      assert.throws(
        () => applyMmrWebConfigUpdate({}, { searxngUrl: bad }),
        /searxngUrl/,
      );
    }
  });

  it("rejects non-string searxngUrl values", async () => {
    const { applyMmrWebConfigUpdate } = await importSource("extensions/ampi-web/config-writer.ts");
    for (const bad of ["", "   ", "not a url", null, 42, true]) {
      assert.throws(
        () => applyMmrWebConfigUpdate({}, { searxngUrl: bad }),
        /searxngUrl/,
      );
    }
  });

  it("accepts searchBackend=searxng (new backend value)", async () => {
    const { applyMmrWebConfigUpdate } = await importSource("extensions/ampi-web/config-writer.ts");
    const next = applyMmrWebConfigUpdate({}, { searchBackend: "searxng" });
    assert.deepEqual(next.ampiWeb, { searchBackend: "searxng" });
  });

  it("writes searxngManaged (boolean)", async () => {
    const { applyMmrWebConfigUpdate } = await importSource("extensions/ampi-web/config-writer.ts");
    const next = applyMmrWebConfigUpdate({}, { searxngManaged: true });
    assert.deepEqual(next.ampiWeb, { searxngManaged: true });
  });

  it("clears searxngManaged via the \"clear\" sentinel", async () => {
    const { applyMmrWebConfigUpdate } = await importSource("extensions/ampi-web/config-writer.ts");
    const existing = { mmrWeb: { enabled: true, searxngManaged: true } };
    const next = applyMmrWebConfigUpdate(existing, { searxngManaged: "clear" });
    assert.deepEqual(next.mmrWeb, { enabled: true });
  });

  it("writes a valid searxngHealthUrl", async () => {
    const { applyMmrWebConfigUpdate } = await importSource("extensions/ampi-web/config-writer.ts");
    const next = applyMmrWebConfigUpdate({}, { searxngHealthUrl: "http://127.0.0.1:8080/healthz" });
    assert.deepEqual(next.ampiWeb, { searxngHealthUrl: "http://127.0.0.1:8080/healthz" });
  });

  it("rejects non-http(s) searxngHealthUrl values", async () => {
    const { applyMmrWebConfigUpdate } = await importSource("extensions/ampi-web/config-writer.ts");
    for (const bad of ["file:///tmp/x", "javascript:alert(1)", "ftp://example.com/"]) {
      assert.throws(
        () => applyMmrWebConfigUpdate({}, { searxngHealthUrl: bad }),
        /searxngHealthUrl/,
      );
    }
  });

  it("writes searxngIdleTimeoutMs and searxngStartTimeoutMs", async () => {
    const { applyMmrWebConfigUpdate } = await importSource("extensions/ampi-web/config-writer.ts");
    const next = applyMmrWebConfigUpdate({}, {
      searxngIdleTimeoutMs: 60_000,
      searxngStartTimeoutMs: 45_000,
    });
    assert.deepEqual(next.ampiWeb, {
      searxngIdleTimeoutMs: 60_000,
      searxngStartTimeoutMs: 45_000,
    });
  });

  it("allows searxngIdleTimeoutMs=0 to disable idle-stop", async () => {
    const { applyMmrWebConfigUpdate } = await importSource("extensions/ampi-web/config-writer.ts");
    const next = applyMmrWebConfigUpdate({}, { searxngIdleTimeoutMs: 0 });
    assert.deepEqual(next.ampiWeb, { searxngIdleTimeoutMs: 0 });
  });

  it("rejects zero/negative/non-integer values for sidecar timers", async () => {
    const { applyMmrWebConfigUpdate } = await importSource("extensions/ampi-web/config-writer.ts");
    for (const bad of [0, -1, 1.5, "30000", null]) {
      assert.throws(
        () => applyMmrWebConfigUpdate({}, { searxngStartTimeoutMs: bad }),
        /searxngStartTimeoutMs/,
      );
    }
  });

  it("intentionally does NOT accept searxngStartCommand or searxngStopCommand (settings-file only)", async () => {
    const { applyMmrWebConfigUpdate } = await importSource("extensions/ampi-web/config-writer.ts");
    // The MmrWebConfigUpdate TS surface excludes these fields. Any caller
    // that smuggles them in via a cast must be ignored — the FIELD_SPECS
    // table is the gating layer and does not list them.
    const next = applyMmrWebConfigUpdate({ mmrWeb: { searxngManaged: true } }, /** @type {any} */ ({
      searxngStartCommand: ["rm", "-rf", "/"],
      searxngStopCommand: ["shutdown", "-h", "now"],
    }));
    // Existing mmrWeb block is preserved; the smuggled fields do not land.
    assert.deepEqual(next.mmrWeb, { searxngManaged: true });
    assert.equal(next.mmrWeb.searxngStartCommand, undefined);
    assert.equal(next.mmrWeb.searxngStopCommand, undefined);
  });
});
