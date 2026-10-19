// ampi-gui's right pane and its Changes list: parsing git's -z output, the
// list a checkout answers (sections, totals, ranges, the file cap) built from
// temporary Git repositories made here, that git runs without optional locks
// and leaves the index alone, the GET /api/changes and POST /api/review
// routes on a session server and on ampi app's hub (real servers on
// loopback), and the client's pure helpers: rows, totals, order, the refetch
// rule, the debouncer, the pane width and the pane's commands. Git's global
// and system configuration are turned off, so the user's own settings never
// change what a test sees.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const hasGit = spawnSync("git", ["--version"]).status === 0;
const noGit = hasGit ? false : "git is not installed";

const TOKEN = ["changes", "test", "token"].join("-");
const HUB_TOKEN = ["changes", "hub", "token"].join("-");
const WORKER_TOKEN = ["changes", "worker", "token"].join("-");

const changesModule = () => importSource("extensions/ampi-gui/changes.ts");
const clientChanges = () => importSource("extensions/ampi-gui/client/changes.js");

const dirs = [];
const temp = (prefix) => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

// Git without the user's configuration, for the repositories built here and for the code under test.
const savedEnv = {};
const GIT_ENV = { GIT_CONFIG_GLOBAL: "", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
before(() => {
  const config = path.join(temp("ampi-changes-config-"), "gitconfig");
  writeFileSync(config, "");
  GIT_ENV.GIT_CONFIG_GLOBAL = config;
  for (const [name, value] of Object.entries(GIT_ENV)) {
    savedEnv[name] = process.env[name];
    process.env[name] = value;
  }
});
after(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd, ...args) {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[name];
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function write(root, file, content) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), content);
}

const NEWLINE_NAME = "dir/new\nname.txt";

/**
 * A checkout with every kind of change: a staged new file, a staged rename
 * to a name with a newline, a file staged and changed again, an unstaged
 * edit, a deletion, a changed binary file, an untracked text file in a
 * directory with a space and an untracked binary file. Its one commit is a
 * root commit.
 */
function mixedRepo() {
  const root = temp("ampi-changes-mixed-");
  git(root, "init", "-q", "-b", "main");
  write(root, "keep.txt", "1\n2\n3\n");
  write(root, "old name.txt", "a\nb\n");
  write(root, "gone.txt", "x\n");
  write(root, "img.bin", Buffer.from([0x89, 0x50, 0x00, 0x01]));
  write(root, "dir/edit me.ts", "one\n");
  write(root, "clean.txt", "untouched\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  write(root, "added.txt", "1\n2\n");
  git(root, "add", "added.txt");
  git(root, "mv", "old name.txt", NEWLINE_NAME);
  write(root, "dir/edit me.ts", "one\ntwo\n");
  git(root, "add", "dir/edit me.ts");
  write(root, "dir/edit me.ts", "one\ntwo\nthree\n");
  write(root, "keep.txt", "1\ntwo\n3\n");
  rmSync(path.join(root, "gone.txt"));
  write(root, "img.bin", Buffer.from([0x89, 0x50, 0x00, 0x02, 0x03]));
  write(root, "notes dir/untracked file.md", "a\nb\nc");
  write(root, "blob.dat", Buffer.from([0x00, 0x01, 0x02]));
  return root;
}

const file = (path, status, added, removed, extra = {}) => ({ path, oldPath: null, status, added, removed, binary: false, ...extra });

describe("ampi-gui changes: parsing git's -z output", () => {
  it("reads numstat entries, renames with both paths and binary files, with spaces and newlines in paths", async () => {
    const { parseMmrGuiNumstat } = await changesModule();
    const text = ["3\t1\tsrc/a file.ts", "-\t-\timg.bin", "0\t0\t", "old\nname.txt", "new name.txt", "12\t0\tdir/x\ny.md", ""].join("\0");
    assert.deepEqual(parseMmrGuiNumstat(text), [
      { path: "src/a file.ts", oldPath: null, added: 3, removed: 1, binary: false },
      { path: "img.bin", oldPath: null, added: 0, removed: 0, binary: true },
      { path: "new name.txt", oldPath: "old\nname.txt", added: 0, removed: 0, binary: false },
      { path: "dir/x\ny.md", oldPath: null, added: 12, removed: 0, binary: false },
    ]);
    assert.deepEqual(parseMmrGuiNumstat(""), []);
  });

  it("reads status entries with the index's and the worktree's letters, renames, conflicts and untracked files", async () => {
    const { parseMmrGuiStatus } = await changesModule();
    const hash = "0".repeat(40);
    const text = [
      `1 M. N... 100644 100644 100644 ${hash} ${hash} a file.txt`,
      `1 .D N... 100644 100644 000000 ${hash} ${hash} gone.txt`,
      `1 AM N... 000000 100644 100644 ${hash} ${hash} new.txt`,
      `2 R. N... 100644 100644 100644 ${hash} ${hash} R100 dir/new\nname.txt`,
      "old name.txt",
      `u UU N... 100644 100644 100644 100644 ${hash} ${hash} ${hash} both edited.txt`,
      "? untracked dir/x y.md",
      "",
    ].join("\0");
    assert.deepEqual(parseMmrGuiStatus(text), [
      { kind: "tracked", path: "a file.txt", oldPath: null, staged: "M", unstaged: null },
      { kind: "tracked", path: "gone.txt", oldPath: null, staged: null, unstaged: "D" },
      { kind: "tracked", path: "new.txt", oldPath: null, staged: "A", unstaged: "M" },
      { kind: "tracked", path: "dir/new\nname.txt", oldPath: "old name.txt", staged: "R", unstaged: null },
      { kind: "tracked", path: "both edited.txt", oldPath: null, staged: null, unstaged: "M" },
      { kind: "untracked", path: "untracked dir/x y.md" },
    ]);
  });

  it("reads name-status entries, copies as added and type changes as modified", async () => {
    const { parseMmrGuiNameStatus } = await changesModule();
    const text = ["M", "a b.ts", "R087", "old.ts", "new\n.ts", "C075", "src.ts", "copy.ts", "T", "link", "D", "gone", ""].join("\0");
    assert.deepEqual(parseMmrGuiNameStatus(text), [
      { path: "a b.ts", oldPath: null, status: "M" },
      { path: "new\n.ts", oldPath: "old.ts", status: "R" },
      { path: "copy.ts", oldPath: "src.ts", status: "A" },
      { path: "link", oldPath: null, status: "M" },
      { path: "gone", oldPath: null, status: "D" },
    ]);
  });
});

describe("ampi-gui changes: a checkout's list", { skip: noGit }, () => {
  let mixed;
  before(() => {
    mixed = mixedRepo();
  });

  it("lists staged and unstaged files with their status and lines, and the totals over them", async () => {
    const { readMmrGuiChanges } = await changesModule();
    const { status, body } = await readMmrGuiChanges(path.join(mixed, "dir"), "uncommitted");
    assert.equal(status, 200);
    assert.equal(body.repo, true);
    assert.equal(body.root, mixed, "the root, also from a subdirectory");
    assert.equal(body.branch, "main");
    assert.equal(body.range, "uncommitted");
    assert.deepEqual(body.ranges, [
      { id: "uncommitted", label: "Uncommitted" },
      { id: "last-commit", label: "Last commit" },
    ]);
    assert.deepEqual(body.sections, [
      {
        id: "staged",
        label: "Staged",
        files: [file("added.txt", "A", 2, 0), file("dir/edit me.ts", "M", 1, 0), file(NEWLINE_NAME, "R", 0, 0, { oldPath: "old name.txt" })],
      },
      {
        id: "unstaged",
        label: "Unstaged",
        files: [
          file("blob.dat", "A", 0, 0, { binary: true }),
          file("dir/edit me.ts", "M", 1, 0),
          file("gone.txt", "D", 0, 1),
          file("img.bin", "M", 0, 0, { binary: true }),
          file("keep.txt", "M", 1, 1),
          file("notes dir/untracked file.md", "A", 3, 0),
        ],
      },
    ]);
    // 2 + 1 staged, 1 + 1 + 3 unstaged; one removal each in gone.txt and keep.txt; dir/edit me.ts counts once.
    assert.deepEqual(body.totals, { added: 8, removed: 2, files: 8 });
    assert.equal(body.truncated, false);
  });

  it("runs git with fixed arguments, a -- separator, a 10 s timeout and GIT_OPTIONAL_LOCKS=0", async () => {
    const { readMmrGuiChanges } = await changesModule();
    const { runMmrGuiFile } = await importSource("extensions/ampi-gui/new-thread.ts");
    const calls = [];
    const run = (command, args, options) => {
      calls.push({ command, args, options });
      return runMmrGuiFile(command, args, options);
    };
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(tmpdir(), "not-this-repository");
    try {
      assert.equal((await readMmrGuiChanges(mixed, "uncommitted", { run })).status, 200, "a GIT_DIR around the process does not redirect git");
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
    assert.ok(calls.length >= 4);
    for (const { command, args, options } of calls) {
      assert.equal(command, "git");
      assert.deepEqual(args.slice(0, 4), ["-C", mixed, "-c", "core.fsmonitor=false"]);
      assert.equal(options.env.GIT_OPTIONAL_LOCKS, "0", args.join(" "));
      assert.equal(options.env.GIT_DIR, undefined);
      assert.equal(options.timeout, 10_000);
      if (["status", "diff", "diff-files"].includes(args[4])) assert.equal(args.at(-1), "--", `${args[4]} ends its options with --`);
    }
    assert.ok(calls.some(({ args }) => args.includes("--porcelain=v2") && args.includes("-z") && args.includes("--untracked-files=all")));
    assert.ok(calls.some(({ args }) => args[4] === "diff" && args.includes("--cached") && args.includes("--numstat")));
  });

  it("leaves the index file alone, where a plain git diff would rewrite it", async () => {
    const { readMmrGuiChanges } = await changesModule();
    const index = path.join(mixed, ".git", "index");
    // A tracked file whose stat no longer matches the index: git wants to refresh the index.
    const later = new Date(Date.now() + 3_600_000);
    utimesSync(path.join(mixed, "clean.txt"), later, later);
    const before = statSync(index).mtimeMs;
    for (const range of ["uncommitted", "last-commit"]) assert.equal((await readMmrGuiChanges(mixed, range)).status, 200);
    assert.equal(statSync(index).mtimeMs, before, "the index was not written");
    git(mixed, "diff", "--numstat");
    assert.notEqual(statSync(index).mtimeMs, before, "the check above would notice a write");
  });

  it("lists a root commit against the empty tree for Last commit", async () => {
    const { readMmrGuiChanges } = await changesModule();
    const { body } = await readMmrGuiChanges(mixed, "last-commit");
    assert.equal(body.range, "last-commit");
    assert.deepEqual(body.sections, [
      {
        id: "commits",
        label: "Committed",
        files: [
          file("clean.txt", "A", 1, 0),
          file("dir/edit me.ts", "A", 1, 0),
          file("gone.txt", "A", 1, 0),
          file("img.bin", "A", 0, 0, { binary: true }),
          file("keep.txt", "A", 3, 0),
          file("old name.txt", "A", 2, 0),
        ],
      },
    ]);
    assert.deepEqual(body.totals, { added: 8, removed: 0, files: 6 });
  });

  it("answers Uncommitted for a range the checkout does not have", async () => {
    const { readMmrGuiChanges } = await changesModule();
    const { body } = await readMmrGuiChanges(mixed, "branch");
    assert.equal(body.range, "uncommitted", "no upstream and no origin: no Branch range");
    assert.equal(body.sections[0].id, "staged");
  });

  it("lists the staged files of a repository with no commits, which has only Uncommitted", async () => {
    const { readMmrGuiChanges } = await changesModule();
    const root = temp("ampi-changes-unborn-");
    git(root, "init", "-q", "-b", "trunk");
    write(root, "first.txt", "a\nb\n");
    git(root, "add", "first.txt");
    write(root, "later.txt", "c\n");
    for (const range of ["uncommitted", "last-commit"]) {
      const { status, body } = await readMmrGuiChanges(root, range);
      assert.equal(status, 200);
      assert.equal(body.branch, "trunk");
      assert.equal(body.range, "uncommitted");
      assert.deepEqual(body.ranges, [{ id: "uncommitted", label: "Uncommitted" }]);
      assert.deepEqual(
        body.sections.map((section) => [section.id, section.files]),
        [
          ["staged", [file("first.txt", "A", 2, 0)]],
          ["unstaged", [file("later.txt", "A", 1, 0)]],
        ],
      );
    }
  });

  it("answers repo false outside a Git checkout, and no sections for a clean one", async () => {
    const { readMmrGuiChanges } = await changesModule();
    const outside = await readMmrGuiChanges(temp("ampi-changes-plain-"), "uncommitted");
    assert.deepEqual(outside, {
      status: 200,
      body: { repo: false, root: null, branch: null, range: "uncommitted", ranges: [], sections: [], totals: { added: 0, removed: 0, files: 0 }, truncated: false },
    });
    const clean = temp("ampi-changes-clean-");
    git(clean, "init", "-q", "-b", "main");
    write(clean, "a.txt", "a\n");
    git(clean, "add", "a.txt");
    git(clean, "commit", "-q", "-m", "a");
    const { body } = await readMmrGuiChanges(clean, "uncommitted");
    assert.equal(body.repo, true);
    assert.deepEqual(body.sections, []);
    assert.deepEqual(body.totals, { added: 0, removed: 0, files: 0 });
  });

  it("compares a branch with its upstream, else with origin's default branch", async () => {
    const { readMmrGuiChanges } = await changesModule();
    const remote = temp("ampi-changes-remote-");
    git(remote, "init", "-q", "--bare", "-b", "main");
    const root = temp("ampi-changes-clone-");
    git(root, "init", "-q", "-b", "main");
    git(root, "remote", "add", "origin", remote);
    write(root, "base.txt", "base\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    git(root, "push", "-q", "-u", "origin", "main");
    git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

    // feature tracks origin/feature, which has its first commit only.
    git(root, "switch", "-q", "-c", "feature");
    write(root, "pushed.txt", "1\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "pushed");
    git(root, "push", "-q", "-u", "origin", "feature");
    write(root, "base.txt", "base\nmore\n");
    write(root, "local.txt", "1\n2\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "local");
    let { body } = await readMmrGuiChanges(root, "branch");
    assert.equal(body.range, "branch");
    assert.deepEqual(body.ranges.at(-1), { id: "branch", label: "Branch vs origin/feature" });
    assert.deepEqual(body.sections, [{ id: "commits", label: "Committed", files: [file("base.txt", "M", 1, 0), file("local.txt", "A", 2, 0)] }]);

    // topic has no upstream: origin's default branch is the base.
    git(root, "switch", "-q", "-c", "topic", "--no-track", "origin/main");
    write(root, "topic.txt", "t\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "topic");
    ({ body } = await readMmrGuiChanges(root, "branch"));
    assert.deepEqual(body.ranges.at(-1), { id: "branch", label: "Branch vs origin/main" });
    assert.deepEqual(body.sections[0].files, [file("topic.txt", "A", 1, 0)]);

    // Last commit is the one commit on top.
    ({ body } = await readMmrGuiChanges(root, "last-commit"));
    assert.deepEqual(body.sections[0].files, [file("topic.txt", "A", 1, 0)]);
  });

  it("lists at most 2000 files, in section order, and says the list is cut", async () => {
    const { readMmrGuiChanges, MMR_GUI_CHANGES_FILE_LIMIT } = await changesModule();
    assert.equal(MMR_GUI_CHANGES_FILE_LIMIT, 2000);
    const root = temp("ampi-changes-many-");
    git(root, "init", "-q", "-b", "main");
    write(root, "staged.txt", "s\n");
    git(root, "add", "staged.txt");
    for (let index = 0; index <= 2000; index++) write(root, `many/f${String(index).padStart(4, "0")}.txt`, "x\n");
    const { body } = await readMmrGuiChanges(root, "uncommitted");
    assert.equal(body.truncated, true);
    assert.deepEqual(
      body.sections.map((section) => [section.id, section.files.length]),
      [
        ["staged", 1],
        ["unstaged", 1999],
      ],
    );
    assert.equal(body.sections[1].files.at(-1).path, "many/f1998.txt");
    assert.deepEqual(body.totals, { added: 2000, removed: 0, files: 2000 });
  });

  it("counts an untracked file's lines in its first megabyte", async () => {
    const { readMmrGuiChanges, MMR_GUI_UNTRACKED_READ_BYTES } = await changesModule();
    const root = temp("ampi-changes-big-");
    git(root, "init", "-q", "-b", "main");
    write(root, "big.log", "x\n".repeat(MMR_GUI_UNTRACKED_READ_BYTES));
    const { body } = await readMmrGuiChanges(root, "uncommitted");
    assert.deepEqual(body.sections[0].files, [file("big.log", "A", MMR_GUI_UNTRACKED_READ_BYTES / 2, 0)]);
  });
});

// ---------------------------------------------------------------------------
// Routes

function send(port, { method = "GET", target, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path: target, headers: { Host: `127.0.0.1:${port}`, ...headers }, setHost: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

describe("ampi-gui changes: the session server's routes", { skip: noGit }, () => {
  let server;
  let mock;
  let context;
  let repo;
  let plain;
  let registry;
  const cookie = () => ({ Cookie: `ampi_gui_${server.port}=${TOKEN}` });
  const get = (target, headers = cookie()) => send(server.port, { target, headers });
  const post = (route, body = {}) =>
    send(server.port, {
      method: "POST",
      target: `/api/${route}`,
      headers: { ...cookie(), Origin: `http://127.0.0.1:${server.port}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  before(async () => {
    repo = mixedRepo();
    plain = temp("ampi-changes-elsewhere-");
    const { startMmrGuiServer } = await importSource("extensions/ampi-gui/server.ts");
    const { createMmrGuiBridge } = await importSource("extensions/ampi-gui/bridge.ts");
    const { createMmrGuiCommands } = await importSource("extensions/ampi-gui/commands.ts");
    const { createMmrGuiSessions } = await importSource("extensions/ampi-gui/sessions.ts");
    registry = await importSource("extensions/ampi-core/command-registry.ts");
    mock = createMockPi();
    context = createMockExtensionContext({ cwd: repo, sessionId: "s-live", sessionName: "Changes test" });
    const bridge = createMmrGuiBridge(mock.pi);
    bridge.start(context.ctx);
    const other = { path: "/sessions/s-other.jsonl", id: "s-other", cwd: plain, created: new Date(0), modified: new Date(0), messageCount: 1, firstMessage: "x", allMessagesText: "" };
    const sessions = createMmrGuiSessions({ source: { listSessions: async () => [other] }, current: () => bridge.session() });
    server = await startMmrGuiServer({
      bridge,
      commands: createMmrGuiCommands(mock.pi, bridge, sessions),
      sessions,
      token: TOKEN,
      clientDir: path.join(getPreparedSourceRoot(), "extensions/ampi-gui/client"),
    });
  });
  after(() => server?.close());

  it("refuses a request without the token, from another Host or from another Origin", async () => {
    const target = "/api/changes?sessionId=s-live";
    assert.equal((await get(target, {})).status, 401);
    assert.equal((await get(target, { ...cookie(), Host: `evil.example:${server.port}` })).status, 403);
    assert.equal((await get(target, { ...cookie(), Origin: "http://evil.example" })).status, 403);
    const own = await get(target, { ...cookie(), Origin: `http://127.0.0.1:${server.port}` });
    assert.equal(own.status, 200);
    assert.equal(own.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(own.headers["access-control-allow-origin"], undefined);
  });

  it("answers the live session's checkout and a listed session's directory, and 400 or 404 for what does not parse or exist", async () => {
    const live = (await get("/api/changes?sessionId=s-live&range=uncommitted")).json();
    assert.equal(live.root, repo);
    assert.deepEqual(live.totals, { added: 8, removed: 2, files: 8 });
    assert.equal((await get("/api/changes?sessionId=s-other")).json().repo, false);
    assert.equal((await get("/api/changes?sessionId=s-live&range=everything")).status, 400);
    assert.equal((await get("/api/changes?sessionId=..%2Fx")).status, 400);
    assert.equal((await get("/api/changes")).status, 400);
    assert.equal((await get("/api/changes?sessionId=s-none")).status, 404);
  });

  it("asks for a review as a follow-up message, or runs a registered review command", async () => {
    const { MMR_GUI_REVIEW_PROMPT } = await importSource("extensions/ampi-gui/commands.ts");
    mock.calls.sendUserMessage.length = 0;
    let answer = await post("review");
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json(), { ok: true, delivered: "prompt" });
    context.state.idle = false;
    assert.deepEqual((await post("review")).json(), { ok: true, delivered: "followUp" });
    context.state.idle = true;
    assert.deepEqual(mock.calls.sendUserMessage, [
      { content: MMR_GUI_REVIEW_PROMPT, options: { deliverAs: "followUp" } },
      { content: MMR_GUI_REVIEW_PROMPT, options: { deliverAs: "followUp" } },
    ]);
    assert.match(MMR_GUI_REVIEW_PROMPT, /uncommitted changes/);
    assert.match(MMR_GUI_REVIEW_PROMPT, /by severity/);

    const ran = [];
    registry.registerMmrCommand({ id: "thread.review", noun: "thread", verb: "review", description: "Review", run: (ctx) => ran.push(ctx.cwd) });
    try {
      answer = await post("review");
      assert.deepEqual(answer.json(), { ok: true, ran: "thread.review" });
      assert.deepEqual(ran, [repo]);
      assert.equal(mock.calls.sendUserMessage.length, 2, "no message when the command runs");
    } finally {
      registry.unregisterMmrCommand("thread.review");
    }
  });
});

describe("ampi-gui changes: ampi app's hub", { skip: noGit }, () => {
  let hub;
  let worker;
  let repo;
  const starts = [];
  const hubHeaders = (extra = {}) => ({ Host: `127.0.0.1:${hub.port}`, Cookie: `ampi_gui_${hub.port}=${HUB_TOKEN}`, ...extra });

  before(async () => {
    repo = mixedRepo();
    // The worker a send or a review starts: a server that records what reaches it.
    const received = [];
    const recorder = createServer((req, res) => {
      let text = "";
      req.on("data", (chunk) => {
        text += chunk;
      });
      req.on("end", () => {
        received.push({ method: req.method, url: req.url, cookie: req.headers.cookie, body: text });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, delivered: "prompt" }));
      });
    });
    await new Promise((resolve) => recorder.listen(0, "127.0.0.1", resolve));
    worker = { server: recorder, received };
    const info = { path: path.join(temp("ampi-changes-hub-"), "s-dormant.jsonl"), id: "s-dormant", cwd: repo, created: new Date(0), modified: new Date(0), messageCount: 2, firstMessage: "x", allMessagesText: "" };
    const sessions = {
      list: async () => ({ currentId: null, groups: [], actions: {} }),
      view: async () => undefined,
      find: async (id) => (id === info.id ? info : undefined),
      read: async () => ({ header: null, branch: [], entries: [] }),
      searchable: async () => ({ now: 0, home: "/", rows: [] }),
      invalidate() {},
    };
    const { startMmrGuiHub } = await importSource("extensions/ampi-gui/hub.ts");
    hub = await startMmrGuiHub({
      token: HUB_TOKEN,
      clientDir: path.join(getPreparedSourceRoot(), "extensions/ampi-gui/client"),
      startSession: async (request) => {
        starts.push(request);
        return {
          pid: 7_200_001,
          port: recorder.address().port,
          token: WORKER_TOKEN,
          sessionId: "s-dormant",
          sessionPath: request.path,
          stop: async () => {},
          onExit() {},
          onActivity() {},
        };
      },
      sessions,
      commands: {},
      exportSession: async () => ({ status: 404, body: { error: "none" } }),
      modes: () => ({ modes: [], models: [], current: null }),
      registry: { dir: path.join(temp("ampi-changes-live-"), "live"), isAlive: () => false, procStart: () => null },
      setTimer: () => ({}),
      clearTimer: () => {},
    });
  });
  after(async () => {
    await hub?.close();
    await new Promise((resolve) => worker?.server.close(resolve));
  });

  it("serves a session nothing runs from its directory, without starting a worker", async () => {
    const answer = await send(hub.port, { target: "/api/changes?sessionId=s-dormant&range=uncommitted", headers: hubHeaders() });
    assert.equal(answer.status, 200);
    assert.equal(answer.json().root, repo);
    assert.equal(answer.json().totals.files, 8);
    assert.deepEqual(starts, []);
    assert.equal((await send(hub.port, { target: "/api/changes?sessionId=s-dormant" })).status, 401, "the token is required");
    assert.equal((await send(hub.port, { target: "/api/changes?sessionId=s-unknown", headers: hubHeaders() })).status, 404);
  });

  it("starts a worker for Review on a session nothing runs and forwards it, as for a send", async () => {
    const answer = await send(hub.port, {
      method: "POST",
      target: "/s/s-dormant/api/review",
      headers: hubHeaders({ Origin: `http://127.0.0.1:${hub.port}`, "Content-Type": "application/json" }),
      body: "{}",
    });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json(), { ok: true, delivered: "prompt" });
    assert.equal(starts.length, 1);
    assert.deepEqual(
      worker.received.map(({ method, url, cookie }) => [method, url, cookie]),
      [["POST", "/api/review", `ampi_gui_${worker.server.address().port}=${WORKER_TOKEN}`]],
    );
  });
});

// ---------------------------------------------------------------------------
// The client's helpers

describe("ampi-gui changes: the Changes tab's rows and toolbar", () => {
  it("escapes every part of a file's row", async () => {
    const { changeFileHtml, changesSectionsHtml } = await clientChanges();
    const nasty = { path: `src/<script>"x"/a&b'<img src=x onerror=alert(1)>.ts`, oldPath: "<old>.ts", status: "R", added: 1, removed: 2, binary: false };
    const html = changeFileHtml(nasty, { section: "staged", index: 0 });
    assert.ok(!/<(script|img)\b/.test(html), html);
    assert.ok(!html.includes(`"x"`), "quotes cannot end an attribute");
    assert.match(html, /<span class="change-file">a&#38;b&#39;&#60;img src=x onerror=alert\(1\)&#62;\.ts<\/span>/);
    assert.match(html, /<span class="change-dir">src\/&#60;script&#62;&#34;x&#34;<\/span>/);
    assert.match(html, /title="src\/&#60;script&#62;[^"]*\nRenamed from &#60;old&#62;\.ts"/);
    assert.match(html, /aria-label="Actions for src\/&#60;script&#62;/);
    const section = changesSectionsHtml([{ id: "unstaged", label: "<b>Unstaged</b>", files: [nasty] }], "path");
    assert.ok(section.includes("&#60;b&#62;Unstaged&#60;/b&#62;"));
  });

  it("shows +N and -M only when not zero, binary for a binary file, and the status badge", async () => {
    const { changeFileHtml } = await clientChanges();
    const row = (fields) => changeFileHtml({ path: "a/b.ts", oldPath: null, status: "M", added: 0, removed: 0, binary: false, ...fields }, { section: "s", index: 3 });
    assert.match(row({ added: 6, removed: 2 }), /<span class="change-added">\+6<\/span> <span class="change-removed">-2<\/span>/);
    assert.ok(!row({ added: 1 }).includes("change-removed"));
    assert.match(row({ binary: true }), /<span class="change-binary">binary<\/span>/);
    assert.match(row({ status: "D" }), /<span class="change-badge" data-status="D" title="Deleted">D<\/span>/);
    assert.match(row({}), /data-section="s" data-index="3"/);
    assert.ok(!row({ path: "root.txt" }).includes("change-dir"), "a file at the root has no directory");
  });

  it("orders by path or by changed lines, and sums the totals in words", async () => {
    const { orderChangedFiles, changesTotals, changesEmptyText } = await clientChanges();
    const files = [
      { path: "b.ts", added: 1, removed: 1 },
      { path: "a.ts", added: 1, removed: 0 },
      { path: "c.ts", added: 10, removed: 0 },
      { path: "0.ts", added: 2, removed: 0 },
    ];
    assert.deepEqual(
      orderChangedFiles(files, "path").map((entry) => entry.path),
      ["0.ts", "a.ts", "b.ts", "c.ts"],
    );
    assert.deepEqual(
      orderChangedFiles(files, "churn").map((entry) => entry.path),
      ["c.ts", "0.ts", "b.ts", "a.ts"],
      "equal counts keep path order",
    );
    assert.equal(files[0].path, "b.ts", "the section's own list stays as it was");
    const totals = changesTotals({ added: 17, removed: 7, files: 1 });
    assert.equal(totals.html, '<span class="change-added">+17</span> <span class="change-removed">-7</span> <span class="change-files">~1</span>');
    assert.equal(totals.title, "17 lines added and 7 lines removed, in 1 file");
    assert.equal(changesTotals({ added: 1, removed: 0, files: 3 }).title, "1 line added and 0 lines removed, in 3 files");
    assert.equal(changesEmptyText({ data: null }), "Loading…");
    assert.equal(changesEmptyText({ data: { repo: false, sections: [] } }), "Not a Git checkout");
    assert.equal(changesEmptyText({ data: { repo: true, sections: [] } }), "No changes");
    assert.equal(changesEmptyText({ data: { repo: true, sections: [{}] } }), null);
    assert.equal(changesEmptyText({ data: null, error: "git failed" }), "git failed");
  });

  it("refetches once per burst of edit, write and shell calls that ended", async () => {
    const { changesRefetchFor, createDebouncer, REFETCH_MS, changesUrl } = await clientChanges();
    const part = (name, status) => ({ type: "tool", toolCallId: "c1", name, status, title: [] });
    for (const name of ["edit", "write", "bash", "apply_patch"]) {
      assert.equal(changesRefetchFor(part(name, "done")), true, name);
      assert.equal(changesRefetchFor(part(name, "error")), true, `${name} that failed may have changed files`);
      assert.equal(changesRefetchFor(part(name, "running")), false, `${name} still running`);
    }
    assert.equal(changesRefetchFor(part("read", "done")), false);
    assert.equal(changesRefetchFor(undefined), false);

    assert.equal(REFETCH_MS, 500);
    const timers = new Map();
    let next = 0;
    const debouncer = createDebouncer({
      ms: REFETCH_MS,
      setTimer: (callback, ms) => {
        timers.set(++next, { callback, ms });
        return next;
      },
      clearTimer: (id) => timers.delete(id),
    });
    let runs = 0;
    for (let index = 0; index < 3; index++) debouncer.call(() => runs++);
    assert.equal(timers.size, 1, "each call replaces the waiting one");
    const [only] = timers.values();
    assert.equal(only.ms, 500);
    only.callback();
    assert.equal(runs, 1);
    debouncer.call(() => runs++);
    debouncer.cancel();
    assert.equal(timers.size, 1, "the run timer is gone, the cancelled one too");
    assert.equal(changesUrl("s 1", "last-commit"), "/api/changes?sessionId=s+1&range=last-commit");
  });
});

describe("ampi-gui right pane: width and commands", () => {
  it("keeps the pane between its narrowest and widest width, 520 px by default", async () => {
    const { clampRightPaneWidth, RIGHT_PANE_WIDTH } = await importSource("extensions/ampi-gui/client/right-pane.js");
    assert.equal(RIGHT_PANE_WIDTH.default, 520);
    assert.equal(clampRightPaneWidth(Number.NaN), 520);
    assert.equal(clampRightPaneWidth(100), RIGHT_PANE_WIDTH.min);
    assert.equal(clampRightPaneWidth(5000), RIGHT_PANE_WIDTH.max);
    assert.equal(clampRightPaneWidth(600.4), 600);
  });

  it("binds the pane's keys and Run Review without conflicts, on session pages only", async () => {
    const { DEFAULT_COMMANDS } = await importSource("extensions/ampi-gui/client/commands.js");
    const { findConflicts } = await importSource("extensions/ampi-gui/client/keys.js");
    const get = (id) => DEFAULT_COMMANDS.find((entry) => entry.id === id);
    assert.deepEqual(
      ["show-changes", "toggle-right-pane", "toggle-focus-pane", "run-review", "focus-prompt"].map((id) => get(id).keys),
      [["ctrl+shift+g"], ["mod+alt+b"], ["mod+alt+f"], ["ctrl+g r"], ["ctrl+shift+a"]],
    );
    assert.equal(get("run-review").palette.title, "Run Review");
    assert.deepEqual(findConflicts(DEFAULT_COMMANDS), []);
    assert.deepEqual(findConflicts(DEFAULT_COMMANDS, { mac: true }), []);
    for (const id of ["show-changes", "toggle-right-pane", "toggle-focus-pane", "run-review"]) {
      assert.equal(get(id).when({ threadPage: false, writable: true }).state, "hidden", id);
      assert.equal(get(id).when({ threadPage: true, writable: true }).state, "available", id);
    }
    assert.equal(get("run-review").when({ threadPage: true, writable: false }).reason, "This session is read-only here");
    const ran = [];
    const ui = new Proxy({}, { get: (_, name) => (...args) => ran.push([name, ...args]) });
    for (const id of ["show-changes", "toggle-right-pane", "toggle-focus-pane", "run-review"]) get(id).run({ ui });
    assert.deepEqual(ran, [["showPaneTab", "changes"], ["toggleRightPane"], ["toggleFocusPane"], ["runReview"]]);
  });
});
