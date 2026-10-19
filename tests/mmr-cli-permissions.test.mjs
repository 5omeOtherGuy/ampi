// `ampi permissions list|test|edit|add`: spawned against temporary home,
// agent and project directories, with the project trusted or not through
// Pi's trust store; the editor path through the injectable host; and the
// command and a session's tool_call gate deciding the same call alike.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { cleanupLoadedSource } from "./helpers/load-src.mjs";
import { loadPermissionModules, removeTempDirs, setEnv, setupPermissions } from "./helpers/permissions-gate.mjs";

after(cleanupLoadedSource);
after(removeTempDirs);

const repoRoot = path.resolve(import.meta.dirname, "..");
const bin = path.join(repoRoot, "packages", "ampi-cli", "bin", "ampi.js");

let pi;
before(async () => {
  pi = await import("@earendil-works/pi-coding-agent");
});

const roots = [];
after(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A home, an agent directory and a project under one temporary directory,
 * and `run`, which spawns `ampi permissions` there with stdin given as text.
 */
function makeEnv() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ampi-cli-permissions-"));
  roots.push(root);
  const home = path.join(root, "home");
  const agentDir = path.join(root, "agent");
  const project = path.join(root, "project");
  for (const dir of [home, agentDir, project]) mkdirSync(dir, { recursive: true });
  const userFile = path.join(agentDir, "settings.json");
  const projectFile = path.join(project, ".pi", "settings.json");
  const run = (args, { input = "", env = {} } = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [bin, "permissions", ...args], {
        cwd: project,
        env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", VISUAL: "", EDITOR: "false", ...env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
      child.stdin.end(input);
    });
  const writeUser = (settings) => writeFileSync(userFile, JSON.stringify(settings, null, 2));
  const writeProject = (settings) => {
    mkdirSync(path.dirname(projectFile), { recursive: true });
    writeFileSync(projectFile, JSON.stringify(settings, null, 2));
  };
  const trust = (value) => new pi.ProjectTrustStore(agentDir).set(project, value);
  const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
  return { root, home, agentDir, project, userFile, projectFile, run, writeUser, writeProject, trust, readJson };
}

const PUSH = { tool: "bash", matches: { command: "git push*" }, action: "ask" };
const RM = { tool: "bash", matches: { command: "rm -rf *" }, action: "reject", message: "Use the clean script." };

describe("ampi permissions list", () => {
  it("prints the user's rules as text or JSON, an untextable rule as a JSON comment, and nothing without rules", async () => {
    const env = makeEnv();
    const empty = await env.run(["list"]);
    assert.equal(empty.status, 0, empty.stderr);
    assert.equal(empty.stdout, "");
    assert.match(empty.stderr, /^ampi: no rules: .* has no ampi\.permissions\.$/m);

    const stored = [PUSH, RM, { tool: "t", matches: { context: "x" }, action: "ask" }, { tool: "bad" }];
    env.writeUser({ theme: "dark", ampi: { permissions: stored } });
    const [text, json, alias] = await Promise.all([env.run(["list"]), env.run(["list", "--json"]), env.run(["ls"])]);
    assert.equal(text.status, 0, text.stderr);
    assert.equal(
      text.stdout,
      [
        "ask bash --command 'git push*'",
        "reject bash --command 'rm -rf *' --message 'Use the clean script.'",
        '# {"tool":"t","matches":{"context":"x"},"action":"ask"}',
        "",
      ].join("\n"),
    );
    assert.match(text.stderr, /skipping ampi\.permissions\[3\] in .*: action must be/);
    assert.match(text.stderr, /ampi\.permissions\[2\] has no exact text form/);
    assert.deepEqual(JSON.parse(json.stdout), stored);
    assert.equal(alias.stdout, text.stdout);
  });

  it("prints ampi's defaults with --builtin, which does not combine with --workspace", async () => {
    const env = makeEnv();
    const [text, json, both] = await Promise.all([
      env.run(["list", "--builtin"]),
      env.run(["list", "--builtin", "--json"]),
      env.run(["list", "--builtin", "--workspace"]),
    ]);
    const defaults = JSON.parse(json.stdout);
    assert.ok(defaults.length > 20, "ampi has many default rules");
    const lines = text.stdout.trimEnd().split("\n");
    assert.equal(lines.length, defaults.length);
    assert.ok(lines.includes("ask bash"), "the catch-all for bash");
    assert.ok(lines.every((line) => /^(allow|ask|reject) /.test(line)));
    assert.equal(both.status, 2);
    assert.match(both.stderr, /--builtin and --workspace cannot be combined/);
  });

  it("lists the project's rules with --workspace, saying when Pi does not trust it and which rules sessions ignore", async () => {
    const env = makeEnv();
    env.writeProject({ ampi: { permissions: [{ tool: "bash", action: "allow" }, PUSH] } });
    env.trust(false);
    const untrusted = await env.run(["list", "--workspace"]);
    assert.equal(untrusted.status, 0, untrusted.stderr);
    assert.equal(untrusted.stdout, "allow bash\nask bash --command 'git push*'\n");
    assert.match(untrusted.stderr, /Pi does not trust this project, so sessions do not read the rules in /);
    assert.match(untrusted.stderr, /sessions ignore this project's allow rule allow bash/);
    env.trust(true);
    const trusted = await env.run(["list", "--workspace"]);
    assert.doesNotMatch(trusted.stderr, /does not trust/);
    assert.match(trusted.stderr, /sessions ignore this project's allow rule/);
  });
});

describe("ampi permissions add", () => {
  it("puts the new rule first, keeps every other entry and key, and prints it", async () => {
    const env = makeEnv();
    env.writeUser({ theme: "dark", ampi: { keymap: { leader: "ctrl+b" }, permissions: [{ tool: "bad" }] } });
    const first = await env.run(["add", "ask", "bash", "--command", "git push*"]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, "ask bash --command 'git push*'\n");
    const second = await env.run(["add", "reject", "bash", "--command", "rm -rf *", "--message", "Use the clean script."]);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(env.readJson(env.userFile), { theme: "dark", ampi: { keymap: { leader: "ctrl+b" }, permissions: [RM, PUSH, { tool: "bad" }] } });
    const listed = await env.run(["list"]);
    assert.equal(listed.stdout.split("\n")[0], "reject bash --command 'rm -rf *' --message 'Use the clean script.'");

    const literals = await env.run(["add", "allow", "x", "--count", "42", "--id", '"42"', "--opts.force=true"]);
    assert.equal(literals.stdout, "allow x --count 42 --id '42' --opts.force true\n");
    assert.deepEqual(env.readJson(env.userFile).ampi.permissions[0], { tool: "x", matches: { count: 42, id: "42", opts: { force: true } }, action: "allow" });
  });

  it("exits 2 with every problem of an invalid rule and writes nothing", async () => {
    const env = makeEnv();
    env.writeUser({ ampi: { permissions: [PUSH] } });
    const before = readFileSync(env.userFile, "utf8");
    const result = await env.run(["add", "ask", "bash", "--to", "my-check", "--command"]);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /--command needs a value/);
    assert.match(result.stderr, /--to is allowed only on a delegate rule/);
    assert.equal(readFileSync(env.userFile, "utf8"), before);
  });

  it("writes to the project with --workspace and warns about a rule sessions ignore there", async () => {
    const env = makeEnv();
    const result = await env.run(["add", "allow", "bash", "--workspace"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(env.readJson(env.projectFile), { ampi: { permissions: [{ tool: "bash", action: "allow" }] } });
    assert.match(result.stderr, /sessions ignore a project's allow rules/);
    assert.ok(!existsSync(env.userFile));
  });
});

describe("ampi permissions edit", () => {
  it("writes valid text from stdin, keeping every other key, and says when nothing changed", async () => {
    const env = makeEnv();
    env.writeUser({ theme: "dark", ampi: { keymap: { leader: "ctrl+b" }, permissions: [PUSH] } });
    const text = "# mine\nreject bash --command 'rm -rf *' --message 'Use the clean script.'\n\nallow 'mcp__*' --context subagent\n";
    const result = await env.run(["edit"], { input: text });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(env.readJson(env.userFile), {
      theme: "dark",
      ampi: { keymap: { leader: "ctrl+b" }, permissions: [RM, { tool: "mcp__*", action: "allow", context: "subagent" }] },
    });
    const again = await env.run(["edit"], { input: text });
    assert.equal(again.status, 0);
    assert.match(again.stderr, /no change; nothing was written/);
  });

  it("leaves the file's text exactly as it was when a line has a problem", async () => {
    const env = makeEnv();
    env.writeUser({ ampi: { permissions: [PUSH] } });
    const before = readFileSync(env.userFile, "utf8");
    const result = await env.run(["edit"], { input: "ask bash --command 'ok*'\nfoo bash\nask bash --command 'x\n" });
    assert.equal(result.status, 1);
    assert.equal(readFileSync(env.userFile, "utf8"), before);
    assert.match(result.stderr, /^ampi: line 2: action must be allow, reject, ask or delegate \(got "foo"\)$/m);
    assert.match(result.stderr, /^ampi: line 3: a single quote is not closed$/m);
    assert.match(result.stderr, /nothing was written/);
  });

  it("removes ampi.permissions for text without rules, and an ampi object left empty", async () => {
    const env = makeEnv();
    env.writeUser({ theme: "dark", ampi: { keymap: { leader: "ctrl+b" }, permissions: [] } });
    const removed = await env.run(["edit"], { input: "# nothing here\n\n" });
    assert.equal(removed.status, 0, removed.stderr);
    assert.deepEqual(env.readJson(env.userFile), { theme: "dark", ampi: { keymap: { leader: "ctrl+b" } } });
    assert.match(removed.stderr, /no setting turns ampi-permissions on any more/);

    env.writeUser({ theme: "dark", ampi: { permissions: [PUSH] } });
    await env.run(["edit"], { input: "" });
    assert.deepEqual(env.readJson(env.userFile), { theme: "dark" });
  });

  it("refuses to start when the stored rules have no exact text form or hold an invalid entry", async () => {
    const env = makeEnv();
    for (const permissions of [[PUSH, { tool: "t", matches: { to: "x" }, action: "ask" }], [{ tool: "bad" }], "nope"]) {
      env.writeUser({ ampi: { permissions } });
      const before = readFileSync(env.userFile, "utf8");
      const result = await env.run(["edit"], { input: "" });
      assert.equal(result.status, 1, JSON.stringify(permissions));
      assert.match(result.stderr, /edit cannot show ampi\.permissions .* as text without changing it: .*ampi config edit\./);
      assert.equal(readFileSync(env.userFile, "utf8"), before);
    }
  });

  it("opens the rules in the editor through the host, and keeps the edited file after a problem", async () => {
    const { runPermissionsCommand } = await import("../packages/ampi-cli/src/permissions.js");
    const { openInPiEditor } = await import("../packages/ampi-cli/src/editor.js");
    const env = makeEnv();
    env.writeUser({ ampi: { permissions: [PUSH] } });
    // Appends $FAKE_EDITOR_LINE to the file it opens, after recording what the file held.
    const editor = path.join(env.root, "editor.mjs");
    const seen = path.join(env.root, "seen.txt");
    writeFileSync(
      editor,
      `import { appendFileSync, copyFileSync } from "node:fs";\nconst file = process.argv[2];\ncopyFileSync(file, ${JSON.stringify(seen)});\nappendFileSync(file, process.env.FAKE_EDITOR_LINE + "\\n");\n`,
    );
    const errors = [];
    const host = {
      pi,
      cwd: env.project,
      locateAmpi: async () => ({ root: repoRoot }),
      out: () => {},
      log: { error: (message) => errors.push(message), warn: () => {}, info: () => {} },
      stdinIsTTY: true,
      readStdin: async () => assert.fail("the editor path does not read stdin"),
      editFile: (file) => openInPiEditor(pi, env.project, file),
      tempDir: env.root,
    };
    const restore = setEnv({ PI_CODING_AGENT_DIR: env.agentDir, HOME: env.home, VISUAL: "", EDITOR: `${process.execPath} ${editor}`, FAKE_EDITOR_LINE: "reject bash --command 'rm *'" });
    try {
      assert.equal(await runPermissionsCommand(["edit"], host), 0, errors.join("\n"));
      assert.match(readFileSync(seen, "utf8"), /^# ampi\.permissions in .*\nask bash --command 'git push\*'\n$/s);
      assert.deepEqual(env.readJson(env.userFile).ampi.permissions, [PUSH, { tool: "bash", matches: { command: "rm *" }, action: "reject" }]);

      process.env.FAKE_EDITOR_LINE = "reject bash --nope";
      assert.equal(await runPermissionsCommand(["edit"], host), 1);
      assert.match(errors[0], /^line \d+: --nope needs a value$/);
      const kept = /Your text is kept in (\S+); fix it/.exec(errors.at(-1))?.[1];
      assert.ok(kept !== undefined && existsSync(kept), errors.at(-1));
      assert.match(readFileSync(kept, "utf8"), /reject bash --nope\n$/);
      assert.equal(env.readJson(env.userFile).ampi.permissions.length, 2, "the settings stay as they were");
    } finally {
      restore();
    }
  });
});

describe("ampi permissions test", () => {
  const MAKE = { tool: "bash", matches: { command: "make *" }, action: "allow" };
  const DELEGATE = { tool: "bash", matches: { command: "git *" }, action: "delegate", to: "node approve.mjs" };
  const USER_RULES = [RM, PUSH, DELEGATE, MAKE];

  it("exits 0, 1 and 3 for allow, reject, and ask or delegate, and runs no program", async () => {
    const env = makeEnv();
    env.writeUser({ ampi: { permissions: USER_RULES } });
    const test = (command, ...rest) => env.run(["test", "bash", "--command", command, ...rest]);
    const [allow, reject, ask, delegate, quiet] = await Promise.all([
      test("make build"),
      test("rm -rf build"),
      test("git push origin main"),
      test("git status"),
      test("git push origin main", "-q"),
    ]);
    assert.deepEqual([allow.status, reject.status, ask.status, delegate.status], [0, 1, 3, 3]);
    assert.equal(allow.stdout, "allow: user rule allow bash --command 'make *'\n");
    assert.equal(reject.stdout, "reject: user rule reject bash --command 'rm -rf *' --message 'Use the clean script.' (for rm -rf build)\n");
    assert.equal(ask.stdout, "ask: user rule ask bash --command 'git push*' (for git push origin main)\n");
    assert.equal(delegate.stdout, "delegate to node approve.mjs: user rule delegate bash --command 'git *' --to 'node approve.mjs' (for git status)\n");
    assert.equal(quiet.status, 3);
    assert.equal(quiet.stdout, "");
  });

  it("prints one JSON object per decision, and each part of a shell line under the line's decision", async () => {
    const env = makeEnv();
    env.writeUser({ ampi: { permissions: USER_RULES } });
    const test = (command, ...rest) => env.run(["test", "bash", "--command", command, "--json", ...rest]);
    const [allow, reject, ask, line, subagent, text] = await Promise.all([
      test("make build"),
      test("rm -rf build"),
      test("git push origin main"),
      test("make build && git status"),
      test("git push origin main", "--context", "subagent"),
      env.run(["test", "bash", "--command", "make build && git status"]),
    ]);
    assert.deepEqual(JSON.parse(allow.stdout), { decision: "allow", source: "user", rule: MAKE });
    assert.deepEqual(JSON.parse(reject.stdout), { decision: "reject", source: "user", rule: RM, command: "rm -rf build" });
    assert.deepEqual(JSON.parse(ask.stdout), { decision: "ask", source: "user", rule: PUSH, command: "git push origin main" });
    assert.equal(line.status, 3);
    assert.deepEqual(JSON.parse(line.stdout), {
      decision: "delegate",
      source: "user",
      rule: DELEGATE,
      command: "git status",
      parts: [
        { decision: "allow", source: "user", rule: MAKE, command: "make build" },
        { decision: "delegate", source: "user", rule: DELEGATE, command: "git status" },
      ],
    });
    assert.equal(
      text.stdout,
      [
        "delegate to node approve.mjs: user rule delegate bash --command 'git *' --to 'node approve.mjs'",
        "  allow: make build (user rule allow bash --command 'make *')",
        "  delegate to node approve.mjs: git status (user rule delegate bash --command 'git *' --to 'node approve.mjs')",
        "",
      ].join("\n"),
    );
    assert.deepEqual(JSON.parse(subagent.stdout), { decision: "ask", source: "user", rule: PUSH, command: "git push origin main", subagentRefuses: true });
    assert.match(subagent.stderr, /a subagent cannot ask, so it refuses this call instead/);
  });

  it("reads a trusted project's reject and ask rules first, ignores its allow rules, and reads nothing of an untrusted project", async () => {
    const env = makeEnv();
    env.writeUser({ ampi: { permissions: [MAKE] } });
    env.writeProject({ ampi: { permissions: [{ tool: "bash", matches: { command: "git push*" }, action: "allow" }, { tool: "bash", matches: { command: "make deploy*" }, action: "reject" }] } });
    const test = (command, ...rest) => env.run(["test", "bash", "--command", command, "--json", ...rest]);
    env.trust(true);
    const [deploy, push] = await Promise.all([test("make deploy"), test("git push origin main")]);
    assert.equal(deploy.status, 1);
    assert.equal(JSON.parse(deploy.stdout).source, "project");
    assert.equal(push.status, 3, "the project's allow rule does not count");
    assert.equal(JSON.parse(push.stdout).source, "default");
    assert.match(push.stderr, /Ignoring 1 allow or delegate rule in .*project settings can only add reject and ask rules/);

    env.trust(false);
    const [untrusted, workspace, workspaceUserRule] = await Promise.all([
      test("make deploy"),
      test("make deploy", "--workspace"),
      test("make build", "--workspace"),
    ]);
    assert.equal(untrusted.status, 0);
    assert.deepEqual(JSON.parse(untrusted.stdout), { decision: "allow", source: "user", rule: MAKE });
    assert.doesNotMatch(untrusted.stderr, /Ignoring/, "an untrusted project's file is not read at all");
    assert.equal(workspace.status, 1, "--workspace reads the project even untrusted");
    assert.match(workspace.stderr, /Pi does not trust this project, so sessions do not read .*; this test reads it anyway/);
    assert.equal(workspaceUserRule.status, 3, "--workspace leaves the user's rules out");
    assert.equal(JSON.parse(workspaceUserRule.stdout).source, "default");
  });

  it("asks about guarded files with their category, unless the allowlist covers them", async () => {
    const env = makeEnv();
    env.writeUser({ ampi: { permissions: [], guardedFiles: { allowlist: [path.join(env.project, ".env.local")] } } });
    const patchText = ["*** Begin Patch", "*** Add File: src/a.ts", "+x", "*** Update File: .git/config", "@@", "-a", "+b", "*** End Patch"].join("\n");
    const [env1, allowed, patch, text] = await Promise.all([
      env.run(["test", "write", "--path", ".env", "--json"]),
      env.run(["test", "write", "--path", ".env.local", "--json"]),
      env.run(["test", "apply_patch", "--patchText", patchText, "--json"]),
      env.run(["test", "write", "--path", ".env"]),
    ]);
    const envFile = { key: "env-file", description: "environment file" };
    assert.equal(env1.status, 3);
    assert.deepEqual(JSON.parse(env1.stdout), { decision: "ask", source: "guarded", category: envFile, files: [{ path: path.join(env.project, ".env"), category: envFile }] });
    assert.equal(text.stdout, `ask: guarded file ${path.join(env.project, ".env")} (environment file)\n`);
    assert.equal(allowed.status, 0);
    assert.deepEqual(JSON.parse(allowed.stdout), { decision: "allow", source: "none" });
    assert.equal(patch.status, 3);
    const git = { key: "git", description: "Git internals" };
    assert.deepEqual(JSON.parse(patch.stdout), { decision: "ask", source: "guarded", category: git, files: [{ path: path.join(env.project, ".git", "config"), category: git }] });
  });

  it("allows with source off when no setting turns the gate on, and asks for every call when the settings fail closed", async () => {
    const env = makeEnv();
    const off = await env.run(["test", "bash", "--command", "rm -rf /", "--json"]);
    assert.equal(off.status, 0);
    assert.deepEqual(JSON.parse(off.stdout), { decision: "allow", source: "off" });
    assert.match(off.stderr, /no setting turns ampi-permissions on/);

    env.writeUser({ ampi: { permissions: "nope" } });
    const closed = await env.run(["test", "read", "--path", "README.md", "--json"]);
    assert.equal(closed.status, 3);
    assert.deepEqual(JSON.parse(closed.stdout), { decision: "ask", source: "none", reason: `ampi.permissions in ${env.userFile} is not a list of rules` });

    env.writeUser({ ampi: { dangerouslyAllowAll: true, permissions: [RM] } });
    const all = await env.run(["test", "bash", "--command", "rm -rf /", "--json"]);
    assert.deepEqual([all.status, JSON.parse(all.stdout)], [0, { decision: "allow", source: "allow-all" }]);
  });

  it("exits 2 on a usage error and 4 when the ampi package is too old to decide", async () => {
    const env = makeEnv();
    const [noTool, toFlag] = await Promise.all([env.run(["test", "--command", "ls"]), env.run(["test", "bash", "--to", "x"])]);
    assert.equal(noTool.status, 2);
    assert.match(noTool.stderr, /test needs the tool's name/);
    assert.equal(toFlag.status, 2);
    assert.match(toFlag.stderr, /--to is a rule's option/);

    const old = path.join(env.root, "old-ampi");
    mkdirSync(path.join(old, "src"), { recursive: true });
    writeFileSync(path.join(old, "src", "index.ts"), "");
    writeFileSync(path.join(old, "package.json"), JSON.stringify({ name: "@skippermissions/ampi", version: "0.0.1" }));
    env.writeUser({ extensions: [path.join(old, "src", "index.ts")] });
    const tooOld = await env.run(["test", "bash", "--command", "ls"]);
    assert.equal(tooOld.status, 4);
    assert.match(tooOld.stderr, /ampi 0\.0\.1 is too old for permissions test; update @skippermissions\/ampi/);
  });
});

describe("ampi permissions: help and usage", () => {
  it("prints the overview for no subcommand or --help, each subcommand's help, and exits 2 for an unknown one", async () => {
    const env = makeEnv();
    const [none, help, testHelp, unknown] = await Promise.all([env.run([]), env.run(["--help"]), env.run(["test", "-h"]), env.run(["lsit"])]);
    assert.equal(none.status, 0);
    assert.match(none.stdout, /^ampi permissions: list, test, edit and add/);
    assert.equal(help.stdout, none.stdout);
    assert.match(testHelp.stdout, /^ampi permissions test: /);
    assert.match(testHelp.stdout, /Exit status: 0 allow, 1 reject, 3 ask or delegate, 2 on a usage error, 4 when/);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /^ampi: permissions: unknown command lsit\./);
  });
});

describe("ampi permissions test and a session decide alike", () => {
  let modules;
  before(async () => {
    modules = await loadPermissionModules();
  });

  it("gives the gate's outcome for the same settings and call", async () => {
    const user = { ampi: { permissions: [RM, PUSH, { tool: "bash", matches: { command: "make *" }, action: "allow" }] } };
    const project = { ampi: { permissions: [{ tool: "bash", matches: { command: "make deploy*" }, action: "reject" }, { tool: "bash", matches: { command: "ls*" }, action: "allow" }] } };
    const calls = [
      ["bash", { command: "rm -rf build" }],
      ["bash", { command: "git push origin main" }],
      ["bash", { command: "make build" }],
      ["bash", { command: "make deploy" }],
      ["bash", { command: "ls -la" }],
      ["bash", { command: "npm publish" }],
      ["write", { path: ".env", content: "A=1" }],
      ["read", { path: "README.md" }],
    ];
    for (const trusted of [true, false]) {
      // The session dismisses every dialog, so a call that asks is blocked after one dialog.
      const session = await setupPermissions(modules, { user, project, trusted, answers: calls.map(() => undefined) });
      new pi.ProjectTrustStore(session.agentDir).set(session.cwd, trusted);
      const gates = [];
      for (const [toolName, input] of calls) {
        const before = session.selects.length;
        const blocked = (await session.call(toolName, input))?.block === true;
        gates.push(session.selects.length > before ? "ask" : blocked ? "reject" : "allow");
      }
      const tested = await Promise.all(
        calls.map(
          ([toolName, input]) =>
            new Promise((resolve, reject) => {
              const args = Object.entries(input).flatMap(([field, value]) => [`--${field}`, value]);
              const child = spawn(process.execPath, [bin, "permissions", "test", toolName, ...args], {
                cwd: session.cwd,
                env: { ...process.env, HOME: path.join(session.agentDir, "home"), PI_CODING_AGENT_DIR: session.agentDir, PI_OFFLINE: "1" },
                stdio: ["ignore", "ignore", "pipe"],
              });
              child.on("error", reject);
              child.on("close", (status) => resolve({ 0: "allow", 1: "reject", 3: "ask" }[status]));
            }),
        ),
      );
      assert.deepEqual(
        tested.map((outcome, index) => [...calls[index], outcome]),
        calls.map((call, index) => [...call, gates[index]]),
        `project trusted: ${trusted}`,
      );
    }
  });
});
