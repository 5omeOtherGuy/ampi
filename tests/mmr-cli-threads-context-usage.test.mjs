// `ampi threads context`, `ampi threads usage` and `ampi usage`
// (packages/ampi-cli/src/threads.js with the reports in src/cli-threads.ts,
// loaded through Pi): a temporary agent directory whose sessions are written
// through Pi's SessionManager on a fixed clock, in two directories, with a
// models.json that adds a model with a small context window. The expected
// numbers are worked out by hand below, at four characters to a token.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";
import * as pi from "@earendil-works/pi-coding-agent";
import { createLogger } from "../packages/ampi-cli/src/log.js";
import { threadIndexPath, updateThreadRecord } from "../packages/ampi-cli/src/thread-index.js";
import { formatThreadsHelp, runThreadsCommand } from "../packages/ampi-cli/src/threads.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const bin = path.join(repoRoot, "packages", "ampi-cli", "bin", "ampi.js");

const NOW = Date.parse("2026-10-18T10:00:00.000Z");
const MAIN = "019a0000-0000-7000-8000-00000000000a";
const BARE = "019a0000-0000-7000-8000-00000000000b";
const TINY = "019a0000-0000-7000-8000-00000000000c";
const IMPORTED = "019a0000-0000-7000-8000-00000000000d";
const OLD = "019a0000-0000-7000-8000-00000000000e";
// Sessions from August, before every range the usage tests count.
const SWITCHED = "019a0000-0000-7000-8000-00000000000f";
const MODEL_ONLY = "019a0000-0000-7000-8000-000000000010";
const EDITED = "019a0000-0000-7000-8000-000000000011";
const BULK = Array.from({ length: 11 }, (_, index) => `019b0000-0000-7000-8000-0000000000${String(index + 1).padStart(2, "0")}`);

const savedEnv = { agentDir: process.env.PI_CODING_AGENT_DIR, sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR };
const temporary = mkdtempSync(path.join(tmpdir(), "ampi-cli-context-usage-"));
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

// 167 characters: a 42-character opening tag, a newline, 100 a's, a newline and the 23-character closing tag.
const AGENTS_ROOT = `<project_instructions path="/w/AGENTS.md">\n${"a".repeat(100)}\n</project_instructions>`;
// 131 characters: a 46-character opening tag, newline, 60 b's, newline, closing tag.
const AGENTS_PKG = `<project_instructions path="/w/pkg/AGENTS.md">\n${"b".repeat(60)}\n</project_instructions>`;
// 97 characters: 18 + 1 + 18 + 1 + 18 + 1 + 20 + 1 + 19.
const SKILLS = "<available_skills>\n<skill>one</skill>\n<skill>two</skill>\n<skill>three</skill>\n</available_skills>";
// Declarations as JSON of {name, description, parameters}: 74, 76, 91 and 87 characters.
const tool = (name, description) => ({ name, description, parameters: { type: "object" } });
const TOOLS = [tool("read", "Read a file"), tool("bash", "Run a command"), tool("mcp__docs__search", "Search the docs"), tool("mcp__docs__fetch", "Fetch a page")];
// The prompt is the sections joined by blank lines: 400 + 2 + 337 + 2 + 116 = 857 characters.
const SECTIONS = {
  preamble: "p".repeat(400),
  project_context: `<project_context>\n${AGENTS_ROOT}\n\n${AGENTS_PKG}\n</project_context>`,
  skills: `<skills>\n${SKILLS}\n</skills>`,
};

const at = (iso) => Date.parse(iso);
const usage = (input, output, cacheRead, total = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
  totalTokens: input + output + cacheRead,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});
const assistant = (provider, model, content, use) => ({
  role: "assistant",
  content,
  api: "faux",
  provider,
  model,
  usage: use,
  stopReason: "stop",
  timestamp: Date.now(),
});
const text = (value) => ({ type: "text", text: value });
const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const result = (id, name, value) => ({ role: "toolResult", toolCallId: id, toolName: name, content: [text(value)], isError: false, timestamp: Date.now() });

before(() => {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(demo, { recursive: true });
  mkdirSync(other, { recursive: true });
  // A model only models.json knows, with a 300-token window and a price.
  writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        tiny: {
          baseUrl: "http://127.0.0.1:9/v1",
          api: "openai-completions",
          models: [{ id: "small", name: "Tiny Small", contextWindow: 300, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
        },
      },
    }),
  );

  mock.timers.enable({ apis: ["Date"], now: 0 });
  try {
    /** Append each step at its time; a step is a function of the manager. */
    const session = (cwd, id, steps) => {
      const [[firstIso]] = steps;
      mock.timers.setTime(at(firstIso));
      const manager = pi.SessionManager.create(cwd, undefined, { id });
      const ids = [];
      for (const [iso, step] of steps) {
        mock.timers.setTime(at(iso));
        ids.push(step(manager, ids));
      }
      return manager;
    };
    const message = (body) => (manager) => manager.appendMessage({ timestamp: Date.now(), ...body });
    const reply = (...args) => (manager) => manager.appendMessage(assistant(...args));

    session(demo, MAIN, [
      ["2026-10-17T09:00:00.000Z", (manager) => manager.appendSessionInfo("Fix the parser")],
      ["2026-10-17T09:00:00.000Z", message({ role: "system", content: "", sections: SECTIONS, toolsAdded: TOOLS })],
      ["2026-10-17T09:00:01.000Z", message({ role: "user", content: "u".repeat(40) })],
      // Pi recorded $0.05.
      [
        "2026-10-17T09:01:00.000Z",
        reply("acme", "recorded", [text("a".repeat(80)), call("c1", "read", { path: "a.ts" }), call("c2", "read", { path: "b.ts" })], usage(1000, 200, 0, 0.05)),
      ],
      ["2026-10-17T09:01:01.000Z", message(result("c1", "read", "r".repeat(120)))],
      ["2026-10-17T09:01:02.000Z", message(result("c2", "read", "r".repeat(40)))],
      // Priced by Pi's built-in catalogue at $3 in, $15 out, $0.30 cache read per million:
      // (2000 × 3 + 100 × 15 + 1000 × 0.3) / 1e6 = $0.0078.
      ["2026-10-17T09:02:00.000Z", reply("anthropic", "claude-sonnet-4-5", [text("b".repeat(40)), call("c3", "bash", { command: "ls" })], usage(2000, 100, 1000))],
      ["2026-10-17T09:02:01.000Z", message(result("c3", "bash", "ok"))],
      // No recorded cost and no price: unknown. Kept by the compaction below: 20 characters, 5 tokens.
      ["2026-10-17T09:03:00.000Z", reply("acme", "mystery", [text("c".repeat(20))], usage(500, 50, 0))],
      ["2026-10-17T09:04:00.000Z", (manager, ids) => manager.appendCompaction("s".repeat(200), ids[8], 3000)],
      // 24 characters: 6 tokens.
      ["2026-10-17T09:05:00.000Z", message({ role: "user", content: "v".repeat(24) })],
      // 60 characters: 15 tokens. (3000 × 3 + 40 × 15) / 1e6 = $0.0096.
      ["2026-10-17T09:06:00.000Z", reply("anthropic", "claude-sonnet-4-5", [text("d".repeat(60))], usage(3000, 40, 0))],
    ]);

    // No system message, an unknown model: 16 + 8 characters, 4 + 2 tokens.
    session(demo, BARE, [
      ["2026-10-16T09:00:00.000Z", message({ role: "user", content: "w".repeat(16) })],
      ["2026-10-16T09:01:00.000Z", reply("acme", "mystery", [text("z".repeat(8))], usage(100, 10, 0))],
    ]);

    // The 300-token model: a 44-character prompt (11 tokens) and 1200 + 28 characters of messages (300 + 7 tokens).
    // (310 × 1 + 7 × 2) / 1e6 = $0.000324.
    session(other, TINY, [
      ["2026-10-15T09:00:00.000Z", message({ role: "system", content: "", sections: { preamble: "q".repeat(44) } })],
      ["2026-10-15T09:00:01.000Z", message({ role: "user", content: "x".repeat(1200) })],
      ["2026-10-15T09:01:00.000Z", reply("tiny", "small", [text("y".repeat(28))], usage(310, 7, 0))],
    ]);

    // Labelled imported in the thread index below: its recorded $0.50 counts as unknown.
    session(other, IMPORTED, [
      ["2026-10-14T09:00:00.000Z", message({ role: "user", content: "Old work" })],
      ["2026-10-14T09:01:00.000Z", reply("acme", "legacy", [text("Done.")], usage(400, 40, 0, 0.5))],
    ]);

    // A millisecond before the default 30 days up to NOW.
    session(other, OLD, [
      ["2026-09-18T09:59:59.000Z", message({ role: "user", content: "Too old" })],
      ["2026-09-18T09:59:59.999Z", reply("acme", "recorded", [text("Done.")], usage(9999, 9999, 0, 9.99))],
    ]);

    // A reply that recorded no usage, then a switch to the 300-token model: 16 + 8 + 12 characters, 4 + 2 + 3 tokens.
    session(demo, SWITCHED, [
      ["2026-08-01T09:00:00.000Z", message({ role: "user", content: "w".repeat(16) })],
      ["2026-08-01T09:01:00.000Z", reply("acme", "mystery", [text("z".repeat(8))], usage(100, 10, 0))],
      ["2026-08-01T09:02:00.000Z", reply("acme", "mystery", [text("n".repeat(12))], undefined)],
      ["2026-08-01T09:03:00.000Z", (manager) => manager.appendModelChange("tiny", "small")],
    ]);

    // No response yet, only a chosen model: 20 characters, 5 tokens.
    session(demo, MODEL_ONLY, [
      ["2026-08-02T09:00:00.000Z", message({ role: "user", content: "m".repeat(20) })],
      ["2026-08-02T09:00:01.000Z", (manager) => manager.appendModelChange("tiny", "small")],
    ]);

    // The prompt is edited after the reply: 4 characters instead of 16, so 1 + 2 tokens.
    session(demo, EDITED, [
      ["2026-08-03T09:00:00.000Z", message({ role: "user", content: "e".repeat(16) })],
      ["2026-08-03T09:01:00.000Z", reply("acme", "mystery", [text("f".repeat(8))], usage(100, 10, 0))],
      ["2026-08-03T09:02:00.000Z", (manager, ids) => manager.appendContextEdit(ids[0], { content: "g".repeat(4) })],
    ]);

    // Bulk session k (1 to 11) cost $0.0k recorded, for 10k input and k output tokens.
    BULK.forEach((id, index) => {
      const k = index + 1;
      const day = `2026-10-${String(k).padStart(2, "0")}`;
      session(k % 2 === 0 ? demo : other, id, [
        [`${day}T08:00:00.000Z`, message({ role: "user", content: `Task ${k}` })],
        [`${day}T08:01:00.000Z`, reply("acme", "recorded", [text("Done.")], usage(10 * k, k, 0, k / 100))],
      ]);
    });
  } finally {
    mock.timers.reset();
  }
  updateThreadRecord(threadIndexPath(agentDir), IMPORTED, { labels: ["imported"] });
});

/** Run a thread command in the demo directory at NOW, with this checkout as the ampi package. */
async function run(args, { root = repoRoot, version } = {}) {
  let out = "";
  let err = "";
  const outcome = await runThreadsCommand(args, {
    pi,
    cwd: demo,
    env: {},
    now: () => NOW,
    columns: 120,
    out: (value) => {
      out += value;
    },
    log: createLogger({
      stderr: (value) => {
        err += value;
      },
    }),
    confirm: async (question) => {
      throw new Error(`unexpected question: ${question}`);
    },
    locateAmpi: async () => ({ root, version }),
  });
  return { result: outcome, out, err };
}

async function json(args) {
  const { result: outcome, out, err } = await run(args);
  assert.deepEqual(outcome, { code: 0 }, err);
  return { report: JSON.parse(out), err };
}

const SECTION_NAMES = {
  "system-prompt": "System prompt",
  "builtin-tools": "Built-in tools",
  "agents-files": "AGENTS.md files",
  "mcp-tools": "MCP tools",
  "loaded-skills": "Loaded skills",
  "compaction-summary": "Compaction summary",
  messages: "Messages",
};
const sections = (rows) => Object.entries(rows).map(([id, [tokens, percentage]]) => ({ id, name: SECTION_NAMES[id], tokens, percentage }));

describe("ampi threads context", () => {
  it("splits the recorded prompt, tools and conversation into sections of the model's window", async () => {
    const { report, err } = await json(["threads", "context", MAIN]);
    assert.equal(err, "");
    assert.deepEqual(report, {
      threadID: MAIN,
      scope: "current-context",
      // The last response's model, which Pi's built-in catalogue knows.
      model: "anthropic/claude-sonnet-4-5",
      modelDisplayName: "Claude Sonnet 4.5 (latest)",
      maxContextTokens: 200000,
      // Shares of 200000: tokens / 2000 percent, to one decimal.
      sections: sections({
        // 857 - 167 - 131 - 97 = 462 characters: 115.5, so 116 tokens; 0.058% rounds up to 0.1.
        "system-prompt": [116, 0.1],
        // read and bash: 74 and 76 characters, 19 + 19.
        "builtin-tools": [38, 0],
        // 167 + 131 = 298 characters: 74.5, so 75.
        "agents-files": [75, 0],
        // The two mcp__ tools: 91 and 87 characters, 23 + 22.
        "mcp-tools": [45, 0],
        // 97 characters: 24.25, so 25.
        "loaded-skills": [25, 0],
        // 200 characters.
        "compaction-summary": [50, 0],
        // After the compaction: the kept reply (5), the prompt (6) and the last reply (15).
        messages: [26, 0],
      }),
      totalTokens: 375,
      freeSpace: 199625,
      compactionCount: 1,
      toolCounts: { builtin: 2, mcp: 2, total: 4 },
      // The last response's 3000 + 40 tokens, with nothing after it.
      measuredTokens: 3040,
    });
  });

  it("leaves the shares and free space out when the window is unknown, and says when no prompt was recorded", async () => {
    // The alias works the same.
    const { report, err } = await json(["threads", "analyze-context", BARE]);
    assert.equal(err, "ampi: the session records no system prompt yet (Pi records it with the first request), so the prompt and tool sections are 0.\n");
    assert.deepEqual(report, {
      threadID: BARE,
      scope: "current-context",
      model: "acme/mystery",
      modelDisplayName: null,
      maxContextTokens: null,
      sections: sections({
        "system-prompt": [0, null],
        "builtin-tools": [0, null],
        "agents-files": [0, null],
        "mcp-tools": [0, null],
        "loaded-skills": [0, null],
        "compaction-summary": [0, null],
        messages: [6, null],
      }),
      totalTokens: 6,
      freeSpace: null,
      compactionCount: 0,
      toolCounts: { builtin: 0, mcp: 0, total: 0 },
      measuredTokens: 110,
      systemPromptRecorded: false,
    });
  });

  it("rounds shares to one decimal and keeps the free space at 0 when the context is over the window", async () => {
    const { report } = await json(["threads", "context", TINY]);
    assert.equal(report.model, "tiny/small");
    assert.equal(report.modelDisplayName, "Tiny Small");
    assert.equal(report.maxContextTokens, 300);
    assert.deepEqual(
      report.sections.filter((section) => section.tokens > 0),
      // 11 / 300 = 3.67% rounds up, 307 / 300 = 102.33% down.
      [
        { id: "system-prompt", name: "System prompt", tokens: 11, percentage: 3.7 },
        { id: "messages", name: "Messages", tokens: 307, percentage: 102.3 },
      ],
    );
    assert.equal(report.totalTokens, 318);
    assert.equal(report.freeSpace, 0);
    assert.equal(report.measuredTokens, 317);
  });

  it("takes the model chosen after the last reply, or before any, and counts replies that recorded no usage", async () => {
    const switched = (await json(["threads", "context", SWITCHED])).report;
    assert.deepEqual(
      {
        model: switched.model,
        modelDisplayName: switched.modelDisplayName,
        maxContextTokens: switched.maxContextTokens,
        messages: switched.sections.at(-1),
        totalTokens: switched.totalTokens,
        freeSpace: switched.freeSpace,
        measuredTokens: switched.measuredTokens,
      },
      {
        model: "tiny/small",
        modelDisplayName: "Tiny Small",
        maxContextTokens: 300,
        // 9 / 300 = 3%.
        messages: { id: "messages", name: "Messages", tokens: 9, percentage: 3 },
        totalTokens: 9,
        freeSpace: 291,
        // The first reply's 100 + 10, and 3 estimated for the reply without usage.
        measuredTokens: 113,
      },
    );

    const chosen = (await json(["threads", "context", MODEL_ONLY])).report;
    assert.deepEqual(
      [chosen.model, chosen.modelDisplayName, chosen.maxContextTokens, chosen.sections.at(-1), chosen.freeSpace, "measuredTokens" in chosen],
      // 5 / 300 = 1.67% rounds up.
      ["tiny/small", "Tiny Small", 300, { id: "messages", name: "Messages", tokens: 5, percentage: 1.7 }, 295, false],
    );
  });

  it("leaves measuredTokens out when the context was edited after the last reply", async () => {
    const { report } = await json(["threads", "context", EDITED]);
    assert.equal(report.model, "acme/mystery");
    assert.equal(report.totalTokens, 3);
    assert.equal("measuredTokens" in report, false);
  });

  it("exits 1 for an unknown id and 2 without one", async () => {
    const missing = await run(["threads", "context", "nosuch"]);
    assert.deepEqual(missing.result, { code: 1 });
    assert.equal(missing.err, "ampi: no session has an id starting with nosuch.\n");
    const none = await run(["threads", "context"]);
    assert.deepEqual(none.result, { code: 2 });
    assert.match(none.err, /threads context takes one session id/);
  });
});

describe("ampi threads usage", () => {
  it("prints the title and the total in the gauge's format, noting models without a price", async () => {
    const { result: outcome, out } = await run(["threads", "usage", MAIN]);
    assert.deepEqual(outcome, { code: 0 });
    // 0.05 + 0.0078 + 0.0096 = 0.0674.
    assert.equal(out, "Fix the parser\nTotal: $0.07, not counting 1 model without a price\n");
  });

  it("adds tokens and cost per model and tool calls per tool with --details", async () => {
    const { out } = await run(["threads", "usage", MAIN, "--details"]);
    assert.equal(
      out,
      [
        "Fix the parser",
        "Total: $0.07, not counting 1 model without a price",
        "",
        "Model                        Input  Output  Cache read  Cache write     Cost",
        "───────────────────────────  ─────  ──────  ──────────  ───────────  ───────",
        "acme/recorded                 1000     200           0            0    $0.05",
        "anthropic/claude-sonnet-4-5   5000     140        1000            0    $0.02",
        "acme/mystery                   500      50           0            0  unknown",
        "",
        "Tool calls:",
        "Tool  Calls",
        "────  ─────",
        "read      2",
        "bash      1",
        "",
      ].join("\n"),
    );
  });

  it("prints JSON, counting entries from --start on and before --end", async () => {
    const whole = (await json(["threads", "usage", MAIN, "--json"])).report;
    assert.deepEqual(whole, {
      threadID: MAIN,
      title: "Fix the parser",
      start: null,
      end: null,
      cost: 0.0674,
      unknownCostModels: 1,
      models: [
        { model: "acme/recorded", cost: 0.05, inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        { model: "anthropic/claude-sonnet-4-5", cost: 0.0174, inputTokens: 5000, outputTokens: 140, cacheReadInputTokens: 1000, cacheCreationInputTokens: 0 },
        { model: "acme/mystery", cost: null, inputTokens: 500, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      ],
      toolCalls: { read: 2, bash: 1 },
    });

    // The reply at exactly 09:02 is in; the one at exactly 09:06 is out.
    const ranged = (await json(["threads", "usage", MAIN, "--json", "--start", "2026-10-17T09:02:00Z", "--end", "2026-10-17T09:06:00Z"])).report;
    assert.deepEqual(ranged, {
      threadID: MAIN,
      title: "Fix the parser",
      start: "2026-10-17T09:02:00.000Z",
      end: "2026-10-17T09:06:00.000Z",
      cost: 0.0078,
      unknownCostModels: 1,
      models: [
        { model: "anthropic/claude-sonnet-4-5", cost: 0.0078, inputTokens: 2000, outputTokens: 100, cacheReadInputTokens: 1000, cacheCreationInputTokens: 0 },
        { model: "acme/mystery", cost: null, inputTokens: 500, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      ],
      toolCalls: { bash: 1 },
    });

    // Only unknown models: the total is unknown too.
    const bare = (await json(["threads", "usage", BARE, "--json"])).report;
    assert.equal(bare.cost, null);
    assert.equal((await run(["threads", "usage", BARE])).out, `${"w".repeat(16)}\nTotal: unknown (no model has a price)\n`);
  });

  it("exits 2 on a malformed time or a start after the end, and 1 for an unknown id", async () => {
    for (const [args, message] of [
      [["--start", "yesterday"], "--start needs an ISO 8601 time such as 2026-10-01 or 2026-10-01T09:30:00Z, not yesterday."],
      [["--end", "2026-13-01"], "--end needs an ISO 8601 time such as 2026-10-01 or 2026-10-01T09:30:00Z, not 2026-13-01."],
      [["--start", "2026-10-17T10:00:00Z", "--end", "2026-10-17T09:00:00Z"], "--start is after --end."],
      // Not a day of the calendar, though Date.parse would take it for 2 March.
      [["--start", "2026-02-30", "--end", "2026-03-01"], "--start needs an ISO 8601 time such as 2026-10-01 or 2026-10-01T09:30:00Z, not 2026-02-30."],
    ]) {
      const { result: outcome, err } = await run(["threads", "usage", MAIN, ...args]);
      assert.deepEqual(outcome, { code: 2 }, args.join(" "));
      assert.equal(err, `ampi: ${message}\nRun ampi threads --help for the thread commands.\n`);
    }
    assert.deepEqual((await run(["threads", "usage", "nosuch"])).result, { code: 1 });
  });
});

describe("ampi usage", () => {
  it("totals every directory's sessions over the 30 days up to now, counting imported sessions as unknown", async () => {
    const { report } = await json(["usage", "--json"]);
    const byModel = Object.fromEntries(report.models.map(({ model, ...rest }) => [model, rest]));
    assert.deepEqual(byModel, {
      // MAIN's 1000 in, 200 out, $0.05, and the bulk sessions' 10 × 66 in, 66 out, $0.66.
      "acme/recorded": { cost: 0.71, inputTokens: 1660, outputTokens: 266, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      "anthropic/claude-sonnet-4-5": { cost: 0.0174, inputTokens: 5000, outputTokens: 140, cacheReadInputTokens: 1000, cacheCreationInputTokens: 0 },
      // MAIN's 500 and 50, BARE's 100 and 10.
      "acme/mystery": { cost: null, inputTokens: 600, outputTokens: 60, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      "tiny/small": { cost: 0.000324, inputTokens: 310, outputTokens: 7, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      "acme/legacy": { cost: null, inputTokens: 400, outputTokens: 40, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });
    const { models, sessions, ...totals } = report;
    assert.deepEqual(totals, {
      start: "2026-09-18T10:00:00.000Z",
      end: "2026-10-18T10:00:00.000Z",
      // 0.71 + 0.0174 + 0.000324.
      cost: 0.727724,
      unknownCostModels: 2,
      // MAIN, BARE, TINY, IMPORTED and the 11 bulk sessions; OLD is a millisecond too early.
      sessionCount: 15,
      inputTokens: 7970,
      outputTokens: 513,
      cacheReadInputTokens: 1000,
      cacheCreationInputTokens: 0,
    });
    assert.deepEqual(
      sessions.map((session) => [session.threadID, session.cost]),
      [
        [BULK[10], 0.11],
        [BULK[9], 0.1],
        [BULK[8], 0.09],
        [BULK[7], 0.08],
        [BULK[6], 0.07],
        [MAIN, 0.0674],
        [BULK[5], 0.06],
        [BULK[4], 0.05],
        [BULK[3], 0.04],
        [BULK[2], 0.03],
        [BULK[1], 0.02],
        [BULK[0], 0.01],
        [TINY, 0.000324],
        [BARE, null],
        [IMPORTED, null],
      ],
    );
    assert.deepEqual(sessions[5], { threadID: MAIN, title: "Fix the parser", cwd: demo, cost: 0.0674 });
  });

  it("prints the range, total, session count and tokens, and the ten most expensive sessions with --details", async () => {
    const { result: outcome, out } = await run(["usage", "--details", "--start", "2026-10-15", "--end", "2026-10-17T09:06:00Z"]);
    assert.deepEqual(outcome, { code: 0 });
    const lines = out.split("\n");
    assert.deepEqual(lines.slice(0, 5), [
      "Usage from 2026-10-15T00:00:00.000Z until 2026-10-17T09:06:00.000Z",
      // MAIN without its last reply (0.05 + 0.0078), TINY 0.000324, BARE unknown.
      "Total: $0.06, not counting 1 model without a price",
      "Sessions: 3",
      "Tokens: 3910 input, 367 output, 1000 cache read, 0 cache write",
      "ampi keeps no account and no credits: these costs are what the providers reported, or the tokens at the models' list prices where they reported none.",
    ]);
    const top = lines.slice(lines.indexOf("Most expensive sessions:") + 3).filter(Boolean);
    assert.deepEqual(
      top.map((line) => line.split(/\s{2,}/)),
      [
        [MAIN, "Fix the parser", "$0.06", demo],
        [TINY, "x".repeat(39) + "…", "$0.000", other],
        [BARE, "w".repeat(16), "unknown", demo],
      ],
    );

    const all = (await run(["usage", "--details"])).out.split("\n");
    const ranked = all.slice(all.indexOf("Most expensive sessions:") + 3).filter(Boolean);
    assert.equal(ranked.length, 10);
    assert.deepEqual(
      ranked.map((line) => line.split(/\s{2,}/)[0]),
      [BULK[10], BULK[9], BULK[8], BULK[7], BULK[6], MAIN, BULK[5], BULK[4], BULK[3], BULK[2]],
    );
  });

  it("defaults the start to 30 days before --end, and refuses arguments and bad times", async () => {
    const { report } = await json(["usage", "--json", "--end", "2026-10-12T00:00:00Z"]);
    assert.equal(report.start, "2026-09-12T00:00:00.000Z");
    // OLD's reply at 09:59:59.999 on 18 September, and bulk sessions 1 to 11.
    assert.equal(report.sessionCount, 12);

    assert.deepEqual((await run(["usage", "--start", "2026-10-18T11:00:00Z"])).result, { code: 2 }, "a start after the default end");
    assert.deepEqual((await run(["usage", "--start", "10/01/2026"])).result, { code: 2 });
    assert.deepEqual((await run(["usage", MAIN])).result, { code: 2 });
    assert.deepEqual((await run(["usage", "--frobnicate"])).result, { code: 2 });
  });
});

describe("ampi threads context and usage: packages and the command line", () => {
  it("says an ampi package without the reports is too old, and exits 1", async () => {
    const stub = path.join(temporary, "old-ampi");
    mkdirSync(path.join(stub, "src"), { recursive: true });
    // An entry from before the reports: it hands over the search only.
    writeFileSync(path.join(stub, "src", "cli-threads.ts"), 'export default function (pi) { pi.events.emit("ampi:cli-threads", { searchThreads: async () => ({}) }); }\n');
    for (const [args, command] of [
      [["threads", "context", MAIN], "threads context"],
      [["threads", "usage", MAIN], "threads usage"],
      [["usage"], "usage"],
    ]) {
      const { result: outcome, out, err } = await run(args, { root: stub, version: "0.0.1" });
      assert.deepEqual(outcome, { code: 1 });
      assert.equal(out, "");
      assert.equal(err, `ampi: ampi 0.0.1 is too old for ${command}; update @skippermissions/ampi (or ampi-cli).\n`);
    }
  });

  it("lists the commands in the thread help", () => {
    assert.match(formatThreadsHelp(), /^ {2}context, analyze-context <id>/m);
    assert.match(formatThreadsHelp(), /^ {2}usage <id>/m);
    assert.match(formatThreadsHelp(), /^ {2}ampi usage/m);
  });

  it("runs from the executable with exit codes 0 and 2", () => {
    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", HOME: temporary };
    delete env.PI_CODING_AGENT_SESSION_DIR;
    const spawn = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd: demo, env, encoding: "utf8" });
    const ok = spawn("usage", "--json", "--start", "2026-10-17", "--end", "2026-10-18");
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).sessionCount, 1);
    const context = spawn("threads", "context", MAIN);
    assert.equal(context.status, 0, context.stderr);
    assert.equal(JSON.parse(context.stdout).totalTokens, 375);
    assert.equal(spawn("usage", "--end", "soon").status, 2);
  });
});
