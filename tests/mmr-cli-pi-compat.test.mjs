// Probe of the Pi calls the `ampi` command makes besides main()
// (packages/ampi-cli/src/pi-compat.js). Pi exports them without documenting
// them; when a Pi upgrade changes their shape, this test fails here instead of
// every `ampi` start failing or loading ampi twice.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { decideAmpiLoad, readPackageAt } from "../packages/ampi-cli/src/packages.js";
import {
  checkPiSkillDir,
  createPiModelLookup,
  createPiSessionServices,
  createPiSessionWriter,
  isPiProjectTrusted,
  listPiExtensionSources,
  listPiMcpServers,
  listPiSessions,
  listPiTrustResources,
  loadThroughPi,
  parsePiFrontmatter,
  parsePiMcpList,
  piAgentDir,
  piExternalEditorCommand,
  piSettingsManager,
  piMcpUsesOAuth,
  piProjectMcpPath,
  piSettingsPath,
  piToolOrigin,
  readPiProjectTrust,
  readPiSessionEntries,
  readPiSessionSkills,
  readPiSettings,
  setPiSessionName,
  trustPiProject,
} from "../packages/ampi-cli/src/pi-compat.js";
import { createAmpiSdkSession } from "../packages/ampi-cli/src/sdk-session.js";
import { createSessionId } from "../packages/ampi-cli/src/threads.js";

/** @param {string} file @param {unknown} json */
const writeJson = (file, json) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(json));
};
/** @param {string} file */
const touch = (file) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "");
};

describe("Pi surface used by the ampi command", () => {
  const savedEnv = { agentDir: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
  const dir = mkdtempSync(path.join(tmpdir(), "ampi-cli-pi-compat-"));
  const agentDir = path.join(dir, "agent");
  const project = path.join(dir, "project");
  // An ampi installed from npm where Pi keeps user packages, so Pi never looks for a global npm install.
  const npmAmpi = path.join(agentDir, "npm", "node_modules", "@skippermissions", "ampi");
  const npmEntry = path.join(npmAmpi, "src", "core.ts");
  // A file of another ampi copy, listed under the settings `extensions` key.
  const listedEntry = path.join(dir, "ampi-copy", "src", "tui.ts");
  // A file in Pi's own extension directory.
  const discoveredEntry = path.join(agentDir, "extensions", "local.ts");
  const missingGit = "git:github.com/5omeOtherGuy/ampi";

  before(() => {
    writeJson(path.join(npmAmpi, "package.json"), { name: "@skippermissions/ampi", version: "9.9.9", pi: { extensions: ["./src/core.ts"] } });
    touch(npmEntry);
    writeJson(path.join(dir, "ampi-copy", "package.json"), { name: "@skippermissions/ampi", version: "9.9.8" });
    touch(listedEntry);
    touch(discoveredEntry);
    writeJson(path.join(agentDir, "settings.json"), {
      packages: ["npm:@skippermissions/ampi", missingGit],
      extensions: [listedEntry],
    });
    mkdirSync(project, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    // Offline mode skips the missing-source callback; this probe needs it.
    delete process.env.PI_OFFLINE;
  });

  after(() => {
    for (const [name, value] of [
      ["PI_CODING_AGENT_DIR", savedEnv.agentDir],
      ["PI_OFFLINE", savedEnv.offline],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists enabled extensions from packages, the extensions key and extension directories, without installing", async () => {
    const pi = await import("@earendil-works/pi-coding-agent");
    const sources = await listPiExtensionSources(pi, project);

    const files = sources.enabled.filter((entry) => path.isAbsolute(entry.path));
    assert.deepEqual(
      files.sort((a, b) => a.path.localeCompare(b.path)),
      [
        { path: npmEntry, source: "npm:@skippermissions/ampi" },
        { path: discoveredEntry, source: discoveredEntry },
        { path: listedEntry, source: listedEntry },
      ].sort((a, b) => a.path.localeCompare(b.path)),
    );
    assert.deepEqual(sources.missing, [missingGit]);
    assert.equal(sources.cachedPathOf(missingGit), undefined);
    assert.equal(sources.cachedPathOf("npm:@skippermissions/ampi"), undefined);

    const decision = decideAmpiLoad({ piArgs: [], pi: sources, cwd: project, packageNameAt: (start) => readPackageAt(start)?.name });
    assert.equal(decision.load, false);
  });
});

describe("Pi session calls used by the thread commands", () => {
  const savedEnv = process.env.PI_CODING_AGENT_DIR;
  const dir = mkdtempSync(path.join(tmpdir(), "ampi-cli-pi-sessions-"));
  const agentDir = path.join(dir, "agent");
  const custom = path.join(dir, "custom");
  const line = (entry) => `${JSON.stringify(entry)}\n`;
  // Session files written by hand in the documented format and layout (Pi's docs/session-format.md).
  const writeSession = (file, id, cwd, prompt, iso) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      line({ type: "session", version: 3, id, timestamp: iso, cwd }) +
        line({ type: "message", id: "m1", parentId: null, timestamp: iso, message: { role: "user", content: prompt, timestamp: Date.parse(iso) } }),
    );
  };
  const projectFile = path.join(agentDir, "sessions", "--work-project--", "2026-10-18T09-00-00-000Z_s-project.jsonl");
  const otherFile = path.join(agentDir, "sessions", "--work-other--", "2026-10-17T09-00-00-000Z_s-other.jsonl");
  const customFile = path.join(custom, "2026-10-16T09-00-00-000Z_s-custom.jsonl");

  before(() => {
    writeSession(projectFile, "s-project", "/work/project", "Fix the parser", "2026-10-18T09:00:00.000Z");
    writeSession(otherFile, "s-other", "/work/other", "Port the docs", "2026-10-17T09:00:00.000Z");
    writeSession(customFile, "s-custom", "/work/project", "Elsewhere", "2026-10-16T09:00:00.000Z");
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  after(() => {
    if (savedEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds Pi's agent directory, lists sessions with the fields the commands read, and names one", async () => {
    const pi = await import("@earendil-works/pi-coding-agent");
    assert.equal(piAgentDir(pi), agentDir);

    const [project] = await listPiSessions(pi, { cwd: "/work/project", env: {}, scope: "workspace" });
    assert.deepEqual(
      {
        path: project.path,
        id: project.id,
        cwd: project.cwd,
        name: project.name,
        created: project.created.toISOString(),
        modified: project.modified.toISOString(),
        messageCount: project.messageCount,
        firstMessage: project.firstMessage,
      },
      {
        path: projectFile,
        id: "s-project",
        cwd: "/work/project",
        name: undefined,
        created: "2026-10-18T09:00:00.000Z",
        modified: "2026-10-18T09:00:00.000Z",
        messageCount: 1,
        firstMessage: "Fix the parser",
      },
    );
    const ids = async (options) => (await listPiSessions(pi, options)).map((session) => session.id).sort();
    assert.deepEqual(await ids({ cwd: "/work/project", env: {}, scope: "all" }), ["s-other", "s-project"]);
    const env = { PI_CODING_AGENT_SESSION_DIR: custom };
    assert.deepEqual(await ids({ cwd: "/work/project", env, scope: "workspace" }), ["s-custom"]);
    assert.deepEqual(await ids({ cwd: "/work/project", env, scope: "all" }), ["s-custom"]);

    setPiSessionName(pi, projectFile, "Parser fix");
    const [renamed] = await listPiSessions(pi, { cwd: "/work/project", env: {}, scope: "workspace" });
    assert.equal(renamed.name, "Parser fix");
    const last = JSON.parse(readFileSync(projectFile, "utf8").trim().split("\n").at(-1));
    assert.deepEqual([last.type, last.name], ["session_info", "Parser fix"]);

    // The entries without the header, as the reports read them.
    assert.deepEqual(
      readPiSessionEntries(pi, otherFile).map((entry) => [entry.type, entry.id, entry.parentId, entry.message?.content]),
      [["message", "m1", null, "Port the docs"]],
    );
    // An older file version is migrated in memory and never written back.
    const legacyFile = path.join(dir, "legacy", "2026-10-15T09-00-00-000Z_s-legacy.jsonl");
    mkdirSync(path.dirname(legacyFile), { recursive: true });
    const legacy =
      line({ type: "session", version: 2, id: "s-legacy", timestamp: "2026-10-15T09:00:00.000Z", cwd: "/work/project" }) +
      line({
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "2026-10-15T09:00:00.000Z",
        message: { role: "hookMessage", customType: "note", content: "Old note", display: true, timestamp: 0 },
      });
    writeFileSync(legacyFile, legacy);
    assert.deepEqual(
      readPiSessionEntries(pi, legacyFile).map((entry) => [entry.type, entry.id, entry.message?.role]),
      [["message", "m1", "custom"]],
    );
    assert.equal(readFileSync(legacyFile, "utf8"), legacy);
  });

  it("writes a new session under a given id where Pi lists it, once it has a message", async () => {
    const pi = await import("@earendil-works/pi-coding-agent");
    for (const [env, folder] of [
      [{}, path.join(agentDir, "sessions", "--work-imported--")],
      [{ PI_CODING_AGENT_SESSION_DIR: custom }, custom],
    ]) {
      const writer = createPiSessionWriter(pi, { cwd: "/work/imported", env, id: "s-imported" });
      assert.equal(writer.getSessionId(), "s-imported");
      assert.equal(path.dirname(writer.getSessionFile()), folder);
      writer.appendCustomEntry("probe", { kept: true });
      writer.appendSessionInfo("Imported");
      assert.equal(existsSync(writer.getSessionFile()), false, "no file before the first message");
      writer.appendMessage({ role: "user", content: "Hello", timestamp: Date.parse("2026-10-01T09:00:00.000Z") });
      const [listed] = (await listPiSessions(pi, { cwd: "/work/imported", env, scope: "workspace" })).filter((session) => session.id === "s-imported");
      assert.deepEqual(
        { path: listed.path, name: listed.name, modified: listed.modified.toISOString(), messageCount: listed.messageCount },
        { path: writer.getSessionFile(), name: "Imported", modified: "2026-10-01T09:00:00.000Z", messageCount: 1 },
      );
      assert.deepEqual(
        readPiSessionEntries(pi, writer.getSessionFile()).map((entry) => entry.type),
        ["custom", "session_info", "message"],
      );
    }
  });
});

describe("Pi's model registry, as the cost and context reports read it", () => {
  const savedEnv = { agentDir: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
  const dir = mkdtempSync(path.join(tmpdir(), "ampi-cli-pi-models-"));
  const agentDir = path.join(dir, "agent");

  before(() => {
    writeJson(path.join(agentDir, "models.json"), {
      providers: {
        local: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [{ id: "coder", name: "Local Coder", contextWindow: 32000 }] },
      },
    });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    // The registry must stay offline whether or not PI_OFFLINE is set.
    delete process.env.PI_OFFLINE;
  });

  after(() => {
    for (const [name, value] of [
      ["PI_CODING_AGENT_DIR", savedEnv.agentDir],
      ["PI_OFFLINE", savedEnv.offline],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds built-in and models.json models with their name, window and price, without touching credentials", async () => {
    const pi = await import("@earendil-works/pi-coding-agent");
    const lookup = await createPiModelLookup(pi);
    const builtIn = lookup("anthropic", "claude-sonnet-4-5");
    assert.equal(typeof builtIn?.name, "string");
    assert.ok(builtIn.contextWindow > 0);
    assert.deepEqual(Object.keys(builtIn.cost).sort(), ["cacheRead", "cacheWrite", "input", "output"]);
    assert.ok(builtIn.cost.input > 0);
    // A model without a price gets Pi's all-zero price.
    assert.deepEqual(lookup("local", "coder"), { name: "Local Coder", contextWindow: 32000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    assert.equal(lookup("acme", "nothing"), undefined);
    // Pi writes an empty auth.json when it opens its credential store; the registry never opens it.
    assert.deepEqual(readdirSync(agentDir), ["models.json"]);
  });
});

describe("Pi's session ids, as threads new and threads continue make them", () => {
  it("accepts the ids threads new makes under --session-id, refuses ids outside its rules, and makes the same shape itself", async () => {
    const pi = await import("@earendil-works/pi-coding-agent");
    const ids = [createSessionId(0, new Uint8Array(10)), createSessionId(2 ** 48 - 1, new Uint8Array(10).fill(0xff)), createSessionId(Date.now())];
    for (const id of ids) {
      assert.equal(pi.parseArgs(["--session-id", id]).sessionId, id);
      // Pi checks an id it is given against its id rules before it uses it.
      assert.equal(pi.SessionManager.inMemory("/work/project", { id }).getSessionId(), id);
    }
    for (const id of ["-leading", "trailing.", "with space", ""]) {
      assert.throws(() => pi.SessionManager.inMemory("/work/project", { id }), /Session id must/, JSON.stringify(id));
    }
    // threads continue recognises a complete id by this shape, so Pi's own ids must have it too.
    assert.match(pi.SessionManager.inMemory("/work/project").getSessionId(), /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("Pi calls used by the config commands", () => {
  const savedEnv = { agentDir: process.env.PI_CODING_AGENT_DIR, visual: process.env.VISUAL, editor: process.env.EDITOR };
  const dir = mkdtempSync(path.join(tmpdir(), "ampi-cli-pi-config-"));
  const agentDir = path.join(dir, "agent");
  const project = path.join(dir, "project");

  before(() => {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeJson(path.join(agentDir, "settings.json"), { ampi: { keymap: { "thread.new": "ctrl+t" } } });
    writeJson(path.join(project, ".pi", "settings.json"), { ampi: { keymap: { "thread.new": "alt+n" } }, externalEditor: "project-editor" });
  });

  after(() => {
    for (const [name, value] of [
      ["PI_CODING_AGENT_DIR", savedEnv.agentDir],
      ["VISUAL", savedEnv.visual],
      ["EDITOR", savedEnv.editor],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads one TypeScript file through Pi's loader and returns what it emits", async () => {
    const pi = await import("@earendil-works/pi-coding-agent");
    const entry = path.join(dir, "entry.ts");
    writeFileSync(
      entry,
      'export default function (pi: { events: { emit(channel: string, data: unknown): void } }): void {\n  pi.events.emit("probe", { answer: 42 as number });\n}\n',
    );
    assert.deepEqual(await loadThroughPi(pi, entry, "probe"), { answer: 42 });
    await assert.rejects(loadThroughPi(pi, path.join(dir, "missing.ts"), "probe"), /missing\.ts/);
  });

  it("reads the project's settings and editor only once Pi trusts the project", async () => {
    const pi = await import("@earendil-works/pi-coding-agent");
    delete process.env.VISUAL;
    process.env.EDITOR = "env-editor --wait";
    assert.deepEqual(readPiSettings(pi, project).ampi, { keymap: { "thread.new": "ctrl+t" } });
    assert.equal(piExternalEditorCommand(pi, project), "env-editor --wait");

    new pi.ProjectTrustStore(agentDir).set(project, true);
    assert.deepEqual(readPiSettings(pi, project).ampi, { keymap: { "thread.new": "alt+n" } });
    assert.equal(piExternalEditorCommand(pi, project), "project-editor");
    process.env.VISUAL = "visual-editor";
    assert.equal(piExternalEditorCommand(pi, dir), "visual-editor");

    assert.equal(piSettingsPath(pi, project, "user"), path.join(agentDir, "settings.json"));
    assert.equal(piSettingsPath(pi, project, "project"), path.join(project, ".pi", "settings.json"));
  });

  it("trusts a project without a stored decision when defaultProjectTrust is always, and a stored no wins", async () => {
    const pi = await import("@earendil-works/pi-coding-agent");
    const other = path.join(dir, "other-project");
    writeJson(path.join(other, ".pi", "settings.json"), { ampi: { keymap: { "thread.new": "alt+n" } } });
    writeJson(path.join(agentDir, "settings.json"), { defaultProjectTrust: "always", ampi: { keymap: { "thread.new": "ctrl+t" } } });
    assert.deepEqual(readPiSettings(pi, other).ampi, { keymap: { "thread.new": "alt+n" } });

    new pi.ProjectTrustStore(agentDir).set(other, false);
    assert.deepEqual(readPiSettings(pi, other).ampi, { keymap: { "thread.new": "ctrl+t" } });
  });

  it("hands SDK sessions a SettingsManager that carries the project trust it read", async () => {
    const pi = await import("@earendil-works/pi-coding-agent");
    // The previous test stored "no" for this project.
    const untrusted = path.join(dir, "other-project");
    const trusted = path.join(dir, "trusted-project");
    writeJson(path.join(trusted, ".pi", "settings.json"), { ampi: { keymap: { "thread.new": "alt+t" } } });
    new pi.ProjectTrustStore(agentDir).set(trusted, true);
    const kept = piSettingsManager(pi, untrusted);
    assert.ok(kept instanceof pi.SettingsManager);
    assert.equal(kept.isProjectTrusted(), false);
    const read = piSettingsManager(pi, trusted);
    assert.equal(read.isProjectTrusted(), true);
    assert.deepEqual(read.getSettings().ampi, { keymap: { "thread.new": "alt+t" } });
  });
});

describe("Pi calls used by SDK sessions", () => {
  const savedEnv = { agentDir: process.env.PI_CODING_AGENT_DIR, home: process.env.HOME };
  const dir = mkdtempSync(path.join(tmpdir(), "ampi-cli-pi-services-"));
  const agentDir = path.join(dir, "agent");
  const project = path.join(dir, "project");
  const good = path.join(dir, "extensions", "good.ts");
  const broken = path.join(dir, "extensions", "broken.ts");

  before(() => {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = path.join(dir, "home");
    mkdirSync(project, { recursive: true });
    mkdirSync(path.dirname(good), { recursive: true });
    writeFileSync(good, "export default function (): void {}\n");
    writeFileSync(broken, 'export default function (): void {\n  throw new Error("probe extension failed");\n}\n');
  });

  after(() => {
    for (const [name, value] of [
      ["PI_CODING_AGENT_DIR", savedEnv.agentDir],
      ["HOME", savedEnv.home],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates services that load the extra extension paths and factories, with load failures as error diagnostics", async () => {
    const pi = await import("@earendil-works/pi-coding-agent");
    const factoryRan = [];
    const { services, diagnostics } = await createPiSessionServices(pi, {
      cwd: project,
      agentDir,
      extensionPaths: [good, broken],
      extensionFactories: [{ name: "probe-factory", factory: () => factoryRan.push(true) }],
    });

    const loaded = services.resourceLoader.getExtensions().extensions.map((extension) => extension.path);
    assert.ok(loaded.includes(good), loaded.join(", "));
    assert.ok(loaded.includes("<inline:probe-factory>"), loaded.join(", "));
    assert.equal(loaded.includes(broken), false);
    assert.deepEqual(factoryRan, [true]);
    const errors = diagnostics.filter((diagnostic) => diagnostic.type === "error").map((diagnostic) => diagnostic.message);
    assert.equal(errors.length, 1, errors.join("\n"));
    assert.match(errors[0], /broken\.ts/);
    assert.match(errors[0], /probe extension failed/);
    // The services use the settings piSettingsManager reads, project trust included.
    assert.equal(services.settingsManager.isProjectTrusted(), piSettingsManager(pi, project).isProjectTrusted());
  });
});

describe("Pi SDK calls of the session builder (sdk-session.js) and the tools command", () => {
  const savedEnv = { agentDir: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
  const dir = mkdtempSync(path.join(tmpdir(), "ampi-cli-pi-sdk-"));
  const agentDir = path.join(dir, "agent");
  const project = path.join(dir, "project");
  // A stand-in named like ampi, which Pi's settings load, so the builder does not add the real one.
  const standIn = path.join(dir, "stand-in");
  const extensionFile = path.join(dir, "extensions", "stamp.ts");
  const probeKey = "__ampi_cli_sdk_probe__";

  before(() => {
    writeJson(path.join(standIn, "package.json"), { name: "@skippermissions/ampi", version: "0.0.0", pi: { extensions: ["./index.ts"] } });
    writeFileSync(
      path.join(standIn, "index.ts"),
      [
        "export default function (pi: any): void {",
        '  pi.registerFlag("ampi-mode", { type: "string", description: "mode" });',
        '  pi.registerTool({ name: "echo", label: "Echo", description: "Echo.", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: {} }) });',
        `  pi.on("session_start", (_event: any, ctx: any) => { (globalThis as any)[${JSON.stringify(probeKey)}] = { flag: pi.getFlag("ampi-mode"), mode: ctx.mode }; });`,
        "}",
        "",
      ].join("\n"),
    );
    mkdirSync(path.dirname(extensionFile), { recursive: true });
    writeFileSync(
      extensionFile,
      'export default function (pi: any): void { pi.registerTool({ name: "stamp", label: "Stamp", description: "Stamp.", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: {} }) }); }\n',
    );
    writeJson(path.join(agentDir, "settings.json"), { packages: [standIn], extensions: [extensionFile] });
    // Servers default to codemode exposure, which makes the MCP extension activate codemode.
    writeJson(path.join(agentDir, "mcp.json"), {
      mcpServers: {
        docs: { command: process.execPath },
        off: { command: process.execPath, enabled: false },
        later: { command: process.execPath },
      },
    });
    // A project server and an override that turns a user server off, read once the project is trusted.
    writeJson(path.join(project, ".pi", "mcp.json"), { mcpServers: { local: { url: "http://127.0.0.1:9/mcp" }, later: { enabled: false } } });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_OFFLINE = "1";
  });

  after(() => {
    delete (/** @type {any} */ (globalThis))[probeKey];
    for (const [name, value] of [
      ["PI_CODING_AGENT_DIR", savedEnv.agentDir],
      ["PI_OFFLINE", savedEnv.offline],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the MCP servers Pi would connect, the project's only once it is trusted", async () => {
    const pi = await import("@earendil-works/pi-coding-agent");
    assert.deepEqual(listPiMcpServers(pi, project), ["docs", "later"]);
    new pi.ProjectTrustStore(agentDir).set(project, true);
    assert.deepEqual(listPiMcpServers(pi, project), ["docs", "local"]);
  });

  it("builds a session with the mode flag, the built-in extensions and Pi's tool sources, without connecting MCP", async () => {
    const pi = await import("@earendil-works/pi-coding-agent");
    // Pi with a createMcpExtension that records the options the builder gives the MCP extension.
    /** @type {any[]} */
    const mcpOptions = [];
    const recordingPi = {
      ...pi,
      createMcpExtension: (/** @type {any} */ options) => {
        mcpOptions.push(options);
        return pi.createMcpExtension(options);
      },
    };
    const runtime = await createAmpiSdkSession({
      cwd: project,
      sessionManager: pi.SessionManager.inMemory(project),
      mode: "print",
      connectMcp: false,
      ampiMode: "high",
      pi: recordingPi,
    });
    try {
      assert.deepEqual(runtime.diagnostics, []);
      assert.deepEqual((/** @type {any} */ (globalThis))[probeKey], { flag: "high", mode: "print" });
      const { session } = runtime;
      /** @type {Map<string, any>} */
      const tools = new Map(session.getAllTools().map((/** @type {any} */ info) => [info.name, info]));
      assert.deepEqual(piToolOrigin(tools.get("read")), { builtin: "read" });
      assert.deepEqual(piToolOrigin(tools.get("codemode")), { builtin: "codemode" });
      assert.deepEqual(piToolOrigin(tools.get("tool_search")), { builtin: "tool-search" });
      assert.deepEqual(piToolOrigin(tools.get("stamp")), { file: extensionFile });
      assert.deepEqual(piToolOrigin(tools.get("echo")), { file: path.join(standIn, "index.ts"), packageRoot: standIn, packageSource: standIn });
      assert.equal(typeof tools.get("read").parameters.properties.path, "object");
      // The MCP extension read its configuration (codemode is active for the docs server) but connected nothing.
      const active = session.getActiveToolNames();
      assert.ok(active.includes("codemode") && active.includes("read") && active.includes("stamp"), active.join(" "));
      assert.deepEqual([...tools.keys()].filter((name) => name.startsWith("mcp__")), []);
    } finally {
      await runtime.dispose();
    }
    // Every server the MCP extension tries goes through this transport factory, which refuses at once.
    assert.equal(mcpOptions.length, 1);
    const { createTransport } = mcpOptions[0];
    assert.equal(typeof createTransport, "function");
    const docs = { name: "docs", config: { command: process.execPath } };
    assert.throws(() => createTransport(docs, project, undefined), /does not connect MCP servers/);
    assert.equal(existsSync(path.join(agentDir, "sessions")), false, "an in-memory session writes no file");
  });
});

describe("Pi calls used by the skill commands", () => {
  const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, home: process.env.HOME, offline: process.env.PI_OFFLINE };
  const dir = mkdtempSync(path.join(tmpdir(), "ampi-cli-pi-skills-"));
  const agentDir = path.join(dir, "agent");
  const home = path.join(dir, "home");
  const project = path.join(dir, "project");
  const standIn = path.join(dir, "stand-in");
  /** @param {string} file @param {string} text */
  const writeFileSyncDeep = (file, text) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  /** @param {string} file @param {string} name @param {string} [description] */
  const skill = (file, name, description) =>
    writeFileSyncDeep(file, `---\nname: ${name}\n${description === undefined ? "" : `description: ${description}\n`}---\nBody\n`);

  before(() => {
    writeJson(path.join(standIn, "package.json"), { name: "@skippermissions/ampi", version: "0.0.0", pi: { extensions: ["./index.ts"] } });
    writeFileSyncDeep(path.join(standIn, "index.ts"), "export default function (): void {}\n");
    writeJson(path.join(agentDir, "settings.json"), { packages: [standIn] });
    skill(path.join(agentDir, "skills", "pdf-tools", "SKILL.md"), "pdf-tools", "Read PDFs.");
    skill(path.join(home, ".agents", "skills", "pdf-copy", "SKILL.md"), "pdf-tools", "Read PDFs again.");
    skill(path.join(project, ".agents", "skills", "triage", "SKILL.md"), "triage", "Sort issues.");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = home;
    process.env.PI_OFFLINE = "1";
  });

  after(() => {
    for (const [name, value] of [
      ["PI_CODING_AGENT_DIR", saved.agentDir],
      ["HOME", saved.home],
      ["PI_OFFLINE", saved.offline],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a session's skills with their source info, and reports a name collision on the skill that lost", async () => {
    const pi = await import("@earendil-works/pi-coding-agent");
    const runtime = await createAmpiSdkSession({ cwd: project, sessionManager: pi.SessionManager.inMemory(project), mode: "print", connectMcp: false, pi });
    try {
      const { skills, problems } = readPiSessionSkills(runtime.session);
      // The project's .agents/skills needs trust, which this project does not have.
      assert.deepEqual(
        skills.map((entry) => [entry.name, entry.description, entry.filePath, entry.baseDir, entry.disableModelInvocation, entry.sourceInfo.source, entry.sourceInfo.scope, entry.sourceInfo.origin]),
        [["pdf-tools", "Read PDFs.", path.join(agentDir, "skills", "pdf-tools", "SKILL.md"), path.join(agentDir, "skills", "pdf-tools"), false, "auto", "user", "top-level"]],
      );
      assert.deepEqual(problems, [
        {
          path: path.join(home, ".agents", "skills", "pdf-copy", "SKILL.md"),
          message: `another skill named "pdf-tools" is loaded from ${path.join(agentDir, "skills", "pdf-tools", "SKILL.md")}`,
        },
      ]);
    } finally {
      await runtime.dispose();
    }
    assert.equal(isPiProjectTrusted(pi, project), false);
    new pi.ProjectTrustStore(agentDir).set(project, true);
    assert.equal(isPiProjectTrusted(pi, project), true);
  });

  it("checks a skill directory and parses frontmatter with Pi's rules", async () => {
    const pi = await import("@earendil-works/pi-coding-agent");
    assert.deepEqual(checkPiSkillDir(pi, path.join(agentDir, "skills", "pdf-tools")), { name: "pdf-tools", problems: [] });
    skill(path.join(dir, "bad", "SKILL.md"), "Bad--Name");
    const bad = checkPiSkillDir(pi, path.join(dir, "bad"));
    assert.equal(bad.name, undefined);
    assert.deepEqual(bad.problems.sort(), [
      "description is required",
      "name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)",
      "name must not contain consecutive hyphens",
    ]);
    assert.deepEqual(parsePiFrontmatter(pi, "---\nname: a\nmetadata:\n  team: x\n---\nBody\n"), { name: "a", metadata: { team: "x" } });
    assert.deepEqual(parsePiFrontmatter(pi, "No frontmatter\n"), {});
    assert.throws(() => parsePiFrontmatter(pi, "---\nname: [unclosed\n---\n"));
  });
});

describe("Pi's MCP list and project trust, as the mcp commands use them", () => {
  const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, home: process.env.HOME, offline: process.env.PI_OFFLINE };
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "ampi-cli-pi-mcp-")));
  const agentDir = path.join(dir, "agent");
  const home = path.join(dir, "home");
  const project = path.join(dir, "project");
  const echoServer = path.join(import.meta.dirname, "fixtures", "ampi-cli", "mcp-echo-server.mjs");
  const piRoot = path.join(import.meta.dirname, "..", "node_modules", "@earendil-works", "pi-coding-agent");
  const piBin = path.join(piRoot, JSON.parse(readFileSync(path.join(piRoot, "package.json"), "utf8")).bin.pi);
  /** @param {string[]} args @param {string} [cwd] */
  const piMcp = (args, cwd = project) =>
    spawnSync(process.execPath, [piBin, "mcp", ...args], { cwd, encoding: "utf8", env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" } });

  before(() => {
    writeJson(path.join(agentDir, "mcp.json"), {
      mcpServers: {
        echo: { command: process.execPath, args: [echoServer] },
        off: { command: process.execPath, enabled: false },
        // HTTP servers are never connected here: `pi mcp logout` only reads their configuration.
        open: { url: "https://open.example/mcp", enabled: false },
        keyed: { url: "https://keyed.example/mcp", headers: { Authorization: "Bearer x" }, enabled: false },
      },
    });
    writeJson(path.join(project, ".pi", "mcp.json"), { mcpServers: { local: { command: process.execPath, args: [echoServer] } } });
    mkdirSync(home, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = home;
    process.env.PI_OFFLINE = "1";
  });

  after(() => {
    for (const [name, value] of [
      ["PI_CODING_AGENT_DIR", saved.agentDir],
      ["HOME", saved.home],
      ["PI_OFFLINE", saved.offline],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the list JSON Pi prints: servers with state, transport and tools, errors, and the untrusted-project note", () => {
    const result = piMcp(["list", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const raw = JSON.parse(result.stdout);
    for (const key of ["name", "scope", "source", "enabled", "transport", "state", "tools"]) assert.ok(key in raw.servers[0], key);
    const list = parsePiMcpList(result.stdout);
    assert.deepEqual(
      list.servers.map(({ name, scope, enabled, kind, state, tools }) => ({ name, scope, enabled, kind, state, tools })),
      [
        { name: "echo", scope: "global", enabled: true, kind: "stdio", state: "connected", tools: ["echo"] },
        { name: "off", scope: "global", enabled: false, kind: "stdio", state: "disabled", tools: [] },
        { name: "open", scope: "global", enabled: false, kind: "http", state: "disabled", tools: [] },
        { name: "keyed", scope: "global", enabled: false, kind: "http", state: "disabled", tools: [] },
      ],
    );
    assert.equal(list.servers[0].source, path.join(agentDir, "mcp.json"));
    assert.deepEqual(list.errors, []);
    assert.match(list.note ?? "", /mcp\.json is ignored because the project is not trusted/);
    assert.throws(() => parsePiMcpList('{"servers": {}}'));
  });

  it("tells OAuth servers apart as pi mcp logout does", () => {
    const list = parsePiMcpList(piMcp(["list", "--json"]).stdout);
    for (const server of list.servers) {
      const logout = piMcp(["logout", server.name]);
      const piSaysOAuth = logout.status === 0 && /No stored credentials/.test(logout.stdout);
      // Either answer, never another: a change in Pi's wording fails here.
      assert.ok(piSaysOAuth || (logout.status === 1 && /does not use OAuth/.test(logout.stderr)), `${server.name}: ${logout.stdout}${logout.stderr}`);
      assert.equal(piMcpUsesOAuth(server), piSaysOAuth, `${server.name}: ${logout.stdout}${logout.stderr}`);
    }
    assert.deepEqual(list.servers.filter(piMcpUsesOAuth).map((server) => server.name), ["open"]);
  });

  it("saves trust as Pi's trust prompt does, and reads the closest saved decision", async () => {
    const pi = await import("@earendil-works/pi-coding-agent");
    assert.equal(piProjectMcpPath(pi, project), path.join(project, ".pi", "mcp.json"));
    assert.deepEqual(readPiProjectTrust(pi, project), { decision: null });
    new pi.ProjectTrustStore(agentDir).set(dir, false);
    assert.deepEqual(readPiProjectTrust(pi, project), { decision: false, path: dir });
    trustPiProject(pi, project);
    assert.deepEqual(readPiProjectTrust(pi, project), { decision: true, path: project });
    assert.deepEqual(JSON.parse(readFileSync(path.join(agentDir, "trust.json"), "utf8")), { [dir]: false, [project]: true });
    // `pi mcp list` now reads the project's servers.
    const list = parsePiMcpList(piMcp(["list", "--json"]).stdout);
    assert.equal(list.note, undefined);
    assert.deepEqual(list.servers.find((server) => server.name === "local")?.state, "connected");
  });

  it("lists exactly the project resources that make Pi ask for trust", async () => {
    const pi = await import("@earendil-works/pi-coding-agent");
    const entries = ["settings.json", "mcp.json", "extensions", "skills", "prompts", "themes", "SYSTEM.md", "APPEND_SYSTEM.md"];
    for (const [index, entry] of entries.entries()) {
      const cwd = path.join(dir, `trust-${index}`);
      mkdirSync(path.join(cwd, ".pi"), { recursive: true });
      assert.equal(pi.hasTrustRequiringProjectResources(cwd), false, entry);
      assert.deepEqual(listPiTrustResources(pi, cwd), [], entry);
      writeFileSync(path.join(cwd, ".pi", entry), "");
      assert.equal(pi.hasTrustRequiringProjectResources(cwd), true, entry);
      assert.deepEqual(listPiTrustResources(pi, cwd), [path.join(cwd, ".pi", entry)], entry);
    }
    // .agents/skills counts in the directory and its parents, but not the user's own.
    const nested = path.join(dir, "outer", "inner");
    mkdirSync(path.join(dir, "outer", ".agents", "skills"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    assert.equal(pi.hasTrustRequiringProjectResources(nested), true);
    assert.deepEqual(listPiTrustResources(pi, nested), [path.join(dir, "outer", ".agents", "skills")]);
    mkdirSync(path.join(home, ".agents", "skills"), { recursive: true });
    assert.equal(pi.hasTrustRequiringProjectResources(home), false);
    assert.deepEqual(listPiTrustResources(pi, home), []);
  });
});
