// `--mcp-config` of the `ampi` command (packages/ampi-cli/src/mcp-config.js):
// which values give which servers or usage errors, what the inline extension
// registers on every extension load and when it reports a server that an
// mcp.json file overrides, then spawned runs against the installed Pi with the
// scripted offline model (tests/fixtures/ampi-cli/faux-model).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createMcpConfigExtension, readMcpConfigFlag } from "../packages/ampi-cli/src/mcp-config.js";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const bin = path.join(repoRoot, "packages", "ampi-cli", "bin", "ampi.js");
const fauxModel = path.join(import.meta.dirname, "fixtures", "ampi-cli", "faux-model");

const dir = mkdtempSync(path.join(tmpdir(), "ampi-cli-mcp-config-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const DOCS = { url: "https://example.com/mcp" };
const FILES = { command: "files-server", args: ["--root", "."] };

describe("ampi --mcp-config: reading the value", () => {
  it("reads inline JSON in Pi's mcp.json shape and as a bare map of servers", () => {
    assert.deepEqual(readMcpConfigFlag(JSON.stringify({ mcpServers: { docs: DOCS } }), "/nowhere"), { servers: { docs: DOCS } });
    assert.deepEqual(readMcpConfigFlag(`  ${JSON.stringify({ docs: DOCS, files: FILES })}`, "/nowhere"), { servers: { docs: DOCS, files: FILES } });
  });

  it("reads a file path relative to the working directory", () => {
    const project = path.join(dir, "read-file");
    mkdirSync(path.join(project, "config"), { recursive: true });
    writeFileSync(path.join(project, "config", "servers.json"), JSON.stringify({ mcpServers: { files: FILES } }));
    assert.deepEqual(readMcpConfigFlag("config/servers.json", project), { servers: { files: FILES } });
    assert.deepEqual(readMcpConfigFlag(path.join(project, "config", "servers.json"), "/nowhere"), { servers: { files: FILES } });
  });

  it("names the problem with an unreadable file, invalid JSON or a value that is not an object of servers", () => {
    const missing = readMcpConfigFlag("missing.json", dir);
    assert.match(missing.error, new RegExp(`^--mcp-config: cannot read ${path.join(dir, "missing.json")}: ENOENT`));
    assert.match(readMcpConfigFlag('{"docs": ', dir).error, /^--mcp-config: the --mcp-config value is not valid JSON: /);
    const file = path.join(dir, "list.json");
    writeFileSync(file, "[]");
    assert.equal(readMcpConfigFlag(file, dir).error, `--mcp-config: ${file} must be a JSON object of MCP servers by name.`);
    assert.equal(readMcpConfigFlag('{"mcpServers": ["docs"]}', dir).error, '--mcp-config: "mcpServers" in the --mcp-config value must be an object of MCP servers by name.');
  });
});

describe("ampi --mcp-config: the inline extension", () => {
  const host = (lines) => ({
    warn: (text) => lines.push(["warn", text]),
    fail: (text) => lines.push(["fail", text]),
  });

  it("registers every server on every extension load", () => {
    const lines = [];
    const factory = createMcpConfigExtension({ docs: DOCS, files: FILES }, { agentDir: path.join(dir, "no-agent"), configDirName: ".pi" }, host(lines));
    // Pi calls the factory again for every runtime: at startup, then after /reload, /new and the like.
    for (let load = 0; load < 2; load++) {
      const { pi, calls } = createMockPi();
      factory(pi);
      assert.deepEqual(calls.registerMcpServer, [
        { name: "docs", config: DOCS },
        { name: "files", config: FILES },
      ]);
    }
    assert.deepEqual(lines, []);
  });

  it("fails the run with Pi's reason when Pi rejects an entry", () => {
    const lines = [];
    const factory = createMcpConfigExtension({ "bad name": FILES }, { agentDir: dir, configDirName: ".pi" }, host(lines));
    const { pi } = createMockPi({
      onRegisterMcpServer: (name) => {
        throw new Error(`invalid server name "${name}"`);
      },
    });
    factory(pi);
    assert.deepEqual(lines, [["fail", '--mcp-config: invalid server name "bad name"']]);
  });

  it("reports once each server that the user's or a trusted project's mcp.json defines, naming the file Pi uses", async () => {
    const root = path.join(dir, "collide");
    const agentDir = path.join(root, "agent");
    const project = path.join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(path.join(project, ".pi"), { recursive: true });
    writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { "doc-search": DOCS, files: FILES } }));
    // A project entry without command, url or type only overrides the user's server; "notes" is the project's own.
    writeFileSync(path.join(project, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { files: { url: "https://example.com/files" }, solo: { enabled: false }, notes: FILES } }));
    const servers = { doc_search: DOCS, files: FILES, solo: FILES, notes: FILES, own: FILES };

    const startOnce = async (trusted, hasUI) => {
      const lines = [];
      const factory = createMcpConfigExtension(servers, { agentDir, configDirName: ".pi" }, host(lines));
      const notes = [];
      for (const reason of ["startup", "reload"]) {
        const { pi, handlers } = createMockPi();
        factory(pi);
        const { ctx, notifications, state } = createMockExtensionContext({ cwd: project, hasUI });
        state.projectTrusted = trusted;
        await handlers.get("session_start")({ type: "session_start", reason }, ctx);
        notes.push(...notifications);
      }
      return { lines, notes };
    };
    const note = (name, file) => `the MCP server "${name}" from --mcp-config is not used: ${file} defines a server of that name, which Pi uses instead.`;
    const userFile = path.join(agentDir, "mcp.json");
    const projectFile = path.join(project, ".pi", "mcp.json");

    const trusted = await startOnce(true, false);
    assert.deepEqual(trusted.lines, [
      ["warn", note("doc_search", userFile)],
      ["warn", note("files", projectFile)],
      ["warn", note("notes", projectFile)],
    ]);
    const untrusted = await startOnce(false, false);
    assert.deepEqual(untrusted.lines, [
      ["warn", note("doc_search", userFile)],
      ["warn", note("files", userFile)],
    ]);
    // In the terminal UI the report is a notification, so it does not write over the screen.
    const ui = await startOnce(false, true);
    assert.deepEqual(ui.lines, []);
    assert.deepEqual(
      ui.notes.map(({ message, level }) => [level, message]),
      [
        ["warning", `ampi: ${note("doc_search", userFile)}`],
        ["warning", `ampi: ${note("files", userFile)}`],
      ],
    );
  });
});

describe("ampi --mcp-config: the command", { concurrency: true }, () => {
  let runs = 0;

  /** Run the command with piped stdin and stdout in its own home, agent directory and project. */
  const runAmpi = (args, { userMcp } = {}) => {
    const root = path.join(dir, "runs", String(++runs));
    for (const sub of ["home", "agent", "project"]) mkdirSync(path.join(root, sub), { recursive: true });
    if (userMcp) writeFileSync(path.join(root, "agent", "mcp.json"), JSON.stringify(userMcp));
    const env = { PATH: process.env.PATH, HOME: path.join(root, "home"), PI_CODING_AGENT_DIR: path.join(root, "agent"), PI_OFFLINE: "1" };
    const child = spawn(process.execPath, [bin, "-e", fauxModel, "--model", "faux/faux-1", ...args], { cwd: path.join(root, "project"), env });
    child.stdin.end();
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    return new Promise((resolve) => child.on("close", (status) => resolve({ status, stdout, stderr })));
  };

  it("exits 2 before the run for an unreadable file, invalid JSON, an entry Pi rejects, and with --no-mcp", async () => {
    const [missing, invalid, rejected, noMcp] = await Promise.all([
      runAmpi(["-x", "--mcp-config", "servers.json", "hello"]),
      runAmpi(["-x", "--mcp-config", "{docs}", "hello"]),
      runAmpi(["-x", "--mcp-config", JSON.stringify({ docs: { url: "ftp://example.com/mcp" } }), "hello"]),
      runAmpi(["-x", "--no-mcp", "--mcp-config", "{}", "hello"]),
    ]);
    for (const [result, pattern] of [
      [missing, /^ampi: --mcp-config: cannot read \S+servers\.json: ENOENT/],
      [invalid, /^ampi: --mcp-config: the --mcp-config value is not valid JSON: /],
      [rejected, /^ampi: --mcp-config: .*server "docs": url must be an http or https URL\n$/],
      [noMcp, /^ampi: --mcp-config needs Pi's MCP support; leave out --no-mcp\.\n$/],
    ]) {
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, pattern);
    }
  });

  it("runs with a server of the user's mcp.json in place of the flag's, and says so on stderr", async () => {
    const userMcp = { mcpServers: { docs: { url: "https://example.com/mcp", enabled: false } } };
    const result = await runAmpi(["-x", "--mcp-config", JSON.stringify({ mcpServers: { docs: { command: "docs-server" } } }), "hello"], { userMcp });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "Echo: hello\n");
    assert.match(result.stderr, /^ampi: the MCP server "docs" from --mcp-config is not used: \S+mcp\.json defines a server of that name, which Pi uses instead\.$/m);
  });
});
