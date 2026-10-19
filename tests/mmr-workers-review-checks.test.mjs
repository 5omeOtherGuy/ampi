// Review checks for the `reviewer` worker: Markdown files under
// `.agents/checks/` that each run as one more reviewer child.
//
//   1. Discovery and selection against a temporary git repository: root and
//      nested checks, the changed-file filter, check_scope, check_filter,
//      front matter (name, file stem, unreadable, CRLF) and ignored folders.
//   2. Changed-file resolution: uncommitted changes (untracked files and a
//      rename), a revision range, and a description that names no revision.
//   3. Orchestration with an injected runner and an injected repository (no
//      child processes): the concurrency limit, checks_only, partial and total
//      failure, cancellation, the combined report and the per-check details,
//      and the background run preparer.
//   4. Jujutsu, through an injected command runner.
//
// Every expected value is written out by hand.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

const CHECKS_MODULE = "extensions/ampi-workers/review/checks.ts";
const REVIEWER_MODULE = "extensions/ampi-workers/builtin-workers/reviewer.ts";
const PROMPTS_MODULE = "extensions/ampi-workers/profiles/prompts.ts";
const PROMPT_ASSEMBLY_MODULE = "extensions/ampi-core/subagent-prompt-assembly.ts";

const tempDirs = [];
const savedEnv = {};
const ISOLATED_ENV = ["HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"];

before(() => {
  // git must not read the developer's own configuration or global ignore file.
  const home = mkdtempSync(path.join(tmpdir(), "ampi-review-checks-home-"));
  tempDirs.push(home);
  writeFileSync(path.join(home, "gitconfig"), "");
  for (const key of ISOLATED_ENV) savedEnv[key] = process.env[key];
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.GIT_CONFIG_GLOBAL = path.join(home, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

after(() => {
  for (const key of ISOLATED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  cleanupLoadedSource();
});

beforeEach(async () => {
  const { clearMmrSubagentPromptBuilders } = await importSource(PROMPT_ASSEMBLY_MODULE);
  const { registerMmrSubagentsPromptBuilders } = await importSource(PROMPTS_MODULE);
  clearMmrSubagentPromptBuilders();
  registerMmrSubagentsPromptBuilders();
});

// ---------------------------------------------------------------------------
// Temporary git repositories
// ---------------------------------------------------------------------------

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function write(root, relativePath, content) {
  const target = path.join(root, ...relativePath.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function makeGitRepo(files) {
  const root = mkdtempSync(path.join(tmpdir(), "ampi-review-checks-repo-"));
  tempDirs.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Review Checks Test");
  git(root, "config", "user.email", "review-checks@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  for (const [relativePath, content] of Object.entries(files)) write(root, relativePath, content);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "initial");
  return root;
}

const REPO_FILES = {
  ".gitignore": "vendor/\n",
  ".agents/checks/style.md": "---\nname: house-style\ndescription: Names and layout\n---\nKeep names short.\n",
  ".agents/checks/broken.md": "---\nname: never-used\nKeep going.\n",
  ".agents/checks/notes/deep.md": "Not a check: it is not directly in a checks directory.\n",
  "packages/x/.agents/checks/input.md": "Every new handler validates its input.\n",
  "packages/y/.agents/checks/crlf.md": "---\r\nname: crlf-check\r\ndescription: Written on Windows\r\n---\r\nCRLF body line one.\r\nLine two.\r\n",
  "vendor/lib/.agents/checks/ignored.md": "Ignored by .gitignore, so never a check.\n",
  "README.md": "# repo\n",
  "packages/x/handler.ts": "export const handler = 1;\n",
  "packages/y/old.ts": "export const old = 1;\n",
};

/** A repository whose only commit is its root commit, so `HEAD^!` has no parent to read. */
function makeRootOnly() {
  const root = makeGitRepo({ "a.txt": "a\n" });
  return { kind: "git", root };
}

// The vendored check must exist on disk but stay untracked and ignored.
function makeChecksRepo() {
  const root = makeGitRepo(Object.fromEntries(Object.entries(REPO_FILES).filter(([file]) => !file.startsWith("vendor/"))));
  write(root, "vendor/lib/.agents/checks/ignored.md", REPO_FILES["vendor/lib/.agents/checks/ignored.md"]);
  return root;
}

const STYLE = {
  name: "house-style",
  description: "Names and layout",
  instructions: "Keep names short.",
  file: ".agents/checks/style.md",
  scope: ".",
};
const BROKEN = {
  name: "broken",
  instructions: "name: never-used\nKeep going.",
  file: ".agents/checks/broken.md",
  scope: ".",
  warning: '.agents/checks/broken.md: the front matter has no closing --- line; the check runs as "broken".',
};
const INPUT = {
  name: "input",
  instructions: "Every new handler validates its input.",
  file: "packages/x/.agents/checks/input.md",
  scope: "packages/x",
};
const CRLF = {
  name: "crlf-check",
  description: "Written on Windows",
  instructions: "CRLF body line one.\nLine two.",
  file: "packages/y/.agents/checks/crlf.md",
  scope: "packages/y",
};

describe("review check discovery", () => {
  it("finds root and nested checks among tracked and untracked files, and skips ignored folders", async () => {
    const { createAmpiReviewCheckEnv, detectAmpiReviewRepository, discoverAmpiReviewChecks } = await importSource(CHECKS_MODULE);
    const root = makeChecksRepo();
    write(root, "packages/x/.agents/checks/untracked.md", "---\nname: fresh\n---\nA rule nobody committed yet.\n");
    const env = createAmpiReviewCheckEnv();
    const repository = detectAmpiReviewRepository(path.join(root, "packages", "x"), env);
    assert.deepEqual(repository, { kind: "git", root });
    assert.deepEqual(discoverAmpiReviewChecks(repository, env), [
      BROKEN,
      STYLE,
      {
        name: "fresh",
        instructions: "A rule nobody committed yet.",
        file: "packages/x/.agents/checks/untracked.md",
        scope: "packages/x",
      },
      INPUT,
      CRLF,
    ]);
  });

  it("without version control reads only <cwd>/.agents/checks", async () => {
    const { createAmpiReviewCheckEnv, detectAmpiReviewRepository, discoverAmpiReviewChecks } = await importSource(CHECKS_MODULE);
    const dir = mkdtempSync(path.join(tmpdir(), "ampi-review-checks-plain-"));
    tempDirs.push(dir);
    write(dir, ".agents/checks/plain.md", "Plain rule.\n");
    write(dir, "sub/.agents/checks/nested.md", "Never read without version control.\n");
    const env = createAmpiReviewCheckEnv();
    const repository = detectAmpiReviewRepository(dir, env);
    assert.deepEqual(repository, { kind: "none", root: dir });
    assert.deepEqual(discoverAmpiReviewChecks(repository, env), [
      { name: "plain", instructions: "Plain rule.", file: ".agents/checks/plain.md", scope: "." },
    ]);
  });

  it("parses front matter: quoted values, continuation lines, unknown keys, and a malformed line", async () => {
    const { parseAmpiReviewCheckFile } = await importSource(CHECKS_MODULE);
    assert.deepEqual(
      parseAmpiReviewCheckFile(
        "api/.agents/checks/limits.md",
        "\uFEFF---\n# comment\nname: \"rate-limits\"\ndescription: >\n  Every endpoint\n  has a limit\nowner: platform\n---\n\nBody.\n",
      ),
      { name: "rate-limits", description: "Every endpoint has a limit", instructions: "Body.", file: "api/.agents/checks/limits.md", scope: "api" },
    );
    assert.deepEqual(parseAmpiReviewCheckFile(".agents/checks/odd.md", "---\nname: odd\njust words\n---\nBody.\n"), {
      name: "odd",
      instructions: "Body.",
      file: ".agents/checks/odd.md",
      scope: ".",
      warning: '.agents/checks/odd.md: the front matter line "just words" is not "key: value"; the check runs as "odd".',
    });
    assert.deepEqual(parseAmpiReviewCheckFile(".agents/checks/empty-name.md", "---\nname:\n---\nBody.\n"), {
      name: "empty-name",
      instructions: "Body.",
      file: ".agents/checks/empty-name.md",
      scope: ".",
    });
    assert.equal(parseAmpiReviewCheckFile(".agents/checks/sub/deep.md", "x"), undefined);
    assert.equal(parseAmpiReviewCheckFile("docs/checks/a.md", "x"), undefined);
  });
});

describe("review check selection", () => {
  async function plan(root, overrides = {}) {
    const { planAmpiReviewChecks } = await importSource(CHECKS_MODULE);
    return planAmpiReviewChecks({ cwd: root, diffDescription: "uncommitted changes", ...overrides });
  }
  const names = (result) => result.selected.map((selection) => `${selection.check.scope}:${selection.check.name}`);

  it("skips a nested check when the change is only outside its directory", async () => {
    const root = makeChecksRepo();
    write(root, "README.md", "# repo, edited\n");
    const result = await plan(root);
    assert.deepEqual(result.changes, { kind: "uncommitted", files: ["README.md"] });
    assert.deepEqual(names(result), [".:broken", ".:house-style"]);
    assert.deepEqual(result.selected[0].changedFiles, ["README.md"]);
  });

  it("runs a nested check for a change under its directory, with only that directory's changed files", async () => {
    const root = makeChecksRepo();
    write(root, "README.md", "# repo, edited\n");
    write(root, "packages/x/handler.ts", "export const handler = 2;\n");
    const result = await plan(root);
    assert.deepEqual(names(result), [".:broken", ".:house-style", "packages/x:input"]);
    assert.deepEqual(result.selected[2].changedFiles, ["packages/x/handler.ts"]);
    assert.deepEqual(result.selected[0].changedFiles, ["README.md", "packages/x/handler.ts"]);
  });

  it("check_scope keeps checks in that directory (relative to cwd) and below", async () => {
    const root = makeChecksRepo();
    write(root, "packages/x/handler.ts", "export const handler = 2;\n");
    write(root, "packages/y/old.ts", "export const old = 2;\n");
    assert.deepEqual(names(await plan(root, { scope: "packages" })), ["packages/x:input", "packages/y:crlf-check"]);
    assert.deepEqual(names(await plan(path.join(root, "packages"), { scope: "y" })), ["packages/y:crlf-check"]);
    assert.deepEqual(names(await plan(path.join(root, "packages"), { scope: ".." })), [
      ".:broken",
      ".:house-style",
      "packages/x:input",
      "packages/y:crlf-check",
    ]);
    await assert.rejects(plan(root, { scope: "../elsewhere" }), /check_scope "\.\.\/elsewhere" is outside the repository/);
  });

  it("check_scope compares real paths, so a cwd reached through a symlink still resolves inside the repository", async () => {
    const root = makeChecksRepo();
    write(root, "packages/x/handler.ts", "export const handler = 2;\n");
    const linkParent = mkdtempSync(path.join(tmpdir(), "ampi-review-checks-link-"));
    tempDirs.push(linkParent);
    const link = path.join(linkParent, "repo");
    symlinkSync(root, link, "dir");
    assert.deepEqual(names(await plan(path.join(link, "packages"), { scope: "x" })), ["packages/x:input"]);
    assert.deepEqual(names(await plan(link, { scope: "packages" })), ["packages/x:input"]);
  });

  it("check_scope accepts a directory whose name starts with two dots", async () => {
    const root = makeChecksRepo();
    write(root, "..config/.agents/checks/dots.md", "Dotted directory rule.\n");
    write(root, "..config/settings.ts", "export const s = 1;\n");
    assert.deepEqual(names(await plan(root, { scope: "..config" })), ["..config:dots"]);
  });

  it("check_filter keeps the named checks, and an unknown name lists the available ones", async () => {
    const root = makeChecksRepo();
    write(root, "packages/x/handler.ts", "export const handler = 2;\n");
    assert.deepEqual(names(await plan(root, { filter: ["input", "crlf-check"] })), ["packages/x:input"]);
    await assert.rejects(
      plan(root, { filter: ["input", "nope"] }),
      (error) =>
        error.message ===
        'reviewer: no review check named "nope". Available checks: broken, crlf-check, house-style, input.',
    );
  });
});

describe("changed-file resolution", () => {
  it("reads uncommitted changes, untracked files and both sides of a rename for an empty or uncommitted description", async () => {
    const { createAmpiReviewCheckEnv, detectAmpiReviewRepository, resolveAmpiReviewChangedFiles } = await importSource(CHECKS_MODULE);
    const root = makeChecksRepo();
    write(root, "README.md", "# repo, edited\n");
    git(root, "mv", "packages/y/old.ts", "packages/x/renamed.ts");
    write(root, "notes/new file.txt", "untracked\n");
    const env = createAmpiReviewCheckEnv();
    const repository = detectAmpiReviewRepository(root, env);
    const expected = {
      kind: "uncommitted",
      files: ["README.md", "notes/new file.txt", "packages/x/renamed.ts", "packages/y/old.ts"],
    };
    for (const description of ["", "   ", "uncommitted changes", "All uncommitted changes.", "the working tree", "local changes"]) {
      assert.deepEqual(resolveAmpiReviewChangedFiles(description, repository, env), expected, JSON.stringify(description));
    }
  });

  it("reads a revision range or a single revision through git diff", async () => {
    const { createAmpiReviewCheckEnv, detectAmpiReviewRepository, resolveAmpiReviewChangedFiles } = await importSource(CHECKS_MODULE);
    const root = makeChecksRepo();
    const first = git(root, "rev-parse", "HEAD").trim();
    write(root, "packages/x/handler.ts", "export const handler = 3;\n");
    write(root, "docs/guide.md", "# guide\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "second");
    const env = createAmpiReviewCheckEnv();
    const repository = detectAmpiReviewRepository(root, env);
    const files = ["docs/guide.md", "packages/x/handler.ts"];
    assert.deepEqual(resolveAmpiReviewChangedFiles(`${first}..HEAD`, repository, env), { kind: "revision", revision: `${first}..HEAD`, files });
    assert.deepEqual(resolveAmpiReviewChangedFiles("HEAD~1", repository, env), { kind: "revision", revision: "HEAD~1", files });
    // Naming the commit itself with a clean tree reads that commit (`<rev>^!`), not the empty working-tree diff.
    const second = git(root, "rev-parse", "HEAD").trim();
    assert.deepEqual(resolveAmpiReviewChangedFiles("HEAD", repository, env), { kind: "revision", revision: "HEAD", files });
    assert.deepEqual(resolveAmpiReviewChangedFiles(second, repository, env), { kind: "revision", revision: second, files });
    // A dirty tree keeps the working-tree diff for a single revision.
    write(root, "README.md", "# repo, edited\n");
    assert.deepEqual(resolveAmpiReviewChangedFiles("HEAD", repository, env), { kind: "revision", revision: "HEAD", files: ["README.md"] });
    // A revision that still yields no files is unknown, so every check runs rather than none.
    assert.deepEqual(resolveAmpiReviewChangedFiles("HEAD..HEAD", repository, env), { kind: "unknown" });
    assert.deepEqual(resolveAmpiReviewChangedFiles("HEAD", makeRootOnly(), env), { kind: "unknown" });
  });

  it("treats a description that is not a revision as unknown, so every check runs", async () => {
    const { createAmpiReviewCheckEnv, detectAmpiReviewRepository, planAmpiReviewChecks, resolveAmpiReviewChangedFiles } =
      await importSource(CHECKS_MODULE);
    const root = makeChecksRepo();
    const env = createAmpiReviewCheckEnv();
    const repository = detectAmpiReviewRepository(root, env);
    for (const description of ["the retry refactor on this branch", "no-such-ref", "--output=/tmp/x", "HEAD~99"]) {
      assert.deepEqual(resolveAmpiReviewChangedFiles(description, repository, env), { kind: "unknown" }, description);
    }
    const result = planAmpiReviewChecks({ cwd: root, diffDescription: "the retry refactor on this branch" });
    assert.deepEqual(
      result.selected.map((selection) => [selection.check.name, selection.changedFiles]),
      [["broken", undefined], ["house-style", undefined], ["input", undefined], ["crlf-check", undefined]],
    );
  });

  it("parses git status -z entries, renames and copies included", async () => {
    const { parseAmpiGitStatusPorcelain } = await importSource(CHECKS_MODULE);
    const stdout = [" M a.ts", "R  new/b.ts", "old/b.ts", "?? c d.txt", "C  copy.ts", "orig.ts", "D  gone.ts", ""].join("\0");
    assert.deepEqual(parseAmpiGitStatusPorcelain(stdout), ["a.ts", "new/b.ts", "old/b.ts", "c d.txt", "copy.ts", "orig.ts", "gone.ts"]);
  });

  it("counts findings as location lines after the Findings heading", async () => {
    const { countAmpiReviewFindings } = await importSource(CHECKS_MODULE);
    const report = [
      "Summary: touches src/a.ts:1-2 and more.",
      "",
      "## Findings",
      "- src/a.ts:3-4 — severity: high; type: bug",
      "  continued text mentioning src/a.ts:5-6",
      "1. `src/b.ts:0-0` — severity: low; type: non_actionable",
      "**src/c.ts:10-12** — severity: medium; type: suggested_edit",
      "See src/d.ts:1-1 for context.",
    ].join("\n");
    assert.equal(countAmpiReviewFindings(report), 3);
    assert.equal(countAmpiReviewFindings("Clean.\n\nFindings\n\nNone."), 0);
    assert.equal(countAmpiReviewFindings("- x.ts:1-2 — severity: low; type: compliment\r\n- y.ts:3-4 — low"), 2);
    // A single-line location counts too; a labelled location and a table row do not.
    assert.equal(countAmpiReviewFindings("Findings\n- `src/api/h.ts:42` — high, bug\n3. src/b.ts:7 — low\nNote: 3 items"), 2);
    assert.equal(countAmpiReviewFindings("**File:** `src/api/h.ts:40-44`\n| src/api/h.ts:40-44 | high |"), 0);
  });
});

// ---------------------------------------------------------------------------
// Orchestration: injected repository and runner, no child processes
// ---------------------------------------------------------------------------

/** An injected repository at /repo answering exactly the git commands discovery runs. */
function fakeGitRepo(files, statusEntries) {
  const commands = [];
  const env = {
    runCommand(command, args, cwd) {
      commands.push([command, ...args].join(" "));
      const line = [command, ...args].join(" ");
      if (line === "git rev-parse --show-toplevel") return { stdout: "/repo\n", exitCode: 0 };
      if (line.startsWith("git ls-files")) {
        assert.equal(cwd, "/repo");
        return { stdout: Object.keys(files).map((file) => `${file}\0`).join(""), exitCode: 0 };
      }
      if (line.startsWith("git status")) return { stdout: statusEntries.map((entry) => `${entry}\0`).join(""), exitCode: 0 };
      return { stdout: "", exitCode: 128 };
    },
    readFile: (absolutePath) => files[path.relative("/repo", absolutePath).split(path.sep).join("/")],
    isDirectory: () => false,
    listDirectory: () => [],
  };
  return { env, commands };
}

const SIX_CHECKS = {
  ".agents/checks/a-style.md": "---\nname: style\ndescription: House style\n---\nKeep names short.\n",
  ".agents/checks/b-docs.md": "Docs follow the change.\n",
  ".agents/checks/c-broken.md": "---\nname: c\nnot a pair\n---\nBody C.\n",
  "packages/x/.agents/checks/input.md": "---\nname: input\n---\nValidate input.\n",
  "packages/x/.agents/checks/logs.md": "No secrets in logs.\n",
  "packages/y/.agents/checks/perf.md": "Avoid N+1 queries.\n",
};
const SIX_STATUS = [" M src/a.ts", " M packages/x/h.ts", "?? packages/y/new.ts"];
const ALL_CHANGED = ["packages/x/h.ts", "packages/y/new.ts", "src/a.ts"];
const MAIN_PROMPT = "Review the following diff: uncommitted changes";

function workerResult(finalOutput, overrides = {}) {
  return {
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
  };
}

/** Which run a runner call is: `main`, or the quoted check name in its task text. */
function runName(options) {
  if (options.prompt === MAIN_PROMPT) return "main";
  return /review check, "([^"]+)"/.exec(options.prompt)?.[1] ?? "unknown";
}

const OUTPUTS = {
  main: "Main summary.\n\nFindings\n- src/a.ts:1-2 — severity: low; type: compliment\n  Nice.",
  style: "Style summary.\n\nFindings\n- src/a.ts:3-4 — severity: medium; type: suggested_edit\n- src/a.ts:9-9 — severity: low; type: suggested_edit",
  "b-docs": "Docs are fine.\n\nFindings\n\nNone.",
  input: "Input summary.\n\n## Findings\n1. `packages/x/h.ts:5-7` — severity: high; type: bug",
  logs: "Clean.",
  perf: "Clean.",
};

function resultFor(options) {
  const name = runName(options);
  if (name === "c-broken") return workerResult("", { exitCode: 1, stderr: "loading\nboom", stopReason: "error" });
  return workerResult(OUTPUTS[name] ?? `unexpected run ${name}`);
}

/** A runner whose calls stay in flight until the test settles them by hand. */
function manualRunner() {
  const calls = [];
  const waiters = [];
  let inFlight = 0;
  let peak = 0;
  const notify = () => {
    for (const waiter of [...waiters]) {
      if (calls.length >= waiter.count) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  };
  const runner = {
    run(options) {
      inFlight++;
      peak = Math.max(peak, inFlight);
      return new Promise((resolve) => {
        let settled = false;
        const settle = (result) => {
          if (settled) return;
          settled = true;
          inFlight--;
          resolve(result);
        };
        const call = { options, name: runName(options), settle };
        options.signal?.addEventListener("abort", () => settle(workerResult("", { aborted: true, stopReason: "aborted", exitCode: null })), { once: true });
        calls.push(call);
        notify();
      });
    },
  };
  return {
    runner,
    calls,
    get inFlight() {
      return inFlight;
    },
    get peak() {
      return peak;
    },
    waitForCalls(count) {
      return new Promise((resolve) => {
        waiters.push({ count, resolve });
        notify();
      });
    },
  };
}

function immediateRunner(resolve = resultFor) {
  const calls = [];
  return {
    calls,
    runner: {
      async run(options) {
        calls.push(options);
        return resolve(options);
      },
    },
  };
}

async function reviewerTool(deps) {
  const { createReviewerTool } = await importSource(REVIEWER_MODULE);
  return createReviewerTool({ buildSystemPrompt: (cwd) => `SP for ${cwd}`, ...deps });
}

const EXPECTED_CHECKS_SECTION = [
  "## Checks",
  "",
  "### b-docs (repository root): 0 counted findings (see report)",
  "",
  "Docs are fine.",
  "",
  "Findings",
  "",
  "None.",
  "",
  "### c-broken (repository root): failed: worker exited with code 1: boom",
  "",
  "### style (repository root): 2 findings",
  "",
  "Style summary.",
  "",
  "Findings",
  "- src/a.ts:3-4 — severity: medium; type: suggested_edit",
  "- src/a.ts:9-9 — severity: low; type: suggested_edit",
  "",
  "### input (packages/x): 1 finding",
  "",
  "Input summary.",
  "",
  "## Findings",
  "1. `packages/x/h.ts:5-7` — severity: high; type: bug",
  "",
  "### logs (packages/x): 0 counted findings (see report)",
  "",
  "Clean.",
  "",
  "### perf (packages/y): 0 counted findings (see report)",
  "",
  "Clean.",
  "",
  "Warnings:",
  '- .agents/checks/c-broken.md: the front matter line "not a pair" is not "key: value"; the check runs as "c-broken".',
].join("\n");

const EXPECTED_CHECK_DETAILS = [
  { name: "b-docs", scope: ".", file: ".agents/checks/b-docs.md", status: "no-issues", findings: 0, changedFiles: ALL_CHANGED },
  {
    name: "c-broken",
    scope: ".",
    file: ".agents/checks/c-broken.md",
    status: "failed",
    findings: 0,
    failureReason: "worker exited with code 1: boom",
    warning: '.agents/checks/c-broken.md: the front matter line "not a pair" is not "key: value"; the check runs as "c-broken".',
    changedFiles: ALL_CHANGED,
  },
  { name: "style", scope: ".", file: ".agents/checks/a-style.md", status: "findings", findings: 2, changedFiles: ALL_CHANGED },
  { name: "input", scope: "packages/x", file: "packages/x/.agents/checks/input.md", status: "findings", findings: 1, changedFiles: ["packages/x/h.ts"] },
  { name: "logs", scope: "packages/x", file: "packages/x/.agents/checks/logs.md", status: "no-issues", findings: 0, changedFiles: ["packages/x/h.ts"] },
  { name: "perf", scope: "packages/y", file: "packages/y/.agents/checks/perf.md", status: "no-issues", findings: 0, changedFiles: ["packages/y/new.ts"] },
];

describe("reviewer with review checks", () => {
  it("never runs more than 4 reviewer children at once, the main review counted", async () => {
    const { env } = fakeGitRepo(SIX_CHECKS, SIX_STATUS);
    const manual = manualRunner();
    const tool = await reviewerTool({ runner: manual.runner, reviewCheckEnv: env });
    const pending = tool.execute("c1", { diff_description: "uncommitted changes" }, undefined, undefined, { cwd: "/repo" });

    await manual.waitForCalls(4);
    assert.equal(manual.inFlight, 4);
    assert.deepEqual(manual.calls.map((call) => call.name), ["main", "b-docs", "c-broken", "style"]);
    for (let next = 5; next <= 7; next++) {
      manual.calls[next - 5].settle(resultFor(manual.calls[next - 5].options));
      await manual.waitForCalls(next);
      assert.equal(manual.inFlight, 4, `after starting run ${next}`);
    }
    for (const call of manual.calls.slice(3)) call.settle(resultFor(call.options));
    const result = await pending;
    assert.equal(manual.calls.length, 7);
    assert.equal(manual.peak, 4);
    assert.deepEqual(manual.calls.map((call) => call.name), ["main", "b-docs", "c-broken", "style", "input", "logs", "perf"]);
    assert.equal(result.details.status, "success");
  });

  it("puts the main report first, then a Checks section, and records each check in details", async () => {
    const { env } = fakeGitRepo(SIX_CHECKS, SIX_STATUS);
    const { runner, calls } = immediateRunner();
    const tool = await reviewerTool({ runner, reviewCheckEnv: env });
    const result = await tool.execute("c1", { diff_description: "uncommitted changes" }, undefined, undefined, { cwd: "/repo" });

    assert.equal(result.content[0].text, `${OUTPUTS.main}\n\n${EXPECTED_CHECKS_SECTION}`);
    assert.deepEqual(result.details.checks, EXPECTED_CHECK_DETAILS);
    assert.equal(result.details.status, "success");
    assert.equal(result.details.mainReview, "success");
    // The details otherwise describe the main review, as without checks.
    assert.equal(result.details.worker, "ampi-workers.reviewer");
    assert.equal(result.details.cwd, "/repo");

    // Every child shares the reviewer profile and system prompt; only the task text differs.
    assert.equal(calls.length, 7);
    for (const options of calls) {
      assert.equal(options.profileName, "reviewer");
      assert.equal(options.systemPrompt, "SP for /repo");
      assert.equal(options.cwd, "/repo");
    }
    const input = calls.find((options) => runName(options) === "input");
    assert.equal(
      input.prompt,
      [
        "Review the following diff: uncommitted changes",
        "",
        'This review applies a single review check, "input", defined in packages/x/.agents/checks/input.md: report only what the check asks about.',
        "",
        "Scope: packages/x. Review only changed files under this directory; paths are relative to the repository root, /repo.",
        "Changed files in scope:",
        "- packages/x/h.ts",
        "",
        "Check instructions:",
        "",
        "Validate input.",
      ].join("\n"),
    );
    const style = calls.find((options) => runName(options) === "style");
    assert.match(style.prompt, /Scope: the repository root\. Review only changed files under it;/);
    assert.match(style.prompt, /\n\nCheck description: House style\n\nCheck instructions:\n\nKeep names short\.$/);
  });

  it("checks_only skips the main review", async () => {
    const { env } = fakeGitRepo(SIX_CHECKS, SIX_STATUS);
    const { runner, calls } = immediateRunner();
    const tool = await reviewerTool({ runner, reviewCheckEnv: env });
    const result = await tool.execute("c1", { diff_description: "uncommitted changes", checks_only: true }, undefined, undefined, { cwd: "/repo" });
    assert.equal(calls.length, 6);
    assert.ok(!calls.some((options) => runName(options) === "main"));
    assert.equal(result.content[0].text, EXPECTED_CHECKS_SECTION);
    assert.equal(result.details.mainReview, "skipped");
    assert.equal(result.details.status, "success");
    assert.deepEqual(result.details.checks, EXPECTED_CHECK_DETAILS);
  });

  it("check_filter and check_scope narrow the checks; an unknown name fails before any run", async () => {
    const { env } = fakeGitRepo(SIX_CHECKS, SIX_STATUS);
    const { runner, calls } = immediateRunner();
    const tool = await reviewerTool({ runner, reviewCheckEnv: env });
    const filtered = await tool.execute("c1", { diff_description: "uncommitted changes", check_filter: ["perf", "style"] }, undefined, undefined, { cwd: "/repo" });
    assert.deepEqual(filtered.details.checks.map((check) => check.name), ["style", "perf"]);
    const scoped = await tool.execute("c2", { diff_description: "uncommitted changes", check_scope: "packages/x" }, undefined, undefined, { cwd: "/repo" });
    assert.deepEqual(scoped.details.checks.map((check) => check.name), ["input", "logs"]);
    calls.length = 0;
    await assert.rejects(
      tool.execute("c3", { diff_description: "uncommitted changes", check_filter: ["missing"] }, undefined, undefined, { cwd: "/repo" }),
      (error) => error.message === 'reviewer: no review check named "missing". Available checks: b-docs, c-broken, input, logs, perf, style.',
    );
    assert.equal(calls.length, 0);
  });

  it("checks_only with no applicable check is an error, and no checks at all leaves the review as it was", async () => {
    const { env } = fakeGitRepo({ "packages/x/.agents/checks/input.md": "Validate input.\n" }, [" M src/a.ts"]);
    const { runner, calls } = immediateRunner();
    const tool = await reviewerTool({ runner, reviewCheckEnv: env });
    await assert.rejects(
      tool.execute("c1", { diff_description: "uncommitted changes", checks_only: true }, undefined, undefined, { cwd: "/repo" }),
      (error) => error.message === "reviewer: checks_only is set, but no review check applies to this change (1 check file found under .agents/checks/).",
    );
    assert.equal(calls.length, 0);
    const result = await tool.execute("c2", { diff_description: "uncommitted changes" }, undefined, undefined, { cwd: "/repo" });
    assert.equal(calls.length, 1);
    assert.equal(result.content[0].text, OUTPUTS.main);
    assert.equal(result.details.checks, undefined);
    assert.equal(result.details.mainReview, undefined);
  });

  it("keeps a check's whole report when its findings use a shape the counter does not recognize", async () => {
    const { env } = fakeGitRepo({ "src/api/.agents/checks/handlers.md": "Handlers validate input.\n" }, [" M src/api/h.ts"]);
    const report = [
      "Two handlers trust their input.",
      "",
      "**File:** `src/api/h.ts:40-44`",
      "#### 1. `src/api/h.ts:40-44`",
      "| src/api/h.ts:40-44 | high |",
    ].join("\n");
    const { runner } = immediateRunner((options) => workerResult(runName(options) === "handlers" ? report : "Main: clean."));
    const tool = await reviewerTool({ runner, reviewCheckEnv: env });
    const result = await tool.execute("c1", { diff_description: "uncommitted changes" }, undefined, undefined, { cwd: "/repo" });
    // The heading claims only what the counter knows; the report says the rest.
    assert.equal(result.content[0].text, `Main: clean.\n\n## Checks\n\n### handlers (src/api): 0 counted findings (see report)\n\n${report}`);
    assert.deepEqual(result.details.checks.map((check) => [check.name, check.status, check.findings]), [["handlers", "no-issues", 0]]);
  });

  it("fails the call only when every run failed", async () => {
    const { env } = fakeGitRepo({ ".agents/checks/one.md": "One.\n", ".agents/checks/two.md": "Two.\n" }, [" M src/a.ts"]);
    const failing = () => workerResult("", { exitCode: 1, stderr: "boom", stopReason: "error" });
    const { runner } = immediateRunner(failing);
    const tool = await reviewerTool({ runner, reviewCheckEnv: env });
    const result = await tool.execute("c1", { diff_description: "uncommitted changes" }, undefined, undefined, { cwd: "/repo" });
    assert.equal(result.details.status, "worker-error");
    assert.equal(result.details.mainReview, "worker-error");
    assert.equal(
      result.content[0].text,
      [
        "reviewer: worker exited with code 1.",
        "",
        "boom",
        "",
        "## Checks",
        "",
        "### one (repository root): failed: worker exited with code 1: boom",
        "",
        "### two (repository root): failed: worker exited with code 1: boom",
      ].join("\n"),
    );

    // One check that answers is enough for the call to succeed.
    const { runner: mixed } = immediateRunner((options) => (runName(options) === "two" ? workerResult("Clean.") : failing()));
    const partial = await (await reviewerTool({ runner: mixed, reviewCheckEnv: env })).execute(
      "c2",
      { diff_description: "uncommitted changes" },
      undefined,
      undefined,
      { cwd: "/repo" },
    );
    assert.equal(partial.details.status, "success");
    assert.equal(partial.details.mainReview, "worker-error");
    assert.deepEqual(partial.details.checks.map((check) => [check.name, check.status]), [["one", "failed"], ["two", "no-issues"]]);
  });

  it("cancelling the call cancels running children and never starts pending ones", async () => {
    const { env } = fakeGitRepo(SIX_CHECKS, SIX_STATUS);
    const manual = manualRunner();
    const tool = await reviewerTool({ runner: manual.runner, reviewCheckEnv: env });
    const controller = new AbortController();
    const pending = tool.execute("c1", { diff_description: "uncommitted changes" }, controller.signal, undefined, { cwd: "/repo" });
    await manual.waitForCalls(4);
    controller.abort();
    const result = await pending;
    assert.equal(manual.calls.length, 4, "pending checks never start");
    assert.ok(manual.calls.every((call) => call.options.signal.aborted), "every running child saw the abort");
    assert.deepEqual(
      result.details.checks.map((check) => [check.name, check.status, check.failureReason]),
      [
        ["b-docs", "failed", "cancelled"],
        ["c-broken", "failed", "cancelled"],
        ["style", "failed", "cancelled"],
        ["input", "failed", "cancelled"],
        ["logs", "failed", "cancelled"],
        ["perf", "failed", "cancelled"],
      ],
    );
    assert.equal(result.details.mainReview, "aborted");
    assert.match(result.content[0].text, /^reviewer: the review was cancelled before producing a report\.\n\n## Checks\n/);
  });

  it("runs checks through the background run preparer too", async () => {
    const { createReviewerRunPreparer } = await importSource(REVIEWER_MODULE);
    const { env } = fakeGitRepo(SIX_CHECKS, SIX_STATUS);
    const { runner, calls } = immediateRunner();
    const prepare = createReviewerRunPreparer({ runner, reviewCheckEnv: env, buildSystemPrompt: (cwd) => `SP for ${cwd}` });
    const prep = prepare({ diff_description: "uncommitted changes" }, { cwd: "/repo" });
    assert.equal(prep.ok, true);
    const raw = await prep.prepared.run({ signal: new AbortController().signal, onProgress: () => {} });
    assert.equal(calls.length, 7);
    const projected = prep.prepared.projectResult(raw);
    assert.equal(projected.content[0].text, `${OUTPUTS.main}\n\n${EXPECTED_CHECKS_SECTION}`);
    assert.deepEqual(projected.details.checks, EXPECTED_CHECK_DETAILS);
  });

  it("re-sends progress when a pending check starts after the main review has reported progress", async () => {
    const { env } = fakeGitRepo(SIX_CHECKS, SIX_STATUS);
    const manual = manualRunner();
    const tool = await reviewerTool({ runner: manual.runner, reviewCheckEnv: env });
    const updates = [];
    const pending = tool.execute("c1", { diff_description: "uncommitted changes" }, undefined, (update) => updates.push(update), { cwd: "/repo" });
    await manual.waitForCalls(4);
    const main = manual.calls.find((call) => call.name === "main");
    main.options.onProgress({ messages: [], finalOutput: "Reading the diff.", truncatedFinalOutput: "Reading the diff.", trail: [], usage: workerResult("").usage });
    const statuses = (update) => Object.fromEntries(update.details.checks.map((check) => [check.name, check.status]));
    assert.deepEqual(statuses(updates.at(-1)), {
      "b-docs": "running",
      "c-broken": "running",
      style: "running",
      input: "pending",
      logs: "pending",
      perf: "pending",
    });
    const before = updates.length;
    const docs = manual.calls.find((call) => call.name === "b-docs");
    docs.settle(resultFor(docs.options));
    await manual.waitForCalls(5);
    // Freeing b-docs' slot starts input; that start is visible before input's own run reports anything.
    const started = updates.slice(before).find((update) => statuses(update).input === "running");
    assert.ok(started, "a progress update carries the started check");
    assert.equal(started.content[0].text, "Reading the diff.");
    assert.deepEqual(statuses(started), {
      "b-docs": "no-issues",
      "c-broken": "running",
      style: "running",
      input: "running",
      logs: "pending",
      perf: "pending",
    });
    // Settle everything; the last pending checks start as slots free.
    while (manual.calls.length < 7) {
      const started = manual.calls.length;
      for (const call of manual.calls) call.settle(resultFor(call.options));
      await manual.waitForCalls(started + 1);
    }
    for (const call of manual.calls) call.settle(resultFor(call.options));
    await pending;
  });

  it("reports progress from the main review, and again when a check settles", async () => {
    const { env } = fakeGitRepo({ ".agents/checks/one.md": "One.\n" }, [" M src/a.ts"]);
    const manual = manualRunner();
    const tool = await reviewerTool({ runner: manual.runner, reviewCheckEnv: env });
    const updates = [];
    const pending = tool.execute("c1", { diff_description: "uncommitted changes" }, undefined, (update) => updates.push(update), { cwd: "/repo" });
    await manual.waitForCalls(2);
    const main = manual.calls.find((call) => call.name === "main");
    const check = manual.calls.find((call) => call.name === "one");
    check.options.onProgress?.({ messages: [], finalOutput: "", truncatedFinalOutput: "", trail: [], usage: workerResult("").usage });
    assert.equal(updates.length, 0, "check children do not drive the row");
    main.options.onProgress({ messages: [], finalOutput: "Reading the diff.", truncatedFinalOutput: "Reading the diff.", trail: [], usage: workerResult("").usage });
    assert.deepEqual(updates.at(-1).details.checks, [
      { name: "one", scope: ".", file: ".agents/checks/one.md", status: "running", findings: 0, changedFiles: ["src/a.ts"] },
    ]);
    const before = updates.length;
    check.settle(workerResult("Clean."));
    main.settle(resultFor(main.options));
    await pending;
    // The run re-sent the main review's last progress once the check settled, before it finished.
    const refreshed = updates.slice(before).find((update) => update.details.checks?.[0]?.status === "no-issues");
    assert.ok(refreshed, "a progress update carries the settled check");
    assert.equal(refreshed.content[0].text, "Reading the diff.");
    assert.deepEqual(refreshed.details.checks, [
      { name: "one", scope: ".", file: ".agents/checks/one.md", status: "no-issues", findings: 0, changedFiles: ["src/a.ts"] },
    ]);
  });
});

describe("review checks in a Jujutsu repository", () => {
  function fakeJjRepo() {
    const commands = [];
    const files = { ".agents/checks/naming.md": "---\nname: naming\n---\nNames say what they hold.\n" };
    const env = {
      runCommand(command, args, cwd) {
        const line = [command, ...args].join(" ");
        commands.push(`${line} @ ${cwd}`);
        if (line === "jj root") return { stdout: "/jjrepo\n", exitCode: 0 };
        if (line === 'jj file list glob:"**/.agents/checks/*.md"') return { stdout: ".agents/checks/naming.md\n", exitCode: 0 };
        if (line === "jj diff --name-only") return { stdout: "src/a.ts\n", exitCode: 0 };
        return { stdout: "", exitCode: 1 };
      },
      readFile: (absolutePath) => files[path.relative("/jjrepo", absolutePath)],
      isDirectory: (absolutePath) => absolutePath === "/jjrepo/.jj",
      listDirectory: () => [],
    };
    return { env, commands };
  }

  it("finds the root with jj root, checks with a jj file list fileset and changes with jj diff --name-only", async () => {
    const { planAmpiReviewChecks } = await importSource(CHECKS_MODULE);
    const { env, commands } = fakeJjRepo();
    const result = planAmpiReviewChecks({ cwd: "/jjrepo/src", diffDescription: "uncommitted changes", env });
    assert.deepEqual(result.repository, { kind: "jj", root: "/jjrepo" });
    assert.deepEqual(result.changes, { kind: "uncommitted", files: ["src/a.ts"] });
    assert.deepEqual(
      result.selected.map((selection) => [selection.check.name, selection.changedFiles]),
      [["naming", ["src/a.ts"]]],
    );
    assert.deepEqual(commands, ["jj root @ /jjrepo/src", 'jj file list glob:"**/.agents/checks/*.md" @ /jjrepo', "jj diff --name-only @ /jjrepo"]);
  });

  it("tells the check child to read the diff with jj diff --git", async () => {
    const { env } = fakeJjRepo();
    const { runner, calls } = immediateRunner(() => workerResult("Clean."));
    const tool = await reviewerTool({ runner, reviewCheckEnv: env });
    const result = await tool.execute("c1", { diff_description: "uncommitted changes" }, undefined, undefined, { cwd: "/jjrepo" });
    const check = calls.find((options) => runName(options) === "naming");
    assert.match(check.prompt, /This is a Jujutsu repository: get the diff with `jj diff --git`/);
    assert.equal(calls.find((options) => runName(options) === "main").prompt, MAIN_PROMPT);
    assert.deepEqual(result.details.checks.map((entry) => [entry.name, entry.status]), [["naming", "no-issues"]]);
  });
});
