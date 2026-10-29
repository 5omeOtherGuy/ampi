// ampi-permissions: the tool_call gate, its settings and project trust, the
// approval dialog, runs without UI, and the approval status it drives.
// Delegate programs and subagent children have their own suites
// (mmr-permissions-delegate, mmr-permissions-subagents).
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi, markAmpiCoreLoaded } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);
before(markAmpiCoreLoaded);

const repoRoot = path.resolve(import.meta.dirname, "..");
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

let extension;
let gate;
let rules;
let runtime;

before(async () => {
  extension = await importSource("extensions/ampi-permissions/index.ts");
  gate = await importSource("extensions/ampi-permissions/gate.ts");
  rules = await importSource("extensions/ampi-core/permissions.ts");
  runtime = await importSource("extensions/ampi-core/runtime.ts");
});

afterEach(() => {
  rules.setMmrPermissionsSessionAllowAll(false);
  runtime.setMmrSubagentState(undefined);
  runtime.setMmrModeState(undefined);
});

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "ampi-permissions-"));
  dirs.push(dir);
  return dir;
}

/** A Pi event bus that delivers to subscribers and records every emission. */
function createBus() {
  const listeners = new Map();
  const emitted = [];
  return {
    emitted,
    on(name, handler) {
      const set = listeners.get(name) ?? new Set();
      set.add(handler);
      listeners.set(name, set);
      return () => set.delete(handler);
    },
    off() {},
    emit(name, data) {
      emitted.push({ name, data });
      for (const handler of [...(listeners.get(name) ?? [])]) handler(data);
    },
  };
}

const ON = { ampi: { permissions: [] } };

/**
 * Load the extension against a temp agent dir (user settings) and a temp
 * project. `answers` are what the dialog returns, in order; a function
 * answer is called with the select arguments.
 */
async function setup({ user, project, trusted = true, hasUI = true, answers = [], feedback = [], columns = 80 } = {}) {
  const agentDir = tempDir();
  const userFile = path.join(agentDir, "settings.json");
  if (user !== undefined) writeFileSync(userFile, typeof user === "string" ? user : JSON.stringify(user));
  const cwd = tempDir();
  const projectFile = path.join(cwd, ".pi", "settings.json");
  if (project !== undefined) {
    mkdirSync(path.dirname(projectFile));
    writeFileSync(projectFile, JSON.stringify(project));
  }

  const mock = createMockPi();
  const bus = createBus();
  mock.pi.events = bus;
  const context = createMockExtensionContext({ cwd, hasUI, projectTrusted: trusted });
  const controller = new AbortController();
  context.ctx.signal = controller.signal;
  const selects = [];
  const inputs = [];
  context.ctx.ui.select = async (title, options, opts) => {
    selects.push({ title, options, opts });
    const answer = answers.shift();
    return typeof answer === "function" ? answer({ title, options, opts, controller }) : answer;
  };
  context.ctx.ui.input = async (title, placeholder, opts) => {
    inputs.push({ title, placeholder, opts });
    return feedback.shift();
  };
  extension.createMmrPermissionsExtension({ agentDir: () => agentDir, columns: () => columns })(mock.pi);

  const start = (reason = "startup") => mock.handlers.get("session_start")({ type: "session_start", reason }, context.ctx);
  await start();
  let next = 0;
  const call = (toolName, input, extra = {}) =>
    mock.handlers.get("tool_call")({ type: "tool_call", toolCallId: `call-${++next}`, toolName, input, ...extra }, context.ctx);
  const gateStatus = () => runtime.resolveMmrFeatureGates(["ampi-permissions"])[0];
  return { mock, bus, ctx: context.ctx, notifications: context.notifications, selects, inputs, call, start, userFile, projectFile, controller, gateStatus };
}

const push = { command: "git push origin main" };

describe("ampi-permissions: turning it on", () => {
  it("is inert without ampi.permissions or ampi.dangerouslyAllowAll: false", async () => {
    for (const user of [undefined, {}, { ampi: { dangerouslyAllowAll: true } }, { ampi: { tools: { disable: [] } } }]) {
      const t = await setup({ user });
      assert.equal(await t.call("bash", { command: "rm -rf build" }), undefined, JSON.stringify(user));
      assert.equal(t.selects.length, 0);
      assert.equal(t.gateStatus().status, "disabled");
      assert.match(t.gateStatus().reason, /^off; set ampi\.permissions/);
    }
  });

  it("turns on for ampi.permissions, any value, or ampi.dangerouslyAllowAll: false, and counts the rules per source", async () => {
    const { MMR_PERMISSIONS_DEFAULT_RULES } = await importSource("extensions/ampi-core/permission-defaults.ts");
    const t = await setup({
      user: { ampi: { permissions: [{ tool: "read", action: "allow" }, { tool: "edit", action: "ask" }] } },
      project: { ampi: { permissions: [{ tool: "write", action: "reject" }] } },
    });
    assert.deepEqual(t.gateStatus(), {
      gate: "ampi-permissions",
      status: "enabled",
      reason: `on: 1 project rule, 2 user rules, ${MMR_PERMISSIONS_DEFAULT_RULES.length} default rules, 0 guarded file allowlist entries`,
      source: "ampi-permissions",
    });
    const off = await setup({ user: { ampi: { dangerouslyAllowAll: false } } });
    assert.equal(off.gateStatus().status, "enabled");
    assert.equal((await off.call("bash", push)).block, true, "the stub dialog's empty answer is a dismissal");
    assert.equal(off.selects.length, 1);
  });

  it("lets a trusted project turn it on, since that only tightens", async () => {
    const t = await setup({ project: { ampi: { dangerouslyAllowAll: false } } });
    await t.call("bash", push);
    assert.equal(t.selects.length, 1);
  });

  it("allows everything when the user set ampi.dangerouslyAllowAll: true", async () => {
    const t = await setup({ user: { ampi: { permissions: [], dangerouslyAllowAll: true } } });
    assert.equal(await t.call("bash", push), undefined);
    assert.equal(t.selects.length, 0);
    assert.match(t.gateStatus().reason, /ampi\.dangerouslyAllowAll is true/);
  });

  it("loads after ampi-custom-subagents and before ampi-tui", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const order = pkg.pi.extensions;
    const own = order.indexOf("./src/extensions/ampi-permissions/index.ts");
    assert.equal(order[own - 1], "./src/extensions/ampi-custom-subagents/index.ts");
    assert.equal(order[own + 1], "./src/extensions/ampi-tui/index.ts");
    assert.equal(pkg.exports["./extensions/ampi-permissions"], "./src/extensions/ampi-permissions/index.ts");
    assert.equal(pkg.exports["./extensions/mmr-permissions"], "./src/extensions/ampi-permissions/index.ts");
  });
});

describe("ampi-permissions: the approval dialog", () => {
  it("asks with a summary title and the four options; Allow Once lets this call run and asks again next time", async () => {
    const t = await setup({ user: ON, answers: ["Allow Once", "Allow Once"] });
    assert.equal(await t.call("bash", push), undefined);
    assert.equal(t.selects[0].title, "Approval Required\nTool: bash\ngit push origin main");
    assert.deepEqual(t.selects[0].options, ["Allow Once", "Reject with feedback", "Allow All for This Session", "Allow All for Every Session"]);
    assert.equal(t.selects[0].opts.signal, t.ctx.signal);
    assert.equal(await t.call("bash", push), undefined);
    assert.equal(t.selects.length, 2);
    assert.equal(await t.call("bash", { command: "git status" }), undefined, "the defaults allow it");
    assert.equal(t.selects.length, 2);
  });

  it("Reject with feedback blocks with the user's words; empty feedback is a plain rejection", async () => {
    const t = await setup({ user: ON, answers: ["Reject with feedback", "Reject with feedback"], feedback: ["push to a branch instead", "  "] });
    assert.deepEqual(await t.call("bash", push), { block: true, reason: "The user rejected this tool call and said: push to a branch instead" });
    assert.equal(t.inputs[0].title, "What should the agent do instead?");
    assert.equal(t.inputs[0].opts.signal, t.ctx.signal);
    assert.deepEqual(await t.call("bash", push), { block: true, reason: "The user rejected this tool call." });
  });

  it("Allow All for This Session stops asking until a new session; a reload keeps it", async () => {
    const t = await setup({ user: ON, answers: ["Allow All for This Session", "Allow Once"] });
    assert.equal(await t.call("bash", push), undefined);
    assert.equal(rules.isMmrPermissionsSessionAllowAll(), true);
    assert.equal(await t.call("bash", { command: "rm -rf build" }), undefined);
    assert.equal(t.selects.length, 1);
    assert.match(t.gateStatus().reason, /every tool call is allowed for this session/);
    await t.start("reload");
    assert.equal(await t.call("bash", push), undefined);
    assert.equal(t.selects.length, 1);
    await t.start("new");
    assert.equal(rules.isMmrPermissionsSessionAllowAll(), false);
    await t.call("bash", push);
    assert.equal(t.selects.length, 2);
  });

  it("Allow All for Every Session saves ampi.dangerouslyAllowAll: true and keeps every other key", async () => {
    const user = { theme: "dark", ampi: { permissions: [], tools: { disable: ["x"] } }, packages: ["a"] };
    const t = await setup({ user, answers: ["Allow All for Every Session"] });
    assert.equal(await t.call("bash", push), undefined);
    assert.deepEqual(JSON.parse(readFileSync(t.userFile, "utf8")), {
      theme: "dark",
      ampi: { permissions: [], tools: { disable: ["x"] }, dangerouslyAllowAll: true },
      packages: ["a"],
    });
    assert.deepEqual(t.notifications.at(-1), {
      message: `Saved ampi.dangerouslyAllowAll: true to ${t.userFile}; tool calls no longer ask for approval.`,
      level: "info",
    });
    assert.match(t.gateStatus().reason, /ampi\.dangerouslyAllowAll is true/, "the settings were read again");
    assert.equal(await t.call("bash", { command: "rm -rf build" }), undefined);
    assert.equal(t.selects.length, 1);
  });

  it("leaves a symlinked user settings file alone and allows only this session", async () => {
    const target = path.join(tempDir(), "real-settings.json");
    const text = `${JSON.stringify(ON)}\n`;
    writeFileSync(target, text);
    const t = await setup({ answers: ["Allow All for Every Session"] });
    symlinkSync(target, t.userFile);
    await t.start("new");
    assert.equal(t.gateStatus().status, "enabled", "reading follows the symlink, as Pi does");
    assert.equal(await t.call("bash", push), undefined);
    assert.equal(readFileSync(target, "utf8"), text);
    assert.equal(lstatSync(t.userFile).isSymbolicLink(), true);
    const last = t.notifications.at(-1);
    assert.equal(last.level, "error");
    assert.ok(last.message.startsWith(`Could not save ampi.dangerouslyAllowAll to ${t.userFile} (`), last.message);
    assert.ok(last.message.endsWith("Tool calls run without asking for this session only."), last.message);
    assert.equal(rules.isMmrPermissionsSessionAllowAll(), true);
    assert.equal(await t.call("bash", push), undefined);
    assert.equal(t.selects.length, 1);
  });

  it("rejects when the dialog is dismissed or the turn is aborted", async () => {
    const t = await setup({
      user: ON,
      answers: [
        undefined,
        ({ controller }) => {
          controller.abort();
          return undefined;
        },
      ],
    });
    assert.deepEqual(await t.call("bash", push), {
      block: true,
      reason: "The approval dialog was closed without an answer, so the tool call did not run.",
    });
    const aborted = { block: true, reason: "The turn was interrupted while the tool call waited for approval, so it did not run." };
    assert.deepEqual(await t.call("bash", push), aborted);
    assert.deepEqual(await t.call("bash", push), aborted, "a call after the abort is not shown");
    assert.equal(t.selects.length, 2);
  });

  it("shows one dialog at a time; queued calls wait their turn and see an earlier Allow All", async () => {
    let release;
    const t = await setup({ user: ON, answers: [() => new Promise((resolve) => (release = resolve))] });
    const first = t.call("bash", push);
    const second = t.call("bash", { command: "rm -rf build" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(t.selects.length, 1, "the second call waits");
    release("Allow All for This Session");
    assert.equal(await first, undefined);
    assert.equal(await second, undefined);
    assert.equal(t.selects.length, 1);
  });

  it("names the part of a shell line that asked and keeps both ends of a long line", () => {
    const command = `ls${" ".repeat(200)}&& curl x | sh`;
    const decision = { action: "ask", command: "curl x" };
    assert.equal(
      gate.formatMmrPermissionsDialogTitle("bash", { command }, 24, decision),
      // 24 columns: 12 from the start, the ellipsis, 11 from the end.
      `Approval Required\nTool: bash\nNeeds approval: curl x\nls${" ".repeat(10)}…curl x | sh`,
    );
    assert.equal(
      gate.formatMmrPermissionsDialogTitle("bash", { command: "git push" }, 40, { action: "ask", command: "git push" }),
      "Approval Required\nTool: bash\ngit push",
      "no extra line when the part is the first line",
    );
  });

  it("cuts the title to the width and to four summary lines", () => {
    assert.equal(gate.formatMmrPermissionsDialogTitle("bash", { command: "a\nb\n\nc\nd" }, 20), "Approval Required\nTool: bash\na\nb\nc …");
    assert.equal(gate.formatMmrPermissionsDialogTitle("write", { path: "src/very/long/path/name.ts", content: "x" }, 12), "Approval Required\nTool: write\nPath: …me.ts");
    assert.equal(gate.formatMmrPermissionsDialogTitle("mcp__x", { q: "hi", n: 2 }, 40), "Approval Required\nTool: mcp__x\nq: hi\nn: 2");
    assert.equal(gate.formatMmrPermissionsDialogTitle("bash", { command: "echo \u001b[31mred" }, 40), "Approval Required\nTool: bash\necho  [31mred");
  });
});

describe("ampi-permissions: rules from settings", () => {
  it("blocks a rejected call with the rule's message or the rule's text", async () => {
    const t = await setup({
      user: {
        ampi: {
          permissions: [
            { tool: "bash", matches: { command: "rm *" }, action: "reject", message: "Use the clean script." },
            { tool: "read", matches: { path: "*.env" }, action: "reject" },
          ],
        },
      },
    });
    assert.deepEqual(await t.call("bash", { command: "ls && rm -rf build" }), { block: true, reason: "Use the clean script." });
    assert.deepEqual(await t.call("read", { path: "prod.env" }), {
      block: true,
      reason: 'The read call was rejected by the permissions rule "reject read --path \'*.env\'".',
    });
    assert.equal(t.selects.length, 0);
  });

  it("blocks a call that needs approval in a run without UI", async () => {
    const t = await setup({ user: ON, hasUI: false });
    const expected =
      "The bash call needs the user's approval, and this run cannot ask for it. " +
      'The permissions rule "ask bash" asks for approval (for "git push origin main"). ' +
      "An allow rule in ampi.permissions lets such calls run without asking. " +
      "To let every tool call run, repeat the run with --dangerously-allow-all (the ampi command) or --ampi-dangerously-allow-all (pi).";
    assert.deepEqual(await t.call("bash", push), { block: true, reason: expected });
    assert.equal(t.bus.emitted.length, 0, "no approval status without a dialog");
  });

  it("fails closed when ampi.permissions is not a list: every call asks", async () => {
    const t = await setup({ user: { ampi: { permissions: { tool: "bash", action: "allow" } } }, hasUI: false });
    const reason = `ampi.permissions in ${t.userFile} is not a list of rules`;
    assert.deepEqual(t.notifications, [{ message: `ampi-permissions:\n${reason}, so every tool call asks for approval until it is fixed.`, level: "warning" }]);
    const result = await t.call("read", { path: "a.txt" });
    assert.equal(result.block, true);
    assert.ok(result.reason.includes(`It needs approval because ${reason}.`), result.reason);
    assert.match(t.gateStatus().reason, /every tool call asks because/);
  });

  it("skips an invalid rule with one warning per session and keeps the valid ones", async () => {
    const t = await setup({ user: { ampi: { permissions: [{ tool: "bash", action: "permit" }, { tool: "read", action: "reject" }] } } });
    assert.deepEqual(t.notifications, [
      {
        message: `ampi-permissions:\nSkipping ampi.permissions[0] in ${t.userFile}: action must be allow, reject, ask or delegate (got "permit").`,
        level: "warning",
      },
    ]);
    assert.equal((await t.call("read", { path: "a" })).block, true);
    await t.call("read", { path: "b" });
    assert.equal(t.notifications.length, 1, "tool calls do not warn again");
  });

  it("ignores an untrusted project's rules", async () => {
    const project = { ampi: { permissions: [{ tool: "read", action: "reject" }] } };
    const untrusted = await setup({ user: ON, project, trusted: false });
    assert.equal(await untrusted.call("read", { path: "a" }), undefined);
    const trusted = await setup({ user: ON, project });
    assert.equal((await trusted.call("read", { path: "a" })).block, true);
  });

  it("lets a project only tighten: its allow and delegate rules and dangerouslyAllowAll are ignored with a warning", async () => {
    const t = await setup({
      user: ON,
      project: {
        ampi: {
          dangerouslyAllowAll: true,
          permissions: [
            { tool: "bash", matches: { command: "git push*" }, action: "allow" },
            { tool: "bash", action: "delegate", to: "x" },
            { tool: "write", action: "ask" },
          ],
        },
      },
    });
    assert.deepEqual(t.notifications, [
      {
        message: [
          "ampi-permissions:",
          `Ignoring ampi.dangerouslyAllowAll in ${t.projectFile}: project settings can only add restrictions.`,
          `Ignoring 2 allow or delegate rules in ${t.projectFile}: project settings can only add reject and ask rules.`,
        ].join("\n"),
        level: "warning",
      },
    ]);
    await t.call("bash", push);
    await t.call("write", { path: "a", content: "" });
    assert.equal(t.selects.length, 2, "the push still asks, and the project's ask rule applies");
  });
});

describe("ampi-permissions: where the gate applies", () => {
  it("gates calls in Free mode, and /ampi-status lists it there", async () => {
    const { createMmrModeState } = await importSource("extensions/ampi-core/state.ts");
    const { getMmrMode } = await importSource("extensions/ampi-core/modes.ts");
    const { formatMmrStatus } = await importSource("extensions/ampi-core/status.ts");
    const tools = { requestedTools: [], activeTools: ["bash"], missingTools: [], deferredTools: [], gatedTools: [], disabledTools: [], decisions: [] };
    const modelResolution = { requestedModels: [], modelFound: false, modelApplied: false, fallbackApplied: false, candidates: [] };
    const free = createMmrModeState({ mode: getMmrMode("free"), source: "command", modelResolution, tools });
    runtime.setMmrModeState(free);
    const t = await setup({ user: ON });
    await t.call("bash", push);
    assert.equal(t.selects.length, 1);
    const line = `Permissions: enabled via ampi-permissions (${t.gateStatus().reason})`;
    const status = formatMmrStatus(free, { permissions: t.gateStatus() });
    assert.ok(status.split("\n").includes(line), status);
    assert.equal(formatMmrStatus(undefined, { permissions: t.gateStatus() }), `MMR mode has not been resolved yet.\n${line}`);
  });

  it("gates a nested call another tool made", async () => {
    const t = await setup({ user: ON });
    await t.call("bash", push, { toolCallId: "parent-1/1", parentToolCallId: "parent-1" });
    assert.equal(t.selects.length, 1);
    assert.deepEqual(t.bus.emitted.map((event) => event.data), [
      { phase: "request", requestId: "parent-1/1" },
      { phase: "answer", requestId: "parent-1/1" },
    ]);
  });
});

describe("ampi-permissions: approval status", () => {
  it("drives the prompt box's status feed and the web GUI bridge to Waiting for Approval and back", async () => {
    const { createMmrStatusFeed } = await importSource("extensions/ampi-tui/editor/status-feed.ts");
    const { createMmrGuiBridge } = await importSource("extensions/ampi-gui/bridge.ts");
    let release;
    const t = await setup({ user: ON, answers: [() => new Promise((resolve) => (release = resolve))] });
    const feed = createMmrStatusFeed(t.mock.pi, { now: () => 0 });
    feed.reset(t.ctx);
    const bridge = createMmrGuiBridge(t.mock.pi, { now: () => 0, home: "/home/u" });
    bridge.start(t.ctx);
    const fire = (name, event) => t.mock.handlers.get(name)({ type: name, ...event }, t.ctx);
    await fire("turn_start", {});
    await fire("tool_execution_start", { toolCallId: "call-1", toolName: "bash", args: push });
    assert.equal(feed.status.phase, "runningTools");

    const pending = t.call("bash", push);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(feed.status.phase, "waitingApproval");
    assert.equal(feed.status.label, "Waiting for Approval");
    assert.equal(bridge.status().phase, "waitingApproval");

    release("Allow Once");
    await pending;
    assert.equal(feed.status.phase, "runningTools");
    assert.equal(bridge.status().phase, "runningTools");
    bridge.stop();
  });
});
