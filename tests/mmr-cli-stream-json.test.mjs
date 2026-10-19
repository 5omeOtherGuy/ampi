// Stream JSON output of the `ampi` command (packages/ampi-cli/src/stream-json.js):
// hand-written Pi JSON event sequences against the records they must become,
// a schema check of every record (tests/fixtures/ampi-cli/stream-json.schema.json),
// subagent records made from the trail in a worker tool's progress, what the
// init record reads from the session, and spawned runs against the installed Pi
// with the scripted offline model (tests/fixtures/ampi-cli/faux-model).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { Check, Errors } from "typebox/schema";
import { createStreamJsonEncoder, readStreamJsonContext, readWorkerRun } from "../packages/ampi-cli/src/stream-json.js";
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

// --- Worker tools: progress updates whose details carry ampi's worker run
// envelope and the child's trail, written as ampi-workers sends them.

const workerRun = (toolName, runMode = "blocking", status = "running") => ({
  kind: "worker-run",
  version: 1,
  run: { profileName: toolName === "Task" ? "task-subagent" : toolName, toolName, agent: toolName, runMode, status, workerTools: ["bash", "read"] },
  snapshot: {},
  render: {},
});
const workerDetails = (toolName, trail, runMode, status) => ({
  worker: `ampi-workers.${toolName}`,
  status: "success",
  usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
  workerTools: ["bash", "read"],
  trail,
  ...workerRun(toolName, runMode, status),
});
const progress = (toolCallId, trail, { toolName = "Task", runMode = "blocking", extra = {} } = {}) => ({
  type: "tool_execution_update",
  toolCallId,
  toolName,
  args: { prompt: "run probe", description: "Probe" },
  partialResult: { content: [{ type: "text", text: "(working)" }], details: workerDetails(toolName, trail, runMode) },
  ...extra,
});
const finished = (toolCallId, trail, { toolName = "Task", text = "Child done.", extra = {} } = {}) => ({
  type: "tool_execution_end",
  toolCallId,
  toolName,
  result: { content: [{ type: "text", text }], details: workerDetails(toolName, trail, "blocking", "succeeded") },
  isError: false,
  durationMs: 40,
  ...extra,
});
/** One turn of the main agent that calls worker tools and reports their results. */
const workerTurn = (calls, events) => {
  const message = assistant(
    calls.map(({ id, name }) => ({ type: "toolCall", id, name, arguments: { prompt: "run probe", description: "Probe" } })),
    "toolUse",
    usage(40, 6),
  );
  const results = calls.map(({ id, name }) => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: `${name} done.` }], isError: false, timestamp: 4 }));
  return [
    { type: "turn_start" },
    ...ends(message),
    ...calls.map(({ id, name }) => ({ type: "tool_execution_start", toolCallId: id, toolName: name, args: { prompt: "run probe", description: "Probe" } })),
    ...events,
    ...results.flatMap(ends),
    { type: "turn_end", message, toolResults: results },
  ];
};
const finalTurn = () => turn(assistant([{ type: "text", text: "Parent done." }], "stop", usage(50, 2)));

const said = (text) => ({ type: "assistant", text });
const prompted = (text = "Task: run probe") => ({ type: "user", text });
const toolItem = (toolCallId, status, extra = {}) => ({
  type: "tool",
  toolCallId,
  toolName: "bash",
  status,
  args: { command: `echo ${toolCallId}` },
  argsPreview: `{"command":"echo ${toolCallId}"}`,
  ...(status === "running" ? {} : { isError: status === "failed" }),
  ...extra,
});

/** A tool item as the child's answer first names it, before the child starts the tool with its arguments. */
const named = (item) => {
  const { args: _args, ...rest } = item;
  return rest;
};
const childText = (parent, text) => ({
  type: "assistant",
  message: { type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: null },
  parent_tool_use_id: parent,
  session_id: SESSION,
});
const childToolUse = (parent, id, input = { command: `echo ${id}` }) => ({
  type: "assistant",
  message: { type: "message", role: "assistant", content: [{ type: "tool_use", id, name: "bash", input }], stop_reason: null },
  parent_tool_use_id: parent,
  session_id: SESSION,
});
const childToolResult = (parent, id, content, isError = false) => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
  parent_tool_use_id: parent,
  session_id: SESSION,
});
/** The records of the events that a subagent produced, checked against the schema. */
const childRecordsOf = (events, options) => {
  const { records } = encode([header, ...events], options);
  assertSchema(records);
  return records.filter((record) => typeof record.parent_tool_use_id === "string");
};
/** A short form of child records, for sequences longer than a few records. */
const summaryOf = (records) =>
  records.map((record) => {
    const block = record.message.content[0];
    if (block.type === "text") return block.text;
    if (block.type === "thinking") return `thinking: ${block.thinking}`;
    if (block.type === "tool_use") return `use ${block.id}`;
    return `result ${block.tool_use_id}: ${block.content}${block.is_error ? " (error)" : ""}`;
  });

describe("ampi stream JSON: subagent records from worker progress", () => {
  it("puts a Task child's answers and tool calls between the parent's tool_use and tool_result", () => {
    const task = { id: "toolu_task", name: "Task" };
    const events = run(
      "delegate probe",
      workerTurn(
        [task],
        [
          progress(task.id, [prompted()]),
          progress(task.id, [prompted(), said("Running the probe.")]),
          progress(task.id, [prompted(), said("Running the probe."), named(toolItem("call_echo", "running"))]),
          progress(task.id, [prompted(), said("Running the probe."), toolItem("call_echo", "running")]),
          progress(task.id, [prompted(), said("Running the probe."), toolItem("call_echo", "completed", { resultPreview: "child-ok" })]),
          // The last answer arrives only with the final result.
          finished(task.id, [prompted(), said("Running the probe."), toolItem("call_echo", "completed", { resultPreview: "child-ok" }), said("Child done: child-ok")]),
        ],
      ),
      finalTurn(),
    );
    const { records } = encode(events);
    assertSchema(records);
    const callUsage = { input_tokens: 40, output_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    const answerUsage = { input_tokens: 50, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    assert.deepEqual(records, [
      INIT,
      userRecord([{ type: "text", text: "delegate probe" }]),
      assistantRecord([{ type: "tool_use", id: "toolu_task", name: "Task", input: { prompt: "run probe", description: "Probe" } }], "tool_use", callUsage),
      childText("toolu_task", "Running the probe."),
      childToolUse("toolu_task", "call_echo"),
      childToolResult("toolu_task", "call_echo", "child-ok"),
      childText("toolu_task", "Child done: child-ok"),
      userRecord([{ type: "tool_result", tool_use_id: "toolu_task", content: "Task done.", is_error: false }]),
      assistantRecord([{ type: "text", text: "Parent done." }], "end_turn", answerUsage),
      {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 5,
        num_turns: 2,
        session_id: SESSION,
        usage: { input_tokens: 90, output_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        result: "Parent done.",
      },
    ]);
  });

  it("keeps init and result, turns and usage the same as without the child records", () => {
    const task = { id: "toolu_task", name: "Task" };
    const trail = [prompted(), said("Looking."), toolItem("call_a", "completed", { resultPreview: "a" }), said("Found it.")];
    const withChild = encode(run("delegate probe", workerTurn([task], [progress(task.id, trail), finished(task.id, trail)]), finalTurn())).records;
    const without = encode(run("delegate probe", workerTurn([task], []), finalTurn())).records;
    assert.equal(withChild.filter((record) => typeof record.parent_tool_use_id === "string").length, 4);
    assert.deepEqual(withChild[0], without[0]);
    assert.deepEqual(withChild.at(-1), without.at(-1));
    assert.equal(withChild.at(-1).num_turns, 2);
    assert.deepEqual(
      withChild.filter((record) => record.parent_tool_use_id === null),
      without.filter((record) => record.parent_tool_use_id === null),
    );
  });

  it("maps each kind of trail item, and gives a tool call one tool_result at most", () => {
    const first = [
      prompted(),
      { type: "skillInvocation", name: "probe", location: "/skills/probe/SKILL.md", text: "Run the probe." },
      { type: "thinking", text: "The probe needs a shell." },
      said("Checking."),
      toolItem("call_a", "completed", { resultPreview: "a-ok" }),
      // A separate result for a tool whose item is still there adds nothing.
      { type: "toolResult", toolCallId: "call_a", toolName: "bash", text: "a-again", isError: true },
      // A result for a tool the stream never saw adds nothing.
      { type: "toolResult", toolCallId: "call_unseen", toolName: "bash", text: "lost" },
      { type: "bashExecution", command: "ls", output: "notes.md", exitCode: 0 },
      { type: "custom", customType: "note", text: "A note." },
      { type: "compactionSummary", summary: "Earlier work.", tokensBefore: 900 },
      { type: "branchSummary", summary: "Another branch." },
      { type: "toolResult", toolName: "bash", text: "no call id" },
      toolItem("call_b", "running"),
      // Items the stream cannot read are left out.
      { type: "unknown-kind", text: "?" },
      null,
      "text",
      { type: "tool", toolName: "bash", status: "running" },
    ];
    // The tool's result arrives as a separate item; its text is the result.
    const second = [...first, { type: "toolResult", toolCallId: "call_b", toolName: "bash", text: "b-out", isError: true }];
    // The tool item completes later; its result was already streamed.
    const third = second.map((item) => (item?.toolCallId === "call_b" && item.type === "tool" ? toolItem("call_b", "completed", { resultPreview: "b-done" }) : item));
    const events = [progress("toolu_task", first), progress("toolu_task", second), finished("toolu_task", third)];
    assert.deepEqual(summaryOf(childRecordsOf(events)), ["Checking.", "use call_a", "result call_a: a-ok", "use call_b", "result call_b: b-out (error)"]);
    assert.deepEqual(summaryOf(childRecordsOf(events, { thinking: true })), [
      "thinking: The probe needs a shell.",
      "Checking.",
      "use call_a",
      "result call_a: a-ok",
      "use call_b",
      "result call_b: b-out (error)",
    ]);
    const thinkingRecord = childRecordsOf(events, { thinking: true })[0];
    assert.deepEqual(thinkingRecord.message.content, [{ type: "thinking", thinking: "The probe needs a shell." }]);
  });

  it("reports a failed child tool, a tool first seen finished, and no result for a tool still running at the end", () => {
    const trail = [
      prompted(),
      toolItem("call_fail", "failed", { resultPreview: "exit code 1" }),
      toolItem("call_bare", "completed"),
      { ...toolItem("call_odd", "running"), args: ["not", "an", "object"] },
    ];
    const records = childRecordsOf([progress("toolu_task", trail), finished("toolu_task", trail)]);
    assert.deepEqual(records, [
      childToolUse("toolu_task", "call_fail"),
      childToolResult("toolu_task", "call_fail", "exit code 1", true),
      childToolUse("toolu_task", "call_bare"),
      childToolResult("toolu_task", "call_bare", ""),
      childToolUse("toolu_task", "call_odd", {}),
    ]);
  });

  it("waits for a child tool's arguments before its tool_use, keeping the order", () => {
    const events = [
      progress("t", [prompted(), named(toolItem("call_1", "running")), named(toolItem("call_2", "running"))]),
      progress("t", [prompted(), toolItem("call_1", "running"), named(toolItem("call_2", "running"))]),
      progress("t", [prompted(), toolItem("call_1", "completed", { resultPreview: "one" }), named(toolItem("call_2", "running")), said("Later.")]),
      progress("t", [prompted(), toolItem("call_1", "completed", { resultPreview: "one" }), toolItem("call_2", "running"), said("Later.")]),
      // A tool that finishes, or a worker call that ends, before the arguments arrive streams without them.
      progress("t", [prompted(), toolItem("call_1", "completed", { resultPreview: "one" }), toolItem("call_2", "running"), said("Later."), named(toolItem("call_3", "completed"))]),
      finished("t", [prompted(), toolItem("call_1", "completed", { resultPreview: "one" }), toolItem("call_2", "running"), said("Later."), named(toolItem("call_3", "completed")), named(toolItem("call_4", "running"))]),
    ];
    const records = childRecordsOf(events);
    assert.deepEqual(summaryOf(records), ["use call_1", "result call_1: one", "use call_2", "Later.", "use call_3", "result call_3: ", "use call_4"]);
    assert.deepEqual(
      records.filter((record) => record.type === "assistant" && record.message.content[0].type === "tool_use").map((record) => record.message.content[0].input),
      [{ command: "echo call_1" }, { command: "echo call_2" }, {}, {}],
    );
  });

  it("streams nothing twice when the same snapshot arrives again", () => {
    const trail = [prompted(), said("Once."), toolItem("call_a", "running")];
    const done = [prompted(), said("Once."), toolItem("call_a", "completed", { resultPreview: "a" })];
    const events = [progress("t", trail), progress("t", trail), progress("t", trail), progress("t", done), progress("t", done), finished("t", done)];
    assert.deepEqual(summaryOf(childRecordsOf(events)), ["Once.", "use call_a", "result call_a: a"]);
  });

  it("follows a trail at its limit that drops its oldest items, and skips items dropped before an update showed them", () => {
    // A trail of at most four items, as ampi's is of at most 32.
    const updates = [
      [said("One"), toolItem("t1", "running")],
      [said("One"), toolItem("t1", "completed", { resultPreview: "t1-ok" }), said("Two"), said("Three")],
      // One item dropped.
      [toolItem("t1", "completed", { resultPreview: "t1-ok" }), said("Two"), said("Three"), toolItem("t2", "running")],
      // Two items dropped at once, while t2 completes.
      [said("Three"), toolItem("t2", "completed", { resultPreview: "t2-ok" }), said("Four"), said("Five")],
      [said("Five"), said("Six"), said("Seven"), said("Eight")],
      // "Nine" and "Ten" were dropped before any update showed them.
      [said("Eleven"), said("Twelve"), said("Again"), said("Again")],
      [said("Twelve"), said("Again"), said("Again"), said("Again")],
      // One to three new items fit here; the longest overlap wins, so nothing comes twice.
      [said("Again"), said("Again"), said("Again"), said("Again")],
    ];
    const events = updates.map((trail) => progress("t", trail));
    events.push(finished("t", updates.at(-1)));
    assert.deepEqual(summaryOf(childRecordsOf(events)), [
      "One",
      "use t1",
      "result t1: t1-ok",
      "Two",
      "Three",
      "use t2",
      "result t2: t2-ok",
      "Four",
      "Five",
      "Six",
      "Seven",
      "Eight",
      "Eleven",
      "Twelve",
      "Again",
      "Again",
      "Again",
      "Again",
    ]);
  });

  it("streams the new run of a child that a model fallback restarted, under the same call", () => {
    const events = [
      progress("t", [prompted(), said("First try."), toolItem("call_ls", "completed", { resultPreview: "a" })]),
      // The new run's trail starts again from the prompt.
      progress("t", [prompted()]),
      progress("t", [prompted(), toolItem("call_ls", "completed", { resultPreview: "b" }), said("Second try.")]),
      finished("t", [prompted(), toolItem("call_ls", "completed", { resultPreview: "b" }), said("Second try.")]),
    ];
    const records = childRecordsOf(events);
    assert.deepEqual(summaryOf(records), ["First try.", "use call_ls", "result call_ls: a", "use call_ls", "result call_ls: b", "Second try."]);
    assert.ok(records.every((record) => record.parent_tool_use_id === "t"));
  });

  it("reads the envelope's snapshot trail when the details have none, and ignores a trail that is not a list", () => {
    const details = (trail, snapshotTrail) => {
      const { trail: _trail, ...rest } = workerDetails("finder", [], "blocking");
      return { ...rest, ...(trail === undefined ? {} : { trail }), snapshot: { trail: snapshotTrail } };
    };
    const update = (trail, snapshotTrail) => ({ ...progress("f", [], { toolName: "finder" }), partialResult: { content: [], details: details(trail, snapshotTrail) } });
    assert.deepEqual(summaryOf(childRecordsOf([update(undefined, [said("From the snapshot.")])])), ["From the snapshot."]);
    assert.deepEqual(childRecordsOf([update({ length: 1, 0: said("Not a list.") }, "nor this")]), []);
  });

  it("streams nothing for tools without the envelope and for background and internal runs", () => {
    const trail = [prompted(), said("Hidden.")];
    const bash = [
      { type: "tool_execution_start", toolCallId: "call_sh", toolName: "bash", args: { command: "make" } },
      { type: "tool_execution_update", toolCallId: "call_sh", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: "building" }], details: { trail } } },
      { type: "tool_execution_end", toolCallId: "call_sh", toolName: "bash", result: { content: [{ type: "text", text: "done" }] }, isError: false },
    ];
    const background = [
      progress("call_bg", trail, { toolName: "start_task", runMode: "background" }),
      progress("call_int", trail, { runMode: "internal" }),
      { ...finished("call_poll", trail, { toolName: "task_wait" }), result: { content: [], details: workerDetails("Task", trail, "background", "succeeded") } },
    ];
    const unknownVersion = { ...progress("call_v2", trail), partialResult: { content: [], details: { ...workerDetails("Task", trail), version: 2 } } };
    assert.deepEqual(childRecordsOf([...bash, ...background, unknownVersion]), []);
  });

  it("carries a finder child's sanitised links as its trail gives them", () => {
    const text = "Defined in [src/app.ts#L4-L9](file:///work/app/src/app.ts#L4-L9); an outside copy is /etc/app.ts#L1.";
    const records = childRecordsOf([progress("call_find", [prompted("Find the app"), said(text)], { toolName: "finder" })]);
    assert.deepEqual(records, [childText("call_find", text)]);
  });

  it("names each worker call's own parent when two run at once", () => {
    const task = { id: "toolu_task", name: "Task" };
    const finder = { id: "toolu_find", name: "finder" };
    const events = run(
      "two at once",
      workerTurn(
        [task, finder],
        [
          progress(task.id, [prompted(), said("Task one.")]),
          progress(finder.id, [prompted("Find"), said("Finder one.")], { toolName: "finder" }),
          progress(task.id, [prompted(), said("Task one."), toolItem("call_t", "running")]),
          progress(finder.id, [prompted("Find"), said("Finder one."), toolItem("call_f", "completed", { resultPreview: "f" })], { toolName: "finder" }),
          finished(task.id, [prompted(), said("Task one."), toolItem("call_t", "completed", { resultPreview: "t" })]),
          finished(finder.id, [prompted("Find"), said("Finder one."), toolItem("call_f", "completed", { resultPreview: "f" }), said("Finder two.")], { toolName: "finder" }),
        ],
      ),
      finalTurn(),
    );
    const { records } = encode(events);
    assertSchema(records);
    const children = records.filter((record) => typeof record.parent_tool_use_id === "string");
    assert.deepEqual(
      children.map((record) => [record.parent_tool_use_id, summaryOf([record])[0]]),
      [
        ["toolu_task", "Task one."],
        ["toolu_find", "Finder one."],
        ["toolu_task", "use call_t"],
        ["toolu_find", "use call_f"],
        ["toolu_find", "result call_f: f"],
        ["toolu_task", "result call_t: t"],
        ["toolu_find", "Finder two."],
      ],
    );
  });

  it("names the outermost call the stream showed for a worker another tool called", () => {
    const code = { id: "toolu_code", name: "codemode" };
    const nested = (id, parent) => ({ extra: { parentToolCallId: parent }, id });
    const batch = nested("toolu_code/1", "toolu_code");
    const inner = nested("toolu_code/1/1", "toolu_code/1");
    const events = run(
      "script it",
      workerTurn(
        [code],
        [
          { type: "tool_execution_start", toolCallId: batch.id, toolName: "batch", args: {}, parentToolCallId: "toolu_code" },
          { type: "tool_execution_start", toolCallId: inner.id, toolName: "Task", args: {}, parentToolCallId: batch.id },
          progress(inner.id, [prompted(), said("Nested child.")], { extra: inner.extra }),
          finished(inner.id, [prompted(), said("Nested child."), toolItem("call_n", "completed", { resultPreview: "n" })], { extra: inner.extra }),
          { type: "tool_execution_end", toolCallId: batch.id, toolName: "batch", result: { content: [] }, isError: false, parentToolCallId: "toolu_code" },
        ],
      ),
      finalTurn(),
    );
    const { records } = encode(events);
    assertSchema(records);
    const children = records.filter((record) => typeof record.parent_tool_use_id === "string");
    assert.equal(children.length, 3);
    assert.ok(children.every((record) => record.parent_tool_use_id === "toolu_code"));
    // The parent id names a tool_use the stream showed.
    assert.ok(records.some((record) => record.message?.content?.some((block) => block.type === "tool_use" && block.id === "toolu_code" && record.parent_tool_use_id === null)));
  });

  it("detects the worker run envelope as ampi-workers does", async () => {
    const { readWorkerRunEnvelope } = await importSource("extensions/ampi-workers/rendering/worker-run-envelope.ts");
    const valid = workerRun("Task");
    const cases = [
      valid,
      workerRun("finder", "background"),
      workerRun("oracle", "internal"),
      { ...workerDetails("Task", []), trail: [said("x")] },
      // Legacy details without the envelope.
      { worker: "ampi-workers.Task", status: "success", trail: [] },
      { ...valid, version: 2 },
      { ...valid, version: "1" },
      { ...valid, kind: "worker-runs" },
      { ...valid, run: undefined },
      { ...valid, run: [] },
      { ...valid, run: { ...valid.run, runMode: "foreground" } },
      { ...valid, run: { ...valid.run, status: 1 } },
      { ...valid, run: { ...valid.run, agent: undefined } },
      { ...valid, run: { ...valid.run, profileName: null } },
      { ...valid, run: { ...valid.run, toolName: 7 } },
      { ...valid, snapshot: "not an object" },
      [valid],
      null,
      undefined,
      "worker-run",
    ];
    for (const details of cases) {
      assert.equal(readWorkerRun(details)?.runMode, readWorkerRunEnvelope(details)?.run.runMode, JSON.stringify(details));
    }
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
