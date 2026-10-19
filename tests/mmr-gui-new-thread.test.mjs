// ampi app's new-thread composer: the POST /api/threads checks, the
// directory list from a fixture catalogue and live registry, the hub's
// routes against a real server (the request policy, the start with its
// mode, the first message, the labels, the thread hosted before the
// catalogue lists it), the mode on its way from `ampi app` to the worker's
// session, and the client's pure parts (submit keys and variants, the
// mention, escaping, the registry's new commands), and New Worktree against
// a Git repository built in a temporary directory. Workers are a recording
// server started by a fake startSession; timers are injected.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { runApp } from "../packages/ampi-cli/src/app.js";
import { AMPI_GUI_HOST_GLOBAL_KEY, runAppWorker } from "../packages/ampi-cli/src/app-worker.js";
import { createLogger } from "../packages/ampi-cli/src/log.js";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const HUB_TOKEN = ["hub", "new", "thread"].join("-");
const WORKER_TOKEN = ["worker", "new", "thread"].join("-");
const HUB_PID = 7_300_001;
const WORKER_PID = 7_300_002;
const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const iso = (hoursAgo) => new Date(NOW - hoursAgo * 3_600_000).toISOString();

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  delete globalThis[AMPI_GUI_HOST_GLOBAL_KEY];
});

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "ampi-new-thread-"));
  dirs.push(dir);
  return dir;
}

let newThread;
let hubModule;
let sessionsModule;
before(async () => {
  newThread = await importSource("extensions/ampi-gui/new-thread.ts");
  hubModule = await importSource("extensions/ampi-gui/hub.ts");
  sessionsModule = await importSource("extensions/ampi-gui/sessions.ts");
});
const client = () => importSource("extensions/ampi-gui/client/new-thread.js");

/** The hub's modes for a new thread: high is set up, ultra is not. */
const MODES = {
  current: "medium",
  locked: false,
  lockReason: null,
  model: null,
  fast: null,
  models: [],
  modes: [
    { key: "medium", label: "Medium", description: "", color: null, agentModel: null, oracleModel: null, available: true, reason: null },
    { key: "high", label: "High", description: "", color: null, agentModel: null, oracleModel: null, available: true, reason: null },
    { key: "ultra", label: "Ultra", description: "", color: null, agentModel: null, oracleModel: null, available: false, reason: "Not set up." },
  ],
};

/** A raw request with exactly the headers given. */
function send(port, { method = "GET", target = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path: target, headers, setHost: false, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: text, json: () => JSON.parse(text) }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe("ampi-gui new thread: the request", () => {
  it("takes a prompt, an absolute directory, a set-up mode and labels, and refuses each part that does not fit", async () => {
    const dir = tempDir();
    const file = path.join(dir, "notes.txt");
    writeFileSync(file, "x");
    const check = (body) => newThread.parseMmrGuiNewThread(body, { modes: MODES });
    const good = { prompt: "  Fix the parser  ", cwd: dir, mode: "high", labels: ["docs", "p1", "docs"] };
    assert.deepEqual(await check(good), { ok: true, value: { prompt: "Fix the parser", cwd: dir, mode: "high", labels: ["docs", "p1"], worktree: false } });
    assert.deepEqual((await check({ prompt: "x", cwd: dir })).value, { prompt: "x", cwd: dir, mode: null, labels: [], worktree: false }, "mode, labels and worktree are optional");
    assert.equal((await check({ ...good, worktree: true })).value.worktree, true);

    const refused = async (body, status, pattern) => {
      const result = await check({ ...good, ...body });
      assert.equal(result.ok, false, JSON.stringify(body));
      assert.equal(result.status, status, JSON.stringify(body));
      assert.match(result.body.error, pattern);
    };
    await refused({ cwd: "work/lib" }, 400, /absolute path/);
    await refused({ cwd: path.join(dir, "gone") }, 400, /no directory at/);
    await refused({ cwd: file }, 400, /is not a directory/);
    await refused({ cwd: undefined }, 400, /Choose a directory/);
    await refused({ mode: "turbo" }, 400, /"turbo" is not one of ampi's modes/);
    await refused({ mode: 3 }, 400, /not one of ampi's modes/);
    await refused({ mode: "ultra" }, 409, /Not set up/);
    await refused({ prompt: "   " }, 400, /Type a prompt/);
    await refused({ prompt: 42 }, 400, /Type a prompt/);
    await refused({ prompt: "x".repeat(100_001) }, 400, /too long/);
    assert.equal((await check({ ...good, prompt: "x".repeat(100_000) })).ok, true, "100,000 characters fit");
    await refused({ labels: "docs" }, 400, /list of strings/);
    await refused({ labels: ["Docs"] }, 400, /"Docs" is not a label/);
    await refused({ labels: ["a".repeat(33)] }, 400, /at most 32 characters/);
    await refused({ labels: Array.from({ length: 21 }, (_, index) => `l${index}`) }, 400, /at most 20 labels/);
    await refused({ worktree: "yes" }, 400, /worktree must be true or false/);
  });

  it("accepts and refuses the same labels as the thread index", async () => {
    const { validateMmrThreadLabels } = await importSource("extensions/ampi-threads/index-store.ts");
    const indexTakes = (labels) => {
      try {
        return validateMmrThreadLabels(labels);
      } catch {
        return "refused";
      }
    };
    const guiTakes = (labels) => {
      const checked = newThread.checkMmrGuiLabels(labels);
      return typeof checked === "string" ? "refused" : checked;
    };
    for (const labels of [
      ["a", "b-2", "a"],
      ["UPPER"],
      ["with space"],
      ["x".repeat(32)],
      ["x".repeat(33)],
      [""],
      [7],
      Array.from({ length: 20 }, (_, index) => `l${index}`),
      Array.from({ length: 21 }, (_, index) => `l${index}`),
      // Duplicates count once, so 21 entries with one repeated fit.
      [...Array.from({ length: 20 }, (_, index) => `l${index}`), "l0"],
      "not-a-list",
    ]) {
      assert.deepEqual(guiTakes(labels), indexTakes(labels), JSON.stringify(labels));
    }
  });
});

describe("ampi-gui new thread: the directories", () => {
  it("lists the catalogue's and the live processes' directories by last use, with their thread counts and Git branch", async () => {
    const root = tempDir();
    const home = path.join(root, "home");
    const repo = path.join(home, "repo");
    const worktree = path.join(root, "worktree");
    const plain = path.join(root, "plain");
    const live = path.join(root, "live-only");
    for (const dir of [path.join(repo, ".git"), path.join(repo, "src"), worktree, plain, live, path.join(root, "gitdirs", "wt")]) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/feat/parser\n");
    // A worktree's .git is a file naming its Git directory, here relative and on a detached head.
    writeFileSync(path.join(worktree, ".git"), "gitdir: ../gitdirs/wt\n");
    writeFileSync(path.join(root, "gitdirs", "wt", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
    const rows = [
      { id: "a", cwd: repo, modified: iso(5) },
      { id: "b", cwd: repo, modified: iso(1) },
      { id: "c", cwd: plain, modified: iso(3) },
      { id: "d", cwd: worktree, modified: iso(10) },
      { id: "e", cwd: path.join(root, "removed"), modified: iso(0) },
      { id: "f", cwd: path.join(repo, "src"), modified: iso(20) },
    ];
    const entries = [
      { kind: "tui", sessionId: "b", cwd: repo, updatedAt: iso(0.5) },
      { kind: "execute", sessionId: "g", cwd: live, updatedAt: iso(2) },
      { kind: "app", sessionId: null, cwd: path.join(root, "app-cwd"), updatedAt: iso(0) },
    ];
    // Git is looked for no higher than the fixture's root, whatever the temporary directory sits in.
    const list = (query) => newThread.listMmrGuiDirectories({ rows, live: entries, query, home, gitHead: (dir) => newThread.readMmrGuiGitHead(dir, root) });

    const all = await list("");
    assert.deepEqual(
      all.directories.map((entry) => [entry.path, entry.label, entry.git, entry.branch, entry.sessions, entry.lastUsed]),
      [
        [repo, "repo", true, "feat/parser", 2, iso(0.5)],
        [live, "live-only", false, null, 1, iso(2)],
        [plain, "plain", false, null, 1, iso(3)],
        [worktree, "worktree", true, "0123456", 1, iso(10)],
        [path.join(repo, "src"), "src", true, "feat/parser", 1, iso(20)],
      ],
      "a removed directory and the app's own are left out; a subdirectory finds its checkout's Git",
    );
    assert.equal(all.typed, null);

    assert.deepEqual(
      (await list("REPO src")).directories.map((entry) => entry.path),
      [path.join(repo, "src")],
      "every word, in the path or the name, ignoring case",
    );
    // A typed path: ~ is the home directory; an unlisted directory is offered, a listed one is just listed.
    const typedHome = await list("~");
    assert.deepEqual([typedHome.typed?.path, typedHome.typed?.label, typedHome.typed?.lastUsed], [home, "~", null]);
    assert.equal((await list(`${root}/gitdirs`)).typed?.path, path.join(root, "gitdirs"));
    const listed = await list("~/repo");
    assert.equal(listed.typed, null);
    assert.equal(listed.directories[0].path, repo);
    assert.equal((await list(`${root}/missing`)).typed, null, "a path that is not a directory is not offered");
    // `~name` is no path (it would resolve against the hub's working directory): it searches for the name.
    const tilde = await newThread.listMmrGuiDirectories({ rows, live: entries, query: "~live-only", home, pathKind: async () => "directory", gitHead: async () => ({ git: false, branch: null }) });
    assert.equal(tilde.typed, null);
    assert.deepEqual(tilde.directories.map((entry) => entry.path), [live]);
    assert.equal((await list(path.join(plain, "..", "plain"))).directories[0].path, plain, "a typed path is resolved");
  });
});

/** The hub's `GET /api/events` stream: `count()` is how many `sessions` events arrived, `next(n)` waits for the n-th. */
function openEvents(port, headers) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/events", headers, setHost: false, agent: false }, (res) => {
      let text = "";
      const waiters = [];
      const count = () => text.match(/event: sessions/g)?.length ?? 0;
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
        for (const waiter of waiters.splice(0)) {
          if (count() >= waiter.n) waiter.done();
          else waiters.push(waiter);
        }
      });
      resolve({
        count,
        next: (n) => (count() >= n ? Promise.resolve() : new Promise((done) => waiters.push({ n, done }))),
        close: () => req.destroy(),
      });
    });
    req.on("error", (error) => (error.code === "ECONNRESET" ? undefined : reject(error)));
    req.end();
  });
}

/** A worker stand-in: records every request and answers `/api/send` with `sendStatus`. */
async function startRecorder({ sendStatus = 200 } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: { ...req.headers }, body: Buffer.concat(chunks).toString("utf8") });
      const refused = req.url === "/api/send" && sendStatus !== 200;
      res.writeHead(refused ? sendStatus : 200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(refused ? { error: "Pi is compacting." } : { ok: true, from: "worker" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}

/** Git without the user's or the system's configuration, so the tests never read them. */
const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, ...GIT_ENV } }).trim();

/** A Git repository with one commit on `main`. */
function initRepo(repo) {
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: { ...process.env, ...GIT_ENV } });
  git(repo, "-c", "user.name=ampi", "-c", "user.email=ampi@example.invalid", "commit", "-q", "--allow-empty", "-m", "start");
}

/**
 * A hub over one saved session in `repo`, a fake thread index and a fake
 * startSession whose workers are `recorder`; `gitRepo` makes `repo` a Git
 * repository, `hub` adds options to the hub's.
 */
async function startHub({ recorder, index = true, start, gitRepo = false, hub: hubOptions = {} } = {}) {
  const root = realpathSync(tempDir());
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  if (gitRepo) initRepo(repo);
  const file = path.join(root, "s-old.jsonl");
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "s-old", timestamp: iso(2), cwd: repo })}\n`);
  const infos = [{ path: file, id: "s-old", cwd: repo, created: new Date(NOW - 7_200_000), modified: new Date(NOW - 7_200_000), messageCount: 2, firstMessage: "Old", allMessagesText: "" }];
  let listed = 0;
  const sessions = sessionsModule.createMmrGuiSessions({
    source: {
      listSessions: async () => {
        listed++;
        return infos;
      },
    },
    current: () => undefined,
    threadIndex: () => undefined,
    now: () => NOW,
  });
  const labels = [];
  const threadIndex = index ? { update: async (id, patch) => labels.push([id, patch]) } : undefined;
  const starts = [];
  const stops = [];
  const exits = [];
  const activity = [];
  const startSession =
    start ??
    (async (startRequest) => {
      starts.push(startRequest);
      return {
        pid: WORKER_PID,
        port: recorder.port,
        token: WORKER_TOKEN,
        sessionId: "s-new",
        sessionPath: path.join(root, "s-new.jsonl"),
        stop: async () => {
          stops.push("s-new");
        },
        onExit: (listener) => exits.push(listener),
        onActivity: (listener) => activity.push(listener),
      };
    });
  const timers = new Set();
  const hub = await hubModule.startMmrGuiHub({
    token: HUB_TOKEN,
    clientDir: path.join(getPreparedSourceRoot(), "extensions/ampi-gui/client"),
    startSession,
    sessions,
    commands: {},
    exportSession: async () => ({ status: 404, body: {} }),
    modes: () => MODES,
    threadIndex: () => threadIndex,
    hostname: "devbox<1>",
    home: root,
    registry: { dir: path.join(root, "live"), isAlive: () => false, procStart: () => null },
    pid: HUB_PID,
    now: () => NOW,
    setTimer: (callback, ms) => {
      const timer = { callback, ms };
      timers.add(timer);
      return timer;
    },
    clearTimer: (timer) => timers.delete(timer),
    ...hubOptions,
  });
  const port = hub.port;
  const headers = (extra = {}) => ({ Host: `127.0.0.1:${port}`, Cookie: `ampi_gui_${port}=${HUB_TOKEN}`, ...extra });
  const post = (target, body, extra = {}) =>
    send(port, { method: "POST", target, headers: headers({ Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json", ...extra }), body: JSON.stringify(body) });
  const get = (target, extra = {}) => send(port, { target, headers: headers(extra) });
  /** The worker reports its agent `busy` or `idle`. */
  const report = (state) => {
    for (const listener of activity) listener(state);
  };
  /** The worker process exits. */
  const exit = () => {
    for (const listener of exits) listener();
  };
  return { hub, port, repo, root, post, get, headers, starts, stops, labels, timers, report, exit, listed: () => listed, close: () => hub.close() };
}

describe("ampi-gui new thread: the hub", () => {
  it("starts a worker in the directory and mode, sends the prompt as its first message, records the labels and serves the thread at once", async () => {
    const recorder = await startRecorder();
    const app = await startHub({ recorder });
    try {
      const page = await app.get("/new");
      assert.equal(page.status, 200);
      assert.match(page.headers["content-type"], /^text\/html/);
      assert.deepEqual((await app.get("/api/app")).json(), { app: true, hostname: "devbox<1>" });

      const listedBefore = app.listed();
      const created = await app.post("/api/threads", { prompt: "Fix the parser", cwd: app.repo, mode: "high", labels: ["docs"] });
      assert.equal(created.status, 200);
      assert.deepEqual(created.json(), { ok: true, sessionId: "s-new" });
      assert.deepEqual(app.starts, [{ cwd: app.repo, mode: "high" }]);
      const first = recorder.requests.find((entry) => entry.url === "/api/send");
      assert.deepEqual(JSON.parse(first.body), { text: "Fix the parser" });
      assert.equal(first.headers.cookie, `ampi_gui_${recorder.port}=${WORKER_TOKEN}`, "the hub reaches the worker with the worker's token");
      assert.equal(first.headers.origin, `http://127.0.0.1:${recorder.port}`);
      assert.deepEqual(app.labels, [["s-new", { labels: ["docs"] }]]);

      // The catalogue does not list the new session yet; its routes reach the worker all the same.
      const transcript = await app.get("/s/s-new/api/transcript");
      assert.equal(transcript.status, 200);
      assert.deepEqual(transcript.json(), { ok: true, from: "worker" });
      assert.equal(recorder.requests.at(-1).url, "/api/transcript");
      // The list is read again after the start, so the thread shows once Pi saved it.
      await app.get("/api/sessions");
      assert.ok(app.listed() > listedBefore);

      // Without a mode the worker starts in its own default; without labels the index is not touched.
      await app.post("/api/threads", { prompt: "Again", cwd: app.repo });
      assert.deepEqual(app.starts[1], { cwd: app.repo });
      assert.equal(app.labels.length, 1);
    } finally {
      await app.close();
      await recorder.close();
    }
  });

  it("tells the pages to read the list again when the new thread's first turn starts and settles, as Pi saves its file only then", { timeout: 10_000 }, async () => {
    const recorder = await startRecorder();
    const app = await startHub({ recorder });
    const stream = await openEvents(app.port, app.headers());
    try {
      assert.equal((await app.post("/api/threads", { prompt: "In the background", cwd: app.repo })).status, 200);
      await stream.next(1);
      // The page reads the list before Pi saved the file; the hub keeps that list until it is told otherwise.
      await app.get("/api/sessions");
      const before = app.listed();
      await app.get("/api/sessions");
      assert.equal(app.listed(), before, "the list is cached");

      app.report("busy");
      await stream.next(2);
      await app.get("/api/sessions");
      assert.equal(app.listed(), before + 1, "the first turn's start reads the catalogue again");
      app.report("idle");
      await stream.next(3);
      await app.get("/api/sessions");
      assert.equal(app.listed(), before + 2, "and so does its end, when the file is saved for sure");

      // Later turns change nothing: the next event is the worker's exit.
      app.report("busy");
      app.report("idle");
      app.exit();
      await stream.next(4);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(stream.count(), 4);
    } finally {
      stream.close();
      await app.close();
      await recorder.close();
    }
  });

  it("answers a refused request without starting anything, and stops a worker that does not take the prompt", async () => {
    const recorder = await startRecorder({ sendStatus: 409 });
    const app = await startHub({ recorder });
    const bare = await startHub({ recorder, index: false });
    try {
      for (const body of [
        { prompt: "", cwd: app.repo },
        { prompt: "x", cwd: "repo" },
        { prompt: "x", cwd: path.join(app.repo, "missing") },
        { prompt: "x", cwd: app.repo, mode: "turbo" },
        { prompt: "x", cwd: app.repo, labels: ["Bad Label"] },
      ]) {
        assert.equal((await app.post("/api/threads", body)).status, 400, JSON.stringify(body));
      }
      assert.equal((await app.post("/api/threads", { prompt: "x", cwd: app.repo, mode: "ultra" })).status, 409);
      const noIndex = await bare.post("/api/threads", { prompt: "x", cwd: bare.repo, labels: ["docs"] });
      assert.deepEqual([noIndex.status, noIndex.json().error], [409, "Labels need the ampi-threads extension."]);
      assert.deepEqual([app.starts, bare.starts], [[], []]);

      const refused = await app.post("/api/threads", { prompt: "x", cwd: app.repo });
      assert.deepEqual([refused.status, refused.json()], [409, { error: "Pi is compacting." }]);
      assert.deepEqual(app.stops, ["s-new"], "the worker of a thread without a message is stopped");
      assert.equal((await app.get("/s/s-new/api/transcript")).status, 404, "and no longer routed");
    } finally {
      await app.close();
      await bare.close();
      await recorder.close();
    }
  });

  it("answers 504 when the start outlasts its wait, and stops the worker that comes later", async () => {
    let finish;
    const late = { stop: async () => late.stopped++, stopped: 0 };
    const app = await startHub({ start: () => new Promise((resolve) => (finish = resolve)) });
    try {
      const pending = app.post("/api/threads", { prompt: "x", cwd: app.repo });
      while (![...app.timers].some((timer) => timer.ms === hubModule.MMR_GUI_HUB_START_TIMEOUT_MS)) await new Promise((resolve) => setImmediate(resolve));
      const timer = [...app.timers].find((entry) => entry.ms === hubModule.MMR_GUI_HUB_START_TIMEOUT_MS);
      timer.callback();
      assert.equal((await pending).status, 504);
      finish(late);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(late.stopped, 1);
    } finally {
      await app.close();
    }
  });

  it("lists directories, and applies the request policy to the new routes", async () => {
    const app = await startHub({ recorder: { port: 1 } });
    try {
      const listed = await app.get("/api/directories");
      assert.equal(listed.status, 200);
      assert.deepEqual(
        listed.json().directories.map((entry) => [entry.path, entry.sessions]),
        [[app.repo, 1]],
      );
      assert.equal((await app.get(`/api/directories?q=${encodeURIComponent("~")}`)).json().typed.path, app.root, "~ is the hub's home");

      for (const target of ["/api/directories", "/new"]) {
        assert.equal((await send(app.port, { target, headers: { Host: `127.0.0.1:${app.port}` } })).status, 401, `${target} without the token`);
        assert.equal((await app.get(target, { Host: `evil.example:${app.port}` })).status, 403, `${target} with another Host`);
        assert.equal((await app.get(target, { Origin: "http://evil.example" })).status, 403, `${target} from another origin`);
      }
      const body = { prompt: "x", cwd: app.repo };
      assert.equal((await app.post("/api/threads", body, { Origin: "http://evil.example" })).status, 403);
      assert.equal((await app.post("/api/threads", body, { Cookie: "" })).status, 403);
      assert.equal((await app.post("/api/threads", body, { "Content-Type": "text/plain" })).status, 415);
      assert.equal((await app.post("/api/threads", body, { Host: `localhost:${app.port}`, Origin: "http://localhost:1" })).status, 403);
      assert.deepEqual(app.starts, []);
    } finally {
      await app.close();
    }
  });
});

describe("ampi-gui new thread: New Worktree", () => {
  const runFile = promisify(execFileCallback);
  /** Runs git as the hub asks, without the user's configuration, and records each call. */
  function capturingRunner() {
    const calls = [];
    const run = (file, args, options) => {
      calls.push({ file, args: [...args], options: { ...options } });
      return runFile(file, [...args], { ...options, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
    };
    return { calls, run };
  }

  it("creates the worktree from HEAD on ampi/<slug> beside the main checkout, through execFile, and starts the session in it", async () => {
    const recorder = await startRecorder();
    const runner = capturingRunner();
    const suffixes = ["beef", "f00d"];
    const app = await startHub({ recorder, gitRepo: true, hub: { execFile: runner.run, worktreeSuffix: () => suffixes.shift() } });
    try {
      const sub = path.join(app.repo, "src");
      mkdirSync(sub);
      const created = await app.post("/api/threads", { prompt: "Fix the parser's edge cases", cwd: sub, worktree: true, labels: ["docs"] });
      assert.equal(created.status, 200);
      const target = path.join(app.root, "repo-worktrees", "fix-the-parsers-edge-cases-beef");
      const branch = "ampi/fix-the-parsers-edge-cases-beef";
      assert.deepEqual(created.json(), { ok: true, sessionId: "s-new", worktree: { path: target, branch } });
      assert.deepEqual(app.starts, [{ cwd: target }], "the session's cwd is the new worktree");
      assert.equal(git(target, "symbolic-ref", "--short", "HEAD"), branch);
      assert.equal(git(target, "rev-parse", "HEAD"), git(app.repo, "rev-parse", "HEAD"), "it starts from the checkout's HEAD");
      assert.match(git(app.repo, "worktree", "list", "--porcelain"), new RegExp(`worktree ${target}\\nHEAD [0-9a-f]+\\nbranch refs/heads/${branch}`));
      assert.deepEqual(JSON.parse(recorder.requests.find((entry) => entry.url === "/api/send").body), { text: "Fix the parser's edge cases" });
      assert.deepEqual(app.labels, [["s-new", { labels: ["docs"] }]]);

      // From inside that worktree, the next one still goes beside the main checkout.
      const again = await app.post("/api/threads", { prompt: "Next", cwd: target, worktree: true });
      assert.equal(again.json().worktree.path, path.join(app.root, "repo-worktrees", "next-f00d"));
      assert.deepEqual(app.starts[1], { cwd: path.join(app.root, "repo-worktrees", "next-f00d") });

      // git runs as a file with its arguments, never through a shell.
      assert.deepEqual(
        runner.calls.slice(0, 2).map((call) => [call.file, call.args]),
        [
          ["git", ["-C", sub, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]],
          ["git", ["-C", sub, "worktree", "add", "-b", branch, "--", target, "HEAD"]],
        ],
      );
      for (const call of runner.calls) {
        assert.equal(call.options.shell, undefined);
        assert.equal(call.options.timeout, newThread.MMR_GUI_WORKTREE_TIMEOUT_MS);
      }
      assert.equal(newThread.MMR_GUI_WORKTREE_TIMEOUT_MS, 30_000);
    } finally {
      await app.close();
      await recorder.close();
    }
  });

  it("answers 409 with git's message when the branch exists, and 400 outside a Git checkout, without starting a worker", async () => {
    const runner = capturingRunner();
    const app = await startHub({ recorder: { port: 1 }, gitRepo: true, hub: { execFile: runner.run, worktreeSuffix: () => "beef" } });
    try {
      git(app.repo, "branch", "ampi/fix-parser-beef");
      const taken = await app.post("/api/threads", { prompt: "Fix parser", cwd: app.repo, worktree: true });
      assert.equal(taken.status, 409);
      assert.match(taken.json().error, /^fatal: a branch named 'ampi\/fix-parser-beef' already exists$/);

      const plain = path.join(app.root, "plain");
      mkdirSync(plain);
      const outside = await app.post("/api/threads", { prompt: "Fix parser", cwd: plain, worktree: true });
      assert.deepEqual([outside.status, outside.json()], [400, { error: `${plain} is not in a Git checkout, so it has no worktrees.` }]);
      assert.deepEqual(
        runner.calls.at(-1).args.slice(0, 3),
        ["-C", plain, "rev-parse"],
        "outside a checkout, nothing but rev-parse runs",
      );
      assert.deepEqual(app.starts, []);
    } finally {
      await app.close();
    }
  });

  it("names the slug after the prompt's first words in kebab case, at most 32 characters, with four hex characters", () => {
    const slug = (prompt) => newThread.mmrGuiWorktreeSlug(prompt, "beef");
    assert.equal(slug("Fix the parser"), "fix-the-parser-beef");
    assert.equal(slug("  --  !! ?? "), "thread-beef", "no words");
    assert.equal(slug(""), "thread-beef");
    assert.equal(slug("修复登录错误 🚀"), "thread-beef", "nothing left in ASCII");
    assert.equal(slug("Réparer le café naïve"), "reparer-le-cafe-naive-beef", "accents dropped");
    assert.equal(slug("Don't break the build"), "dont-break-the-build-beef");
    assert.equal(slug("Port the 2 tests to v24"), "port-the-2-tests-to-v24-beef");
    assert.equal(slug("Refactor the session catalogue so every directory loads lazily"), "refactor-the-session-catalogue-beef", "cut between words");
    assert.equal(slug("x".repeat(50)), `${"x".repeat(32)}-beef`, "one long word is cut");
    assert.match(newThread.mmrGuiWorktreeSlug("Fix it"), /^fix-it-[0-9a-f]{4}$/);
    for (const prompt of ["a ".repeat(40), "Ünïcödé wörds everywhere in this rather long prompt"]) {
      const value = slug(prompt);
      assert.ok(value.length <= 37, value);
      assert.match(value, /^[a-z0-9]+(-[a-z0-9]+)*-beef$/, value);
    }
  });
});

describe("ampi-gui new thread: the mode on its way to the session", () => {
  it("rides beside the session in ampi app's start message", async () => {
    const children = [];
    const forkWorker = () => {
      const child = new EventEmitter();
      Object.assign(child, { pid: 9_100 + children.length, connected: true, sent: [], kill: () => true });
      child.send = (message) => {
        child.sent.push(message);
        if (message.type === "start") queueMicrotask(() => child.emit("message", { type: "ready", pid: child.pid, port: 4_100, sessionId: "s-new", sessionPath: null }));
        if (message.type === "stop") queueMicrotask(() => child.emit("exit", 0, null));
        return true;
      };
      children.push(child);
      return child;
    };
    let stop;
    const stopped = new Promise((resolve) => {
      stop = resolve;
    });
    let host;
    const registryDir = path.join(tempDir(), "live");
    const exit = runApp({
      pi: { getAgentDir: () => path.dirname(registryDir), SessionManager: { inMemory: () => ({}) } },
      open: false,
      cwd: "/work",
      out: () => {},
      log: createLogger({ stderr: () => {} }),
      stopped,
      registryDir,
      pid: HUB_PID,
      forkWorker,
      createToken: () => ["token", children.length].join("-"),
      createSession: async () => {
        host = globalThis[AMPI_GUI_HOST_GLOBAL_KEY];
        host.ready({ port: 4_000 });
        return { diagnostics: [], dispose: async () => {} };
      },
    });
    while (!host) await new Promise((resolve) => setImmediate(resolve));
    const session = await host.startSession({ cwd: "/work/repo", mode: "high" });
    assert.deepEqual(children[0].sent, [{ type: "start", token: session.token, session: { cwd: "/work/repo" }, mode: "high" }]);
    await host.startSession({ cwd: "/work/repo" });
    assert.deepEqual(children[1].sent[0].session, { cwd: "/work/repo" });
    assert.equal("mode" in children[1].sent[0], false);
    stop();
    assert.equal(await exit, 0);
  });

  it("reaches the worker's session as the --ampi-mode value, and a mode that is not a key refuses the start", async () => {
    const cwd = tempDir();
    const run = async (message) => {
      const channel = new EventEmitter();
      Object.assign(channel, { connected: true, sent: [] });
      channel.send = (sent, callback) => {
        channel.sent.push(sent);
        channel.emit("sent", sent);
        callback(null);
      };
      const created = [];
      const exit = runAppWorker({
        channel,
        pi: { getAgentDir: () => path.join(cwd, "agent"), SessionManager: { create: (dir) => ({ getCwd: () => dir }) } },
        createSession: async (options) => {
          created.push(options);
          globalThis[AMPI_GUI_HOST_GLOBAL_KEY].ready({ port: 4_200 });
          return { diagnostics: [], session: { sessionId: "s-new", sessionFile: null, subscribe: () => () => {} }, dispose: async () => {} };
        },
        locateAmpi: async () => ({ load: true, ampi: { root: path.resolve(import.meta.dirname, ".."), version: "0.5.0" } }),
        registryDir: path.join(cwd, "live"),
        pid: WORKER_PID,
        ownerPid: HUB_PID,
        chdir: () => {},
      });
      channel.emit("message", { type: "start", token: WORKER_TOKEN, session: { cwd }, ...message });
      const reply = await new Promise((resolve) => {
        const done = (sent) => (sent.type === "ready" || sent.type === "error" ? resolve(sent) : undefined);
        for (const sent of channel.sent) done(sent);
        channel.on("sent", done);
      });
      if (reply.type === "ready") channel.emit("message", { type: "stop" });
      await exit;
      return { reply, created };
    };
    const high = await run({ mode: "high" });
    assert.equal(high.reply.type, "ready");
    assert.equal(high.created[0].ampiMode, "high");
    const plain = await run({});
    assert.equal("ampiMode" in plain.created[0], false, "without a mode the session starts as ampi decides");
    const bad = await run({ mode: "" });
    assert.equal(bad.reply.code, "bad-start");
    assert.deepEqual(bad.created, []);
  });
});

describe("ampi-gui new thread: the composer's pure parts", () => {
  const key = (extra) => ({ key: "Enter", isComposing: false, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...extra });

  it("reads Enter, Mod+Shift+Enter and Ctrl+Alt+Enter (⌃⌘Enter on macOS) as the three ways to create", async () => {
    const { submitVariantFor } = await client();
    assert.equal(submitVariantFor(key({})), "open");
    assert.equal(submitVariantFor(key({ shiftKey: true })), null, "Shift+Enter is a new line");
    assert.equal(submitVariantFor(key({ isComposing: true })), null);
    assert.equal(submitVariantFor(key({ key: "a" })), null);
    assert.equal(submitVariantFor(key({ ctrlKey: true, shiftKey: true })), "background");
    assert.equal(submitVariantFor(key({ ctrlKey: true, altKey: true })), "another");
    assert.equal(submitVariantFor(key({ altKey: true })), null, "Alt+Enter is the New Thread command");
    assert.equal(submitVariantFor(key({ ctrlKey: true })), null);
    assert.equal(submitVariantFor(key({ metaKey: true, shiftKey: true })), null, "Meta is not Mod off macOS");
    assert.equal(submitVariantFor(key({ metaKey: true, shiftKey: true }), true), "background");
    assert.equal(submitVariantFor(key({ metaKey: true, ctrlKey: true }), true), "another");
    assert.equal(submitVariantFor(key({ ctrlKey: true, shiftKey: true }), true), null, "Ctrl is not Mod on macOS");
    assert.equal(submitVariantFor(key({ ctrlKey: true, altKey: true }), true), null);
  });

  it("goes from creating back to idle with each variant's effect, ignores a second submit and keeps the text on failure", async () => {
    const { IDLE, newThreadTransition } = await client();
    const creating = newThreadTransition(IDLE, { type: "submit", variant: "background" });
    assert.deepEqual(creating, { phase: "creating", variant: "background", error: null, effect: null });
    assert.deepEqual(newThreadTransition(creating, { type: "submit", variant: "open" }), creating, "a second submit changes nothing");
    const failed = newThreadTransition(creating, { type: "failed", error: "There is no directory at /x." });
    assert.deepEqual(failed, { phase: "idle", variant: null, error: "There is no directory at /x.", effect: null });
    const effects = Object.fromEntries(
      ["open", "background", "another"].map((variant) => {
        const done = newThreadTransition(newThreadTransition(failed, { type: "submit", variant }), { type: "created", sessionId: "s-9" });
        assert.equal(done.phase, "idle");
        assert.equal(done.error, null, "a new submit clears the old error");
        return [variant, done.effect];
      }),
    );
    assert.deepEqual(effects, {
      open: { open: "s-9", toast: null, reset: ["prompt", "labels", "mode", "from"] },
      background: { open: null, toast: "s-9", reset: ["prompt"] },
      another: { open: null, toast: "s-9", reset: ["prompt", "labels", "mode", "from"] },
    });
  });

  it("ignores only the click that ends a long press on the send button, however that press ended", async () => {
    const { LONG_PRESS_MS, wireLongPress } = await client();
    const timers = new Set();
    const fire = (ms) => {
      for (const timer of [...timers].filter((entry) => entry.ms === ms)) {
        timers.delete(timer);
        timer.callback();
      }
    };
    const button = new EventTarget();
    const calls = [];
    wireLongPress(
      button,
      { onPress: () => calls.push("press"), onLongPress: () => calls.push("long") },
      {
        setTimer: (callback, ms) => {
          const timer = { callback, ms };
          timers.add(timer);
          return timer;
        },
        clearTimer: (timer) => timers.delete(timer),
      },
    );
    const dispatch = (type, fields = {}) => button.dispatchEvent(Object.assign(new Event(type), fields));
    const longPress = () => {
      dispatch("pointerdown", { button: 0 });
      fire(LONG_PRESS_MS);
    };

    dispatch("pointerdown", { button: 0 });
    dispatch("pointerup");
    dispatch("click");
    assert.deepEqual(calls.splice(0), ["press"], "a short press");

    longPress();
    dispatch("pointerup");
    dispatch("click");
    assert.deepEqual(calls.splice(0), ["long"], "a long press released on the button: its click is ignored");
    fire(0);
    dispatch("click");
    assert.deepEqual(calls.splice(0), ["press"], "and the next keyboard activation is not");

    // Released off the button: no pointerup and no click reach it.
    longPress();
    dispatch("pointerleave");
    dispatch("blur");
    dispatch("click");
    assert.deepEqual(calls.splice(0), ["long", "press"], "the menu took the focus, so the next activation counts");

    longPress();
    dispatch("pointercancel");
    dispatch("click");
    assert.deepEqual(calls.splice(0), ["long", "press"], "a cancelled press");

    dispatch("pointerdown", { button: 2 });
    fire(LONG_PRESS_MS);
    assert.deepEqual(calls, [], "only the primary button presses long");
  });

  it("builds the request only with a prompt and a directory, sending the mode only when there is one", async () => {
    const { threadRequest } = await client();
    assert.deepEqual(threadRequest({ prompt: " ", cwd: "/w", mode: "high", labels: [] }), { error: "Write a prompt first." });
    assert.deepEqual(threadRequest({ prompt: "x", cwd: null, mode: "high", labels: [] }), { error: "Choose a directory first." });
    assert.deepEqual(threadRequest({ prompt: "x", cwd: "/w", mode: "high", labels: ["a"] }), { body: { prompt: "x", cwd: "/w", mode: "high", labels: ["a"] } });
    assert.deepEqual(threadRequest({ prompt: "x", cwd: "/w", mode: null, labels: [] }), { body: { prompt: "x", cwd: "/w", labels: [] } });
    assert.deepEqual(threadRequest({ prompt: "x", cwd: "/w", mode: null, labels: [], worktree: true }), { body: { prompt: "x", cwd: "/w", labels: [], worktree: true } });
    assert.deepEqual(threadRequest({ prompt: "x", cwd: "/w", mode: null, labels: [], worktree: false }), { body: { prompt: "x", cwd: "/w", labels: [] } });
  });

  it("offers Current or New Worktree on Git checkouts only, and shows the created worktree's branch on the pill", async () => {
    const { directoryOptionHtml, directoryPillDetail, directoryAfterWorktree } = await client();
    const repo = { path: "/w/repo", label: "repo", git: true, branch: "main", lastUsed: null, sessions: 1 };
    const html = directoryOptionHtml(repo, 0);
    assert.match(html, /data-choice="current">Current</);
    assert.match(html, /data-choice="worktree">New Worktree</);
    assert.match(html, /<kbd>Tab<\/kbd>/);
    assert.match(html, /The checkout itself; Tab for a new worktree/);
    assert.match(directoryOptionHtml(repo, 0, { worktree: true }), /New worktree; Tab for the checkout itself/);
    assert.ok(!directoryOptionHtml({ ...repo, git: false, branch: null }, 0).includes("data-choice"), "a plain directory has no worktrees");

    assert.equal(directoryPillDetail(null), "");
    assert.equal(directoryPillDetail({ path: "/w/repo", label: "repo" }), "");
    assert.equal(directoryPillDetail({ ...repo, worktree: true }), "New Worktree");
    const made = directoryAfterWorktree({ path: "/w/repo-worktrees/fix-it-beef", branch: "ampi/fix-it-beef" }, { ...repo, worktree: true });
    assert.deepEqual(made, { path: "/w/repo-worktrees/fix-it-beef", label: "repo", git: true, branch: "ampi/fix-it-beef", worktree: false, createdBranch: "ampi/fix-it-beef" });
    assert.equal(directoryPillDetail(made), "ampi/fix-it-beef");
    assert.equal(directoryAfterWorktree({ path: "/w/repo-worktrees/fix-it-beef", branch: "ampi/fix-it-beef" }).label, "fix-it-beef", "without a directory, the worktree's folder");
  });

  it("inserts the current thread as @<id> at the cursor, with a space before it when it would touch a word", async () => {
    const { insertMention } = await client();
    assert.deepEqual(insertMention("", 0, 0, "s-1"), { text: "@s-1 ", caret: 5 });
    assert.deepEqual(insertMention("see", 3, 3, "s-1"), { text: "see @s-1 ", caret: 9 });
    assert.deepEqual(insertMention("see ", 4, 4, "s-1"), { text: "see @s-1 ", caret: 9 });
    assert.deepEqual(insertMention("see that thread", 4, 8, "s-1"), { text: "see @s-1  thread", caret: 9 }, "it replaces the selection");
    assert.deepEqual(insertMention("ab", 1, 1, "s-1"), { text: "a @s-1 b", caret: 7 });
  });

  it("escapes directory names, paths and branches, and the host name", async () => {
    const { directoryOptionHtml, executorOptionHtml, threadCount } = await client();
    const entry = { path: '/w/<img src=x onerror="a">', label: "<b>&'name'", git: true, branch: "<script>", lastUsed: null, sessions: 2 };
    const html = directoryOptionHtml(entry, 3, { checked: true });
    for (const raw of ["<img", "<b>", "<script>", 'onerror="a"']) assert.ok(!html.includes(raw), raw);
    assert.match(html, /&#60;b&#62;&#38;&#39;name&#39;/);
    assert.match(html, /2 threads/);
    assert.match(html, /aria-current="true"/);
    assert.match(directoryOptionHtml(entry, 0, { typed: true }), /Use \/w\/&#60;img/);
    assert.ok(!executorOptionHtml("<host>").includes("<host>"));
    assert.deepEqual([threadCount(0), threadCount(1), threadCount(5)], ["No threads", "1 thread", "5 threads"]);
  });
});

describe("ampi-gui new thread: commands and palette", () => {
  const commandsModule = () => importSource("extensions/ampi-gui/client/commands.js");

  it("offers New Thread only in ampi app, and the composer's keys only while it is shown", async () => {
    const { DEFAULT_COMMANDS } = await commandsModule();
    const { createKeyDispatcher } = await importSource("extensions/ampi-gui/client/keys.js");
    const get = (id) => DEFAULT_COMMANDS.find((entry) => entry.id === id);
    assert.deepEqual(get("new-thread").keys, ["alt+enter"]);
    assert.deepEqual(get("new-thread").when({ app: false }), { state: "unavailable", reason: "Needs ampi app" });
    assert.equal(get("new-thread").when({ app: true }).state, "available");
    const keys = Object.fromEntries(DEFAULT_COMMANDS.filter((entry) => entry.context === "new-thread").map((entry) => [entry.id, entry.keys]));
    assert.deepEqual(keys, {
      "new-thread-executor": ["ctrl+m"],
      "new-thread-directory": ["ctrl+j"],
      "new-thread-mode": ["ctrl+s"],
      "new-thread-labels": ["ctrl+l"],
      "new-thread-insert": ["ctrl+i"],
    });
    assert.equal(get("new-thread-insert").when({ fromThread: null }).reason, "Open New Thread from a thread to mention it");

    const opened = [];
    const ui = { newThreadControl: (kind) => opened.push(kind), openModePicker: () => opened.push("thread mode") };
    const dispatcher = createKeyDispatcher({ commands: () => DEFAULT_COMMANDS });
    const press = (keyName) => ({ key: keyName, code: `Key${keyName.toUpperCase()}`, ctrlKey: true, target: { closest: () => ({}) } });
    const composer = { contexts: ["new-thread", "global"], ui, fromThread: "s-1", threadPage: false, promptFocused: false };
    for (const letter of ["m", "j", "s", "l", "i"]) {
      const result = dispatcher.handle(press(letter), composer);
      result.command.run(composer, { chord: result.chord });
    }
    assert.deepEqual(opened, ["executor", "directory", "mode", "labels", "insert"]);
    // On a thread page Ctrl+S is the thread's own mode picker, and Ctrl+M is the browser's.
    const thread = { contexts: ["global"], ui, threadPage: true, promptFocused: true, modes: { locked: false } };
    assert.equal(dispatcher.handle(press("s"), thread).command.id, "choose-mode");
    assert.equal(dispatcher.handle(press("m"), thread), null);
  });

  it("lists the New Thread keys in their own keymap column, and offers a typed text as a new thread's prompt", async () => {
    const { DEFAULT_COMMANDS } = await commandsModule();
    const { keymapGroups } = await importSource("extensions/ampi-gui/client/keymap.js");
    const { paletteSections, NEW_THREAD_TITLE } = await importSource("extensions/ampi-gui/client/palette.js");
    const columns = keymapGroups(DEFAULT_COMMANDS, { newThread: true });
    assert.deepEqual(
      columns.map((group) => group.label),
      ["Global", "New Thread"],
    );
    assert.deepEqual(
      columns[1].rows.map((row) => row.chords[0].chips.join(" ")),
      ["Ctrl+M", "Ctrl+J", "Ctrl+S", "Ctrl+L", "Ctrl+I"],
    );
    assert.ok(!keymapGroups(DEFAULT_COMMANDS, { threadPage: true }).some((group) => group.label === "New Thread"));

    const base = { threadPage: false, writable: false, sessionList: { groups: [], actions: {} }, shownId: null };
    const inApp = paletteSections(DEFAULT_COMMANDS, { ...base, app: true }, "please fix the parser")[0];
    assert.equal(inApp.section, "Message");
    assert.deepEqual(inApp.rows[1], { kind: "new-thread", id: "new-thread-message", title: NEW_THREAD_TITLE, text: "please fix the parser", state: "available" });
    const onTerminal = paletteSections(DEFAULT_COMMANDS, { ...base, app: false }, "please fix the parser")[0].rows[1];
    assert.deepEqual([onTerminal.state, onTerminal.reason], ["unavailable", "Needs ampi app"]);
    const global = paletteSections(DEFAULT_COMMANDS, { ...base, app: false }, "")[0];
    const row = global.rows.find((entry) => entry.title === "New Thread…");
    assert.deepEqual([row.state, row.reason, row.chips], ["unavailable", "Needs ampi app", ["Alt+Enter"]]);
  });
});
