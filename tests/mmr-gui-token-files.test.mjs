// The GUI token files next to the live registry entries: ampi-core writes
// `<pid>.token` (owner-only, in the owner-only registry directory) while the
// process's web GUI serves, removes it with the entry's `gui` part, at
// shutdown and on exit, and both readers (ampi-core's and the `ampi`
// command's) use a token file only when it matches the entry's hash and
// remove it with a dead process's entry.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { readLiveEntries, readLiveToken } from "../packages/ampi-cli/src/live-registry.js";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const TOKEN = ["first", "gui", "token"].join("-");
const OTHER_TOKEN = ["second", "gui", "token"].join("-");
const hash = (token) => createHash("sha256").update(token).digest("hex");
const DEAD_PID = 7_300_001;
const LIVE_PID = 7_300_002;
const load = () => importSource("extensions/ampi-core/live-registry.ts");

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function liveDir() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "ampi-token-files-")));
  dirs.push(dir);
  return path.join(dir, "live");
}

const mode = (file) => statSync(file).mode & 0o777;

/** ampi-core's writer on a mock Pi, with a clock that never moves and timers run by hand. */
async function writer(dir) {
  const { registerMmrLiveRegistry } = await load();
  const mock = createMockPi();
  mock.pi.events = { on: () => () => {}, emit: () => {} };
  const timers = [];
  const handle = registerMmrLiveRegistry(mock.pi, {
    dir,
    isAlive: () => true,
    procStart: () => 4321,
    now: () => 0,
    setTimer: (callback) => timers.push(callback),
    clearTimer: () => {},
  });
  const { ctx } = createMockExtensionContext({ mode: "tui", sessionId: "s-1", sessionFile: "/sessions/s-1.jsonl" });
  const emit = async (name, event = {}) => {
    await mock.handlers.get(name)?.({ type: name, ...event }, ctx);
    await handle.idle();
  };
  /** Run the throttled writes and wait for them. */
  const settle = async () => {
    for (const run of timers.splice(0)) run();
    await handle.idle();
  };
  return { emit, settle };
}

/** An entry file as ampi-core writes it, with a GUI whose token hashes to `tokenHash`. */
function writeEntry(dir, pid, tokenHash) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const entry = {
    version: 2,
    pid,
    procStart: null,
    kind: "tui",
    sessionId: `s-${pid}`,
    sessionPath: `/sessions/${pid}.jsonl`,
    cwd: "/work",
    title: null,
    mode: null,
    status: null,
    startedAt: "2026-10-18T10:00:00.000Z",
    updatedAt: "2026-10-18T10:00:00.000Z",
    gui: tokenHash === null ? null : { port: 40_000, tokenHash },
  };
  writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify(entry), { mode: 0o600 });
  return entry;
}

describe("GUI token files: the writer", () => {
  it("writes the token owner-only in the owner-only directory with the GUI, and removes it with the GUI and at shutdown", async () => {
    const { setMmrLiveFields } = await load();
    const dir = liveDir();
    const own = path.join(dir, `${process.pid}.json`);
    const tokenFile = path.join(dir, `${process.pid}.token`);
    const { emit, settle } = await writer(dir);
    await emit("session_start", { reason: "startup" });
    assert.equal(existsSync(tokenFile), false, "no token file before the GUI serves");

    setMmrLiveFields({ gui: { port: 40_123, token: TOKEN } });
    await settle();
    assert.equal(mode(dir), 0o700);
    assert.equal(mode(tokenFile), 0o600);
    assert.equal(mode(own), 0o600);
    assert.equal(readFileSync(tokenFile, "utf8"), TOKEN);
    assert.deepEqual(JSON.parse(readFileSync(own, "utf8")).gui, { port: 40_123, tokenHash: hash(TOKEN) });
    assert.equal(readFileSync(own, "utf8").includes(TOKEN), false, "the entry keeps only the hash");

    setMmrLiveFields({ gui: null });
    await settle();
    assert.deepEqual(readdirSync(dir), [`${process.pid}.json`], "the token goes with the GUI; the entry stays");

    setMmrLiveFields({ gui: { port: 40_124, token: OTHER_TOKEN } });
    await settle();
    assert.equal(readFileSync(tokenFile, "utf8"), OTHER_TOKEN, "a new server's token replaces the file");

    await emit("session_shutdown", { reason: "quit" });
    assert.deepEqual(readdirSync(dir), []);
  });

  it("removes the token file with the entry when the process exits", async () => {
    const { setMmrLiveFields } = await load();
    const dir = liveDir();
    const { emit, settle } = await writer(dir);
    const before = new Set(process.listeners("exit"));
    await emit("session_start", { reason: "startup" });
    const [onExit] = process.listeners("exit").filter((listener) => !before.has(listener));
    assert.equal(typeof onExit, "function");
    setMmrLiveFields({ gui: { port: 40_125, token: TOKEN } });
    await settle();
    assert.deepEqual(readdirSync(dir).sort(), [`${process.pid}.json`, `${process.pid}.token`]);
    onExit();
    assert.deepEqual(readdirSync(dir), []);
    await emit("session_shutdown", { reason: "quit" });
  });
});

describe("GUI token files: the readers", () => {
  it("return the token only when it matches the entry's hash", async () => {
    const { readMmrLiveToken, readMmrLiveEntries } = await load();
    const dir = liveDir();
    writeEntry(dir, LIVE_PID, hash(TOKEN));
    const [core] = await readMmrLiveEntries({ dir, isAlive: () => true });
    const [cli] = readLiveEntries({ dir, isAlive: () => true });
    const tokenFile = path.join(dir, `${LIVE_PID}.token`);

    assert.equal(await readMmrLiveToken(core, { dir }), undefined, "no token file");
    assert.equal(readLiveToken(dir, cli), undefined);

    writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
    assert.equal(await readMmrLiveToken(core, { dir }), TOKEN);
    assert.equal(readLiveToken(dir, cli), TOKEN);

    writeFileSync(tokenFile, OTHER_TOKEN, { mode: 0o600 });
    assert.equal(await readMmrLiveToken(core, { dir }), undefined, "a token the hash does not name is ignored");
    assert.equal(readLiveToken(dir, cli), undefined);

    writeFileSync(tokenFile, "", { mode: 0o600 });
    const emptyHash = { ...core, gui: { port: 40_000, tokenHash: hash("") } };
    assert.equal(await readMmrLiveToken(emptyHash, { dir }), undefined, "an empty file is no token");
    assert.equal(readLiveToken(dir, emptyHash), undefined);

    writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
    assert.equal(await readMmrLiveToken({ ...core, gui: null }, { dir }), undefined, "an entry without a GUI has no token");
    assert.equal(readLiveToken(dir, { ...cli, gui: null }), undefined);
  });

  it("remove the token files of stale entries and keep the live ones", async () => {
    const { readMmrLiveEntries } = await load();
    const isAlive = (pid) => pid === LIVE_PID;
    for (const read of [(dir) => readMmrLiveEntries({ dir, isAlive }), async (dir) => readLiveEntries({ dir, isAlive })]) {
      const dir = liveDir();
      writeEntry(dir, DEAD_PID, hash(TOKEN));
      writeFileSync(path.join(dir, `${DEAD_PID}.token`), TOKEN, { mode: 0o600 });
      writeEntry(dir, LIVE_PID, hash(OTHER_TOKEN));
      writeFileSync(path.join(dir, `${LIVE_PID}.token`), OTHER_TOKEN, { mode: 0o600 });
      const entries = await read(dir);
      assert.deepEqual(entries.map((entry) => entry.pid), [LIVE_PID]);
      assert.deepEqual(readdirSync(dir).sort(), [`${LIVE_PID}.json`, `${LIVE_PID}.token`]);
    }
  });
});
