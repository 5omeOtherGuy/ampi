// `ampi review` (packages/ampi-cli/src/review.js and ampi-workers'
// /ampi-review-run in src/extensions/ampi-workers/builtin-workers/review-run.ts):
//
//   1. The command line, through runReviewCommand with a fake Pi runner that
//      reads the request file: every option's mapping, the default
//      description, usage errors and help.
//   2. Output, exit codes and the recorded thread, from hand-written output
//      files: text and JSON, failures, Pi stopping first, an ampi too old for
//      review, the session and the thread index.
//   3. The findings parser on hand-written reports, and its agreement with
//      the findings counter.
//   4. /ampi-review-run in a mocked Pi with an injected runner and repository:
//      the request it reads, the thinking level the children get, the
//      document and the outcome file.
//   5. Spawned `ampi review` runs against the installed Pi with the scripted
//      model (tests/fixtures/ampi-cli/faux-model), offline, in a temporary
//      home, agent directory and git repository.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { Check, Errors } from "typebox/schema";
import { createLogger } from "../packages/ampi-cli/src/log.js";
import { listPiSessions, readPiSessionEntries } from "../packages/ampi-cli/src/pi-compat.js";
import { formatReviewHelp, runReviewCommand } from "../packages/ampi-cli/src/review.js";
import { readThreadIndex, threadIndexPath } from "../packages/ampi-cli/src/thread-index.js";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const bin = path.join(repoRoot, "packages", "ampi-cli", "bin", "ampi.js");
const fauxModel = path.join(import.meta.dirname, "fixtures", "ampi-cli", "faux-model");
const schema = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "ampi-cli", "review.schema.json"), "utf8"));
const NOW = Date.parse("2026-10-19T08:30:00.000Z");

const temporary = realpathSync(mkdtempSync(path.join(tmpdir(), "ampi-cli-review-")));
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
after(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  rmSync(temporary, { recursive: true, force: true });
  cleanupLoadedSource();
});

/** @param {unknown} document */
const assertSchema = (document) => assert.ok(Check(schema, document), JSON.stringify(Errors(schema, document)[1]?.slice(0, 3)));

/** A document as /ampi-review-run writes it, written out by hand. */
const DOCUMENT = {
  diff: "uncommitted changes",
  summary: "One fix is needed.",
  findings: [
    { file: "src/a.ts", startLine: 3, endLine: 4, severity: "high", type: "bug", text: "The loop stops one item early." },
    { file: "src/b.ts", startLine: 1, endLine: 1, severity: "low", type: "suggested_edit", text: "Rename x.", check: "naming" },
  ],
  checks: [{ name: "naming", path: ".agents/checks/naming.md", scope: ".", status: "findings", findings: 1 }],
  report:
    "One fix is needed.\n\nFindings\n- src/a.ts:3-4 — severity: high; type: bug\n  The loop stops one item early.\n\n## Checks\n\n### naming (repository root): 1 finding\n\nFindings\n- src/b.ts:1-1 — low suggested_edit\n  Rename x.\n",
};

describe("ampi review: the command line and its outcome", () => {
  const agentDir = path.join(temporary, "unit-agent");
  const project = path.join(temporary, "unit-project");
  let pi;

  before(async () => {
    mkdirSync(project, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    pi = await import("@earendil-works/pi-coding-agent");
  });
  beforeEach(() => rmSync(agentDir, { recursive: true, force: true }));

  /**
   * Run `ampi review` with a fake Pi runner, which records the request file
   * and, as Pi would, writes `output` to the output file and `stderr` to the
   * command's stderr.
   */
  async function review(argv, { output, stderr = "", status = 0, error, ampi = { root: path.join(temporary, "no-ampi"), version: "0.4.0" } } = {}) {
    // `ampi: null` stands for no ampi package found.
    const located = ampi === null ? undefined : ampi;
    const calls = [];
    const dirs = [];
    let out = "";
    let err = "";
    const code = await runReviewCommand(argv, {
      pi,
      cwd: project,
      env: {},
      now: () => NOW,
      makeTempDir: () => {
        const dir = mkdtempSync(path.join(temporary, "run-"));
        dirs.push(dir);
        return dir;
      },
      runPi: async (args, { cwd, forward }) => {
        const value = (flag) => args.find((arg) => arg.startsWith(`--${flag}=`))?.slice(flag.length + 3);
        calls.push({ args, cwd, request: JSON.parse(readFileSync(value("ampi-review-request"), "utf8")) });
        if (stderr !== "") forward(stderr);
        if (output !== undefined) writeFileSync(value("ampi-review-output"), typeof output === "string" ? output : JSON.stringify(output));
        return { status, stderr, ...(error ? { error } : {}) };
      },
      locateAmpi: async () => located,
      out: (text) => (out += text),
      err: (text) => (err += text),
      log: createLogger({ stderr: (text) => (err += text) }),
    });
    assert.ok(dirs.every((dir) => !existsSync(dir)), "the temporary directory is removed");
    return { code, out, err, calls };
  }

  /** The sessions written in the project directory, with their entries. */
  async function sessions() {
    const listed = await listPiSessions(pi, { cwd: project, env: {}, scope: "workspace" });
    return listed.map((session) => ({ id: session.id, name: session.name, entries: readPiSessionEntries(pi, session.path) }));
  }
  const index = () => readThreadIndex(threadIndexPath(agentDir));

  it("puts every option into the request, joins the description and starts Pi on /ampi-review-run", async () => {
    const { calls } = await review([
      "the", "last", "commit",
      "-f", "src/a.ts", "--files", "src/b.ts",
      "-i", "focus on errors",
      "-s", "packages/x",
      "-c", "naming", "--check-filter=style",
      "--checks-only",
      "--thinking", "high",
    ]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cwd, project);
    assert.deepEqual(calls[0].request, {
      version: 1,
      params: {
        diff_description: "the last commit",
        files: ["src/a.ts", "src/b.ts"],
        instructions: "focus on errors",
        checks_only: true,
        check_filter: ["naming", "style"],
        check_scope: "packages/x",
      },
      thinking: "high",
    });
    const { args } = calls[0];
    assert.deepEqual([args[0], args[1], args.at(-1)], ["--no-session", "-p", "/ampi-review-run"]);
    assert.ok(args.some((arg) => arg.startsWith("--ampi-review-output=")));
  });

  it("reviews the uncommitted changes at low thinking when no description is given", async () => {
    for (const argv of [[], [""], ["  "]]) {
      const { calls } = await review(argv);
      assert.deepEqual(calls[0].request, { version: 1, params: { diff_description: "uncommitted changes" }, thinking: "low" }, JSON.stringify(argv));
    }
  });

  it("exits 2 on a usage error without starting Pi", async () => {
    for (const [argv, message] of [
      [["--bogus"], /Unknown option '--bogus'/],
      [["--thinking", "medium"], /--thinking takes low or high, not "medium"\./],
      [["-i"], /argument missing/],
      [["--title", " "], /--title needs a value\./],
      [["-l", "Not A Label"], /label "Not A Label" is not allowed/],
    ]) {
      const result = await review(argv);
      assert.equal(result.code, 2, argv.join(" "));
      assert.equal(result.calls.length, 0);
      assert.equal(result.out, "");
      assert.match(result.err, /^ampi: review: /);
      assert.match(result.err, message);
      assert.match(result.err, /\nRun ampi review --help for the options\.\n$/);
    }
  });

  it("prints its help with exit 0", async () => {
    const result = await review(["the", "change", "--help"]);
    assert.equal(result.code, 0);
    assert.equal(result.out, formatReviewHelp());
    assert.equal(result.calls.length, 0);
    assert.match(result.out, /--thinking low\|high/);
  });

  it("prints the report, then records an archived thread with the request and the review", async () => {
    const result = await review(["-f", "src/a.ts"], { output: { ok: true, result: DOCUMENT } });
    assert.equal(result.code, 0, result.err);
    assert.equal(result.out, DOCUMENT.report);
    assert.equal(result.err, "");
    const [session, ...others] = await sessions();
    assert.equal(others.length, 0);
    assert.equal(session.name, "Review: uncommitted changes");
    assert.deepEqual(
      session.entries.map((entry) => entry.type),
      ["message", "session_info", "custom_message"],
    );
    const [message, , review_] = session.entries;
    assert.deepEqual(message.message, { role: "user", content: "ampi review: uncommitted changes\nFiles: src/a.ts\nThinking: low", timestamp: NOW });
    assert.deepEqual(
      { customType: review_.customType, content: review_.content, display: review_.display, details: review_.details },
      { customType: "ampi-review", content: DOCUMENT.report, display: true, details: DOCUMENT },
    );
    assert.deepEqual({ ...index()[session.id] }, { archived: "2026-10-19T08:30:00.000Z" });
  });

  it("prints the JSON document with --json, and names, labels and keeps the thread out of the archive on request", async () => {
    const result = await review(["--json", "--title", "Nightly review", "-l", "ci", "-l", "nightly", "--no-archive-after-execute"], {
      output: { ok: true, result: DOCUMENT },
    });
    assert.equal(result.code, 0, result.err);
    assert.equal(result.out, `${JSON.stringify(DOCUMENT, null, 2)}\n`);
    assertSchema(JSON.parse(result.out));
    const [session] = await sessions();
    assert.equal(session.name, "Nightly review");
    assert.deepEqual({ ...index()[session.id] }, { labels: ["ci", "nightly"], titleSource: "user" });

    // Neither labels, a title nor the archive: no index record at all.
    rmSync(agentDir, { recursive: true, force: true });
    assert.equal((await review(["--no-archive-after-execute"], { output: { ok: true, result: DOCUMENT } })).code, 0);
    const [plain] = await sessions();
    assert.equal(index()[plain.id], undefined);
  });

  it("names a failed main review on stderr and still exits 0 when a check answered", async () => {
    const result = await review([], { output: { ok: true, result: DOCUMENT, mainReviewFailure: "worker exited with code 1: boom" } });
    assert.equal(result.code, 0);
    assert.equal(result.out, DOCUMENT.report);
    assert.equal(result.err, "ampi: the main review failed (worker exited with code 1: boom); the report holds the checks' results.\n");
  });

  it("exits 1 with the reason when the review failed, and records no thread", async () => {
    const result = await review(["-c", "nope"], { output: { ok: false, error: 'reviewer: no review check named "nope". Available checks: naming.' } });
    assert.equal(result.code, 1);
    assert.equal(result.out, "");
    assert.equal(result.err, 'ampi: review failed: reviewer: no review check named "nope". Available checks: naming.\n');
    assert.deepEqual(await sessions(), []);
  });

  it("exits 1 after Pi's own message when Pi stopped before writing an output file", async () => {
    const result = await review([], { status: 1, stderr: "No models available. Use /login.\n" });
    assert.equal(result.code, 1);
    assert.equal(result.out, "");
    assert.equal(result.err, "No models available. Use /login.\nampi: review failed: Pi exited with status 1 before the review ran; see Pi's message above.\n");
    assert.deepEqual(await sessions(), []);

    const unreadable = await review([], { output: "{ not json" });
    assert.equal(unreadable.code, 1);
    assert.match(unreadable.err, /^ampi: review failed: the review's output could not be read: /);

    const foreign = await review([], { output: { ok: "yes" } });
    assert.equal(foreign.code, 1);
    assert.match(foreign.err, /^ampi: review failed: the review's output is not in the format this ampi command reads/);

    const unstarted = await review([], { status: null, error: new Error("spawn EACCES") });
    assert.equal(unstarted.code, 1);
    assert.equal(unstarted.err, "ampi: review failed: could not start Pi: spawn EACCES\n");
  });

  it("says the ampi Pi loads is too old when Pi does not know the request flag", async () => {
    const stderr = "Error: Unknown options: --ampi-review-request, --ampi-review-output\n";
    const old = await review([], { status: 1, stderr, ampi: { root: path.join(temporary, "old-ampi"), version: "0.0.1" } });
    assert.equal(old.code, 1);
    assert.equal(old.err, `${stderr}ampi: ampi 0.0.1 is too old for review; update @skippermissions/ampi (or ampi-cli).\n`);
    const unversioned = await review([], { status: 1, stderr: `\u001b[31m${stderr}\u001b[39m`, ampi: null });
    assert.match(unversioned.err, /ampi: the ampi package is too old for review;/);
    // An ampi that has the command, loaded without ampi-workers.
    const withoutWorkers = await review([], { status: 1, stderr, ampi: { root: repoRoot, version: "9.9.9" } });
    assert.match(withoutWorkers.err, /ampi: review failed: review needs ampi-workers, which the ampi that Pi loads does not run;/);
  });
});

describe("ampi review: the findings parser", () => {
  let parseAmpiReviewFindings;
  let ampiReviewSummary;
  let countAmpiReviewFindings;
  before(async () => {
    ({ parseAmpiReviewFindings, ampiReviewSummary } = await importSource("extensions/ampi-workers/review/findings.ts"));
    ({ countAmpiReviewFindings } = await importSource("extensions/ampi-workers/review/checks.ts"));
  });

  /** The findings counter before it used the parser, kept here as an independent reading of the same rules. */
  const FORMER_FINDING_LINE = /^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)?[*_`]*[^\s:`*]+:\d+(?:-\d+)?\b/;
  const FORMER_FINDINGS_HEADING = /^\s*(?:#{1,6}\s*)?[*_]*findings[*_]*\s*:?\s*[*_]*\s*$/i;
  const formerCount = (report) => {
    const lines = report.replace(/\r\n?/g, "\n").split("\n");
    const heading = lines.findIndex((line) => FORMER_FINDINGS_HEADING.test(line));
    return (heading === -1 ? lines : lines.slice(heading + 1)).filter((line) => FORMER_FINDING_LINE.test(line)).length;
  };

  const finding = (file, startLine, endLine, severity, type, text) => ({ file, startLine, endLine, severity, type, text });

  const SAMPLES = {
    wellFormed: [
      "The change looks right except for one loop.",
      "",
      "## Findings",
      "",
      "- `src/a.ts:12-14` — severity: high; type: bug",
      "  The loop stops one item early.",
      "  It skips the last row.",
      "- src/b.ts:3-3 — severity: low; type: compliment",
      "  Clear naming.",
    ].join("\n"),
    separators: [
      "Findings",
      "- src/a.ts:1-2 - medium bug - Off by one.",
      "- src/a.ts:5-6: low suggested_edit: Use a constant.",
      "* src/c.ts:7-9 — critical bug",
    ].join("\n"),
    forms: [
      "**Findings**",
      "1. **src/a.ts:4-4** — **High** bug",
      "   The guard is inverted.",
      "2) `src/b.ts:8-9` — low · compliment",
      "### src/c.ts:2-3 (type: suggested-edit, severity: medium)",
      "Prefer the helper.",
      "- src/d.ts:1-1 — Severity: Medium | Type: Non-actionable — Context only.",
      "- src/e.ts:2-2 — `fix()` is called twice.",
    ].join("\n"),
    shapes: [
      "Findings:",
      "- src/gone.ts:0-0 — severity: medium; type: non_actionable",
      "  The file was deleted.",
      "- src/one.ts:42 — high bug",
      "- src/nowhere.ts — high bug",
      "  A location without a line is not a finding.",
      "- __init__.py:3 — low compliment",
    ].join("\n"),
    prose: [
      "I read src/a.ts:10 closely before writing this.",
      "",
      "Findings",
      "- src/a.ts:10-11 — severity: medium; type: bug",
      "  Missing await.",
      "",
      "## Notes",
      "Overall the change is small.",
    ].join("\n"),
    noHeading: ["Check summary: one naming issue.", "src/names.ts:5-5 — low suggested_edit", "Rename `tmp` to `rows`."].join("\n"),
    none: "The change looks clean.\n\nFindings\n\nNone.",
  };

  it("reads well-formed findings with their text up to the next finding", () => {
    assert.deepEqual(parseAmpiReviewFindings(SAMPLES.wellFormed), [
      finding("src/a.ts", 12, 14, "high", "bug", "The loop stops one item early.\nIt skips the last row."),
      finding("src/b.ts", 3, 3, "low", "compliment", "Clear naming."),
    ]);
    assert.equal(ampiReviewSummary(SAMPLES.wellFormed), "The change looks right except for one loop.");
  });

  it("accepts an em dash, a hyphen or a colon after the line range", () => {
    assert.deepEqual(parseAmpiReviewFindings(SAMPLES.separators), [
      finding("src/a.ts", 1, 2, "medium", "bug", "Off by one."),
      finding("src/a.ts", 5, 6, "low", "suggested_edit", "Use a constant."),
      finding("src/c.ts", 7, 9, "critical", "bug", ""),
    ]);
  });

  it("reads severity and type in either order and form, around emphasis, numbering and headings", () => {
    assert.deepEqual(parseAmpiReviewFindings(SAMPLES.forms), [
      finding("src/a.ts", 4, 4, "high", "bug", "The guard is inverted."),
      finding("src/b.ts", 8, 9, "low", "compliment", ""),
      finding("src/c.ts", 2, 3, "medium", "suggested_edit", "Prefer the helper."),
      finding("src/d.ts", 1, 1, "medium", "non_actionable", "Context only."),
      finding("src/e.ts", 2, 2, null, null, "`fix()` is called twice."),
    ]);
  });

  it("reads a deleted file and a single line, and leaves a location without a line in the text", () => {
    assert.deepEqual(parseAmpiReviewFindings(SAMPLES.shapes), [
      finding("src/gone.ts", 0, 0, "medium", "non_actionable", "The file was deleted."),
      finding("src/one.ts", 42, 42, "high", "bug", "- src/nowhere.ts — high bug\n  A location without a line is not a finding."),
      finding("__init__.py", 3, 3, "low", "compliment", ""),
    ]);
  });

  it("ignores locations in the summary, stops a finding's text at a heading, and reads a report without a Findings heading", () => {
    assert.deepEqual(parseAmpiReviewFindings(SAMPLES.prose), [finding("src/a.ts", 10, 11, "medium", "bug", "Missing await.")]);
    assert.equal(ampiReviewSummary(SAMPLES.prose), "I read src/a.ts:10 closely before writing this.");
    assert.deepEqual(parseAmpiReviewFindings(SAMPLES.noHeading), [finding("src/names.ts", 5, 5, "low", "suggested_edit", "Rename `tmp` to `rows`.")]);
    assert.equal(ampiReviewSummary(SAMPLES.noHeading), "Check summary: one naming issue.");
    assert.deepEqual(parseAmpiReviewFindings(SAMPLES.none), []);
    assert.equal(ampiReviewSummary(SAMPLES.none), "The change looks clean.");
    assert.equal(ampiReviewSummary("No structure at all."), "");
  });

  it("parses exactly the lines the findings counter counts", () => {
    for (const [name, report] of Object.entries(SAMPLES)) {
      const parsed = parseAmpiReviewFindings(report).length;
      assert.equal(parsed, formerCount(report), name);
      assert.equal(countAmpiReviewFindings(report), parsed, name);
    }
  });
});

describe("ampi review: /ampi-review-run in a session", () => {
  let reviewRun;
  before(async () => {
    reviewRun = await importSource("extensions/ampi-workers/builtin-workers/review-run.ts");
  });
  beforeEach(async () => {
    const { clearMmrSubagentPromptBuilders } = await importSource("extensions/ampi-core/subagent-prompt-assembly.ts");
    const { registerMmrSubagentsPromptBuilders } = await importSource("extensions/ampi-workers/profiles/prompts.ts");
    clearMmrSubagentPromptBuilders();
    registerMmrSubagentsPromptBuilders();
  });

  const workerResult = (finalOutput, overrides = {}) => ({
    messages: [],
    finalOutput,
    truncatedFinalOutput: finalOutput,
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
    model: "faux-1",
    stopReason: "end_turn",
    prompt: "",
    cwd: "/repo",
    command: "pi",
    args: [],
    exitCode: 0,
    signal: null,
    stderr: "",
    aborted: false,
    outputTruncated: false,
    ignoredJsonLines: 0,
    agentStarted: true,
    trail: [],
    ...overrides,
  });

  /** A repository at /repo with one check, `naming`, and one changed file, answered without git. */
  const repository = {
    runCommand(command, args) {
      const line = [command, ...args].join(" ");
      if (line === "git rev-parse --show-toplevel") return { stdout: "/repo\n", exitCode: 0 };
      if (line.startsWith("git ls-files")) return { stdout: ".agents/checks/naming.md\0", exitCode: 0 };
      if (line.startsWith("git status")) return { stdout: " M src/a.ts\0", exitCode: 0 };
      return { stdout: "", exitCode: 128 };
    },
    readFile: () => "Names must be clear.\n",
    isDirectory: () => false,
    listDirectory: () => [],
  };

  /** Register the command in a mocked Pi and run it with these flags; the runner answers per run. */
  async function runCommand(flags, answer, request, hasUI = false) {
    const dir = mkdtempSync(path.join(temporary, "command-"));
    const requestFile = path.join(dir, "request.json");
    const outputFile = path.join(dir, "output.json");
    if (request !== undefined) writeFileSync(requestFile, JSON.stringify(request));
    const calls = [];
    const { pi, commands } = createMockPi({
      flags: flags ? { "ampi-review-request": requestFile, "ampi-review-output": outputFile } : {},
    });
    reviewRun.registerAmpiReviewRunCommand(pi, {
      runner: {
        async run(options) {
          calls.push(options);
          return answer(options.prompt.includes('review check, "naming"') ? "naming" : "main");
        },
      },
      reviewCheckEnv: repository,
      buildSystemPrompt: () => "SP",
      loadSubagentModelPreferences: () => ({ subagentModelPreferences: { reviewer: [{ model: "faux-1", providers: ["faux"], thinkingLevel: "high" }] } }),
    });
    const context = createMockExtensionContext({ cwd: "/repo", hasUI, models: [{ provider: "faux", id: "faux-1", name: "Faux One" }] });
    await commands.get("ampi-review-run").handler("", context.ctx);
    const outcome = existsSync(outputFile) ? JSON.parse(readFileSync(outputFile, "utf8")) : undefined;
    return { outcome, calls, notifications: context.notifications };
  }

  const REPORTS = {
    main: "Main summary.\n\nFindings\n- src/a.ts:2-3 — severity: high; type: bug\n  Wrong bound.",
    naming: "Naming summary.\n\nFindings\n- src/a.ts:1-1 — low suggested_edit\n  Rename x.",
  };

  it("runs the review with the requested thinking level in every child and writes the document", async () => {
    const request = { version: 1, params: { diff_description: "uncommitted changes" }, thinking: "low" };
    const { outcome, calls } = await runCommand(true, (run) => workerResult(REPORTS[run]), request);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.model, "faux/faux-1");
      assert.deepEqual(call.modelPreferencesOverride, [{ model: "faux-1", providers: ["faux"], thinkingLevel: "low" }]);
    }
    assert.equal(outcome.ok, true);
    const document = outcome.result;
    assertSchema(document);
    assert.deepEqual(Object.keys(document), ["diff", "summary", "findings", "checks", "report"]);
    assert.deepEqual(document.findings, [
      { file: "src/a.ts", startLine: 2, endLine: 3, severity: "high", type: "bug", text: "Wrong bound." },
      { file: "src/a.ts", startLine: 1, endLine: 1, severity: "low", type: "suggested_edit", text: "Rename x.", check: "naming" },
    ]);
    assert.equal(document.summary, "Main summary.");
    assert.deepEqual(document.checks, [{ name: "naming", path: ".agents/checks/naming.md", scope: ".", status: "findings", findings: 1 }]);
    assert.equal(document.report, `${REPORTS.main}\n\n## Checks\n\n### naming (repository root): 1 finding\n\n${REPORTS.naming}\n`);
  });

  it("leaves the summary and main findings empty under checks_only, and reports a failed main review apart", async () => {
    const checksOnly = await runCommand(true, (run) => workerResult(REPORTS[run]), {
      version: 1,
      params: { diff_description: "uncommitted changes", checks_only: true },
      thinking: "high",
    });
    assert.equal(checksOnly.calls.length, 1);
    assert.equal(checksOnly.calls[0].modelPreferencesOverride[0].thinkingLevel, "high");
    assert.equal(checksOnly.outcome.result.summary, "");
    assert.deepEqual(checksOnly.outcome.result.findings.map((item) => item.check), ["naming"]);

    const failedMain = await runCommand(
      true,
      (run) => (run === "main" ? workerResult("", { exitCode: 1, stderr: "boom", stopReason: "error" }) : workerResult(REPORTS.naming)),
      { version: 1, params: { diff_description: "uncommitted changes" }, thinking: "low" },
    );
    assert.equal(failedMain.outcome.ok, true);
    assert.equal(failedMain.outcome.mainReviewFailure, "worker exited with code 1: boom");
    assert.equal(failedMain.outcome.result.summary, "");
    assert.deepEqual(failedMain.outcome.result.findings.map((item) => item.check), ["naming"]);
  });

  it("writes the error when every run failed or the call could not be prepared", async () => {
    const failing = () => workerResult("", { exitCode: 1, stderr: "boom", stopReason: "error" });
    const allFailed = await runCommand(true, failing, { version: 1, params: { diff_description: "uncommitted changes" }, thinking: "low" });
    assert.deepEqual(allFailed.outcome, {
      ok: false,
      error: "every review run failed: worker exited with code 1: boom",
    });
    const twoReasons = await runCommand(true, (run) => workerResult("", { exitCode: 1, stderr: `${run} broke`, stopReason: "error" }), {
      version: 1,
      params: { diff_description: "uncommitted changes" },
      thinking: "low",
    });
    assert.equal(twoReasons.outcome.error, "every review run failed (main review: worker exited with code 1: main broke; naming: worker exited with code 1: naming broke)");

    const unknown = await runCommand(true, failing, { version: 1, params: { diff_description: "uncommitted changes", check_filter: ["nope"] }, thinking: "low" });
    assert.equal(unknown.outcome.ok, false);
    assert.match(unknown.outcome.error, /no review check named "nope"\. Available checks: naming\./);
    assert.equal(unknown.calls.length, 0);

    const blank = await runCommand(true, failing, { version: 1, params: { diff_description: " " }, thinking: "low" });
    assert.match(blank.outcome.error, /diff_description is required/);

    const missing = await runCommand(true, failing, undefined);
    assert.match(missing.outcome.error, /ENOENT/);
    const foreign = await runCommand(true, failing, { version: 2 });
    assert.match(foreign.outcome.error, /written by a different version of the ampi command/);
  });

  it("only says what runs it when typed in a session without the flags", async () => {
    const typed = await runCommand(false, () => assert.fail("no review runs"), undefined, true);
    assert.equal(typed.outcome, undefined);
    assert.equal(typed.calls.length, 0);
    assert.equal(typed.notifications.length, 1);
    assert.match(typed.notifications[0].message, /runs a review for the ampi review shell command/);
    // Without a UI a notification shows nothing, so the notice becomes the command's error.
    await assert.rejects(runCommand(false, () => assert.fail("no review runs"), undefined), /runs a review for the ampi review shell command/);
  });

  it("registers its command and both flags with descriptions", () => {
    const { pi, commands, flagDefs } = createMockPi();
    reviewRun.registerAmpiReviewRunCommand(pi);
    assert.match(commands.get("ampi-review-run").description, /used by ampi review; does nothing when typed/);
    assert.equal(flagDefs.get("ampi-review-request").type, "string");
    assert.equal(flagDefs.get("ampi-review-output").type, "string");
  });
});

const hasGit = spawnSync("git", ["--version"]).status === 0;

describe("ampi review: the command", { concurrency: true, skip: hasGit ? false : "git is not installed" }, () => {
  let runs = 0;

  /**
   * A home whose agent directory loads the scripted model through Pi's
   * settings (or, with `model: false`, no model), and a git repository with
   * one committed file, an uncommitted change and the check `naming`, whose
   * body asks the scripted reviewer for a finding.
   */
  function setUp({ model = true, extensions = [] } = {}) {
    const root = path.join(temporary, `spawned-${++runs}`);
    const home = path.join(root, "home");
    const agentDir = path.join(home, ".pi", "agent");
    const repo = path.join(root, "repo");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(path.join(repo, "src"), { recursive: true });
    mkdirSync(path.join(repo, ".agents", "checks"), { recursive: true });
    const settings = model
      ? {
          extensions: [fauxModel, ...extensions],
          defaultProvider: "faux",
          defaultModel: "faux-1",
          // ampi-core reads its settings from ~/.pi/agent, which is the agent directory here.
          ampiCore: { subagentModelPreferences: { reviewer: [{ model: "faux-1", providers: ["faux"] }] } },
        }
      : { extensions };
    writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings));
    writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "scripted" } }));
    writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(path.join(repo, ".agents", "checks", "naming.md"), "---\nname: naming\ndescription: Clear names\n---\nNames must be clear. faux-finding src/a.ts\n");
    const env = { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", GIT_CONFIG_NOSYSTEM: "1" };
    const git = (...args) => {
      const result = spawnSync("git", ["-c", "user.name=ampi", "-c", "user.email=ampi@example.invalid", ...args], { cwd: repo, env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "start");
    writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 2;\n");
    return { root, agentDir, repo, env };
  }

  /** Run the command in the repository, with stdin closed as a script's would be. */
  function ampi(setup, args) {
    const child = spawn(process.execPath, [bin, ...args], { cwd: setup.repo, env: setup.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    return new Promise((resolve) => child.on("close", (status) => resolve({ status, stdout, stderr })));
  }
  const index = (setup) => readThreadIndex(threadIndexPath(setup.agentDir));

  it("prints the main report and the checks, and archives the thread, which threads markdown prints", async () => {
    const setup = setUp();
    const result = await ampi(setup, ["review"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      [
        "The change looks clean.",
        "",
        "Findings",
        "",
        "None.",
        "",
        "## Checks",
        "",
        "### naming (repository root): 1 finding",
        "",
        "The change needs one fix.",
        "",
        "Findings",
        "- src/a.ts:1-1 — severity: medium; type: bug",
        "  The scripted reviewer flags this line.",
        "",
      ].join("\n"),
    );
    const threads = Object.entries(index(setup));
    assert.equal(threads.length, 1);
    const [id, record] = threads[0];
    assert.match(record.archived, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    const markdown = await ampi(setup, ["threads", "markdown", id]);
    assert.equal(markdown.status, 0, markdown.stderr);
    assert.match(markdown.stdout, /^# Review: uncommitted changes$/m);
    assert.ok(markdown.stdout.includes(`## User\n\nampi review: uncommitted changes\nThinking: low\n\n## Assistant\n\n${result.stdout}`), markdown.stdout);
  });

  it("prints a JSON document that matches the schema, with the main review's and the check's findings", async () => {
    const setup = setUp();
    const result = await ampi(setup, ["review", "--json", "-i", "faux-finding src/a.ts", "--no-archive-after-execute", "-l", "ci"]);
    assert.equal(result.status, 0, result.stderr);
    const document = JSON.parse(result.stdout);
    assertSchema(document);
    assert.equal(document.diff, "uncommitted changes");
    assert.equal(document.summary, "The change needs one fix.");
    const flagged = { file: "src/a.ts", startLine: 1, endLine: 1, severity: "medium", type: "bug", text: "The scripted reviewer flags this line." };
    assert.deepEqual(document.findings, [flagged, { ...flagged, check: "naming" }]);
    assert.deepEqual(document.checks, [{ name: "naming", path: ".agents/checks/naming.md", scope: ".", status: "findings", findings: 1 }]);
    const [record] = Object.values(index(setup));
    assert.deepEqual({ ...record }, { labels: ["ci"] });
  });

  it("runs only the checks with --checks-only", async () => {
    const setup = setUp();
    const result = await ampi(setup, ["review", "--json", "--checks-only", "-c", "naming"]);
    assert.equal(result.status, 0, result.stderr);
    const document = JSON.parse(result.stdout);
    assertSchema(document);
    assert.equal(document.summary, "");
    assert.deepEqual(document.findings.map((item) => item.check), ["naming"]);
    assert.ok(document.report.startsWith("## Checks\n"), document.report);
  });

  // Pi still selects a model of its catalogue without credentials, so the
  // review starts and its runs find no route for the reviewer.
  it("exits 1 with nothing on stdout when no model is available", async () => {
    const setup = setUp({ model: false });
    const result = await ampi(setup, ["review"]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /^ampi: review failed: every review run failed: subagent activation failed: Subagent "reviewer" could not resolve any model route\./m,
    );
    assert.equal(existsSync(threadIndexPath(setup.agentDir)), false);
  });

  it("says the ampi that Pi loads is too old for review", async () => {
    const stub = path.join(temporary, `old-ampi-${runs}`);
    mkdirSync(path.join(stub, "src"), { recursive: true });
    writeFileSync(path.join(stub, "src", "index.ts"), "");
    writeFileSync(path.join(stub, "package.json"), JSON.stringify({ name: "@skippermissions/ampi", version: "0.0.1" }));
    const setup = setUp({ extensions: [path.join(stub, "src", "index.ts")] });
    const result = await ampi(setup, ["review"]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /ampi: using the ampi that Pi already loads/);
    assert.match(result.stderr, /ampi: ampi 0\.0\.1 is too old for review; update @skippermissions\/ampi \(or ampi-cli\)\.\n$/);
  });
});
