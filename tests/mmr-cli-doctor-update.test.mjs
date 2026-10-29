// `ampi doctor` and `ampi update` (packages/ampi-cli/src/doctor.js,
// update.js, versions.js). The doctor's checks run through an injected host
// with hand-written facts, through the installed Pi against temporary agent
// and project directories, and in spawned runs with the offline guard
// (fixtures/ampi-cli/offline-guard.mjs). The update runs against an injected
// npm runner and, spawned, against a fake npm first on PATH that logs its
// arguments and answers `root -g`, `view` and `install` from environment
// variables, so no real npm call is made.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildDoctorChecks, createDoctorPi, DOCTOR_FILE_SYSTEM, formatDoctorText, gatherDoctorFacts, runDoctorCommand } from "../packages/ampi-cli/src/doctor.js";
import { createLogger } from "../packages/ampi-cli/src/log.js";
import { otherInstallAdvice, runUpdateCommand } from "../packages/ampi-cli/src/update.js";
import { compareVersions, parseVersion, satisfiesRange } from "../packages/ampi-cli/src/versions.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cliRoot = path.join(repoRoot, "packages", "ampi-cli");
const bin = path.join(cliRoot, "bin", "ampi.js");
const guard = path.join(import.meta.dirname, "fixtures", "ampi-cli", "offline-guard.mjs");
const nodeDir = path.dirname(process.execPath);

const root = mkdtempSync(path.join(tmpdir(), "ampi-cli-doctor-update-"));
after(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
/** A new empty directory under the suite's temporary root. */
const freshDir = (name = "dir") => {
  const dir = path.join(root, `${name}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
/** @param {string} file @param {string} text @param {number} [mode] */
const write = (file, text, mode) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, mode === undefined ? undefined : { mode });
};

/** Every file and directory under `dir`, with its size and modification time, and `dir`'s own. */
const snapshot = (dir) => {
  const lines = [`. ${statSync(dir).mtimeMs}`];
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const file = path.join(current, name);
      const stat = statSync(file);
      lines.push(`${path.relative(dir, file)} ${stat.isDirectory() ? "dir" : stat.size} ${stat.mtimeMs}`);
      if (stat.isDirectory()) walk(file);
    }
  };
  walk(dir);
  return lines.join("\n");
};

describe("ampi-cli version ranges", () => {
  it("checks >= ranges on both sides of the bound", () => {
    assert.equal(satisfiesRange("22.19.0", ">=22.19.0"), true);
    assert.equal(satisfiesRange("22.18.9", ">=22.19.0"), false);
    assert.equal(satisfiesRange("24.0.0", ">=22.19.0"), true);
  });

  it("keeps ^ ranges below the next change of the first non-zero part", () => {
    assert.equal(satisfiesRange("1.3.0", "^1.3.0"), true);
    assert.equal(satisfiesRange("1.2.9", "^1.3.0"), false);
    assert.equal(satisfiesRange("1.99.4", "^1.3.0"), true);
    assert.equal(satisfiesRange("2.0.0", "^1.3.0"), false);
    assert.equal(satisfiesRange("0.3.1", "^0.3.1"), true);
    assert.equal(satisfiesRange("0.3.0", "^0.3.1"), false);
    assert.equal(satisfiesRange("0.3.9", "^0.3.1"), true);
    assert.equal(satisfiesRange("0.4.0", "^0.3.1"), false);
    assert.equal(satisfiesRange("0.0.3", "^0.0.3"), true);
    assert.equal(satisfiesRange("0.0.4", "^0.0.3"), false);
  });

  it("matches a plain version exactly and keeps pre-releases out unless the range names one", () => {
    assert.equal(satisfiesRange("1.3.0", "1.3.0"), true);
    assert.equal(satisfiesRange("1.3.1", "1.3.0"), false);
    assert.equal(satisfiesRange("1.4.0-beta.1", "^1.3.0"), false);
    assert.equal(satisfiesRange("2.0.0-rc.1", "^1.3.0"), false);
    assert.equal(satisfiesRange("1.3.0-beta.2", "^1.3.0-beta.1"), true);
    assert.equal(satisfiesRange("1.3.0-alpha", "^1.3.0-beta.1"), false);
  });

  it("reports other range forms and invalid versions as unknown", () => {
    for (const range of ["~1.3.0", "1.x", ">=1.0.0 <2.0.0", "*", "^1.3"]) assert.equal(satisfiesRange("1.3.0", range), undefined, range);
    assert.equal(satisfiesRange("1.3", "^1.3.0"), undefined);
  });

  it("orders versions by SemVer precedence", () => {
    const order = ["0.9.0", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.10.0"];
    for (let index = 1; index < order.length; index++) {
      assert.ok(compareVersions(parseVersion(order[index - 1]), parseVersion(order[index])) < 0, `${order[index - 1]} < ${order[index]}`);
    }
    assert.equal(compareVersions(parseVersion("1.0.0+build.1"), parseVersion("1.0.0")), 0);
    for (const text of ["1.0", "01.0.0", "v1.0.0", "1.0.0-", "latest"]) assert.equal(parseVersion(text), undefined, text);
  });
});

/**
 * A doctor host over a temporary agent directory, with Pi replaced by
 * hand-written answers and PATH by `pathDirs`.
 */
const makeHost = ({ pi = {}, fs = {}, env = {}, pathDirs = [], ...rest } = {}) => {
  const agentDir = pi.agentDir ?? freshDir("agent");
  const out = [];
  const err = [];
  /** @type {import("../packages/ampi-cli/src/doctor.js").DoctorPi} */
  const fakePi = {
    version: "1.3.0",
    agentDir,
    binDir: path.join(agentDir, "bin"),
    settingsErrors: () => [],
    credentialedModels: async () => ({ models: 3, providers: 1 }),
    extensionSources: async () => ({ enabled: [], missing: [], cachedPathOf: () => undefined }),
    ...pi,
  };
  return {
    host: {
      env: { PATH: pathDirs.join(path.delimiter), ...env },
      cwd: freshDir("project"),
      platform: "linux",
      nodeVersion: "24.0.0",
      cliRoot,
      loadPi: async () => fakePi,
      fs: { ...DOCTOR_FILE_SYSTEM, ...fs },
      isTTY: false,
      colorDepth: undefined,
      out: (text) => out.push(text),
      log: createLogger({ stderr: (text) => err.push(text) }),
      ...rest,
    },
    agentDir,
    out,
    err,
  };
};

/** The checks of one doctor run, by id. */
const checksOf = async (options) => {
  const { host } = makeHost(options);
  const checks = buildDoctorChecks(await gatherDoctorFacts(host));
  return Object.fromEntries(checks.map((check) => [check.id, check]));
};

describe("ampi doctor: checks through an injected host", () => {
  it("fails a Node.js below ampi-cli's engines range and passes its exact lower bound", async () => {
    const below = (await checksOf({ nodeVersion: "22.18.9" })).node;
    assert.equal(below.status, "fail");
    assert.equal(below.summary, "Node.js 22.18.9 is older than ampi-cli needs (>=22.19.0)");
    assert.equal(below.hint, "Install Node.js 22.19.0 or later.");
    assert.deepEqual((await checksOf({ nodeVersion: "22.19.0" })).node, { id: "node", status: "ok", summary: "Node.js 22.19.0 (ampi-cli needs >=22.19.0)" });
  });

  it("fails a Pi outside the loading ampi's peer range and passes its exact lower bound", async () => {
    const ampiVersion = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
    for (const version of ["1.2.9", "2.0.0"]) {
      const pi = (await checksOf({ pi: { version } })).pi;
      assert.equal(pi.status, "fail", version);
      assert.equal(pi.summary, `Pi ${version} is outside the Pi versions ampi ${ampiVersion} supports (^1.3.0)`);
    }
    assert.deepEqual((await checksOf({ pi: { version: "1.3.0" } })).pi, { id: "pi", status: "ok", summary: `Pi 1.3.0 (ampi ${ampiVersion} supports ^1.3.0)` });
    const missing = (await checksOf({ loadPi: async () => undefined })).pi;
    assert.equal(missing.status, "fail");
    assert.match(missing.summary, /cannot be loaded/);
  });

  it("finds rg in Pi's bin directory, accepts fdfind on PATH as fd, and warns when both are missing", async () => {
    const agentDir = freshDir("agent");
    write(path.join(agentDir, "bin", "rg"), "");
    const pathDir = freshDir("path");
    write(path.join(pathDir, "fdfind"), "#!/bin/sh\n", 0o755);
    // An rg on PATH that is not executable does not count; the bin directory's does.
    write(path.join(pathDir, "rg"), "", 0o644);
    const found = (await checksOf({ pi: { agentDir, binDir: path.join(agentDir, "bin") }, pathDirs: [pathDir] })).tools;
    assert.deepEqual(found, {
      id: "tools",
      status: "ok",
      summary: `rg in Pi's bin directory (${path.join(agentDir, "bin", "rg")}), fd (as fdfind) on PATH (${path.join(pathDir, "fdfind")})`,
    });

    const none = (await checksOf({ pathDirs: [freshDir("empty")] })).tools;
    assert.equal(none.status, "warn");
    assert.equal(none.summary, "rg not found, fd not found");
    assert.match(none.hint, /^Pi downloads rg and fd into .*bin on first use when it is online; or install them with the system package manager \(ripgrep and fd-find on Debian and Ubuntu\)\.$/);

    const onlyFd = freshDir("path");
    write(path.join(onlyFd, "fd"), "", 0o755);
    const half = (await checksOf({ pathDirs: [onlyFd] })).tools;
    assert.equal(half.status, "warn");
    assert.match(half.hint, /^Pi downloads rg into .* install it with the system package manager \(ripgrep on Debian and Ubuntu\)\.$/);
  });

  it("finds programs through Path and PATHEXT on Windows, in PATHEXT's order", async () => {
    const files = new Set(["D:\\bin\\git.EXE", "D:\\bin\\git.CMD", "C:\\tools\\git.CMD"]);
    const fs = { kind: (file) => (files.has(file) ? "file" : "missing"), executable: () => false };
    const env = { PATH: undefined, Path: "C:\\empty;D:\\bin;C:\\tools", PATHEXT: ".COM;.EXE;.CMD" };
    const git = (await checksOf({ platform: "win32", env, fs })).git;
    assert.deepEqual(git, { id: "git", status: "ok", summary: "git on PATH (D:\\bin\\git.EXE)" });
  });

  it("warns without git on PATH", async () => {
    const git = (await checksOf({ pathDirs: [freshDir("empty")] })).git;
    assert.equal(git.status, "warn");
    assert.equal(git.hint, "Install git: repo: search filters, adding skills from git and commit mentions need it.");
  });

  it("fails an agent directory that is not writable and warns about one that does not exist yet", async () => {
    const agentDir = freshDir("agent");
    const locked = (await checksOf({ pi: { agentDir }, fs: { writable: (dir) => dir !== agentDir } }))["agent-dir"];
    assert.equal(locked.status, "fail");
    assert.equal(locked.summary, `${agentDir} is not writable`);
    assert.match(locked.hint, /^Make .* writable for your user, or set PI_CODING_AGENT_DIR/);

    const absent = (await checksOf({ pi: { agentDir: path.join(agentDir, "not-yet") } }))["agent-dir"];
    assert.deepEqual(absent, { id: "agent-dir", status: "warn", summary: `${path.join(agentDir, "not-yet")} does not exist yet`, hint: "Pi creates it on its first start." });
    assert.equal((await checksOf({ pi: { agentDir } }))["agent-dir"].status, "ok");
  });

  it("warns about a damaged or newer thread index and accepts a missing index and live directory", async () => {
    const missing = (await checksOf({}))["ampi-data"];
    assert.deepEqual(missing, { id: "ampi-data", status: "ok", summary: "no thread index yet, no live registry yet" });

    const agentDir = freshDir("agent");
    const index = path.join(agentDir, "data", "ampi", "threads", "index.json");
    write(index, "{ not json");
    const corrupt = (await checksOf({ pi: { agentDir } }))["ampi-data"];
    assert.equal(corrupt.status, "warn");
    assert.equal(corrupt.summary, "thread index unreadable, no live registry yet");
    assert.equal(corrupt.hint, `${index} is not a thread index ampi can read; start Pi with ampi once to set it aside.`);

    write(index, JSON.stringify({ version: 2, threads: {} }));
    const newer = (await checksOf({ pi: { agentDir } }))["ampi-data"];
    assert.equal(newer.status, "warn");
    assert.equal(newer.hint, `${index} has index version 2, written by a newer ampi; update ampi-cli to use it.`);

    write(index, JSON.stringify({ version: 1, threads: { a: {}, b: { labels: ["x"] } } }));
    write(path.join(agentDir, "data", "ampi", "live", "123.json"), "{}");
    const fine = (await checksOf({ pi: { agentDir } }))["ampi-data"];
    assert.deepEqual(fine, { id: "ampi-data", status: "ok", summary: "thread index readable (2 sessions), live registry readable (1 entry)" });

    const denied = Object.assign(new Error("EACCES: permission denied, scandir"), { code: "EACCES" });
    const unreadable = (await checksOf({ pi: { agentDir }, fs: { readDir: () => { throw denied; } } }))["ampi-data"];
    assert.equal(unreadable.status, "warn");
    assert.equal(unreadable.hint, "EACCES: permission denied, scandir; check the directory's permissions.");
  });

  it("fails without credentials and reports the count with them", async () => {
    const none = (await checksOf({ pi: { credentialedModels: async () => ({ models: 0, providers: 0 }) } })).models;
    assert.deepEqual(none, {
      id: "models",
      status: "fail",
      summary: "no model has credentials",
      hint: "Run /login in a session, or set a provider's API key variable (Pi's docs/providers.md lists them).",
    });
    const some = (await checksOf({ pi: { credentialedModels: async () => ({ models: 1, providers: 1 }) } })).models;
    assert.deepEqual(some, { id: "models", status: "ok", summary: "credentials for 1 model from 1 provider" });
  });

  it("reports the ampi that comes with ampi-cli when Pi loads none", async () => {
    const ampi = (await checksOf({})).ampi;
    const version = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
    assert.deepEqual(ampi, { id: "ampi", status: "ok", summary: `ampi ${version} that comes with ampi-cli loads (${repoRoot})` });
  });

  it("adds the terminal line only when stdout is a terminal", async () => {
    assert.equal((await checksOf({})).terminal, undefined);
    const terminal = (await checksOf({ isTTY: true, colorDepth: 24, env: { TERM: "xterm-256color", COLORTERM: "truecolor" } })).terminal;
    assert.deepEqual(terminal, { id: "terminal", status: "ok", summary: "TERM=xterm-256color, COLORTERM=truecolor, 24-bit color" });
  });
});

describe("ampi doctor: output and exit status", () => {
  it("prints the JSON shape with hints only on checks that are not ok, and exits 0 with only warnings", async () => {
    const { host, out, err } = makeHost({ pathDirs: [freshDir("empty")] });
    assert.equal(await runDoctorCommand(["--json"], host), 0);
    assert.deepEqual(err, []);
    assert.equal(out.length, 1);
    assert.ok(out[0].endsWith("}\n"));
    const document = JSON.parse(out[0]);
    assert.deepEqual(Object.keys(document), ["checks"]);
    assert.deepEqual(
      document.checks.map((check) => [check.id, check.status]),
      [["node", "ok"], ["pi", "ok"], ["ampi", "ok"], ["parts", "ok"], ["agent-dir", "ok"], ["tools", "warn"], ["git", "warn"], ["models", "ok"], ["ampi-data", "ok"]],
    );
    for (const check of document.checks) {
      assert.deepEqual(Object.keys(check), check.status === "ok" ? ["id", "status", "summary"] : ["id", "status", "summary", "hint"], check.id);
    }
    assert.equal(out[0], `${JSON.stringify(document, null, 2)}\n`);
  });

  it("prints one line per check, then the hints, and exits 1 when one check fails", async () => {
    const { host, out } = makeHost({ pathDirs: [freshDir("empty")], nodeVersion: "20.0.0" });
    assert.equal(await runDoctorCommand([], host), 1);
    const lines = out.join("").split("\n");
    assert.equal(lines[0], "fail  node       Node.js 20.0.0 is older than ampi-cli needs (>=22.19.0)");
    assert.equal(lines[5], "warn  tools      rg not found, fd not found");
    assert.match(lines[4], /^ok {4}agent-dir {2}/);
    assert.equal(lines[9], "");
    assert.deepEqual(lines.slice(10).map((line) => line.split(":")[0]), ["node", "tools", "git", ""]);
    assert.doesNotMatch(out.join(""), /\u001b\[/);
  });

  it("colors the status words on a terminal, unless NO_COLOR is set", async () => {
    const checks = [{ id: "git", status: "warn", summary: "git not found on PATH", hint: "Install git." }];
    assert.equal(formatDoctorText(checks, { color: true }), "\u001b[33mwarn\u001b[0m  git        git not found on PATH\n\ngit: Install git.\n");
    const { host, out } = makeHost({ isTTY: true, env: { NO_COLOR: "1" } });
    await runDoctorCommand([], host);
    assert.doesNotMatch(out.join(""), /\u001b\[/);
  });

  it("exits 2 on an unknown option or an argument and prints the help on --help", async () => {
    for (const argv of [["--fix"], ["now"]]) {
      const { host, out, err } = makeHost();
      assert.equal(await runDoctorCommand(argv, host), 2, argv.join(" "));
      assert.deepEqual(out, []);
      assert.match(err.join(""), /^ampi: doctor: .*\nRun ampi doctor --help for the options\.\n$/);
    }
    const { host, out } = makeHost({ loadPi: async () => assert.fail("--help loads no Pi") });
    assert.equal(await runDoctorCommand(["--help"], host), 0);
    assert.match(out.join(""), /^ampi doctor: /);
    assert.match(out.join(""), /installs nothing/);
  });
});

describe("ampi doctor: through the installed Pi", () => {
  const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
  /** @type {any} */
  let pi;
  const agentDir = freshDir("agent");
  const project = freshDir("project");

  before(async () => {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_OFFLINE = "1";
    pi = await import("@earendil-works/pi-coding-agent");
  });
  after(() => {
    for (const [name, value] of [
      ["PI_CODING_AGENT_DIR", saved.agentDir],
      ["PI_OFFLINE", saved.offline],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const checksWithPi = async () => {
    const { host } = makeHost({ cwd: project });
    host.cwd = project;
    host.loadPi = async () => createDoctorPi(pi, project);
    const checks = buildDoctorChecks(await gatherDoctorFacts(host));
    return Object.fromEntries(checks.map((check) => [check.id, check]));
  };

  it("fails an unparsable user settings.json and project .pi/settings.json, naming each file", async () => {
    const user = path.join(agentDir, "settings.json");
    const projectSettings = path.join(project, ".pi", "settings.json");
    write(user, '{ "theme": "dark", }');
    write(projectSettings, "{ bad }");
    try {
      const before = snapshot(agentDir);
      const check = (await checksWithPi())["agent-dir"];
      assert.equal(check.status, "fail");
      assert.equal(
        check.summary,
        `${user} does not parse (invalid JSON at line 1, column 20); ${projectSettings} does not parse (invalid JSON at line 1, column 3)`,
      );
      assert.equal(check.hint, `Fix ${user} or move it aside; fix ${projectSettings} or move it aside.`);
      assert.equal(snapshot(agentDir), before, "reading the settings leaves the agent directory as it was");
    } finally {
      rmSync(user);
      rmSync(path.join(project, ".pi"), { recursive: true });
    }
  });

  it("names Pi's copy of ampi when the settings list a local ampi package, and a git source Pi has not installed yet", async () => {
    const standIn = path.join(freshDir("ampi"), "@skippermissions", "ampi");
    write(path.join(standIn, "package.json"), JSON.stringify({ name: "@skippermissions/ampi", version: "9.9.7", pi: { extensions: ["./index.ts"] }, peerDependencies: { "@earendil-works/pi-coding-agent": "^9.0.0" } }));
    write(path.join(standIn, "index.ts"), "export default function () {}\n");
    const settings = path.join(agentDir, "settings.json");
    write(settings, JSON.stringify({ packages: [standIn] }));
    try {
      const checks = await checksWithPi();
      assert.deepEqual(checks.ampi, { id: "ampi", status: "ok", summary: `ampi 9.9.7 that Pi loads (${standIn}); ampi-cli adds no copy of its own` });
      // The Pi range comes from the copy that loads.
      assert.equal(checks.pi.summary, `Pi ${pi.VERSION} is outside the Pi versions ampi 9.9.7 supports (^9.0.0)`);

      write(settings, JSON.stringify({ packages: ["git:github.com/5omeOtherGuy/ampi"] }));
      const pending = (await checksWithPi()).ampi;
      assert.deepEqual(pending, {
        id: "ampi",
        status: "ok",
        summary: "Pi's settings list ampi (git:github.com/5omeOtherGuy/ampi), not installed yet: Pi installs it on its next start, and ampi-cli adds no copy of its own",
      });
    } finally {
      rmSync(settings);
    }
  });
});

describe("ampi doctor: spawned", () => {
  /** @param {string[]} args @param {Record<string, string>} env @param {string} cwd */
  const runDoctor = (args, env, cwd, preload = []) =>
    spawnSync(process.execPath, [...preload, bin, "doctor", ...args], { cwd, env: { PATH: nodeDir, PI_OFFLINE: "1", ...env }, encoding: "utf8" });

  it("starts no program, makes no network request and writes nothing, even with a !command key in auth.json", () => {
    const dir = freshDir("spawn");
    const agentDir = path.join(dir, "agent");
    const marker = path.join(dir, "command-ran");
    write(path.join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
    write(path.join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: `!${process.execPath} -e "require('fs').writeFileSync('${marker}', '')"` } }));
    write(path.join(agentDir, "bin", "rg"), "");
    write(path.join(agentDir, "data", "ampi", "threads", "index.json"), JSON.stringify({ version: 1, threads: {} }));
    write(path.join(agentDir, "data", "ampi", "live", "4242.json"), "{}");
    const project = path.join(dir, "project");
    write(path.join(project, ".pi", "settings.json"), "{}");
    const guardLog = path.join(dir, "guard.jsonl");
    write(guardLog, "");
    const before = snapshot(agentDir);
    const projectBefore = snapshot(project);

    const result = runDoctor(["--json"], { HOME: path.join(dir, "home"), PI_CODING_AGENT_DIR: agentDir, AMPI_TEST_GUARD_LOG: guardLog }, project, ["--import", guard]);
    assert.equal(result.stderr, "");
    assert.equal(readFileSync(guardLog, "utf8"), "", "no child process and no network attempt");
    assert.equal(snapshot(agentDir), before);
    assert.equal(snapshot(project), projectBefore);
    assert.throws(() => statSync(marker), { code: "ENOENT" });
    const checks = Object.fromEntries(JSON.parse(result.stdout).checks.map((check) => [check.id, check]));
    assert.equal(checks.models.status, "ok", "a !command key counts without running");
    assert.equal(checks.tools.summary, `rg in Pi's bin directory (${path.join(agentDir, "bin", "rg")}), fd not found`);
    assert.equal(checks.git.status, "warn");
    assert.equal(result.status, 0);
  });

  it("runs a project's npmCommand for Pi's package lookup only once Pi trusts the project", () => {
    const dir = freshDir("spawn");
    const agentDir = path.join(dir, "agent");
    const fakeBin = path.join(dir, "bin");
    const pathLog = path.join(dir, "path-npm.jsonl");
    const projectLog = path.join(dir, "project-npm.jsonl");
    /** An npm that logs its arguments and answers `root -g` with an empty directory. */
    const fakeNpm = (log) =>
      `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.stdout.write(${JSON.stringify(path.join(dir, "global"))} + "\\n");\n`;
    write(path.join(fakeBin, "npm"), fakeNpm(pathLog), 0o755);
    // An npm package Pi has not installed, so its lookup asks npm for the global directory.
    write(path.join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:@probe/not-installed"] }));
    const project = path.join(dir, "project");
    write(path.join(project, "tools", "npm"), fakeNpm(projectLog), 0o755);
    write(path.join(project, ".pi", "settings.json"), JSON.stringify({ npmCommand: [path.join(project, "tools", "npm")] }));
    const logged = (file) => {
      try {
        return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    };
    const env = { HOME: path.join(dir, "home"), PI_CODING_AGENT_DIR: agentDir, PATH: `${fakeBin}${path.delimiter}${nodeDir}` };

    const untrusted = runDoctor(["--json"], env, project);
    assert.equal(untrusted.stderr, "");
    assert.deepEqual(logged(projectLog), [], "the untrusted project's npmCommand did not run");
    assert.deepEqual(logged(pathLog), [["root", "-g"]], "the lookup ran npm from PATH");

    // Pi's trust store: the decision for the directory's real path.
    write(path.join(agentDir, "trust.json"), JSON.stringify({ [realpathSync(project)]: true }));
    const trusted = runDoctor(["--json"], env, project);
    assert.equal(trusted.stderr, "");
    assert.deepEqual(logged(projectLog), [["root", "-g"]], "a trusted project's npmCommand runs");
    assert.deepEqual(logged(pathLog), [["root", "-g"]]);
  });

  it("counts a provider key from the environment without printing it, and fails without one", () => {
    const dir = freshDir("spawn");
    const env = { HOME: path.join(dir, "home"), PI_CODING_AGENT_DIR: path.join(dir, "agent") };
    const key = ["doctor", "probe", "value", "7351"].join("-");

    const without = runDoctor([], env, dir);
    assert.equal(without.status, 1);
    assert.match(without.stdout, /^fail {2}models {5}no model has credentials$/m);

    const withKey = runDoctor([], { ...env, ANTHROPIC_API_KEY: key }, dir);
    assert.match(withKey.stdout, /^ok {4}models {5}credentials for \d+ models? from 1 provider$/m);
    for (const text of [withKey.stdout, withKey.stderr, without.stdout, without.stderr]) assert.ok(!text.includes(key));
  });
});

/** A stand-in global npm directory holding an ampi-cli package of `version`. */
const fakeGlobal = (version) => {
  const globalRoot = freshDir("global");
  const installed = path.join(globalRoot, "@skippermissions", "ampi-cli");
  write(path.join(installed, "package.json"), JSON.stringify({ name: "@skippermissions/ampi-cli", version }));
  return { globalRoot: realpathSync(globalRoot), installed };
};

/**
 * An injected npm: `root -g` answers `globalRoot`, `view` the versions in
 * `published` (the first is the latest), `install` exits with `installStatus`.
 */
const fakeRunner = ({ globalRoot, published = [], viewError, installStatus = 0 }) => {
  const calls = [];
  const notFound = (what) => ({ status: 1, stdout: "", stderr: `npm error code E404\nnpm error 404 ${what}\nnpm error 404\nnpm error A complete log of this run can be found in: /x.log\n` });
  return {
    calls,
    runNpm: (args) => {
      calls.push(args);
      if (args[0] === "root") return { status: 0, stdout: `${globalRoot}\n`, stderr: "" };
      if (args[0] === "view") {
        if (viewError) return viewError;
        const [, version] = args[1].split(/(?<=.)@/);
        if (version === undefined) return published.length > 0 ? { status: 0, stdout: `${published[0]}\n`, stderr: "" } : notFound("Not Found - GET https://registry.example/@skippermissions%2fampi-cli - Not found");
        return published.includes(version) ? { status: 0, stdout: `${version}\n`, stderr: "" } : notFound(`No match found for version ${version}`);
      }
      if (args[0] === "install") {
        return installStatus === 0
          ? { status: 0, stdout: "changed 3 packages in 1s\n", stderr: "" }
          : { status: installStatus, stdout: "", stderr: "npm error code EACCES\nnpm error syscall rename\nnpm error permission denied\n" };
      }
      return { status: 1, stdout: "", stderr: `unexpected npm ${args.join(" ")}` };
    },
  };
};

const runUpdate = (argv, { cliRoot: root, ...runner }) => {
  const out = [];
  const err = [];
  const npm = fakeRunner(runner);
  const code = runUpdateCommand(argv, {
    cliRoot: root,
    runNpm: npm.runNpm,
    realpath: (file) => realpathSync(file),
    out: (text) => out.push(text),
    progress: (text) => err.push(text),
    log: createLogger({ stderr: (text) => err.push(text) }),
  });
  return { code, out: out.join(""), err: err.join(""), calls: npm.calls };
};

describe("ampi update: through an injected npm", () => {
  it("installs nothing when the installed version is the latest or newer", () => {
    const { globalRoot, installed } = fakeGlobal("0.2.0");
    const same = runUpdate(["--porcelain"], { cliRoot: installed, globalRoot, published: ["0.2.0"] });
    assert.equal(same.code, 0, same.err);
    assert.equal(same.out, "no update needed\n");
    assert.deepEqual(same.calls, [["root", "-g"], ["view", "@skippermissions/ampi-cli", "version"]]);
    const newer = runUpdate([], { cliRoot: installed, globalRoot, published: ["0.1.0"] });
    assert.equal(newer.code, 0);
    assert.equal(newer.out, "ampi-cli 0.2.0 is installed, newer than the latest published version 0.1.0; no update needed.\n");
    assert.equal(newer.calls.length, 2);
  });

  it("installs a newer latest version and prints exactly one porcelain line", () => {
    const { globalRoot, installed } = fakeGlobal("0.1.0");
    const result = runUpdate(["--porcelain"], { cliRoot: installed, globalRoot, published: ["0.2.0"] });
    assert.equal(result.code, 0, result.err);
    assert.equal(result.out, "updated 0.2.0\n");
    assert.deepEqual(result.calls.at(-1), ["install", "-g", "--ignore-scripts", "@skippermissions/ampi-cli@0.2.0"]);
    assert.match(result.err, /changed 3 packages/);
    const plain = runUpdate([], { cliRoot: installed, globalRoot, published: ["0.2.0"] });
    assert.equal(plain.out, "ampi-cli updated from 0.1.0 to 0.2.0.\n");
  });

  it("installs the --target-version, older or newer, and refuses one that is invalid or unknown", () => {
    const { globalRoot, installed } = fakeGlobal("0.1.0");
    for (const [argv, version] of [
      [["--target-version", "0.0.5"], "0.0.5"],
      [["--target-version=0.1.5", "--porcelain"], "0.1.5"],
    ]) {
      const result = runUpdate(argv, { cliRoot: installed, globalRoot, published: ["0.2.0", "0.1.5", "0.0.5"] });
      assert.equal(result.code, 0, result.err);
      assert.deepEqual(result.calls[1], ["view", `@skippermissions/ampi-cli@${version}`, "version"]);
      assert.deepEqual(result.calls[2], ["install", "-g", "--ignore-scripts", `@skippermissions/ampi-cli@${version}`]);
    }
    const sameTarget = runUpdate(["--target-version", "0.1.0", "--porcelain"], { cliRoot: installed, globalRoot, published: ["0.1.0"] });
    assert.equal(sameTarget.out, "no update needed\n");

    const invalid = runUpdate(["--target-version", "latest"], { cliRoot: installed, globalRoot, published: ["0.2.0"] });
    assert.equal(invalid.code, 2);
    assert.deepEqual(invalid.calls, []);
    assert.match(invalid.err, /^ampi: update: --target-version needs a version such as 0\.4\.0, not "latest"\.\nRun ampi update --help/);

    const unknown = runUpdate(["--target-version", "0.9.0"], { cliRoot: installed, globalRoot, published: ["0.2.0"] });
    assert.equal(unknown.code, 1);
    assert.equal(unknown.out, "");
    assert.equal(unknown.err, "ampi: @skippermissions/ampi-cli 0.9.0 is not on the npm registry (npm: 404 No match found for version 0.9.0).\n");
    assert.ok(!unknown.calls.some((args) => args[0] === "install"));
  });

  it("explains an npm view E404 or other failure in one line", () => {
    const { globalRoot, installed } = fakeGlobal("0.1.0");
    const missing = runUpdate(["--porcelain"], { cliRoot: installed, globalRoot, published: [] });
    assert.equal(missing.code, 1);
    assert.equal(missing.out, "");
    assert.equal(missing.err, "ampi: @skippermissions/ampi-cli is not on the npm registry (npm: 404 Not Found - GET https://registry.example/@skippermissions%2fampi-cli - Not found).\n");

    const offline = { status: 1, stdout: "", stderr: "npm error code ENOTFOUND\nnpm error network request to https://registry.example failed\nnpm error A complete log of this run can be found in: /x.log\n" };
    const failed = runUpdate([], { cliRoot: installed, globalRoot, viewError: offline });
    assert.equal(failed.code, 1);
    assert.equal(failed.err, "ampi: npm view @skippermissions/ampi-cli version failed: network request to https://registry.example failed.\n");
  });

  it("exits 1 with npm's status and the end of its stderr when the install fails", () => {
    const { globalRoot, installed } = fakeGlobal("0.1.0");
    const result = runUpdate(["--porcelain"], { cliRoot: installed, globalRoot, published: ["0.2.0"], installStatus: 243 });
    assert.equal(result.code, 1);
    assert.equal(result.out, "");
    assert.match(result.err, /ampi: npm install -g --ignore-scripts @skippermissions\/ampi-cli@0\.2\.0 exited with status 243:\nnpm error code EACCES\nnpm error syscall rename\nnpm error permission denied\n$/);
  });

  it("refuses an ampi-cli that is not npm's global install, without asking the registry", () => {
    const { globalRoot } = fakeGlobal("0.1.0");
    const elsewhere = path.join(freshDir("tools"), "node_modules", "@skippermissions", "ampi-cli");
    write(path.join(elsewhere, "package.json"), JSON.stringify({ name: "@skippermissions/ampi-cli", version: "0.1.0" }));
    const result = runUpdate([], { cliRoot: elsewhere, globalRoot, published: ["0.2.0"] });
    assert.equal(result.code, 1);
    assert.deepEqual(result.calls, [["root", "-g"]]);
    assert.match(result.err, /is not the one npm installs globally .* update it with whatever installed it\.\n$/);
  });

  it("names the update command of npx, pnpm, yarn and bun installs", () => {
    const advice = (where) => otherInstallAdvice(where, "/usr/lib/node_modules", "latest");
    assert.match(advice("/home/u/.npm/_npx/1a2b/node_modules/@skippermissions/ampi-cli"), /npx's cache .* run npx @skippermissions\/ampi-cli@latest/);
    assert.match(advice("/home/u/.local/share/pnpm/global/5/.pnpm/x/node_modules/@skippermissions/ampi-cli"), /pnpm add -g @skippermissions\/ampi-cli@latest/);
    assert.match(advice("/home/u/.config/yarn/global/node_modules/@skippermissions/ampi-cli"), /yarn global add @skippermissions\/ampi-cli@latest/);
    assert.match(advice("/home/u/.bun/install/global/node_modules/@skippermissions/ampi-cli"), /bun add -g @skippermissions\/ampi-cli@latest/);
    assert.match(otherInstallAdvice("C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\9\\node_modules\\@skippermissions\\ampi-cli", "C:\\npm", "0.4.0"), /npx @skippermissions\/ampi-cli@0\.4\.0/);
  });
});

describe("ampi update: spawned against a fake npm", () => {
  const fakeBin = freshDir("fakebin");
  const npmLog = path.join(freshDir("log"), "npm.jsonl");
  write(
    path.join(fakeBin, "npm"),
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "root" && args[1] === "-g") { process.stdout.write(process.env.FAKE_NPM_ROOT + "\\n"); process.exit(0); }
if (args[0] === "view") {
  if (process.env.FAKE_NPM_VIEW_E404) { process.stderr.write("npm error code E404\\nnpm error 404 Not Found - GET https://registry.example/x - Not found\\n"); process.exit(1); }
  process.stdout.write(process.env.FAKE_NPM_VIEW + "\\n"); process.exit(0);
}
if (args[0] === "install") { process.stdout.write("changed 1 package\\n"); process.exit(Number(process.env.FAKE_NPM_INSTALL_STATUS || 0)); }
process.exit(1);
`,
    0o755,
  );

  /** A copy of the ampi-cli package at `<global>/@skippermissions/ampi-cli`, at `version`. */
  const installCopy = (version) => {
    const globalRoot = freshDir("global");
    const copy = path.join(globalRoot, "@skippermissions", "ampi-cli");
    cpSync(cliRoot, copy, { recursive: true });
    const manifest = JSON.parse(readFileSync(path.join(copy, "package.json"), "utf8"));
    writeFileSync(path.join(copy, "package.json"), JSON.stringify({ ...manifest, version }));
    return { globalRoot, copyBin: path.join(copy, "bin", "ampi.js") };
  };
  const logged = () => readFileSync(npmLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const run = (binPath, args, env) => {
    writeFileSync(npmLog, "");
    return spawnSync(process.execPath, [binPath, ...args], {
      cwd: root,
      env: { PATH: `${fakeBin}${path.delimiter}${nodeDir}`, HOME: freshDir("home"), FAKE_NPM_LOG: npmLog, ...env },
      encoding: "utf8",
    });
  };

  it("updates a global install to the version npm reports and prints one porcelain line", () => {
    const { globalRoot, copyBin } = installCopy("0.1.0");
    const updated = run(copyBin, ["update", "--porcelain"], { FAKE_NPM_ROOT: globalRoot, FAKE_NPM_VIEW: "0.2.0" });
    assert.equal(updated.status, 0, updated.stderr);
    assert.equal(updated.stdout, "updated 0.2.0\n");
    assert.match(updated.stderr, /changed 1 package/);
    assert.deepEqual(logged(), [["root", "-g"], ["view", "@skippermissions/ampi-cli", "version"], ["install", "-g", "--ignore-scripts", "@skippermissions/ampi-cli@0.2.0"]]);

    const current = run(copyBin, ["up", "--porcelain"], { FAKE_NPM_ROOT: globalRoot, FAKE_NPM_VIEW: "0.1.0" });
    assert.equal(current.status, 0, current.stderr);
    assert.equal(current.stdout, "no update needed\n");
    assert.equal(logged().length, 2);
  });

  it("exits 1 on an E404 from npm view and on a failing install", () => {
    const { globalRoot, copyBin } = installCopy("0.1.0");
    const missing = run(copyBin, ["update"], { FAKE_NPM_ROOT: globalRoot, FAKE_NPM_VIEW_E404: "1" });
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout, "");
    assert.equal(missing.stderr, "ampi: @skippermissions/ampi-cli is not on the npm registry (npm: 404 Not Found - GET https://registry.example/x - Not found).\n");
    const failed = run(copyBin, ["update"], { FAKE_NPM_ROOT: globalRoot, FAKE_NPM_VIEW: "0.2.0", FAKE_NPM_INSTALL_STATUS: "1" });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /exited with status 1\.\n$/);
  });

  it("refuses the source checkout without calling npm at all", () => {
    const result = run(bin, ["update"], { FAKE_NPM_ROOT: root, FAKE_NPM_VIEW: "9.9.9" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^ampi: this ampi runs from a source checkout of the ampi repository \(.*\), so ampi update leaves it alone\. Update it with git pull and npm ci in /);
    assert.deepEqual(logged(), []);
  });

  it("exits 2 when ampi's update options and Pi's update arguments are mixed", () => {
    const result = run(bin, ["update", "--porcelain", "--extensions"], {});
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "ampi: --porcelain is an option of ampi's own update, and --extensions goes to Pi's update; run them as two commands.\nRun ampi update --help for both.\n",
    );
    assert.deepEqual(logged(), []);
  });
});
