// The `ampi` command's live registry reader (plain JavaScript) against
// ampi-core's (TypeScript): the same files give the same entries, and both
// remove the same stale ones. A change to one reader that the other does not
// follow fails here.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { findLiveOwner, liveRegistryDir, readLiveEntries, readProcStart } from "../packages/ampi-cli/src/live-registry.js";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const FIXTURES = path.join(import.meta.dirname, "fixtures", "live-registry");
const core = () => importSource("extensions/ampi-core/live-registry.ts");
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function fixtureDir() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ampi-cli-live-")));
  dirs.push(root);
  const dir = path.join(root, "live");
  cpSync(FIXTURES, dir, { recursive: true });
  return dir;
}

describe("ampi live registry reader", () => {
  it("reads the shared fixtures exactly as ampi-core does", async () => {
    const { readMmrLiveEntries } = await core();
    const options = { isAlive: () => true, procStart: () => null };
    const cli = readLiveEntries({ dir: fixtureDir(), ...options });
    assert.deepEqual(await readMmrLiveEntries({ dir: fixtureDir(), ...options }), cli);
    assert.deepEqual(
      cli.map((entry) => [entry.pid, entry.version, entry.kind]),
      [
        [101, 1, "tui"],
        [102, 2, "tui"],
        [103, 2, "execute"],
        [104, 2, "app-session"],
        [105, 2, "tui"],
      ],
    );
  });

  it("removes the same dead and reused entries and leaves the same invalid files", async () => {
    const { readMmrLiveEntries } = await core();
    const alive = new Set([101, 102, 104, 105]);
    const starts = { 102: 5000, 105: 7001 };
    const options = { isAlive: (pid) => alive.has(pid), procStart: (pid) => starts[pid] ?? null };
    const cliDir = fixtureDir();
    const coreDir = fixtureDir();
    const cli = readLiveEntries({ dir: cliDir, ...options });
    assert.deepEqual(await readMmrLiveEntries({ dir: coreDir, ...options }), cli);
    assert.deepEqual(
      cli.map((entry) => entry.pid),
      [101, 102, 104],
    );
    assert.deepEqual(readdirSync(cliDir).sort(), readdirSync(coreDir).sort());
    assert.deepEqual(readdirSync(cliDir).sort(), ["101.json", "102.json", "104.json", "106.json", "107.json", "108.json", "110.json", "111.json", "notes.txt"]);
  });

  it("reads what ampi-core writes, and finds the owner of a session file through a symbolic link", async () => {
    const { writeMmrLiveEntry, readMmrProcStart } = await core();
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ampi-cli-live-")));
    dirs.push(root);
    const dir = liveRegistryDir(path.join(root, "agent"));
    assert.equal(dir, path.join(root, "agent", "data", "ampi", "live"));
    assert.deepEqual(readLiveEntries({ dir }), [], "no directory, no entries");
    mkdirSync(path.join(root, "sessions"));
    writeFileSync(path.join(root, "sessions", "a.jsonl"), "");
    symlinkSync(path.join(root, "sessions"), path.join(root, "linked"));
    assert.equal(readProcStart(process.pid), readMmrProcStart(process.pid));
    await writeMmrLiveEntry(
      {
        pid: process.pid,
        procStart: readProcStart(process.pid),
        kind: "execute",
        sessionId: "s-a",
        sessionPath: path.join(root, "sessions", "a.jsonl"),
        cwd: root,
        title: null,
        mode: "medium",
        status: { phase: "sending", label: "Sending" },
        startedAt: "2026-10-18T10:00:00.000Z",
        updatedAt: "2026-10-18T10:00:00.000Z",
        gui: null,
      },
      { dir },
    );
    const owner = findLiveOwner(path.join(root, "linked", "a.jsonl"), { dir });
    assert.equal(owner?.pid, process.pid, "the default checks see this process as running");
    assert.equal(owner?.kind, "execute");
    assert.equal(findLiveOwner(path.join(root, "linked", "a.jsonl"), { dir, exceptPid: process.pid }), undefined);
  });
});
