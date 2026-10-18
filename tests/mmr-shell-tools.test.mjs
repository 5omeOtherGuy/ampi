// ampi-shell: shell_command, shell_command_status and shell_command_kill
// against real child processes. Commands block on a FIFO the test writes to,
// and the test waits on output or exits it observes, never on a clock.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const unix = process.platform !== "win32";

let dir;
let fifo;
let shutdown;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ampi-shell-test-"));
  fifo = path.join(dir, "control");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0, "mkfifo must succeed");
});

afterEach(async () => {
  await shutdown?.();
  shutdown = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** Load ampi-shell into a mocked Pi with the given settings; returns a caller per tool. */
async function load({ backgroundAfterMs = 60_000, maxBackground = 8, piSettings = {}, ctxOptions = {} } = {}) {
  const { createMmrShellExtension } = await importSource("extensions/ampi-shell/index.ts");
  const { pi, tools, handlers } = createMockPi({ settings: piSettings });
  createMmrShellExtension({
    loadSettings: () => ({ enabled: true, backgroundAfterMs, maxBackground }),
    registryOptions: { killGraceMs: 0 },
  })(pi);
  const { ctx } = createMockExtensionContext({ cwd: dir, sessionId: "session-1234", ...ctxOptions });
  shutdown = () => handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
  const call = (name, params, { signal, onUpdate } = {}) => tools.get(name).execute(`${name}-call`, params, signal, onUpdate, ctx);
  return { call, tools, shutdown };
}

const text = (result) => result.content.map((part) => part.text).join("");

/** Wait for `pid` to print `expected`; the output it printed so far is read. */
async function readUntil(call, pid, expected) {
  const controller = new AbortController();
  const result = await call(
    "shell_command_status",
    { pid, timeout_ms: 60_000 },
    {
      signal: controller.signal,
      onUpdate: (update) => {
        if (text(update).includes(expected)) controller.abort();
      },
    },
  );
  assert.match(text(result), new RegExp(expected));
  return result;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("ampi-shell: shell_command", { skip: !unix && "process groups need Linux or macOS" }, () => {
  it("returns the output of a command that ends in time", async () => {
    const { call } = await load();
    const result = await call("shell_command", { command: "printf 'hello\\nworld\\n'" });
    assert.equal(text(result), "hello\nworld\n");
    assert.notEqual(result.isError, true);
    assert.equal(result.details.running, false);
    assert.equal(result.details.exitCode, 0);
  });

  it("reports a non-zero exit as an error with its code", async () => {
    const { call } = await load();
    const result = await call("shell_command", { command: "echo oops; exit 3" });
    assert.equal(result.isError, true);
    assert.equal(text(result), "oops\n\nCommand exited with code 3");
    assert.equal(result.details.exitCode, 3);
  });

  it("runs in workdir, relative to the session's directory, and names a workdir that does not exist", async () => {
    const { call } = await load();
    const result = await call("shell_command", { command: "pwd", workdir: "." });
    assert.equal(text(result).trim(), dir);
    await assert.rejects(call("shell_command", { command: "pwd", workdir: "missing" }), (error) => {
      assert.match(error.message, /does not exist/);
      assert.ok(error.message.includes(path.join(dir, "missing")));
      return true;
    });
  });

  it("gives the command PI_SESSION_ID and leaves PI_SESSION_FILE unset without a session file", async () => {
    const { call } = await load();
    const result = await call("shell_command", { command: `printf '%s %s' "$PI_SESSION_ID" "\${PI_SESSION_FILE-unset}"` });
    assert.equal(text(result), "session-1234 unset");
  });

  it("puts Pi's shellCommandPrefix before the command", async () => {
    const { call } = await load({ piSettings: { shellCommandPrefix: "greeting=hi" } });
    const result = await call("shell_command", { command: 'echo "$greeting"' });
    assert.equal(text(result), "hi\n");
  });

  it("backgrounds at once with backgroundAfterMs 0, and each status read returns only new output", async () => {
    const { call } = await load({ backgroundAfterMs: 0 });
    // One FIFO per read: a second read of the same FIFO could open it while
    // the test's first write still holds it open.
    const second = `${fifo}-2`;
    assert.equal(spawnSync("mkfifo", [second]).status, 0);
    const started = await call("shell_command", {
      command: `read a < "${fifo}"; echo "first $a"; read b < "${second}"; echo "second $b"`,
    });
    const { pid } = started.details;
    assert.equal(started.details.running, true);
    assert.equal(typeof started.details.startedAt, "number");
    assert.match(text(started), new RegExp(`still running in the background as pid ${pid}`));

    await writeFile(fifo, "one\n");
    const first = await readUntil(call, pid, "first one");
    assert.equal(first.details.running, true);
    assert.match(text(first), /Command is still running as pid \d+\.$/);

    await writeFile(second, "two\n");
    const last = await call("shell_command_status", { pid, timeout_ms: 60_000 });
    assert.equal(text(last), "second two\n\nCommand exited with code 0");
    assert.equal(last.details.running, false);
    assert.equal(last.details.exitCode, 0);

    // Its last output was read, so it is no longer listed.
    await assert.rejects(call("shell_command_status", { pid }), /Unknown pid/);
  });

  it("stops a command at timeout_ms in the background, and status reports the timeout", async () => {
    const { call } = await load({ backgroundAfterMs: 0 });
    const started = await call("shell_command", { command: `read x < "${fifo}"`, timeout_ms: 50 });
    const result = await call("shell_command_status", { pid: started.details.pid, timeout_ms: 60_000 });
    assert.equal(text(result), "(no new output)\n\nCommand timed out after 0.05 seconds");
    assert.equal(result.details.stoppedBy, "timeout");
    assert.equal(alive(started.details.pid), false);
  });

  it("kills the process group when the turn is aborted while it waits", async () => {
    const { call } = await load();
    const controller = new AbortController();
    const running = call(
      "shell_command",
      { command: `echo ready; read x < "${fifo}"` },
      {
        signal: controller.signal,
        onUpdate: (update) => {
          if (text(update).includes("ready")) controller.abort();
        },
      },
    );
    await assert.rejects(running, /ready\n\nCommand aborted$/);
  });

  it("refuses a start past maxBackground and names the running pids", async () => {
    const { call } = await load({ backgroundAfterMs: 0, maxBackground: 2 });
    const a = await call("shell_command", { command: `read x < "${fifo}"` });
    const b = await call("shell_command", { command: `read x < "${fifo}"` });
    await assert.rejects(call("shell_command", { command: "true" }), (error) => {
      assert.match(error.message, /limit is 2/);
      assert.ok(error.message.includes(`pids ${a.details.pid}, ${b.details.pid}`));
      return true;
    });
  });

  it("keeps the last 1 MiB of unread output and says how many bytes it dropped", async () => {
    const { call } = await load({ backgroundAfterMs: 0 });
    const started = await call("shell_command", {
      command: `read x < "${fifo}"; head -c 1500000 /dev/zero | tr '\\0' a`,
    });
    await writeFile(fifo, "go\n");
    const result = await call("shell_command_status", { pid: started.details.pid, timeout_ms: 60_000 });
    const { fullOutputPath } = result.details;
    assert.ok(fullOutputPath, "a cut result names the file with the full output");
    try {
      const full = readFileSync(fullOutputPath, "utf8");
      const marker = `[ampi-shell: ${1_500_000 - 1024 * 1024} bytes of older output were dropped]\n`;
      assert.ok(full.startsWith(marker), full.slice(0, 80));
      assert.equal(full.length, marker.length + 1024 * 1024);
      assert.ok(text(result).includes(`Full output: ${fullOutputPath}`));
    } finally {
      unlinkSync(fullOutputPath);
    }
  });
});

describe("ampi-shell: shell_command_status and shell_command_kill", { skip: !unix && "process groups need Linux or macOS" }, () => {
  it("returns at once with timeout_ms 0", async () => {
    const { call } = await load({ backgroundAfterMs: 0 });
    const started = await call("shell_command", { command: `read x < "${fifo}"` });
    const result = await call("shell_command_status", { pid: started.details.pid, timeout_ms: 0 });
    assert.equal(result.details.running, true);
    assert.equal(text(result), `(no new output)\n\nCommand is still running as pid ${started.details.pid}.`);
  });

  it("names the range of an out-of-range timeout_ms and the known pids for an unknown pid", async () => {
    const { call } = await load({ backgroundAfterMs: 0 });
    const started = await call("shell_command", { command: `read x < "${fifo}"` });
    for (const timeout_ms of [-1, 60_001]) {
      await assert.rejects(call("shell_command_status", { pid: started.details.pid, timeout_ms }), /from 0 to 60000/);
    }
    for (const name of ["shell_command_status", "shell_command_kill"]) {
      await assert.rejects(call(name, { pid: 999_999_999 }), (error) => {
        assert.match(error.message, /Unknown pid 999999999/);
        assert.ok(error.message.includes(`started in this session: ${started.details.pid}.`));
        return true;
      });
    }
  });

  it("ends a command that ignores SIGTERM with SIGKILL", async () => {
    const { call } = await load({ backgroundAfterMs: 0 });
    const started = await call("shell_command", { command: `trap '' TERM; echo ready; read x < "${fifo}"` });
    const { pid } = started.details;
    if (!text(started).includes("ready")) await readUntil(call, pid, "ready");
    const result = await call("shell_command_kill", { pid });
    assert.equal(result.details.running, false);
    assert.equal(result.details.signal, "SIGKILL");
    assert.equal(result.details.exitCode, 128 + 9);
    assert.match(text(result), /Command stopped with SIGKILL$/);
    assert.throws(() => process.kill(pid, 0));
  });

  it("kills every running command on session_shutdown", async () => {
    const { call, shutdown: endSession } = await load({ backgroundAfterMs: 0 });
    const started = await call("shell_command", { command: `read x < "${fifo}"` });
    const { pid } = started.details;
    assert.equal(alive(pid), true);
    await endSession();
    assert.equal(alive(pid), false);
    await assert.rejects(call("shell_command_status", { pid }), /Unknown pid/);
  });
});

describe("ampi-shell: settings and registration", () => {
  it("reads ampiShell or ampi.shell settings and AMPI_SHELL_ENABLE", async () => {
    const { loadMmrShellSettings } = await importSource("extensions/ampi-shell/config.ts");
    const home = path.join(dir, "home");
    const project = path.join(dir, "project");
    for (const base of [path.join(home, ".pi/agent"), path.join(project, ".pi")]) mkdirSync(base, { recursive: true });
    assert.deepEqual(loadMmrShellSettings(project, { homeDirectory: home, env: {} }), {
      enabled: true,
      backgroundAfterMs: 30_000,
      maxBackground: 8,
    });
    await writeFile(path.join(home, ".pi/agent/settings.json"), JSON.stringify({ ampiShell: { backgroundAfterMs: 500, maxBackground: 0 } }));
    await writeFile(path.join(project, ".pi/settings.json"), JSON.stringify({ ampi: { shell: { enabled: false, maxBackground: 3 } } }));
    assert.deepEqual(loadMmrShellSettings(project, { homeDirectory: home, env: {} }), {
      enabled: false,
      backgroundAfterMs: 500,
      maxBackground: 3,
    });
    assert.equal(loadMmrShellSettings(project, { homeDirectory: home, env: { AMPI_SHELL_ENABLE: "1" } }).enabled, true);
  });

  it("registers the three tools as ampi-owned, and none when turned off", async () => {
    const { createMmrShellExtension, MMR_SHELL_TOOL_NAMES } = await importSource("extensions/ampi-shell/index.ts");
    const owned = await importSource("extensions/ampi-core/owned-tools.ts");
    const on = createMockPi();
    createMmrShellExtension({ loadSettings: () => ({ enabled: true, backgroundAfterMs: 0, maxBackground: 1 }) })(on.pi);
    assert.deepEqual([...on.tools.keys()], [...MMR_SHELL_TOOL_NAMES]);
    for (const name of MMR_SHELL_TOOL_NAMES) assert.equal(owned.isAmpiOwnedTool(name), true);
    assert.equal(on.handlers.has("session_shutdown"), true);

    const off = createMockPi();
    createMmrShellExtension({ loadSettings: () => ({ enabled: false, backgroundAfterMs: 0, maxBackground: 1 }) })(off.pi);
    assert.equal(off.tools.size, 0);
  });
});
