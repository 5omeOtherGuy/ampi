// `ampi threads import` (packages/ampi-cli/src/import/): detect with the
// environment overrides, the conversion of hand-written Claude Code and Codex
// sessions and OpenCode JSON storage (tests/fixtures/ampi-cli/import), and of
// an OpenCode database built here, into hand-written Pi messages, and the
// import itself against a temporary agent directory on a fixed clock: the
// --all age boundary, --limit, the import record and --reimport, --dry-run,
// the JSON lines and the exit codes, and OpenCode without node:sqlite. The
// imported sessions are then opened through Pi and read with threads list
// and threads markdown, and an execute run in one fails with the read-only
// notice.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it, mock } from "node:test";
import * as pi from "@earendil-works/pi-coding-agent";
import { convertClaudeCodeSession } from "../packages/ampi-cli/src/import/claude-code.js";
import { convertCodexSession } from "../packages/ampi-cli/src/import/codex.js";
import { formatImportHelp } from "../packages/ampi-cli/src/import/index.js";
import { convertOpenCodeSession, loadNodeSqlite, openOpenCode } from "../packages/ampi-cli/src/import/opencode.js";
import { createLogger } from "../packages/ampi-cli/src/log.js";
import { formatThreadsHelp, runThreadsCommand } from "../packages/ampi-cli/src/threads.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const bin = path.join(repoRoot, "packages", "ampi-cli", "bin", "ampi.js");
const fauxModel = path.join(import.meta.dirname, "fixtures", "ampi-cli", "faux-model");
const fixtures = path.join(import.meta.dirname, "fixtures", "ampi-cli", "import", "claude");
const codexFixtures = path.join(import.meta.dirname, "fixtures", "ampi-cli", "import", "codex");
const openCodeFixtures = path.join(import.meta.dirname, "fixtures", "ampi-cli", "import", "opencode");

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
const replyOf = (provider) => (content, model, iso, tokens, stopReason) => ({
  role: "assistant",
  content,
  api: "imported",
  provider,
  model,
  timestamp: at(iso),
  usage: tokens,
  stopReason,
});
const assistant = replyOf("claude-code-import");
const codexReply = replyOf("codex-import");
const openCodeReply = replyOf("opencode-import");
const NO_USAGE = usage(0, 0, 0, 0, 0);
const toolResult = (toolCallId, toolName, content, iso, isError = false) => ({ role: "toolResult", toolCallId, toolName, content, isError, timestamp: at(iso) });
const text = (value) => ({ type: "text", text: value });
const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });

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

const CODEX_DEMO = "0199d2a4-6b1c-7e3f-9a50-2c4d6e8f0a1b";
const CODEX_OTHER = "0199a0b1-c2d3-7e4f-8a9b-0c1d2e3f4a5b";
/** A review Codex ran as a helper agent, a day before NOW. */
const CODEX_REVIEW = "0199e8f0-1a2b-7c3d-8e4f-5a6b7c8d9e0f";
const PATCH = "*** Begin Patch\n*** Update File: src/health.ts\n@@\n-  return config.get('db');\n+  return config.get('db') ?? 'ok';\n*** End Patch\n";

/**
 * The Codex fixture in /work/api as Pi messages: the developer message and
 * the environment and AGENTS.md blocks are gone, the encrypted reasoning too,
 * and the first turn's tokens (it records its start, end and counts) sit on
 * its last reply; the second turn never ends, so its tokens are left out.
 */
const CODEX_DEMO_MESSAGES = [
  {
    role: "user",
    content: [text("Why does the health check return 500?"), { type: "image", data: IMAGE, mimeType: "image/png" }],
    timestamp: at("2026-10-12T08:00:02.000Z"),
  },
  codexReply(
    [{ type: "thinking", thinking: "The route reads a config key that is never set." }, call("call_1", "exec_command", { cmd: "rg -n health src" })],
    "gpt-5-codex",
    "2026-10-12T08:00:05.000Z",
    NO_USAGE,
    "toolUse",
  ),
  toolResult("call_1", "exec_command", [text("src/health.ts:4:  return config.get('db');")], "2026-10-12T08:00:06.000Z"),
  codexReply([call("call_2", "apply_patch", { input: PATCH })], "gpt-5-codex", "2026-10-12T08:00:09.000Z", NO_USAGE, "toolUse"),
  toolResult("call_2", "apply_patch", [text("Success. Updated the following files:\nM src/health.ts\n")], "2026-10-12T08:00:10.000Z"),
  codexReply([call("call_3", "shell", { command: "npm test" })], "gpt-5-codex", "2026-10-12T08:00:12.000Z", NO_USAGE, "toolUse"),
  toolResult("call_3", "shell", [text("4 passing")], "2026-10-12T08:00:20.000Z"),
  // 4000 input tokens of which 2500 cached, 240 output.
  codexReply([text("The route read an unset key. It now falls back to ok, and the tests pass.")], "gpt-5-codex", "2026-10-12T08:00:24.000Z", usage(1500, 240, 2500, 0, 4240), "stop"),
  { role: "user", content: "Thanks, that was quick.", timestamp: at("2026-10-12T08:02:01.000Z") },
  codexReply([text("Glad it helped.")], "gpt-5-codex", "2026-10-12T08:02:03.000Z", NO_USAGE, "stop"),
];

/** An older Codex session without turn events: its tokens are left out, and arguments that are not JSON are kept as input. */
const CODEX_OTHER_MESSAGES = [
  { role: "user", content: "Summarize the README", timestamp: at("2026-09-02T14:30:01.000Z") },
  codexReply([call("call_9", "read_file", { input: "README.md" })], "gpt-5", "2026-09-02T14:30:03.000Z", NO_USAGE, "toolUse"),
  toolResult("call_9", "read_file", [text("# Notes\nA place for meeting notes.")], "2026-09-02T14:30:03.500Z"),
  codexReply([text("It is a folder for meeting notes.")], "gpt-5", "2026-09-02T14:30:06.000Z", NO_USAGE, "stop"),
];

const OPENCODE_DEMO = "ses_0a1b2c3d4e5fDbDemo00001";
const OPENCODE_CHILD = "ses_0a1b2c3d4e5fDbChild0001";
const OPENCODE_JSON = "ses_0b2c3d4e5f6aJsonStore01";
const OPENCODE_USER = "2026-09-18T09:00:00.000Z";
const OPENCODE_REPLY = "2026-09-18T09:00:05.000Z";
const HEADER = "/work/site/src/Header.tsx";

/**
 * The OpenCode database session as Pi messages: the synthetic text is gone,
 * the file part is a line of text, each tool part is a call and a result,
 * text after the calls starts a new message, and the tokens sit on the last.
 */
const OPENCODE_DEMO_MESSAGES = [
  { role: "user", content: "Add a dark mode toggle to the header\n\n(file /work/site/mock.png)", timestamp: at(OPENCODE_USER) },
  openCodeReply(
    [
      { type: "thinking", thinking: "The header lives in Header.tsx." },
      text("I'll add the toggle."),
      call("toolu_a", "read", { filePath: HEADER }),
      call("toolu_b", "edit", { filePath: HEADER, oldString: "<nav>", newString: "<nav><Toggle />" }),
    ],
    "claude-sonnet-4-5",
    OPENCODE_REPLY,
    NO_USAGE,
    "toolUse",
  ),
  toolResult("toolu_a", "read", [text("export function Header() { return <header><Nav /></header>; }")], OPENCODE_REPLY),
  toolResult("toolu_b", "edit", [text("oldString not found in content")], OPENCODE_REPLY, true),
  openCodeReply(
    [text("The edit failed, so I retried with the exact text."), call("toolu_c", "edit", { filePath: HEADER, oldString: "<Nav />", newString: "<Nav /><Toggle />" })],
    "claude-sonnet-4-5",
    OPENCODE_REPLY,
    NO_USAGE,
    "toolUse",
  ),
  toolResult("toolu_c", "edit", [text("Edit applied successfully.")], OPENCODE_REPLY),
  openCodeReply([text("Done: the header has a dark mode toggle.")], "claude-sonnet-4-5", OPENCODE_REPLY, usage(900, 150, 4000, 300, 5350), "stop"),
];

/** The JSON storage fixture as Pi messages. */
const OPENCODE_JSON_MESSAGES = [
  { role: "user", content: "Which config loader do we use?", timestamp: at("2026-08-20T07:00:04.000Z") },
  openCodeReply([call("call_grep_1", "grep", { pattern: "loadConfig" })], "gpt-4.1", "2026-08-20T07:00:09.000Z", NO_USAGE, "toolUse"),
  toolResult("call_grep_1", "grep", [text("src/config.ts:1:export function loadConfig() {}")], "2026-08-20T07:00:09.000Z"),
  openCodeReply([text("loadConfig in src/config.ts.")], "gpt-4.1", "2026-08-20T07:00:09.000Z", usage(640, 25, 0, 0, 665), "stop"),
];

/**
 * An OpenCode database at `file` with OpenCode's `session`, `message` and
 * `part` tables: the /work/site session, updated exactly 30 days before NOW,
 * and a helper agent's session under it, updated a day before NOW. Rows are
 * inserted out of order; the reader orders them.
 */
async function buildOpenCodeDatabase(file) {
  const { DatabaseSync } = await loadNodeSqlite();
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT, slug TEXT NOT NULL,
      directory TEXT NOT NULL, path TEXT, title TEXT NOT NULL, version TEXT NOT NULL, share_url TEXT, summary_additions INTEGER,
      summary_deletions INTEGER, summary_files INTEGER, summary_diffs TEXT, metadata TEXT, cost REAL NOT NULL,
      tokens_input INTEGER NOT NULL, tokens_output INTEGER NOT NULL, tokens_reasoning INTEGER NOT NULL,
      tokens_cache_read INTEGER NOT NULL, tokens_cache_write INTEGER NOT NULL, revert TEXT, permission TEXT, agent TEXT,
      model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_compacting INTEGER, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  `);
  const session = db.prepare(
    `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, cost, tokens_input, tokens_output,
      tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated) VALUES (?, 'prj1', ?, ?, ?, ?, '1.2.0', 0, 0, 0, 0, 0, 0, ?, ?)`,
  );
  session.run(OPENCODE_CHILD, OPENCODE_DEMO, "quiet-fox", "/work/site", "Find the header (@explore subagent)", NOW - 2 * DAY, NOW - DAY);
  session.run(OPENCODE_DEMO, null, "brave-owl", "/work/site", "Add a dark mode toggle", at(OPENCODE_USER), NOW - 30 * DAY);
  const message = db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)");
  const part = db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, 0, 0, ?)");
  const tool = (id, callID, name, state) => part.run(id, "msg_02", OPENCODE_DEMO, JSON.stringify({ type: "tool", callID, tool: name, state }));
  const reply = at(OPENCODE_REPLY);
  message.run(
    "msg_02",
    OPENCODE_DEMO,
    reply,
    reply,
    JSON.stringify({
      role: "assistant",
      time: { created: reply, completed: reply + 9000 },
      modelID: "claude-sonnet-4-5",
      providerID: "anthropic",
      mode: "build",
      path: { cwd: "/work/site", root: "/work/site" },
      cost: 0.0123,
      tokens: { input: 900, output: 120, reasoning: 30, cache: { read: 4000, write: 300 } },
      finish: "stop",
    }),
  );
  message.run("msg_01", OPENCODE_DEMO, at(OPENCODE_USER), at(OPENCODE_USER), JSON.stringify({ role: "user", time: { created: at(OPENCODE_USER) }, agent: "build" }));
  tool("prt_05", "toolu_b", "edit", { status: "error", input: { filePath: HEADER, oldString: "<nav>", newString: "<nav><Toggle />" }, error: "oldString not found in content", time: { start: reply, end: reply } });
  part.run("prt_01", "msg_02", OPENCODE_DEMO, JSON.stringify({ type: "step-start" }));
  part.run("prt_02", "msg_02", OPENCODE_DEMO, JSON.stringify({ type: "reasoning", text: "The header lives in Header.tsx.", time: { start: reply } }));
  part.run("prt_03", "msg_02", OPENCODE_DEMO, JSON.stringify({ type: "text", text: "I'll add the toggle.", time: { start: reply } }));
  tool("prt_04", "toolu_a", "read", { status: "completed", input: { filePath: HEADER }, output: "export function Header() { return <header><Nav /></header>; }", title: "Header.tsx", metadata: {}, time: { start: reply, end: reply } });
  part.run("prt_06", "msg_02", OPENCODE_DEMO, JSON.stringify({ type: "text", text: "The edit failed, so I retried with the exact text." }));
  tool("prt_07", "toolu_c", "edit", { status: "completed", input: { filePath: HEADER, oldString: "<Nav />", newString: "<Nav /><Toggle />" }, output: "Edit applied successfully.", title: "Header.tsx", metadata: {}, time: { start: reply, end: reply } });
  part.run("prt_08", "msg_02", OPENCODE_DEMO, JSON.stringify({ type: "text", text: "Done: the header has a dark mode toggle." }));
  part.run("prt_09", "msg_02", OPENCODE_DEMO, JSON.stringify({ type: "step-finish", tokens: { input: 900, output: 120, reasoning: 30, cache: { read: 4000, write: 300 } }, cost: 0.0123 }));
  part.run("prt_a1", "msg_01", OPENCODE_DEMO, JSON.stringify({ type: "text", text: "Add a dark mode toggle to the header" }));
  part.run("prt_a2", "msg_01", OPENCODE_DEMO, JSON.stringify({ type: "file", mime: "image/png", filename: "mock.png", url: `data:image/png;base64,${IMAGE}`, source: { type: "file", path: "/work/site/mock.png", text: { value: "", start: 0, end: 0 } } }));
  part.run("prt_a3", "msg_01", OPENCODE_DEMO, JSON.stringify({ type: "text", text: "Called the Read tool with the following input: {}", synthetic: true }));
  message.run("msg_11", OPENCODE_CHILD, NOW - 2 * DAY, NOW - 2 * DAY, JSON.stringify({ role: "user", time: { created: NOW - 2 * DAY } }));
  part.run("prt_11", "msg_11", OPENCODE_CHILD, JSON.stringify({ type: "text", text: "Find the header component" }));
  message.run("msg_12", OPENCODE_CHILD, NOW - 2 * DAY + 1000, NOW - 2 * DAY + 1000, JSON.stringify({ role: "assistant", time: { created: NOW - 2 * DAY + 1000 }, modelID: "claude-haiku-4-5", tokens: { input: 50, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } }));
  part.run("prt_12", "msg_12", OPENCODE_CHILD, JSON.stringify({ type: "text", text: "src/Header.tsx" }));
  db.close();
}

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
 * A home, an agent directory Pi is pointed at, and copies of the fixture
 * sessions in a Claude Code directory and a Codex sessions directory: the
 * /work/demo and /work/api sessions changed exactly 30 days before NOW, the
 * /work/other and /work/notes ones a second earlier, and a Codex review a
 * helper agent ran a day before NOW. The OpenCode directory
 * holds the JSON storage fixture; `openCode()` adds the database.
 */
function setup() {
  const root = path.join(temporary, String(++setups));
  const home = path.join(root, "home");
  const agentDir = path.join(root, "agent");
  const claudeDir = path.join(root, "claude");
  const codexDir = path.join(root, "codex-sessions");
  const openCodeDir = path.join(root, "opencode");
  mkdirSync(home, { recursive: true });
  cpSync(fixtures, claudeDir, { recursive: true });
  cpSync(codexFixtures, codexDir, { recursive: true });
  cpSync(openCodeFixtures, openCodeDir, { recursive: true });
  const demoFile = path.join(claudeDir, "projects", "-work-demo", `${DEMO}.jsonl`);
  const otherFile = path.join(claudeDir, "projects", "-work-other", `${OTHER}.jsonl`);
  const codexDemoFile = path.join(codexDir, "2026", "10", "12", `rollout-2026-10-12T08-00-00-${CODEX_DEMO}.jsonl`);
  const codexOtherFile = path.join(codexDir, "2026", "09", "02", `rollout-2026-09-02T14-30-00-${CODEX_OTHER}.jsonl`);
  for (const file of [demoFile, codexDemoFile]) utimesSync(file, new Date(NOW - 30 * DAY), new Date(NOW - 30 * DAY));
  for (const file of [otherFile, codexOtherFile]) utimesSync(file, new Date(NOW - 30 * DAY - 1000), new Date(NOW - 30 * DAY - 1000));
  const codexReviewFile = path.join(codexDir, "2026", "10", "17", `rollout-2026-10-17T16-00-00-${CODEX_REVIEW}.jsonl`);
  utimesSync(codexReviewFile, new Date(NOW - DAY), new Date(NOW - DAY));
  const openCode = () => buildOpenCodeDatabase(path.join(openCodeDir, "opencode.db"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  const ledger = () => JSON.parse(readFileSync(path.join(agentDir, "data", "ampi", "imports.json"), "utf8"));
  const sessionFiles = () => {
    const sessions = path.join(agentDir, "sessions");
    if (!existsSync(sessions)) return [];
    return readdirSync(sessions).flatMap((folder) => readdirSync(path.join(sessions, folder)).map((name) => path.join(sessions, folder, name)));
  };
  /** The session file's entries after the header, without their ids, parents and times. */
  const entriesOf = (file) =>
    readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => {
        const { id, parentId, timestamp, ...entry } = JSON.parse(line);
        return entry;
      });
  return { root, home, agentDir, claudeDir, codexDir, openCodeDir, demoFile, otherFile, codexDemoFile, codexOtherFile, openCode, ledger, sessionFiles, entriesOf };
}

/** Run a thread command at `time` (Pi's clock too), collecting its output. */
async function run(args, { env = {}, time = NOW, cwd = "/work/demo", loadSqlite } = {}) {
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
      log: createLogger({
        stderr: (text) => {
          err += text;
        },
      }),
      confirm: async () => false,
      locateAmpi: async () => ({ root: repoRoot }),
      ...(loadSqlite === undefined ? {} : { loadSqlite }),
    });
    return { result, out, err };
  } finally {
    mock.timers.reset();
  }
}

/** `ampi threads import claude …` with the fixture copy as --claude-dir. */
const importClaude = (t, args, options) => run(["threads", "import", "claude", ...args, "--claude-dir", t.claudeDir], options);
/** `ampi threads import codex …` with the fixture copy as --codex-dir. */
const importCodex = (t, args, options) => run(["threads", "import", "codex", ...args, "--codex-dir", t.codexDir], options);
/** `ampi threads import opencode …` with the fixture copy as --opencode-dir. */
const importOpenCode = (t, args, options) => run(["threads", "import", "opencode", ...args, "--opencode-dir", t.openCodeDir], options);
/** The custom entry an import writes first. */
const importEntry = (agent, sourceId, sourcePath, sourceModified, sourceStarted, importedAt = "2026-10-18T10:00:00.000Z") => ({
  type: "custom",
  customType: "ampi-import",
  data: { agent, sourceId, sourcePath, sourceModified: new Date(sourceModified).toISOString(), sourceStarted, importedAt, formatVersion: 1 },
});
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

describe("Codex sessions as Pi messages", () => {
  it("skips developer and context messages, keeps reasoning summaries, tool calls, outputs and images, and counts a finished turn's tokens", () => {
    const demo = path.join(codexFixtures, "2026", "10", "12", `rollout-2026-10-12T08-00-00-${CODEX_DEMO}.jsonl`);
    assert.deepEqual(convertCodexSession(readFileSync(demo, "utf8")), {
      cwd: "/work/api",
      title: undefined,
      started: at("2026-10-12T08:00:02.000Z"),
      messages: CODEX_DEMO_MESSAGES,
    });
    const other = path.join(codexFixtures, "2026", "09", "02", `rollout-2026-09-02T14-30-00-${CODEX_OTHER}.jsonl`);
    assert.deepEqual(convertCodexSession(readFileSync(other, "utf8")), {
      cwd: "/work/notes",
      title: undefined,
      started: at("2026-09-02T14:30:01.000Z"),
      messages: CODEX_OTHER_MESSAGES,
    });
  });

  it("counts a turn's tokens from the running totals, so a repeated count adds nothing", () => {
    const line = (timestamp, type, payload) => JSON.stringify({ timestamp, type, payload });
    const totals = (input, cached, output) => ({ type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } });
    const reply = (timestamp, words) => line(timestamp, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: words }] });
    const source = [
      line("2026-10-01T00:00:00.000Z", "session_meta", { id: CODEX_OTHER, cwd: "/w" }),
      line("2026-10-01T00:00:01.000Z", "event_msg", { type: "task_started", turn_id: "a" }),
      line("2026-10-01T00:00:02.000Z", "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "one" }] }),
      reply("2026-10-01T00:00:03.000Z", "first"),
      line("2026-10-01T00:00:03.100Z", "event_msg", totals(100, 0, 10)),
      line("2026-10-01T00:00:03.200Z", "event_msg", totals(100, 0, 10)),
      line("2026-10-01T00:00:04.000Z", "event_msg", { type: "task_complete", turn_id: "a" }),
      line("2026-10-01T00:00:05.000Z", "event_msg", { type: "task_started", turn_id: "b" }),
      line("2026-10-01T00:00:06.000Z", "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "two" }] }),
      reply("2026-10-01T00:00:07.000Z", "second"),
      line("2026-10-01T00:00:07.100Z", "event_msg", totals(350, 100, 30)),
      line("2026-10-01T00:00:08.000Z", "event_msg", { type: "turn_aborted", turn_id: "b" }),
    ].join("\n");
    const replies = convertCodexSession(source).messages.filter((message) => message.role === "assistant");
    assert.deepEqual(
      replies.map((message) => message.usage),
      [usage(100, 10, 0, 0, 110), usage(150, 20, 100, 0, 270)],
    );
  });
});

describe("OpenCode sessions as Pi messages", () => {
  it("reads sessions from the database and the older JSON storage, with their directories, titles and update times", async () => {
    const t = setup();
    await t.openCode();
    // An older copy of the database session in the JSON storage, which the database's copy replaces.
    const storage = path.join(t.openCodeDir, "storage");
    for (const folder of ["session/4f1e2d3c", `message/${OPENCODE_DEMO}`, "part/msg_0b2c3d4e5f6a0901"]) mkdirSync(path.join(storage, folder), { recursive: true });
    writeFileSync(path.join(storage, "session", "4f1e2d3c", `${OPENCODE_DEMO}.json`), JSON.stringify({ id: OPENCODE_DEMO, directory: "/work/stale", title: "A stale copy", time: { created: NOW - 40 * DAY, updated: NOW - 40 * DAY } }));
    writeFileSync(path.join(storage, "message", OPENCODE_DEMO, "msg_0b2c3d4e5f6a0901.json"), JSON.stringify({ id: "msg_0b2c3d4e5f6a0901", role: "user", time: { created: NOW - 40 * DAY } }));
    writeFileSync(path.join(storage, "part", "msg_0b2c3d4e5f6a0901", "prt_0b2c3d4e5f6a0901.json"), JSON.stringify({ id: "prt_0b2c3d4e5f6a0901", type: "text", text: "The stale prompt" }));
    const source = await openOpenCode(t.openCodeDir);
    try {
      const database = path.join(t.openCodeDir, "opencode.db");
      assert.deepEqual(
        source.sessions.sort((a, b) => a.id.localeCompare(b.id)),
        [
          { id: OPENCODE_CHILD, file: database, modified: new Date(NOW - DAY), subagent: true },
          { id: OPENCODE_DEMO, file: database, modified: new Date(NOW - 30 * DAY) },
          { id: OPENCODE_JSON, file: path.join(t.openCodeDir, "storage", "session", "4f1e2d3c", `${OPENCODE_JSON}.json`), modified: new Date(NOW - 30 * DAY - 1000) },
        ],
      );
      const byId = (id) => source.sessions.find((session) => session.id === id);
      assert.deepEqual(source.convert(byId(OPENCODE_DEMO)), {
        cwd: "/work/site",
        title: "Add a dark mode toggle",
        started: at(OPENCODE_USER),
        messages: OPENCODE_DEMO_MESSAGES,
      });
      // OpenCode's placeholder title is no title: Pi then shows the first prompt.
      assert.deepEqual(source.convert(byId(OPENCODE_JSON)), {
        cwd: "/work/legacy",
        title: undefined,
        started: at("2026-08-20T07:00:04.000Z"),
        messages: OPENCODE_JSON_MESSAGES,
      });
    } finally {
      source.close();
    }
  });
});

describe("OpenCode tool parts", () => {
  it("turns a tool the session stopped before it finished into an interrupted error", () => {
    const tool = (callID, status) => ({ type: "tool", callID, tool: "bash", state: { status, input: { command: "npm test" } } });
    const { messages } = convertOpenCodeSession({ directory: "/w", title: "t" }, [
      { info: { role: "assistant", time: { created: 5 }, modelID: "m" }, parts: [tool("call_p", "pending"), tool("call_r", "running")] },
    ]);
    assert.deepEqual(
      messages.filter((message) => message.role === "toolResult").map(({ toolCallId, content, isError }) => ({ toolCallId, content, isError })),
      [
        { toolCallId: "call_p", content: [text("(interrupted)")], isError: true },
        { toolCallId: "call_r", content: [text("(interrupted)")], isError: true },
      ],
    );
  });
});

describe("loading node:sqlite", () => {
  it("keeps SQLite's experimental warning away and lets other warnings through", async () => {
    const emitted = [];
    const original = process.emitWarning;
    process.emitWarning = (warning, type) => emitted.push([String(warning), type]);
    try {
      const module = await loadNodeSqlite(async () => {
        process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");
        process.emitWarning("Another feature is experimental", "ExperimentalWarning");
        process.emitWarning("SQLite says something else", "DeprecationWarning");
        return { loaded: true };
      });
      assert.deepEqual(module, { loaded: true });
      assert.deepEqual(emitted, [
        ["Another feature is experimental", "ExperimentalWarning"],
        ["SQLite says something else", "DeprecationWarning"],
      ]);
      // The filter is gone once the module is loaded.
      process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");
      assert.equal(emitted.length, 3);
    } finally {
      process.emitWarning = original;
    }
  });

  it("names the Node.js version only when the module is missing, and otherwise the reason it failed", async () => {
    await assert.rejects(
      loadNodeSqlite(async () => {
        throw new Error("SQLite is disabled in this build");
      }),
      { message: "cannot load node:sqlite to read OpenCode's database: SQLite is disabled in this build" },
    );
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

  it("refuses usage errors with exit 2 and writes nothing", async () => {
    const t = setup();
    const cases = [
      [["codex"], "threads import codex needs session ids or --all."],
      [["opencode", OPENCODE_DEMO, "--all"], "threads import opencode takes session ids or --all, not both."],
      [["codex", "rollout-2026-10-12"], '"rollout-2026-10-12" is not a Codex session id: give the id that ends the rollout file\'s name.'],
      [["opencode", "../ses_1"], '"../ses_1" is not an OpenCode session id: give an id that starts with ses_.'],
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
    // Each agent takes only its own directory option.
    const wrongDir = await run(["threads", "import", "codex", "--all", "--claude-dir", t.claudeDir], { env: { HOME: t.home } });
    assert.equal(wrongDir.result.code, 2);
    assert.match(wrongDir.err, /^ampi: threads import codex: Unknown option '--claude-dir'/);
    assert.deepEqual(t.sessionFiles(), []);
  });

  it("prints its help, and threads --help names it", async () => {
    for (const agent of ["claude", "codex", "opencode"]) {
      const { result, out } = await run(["threads", "import", agent, "--help"]);
      assert.equal(result.code, 0);
      assert.equal(out, formatImportHelp());
    }
    assert.match(formatThreadsHelp(), /^ {2}import \[command\] {14}Copy Claude Code, Codex and OpenCode conversations/m);
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

describe("ampi threads import codex", () => {
  it("imports the sessions updated within --max-age days from the dated folders, as sessions labelled codex", async () => {
    const t = setup();
    const first = await importCodex(t, ["--all"]);
    assert.equal(first.result.code, 0, first.err);
    const demo = t.ledger().imports[`codex:${CODEX_DEMO}`];
    assert.equal(first.out, `Imported ${CODEX_DEMO} as ${demo.sessionId} (10 messages)\nCodex: 1 imported, 0 skipped, 0 failed.\n`);
    assert.equal(t.ledger().imports[`codex:${CODEX_OTHER}`], undefined, "a second older than 30 days is left out");
    assert.equal(t.ledger().imports[`codex:${CODEX_REVIEW}`], undefined, "a helper agent's review is left out");

    assert.deepEqual(t.entriesOf(demo.sessionPath), [
      importEntry("codex", CODEX_DEMO, t.codexDemoFile, NOW - 30 * DAY, "2026-10-12T08:00:02.000Z"),
      ...CODEX_DEMO_MESSAGES.map((message) => ({ type: "message", message })),
    ]);
    assert.deepEqual(pi.SessionManager.open(demo.sessionPath).buildSessionContext().messages, CODEX_DEMO_MESSAGES);

    const all = await importCodex(t, ["--all", "--max-age", "0", "--json"]);
    const other = t.ledger().imports[`codex:${CODEX_OTHER}`];
    assert.deepEqual(jsonLines(all.out), [
      { type: "skipped", agent: "codex", sourceId: CODEX_DEMO, sessionId: demo.sessionId, reason: `already imported as ${demo.sessionId}; --reimport imports it again` },
      { type: "imported", agent: "codex", sourceId: CODEX_OTHER, sessionId: other.sessionId, messages: 4 },
      { type: "summary", agent: "codex", imported: 1, skipped: 1, failed: 0 },
    ]);

    const listed = jsonLines((await run(["threads", "list", "--all", "--json"])).out);
    assert.deepEqual(
      listed.map(({ id, title, labels, cwd }) => ({ id, title, labels, cwd })),
      [
        { id: demo.sessionId, title: "Why does the health check return 500?", labels: ["imported", "codex"], cwd: "/work/api" },
        { id: other.sessionId, title: "Summarize the README", labels: ["imported", "codex"], cwd: "/work/notes" },
      ],
    );
    const markdown = await run(["threads", "markdown", other.sessionId]);
    assert.equal(markdown.result.code, 0);
    assert.match(markdown.out, /\n## User\n\nSummarize the README\n\n## Assistant\n\n\*\*Tool Use:\*\* `read_file`\n/);

    // A helper agent's rollout imports by its id.
    const review = await importCodex(t, [CODEX_REVIEW, "--json"]);
    assert.equal(review.result.code, 0, review.err);
    assert.deepEqual(jsonLines(review.out).at(-1), { type: "summary", agent: "codex", imported: 1, skipped: 0, failed: 0 });
  });

  it("skips what it imported before and imports it again under the same id with --reimport", async () => {
    const t = setup();
    await importCodex(t, [CODEX_OTHER]);
    const first = t.ledger().imports[`codex:${CODEX_OTHER}`];
    const again = await importCodex(t, [CODEX_OTHER]);
    assert.equal(again.out, `Skipped ${CODEX_OTHER}: already imported as ${first.sessionId}; --reimport imports it again\nCodex: 0 imported, 1 skipped, 0 failed.\n`);
    const reimported = await importCodex(t, [CODEX_OTHER, "--reimport"], { time: NOW + 60_000 });
    assert.equal(reimported.result.code, 0);
    const second = t.ledger().imports[`codex:${CODEX_OTHER}`];
    assert.equal(second.sessionId, first.sessionId);
    assert.deepEqual(t.sessionFiles(), [second.sessionPath]);
  });

  it("converts and counts with --dry-run, writes nothing, and fails an id no rollout has", async () => {
    const t = setup();
    const missing = "0199ffff-0000-7000-8000-000000000000";
    const { result, out } = await importCodex(t, [CODEX_DEMO, missing, "--dry-run", "--json"]);
    assert.equal(result.code, 1);
    assert.deepEqual(jsonLines(out), [
      { type: "failed", agent: "codex", sourceId: missing, reason: `no Codex session has this id in ${t.codexDir}` },
      { type: "imported", agent: "codex", sourceId: CODEX_DEMO, messages: 10 },
      { type: "summary", agent: "codex", imported: 1, skipped: 0, failed: 1, dryRun: true },
    ]);
    assert.equal(existsSync(t.agentDir), false);
  });

  it("finds sessions in $CODEX_HOME/sessions without --codex-dir", async () => {
    const t = setup();
    const codexHome = path.join(t.root, "codex-home");
    cpSync(t.codexDir, path.join(codexHome, "sessions"), { recursive: true });
    const { result } = await run(["threads", "import", "codex", CODEX_OTHER], { env: { HOME: t.home, CODEX_HOME: codexHome } });
    assert.equal(result.code, 0);
    assert.ok(t.ledger().imports[`codex:${CODEX_OTHER}`]);
  });
});

describe("ampi threads import opencode", () => {
  it("imports from the database and the JSON storage by update time, leaving helper agents' sessions out of --all", async () => {
    const t = setup();
    await t.openCode();
    const first = await importOpenCode(t, ["--all", "--json"]);
    assert.equal(first.result.code, 0, first.err);
    const demo = t.ledger().imports[`opencode:${OPENCODE_DEMO}`];
    assert.deepEqual(jsonLines(first.out), [
      { type: "imported", agent: "opencode", sourceId: OPENCODE_DEMO, sessionId: demo.sessionId, messages: 7 },
      { type: "summary", agent: "opencode", imported: 1, skipped: 0, failed: 0 },
    ]);
    assert.deepEqual(t.entriesOf(demo.sessionPath), [
      importEntry("opencode", OPENCODE_DEMO, path.join(t.openCodeDir, "opencode.db"), NOW - 30 * DAY, OPENCODE_USER),
      { type: "session_info", name: "Add a dark mode toggle" },
      ...OPENCODE_DEMO_MESSAGES.map((message) => ({ type: "message", message })),
    ]);

    const all = await importOpenCode(t, ["--all", "--max-age", "0"]);
    const legacy = t.ledger().imports[`opencode:${OPENCODE_JSON}`];
    assert.equal(
      all.out,
      [
        `Skipped ${OPENCODE_DEMO}: already imported as ${demo.sessionId}; --reimport imports it again`,
        `Imported ${OPENCODE_JSON} as ${legacy.sessionId} (4 messages)`,
        "OpenCode: 1 imported, 1 skipped, 0 failed.",
        "",
      ].join("\n"),
    );
    assert.equal(t.ledger().imports[`opencode:${OPENCODE_CHILD}`], undefined);

    // A helper agent's session imports by its id.
    const child = await importOpenCode(t, [OPENCODE_CHILD]);
    assert.equal(child.result.code, 0);
    const listed = jsonLines((await run(["threads", "list", "--all", "--json"])).out);
    assert.deepEqual(
      listed.map(({ title, labels, cwd }) => ({ title, labels, cwd })),
      [
        { title: "Find the header (@explore subagent)", labels: ["imported", "opencode"], cwd: "/work/site" },
        { title: "Add a dark mode toggle", labels: ["imported", "opencode"], cwd: "/work/site" },
        { title: "Which config loader do we use?", labels: ["imported", "opencode"], cwd: "/work/legacy" },
      ],
    );
  });

  it("skips what it imported before and imports it again under the same id with --reimport", async () => {
    const t = setup();
    await t.openCode();
    await importOpenCode(t, [OPENCODE_DEMO, OPENCODE_JSON]);
    const first = t.ledger().imports[`opencode:${OPENCODE_DEMO}`];
    const again = await importOpenCode(t, [OPENCODE_DEMO, "--reimport", "--json"], { time: NOW + 60_000 });
    assert.deepEqual(jsonLines(again.out), [
      { type: "imported", agent: "opencode", sourceId: OPENCODE_DEMO, sessionId: first.sessionId, messages: 7 },
      { type: "summary", agent: "opencode", imported: 1, skipped: 0, failed: 0 },
    ]);
    const second = t.ledger().imports[`opencode:${OPENCODE_DEMO}`];
    assert.equal(second.importedAt, new Date(NOW + 60_000).toISOString());
    assert.equal(t.sessionFiles().length, 2);
    assert.ok(t.sessionFiles().includes(second.sessionPath));
  });

  it("converts and counts with --dry-run and writes nothing", async () => {
    const t = setup();
    await t.openCode();
    const { result, out } = await importOpenCode(t, ["--all", "--max-age", "0", "--dry-run"]);
    assert.equal(result.code, 0);
    assert.equal(
      out,
      [`Would import ${OPENCODE_DEMO} (7 messages)`, `Would import ${OPENCODE_JSON} (4 messages)`, "OpenCode: 2 to import, 0 skipped, 0 failed. Nothing was written (--dry-run).", ""].join("\n"),
    );
    assert.equal(existsSync(t.agentDir), false);
  });

  it("names the Node.js version it needs when node:sqlite is missing, and reads JSON storage without it", async () => {
    const t = setup();
    let loads = 0;
    const loadSqlite = async () => {
      loads += 1;
      throw Object.assign(new Error("No such built-in module: node:sqlite"), { code: "ERR_UNKNOWN_BUILTIN_MODULE" });
    };
    const storageOnly = await importOpenCode(t, [OPENCODE_JSON], { loadSqlite });
    assert.equal(storageOnly.result.code, 0, storageOnly.err);
    assert.equal(loads, 0, "no database, so node:sqlite is not loaded");

    await t.openCode();
    const { result, out, err } = await importOpenCode(t, ["--all"], { loadSqlite });
    assert.equal(result.code, 1);
    assert.equal(out, "");
    assert.equal(err, `ampi: reading OpenCode's database needs Node.js 22.19 or later, which includes node:sqlite; this is Node.js ${process.version}.\n`);
  });

  it("finds the data directory in $XDG_DATA_HOME without --opencode-dir", async () => {
    const t = setup();
    const xdg = path.join(t.root, "xdg");
    cpSync(t.openCodeDir, path.join(xdg, "opencode"), { recursive: true });
    const { result } = await run(["threads", "import", "opencode", OPENCODE_JSON], { env: { HOME: t.home, XDG_DATA_HOME: xdg } });
    assert.equal(result.code, 0);
    assert.ok(t.ledger().imports[`opencode:${OPENCODE_JSON}`]);
  });
});

describe("an execute run in an imported session", () => {
  it("sends nothing, prints the read-only notice on stderr and exits 1, for Claude Code and Codex sessions alike", async () => {
    const t = setup();
    const project = path.join(t.root, "project");
    mkdirSync(project);
    // Conversations that ran in a directory this test owns, so Pi finds their sessions by id there.
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
    const codexDir = path.join(t.root, "codex-project");
    const codexId = "0199e000-0000-7000-8000-000000000001";
    mkdirSync(path.join(codexDir, "2026", "10", "17"), { recursive: true });
    writeFileSync(
      path.join(codexDir, "2026", "10", "17", `rollout-2026-10-17T08-00-00-${codexId}.jsonl`),
      [
        { timestamp: "2026-10-17T08:00:00.000Z", type: "session_meta", payload: { id: codexId, cwd: project } },
        { timestamp: "2026-10-17T08:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "List the scripts" }] } },
        { timestamp: "2026-10-17T08:00:04.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "build and test." }] } },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    await run(["threads", "import", "codex", codexId, "--codex-dir", codexDir]);

    const imports = t.ledger().imports;
    await Promise.all(
      [imports["claude-code:1a2b3c4d-0000-4000-8000-000000000001"], imports[`codex:${codexId}`]].map(async ({ sessionId, sessionPath }) => {
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
      }),
    );
  });
});
