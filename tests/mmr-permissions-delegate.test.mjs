// ampi-permissions: delegate programs. Each fixture is a small Node script
// written to a temporary directory and run with this Node; timeouts fire
// through an injected timer, never by waiting.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { cleanupLoadedSource } from "./helpers/load-src.mjs";
import { loadPermissionModules, removeTempDirs, setEnv, setupPermissions, tempDir } from "./helpers/permissions-gate.mjs";

after(cleanupLoadedSource);
after(removeTempDirs);

let modules;
before(async () => {
  modules = await loadPermissionModules();
});
afterEach(() => {
  modules.rules.setMmrPermissionsSessionAllowAll(false);
  modules.runtime.setMmrSubagentState(undefined);
});

const node = process.execPath;
const scripts = tempDir("ampi-delegate-scripts-");

/** Write a fixture script and return its path. */
function script(name, body) {
  const file = path.join(scripts, name);
  writeFileSync(file, body);
  return file;
}

const quoted = (word) => `'${word}'`;
const program = (file, ...args) => [node, file, ...args].map(quoted).join(" ");

const exit0 = script("exit0.mjs", "process.exit(0);\n");
const exit2 = script("exit2.mjs", "process.exit(2);\n");
const exit3 = script("exit3.mjs", "process.exit(3);\n");
const rejectStdout = script("reject-stdout.mjs", 'process.stdout.write("\\n  Only\\u0007 echo ok may run here.\\nsecond line\\n");\nprocess.exit(1);\n');
const rejectStderr = script("reject-stderr.mjs", 'process.stderr.write("Not on this branch.\\n");\nprocess.exit(1);\n');
const rejectSilent = script("reject-silent.mjs", "process.exit(1);\n");
const rejectLong = script("reject-long.mjs", 'process.stdout.write("y".repeat(600) + "\\n");\nprocess.exit(1);\n');
const flood = script(
  "flood.mjs",
  'const mib = "x".repeat(1024 * 1024);\nprocess.stderr.write(mib);\nprocess.stdout.write(mib, () => process.exit(1));\n',
);
// Appends what it read to the file named by its first argument, then allows
// `echo ok` and rejects every other command with a one-line message.
const recorder = script(
  "recorder.mjs",
  [
    'import { appendFileSync } from "node:fs";',
    'let text = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => { text += chunk; });',
    'process.stdin.on("end", () => {',
    '  appendFileSync(process.argv[2], text);',
    '  if (JSON.parse(text).input.command === "echo ok") process.exit(0);',
    '  console.log("Only echo ok may run here.");',
    "  process.exit(1);",
    "});",
    "",
  ].join("\n"),
);
// Reads its input, starts a second process in its group, holds fd 3 (which
// the test's spawn adds) in both, says it is ready and never exits.
const hang = script(
  "hang.mjs",
  [
    'import { spawn } from "node:child_process";',
    'process.stdin.resume();',
    'process.stdin.on("end", () => {',
    '  const second = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore", 3] });',
    '  process.stdout.write("ready " + second.pid + "\\n");',
    "  setInterval(() => {}, 1000);",
    "});",
    "",
  ].join("\n"),
);

const ON = (rules) => ({ ampi: { permissions: rules } });
const delegateBash = (to, command = "echo *") => ({ tool: "bash", matches: { command }, action: "delegate", to });

/** Records every program run read by the recorder fixture. */
function recordFile() {
  return path.join(tempDir(), "runs.jsonl");
}
function runs(file) {
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
}

/** A timer the test fires itself. */
function manualTimer() {
  const timers = [];
  return {
    timers,
    timer: (callback, ms) => {
      const entry = { callback, ms, cancelled: false };
      timers.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  };
}

/** Second processes of the hang fixture, killed after the suite in case a test left one behind. */
const strays = [];
after(() => {
  for (const pid of strays) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone, as it should be.
    }
  }
});

/** A spawn that adds a pipe on fd 3 and reports the child once it prints "ready". */
function spawnWithGroupPipe() {
  let readyResolve;
  const ready = new Promise((resolve) => (readyResolve = resolve));
  let groupGone;
  const spawnImpl = (command, args, options) => {
    const child = spawn(command, args, { ...options, stdio: [...options.stdio, "pipe"] });
    // fd 3 closes only once every process holding it, the second one included, is gone.
    groupGone = new Promise((resolve) => child.stdio[3].on("close", resolve));
    child.stdio[3].resume();
    child.stdout.on("data", (chunk) => {
      const ready = /ready (\d+)/.exec(String(chunk));
      if (!ready) return;
      strays.push(Number(ready[1]));
      readyResolve(child);
    });
    return child;
  };
  return { spawnImpl, ready, groupGone: () => groupGone };
}

describe("ampi-permissions delegate: exit codes", () => {
  it("allows on exit 0 without a dialog or approval events", async () => {
    const t = await setupPermissions(modules, { user: ON([delegateBash(program(exit0))]) });
    assert.equal(await t.call("bash", { command: "echo hi" }), undefined);
    assert.equal(t.selects.length, 0);
    assert.deepEqual(t.bus.emitted, [], "a program's answer is no approval");
  });

  it("survives a program that exits without reading a large input", async () => {
    const t = await setupPermissions(modules, { user: ON([{ tool: "write", action: "delegate", to: program(exit0) }]) });
    assert.equal(await t.call("write", { path: "big.txt", content: "z".repeat(4 * 1024 * 1024) }), undefined);
  });

  it("rejects on exit 1 with the first non-empty line of stdout, else stderr, without control characters", async () => {
    const t = await setupPermissions(modules, {
      user: ON([
        delegateBash(program(rejectStdout), "echo a"),
        delegateBash(program(rejectStderr), "echo b"),
        delegateBash(program(rejectSilent), "echo c"),
        delegateBash(program(rejectLong), "echo d"),
      ]),
    });
    assert.deepEqual(await t.call("bash", { command: "echo a" }), { block: true, reason: "Only echo ok may run here." });
    assert.deepEqual(await t.call("bash", { command: "echo b" }), { block: true, reason: "Not on this branch." });
    assert.deepEqual(await t.call("bash", { command: "echo c" }), {
      block: true,
      reason: `The delegate program "${program(rejectSilent)}" rejected this call without giving a reason.`,
    });
    assert.deepEqual(await t.call("bash", { command: "echo d" }), { block: true, reason: "y".repeat(500) });
    assert.equal(t.selects.length, 0);
  });

  it("drains a program that writes far more than it may keep", async () => {
    const t = await setupPermissions(modules, { user: ON([delegateBash(program(flood))]) });
    assert.deepEqual(await t.call("bash", { command: "echo hi" }), { block: true, reason: "x".repeat(500) });
  });

  it("asks on exit 2: the dialog with a UI, the no-UI reason without one", async () => {
    const rule = delegateBash(program(exit2));
    const ui = await setupPermissions(modules, { user: ON([rule]), answers: ["Allow Once"] });
    assert.equal(await ui.call("bash", { command: "echo hi" }), undefined);
    assert.equal(ui.selects.length, 1);
    assert.equal(ui.selects[0].title, "Approval Required\nTool: bash\necho hi");
    assert.deepEqual(
      ui.bus.emitted.map((event) => event.data.phase),
      ["request", "answer"],
      "the dialog that opens emits approval events",
    );
    assert.deepEqual(ui.notifications, [], "exit 2 is an answer, not a failure");

    const noUi = await setupPermissions(modules, { user: ON([rule]), hasUI: false });
    const text = modules.rules.formatMmrPermissionRule(rule);
    assert.deepEqual(await noUi.call("bash", { command: "echo hi" }), {
      block: true,
      reason:
        "The bash call needs the user's approval, and this run cannot ask for it. " +
        `The permissions rule "${text}" asks for approval (for "echo hi"), because its program did not allow the call. ` +
        "An allow rule in ampi.permissions lets such calls run without asking.",
    });
  });

  it("asks on any other exit code and warns once per program per session", async () => {
    const to = program(exit3);
    const t = await setupPermissions(modules, { user: ON([delegateBash(to)]), hasUI: false });
    for (let i = 0; i < 2; i++) {
      const result = await t.call("bash", { command: "echo hi" });
      assert.equal(result.block, true);
      assert.match(result.reason, /this run cannot ask for it/);
    }
    assert.deepEqual(t.notifications, [
      {
        message: `ampi-permissions: the delegate program "${to}" exited with code 3, so its calls ask for approval as an ask rule would.`,
        level: "warning",
      },
    ]);
  });

  it("asks and warns when the program is not found", async () => {
    const restore = setEnv({ PATH: tempDir() });
    try {
      const t = await setupPermissions(modules, { user: ON([delegateBash("ampi-no-such-check --strict")]), hasUI: false });
      assert.equal((await t.call("bash", { command: "echo hi" })).block, true);
      assert.deepEqual(t.notifications, [
        {
          message:
            'ampi-permissions: the delegate program "ampi-no-such-check --strict" was not found on PATH, so its calls ask for approval as an ask rule would.',
          level: "warning",
        },
      ]);
    } finally {
      restore();
    }
  });

  // A test timeout, so a regression fails instead of waiting on a process that lives on.
  it("kills the program and its process group when the timeout fires, then asks", { timeout: 10_000 }, async () => {
    const clock = manualTimer();
    const child = spawnWithGroupPipe();
    const t = await setupPermissions(modules, {
      user: ON([delegateBash(program(hang))]),
      hasUI: false,
      overrides: { delegateTimer: clock.timer, delegateSpawn: child.spawnImpl },
    });
    const pending = t.call("bash", { command: "echo hi" });
    await child.ready;
    assert.equal(clock.timers.length, 1);
    assert.equal(clock.timers[0].ms, 10_000, "the default limit is 10 seconds");
    clock.timers[0].callback();
    const result = await pending;
    assert.equal(result.block, true);
    assert.match(result.reason, /this run cannot ask for it/);
    await child.groupGone();
    assert.match(t.notifications[0].message, /"[^"]+hang\.mjs'" timed out after 10 s, so its calls ask/);
  });

  it("kills the program and blocks with the interrupted reason when the turn is aborted", { timeout: 10_000 }, async () => {
    const clock = manualTimer();
    const child = spawnWithGroupPipe();
    const t = await setupPermissions(modules, {
      user: ON([delegateBash(program(hang))]),
      overrides: { delegateTimer: clock.timer, delegateSpawn: child.spawnImpl, delegateTimeoutMs: 2_500 },
    });
    const pending = t.call("bash", { command: "echo hi" });
    await child.ready;
    assert.equal(clock.timers[0].ms, 2_500);
    t.controller.abort();
    assert.deepEqual(await pending, {
      block: true,
      reason: "The turn was interrupted while the tool call waited for approval, so it did not run.",
    });
    await child.groupGone();
    assert.equal(clock.timers[0].cancelled, true);
    assert.equal(t.selects.length, 0);
  });
});

describe("ampi-permissions delegate: what the program gets", () => {
  it("reads one JSON line with the tool, its input, the context and the working directory, and runs there", async () => {
    const file = recordFile();
    const cwdRecorder = script("cwd.mjs", 'import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], process.cwd());\n');
    const cwdFile = recordFile();
    const t = await setupPermissions(modules, {
      user: ON([
        { tool: "write", action: "delegate", to: program(cwdRecorder, cwdFile) },
        delegateBash(program(recorder, file)),
      ]),
    });
    assert.equal(await t.call("bash", { command: "echo ok", timeout: 5 }), undefined);
    const expected = { tool: "bash", input: { command: "echo ok", timeout: 5 }, context: "thread", cwd: t.cwd };
    assert.equal(readFileSync(file, "utf8"), `${JSON.stringify(expected)}\n`);
    assert.equal(await t.call("write", { path: "a.txt", content: "" }), undefined);
    assert.equal(readFileSync(cwdFile, "utf8"), t.cwd);
  });

  it("expands ~ to the home directory and finds a bare name on PATH", async () => {
    const home = tempDir();
    mkdirSync(path.join(home, "bin"));
    const inHome = path.join(home, "bin", "check.mjs");
    writeFileSync(inHome, readFileSync(recorder));
    const binDir = tempDir();
    const onPath = path.join(binDir, "ampi-check");
    writeFileSync(onPath, `#!${node}\n${readFileSync(recorder, "utf8")}`);
    chmodSync(onPath, 0o755);
    // Not executable: the lookup skips it and keeps searching.
    const shadowDir = tempDir();
    writeFileSync(path.join(shadowDir, "ampi-check"), "not a program\n");
    const homeRuns = recordFile();
    const pathRuns = recordFile();
    const restore = setEnv({ HOME: home, PATH: [shadowDir, binDir].join(path.delimiter) });
    try {
      const t = await setupPermissions(modules, {
        user: ON([delegateBash(`${quoted(node)} ~/bin/check.mjs ${homeRuns}`, "echo ok"), delegateBash(`ampi-check ${pathRuns}`, "echo no")]),
      });
      assert.equal(await t.call("bash", { command: "echo ok" }), undefined);
      assert.equal(runs(homeRuns).length, 1);
      assert.deepEqual(await t.call("bash", { command: "echo no" }), { block: true, reason: "Only echo ok may run here." });
      assert.equal(runs(pathRuns)[0].input.command, "echo no");
      assert.deepEqual(t.notifications, []);
    } finally {
      restore();
    }
  });
});

describe("ampi-permissions delegate: shell lines", () => {
  it("sends only the delegated part, then asks for the part a rule asks about", async () => {
    const file = recordFile();
    const t = await setupPermissions(modules, { user: ON([delegateBash(program(recorder, file))]), answers: ["Allow Once"] });
    assert.equal(await t.call("bash", { command: "echo ok && rm -rf build" }), undefined);
    assert.deepEqual(
      runs(file).map((run) => run.input.command),
      ["echo ok"],
    );
    assert.equal(t.selects.length, 1);
    assert.equal(t.selects[0].title, "Approval Required\nTool: bash\nNeeds approval: rm -rf build\necho ok && rm -rf build");
  });

  it("stops at the first program that rejects", async () => {
    const file = recordFile();
    const t = await setupPermissions(modules, { user: ON([delegateBash(program(recorder, file))]) });
    assert.deepEqual(await t.call("bash", { command: "echo no; echo ok" }), { block: true, reason: "Only echo ok may run here." });
    assert.deepEqual(
      runs(file).map((run) => run.input.command),
      ["echo no"],
      "the second part's program never runs",
    );
  });

  it("runs no program when a rule rejects another part", async () => {
    const file = recordFile();
    const reject = { tool: "bash", matches: { command: "rm *" }, action: "reject", message: "No rm." };
    const t = await setupPermissions(modules, { user: ON([reject, delegateBash(program(recorder, file))]) });
    assert.deepEqual(await t.call("bash", { command: "echo ok && rm -rf build" }), { block: true, reason: "No rm." });
    assert.deepEqual(runs(file), []);
  });
});

describe("ampi-permissions delegate: who may delegate", () => {
  it("rejects a program line with an operator, a redirection or words a shell would expand", () => {
    const problems = (to) => modules.rules.validateMmrPermissionRule({ tool: "bash", action: "delegate", to });
    assert.deepEqual(problems("a | b"), ["to: a program and its arguments only, without operators or redirections (found |)"]);
    assert.deepEqual(problems("a > f"), ["to: a program and its arguments only, without operators or redirections (found >)"]);
    assert.deepEqual(problems("check && other"), ["to: a program and its arguments only, without operators or redirections (found &&)"]);
    assert.deepEqual(problems("check $(whoami)"), ["to: a program and its arguments only, without a subshell, $(...) or backticks"]);
    assert.deepEqual(problems("check $HOME/x"), ["to: variables, $'...' quoting and brace expansions are not expanded; write the value out"]);
    assert.deepEqual(problems("check 'open"), ["to: ampi cannot read this program line (a comment, a heredoc or unbalanced quotes)"]);
    assert.deepEqual(problems("node ~/bin/approve.mjs --strict '$literal'"), []);
  });

  it("skips an invalid delegate rule with a warning at session start", async () => {
    const t = await setupPermissions(modules, { user: ON([delegateBash(`${quoted(node)} x.mjs | tee log`)]), hasUI: false });
    assert.equal(t.notifications.length, 1);
    assert.match(t.notifications[0].message, /Skipping ampi\.permissions\[0\] in .*settings\.json: to: a program and its arguments only/);
    assert.equal(await t.call("bash", { command: "echo hi" }), undefined, "the defaults allow echo");
  });

  it("never runs a project's delegate program", async () => {
    const file = recordFile();
    const t = await setupPermissions(modules, {
      user: ON([]),
      project: ON([delegateBash(program(recorder, file), "make *")]),
      hasUI: false,
    });
    assert.match(t.notifications[0].message, /Ignoring 1 allow or delegate rule in .*: project settings can only add reject and ask rules\./);
    const result = await t.call("bash", { command: "make all" });
    assert.match(result.reason, /The permissions rule "ask bash" asks for approval/);
    assert.equal(existsSync(file), false);
  });
});
