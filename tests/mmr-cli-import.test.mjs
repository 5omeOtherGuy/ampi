// `ampi threads import` (packages/ampi-cli/src/import/): detect with the
// environment overrides, the conversion of hand-written Claude Code sessions
// (tests/fixtures/ampi-cli/import/claude) into hand-written Pi messages, and
// the import itself against a temporary agent directory on a fixed clock:
// the --all age boundary, --limit, the import record and --reimport,
// --dry-run, the JSON lines and the exit codes. The imported session is then
// opened through Pi and read with threads list and threads markdown, and an
// execute run in it fails with the read-only notice.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it, mock } from "node:test";
import * as pi from "@earendil-works/pi-coding-agent";
import { convertClaudeCodeSession } from "../packages/ampi-cli/src/import/claude-code.js";
import { formatImportHelp } from "../packages/ampi-cli/src/import/index.js";
import { formatThreadsHelp, runThreadsCommand } from "../packages/ampi-cli/src/threads.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const bin = path.join(repoRoot, "packages", "ampi-cli", "bin", "ampi.js");
const fauxModel = path.join(import.meta.dirname, "fixtures", "ampi-cli", "faux-model");
const fixtures = path.join(import.meta.dirname, "fixtures", "ampi-cli", "import", "claude");

const NOW = Date.parse("2026-10-18T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const DEMO = "5b1f0c2e-7d3a-4c8b-9e1f-2a3b4c5d6e7f";
const OTHER = "9c8d7e6f-5a4b-4c3d-8e2f-1a0b9c8d7e6f";
const IMAGE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const NOTICE =
  "This session was imported from another coding agent and is read-only. To continue the work, start a new session and mention this one with @@, or ask the agent to use find_session and read_session.";

const at = (iso) => Date.parse(iso);
const usage = (input, output, cacheRead, cacheWrite, totalTokens) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const assistant = (content, model, iso, tokens, stopReason) => ({
  role: "assistant",
  content,
  api: "imported",
  provider: "claude-code-import",
  model,
  timestamp: at(iso),
  usage: tokens,
  stopReason,
});

/** The fixture session in /work/demo as Pi messages, written out by hand. */
const DEMO_MESSAGES = [
  {
    role: "user",
    content: [
      { type: "text", text: "The parser crashes on an empty file. Here are two screenshots." },
      { type: "image", data: IMAGE, mimeType: "image/png" },
      { type: "text", text: "(image)" },
    ],
    timestamp: at("2026-10-10T09:00:05.000Z"),
  },
  assistant(
    [
      { type: "thinking", thinking: "An empty file yields no tokens." },
      { type: "text", text: "Let me read the parser." },
      { type: "toolCall", id: "toolu_01", name: "Read", arguments: { file_path: "/work/demo/src/parser.ts" } },
    ],
    "claude-sonnet-4-5",
    "2026-10-10T09:00:10.000Z",
    usage(120, 45, 0, 900, 1065),
    "toolUse",
  ),
  {
    role: "toolResult",
    toolCallId: "toolu_01",
    toolName: "Read",
    content: [{ type: "text", text: "export function parse(text) { return text.split(' ')[0].trim(); }" }],
    isError: false,
    timestamp: at("2026-10-10T09:00:13.000Z"),
  },
  assistant(
    [{ type: "toolCall", id: "toolu_02", name: "Bash", arguments: { command: "npm test" } }],
    "claude-sonnet-4-5",
    "2026-10-10T09:00:20.000Z",
    usage(300, 15, 900, 0, 1215),
    "toolUse",
  ),
  {
    role: "toolResult",
    toolCallId: "toolu_02",
    toolName: "Bash",
    content: [{ type: "text", text: "1 test failed: parse('') threw" }],
    isError: true,
    timestamp: at("2026-10-10T09:00:30.000Z"),
  },
  assistant(
    [{ type: "text", text: "The test fails because an empty file has no first word. Guard it with an early return." }],
    "claude-sonnet-4-5",
    "2026-10-10T09:00:40.000Z",
    usage(340, 30, 900, 0, 1270),
    "stop",
  ),
];

const OTHER_MESSAGES = [
  { role: "user", content: "Port the docs to the new site", timestamp: at("2026-09-01T12:00:00.000Z") },
  assistant([{ type: "text", text: "Ported the docs." }], "claude-opus-4-1", "2026-09-01T12:00:09.000Z", usage(40, 6, 0, 0, 46), "stop"),
];

const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const savedSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
const temporary = mkdtempSync(path.join(tmpdir(), "ampi-cli-import-"));
after(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  if (savedSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
  else process.env.PI_CODING_AGENT_SESSION_DIR = savedSessionDir;
  rmSync(temporary, { recursive: true, force: true });
});

let setups = 0;
/**
 * A home, an agent directory Pi is pointed at, and a copy of the fixture
 * sessions in a Claude Code directory: the /work/demo session changed exactly
 * 30 days before NOW, the /work/other one a second earlier.
 */
function setup() {
  const root = path.join(temporary, String(++setups));
  const home = path.join(root, "home");
  const agentDir = path.join(root, "agent");
  const claudeDir = path.join(root, "claude");
  mkdirSync(home, { recursive: true });
  cpSync(fixtures, claudeDir, { recursive: true });
  const demoFile = path.join(claudeDir, "projects", "-work-demo", `${DEMO}.jsonl`);
  const otherFile = path.join(claudeDir, "projects", "-work-other", `${OTHER}.jsonl`);
  utimesSync(demoFile, new Date(NOW - 30 * DAY), new Date(NOW - 30 * DAY));
  utimesSync(otherFile, new Date(NOW - 30 * DAY - 1000), new Date(NOW - 30 * DAY - 1000));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  const ledger = () => JSON.parse(readFileSync(path.join(agentDir, "data", "ampi", "imports.json"), "utf8"));
  const sessionFiles = () => {
    const sessions = path.join(agentDir, "sessions");
    if (!existsSync(sessions)) return [];
    return readdirSync(sessions).flatMap((folder) => readdirSync(path.join(sessions, folder)).map((name) => path.join(sessions, folder, name)));
  };
  return { root, home, agentDir, claudeDir, demoFile, otherFile, ledger, sessionFiles };
}

/** Run a thread command at `time` (Pi's clock too), collecting its output. */
async function run(args, { env = {}, time = NOW, cwd = "/work/demo" } = {}) {
  let out = "";
  let err = "";
  mock.timers.enable({ apis: ["Date"], now: time });
  try {
    const result = await runThreadsCommand(args, {
      pi,
      cwd,
      env,
      now: () => Date.now(),
      columns: 200,
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
      confirm: async () => false,
      locateAmpi: async () => ({ root: repoRoot }),
    });
    return { result, out, err };
  } finally {
    mock.timers.reset();
  }
}

/** `ampi threads import claude …` with the fixture copy as --claude-dir. */
const importClaude = (t, args, options) => run(["threads", "import", "claude", ...args, "--claude-dir", t.claudeDir], options);
const jsonLines = (text) => text.trim().split("\n").map((line) => JSON.parse(line));

describe("Claude Code sessions as Pi messages", () => {
  it("keeps text, images, thinking, tool calls and results with their times, and skips sidechain, meta and bookkeeping entries", () => {
    assert.deepEqual(convertClaudeCodeSession(readFileSync(path.join(fixtures, "projects", "-work-demo", `${DEMO}.jsonl`), "utf8")), {
      cwd: "/work/demo",
      title: "Fix the parser crash on empty files",
      started: at("2026-10-10T09:00:05.000Z"),
      messages: DEMO_MESSAGES,
    });
    assert.deepEqual(convertClaudeCodeSession(readFileSync(path.join(fixtures, "projects", "-work-other", `${OTHER}.jsonl`), "utf8")), {
      cwd: "/work/other",
      title: undefined,
      started: at("2026-09-01T12:00:00.000Z"),
      messages: OTHER_MESSAGES,
    });
  });

  it("counts the tokens of an assistant message split around tool results once, on its latest part", () => {
    const line = (entry) => JSON.stringify(entry);
    const part = (iso, content, outputTokens) =>
      line({
        type: "assistant",
        cwd: "/w",
        timestamp: iso,
        message: { id: "msg_7", role: "assistant", model: "claude-sonnet-4-5", content, usage: { input_tokens: 100, output_tokens: outputTokens } },
      });
    const result = (iso, id) =>
      line({ type: "user", cwd: "/w", timestamp: iso, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
    const text = [
      line({ type: "user", cwd: "/w", timestamp: "2026-10-01T00:00:00.000Z", message: { role: "user", content: "Check both files" } }),
      part("2026-10-01T00:00:01.000Z", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } }], 10),
      result("2026-10-01T00:00:02.000Z", "t1"),
      part("2026-10-01T00:00:03.000Z", [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "b.ts" } }], 25),
      result("2026-10-01T00:00:04.000Z", "t2"),
    ].join("\n");
    const call = (id, file) => ({ type: "toolCall", id, name: "Read", arguments: { file_path: file } });
    const toolResult = (id, iso) => ({ role: "toolResult", toolCallId: id, toolName: "Read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: at(iso) });
    assert.deepEqual(convertClaudeCodeSession(text).messages, [
      { role: "user", content: "Check both files", timestamp: at("2026-10-01T00:00:00.000Z") },
      assistant([call("t1", "a.ts")], "claude-sonnet-4-5", "2026-10-01T00:00:01.000Z", usage(0, 0, 0, 0, 0), "toolUse"),
      toolResult("t1", "2026-10-01T00:00:02.000Z"),
      assistant([call("t2", "b.ts")], "claude-sonnet-4-5", "2026-10-01T00:00:03.000Z", usage(100, 25, 0, 0, 125), "toolUse"),
      toolResult("t2", "2026-10-01T00:00:04.000Z"),
    ]);
  });

  it("prefers a title the user set over a generated one or a summary", () => {
    const line = (entry) => JSON.stringify(entry);
    const text = [
      line({ type: "summary", summary: "A summary" }),
      line({ type: "custom-title", customTitle: "My title" }),
      line({ type: "ai-title", aiTitle: "A generated title" }),
      line({ type: "user", cwd: "/w", timestamp: "2026-10-01T00:00:00.000Z", message: { role: "user", content: "hello" } }),
    ].join("\n");
    assert.equal(convertClaudeCodeSession(text).title, "My title");
  });
});

describe("ampi threads import detect", () => {
  it("reports each agent's data location from the environment overrides, and whether it exists", async () => {
    const t = setup();
    const xdg = path.join(t.root, "xdg");
    mkdirSync(path.join(xdg, "opencode"), { recursive: true });
    const env = { HOME: t.home, CLAUDE_CONFIG_DIR: t.claudeDir, CODEX_HOME: path.join(t.root, "codex"), XDG_DATA_HOME: xdg };
    const json = await run(["threads", "import", "detect", "--json"], { env });
    assert.equal(json.result.code, 0);
    assert.deepEqual(JSON.parse(json.out), {
      agents: [
        { agent: "claude-code", path: path.join(t.claudeDir, "projects"), found: true },
        { agent: "codex", path: path.join(t.root, "codex", "sessions"), found: false },
        { agent: "opencode", path: path.join(xdg, "opencode"), found: true },
      ],
    });
    const text = await run(["threads", "import", "detect"], { env: { HOME: t.home } });
    assert.equal(
      text.out,
      [
        "Agent        Found    Path",
        `claude-code  missing  ${path.join(t.home, ".claude", "projects")}`,
        `codex        missing  ${path.join(t.home, ".codex", "sessions")}`,
        `opencode     missing  ${path.join(t.home, ".local", "share", "opencode")}`,
        "",
      ].join("\n"),
    );
  });

  it("refuses codex and opencode, which are not supported yet, and other usage errors with exit 2", async () => {
    const t = setup();
    const cases = [
      [["codex", "--all"], "threads import codex is not supported yet."],
      [["opencode"], "threads import opencode is not supported yet."],
      [["claude"], "threads import claude needs session ids or --all."],
      [["claude", DEMO, "--all"], "threads import claude takes session ids or --all, not both."],
      [["claude", DEMO, "--limit", "1"], "--limit works only with --all."],
      [["claude", "--all", "--max-age", "7.5"], "--max-age needs a whole number of days, not 7.5."],
      [["claude", "--all", "--limit", "0"], "--limit needs a whole number above 0, not 0."],
      [["claude", "../escape"], '"../escape" is not a Claude Code session id: give the session file\'s name without .jsonl.'],
      [["gemini"], "unknown import command gemini."],
    ];
    for (const [args, message] of cases) {
      const { result, out, err } = await run(["threads", "import", ...args], { env: { HOME: t.home } });
      assert.equal(result.code, 2, args.join(" "));
      assert.equal(out, "");
      assert.equal(err, `ampi: ${message}\nRun ampi threads import --help for the agents and options.\n`);
    }
    assert.deepEqual(t.sessionFiles(), []);
  });

  it("prints its help, and threads --help names it", async () => {
    const { result, out } = await run(["threads", "import", "claude", "--help"]);
    assert.equal(result.code, 0);
    assert.equal(out, formatImportHelp());
    assert.match(formatThreadsHelp(), /^ {2}import detect\|claude {10}Copy other coding agents' conversations/m);
  });
});

describe("ampi threads import claude", () => {
  it("imports every session updated within --max-age days, the boundary included, newest first", async () => {
    const t = setup();
    const first = await importClaude(t, ["--all"]);
    assert.equal(first.result.code, 0, first.err);
    const demo = t.ledger().imports[`claude-code:${DEMO}`];
    assert.equal(first.out, `Imported ${DEMO} as ${demo.sessionId} (6 messages)\nClaude Code: 1 imported, 0 skipped, 0 failed.\n`);
    assert.equal(t.ledger().imports[`claude-code:${OTHER}`], undefined, "a second older than 30 days is left out");

    const all = await importClaude(t, ["--all", "--max-age", "0", "--json"]);
    assert.equal(all.result.code, 0, all.err);
    const other = t.ledger().imports[`claude-code:${OTHER}`];
    assert.deepEqual(jsonLines(all.out), [
      {
        type: "skipped",
        agent: "claude-code",
        sourceId: DEMO,
        sessionId: demo.sessionId,
        reason: `already imported as ${demo.sessionId}; --reimport imports it again`,
      },
      { type: "imported", agent: "claude-code", sourceId: OTHER, sessionId: other.sessionId, messages: 2 },
      { type: "summary", agent: "claude-code", imported: 1, skipped: 1, failed: 0 },
    ]);
    assert.equal(t.sessionFiles().length, 2);
  });

  it("stops after --limit sessions", async () => {
    const t = setup();
    const { result, out } = await importClaude(t, ["--all", "--max-age", "0", "--limit", "1", "--json"]);
    assert.equal(result.code, 0);
    const demo = t.ledger().imports[`claude-code:${DEMO}`];
    assert.deepEqual(jsonLines(out), [
      { type: "imported", agent: "claude-code", sourceId: DEMO, sessionId: demo.sessionId, messages: 6 },
      { type: "summary", agent: "claude-code", imported: 1, skipped: 0, failed: 0 },
    ]);
  });

  it("writes one Pi session per conversation in its directory, with the import entry, the title, the messages, labels and a record", async () => {
    const t = setup();
    const { result } = await importClaude(t, [DEMO, OTHER]);
    assert.equal(result.code, 0);
    const record = t.ledger().imports[`claude-code:${DEMO}`];
    assert.deepEqual(record, {
      sessionId: record.sessionId,
      sessionPath: path.join(t.agentDir, "sessions", "--work-demo--", `2026-10-18T10-00-00-000Z_${record.sessionId}.jsonl`),
      importedAt: "2026-10-18T10:00:00.000Z",
      sourceModified: new Date(NOW - 30 * DAY).toISOString(),
    });

    const entries = readFileSync(record.sessionPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const [header, ...rest] = entries;
    assert.deepEqual(header, { type: "session", version: 3, id: record.sessionId, timestamp: "2026-10-18T10:00:00.000Z", cwd: "/work/demo" });
    assert.deepEqual(
      rest.map((entry) => entry.parentId),
      [null, ...rest.slice(0, -1).map((entry) => entry.id)],
      "one chain, in order",
    );
    assert.deepEqual(
      rest.map(({ id, parentId, timestamp, ...entry }) => entry),
      [
        {
          type: "custom",
          customType: "ampi-import",
          data: {
            agent: "claude-code",
            sourceId: DEMO,
            sourcePath: t.demoFile,
            sourceModified: new Date(NOW - 30 * DAY).toISOString(),
            sourceStarted: "2026-10-10T09:00:05.000Z",
            importedAt: "2026-10-18T10:00:00.000Z",
            formatVersion: 1,
          },
        },
        { type: "session_info", name: "Fix the parser crash on empty files" },
        ...DEMO_MESSAGES.map((message) => ({ type: "message", message })),
      ],
    );

    // Pi opens it and builds the context the model would see.
    const manager = pi.SessionManager.open(record.sessionPath);
    assert.equal(manager.getSessionName(), "Fix the parser crash on empty files");
    assert.deepEqual(manager.buildSessionContext().messages, DEMO_MESSAGES);

    const listed = jsonLines((await run(["threads", "list", "--all", "--json"])).out);
    const other = t.ledger().imports[`claude-code:${OTHER}`];
    assert.deepEqual(
      listed.map(({ id, title, labels, cwd, updated }) => ({ id, title, labels, cwd, updated })),
      [
        { id: record.sessionId, title: "Fix the parser crash on empty files", labels: ["imported", "claude-code"], cwd: "/work/demo", updated: "2026-10-10T09:00:40.000Z" },
        { id: other.sessionId, title: "Port the docs to the new site", labels: ["imported", "claude-code"], cwd: "/work/other", updated: "2026-09-01T12:00:09.000Z" },
      ],
    );

    const markdown = await run(["threads", "markdown", record.sessionId]);
    assert.equal(markdown.result.code, 0);
    assert.equal(
      markdown.out,
      [
        "---",
        'title: "Fix the parser crash on empty files"',
        `sessionId: "${record.sessionId}"`,
        'created: "2026-10-18T10:00:00.000Z"',
        "---",
        "",
        "# Fix the parser crash on empty files",
        "",
        "## User",
        "",
        "The parser crashes on an empty file. Here are two screenshots.",
        "",
        "(image)",
        "",
        "(image)",
        "",
        "## Assistant",
        "",
        "Let me read the parser.",
        "",
        "**Tool Use:** `Read`",
        "",
        "```json",
        "{",
        '  "file_path": "/work/demo/src/parser.ts"',
        "}",
        "```",
        "",
        "**Tool Result:** `toolu_01`",
        "",
        "```",
        "export function parse(text) { return text.split(' ')[0].trim(); }",
        "```",
        "",
        "**Tool Use:** `Bash`",
        "",
        "```json",
        "{",
        '  "command": "npm test"',
        "}",
        "```",
        "",
        "**Tool Result:** `toolu_02` (error)",
        "",
        "```",
        "1 test failed: parse('') threw",
        "```",
        "",
        "The test fails because an empty file has no first word. Guard it with an early return.",
        "",
      ].join("\n"),
    );

    // The tokens count; the cost is unknown, not zero.
    const report = JSON.parse((await run(["threads", "usage", record.sessionId, "--json"])).out);
    assert.equal(report.cost, null);
    assert.deepEqual(report.models, [
      {
        model: "claude-code-import/claude-sonnet-4-5",
        cost: null,
        inputTokens: 760,
        outputTokens: 90,
        cacheReadInputTokens: 1800,
        cacheCreationInputTokens: 900,
      },
    ]);
  });

  it("skips what it imported before, imports it again under the same id with --reimport, and forgets records of deleted sessions", async () => {
    const t = setup();
    await importClaude(t, [DEMO]);
    const first = t.ledger().imports[`claude-code:${DEMO}`];

    const again = await importClaude(t, [DEMO]);
    assert.equal(again.result.code, 0);
    assert.equal(again.out, `Skipped ${DEMO}: already imported as ${first.sessionId}; --reimport imports it again\nClaude Code: 0 imported, 1 skipped, 0 failed.\n`);

    const later = NOW + 60_000;
    const reimported = await importClaude(t, [DEMO, "--reimport"], { time: later });
    assert.equal(reimported.result.code, 0);
    const second = t.ledger().imports[`claude-code:${DEMO}`];
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.importedAt, new Date(later).toISOString());
    assert.notEqual(second.sessionPath, first.sessionPath);
    assert.deepEqual(t.sessionFiles(), [second.sessionPath], "the old file is gone once the new one is written");
    assert.equal(JSON.parse(readFileSync(second.sessionPath, "utf8").split("\n")[0]).id, first.sessionId);

    unlinkSync(second.sessionPath);
    const restored = await importClaude(t, [DEMO]);
    assert.equal(restored.result.code, 0);
    const third = t.ledger().imports[`claude-code:${DEMO}`];
    assert.match(restored.out, new RegExp(`^Imported ${DEMO} as ${third.sessionId} \\(6 messages\\)\n`));
    assert.ok(existsSync(third.sessionPath));
  });

  it("converts and counts with --dry-run, and writes nothing", async () => {
    const t = setup();
    const text = await importClaude(t, ["--all", "--max-age", "0", "--dry-run"]);
    assert.equal(text.result.code, 0);
    assert.equal(
      text.out,
      [
        `Would import ${DEMO} (6 messages)`,
        `Would import ${OTHER} (2 messages)`,
        "Claude Code: 2 to import, 0 skipped, 0 failed. Nothing was written (--dry-run).",
        "",
      ].join("\n"),
    );
    const json = await importClaude(t, [OTHER, "--dry-run", "--json"]);
    assert.deepEqual(jsonLines(json.out), [
      { type: "imported", agent: "claude-code", sourceId: OTHER, messages: 2 },
      { type: "summary", agent: "claude-code", imported: 1, skipped: 0, failed: 0, dryRun: true },
    ]);
    assert.equal(existsSync(t.agentDir), false, "no session, record or thread index");
  });

  it("exits 1 for an id no session has, after importing the others", async () => {
    const t = setup();
    const missing = "00000000-0000-4000-8000-000000000000";
    const { result, out } = await importClaude(t, [missing, OTHER, "--json"]);
    assert.equal(result.code, 1);
    const other = t.ledger().imports[`claude-code:${OTHER}`];
    assert.deepEqual(jsonLines(out), [
      { type: "failed", agent: "claude-code", sourceId: missing, reason: `no Claude Code session has this id in ${path.join(t.claudeDir, "projects")}` },
      { type: "imported", agent: "claude-code", sourceId: OTHER, sessionId: other.sessionId, messages: 2 },
      { type: "summary", agent: "claude-code", imported: 1, skipped: 0, failed: 1 },
    ]);
  });

  it("finds sessions in $CLAUDE_CONFIG_DIR without --claude-dir", async () => {
    const t = setup();
    const { result } = await run(["threads", "import", "claude-code", OTHER], { env: { HOME: t.home, CLAUDE_CONFIG_DIR: t.claudeDir } });
    assert.equal(result.code, 0);
    assert.ok(t.ledger().imports[`claude-code:${OTHER}`]);
  });
});

describe("an execute run in an imported session", () => {
  it("sends nothing, prints the read-only notice on stderr and exits 1", async () => {
    const t = setup();
    const project = path.join(t.root, "project");
    mkdirSync(project);
    // A conversation that ran in a directory this test owns, so Pi finds its session by id there.
    const claudeDir = path.join(t.root, "claude-project");
    const file = path.join(claudeDir, "projects", "-project", "1a2b3c4d-0000-4000-8000-000000000001.jsonl");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      [
        { type: "user", cwd: project, timestamp: "2026-10-17T08:00:00.000Z", message: { role: "user", content: "Summarize the README" } },
        { type: "assistant", cwd: project, timestamp: "2026-10-17T08:00:05.000Z", message: { id: "m1", role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "It explains the install." }] } },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    await run(["threads", "import", "claude", "1a2b3c4d-0000-4000-8000-000000000001", "--claude-dir", claudeDir]);
    const { sessionId, sessionPath } = t.ledger().imports["claude-code:1a2b3c4d-0000-4000-8000-000000000001"];
    // Pi records the model and thinking level it starts with; no message may follow.
    const messages = () =>
      readFileSync(sessionPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.type === "message");
    const before = messages();

    const child = spawn(process.execPath, [bin, "-e", fauxModel, "--model", "faux/faux-1", "-x", "--session-id", sessionId, "hi"], {
      cwd: project,
      env: { PATH: process.env.PATH, HOME: t.home, PI_CODING_AGENT_DIR: t.agentDir, PI_OFFLINE: "1" },
    });
    child.stdin.end();
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const status = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(status, 1, stderr);
    assert.ok(stderr.includes(`ampi: ${NOTICE}\n`), stderr);
    assert.deepEqual(messages(), before, "no message was added");
  });
});
