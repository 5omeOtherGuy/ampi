// `ampi.tools.disable`: the matcher, the settings it is read from, the
// active-tool sets ampi-core applies, the tool_call gate and /ampi-status.
// The last suite checks the tool sources the installed Pi reports, which the
// `builtin:` entries rely on.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const SMART_MODEL = { provider: "claude-subscription", id: "claude-opus-4-8" };
const WORKER_MODEL = { provider: "openai-codex", id: "gpt-5.4-mini" };

const builtin = (name) => ({ name, sourceInfo: { path: `builtin:${name}` } });
const extensionTool = (name) => ({ name, sourceInfo: { path: "/ext/tools/index.ts" } });
const MCP_TOOL = { name: "mcp__x__lookup", sourceInfo: { path: "builtin:mcp" } };
const CODEMODE_TOOL = { name: "codemode", sourceInfo: { path: "builtin:codemode" } };
const TOOL_SEARCH_TOOL = { name: "tool_search", sourceInfo: { path: "builtin:tool-search" } };

async function importRuntime() {
  return import(pathToFileURL(path.join(getPreparedSourceRoot(), "extensions/ampi-core/runtime.ts")).href);
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

/** A temporary home and project with `ampi.tools.disable` set in each settings file. */
function makeWorkspace(t, { user, project } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ampi-tools-disable-"));
  const home = path.join(dir, "home");
  const cwd = path.join(dir, "project");
  mkdirSync(cwd, { recursive: true });
  if (user !== undefined) writeJson(path.join(home, ".pi/agent/settings.json"), { ampi: { tools: { disable: user } } });
  if (project !== undefined) writeJson(path.join(cwd, ".pi/settings.json"), { ampi: { tools: { disable: project } } });
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(dir, { recursive: true, force: true });
  });
  return { home, cwd };
}

describe("ampi.tools.disable matcher", () => {
  it("matches exact names and * globs over tool names", async () => {
    const { createMmrToolDisableMatcher } = await importSource("extensions/ampi-core/tool-disable.ts");
    const matcher = createMmrToolDisableMatcher(["web_search", "task_*", "mcp__x__*"]);
    assert.equal(matcher.match({ name: "web_search" }), "web_search");
    assert.equal(matcher.match({ name: "web_search_2" }), undefined, "an exact name is not a prefix");
    assert.equal(matcher.match({ name: "task_list" }), "task_*");
    assert.equal(matcher.match({ name: "start_task" }), undefined, "task_* does not match start_task");
    assert.equal(matcher.match(MCP_TOOL), "mcp__x__*");
    assert.equal(matcher.match({ name: "mcp__y__lookup" }), undefined);
  });

  it("matches builtin: entries only against Pi's own built-in tools", async () => {
    const { createMmrToolDisableMatcher } = await importSource("extensions/ampi-core/tool-disable.ts");
    const grepOnly = createMmrToolDisableMatcher(["builtin:grep"]);
    assert.equal(grepOnly.match(builtin("grep")), "builtin:grep");
    assert.equal(grepOnly.match(extensionTool("grep")), undefined, "an extension tool named grep stays on");
    assert.equal(grepOnly.match({ name: "grep" }), undefined, "a tool without a known source stays on");

    const every = createMmrToolDisableMatcher(["builtin:*"]);
    assert.equal(every.match(builtin("read")), "builtin:*");
    assert.equal(every.match(builtin("ls")), "builtin:*");
    for (const tool of [MCP_TOOL, CODEMODE_TOOL, TOOL_SEARCH_TOOL, extensionTool("bash")]) {
      assert.equal(every.match(tool), undefined, `${tool.name} from ${tool.sourceInfo.path} is not a Pi built-in tool`);
    }
  });

  it("reports the first entry that matches", async () => {
    const { createMmrToolDisableMatcher } = await importSource("extensions/ampi-core/tool-disable.ts");
    const matcher = createMmrToolDisableMatcher(["builtin:g*", "grep"]);
    assert.equal(matcher.match(builtin("grep")), "builtin:g*");
    assert.equal(matcher.match(extensionTool("grep")), "grep");
  });
});

describe("ampi.tools.disable settings", () => {
  it("combines the user and project lists and warns about entries it skips", async (t) => {
    const { loadMmrCoreSettings } = await importSource("extensions/ampi-core/settings.ts");
    const { home, cwd } = makeWorkspace(t, {
      user: ["web_search", "  task_*  ", 7, "", "builtin:", "bad[z-a]", "web_search"],
      project: ["task_*", "builtin:grep"],
    });

    const { settings, warnings } = loadMmrCoreSettings(cwd, home);

    assert.deepEqual(settings.toolsDisable, ["web_search", "task_*", "builtin:grep"]);
    const userFile = path.join(home, ".pi/agent/settings.json");
    assert.deepEqual(warnings, [
      `Ignoring ampi.tools.disable[2] in ${userFile}: expected a tool name, a glob, or builtin:<name>.`,
      `Ignoring ampi.tools.disable[3] in ${userFile}: expected a tool name, a glob, or builtin:<name>.`,
      `Ignoring ampi.tools.disable[4] in ${userFile}: unsupported glob pattern \`builtin:\`: no tool name after builtin:.`,
      `Ignoring ampi.tools.disable[5] in ${userFile}: unsupported glob pattern \`bad[z-a]\`: character class range is out of order.`,
    ]);
  });

  it("warns when the value is not a list", async (t) => {
    const { loadMmrCoreSettings } = await importSource("extensions/ampi-core/settings.ts");
    const { home, cwd } = makeWorkspace(t, { project: "web_search" });
    const { settings, warnings } = loadMmrCoreSettings(cwd, home);
    assert.equal(settings.toolsDisable, undefined);
    assert.deepEqual(warnings, [
      `Ignoring ampi.tools.disable in ${path.join(cwd, ".pi/settings.json")}: expected an array of tool names, globs, or builtin:<name> entries.`,
    ]);
  });
});

describe("ampi.tools.disable in ampi-core sessions", () => {
  beforeEach(async () => {
    const runtime = await importRuntime();
    runtime.setMmrModeState(undefined);
    runtime.setMmrSubagentState(undefined);
  });

  const SMART_TOOLS = [
    builtin("read"),
    builtin("bash"),
    builtin("write"),
    builtin("edit"),
    builtin("grep"),
    extensionTool("web_search"),
    extensionTool("task_list"),
    extensionTool("task_poll"),
    extensionTool("start_task"),
    MCP_TOOL,
  ];

  async function startSession(t, disable, piOptions = {}) {
    const { cwd } = makeWorkspace(t, { user: disable });
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const mock = createMockPi({ activeTools: ["read", "bash", "grep"], allTools: SMART_TOOLS, ...piOptions });
    const context = createMockExtensionContext({ models: [SMART_MODEL, WORKER_MODEL], cwd });
    extension(mock.pi);
    await mock.handlers.get("session_start")({ type: "session_start", reason: "new" }, context.ctx);
    return { ...mock, ...context };
  }

  it("leaves disabled tools out of a locked mode and reports them as disabled", async (t) => {
    const runtime = await importRuntime();
    const { calls } = await startSession(t, ["web_search", "task_*", "builtin:bash"]);

    const state = runtime.getMmrModeState();
    assert.equal(state.mode, "medium");
    const applied = calls.setActiveTools.at(-1);
    for (const name of ["read", "write", "edit", "start_task"]) assert.ok(applied.includes(name), `${name} stays on`);
    for (const name of ["web_search", "task_list", "task_poll", "bash"]) assert.ok(!applied.includes(name), `${name} is off`);
    assert.deepEqual(state.activeTools, applied);

    // task_wait and task_cancel are not registered: disabled, never missing or deferred.
    for (const name of ["web_search", "task_list", "task_poll", "task_wait", "task_cancel", "bash"]) {
      assert.ok(state.disabledTools.includes(name), `${name} is listed as disabled`);
    }
    for (const bucket of ["missingTools", "deferredTools", "gatedTools"]) {
      assert.ok(!state[bucket].some((name) => name.startsWith("task_") && name !== "task_list"), `no task_* tool in ${bucket}`);
    }
    const waitDecision = state.resolution.toolDecisions.find((decision) => decision.requested === "task_wait");
    assert.equal(waitDecision.status, "disabled");
    assert.equal(waitDecision.diagnostic, 'task_wait: turned off by ampi.tools.disable entry "task_*"');
  });

  it("still activates a mode whose every tool is disabled", async (t) => {
    const runtime = await importRuntime();
    const { calls, notifications } = await startSession(t, ["*"]);
    const state = runtime.getMmrModeState();
    assert.equal(state.mode, "medium");
    assert.equal(state.modelApplied, true);
    assert.deepEqual(calls.setActiveTools.at(-1), []);
    assert.equal(notifications.find((note) => note.level === "error"), undefined);
  });

  it("leaves disabled tools out when free mode restores Pi's tools", async (t) => {
    const runtime = await importRuntime();
    const { calls, commands, ctx } = await startSession(t, ["builtin:grep"]);
    await commands.get("mode").handler("free", ctx);
    assert.equal(runtime.getMmrModeState().mode, "free");
    assert.deepEqual(calls.setActiveTools.at(-1), ["read", "bash"]);
  });

  it("leaves disabled tools out of a subagent worker's tools", async (t) => {
    const { cwd } = makeWorkspace(t, { user: ["builtin:grep"] });
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const { pi, handlers, calls } = createMockPi({
      activeTools: ["grep", "find", "read"],
      allTools: [builtin("grep"), builtin("find"), builtin("read")],
      flags: { "ampi-subagent": "finder" },
    });
    const { ctx } = createMockExtensionContext({ models: [WORKER_MODEL], cwd });
    extension(pi);
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    assert.deepEqual(calls.setActiveTools, [["find", "read"]]);

    const blocked = await handlers.get("tool_call")({ type: "tool_call", toolName: "grep", toolCallId: "w1", input: {} });
    assert.equal(blocked?.block, true, "the gate holds in workers too");
  });

  it("blocks calls to disabled tools, nested calls included, and lets others through", async (t) => {
    const { handlers } = await startSession(t, ["web_search", "mcp__x__*"]);
    const toolCall = handlers.get("tool_call");

    const direct = await toolCall({ type: "tool_call", toolName: "web_search", toolCallId: "c1", input: {} });
    assert.deepEqual(direct, {
      block: true,
      reason: 'Tool "web_search" is turned off by the ampi.tools.disable setting (entry "web_search").',
    });
    const nested = await toolCall({ type: "tool_call", toolName: "mcp__x__lookup", toolCallId: "c2/1", parentToolCallId: "c2", input: {} });
    assert.equal(nested?.block, true);
    assert.match(nested.reason, /ampi\.tools\.disable setting \(entry "mcp__x__\*"\)/);
    assert.equal(await toolCall({ type: "tool_call", toolName: "read", toolCallId: "c3", input: {} }), undefined);
  });

  it("keeps blocking in free mode", async (t) => {
    const { handlers, commands, ctx } = await startSession(t, ["builtin:grep"]);
    await commands.get("mode").handler("free", ctx);
    const blocked = await handlers.get("tool_call")({ type: "tool_call", toolName: "grep", toolCallId: "c1", input: {} });
    assert.equal(blocked?.block, true);
    assert.equal(await handlers.get("tool_call")({ type: "tool_call", toolName: "read", toolCallId: "c2", input: {} }), undefined);
  });

  it("lists each disabled tool in /ampi-status with the entry that matched", async (t) => {
    const { commands, ctx, notifications } = await startSession(t, ["web_search", "builtin:grep", "mcp__x__*"]);
    await commands.get("ampi-status").handler("", ctx);
    const status = notifications.at(-1).message;
    assert.ok(
      status.includes(
        [
          "Turned off by ampi.tools.disable:",
          '  - grep (disabled) by "builtin:grep"',
          '  - web_search (disabled) by "web_search"',
          '  - mcp__x__lookup (disabled) by "mcp__x__*"',
        ].join("\n"),
      ),
      status,
    );
    assert.match(status, /^Disabled tools: web_search$/m);
    assert.match(status, /- web_search -> disabled \(disabled\) via ampi-web\n {6}web_search: turned off by ampi\.tools\.disable entry "web_search"/);
    assert.doesNotMatch(status, /^Missing tools: .*web_search/m);
  });

  it("adds no status rows when nothing is disabled", async (t) => {
    const { commands, ctx, notifications } = await startSession(t, undefined);
    await commands.get("ampi-status").handler("", ctx);
    assert.doesNotMatch(notifications.at(-1).message, /Turned off by/);
  });
});

describe("tool sources reported by the installed Pi", () => {
  /** Pi's coding-agent dist directory; the package entry is dist/index.js. */
  const piDist = () => path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  const saved = {};

  beforeEach(() => {
    saved.home = process.env.HOME;
    saved.offline = process.env.PI_OFFLINE;
    process.env.PI_OFFLINE = "1";
  });
  afterEach(() => {
    for (const [name, value] of [["HOME", saved.home], ["PI_OFFLINE", saved.offline]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("names Pi's built-in tools as ampi does", async () => {
    const { allToolNames } = await import(pathToFileURL(path.join(piDist(), "core/tools/index.js")).href);
    const { PI_BUILTIN_TOOL_NAMES } = await importSource("extensions/ampi-core/tool-disable.ts");
    assert.deepEqual([...allToolNames].sort(), [...PI_BUILTIN_TOOL_NAMES].sort(), "Pi changed its built-in tools; update PI_BUILTIN_TOOL_NAMES");
  });

  it("gives built-in tools builtin:<name> and built-in extension tools builtin:<extension>", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ampi-tool-sources-"));
    process.env.HOME = dir;
    try {
      const { builtInExtensions } = await import(pathToFileURL(path.join(piDist(), "extensions/index.js")).href);
      assert.ok(builtInExtensions.some((extension) => extension.name === "mcp"), "MCP tools come from the built-in extension named mcp");
      let api;
      const replaceGrep = (pi) => {
        api = pi;
        pi.registerTool({
          name: "grep",
          label: "grep",
          description: "An extension tool that replaces Pi's grep.",
          parameters: { type: "object", properties: {} },
          execute: async () => ({ content: [] }),
        });
      };
      const settingsManager = SettingsManager.create(dir, dir);
      const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, extensionFactories: [...builtInExtensions, replaceGrep] });
      await resourceLoader.reload();
      const { session } = await createAgentSession({
        cwd: dir,
        agentDir: dir,
        settingsManager,
        resourceLoader,
        sessionManager: SessionManager.inMemory(dir),
        tools: ["read", "bash", "grep", "find", "codemode", "tool_search"],
      });
      await session.bindExtensions({});

      const sources = Object.fromEntries(api.getAllTools().map((tool) => [tool.name, tool.sourceInfo.path]));
      assert.equal(sources.read, "builtin:read");
      assert.equal(sources.find, "builtin:find");
      assert.equal(sources.codemode, "builtin:codemode", "codemode's extension path equals builtin:<tool name>");
      assert.equal(sources.tool_search, "builtin:tool-search");
      assert.doesNotMatch(sources.grep, /^builtin:/, "the replacing extension tool keeps its own source");

      const { createMmrToolDisableMatcher, listMmrDisabledTools } = await importSource("extensions/ampi-core/tool-disable.ts");
      const disabled = listMmrDisabledTools(createMmrToolDisableMatcher(["builtin:*"]), api.getAllTools()).map((row) => row.tool);
      assert.deepEqual(disabled.sort(), ["bash", "find", "read"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
