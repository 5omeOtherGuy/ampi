// Stream JSON input of the `ampi` command (packages/ampi-cli/src/stream-json-input.js):
// input lines against the messages or errors they must give, the driver that
// turns them into commands for Pi's RPC mode, and spawned runs against the
// installed Pi with the scripted offline model (tests/fixtures/ampi-cli/faux-model),
// each record checked against tests/fixtures/ampi-cli/stream-json.schema.json.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { Check, Errors } from "typebox/schema";
import { EXECUTE_NO_MESSAGE_ERROR } from "../packages/ampi-cli/src/execute.js";
import { createLogger } from "../packages/ampi-cli/src/log.js";
import { createStreamJsonEncoder } from "../packages/ampi-cli/src/stream-json.js";
import { createStreamJsonInputDriver, parseStreamJsonInputLine } from "../packages/ampi-cli/src/stream-json-input.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const bin = path.join(repoRoot, "packages", "ampi-cli", "bin", "ampi.js");
const fauxModel = path.join(import.meta.dirname, "fixtures", "ampi-cli", "faux-model");
const schema = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "ampi-cli", "stream-json.schema.json"), "utf8"));

/** Every record must match the schema; the failure names what is wrong. */
const assertSchema = (records) => {
  for (const record of records) assert.ok(Check(schema, record), `${JSON.stringify(record)}\n${JSON.stringify(Errors(schema, record)[1].slice(0, 3))}`);
};

// The first bytes of each image format, base64-encoded by hand.
const PNG = "iVBORw0KGgoAAAANSUhEUg=="; // 89 50 4E 47 0D 0A 1A 0A, then the IHDR chunk header
const JPEG = "/9j/4AAQSkZJRg=="; // FF D8 FF E0, then JFIF
const GIF = "R0lGODlhAQABAA=="; // GIF89a
const WEBP = "UklGRiQAAABXRUJQVlA4IA=="; // RIFF, a size, WEBPVP8

const line = (value) => JSON.stringify(value);
const user = (content, extra = {}) => ({ type: "user", ...extra, message: { role: "user", content } });
const image = (mediaType, data, extra = {}) => ({ type: "image", source: { type: "base64", media_type: mediaType, data }, ...extra });

describe("ampi stream JSON input: reading one line", () => {
  it("reads string content as the message text", () => {
    assert.deepEqual(parseStreamJsonInputLine(line(user("list the files")), 1), { text: "list the files", images: [], steer: false });
  });

  it("joins text blocks with newlines and reads steer", () => {
    const parsed = parseStreamJsonInputLine(line(user([{ type: "text", text: "first" }, { type: "text", text: "second" }], { steer: true })), 4);
    assert.deepEqual(parsed, { text: "first\nsecond", images: [], steer: true });
  });

  it("turns images whose bytes match their declared type into Pi image content", () => {
    const blocks = [
      { type: "text", text: "compare these" },
      image("image/png", PNG, { source_path: "shots/a.png" }),
      image("image/jpeg", JPEG),
      image("image/gif", GIF),
      image("image/webp", WEBP),
    ];
    assert.deepEqual(parseStreamJsonInputLine(line(user(blocks)), 1), {
      text: "compare these",
      images: [
        { type: "image", data: PNG, mimeType: "image/png" },
        { type: "image", data: JPEG, mimeType: "image/jpeg" },
        { type: "image", data: GIF, mimeType: "image/gif" },
        { type: "image", data: WEBP, mimeType: "image/webp" },
      ],
      steer: false,
    });
    // An image without text is a message too.
    assert.deepEqual(parseStreamJsonInputLine(line(user([image("image/png", PNG)])), 1).text, "");
  });

  it("rejects an image whose bytes are another type than declared, or no image at all", () => {
    assert.deepEqual(parseStreamJsonInputLine(line(user([{ type: "text", text: "x" }, image("image/png", JPEG)])), 3), {
      error: "stdin line 3: content block 2: the image is declared as image/png but its data is a JPEG image",
    });
    assert.deepEqual(parseStreamJsonInputLine(line(user([image("image/gif", "aGVsbG8gd29ybGQ=")])), 2), {
      error: "stdin line 2: content block 1: the image is declared as image/gif but its data is not a PNG, JPEG, GIF or WebP image",
    });
    assert.match(parseStreamJsonInputLine(line(user([image("image/bmp", PNG)])), 1).error, /"media_type" must be image\/png, image\/jpeg/);
    assert.match(parseStreamJsonInputLine(line(user([image("image/png", "not base64!")])), 1).error, /"data" must be base64/);
    assert.match(parseStreamJsonInputLine(line(user([{ type: "image", source: { type: "url", url: "https://x" } }])), 1).error, /"type": "base64"/);
  });

  it("accepts ten images on a line and rejects eleven", () => {
    const ten = Array.from({ length: 10 }, () => image("image/png", PNG));
    assert.equal(parseStreamJsonInputLine(line(user(ten)), 1).images.length, 10);
    assert.deepEqual(parseStreamJsonInputLine(line(user([...ten, image("image/png", PNG)])), 5), { error: "stdin line 5: more than 10 images" });
  });

  it("names the line and the problem for anything that is not a user message", () => {
    const cases = [
      ["{not json", "stdin line 7: not valid JSON"],
      ["[1, 2]", "stdin line 7: expected a JSON object"],
      [line({ type: "assistant", message: { role: "user", content: "x" } }), 'stdin line 7: "type" must be "user"'],
      [line({ type: "user" }), 'stdin line 7: "message" must be an object'],
      [line({ type: "user", message: { role: "assistant", content: "x" } }), 'stdin line 7: "message.role" must be "user"'],
      [line({ type: "user", message: { role: "user" } }), 'stdin line 7: "message.content" must be a string or an array of content blocks'],
      [line(user("x", { steer: "yes" })), 'stdin line 7: "steer" must be true or false'],
      [line(user([{ type: "tool_result", tool_use_id: "a", content: "b" }])), 'stdin line 7: content block 1: "type" must be "text" or "image"'],
      [line(user([{ type: "text", text: 42 }])), 'stdin line 7: content block 1: "text" must be a string'],
      [line(user("   ")), "stdin line 7: the message has no text and no images"],
    ];
    for (const [input, error] of cases) assert.deepEqual(parseStreamJsonInputLine(input, 7), { error }, input);
  });
});

describe("ampi stream JSON input: driving Pi's RPC mode", () => {
  const SESSION = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
  const answer = (text) => [
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: { input: 3, output: 2 }, stopReason: "stop" } },
    { type: "turn_end" },
    { type: "agent_end", messages: [] },
    { type: "agent_settled", aborted: false },
  ];

  /** A driver on a real encoder with a clock that advances 5 ms per read, recording what it does. */
  const drive = () => {
    let clock = 0;
    const encoder = createStreamJsonEncoder({ thinking: false, now: () => (clock += 5), context: () => ({ tools: [], mcpServers: [] }) });
    encoder.push({ type: "session", id: SESSION, cwd: "/work" });
    const sent = [];
    const records = [];
    const warnings = [];
    let ended = 0;
    const driver = createStreamJsonInputDriver(encoder, {
      send: (command) => sent.push(command),
      write: (written) => records.push(...written),
      log: createLogger({ stderr: (text) => warnings.push(text) }),
      end: () => ended++,
    });
    return { driver, sent, records, warnings, ended: () => ended };
  };

  it("sends one prompt at a time, in order, with the steer flag as Pi's streaming behavior", () => {
    const { driver, sent } = drive();
    driver.line(line(user("first")));
    driver.line(line(user([image("image/png", PNG)], { steer: true })));
    assert.deepEqual(sent, [{ id: "ampi-input-1", type: "prompt", message: "first", streamingBehavior: "followUp" }]);
    driver.receive({ id: "ampi-input-1", type: "response", command: "prompt", success: true, data: { disposition: "started" } });
    assert.deepEqual(sent[1], {
      id: "ampi-input-2",
      type: "prompt",
      message: "",
      images: [{ type: "image", data: PNG, mimeType: "image/png" }],
      streamingBehavior: "steer",
    });
  });

  it("writes a result for each settled run and ends Pi's input after stdin ends and the last run settles", () => {
    const { driver, records, ended } = drive();
    driver.line(line(user("first")));
    driver.receive({ id: "ampi-input-1", type: "response", command: "prompt", success: true, data: { disposition: "started" } });
    for (const event of answer("one")) driver.receive(event);
    driver.line("");
    driver.line(line(user("second")));
    driver.end();
    driver.receive({ id: "ampi-input-2", type: "response", command: "prompt", success: true, data: { disposition: "started" } });
    assert.equal(ended(), 0, "the second run is still in progress");
    for (const event of answer("two")) driver.receive(event);
    assert.equal(ended(), 1);
    const results = records.filter((record) => record.type === "result");
    assert.deepEqual(
      results.map((record) => [record.subtype, record.result, record.num_turns]),
      [
        ["success", "one", 1],
        ["success", "two", 1],
      ],
    );
    assert.equal(driver.exitCode, 0);
    assertSchema(records);
  });

  it("waits for a run Pi starts without a prompt before it ends Pi's input", () => {
    const { driver, records, ended } = drive();
    driver.line(line(user("first")));
    driver.receive({ id: "ampi-input-1", type: "response", command: "prompt", success: true, data: { disposition: "started" } });
    for (const event of answer("one")) driver.receive(event);
    const [start, turnStart, ...rest] = answer("task done");
    driver.receive(start);
    driver.receive(turnStart);
    driver.end();
    assert.equal(ended(), 0, "the run Pi started is still in progress");
    assert.equal(driver.ended, false);
    for (const event of rest) driver.receive(event);
    assert.equal(ended(), 1);
    assert.equal(driver.ended, true);
    assert.deepEqual(
      records.filter((record) => record.type === "result").map((record) => record.result),
      ["one", "task done"],
    );
    assert.equal(driver.exitCode, 0);
  });

  it("cancels extension dialogs at once and passes extension errors to stderr", () => {
    const { driver, sent, warnings } = drive();
    for (const method of ["select", "confirm", "input", "editor"]) driver.receive({ type: "extension_ui_request", id: `ui-${method}`, method, title: "Allow?" });
    driver.receive({ type: "extension_ui_request", id: "ui-notify", method: "notify", message: "hello" });
    assert.deepEqual(
      sent,
      ["select", "confirm", "input", "editor"].map((method) => ({ type: "extension_ui_response", id: `ui-${method}`, cancelled: true })),
    );
    driver.receive({ type: "extension_error", extensionPath: "/ext/a.ts", event: "input", error: "boom" });
    assert.deepEqual(warnings, ["ampi: extension error (/ext/a.ts, input): boom\n"]);
  });

  it("reports a prompt Pi rejects as a failed run and exits 1", () => {
    const { driver, records, ended } = drive();
    driver.line(line(user("first")));
    driver.end();
    driver.receive({ id: "ampi-input-1", type: "response", command: "prompt", success: false, error: "No model selected." });
    assert.equal(records.at(-1).subtype, "error_during_execution");
    assert.equal(records.at(-1).error, "No model selected.");
    assert.equal(driver.exitCode, 1);
    assert.equal(ended(), 1);
    assertSchema(records);
  });

  it("stops at an invalid line, lets the current run finish, then reports the line", () => {
    const { driver, sent, records, ended } = drive();
    driver.line(line(user("first")));
    driver.receive({ id: "ampi-input-1", type: "response", command: "prompt", success: true, data: { disposition: "started" } });
    driver.line("{oops");
    driver.line(line(user("never sent")));
    assert.equal(ended(), 0);
    for (const event of answer("one")) driver.receive(event);
    assert.equal(sent.length, 1);
    assert.equal(ended(), 1);
    assert.deepEqual(
      records.filter((record) => record.type === "result").map((record) => record.error ?? record.result),
      ["one", "stdin line 2: not valid JSON"],
    );
    assert.equal(driver.exitCode, 1);
    assertSchema(records);
  });
});

// The timeout fails runs that hang, for example when Pi stops reading its input from
// process.stdin, well before CI gives up on the job; the commands still running are killed.
describe("ampi stream JSON input: the command", { concurrency: true, timeout: 300_000 }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ampi-cli-stream-json-input-"));
  const children = new Set();
  after(() => {
    for (const child of children) child.kill();
    rmSync(dir, { recursive: true, force: true });
  });
  let runs = 0;

  /**
   * Start the command with --stream-json-input in its own home, agent
   * directory and project, with stdin and stdout as pipes the test drives.
   */
  const start = (args = [], { agentSettings } = {}) => {
    const root = path.join(dir, String(++runs));
    for (const sub of ["home", "agent", "project"]) mkdirSync(path.join(root, sub), { recursive: true });
    if (agentSettings !== undefined) writeFileSync(path.join(root, "agent", "settings.json"), JSON.stringify(agentSettings));
    const project = path.join(root, "project");
    const env = { PATH: process.env.PATH, HOME: path.join(root, "home"), PI_CODING_AGENT_DIR: path.join(root, "agent"), PI_OFFLINE: "1" };
    const argv = [bin, "-e", fauxModel, "--model", "faux/faux-1", "-x", "--stream-json", "--stream-json-input", ...args];
    const child = spawn(process.execPath, argv, { cwd: project, env });
    children.add(child);
    child.on("exit", () => children.delete(child));
    let stdout = "";
    let stderr = "";
    let closed = false;
    const checks = new Set();
    const records = () =>
      stdout
        .split("\n")
        .slice(0, -1)
        .map((text) => JSON.parse(text));
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (const check of checks) check();
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const done = new Promise((resolve) =>
      child.on("close", (status) => {
        closed = true;
        for (const check of checks) check();
        resolve({ status, stdout, stderr });
      }),
    );
    return {
      project,
      send: (text) => child.stdin.write(`${text}\n`),
      end: () => child.stdin.end(),
      done,
      /** Resolves once the records so far satisfy `predicate`; rejects if the command exits first. */
      until: (predicate) =>
        new Promise((resolve, reject) => {
          const check = () => {
            if (predicate(records())) {
              checks.delete(check);
              resolve();
            } else if (closed) {
              checks.delete(check);
              reject(new Error(`the command exited first\n${stdout}\n${stderr}`));
            }
          };
          checks.add(check);
          check();
        }),
    };
  };
  const recordsOf = (stdout) => {
    assert.ok(stdout.endsWith("\n"), "the last record ends with a newline");
    return stdout.trimEnd().split("\n").map((text) => JSON.parse(text));
  };
  const textOf = (record) => record.message.content.map((block) => block.text ?? block.content ?? `[${block.type}]`).join("");
  const hasResult = (records) => records.some((record) => record.type === "result");

  it("answers two messages in two runs, each with its user record and result", async () => {
    const run = start();
    run.send(line(user("first message")));
    await run.until(hasResult);
    run.send(line(user([{ type: "text", text: "second message" }])));
    run.end();
    const { status, stdout, stderr } = await run.done;
    assert.equal(status, 0, stderr);
    const records = recordsOf(stdout);
    assertSchema(records);
    assert.deepEqual(
      records.map((record) => (record.type === "result" ? `result: ${record.result}` : record.type === "system" ? "init" : `${record.type}: ${textOf(record)}`)),
      ["init", "user: first message", "assistant: Echo: first message", "result: Echo: first message", "user: second message", "assistant: Echo: second message", "result: Echo: second message"],
    );
    const [init] = records;
    assert.equal(init.cwd, run.project);
    assert.ok(init.session_id.length > 0);
    assert.ok(records.every((record) => record.session_id === init.session_id));
    assert.ok(records.filter((record) => record.type === "result").every((record) => record.subtype === "success" && record.num_turns === 1));
  });

  it("refuses a call that needs approval instead of opening a dialog, and lists it in that run's result only", async () => {
    const agentSettings = { ampi: { permissions: [{ tool: "bash", matches: { command: "echo *" }, action: "ask" }] } };
    const run = start([], { agentSettings });
    run.send(line(user("run: echo one")));
    await run.until(hasResult);
    run.send(line(user("nothing to run")));
    run.end();
    const { status, stdout, stderr } = await run.done;
    assert.equal(status, 0, stderr);
    const records = recordsOf(stdout);
    assertSchema(records);
    const toolResult = records.find((record) => record.type === "user" && record.message.content[0].type === "tool_result").message.content[0];
    assert.equal(toolResult.is_error, true);
    assert.match(toolResult.content, /^The bash call needs the user's approval, and this run cannot ask for it\. .* --ampi-dangerously-allow-all \(pi\)\.$/);
    assert.doesNotMatch(toolResult.content, /dialog/);
    const results = records.filter((record) => record.type === "result");
    assert.deepEqual(
      results.map((record) => [record.result.split(".")[0], record.permission_denials]),
      [
        ["Ran: The bash call needs the user's approval, and this run cannot ask for it", ["bash"]],
        ["Echo: nothing to run", undefined],
      ],
    );
    assert.doesNotMatch(stderr, /refused/);
  });

  it("delivers a steering message to the run in progress", async () => {
    const run = start();
    // The scripted model runs `cat` on this FIFO; the steering message writes it when Pi receives it.
    const fifo = path.join(run.project, "gate");
    execFileSync("mkfifo", [fifo]);
    run.send(line(user(`wait on ${fifo}`)));
    await run.until((records) => records.some((record) => record.type === "assistant" && record.message.content[0].type === "tool_use"));
    run.send(line(user(`release ${fifo} and change course`, { steer: true })));
    run.end();
    const { status, stdout, stderr } = await run.done;
    assert.equal(status, 0, stderr);
    const records = recordsOf(stdout);
    assertSchema(records);
    assert.deepEqual(
      records.map((record) => record.type),
      ["system", "user", "assistant", "user", "user", "assistant", "result"],
    );
    assert.match(records[3].message.content[0].content, /^released\b/);
    assert.equal(textOf(records[4]), `release ${fifo} and change course`);
    // One run: the answer after the tool call already follows the steering message.
    assert.equal(records.at(-1).result, `Echo: release ${fifo} and change course`);
    assert.equal(records.at(-1).num_turns, 2);
  });

  it("exits 2 without records when stdin ends before a message", async () => {
    const run = start();
    run.send("");
    run.end();
    const { status, stdout, stderr } = await run.done;
    assert.equal(status, 2);
    assert.equal(stdout, "");
    assert.equal(stderr, `ampi: ${EXECUTE_NO_MESSAGE_ERROR}\n`);
  });

  it("stops at an invalid second line and exits 1 with an error naming it", async () => {
    const run = start();
    run.send(line(user("first message")));
    run.send('{"type": "user", "message": "not an object"}');
    // Stdin stays open: the invalid line alone ends the run.
    const { status, stdout, stderr } = await run.done;
    assert.equal(status, 1, stderr);
    const records = recordsOf(stdout);
    assertSchema(records);
    assert.deepEqual(
      records.map((record) => record.subtype ?? record.type),
      ["init", "user", "assistant", "success", "error_during_execution"],
    );
    assert.equal(records.at(-1).error, 'stdin line 2: "message" must be an object');
  });

  it("refuses a message argument", async () => {
    const run = start(["hello"]);
    run.end();
    const { status, stdout, stderr } = await run.done;
    assert.equal(status, 2);
    assert.equal(stdout, "");
    assert.equal(stderr, "ampi: --stream-json-input reads every message from stdin; leave out the message argument.\n");
  });
});
