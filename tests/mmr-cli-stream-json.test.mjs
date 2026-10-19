// Stream JSON output of the `ampi` command (packages/ampi-cli/src/stream-json.js):
// hand-written Pi JSON event sequences against the records they must become,
// a schema check of every record (tests/fixtures/ampi-cli/stream-json.schema.json),
// what the init record reads from the session, and spawned runs against the
// installed Pi with the scripted offline model (tests/fixtures/ampi-cli/faux-model).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { Check, Errors } from "typebox/schema";
import { createStreamJsonEncoder, readStreamJsonContext } from "../packages/ampi-cli/src/stream-json.js";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const bin = path.join(repoRoot, "packages", "ampi-cli", "bin", "ampi.js");
const fauxModel = path.join(import.meta.dirname, "fixtures", "ampi-cli", "faux-model");
const schema = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "ampi-cli", "stream-json.schema.json"), "utf8"));

after(() => cleanupLoadedSource());

/** Every record must match the schema; the failure names what is wrong. */
const assertSchema = (records) => {
  for (const record of records) assert.ok(Check(schema, record), `${JSON.stringify(record)}\n${JSON.stringify(Errors(schema, record)[1].slice(0, 3))}`);
};

// --- Pi events, written as Pi's docs/json.md and docs/message-types.md describe them.

const SESSION = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const header = { type: "session", version: 3, id: SESSION, timestamp: "2026-10-18T10:00:00.000Z", cwd: "/work/app" };
const usage = (input, output, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const systemMessage = { role: "system", content: "", sections: { preamble: "You help." }, timestamp: 1 };
const userMessage = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 2 });
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
const ends = (message) => [
  { type: "message_start", message },
  { type: "message_end", message },
];
/** One turn whose assistant message streams one text delta first, as Pi sends it. */
const turn = (message, toolResults = []) => [
  { type: "turn_start" },
  { type: "message_start", message: { ...message, content: [], stopReason: "pending" } },
  { type: "message_update", usage: message.usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "…" } },
  { type: "message_end", message },
  ...toolResults.flatMap((result) => [
    { type: "tool_execution_start", toolCallId: result.toolCallId, toolName: result.toolName, args: {} },
    { type: "tool_execution_end", toolCallId: result.toolCallId, toolName: result.toolName, result: { content: result.content }, isError: result.isError },
    ...ends(result),
  ]),
  { type: "turn_end", message, toolResults },
];
const run = (prompt, ...turns) => [
  header,
  { type: "agent_start" },
  ...ends(systemMessage),
  ...ends(userMessage(prompt)),
  ...turns.flat(),
  { type: "agent_end", messages: [], willRetry: false },
  { type: "agent_settled", aborted: false },
];

const CONTEXT = { tools: ["read", "bash"], mcpServers: [], agentMode: "medium" };

/** Feed the events to a new encoder on a clock that advances 5 ms per read. */
const encode = (events, { thinking = false, failure, context = CONTEXT } = {}) => {
  let clock = 1000;
  const encoder = createStreamJsonEncoder({ thinking, now: () => (clock += 5), context: () => context });
  const records = events.flatMap((event) => encoder.push(event));
  const end = encoder.finish(failure);
  return { records: [...records, ...end.records], exitCode: end.exitCode };
};

// --- Records, written from the stream JSON format, not from the encoder.

const INIT = { type: "system", subtype: "init", cwd: "/work/app", session_id: SESSION, tools: ["read", "bash"], mcp_servers: [], agent_mode: "medium" };
const userRecord = (content) => ({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: SESSION });
const assistantRecord = (content, stopReason, recordUsage) => ({
  type: "assistant",
  message: { type: "message", role: "assistant", content, stop_reason: stopReason, usage: recordUsage },
  parent_tool_use_id: null,
  session_id: SESSION,
});

describe("ampi stream JSON: records from Pi's events", () => {
  it("turns a text answer into init, user, assistant and a success result", () => {
    const { records, exitCode } = encode(run("hello", turn(assistant([{ type: "text", text: "Hi there." }], "stop", usage(120, 4, 30, 10)))));
    const recordUsage = { input_tokens: 120, output_tokens: 4, cache_creation_input_tokens: 10, cache_read_input_tokens: 30 };
    assert.deepEqual(records, [
      INIT,
      userRecord([{ type: "text", text: "hello" }]),
      assistantRecord([{ type: "text", text: "Hi there." }], "end_turn", recordUsage),
      { type: "result", subtype: "success", is_error: false, duration_ms: 5, num_turns: 1, session_id: SESSION, usage: recordUsage, result: "Hi there." },
    ]);
    assert.equal(exitCode, 0);
    assertSchema(records);
  });

  it("reports a tool call, its result as a user record, and usage summed over the turns", () => {
    const call = assistant([{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } }], "toolUse", usage(100, 8));
    const result = { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: "a.txt\nb.md\n" }], isError: false, timestamp: 4 };
    const answer = assistant([{ type: "text", text: "Two files." }, { type: "text", text: "Both are new." }], "stop", usage(20, 6, 100));
    const { records, exitCode } = encode(run("list files", turn(call, [result]), turn(answer)));
    assert.deepEqual(records, [
      INIT,
      userRecord([{ type: "text", text: "list files" }]),
      assistantRecord([{ type: "tool_use", id: "call_1", name: "bash", input: { command: "ls" } }], "tool_use", {
        input_tokens: 100,
        output_tokens: 8,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
      userRecord([{ type: "tool_result", tool_use_id: "call_1", content: "a.txt\nb.md\n", is_error: false }]),
      assistantRecord([{ type: "text", text: "Two files." }, { type: "text", text: "Both are new." }], "end_turn", {
        input_tokens: 20,
        output_tokens: 6,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 100,
      }),
      {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 5,
        num_turns: 2,
        session_id: SESSION,
        usage: { input_tokens: 120, output_tokens: 14, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 },
        result: "Two files.\nBoth are new.",
      },
    ]);
    assert.equal(exitCode, 0);
    assertSchema(records);
  });

  it("marks a failed tool and leaves images out of user records", () => {
    const call = assistant([{ type: "toolCall", id: "call_2", name: "read", arguments: { path: "x.png" } }], "toolUse", usage(10, 2));
    const result = {
      role: "toolResult",
      toolCallId: "call_2",
      toolName: "read",
      content: [{ type: "image", data: "aGk=", mimeType: "image/png" }, { type: "text", text: "not found" }],
      isError: true,
      timestamp: 4,
    };
    const prompt = { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "aGk=", mimeType: "image/png" }], timestamp: 2 };
    const events = run("unused", turn(call, [result]), turn(assistant([{ type: "text", text: "Missing." }], "stop", usage(1, 1))));
    events.splice(events.findIndex((event) => event.message?.role === "user"), 2, ...ends(prompt));
    const { records } = encode(events);
    assert.deepEqual(records[1], userRecord([{ type: "text", text: "look" }]));
    assert.deepEqual(records[3], userRecord([{ type: "tool_result", tool_use_id: "call_2", content: "not found", is_error: true }]));
    assertSchema(records);
  });

  it("adds thinking and redacted thinking blocks only with --stream-json-thinking", () => {
    const content = [
      { type: "thinking", thinking: "The user wants a greeting.", thinkingSignature: "sig-1" },
      { type: "thinking", thinking: "", thinkingSignature: "opaque-payload", redacted: true },
      { type: "text", text: "Hello." },
    ];
    const events = run("greet me", turn(assistant(content, "stop", usage(5, 9))));
    const withThinking = encode(events, { thinking: true }).records;
    assert.deepEqual(withThinking[2].message.content, [
      { type: "thinking", thinking: "The user wants a greeting." },
      { type: "redacted_thinking", data: "opaque-payload" },
      { type: "text", text: "Hello." },
    ]);
    const without = encode(events).records;
    assert.deepEqual(without[2].message.content, [{ type: "text", text: "Hello." }]);
    // Thinking alone, without the flag, leaves nothing to report for that message.
    const onlyThinking = encode(run("think", turn(assistant([content[0]], "stop", usage(1, 1))))).records;
    assert.deepEqual(
      onlyThinking.map((record) => record.type),
      ["system", "user", "result"],
    );
    assert.equal(onlyThinking[2].result, "");
    assertSchema([...withThinking, ...without, ...onlyThinking]);
  });

  it("ends a failed request with an error result and exit code 1, without an empty assistant record", () => {
    const failed = assistant([{ type: "text", text: "" }], "error", usage(50, 0), { errorMessage: "429 rate limited" });
    const { records, exitCode } = encode(run("hello", turn(failed)));
    assert.deepEqual(records, [
      INIT,
      userRecord([{ type: "text", text: "hello" }]),
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        duration_ms: 5,
        num_turns: 1,
        session_id: SESSION,
        usage: { input_tokens: 50, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        error: "429 rate limited",
      },
    ]);
    assert.equal(exitCode, 1);
    assertSchema(records);
  });

  it("treats an aborted request and an answer cut off at the output limit as failures", () => {
    const aborted = encode(run("hello", turn(assistant([], "aborted", usage(1, 0)))));
    assert.equal(aborted.exitCode, 1);
    assert.equal(aborted.records.at(-1).error, "The request was aborted.");
    const cut = encode(run("hello", turn(assistant([{ type: "text", text: "The first half" }], "length", usage(1, 4096)))));
    assert.equal(cut.exitCode, 1);
    // The partial answer is still in the assistant record.
    assert.equal(cut.records[2].message.stop_reason, "max_tokens");
    assert.deepEqual(cut.records[2].message.content, [{ type: "text", text: "The first half" }]);
    assert.equal(cut.records.at(-1).subtype, "error_during_execution");
    assert.equal(cut.records.at(-1).error, "The answer was cut off at the model's output limit.");
    assertSchema([...aborted.records, ...cut.records]);
  });

  it("reports success when Pi's automatic retry recovers from a failed request", () => {
    const failed = assistant([], "error", usage(10, 0), { errorMessage: "overloaded" });
    const events = run("hello", turn(failed), turn(assistant([{ type: "text", text: "Recovered." }], "stop", usage(10, 2))));
    const { records, exitCode } = encode(events);
    assert.equal(exitCode, 0);
    assert.equal(records.at(-1).result, "Recovered.");
    assert.equal(records.at(-1).num_turns, 2);
    assert.deepEqual(records.at(-1).usage, { input_tokens: 20, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
  });

  it("reports a run that failed outside the answer, and leaves agent_mode out when no ampi mode is active", () => {
    const { records, exitCode } = encode([header], { failure: "Pi stopped with an error.", context: { tools: [], mcpServers: [] } });
    assert.deepEqual(records, [
      { type: "system", subtype: "init", cwd: "/work/app", session_id: SESSION, tools: [], mcp_servers: [] },
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        duration_ms: 5,
        num_turns: 0,
        session_id: SESSION,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        error: "Pi stopped with an error.",
      },
    ]);
    assert.equal(exitCode, 1);
    assertSchema(records);
  });

  it("has a schema that rejects records outside the format", () => {
    const valid = assistantRecord([{ type: "text", text: "x" }], "end_turn", { input_tokens: 1, output_tokens: 1 });
    assert.ok(Check(schema, valid));
    assert.equal(Check(schema, { ...valid, session_id: undefined }), false);
    assert.equal(Check(schema, { ...valid, message: { ...valid.message, stop_reason: "stop" } }), false);
    assert.equal(Check(schema, { ...valid, message: { ...valid.message, content: [{ type: "toolCall", id: "c" }] } }), false);
    assert.equal(Check(schema, { type: "result", subtype: "success", is_error: true, duration_ms: 1, num_turns: 1, result: "", session_id: "s" }), false);
  });
});

describe("ampi stream JSON: what the init record reads from the session", () => {
  it("reads the active tools from Pi and the mode from ampi-core's runtime", async () => {
    const { setMmrModeState } = await importSource("extensions/ampi-core/runtime.ts");
    const pi = { getActiveTools: () => ["read", "grep"] };
    try {
      setMmrModeState({ mode: "high" });
      assert.deepEqual(readStreamJsonContext(pi), { tools: ["read", "grep"], mcpServers: [], agentMode: "high" });
      setMmrModeState(undefined);
      assert.deepEqual(readStreamJsonContext(pi), { tools: ["read", "grep"], mcpServers: [] });
    } finally {
      setMmrModeState(undefined);
    }
  });

  it("reports no tools when the extension API is missing or no longer usable", () => {
    assert.deepEqual(readStreamJsonContext(undefined).tools, []);
    const stale = {
      getActiveTools: () => {
        throw new Error("stale");
      },
    };
    assert.deepEqual(readStreamJsonContext(stale).tools, []);
  });
});

describe("ampi stream JSON: the command", { concurrency: true }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ampi-cli-stream-json-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  let runs = 0;

  /**
   * Run the command with piped stdin and stdout in its own home, agent
   * directory and project. The project's settings route low mode to the
   * scripted model, so ampi applies the mode. The stored credential makes Pi
   * count the scripted provider as signed in the moment it is registered;
   * without one, that waits for an availability check Pi runs in the
   * background, which can still be pending when ampi picks the mode's model.
   */
  const runAmpi = (args) => {
    const root = path.join(dir, String(++runs));
    for (const sub of ["home", "agent", "project/.pi"]) mkdirSync(path.join(root, sub), { recursive: true });
    writeFileSync(path.join(root, "agent", "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "scripted" } }));
    const project = path.join(root, "project");
    writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify({ ampiCore: { modelPreferences: { low: ["faux/faux-1"] } } }));
    writeFileSync(path.join(project, "notes.md"), "");
    const env = { PATH: process.env.PATH, HOME: path.join(root, "home"), PI_CODING_AGENT_DIR: path.join(root, "agent"), PI_OFFLINE: "1" };
    const child = spawn(process.execPath, [bin, "-e", fauxModel, "--model", "faux/faux-1", ...args], { cwd: project, env });
    child.stdin.end();
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    return new Promise((resolve) => child.on("close", (status) => resolve({ project, status, stdout, stderr })));
  };
  const recordsOf = (stdout) => {
    assert.ok(stdout.endsWith("\n"), "the last record ends with a newline");
    return stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
  };
  const assistantText = (records) =>
    records
      .filter((record) => record.type === "assistant")
      .flatMap((record) => record.message.content)
      .filter((block) => block.type === "text")
      .map((block) => block.text);

  it("streams a tool call and its result, and ends with the final answer", async () => {
    const result = await runAmpi(["-m", "low", "-x", "list files", "--stream-json"]);
    assert.equal(result.status, 0, result.stderr);
    const records = recordsOf(result.stdout);
    assertSchema(records);
    assert.deepEqual(
      records.map((record) => record.type),
      ["system", "user", "assistant", "user", "assistant", "result"],
    );
    const [init, prompt, call, toolResult, , end] = records;
    assert.equal(init.cwd, result.project);
    assert.equal(init.agent_mode, "low");
    assert.ok(init.tools.includes("bash"), init.tools.join(" "));
    assert.ok(records.every((record) => record.session_id === init.session_id));
    assert.deepEqual(prompt.message.content, [{ type: "text", text: "list files" }]);
    assert.deepEqual(call.message.content, [{ type: "tool_use", id: "call_ls", name: "bash", input: { command: "ls" } }]);
    assert.equal(toolResult.message.content[0].tool_use_id, "call_ls");
    assert.match(toolResult.message.content[0].content, /notes\.md/);
    assert.deepEqual(assistantText(records), ["Files:\nnotes.md"]);
    assert.equal(end.subtype, "success");
    assert.equal(end.result, "Files:\nnotes.md");
    assert.equal(end.num_turns, 2);
  });

  it("adds the model's thinking with --stream-json-thinking", async () => {
    const result = await runAmpi(["-x", "list files", "--stream-json-thinking"]);
    assert.equal(result.status, 0, result.stderr);
    const records = recordsOf(result.stdout);
    assertSchema(records);
    assert.deepEqual(records[2].message.content[0], { type: "thinking", thinking: "A directory listing answers this." });
    // Without an applied ampi mode the init record has no agent_mode.
    assert.equal("agent_mode" in records[0], false);
  });

  it("ends with an error result and exit code 1 when the model fails", async () => {
    const result = await runAmpi(["-x", "please fail", "--stream-json"]);
    assert.equal(result.status, 1);
    const records = recordsOf(result.stdout);
    assertSchema(records);
    assert.deepEqual(
      records.map((record) => record.type),
      ["system", "user", "result"],
    );
    assert.equal(records.at(-1).error, "The scripted model failed.");
  });

  it("refuses --stream-json outside execute mode and together with Pi's --mode", async () => {
    const printMode = await runAmpi(["-p", "hi", "--stream-json"]);
    assert.equal(printMode.status, 2);
    assert.equal(printMode.stdout, "");
    assert.equal(printMode.stderr, "ampi: --stream-json needs execute mode (-x).\n");
    const jsonMode = await runAmpi(["-x", "--mode", "json", "hi", "--stream-json-thinking"]);
    assert.equal(jsonMode.status, 2);
    assert.equal(jsonMode.stdout, "");
    assert.equal(jsonMode.stderr, "ampi: --stream-json replaces Pi's output mode; leave out --mode json.\n");
  });
});
