import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const loadStore = () => importSource("extensions/ampi-threads/index-store.ts");
const loadSeam = () => importSource("extensions/ampi-core/thread-index.ts");

let dir;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "ampi-threads-index-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Each importSource call loads a fresh module copy, so errors are matched by name.
const INDEX_ERROR = { name: "MmrThreadIndexError" };

const indexPath = () => path.join(dir, "threads", "index.json");
const readIndex = () => JSON.parse(readFileSync(indexPath(), "utf8"));

async function createStore(options = {}) {
  const { createMmrThreadIndexStore } = await loadStore();
  const warnings = [];
  let ids = 0;
  const store = createMmrThreadIndexStore({
    baseDir: path.join(dir, "threads"),
    randomId: () => `id${++ids}`,
    onWarning: (message) => warnings.push(message),
    ...options,
  });
  return { store, warnings };
}

function writeRaw(text) {
  mkdirSync(path.dirname(indexPath()), { recursive: true });
  writeFileSync(indexPath(), text);
}

describe("thread index store", () => {
  it("reads a missing index as empty without creating it", async () => {
    const { store } = await createStore();
    assert.equal(store.path, indexPath());
    assert.deepEqual(await store.list(), {});
    assert.equal(await store.get("s1"), undefined);
    assert.equal(existsSync(indexPath()), false);
  });

  it("writes a versioned index under the threads directory", async () => {
    const { store } = await createStore();
    const record = await store.update("s1", { archived: "2026-10-18T10:00:00.000Z", labels: ["bug-fix"], pinned: true });
    assert.deepEqual(record, { archived: "2026-10-18T10:00:00.000Z", labels: ["bug-fix"], pinned: true });
    assert.deepEqual(readIndex(), {
      version: 1,
      threads: { s1: { archived: "2026-10-18T10:00:00.000Z", labels: ["bug-fix"], pinned: true } },
    });
    assert.deepEqual(await store.get("s1"), record);
    assert.deepEqual(store.peek("s1"), record);
  });

  it("replaces the file by renaming a finished temp file over it", async () => {
    const { store } = await createStore();
    await store.update("s1", { pinned: true });
    const before = statSync(indexPath()).ino;
    await store.update("s2", { color: "blue" });
    assert.notEqual(statSync(indexPath()).ino, before, "an in-place write would keep the inode");
    assert.deepEqual(readdirSync(path.dirname(indexPath())), ["index.json"], "no temp file is left behind");
    assert.deepEqual(Object.keys(readIndex().threads), ["s1", "s2"]);
  });

  it("sets fields, removes them with null, and drops a record with no fields left", async () => {
    const { store } = await createStore();
    await store.update("s1", { archived: "2026-10-18T10:00:00.000Z", color: "#00ff7f", titleSource: "user" });
    assert.deepEqual(await store.update("s1", { archived: null, color: undefined }), {
      color: "#00ff7f",
      titleSource: "user",
    });
    assert.equal(await store.update("s1", { color: null, titleSource: null }), undefined);
    assert.deepEqual(readIndex(), { version: 1, threads: {} });
  });

  it("moves a corrupt index aside, warns once, and starts empty", async () => {
    const { store, warnings } = await createStore();
    writeRaw("{ not json");
    assert.deepEqual(await store.list(), {});
    assert.equal(readFileSync(`${indexPath()}.id1.corrupt`, "utf8"), "{ not json", "the original bytes are kept");
    assert.equal(existsSync(indexPath()), false, "the corrupt file is never overwritten in place");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /could not be read \(it is not valid JSON\)/);
    assert.ok(warnings[0].includes(`${indexPath()}.id1.corrupt`));

    await store.update("s1", { pinned: true });
    assert.deepEqual(readIndex().threads, { s1: { pinned: true } });

    // A record of the wrong shape counts as corrupt too; the warning is not repeated.
    writeRaw(JSON.stringify({ version: 1, threads: { s1: { labels: "bug" } } }));
    assert.equal(await store.get("s1"), undefined);
    assert.ok(existsSync(`${indexPath()}.id2.corrupt`));
    assert.equal(readFileSync(`${indexPath()}.id1.corrupt`, "utf8"), "{ not json", "the first copy stays");
    assert.equal(warnings.length, 1);
  });

  it("treats a missing or unknown old version as corrupt", async () => {
    const { store } = await createStore();
    writeRaw(JSON.stringify({ threads: {} }));
    assert.deepEqual(await store.list(), {});
    assert.ok(existsSync(`${indexPath()}.id1.corrupt`));
  });

  it("refuses to read or change an index written by a newer version, leaving it untouched", async () => {
    const { store, warnings } = await createStore();
    const newer = JSON.stringify({ version: 2, threads: { s1: { archived: "2026-10-18T10:00:00.000Z" } } });
    writeRaw(newer);
    await assert.rejects(store.get("s1"), { ...INDEX_ERROR, message: /version 2, written by a newer ampi/ });
    await assert.rejects(store.update("s1", { archived: null }), INDEX_ERROR);
    assert.equal(readFileSync(indexPath(), "utf8"), newer);
    assert.deepEqual(readdirSync(path.dirname(indexPath())), ["index.json"]);
    assert.equal(warnings.length, 0);
  });

  it("runs concurrent updates one at a time, so none is lost", async () => {
    const { countMmrThreadIndexLocks } = await loadStore();
    const { store } = await createStore();
    const ids = Array.from({ length: 25 }, (_, i) => `s${i}`);
    await Promise.all(ids.map((id) => store.update(id, { labels: [`n${id.slice(1)}`] })));
    assert.deepEqual(Object.keys(readIndex().threads).sort(), [...ids].sort());
    assert.equal(countMmrThreadIndexLocks(), 0, "the lock map is emptied once the queue drains");
  });

  it("shares the queue between stores on the same path, and a failed update does not block the next", async () => {
    const { store: first } = await createStore();
    const { store: second } = await createStore();
    const results = await Promise.allSettled([
      first.update("a", { pinned: true }),
      second.update("b", { color: "not-a-colour" }),
      second.update("c", { pinned: false }),
      first.update("d", { titleSource: "model" }),
    ]);
    assert.deepEqual(
      results.map((result) => result.status),
      ["fulfilled", "rejected", "fulfilled", "fulfilled"],
    );
    assert.deepEqual(readIndex().threads, { a: { pinned: true }, c: { pinned: false }, d: { titleSource: "model" } });
  });

  it("validates fields and session ids before writing anything", async () => {
    const { store } = await createStore();
    await store.update("s1", { pinned: true });
    const before = readFileSync(indexPath(), "utf8");
    for (const [sessionId, patch] of [
      ["s1", { color: "teal" }],
      ["s1", { color: "#00ff7" }],
      ["s1", { archived: "yesterday" }],
      ["s1", { titleSource: "bot" }],
      ["s1", { pinned: "yes" }],
      ["s1", { labels: ["Bug"] }],
      ["__proto__", { pinned: true }],
      ["", { pinned: true }],
    ]) {
      await assert.rejects(store.update(sessionId, patch), INDEX_ERROR, `${sessionId} ${JSON.stringify(patch)}`);
    }
    assert.equal(readFileSync(indexPath(), "utf8"), before);
    assert.deepEqual(await store.update("s1", { color: "gray" }), { pinned: true, color: "gray" });
  });

  it("puts the index under Pi's agent directory by default", async () => {
    const { resolveDefaultMmrThreadIndexDir } = await loadStore();
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
    try {
      assert.equal(resolveDefaultMmrThreadIndexDir(), path.join(dir, "agent", "data", "ampi", "threads"));
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});

describe("thread labels", () => {
  const label = (length, char = "a") => char.repeat(length);

  it("accepts lowercase letters, digits and hyphens up to 32 characters, and drops duplicates", async () => {
    const { validateMmrThreadLabels } = await loadStore();
    assert.deepEqual(validateMmrThreadLabels(["a-1", "x9", label(32), "a-1"]), ["a-1", "x9", label(32)]);
    assert.deepEqual(validateMmrThreadLabels([]), []);
  });

  it("rejects a 33-character label and labels with other characters", async () => {
    const { validateMmrThreadLabels } = await loadStore();
    for (const bad of [label(33), "Bug", "a_b", "a b", "", "ä", 7]) {
      assert.throws(() => validateMmrThreadLabels([bad]), INDEX_ERROR, JSON.stringify(bad));
    }
    assert.throws(() => validateMmrThreadLabels("bug"), INDEX_ERROR);
  });

  it("allows 20 labels on a session but not 21", async () => {
    const { validateMmrThreadLabels } = await loadStore();
    const twenty = Array.from({ length: 20 }, (_, i) => `l${i}`);
    assert.equal(validateMmrThreadLabels(twenty).length, 20);
    assert.equal(validateMmrThreadLabels([...twenty, "l0"]).length, 20, "a repeated label does not count twice");
    assert.throws(() => validateMmrThreadLabels([...twenty, "l20"]), INDEX_ERROR);
  });

  it("removes the labels field when the list is empty", async () => {
    const { store } = await createStore();
    await store.update("s1", { labels: ["a"], pinned: true });
    assert.deepEqual(await store.update("s1", { labels: [] }), { pinned: true });
  });
});

describe("thread index seam", () => {
  it("returns the most recent registration and falls back when it is released", async () => {
    const { getMmrThreadIndex, registerMmrThreadIndex } = await loadSeam();
    assert.equal(getMmrThreadIndex(), undefined);
    const first = { name: "first" };
    const second = { name: "second" };
    const releaseFirst = registerMmrThreadIndex(first);
    const releaseSecond = registerMmrThreadIndex(second);
    assert.equal(getMmrThreadIndex(), second);
    releaseSecond();
    releaseSecond();
    assert.equal(getMmrThreadIndex(), first, "releasing twice removes only its own registration");
    releaseFirst();
    assert.equal(getMmrThreadIndex(), undefined);
  });

  it("filters catalogue sessions by archived state, keeping their order", async () => {
    const { filterMmrSessionsByArchived } = await loadSeam();
    const sessions = [{ id: "c" }, { id: "a" }, { id: "constructor" }, { id: "b" }];
    const threads = { a: { archived: "2026-10-18T10:00:00.000Z" }, b: { pinned: true }, c: { archived: "2026-10-17T10:00:00.000Z" } };
    assert.deepEqual(filterMmrSessionsByArchived(sessions, threads, true), [{ id: "c" }, { id: "a" }]);
    assert.deepEqual(filterMmrSessionsByArchived(sessions, threads, false), [{ id: "constructor" }, { id: "b" }]);
  });
});
