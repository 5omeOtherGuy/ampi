// `ampi setup` and the parts check of `ampi doctor` (packages/ampi-cli/src/
// setup.js, parts.js, doctor.js). The command writes Pi's settings through
// the installed Pi against a temporary agent directory and a stand-in ampi
// package (a local source, so nothing is downloaded), and every choice is
// checked by asking Pi which extension files it now loads.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { buildDoctorChecks, createDoctorPi, DOCTOR_FILE_SYSTEM, gatherDoctorFacts } from "../packages/ampi-cli/src/doctor.js";
import { createLogger } from "../packages/ampi-cli/src/log.js";
import { applySelection, completeSelection, listAmpiParts, PART_INFO, selectionProblems } from "../packages/ampi-cli/src/parts.js";
import { listPiExtensionSources, openPiPackageSettings } from "../packages/ampi-cli/src/pi-compat.js";
import { runSetupCommand } from "../packages/ampi-cli/src/setup.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cliRoot = path.join(repoRoot, "packages", "ampi-cli");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

describe("ampi's parts", () => {
  it("describe every extension the ampi package registers, core first, and nothing else", () => {
    const parts = listAmpiParts(readJson(path.join(repoRoot, "package.json")));
    assert.equal(parts[0].name, "core");
    assert.deepEqual(
      parts.map((part) => part.name),
      Object.keys(PART_INFO),
      "PART_INFO lists the parts of package.json pi.extensions, in load order",
    );
    for (const part of parts) {
      assert.notEqual(part.summary, "", `${part.name} has a summary`);
      for (const needed of part.requires) assert.ok(PART_INFO[needed], `${part.name} requires a known part`);
    }
  });

  const parts = [
    { name: "core", extension: "ampi-core", entry: "src/extensions/ampi-core/index.ts", summary: "", requires: [] },
    { name: "web", extension: "ampi-web", entry: "src/extensions/ampi-web/index.ts", summary: "", requires: [] },
    { name: "workers", extension: "ampi-workers", entry: "src/extensions/ampi-workers/index.ts", summary: "", requires: [] },
    { name: "custom-subagents", extension: "ampi-custom-subagents", entry: "src/extensions/ampi-custom-subagents/index.ts", summary: "", requires: ["workers"] },
  ];

  it("keep core and what a chosen part needs on, and report what they added", () => {
    const { selected, added } = completeSelection(["custom-subagents"], parts);
    assert.deepEqual([...selected].sort(), ["core", "custom-subagents", "workers"]);
    assert.deepEqual(added, [{ name: "workers", by: "custom-subagents" }]);
  });

  it("find a selection without core, or with a part missing what it needs", () => {
    assert.deepEqual(selectionProblems(new Set(["web"]), parts), [{ severity: "fail", message: "core is off, but web needs it" }]);
    assert.deepEqual(selectionProblems(new Set(["core", "custom-subagents"]), parts), [
      { severity: "warn", message: "custom-subagents is on without workers, which it needs" },
    ]);
    assert.deepEqual(selectionProblems(new Set(["core"]), parts), []);
  });

  it("replace the patterns that name parts, keep the others, and fall back to a plain source with everything on", () => {
    const entry = { source: "npm:@skippermissions/ampi", skills: [], extensions: ["!src/legacy/*.ts", "-./src/extensions/ampi-web/index.ts"] };
    assert.deepEqual(applySelection(entry, parts, new Set(["core", "web"])), {
      source: "npm:@skippermissions/ampi",
      skills: [],
      extensions: [
        "!src/legacy/*.ts",
        "+src/extensions/ampi-core/index.ts",
        "+src/extensions/ampi-web/index.ts",
        "-src/extensions/ampi-workers/index.ts",
        "-src/extensions/ampi-custom-subagents/index.ts",
      ],
    });
    const all = new Set(parts.map((part) => part.name));
    assert.equal(applySelection({ source: "../ampi", extensions: ["-src/extensions/ampi-web/index.ts"] }, parts, all), "../ampi");
    // A project entry that filters on top of the user's needs every part spelled out, even with all on.
    assert.equal(applySelection({ source: "../ampi", autoload: false }, parts, all).extensions.length, parts.length);
  });
});

describe("ampi setup against Pi's settings", () => {
  const savedEnv = { agentDir: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
  const dir = mkdtempSync(path.join(tmpdir(), "ampi-cli-setup-"));
  const agentDir = path.join(dir, "agent");
  const project = path.join(dir, "project");
  const settingsFile = path.join(agentDir, "settings.json");
  // A stand-in ampi package: the real manifest shape with empty extension files.
  const ampi = path.join(dir, "ampi");
  const names = ["ampi-core", "ampi-web", "ampi-workers", "ampi-custom-subagents", "ampi-tui"];
  const entryOf = (name) => path.join(ampi, "src", "extensions", name, "index.ts");
  /** @type {any} */
  let pi;

  before(async () => {
    writeJson(path.join(ampi, "package.json"), {
      name: "@skippermissions/ampi",
      version: "9.9.9",
      pi: { extensions: names.map((name) => `./src/extensions/${name}/index.ts`) },
    });
    for (const name of names) {
      mkdirSync(path.dirname(entryOf(name)), { recursive: true });
      writeFileSync(entryOf(name), "export default function () {}\n");
    }
    mkdirSync(project, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_OFFLINE = "1";
    pi = await import("@earendil-works/pi-coding-agent");
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

  beforeEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
    writeJson(settingsFile, { theme: "dark", packages: ["npm:some-other-package", ampi] });
  });

  /** @param {{ answers?: string[], isTTY?: boolean }} [options] */
  const makeHost = ({ answers, isTTY = false } = {}) => {
    const out = [];
    const err = [];
    const questions = [];
    return {
      out,
      err,
      questions,
      host: {
        cwd: project,
        openSettings: (scope) => openPiPackageSettings(pi, project, scope),
        extensionSources: () => listPiExtensionSources(pi, project),
        projectTrusted: () => true,
        ownAmpi: { root: ampi, version: "9.9.9" },
        isTTY,
        ask: async (question) => {
          questions.push(question);
          return answers?.shift();
        },
        out: (text) => out.push(text),
        log: createLogger({ stderr: (text) => err.push(text) }),
      },
    };
  };

  /** The extensions of the stand-in package Pi loads now, by directory name. */
  const loaded = async () => {
    const { enabled } = await listPiExtensionSources(pi, project);
    return names.filter((name) => enabled.some((entry) => entry.path === entryOf(name)));
  };

  it("--parts makes Pi load exactly those parts, core and what they need, and leaves the rest of the settings alone", async () => {
    const { host, err } = makeHost();
    assert.equal(await runSetupCommand(["--parts", "custom-subagents,ampi-tui"], host), 0);
    assert.deepEqual(await loaded(), ["ampi-core", "ampi-workers", "ampi-custom-subagents", "ampi-tui"]);
    assert.match(err.join(""), /custom-subagents needs workers, so workers is on too/);
    const settings = readJson(settingsFile);
    assert.equal(settings.theme, "dark");
    assert.equal(settings.packages[0], "npm:some-other-package");

    assert.equal(await runSetupCommand(["--add", "web", "--remove", "tui"], makeHost().host), 0);
    assert.deepEqual(await loaded(), ["ampi-core", "ampi-web", "ampi-workers", "ampi-custom-subagents"]);

    assert.equal(await runSetupCommand(["--all"], makeHost().host), 0);
    assert.deepEqual(await loaded(), names);
    assert.equal(typeof readJson(settingsFile).packages[1], "string", "everything on is a plain source again");
  });

  it("asks in a terminal: toggles by number and name, keeps core on, saves on an empty line", async () => {
    const { host, out } = makeHost({ isTTY: true, answers: ["2 tui", "core", "nope", ""] });
    assert.equal(await runSetupCommand([], host), 0);
    const text = out.join("");
    assert.match(text, /core is required and stays on/);
    assert.match(text, /No part nope/);
    assert.deepEqual(await loaded(), ["ampi-core", "ampi-workers", "ampi-custom-subagents"]);
  });

  it("cancels on q or the end of input without writing, and asks only in a terminal", async () => {
    const before = readFileSync(settingsFile, "utf8");
    for (const answers of [["web", "q"], []]) {
      assert.equal(await runSetupCommand([], makeHost({ isTTY: true, answers }).host), 1);
      assert.equal(readFileSync(settingsFile, "utf8"), before);
    }
    const { host, err } = makeHost();
    assert.equal(await runSetupCommand([], host), 2);
    assert.match(err.join(""), /only in a terminal/);
    assert.equal(await runSetupCommand(["--parts", "nope"], makeHost().host), 2);
    assert.equal(await runSetupCommand(["--parts", "web", "--add", "tui"], makeHost().host), 2);
    assert.equal(readFileSync(settingsFile, "utf8"), before);
  });

  it("installs ampi from --source when the settings have no ampi entry, then applies the choice", async () => {
    writeJson(settingsFile, {});
    const { host, out } = makeHost();
    assert.equal(await runSetupCommand(["--parts", "tui", "--source", ampi], host), 0);
    assert.match(out.join(""), /Installing/);
    assert.deepEqual(await loaded(), ["ampi-core", "ampi-tui"]);
  });

  it("leaves a settings file that does not parse as it is", async () => {
    writeFileSync(settingsFile, "{ not json");
    const { host, err } = makeHost();
    assert.equal(await runSetupCommand(["--parts", "tui"], host), 1);
    assert.match(err.join(""), /cannot read Pi's settings/);
    assert.equal(readFileSync(settingsFile, "utf8"), "{ not json");
  });

  it("is what ampi doctor reports, which fails when core is off", async () => {
    const parts = async () => {
      const facts = await gatherDoctorFacts({
        env: { PATH: "" },
        cwd: project,
        platform: process.platform,
        nodeVersion: process.versions.node,
        cliRoot,
        loadPi: async () => createDoctorPi(pi, project),
        fs: DOCTOR_FILE_SYSTEM,
        isTTY: false,
        colorDepth: undefined,
        out: () => {},
        log: createLogger({ stderr: () => {} }),
      });
      return buildDoctorChecks(facts).find((check) => check.id === "parts");
    };
    assert.equal(await runSetupCommand(["--parts", "web"], makeHost().host), 0);
    assert.deepEqual(await parts(), { id: "parts", status: "ok", summary: "2 of 5 parts load (core, web); off: workers, custom-subagents, tui" });

    // pi config can switch core off too; doctor says what to do.
    const settings = readJson(settingsFile);
    settings.packages[1].extensions = settings.packages[1].extensions.map((pattern) => pattern.replace("+src/extensions/ampi-core", "-src/extensions/ampi-core"));
    writeJson(settingsFile, settings);
    const check = await parts();
    assert.equal(check.status, "fail");
    assert.match(check.summary, /core is off, but web needs it/);
    assert.match(check.hint, /ampi setup/);
  });
});
