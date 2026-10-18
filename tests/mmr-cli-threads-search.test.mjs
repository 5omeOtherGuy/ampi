// `ampi threads search` (packages/ampi-cli/src/threads.js with the search in
// src/cli-threads.ts, loaded through Pi): queries against a temporary agent
// directory whose sessions are written through Pi's SessionManager on a fixed
// clock, in two directories, with a parent and child, an archived and a pinned
// session, labels in the thread index and as Pi entries, and two models. The
// expected results are written by hand from the fixture below.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";
import * as pi from "@earendil-works/pi-coding-agent";
import { threadIndexPath, updateThreadRecord } from "../packages/ampi-cli/src/thread-index.js";
import { formatThreadsHelp, runThreadsCommand } from "../packages/ampi-cli/src/threads.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const bin = path.join(repoRoot, "packages", "ampi-cli", "bin", "ampi.js");

const NOW = Date.parse("2026-10-18T10:00:00.000Z");
// Parent and child in the demo directory, both after the 7-day bound.
const PARENT = "019a0000-0000-7000-8000-00000000000a";
const CHILD = "019a0000-0000-7000-8000-00000000000b";
// Archived, in the demo directory.
const NOTES = "019b0000-0000-7000-8000-00000000000c";
// Other directory: created before the 7-day bound, updated after it.
const PORT = "019c0000-0000-7000-8000-00000000000d";
// Other directory: created and updated before the bound.
const OLD = "019d0000-0000-7000-8000-00000000000e";

const savedEnv = { agentDir: process.env.PI_CODING_AGENT_DIR, sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR };
const temporary = mkdtempSync(path.join(tmpdir(), "ampi-cli-threads-search-"));
const agentDir = path.join(temporary, "agent");
const demo = path.join(temporary, "work", "demo");
const other = path.join(temporary, "work", "other");

after(() => {
  for (const [name, value] of [
    ["PI_CODING_AGENT_DIR", savedEnv.agentDir],
    ["PI_CODING_AGENT_SESSION_DIR", savedEnv.sessionDir],
  ]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(temporary, { recursive: true, force: true });
});

const at = (iso) => Date.parse(iso);
const user = (text, iso) => ({ role: "user", content: text, timestamp: at(iso) });
const assistant = (text, iso, model = "faux-1") => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "faux",
  provider: "faux",
  model,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop",
  timestamp: at(iso),
});

before(() => {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  mkdirSync(path.join(demo, ".git"), { recursive: true });
  mkdirSync(other, { recursive: true });
  writeFileSync(path.join(demo, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/acme/parser.git\n');

  const session = (cwd, id, createdIso, messages, options = {}) => {
    mock.timers.setTime(at(createdIso));
    const manager = pi.SessionManager.create(cwd, undefined, { id, parentSession: options.parent });
    for (const message of messages) manager.appendMessage(message);
    if (options.entryLabel) manager.appendLabelChange(manager.getLeafId(), options.entryLabel);
    return manager.getSessionFile();
  };
  mock.timers.enable({ apis: ["Date"], now: 0 });
  try {
    const parentFile = session(demo, PARENT, "2026-10-17T09:00:00.000Z", [
      user("Rename the parser module", "2026-10-17T09:00:00.000Z"),
      assistant("Renamed the module.", "2026-10-17T09:05:00.000Z"),
    ]);
    session(
      demo,
      CHILD,
      "2026-10-17T12:00:00.000Z",
      [user("Write parser tests", "2026-10-17T12:00:00.000Z"), assistant("Wrote the tests.", "2026-10-17T12:10:00.000Z", "faux-2")],
      { parent: parentFile, entryLabel: "checkpoint" },
    );
    session(demo, NOTES, "2026-10-16T09:00:00.000Z", [
      user("Draft the release notes", "2026-10-16T09:00:00.000Z"),
      assistant("Drafted them.", "2026-10-16T09:30:00.000Z"),
    ]);
    session(other, PORT, "2026-10-01T10:00:00.000Z", [
      user("Port the docs and keep notes for the release", "2026-10-01T10:00:00.000Z"),
      assistant("Ported.", "2026-10-15T08:00:00.000Z"),
    ]);
    session(other, OLD, "2026-09-01T10:00:00.000Z", [
      user("Port the changelog", "2026-09-01T10:00:00.000Z"),
      assistant("Done.", "2026-09-01T10:05:00.000Z"),
    ]);
  } finally {
    mock.timers.reset();
  }
  const index = threadIndexPath(agentDir);
  updateThreadRecord(index, PARENT, { labels: ["parser"], pinned: true });
  updateThreadRecord(index, NOTES, { archived: "2026-10-17T00:00:00.000Z", labels: ["release"] });
});

/** Run a thread command in the demo directory at NOW, with this checkout as the ampi package. */
async function run(args, { root = repoRoot, version } = {}) {
  let out = "";
  let err = "";
  const result = await runThreadsCommand(args, {
    pi,
    cwd: demo,
    env: {},
    now: () => NOW,
    columns: 120,
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    confirm: async (question) => {
      throw new Error(`unexpected question: ${question}`);
    },
    locateAmpi: async () => ({ root, version }),
  });
  return { result, out, err };
}

/** The ids `threads search --json` prints for `query`, in order. */
async function ids(...query) {
  const { result, out, err } = await run(["threads", "search", "--json", ...query]);
  assert.deepEqual(result, { code: 0 }, err);
  return out
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).id);
}

describe("ampi threads search: matching", () => {
  it("needs every word, so two words only one session has both of find that one", async () => {
    assert.deepEqual(await ids("parser", "tests"), [CHILD]);
    assert.deepEqual(await ids("parser"), [CHILD, PARENT]);
  });

  it("matches a quoted phrase only where its words stand together", async () => {
    assert.deepEqual(await ids('"release notes"'), [NOTES]);
    assert.deepEqual(await ids("release notes"), [NOTES, PORT]);
  });

  it("takes id: as an id or its first characters, not any part of it", async () => {
    assert.deepEqual(await ids("id:019b"), [NOTES]);
    assert.deepEqual(await ids(`id:${PORT}`), [PORT]);
    assert.deepEqual(await ids("id:0000000c"), []);
  });

  it("finds the sessions forked from a parent with parent:", async () => {
    assert.deepEqual(await ids(`parent:${PARENT}`), [CHILD]);
    assert.deepEqual(await ids("parent:019a0000-0000-7000-8000-00000000000A"), [CHILD]);
    assert.deepEqual(await ids(`parent:${CHILD}`), []);
  });

  it("includes archived sessions unless archived: narrows them", async () => {
    assert.deepEqual(await ids("release"), [NOTES, PORT]);
    assert.deepEqual(await ids("release", "archived:false"), [PORT]);
    assert.deepEqual(await ids("archived:true"), [NOTES]);
  });

  it("finds pinned sessions with pinned:true", async () => {
    assert.deepEqual(await ids("pinned:true"), [PARENT]);
    assert.deepEqual(await ids("parser", "pinned:false"), [CHILD]);
  });

  it("matches label: in the thread index and in Pi's label entries", async () => {
    assert.deepEqual(await ids("label:parser"), [PARENT]);
    assert.deepEqual(await ids("label:checkpoint"), [CHILD]);
  });

  it("compares after: with the last update and created_after: with the creation time", async () => {
    // PORT was created before the bound (2026-10-11T10:00Z) and updated after it.
    assert.deepEqual(await ids("after:7d"), [CHILD, PARENT, NOTES, PORT]);
    assert.deepEqual(await ids("created_after:7d"), [CHILD, PARENT, NOTES]);
    assert.deepEqual(await ids("updated_before:7d"), [OLD]);
  });

  it("narrows to a directory with cwd:, by model, and by the directory's git remote", async () => {
    assert.deepEqual(await ids("cwd:other"), [PORT, OLD]);
    assert.deepEqual(await ids("model:faux-2"), [CHILD]);
    assert.deepEqual(await ids("repo:acme/parser"), [CHILD, PARENT, NOTES]);
  });

  it("combines filters", async () => {
    assert.deepEqual(await ids("repo:github.com/acme/parser", "archived:false", "model:faux-1", "after:2d"), [PARENT]);
    assert.deepEqual(await ids("port", "cwd:other", "after:week"), [PORT]);
  });
});

describe("ampi threads search: output", () => {
  it("prints the list table with the Archived column", async () => {
    const { result, out, err } = await run(["threads", "find", "release"]);
    assert.deepEqual(result, { code: 0 });
    assert.equal(err, "");
    assert.equal(
      out,
      [
        "ID                                    Title                                         Updated  Messages  Archived",
        "────────────────────────────────────  ────────────────────────────────────────────  ───────  ────────  ────────",
        `${NOTES}  Draft the release notes                       2d ago          2  archived`,
        `${PORT}  Port the docs and keep notes for the release  3d ago          2`,
        "",
      ].join("\n"),
    );
  });

  it("says when nothing matches", async () => {
    const { result, out } = await run(["threads", "search", "nothing", "like", "this"]);
    assert.deepEqual(result, { code: 0 });
    assert.equal(out, "No sessions match.\n");
  });

  it("stops at the limit, 20 by default, and says how many it left out", async () => {
    const { result, out, err } = await run(["threads", "search", "-n", "2", "--json", "after:month"]);
    assert.deepEqual(result, { code: 0 });
    assert.deepEqual(
      out.trimEnd().split("\n").map((line) => JSON.parse(line).id),
      [CHILD, PARENT],
    );
    assert.equal(err, "ampi: showing 2 of 4 matching sessions; --limit shows more.\n");
    assert.equal((await run(["threads", "search", "--limit", "4", "after:month"])).err, "");
  });

  it("prints one JSON object per line: the list's fields and the matched words", async () => {
    const { out } = await run(["threads", "search", "--json", "parser", "label:parser"]);
    const lines = out.trimEnd().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), {
      id: PARENT,
      title: "Rename the parser module",
      created: "2026-10-17T09:00:00.000Z",
      updated: "2026-10-17T09:05:00.000Z",
      messageCount: 2,
      cwd: demo,
      path: JSON.parse(lines[0]).path,
      labels: ["parser"],
      pinned: true,
      matchedTerms: ["parser"],
    });
    assert.ok(JSON.parse(lines[0]).path.endsWith(`_${PARENT}.jsonl`));
  });
});

describe("ampi threads search: errors", () => {
  const usageError = async (args, pattern) => {
    const { result, out, err } = await run(["threads", "search", ...args]);
    assert.deepEqual(result, { code: 2 }, args.join(" "));
    assert.equal(out, "");
    assert.match(err, pattern);
    assert.match(err, /Run ampi threads --help/);
  };

  it("refuses an unknown key and names it", () => usageError(["parser", "visibility:private"], /^ampi: visibility: is not a search key \(in visibility:private\)\./));

  it("refuses commit:, pr: and author: as needing hosted data", async () => {
    await usageError(["commit:abc123"], /^ampi: commit: needs data that a hosted service keeps; it is not available for local sessions/);
    await usageError(["pr:42", "author:me"], /pr: needs data .*\nauthor: needs data/);
  });

  it("refuses a value it cannot read", async () => {
    await usageError(["after:soon"], /^ampi: after:soon has a value search cannot read; after: takes a date/);
    await usageError(["pinned:maybe"], /pinned: takes true or false/);
  });

  it("refuses an empty query and a bad limit", async () => {
    await usageError([], /threads search needs a query/);
    await usageError(["--json"], /threads search needs a query/);
    await usageError(["-n", "0", "parser"], /--limit needs a whole number above 0, not 0/);
  });

  it("says an ampi package without the search is too old, and exits 1", async () => {
    const stub = path.join(temporary, "old-ampi");
    mkdirSync(path.join(stub, "src"), { recursive: true });
    const { result, out, err } = await run(["threads", "search", "parser"], { root: stub, version: "0.0.1" });
    assert.deepEqual(result, { code: 1 });
    assert.equal(out, "");
    assert.equal(err, "ampi: ampi 0.0.1 is too old for threads search; update @skippermissions/ampi (or ampi-cli).\n");
  });

  it("lists search in the thread help", () => {
    assert.match(formatThreadsHelp(), /^ {2}search, find <query\.\.\.>/m);
  });

  it("exits 2 from the command line on an unknown key, and 0 with results", () => {
    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", HOME: temporary };
    delete env.PI_CODING_AGENT_SESSION_DIR;
    const bad = spawnSync(process.execPath, [bin, "threads", "search", "parser", "visibility:private"], { cwd: demo, env, encoding: "utf8" });
    assert.equal(bad.status, 2, bad.stderr);
    assert.match(bad.stderr, /visibility: is not a search key/);
    const good = spawnSync(process.execPath, [bin, "threads", "search", "--json", "parser", "tests"], { cwd: demo, env, encoding: "utf8" });
    assert.equal(good.status, 0, good.stderr);
    assert.deepEqual(
      good.stdout.trimEnd().split("\n").map((line) => JSON.parse(line).id),
      [CHILD],
    );
  });
});
