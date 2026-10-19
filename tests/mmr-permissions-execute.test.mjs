// ampi-permissions in runs that cannot ask and with --ampi-dangerously-allow-all:
// the flag allows every call for the whole process, a run the `ampi` command
// marks as non-interactive refuses calls that need approval even with a UI,
// and every call the gate blocks in the main session is noted for the run's
// report.
import assert from "node:assert/strict";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { cleanupLoadedSource } from "./helpers/load-src.mjs";
import { loadPermissionModules, removeTempDirs, setEnv, setupPermissions } from "./helpers/permissions-gate.mjs";

after(cleanupLoadedSource);
after(removeTempDirs);

let modules;
before(async () => {
  modules = await loadPermissionModules();
});
afterEach(() => {
  modules.rules.setMmrPermissionsSessionAllowAll(false);
  modules.rules.setMmrPermissionsNonInteractive(false);
  modules.rules.clearMmrPermissionsDenials();
  modules.runtime.setMmrSubagentState(undefined);
});

const FLAG = "ampi-dangerously-allow-all";
const NO_SEAMS = { AMPI_PERMISSIONS_ALLOW_ALL: undefined, AMPI_PERMISSIONS_PROJECT_RULES: undefined };
const ASK_ECHO = { tool: "bash", matches: { command: "echo *" }, action: "ask" };
const ON = (rules) => ({ ampi: { permissions: rules } });
const RERUN =
  "To let every tool call run, repeat the run with --dangerously-allow-all (the ampi command) or --ampi-dangerously-allow-all (pi).";

/** A delegate spawn that records each start and fails, so a program that runs makes the call ask. */
function failingSpawn() {
  const started = [];
  const spawn = (file) => {
    started.push(file);
    throw Object.assign(new Error("not started"), { code: "EACCES" });
  };
  return { started, spawn };
}

const gateReason = () => modules.runtime.resolveMmrFeatureGates(["ampi-permissions"])[0].reason;

describe("ampi-permissions: --ampi-dangerously-allow-all", () => {
  it("registers the boolean flag even while no setting turns the gate on", async () => {
    const t = await setupPermissions(modules, {});
    const flag = t.flagDefs.get(FLAG);
    assert.equal(flag.type, "boolean");
    assert.equal(flag.default, false);
    assert.equal(typeof flag.description, "string");
  });

  it("runs every call without a dialog: ask rules, guarded paths and delegate programs", async () => {
    const restore = setEnv(NO_SEAMS);
    try {
      const { started, spawn } = failingSpawn();
      const rules = [ASK_ECHO, { tool: "edit", action: "delegate", to: `'${process.execPath}' reject.mjs` }];
      const t = await setupPermissions(modules, { user: ON(rules), flags: { [FLAG]: true }, overrides: { delegateSpawn: spawn } });
      assert.equal(await t.call("bash", { command: "echo hi" }), undefined);
      assert.equal(await t.call("write", { path: ".git/config", content: "" }), undefined);
      assert.equal(await t.call("edit", { path: "a.txt", edits: [] }), undefined);
      assert.deepEqual(t.selects, []);
      assert.deepEqual(started, [], "no delegate program ran");
      assert.match(gateReason(), /; --ampi-dangerously-allow-all is set, so every tool call runs without asking$/);
    } finally {
      restore();
    }
  });

  it("holds through a new session and reaches subagent children; without it a new session asks again", async () => {
    const flagged = await setupPermissions(modules, { user: ON([ASK_ECHO]), flags: { [FLAG]: true } });
    await flagged.start("new");
    assert.equal(modules.rules.isMmrPermissionsSessionAllowAll(), true);
    const env = {};
    modules.rules.writeMmrPermissionsChildEnv(env);
    assert.equal(env.AMPI_PERMISSIONS_ALLOW_ALL, "1");

    const plain = await setupPermissions(modules, { user: ON([ASK_ECHO]), answers: ["Allow All for This Session"] });
    assert.equal(await plain.call("bash", { command: "echo one" }), undefined);
    assert.match(gateReason(), /every tool call is allowed for this session$/);
    await plain.start("new");
    assert.equal(modules.rules.isMmrPermissionsSessionAllowAll(), false);
    assert.equal((await plain.call("bash", { command: "echo two" })).block, true, "the dialog has no answer left");
    assert.equal(plain.selects.length, 2);
  });
});

describe("ampi-permissions: runs the ampi command marks as non-interactive", () => {
  it("refuses an ask rule with the execute reason instead of opening the dialog it could", async () => {
    const t = await setupPermissions(modules, { user: ON([ASK_ECHO]), hasUI: true });
    modules.rules.setMmrPermissionsNonInteractive(true);
    assert.deepEqual(await t.call("bash", { command: "echo hi" }), {
      block: true,
      reason:
        "The bash call needs the user's approval, and this run cannot ask for it. " +
        `The permissions rule "ask bash --command 'echo *'" asks for approval (for "echo hi"). ` +
        `An allow rule in ampi.permissions lets such calls run without asking. ${RERUN}`,
    });
    assert.deepEqual(t.selects, []);
    assert.deepEqual(t.bus.emitted, [], "no approval status without a dialog");
  });

  it("refuses a delegate that ends in asking, a settings file that fails closed and a guarded path", async () => {
    const restore = setEnv(NO_SEAMS);
    try {
      const { spawn } = failingSpawn();
      const delegateRule = { tool: "edit", action: "delegate", to: `'${process.execPath}' check.mjs` };
      const t = await setupPermissions(modules, { user: ON([delegateRule]), overrides: { delegateSpawn: spawn } });
      modules.rules.setMmrPermissionsNonInteractive(true);
      const delegated = await t.call("edit", { path: "a.txt", edits: [] });
      assert.equal(delegated.block, true);
      assert.ok(
        delegated.reason.startsWith("The edit call needs the user's approval, and this run cannot ask for it. The permissions rule "),
        delegated.reason,
      );
      assert.ok(delegated.reason.endsWith(`, because its program did not allow the call. An allow rule in ampi.permissions lets such calls run without asking. ${RERUN}`));

      const guarded = await t.call("write", { path: ".git/config", content: "" });
      assert.deepEqual(guarded, {
        block: true,
        reason:
          `The write call changes a guarded file: ${path.join(t.cwd, ".git", "config")} (Git internals). ` +
          "Changes to guarded files need the user's approval, even when a rule allows the tool, and this run cannot ask for it. " +
          `A path in ampi.guardedFiles.allowlist in the user settings lets such calls run without asking. ${RERUN}`,
      });

      const closed = await setupPermissions(modules, { user: { ampi: { permissions: { tool: "read", action: "allow" } } } });
      const file = path.join(closed.agentDir, "settings.json");
      assert.deepEqual(await closed.call("read", { path: "a.txt" }), {
        block: true,
        reason:
          "The read call needs the user's approval, and this run cannot ask for it. " +
          `It needs approval because ampi.permissions in ${file} is not a list of rules. ` +
          `An allow rule in ampi.permissions lets such calls run without asking. ${RERUN}`,
      });
      assert.deepEqual([...t.selects, ...closed.selects], []);
    } finally {
      restore();
    }
  });

  it("keeps the subagent reason in a child", async () => {
    const restore = setEnv(NO_SEAMS);
    try {
      const t = await setupPermissions(modules, { user: ON([ASK_ECHO]), subagent: true });
      modules.rules.setMmrPermissionsNonInteractive(true);
      const result = await t.call("bash", { command: "echo hi" });
      assert.equal(result.block, true);
      assert.ok(result.reason.startsWith("The bash call needs the user's approval, and a subagent cannot ask the user for it. "), result.reason);
      assert.deepEqual(modules.rules.readMmrPermissionsDenials(), [], "a child's refusals are not noted");
    } finally {
      restore();
    }
  });
});

describe("ampi-permissions: the run's refused calls", () => {
  it("notes every call the gate blocks in the main session, one entry per call and in order", async () => {
    const restore = setEnv(NO_SEAMS);
    try {
      const rules = [{ tool: "bash", matches: { command: "rm *" }, action: "reject" }, ASK_ECHO, { tool: "read", action: "allow" }];
      const t = await setupPermissions(modules, { user: ON(rules), answers: ["Reject", "Allow Once"] });
      assert.equal((await t.call("bash", { command: "rm -rf build" })).block, true);
      assert.equal(await t.call("read", { path: "a.txt" }), undefined);
      assert.equal((await t.call("write", { path: ".git/config", content: "" })).block, true, "rejected in the guarded file dialog");
      assert.equal(await t.call("bash", { command: "echo allowed" }), undefined, "allowed once in the dialog");
      modules.rules.setMmrPermissionsNonInteractive(true);
      assert.equal((await t.call("bash", { command: "echo refused" })).block, true);
      assert.deepEqual(modules.rules.readMmrPermissionsDenials(), ["bash", "write", "bash"]);
      modules.rules.clearMmrPermissionsDenials();
      assert.deepEqual(modules.rules.readMmrPermissionsDenials(), []);
    } finally {
      restore();
    }
  });
});
