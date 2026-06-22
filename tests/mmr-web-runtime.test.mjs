import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

function settings(partial = {}) {
  return {
    enabled: false,
    backend: "auto",
    searchBackend: undefined,
    readerBackend: undefined,
    braveApiKey: undefined,
    searchTimeoutMs: 30000,
    readTimeoutMs: 30000,
    maxResultBytes: 200000,
    ...partial,
  };
}

function makePi() {
  const tools = [];
  const handlers = new Map();
  return {
    tools,
    handlers,
    pi: {
      registerTool: (definition) => tools.push(definition),
      on: (name, handler) => handlers.set(name, handler),
    },
  };
}

async function importRuntime() {
  const url = pathToFileURL(path.join(getPreparedSourceRoot(), "extensions/mmr-core/runtime.ts")).href;
  return import(url);
}

async function importCacheIsolatedRuntime() {
  return importSource("extensions/mmr-core/runtime.ts");
}

const LOCKED_MODES_THAT_REQUEST_WEB_TOOLS = ["smart", "rush", "test", "large", "deep"];

describe("mmr-web covers every locked mode that requests web_search / read_web_page", () => {
  for (const mode of LOCKED_MODES_THAT_REQUEST_WEB_TOOLS) {
    it(`${mode}: enabled + BRAVE_API_KEY -> web_search and read_web_page both active under mmr-web`, async () => {
      const { createMmrWebExtension } = await importSource("extensions/mmr-web/index.ts");
      const runtime = await importRuntime();
      const { pi } = makePi();
      createMmrWebExtension({ loadSettings: () => settings({ enabled: true, braveApiKey: "brv" }) })(pi);

      const resolved = runtime.resolveMmrTools(mode, [
        "read", "bash", "edit", "write", "grep", "find", "glob", "shell_command",
        "web_search", "read_web_page",
      ]);
      const search = resolved.decisions.find((d) => d.requested === "web_search");
      const reader = resolved.decisions.find((d) => d.requested === "read_web_page");
      assert.equal(search?.status, "active", `web_search must be active in ${mode}`);
      assert.equal(search?.owner, "mmr-web");
      assert.equal(reader?.status, "active", `read_web_page must be active in ${mode}`);
      assert.equal(reader?.owner, "mmr-web");
      assert.equal(resolved.activeTools.includes("web_search"), true);
      assert.equal(resolved.activeTools.includes("read_web_page"), true);
    });

    it(`${mode}: enabled without API key -> both tools active and owned by mmr-web`, async () => {
      const { createMmrWebExtension } = await importSource("extensions/mmr-web/index.ts");
      const runtime = await importRuntime();
      const { pi } = makePi();
      createMmrWebExtension({ loadSettings: () => settings({ enabled: true }) })(pi);

      const resolved = runtime.resolveMmrTools(mode, [
        "read", "bash", "edit", "write", "grep", "find", "glob", "shell_command",
        "web_search", "read_web_page",
      ]);
      const search = resolved.decisions.find((d) => d.requested === "web_search");
      const reader = resolved.decisions.find((d) => d.requested === "read_web_page");
      assert.equal(search?.status, "active", `web_search must stay active in ${mode} so execution can report BRAVE_API_KEY setup`);
      assert.equal(search?.owner, "mmr-web");
      assert.equal(reader?.status, "active");
      assert.equal(reader?.owner, "mmr-web");
    });

    it(`${mode}: network disabled -> both web tools gated under mmr-web`, async () => {
      const { createMmrWebExtension } = await importSource("extensions/mmr-web/index.ts");
      const runtime = await importRuntime();
      const { pi } = makePi();
      createMmrWebExtension({ loadSettings: () => settings({ enabled: false }) })(pi);

      const resolved = runtime.resolveMmrTools(mode, [
        "read", "bash", "edit", "write", "grep", "find", "glob", "shell_command",
      ]);
      const search = resolved.decisions.find((d) => d.requested === "web_search");
      const reader = resolved.decisions.find((d) => d.requested === "read_web_page");
      assert.equal(search?.status, "gated");
      assert.equal(search?.owner, "mmr-web");
      assert.equal(reader?.status, "gated");
      assert.equal(reader?.owner, "mmr-web");
    });
  }
});

describe("mmr-web registration across cache-isolated extension entrypoints", () => {
  it("shares mmr-web provider registrations with a separately imported mmr-core runtime", async () => {
    const { createMmrWebExtension } = await importSource("extensions/mmr-web/index.ts");
    const runtime = await importCacheIsolatedRuntime();
    const { pi, tools } = makePi();

    createMmrWebExtension({ loadSettings: () => settings({ enabled: false }) })(pi);

    assert.equal(tools.length, 0, "disabled mmr-web must not register concrete network tools");
    const resolved = runtime.resolveMmrTools("deep", ["read", "bash", "edit", "write", "apply_patch"]);
    const search = resolved.decisions.find((d) => d.requested === "web_search");
    const reader = resolved.decisions.find((d) => d.requested === "read_web_page");
    assert.equal(search.status, "gated");
    assert.equal(search.owner, "mmr-web");
    assert.match(search.diagnostic, /MMR_WEB_ENABLE=true/);
    assert.equal(reader.status, "gated");
    assert.equal(reader.owner, "mmr-web");
    assert.deepEqual(resolved.gatedTools.filter((tool) => tool === "web_search" || tool === "read_web_page").sort(), [
      "read_web_page",
      "web_search",
    ]);

    const [gate] = runtime.resolveMmrFeatureGates(["mmr-web"]);
    assert.equal(gate.status, "disabled");
    assert.equal(gate.source, "mmr-web");
  });

  it("activates configured web tools through a separately imported mmr-core runtime", async () => {
    const { createMmrWebExtension } = await importSource("extensions/mmr-web/index.ts");
    const runtime = await importCacheIsolatedRuntime();
    const { pi, tools } = makePi();

    createMmrWebExtension({ loadSettings: () => settings({ enabled: true, braveApiKey: "brv" }) })(pi);

    const availableTools = ["read", "bash", "edit", "write", "apply_patch", ...tools.map((tool) => tool.name)];
    const resolved = runtime.resolveMmrTools("deep", availableTools);
    assert.equal(resolved.deferredTools.includes("web_search"), false);
    assert.equal(resolved.deferredTools.includes("read_web_page"), false);
    assert.equal(resolved.activeTools.includes("web_search"), true);
    assert.equal(resolved.activeTools.includes("read_web_page"), true);

    const [gate] = runtime.resolveMmrFeatureGates(["mmr-web"]);
    assert.equal(gate.status, "enabled");
    assert.equal(gate.source, "mmr-web");
  });

  it("keeps both tools active across cache isolation when only the key is missing", async () => {
    const { createMmrWebExtension } = await importSource("extensions/mmr-web/index.ts");
    const runtime = await importCacheIsolatedRuntime();
    const { pi, tools } = makePi();

    createMmrWebExtension({ loadSettings: () => settings({ enabled: true }) })(pi);

    const availableTools = ["read", "bash", "edit", "write", "apply_patch", ...tools.map((tool) => tool.name)];
    const resolved = runtime.resolveMmrTools("deep", availableTools);
    const search = resolved.decisions.find((d) => d.requested === "web_search");
    const reader = resolved.decisions.find((d) => d.requested === "read_web_page");
    assert.equal(search.status, "active");
    assert.equal(search.chosen, "web_search");
    assert.equal(reader.status, "active");
    assert.equal(reader.chosen, "read_web_page");

    const [gate] = runtime.resolveMmrFeatureGates(["mmr-web"]);
    assert.equal(gate.status, "enabled");
    assert.equal(gate.source, "mmr-web");
    assert.match(gate.reason, /BRAVE_API_KEY/);
  });
});

describe("mmr-web extension factory", () => {
  it("registers a tool provider that overrides mmr-core's deferred web tools", async () => {
    const { createMmrWebExtension } = await importSource("extensions/mmr-web/index.ts");
    const runtime = await importRuntime();
    const { pi } = makePi();

    let current = settings({ enabled: true, braveApiKey: "free-key" });
    const factory = createMmrWebExtension({ loadSettings: () => current });
    factory(pi);

    const resolved = runtime.resolveMmrTools("smart", ["read", "bash", "edit", "write", "web_search", "read_web_page"]);
    assert.equal(resolved.activeTools.includes("web_search"), true);
    assert.equal(resolved.activeTools.includes("read_web_page"), true);
    const decision = resolved.decisions.find((d) => d.requested === "web_search");
    assert.equal(decision.owner, "mmr-web");
    assert.equal(decision.status, "active");
  });

  it("emits gated decisions when network is disabled", async () => {
    const { createMmrWebExtension } = await importSource("extensions/mmr-web/index.ts");
    const runtime = await importRuntime();
    const { pi, tools } = makePi();

    const factory = createMmrWebExtension({ loadSettings: () => settings({ enabled: false }) });
    factory(pi);

    assert.equal(tools.length, 0, "no Pi tools registered when disabled");
    const resolved = runtime.resolveMmrTools("smart", ["read", "bash", "edit", "write"]);
    const search = resolved.decisions.find((d) => d.requested === "web_search");
    const reader = resolved.decisions.find((d) => d.requested === "read_web_page");
    assert.equal(search.status, "gated");
    assert.equal(search.owner, "mmr-web");
    assert.equal(reader.status, "gated");
    assert.equal(reader.owner, "mmr-web");
    assert.equal(resolved.gatedTools.includes("web_search"), true);
    assert.equal(resolved.gatedTools.includes("read_web_page"), true);
  });

  it("session_start does NOT reload settings (one-shot to keep gate in sync with registered tools)", async () => {
    const { createMmrWebExtension } = await importSource("extensions/mmr-web/index.ts");
    const { pi, handlers } = makePi();

    let calls = 0;
    const factory = createMmrWebExtension({
      loadSettings: () => {
        calls += 1;
        return settings({ enabled: false });
      },
    });
    factory(pi);
    assert.equal(calls, 1, "settings are loaded exactly once at extension init");

    const handler = handlers.get("session_start");
    assert.equal(typeof handler, "function");
    await handler({}, { cwd: process.cwd(), ui: { notify: () => {} } });
    await handler({}, { cwd: process.cwd(), ui: { notify: () => {} } });
    assert.equal(calls, 1, "session_start must not re-invoke loadSettings; reload requires a Pi restart");
  });

  it("session_start drains initial-load warnings exactly once and never again", async () => {
    const { createMmrWebExtension } = await importSource("extensions/mmr-web/index.ts");
    const { pi, handlers } = makePi();

    const factory = createMmrWebExtension({
      loadSettings: () => ({
        settings: settings({ enabled: false }),
        warnings: ["first warning", "second warning"],
      }),
    });
    factory(pi);

    const handler = handlers.get("session_start");
    const captured = [];
    const ui = { notify: (msg, level) => captured.push({ msg, level }) };

    await handler({}, { cwd: process.cwd(), ui });
    assert.deepEqual(captured, [
      { msg: "first warning", level: "warning" },
      { msg: "second warning", level: "warning" },
    ]);

    await handler({}, { cwd: process.cwd(), ui });
    assert.equal(captured.length, 2, "a second session_start must not re-emit warnings");
  });
});
