// ampi-core live registry: one file per running Pi process whose session has
// a file, written by ampi-core for the session's lifetime, read (and cleaned
// of dead or reused pids) by every process that wants to know who runs what.

import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const FIXTURES = path.join(import.meta.dirname, "fixtures", "live-registry");
const HASH = "0f".repeat(32);
const load = () => importSource("extensions/ampi-core/live-registry.ts");
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "ampi-core-live-")));
  dirs.push(dir);
  return dir;
}

/** A copy of the shared fixtures, since readers remove the entries of dead processes. */
function fixtureDir() {
  const dir = path.join(tempDir(), "live");
  cpSync(FIXTURES, dir, { recursive: true });
  return dir;
}

const entry = (pid, extra = {}) => ({
  pid,
  procStart: 4321,
  kind: "tui",
  sessionId: `s-${pid}`,
  sessionPath: `/sessions/${pid}.jsonl`,
  cwd: "/work/app",
  title: "Fix the parser",
  mode: "medium",
  status: { phase: "idle", label: "" },
  startedAt: "2026-10-18T10:00:00.000Z",
  updatedAt: "2026-10-18T10:00:01.000Z",
  gui: { port: 40000 + pid, tokenHash: HASH },
  ...extra,
});

/** A mock Pi whose event bus delivers emits, so mode changes reach the writer. */
function mockPi() {
  const mock = createMockPi();
  const listeners = new Map();
  mock.pi.events = {
    on: (name, handler) => {
      listeners.set(name, [...(listeners.get(name) ?? []), handler]);
      return () => {};
    },
    emit: (name, data) => {
      for (const handler of listeners.get(name) ?? []) handler(data);
    },
  };
  return mock;
}

/** A fake clock and timer queue for the write throttle. */
function fakeClock(start = 1_000_000) {
  const clock = { now: start, timers: [] };
  clock.options = {
    now: () => clock.now,
    setTimer: (callback, ms) => {
      const timer = { callback, ms, at: clock.now };
      clock.timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      clock.timers = clock.timers.filter((t) => t !== timer);
    },
  };
  clock.fire = () => {
    const due = clock.timers;
    clock.timers = [];
    for (const timer of due) timer.callback();
  };
  return clock;
}

/** Load the writer on a fresh mock Pi with a fixed process start time and a fake clock. */
async function writer(dir, options = {}) {
  const { registerMmrLiveRegistry } = await load();
  const mock = mockPi();
  const clock = fakeClock();
  const handle = registerMmrLiveRegistry(mock.pi, {
    dir,
    isAlive: () => true,
    procStart: () => 4321,
    ...clock.options,
    ...options,
  });
  const emit = async (name, event, ctx) => {
    await mock.handlers.get(name)?.({ type: name, ...event }, ctx);
    await handle.idle();
  };
  return { ...mock, clock, handle, emit };
}

const own = (dir) => path.join(dir, `${process.pid}.json`);
const readOwn = (dir) => JSON.parse(readFileSync(own(dir), "utf8"));

describe("ampi-core live registry files", () => {
  it("writes version 2 atomically, owner-only, and reads it back", async () => {
    const { writeMmrLiveEntry, readMmrLiveEntries } = await load();
    const dir = path.join(tempDir(), "live");
    const file = await writeMmrLiveEntry(entry(12), { dir });
    assert.equal(file, path.join(dir, "12.json"));
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 2, ...entry(12) });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    await writeMmrLiveEntry(entry(12, { title: null }), { dir });
    assert.deepEqual(readdirSync(dir), ["12.json"], "no temp file is left");
    assert.deepEqual(await readMmrLiveEntries({ dir, isAlive: () => true, procStart: () => 4321 }), [{ version: 2, ...entry(12, { title: null }) }]);
  });

  it("reads version 1 files as terminal sessions with a GUI and nothing else known", async () => {
    const { readMmrLiveEntries } = await load();
    const dir = fixtureDir();
    const [v1] = await readMmrLiveEntries({ dir, isAlive: (pid) => pid === 101 });
    assert.deepEqual(v1, {
      version: 1,
      pid: 101,
      procStart: null,
      kind: "tui",
      sessionId: null,
      sessionPath: "/sessions/a.jsonl",
      cwd: "/work/app",
      title: null,
      mode: null,
      status: null,
      startedAt: "2026-10-18T10:00:00.000Z",
      updatedAt: "2026-10-18T10:00:00.000Z",
      gui: { port: 40101, tokenHash: HASH },
    });
  });

  it("skips files that are not valid entries and leaves them alone", async () => {
    const { readMmrLiveEntries } = await load();
    const dir = fixtureDir();
    const running = await readMmrLiveEntries({ dir, isAlive: () => true, procStart: () => null });
    assert.deepEqual(
      running.map((e) => [e.pid, e.kind]),
      [
        [101, "tui"],
        [102, "tui"],
        [103, "execute"],
        [104, "app-session"],
        [105, "tui"],
      ],
    );
    assert.equal(running[2].ownerPid, undefined, "only an app-session entry carries ownerPid");
    assert.equal(running[3].ownerPid, 102);
    assert.deepEqual(await readMmrLiveEntries({ dir, isAlive: () => false }), []);
    assert.deepEqual(
      readdirSync(dir).sort(),
      ["106.json", "107.json", "108.json", "110.json", "111.json", "notes.txt"],
      "malformed JSON, an unknown version, a name that is not the pid, an app-session without owner and an unknown kind stay",
    );
  });

  it("removes the entries of dead processes and of reused pids", async () => {
    const { readMmrLiveEntries } = await load();
    const dir = fixtureDir();
    const alive = new Set([101, 102, 104, 105]);
    // 102 started when its entry says; 105's pid now belongs to a later process; 104 cannot be checked.
    const starts = { 102: 5000, 105: 7001 };
    const entries = await readMmrLiveEntries({ dir, isAlive: (pid) => alive.has(pid), procStart: (pid) => starts[pid] ?? null });
    assert.deepEqual(
      entries.map((e) => e.pid),
      [101, 102, 104],
    );
    assert.equal(existsSync(path.join(dir, "103.json")), false, "dead");
    assert.equal(existsSync(path.join(dir, "105.json")), false, "reused");
  });

  it("probes this process with the default checks, and tolerates a missing directory or file", async () => {
    const { writeMmrLiveEntry, readMmrLiveEntries, removeMmrLiveEntry, readMmrProcStart } = await load();
    const dir = path.join(tempDir(), "live");
    assert.deepEqual(await readMmrLiveEntries({ dir }), []);
    await removeMmrLiveEntry(30, { dir });
    const start = readMmrProcStart(process.pid);
    if (process.platform === "linux") assert.ok(Number.isSafeInteger(start), String(start));
    else assert.equal(start, null);
    await writeMmrLiveEntry(entry(process.pid, { procStart: start }), { dir });
    assert.deepEqual(
      (await readMmrLiveEntries({ dir })).map((e) => e.pid),
      [process.pid],
    );
    await removeMmrLiveEntry(process.pid, { dir });
    assert.deepEqual(readdirSync(dir), []);
  });

  it("finds the process that owns a session file through a symbolic link", async () => {
    const { writeMmrLiveEntry, findMmrLiveOwner } = await load();
    const root = tempDir();
    const dir = path.join(root, "live");
    mkdirSync(path.join(root, "sessions"));
    const real = path.join(root, "sessions", "a.jsonl");
    writeFileSync(real, "");
    symlinkSync(path.join(root, "sessions"), path.join(root, "linked"));
    await writeMmrLiveEntry(entry(4242, { kind: "execute", sessionPath: real }), { dir });
    const options = { dir, isAlive: () => true, procStart: () => 4321 };
    assert.equal((await findMmrLiveOwner(path.join(root, "linked", "a.jsonl"), options))?.pid, 4242);
    assert.equal(await findMmrLiveOwner(path.join(root, "linked", "a.jsonl"), { ...options, exceptPid: 4242 }), undefined);
    assert.equal(await findMmrLiveOwner(path.join(root, "linked", "b.jsonl"), options), undefined);
  });
});

describe("ampi-core live registry writer", () => {
  it("records a terminal session as tui, and print, JSON and RPC runs with a file as execute", async () => {
    for (const [mode, kind] of [
      ["tui", "tui"],
      ["print", "execute"],
      ["json", "execute"],
      ["rpc", "execute"],
    ]) {
      const dir = path.join(tempDir(), "live");
      const { emit } = await writer(dir);
      const { ctx } = createMockExtensionContext({ mode, cwd: "/work/app", sessionId: "s-1", sessionFile: "/sessions/s-1.jsonl", sessionName: "Parser fix" });
      await emit("session_start", { reason: "startup" }, ctx);
      const recorded = readOwn(dir);
      assert.equal(recorded.kind, kind, mode);
      assert.deepEqual(
        { ...recorded, startedAt: undefined, updatedAt: undefined },
        {
          version: 2,
          pid: process.pid,
          procStart: 4321,
          kind,
          sessionId: "s-1",
          sessionPath: "/sessions/s-1.jsonl",
          cwd: "/work/app",
          title: "Parser fix",
          mode: null,
          status: { phase: "idle", label: "" },
          startedAt: undefined,
          updatedAt: undefined,
          gui: null,
        },
      );
      await emit("session_shutdown", { reason: "quit" }, ctx);
      assert.deepEqual(readdirSync(dir), [], mode);
    }
  });

  it("writes nothing for a session without a file (--no-session, in memory)", async () => {
    for (const mode of ["tui", "print", "json"]) {
      const dir = path.join(tempDir(), "live");
      const { emit } = await writer(dir);
      const { ctx } = createMockExtensionContext({ mode, sessionId: "s-1" });
      await emit("session_start", { reason: "startup" }, ctx);
      await emit("turn_start", {}, ctx);
      await emit("session_shutdown", { reason: "quit" }, ctx);
      assert.equal(existsSync(dir), false, mode);
    }
  });

  it("records the session with ampi-threads turned off", async () => {
    const { createMmrThreadsExtension } = await importSource("extensions/ampi-threads/index.ts");
    const dir = path.join(tempDir(), "live");
    const { pi, emit } = await writer(dir);
    createMmrThreadsExtension({ loadSettings: () => ({ enabled: false }) })(pi);
    const { ctx } = createMockExtensionContext({ mode: "tui", sessionId: "s-1", sessionFile: "/sessions/s-1.jsonl" });
    await emit("session_start", { reason: "startup" }, ctx);
    assert.equal(readOwn(dir).sessionPath, "/sessions/s-1.jsonl");
    await emit("session_shutdown", { reason: "quit" }, ctx);
  });

  it("rewrites the entry for the next session after a switch, and removes it at shutdown", async () => {
    const dir = path.join(tempDir(), "live");
    const { emit } = await writer(dir);
    const first = createMockExtensionContext({ mode: "tui", sessionId: "s-1", sessionFile: "/sessions/s-1.jsonl" }).ctx;
    const second = createMockExtensionContext({ mode: "tui", sessionId: "s-2", sessionFile: "/sessions/s-2.jsonl" }).ctx;
    await emit("session_start", { reason: "startup" }, first);
    await emit("session_shutdown", { reason: "new" }, first);
    assert.deepEqual(readdirSync(dir), [], "the old session's entry goes with it");
    await emit("session_start", { reason: "new" }, second);
    assert.deepEqual([readOwn(dir).sessionId, readOwn(dir).sessionPath], ["s-2", "/sessions/s-2.jsonl"]);
    await emit("session_shutdown", { reason: "quit" }, second);
    assert.deepEqual(readdirSync(dir), []);
  });

  it("merges contributed fields: the GUI's port is set and cleared in the one file", async () => {
    const { setMmrLiveFields } = await load();
    const dir = path.join(tempDir(), "live");
    const { emit, clock, handle } = await writer(dir);
    const { ctx } = createMockExtensionContext({ mode: "tui", sessionId: "s-1", sessionFile: "/sessions/s-1.jsonl" });
    await emit("session_start", { reason: "startup" }, ctx);
    clock.now += 1000;
    setMmrLiveFields({ gui: { port: 40123, tokenHash: HASH } });
    await handle.idle();
    assert.deepEqual(readOwn(dir).gui, { port: 40123, tokenHash: HASH });
    clock.now += 1000;
    setMmrLiveFields({ title: "Generated title" });
    await handle.idle();
    assert.deepEqual([readOwn(dir).title, readOwn(dir).gui?.port], ["Generated title", 40123], "an absent key leaves the field alone");
    clock.now += 1000;
    setMmrLiveFields({ gui: null });
    await handle.idle();
    assert.equal(readOwn(dir).gui, null);
    assert.deepEqual(readdirSync(dir), [`${process.pid}.json`]);
    await emit("session_shutdown", { reason: "quit" }, ctx);
    setMmrLiveFields({ gui: { port: 1, tokenHash: HASH } });
    await handle.idle();
    assert.deepEqual(readdirSync(dir), [], "a contribution after shutdown writes nothing");
  });

  it("follows the mode and the status phase, at most once per 250 ms with a trailing write", async () => {
    const { setMmrModeState, MMR_EVENT_STATE_CHANGED } = await importSource("extensions/ampi-core/runtime.ts");
    const dir = path.join(tempDir(), "live");
    setMmrModeState({ mode: "high" });
    const { emit, clock, handle, pi } = await writer(dir);
    const { ctx } = createMockExtensionContext({ mode: "tui", sessionId: "s-1", sessionFile: "/sessions/s-1.jsonl" });
    const start = clock.now;
    await emit("session_start", { reason: "startup" }, ctx);
    assert.deepEqual([readOwn(dir).mode, readOwn(dir).status.phase], ["high", "idle"]);

    clock.now = start + 100;
    await emit("turn_start", {}, ctx);
    assert.deepEqual(
      clock.timers.map((t) => t.ms),
      [150],
      "the write waits for the end of the 250 ms window",
    );
    clock.now = start + 150;
    await emit("tool_execution_start", { toolCallId: "t1", toolName: "bash" }, ctx);
    assert.equal(clock.timers.length, 1, "changes inside the window share the trailing write");
    assert.equal(readOwn(dir).status.phase, "idle");

    clock.now = start + 250;
    clock.fire();
    await handle.idle();
    assert.deepEqual(readOwn(dir).status, { phase: "runningTools", label: "Running Tools" });
    assert.equal(readOwn(dir).updatedAt, new Date(start + 250).toISOString());

    clock.now = start + 400;
    await emit("tool_execution_end", { toolCallId: "t1", isError: false }, ctx);
    await emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "abcd" } }, ctx);
    assert.equal(clock.timers.length, 1);
    clock.now = start + 500;
    clock.fire();
    await handle.idle();
    assert.deepEqual(readOwn(dir).status, { phase: "streaming", label: "Streaming" });

    clock.now = start + 2000;
    setMmrModeState({ mode: "low" });
    pi.events.emit(MMR_EVENT_STATE_CHANGED, { mode: "low" });
    await handle.idle();
    assert.equal(clock.timers.length, 0, "after a quiet window the change is written at once");
    assert.equal(readOwn(dir).mode, "low");

    clock.now = start + 3000;
    await emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "more text" } }, ctx);
    assert.equal(clock.timers.length, 0, "a token count alone does not rewrite the entry");

    await emit("session_shutdown", { reason: "quit" }, ctx);
    setMmrModeState(undefined);
    assert.deepEqual(readdirSync(dir), []);
  });

  it("warns in the terminal when another live process has the session file open", async () => {
    const { writeMmrLiveEntry } = await load();
    const root = tempDir();
    const dir = path.join(root, "live");
    const sessionFile = path.join(root, "s-1.jsonl");
    writeFileSync(sessionFile, "");
    await writeMmrLiveEntry(entry(4242, { kind: "execute", sessionPath: sessionFile }), { dir });
    const { emit } = await writer(dir);
    const { ctx, notifications } = createMockExtensionContext({ mode: "tui", sessionId: "s-1", sessionFile });
    await emit("session_start", { reason: "startup" }, ctx);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].level, "warning");
    assert.match(notifications[0].message, /process 4242 \(execute\)/);
    assert.match(notifications[0].message, /can lose messages/);
    assert.equal(readOwn(dir).sessionPath, sessionFile, "the warning does not stop the entry");
    await emit("session_shutdown", { reason: "quit" }, ctx);
    assert.deepEqual(readdirSync(dir), ["4242.json"], "only its own entry goes");
  });

  it("writes one stderr line starting with ampi: outside the terminal", async () => {
    const { writeMmrLiveEntry } = await load();
    const root = tempDir();
    const dir = path.join(root, "live");
    const sessionFile = path.join(root, "s-1.jsonl");
    await writeMmrLiveEntry(entry(4243, { kind: "tui", sessionPath: sessionFile }), { dir });
    const lines = [];
    const { emit } = await writer(dir, { writeStderr: (line) => lines.push(line) });
    const { ctx, notifications } = createMockExtensionContext({ mode: "print", sessionId: "s-1", sessionFile });
    await emit("session_start", { reason: "startup" }, ctx);
    assert.deepEqual(notifications, []);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^ampi: .*process 4243 \(tui\).*can lose messages.*\n$/);
    await emit("session_shutdown", { reason: "quit" }, ctx);
  });

  it("decides the kind in one place", async () => {
    const { resolveMmrLiveKind } = await load();
    const withFile = (mode) => createMockExtensionContext({ mode, sessionFile: "/sessions/a.jsonl" }).ctx;
    assert.deepEqual(resolveMmrLiveKind(withFile("tui")), { kind: "tui" });
    assert.deepEqual(resolveMmrLiveKind(withFile("rpc")), { kind: "execute" });
    assert.equal(resolveMmrLiveKind(createMockExtensionContext({ mode: "tui" }).ctx), undefined);
  });
});
