import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";
import { createAnsiTheme, expectFixture, plain } from "./helpers/tui-render.mjs";

after(cleanupLoadedSource);

let mcp;
let help;
let createMmrTuiCommands;
let createMmrTuiKeys;
let registry;
const theme = createAnsiTheme();

before(async () => {
  mcp = await importSource("extensions/ampi-tui/overlays/mcp-info.ts");
  help = await importSource("extensions/ampi-tui/overlays/help-keymap.ts");
  ({ createMmrTuiCommands } = await importSource("extensions/ampi-tui/keys/commands.ts"));
  ({ createMmrTuiKeys } = await importSource("extensions/ampi-tui/keys/install.ts"));
  registry = await importSource("extensions/ampi-core/command-registry.ts");
});

const HOME = "/home/user";
const CWD = `${HOME}/projects/app`;
const USER_FILE = `${HOME}/.pi/agent/mcp.json`;
const PROJECT_FILE = `${CWD}/.pi/mcp.json`;
const EXTENSION = `${HOME}/extensions/tracker/index.ts`;

const userFile = (servers) => ({ path: USER_FILE, scope: "user", text: JSON.stringify({ mcpServers: servers }) });
const projectFile = (servers) => ({ path: PROJECT_FILE, scope: "project", text: JSON.stringify({ mcpServers: servers }) });
const tool = (name, description, namespace, exposure) => ({
  name,
  description,
  ...(namespace ? { namespace: { name: namespace } } : {}),
  ...(exposure ? { exposure } : {}),
});
const build = (inputs) => mcp.buildMmrMcpInfo({ files: [], registered: [], tools: [], manageable: true, ...inputs });
const summary = (info) =>
  info.servers.map((server) => ({
    name: server.name,
    enabled: server.enabled,
    exposure: server.exposure,
    source: server.source && `${server.source.kind}${server.source.override ? " override" : ""}`,
    tools: server.tools.map((entry) => entry.name),
  }));

/** A session with three servers: one from each place, one of them disabled, with asymmetric tool counts. */
const SESSION = {
  files: [
    userFile({
      "dev-radius": { command: "radius-mcp", exposure: "direct" },
      docs: { url: "https://docs.example/mcp" },
      legacy: { command: "legacy-mcp", enabled: false },
    }),
    projectFile({ docs: { exposure: "deferred" } }),
  ],
  registered: [{ name: "tracker", config: { url: "https://tracker.example/mcp" }, extensionPath: EXTENSION }],
  tools: [
    tool("read", "Read a file"),
    tool("mcp__dev_radius__find_symbol", "Find where a symbol is defined.\nLonger notes follow."),
    tool("mcp__dev_radius__list_files", "List the files under a directory"),
    tool("mcp__dev_radius__open", "Open a file at a line"),
    tool("mcp__tracker__search_issues", "Search the issue tracker by text, label or assignee, newest first"),
    tool("list_mcp_resources", "List resources from MCP servers"),
  ],
};

describe("MCP server and tool data", () => {
  it("merges the user and project files: a project entry replaces the user one", () => {
    const files = [
      userFile({ docs: { url: "https://docs.example/mcp" }, search: { command: "search-mcp" } }),
      projectFile({ docs: { command: "docs-local", exposure: "hidden" }, lint: { command: "lint-mcp" } }),
    ];
    assert.deepEqual(summary(build({ files })), [
      { name: "docs", enabled: true, exposure: "hidden", source: "project", tools: [] },
      { name: "search", enabled: true, exposure: "codemode", source: "user", tools: [] },
      { name: "lint", enabled: true, exposure: "codemode", source: "project", tools: [] },
    ]);
  });

  it("skips entries Pi skips: one without command or url, and a name Pi writes like an earlier one", () => {
    const info = build({
      files: [
        userFile({ "a-b": { command: "ab-mcp" }, a_b: { url: "https://ab.example/mcp" }, broken: { enabled: true } }),
        projectFile({ typed: { type: "stdio" }, "a-b": { url: "https://ab.example/project" } }),
      ],
      tools: [tool("mcp__a_b__run", "Run"), tool("mcp__a_b__stop", "Stop")],
    });
    assert.deepEqual(summary(info), [{ name: "a-b", enabled: true, exposure: "codemode", source: "project", tools: ["run", "stop"] }]);
  });

  it("leaves out the tools Pi hid because their server was turned off or dropped them, not those its config hides", () => {
    const info = build({
      files: [
        userFile({
          docs: { url: "https://docs.example/mcp" },
          legacy: { command: "legacy-mcp", enabled: false },
          quiet: { command: "quiet-mcp", exposure: "hidden" },
          picky: { command: "picky-mcp", toolExposure: { "internal-*": "hidden" } },
        }),
      ],
      tools: [
        tool("mcp__docs__search", "Search", undefined, "deferred"),
        tool("mcp__docs__retired", "No longer offered", undefined, "hidden"),
        tool("mcp__legacy__run", "Run", undefined, "hidden"),
        tool("mcp__quiet__peek", "Peek", undefined, "hidden"),
        tool("mcp__picky__internal_dump", "Dump", undefined, "hidden"),
        tool("mcp__picky__gone", "Dropped", undefined, "hidden"),
        tool("mcp__ghost__look", "From a server that was removed", undefined, "hidden"),
      ],
    });
    assert.deepEqual(
      summary(info).map((server) => [server.name, server.enabled, server.tools]),
      [
        ["docs", true, ["search"]],
        ["legacy", false, []],
        ["quiet", true, ["peek"]],
        ["picky", true, ["internal_dump"]],
      ],
    );
  });

  it("lets a project entry without command or url change only the user server's state and exposure", () => {
    const info = build({
      files: [
        userFile({ docs: { url: "https://docs.example/mcp", exposure: "codemode-deferred" } }),
        projectFile({ docs: { enabled: false }, orphan: { enabled: false }, extra: { exposure: "direct", env: {} } }),
      ],
    });
    assert.deepEqual(summary(info), [{ name: "docs", enabled: false, exposure: "codemode", source: "project override", tools: [] }]);
  });

  it("lets a file entry win over a registered server whose name differs only in - and _", () => {
    const info = build({
      files: [userFile({ "dev-radius": { command: "radius-mcp" } })],
      registered: [
        { name: "dev_radius", config: { url: "https://radius.example/mcp" }, extensionPath: EXTENSION },
        { name: "tracker", config: { url: "https://tracker.example/mcp", enabled: false }, extensionPath: EXTENSION },
      ],
    });
    assert.deepEqual(summary(info), [
      { name: "dev-radius", enabled: true, exposure: "codemode", source: "user", tools: [] },
      { name: "tracker", enabled: false, exposure: "codemode", source: "extension", tools: [] },
    ]);
  });

  it("reports an unreadable or invalid file instead of failing, and skips a missing one", () => {
    const info = build({
      files: [
        { path: USER_FILE, scope: "user", text: "{ not json" },
        { path: PROJECT_FILE, scope: "project", error: "EACCES: permission denied" },
      ],
    });
    assert.deepEqual(info.errors, [
      { path: USER_FILE, message: "is not valid JSON" },
      { path: PROJECT_FILE, message: "could not be read" },
    ]);
    assert.deepEqual(build({ files: [{ path: USER_FILE, scope: "user", text: '{ "mcpServers": [] }' }] }).errors, [
      { path: USER_FILE, message: "has no mcpServers object" },
    ]);
    assert.deepEqual(build({ files: [{ path: USER_FILE, scope: "user" }] }), { servers: [], errors: [], manageable: true });
  });

  it("matches tools to servers by Pi's tool names, a hyphenated server included, and counts them per server", () => {
    const info = build(SESSION);
    assert.deepEqual(summary(info), [
      { name: "dev-radius", enabled: true, exposure: "direct", source: "user", tools: ["find_symbol", "list_files", "open"] },
      { name: "docs", enabled: true, exposure: "deferred", source: "project override", tools: [] },
      { name: "legacy", enabled: false, exposure: "codemode", source: "user", tools: [] },
      { name: "tracker", enabled: true, exposure: "codemode", source: "extension", tools: ["search_issues"] },
    ]);
    assert.equal(info.servers[0].tools[0].description, "Find where a symbol is defined.");
  });

  it("uses a tool's namespace and the longest server name that fits, and keeps tools of unknown servers", () => {
    const info = build({
      files: [userFile({ a: { command: "a" }, a__b: { command: "ab" } })],
      tools: [
        tool("mcp__a__b__run", "Runs on a__b"),
        tool("mcp__a__go", "Runs on a"),
        tool("mcp__a__b_c_1a2b3c4d", "A hashed name", "mcp__a"),
        tool("mcp__ghost__look", "From a server no file names"),
      ],
    });
    assert.deepEqual(
      summary(info).map((server) => [server.name, server.source, server.tools]),
      [
        ["a", "user", ["go", "b_c_1a2b3c4d"]],
        ["a__b", "user", ["run"]],
        ["ghost", undefined, ["look"]],
      ],
    );
  });
});

/** The dialog as Pi draws it at a terminal size, on a given tab. */
function render(info, columns, rows, tab = 0) {
  const view = new help.MmrScrollOverlay({
    title: mcp.MMR_MCP_TITLE,
    content: (width, current, index) =>
      index === 0 ? mcp.renderMmrMcpServerLines(info, width, current, CWD, HOME) : mcp.renderMmrMcpToolLines(info, width, current),
    theme,
    onClose() {},
    terminalRows: () => rows,
    fit: true,
    tabs: mcp.MMR_MCP_TABS,
  });
  for (let index = 0; index < tab; index++) view.handleInput("\t");
  return view.render(Math.min(mcp.MMR_MCP_WIDTH, columns - 4));
}

describe("MCP Servers dialog", () => {
  it("renders both tabs at 80 and 140 columns", () => {
    const info = build(SESSION);
    for (const [columns, rows] of [
      [80, 24],
      [140, 44],
    ]) {
      expectFixture("ampi-tui-mcp-info", `servers-${columns}`, render(info, columns, rows));
      expectFixture("ampi-tui-mcp-info", `tools-${columns}`, render(info, columns, rows, 1));
    }
    const servers = plain(render(info, 140, 44));
    assert.match(servers[0], /^╭─ MCP Servers ─+╮$/);
    assert.match(servers[2], /^│ Servers {2}· {2}Tools +│$/);
    assert.match(servers[4], /^│ dev-radius {2}connected {6}3 tools {2}direct {4}~\/\.pi\/agent\/mcp\.json +│$/);
    assert.match(servers[5], /^│ docs {8}not connected {2}0 tools {2}deferred {2}\.pi\/mcp\.json override +│$/);
    assert.match(servers[7], /^│ tracker {5}connected {6}1 tool {3}codemode {2}~\/extensions\/tracker\/index\.ts +│$/);
    assert.match(servers.at(-1), /Tab switch tab · Esc close ─╯$/);
    const tools = plain(render(info, 140, 44, 1));
    assert.match(tools[2], /^│ Servers {2}· {2}Tools +│$/);
    assert.deepEqual(tools.length, servers.length, "the box keeps its height across tabs");
  });

  it("styles the active tab bold in the title color and the other dim", () => {
    const [servers, tools] = [render(build({}), 80, 24)[2], render(build({}), 80, 24, 1)[2]];
    assert.ok(servers.includes("\x1b[1m\x1b[33mServers\x1b[39m\x1b[22m"));
    assert.ok(servers.includes("\x1b[2mTools\x1b[22m"));
    assert.ok(tools.includes("\x1b[2mServers\x1b[22m"));
    assert.ok(tools.includes("\x1b[1m\x1b[33mTools\x1b[39m\x1b[22m"));
  });

  it("shows the empty states, the file errors and whether MCP support is on", () => {
    expectFixture("ampi-tui-mcp-info", "empty-80", render(build({}), 80, 24));
    const empty = plain(render(build({}), 80, 24, 1));
    assert.ok(empty.some((line) => line.includes(mcp.MMR_MCP_NO_TOOLS)));
    const off = plain(mcp.renderMmrMcpServerLines(build({ manageable: false }), 76, theme, CWD, HOME));
    assert.ok(off.join(" ").includes("MCP support is off in this session"));
    assert.ok(!off.join(" ").includes("Run /mcp"));
    const broken = plain(
      mcp.renderMmrMcpServerLines(build({ files: [{ path: USER_FILE, scope: "user", text: "{" }] }), 76, theme, CWD, HOME),
    );
    assert.equal(broken[0], "~/.pi/agent/mcp.json is not valid JSON");
    assert.match(broken[2], /^No MCP servers are set up\. Add one with pi mcp add/);
  });

  it("switches tabs with Tab, scrolls with the arrow, j/k and page keys, and closes on Esc", () => {
    const many = Array.from({ length: 30 }, (_, index) => tool(`mcp__docs__tool_${String(index).padStart(2, "0")}`, `Tool ${index}`));
    const info = build({ files: [userFile({ docs: { url: "https://docs.example/mcp" } })], tools: many });
    let closed = 0;
    const view = new help.MmrScrollOverlay({
      title: mcp.MMR_MCP_TITLE,
      content: (width, current, index) =>
        index === 0 ? mcp.renderMmrMcpServerLines(info, width, current, CWD, HOME) : mcp.renderMmrMcpToolLines(info, width, current),
      theme,
      onClose: () => closed++,
      terminalRows: () => 24,
      fit: true,
      tabs: mcp.MMR_MCP_TABS,
    });
    let lines = plain(view.render(76));
    assert.match(lines.at(-1), /Tab switch tab · Esc close ─╯$/, "the servers fit: no scroll hint");
    view.handleInput("\t");
    assert.equal(view.getTab(), 1);
    lines = plain(view.render(76));
    assert.match(lines.at(-1), /Tab switch tab · Esc close · ↑↓\/j\/k scroll ─╯$/);
    assert.match(lines[2], /Servers {2}· {2}Tools/);
    assert.match(lines[4], /^│ docs/);
    view.handleInput("j");
    view.handleInput("\x1b[B");
    assert.equal(view.getOffset(), 2);
    view.handleInput("k");
    assert.equal(view.getOffset(), 1);
    view.handleInput("\x1b[6~");
    view.render(76);
    // 24 rows: the box is 22 tall, 3 rows of frame and 2 of tab row leave 17 content rows; a page is 16.
    assert.equal(view.getOffset(), 14);
    lines = plain(view.render(76));
    assert.match(lines[2], /Servers {2}· {2}Tools/, "the tab row stays while the content scrolls");
    assert.match(lines[4], /tool_13/, "row 14: the server name, then tool_00 to tool_13");
    view.handleInput("\t");
    assert.equal(view.getTab(), 0);
    assert.equal(view.getOffset(), 0, "a new tab starts at the top");
    view.handleInput("\x1b");
    assert.equal(closed, 1);
  });
});

describe("MCP commands", () => {
  const opened = [];
  const commands = [];
  const sent = [];
  const host = {
    getTui: () => undefined,
    pi: {
      getCommands: () => commands,
      getSettings: () => ({}),
      sendUserMessage: (text, options) => sent.push({ text, options }),
    },
    openMcpInfo: () => opened.push("mcp"),
  };
  const find = (id) => createMmrTuiCommands(host).find((command) => command.id === id);

  it("mcp info opens the dialog in the terminal UI", () => {
    const { ctx } = createMockExtensionContext({ hasUI: true });
    const print = createMockExtensionContext({ hasUI: false }).ctx;
    assert.equal(`${find("mcp.info").noun} ${find("mcp.info").verb}`, "mcp info");
    assert.deepEqual(find("mcp.info").availability(print), { state: "unavailable", reason: "only in Pi's terminal UI" });
    assert.deepEqual(find("mcp.info").availability(ctx), { state: "available" });
    find("mcp.info").run(ctx);
    assert.deepEqual(opened, ["mcp"]);
  });

  it("mcp authenticate runs /mcp when Pi registered it and no turn is running", () => {
    const authenticate = find("mcp.authenticate");
    assert.equal(`${authenticate.noun} ${authenticate.verb}`, "mcp authenticate");
    const context = createMockExtensionContext({ hasUI: true });
    assert.deepEqual(authenticate.availability(context.ctx), {
      state: "unavailable",
      reason: "MCP support is off in this session (no /mcp command)",
    });
    commands.push({ name: "mcp", description: "Manage MCP servers", source: "extension" });
    assert.deepEqual(authenticate.availability(context.ctx), { state: "available" });
    context.state.idle = false;
    assert.deepEqual(authenticate.availability(context.ctx), { state: "unavailable", reason: "a turn is running" });
    context.state.idle = true;
    authenticate.run(context.ctx);
    assert.deepEqual(sent, [{ text: "/mcp", options: { expandPromptTemplates: true } }]);
  });
});

describe("MCP Servers dialog in a session", () => {
  let agentDir;
  let previous;
  beforeEach(() => {
    registry.__resetMmrCommandsForTests();
    agentDir = mkdtempSync(path.join(tmpdir(), "ampi-mcp-info-"));
    previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });
  afterEach(() => {
    registry.__resetMmrCommandsForTests();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("reads the project's mcp.json only when the project is trusted", () => {
    const cwd = path.join(agentDir, "project");
    mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { docs: { url: "https://docs.example/mcp" } } }));
    writeFileSync(path.join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { docs: { enabled: false }, lint: { command: "lint-mcp" } } }));
    const pi = { getMcpServers: () => [], getAllTools: () => [], getCommands: () => [{ name: "mcp" }] };
    const read = (trusted) => summary(mcp.readMmrMcpInfo(pi, { cwd, isProjectTrusted: () => trusted }, agentDir));
    assert.deepEqual(read(false), [{ name: "docs", enabled: true, exposure: "codemode", source: "user", tools: [] }]);
    assert.deepEqual(read(true), [
      { name: "docs", enabled: false, exposure: "codemode", source: "project override", tools: [] },
      { name: "lint", enabled: true, exposure: "codemode", source: "project", tools: [] },
    ]);
  });

  it("gathers registered servers and tools when it opens, in a box that dims the prompt", async () => {
    // Under the real home directory, which the dialog writes as ~ whatever HOME is.
    const extensionPath = path.join(homedir(), "extensions", "tracker", "index.ts");
    const mock = createMockPi({
      allTools: [tool("mcp__tracker__search_issues", "Search issues")],
      mcpServers: [{ name: "tracker", config: { url: "https://tracker.example/mcp" }, extensionPath }],
    });
    mock.pi.events = { emit() {}, on: () => () => {} };
    const dims = [];
    const context = createMockExtensionContext({ hasUI: true, cwd: agentDir });
    const keys = createMmrTuiKeys(mock.pi, { onPaletteOpen: (open) => dims.push(open) });
    keys.start(context.ctx, () => undefined);

    registry.getMmrCommand("mcp.info").run(context.ctx);
    const view = context.overlays.at(-1).component;
    const servers = plain(view.render(76));
    assert.match(servers[0], /^╭─ MCP Servers ─+╮$/);
    assert.match(servers[4], /^│ tracker {2}connected {2}1 tool {2}codemode {2}~\/extensions\/tracker\/index\.ts +│$/);
    assert.ok(servers.some((line) => line.includes("MCP support is off")), "the stub registers no /mcp");
    view.handleInput("\t");
    assert.match(plain(view.render(76))[5], /^│ {3}search_issues {2}Search issues +│$/);
    assert.deepEqual(dims, [true]);
    view.handleInput("\x1b");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(dims, [true, false]);
    keys.stop();
  });
});
