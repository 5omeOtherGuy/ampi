// Probe of the Pi calls the `ampi` command makes besides main()
// (packages/ampi-cli/src/pi-compat.js). Pi exports them without documenting
// them; when a Pi upgrade changes their shape, this test fails here instead of
// every `ampi` start failing or loading ampi twice.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { decideAmpiLoad, readPackageAt } from "../packages/ampi-cli/src/packages.js";
import {
  listPiExtensionSources,
  listPiSessions,
  loadThroughPi,
  piAgentDir,
  piExternalEditorCommand,
  piSettingsPath,
  readPiSettings,
  setPiSessionName,
} from "../packages/ampi-cli/src/pi-compat.js";

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
});
