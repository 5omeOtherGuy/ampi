// A loaded ampi-permissions extension against temporary settings files, for
// the delegate, subagent and guarded file suites: mock Pi, an event bus that records
// approval events, a dialog that answers from a list, and an optional
// subagent state set before session_start, as ampi-core does in a child.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { importSource } from "./load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./pi-stub.mjs";

export const TASK_CHILD_STATE = Object.freeze({
  profile: "task-subagent",
  provider: "faux",
  model: "faux-1",
  thinkingLevel: "minimal",
  promptRoute: "standalone",
  activeTools: ["bash", "edit", "write"],
  activatedAt: "2026-10-19T00:00:00.000Z",
});

/** Temporary directories, removed by `removeTempDirs`. */
const dirs = [];

export function tempDir(prefix = "ampi-permissions-") {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

export function removeTempDirs() {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** The modules a suite needs, each loaded once. */
export async function loadPermissionModules() {
  return {
    extension: await importSource("extensions/ampi-permissions/index.ts"),
    rules: await importSource("extensions/ampi-core/permissions.ts"),
    runtime: await importSource("extensions/ampi-core/runtime.ts"),
  };
}

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

/**
 * Load the extension. `user` and `project` are the settings objects written
 * to the agent directory and `<cwd>/.pi/settings.json` (`userText` is written
 * as it is, for a user settings file that is no JSON object); `answers` are what
 * the dialog returns, in order; `subagent` makes this session a child.
 */
export async function setupPermissions(modules, options = {}) {
  const { user, userText, project, trusted = true, hasUI = true, answers = [], subagent = false, overrides = {} } = options;
  const agentDir = tempDir();
  if (user !== undefined) writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(user));
  if (userText !== undefined) writeFileSync(path.join(agentDir, "settings.json"), userText);
  const cwd = options.cwd ?? tempDir();
  if (project !== undefined) {
    mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify(project));
  }

  const mock = createMockPi();
  const bus = createBus();
  mock.pi.events = bus;
  const context = createMockExtensionContext({ cwd, hasUI, projectTrusted: trusted });
  const controller = new AbortController();
  context.ctx.signal = controller.signal;
  const selects = [];
  context.ctx.ui.select = async (title, choices) => {
    selects.push({ title, choices });
    return answers.shift();
  };
  modules.extension.createMmrPermissionsExtension({ agentDir: () => agentDir, columns: () => 80, ...overrides })(mock.pi);

  modules.runtime.setMmrSubagentState(subagent ? TASK_CHILD_STATE : undefined);
  await mock.handlers.get("session_start")({ type: "session_start", reason: "startup" }, context.ctx);
  let next = 0;
  const call = (toolName, input) =>
    mock.handlers.get("tool_call")({ type: "tool_call", toolCallId: `call-${++next}`, toolName, input }, context.ctx);
  return { cwd, agentDir, bus, selects, notifications: context.notifications, controller, call };
}

/** Set environment variables for one test; the returned function restores them. */
export function setEnv(values) {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}
