// `ampi skill list|info|add|remove` (packages/ampi-cli/src/skill.js) and the
// skill source rules it shares with ampi-core (src/extensions/ampi-core/
// skill-sources.ts, copied to packages/ampi-cli/src/skill-sources.js). The
// listing runs against the installed Pi in a session started in memory with a
// stand-in ampi package, in a temporary home and agent directory; git sources
// are bare repositories in a temporary directory, cloned through file:// URLs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import * as pi from "@earendil-works/pi-coding-agent";
import { routeAmpiArgv } from "../packages/ampi-cli/src/argv.js";
import { createLogger } from "../packages/ampi-cli/src/log.js";
import { INFO_FILE_LIMIT, parseSkillSource, readSessionSkills, removalAdvice, runSkillCommand } from "../packages/ampi-cli/src/skill.js";
import { classifySkillSource, skillSourceLabel } from "../packages/ampi-cli/src/skill-sources.js";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(() => cleanupLoadedSource());

const HOME = "/home/user";
const PROJECT = `${HOME}/projects/demo`;
const info = (path, source, scope, origin = "top-level") => ({ path, source, scope, origin });

/** One skill from each place Pi finds them, with the sourceInfo Pi gives each, and the label the command prints. */
const FIXTURES = [
  [info(`${HOME}/.pi/agent/skills/pdf-tools/SKILL.md`, "auto", "user"), "user"],
  [info(`${HOME}/.agents/skills/review/SKILL.md`, "auto", "user"), "agents-user"],
  [info(`${PROJECT}/.pi/skills/release-notes/SKILL.md`, "auto", "project"), "project"],
  [info(`${PROJECT}/.agents/skills/triage/SKILL.md`, "auto", "project"), "agents-project"],
  [info(`${HOME}/.pi/agent/npm/node_modules/pi-skills/skills/search/SKILL.md`, "npm:pi-skills", "user", "package"), "package:npm:pi-skills"],
  [info(`${HOME}/shared-skills/deploy/SKILL.md`, "local", "user"), "settings"],
  [info("/tmp/try/SKILL.md", "cli", "temporary"), "temporary"],
  [info("/tmp/pkg/skills/a/SKILL.md", "npm:pi-skills", "temporary", "package"), "temporary"],
  [info(`${HOME}/.claude/skills/commit/SKILL.md`, "extension:index", "temporary"), "claude-user"],
  [info(`${PROJECT}/.claude/skills/lint/SKILL.md`, "extension:index", "temporary"), "claude-project"],
  [info(`${HOME}/my-skills/notes/SKILL.md`, "extension:index", "temporary"), "settings"],
];

/** @param {string} file @param {string} text */
const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

/** A SKILL.md with the given frontmatter lines. */
const skillFile = (...frontmatter) => `---\n${frontmatter.join("\n")}\n---\n\nInstructions.\n`;

/** @param {string} dir @param {string} name @param {string} [description] */
const writeSkill = (dir, name, description = `The ${name} skill.`) => write(path.join(dir, "SKILL.md"), skillFile(`name: ${name}`, `description: ${description}`));

/** A hand-built skill as Pi's loader returns it. */
const piSkill = (name, sourceInfo, baseDir = path.dirname(sourceInfo.path)) => ({
  name,
  description: `The ${name} skill.`,
  filePath: sourceInfo.path,
  baseDir,
  sourceInfo,
  disableModelInvocation: false,
});

/**
 * Run a skill command, collecting its output. `skills` (or `readSkills`) stands in for the session.
 *
 * @param {string[]} args
 * @param {object} options
 */
async function run(args, { cwd, agentDir, skills = [], readSkills, tempRoot = tmpdir(), interactive = false, answer, columns = 80, gitEnv } = {}) {
  let out = "";
  let err = "";
  const questions = [];
  const code = await runSkillCommand(args, {
    pi,
    cwd,
    agentDir,
    readSkills: readSkills ?? (async () => ({ skills, problems: [], failures: [] })),
    git: (gitArgs) => {
      const result = spawnSync("git", gitArgs, { encoding: "utf8", env: { ...process.env, ...gitEnv, GIT_TERMINAL_PROMPT: "0" } });
      return { status: result.status, stderr: result.stderr ?? "", error: result.error };
    },
    tempRoot,
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
  });
  return { code, out, err, questions };
}

describe("skill sources", () => {
  it("gives the same groups in ampi-core and the command, and the command's labels", async () => {
    const core = await importSource("extensions/ampi-core/skill-sources.ts");
    for (const [sourceInfo, label] of FIXTURES) {
      const cli = classifySkillSource(sourceInfo, sourceInfo.path, HOME);
      assert.deepEqual(cli, core.classifyMmrSkillSource(sourceInfo, sourceInfo.path, HOME), sourceInfo.path);
      assert.equal(skillSourceLabel(cli), label, sourceInfo.path);
    }
    // The file path, when given, decides the origin.
    const [user] = FIXTURES[0];
    const agentsPath = `${HOME}/.agents/skills/x/SKILL.md`;
    assert.deepEqual(classifySkillSource(user, agentsPath, HOME), core.classifyMmrSkillSource(user, agentsPath, HOME));
  });
});

describe("ampi skill: routing and usage errors", () => {
  it("routes skill and its alias skills with the rest of the command line", () => {
    for (const group of ["skill", "skills"]) {
      const route = routeAmpiArgv([group, "add", "acme/skills", "--global"]);
      assert.equal(route.command, "skill", group);
      assert.deepEqual(route.skillArgs, ["add", "acme/skills", "--global"]);
      assert.deepEqual(route.piArgs, []);
    }
  });

  it("refuses unknown commands, options of another command, wrong argument counts and --global with --target", async () => {
    const cwd = "/nowhere";
    const cases = [
      [[], /needs a command/],
      [["publish"], /unknown skill command "publish"/],
      [["list", "--yes"], /--yes does not apply to skill list/],
      [["info"], /needs exactly one argument: a skill name/],
      [["ls", "extra"], /takes no arguments/],
      [["add", "x", "--global", "--target", "y"], /--global or --target, not both/],
      [["rm", "../escape"], /is not a skill name/],
      [["add", "https://example.com/r.git//../up"], /must be relative and stay inside it/],
    ];
    for (const [args, message] of cases) {
      const result = await run(args, { cwd, agentDir: cwd });
      assert.equal(result.code, 2, args.join(" "));
      assert.match(result.err, message, args.join(" "));
    }
    assert.match((await run(["--help"], { cwd })).out, /^ampi skill:/);
  });
});

describe("ampi skill add: sources", () => {
  it("reads owner/repo shorthands, git URLs with a //subpath, and local paths", () => {
    const exists = (candidate) => candidate === "skills/local";
    assert.deepEqual(parseSkillSource("acme/skills", exists), { kind: "git", url: "https://github.com/acme/skills.git", subpath: "" });
    assert.deepEqual(parseSkillSource("acme/skills.git/tools/pdf/", exists), {
      kind: "git",
      url: "https://github.com/acme/skills.git",
      subpath: "tools/pdf",
    });
    assert.deepEqual(parseSkillSource("https://example.com/team/skills.git//review", exists), {
      kind: "git",
      url: "https://example.com/team/skills.git",
      subpath: "review",
    });
    assert.deepEqual(parseSkillSource("file:///srv/git/skills.git//a/b", exists), { kind: "git", url: "file:///srv/git/skills.git", subpath: "a/b" });
    assert.deepEqual(parseSkillSource("git@example.com:team/skills.git", exists), { kind: "git", url: "git@example.com:team/skills.git", subpath: "" });
    assert.deepEqual(parseSkillSource("ssh://git@example.com/team/skills", exists), { kind: "git", url: "ssh://git@example.com/team/skills", subpath: "" });
    // An existing path, or one that starts like a path, is local even when it looks like owner/repo.
    for (const local of ["skills/local", "./acme/skills", "/abs/skills", "~/skills", "single"]) {
      assert.deepEqual(parseSkillSource(local, exists), { kind: "local", path: local }, local);
    }
    assert.equal(parseSkillSource("acme/skills/../other", exists).kind, "error");
    assert.equal(parseSkillSource("user@-oProxyCommand=x:repo", exists).kind, "local");
    assert.equal(parseSkillSource("ssh://-oProxyCommand=x/repo", exists).kind, "error");
  });
});

describe("ampi skill add and remove: local sources and targets", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ampi-cli-skill-add-"));
  const agentDir = path.join(dir, "agent");
  const project = path.join(dir, "project");
  const sources = path.join(dir, "sources");
  const single = path.join(sources, "pdf-tools");
  const multi = path.join(sources, "collection");
  const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, home: process.env.HOME };

  before(() => {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = path.join(dir, "home");
    mkdirSync(project, { recursive: true });
    writeSkill(single, "pdf-tools");
    write(path.join(single, "scripts", "extract.sh"), "echo extract\n");
    write(path.join(single, ".git", "HEAD"), "ref: refs/heads/main\n");
    symlinkSync("scripts/extract.sh", path.join(single, "extract"));
    // Skills directly in the source and in its skills/ directory; dot directories are not skills.
    writeSkill(path.join(multi, "alpha"), "alpha");
    writeSkill(path.join(multi, "skills", "beta"), "beta");
    writeSkill(path.join(multi, ".hidden"), "hidden");
  });

  after(() => {
    for (const [name, value] of [
      ["PI_CODING_AGENT_DIR", saved.agentDir],
      ["HOME", saved.home],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("installs a single skill into the project's .agents/skills without .git, and notes that the project is not trusted", async () => {
    const result = await run(["add", single], { cwd: project, agentDir });
    assert.equal(result.code, 0, result.err);
    const installed = path.join(project, ".agents", "skills", "pdf-tools");
    assert.deepEqual(result.out.split("\n").slice(0, 2), [`Installed pdf-tools in ${installed}`, "Running sessions load it after /reload."]);
    assert.match(result.out, /not trusted yet: Pi loads its skills once you trust it/);
    assert.deepEqual(readdirSync(installed).sort(), ["SKILL.md", "extract", "scripts"]);
    assert.equal(readFileSync(path.join(installed, "extract"), "utf8"), "echo extract\n");
    // Nothing else is left in the target, such as a staging directory.
    assert.deepEqual(readdirSync(path.dirname(installed)), ["pdf-tools"]);
  });

  it("refuses an installed name, then replaces it with --overwrite", async () => {
    const refused = await run(["add", single], { cwd: project, agentDir });
    assert.equal(refused.code, 1);
    assert.match(refused.err, /already exists\. Pass --overwrite to replace it/);
    const installed = path.join(project, ".agents", "skills", "pdf-tools");
    write(path.join(installed, "stale.txt"), "old\n");
    const replaced = await run(["add", single, "--overwrite"], { cwd: project, agentDir });
    assert.equal(replaced.code, 0, replaced.err);
    assert.equal(existsSync(path.join(installed, "stale.txt")), false);
  });

  it("installs every skill of a collection with --global, and into another directory with --target", async () => {
    const global = await run(["add", multi, "--global"], { cwd: project, agentDir });
    assert.equal(global.code, 0, global.err);
    assert.deepEqual(readdirSync(path.join(agentDir, "skills")).sort(), ["alpha", "beta"]);
    assert.doesNotMatch(global.out, /not trusted/);
    const custom = path.join(dir, "custom");
    const targeted = await run(["add", path.relative(project, multi), "--target", "../custom"], { cwd: project, agentDir });
    assert.equal(targeted.code, 0, targeted.err);
    assert.deepEqual(readdirSync(custom).sort(), ["alpha", "beta"]);
    assert.match(targeted.out, new RegExp(`Installed alpha in ${path.join(custom, "alpha")}\nInstalled beta in ${path.join(custom, "beta")}\nRunning sessions load them after /reload\\.`));
    // A directory inside the project that is not one of its skill locations gets no trust note.
    const vendored = await run(["add", multi, "--target", "vendor/skills"], { cwd: project, agentDir });
    assert.equal(vendored.code, 0, vendored.err);
    assert.deepEqual(readdirSync(path.join(project, "vendor", "skills")).sort(), ["alpha", "beta"]);
    assert.doesNotMatch(vendored.out, /not trusted/);
  });

  it("renames the only skill with --name and refuses --name for a collection", async () => {
    const renamed = await run(["add", single, "--name", "pdf-reader", "--global"], { cwd: project, agentDir });
    assert.equal(renamed.code, 0, renamed.err);
    const text = readFileSync(path.join(agentDir, "skills", "pdf-reader", "SKILL.md"), "utf8");
    assert.match(text, /^---\nname: pdf-reader\ndescription: The pdf-tools skill\.\n---/);
    const invalid = await run(["add", single, "--name", "PDF Reader", "--global"], { cwd: project, agentDir });
    assert.equal(invalid.code, 1);
    assert.match(invalid.err, /the name "PDF Reader" is invalid: name contains invalid characters/);
    const several = await run(["add", multi, "--name", "one"], { cwd: project, agentDir });
    assert.equal(several.code, 2);
    assert.match(several.err, /--name needs a source with one skill; .* has 2/);
  });

  it("refuses a --name that is a path before touching any file", async () => {
    const docs = path.join(project, "docs", "SKILL.md");
    write(docs, "ORIGINAL\n");
    const before = readdirSync(project).sort();
    for (const name of ["../../../docs", "../../escaped", "a/b", "..", "."]) {
      const result = await run(["add", single, "--name", name], { cwd: project, agentDir });
      assert.equal(result.code, 2, name);
      assert.match(result.err, /--name ".*" is not a skill name/, name);
    }
    assert.equal(readFileSync(docs, "utf8"), "ORIGINAL\n");
    assert.deepEqual(readdirSync(project).sort(), before);
    assert.equal(existsSync(path.join(project, ".agents", "escaped")), false);
    rmSync(path.join(project, "docs"), { recursive: true });
  });

  it("refuses a target inside the skill it copies, and creates no directory there", async () => {
    // Developing a skill in its own directory and adding it there: the default target lies inside the source.
    const own = path.join(dir, "own-skill");
    writeSkill(own, "own-skill");
    const result = await run(["add", "."], { cwd: own, agentDir });
    assert.equal(result.code, 1);
    assert.match(result.err, /nothing installed; .*\.agents\/skills is inside the skill .*own-skill, which cannot be copied into itself/);
    assert.deepEqual(readdirSync(own), ["SKILL.md"]);
    const nested = await run(["add", own, "--target", path.join(own, "vendor")], { cwd: project, agentDir });
    assert.equal(nested.code, 1);
    assert.deepEqual(readdirSync(own), ["SKILL.md"]);
  });

  it("refuses skills Pi would not load as they are, and installs nothing from that source", async () => {
    const bad = path.join(dir, "bad");
    writeSkill(path.join(bad, "good"), "good");
    write(path.join(bad, "no-description", "SKILL.md"), skillFile("name: no-description"));
    write(path.join(bad, "no-name", "SKILL.md"), skillFile("description: Has no name."));
    writeSkill(path.join(bad, "Bad_Name"), "Bad_Name");
    write(path.join(bad, "broken", "SKILL.md"), "---\nname: [unclosed\ndescription: x\n---\n");
    writeSkill(path.join(bad, "leaky"), "leaky");
    symlinkSync("/etc/hostname", path.join(bad, "leaky", "host"));
    const result = await run(["add", bad, "--target", path.join(dir, "bad-target")], { cwd: project, agentDir });
    assert.equal(result.code, 1);
    assert.match(result.err, /nothing installed; these skills are invalid:/);
    assert.match(result.err, /Bad_Name: name contains invalid characters/);
    assert.match(result.err, /broken: its frontmatter does not parse/);
    assert.match(result.err, /leaky: host links to a file outside the skill/);
    assert.match(result.err, /no-description: description is required/);
    assert.match(result.err, /no-name: its frontmatter has no name/);
    assert.doesNotMatch(result.err, /good:/);
    assert.equal(existsSync(path.join(dir, "bad-target")), false);
    mkdirSync(path.join(dir, "empty", "skills", "notes"), { recursive: true });
    const empty = await run(["add", path.join(dir, "empty")], { cwd: project, agentDir });
    assert.equal(empty.code, 1);
    assert.match(empty.err, /holds no skill/);
  });

  it("removes an installed skill with --yes, asks without it, and refuses to ask without a terminal", async () => {
    const installed = path.join(project, ".agents", "skills", "pdf-tools");
    const headless = await run(["remove", "pdf-tools"], { cwd: project, agentDir });
    assert.equal(headless.code, 1);
    assert.match(headless.err, /there is no terminal to ask in; pass --yes/);
    const declined = await run(["rm", "pdf-tools"], { cwd: project, agentDir, interactive: true, answer: false });
    assert.equal(declined.code, 1);
    assert.deepEqual(declined.questions, [`Delete the skill pdf-tools in ${installed}? [y/N] `]);
    assert.equal(existsSync(installed), true);
    const removed = await run(["remove", "pdf-tools", "--yes"], { cwd: project, agentDir });
    assert.equal(removed.code, 0, removed.err);
    assert.equal(existsSync(installed), false);
    assert.match(removed.out, /^Removed pdf-tools from .*\.agents\/skills\nRunning sessions drop it after \/reload\.\n$/);
    // Not in the project: the global directory is next.
    const global = await run(["remove", "alpha", "--yes"], { cwd: project, agentDir });
    assert.equal(global.code, 0, global.err);
    assert.equal(existsSync(path.join(agentDir, "skills", "alpha")), false);
    // --target looks only there; a directory without SKILL.md is never removed.
    mkdirSync(path.join(dir, "custom", "plain"), { recursive: true });
    const plain = await run(["remove", "plain", "--target", path.join(dir, "custom"), "--yes"], { cwd: project, agentDir });
    assert.equal(plain.code, 1);
    assert.match(plain.err, /is not a skill directory/);
  });

  it("refuses a skill that loads from somewhere else, naming where and how to remove it there", async () => {
    const packaged = piSkill("search", info(path.join(agentDir, "npm", "node_modules", "pi-skills", "skills", "search", "SKILL.md"), "npm:pi-skills", "user", "package"));
    const agents = piSkill("review", info(path.join(dir, "home", ".agents", "skills", "review", "SKILL.md"), "auto", "user"));
    const skills = [packaged, agents];
    const pkg = await run(["remove", "search", "--yes"], { cwd: project, agentDir, skills });
    assert.equal(pkg.code, 1);
    assert.match(pkg.err, /no skill named "search" in .*\. "search" comes from the Pi package npm:pi-skills .* ampi remove npm:pi-skills/s);
    const agentsDir = path.join(dir, "home", ".agents", "skills");
    const user = await run(["remove", "review"], { cwd: project, agentDir, skills });
    assert.equal(user.code, 1);
    assert.ok(user.err.includes(`"review" is in ${agentsDir} (agents-user). Remove it there with ampi skill remove review --target ${agentsDir}.`), user.err);
    const unknown = await run(["remove", "missing", "--yes"], { cwd: project, agentDir, skills });
    assert.match(unknown.err, /no skill named "missing" in .*, and none loads in this directory/);
    // A directory named unlike its skill: the advice names the directory, and following it works.
    const projectSkills = path.join(project, ".agents", "skills");
    writeSkill(path.join(projectSkills, "foo-dir"), "foo");
    const renamed = piSkill("foo", info(path.join(projectSkills, "foo-dir", "SKILL.md"), "auto", "project"));
    const misnamed = await run(["remove", "foo"], { cwd: project, agentDir, skills: [renamed] });
    assert.equal(misnamed.code, 1);
    assert.ok(misnamed.err.includes(`Remove it with ampi skill remove foo-dir --target ${projectSkills}.`), misnamed.err);
    const followed = await run(["remove", "foo-dir", "--target", projectSkills, "--yes"], { cwd: project, agentDir });
    assert.equal(followed.code, 0, followed.err);
    assert.equal(existsSync(path.join(projectSkills, "foo-dir")), false);
    // A .md file directly in a skills directory: Pi's baseDir is the whole directory, so only the file is named.
    const userSkills = path.join(agentDir, "skills");
    const notes = removalAdvice(piSkill("notes", info(path.join(userSkills, "notes.md"), "auto", "user"), userSkills));
    assert.equal(notes, `"notes" is the single-file skill ${path.join(userSkills, "notes.md")} (user). Delete that file to remove it.`);
    assert.match(removalAdvice(piSkill("x", info("/tmp/x/SKILL.md", "cli", "temporary"))), /for this run only/);
    assert.match(removalAdvice(piSkill("y", info("/srv/y/SKILL.md", "local", "user"))), /skills setting or ampi\.skills\.path/);
  });
});

const gitMissing = spawnSync("git", ["--version"]).error !== undefined;

describe("ampi skill list and info: hand-built skills", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ampi-cli-skill-files-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("lists only the file of a single-file skill, and strips control characters from printed paths", async () => {
    const skills = path.join(dir, "skills");
    write(path.join(skills, "notes.md"), skillFile("name: notes", "description: Notes."));
    writeSkill(path.join(skills, "other"), "other");
    const notes = piSkill("notes", info(path.join(skills, "notes.md"), "auto", "user"), skills);
    const result = await run(["info", "notes", "--json"], { cwd: dir, agentDir: dir, skills: [notes] });
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(JSON.parse(result.out).files, ["notes.md"]);
    const escaped = path.join(dir, "evil\u001b[2Jdir");
    const listed = await run(["list"], { cwd: dir, agentDir: dir, skills: [piSkill("evil", info(path.join(escaped, "SKILL.md"), "auto", "user"))] });
    assert.ok(listed.out.includes(`    ${path.join(dir, "evil[2Jdir")}\n`), listed.out);
    assert.doesNotMatch(listed.out, /\u001b/);
  });
});

describe("ampi skill add: git sources", { skip: gitMissing ? "git is not installed" : false }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ampi-cli-skill-git-"));
  const agentDir = path.join(dir, "agent");
  const project = path.join(dir, "project");
  const tempRoot = path.join(dir, "clones");
  const bare = path.join(dir, "skills.git");
  // git without the user's or the system's configuration.
  const gitEnv = { HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(dir, "gitconfig") };
  const git = (args, cwd) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...gitEnv } });
    assert.equal(result.status, 0, result.stderr);
  };

  before(() => {
    const work = path.join(dir, "work");
    writeSkill(path.join(work, "skills", "review"), "review");
    write(path.join(work, "skills", "review", "checklist.md"), "- tests\n");
    writeSkill(path.join(work, "skills", "lint"), "lint");
    git(["init", "--quiet", "--initial-branch=main", work]);
    git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "add", "."], work);
    git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "skills"], work);
    git(["clone", "--quiet", "--bare", work, bare]);
    mkdirSync(project, { recursive: true });
    mkdirSync(tempRoot, { recursive: true });
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it("clones a file:// URL with a subpath, copies the skill without .git, and removes the clone", async () => {
    const result = await run(["add", `file://${bare}//skills/review`, "--global"], { cwd: project, agentDir, tempRoot, gitEnv });
    assert.equal(result.code, 0, result.err);
    const installed = path.join(agentDir, "skills", "review");
    assert.deepEqual(readdirSync(installed).sort(), ["SKILL.md", "checklist.md"]);
    assert.deepEqual(readdirSync(tempRoot), []);
    // The whole repository: its skills/ directory holds both skills.
    const all = await run(["add", `file://${bare}`, "--target", path.join(dir, "all")], { cwd: project, agentDir, tempRoot, gitEnv });
    assert.equal(all.code, 0, all.err);
    assert.deepEqual(readdirSync(path.join(dir, "all")).sort(), ["lint", "review"]);
    assert.deepEqual(readdirSync(tempRoot), []);
  });

  it("removes the clone directory when the clone or the source fails", async () => {
    const missing = await run(["add", `file://${path.join(dir, "missing.git")}`], { cwd: project, agentDir, tempRoot, gitEnv });
    assert.equal(missing.code, 1);
    assert.match(missing.err, /could not clone file:\/\//);
    assert.deepEqual(readdirSync(tempRoot), []);
    const subpath = await run(["add", `file://${bare}//skills/nothing`], { cwd: project, agentDir, tempRoot, gitEnv });
    assert.equal(subpath.code, 1);
    assert.match(subpath.err, /skills\/nothing is not a directory in file:\/\//);
    assert.deepEqual(readdirSync(tempRoot), []);
    assert.equal(existsSync(path.join(project, ".agents")), false);
  });
});

describe("ampi skill list and info", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ampi-cli-skill-list-"));
  const home = path.join(dir, "home");
  const agentDir = path.join(dir, "agent");
  const project = path.join(dir, "project");
  // A stand-in named like ampi, which Pi's settings load, so the session does not load the real one.
  const standIn = path.join(dir, "stand-in");
  const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, home: process.env.HOME, offline: process.env.PI_OFFLINE };

  before(() => {
    write(path.join(standIn, "package.json"), JSON.stringify({ name: "@skippermissions/ampi", version: "0.0.0", pi: { extensions: ["./index.ts"] } }));
    write(path.join(standIn, "index.ts"), "export default function (): void {}\n");
    write(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [standIn] }));
    writeSkill(path.join(agentDir, "skills", "pdf-tools"), "pdf-tools", "Extract text and tables from PDF files. Use when reading, converting or inspecting PDFs of any size.");
    writeSkill(path.join(home, ".agents", "skills", "review"), "review");
    writeSkill(path.join(project, ".pi", "skills", "release-notes"), "release-notes");
    writeSkill(path.join(project, ".agents", "skills", "triage"), "triage");
    // The same name as the user skill in Pi's directory, which Pi reads first: Pi keeps that one and reports this one.
    writeSkill(path.join(home, ".agents", "skills", "pdf-copy"), "pdf-tools");
    write(path.join(project, ".agents", "skills", "no-description", "SKILL.md"), skillFile("name: no-description"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = home;
    process.env.PI_OFFLINE = "1";
  });

  after(() => {
    for (const [name, value] of [
      ["PI_CODING_AGENT_DIR", saved.agentDir],
      ["HOME", saved.home],
      ["PI_OFFLINE", saved.offline],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const readSkills = () => readSessionSkills(pi, project);

  it("lists only the user's skills while the project is not trusted, then the project's too, with Pi's problems", async () => {
    const untrusted = JSON.parse((await run(["list", "--json"], { cwd: project, agentDir, readSkills })).out);
    assert.deepEqual(
      untrusted.skills.map((skill) => [skill.name, skill.source]),
      [
        ["pdf-tools", "user"],
        ["review", "agents-user"],
      ],
    );
    new pi.ProjectTrustStore(agentDir).set(project, true);
    const result = await run(["ls", "--json"], { cwd: project, agentDir, readSkills });
    assert.equal(result.code, 0, result.err);
    const listed = JSON.parse(result.out);
    assert.deepEqual(
      listed.skills.map((skill) => [skill.name, skill.source]),
      [
        ["pdf-tools", "user"],
        ["release-notes", "project"],
        ["review", "agents-user"],
        ["triage", "agents-project"],
      ],
    );
    const pdf = path.join(agentDir, "skills", "pdf-tools");
    assert.deepEqual(listed.skills[0], {
      name: "pdf-tools",
      description: "Extract text and tables from PDF files. Use when reading, converting or inspecting PDFs of any size.",
      baseDir: pdf,
      path: path.join(pdf, "SKILL.md"),
      source: "user",
    });
    const copy = path.join(home, ".agents", "skills", "pdf-copy", "SKILL.md");
    assert.deepEqual(
      listed.errors.sort((a, b) => a.path.localeCompare(b.path)),
      [
        { path: path.join(project, ".agents", "skills", "no-description", "SKILL.md"), message: "description is required" },
        { path: copy, message: `another skill named "pdf-tools" is loaded from ${path.join(pdf, "SKILL.md")}` },
      ].sort((a, b) => a.path.localeCompare(b.path)),
    );
  });

  it("prints a count line and each skill's name, source, description cut to the width and directory", async () => {
    const result = await run(["list"], { cwd: project, agentDir, readSkills, columns: 60 });
    const lines = result.out.split("\n");
    assert.equal(lines[0], "4 skills");
    assert.deepEqual(lines.slice(1, 5), ["", "  pdf-tools (user)", "    Extract text and tables from PDF files. Use when readin…", `    ${path.join(agentDir, "skills", "pdf-tools")}`]);
    assert.ok(lines.every((line) => line.length <= 60 || line.startsWith(`    ${dir}`)), result.out);
    assert.match(result.err, /no-description\/SKILL\.md: description is required/);
    const none = await run(["list"], { cwd: project, agentDir, skills: [] });
    assert.equal(none.out, "0 skills\n\nInstall one with ampi skill add <source>.\n");
  });

  it("shows one skill's source, files and other frontmatter, listing at most 50 files", async () => {
    const triage = path.join(project, ".agents", "skills", "triage");
    write(
      path.join(triage, "SKILL.md"),
      skillFile("name: triage", "description: Sort incoming issues.", "license: MIT", "disable-model-invocation: true", "metadata:", "  team: support"),
    );
    for (let index = 0; index < 60; index++) write(path.join(triage, "references", `note-${String(index).padStart(2, "0")}.md`), "x\n");
    const text = await run(["info", "triage"], { cwd: project, agentDir, readSkills });
    assert.equal(text.code, 0, text.err);
    const lines = text.out.split("\n");
    assert.deepEqual(lines.slice(0, 11), [
      "triage",
      "",
      "Sort incoming issues.",
      "",
      "Source:           agents-project",
      `Directory:        ${triage}`,
      `File:             ${path.join(triage, "SKILL.md")}`,
      "Model invocation: disabled (only /skill:triage loads it)",
      "license:          MIT",
      'metadata:         {"team":"support"}',
      "",
    ]);
    assert.equal(lines[11], "61 files:");
    assert.equal(lines[12], "  SKILL.md");
    assert.equal(lines.filter((line) => line.startsWith("  references/")).length, INFO_FILE_LIMIT - 1);
    assert.equal(lines.at(-2), "  … and 11 more");

    const json = JSON.parse((await run(["info", "triage", "--json"], { cwd: project, agentDir, readSkills })).out);
    assert.deepEqual(
      { ...json, files: json.files.length },
      {
        name: "triage",
        description: "Sort incoming issues.",
        source: "agents-project",
        baseDir: triage,
        path: path.join(triage, "SKILL.md"),
        disableModelInvocation: true,
        frontmatter: { license: "MIT", metadata: { team: "support" } },
        files: INFO_FILE_LIMIT,
        moreFiles: 11,
      },
    );
    const unknown = await run(["info", "nothing"], { cwd: project, agentDir, readSkills });
    assert.equal(unknown.code, 1);
    assert.match(unknown.err, /no skill named "nothing" loads in this directory/);
  });
});
