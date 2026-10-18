import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const loadStore = () => importSource("extensions/ampi-threads/history-store.ts");

let dir;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "ampi-threads-history-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const historyDir = () => path.join(dir, "history");
const WORKSPACE = "/work/parser";
const OTHER = "/work/website";

/** Seconds after 10:00 on a fixed day, as the store writes them. */
const at = (second) => new Date(Date.UTC(2026, 9, 18, 10, 0, second)).toISOString();

/** The file a workspace's prompts go to, derived here from the documented rule. */
function fileFor(cwd) {
  const key = createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 32);
  return path.join(historyDir(), `${key}.jsonl`);
}

/** A store whose clock starts at second 0 and ticks one second per prompt. */
async function createStore() {
  const { createMmrPromptHistoryStore } = await loadStore();
  let second = 0;
  return createMmrPromptHistoryStore({ baseDir: historyDir(), now: () => at(second++) });
}

const texts = (entries) => entries.map((entry) => entry.text);
const fileLines = (file) => readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0);

function writeLines(file, lines, { trailingNewline = true } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${lines.join("\n")}${trailingNewline ? "\n" : ""}`);
}

const line = (second, text) => JSON.stringify({ ts: at(second), text });

describe("prompt history store", () => {
  it("appends one line per prompt to the workspace's file and reads them newest first", async () => {
    const store = await createStore();
    assert.equal(await store.append(WORKSPACE, "Rename the parser"), true);
    assert.equal(await store.append(WORKSPACE, "Now fix\nthe imports"), true);
    assert.equal(store.pathFor(WORKSPACE), fileFor(WORKSPACE));
    assert.deepEqual(fileLines(fileFor(WORKSPACE)).map((text) => JSON.parse(text)), [
      { ts: at(0), text: "Rename the parser" },
      { ts: at(1), text: "Now fix\nthe imports" },
    ]);
    assert.deepEqual(await store.read(WORKSPACE, "workspace"), [
      { ts: at(1), text: "Now fix\nthe imports" },
      { ts: at(0), text: "Rename the parser" },
    ]);
  });

  it("skips blank prompts and a repeat of the last one, but keeps an earlier prompt sent again", async () => {
    const store = await createStore();
    await store.append(WORKSPACE, "first");
    assert.equal(await store.append(WORKSPACE, "first"), false);
    assert.equal(await store.append(WORKSPACE, "  \n "), false);
    await store.append(WORKSPACE, "second");
    assert.equal(await store.append(WORKSPACE, "first"), true);
    assert.deepEqual(texts(await store.read(WORKSPACE, "workspace")), ["first", "second", "first"]);
    assert.equal(fileLines(fileFor(WORKSPACE)).length, 3);
  });

  it("keeps one file per workspace, named by a hash of its absolute path", async () => {
    const store = await createStore();
    await store.append(WORKSPACE, "in parser");
    await store.append(`${WORKSPACE}/`, "in parser, written with a slash");
    await store.append(OTHER, "in website");
    assert.deepEqual(readdirSync(historyDir()).sort(), [path.basename(fileFor(WORKSPACE)), path.basename(fileFor(OTHER))].sort());
    assert.ok(!readdirSync(historyDir()).some((name) => name.includes("parser")), "no path in the file name");
    assert.deepEqual(texts(await store.read(WORKSPACE, "workspace")), ["in parser, written with a slash", "in parser"]);
    assert.deepEqual(texts(await store.read(OTHER, "workspace")), ["in website"]);
    assert.deepEqual(await store.read("/work/elsewhere", "workspace"), []);
  });

  it("merges every workspace's prompts by time for all workspaces", async () => {
    const store = await createStore();
    // Clock: 0 parser, 1 website, 2 parser, 3 website, 4 website.
    await store.append(WORKSPACE, "p0");
    await store.append(OTHER, "w1");
    await store.append(WORKSPACE, "p2");
    await store.append(OTHER, "w3");
    await store.append(OTHER, "w4");
    writeFileSync(path.join(historyDir(), "notes.txt"), "not a history file\n");
    assert.deepEqual(texts(await store.read(WORKSPACE, "all")), ["w4", "w3", "p2", "w1", "p0"]);
    assert.deepEqual(texts(await store.read(OTHER, "all")), ["w4", "w3", "p2", "w1", "p0"], "the same from any workspace");
  });

  it("reads nothing, for either scope, before the first prompt", async () => {
    const store = await createStore();
    assert.deepEqual(await store.read(WORKSPACE, "workspace"), []);
    assert.deepEqual(await store.read(WORKSPACE, "all"), []);
    assert.equal(existsSync(historyDir()), false, "reading creates nothing");
  });

  it("skips lines that are not entries, and starts a fresh line after a cut-off one", async () => {
    writeLines(
      fileFor(WORKSPACE),
      [
        line(0, "kept first"),
        "not json",
        JSON.stringify({ ts: "yesterday-ish", text: "bad date" }),
        JSON.stringify({ ts: at(1), text: 42 }),
        JSON.stringify({ ts: at(2), text: "   " }),
        "[1, 2]",
        line(3, "kept last"),
        '{"ts":"2026-10-18T10:00:04.000Z","te',
      ],
      { trailingNewline: false },
    );
    const store = await createStore();
    assert.deepEqual(texts(await store.read(WORKSPACE, "workspace")), ["kept last", "kept first"]);
    assert.equal(await store.append(WORKSPACE, "after the cut"), true);
    const lines = fileLines(fileFor(WORKSPACE));
    assert.equal(lines.at(-2), '{"ts":"2026-10-18T10:00:04.000Z","te', "the cut-off line is left as it was");
    assert.deepEqual(JSON.parse(lines.at(-1)), { ts: at(0), text: "after the cut" });
    assert.deepEqual(texts(await store.read(WORKSPACE, "workspace")), ["after the cut", "kept last", "kept first"]);
  });

  it("returns the newest 1000 prompts and rewrites the file to them once it would pass 1200 lines", async () => {
    const { MMR_PROMPT_HISTORY_MAX, MMR_PROMPT_HISTORY_REWRITE_AT } = await loadStore();
    assert.equal(MMR_PROMPT_HISTORY_MAX, 1000);
    assert.equal(MMR_PROMPT_HISTORY_REWRITE_AT, 1200);
    // 1199 lines: 1198 prompts and one line that is not an entry.
    const lines = Array.from({ length: 1198 }, (_, index) => line(index, `p${index}`));
    lines.splice(600, 0, "not json");
    writeLines(fileFor(WORKSPACE), lines);
    const { createMmrPromptHistoryStore } = await loadStore();
    const store = createMmrPromptHistoryStore({ baseDir: historyDir(), now: () => at(5000) });

    const before = await store.read(WORKSPACE, "workspace");
    assert.equal(before.length, 1000);
    assert.deepEqual([before[0].text, before.at(-1).text], ["p1197", "p198"]);

    // The 1200th line is appended.
    await store.append(WORKSPACE, "fills the file");
    assert.equal(fileLines(fileFor(WORKSPACE)).length, 1200);
    assert.equal(JSON.parse(fileLines(fileFor(WORKSPACE))[0]).text, "p0");

    // The next prompt rewrites the file: the newest 1000 entries, the bad line dropped.
    await store.append(WORKSPACE, "past the limit");
    const rewritten = fileLines(fileFor(WORKSPACE));
    assert.equal(rewritten.length, 1000);
    assert.equal(JSON.parse(rewritten[0]).text, "p200");
    assert.equal(JSON.parse(rewritten.at(-1)).text, "past the limit");
    assert.ok(!rewritten.includes("not json"));
    assert.deepEqual(readdirSync(historyDir()), [path.basename(fileFor(WORKSPACE))], "no temp file is left behind");
    assert.deepEqual(texts(await store.read(WORKSPACE, "workspace")).slice(0, 2), ["past the limit", "fills the file"]);
  });

  it("queues prompts appended together, keeping their order", async () => {
    const store = await createStore();
    const prompts = Array.from({ length: 20 }, (_, index) => `prompt ${index}`);
    assert.deepEqual(await Promise.all(prompts.map((text) => store.append(WORKSPACE, text))), prompts.map(() => true));
    assert.deepEqual(texts(await store.read(WORKSPACE, "workspace")), prompts.toReversed());
  });

  it("lives under Pi's agent directory by default", async () => {
    const { resolveDefaultMmrPromptHistoryDir } = await loadStore();
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
    try {
      assert.equal(resolveDefaultMmrPromptHistoryDir(), path.join(dir, "agent", "data", "ampi", "threads", "history"));
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});

describe("prompt history seam", () => {
  it("returns the latest registration and releases exactly the one asked for", async () => {
    const seam = await importSource("extensions/ampi-core/prompt-history.ts");
    const first = { read: async () => [] };
    const second = { read: async () => [] };
    const releaseFirst = seam.registerMmrPromptHistory(first);
    const releaseSecond = seam.registerMmrPromptHistory(second);
    try {
      assert.equal(seam.getMmrPromptHistory(), second);
      releaseFirst();
      releaseFirst();
      assert.equal(seam.getMmrPromptHistory(), second);
      releaseSecond();
      assert.equal(seam.getMmrPromptHistory(), undefined);
    } finally {
      releaseFirst();
      releaseSecond();
    }
  });
});
