// What execute mode prints from Pi's JSON mode with --stats and --output-tool
// (packages/ampi-cli/src/run-output.js): hand-written Pi JSON event sequences
// against the line or text they must become, then spawned runs against the
// installed Pi with the scripted offline model (tests/fixtures/ampi-cli/faux-model).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createStatsOutput, createToolOutput } from "../packages/ampi-cli/src/run-output.js";
import { createStreamJsonEncoder } from "../packages/ampi-cli/src/stream-json.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const bin = path.join(repoRoot, "packages", "ampi-cli", "bin", "ampi.js");
const fauxModel = path.join(import.meta.dirname, "fixtures", "ampi-cli", "faux-model");

// --- Pi events, written as Pi's docs/json.md and docs/message-types.md describe them.

const SESSION = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const header = { type: "session", version: 3, id: SESSION, timestamp: "2026-10-18T10:00:00.000Z", cwd: "/work/app" };
const usage = (input, output, cost) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost },
});
const assistant = (content, stopReason, messageUsage, extra = {}) => ({
  role: "assistant",
  content,
  api: "test-api",
  provider: "test",
  model: "test-1",
  usage: messageUsage,
  stopReason,
  timestamp: 3,
  ...extra,
});
const callOf = (id, name) => assistant([{ type: "toolCall", id, name, arguments: {} }], "toolUse", usage(10, 2, 0));
/** One finished tool call: Pi's tool_execution_end and the tool result message. */
const toolRun = (id, toolName, content, isError = false) => [
  { type: "tool_execution_start", toolCallId: id, toolName, args: {} },
  { type: "tool_execution_end", toolCallId: id, toolName, result: { content, details: {} }, isError, durationMs: 3 },
  { type: "message_end", message: { role: "toolResult", toolCallId: id, toolName, content, isError, timestamp: 4 } },
];
const turn = (message, ...toolRuns) => [{ type: "turn_start" }, { type: "message_end", message }, ...toolRuns.flat(), { type: "turn_end", message }];
const run = (...turns) => [
  header,
  { type: "agent_start" },
  { type: "message_end", message: { role: "user", content: [{ type: "text", text: "go" }], timestamp: 2 } },
  ...turns.flat(),
  { type: "agent_end", messages: [], willRetry: false },
];

/** Feed the events to an output on a clock that advances 5 ms per read; nothing is written before the end. */
const outputOf = (create, events, failure) => {
  let clock = 1000;
  const output = create(createStreamJsonEncoder({ thinking: false, now: () => (clock += 5), context: () => ({ tools: [], mcpServers: [] }) }));
  const written = events.map((event) => output.push(event)).join("");
  assert.equal(written, "", "nothing is written while the run is in progress");
  return output.finish(failure);
};

const ZERO_USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

describe("ampi --stats: the summary line", () => {
  it("prints the result with turns, usage and the summed cost on one line", () => {
    const events = run(
      turn(callOf("c1", "bash"), toolRun("c1", "bash", [{ type: "text", text: "a.txt" }])),
      turn(assistant([{ type: "text", text: "One file." }], "stop", usage(20, 4, 0.5))),
    );
    // The first response costs nothing here; the second 0.5, a third 0.25 below.
    events.splice(-1, 0, ...turn(assistant([{ type: "text", text: "Really one." }], "stop", usage(5, 1, 0.25))));
    const end = outputOf(createStatsOutput, events);
    assert.equal(end.exitCode, 0);
    assert.deepEqual(end.notes, []);
    assert.ok(end.stdout.endsWith("}\n"));
    assert.equal(end.stdout.split("\n").length, 2, "exactly one line");
    assert.deepEqual(JSON.parse(end.stdout), {
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 5,
      num_turns: 3,
      result: "Really one.",
      session_id: SESSION,
      usage: { input_tokens: 35, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      total_cost_usd: 0.75,
    });
  });

  it("leaves total_cost_usd out when no response reports a cost", () => {
    const end = outputOf(createStatsOutput, run(turn(assistant([{ type: "text", text: "Hi." }], "stop", usage(3, 1, 0)))));
    const stats = JSON.parse(end.stdout);
    assert.equal("total_cost_usd" in stats, false);
    assert.equal(stats.result, "Hi.");
    assert.equal(end.exitCode, 0);
  });

  it("reports a failed request with its error, its cost and exit code 1", () => {
    const failed = assistant([], "error", usage(50, 0, 0.125), { errorMessage: "429 rate limited" });
    const end = outputOf(createStatsOutput, run(turn(failed)));
    assert.equal(end.exitCode, 1);
    assert.deepEqual(JSON.parse(end.stdout), {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      duration_ms: 5,
      num_turns: 1,
      error: "429 rate limited",
      session_id: SESSION,
      usage: { ...ZERO_USAGE, input_tokens: 50 },
      total_cost_usd: 0.125,
    });
  });

  it("reports a run that failed outside the answer", () => {
    const end = outputOf(createStatsOutput, [header], "Pi stopped with an error; see stderr.");
    assert.equal(end.exitCode, 1);
    const stats = JSON.parse(end.stdout);
    assert.equal(stats.error, "Pi stopped with an error; see stderr.");
    assert.equal(stats.num_turns, 0);
  });
});

describe("ampi --output-tool: the text of one tool's last call", () => {
  const answer = turn(assistant([{ type: "text", text: "Done." }], "stop", usage(1, 1, 0)));

  it("prints the last finished call to exactly that tool, its text blocks joined by newlines", () => {
    const events = run(
      turn(callOf("c1", "bash"), toolRun("c1", "bash", [{ type: "text", text: "first\n" }])),
      turn(
        callOf("c2", "bash"),
        toolRun("c2", "bash", [
          { type: "text", text: "second" },
          { type: "text", text: "part two" },
        ]),
        toolRun("c3", "bash_extra", [{ type: "text", text: "not this tool" }]),
      ),
      answer,
    );
    assert.deepEqual(
      outputOf((encoder) => createToolOutput("bash", encoder), events),
      { stdout: "second\npart two\n", notes: [], exitCode: 0 },
    );
  });

  it("still prints a failed call's text, and exits 1", () => {
    const events = run(
      turn(callOf("c1", "bash"), toolRun("c1", "bash", [{ type: "text", text: "ok" }])),
      turn(callOf("c2", "bash"), toolRun("c2", "bash", [{ type: "text", text: "Command exited with code 2\n" }], true)),
      answer,
    );
    assert.deepEqual(
      outputOf((encoder) => createToolOutput("bash", encoder), events),
      { stdout: "Command exited with code 2\n", notes: [], exitCode: 1 },
    );
  });

  it("prints nothing and exits 1 when no call to the tool finished", () => {
    const events = run(turn(callOf("c1", "read"), toolRun("c1", "read", [{ type: "text", text: "file" }])), answer);
    assert.deepEqual(
      outputOf((encoder) => createToolOutput("bash", encoder), events),
      { stdout: "", notes: [{ level: "error", message: "no call to the tool bash finished, so there is no output to print." }], exitCode: 1 },
    );
  });

  it("leaves images out with a note on stderr", () => {
    const content = [
      { type: "image", data: "aGk=", mimeType: "image/png" },
      { type: "text", text: "a screenshot" },
    ];
    const end = outputOf((encoder) => createToolOutput("look", encoder), run(turn(callOf("c1", "look"), toolRun("c1", "look", content)), answer));
    assert.deepEqual(end, {
      stdout: "a screenshot\n",
      notes: [{ level: "warn", message: "left out an image of the look result; only its text is printed." }],
      exitCode: 0,
    });
  });

  it("exits 1 with the error on stderr when the run failed after the call", () => {
    const failed = turn(assistant([], "error", usage(1, 0, 0), { errorMessage: "overloaded" }));
    const end = outputOf((encoder) => createToolOutput("bash", encoder), run(turn(callOf("c1", "bash"), toolRun("c1", "bash", [{ type: "text", text: "out" }])), failed));
    assert.deepEqual(end, { stdout: "out\n", notes: [{ level: "error", message: "overloaded" }], exitCode: 1 });
  });
});

describe("ampi --stats, --output-tool and --plugin-ready-timeout: the command", { concurrency: true }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ampi-cli-run-output-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  let runs = 0;

  /** Run the command with piped stdin and stdout in its own home, agent directory and project. */
  const runAmpi = (args) => {
    const root = path.join(dir, String(++runs));
    for (const sub of ["home", "agent", "project"]) mkdirSync(path.join(root, sub), { recursive: true });
    const project = path.join(root, "project");
    writeFileSync(path.join(project, "notes.md"), "");
    const env = { PATH: process.env.PATH, HOME: path.join(root, "home"), PI_CODING_AGENT_DIR: path.join(root, "agent"), PI_OFFLINE: "1" };
    const child = spawn(process.execPath, [bin, "-e", fauxModel, "--model", "faux/faux-1", ...args], { cwd: project, env });
    child.stdin.end();
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    return new Promise((resolve) => child.on("close", (status) => resolve({ status, stdout, stderr })));
  };

  it("prints exactly one JSON line with --stats", async () => {
    const result = await runAmpi(["-x", "--stats", "list files"]);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.split("\n");
    assert.deepEqual(lines.slice(1), [""], "one line, ending with a newline");
    const stats = JSON.parse(lines[0]);
    assert.equal(stats.type, "result");
    assert.equal(stats.subtype, "success");
    assert.equal(stats.result, "Files:\nnotes.md");
    assert.equal(stats.num_turns, 2);
    // The scripted model has no price.
    assert.equal("total_cost_usd" in stats, false);
  });

  it("prints the bash output with --output-tool bash, and exits 1 for a tool that was not called", async () => {
    const [bash, read] = await Promise.all([runAmpi(["-x", "--output-tool", "bash", "list files"]), runAmpi(["-x", "--output-tool=read", "list files"])]);
    assert.equal(bash.status, 0, bash.stderr);
    assert.equal(bash.stdout, "notes.md\n");
    assert.equal(read.status, 1);
    assert.equal(read.stdout, "");
    assert.match(read.stderr, /no call to the tool read finished/);
  });

  it("accepts --plugin-ready-timeout in execute mode and keeps the message after it", async () => {
    const result = await runAmpi(["-x", "--plugin-ready-timeout", "hello there"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "Echo: hello there\n");
  });

  it("refuses the flags outside execute mode and with Pi's --mode", async () => {
    const [stats, tool, timeout, mode] = await Promise.all([
      runAmpi(["-p", "hi", "--stats"]),
      runAmpi(["-p", "hi", "--output-tool", "bash"]),
      runAmpi(["-p", "hi", "--plugin-ready-timeout=5"]),
      runAmpi(["-x", "--mode", "json", "hi", "--stats"]),
    ]);
    for (const [result, message] of [
      [stats, "ampi: --stats needs execute mode (-x).\n"],
      [tool, "ampi: --output-tool needs execute mode (-x).\n"],
      [timeout, "ampi: --plugin-ready-timeout needs execute mode (-x).\n"],
      [mode, "ampi: --stats replaces Pi's output mode; leave out --mode json.\n"],
    ]) {
      assert.equal(result.status, 2, message);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, message);
    }
  });
});
