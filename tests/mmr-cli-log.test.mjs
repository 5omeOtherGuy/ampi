// The `ampi` command's diagnostics and colour (packages/ampi-cli/src/log.js):
// level filtering, the log file, the settings from flags and environment
// variables, the colour decision and the environment Pi and its tools
// inherit, and a guard that every diagnostic of the command goes through the
// logger. The spawned runs use the installed Pi offline, with the scripted
// model in tests/fixtures/ampi-cli/faux-model, in a temporary home and agent
// directory.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { applyColorToEnv, createLogger, readLogSettings, useColor } from "../packages/ampi-cli/src/log.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cliSrc = path.join(repoRoot, "packages", "ampi-cli", "src");
const bin = path.join(repoRoot, "packages", "ampi-cli", "bin", "ampi.js");
const fauxModel = path.join(import.meta.dirname, "fixtures", "ampi-cli", "faux-model");
const dir = mkdtempSync(path.join(tmpdir(), "ampi-cli-log-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A logger that collects what it writes to stderr. */
const collecting = (settings = {}) => {
  const stderr = [];
  return { stderr, log: createLogger({ ...settings, stderr: (text) => stderr.push(text) }) };
};
const writeAll = (log) => {
  log.error("an error");
  log.warn("a warning");
  log.info("a note");
  log.debug("a detail");
};
const modeOf = (file) => statSync(file).mode & 0o777;

describe("ampi log: levels", () => {
  it("writes each message as `ampi: <message>` on stderr, at info and above by default", () => {
    const { stderr, log } = collecting();
    writeAll(log);
    assert.deepEqual(stderr, ["ampi: an error\n", "ampi: a warning\n", "ampi: a note\n"]);
  });

  it("hides a warning at error, shows it at warn, and shows debug lines only at debug", () => {
    const at = (level) => {
      const { stderr, log } = collecting({ level });
      writeAll(log);
      return stderr;
    };
    assert.deepEqual(at("error"), ["ampi: an error\n"]);
    assert.deepEqual(at("warn"), ["ampi: an error\n", "ampi: a warning\n"]);
    assert.deepEqual(at("debug"), ["ampi: an error\n", "ampi: a warning\n", "ampi: a note\n", "ampi: a detail\n"]);
  });
});

describe("ampi log: the log file", () => {
  it("appends one line per message with the time and level, keeps errors on stderr too, and creates the file with mode 0600", () => {
    const file = path.join(dir, "unit.log");
    const times = [new Date("2026-10-19T08:00:00.000Z"), new Date("2026-10-19T08:00:01.500Z"), new Date("2026-10-19T08:00:02.000Z")];
    const { stderr, log } = collecting({ level: "warn", file, now: () => times.shift() });
    log.warn("first");
    log.info("hidden at warn");
    log.error("failed\nRun ampi --help for the supported options.");
    // A second logger on the same file, as a second run would have.
    collecting({ file, now: () => times.shift() }).log.info("second run");
    assert.equal(
      readFileSync(file, "utf8"),
      [
        "2026-10-19T08:00:00.000Z warn first",
        "2026-10-19T08:00:01.500Z error failed\\nRun ampi --help for the supported options.",
        "2026-10-19T08:00:02.000Z info second run",
        "",
      ].join("\n"),
    );
    assert.deepEqual(stderr, ["ampi: failed\nRun ampi --help for the supported options.\n"]);
    assert.equal(modeOf(file), 0o600);
  });

  it("says once that the file cannot be written and writes the rest to stderr", () => {
    const file = path.join(dir, "missing", "ampi.log");
    const { stderr, log } = collecting({ file });
    log.warn("one");
    log.error("two");
    assert.equal(stderr.length, 3);
    assert.match(stderr[0], new RegExp(`^ampi: could not write the log file ${file.replaceAll("\\", "\\\\")}, so diagnostics go to stderr: `));
    assert.deepEqual(stderr.slice(1), ["ampi: one\n", "ampi: two\n"]);
  });
});

describe("ampi log: settings", () => {
  const cwd = path.join(dir, "project");

  it("defaults to info without a file, and reads AMPI_LOG_LEVEL and AMPI_LOG_FILE, resolving the file against the directory", () => {
    assert.deepEqual(readLogSettings({}, {}, cwd), { level: "info" });
    assert.deepEqual(readLogSettings({}, { AMPI_LOG_LEVEL: "", AMPI_LOG_FILE: "" }, cwd), { level: "info" });
    assert.deepEqual(readLogSettings({}, { AMPI_LOG_LEVEL: "warn", AMPI_LOG_FILE: "logs/ampi.log" }, cwd), {
      level: "warn",
      file: path.join(cwd, "logs", "ampi.log"),
    });
  });

  it("lets --log-level and --log-file win over the variables", () => {
    const env = { AMPI_LOG_LEVEL: "error", AMPI_LOG_FILE: "/var/env.log" };
    assert.deepEqual(readLogSettings({ logLevel: "debug", logFile: "/var/flag.log" }, env, cwd), { level: "debug", file: "/var/flag.log" });
    // A flag that is valid also hides a variable that is not.
    assert.deepEqual(readLogSettings({ logLevel: "info" }, { AMPI_LOG_LEVEL: "loud" }, cwd), { level: "info" });
  });

  it("refuses an unknown level in AMPI_LOG_LEVEL", () => {
    assert.deepEqual(readLogSettings({}, { AMPI_LOG_LEVEL: "loud" }, cwd), { level: "info", error: 'AMPI_LOG_LEVEL must be error, warn, info or debug, not "loud".' });
    assert.deepEqual(readLogSettings({ logFile: "ampi.log" }, { AMPI_LOG_LEVEL: "loud" }, cwd), {
      level: "info",
      file: path.join(cwd, "ampi.log"),
      error: 'AMPI_LOG_LEVEL must be error, warn, info or debug, not "loud".',
    });
  });
});

describe("ampi colour", () => {
  it("decides colour from the flags, then NO_COLOR, then whether stdout and stderr are terminals", () => {
    for (const [color, env, stdoutIsTTY, stderrIsTTY, expected] of [
      [undefined, {}, true, true, true],
      [undefined, {}, true, false, false],
      [undefined, {}, false, true, false],
      [undefined, { NO_COLOR: "1" }, true, true, false],
      [undefined, { NO_COLOR: "" }, true, true, true],
      [true, {}, false, false, true],
      [true, { NO_COLOR: "1" }, false, false, true],
      [false, {}, true, true, false],
      [false, { FORCE_COLOR: "1" }, true, true, false],
    ]) {
      assert.equal(useColor({ color, env, stdoutIsTTY, stderrIsTTY }), expected, JSON.stringify({ color, env, stdoutIsTTY, stderrIsTTY }));
    }
  });

  it("hands --no-color and --color on as NO_COLOR or FORCE_COLOR, and leaves the environment alone without them", () => {
    const apply = (color, env) => {
      applyColorToEnv(color, env);
      return env;
    };
    assert.deepEqual(apply(false, { FORCE_COLOR: "3", TERM: "xterm" }), { NO_COLOR: "1", TERM: "xterm" });
    assert.deepEqual(apply(true, { NO_COLOR: "1", TERM: "xterm" }), { FORCE_COLOR: "1", TERM: "xterm" });
    assert.deepEqual(apply(undefined, { NO_COLOR: "x", FORCE_COLOR: "0" }), { NO_COLOR: "x", FORCE_COLOR: "0" });
  });
});

describe("ampi log: the command", { concurrency: true }, () => {
  let runs = 0;

  /**
   * Run the command with piped stdin and stdout in its own home, agent
   * directory and project, or in an earlier run's.
   *
   * @param {string[]} args
   * @param {{ env?: Record<string, string>, root?: string, faux?: boolean }} [options]
   */
  const runAmpi = (args, { env = {}, root = path.join(dir, `run-${++runs}`), faux = false } = {}) => {
    for (const sub of ["home", "agent", "project"]) mkdirSync(path.join(root, sub), { recursive: true });
    const model = faux ? ["-e", fauxModel, "--model", "faux/faux-1"] : [];
    const child = spawn(process.execPath, [bin, ...model, ...args], {
      cwd: path.join(root, "project"),
      env: { PATH: process.env.PATH, HOME: path.join(root, "home"), PI_CODING_AGENT_DIR: path.join(root, "agent"), PI_OFFLINE: "1", ...env },
    });
    child.stdin.end();
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const log = (name) => readFileSync(path.join(root, "project", name), "utf8");
    return new Promise((resolve) => child.on("close", (status) => resolve({ root, status, stdout, stderr, log, file: (name) => path.join(root, "project", name) })));
  };

  it("appends its debug lines to --log-file across two runs, in a file with mode 0600, and leaves stderr empty", async () => {
    const first = await runAmpi(["--log-level", "debug", "--log-file", "ampi.log", "--help"]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stderr, "");
    assert.match(first.stdout, /^ampi: Pi with the ampi extensions/);
    const second = await runAmpi(["--log-level=debug", "--log-file=ampi.log", "--help"], { root: first.root });
    assert.equal(second.status, 0, second.stderr);
    const lines = second.log("ampi.log").trimEnd().split("\n");
    assert.equal(lines.length, 2, second.log("ampi.log"));
    for (const line of lines) assert.match(line, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z debug command: help$/);
    assert.equal(modeOf(second.file("ampi.log")), 0o600);
  });

  it("reads AMPI_LOG_LEVEL and AMPI_LOG_FILE, and the flag wins over the variable", async () => {
    const fromEnv = await runAmpi(["--help"], { env: { AMPI_LOG_LEVEL: "debug", AMPI_LOG_FILE: "env.log" } });
    assert.equal(fromEnv.status, 0, fromEnv.stderr);
    assert.match(fromEnv.log("env.log"), / debug command: help\n$/);
    const flagWins = await runAmpi(["--log-level", "info", "--log-file", "flag.log", "--help"], { env: { AMPI_LOG_LEVEL: "debug", AMPI_LOG_FILE: "env.log" } });
    assert.equal(flagWins.status, 0, flagWins.stderr);
    assert.deepEqual(readdirSync(path.join(flagWins.root, "project")), []);
  });

  it("still writes a usage error to stderr with --log-file, and to the file", async () => {
    const result = await runAmpi(["--log-file", "ampi.log", "--settings-file", "s.json"]);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^ampi: --settings-file is not supported: .*\nRun ampi --help for the supported options\.\n$/);
    assert.match(result.log("ampi.log"), /^\S+ error --settings-file is not supported: .*\\nRun ampi --help for the supported options\.\n$/);
  });

  it("exits 2 for an unknown level, from the flag or from AMPI_LOG_LEVEL", async () => {
    const flag = await runAmpi(["--log-level", "loud", "--help"]);
    assert.equal(flag.status, 2);
    assert.equal(flag.stderr, 'ampi: --log-level must be error, warn, info or debug, not "loud".\nRun ampi --help for the supported options.\n');
    const env = await runAmpi(["--help"], { env: { AMPI_LOG_LEVEL: "loud" } });
    assert.equal(env.status, 2);
    assert.equal(env.stderr, 'ampi: AMPI_LOG_LEVEL must be error, warn, info or debug, not "loud".\nRun ampi --help for the supported options.\n');
  });

  it("writes the usage error for an unknown AMPI_LOG_LEVEL to --log-file as well", async () => {
    const result = await runAmpi(["--log-file", "ampi.log", "--help"], { env: { AMPI_LOG_LEVEL: "loud" } });
    assert.equal(result.status, 2);
    assert.equal(result.stderr, 'ampi: AMPI_LOG_LEVEL must be error, warn, info or debug, not "loud".\nRun ampi --help for the supported options.\n');
    assert.match(result.log("ampi.log"), /^\S+ error AMPI_LOG_LEVEL must be error, warn, info or debug, not "loud"\.\\nRun ampi --help for the supported options\.\n$/);
  });

  it("logs the route and Pi's arguments at debug, with the message text left out", async () => {
    const result = await runAmpi(["-x", "--log-level", "debug", "-m", "low", "the secret plan"], { faux: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "Echo: the secret plan\n");
    assert.match(result.stderr, /^ampi: command: pi\nampi: execute mode\nampi: loading ampi from .+\n/);
    const piArgs = /^ampi: Pi's arguments: (.+)$/m.exec(result.stderr);
    assert.ok(piArgs, result.stderr);
    assert.deepEqual(JSON.parse(piArgs[1]).slice(2), ["--print", "-e", fauxModel, "--model", "faux/faux-1", "--ampi-mode", "low", "<message>"]);
    assert.doesNotMatch(result.stderr, /secret/);
  });

  it("logs only the name of Pi's own command at debug, never its header, environment or server arguments", async () => {
    const header = ["sk-", "SECRETHEADER", "0123456789"].join("");
    const env = ["sk-", "SECRETENV", "0123456789"].join("");
    const arg = ["sk-", "SECRETARG", "0123456789"].join("");
    const args = ["mcp", "add", "docs", "--header", `Authorization=Bearer ${header}`, "--env", `DOCS_KEY=${env}`, "--", "docs-server", arg];
    const result = await runAmpi(["--log-level", "debug", "--log-file", "ampi.log", ...args]);
    const log = result.log("ampi.log");
    assert.match(log, / debug pi mcp add through Pi's executable /);
    for (const secret of [header, env, arg]) {
      assert.ok(!result.stderr.includes(secret), result.stderr);
      assert.ok(!log.includes(secret), log);
    }
  });

  it("hands --no-color and --color to the environment of Pi's tools, and leaves it alone without them", async () => {
    const command = "run: echo NO_COLOR=$NO_COLOR FORCE_COLOR=$FORCE_COLOR";
    const [off, on, neither] = await Promise.all([
      runAmpi(["-x", "--no-color", command], { faux: true, env: { FORCE_COLOR: "3" } }),
      runAmpi(["-x", "--color", command], { faux: true, env: { NO_COLOR: "1" } }),
      runAmpi(["-x", command], { faux: true, env: { NO_COLOR: "x" } }),
    ]);
    for (const result of [off, on, neither]) assert.equal(result.status, 0, result.stderr);
    assert.equal(off.stdout, "Ran: NO_COLOR=1 FORCE_COLOR=\n");
    assert.equal(on.stdout, "Ran: NO_COLOR= FORCE_COLOR=1\n");
    assert.equal(neither.stdout, "Ran: NO_COLOR=x FORCE_COLOR=\n");
  });
});

/**
 * The places in packages/ampi-cli/src that may write to stderr without the
 * logger, because they are not the command's diagnostics. Each entry must
 * match exactly one line. A new diagnostic goes through the logger instead.
 */
const STDERR_ALLOWED = [
  { file: "log.js", line: "stderr = (text) => process.stderr.write(text)", reason: "the logger itself" },
  { file: "main.js", line: "report: (line) => process.stderr.write(", reason: "--timings, which the user asked for" },
  { file: "main.js", line: "createInterface({ input: process.stdin, output: process.stderr })", reason: "the yes/no question of threads delete" },
  { file: "pi-compat.js", line: "process.stderr.write(`", reason: "a line Pi wrote to stdout that is not JSON, passed on" },
  { file: "main.js", line: "piStderr: (text) => process.stderr.write(text)", reason: "Pi's own stderr from a pi mcp command, passed on" },
  { file: "main.js", line: "err: (text) => void process.stderr.write(text)", reason: "Pi's own output from the ampi review run, passed on" },
  { file: "main.js", line: "const writeProgress = (text) => process.stderr.write(text)", reason: "skill add's Cloning line, update's install line and npm's output: progress at every level" },
  { file: "main.js", line: "process.stderr.write = ", reason: "ampi __complete writes nothing to stderr, Pi's lines included: the shell would print them over the command line" },
];

describe("ampi diagnostics guard", () => {
  it("finds no stderr write outside the logger and the listed outputs", () => {
    const found = [];
    for (const file of readdirSync(cliSrc, { recursive: true }).filter((name) => name.endsWith(".js"))) {
      for (const [index, line] of readFileSync(path.join(cliSrc, file), "utf8").split("\n").entries()) {
        if (/process\.stderr\b|console\.(error|warn)\b/.test(line)) found.push({ file, number: index + 1, line });
      }
    }
    const unlisted = found.filter(({ file, line }) => !STDERR_ALLOWED.some((allowed) => allowed.file === file && line.includes(allowed.line)));
    assert.deepEqual(unlisted, [], "write diagnostics through the logger from src/log.js, or list the output here with its reason");
    for (const allowed of STDERR_ALLOWED) {
      const matches = found.filter(({ file, line }) => file === allowed.file && line.includes(allowed.line));
      assert.equal(matches.length, 1, `${allowed.file}: ${allowed.line} (${allowed.reason})`);
    }
  });
});
