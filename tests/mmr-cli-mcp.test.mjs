// `ampi mcp` (packages/ampi-cli/src/mcp.js): how each command line is
// translated onto `pi mcp`, and doctor, approve and oauth status against the
// installed Pi. Pi runs as a child process in a temporary home, agent and
// project directory, offline, with fixtures/ampi-cli/mcp-echo-server.mjs as a
// local stdio server.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import * as pi from "@earendil-works/pi-coding-agent";
import { routeAmpiArgv } from "../packages/ampi-cli/src/argv.js";
import { createLogger } from "../packages/ampi-cli/src/log.js";
import { planMcpCommand, runMcpCommand } from "../packages/ampi-cli/src/mcp.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const ampiBin = path.join(repoRoot, "packages", "ampi-cli", "bin", "ampi.js");
const piRoot = path.join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent");
const piBin = path.join(piRoot, JSON.parse(readFileSync(path.join(piRoot, "package.json"), "utf8")).bin.pi);
const echoServer = path.join(import.meta.dirname, "fixtures", "ampi-cli", "mcp-echo-server.mjs");

/** @param {string[]} argv */
const piArgsOf = (argv) => {
  const plan = planMcpCommand(argv);
  assert.equal(plan.action, "pi", `${argv.join(" ")}: ${JSON.stringify(plan)}`);
  return plan.args;
};

describe("ampi mcp: translation onto pi mcp", () => {
  it("routes mcp to ampi with the rest of the command line", () => {
    const route = routeAmpiArgv(["mcp", "add", "docs", "https://example.com/mcp"]);
    assert.equal(route.command, "mcp");
    assert.deepEqual(route.mcpArgs, ["add", "docs", "https://example.com/mcp"]);
    assert.deepEqual(route.piArgs, []);
  });

  it("turns a URL in place of the command into --url, with every --header in order", () => {
    assert.deepEqual(piArgsOf(["add", "docs", "https://example.com/mcp", "--header", "X-Team=core", "--header", "Authorization=Bearer ${DOCS}"]), [
      "add",
      "docs",
      "--url",
      "https://example.com/mcp",
      "--header",
      "X-Team=core",
      "--header",
      "Authorization=Bearer ${DOCS}",
    ]);
    assert.deepEqual(piArgsOf(["add", "--header", "A=1", "docs", "HTTP://example.com/mcp"]), ["add", "--header", "A=1", "docs", "--url", "HTTP://example.com/mcp"]);
    // Pi's own spelling, and --name=value forms.
    assert.deepEqual(piArgsOf(["add", "docs", "--url", "https://example.com/mcp"]), ["add", "docs", "--url", "https://example.com/mcp"]);
    assert.deepEqual(piArgsOf(["add", "docs", "--url=https://example.com/mcp", "--header=A=b=c"]), ["add", "docs", "--url", "https://example.com/mcp", "--header", "A=b=c"]);
  });

  it("keeps a command after -- as it is, with every --env before it", () => {
    assert.deepEqual(piArgsOf(["add", "search", "--env", "SEARCH_INDEX=./index", "--env", "SEARCH_LIMIT=5", "--", "npx", "-y", "server", "--workspace", "--env", "X=1"]), [
      "add",
      "search",
      "--env",
      "SEARCH_INDEX=./index",
      "--env",
      "SEARCH_LIMIT=5",
      "--",
      "npx",
      "-y",
      "server",
      "--workspace",
      "--env",
      "X=1",
    ]);
    assert.deepEqual(piArgsOf(["add", "--env", "A=1", "search", "--", "server"]), ["add", "--env", "A=1", "search", "--", "server"]);
    // Pi reads a command without -- and everything after it as the command line.
    assert.deepEqual(piArgsOf(["add", "search", "server", "--workspace", "-y"]), ["add", "search", "server", "--workspace", "-y"]);
  });

  it("turns --workspace into Pi's --local for add and remove, and remembers the project server", () => {
    assert.deepEqual(planMcpCommand(["add", "tools", "--workspace", "--", "./tools-mcp"]), {
      action: "pi",
      args: ["add", "tools", "--local", "--", "./tools-mcp"],
      projectServer: "tools",
    });
    assert.deepEqual(planMcpCommand(["add", "-l", "tools", "--", "./tools-mcp"]), { action: "pi", args: ["add", "--local", "tools", "--", "./tools-mcp"], projectServer: "tools" });
    assert.deepEqual(planMcpCommand(["add", "tools", "--", "./tools-mcp"]), { action: "pi", args: ["add", "tools", "--", "./tools-mcp"] });
    assert.deepEqual(piArgsOf(["remove", "tools", "--workspace"]), ["remove", "tools", "--local"]);
    assert.deepEqual(piArgsOf(["remove", "tools"]), ["remove", "tools"]);
  });

  it("passes list, Pi's login and logout, unknown subcommands and unknown options unchanged", () => {
    for (const argv of [
      ["list", "--json"],
      ["login", "docs", "--timeout", "30"],
      ["logout", "docs"],
      ["status"],
      ["list", "--frobnicate"],
      ["add", "docs", "--made-up", "--", "server"],
      ["add", "docs", "--exposure", "direct", "--description", "--looks-like-an-option", "--", "server"],
    ]) {
      assert.deepEqual(piArgsOf(argv), argv);
    }
    assert.deepEqual(piArgsOf(["--pi-help"]), ["--help"]);
  });

  it("maps oauth login and logout onto Pi's login and logout, --timeout included", () => {
    assert.deepEqual(piArgsOf(["oauth", "login", "docs", "--timeout", "60"]), ["login", "docs", "--timeout", "60"]);
    // Pi reads only --timeout <seconds>, so --timeout=N is split.
    assert.deepEqual(piArgsOf(["oauth", "login", "docs", "--timeout=30"]), ["login", "docs", "--timeout", "30"]);
    assert.deepEqual(piArgsOf(["oauth", "login", "docs", "--", "--timeout=30"]), ["login", "docs", "--", "--timeout=30"]);
    assert.deepEqual(piArgsOf(["oauth", "logout", "docs"]), ["logout", "docs"]);
    assert.deepEqual(planMcpCommand(["oauth", "status", "docs"]), { action: "oauth-status", name: "docs" });
  });

  it("plans doctor, approve and help", () => {
    assert.deepEqual(planMcpCommand(["doctor"]), { action: "doctor" });
    assert.deepEqual(planMcpCommand(["doctor", "docs"]), { action: "doctor", name: "docs" });
    assert.deepEqual(planMcpCommand(["approve", "tools"]), { action: "approve", name: "tools", yes: false });
    assert.deepEqual(planMcpCommand(["approve", "-y", "tools"]), { action: "approve", name: "tools", yes: true });
    for (const argv of [[], ["help"], ["--help"], ["add", "-h"], ["doctor", "--help"]]) assert.deepEqual(planMcpCommand(argv), { action: "help" }, argv.join(" "));
    // After -- a --help belongs to the server's command.
    assert.equal(planMcpCommand(["add", "x", "--", "server", "--help"]).action, "pi");
  });

  it("refuses with exit 2: client-credential options, remote, and malformed ampi commands", async () => {
    const cases = [
      ...["--client-id", "--client-secret", "--scopes", "--auth-url", "--token-url", "--server-url"].map((option) => [["oauth", "login", "docs", option, "x"], /oauth login takes no client credentials.*"oauth" block in mcp\.json/]),
      [["oauth", "login", "docs", "--client-id=x"], /takes no client credentials/],
      [["remote"], /mcp remote is not available/],
      [["remote", "add", "docs", "https://example.com/mcp", "--personal"], /mcp remote is not available/],
      [["oauth"], /needs a command/],
      [["oauth", "refresh", "docs"], /unknown mcp oauth command "refresh"/],
      [["oauth", "status"], /exactly one argument/],
      [["oauth", "status", "docs", "--json"], /Unknown option '--json'/],
      [["doctor", "a", "b"], /at most one server name/],
      [["doctor", "--json"], /Unknown option '--json'/],
      [["approve"], /exactly one argument/],
      [["approve", "a", "b"], /exactly one argument/],
      [["add", "docs", "https://a.example/mcp", "https://b.example/mcp"], /add takes one URL/],
      [["add", "docs", "--url", "https://a.example/mcp", "https://b.example/mcp"], /add takes one URL/],
      [["add", "docs", "--workspace=yes", "https://a.example/mcp"], /--workspace takes no value/],
    ];
    for (const [argv, message] of cases) {
      let err = "";
      const code = await runMcpCommand(argv, {
        loadPi: async () => assert.fail("no Pi needed"),
        cwd: "/nowhere",
        runPi: () => assert.fail(`${argv.join(" ")} must not run Pi`),
        capturePi: () => assert.fail(`${argv.join(" ")} must not run Pi`),
        columns: 80,
        interactive: false,
        confirm: async () => assert.fail("no question"),
        out: () => {},
        log: createLogger({
          stderr: (text) => {
            err += text;
          },
        }),
        piStderr: (text) => {
          err += text;
        },
      });
      assert.equal(code, 2, argv.join(" "));
      assert.match(err, message, argv.join(" "));
      assert.match(err, /Run ampi mcp --help/, argv.join(" "));
    }
  });
});

describe("ampi mcp against Pi", () => {
  const savedEnv = { home: process.env.HOME, agentDir: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "ampi-cli-mcp-")));
  const home = path.join(dir, "home");
  const agentDir = path.join(dir, "agent");
  const project = path.join(dir, "project");
  const trustFile = path.join(agentDir, "trust.json");
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };

  /** @param {string[]} args */
  const spawnPi = (args) => spawnSync(process.execPath, [piBin, "mcp", ...args], { cwd: project, env, encoding: "utf8" });

  /**
   * Run an mcp command in-process, with Pi as a child process.
   *
   * @param {string[]} args
   * @param {{ interactive?: boolean, answer?: boolean, capturePi?: (args: string[]) => any, columns?: number }} [options]
   */
  async function run(args, { interactive = false, answer, capturePi, columns = Number.POSITIVE_INFINITY } = {}) {
    let out = "";
    let err = "";
    const questions = [];
    const code = await runMcpCommand(args, {
      loadPi: async () => pi,
      cwd: project,
      runPi: (piArgs) => {
        const result = spawnPi(piArgs);
        out += result.stdout;
        err += result.stderr;
        return result.status ?? 1;
      },
      capturePi: capturePi ?? ((piArgs) => spawnPi(piArgs)),
      columns,
      interactive,
      confirm: async (question) => {
        questions.push(question);
        if (answer === undefined) throw new Error(`unexpected question: ${question}`);
        return answer;
      },
      out: (text) => {
        out += text;
      },
      log: createLogger({
        stderr: (text) => {
          err += text;
        },
      }),
      piStderr: (text) => {
        err += text;
      },
    });
    return { code, out, err, questions };
  }

  /** @param {string} text */
  const tableRows = (text) => text.split("\n").filter((line) => line !== "").map((line) => line.split(/\s{2,}/));

  before(() => {
    for (const each of [home, agentDir, project]) mkdirSync(each, { recursive: true });
    // In-process Pi calls (approve) read the same directories as the child processes.
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_OFFLINE = "1";
  });

  after(() => {
    for (const [name, value] of [
      ["HOME", savedEnv.home],
      ["PI_CODING_AGENT_DIR", savedEnv.agentDir],
      ["PI_OFFLINE", savedEnv.offline],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("adds a server that list --json and doctor show as connected, with its tool", async () => {
    const added = await run(["add", "echo", "--env", "ECHO_MODE=plain", "--", process.execPath, echoServer]);
    assert.equal(added.code, 0, added.err);
    assert.deepEqual(JSON.parse(readFileSync(path.join(agentDir, "mcp.json"), "utf8")).mcpServers.echo, {
      command: process.execPath,
      args: [echoServer],
      env: { ECHO_MODE: "plain" },
    });

    const listed = await run(["list", "--json"]);
    assert.equal(listed.code, 0, listed.err);
    const [server] = JSON.parse(listed.out).servers;
    assert.deepEqual([server.name, server.state, server.tools], ["echo", "connected", ["echo"]]);

    const doctor = await run(["doctor"]);
    assert.equal(doctor.code, 0, doctor.err);
    assert.deepEqual(tableRows(doctor.out), [
      ["NAME", "STATUS", "TRANSPORT", "TOOLS", "ERROR"],
      ["echo", "connected", "stdio", "1"],
    ]);
    assert.equal(doctor.err, "");
  });

  it("doctor exits 1 for a server whose command does not exist, and shows only a named server", async () => {
    const missing = path.join(dir, "no-such-server");
    assert.equal((await run(["add", "broken", "--", missing])).code, 0);
    const doctor = await run(["doctor"]);
    assert.equal(doctor.code, 1);
    const rows = tableRows(doctor.out);
    assert.deepEqual(rows[1], ["echo", "connected", "stdio", "1"]);
    assert.deepEqual(rows[2].slice(0, 4), ["broken", "failed", "stdio", "0"]);
    assert.match(rows[2][4], /ENOENT/);

    const one = await run(["doctor", "broken"]);
    assert.equal(one.code, 1);
    assert.equal(tableRows(one.out).length, 2);
    const healthy = await run(["doctor", "echo"]);
    assert.equal(healthy.code, 0, healthy.out);
    assert.equal(tableRows(healthy.out).length, 2);
    assert.equal((await run(["remove", "broken"])).code, 0);
  });

  it("doctor exits 1 for an unknown name and lists the configured ones", async () => {
    const result = await run(["doctor", "nope"]);
    assert.equal(result.code, 1);
    assert.equal(result.out, "");
    assert.match(result.err, /no MCP server named "nope"\. Configured: echo\./);
  });

  it("doctor reports config errors on stderr, a sign-in hint on stdout, and cuts the error column to the terminal", async () => {
    const report = (name, state, extra = {}) => ({ name, scope: "global", source: "mcp.json", enabled: true, exposure: "codemode", transport: `https://${name}.example/mcp`, state, tools: [], ...extra });
    const listing = () => ({
      status: 1,
      stdout: JSON.stringify({
        servers: [report("docs", "needs-auth"), report("search", "failed", { error: "connect ECONNREFUSED 127.0.0.1:4000 while starting the server" })],
        errors: ["project mcp.json: Unexpected token } in JSON"],
      }),
      stderr: "",
    });
    const result = await run(["doctor"], { capturePi: listing });
    assert.equal(result.code, 1);
    assert.match(result.out, /^Sign in to docs with ampi mcp oauth login docs\.$/m);
    assert.doesNotMatch(result.out, /Sign in to search/);
    assert.match(result.err, /^ampi: config error: project mcp\.json: Unexpected token \} in JSON$/m);

    // NAME, STATUS, TRANSPORT and TOOLS take 6+13+9+5 columns and four gaps of two: 41. At 60 the error
    // gets 19 columns; at 52 the 11 left are too few, and the column is dropped.
    const wide = await run(["doctor"], { capturePi: listing, columns: 60 });
    assert.match(wide.out, /^NAME {4}STATUS {9}TRANSPORT {2}TOOLS {2}ERROR$/m);
    assert.match(wide.out, /^search {2}failed {9}http {7}0 {6}connect ECONNREFUS…$/m);
    const narrow = await run(["doctor"], { capturePi: listing, columns: 52 });
    assert.match(narrow.out, /^NAME {4}STATUS {9}TRANSPORT {2}TOOLS$/m);
    assert.match(narrow.out, /^search {2}failed {9}http {7}0$/m);
  });

  it("oauth status says a stdio server is not an OAuth server", async () => {
    const result = await run(["oauth", "status", "echo"]);
    assert.equal(result.code, 0, result.err);
    assert.equal(result.out, "echo: not an OAuth server (Pi starts it as a local command)\n");
  });

  it("oauth status reads sign-in from the list Pi prints for an HTTP server", async () => {
    const config = path.join(dir, "http-mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { open: { url: "https://a.example/mcp" }, keyed: { url: "https://b.example/mcp", headers: { authorization: "Bearer x" } } } }));
    const report = (name, state, extra = {}) => ({ name, scope: "global", source: config, enabled: true, exposure: "codemode", transport: `https://${name}.example/mcp`, state, tools: [], ...extra });
    /** @param {object} server */
    const listing = (server) => () => ({ status: 1, stdout: JSON.stringify({ servers: [server], errors: [] }), stderr: "" });
    const cases = [
      [report("open", "needs-auth"), 0, "open: needs sign-in (ampi mcp oauth login open)\n"],
      [report("open", "connected"), 0, "open: signed in\n"],
      [report("keyed", "connected"), 0, "keyed: not an OAuth server (its configuration sets its own Authorization header or auth)\n"],
    ];
    for (const [server, code, out] of cases) {
      const result = await run(["oauth", "status", server.name], { capturePi: listing(server) });
      assert.deepEqual([result.code, result.out], [code, out], server.state);
    }
    const failed = await run(["oauth", "status", "open"], { capturePi: listing(report("open", "failed", { error: "fetch failed\nmore" })) });
    assert.equal(failed.code, 1);
    assert.match(failed.err, /cannot tell whether open is signed in: it is failed: fetch failed\.\n/);
  });

  it("approve refuses a name the project does not define, and a run without a terminal", async () => {
    const noFile = await run(["approve", "tools", "--yes"]);
    assert.equal(noFile.code, 1);
    assert.match(noFile.err, /this project has no .*\.pi\/mcp\.json/);

    const added = await run(["add", "tools", "--workspace", "--", process.execPath, echoServer]);
    assert.equal(added.code, 0, added.err);
    assert.match(added.err, /run ampi mcp approve tools to trust this project from the shell/);

    // Pi ignores the project's servers until the project is trusted, and says so.
    const untrusted = await run(["doctor"]);
    assert.equal(untrusted.code, 0, untrusted.err);
    assert.deepEqual(tableRows(untrusted.out).map((row) => row[0]), ["NAME", "echo"]);
    assert.match(untrusted.err, /mcp\.json is ignored because the project is not trusted/);

    const unknown = await run(["approve", "echo", "--yes"]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.err, /no server named "echo" in .*mcp\.json\. Project servers: tools\./);

    const noTerminal = await run(["approve", "tools"]);
    assert.equal(noTerminal.code, 1);
    assert.match(noTerminal.out, /Pi trusts a whole project, not one server/);
    assert.match(noTerminal.out, new RegExp(`  tools  ${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `));
    assert.match(noTerminal.err, /no terminal to ask in; pass --yes/);

    const declined = await run(["approve", "tools"], { interactive: true, answer: false });
    assert.equal(declined.code, 1);
    assert.deepEqual(declined.questions, ["Trust this project? [y/N] "]);
    assert.match(declined.err, /nothing changed/);
    assert.equal(new pi.ProjectTrustStore(agentDir).get(project), null);
  });

  it("approve shows each project server's env names and cwd, never env values, with bidirectional controls removed", async () => {
    const file = path.join(project, ".pi", "mcp.json");
    const saved = readFileSync(file, "utf8");
    const config = JSON.parse(saved);
    config.mcpServers.wrapped = {
      command: "node\u202e\u2066sj.revres\u2069",
      args: ["--flag\u200f", "two\nlines"],
      env: { NODE_OPTIONS: "--require ./hook.js", PATH: "./bin" },
      cwd: "./sub\u202adir",
    };
    writeFileSync(file, JSON.stringify(config));
    try {
      const result = await run(["approve", "tools"]);
      assert.equal(result.code, 1);
      assert.match(result.out, /^ {2}wrapped {2}nodesj\.revres --flag two lines\n {11}env: NODE_OPTIONS, PATH\n {11}cwd: \.\/subdir\n/m);
      assert.doesNotMatch(result.out, /hook\.js|\.\/bin/);
      assert.doesNotMatch(result.out, /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
    } finally {
      writeFileSync(file, saved);
    }
  });

  it("approve --yes lists what trust enables, saves trust in Pi's store, and is idempotent", async () => {
    mkdirSync(path.join(project, ".pi", "prompts"), { recursive: true });
    const approved = await run(["approve", "tools", "--yes"]);
    assert.equal(approved.code, 0, approved.err);
    assert.match(approved.out, /and load these project resources, which can also run code:\n {2}.*\.pi\/prompts\n/);
    assert.match(approved.out, /Trusted .* in Pi's trust store/);
    assert.deepEqual(JSON.parse(readFileSync(trustFile, "utf8")), { [project]: true });

    const again = await run(["approve", "tools", "--yes"]);
    assert.equal(again.code, 0, again.err);
    assert.match(again.out, /^This project is already trusted/);
    assert.deepEqual(JSON.parse(readFileSync(trustFile, "utf8")), { [project]: true });

    // Pi now starts the project's server.
    const trusted = await run(["doctor"]);
    assert.equal(trusted.code, 0, trusted.err);
    assert.deepEqual(tableRows(trusted.out).slice(1), [
      ["echo", "connected", "stdio", "1"],
      ["tools", "connected", "stdio", "1"],
    ]);
    assert.equal(trusted.err, "");
  });

  it("the ampi executable hands an option Pi does not know to Pi unchanged", () => {
    const result = spawnSync(process.execPath, [ampiBin, "mcp", "list", "--frobnicate"], { cwd: project, env, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown option --frobnicate\./);
  });
});
