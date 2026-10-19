// The `ampi` command's argument router (packages/ampi-cli/src/argv.js): which
// command runs, what Pi receives, and which ampi options are read. Plain
// JavaScript, imported directly.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs } from "@earendil-works/pi-coding-agent";
import { AMPI_COMMANDS, PI_COMMANDS, routeAmpiArgv } from "../packages/ampi-cli/src/argv.js";

describe("ampi argv router: starting Pi", () => {
  it("starts Pi with no arguments when given none", () => {
    const route = routeAmpiArgv([]);
    assert.equal(route.command, "pi");
    assert.deepEqual(route.piArgs, []);
  });

  it("translates every spelling of the agent mode to --ampi-mode", () => {
    for (const argv of [["-m", "high"], ["-mhigh"], ["--mode", "high"], ["--mode=high"]]) {
      const route = routeAmpiArgv(argv);
      assert.equal(route.command, "pi", argv.join(" "));
      assert.deepEqual(route.piArgs, ["--ampi-mode", "high"], argv.join(" "));
      assert.equal(route.options.mode, "high");
    }
  });

  it("passes a registered mode's key or label through unchecked, for ampi-core to resolve", () => {
    assert.deepEqual(routeAmpiArgv(["-m", "review", "-x", "hi"]).piArgs.slice(0, 2), ["--ampi-mode", "review"]);
    assert.deepEqual(routeAmpiArgv(["--mode", "Review"]).piArgs, ["--ampi-mode", "Review"]);
    assert.equal(routeAmpiArgv(["--mode=SKETCH"]).options.mode, "SKETCH");
  });

  it("keeps Pi's output modes on --mode but not on -m", () => {
    assert.deepEqual(routeAmpiArgv(["--mode", "json", "-p", "hi"]).piArgs, ["--mode", "json", "-p", "hi"]);
    assert.equal(routeAmpiArgv(["--mode", "rpc"]).options.mode, undefined);
    assert.deepEqual(routeAmpiArgv(["-m", "json"]).piArgs, ["--ampi-mode", "json"]);
  });

  it("passes unknown options, their values and positionals to Pi in order", () => {
    const argv = ["--model", "faux/faux-1", "-c", "--thinking", "high", "--name=x", "fix", "the", "build"];
    assert.deepEqual(routeAmpiArgv(argv).piArgs, argv);
    const mixed = routeAmpiArgv(["--model", "a/b", "-m", "low", "@notes.md", "go"]);
    assert.deepEqual(mixed.piArgs, ["--model", "a/b", "--ampi-mode", "low", "@notes.md", "go"]);
  });

  it("passes groups of short flags as written instead of reading ampi letters in them", () => {
    assert.deepEqual(routeAmpiArgv(["-ne", "-e", "./ext.ts"]).piArgs, ["-ne", "-e", "./ext.ts"]);
    assert.deepEqual(routeAmpiArgv(["-nm", "low"]).piArgs, ["-nm", "low"]);
  });

  it("passes the value of Pi's value options untouched, even when it looks like an ampi option", () => {
    for (const argv of [
      ["--append-system-prompt", "-v"],
      ["--system-prompt", "--help"],
      ["--model", "-m"],
      ["-n", "-l"],
      ["-e", "-h", "-m", "low"],
    ]) {
      const route = routeAmpiArgv(argv);
      assert.equal(route.command, "pi", argv.join(" "));
      const expected = argv.at(-1) === "low" ? ["-e", "-h", "--ampi-mode", "low"] : argv;
      assert.deepEqual(route.piArgs, expected, argv.join(" "));
    }
    // Without a Pi value option in front, the same arguments are ampi's.
    assert.equal(routeAmpiArgv(["--verbose", "-v"]).command, "version");
  });

  it("hands everything after -- to Pi without reading it", () => {
    const route = routeAmpiArgv(["-m", "low", "--", "-m", "is", "--help", "text"]);
    assert.equal(route.command, "pi");
    assert.deepEqual(route.piArgs, ["--ampi-mode", "low", "--", "-m", "is", "--help", "text"]);
  });

  it("names the session with --title through Pi's --name and keeps repeated -l/--label for the thread index", () => {
    const route = routeAmpiArgv(["--title", "Release notes", "-l", "docs", "--label", "release", "go"]);
    assert.equal(route.command, "pi");
    assert.deepEqual(route.piArgs, ["--name", "Release notes", "go"]);
    assert.equal(route.options.title, "Release notes");
    assert.deepEqual(route.options.labels, ["docs", "release"]);
  });

  it("translates --fast to --ampi-fast=true once, interactive and in execute mode", () => {
    assert.equal(routeAmpiArgv(["fix it"]).options.fast, false);
    const interactive = routeAmpiArgv(["--fast", "-m", "high", "fix it"]);
    assert.equal(interactive.command, "pi");
    assert.deepEqual(interactive.piArgs, ["--ampi-fast=true", "--ampi-mode", "high", "fix it"]);
    assert.equal(interactive.options.fast, true);
    const execute = routeAmpiArgv(["-x", "fix it", "--fast", "--fast"]);
    assert.deepEqual(execute.piArgs, ["fix it", "--ampi-fast=true"]);
    assert.deepEqual([execute.options.execute, execute.options.fast], [true, true]);
    // After -- it is part of the message.
    assert.deepEqual(routeAmpiArgv(["--", "--fast"]).piArgs, ["--", "--fast"]);
  });

  it("translates --dangerously-allow-all to --ampi-dangerously-allow-all once, with its value attached", () => {
    assert.equal(routeAmpiArgv(["fix it"]).options.dangerouslyAllowAll, false);
    // Attached, so Pi's parser cannot take the message that follows for the flag's value.
    const route = routeAmpiArgv(["-x", "--dangerously-allow-all", "fix it", "--dangerously-allow-all"]);
    assert.deepEqual(route.piArgs, ["--ampi-dangerously-allow-all=true", "fix it"]);
    assert.deepEqual([route.options.execute, route.options.dangerouslyAllowAll], [true, true]);
    assert.deepEqual(parseArgs(route.piArgs).messages, ["fix it"]);
    assert.deepEqual(routeAmpiArgv(["--dangerously-allow-all"]).piArgs, ["--ampi-dangerously-allow-all=true"]);
    // After --, it is part of the message.
    const passed = routeAmpiArgv(["--", "--dangerously-allow-all"]);
    assert.deepEqual(passed.piArgs, ["--", "--dangerously-allow-all"]);
    assert.equal(passed.options.dangerouslyAllowAll, false);
  });

  it("reads -x/--execute, --timings and --no-archive-after-execute and keeps them away from Pi", () => {
    const plain = routeAmpiArgv(["fix", "it"]).options;
    assert.deepEqual([plain.execute, plain.timings, plain.archive], [false, false, true]);
    for (const flag of ["-x", "--execute"]) {
      const route = routeAmpiArgv([flag, "--timings", "--no-archive-after-execute", "-m", "high", "fix it"]);
      assert.equal(route.command, "pi", flag);
      assert.deepEqual(route.piArgs, ["--ampi-mode", "high", "fix it"], flag);
      assert.deepEqual([route.options.execute, route.options.timings, route.options.archive], [true, true, false], flag);
    }
  });

  it("reads --stream-json and --stream-json-thinking, which implies it, and keeps them away from Pi", () => {
    const plain = routeAmpiArgv(["-x", "go"]).options;
    assert.deepEqual([plain.streamJson, plain.streamJsonThinking], [false, false]);
    const stream = routeAmpiArgv(["-x", "go", "--stream-json"]);
    assert.deepEqual(stream.piArgs, ["go"]);
    assert.deepEqual([stream.options.streamJson, stream.options.streamJsonThinking], [true, false]);
    const thinking = routeAmpiArgv(["-x", "--stream-json-thinking", "go"]);
    assert.deepEqual(thinking.piArgs, ["go"]);
    assert.deepEqual([thinking.options.streamJson, thinking.options.streamJsonThinking], [true, true]);
  });

  it("reads --stream-json-input together with --stream-json or --stream-json-thinking and keeps it away from Pi", () => {
    assert.equal(routeAmpiArgv(["-x", "--stream-json"]).options.streamJsonInput, false);
    for (const flag of ["--stream-json", "--stream-json-thinking"]) {
      const route = routeAmpiArgv(["-x", "--stream-json-input", flag, "--model", "a/b"]);
      assert.equal(route.command, "pi", flag);
      assert.equal(route.options.streamJsonInput, true, flag);
      assert.deepEqual(route.piArgs, ["--model", "a/b"], flag);
    }
  });

  it("reads --stats, --output-tool and --mcp-config in both spellings and keeps them away from Pi", () => {
    const plain = routeAmpiArgv(["-x", "go"]).options;
    assert.deepEqual([plain.stats, plain.outputTool, plain.mcpConfig, plain.pluginReadyTimeout], [false, undefined, undefined, undefined]);
    const stats = routeAmpiArgv(["-x", "--stats", "go"]);
    assert.equal(stats.options.stats, true);
    assert.deepEqual(stats.piArgs, ["go"]);
    for (const argv of [["--output-tool", "read", "go"], ["--output-tool=read", "go"]]) {
      const route = routeAmpiArgv(["-x", ...argv]);
      assert.equal(route.options.outputTool, "read", argv.join(" "));
      assert.deepEqual(route.piArgs, ["go"], argv.join(" "));
    }
    const json = '{"docs": {"url": "https://example.com/mcp"}}';
    for (const argv of [["--mcp-config", json, "go"], [`--mcp-config=${json}`, "go"], ["--mcp-config", "servers.json", "go"]]) {
      const route = routeAmpiArgv(argv);
      assert.equal(route.command, "pi", argv.join(" "));
      assert.equal(route.options.mcpConfig, argv[0] === "--mcp-config" ? argv[1] : json, argv.join(" "));
      assert.deepEqual(route.piArgs, ["go"], argv.join(" "));
    }
  });

  it("reads --plugin-ready-timeout bare, with = and with a number of seconds after it, and keeps a message after it", () => {
    const cases = [
      [["--plugin-ready-timeout"], 10, []],
      [["--plugin-ready-timeout=0"], 0, []],
      [["--plugin-ready-timeout=300", "go"], 300, ["go"]],
      [["--plugin-ready-timeout", "30", "x"], 30, ["x"]],
      [["--plugin-ready-timeout", "0", "x"], 0, ["x"]],
      [["--plugin-ready-timeout", "fix the bug"], 10, ["fix the bug"]],
      // Not a number of seconds from 0 to 300, so it is the message.
      [["--plugin-ready-timeout", "301"], 10, ["301"]],
      [["--plugin-ready-timeout", "--model", "a/b"], 10, ["--model", "a/b"]],
    ];
    for (const [argv, seconds, piArgs] of cases) {
      const route = routeAmpiArgv(["-x", ...argv]);
      assert.equal(route.command, "pi", argv.join(" "));
      assert.equal(route.options.pluginReadyTimeout, seconds, argv.join(" "));
      assert.deepEqual(route.piArgs, piArgs, argv.join(" "));
    }
  });

  it("maps --pi-help to Pi's own --help", () => {
    const route = routeAmpiArgv(["--pi-help"]);
    assert.equal(route.command, "pi");
    assert.deepEqual(route.piArgs, ["--help"]);
  });

  it("hands Pi's own commands to Pi untouched, -l included", () => {
    for (const argv of [["install", "npm:x", "-l"], ["list"], ["config"], ["config", "-l"], ["config", "--help"], ["auth"], ["update", "--extensions"]]) {
      const route = routeAmpiArgv(argv);
      assert.equal(route.command, "pi-command", argv.join(" "));
      assert.deepEqual(route.piArgs, argv);
    }
  });

  it("keeps update and up with only ampi's update options for ampi, with the rest of the command line", () => {
    for (const [argv, updateArgs] of [
      [["update"], []],
      [["up"], []],
      [["update", "--porcelain"], ["--porcelain"]],
      [["up", "--target-version", "0.4.0", "--porcelain"], ["--target-version", "0.4.0", "--porcelain"]],
      [["update", "--target-version=0.4.0"], ["--target-version=0.4.0"]],
      [["update", "-h"], ["-h"]],
      // A missing value is the update module's usage error, not Pi's argument.
      [["update", "--target-version"], ["--target-version"]],
    ]) {
      const route = routeAmpiArgv(argv);
      assert.equal(route.command, "update", argv.join(" "));
      assert.deepEqual(route.updateArgs, updateArgs, argv.join(" "));
      assert.deepEqual(route.piArgs, []);
    }
  });

  it("hands update and up with any of Pi's update arguments to Pi's update verbatim, up as update", () => {
    for (const [argv, piArgs] of [
      [["update", "--extensions"], ["update", "--extensions"]],
      [["up", "--extensions"], ["update", "--extensions"]],
      [["update", "npm:some-package"], ["update", "npm:some-package"]],
      [["update", "--extension", "npm:x", "--force"], ["update", "--extension", "npm:x", "--force"]],
      [["update", "self"], ["update", "self"]],
      [["up", "pi"], ["update", "pi"]],
      [["update", "--all"], ["update", "--all"]],
      [["update", "--models"], ["update", "--models"]],
      [["update", "--self"], ["update", "--self"]],
      [["update", "--extensions", "--help"], ["update", "--extensions", "--help"]],
      [["update", "--", "--porcelain"], ["update", "--", "--porcelain"]],
    ]) {
      const route = routeAmpiArgv(argv);
      assert.equal(route.command, "pi-command", argv.join(" "));
      assert.deepEqual(route.piArgs, piArgs, argv.join(" "));
    }
  });

  it("refuses ampi's update options mixed with Pi's update arguments, saying which is whose", () => {
    const route = routeAmpiArgv(["update", "--porcelain", "--extensions"]);
    assert.equal(route.command, "error");
    assert.equal(route.error, "--porcelain is an option of ampi's own update, and --extensions goes to Pi's update; run them as two commands.");
    assert.equal(route.usageHint, "Run ampi update --help for both.");
    const both = routeAmpiArgv(["up", "--target-version", "0.4.0", "--porcelain", "npm:x", "--force"]);
    assert.equal(both.error, "--target-version and --porcelain are options of ampi's own update, and npm:x --force go to Pi's update; run them as two commands.");
  });

  it("routes doctor with the rest of the command line", () => {
    const route = routeAmpiArgv(["doctor", "--json"]);
    assert.equal(route.command, "doctor");
    assert.deepEqual(route.doctorArgs, ["--json"]);
    assert.deepEqual(route.piArgs, []);
  });

  it("routes review with the rest of the command line, Pi's --thinking included, and sends review after -- to Pi", () => {
    const route = routeAmpiArgv(["--log-level", "debug", "review", "the", "last", "commit", "--thinking", "high", "-l", "ci"]);
    assert.equal(route.command, "review");
    assert.deepEqual(route.reviewArgs, ["the", "last", "commit", "--thinking", "high", "-l", "ci"]);
    assert.deepEqual(route.piArgs, []);
    assert.deepEqual(route.options.labels, [], "-l after review is review's own");
    assert.equal(route.options.logLevel, "debug");

    const message = routeAmpiArgv(["--", "review", "x"]);
    assert.equal(message.command, "pi");
    assert.deepEqual(message.piArgs, ["--", "review", "x"]);
  });

  it("keeps config keymap and config edit for ampi, with the rest of their command line", () => {
    assert.deepEqual(routeAmpiArgv(["config", "keymap"]).configArgs, ["keymap"]);
    const edit = routeAmpiArgv(["config", "edit", "--workspace"]);
    assert.equal(edit.command, "config");
    assert.deepEqual(edit.configArgs, ["edit", "--workspace"]);
    assert.deepEqual(edit.piArgs, []);
  });

  it("keeps dev keys for ampi, and leaves every other message starting with dev to Pi", () => {
    const keys = routeAmpiArgv(["dev", "keys", "--raw"]);
    assert.equal(keys.command, "dev");
    assert.deepEqual(keys.devArgs, ["keys", "--raw"]);
    assert.deepEqual(keys.piArgs, []);
    for (const argv of [["dev"], ["dev", "server", "is", "down"], ["dev", "--raw"]]) {
      const route = routeAmpiArgv(argv);
      assert.equal(route.command, "pi", argv.join(" "));
      assert.deepEqual(route.piArgs, argv);
    }
  });

  it("routes permissions and its alias permission with each subcommand and the rest of the command line", () => {
    for (const group of ["permissions", "permission"]) {
      for (const rest of [[], ["list", "--json"], ["ls"], ["test", "bash", "--command", "git push", "-q"], ["edit", "--workspace"], ["add", "ask", "bash", "-m", "x"]]) {
        const route = routeAmpiArgv([group, ...rest]);
        assert.equal(route.command, "permissions", [group, ...rest].join(" "));
        assert.deepEqual(route.permissionsArgs, rest);
        assert.deepEqual(route.piArgs, []);
      }
    }
    const message = routeAmpiArgv(["permissionsx", "list"]);
    assert.equal(message.command, "pi");
    assert.deepEqual(message.piArgs, ["permissionsx", "list"]);
  });

  it("routes tools and its alias tool with the rest of the command line, -m included", () => {
    for (const group of ["tools", "tool"]) {
      const route = routeAmpiArgv([group, "list", "-m", "high", "--json"]);
      assert.equal(route.command, "tools", group);
      assert.deepEqual(route.toolsArgs, ["list", "-m", "high", "--json"]);
      assert.deepEqual(route.piArgs, []);
    }
  });

  it("routes top with the rest of its command line, and sends top after -- to Pi as the message", () => {
    for (const argv of [["top"], ["top", "--stream-jsonl"], ["top", "--json", "-m", "high", "--help"]]) {
      const route = routeAmpiArgv(argv);
      assert.equal(route.command, "top", argv.join(" "));
      assert.deepEqual(route.topArgs, argv.slice(1));
      assert.deepEqual(route.piArgs, []);
    }
    for (const argv of [
      ["--", "top"],
      ["fix", "top"],
    ]) {
      const route = routeAmpiArgv(argv);
      assert.equal(route.command, "pi", argv.join(" "));
      assert.deepEqual(route.piArgs, argv);
    }
  });

  it("routes completions and the hidden __complete with the rest of the command line", () => {
    const completions = routeAmpiArgv(["completions", "bash"]);
    assert.equal(completions.command, "completions");
    assert.deepEqual(completions.completionsArgs, ["bash"]);
    assert.deepEqual(completions.piArgs, []);
    const complete = routeAmpiArgv(["__complete", "bash", "--", "ampi", ""]);
    assert.equal(complete.command, "complete");
    assert.deepEqual(complete.completeArgs, ["bash", "--", "ampi", ""]);
    assert.equal(routeAmpiArgv(["--log-level", "debug", "completions", "zsh"]).command, "completions");
    // Only as the first word: elsewhere it is part of the message.
    assert.deepEqual(routeAmpiArgv(["fix", "__complete"]).piArgs, ["fix", "__complete"]);
  });

  it("routes exactly the commands and aliases in the exported command list", () => {
    const expected = {
      help: "help",
      version: "version",
      threads: "threads",
      last: "threads",
      usage: "threads",
      tools: "tools",
      tool: "tools",
      app: "app",
      top: "top",
      skill: "skill",
      skills: "skill",
      mcp: "mcp",
      permissions: "permissions",
      permission: "permissions",
      doctor: "doctor",
      review: "review",
      update: "update",
      up: "update",
      config: "pi-command",
      dev: "pi",
      completions: "completions",
      __complete: "complete",
    };
    const listed = Object.entries(AMPI_COMMANDS).flatMap(([name, aliases]) => [name, ...aliases]);
    assert.deepEqual(listed.sort(), Object.keys(expected).sort());
    for (const [word, command] of Object.entries(expected)) assert.equal(routeAmpiArgv([word]).command, command, word);
    assert.equal(routeAmpiArgv(["config", "keymap"]).command, "config");
    assert.equal(routeAmpiArgv(["dev", "keys"]).command, "dev");
    for (const word of PI_COMMANDS) assert.equal(routeAmpiArgv([word, "x"]).command, "pi-command", word);
    for (const word of ["thread", "complete", "completion", "Help"]) assert.equal(routeAmpiArgv([word]).command, "pi", word);
  });
});

describe("ampi argv router: help, version and errors", () => {
  it("prints help for the help command and for -h/--help anywhere before --", () => {
    for (const argv of [["help"], ["--help"], ["-h"], ["-m", "low", "--help"]]) {
      assert.equal(routeAmpiArgv(argv).command, "help", argv.join(" "));
    }
    assert.equal(routeAmpiArgv(["--", "--help"]).command, "pi");
  });

  it("prints versions for the version command, -V, -v and --version", () => {
    for (const argv of [["version"], ["-V"], ["-v"], ["--version"]]) {
      assert.equal(routeAmpiArgv(argv).command, "version", argv.join(" "));
    }
  });

  it("treats help and version as commands only in first position", () => {
    const route = routeAmpiArgv(["bump", "the", "version"]);
    assert.equal(route.command, "pi");
    assert.deepEqual(route.piArgs, ["bump", "the", "version"]);
  });

  it("rejects --settings-file and names the supported alternative", () => {
    const route = routeAmpiArgv(["--settings-file", "/tmp/s.json"]);
    assert.equal(route.command, "error");
    assert.match(route.error, /--settings-file is not supported/);
    assert.match(route.error, /PI_CODING_AGENT_DIR/);
    assert.deepEqual(route.piArgs, []);
  });

  it("rejects --stream-json-input without stream JSON output", () => {
    for (const argv of [["-x", "--stream-json-input"], ["--stream-json-input", "-x", "--mode", "json"]]) {
      const route = routeAmpiArgv(argv);
      assert.equal(route.command, "error", argv.join(" "));
      assert.equal(route.error, "--stream-json-input needs --stream-json or --stream-json-thinking.");
    }
  });

  it("rejects --stats and --output-tool together with stream JSON or with each other", () => {
    for (const [argv, message] of [
      [["-x", "--stats", "--stream-json"], "--stats cannot be combined with --stream-json."],
      [["-x", "--stream-json-thinking", "--stats"], "--stats cannot be combined with --stream-json-thinking."],
      [["-x", "--output-tool", "bash", "--stream-json"], "--output-tool cannot be combined with --stream-json."],
      [["-x", "--output-tool=bash", "--stream-json-thinking"], "--output-tool cannot be combined with --stream-json-thinking."],
      [["-x", "--stats", "--output-tool", "bash"], "--stats cannot be combined with --output-tool."],
    ]) {
      const route = routeAmpiArgv(argv);
      assert.equal(route.command, "error", argv.join(" "));
      assert.equal(route.error, message);
      assert.deepEqual(route.piArgs, []);
    }
  });

  it("rejects a --plugin-ready-timeout value outside 0 to 300 seconds", () => {
    for (const value of ["301", "-1", "", "5s", "1.5", "1000"]) {
      const route = routeAmpiArgv(["-x", `--plugin-ready-timeout=${value}`, "go"]);
      assert.equal(route.command, "error", value);
      assert.equal(route.error, `--plugin-ready-timeout takes whole seconds from 0 to 300, not "${value}".`);
    }
    // Followed by -1, which is not a number of seconds, the flag is bare and -1 goes to Pi.
    const bare = routeAmpiArgv(["-x", "--plugin-ready-timeout", "-1"]);
    assert.equal(bare.options.pluginReadyTimeout, 10);
    assert.deepEqual(bare.piArgs, ["-1"]);
  });

  it("rejects a second --mcp-config", () => {
    const route = routeAmpiArgv(["--mcp-config", "a.json", "--mcp-config={}"]);
    assert.equal(route.command, "error");
    assert.equal(route.error, "--mcp-config can be given only once.");
  });

  it("rejects ampi options that are missing their value", () => {
    for (const [argv, pattern] of [
      [["-m"], /-m needs a mode/],
      [["--mode"], /--mode needs a mode/],
      [["--title"], /--title needs a value/],
      [["-l"], /-l needs a value/],
      [["-x", "--output-tool"], /--output-tool needs a tool name/],
      [["-x", "--output-tool="], /--output-tool needs a tool name/],
      [["--mcp-config"], /--mcp-config needs MCP servers/],
    ]) {
      const route = routeAmpiArgv(argv);
      assert.equal(route.command, "error", argv.join(" "));
      assert.match(route.error, pattern);
    }
  });
});

describe("ampi argv router: logging and colour options", () => {
  it("reads --log-level and --log-file in both forms and --color and --no-color, and keeps them away from Pi", () => {
    for (const argv of [
      ["--log-level", "debug", "--log-file", "ampi.log", "--no-color", "-m", "low", "go"],
      ["-m", "low", "--log-level=debug", "go", "--no-color", "--log-file=ampi.log"],
    ]) {
      const route = routeAmpiArgv(argv);
      assert.equal(route.command, "pi", argv.join(" "));
      assert.deepEqual(route.piArgs, ["--ampi-mode", "low", "go"], argv.join(" "));
      assert.deepEqual([route.options.logLevel, route.options.logFile, route.options.color], ["debug", "ampi.log", false], argv.join(" "));
    }
    const plain = routeAmpiArgv(["go"]).options;
    assert.deepEqual([plain.logLevel, plain.logFile, plain.color], [undefined, undefined, undefined]);
  });

  it("lets the last colour flag win", () => {
    assert.equal(routeAmpiArgv(["--no-color", "--color"]).options.color, true);
    assert.equal(routeAmpiArgv(["--color", "--no-color"]).options.color, false);
  });

  it("reads them before ampi's commands and Pi's, which then get the rest of the command line", () => {
    const threads = routeAmpiArgv(["--log-level", "warn", "--color", "threads", "list", "--json"]);
    assert.equal(threads.command, "threads");
    assert.deepEqual(threads.threadArgs, ["threads", "list", "--json"]);
    assert.deepEqual([threads.options.logLevel, threads.options.color], ["warn", true]);
    const install = routeAmpiArgv(["--no-color", "--log-file=pi.log", "install", "npm:x", "-l"]);
    assert.equal(install.command, "pi-command");
    assert.deepEqual(install.piArgs, ["install", "npm:x", "-l"]);
    assert.deepEqual([install.options.logFile, install.options.color], ["pi.log", false]);
    const config = routeAmpiArgv(["--log-level=debug", "config", "keymap"]);
    assert.deepEqual([config.command, config.configArgs, config.options.logLevel], ["config", ["keymap"], "debug"]);
    assert.equal(routeAmpiArgv(["--color", "help"]).command, "help");
    // After a command they belong to that command, which reads its own options.
    assert.deepEqual(routeAmpiArgv(["threads", "list", "--color"]).threadArgs, ["threads", "list", "--color"]);
  });

  it("leaves them to Pi after --", () => {
    const route = routeAmpiArgv(["--", "--log-level", "nonsense", "--no-color"]);
    assert.equal(route.command, "pi");
    assert.deepEqual(route.piArgs, ["--", "--log-level", "nonsense", "--no-color"]);
    assert.equal(route.options.logLevel, undefined);
  });

  it("rejects an unknown level and a missing level or file, before a command too", () => {
    for (const [argv, message] of [
      [["--log-level", "verbose"], '--log-level must be error, warn, info or debug, not "verbose".'],
      [["--log-level=INFO", "threads"], '--log-level must be error, warn, info or debug, not "INFO".'],
      [["--log-level"], "--log-level needs a level: error, warn, info or debug."],
      [["--log-level="], "--log-level needs a level: error, warn, info or debug."],
      [["-x", "go", "--log-file"], "--log-file needs a file path."],
      [["--log-file=", "threads"], "--log-file needs a file path."],
    ]) {
      const route = routeAmpiArgv(argv);
      assert.equal(route.command, "error", argv.join(" "));
      assert.equal(route.error, message, argv.join(" "));
      assert.deepEqual(route.piArgs, []);
    }
  });
});
