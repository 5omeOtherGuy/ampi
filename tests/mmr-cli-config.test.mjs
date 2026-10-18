// `ampi config keymap` and `ampi config edit`: the default commands match what
// the extensions register in a terminal session, the keymap prints as JSONC
// with the settings' overrides, and the settings file opens in the editor.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const repoRoot = path.resolve(import.meta.dirname, "..");
const bin = path.join(repoRoot, "packages", "ampi-cli", "bin", "ampi.js");
const fixtures = path.join(import.meta.dirname, "fixtures", "ampi-cli");
const UPDATE_FIXTURES = process.env.PI_MMR_UPDATE_FIXTURES === "1";

/** Every field of a command the keymap reads. */
const keymapFields = (command) => ({ id: command.id, description: command.description, defaultKey: command.defaultKey ?? null });
const byId = (a, b) => a.id.localeCompare(b.id);

describe("ampi's default commands", () => {
  it("are the commands ampi-tui and ampi-threads register in a terminal session", async () => {
    const registry = await importSource("extensions/ampi-core/command-registry.ts");
    const { collectMmrDefaultCommands } = await importSource("config-keymap.ts");
    const { createMmrTuiExtension } = await importSource("extensions/ampi-tui/index.ts");
    const { createMmrThreadsExtension } = await importSource("extensions/ampi-threads/index.ts");
    registry.__resetMmrCommandsForTests();
    const threads = createMockPi();
    const tui = createMockPi();
    const store = { get: async () => undefined };
    createMmrThreadsExtension({
      loadSettings: () => ({ enabled: true, autoArchiveOnQuit: false }),
      createStore: () => store,
      createHistoryStore: () => ({ read: async () => [], append: async () => {} }),
    })(threads.pi);
    createMmrTuiExtension({ loadSettings: () => ({ enabled: true }) })(tui.pi);
    const { ctx } = createMockExtensionContext({ hasUI: true });
    for (const mock of [threads, tui]) await mock.handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
    try {
      const registered = registry.getMmrCommands().map(keymapFields).sort(byId);
      assert.ok(registered.length > 30, "the session registers ampi's commands");
      assert.deepEqual(collectMmrDefaultCommands().map(keymapFields).sort(byId), registered);
    } finally {
      for (const mock of [tui, threads]) await mock.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
      registry.__resetMmrCommandsForTests();
    }
  });
});

describe("ampi config", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ampi-cli-config-"));
  const agentDir = path.join(dir, "agent");
  const project = path.join(dir, "project");
  const editorLog = path.join(dir, "editor.json");
  const fakeEditor = path.join(dir, "editor.mjs");

  before(() => {
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(project, { recursive: true });
    copyFileSync(path.join(fixtures, "keymap-settings.json"), path.join(agentDir, "settings.json"));
    // Records the file it was asked to open and exits with $FAKE_EDITOR_STATUS.
    writeFileSync(
      fakeEditor,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(editorLog)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(Number(process.env.FAKE_EDITOR_STATUS ?? 0));\n`,
    );
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  const run = (args, env = {}) =>
    spawnSync(process.execPath, [bin, "config", ...args], {
      cwd: project,
      encoding: "utf8",
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", VISUAL: "", EDITOR: `${process.execPath} ${fakeEditor}`, ...env },
    });

  it("prints the keymap in effect as JSONC, with the settings' overrides and their problems on stderr", () => {
    const result = run(["keymap"]);
    assert.equal(result.status, 0, result.stderr);
    const golden = path.join(fixtures, "config-keymap.jsonc");
    if (UPDATE_FIXTURES) writeFileSync(golden, result.stdout);
    assert.equal(result.stdout, readFileSync(golden, "utf8"));

    const lines = result.stdout.trimEnd().split("\n");
    assert.equal(lines[1], '  "leader": "ctrl+b",');
    // Valid JSON once the comments are gone: no comma after the last entry.
    const keymap = JSON.parse(result.stdout.replace(/ \/\/ .*$/gm, ""));
    const ids = Object.keys(keymap);
    assert.equal(ids[0], "leader");
    assert.deepEqual(ids.slice(1), [...ids.slice(1)].sort(), "command ids are sorted");
    assert.equal(keymap["thread.new"], "<leader>n");
    assert.deepEqual(keymap["thread.switch"], ["ctrl+t", "<leader>t"]);
    assert.equal(keymap["thread.toggleDetails"], null);
    assert.equal(keymap["ampi.help"], "f1");
    assert.equal(keymap["ampi.quit"], "ctrl+c ctrl+c", "an override that does not parse keeps the default");
    assert.equal(keymap["thread.archive"], "ctrl+c ctrl+n", "commands without an override keep their default");
    assert.equal(keymap["thread.unarchive"], null);
    assert.equal(keymap["puck.open"], undefined, "unknown ids are not listed");

    const problems = result.stderr.trimEnd().split("\n");
    assert.equal(problems.length, 3, result.stderr);
    assert.ok(problems.every((line) => line.startsWith("ampi: keymap: ")));
    assert.match(result.stderr, /ampi\.quit: "nope" is not a modifier/);
    assert.match(result.stderr, /"puck\.open": no command has that id/);
    assert.match(result.stderr, /Key "ctrl\+o" is bound to ampi\.palette, ampi\.showVersion/);
  });

  it("opens the user settings file in $EDITOR, or the project's with --workspace", () => {
    let result = run(["edit"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(editorLog, "utf8")), [path.join(agentDir, "settings.json")]);

    const projectSettings = path.join(project, ".pi", "settings.json");
    result = run(["edit", "--workspace"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(editorLog, "utf8")), [projectSettings]);
    assert.ok(existsSync(path.dirname(projectSettings)), "the directory exists for the editor to save into");
  });

  it("exits 1 when the editor fails and 2 on a usage error", () => {
    const failed = run(["edit"], { FAKE_EDITOR_STATUS: "3" });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /exited with status 3/);

    const both = run(["edit", "--global", "--workspace"]);
    assert.equal(both.status, 2);
    assert.match(both.stderr, /--global or --workspace, not both/);
    const unknown = run(["keymap", "--json"]);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /^ampi: config keymap: .*--json/);
  });

  it("prints its help for --help", () => {
    const result = run(["keymap", "--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^ampi config: /);
    assert.equal(run(["edit", "-h"]).stdout, result.stdout);
  });
});
