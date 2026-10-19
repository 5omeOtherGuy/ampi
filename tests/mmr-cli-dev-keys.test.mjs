// `ampi dev keys`: one JSON line per input chunk with the keys ampi reads, the
// event, and the command id or pending prefix of the keymap in effect. Driven
// in-process with a stream for stdin, a fake clock and a fake terminal, and
// spawned with piped stdin in a temporary home and agent directory.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, before, beforeEach, describe, it } from "node:test";
import { formatDevKeysHelp, runDevKeysCommand } from "../packages/ampi-cli/src/dev-keys.js";
import { cleanupLoadedSource, getPreparedSourceRoot } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const repoRoot = path.resolve(import.meta.dirname, "..");
const bin = path.join(repoRoot, "packages", "ampi-cli", "bin", "ampi.js");

/** The environment variables that switch ampi-tui and ampi-threads, cleared so the defaults apply. */
const SWITCHES = ["AMPI_TUI_ENABLE", "MMR_TUI_ENABLE", "AMPI_THREADS_ENABLE", "MMR_THREADS_ENABLE"];

const dir = mkdtempSync(path.join(os.tmpdir(), "ampi-cli-dev-keys-"));
const home = path.join(dir, "home");
const agentDir = path.join(dir, "agent");
const project = path.join(dir, "project");
const settingsFile = path.join(agentDir, "settings.json");

/** @param {unknown} keymap The `ampi.keymap` block of Pi's user settings, or undefined for none. */
const writeKeymap = (keymap) => writeFileSync(settingsFile, JSON.stringify(keymap === undefined ? {} : { ampi: { keymap } }));

/** Lines of JSONL output as objects, so a mismatch shows which line differs. */
const parseLines = (text) =>
  text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));

const press = (keys, command = null, pending = null) => ({ keys, event: "press", command, pending });

const savedEnv = {};
before(() => {
  for (const name of ["HOME", "PI_CODING_AGENT_DIR", "PI_OFFLINE", ...SWITCHES]) savedEnv[name] = process.env[name];
  mkdirSync(home, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  // ampi-tui and ampi-threads read their switches from the home directory, Pi its settings from the agent directory.
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  for (const name of SWITCHES) delete process.env[name];
});

after(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => writeKeymap(undefined));

/**
 * A host whose stdin is a stream, whose clock moves only when the test says
 * so, and whose terminal records what is done to it.
 */
function createHost({ stdinIsTTY = false, stdoutIsTTY = stdinIsTTY, ampi, out } = {}) {
  let time = 0;
  const stdout = [];
  const stderr = [];
  const terminalCalls = [];
  let onInput;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  let stopOnSignal;
  const pi = import("@earendil-works/pi-coding-agent");
  const host = {
    cwd: project,
    locateAmpi: async () => ampi ?? { root: path.dirname(getPreparedSourceRoot()), version: "0.0.0-test" },
    stdin: new PassThrough(),
    stdinIsTTY,
    stdoutIsTTY,
    now: () => time,
    createTerminal: () => ({
      start: (handler) => {
        terminalCalls.push("start");
        // The real terminal reads stdin, so its end is seen.
        host.stdin.resume();
        onInput = handler;
        markStarted();
      },
      drain: async (ms) => {
        terminalCalls.push(`drain ${ms}`);
      },
      stop: () => terminalCalls.push("stop"),
    }),
    onSignal: (stop) => {
      stopOnSignal = stop;
      return () => terminalCalls.push("unwatch signals");
    },
    out: out ?? ((text) => stdout.push(text)),
    err: (text) => stderr.push(text),
  };
  return {
    host,
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
    lines: () => parseLines(stdout.join("")),
    terminalCalls,
    started,
    /** Hand the terminal's input handler one chunk, `ms` after the previous one. */
    type: (chunk, ms = 10) => {
      time += ms;
      onInput(chunk);
    },
    signal: (name) => stopOnSignal(name),
    run: async (argv) => runDevKeysCommand(argv, { ...host, pi: await pi }),
  };
}

/** Run with `input` piped in as one write, as recorded input arrives. */
async function runPiped(input, argv = []) {
  const t = createHost();
  const code = t.run(argv);
  t.host.stdin.end(input);
  return { code: await code, lines: t.lines(), stdout: t.stdout(), stderr: t.stderr() };
}

/** Run on the fake terminal: type each chunk 10 ms after the last, then end stdin unless the run ended. */
async function runTyped(chunks, argv = []) {
  const t = createHost({ stdinIsTTY: true });
  const code = t.run(argv);
  await t.started;
  for (const chunk of chunks) t.type(chunk);
  t.host.stdin.end();
  return { code: await code, lines: t.lines(), stderr: t.stderr(), terminalCalls: t.terminalCalls };
}

describe("ampi dev keys: lines for piped input", () => {
  it("shows the leader waiting, and t completing nothing with the default keymap", async () => {
    const result = await runPiped("\x18t");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      result.stdout,
      '{"keys":["ctrl+x"],"event":"press","command":null,"pending":"ctrl+x"}\n{"keys":["t"],"event":"press","command":null,"pending":null}\n',
    );
    assert.equal(result.stderr, "");
  });

  it("names the command a leader chord from the settings runs", async () => {
    writeKeymap({ "thread.new": "<leader>t" });
    const result = await runPiped("\x18t");
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.lines, [press(["ctrl+x"], null, "ctrl+x"), press(["t"], "thread.new")]);
  });

  it("follows the settings' leader and rebound keys", async () => {
    writeKeymap({ leader: "ctrl+b", "thread.new": "<leader>t", "mode.toggle": null, "thread.switch": "ctrl+s" });
    const result = await runPiped("\x18\x02t\x13");
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.lines, [
      press(["ctrl+x"]),
      press(["ctrl+b"], null, "ctrl+b"),
      press(["t"], "thread.new"),
      press(["ctrl+s"], "thread.switch"),
    ]);
  });

  it("reads Esc Esc in one chunk as both keys and the interrupt, and Ctrl+S, Alt+T and Alt+D", async () => {
    const result = await runPiped("\x1b\x1b\x13\x1bt\x1bd");
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.lines, [
      press(["esc", "esc"], "thread.interrupt"),
      press(["ctrl+s"], "mode.toggle"),
      press(["alt+t"], "thread.toggleDetails"),
      press(["alt+d"]),
    ]);
  });

  it("reports kitty press, repeat and release events, and runs nothing on a release", async () => {
    const result = await runPiped("\x1b[115;5u\x1b[115;5:2u\x1b[115;5:3u");
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.lines, [
      press(["ctrl+s"], "mode.toggle"),
      { keys: ["ctrl+s"], event: "repeat", command: "mode.toggle", pending: null },
      { keys: ["ctrl+s"], event: "release", command: null, pending: null },
    ]);
  });

  it("keeps the pending prefix across a release, as a session does", async () => {
    writeKeymap({ "thread.new": "<leader>t" });
    const result = await runPiped("\x1b[120;5u\x1b[120;5:3ut");
    assert.deepEqual(result.lines, [
      press(["ctrl+x"], null, "ctrl+x"),
      { keys: ["ctrl+x"], event: "release", command: null, pending: "ctrl+x" },
      press(["t"], "thread.new"),
    ]);
  });

  it("reports a bracketed paste without its text, and the paste cancels a pending leader", async () => {
    writeKeymap({ "thread.new": "<leader>t" });
    const plain = await runPiped("\x18\x1b[200~hello\x1b[201~t");
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal(
      plain.stdout,
      '{"keys":["ctrl+x"],"event":"press","command":null,"pending":"ctrl+x"}\n{"keys":[],"paste":true}\n{"keys":["t"],"event":"press","command":null,"pending":null}\n',
    );
    const raw = await runPiped("\x1b[200~hello\x1b[201~", ["--raw"]);
    assert.equal(raw.stdout, '{"keys":[],"paste":true,"raw":"\\u001b[200~hello\\u001b[201~"}\n');
  });

  it("marks input that is not a key as unknown, and that cancels a pending prefix too", async () => {
    writeKeymap({ "thread.new": "<leader>t" });
    const plain = await runPiped("\x18\x1b[2~t");
    assert.deepEqual(plain.lines, [press(["ctrl+x"], null, "ctrl+x"), { keys: [], unknown: true }, press(["t"])]);
    const raw = await runPiped("\x18\x1b[2~", ["--raw"]);
    assert.equal(
      raw.stdout,
      '{"keys":["ctrl+x"],"event":"press","command":null,"pending":"ctrl+x","raw":"\\u0018"}\n{"keys":[],"unknown":true,"raw":"\\u001b[2~"}\n',
    );
  });

  it("escapes raw input so that it parses back to the exact bytes", async () => {
    const input = "\x01é\x1b[2~\x1bt\x1b[200~ü\tz\x1b[201~\x7f";
    const result = await runPiped(input, ["--raw"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.lines.length, 6);
    assert.equal(result.lines.map((line) => line.raw).join(""), input);
    assert.ok(!/[\x00-\x1f]/.test(result.stdout.replaceAll("\n", "")), "no C0 control character is printed as it is");
    assert.deepEqual(
      result.lines.map((line) => line.keys),
      [["ctrl+a"], ["é"], [], ["alt+t"], [], ["backspace"]],
    );
  });

  it("prints only keys and events with --no-keymap, and no keymap problems", async () => {
    writeKeymap({ "ampi.quit": "nope+c", "puck.open": "ctrl+p" });
    const withKeymap = await runPiped("\x13");
    assert.match(withKeymap.stderr, /^ampi: keymap: .*ampi\.quit/m);
    assert.match(withKeymap.stderr, /^ampi: keymap: .*"puck\.open"/m);

    const result = await runPiped("\x13\x18\x1b[115;5:3u\x1b[2~", ["--no-keymap"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(
      result.stdout,
      '{"keys":["ctrl+s"],"event":"press"}\n{"keys":["ctrl+x"],"event":"press"}\n{"keys":["ctrl+s"],"event":"release"}\n{"keys":[],"unknown":true}\n',
    );
  });

  it("stops at Ctrl+D in piped input, after printing it", async () => {
    const result = await runPiped("a\x04b");
    assert.equal(result.code, 0);
    assert.deepEqual(result.lines, [press(["a"]), press(["ctrl+d"])]);
  });
});

describe("ampi dev keys: exit keys on the terminal", () => {
  it("reads Esc Esc in two chunks as a pending Esc, then the interrupt", async () => {
    const result = await runTyped(["\x1b", "\x1b"]);
    assert.deepEqual(result.lines, [press(["esc"], null, "esc"), press(["esc"], "thread.interrupt")]);
  });

  it("quits on two Ctrl+C less than a second apart, printing both", async () => {
    const t = createHost({ stdinIsTTY: true });
    const code = t.run([]);
    await t.started;
    t.type("\x03");
    t.type("\x03", 999);
    assert.equal(await code, 0);
    assert.deepEqual(t.lines(), [press(["ctrl+c"], null, "ctrl+c"), press(["ctrl+c"], "ampi.quit")]);
    assert.deepEqual(t.terminalCalls, ["start", "unwatch signals", "drain 1000", "stop"]);
    assert.match(t.stderr(), /Ctrl\+C twice or Ctrl\+D/);
  });

  it("does not quit when the second Ctrl+C comes a second or more later, or another key came between", async () => {
    const t = createHost({ stdinIsTTY: true });
    let ended = false;
    const code = t.run([]).finally(() => {
      ended = true;
    });
    await t.started;
    t.type("\x03");
    t.type("\x03", 1000);
    t.type("a", 10);
    t.type("\x03", 10);
    // A release is no key press: it neither quits nor resets.
    t.type("\x1b[99;5:3u", 10);
    await Promise.resolve();
    assert.equal(ended, false);
    assert.deepEqual(t.terminalCalls, ["start"]);
    t.type("\x1b[99;5u", 10);
    assert.equal(await code, 0);
    assert.deepEqual(
      t.lines().map((line) => [line.keys.join(" "), line.event]),
      [
        ["ctrl+c", "press"],
        ["ctrl+c", "press"],
        ["a", "press"],
        ["ctrl+c", "press"],
        ["ctrl+c", "release"],
        ["ctrl+c", "press"],
      ],
    );
  });

  it("quits on two kitty Ctrl+C presses, and on Ctrl+D", async () => {
    const kitty = await runTyped(["\x1b[99;5u", "\x1b[99;5u", "x"]);
    assert.equal(kitty.code, 0);
    assert.deepEqual(kitty.lines, [press(["ctrl+c"], null, "ctrl+c"), press(["ctrl+c"], "ampi.quit")], "nothing after the exit is read");
    const ctrlD = await runTyped(["\x04", "x"]);
    assert.equal(ctrlD.code, 0);
    assert.deepEqual(ctrlD.lines, [press(["ctrl+d"])]);
    assert.deepEqual(ctrlD.terminalCalls, ["start", "unwatch signals", "drain 1000", "stop"]);
  });

  it("restores the terminal at the end of stdin, on a signal, and when handling a chunk throws", async () => {
    const ended = await runTyped(["a"]);
    assert.equal(ended.code, 0);
    assert.deepEqual(ended.terminalCalls, ["start", "unwatch signals", "stop"]);

    const signalled = createHost({ stdinIsTTY: true });
    const signalCode = signalled.run([]);
    await signalled.started;
    signalled.signal("SIGTERM");
    assert.equal(await signalCode, 143);
    assert.deepEqual(signalled.terminalCalls, ["start", "unwatch signals", "stop"]);

    const failing = createHost({
      stdinIsTTY: true,
      out: (text) => {
        if (text.includes("ctrl+s")) throw new Error("stdout is gone");
      },
    });
    const failCode = failing.run([]);
    await failing.started;
    failing.type("a");
    failing.type("\x13");
    assert.equal(await failCode, 1);
    assert.deepEqual(failing.terminalCalls, ["start", "unwatch signals", "stop"]);
    assert.match(failing.stderr(), /^ampi: dev keys: stdout is gone$/m);
  });
});

describe("ampi dev keys: usage and loading", () => {
  it("exits 2 on an unknown option, an argument, or a terminal stdin with stdout elsewhere", async () => {
    for (const argv of [["--json"], ["now"]]) {
      const t = createHost();
      assert.equal(await t.run(argv), 2, argv.join(" "));
      assert.match(t.stderr(), /^ampi: dev keys: .*\nRun ampi dev keys --help/);
      assert.equal(t.stdout(), "");
    }
    const t = createHost({ stdinIsTTY: true, stdoutIsTTY: false });
    assert.equal(await t.run(["--raw"]), 2);
    assert.match(t.stderr(), /^ampi: dev keys: stdout must be the terminal too.*pipe recorded input/);
    assert.deepEqual(t.terminalCalls, []);
  });

  it("prints its help for --help", async () => {
    const t = createHost();
    assert.equal(await t.run(["--help"]), 0);
    assert.equal(t.stdout(), formatDevKeysHelp());
    assert.match(t.stdout(), /^Usage: ampi dev keys \[--raw\] \[--no-keymap\]$/m);
  });

  it("says when the ampi in use has no key reader, or its reader fails to load", async () => {
    const stub = path.join(dir, "stub-ampi");
    const entry = path.join(stub, "src", "cli-dev-keys.ts");
    mkdirSync(path.dirname(entry), { recursive: true });

    const missing = createHost({ ampi: { root: stub, version: "0.0.1" } });
    assert.equal(await missing.run([]), 1);
    assert.equal(missing.stderr(), "ampi: ampi 0.0.1 is too old for dev keys; update @skippermissions/ampi (or ampi-cli).\n");

    writeFileSync(entry, "export default function (): void {}\n");
    const silent = createHost({ ampi: { root: stub } });
    assert.equal(await silent.run(["--no-keymap"]), 1);
    assert.equal(silent.stderr(), "ampi: the ampi package is too old for dev keys; update @skippermissions/ampi (or ampi-cli).\n");

    writeFileSync(entry, 'export default function (): void {\n  throw new Error("broken entry");\n}\n');
    const broken = createHost({ ampi: { root: stub, version: "0.0.1" } });
    assert.equal(await broken.run([]), 1);
    assert.match(broken.stderr(), /^ampi: could not load ampi's dev keys: .*broken entry/);
    assert.equal(broken.stdout(), "");
  });
});

describe("ampi dev keys: the executable", () => {
  // HOME is the test directory: ampi-tui and ampi-threads read their switches from ~/.pi/agent/settings.json.
  const run = (args, input, env = {}) =>
    spawnSync(process.execPath, [bin, "dev", "keys", ...args], {
      cwd: project,
      input,
      encoding: "utf8",
      env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", ...env },
    });

  it("reads piped stdin to its end and exits 0", () => {
    writeKeymap({ "thread.new": "<leader>t" });
    const result = run(["--raw"], "\x13\x18t\x1b\x1b\x1bt\x1bd");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(
      result.stdout,
      [
        '{"keys":["ctrl+s"],"event":"press","command":"mode.toggle","pending":null,"raw":"\\u0013"}',
        '{"keys":["ctrl+x"],"event":"press","command":null,"pending":"ctrl+x","raw":"\\u0018"}',
        '{"keys":["t"],"event":"press","command":"thread.new","pending":null,"raw":"t"}',
        '{"keys":["esc","esc"],"event":"press","command":"thread.interrupt","pending":null,"raw":"\\u001b\\u001b"}',
        '{"keys":["alt+t"],"event":"press","command":"thread.toggleDetails","pending":null,"raw":"\\u001bt"}',
        '{"keys":["alt+d"],"event":"press","command":null,"pending":null,"raw":"\\u001bd"}',
        "",
      ].join("\n"),
    );
  });

  it("says when the ampi Pi loads is too old, and prints nothing on stdout", () => {
    const oldEntry = path.join(dir, "old-ampi", "src", "index.ts");
    const otherAgentDir = path.join(dir, "agent-with-old-ampi");
    mkdirSync(path.dirname(oldEntry), { recursive: true });
    writeFileSync(oldEntry, "");
    writeFileSync(path.join(dir, "old-ampi", "package.json"), JSON.stringify({ name: "@skippermissions/ampi", version: "0.0.1" }));
    mkdirSync(otherAgentDir, { recursive: true });
    writeFileSync(path.join(otherAgentDir, "settings.json"), JSON.stringify({ extensions: [oldEntry] }));

    const result = run([], "\x13", { PI_CODING_AGENT_DIR: otherAgentDir });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "ampi: ampi 0.0.1 is too old for dev keys; update @skippermissions/ampi (or ampi-cli).\n");
  });
});
