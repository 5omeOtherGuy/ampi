// The `ampi` command's argument router (packages/ampi-cli/src/argv.js): which
// command runs, what Pi receives, and which ampi options are read. Plain
// JavaScript, imported directly.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { routeAmpiArgv } from "../packages/ampi-cli/src/argv.js";

describe("ampi argv router: starting Pi", () => {
  it("starts Pi with no arguments when given none", () => {
    const route = routeAmpiArgv([]);
    assert.equal(route.command, "pi");
    assert.deepEqual(route.piArgs, []);
    assert.deepEqual(route.notices, []);
  });

  it("translates every spelling of the agent mode to --ampi-mode", () => {
    for (const argv of [["-m", "high"], ["-mhigh"], ["--mode", "high"], ["--mode=high"]]) {
      const route = routeAmpiArgv(argv);
      assert.equal(route.command, "pi", argv.join(" "));
      assert.deepEqual(route.piArgs, ["--ampi-mode", "high"], argv.join(" "));
      assert.equal(route.options.mode, "high");
    }
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

  it("accepts --title and repeated -l/--label, keeps them, and tells the user they are ignored", () => {
    const route = routeAmpiArgv(["--title", "Release notes", "-l", "docs", "--label", "release", "go"]);
    assert.equal(route.command, "pi");
    assert.deepEqual(route.piArgs, ["go"]);
    assert.equal(route.options.title, "Release notes");
    assert.deepEqual(route.options.labels, ["docs", "release"]);
    assert.equal(route.notices.length, 2);
    assert.match(route.notices[0], /--title .*ignored/);
    assert.match(route.notices[1], /--label .*ignored/);
  });

  it("maps --pi-help to Pi's own --help", () => {
    const route = routeAmpiArgv(["--pi-help"]);
    assert.equal(route.command, "pi");
    assert.deepEqual(route.piArgs, ["--help"]);
  });

  it("hands Pi's own commands to Pi untouched, -l included", () => {
    for (const argv of [["install", "npm:x", "-l"], ["list"], ["config", "-l"], ["mcp", "status"], ["update", "--extensions"]]) {
      const route = routeAmpiArgv(argv);
      assert.equal(route.command, "pi-command", argv.join(" "));
      assert.deepEqual(route.piArgs, argv);
    }
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

  it("rejects ampi options that are missing their value", () => {
    for (const [argv, pattern] of [
      [["-m"], /-m needs a mode/],
      [["--mode"], /--mode needs a mode/],
      [["--title"], /--title needs a value/],
      [["-l"], /-l needs a value/],
    ]) {
      const route = routeAmpiArgv(argv);
      assert.equal(route.command, "error", argv.join(" "));
      assert.match(route.error, pattern);
    }
  });
});
