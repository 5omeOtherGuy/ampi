// `ampi threads …` and `ampi last` (packages/ampi-cli/src/threads.js): each
// command against a temporary agent directory whose sessions are written
// through Pi's SessionManager on a fixed clock, with hand-written expected
// output; prefix resolution and delete refusals; and the thread index file
// shared with ampi-threads, read and written from both sides. The last suite
// spawns the command for the exit codes and the confirmation question.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";
import * as pi from "@earendil-works/pi-coding-agent";
import { routeAmpiArgv } from "../packages/ampi-cli/src/argv.js";
import { formatThreadMarkdown } from "../packages/ampi-cli/src/thread-markdown.js";
import { readThreadIndex, threadIndexPath, updateThreadRecord, validateThreadLabels } from "../packages/ampi-cli/src/thread-index.js";
import { formatThreadsHelp, runThreadsCommand } from "../packages/ampi-cli/src/threads.js";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const bin = path.join(repoRoot, "packages", "ampi-cli", "bin", "ampi.js");
const markdownFixtures = path.join(import.meta.dirname, "fixtures", "ampi-threads-markdown");

const NOW = Date.parse("2026-10-18T10:00:00.000Z");
const DEMO = "/work/demo";
const OTHER = "/work/other";
const A = "019a0000-aaaa-7000-8000-000000000001";
const B = "019a0000-aaaa-7000-8000-000000000002";
const C = "019a0000-bbbb-7000-8000-000000000003";
const D = "019b1111-cccc-7000-8000-000000000004";
const FIXTURE_ID = "0199a0de-5c1e-7a00-8000-000000000001";

const savedEnv = { agentDir: process.env.PI_CODING_AGENT_DIR, sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR };
const temporary = mkdtempSync(path.join(tmpdir(), "ampi-cli-threads-"));

after(() => {
  for (const [name, value] of [
    ["PI_CODING_AGENT_DIR", savedEnv.agentDir],
    ["PI_CODING_AGENT_SESSION_DIR", savedEnv.sessionDir],
  ]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(temporary, { recursive: true, force: true });
  cleanupLoadedSource();
});

const at = (iso) => Date.parse(iso);
const user = (text, iso) => ({ role: "user", content: text, timestamp: at(iso) });
const assistant = (text, iso) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "faux",
  provider: "faux",
  model: "faux-1",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop",
  timestamp: at(iso),
});

/**
 * A fresh agent directory with six sessions written by Pi's SessionManager
 * on a mocked clock, the Markdown fixture session, and thread index records
 * written by ampi-threads' own store. Points Pi at it.
 */
async function createAgentDir(name) {
  const agentDir = path.join(temporary, name);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  const session = (cwd, id, createdIso, messages, sessionName) => {
    mock.timers.setTime(at(createdIso));
    const manager = pi.SessionManager.create(cwd, undefined, { id });
    for (const message of messages) manager.appendMessage(message);
    if (sessionName) manager.appendSessionInfo(sessionName);
    return manager.getSessionFile();
  };
  mock.timers.enable({ apis: ["Date"], now: 0 });
  try {
    session(DEMO, A, "2026-10-18T08:50:00.000Z", [user("Rename the parser module", "2026-10-18T08:50:00.000Z"), assistant("Renamed it.", "2026-10-18T09:00:00.000Z")], "Rename the parser");
    session(DEMO, B, "2026-10-16T09:00:00.000Z", [
      user("Fix the flaky test in the build scripts", "2026-10-16T09:00:00.000Z"),
      assistant("Which one?", "2026-10-16T09:01:00.000Z"),
      user("The one that times out", "2026-10-16T09:02:00.000Z"),
    ]);
    session(DEMO, C, "2026-10-18T09:50:00.000Z", [user("Draft the release notes", "2026-10-18T09:50:00.000Z"), assistant("Drafted.", "2026-10-18T09:55:00.000Z")]);
    session(OTHER, D, "2026-09-01T12:00:00.000Z", [user("Port the docs", "2026-09-01T12:00:00.000Z"), assistant("Ported.", "2026-09-01T12:05:00.000Z")]);
    session(OTHER, "release", "2026-10-10T10:00:00.000Z", [user("Tag the release", "2026-10-10T10:00:00.000Z")]);
    session(OTHER, "release-notes", "2026-10-11T10:00:00.000Z", [user("Write the notes", "2026-10-11T10:00:00.000Z")]);
  } finally {
    mock.timers.reset();
  }
  // The Markdown fixture, in a directory of its own so the listings above stay as they are.
  const fixtureDir = path.join(agentDir, "sessions", "--work-fixture--");
  mkdirSync(fixtureDir, { recursive: true });
  copyFileSync(path.join(markdownFixtures, "session.jsonl"), path.join(fixtureDir, `2026-10-18T10-00-00-000Z_${FIXTURE_ID}.jsonl`));

  const { createMmrThreadIndexStore } = await importSource("extensions/ampi-threads/index-store.ts");
  const store = createMmrThreadIndexStore({ baseDir: path.dirname(threadIndexPath(agentDir)) });
  await store.update(C, { archived: "2026-10-18T09:58:00.000Z" });
  await store.update(A, { labels: ["parser"] });
  return { agentDir, store };
}

/** Run a thread command in /work/demo at NOW, collecting its output. */
async function run(args, { env = {}, columns = 80, confirm } = {}) {
  let out = "";
  let err = "";
  const questions = [];
  const result = await runThreadsCommand(args, {
    pi,
    cwd: DEMO,
    env,
    now: () => NOW,
    columns,
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    confirm: async (question) => {
      questions.push(question);
      if (confirm === undefined) throw new Error(`unexpected question: ${question}`);
      return confirm;
    },
  });
  return { result, out, err, questions };
}

const sessionFile = (agentDir, cwd, createdIso, id) =>
  path.join(agentDir, "sessions", `--${cwd.slice(1).replaceAll("/", "-")}--`, `${createdIso.replace(/[:.]/g, "-")}_${id}.jsonl`);

describe("ampi threads: routing and help", () => {
  it("routes threads and last to the thread commands with the rest of the command line", () => {
    assert.deepEqual(routeAmpiArgv(["threads", "ls", "--all"]).threadArgs, ["threads", "ls", "--all"]);
    assert.equal(routeAmpiArgv(["last"]).command, "threads");
    // Anywhere else they are a message for Pi.
    assert.deepEqual(routeAmpiArgv(["-m", "high", "threads"]).piArgs, ["--ampi-mode", "high", "threads"]);
  });

  it("prints the thread help for --help after any thread command", async () => {
    for (const args of [["threads", "--help"], ["threads", "delete", "-h"], ["threads", "help"], ["last", "--help"]]) {
      const { result, out } = await run(args);
      assert.deepEqual(result, { code: 0 }, args.join(" "));
      assert.equal(out, formatThreadsHelp());
    }
  });
});

describe("ampi threads: reading sessions", () => {
  let agentDir;
  before(async () => {
    ({ agentDir } = await createAgentDir("reading"));
  });

  it("lists this directory's sessions without archived ones, newest first, with titles cut to the width", async () => {
    const { result, out, err } = await run(["threads", "list"]);
    assert.deepEqual(result, { code: 0 });
    assert.equal(err, "");
    assert.equal(
      out,
      [
        "ID                                    Title                    Updated  Messages",
        "────────────────────────────────────  ───────────────────────  ───────  ────────",
        "019a0000-aaaa-7000-8000-000000000001  Rename the parser        1h ago          2",
        "019a0000-aaaa-7000-8000-000000000002  Fix the flaky test in…   2d ago          3",
        "",
      ].join("\n"),
    );
    // `ampi threads` alone lists too.
    assert.equal((await run(["threads"])).out, out);
  });

  it("includes archived sessions with a marker for --archived and --include-archived", async () => {
    const { out } = await run(["threads", "ls", "--archived"], { columns: 140 });
    assert.equal(
      out,
      [
        "ID                                    Title                                    Updated  Messages  Archived",
        "────────────────────────────────────  ───────────────────────────────────────  ───────  ────────  ────────",
        "019a0000-bbbb-7000-8000-000000000003  Draft the release notes                  5m ago          2  archived",
        "019a0000-aaaa-7000-8000-000000000001  Rename the parser                        1h ago          2",
        "019a0000-aaaa-7000-8000-000000000002  Fix the flaky test in the build scripts  2d ago          3",
        "",
      ].join("\n"),
    );
    assert.equal((await run(["threads", "list", "--include-archived"], { columns: 140 })).out, out);
  });

  it("prints one JSON object per line with the catalogue fields and the thread metadata for --json", async () => {
    const { out } = await run(["threads", "list", "--json", "--archived", "--limit", "2"]);
    const demoDir = `${agentDir}/sessions/--work-demo--`;
    assert.equal(
      out,
      [
        `{"id":"${C}","title":"Draft the release notes","created":"2026-10-18T09:50:00.000Z","updated":"2026-10-18T09:55:00.000Z","messageCount":2,"cwd":"/work/demo","path":"${demoDir}/2026-10-18T09-50-00-000Z_${C}.jsonl","archived":"2026-10-18T09:58:00.000Z"}`,
        `{"id":"${A}","title":"Rename the parser","name":"Rename the parser","created":"2026-10-18T08:50:00.000Z","updated":"2026-10-18T09:00:00.000Z","messageCount":2,"cwd":"/work/demo","path":"${demoDir}/2026-10-18T08-50-00-000Z_${A}.jsonl","labels":["parser"]}`,
        "",
      ].join("\n"),
    );
  });

  it("lists every directory for --all, and says so when a directory has no sessions", async () => {
    const { out } = await run(["threads", "list", "--all", "--json"]);
    const ids = out.trim().split("\n").map((line) => JSON.parse(line).id);
    assert.deepEqual(ids, [FIXTURE_ID, A, B, "release-notes", "release", D]);
    const empty = await runThreadsCommand(["threads", "list"], {
      pi,
      cwd: "/work/empty",
      env: {},
      now: () => NOW,
      columns: 80,
      out: (text) => assert.equal(text, "No sessions in this directory. ampi threads list --all lists every directory.\n"),
      err: assert.fail,
      confirm: assert.fail,
    });
    assert.deepEqual(empty, { code: 0 });
  });

  it("lists the session directory PI_CODING_AGENT_SESSION_DIR names", async () => {
    const custom = path.join(temporary, "custom-sessions");
    mock.timers.enable({ apis: ["Date"], now: at("2026-10-17T10:00:00.000Z") });
    try {
      pi.SessionManager.create(DEMO, custom, { id: "custom-1" }).appendMessage(user("Elsewhere", "2026-10-17T10:00:00.000Z"));
    } finally {
      mock.timers.reset();
    }
    for (const args of [["threads", "list", "--json"], ["threads", "list", "--all", "--json"]]) {
      const { out } = await run(args, { env: { PI_CODING_AGENT_SESSION_DIR: custom } });
      assert.deepEqual(out.trim().split("\n").map((line) => JSON.parse(line).id), ["custom-1"], args.join(" "));
    }
  });

  it("resolves an exact id first, then a unique prefix, with or without @, across every directory", async () => {
    for (const [query, id] of [
      [C, C],
      ["019a0000-bbbb", C],
      ["@019b", D],
      ["release", "release"],
      ["release-n", "release-notes"],
    ]) {
      const { result } = await run(["threads", "continue", query]);
      assert.equal(result.piArgs?.[1].endsWith(`_${id}.jsonl`), true, `${query} -> ${JSON.stringify(result)}`);
    }
  });

  it("refuses a prefix that several sessions share, listing them, and an id nothing matches", async () => {
    const shared = await run(["threads", "export", "019a0000-aaaa"]);
    assert.deepEqual(shared.result, { code: 1 });
    assert.equal(shared.out, "");
    assert.equal(
      shared.err,
      [
        "ampi: 019a0000-aaaa matches 2 sessions; give more of the id:",
        `  ${A}  Rename the parser`,
        `  ${B}  Fix the flaky test in the build scripts`,
        "",
      ].join("\n"),
    );
    const missing = await run(["threads", "markdown", "0198"]);
    assert.deepEqual(missing.result, { code: 1 });
    assert.equal(missing.err, "ampi: no session has an id starting with 0198.\n");
  });

  it("continues a session through Pi's --session, opens Pi's picker without an id, and last skips archived sessions", async () => {
    const pathOf = (id, cwd, created) => sessionFile(agentDir, cwd, created, id);
    assert.deepEqual((await run(["threads", "c", "019b"])).result, { piArgs: ["--session", pathOf(D, OTHER, "2026-09-01T12:00:00.000Z")] });
    assert.deepEqual((await run(["threads", "continue"])).result, { piArgs: ["--resume"] });
    // The archived C is newer than A.
    const last = { piArgs: ["--session", pathOf(A, DEMO, "2026-10-18T08:50:00.000Z")] };
    assert.deepEqual((await run(["last"])).result, last);
    assert.deepEqual((await run(["threads", "continue", "--last"])).result, last);
  });

  it("prints a session as the same Markdown ampi-threads exports", async () => {
    const { result, out } = await run(["threads", "md", "0199a0de"]);
    assert.deepEqual(result, { code: 0 });
    assert.equal(out, readFileSync(path.join(markdownFixtures, "session.md"), "utf8"));
  });

  it("titles a session without a name by its first prompt, and leaves out an unknown mode", () => {
    const entries = [
      { type: "session", version: 3, id: "s-1", timestamp: "2026-10-18T10:00:00.000Z", cwd: DEMO },
      { type: "custom", id: "m", parentId: null, customType: "ampi-core.mode-state", data: { version: 1, mode: "deep" } },
      { type: "message", id: "u", parentId: "m", message: user("Go\non", "2026-10-18T10:00:00.000Z") },
    ];
    assert.equal(
      formatThreadMarkdown(entries),
      '---\ntitle: "Go on"\nsessionId: "s-1"\ncreated: "2026-10-18T10:00:00.000Z"\nmode: "high"\n---\n\n# Go on\n\n## User\n\nGo\non\n',
    );
    entries[1].data.mode = "turbo";
    assert.ok(!formatThreadMarkdown(entries).includes("mode:"));
  });

  it("exports the session's metadata and every entry of its file as JSON", async () => {
    const { result, out } = await run(["threads", "export", A]);
    assert.deepEqual(result, { code: 0 });
    const file = sessionFile(agentDir, DEMO, "2026-10-18T08:50:00.000Z", A);
    const exported = JSON.parse(out);
    const { entries, ...metadata } = exported;
    assert.deepEqual(metadata, {
      id: A,
      title: "Rename the parser",
      name: "Rename the parser",
      created: "2026-10-18T08:50:00.000Z",
      updated: "2026-10-18T09:00:00.000Z",
      messageCount: 2,
      cwd: DEMO,
      path: file,
      labels: ["parser"],
    });
    assert.deepEqual(
      entries.map((entry) => entry.type),
      ["session", "message", "message", "session_info"],
    );
    assert.deepEqual(entries, readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)));
  });

  it("exits 2 on usage errors", async () => {
    for (const [args, message] of [
      [["threads", "frobnicate"], "unknown thread command frobnicate."],
      [["threads", "list", "--limit", "0"], "--limit needs a whole number above 0, not 0."],
      [["threads", "markdown"], "threads markdown takes one session id."],
      [["threads", "continue", A, B], "threads continue takes one session id."],
      [["threads", "rename", A], "threads rename takes a session id and a title."],
      [["threads", "label", A, "Bad_Label"], 'label "Bad_Label" is not allowed: use lowercase letters, digits and hyphens.'],
      [["last", "now"], "last takes no arguments, not now."],
    ]) {
      const { result, err } = await run(args);
      assert.deepEqual(result, { code: 2 }, args.join(" "));
      assert.equal(err, `ampi: ${message}\nRun ampi threads --help for the thread commands.\n`);
    }
    const { result, err } = await run(["threads", "list", "--bogus"]);
    assert.deepEqual(result, { code: 2 });
    assert.match(err, /^ampi: threads list: Unknown option '--bogus'/);
  });
});

describe("ampi threads: changing sessions", () => {
  let agentDir;
  let store;
  before(async () => {
    ({ agentDir, store } = await createAgentDir("changing"));
  });

  it("renames a session with Pi's session name and marks the title as the user's", async () => {
    const { result, out } = await run(["threads", "rename", "019a0000-aaaa-7000-8000-000000000002", "Flaky", "build", "test"]);
    assert.deepEqual(result, { code: 0 });
    assert.equal(out, `Renamed ${B} to "Flaky build test".\n`);
    const [info] = (await pi.SessionManager.list(DEMO)).filter((session) => session.id === B);
    assert.equal(info.name, "Flaky build test");
    assert.deepEqual(await store.get(B), { titleSource: "user" });
  });

  it("archives and unarchives a session, and says when nothing changes", async () => {
    assert.equal((await run(["threads", "archive", "019a0000-aaaa-7000-8000-000000000002"])).out, `Archived ${B} (Flaky build test).\n`);
    assert.deepEqual(await store.get(B), { titleSource: "user", archived: new Date(NOW).toISOString() });
    assert.ok(!(await run(["threads", "list"])).out.includes(B));
    assert.equal((await run(["threads", "archive", B])).out, `${B} is already archived.\n`);

    assert.equal((await run(["threads", "archive", "--unarchive", B])).out, `Unarchived ${B} (Flaky build test).\n`);
    assert.deepEqual(await store.get(B), { titleSource: "user" });
    assert.equal((await run(["threads", "unarchive", B])).out, `${B} is not archived.\n`);
  });

  it("adds labels to the ones a session has, with the label rules of ampi-threads", async () => {
    const { result, out } = await run(["threads", "label", A, "docs", "parser", "v2"]);
    assert.deepEqual(result, { code: 0 });
    assert.equal(out, `Labels of ${A}: parser, docs, v2.\n`);
    assert.deepEqual((await store.get(A)).labels, ["parser", "docs", "v2"]);

    const many = Array.from({ length: 18 }, (_, index) => `l${index}`);
    const tooMany = await run(["threads", "label", A, ...many]);
    assert.deepEqual(tooMany.result, { code: 1 });
    assert.equal(tooMany.err, "ampi: a session takes at most 20 labels, not 21.\n");
  });

  it("accepts and refuses the same labels as ampi-threads, with the same reasons", async () => {
    const { validateMmrThreadLabels } = await importSource("extensions/ampi-threads/index-store.ts");
    const outcome = (validate, labels) => {
      try {
        return validate(labels);
      } catch (error) {
        return error.message;
      }
    };
    for (const labels of [
      ["a", "b-2", "a"],
      ["UPPER"],
      ["with space"],
      ["x".repeat(32)],
      ["x".repeat(33)],
      [""],
      [7],
      Array.from({ length: 21 }, (_, index) => `l${index}`),
      "not-a-list",
    ]) {
      assert.deepEqual(outcome(validateThreadLabels, labels), outcome(validateMmrThreadLabels, labels), JSON.stringify(labels));
    }
  });

  it("writes an index ampi-threads reads, keeps what it does not change, and refuses one from a newer version", async () => {
    const file = threadIndexPath(agentDir);
    await store.update(D, { color: "blue", pinned: true });
    updateThreadRecord(file, D, { archived: "2026-10-18T09:00:00.000Z" });
    assert.deepEqual(await store.get(D), { color: "blue", pinned: true, archived: "2026-10-18T09:00:00.000Z" });
    updateThreadRecord(file, D, null);
    assert.equal(await store.get(D), undefined);
    assert.deepEqual(Object.keys(readThreadIndex(file)).sort(), [A, B, C].sort());

    const newer = path.join(temporary, "newer-index.json");
    writeFileSync(newer, JSON.stringify({ version: 2, threads: {} }));
    assert.throws(() => readThreadIndex(newer), /index version 2, written by a newer ampi/);
  });

  it("refuses to delete the session the command runs in", async () => {
    const file = sessionFile(agentDir, DEMO, "2026-10-18T09:50:00.000Z", C);
    const { result, err, questions } = await run(["threads", "delete", C], { env: { PI_SESSION_ID: C } });
    assert.deepEqual(result, { code: 1 });
    assert.equal(err, `ampi: ${C} is the session this command runs in; it cannot delete itself.\n`);
    assert.deepEqual(questions, []);
    assert.ok(existsSync(file));
  });

  it("asks before deleting and keeps the session on no", async () => {
    const file = sessionFile(agentDir, DEMO, "2026-10-18T09:50:00.000Z", C);
    const { result, err, questions } = await run(["threads", "delete", "019a0000-bbbb"], { confirm: false });
    assert.deepEqual(result, { code: 1 });
    assert.deepEqual(questions, [`Delete session ${C} (Draft the release notes)? [y/N] `]);
    assert.equal(err, "ampi: nothing was deleted.\n");
    assert.ok(existsSync(file));
  });

  it("deletes the session file and its thread metadata on yes, or without asking for --yes", async () => {
    const fileC = sessionFile(agentDir, DEMO, "2026-10-18T09:50:00.000Z", C);
    const confirmed = await run(["threads", "delete", C], { confirm: true });
    assert.deepEqual(confirmed.result, { code: 0 });
    assert.equal(confirmed.out, `Deleted ${C} (Draft the release notes).\n`);
    assert.ok(!existsSync(fileC));
    assert.equal(await store.get(C), undefined);

    const fileD = sessionFile(agentDir, OTHER, "2026-09-01T12:00:00.000Z", D);
    const unasked = await run(["threads", "delete", "-y", "019b"]);
    assert.deepEqual(unasked.result, { code: 0 });
    assert.deepEqual(unasked.questions, []);
    assert.ok(!existsSync(fileD));
    assert.deepEqual((await run(["threads", "delete", "019b", "--yes"])).result, { code: 1 });
  });
});

describe("ampi threads: the executable", () => {
  let agentDir;
  const workspace = path.join(temporary, "workspace");
  before(async () => {
    ({ agentDir } = await createAgentDir("spawned"));
    mkdirSync(workspace, { recursive: true });
  });
  const spawnBin = (args, input) =>
    spawnSync(process.execPath, [bin, ...args], {
      cwd: workspace,
      encoding: "utf8",
      input,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", HOME: temporary, PI_SESSION_ID: "" },
    });

  it("lists, exits 1 when there is nothing to continue and 2 on a usage error", () => {
    const listed = spawnBin(["threads", "list", "--all", "--json", "--limit", "3"]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(listed.stdout.trim().split("\n").map((line) => JSON.parse(line).id), [FIXTURE_ID, A, B]);

    const last = spawnBin(["last"]);
    assert.equal(last.status, 1);
    assert.equal(last.stderr, "ampi: no session to continue in this directory (archived sessions are skipped).\n");

    assert.equal(spawnBin(["threads", "frobnicate"]).status, 2);
  });

  it("reads the delete confirmation from stdin", () => {
    const file = sessionFile(agentDir, OTHER, "2026-10-10T10:00:00.000Z", "release");
    const declined = spawnBin(["threads", "delete", "release"], "n\n");
    assert.equal(declined.status, 1);
    assert.equal(declined.stderr, "Delete session release (Tag the release)? [y/N] ampi: nothing was deleted.\n");
    assert.ok(existsSync(file));
    assert.equal(spawnBin(["threads", "delete", "release"], "").status, 1, "the end of stdin is no");

    const accepted = spawnBin(["threads", "delete", "release"], "y\n");
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(accepted.stdout, "Deleted release (Tag the release).\n");
    assert.ok(!existsSync(file));
  });
});
