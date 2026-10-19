// ampi-permissions in subagent children: rules per context, refusals instead
// of dialogs, the parent's answers passed through the environment, and which
// children load the gate.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { loadPermissionModules, removeTempDirs, setEnv, setupPermissions, tempDir } from "./helpers/permissions-gate.mjs";

after(cleanupLoadedSource);
after(removeTempDirs);

let modules;
before(async () => {
  modules = await loadPermissionModules();
});
afterEach(() => {
  modules.rules.setMmrPermissionsSessionAllowAll(false);
  modules.rules.setMmrPermissionsProjectTrusted(false);
  modules.runtime.setMmrSubagentState(undefined);
});

const ON = (rules) => ({ ampi: { permissions: rules } });
const NO_SEAMS = { AMPI_PERMISSIONS_ALLOW_ALL: undefined, AMPI_PERMISSIONS_PROJECT_RULES: undefined };
const cleanup = { command: "rm -rf build" };

function childReason(cause) {
  return (
    "The bash call needs the user's approval, and a subagent cannot ask the user for it. " +
    `${cause} Tell the main session: the call has to run there, where the user can approve it, or a rule in ampi.permissions has to allow it.`
  );
}

describe("ampi-permissions subagents: rules per context", () => {
  const rules = [
    { tool: "bash", matches: { command: "make child*" }, action: "allow", context: "subagent" },
    { tool: "bash", matches: { command: "make main*" }, action: "allow", context: "thread" },
    { tool: "bash", matches: { command: "make any*" }, action: "allow" },
  ];

  it("applies subagent rules in a child and not thread rules", async () => {
    const restore = setEnv(NO_SEAMS);
    try {
      const t = await setupPermissions(modules, { user: ON(rules), subagent: true });
      assert.equal(await t.call("bash", { command: "make child" }), undefined);
      assert.equal(await t.call("bash", { command: "make any" }), undefined);
      assert.deepEqual(await t.call("bash", { command: "make main" }), {
        block: true,
        reason: childReason('The permissions rule "ask bash" asks for approval (for "make main").'),
      });
    } finally {
      restore();
    }
  });

  it("applies thread rules in the main session and not subagent rules", async () => {
    const t = await setupPermissions(modules, { user: ON(rules), hasUI: false });
    assert.equal(await t.call("bash", { command: "make main" }), undefined);
    assert.equal(await t.call("bash", { command: "make any" }), undefined);
    const result = await t.call("bash", { command: "make child" });
    assert.match(result.reason, /^The bash call needs the user's approval, and this run cannot ask for it\./);
  });
});

describe("ampi-permissions subagents: a child never asks", () => {
  it("blocks what would ask, the default catch-all included, without a dialog even with a UI", async () => {
    const restore = setEnv(NO_SEAMS);
    try {
      const t = await setupPermissions(modules, { user: ON([]), subagent: true, hasUI: true, answers: ["Allow Once"] });
      assert.deepEqual(await t.call("bash", cleanup), {
        block: true,
        reason: childReason('The permissions rule "ask bash" asks for approval (for "rm -rf build").'),
      });
      assert.equal(await t.call("bash", { command: "git status" }), undefined, "the defaults still allow reads");
      assert.equal(t.selects.length, 0);
      assert.deepEqual(t.bus.emitted, []);
    } finally {
      restore();
    }
  });

  it("blocks when a delegate program asks, and tells the program it runs in a subagent", async () => {
    const dir = tempDir();
    const seen = path.join(dir, "seen.json");
    const ask = path.join(dir, "ask.mjs");
    writeFileSync(
      ask,
      'import { writeFileSync } from "node:fs";\nlet t = "";\nprocess.stdin.on("data", (c) => (t += c));\nprocess.stdin.on("end", () => { writeFileSync(process.argv[2], t); process.exit(2); });\n',
    );
    const rule = { tool: "bash", matches: { command: "deploy*" }, action: "delegate", to: `'${process.execPath}' '${ask}' '${seen}'` };
    const restore = setEnv(NO_SEAMS);
    try {
      const t = await setupPermissions(modules, { user: ON([rule]), subagent: true, hasUI: true });
      const text = modules.rules.formatMmrPermissionRule(rule);
      assert.deepEqual(await t.call("bash", { command: "deploy staging" }), {
        block: true,
        reason: childReason(`The permissions rule "${text}" asks for approval (for "deploy staging"), because its program did not allow the call.`),
      });
      assert.equal(t.selects.length, 0);
      assert.equal(JSON.parse(readFileSync(seen, "utf8")).context, "subagent");
    } finally {
      restore();
    }
  });
});

describe("ampi-permissions subagents: answers from the parent", () => {
  it("lets every call run in a child whose parent allowed all", async () => {
    const restore = setEnv({ ...NO_SEAMS, AMPI_PERMISSIONS_ALLOW_ALL: "1" });
    try {
      const t = await setupPermissions(modules, { user: ON([]), subagent: true });
      assert.equal(await t.call("bash", cleanup), undefined);
      assert.equal(modules.rules.isMmrPermissionsSessionAllowAll(), true, "so the child's own workers get it too");
    } finally {
      restore();
    }
  });

  it("ignores the allow-all variable in a main session", async () => {
    const restore = setEnv({ ...NO_SEAMS, AMPI_PERMISSIONS_ALLOW_ALL: "1" });
    try {
      const t = await setupPermissions(modules, { user: ON([]), hasUI: false });
      assert.equal((await t.call("bash", cleanup)).block, true);
      assert.equal(modules.rules.isMmrPermissionsSessionAllowAll(), false);
    } finally {
      restore();
    }
  });

  it("reads the project's rules in an untrusted child when the parent read them", async () => {
    const project = ON([{ tool: "bash", matches: { command: "make *" }, action: "reject", message: "Not in this project." }]);
    const restore = setEnv({ ...NO_SEAMS, AMPI_PERMISSIONS_PROJECT_RULES: "1" });
    try {
      const child = await setupPermissions(modules, { user: ON([{ tool: "bash", matches: { command: "make *" }, action: "allow" }]), project, trusted: false, subagent: true });
      assert.deepEqual(await child.call("bash", { command: "make all" }), { block: true, reason: "Not in this project." });
      assert.equal(modules.rules.isMmrPermissionsProjectTrusted(), true, "so the child's own workers read them too");

      const main = await setupPermissions(modules, { user: ON([{ tool: "bash", matches: { command: "make *" }, action: "allow" }]), project, trusted: false });
      assert.equal(await main.call("bash", { command: "make all" }), undefined, "a main session ignores the variable");
      assert.equal(modules.rules.isMmrPermissionsProjectTrusted(), false);
    } finally {
      restore();
    }
  });

  it("does not read an untrusted project's rules in a child without the variable", async () => {
    const project = ON([{ tool: "bash", matches: { command: "make *" }, action: "reject", message: "Not in this project." }]);
    const restore = setEnv(NO_SEAMS);
    try {
      const t = await setupPermissions(modules, { user: ON([{ tool: "bash", matches: { command: "make *" }, action: "allow" }]), project, trusted: false, subagent: true });
      assert.equal(await t.call("bash", { command: "make all" }), undefined);
      assert.equal(modules.rules.isMmrPermissionsProjectTrusted(), false);
    } finally {
      restore();
    }
  });

  it("records the main session's project trust for the runner", async () => {
    await setupPermissions(modules, { user: ON([]), trusted: true });
    assert.equal(modules.rules.isMmrPermissionsProjectTrusted(), true);
    await setupPermissions(modules, { user: ON([]), trusted: false });
    assert.equal(modules.rules.isMmrPermissionsProjectTrusted(), false);
  });
});

describe("ampi-permissions subagents: the runner passes the answers on", () => {
  function fakeSpawn(calls) {
    return (command, args, options) => {
      calls.push({ command, args, options });
      return {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on(event, listener) {
          if (event === "close") queueMicrotask(() => listener(0, null));
          return this;
        },
        kill: () => true,
      };
    };
  }

  async function childEnv({ allowAll, trusted, inherited }) {
    const { runMmrSubagentWorker } = await importSource("extensions/ampi-workers/framework/runner.ts");
    modules.rules.setMmrPermissionsSessionAllowAll(allowAll);
    modules.rules.setMmrPermissionsProjectTrusted(trusted);
    const restore = setEnv({ AMPI_PERMISSIONS_ALLOW_ALL: inherited, AMPI_PERMISSIONS_PROJECT_RULES: inherited });
    const calls = [];
    try {
      await runMmrSubagentWorker(
        { profileName: "task-subagent", prompt: "q", cwd: "/tmp/cwd" },
        { spawn: fakeSpawn(calls), resolveInvocation: (args) => ({ command: "pi", args }) },
      );
    } finally {
      restore();
    }
    assert.equal(calls.length, 1);
    const env = calls[0].options.env;
    return { allowAll: env.AMPI_PERMISSIONS_ALLOW_ALL, projectRules: env.AMPI_PERMISSIONS_PROJECT_RULES, path: env.PATH };
  }

  it("sets each variable while its answer holds", async () => {
    assert.deepEqual(await childEnv({ allowAll: true, trusted: false }), { allowAll: "1", projectRules: undefined, path: process.env.PATH });
    assert.deepEqual(await childEnv({ allowAll: false, trusted: true }), { allowAll: undefined, projectRules: "1", path: process.env.PATH });
    assert.deepEqual(await childEnv({ allowAll: true, trusted: true }), { allowAll: "1", projectRules: "1", path: process.env.PATH });
  });

  it("removes a value inherited from this process when the answer does not hold", async () => {
    assert.deepEqual(await childEnv({ allowAll: false, trusted: false, inherited: "1" }), {
      allowAll: undefined,
      projectRules: undefined,
      path: process.env.PATH,
    });
  });
});

describe("ampi-permissions subagents: which children load the gate", () => {
  const EXT_DIR = "/pkg/src/extensions";
  const LOCATION = { extensionsDir: EXT_DIR, moduleExt: ".ts" };
  const entry = (name) => path.join(EXT_DIR, name, "index.ts");

  it("keeps ampi-permissions in a restricted Task child, after the other ampi extensions", async () => {
    const scope = await importSource("extensions/ampi-workers/child-extension-scope.ts");
    assert.deepEqual(
      scope.resolveMmrChildExtensionScope({
        profileName: "task-subagent",
        loadedPaths: [entry("ampi-core"), entry("ampi-permissions"), entry("ampi-tui")],
        location: LOCATION,
        fileExists: (candidate) => candidate.startsWith(EXT_DIR),
      }),
      ["ampi-core", "ampi-web", "ampi-workers", "ampi-tasks", "ampi-permissions"].map(entry),
    );
  });

  it("leaves reviewer and custom subagents to full discovery, which loads every extension", async () => {
    const scope = await importSource("extensions/ampi-workers/child-extension-scope.ts");
    for (const profileName of ["reviewer", "sa__release-notes"]) {
      assert.equal(
        scope.resolveMmrChildExtensionScope({ profileName, loadedPaths: [entry("ampi-core")], location: LOCATION, fileExists: () => true }),
        undefined,
        profileName,
      );
    }
  });

  it("does not add the gate to children without shell or edit tools", async () => {
    const scope = await importSource("extensions/ampi-workers/child-extension-scope.ts");
    for (const profile of ["finder", "oracle", "librarian"]) {
      assert.equal(scope.MMR_SUBAGENT_CHILD_KEEP_EXTENSIONS[profile].includes("ampi-permissions"), false, profile);
    }
  });
});
