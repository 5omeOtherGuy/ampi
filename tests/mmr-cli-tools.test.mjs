// `ampi tools list` and `ampi tools show` (packages/ampi-cli/src/tools.js):
// the listing and detail formats against hand-written tool infos, and the
// command itself against the installed Pi and this checkout's ampi, offline,
// in temporary homes and agent directories, with the scripted model in
// fixtures/ampi-cli/faux-model/ so every locked mode can start. A preloaded
// guard (fixtures/ampi-cli/offline-guard.mjs) refuses network access and
// records the child processes the command starts.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { resolveModeArgument, runToolsCommand, toolSource } from "../packages/ampi-cli/src/tools.js";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const bin = path.join(repoRoot, "packages", "ampi-cli", "bin", "ampi.js");
const fauxModel = path.join(import.meta.dirname, "fixtures", "ampi-cli", "faux-model");
const guard = path.join(import.meta.dirname, "fixtures", "ampi-cli", "offline-guard.mjs");

after(() => cleanupLoadedSource());

/** @param {string} file @param {string} text */
const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

describe("ampi tools: listing and detail formats", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ampi-cli-tools-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const extensionFile = path.join(dir, "extensions", "word-count.ts");
  const packageRoot = path.join(dir, "acme");
  write(path.join(packageRoot, "package.json"), JSON.stringify({ name: "acme-tools" }));
  const builtin = (name) => ({ path: `builtin:${name}`, source: "builtin", scope: "temporary", origin: "top-level" });
  const ampiFile = { path: path.join(repoRoot, "src", "extensions", "ampi-shell", "index.ts"), source: "cli", scope: "temporary", origin: "top-level" };

  const read = {
    name: "read",
    description: "Read the contents of a file. Text and images.\n\nLong files are cut; use offset to continue.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file,\n relative or absolute" },
        offset: { type: "number", description: "Line to start at" },
        options: { type: "object", properties: { raw: { type: "boolean" } }, description: "Reading options" },
        limit: { anyOf: [{ type: "number" }, { type: "string" }] },
      },
      required: ["path"],
    },
    sourceInfo: builtin("read"),
  };
  const tools = [
    read,
    {
      name: "shell_command",
      description: "Run a shell command that keeps running in the background while other work continues. Then poll it.",
      parameters: { type: "object", properties: {} },
      sourceInfo: ampiFile,
    },
    { name: "Task", description: "Hand a bounded task to a worker.", parameters: { type: "object", properties: {} }, sourceInfo: ampiFile },
    {
      name: "word_count",
      description: "Count the words in a text.",
      parameters: { type: "object", properties: {} },
      sourceInfo: { path: extensionFile, source: "local", scope: "user", origin: "top-level" },
    },
    {
      name: "lint_check",
      description: "Check a file for lint problems! Returns findings.",
      parameters: { type: "object", properties: {} },
      sourceInfo: { path: path.join(packageRoot, "src", "index.ts"), source: "npm:acme-tools", scope: "user", origin: "package", baseDir: packageRoot },
    },
    {
      name: "mcp__docs__search",
      description: "Search the docs.",
      parameters: { type: "object", properties: {} },
      namespace: { name: "mcp__docs" },
      sourceInfo: builtin("mcp"),
    },
    { name: "read_mcp_resource", description: "Read one resource of an MCP server.", parameters: { type: "object", properties: {} }, sourceInfo: builtin("mcp") },
  ];

  /**
   * Run the command against `tools` without starting Pi.
   *
   * @param {string[]} argv
   * @param {{ mode?: string, mcpServers?: string[], columns?: number }} [found]
   */
  const run = async (argv, found = {}) => {
    let out = "";
    let err = "";
    /** @type {(string | undefined)[]} */
    const requested = [];
    const code = await runToolsCommand(argv, {
      readTools: async (mode) => {
        requested.push(mode);
        return { mode: "mode" in found ? found.mode : (mode ?? "medium"), tools, problems: [], mcpServers: found.mcpServers ?? [] };
      },
      columns: found.columns ?? Number.POSITIVE_INFINITY,
      out: (text) => (out += text),
      err: (text) => (err += text),
    });
    return { code, out, err, requested };
  };

  it("labels each tool with where it comes from", () => {
    assert.deepEqual(
      tools.map((tool) => toolSource(tool)),
      ["built-in", "ampi", "ampi", "extension:word-count", "extension:acme-tools", "mcp", "mcp"],
    );
    const codemode = { ...read, name: "codemode", sourceInfo: builtin("codemode") };
    assert.equal(toolSource(codemode), "built-in");
    const indexFile = { ...read, sourceInfo: { path: path.join(dir, "extensions", "stamp", "index.ts"), source: "local", origin: "top-level" } };
    assert.equal(toolSource(indexFile), "extension:stamp");
  });

  it("lists the tools by source, with names padded and the first sentence cut to the width", async () => {
    const { code, out, err } = await run(["list"], { columns: 64, mcpServers: ["docs"] });
    assert.equal(code, 0, err);
    const lines = out.split("\n");
    const shellRow = lines.find((line) => line.startsWith("  shell_command"));
    assert.ok(shellRow?.endsWith("…") && visibleWidth(shellRow) <= 64 && visibleWidth(shellRow) >= 60, shellRow);
    assert.ok(shellRow.startsWith("  shell_command      Run a shell command that"), shellRow);
    assert.deepEqual(
      lines.map((line) => (line === shellRow ? "<shell_command row>" : line)),
      [
        "7 tools active in medium mode",
        "",
        "built-in",
        "  read               Read the contents of a file",
        "",
        "ampi",
        "<shell_command row>",
        "  Task               Hand a bounded task to a worker",
        "",
        "extension:acme-tools",
        "  lint_check         Check a file for lint problems!",
        "",
        "extension:word-count",
        "  word_count         Count the words in a text",
        "",
        "mcp",
        "  mcp__docs__search  Search the docs",
        "  read_mcp_resource  Read one resource of an MCP server",
        "",
        "1 MCP server is configured; its tools are not listed. ampi mcp list shows it.",
        "",
      ],
    );
  });

  it("prints the list as JSON sorted by name, with each description's first paragraph", async () => {
    for (const argv of [["list", "--json"], ["ls", "--json", "--mode", "medium"]]) {
      const { code, out } = await run(argv);
      assert.equal(code, 0);
      const rows = JSON.parse(out);
      assert.deepEqual(
        rows.map((row) => row.name),
        ["lint_check", "mcp__docs__search", "read", "read_mcp_resource", "shell_command", "Task", "word_count"],
      );
      assert.ok(rows.every((row) => Object.keys(row).join() === "name,source,description"));
      assert.deepEqual(rows[2], { name: "read", source: "built-in", description: "Read the contents of a file. Text and images." });
    }
  });

  it("shows a tool's description and its parameters, required ones marked", async () => {
    const { code, out, requested } = await run(["show", "read", "--mode", "deep"]);
    assert.equal(code, 0);
    assert.deepEqual(requested, ["high"]);
    assert.equal(
      out,
      [
        "read (built-in)",
        "",
        "Read the contents of a file. Text and images.",
        "",
        "Long files are cut; use offset to continue.",
        "",
        "Parameters:",
        "  path (string, required): Path of the file, relative or absolute",
        "  offset (number): Line to start at",
        "  options (object): Reading options",
        "  limit (number | string)",
        "",
      ].join("\n"),
    );
    const none = await run(["show", "Task"]);
    assert.match(none.out, /^Task \(ampi\)\n\nHand a bounded task to a worker\.\n\nParameters:\n {2}none\n$/);
  });

  it("shows a tool as JSON with its input schema", async () => {
    const { code, out } = await run(["show", "--json", "read"]);
    assert.equal(code, 0);
    const shown = JSON.parse(out);
    assert.deepEqual(Object.keys(shown), ["name", "description", "source", "inputSchema"]);
    assert.deepEqual(shown, { name: "read", description: read.description, source: "built-in", inputSchema: read.parameters });
  });

  it("exits 1 for a tool that is not active, naming the mode and up to three close names", async () => {
    const typo = await run(["show", "reed", "--mode", "low"]);
    assert.equal(typo.code, 1);
    assert.equal(typo.out, "");
    assert.equal(typo.err, 'ampi: no tool named "reed" is active in low mode. Did you mean read?\n');
    const many = await run(["show", "_"]);
    assert.equal(many.err, 'ampi: no tool named "_" is active in medium mode. Did you mean lint_check, mcp__docs__search, read_mcp_resource?\n');
    const far = await run(["show", "deploy"]);
    assert.equal(far.err, 'ampi: no tool named "deploy" is active in medium mode. ampi tools list shows the active tools.\n');
  });

  it("exits 2 for an unknown mode, listing the valid ones, before starting a session", async () => {
    const { code, err, requested } = await run(["list", "--mode", "turbo"]);
    assert.equal(code, 2);
    assert.equal(err, 'ampi: unknown mode "turbo". Valid modes: low, medium, high, ultra, free (aliases: rush, smart, deep, fable).\n');
    assert.deepEqual(requested, []);
  });

  it("exits 1 when the mode does not start", async () => {
    const { code, out, err } = await run(["list", "--mode", "ultra"], { mode: undefined });
    assert.equal(code, 1);
    assert.equal(out, "");
    assert.match(err, /^ampi: Ultra mode does not start in this directory/);
  });

  it("exits 2 on usage errors", async () => {
    for (const argv of [[], ["list", "extra"], ["show"], ["show", "a", "b"], ["run"], ["list", "--verbose"]]) {
      const { code, requested } = await run(argv);
      assert.equal(code, 2, argv.join(" "));
      assert.deepEqual(requested, []);
    }
    assert.equal((await run(["--help"])).code, 0);
  });

  it("accepts ampi-core's mode keys and legacy aliases", async () => {
    const { MMR_MODE_KEYS, MMR_LEGACY_MODE_ALIASES } = await importSource("extensions/ampi-core/modes.ts");
    for (const key of MMR_MODE_KEYS) assert.equal(resolveModeArgument(key), key);
    for (const [alias, key] of Object.entries(MMR_LEGACY_MODE_ALIASES)) assert.equal(resolveModeArgument(alias), key);
    assert.equal(resolveModeArgument("turbo"), undefined);
  });
});

/** Git subcommands that only read a repository. */
const READ_ONLY_GIT = new Set(["rev-parse", "status", "log", "show", "diff", "branch", "config", "ls-files", "remote", "describe", "symbolic-ref", "for-each-ref", "cat-file"]);

/**
 * Tools of the mode tables that register only with configuration these runs
 * do not have: a web search backend, session history, GitHub access for the
 * librarian, and an MCP server with resources.
 */
const NOT_CONFIGURED = new Set(["web_search", "read_web_page", "read_session", "find_session", "librarian", "read_mcp_resource"]);

describe("ampi tools: the command", { concurrency: true }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ampi-cli-tools-run-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  // A PATH with node but without git.
  const noGitPath = path.join(dir, "no-git-bin");
  mkdirSync(noGitPath);
  symlinkSync(process.execPath, path.join(noGitPath, "node"));
  const modes = ["low", "medium", "high", "ultra"];
  let runs = 0;

  /** The tools a locked mode declares with the scripted model, whose provider edits with `edit`. */
  const expectedTools = async (mode) => {
    const { getMmrModeToolNames } = await importSource("extensions/ampi-core/modes.ts");
    return getMmrModeToolNames(mode, "edit").filter((name) => !NOT_CONFIGURED.has(name)).sort();
  };

  /**
   * Run the command in its own home, agent directory and project. The user
   * settings load the scripted model and a one-tool extension file, and route
   * every locked mode to the scripted model. The stored credential makes Pi
   * count the scripted provider as signed in the moment it is registered;
   * without one, that waits for an availability check Pi runs in the
   * background, which can still be pending when ampi picks the mode's model.
   *
   * @param {string[]} args
   * @param {{ defaultMode?: string, path?: string }} [options]
   */
  const runAmpi = (args, options = {}) => {
    const root = path.join(dir, String(++runs));
    // Pi's default layout: ampi-core reads its settings from the home directory's .pi/agent.
    const agent = path.join(root, "home", ".pi", "agent");
    const project = path.join(root, "project");
    const extension = path.join(root, "extensions", "word-count.ts");
    write(
      extension,
      [
        "export default function (pi: any): void {",
        "  pi.registerTool({",
        '    name: "word_count",',
        '    label: "Word count",',
        '    description: "Count the words in a text. Separators are runs of whitespace.",',
        '    parameters: { type: "object", properties: { text: { type: "string" }, unique: { type: "boolean" } }, required: ["text"] },',
        '    execute: async () => ({ content: [{ type: "text", text: "0" }], details: {} }),',
        "  });",
        "}",
        "",
      ].join("\n"),
    );
    const preferences = Object.fromEntries(modes.map((mode) => [mode, ["faux/faux-1"]]));
    const ampiCore = { modelPreferences: preferences, ...(options.defaultMode ? { defaultMode: options.defaultMode } : {}) };
    write(path.join(agent, "settings.json"), JSON.stringify({ packages: [fauxModel], extensions: [extension], ampiCore }));
    write(path.join(agent, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "scripted" } }));
    write(path.join(project, "notes.md"), "");
    const guardLog = path.join(root, "guard.jsonl");
    const env = {
      PATH: options.path ?? process.env.PATH,
      HOME: path.join(root, "home"),
      PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: "1",
      AMPI_TEST_GUARD_LOG: guardLog,
    };
    const child = spawn(process.execPath, ["--import", guard, bin, ...args], { cwd: project, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    return new Promise((resolve) =>
      child.on("close", (status) => {
        const guarded = existsSync(guardLog)
          ? readFileSync(guardLog, "utf8").trimEnd().split("\n").filter(Boolean).map((line) => JSON.parse(line))
          : [];
        resolve({ root, agent, project, status, stdout, stderr, guarded });
      }),
    );
  };

  /** Fail on a refused network access or a child process other than read-only git. */
  const assertOffline = (result) => {
    assert.deepEqual(
      result.guarded.filter((entry) => entry.violation),
      [],
      "no network access",
    );
    for (const { child } of result.guarded.filter((entry) => entry.child)) {
      const [command, subcommand] = child;
      assert.ok(path.basename(command) === "git" && READ_ONLY_GIT.has(subcommand), `unexpected child process: ${child.join(" ")}`);
    }
  };

  /** Fail when a run wrote a session file, or anything in the project. */
  const assertNoSessionWritten = (result) => {
    const files = (top) => readdirSync(top, { recursive: true }).map(String).sort();
    assert.equal(existsSync(path.join(result.agent, "sessions")), false, "no sessions directory");
    assert.ok(
      files(path.join(result.root, "home")).every((file) => !file.endsWith(".jsonl")),
      "no session file",
    );
    assert.deepEqual(files(result.project), ["notes.md"]);
  };

  /** @param {string} stdout */
  const namesOf = (stdout) => JSON.parse(stdout).map((row) => row.name).sort();

  /** @type {Map<string, ReturnType<typeof runAmpi>>} One run per mode, shared with the run without git. */
  const listings = new Map();
  /** @param {string} given */
  const listJson = (given) => {
    if (!listings.has(given)) listings.set(given, runAmpi(["tools", "list", "--json", "--mode", given]));
    return /** @type {ReturnType<typeof runAmpi>} */ (listings.get(given));
  };

  for (const [mode, given] of [["low", "rush"], ["medium", "medium"], ["high", "high"], ["ultra", "ultra"]]) {
    it(`lists ${mode} mode's tools from its mode table${given === mode ? "" : ` when named by its alias ${given}`}`, async () => {
      const result = await listJson(given);
      assert.equal(result.status, 0, result.stderr);
      assertOffline(result);
      assertNoSessionWritten(result);
      assert.deepEqual(namesOf(result.stdout), await expectedTools(mode));
      for (const row of JSON.parse(result.stdout)) {
        assert.deepEqual(Object.keys(row), ["name", "source", "description"]);
        assert.ok(["built-in", "ampi"].includes(row.source), `${row.name}: ${row.source}`);
        assert.equal(typeof row.description, "string");
      }
    });
  }

  it("lists free mode's tools: Pi's default tools and other extensions' tools, labelled extension:<name>", async () => {
    const result = await runAmpi(["tools", "list", "--json", "--mode", "free"]);
    assert.equal(result.status, 0, result.stderr);
    assertOffline(result);
    assertNoSessionWritten(result);
    const rows = JSON.parse(result.stdout);
    // Pi's default tools (Pi's docs/cli.md) and the settings-declared extension's tool.
    assert.deepEqual(
      rows.map((row) => [row.name, row.source]),
      [
        ["bash", "built-in"],
        ["edit", "built-in"],
        ["read", "built-in"],
        ["word_count", "extension:word-count"],
        ["write", "built-in"],
      ],
    );
    assert.equal(rows[3].description, "Count the words in a text. Separators are runs of whitespace.");
  });

  it("starts in the settings' default mode without --mode, and lists the same tools without git on PATH", async (t) => {
    const result = await runAmpi(["tools", "list"], { defaultMode: "high", path: noGitPath });
    assert.equal(result.status, 0, result.stderr);
    const withGit = await listJson("high");
    for (const [label, run] of [["with git", withGit], ["without git", result]]) {
      const children = run.guarded.filter((entry) => entry.child).map((entry) => entry.child.join(" "));
      t.diagnostic(`child processes ${label}: ${children.length > 0 ? children.join("; ") : "none"}`);
    }
    assertOffline(result);
    assertNoSessionWritten(result);
    assert.deepEqual(
      result.guarded.filter((entry) => entry.child),
      result.guarded.filter((entry) => entry.child && path.basename(entry.child[0]) === "git"),
    );
    const [count, ...rest] = result.stdout.split("\n");
    const names = rest.filter((line) => line.startsWith("  ")).map((line) => line.trim().split(/\s+/)[0]).sort();
    assert.equal(count, `${names.length} tools active in high mode`);
    assert.deepEqual(names, await expectedTools("high"));
    assert.deepEqual(names, namesOf(withGit.stdout));
  });

  it("shows a settings-declared extension's tool with its required and optional parameters", async () => {
    const result = await runAmpi(["tools", "show", "word_count", "--mode", "free"]);
    assert.equal(result.status, 0, result.stderr);
    assertOffline(result);
    assert.equal(
      result.stdout,
      [
        "word_count (extension:word-count)",
        "",
        "Count the words in a text. Separators are runs of whitespace.",
        "",
        "Parameters:",
        "  text (string, required)",
        "  unique (boolean)",
        "",
      ].join("\n"),
    );
  });

  it("exits 2 for an unknown mode without starting a session", async () => {
    const result = await runAmpi(["tool", "ls", "--mode", "turbo"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Valid modes: low, medium, high, ultra, free/);
    assert.deepEqual(result.guarded, []);
  });
});
