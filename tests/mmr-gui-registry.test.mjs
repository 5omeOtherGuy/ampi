// ampi-gui live registry: one file per running Pi process, written
// atomically, cleaned of processes that no longer run.

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const load = () => importSource("extensions/ampi-gui/registry.ts");
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "ampi-gui-live-"));
  dirs.push(dir);
  return path.join(dir, "live");
}

const entry = (pid, extra = {}) => ({
  pid,
  sessionPath: `/sessions/${pid}.jsonl`,
  cwd: "/work/app",
  port: 40000 + pid,
  tokenHash: "ab".repeat(32),
  startedAt: "2026-10-18T10:00:00.000Z",
  ...extra,
});

describe("ampi-gui live registry", () => {
  it("writes <pid>.json with a version, readable only by the owner, and no temp files left", async () => {
    const { writeMmrGuiLiveEntry, readMmrGuiLiveEntries } = await load();
    const baseDir = tempDir();
    const file = await writeMmrGuiLiveEntry(entry(12), { baseDir, isAlive: () => true });
    assert.equal(file, path.join(baseDir, "12.json"));
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 1, ...entry(12) });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(baseDir), ["12.json"]);
    assert.deepEqual(await readMmrGuiLiveEntries({ baseDir, isAlive: () => true }), [{ version: 1, ...entry(12) }]);
  });

  it("removes entries of processes that no longer run when it reads or writes", async () => {
    const { writeMmrGuiLiveEntry, readMmrGuiLiveEntries } = await load();
    const baseDir = tempDir();
    const alive = new Set([12, 13, 14]);
    const isAlive = (pid) => alive.has(pid);
    await writeMmrGuiLiveEntry(entry(12), { baseDir, isAlive });
    await writeMmrGuiLiveEntry(entry(13, { sessionPath: null }), { baseDir, isAlive });
    alive.delete(12);
    await writeMmrGuiLiveEntry(entry(14), { baseDir, isAlive });
    assert.deepEqual(readdirSync(baseDir).sort(), ["13.json", "14.json"]);
    alive.delete(13);
    assert.deepEqual(
      (await readMmrGuiLiveEntries({ baseDir, isAlive })).map((e) => e.pid),
      [14],
    );
    assert.deepEqual(readdirSync(baseDir), ["14.json"]);
  });

  it("skips files that are not valid entries and leaves them alone", async () => {
    const { writeMmrGuiLiveEntry, readMmrGuiLiveEntries } = await load();
    const baseDir = tempDir();
    await writeMmrGuiLiveEntry(entry(20), { baseDir, isAlive: () => true });
    writeFileSync(path.join(baseDir, "21.json"), "{not json");
    writeFileSync(path.join(baseDir, "22.json"), JSON.stringify({ version: 9, ...entry(22) }));
    writeFileSync(path.join(baseDir, "23.json"), JSON.stringify({ version: 1, ...entry(24) }));
    writeFileSync(path.join(baseDir, "notes.txt"), "keep");
    const entries = await readMmrGuiLiveEntries({ baseDir, isAlive: () => false });
    assert.deepEqual(entries, []);
    assert.deepEqual(readdirSync(baseDir).sort(), ["21.json", "22.json", "23.json", "notes.txt"], "only the valid, dead entry went");
  });

  it("removes this process's entry, and tolerates a missing directory or file", async () => {
    const { writeMmrGuiLiveEntry, removeMmrGuiLiveEntry, readMmrGuiLiveEntries } = await load();
    const baseDir = tempDir();
    assert.deepEqual(await readMmrGuiLiveEntries({ baseDir }), []);
    await removeMmrGuiLiveEntry(30, { baseDir });
    await writeMmrGuiLiveEntry(entry(30), { baseDir, isAlive: () => true });
    await removeMmrGuiLiveEntry(30, { baseDir });
    assert.deepEqual(readdirSync(baseDir), []);
  });

  it("treats this process as running with the default check", async () => {
    const { writeMmrGuiLiveEntry, readMmrGuiLiveEntries } = await load();
    const baseDir = tempDir();
    await writeMmrGuiLiveEntry(entry(process.pid), { baseDir });
    assert.deepEqual(
      (await readMmrGuiLiveEntries({ baseDir })).map((e) => e.pid),
      [process.pid],
    );
  });
});
