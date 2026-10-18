// Skill folders ampi-core adds through Pi's resources_discover event:
// Claude Code's .claude/skills folders and `ampi.skills.path`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

function writeSkill(directory, name, description) {
  mkdirSync(path.join(directory, name), { recursive: true });
  writeFileSync(path.join(directory, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nInstructions.\n`);
}

/**
 * A temporary layout:
 *
 *   outer/.claude/skills          above the repository: never read
 *   outer/repo/.git               the repository root
 *   outer/repo/.claude/skills
 *   outer/repo/app/.claude/skills the working directory's own folder
 *   home/.claude/skills
 *
 * `cwd` is outer/repo/app/src, which has no folder of its own.
 */
function makeLayout(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ampi-skill-paths-"));
  const home = path.join(dir, "home");
  const outer = path.join(dir, "outer");
  const repo = path.join(outer, "repo");
  const app = path.join(repo, "app");
  const cwd = path.join(app, "src");
  for (const directory of [
    path.join(outer, ".claude/skills"),
    path.join(repo, ".git"),
    path.join(repo, ".claude/skills"),
    path.join(app, ".claude/skills"),
    path.join(home, ".claude/skills"),
    cwd,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, home, outer, repo, app, cwd };
}

/** Cases about working outside a repository need a temporary directory that is not inside one. */
async function skipInsideRepository(t, dir) {
  const { findMmrRepositoryRoot } = await importSource("extensions/ampi-core/skill-paths.ts");
  const root = findMmrRepositoryRoot(dir);
  if (root !== undefined) t.skip(`the temporary directory is inside the repository at ${root}`);
  return root !== undefined;
}

async function resolve(input) {
  const { resolveMmrSkillPaths } = await importSource("extensions/ampi-core/skill-paths.ts");
  return resolveMmrSkillPaths(input);
}

describe("ampi-core skill paths", () => {
  it("lists project folders up to the repository root, nearest first, then the user folder", async (t) => {
    const { home, repo, app, cwd } = makeLayout(t);
    assert.deepEqual(await resolve({ cwd, home, projectTrusted: true, settings: {} }), [
      path.join(app, ".claude/skills"),
      path.join(repo, ".claude/skills"),
      path.join(home, ".claude/skills"),
    ]);
  });

  it("reads only the working directory outside a repository", async (t) => {
    const { dir, home, repo, app } = makeLayout(t);
    rmSync(path.join(repo, ".git"), { recursive: true });
    if (await skipInsideRepository(t, dir)) return;
    assert.deepEqual(await resolve({ cwd: app, home, projectTrusted: true, settings: {} }), [
      path.join(app, ".claude/skills"),
      path.join(home, ".claude/skills"),
    ]);
    // A working directory without a folder of its own adds nothing from the project.
    assert.deepEqual(await resolve({ cwd: path.join(app, "src"), home, projectTrusted: true, settings: {} }), [
      path.join(home, ".claude/skills"),
    ]);
  });

  it("returns only folders that exist", async (t) => {
    const { home, repo, app, cwd } = makeLayout(t);
    rmSync(path.join(home, ".claude"), { recursive: true });
    rmSync(path.join(app, ".claude"), { recursive: true });
    assert.deepEqual(await resolve({ cwd, home, projectTrusted: true, settings: {} }), [path.join(repo, ".claude/skills")]);
  });

  it("leaves out project folders and the project's skills path without project trust", async (t) => {
    const { dir, home, cwd } = makeLayout(t);
    const userExtra = path.join(dir, "user-extra");
    const projectExtra = path.join(dir, "project-extra");
    mkdirSync(userExtra);
    mkdirSync(projectExtra);
    const settings = { skillsPath: { user: userExtra, project: projectExtra } };
    assert.deepEqual(await resolve({ cwd, home, projectTrusted: false, settings }), [path.join(home, ".claude/skills"), userExtra]);
    assert.deepEqual((await resolve({ cwd, home, projectTrusted: true, settings })).at(-1), projectExtra, "with trust the project value wins");
  });

  it("splits the skills path on ':', expands '~' and resolves relative entries against the repository root", async (t) => {
    const { dir, home, repo, app, cwd } = makeLayout(t);
    for (const directory of [path.join(home, "my-skills"), path.join(repo, "team-skills"), path.join(dir, "shared")]) {
      mkdirSync(directory, { recursive: true });
    }
    const skillsPath = ["~/my-skills", "", " team-skills ", path.join(dir, "shared"), "missing", "~/my-skills"].join(":");
    assert.deepEqual(await resolve({ cwd, home, projectTrusted: true, settings: { skillsPath: { user: skillsPath } } }), [
      path.join(app, ".claude/skills"),
      path.join(repo, ".claude/skills"),
      path.join(home, ".claude/skills"),
      path.join(home, "my-skills"),
      path.join(repo, "team-skills"),
      path.join(dir, "shared"),
    ]);
  });

  it("resolves relative entries against the working directory outside a repository, and '~' alone is home", async (t) => {
    const { dir, home, repo, app } = makeLayout(t);
    rmSync(path.join(repo, ".git"), { recursive: true });
    if (await skipInsideRepository(t, dir)) return;
    mkdirSync(path.join(app, "local-skills"));
    const settings = { skillsPath: { user: "local-skills:~" }, disableClaudeCodeSkills: true };
    assert.deepEqual(await resolve({ cwd: app, home, projectTrusted: true, settings }), [path.join(app, "local-skills"), home]);
  });

  it("leaves out both .claude folders with disableClaudeCodeSkills", async (t) => {
    const { dir, home, cwd } = makeLayout(t);
    const extra = path.join(dir, "extra");
    mkdirSync(extra);
    const settings = { disableClaudeCodeSkills: true, skillsPath: { user: extra } };
    assert.deepEqual(await resolve({ cwd, home, projectTrusted: true, settings }), [extra]);
  });

  it("lists a folder once when the repository root is the home directory", async (t) => {
    const { home } = makeLayout(t);
    mkdirSync(path.join(home, ".git"));
    const cwd = path.join(home, "work");
    mkdirSync(cwd);
    assert.deepEqual(await resolve({ cwd, home, projectTrusted: true, settings: { skillsPath: { user: "~/.claude/skills" } } }), [
      path.join(home, ".claude/skills"),
    ]);
  });

  it("gives a project skill precedence over a user skill of the same name in Pi", async (t) => {
    const { home, repo, cwd } = makeLayout(t);
    writeSkill(path.join(repo, ".claude/skills"), "review", "Project review steps.");
    writeSkill(path.join(home, ".claude/skills"), "review", "User review steps.");
    const skillPaths = await resolve({ cwd, home, projectTrusted: true, settings: {} });
    const { skills, diagnostics } = loadSkills({ cwd, agentDir: path.join(home, "agent"), skillPaths, includeDefaults: false });
    assert.deepEqual(skills.map((skill) => [skill.name, skill.description]), [["review", "Project review steps."]]);
    assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.type), ["collision"]);
  });
});

describe("ampi.skills settings", () => {
  it("keeps the skills path per settings file and warns about malformed values", async (t) => {
    const { home, cwd } = makeLayout(t);
    const { loadMmrCoreSettings } = await importSource("extensions/ampi-core/settings.ts");
    writeJson(path.join(home, ".pi/agent/settings.json"), { ampi: { skills: { path: "~/a", disableClaudeCodeSkills: "yes" } } });
    writeJson(path.join(cwd, ".pi/settings.json"), { ampi: { skills: { path: 3, disableClaudeCodeSkills: true } } });

    const { settings, warnings } = loadMmrCoreSettings(cwd, home);

    assert.deepEqual(settings.skillsPath, { user: "~/a" });
    assert.equal(settings.disableClaudeCodeSkills, true);
    assert.deepEqual(warnings, [
      `Ignoring ampi.skills.disableClaudeCodeSkills in ${path.join(home, ".pi/agent/settings.json")}: expected true or false.`,
      `Ignoring ampi.skills.path in ${path.join(cwd, ".pi/settings.json")}: expected a string of directories.`,
    ]);
  });
});

describe("ampi-core resources_discover handler", () => {
  async function discover(t, { projectTrusted = true, argv } = {}) {
    const layout = makeLayout(t);
    const userExtra = path.join(layout.dir, "user-extra");
    const projectExtra = path.join(layout.dir, "project-extra");
    mkdirSync(userExtra);
    mkdirSync(projectExtra);
    writeJson(path.join(layout.home, ".pi/agent/settings.json"), { ampi: { skills: { path: userExtra } } });
    writeJson(path.join(layout.cwd, ".pi/settings.json"), { ampi: { skills: { path: projectExtra } } });

    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const { pi, handlers } = createMockPi();
    const { ctx } = createMockExtensionContext({ cwd: layout.cwd, projectTrusted });
    extension(pi);
    const savedArgv = process.argv;
    if (argv) process.argv = ["node", "pi", ...argv];
    try {
      const result = await handlers.get("resources_discover")({ type: "resources_discover", cwd: layout.cwd, reason: "startup" }, ctx);
      return { ...layout, userExtra, projectExtra, result };
    } finally {
      process.argv = savedArgv;
    }
  }

  it("answers with the project, user and settings folders in order", async (t) => {
    const { home, repo, app, projectExtra, result } = await discover(t);
    assert.deepEqual(result, {
      skillPaths: [path.join(app, ".claude/skills"), path.join(repo, ".claude/skills"), path.join(home, ".claude/skills"), projectExtra],
    });
  });

  it("follows Pi's project trust", async (t) => {
    const { home, userExtra, result } = await discover(t, { projectTrusted: false });
    assert.deepEqual(result, { skillPaths: [path.join(home, ".claude/skills"), userExtra] });
  });

  it("adds nothing when Pi runs with --no-skills", async (t) => {
    assert.equal((await discover(t, { argv: ["--no-skills", "-p", "hi"] })).result, undefined);
  });
});
