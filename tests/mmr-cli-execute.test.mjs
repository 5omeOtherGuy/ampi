// Execute mode of the `ampi` command (packages/ampi-cli/src/execute.js): which
// runs are execute mode, how the message is put together from the argument and
// stdin, what the run extension writes to the thread index, and the exit
// codes. The last suite spawns the command against the installed Pi with a
// scripted offline model (tests/fixtures/ampi-cli/faux-model) in a temporary
// home and agent directory.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { parseArgs } from "@earendil-works/pi-coding-agent";
import { buildExecuteArgs, createRunExtension, EXECUTE_NO_MESSAGE_ERROR, isExecuteRun, withoutApiKeys, withoutMessages } from "../packages/ampi-cli/src/execute.js";
import { createLogger } from "../packages/ampi-cli/src/log.js";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const bin = path.join(repoRoot, "packages", "ampi-cli", "bin", "ampi.js");
const fauxModel = path.join(import.meta.dirname, "fixtures", "ampi-cli", "faux-model");

after(() => cleanupLoadedSource());

describe("ampi execute mode: when it runs", () => {
  const parsed = (args) => parseArgs(args);
  const run = (args, { stdinIsTTY = true, stdoutIsTTY = true, explicit = false } = {}) =>
    isExecuteRun({ explicit, parsed: parsed(args), stdinIsTTY, stdoutIsTTY });

  it("runs with -x, and without it when stdin or stdout is not a terminal", () => {
    assert.equal(run(["hi"], { explicit: true }), true);
    assert.equal(run(["hi"], { stdoutIsTTY: false }), true);
    assert.equal(run(["hi"], { stdinIsTTY: false }), true);
    assert.equal(run(["hi"]), false);
  });

  it("leaves Pi's own output modes, exports, model listings and help to Pi when output is redirected", () => {
    for (const args of [["-p", "hi"], ["--mode", "json", "hi"], ["--export", "s.jsonl"], ["--list-models"], ["--help"]]) {
      assert.equal(run(args, { stdoutIsTTY: false }), false, args.join(" "));
    }
  });
});

describe("ampi execute mode: the message", () => {
  const build = (args, stdin) => buildExecuteArgs(parseArgs, args, stdin);

  it("runs Pi's print mode with the argument as the message", () => {
    assert.deepEqual(build(["--model", "a/b", "fix it"], undefined), { args: ["--print", "--model", "a/b", "fix it"] });
  });

  it("puts the argument first, then a newline, then stdin", () => {
    const { args } = build(["review", "@notes.md"], "diff --git a b\n+line\n");
    assert.deepEqual(args, ["--print", "review\ndiff --git a b\n+line", "@notes.md"]);
    assert.deepEqual(parseArgs(args).messages, ["review\ndiff --git a b\n+line"]);
  });

  it("joins stdin to the argument Pi reads as the message, not to an option value that looks the same", () => {
    assert.deepEqual(build(["--name", "fix", "fix"], "log").args, ["--print", "--name", "fix", "fix\nlog"]);
    // An extension flag takes the next argument as its value.
    assert.deepEqual(build(["--ampi-mode", "high", "go"], "log").args, ["--print", "--ampi-mode", "high", "go\nlog"]);
  });

  it("sends stdin alone as the message, after --, even when it starts with - or @", () => {
    assert.deepEqual(build(["--model", "a/b"], "-v is a flag\n").args, ["--print", "--model", "a/b", "--", "-v is a flag"]);
    const atSign = build(["--", "@notes.md"], "@x explain").args;
    assert.deepEqual(atSign, ["--print", "--", "@notes.md", " @x explain"]);
    assert.deepEqual(parseArgs(atSign).messages, [" @x explain"]);
    assert.deepEqual(parseArgs(atSign).fileArgs, ["notes.md"]);
  });

  it("leaves the message text and API keys out of Pi's arguments for the debug log, keeping other option values and attached files", () => {
    assert.deepEqual(withoutMessages(parseArgs, ["--name", "fix", "fix", "@notes.md", "--", "more"]), ["--name", "fix", "<message>", "@notes.md", "--", "<message>"]);
    assert.deepEqual(withoutMessages(parseArgs, ["-e", "./ext.ts", "--model", "a/b"]), ["-e", "./ext.ts", "--model", "a/b"]);
    const key = ["sk", "test", "4f2a"].join("-");
    assert.deepEqual(withoutMessages(parseArgs, ["--api-key", key, "--model", "a/b", "hi"]), ["--api-key", "<redacted>", "--model", "a/b", "<message>"]);
    assert.deepEqual(withoutApiKeys(["install", `--api-key=${key}`, "npm:x", "--api-key", key]), ["install", "--api-key=<redacted>", "npm:x", "--api-key", "<redacted>"]);
  });

  it("accepts an attached file alone, and refuses a run without any message", () => {
    assert.deepEqual(build(["@prompt.md"], undefined).args, ["--print", "@prompt.md"]);
    assert.deepEqual(build(["--model", "a/b"], undefined), { error: EXECUTE_NO_MESSAGE_ERROR });
    assert.deepEqual(build([], " \n\n"), { error: EXECUTE_NO_MESSAGE_ERROR });
  });
});

describe("ampi execute mode: thread options", () => {
  /** A fake Pi host that keeps one handler per event. */
  const fakePi = () => {
    const handlers = new Map();
    return { handlers, pi: { on: (name, handler) => handlers.set(name, handler) } };
  };
  const ctx = (sessionId, entries = [{ type: "message" }]) => ({
    sessionManager: { getSessionId: () => sessionId, getEntries: () => entries },
  });
  /** An in-memory thread index registered through ampi-core's seam, as ampi-threads does. */
  const registerIndex = async (records = {}) => {
    const { registerMmrThreadIndex } = await importSource("extensions/ampi-core/thread-index.ts");
    const threads = new Map(Object.entries(records));
    const index = {
      threads,
      list: async () => Object.fromEntries(threads),
      get: async (id) => threads.get(id),
      update: async (id, patch) => {
        const next = { ...threads.get(id), ...patch };
        threads.set(id, next);
        return next;
      },
    };
    return { index, release: registerMmrThreadIndex(index) };
  };
  const host = (warnings, times = [0]) => ({
    now: () => times.shift() ?? 0,
    timestamp: () => "2026-10-18T10:00:00.000Z",
    log: createLogger({ stderr: (text) => warnings.push(text) }),
    report: (line) => warnings.push(line),
  });

  /**
   * One run of the command: Pi calls the extension factory again for every
   * runtime (after /new, /resume, /fork and /reload), as it does in a process.
   */
  const runOf = (options, runHost) => {
    const factory = createRunExtension(options, runHost);
    return () => {
      const { pi, handlers } = fakePi();
      factory(pi);
      return handlers;
    };
  };
  const start = (handlers, reason, session) => handlers.get("session_start")({ type: "session_start", reason }, session);
  const shutdown = (handlers, reason, session) => handlers.get("session_shutdown")({ type: "session_shutdown", reason }, session);

  it("adds the labels to the starting session's existing ones and marks the title as the user's", async () => {
    const { index, release } = await registerIndex({ s1: { labels: ["old", "docs"] }, s3: { labels: ["kept"] } });
    try {
      const warnings = [];
      const runtime = runOf({ labels: ["docs", "release"], titled: true, archive: false, timings: false }, host(warnings));
      const first = runtime();
      await start(first, "startup", ctx("s1"));
      await shutdown(first, "reload", ctx("s1"));
      const reloaded = runtime();
      await start(reloaded, "reload", ctx("s1"));
      await shutdown(reloaded, "new", ctx("s1"));
      // Later sessions in the same process, after /new and /resume, are left alone.
      const fresh = runtime();
      await start(fresh, "new", ctx("s2", []));
      await shutdown(fresh, "resume", ctx("s2"));
      const resumed = runtime();
      await start(resumed, "resume", ctx("s3"));
      await shutdown(resumed, "quit", ctx("s3"));
      assert.deepEqual(index.threads.get("s1"), { labels: ["old", "docs", "release"], titleSource: "user" });
      assert.equal(index.threads.has("s2"), false);
      assert.deepEqual(index.threads.get("s3"), { labels: ["kept"] });
      assert.deepEqual(warnings, []);
    } finally {
      release();
    }
  });

  it("archives a session the run created when it quits, keeping an earlier archive date", async () => {
    const { index, release } = await registerIndex({ old: { archived: "2026-01-01T00:00:00.000Z" } });
    try {
      const runs = ["s1", "old", "empty"].map((id) => {
        const handlers = runOf({ labels: [], titled: false, archive: true, timings: false }, host([]))();
        // A new session has no messages at its start; the run adds them.
        const entries = [];
        return { handlers, session: ctx(id, entries), entries: id === "empty" ? [] : [{ type: "message" }] };
      });
      for (const { handlers, session } of runs) await start(handlers, "startup", session);
      for (const run of runs) run.session.sessionManager.getEntries = () => run.entries;
      // ampi-threads unregisters the index at shutdown, before this extension's handler runs.
      release();
      for (const { handlers, session } of runs) await shutdown(handlers, "quit", session);
      assert.deepEqual(index.threads.get("s1"), { archived: "2026-10-18T10:00:00.000Z" });
      assert.deepEqual(index.threads.get("old"), { archived: "2026-01-01T00:00:00.000Z" });
      assert.equal(index.threads.has("empty"), false);
    } finally {
      release();
    }
  });

  it("leaves a continued session unarchived, and archives only the session the run quits in", async () => {
    const { index, release } = await registerIndex({ chat: { labels: ["mine"] } });
    try {
      const options = { labels: [], titled: false, archive: true, timings: false };
      // `-c -x`: the session already had messages when the run started.
      const continued = runOf(options, host([]))();
      await start(continued, "startup", ctx("chat"));
      await shutdown(continued, "quit", ctx("chat"));
      // A new session that the run then leaves for another one it creates.
      const runtime = runOf(options, host([]));
      const first = runtime();
      await start(first, "startup", ctx("a", []));
      await shutdown(first, "new", ctx("a"));
      const second = runtime();
      await start(second, "new", ctx("b", []));
      await shutdown(second, "quit", ctx("b"));
      assert.deepEqual(index.threads.get("chat"), { labels: ["mine"] });
      assert.equal(index.threads.has("a"), false);
      assert.deepEqual(index.threads.get("b"), { archived: "2026-10-18T10:00:00.000Z" });
    } finally {
      release();
    }
  });

  it("reports labels it cannot store when ampi-threads is not loaded", async () => {
    const warnings = [];
    const handlers = runOf({ labels: ["docs"], titled: false, archive: true, timings: false }, host(warnings))();
    await start(handlers, "startup", ctx("s1", []));
    await shutdown(handlers, "quit", ctx("s1"));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^ampi: the thread index is off .*labels were not stored/);
  });

  it("reports startup, turn and total durations from the command's start, once when the run quits", async () => {
    const warnings = [];
    const runtime = runOf({ labels: [], titled: false, archive: false, timings: true }, host(warnings, [800.4, 1250, 1300]));
    const first = runtime();
    await start(first, "startup", ctx("s1"));
    first.get("agent_start")();
    first.get("agent_end")();
    await shutdown(first, "reload", ctx("s1"));
    const reloaded = runtime();
    await start(reloaded, "reload", ctx("s1"));
    await shutdown(reloaded, "quit", ctx("s1"));
    assert.deepEqual(warnings, ["ampi: timings: startup 800 ms, turn 450 ms, total 1300 ms"]);
  });
});

describe("ampi execute mode: the command", { concurrency: true }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ampi-cli-execute-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  let runs = 0;

  /**
   * Run the command with piped stdin and stdout, as a script or CI job would,
   * in its own home, agent directory and project.
   *
   * @param {string[]} args
   * @param {string} input
   * @param {string} [root] The directories of an earlier run, to continue its session.
   */
  const runAmpi = (args, input, root = path.join(dir, String(++runs))) => {
    const agentDir = path.join(root, "agent");
    for (const sub of ["home", "agent", "project"]) mkdirSync(path.join(root, sub), { recursive: true });
    const env = { PATH: process.env.PATH, HOME: path.join(root, "home"), PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
    const child = spawn(process.execPath, [bin, "-e", fauxModel, "--model", "faux/faux-1", ...args], {
      cwd: path.join(root, "project"),
      env,
    });
    child.stdin.end(input);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const index = () => JSON.parse(readFileSync(path.join(agentDir, "data", "ampi", "threads", "index.json"), "utf8")).threads;
    return new Promise((resolve) => child.on("close", (status) => resolve({ root, status, stdout, stderr, index })));
  };

  it("prints only the final message for the argument and stdin, and archives the labelled session", async () => {
    const result = await runAmpi(["-x", "-l", "ci", "--title", "Nightly", "summarize"], "line one\nline two\n");
    assert.equal(result.stderr, "");
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "Echo: summarize\nline one\nline two\n");
    const threads = Object.values(result.index());
    assert.equal(threads.length, 1);
    assert.deepEqual(threads[0].labels, ["ci"]);
    assert.equal(threads[0].titleSource, "user");
    assert.match(threads[0].archived, /^\d{4}-\d\d-\d\dT/);
  });

  // Output piped with input from a terminal needs a terminal for stdin, which a
  // spawn cannot give; "when it runs" above covers that case.
  it("runs execute mode without -x when input and output are piped, and keeps the session unarchived on request", async () => {
    const result = await runAmpi(["--no-archive-after-execute", "--timings"], "only stdin\n");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "Echo: only stdin\n");
    assert.match(result.stderr, /^ampi: timings: startup \d+ ms, turn \d+ ms, total \d+ ms\n$/);
    assert.throws(() => result.index(), { code: "ENOENT" });
  });

  it("answers in a continued session without archiving it", async () => {
    const first = await runAmpi(["-x", "--no-archive-after-execute", "-l", "chat", "first question"], "");
    assert.equal(first.status, 0, first.stderr);
    const result = await runAmpi(["-c", "-x", "one more question"], "", first.root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "Echo: one more question\n");
    const threads = Object.values(result.index());
    assert.equal(threads.length, 1);
    assert.deepEqual(threads[0].labels, ["chat"]);
    assert.equal(threads[0].archived, undefined);
  });

  it("exits 1 with the error on stderr when the agent fails", async () => {
    const result = await runAmpi(["-x", "please fail"], "");
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /The scripted model failed\./);
  });

  it("exits 2 without starting a session when there is no message", async () => {
    const result = await runAmpi(["-x"], "  \n");
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `ampi: ${EXECUTE_NO_MESSAGE_ERROR}\n`);
  });

  it("exits 2 for -x with RPC mode, which needs stdin for itself", async () => {
    const result = await runAmpi(["-x", "--mode", "rpc", "hi"], "");
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "ampi: -x cannot be combined with --mode rpc.\n");
  });
});
