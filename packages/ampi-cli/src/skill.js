// `ampi skill list|info|add|remove`: the skills Pi loads in a directory, one
// skill's details, installing skills from a local directory or a git
// repository, and removing an installed one. The listing comes from a session
// started in memory (sdk-session.js), so it holds what an `ampi` session
// loads: Pi's directories, settings and packages, and the folders extensions
// add, under Pi's project-trust decision. Installing copies files only: it
// never runs anything from the source.
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { checkPiSkillDir, isPiProjectTrusted, parsePiFrontmatter, readPiSessionSkills } from "./pi-compat.js";
import { createAmpiSdkSession } from "./sdk-session.js";
import { classifySkillSource, skillSourceLabel } from "./skill-sources.js";
import { cut } from "./threads.js";

/**
 * @typedef {import("./pi-compat.js").PiSkill} PiSkill
 * @typedef {import("./pi-compat.js").PiSkillProblem} PiSkillProblem
 *
 * @typedef {object} LoadedSkills What a session in the directory loads.
 * @property {PiSkill[]} skills
 * @property {PiSkillProblem[]} problems Skill files Pi skipped or loaded with warnings.
 * @property {string[]} failures Extensions that failed to load (their skill folders are missing).
 *
 * @typedef {{ status: number | null, stderr: string, error?: NodeJS.ErrnoException }} GitResult
 *
 * @typedef {object} SkillHost
 * @property {any} pi The `@earendil-works/pi-coding-agent` module.
 * @property {string} cwd
 * @property {string} agentDir Pi's configuration directory.
 * @property {() => Promise<LoadedSkills>} readSkills The skills a session in `cwd` loads.
 * @property {(args: string[]) => GitResult} git Runs git with the arguments, without a terminal prompt.
 * @property {string} tempRoot Where git sources are cloned; each clone is removed afterwards.
 * @property {number} columns Width the listing cuts descriptions to.
 * @property {boolean} interactive Whether a question can be answered (stdin is a terminal).
 * @property {(question: string) => Promise<boolean>} confirm Asks a yes/no question; true for yes.
 * @property {(text: string) => void} out Writes to stdout.
 * @property {(text: string) => void} progress Writes a progress line, such as `Cloning <url>…`, to stderr at every log level.
 * @property {import("./log.js").Logger} log For the command's diagnostics.
 *
 * @typedef {{ kind: "local", path: string } | { kind: "git", url: string, subpath: string } | { kind: "error", error: string }} SkillSourceSpec
 *
 * @typedef {{ code: number, message?: string }} Outcome
 */

const USAGE_HINT = "Run ampi skill --help for the options.";

/** @type {Record<string, string>} */
export const ALIASES = { ls: "list", rm: "remove" };

export const OPTIONS = /** @type {const} */ ({
  json: { type: "boolean" },
  global: { type: "boolean" },
  target: { type: "string" },
  overwrite: { type: "boolean" },
  name: { type: "string" },
  yes: { type: "boolean", short: "y" },
  help: { type: "boolean", short: "h" },
});

/** @type {Record<string, { args: number, options: string[] }>} */
export const COMMANDS = {
  list: { args: 0, options: ["json"] },
  info: { args: 1, options: ["json"] },
  add: { args: 1, options: ["global", "target", "overwrite", "name"] },
  remove: { args: 1, options: ["global", "target", "yes"] },
};

/** How many files `skill info` lists before it only counts the rest. */
export const INFO_FILE_LIMIT = 50;

/** C0 and C1 control characters: descriptions are printed to a terminal, so none may start an escape sequence. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * The text `ampi skill --help` prints.
 *
 * @returns {string}
 */
export function formatSkillHelp() {
  return `ampi skill: list, inspect, install and remove the skills Pi loads

Usage: ampi skill list [--json]
       ampi skill info <name> [--json]
       ampi skill add <source> [--global | --target <dir>] [--overwrite] [--name <name>]
       ampi skill remove <name> [--global | --target <dir>] [--yes]

Commands:

  list, ls                      Print the skills a session in this directory loads, with their
                                source, description and directory, and the problems Pi found
  info <name>                   Print one skill's source, directory, frontmatter and files
  add <source>                  Copy the skills of a source into a skills directory. A source is
                                a local directory, a git URL (https://, ssh://, file:// or
                                user@host:path) or owner/repo[/path] for a GitHub repository.
                                Add //<path> to a git URL to take the skills below that path.
  remove, rm <name>             Delete an installed skill's directory, after asking

Options:

  --json                        list: { skills: [{ name, description, baseDir, path, source }],
                                errors: [{ path, message }] }; info: one skill with its frontmatter
                                and files
  --global                      add and remove: Pi's user skills directory (<agent dir>/skills)
                                instead of this project's .agents/skills
  --target <dir>                add and remove: this skills directory instead
  --overwrite                   add: replace an installed skill of the same name
  --name <name>                 add: install the source's only skill under another name
  -y, --yes                     remove: delete without asking

Sources: a directory with SKILL.md is one skill; otherwise each directory directly in it or in its
skills/ directory that holds SKILL.md is one. Every skill needs a name and a description in its
frontmatter, within Pi's rules; a source with an invalid skill installs nothing. Git sources are
cloned (depth 1) into a temporary directory that is removed afterwards; .git is not copied, and
nothing from the source is run.

Sources (the list's source column): user and project for Pi's skills directories, agents-user and
agents-project for ~/.agents/skills and a project's .agents/skills, claude-user and claude-project
for Claude Code's skills folders, package:<source> for a Pi package, settings for a path in the
skills setting or ampi.skills.path, temporary for a --skill argument.

Exit status: 0 on success, 1 when a skill is unknown, a source is invalid or a change is refused or
declined, 2 on a usage error.

Examples:

  $ ampi skill list
  $ ampi skill info pdf-tools --json
  $ ampi skill add ./my-skills
  $ ampi skill add acme/skills/pdf-tools --global
  $ ampi skill add https://example.com/team/skills.git//review --name team-review
  $ ampi skill remove pdf-tools --yes
`;
}

/**
 * Run `ampi skill …`.
 *
 * @param {readonly string[]} argv The command line after `skill`.
 * @param {SkillHost} host
 * @returns {Promise<number>} The exit code.
 */
export async function runSkillCommand(argv, host) {
  const outcome = await dispatch(argv, host);
  if (outcome.message !== undefined) host.log.error(outcome.code === 2 ? `${clean(outcome.message)}\n${USAGE_HINT}` : clean(outcome.message));
  return outcome.code;
}

/**
 * @param {string} message
 * @returns {Outcome}
 */
const usage = (message) => ({ code: 2, message });

/**
 * @param {string} message
 * @returns {Outcome}
 */
const fail = (message) => ({ code: 1, message });

/**
 * Whether `name` could leave the directory it is joined to: empty, `.`, `..`
 * or holding a path separator. Pi's own name rules are checked later.
 *
 * @param {string} name
 */
const isPathLike = (name) => name === "" || name === "." || name === ".." || /[\\/]/.test(name);

/** @param {unknown} error */
const messageOf = (error) => (error instanceof Error ? error.message : String(error));

/**
 * @param {readonly string[]} argv
 * @param {SkillHost} host
 * @returns {Promise<Outcome>}
 */
async function dispatch(argv, host) {
  /** @type {{ values: Record<string, string | boolean | undefined>, positionals: string[] }} */
  let parsed;
  try {
    parsed = /** @type {any} */ (parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true }));
  } catch (error) {
    return usage(`skill: ${messageOf(error)}`);
  }
  const { values, positionals } = parsed;
  const [given, ...rest] = positionals;
  if (values.help || given === "help") {
    host.out(formatSkillHelp());
    return { code: 0 };
  }
  if (given === undefined) return usage("skill needs a command: list, info, add or remove.");
  const command = ALIASES[given] ?? given;
  const spec = COMMANDS[command];
  if (spec === undefined) return usage(`unknown skill command "${given}".`);
  const misplaced = Object.keys(values).find((option) => option !== "help" && !spec.options.includes(option));
  if (misplaced !== undefined) return usage(`--${misplaced} does not apply to skill ${command}.`);
  if (rest.length !== spec.args) {
    const wanted = { info: "a skill name", add: "a source", remove: "a skill name" }[command];
    return usage(spec.args === 0 ? `skill ${command} takes no arguments.` : `skill ${command} needs exactly one argument: ${wanted}.`);
  }
  if (values.global && values.target !== undefined) return usage(`skill ${command} takes --global or --target, not both.`);
  if (typeof values.name === "string" && isPathLike(values.name)) return usage(`--name "${values.name}" is not a skill name.`);
  switch (command) {
    case "list":
      return list(host, values.json === true);
    case "info":
      return info(host, rest[0], values.json === true);
    case "add":
      return add(host, rest[0], {
        global: values.global === true,
        target: /** @type {string | undefined} */ (values.target),
        overwrite: values.overwrite === true,
        name: /** @type {string | undefined} */ (values.name),
      });
    default:
      return remove(host, rest[0], { global: values.global === true, target: /** @type {string | undefined} */ (values.target), yes: values.yes === true });
  }
}

/**
 * Start a session in memory in `cwd` and read the skills it loaded. The
 * session ends before this returns; it writes no session file, calls no model
 * and connects no MCP server.
 *
 * @param {any} pi The `@earendil-works/pi-coding-agent` module.
 * @param {string} cwd
 * @returns {Promise<LoadedSkills>}
 */
export async function readSessionSkills(pi, cwd) {
  const runtime = await createAmpiSdkSession({ cwd, sessionManager: pi.SessionManager.inMemory(cwd), mode: "print", connectMcp: false, pi });
  try {
    /** @type {{ type: string, message: string }[]} */
    const diagnostics = runtime.diagnostics ?? [];
    return { ...readPiSessionSkills(runtime.session), failures: diagnostics.filter((entry) => entry.type === "error").map((entry) => entry.message) };
  } finally {
    await runtime.dispose();
  }
}

/**
 * @param {SkillHost} host
 * @returns {Promise<LoadedSkills>}
 */
async function loadSkills(host) {
  const loaded = await host.readSkills();
  for (const failure of loaded.failures) host.log.warn(clean(failure));
  return loaded;
}

/** @param {string} text */
const clean = (text) => text.replace(CONTROL, "");

/**
 * @param {PiSkill} skill
 * @returns {string}
 */
const sourceOf = (skill) => skillSourceLabel(classifySkillSource(skill.sourceInfo, skill.filePath));

/**
 * @param {PiSkill[]} skills
 * @returns {PiSkill[]}
 */
const byName = (skills) => [...skills].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/**
 * @param {SkillHost} host
 * @param {boolean} json
 * @returns {Promise<Outcome>}
 */
async function list(host, json) {
  const { skills, problems } = await loadSkills(host);
  const sorted = byName(skills);
  if (json) {
    const rows = sorted.map((skill) => ({ name: skill.name, description: skill.description, baseDir: skill.baseDir, path: skill.filePath, source: sourceOf(skill) }));
    host.out(`${JSON.stringify({ skills: rows, errors: problems }, null, 2)}\n`);
    return { code: 0 };
  }
  const lines = [sorted.length === 1 ? "1 skill" : `${sorted.length} skills`];
  for (const skill of sorted) {
    const description = clean(skill.description).replace(/\s+/g, " ").trim();
    lines.push("", `  ${clean(skill.name)} (${sourceOf(skill)})`);
    if (description !== "") lines.push(Number.isFinite(host.columns) ? cut(`    ${description}`, Math.max(host.columns, 20)) : `    ${description}`);
    lines.push(`    ${clean(skill.baseDir)}`);
  }
  if (sorted.length === 0) lines.push("", "Install one with ampi skill add <source>.");
  host.out(`${lines.join("\n")}\n`);
  for (const problem of problems) host.log.warn(clean(`${problem.path ? `${problem.path}: ` : ""}${problem.message}`));
  return { code: 0 };
}

/**
 * Every file below `dir` as a path relative to it with `/` separators, in
 * alphabetical order. `.git` is skipped, and links are listed, not followed.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function listSkillFiles(dir) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} relative */
  const walk = (relative) => {
    for (const entry of readdirSync(path.join(dir, relative), { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else files.push(child);
    }
  };
  walk("");
  return files.sort();
}

/**
 * Whether Pi loaded the skill from a `.md` file directly in a skills
 * directory rather than from a directory's `SKILL.md`; its `baseDir` is then
 * the whole skills directory.
 *
 * @param {PiSkill} skill
 */
const isSingleFile = (skill) => path.basename(skill.filePath) !== "SKILL.md";

/**
 * @param {SkillHost} host
 * @param {string} name
 * @param {boolean} json
 * @returns {Promise<Outcome>}
 */
async function info(host, name, json) {
  const { skills } = await loadSkills(host);
  const skill = skills.find((candidate) => candidate.name === name);
  if (skill === undefined) return fail(`no skill named "${name}" loads in this directory; ampi skill list shows the skills.`);
  /** @type {Record<string, unknown>} */
  let frontmatter = {};
  try {
    frontmatter = parsePiFrontmatter(host.pi, readFileSync(skill.filePath, "utf8"));
  } catch {
    // Pi loaded it, so it parsed a moment ago; show the rest without the extra fields.
  }
  const fields = Object.fromEntries(Object.entries(frontmatter).filter(([key]) => !["name", "description", "disable-model-invocation"].includes(key)));
  const all = isSingleFile(skill) ? [path.relative(skill.baseDir, skill.filePath)] : listSkillFiles(skill.baseDir);
  const files = all.slice(0, INFO_FILE_LIMIT);
  const moreFiles = all.length - files.length;
  const source = sourceOf(skill);
  if (json) {
    const record = {
      name: skill.name,
      description: skill.description,
      source,
      baseDir: skill.baseDir,
      path: skill.filePath,
      disableModelInvocation: skill.disableModelInvocation,
      frontmatter: fields,
      files,
      moreFiles,
    };
    host.out(`${JSON.stringify(record, null, 2)}\n`);
    return { code: 0 };
  }
  const value = (/** @type {unknown} */ field) => clean(typeof field === "string" ? field : JSON.stringify(field));
  const rows = [
    ["Source", source],
    ["Directory", clean(skill.baseDir)],
    ["File", clean(skill.filePath)],
    ["Model invocation", skill.disableModelInvocation ? `disabled (only /skill:${skill.name} loads it)` : "allowed"],
    ...Object.entries(fields).map(([key, field]) => [clean(key), value(field)]),
  ];
  const width = Math.max(...rows.map(([label]) => label.length)) + 2;
  const lines = [clean(skill.name), "", clean(skill.description).trim(), "", ...rows.map(([label, text]) => `${`${label}:`.padEnd(width)}${text}`)];
  lines.push("", all.length === 1 ? "1 file:" : `${all.length} files:`, ...files.map((file) => `  ${clean(file)}`));
  if (moreFiles > 0) lines.push(`  … and ${moreFiles} more`);
  host.out(`${lines.join("\n")}\n`);
  return { code: 0 };
}

/**
 * Read an `ampi skill add` source: a git URL (`https://`, `ssh://`,
 * `file://` or `user@host:path`, with an optional `//<subpath>` after the
 * repository), `owner/repo[/subpath]` for a GitHub repository, or a local
 * path. A path that starts with `.`, `/` or `~`, or that exists, is local
 * even when it looks like `owner/repo`.
 *
 * @param {string} source
 * @param {(candidate: string) => boolean} exists Whether a path (relative to the working directory) exists.
 * @returns {SkillSourceSpec}
 */
export function parseSkillSource(source, exists) {
  const scheme = /^(https|ssh|file):\/\//i.exec(source);
  const scp = scheme === null ? /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(?!\/\/)/.exec(source) : null;
  if (scheme !== null || scp !== null) {
    const start = scheme === null ? 0 : scheme[0].length + 1;
    const split = source.indexOf("//", start);
    const url = split === -1 ? source : source.slice(0, split);
    const subpath = split === -1 ? "" : source.slice(split + 2).replace(/\/+$/, "");
    let host = scp?.[1];
    if (scheme !== null) {
      try {
        host = new URL(url).hostname;
      } catch {
        return { kind: "error", error: `"${source}" is not a valid git URL.` };
      }
    }
    if (host?.startsWith("-")) return { kind: "error", error: `"${source}" names a host that starts with "-".` };
    const problem = subpathProblem(subpath);
    return problem ? { kind: "error", error: problem } : { kind: "git", url, subpath };
  }
  const local = source.startsWith(".") || source.startsWith("/") || source.startsWith("~") || path.isAbsolute(source) || exists(source);
  const shorthand = local ? null : /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:\/(.+))?$/.exec(source);
  if (shorthand !== null && shorthand[2] !== "." && shorthand[2] !== "..") {
    const subpath = (shorthand[3] ?? "").replace(/\/+$/, "");
    const problem = subpathProblem(subpath);
    if (problem) return { kind: "error", error: problem };
    return { kind: "git", url: `https://github.com/${shorthand[1]}/${shorthand[2]}.git`, subpath };
  }
  return { kind: "local", path: source };
}

/**
 * @param {string} subpath
 * @returns {string | undefined}
 */
function subpathProblem(subpath) {
  if (subpath === "") return undefined;
  if (subpath.startsWith("/") || subpath.split("/").some((part) => part === ".." || part === "")) {
    return `the path inside the repository, "${subpath}", must be relative and stay inside it.`;
  }
  return undefined;
}

/**
 * @param {string} file
 * @returns {import("node:fs").Stats | undefined}
 */
function lstatOrUndefined(file) {
  try {
    return lstatSync(file);
  } catch {
    return undefined;
  }
}

/** @param {string} file */
const isFile = (file) => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

/** @param {string} dir */
const isDirectory = (dir) => {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

/**
 * A directory, or a link to one, that holds `SKILL.md`.
 *
 * @param {string} dir
 */
const isSkillDirectory = (dir) => isDirectory(dir) && isFile(path.join(dir, "SKILL.md"));

/**
 * The skill directories of a source root: the root itself when it holds
 * `SKILL.md`, else each directory directly in it or in its `skills/`
 * directory that does. Links to directories are followed to where they point.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function findSourceSkills(root) {
  if (isFile(path.join(root, "SKILL.md"))) return [root];
  /** @type {Set<string>} */
  const found = new Set();
  for (const base of [root, path.join(root, "skills")]) {
    /** @type {string[]} */
    let names = [];
    try {
      names = readdirSync(base);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const dir = path.join(base, name);
      try {
        if (statSync(dir).isDirectory() && isFile(path.join(dir, "SKILL.md"))) found.add(realpathSync(dir));
      } catch {
        // A broken link: not a skill.
      }
    }
  }
  return [...found];
}

/**
 * The first link below `dir` that points outside it, as a path relative to
 * `dir`; such a link would dangle, or reach other files, once copied.
 *
 * @param {string} dir
 * @returns {string | undefined}
 */
function linkOutside(dir) {
  for (const file of listSkillFiles(dir)) {
    const full = path.join(dir, file);
    if (!lstatSync(full).isSymbolicLink()) continue;
    const link = readlinkSync(full);
    // An absolute link names the source's own location, which a copy leaves behind.
    if (path.isAbsolute(link) || !isInside(path.resolve(path.dirname(full), link), dir)) return file;
  }
  return undefined;
}

/**
 * Why a skill directory cannot be installed: its frontmatter, checked with
 * Pi's own loader (a name and a description, within Pi's rules), and links
 * that leave it. Empty when it is fine.
 *
 * @param {any} pi
 * @param {string} dir
 * @returns {{ name: string | undefined, problems: string[] }}
 */
export function checkSkill(pi, dir) {
  /** @type {Record<string, unknown>} */
  let frontmatter;
  try {
    frontmatter = parsePiFrontmatter(pi, readFileSync(path.join(dir, "SKILL.md"), "utf8"));
  } catch (error) {
    return { name: undefined, problems: [`its frontmatter does not parse: ${messageOf(error)}`] };
  }
  const name = typeof frontmatter.name === "string" && frontmatter.name.trim() !== "" ? frontmatter.name : undefined;
  const checked = checkPiSkillDir(pi, dir);
  const problems = [...(name === undefined ? ["its frontmatter has no name"] : []), ...checked.problems];
  if (problems.length === 0 && checked.name === undefined) problems.push("Pi does not load it");
  const link = linkOutside(dir);
  if (link !== undefined) problems.push(`${link} links to a file outside the skill`);
  return { name, problems };
}

/**
 * `text` (a `SKILL.md`) with the frontmatter's `name:` line set to `name`,
 * or undefined when it has no such line.
 *
 * @param {string} text
 * @param {string} name
 * @returns {string | undefined}
 */
function renameFrontmatter(text, name) {
  const match = /^(﻿?---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(text);
  if (match === null) return undefined;
  const lines = match[2].split("\n");
  const index = lines.findIndex((line) => /^name\s*:/.test(line));
  if (index === -1) return undefined;
  lines[index] = `name: ${name}${lines[index].endsWith("\r") ? "\r" : ""}`;
  return match[1] + lines.join("\n") + match[3] + text.slice(match[0].length);
}

/**
 * @param {string} target
 * @param {string} cwd
 */
const isInside = (target, cwd) => {
  const relative = path.relative(cwd, target);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
};

/**
 * `file` with the links in the part of it that exists resolved; the rest,
 * which does not exist yet, is appended as it is.
 *
 * @param {string} file An absolute path.
 * @returns {string}
 */
function resolveExisting(file) {
  /** @type {string[]} */
  const missing = [];
  let current = file;
  while (!existsSync(current) && path.dirname(current) !== current) {
    missing.unshift(path.basename(current));
    current = path.dirname(current);
  }
  return path.join(realpathSync(current), ...missing);
}

/**
 * @param {SkillHost} host
 * @param {{ global: boolean, target?: string }} options
 * @returns {string}
 */
const targetOf = (host, { global, target }) =>
  target !== undefined ? path.resolve(host.cwd, target) : global ? path.join(host.agentDir, "skills") : path.join(host.cwd, ".agents", "skills");

/**
 * @param {SkillHost} host
 * @param {string} source
 * @param {{ global: boolean, target?: string, overwrite: boolean, name?: string }} options
 * @returns {Promise<Outcome>}
 */
async function add(host, source, options) {
  const spec = parseSkillSource(source, (candidate) => existsSync(path.resolve(host.cwd, candidate)));
  if (spec.kind === "error") return usage(spec.error);
  if (spec.kind === "local") {
    const home = spec.path === "~" || spec.path.startsWith("~/");
    const root = path.resolve(host.cwd, home ? path.join(homedir(), spec.path.slice(1)) : spec.path);
    if (!isDirectory(root)) return fail(`${root} is not a directory.`);
    return install(host, realpathSync(root), source, options);
  }
  mkdirSync(host.tempRoot, { recursive: true });
  const temp = mkdtempSync(path.join(host.tempRoot, "ampi-skill-"));
  try {
    const clone = path.join(temp, "repo");
    host.progress(`Cloning ${spec.url}…\n`);
    const result = host.git(["clone", "--depth", "1", "--quiet", "--no-tags", "--", spec.url, clone]);
    if (result.error?.code === "ENOENT") return fail("git is not installed, and a git source needs it.");
    if (result.error !== undefined || result.status !== 0) {
      const detail = (result.stderr || result.error?.message || "").trim();
      return fail(`could not clone ${spec.url}${detail ? `: ${detail}` : "."}`);
    }
    const root = path.join(clone, spec.subpath);
    if (!isDirectory(root)) return fail(`${spec.subpath || "the repository"} is not a directory in ${spec.url}.`);
    const realClone = realpathSync(clone);
    const realRoot = realpathSync(root);
    if (!isInside(realRoot, realClone)) return fail(`${spec.subpath} leaves the repository ${spec.url}.`);
    return install(host, realRoot, source, options, realClone);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/**
 * Check every skill of a source, then copy them all, or none.
 *
 * @param {SkillHost} host
 * @param {string} root The source directory, links resolved.
 * @param {string} source As the user gave it.
 * @param {{ global: boolean, target?: string, overwrite: boolean, name?: string }} options
 * @param {string} [boundary] A clone's directory, which every skill must stay inside.
 * @returns {Outcome}
 */
function install(host, root, source, options, boundary) {
  const dirs = findSourceSkills(root);
  if (dirs.length === 0) {
    return fail(`${source} holds no skill: a skill is a directory with a SKILL.md, directly in the source or in its skills/ directory.`);
  }
  if (options.name !== undefined && dirs.length !== 1) return usage(`--name needs a source with one skill; ${source} has ${dirs.length}.`);
  /** @type {{ dir: string, name: string }[]} */
  const skills = [];
  /** @type {string[]} */
  const refusals = [];
  for (const dir of dirs) {
    const label = path.relative(root, dir) || path.basename(dir);
    if (boundary !== undefined && !isInside(dir, boundary)) {
      refusals.push(`${label}: it leaves the repository`);
      continue;
    }
    const checked = checkSkill(host.pi, dir);
    if (checked.problems.length > 0 || checked.name === undefined) refusals.push(`${label}: ${checked.problems.join("; ")}`);
    else skills.push({ dir, name: options.name ?? checked.name });
  }
  if (refusals.length > 0) return fail(`nothing installed; these skills are invalid:\n${refusals.map((line) => `  ${line}`).join("\n")}`);
  const names = skills.map((skill) => skill.name);
  const twice = names.find((name, index) => names.indexOf(name) !== index);
  if (twice !== undefined) return fail(`nothing installed; ${source} has two skills named "${twice}".`);

  const target = targetOf(host, options);
  const realTarget = resolveExisting(target);
  const enclosing = skills.find((skill) => isInside(realTarget, skill.dir));
  if (enclosing !== undefined) {
    return fail(`nothing installed; ${target} is inside the skill ${enclosing.dir}, which cannot be copied into itself. Choose another directory with --global or --target.`);
  }
  for (const skill of skills) {
    const destination = path.join(target, skill.name);
    const existing = lstatOrUndefined(destination);
    if (existing === undefined) continue;
    if (!options.overwrite) return fail(`nothing installed; ${destination} already exists. Pass --overwrite to replace it.`);
    if (!isSkillDirectory(destination)) return fail(`nothing installed; ${destination} exists and is not a skill directory, so it is not replaced.`);
    const real = realpathSync(destination);
    if (isInside(skill.dir, real) || isInside(real, skill.dir)) return fail(`nothing installed; ${destination} is the source itself.`);
  }

  mkdirSync(target, { recursive: true });
  const stage = mkdtempSync(path.join(target, ".ampi-skill-add-"));
  try {
    for (const skill of skills) {
      const staged = path.join(stage, skill.name);
      cpSync(skill.dir, staged, { recursive: true, verbatimSymlinks: true, filter: (from) => path.basename(from) !== ".git" });
      if (options.name === undefined) continue;
      const file = path.join(staged, "SKILL.md");
      const renamed = renameFrontmatter(readFileSync(file, "utf8"), options.name);
      if (renamed === undefined) return fail(`nothing installed; the name in ${source}'s SKILL.md is not on a line of its own, so --name cannot change it.`);
      writeFileSync(file, renamed);
      const checked = checkSkill(host.pi, staged);
      if (checked.problems.length > 0 || checked.name !== options.name) {
        return fail(`nothing installed; the name "${options.name}" is invalid: ${checked.problems.join("; ") || "Pi reads another name"}.`);
      }
    }
    for (const skill of skills) {
      const destination = path.join(target, skill.name);
      rmSync(destination, { recursive: true, force: true });
      renameSync(path.join(stage, skill.name), destination);
      host.out(`Installed ${skill.name} in ${destination}\n`);
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  host.out(`Running sessions load ${skills.length === 1 ? "it" : "them"} after /reload.\n`);
  // The project's skill locations Pi reads once it trusts the project.
  const projectTargets = [path.join(host.cwd, ".agents", "skills"), path.join(host.cwd, ".pi", "skills")];
  if (projectTargets.includes(target) && !isPiProjectTrusted(host.pi, host.cwd)) {
    host.out("This project is not trusted yet: Pi loads its skills once you trust it (Pi asks when it starts here).\n");
  }
  return { code: 0 };
}

/**
 * Where a loaded skill comes from and how to remove it there, for a skill
 * `remove` does not find in the directories it looks in.
 *
 * @param {PiSkill} skill
 * @returns {string}
 */
export function removalAdvice(skill) {
  const source = classifySkillSource(skill.sourceInfo, skill.filePath);
  const label = skillSourceLabel(source);
  const parent = path.dirname(skill.baseDir);
  switch (source.group) {
    case "package":
      return `"${skill.name}" comes from the Pi package ${source.packageName} (${skill.baseDir}). Remove the package with ampi remove ${source.packageName} (add -l for a project package), or leave the skill out with a package filter in Pi's settings.`;
    case "settings":
      return `"${skill.name}" loads from ${skill.baseDir}, through Pi's skills setting or ampi.skills.path. Remove that entry from the settings (ampi config edit), or delete the directory yourself.`;
    case "temporary":
      return `"${skill.name}" is loaded for this run only (${skill.baseDir}), from a --skill argument; there is nothing installed to remove.`;
    default: {
      if (isSingleFile(skill)) return `"${skill.name}" is the single-file skill ${skill.filePath} (${label}). Delete that file to remove it.`;
      const dirName = path.basename(skill.baseDir);
      if (dirName !== skill.name) {
        return `"${skill.name}" is in the directory ${skill.baseDir} (${label}), whose name differs from the skill's. Remove it with ampi skill remove ${dirName} --target ${parent}.`;
      }
      return `"${skill.name}" is in ${parent} (${label}). Remove it there with ampi skill remove ${skill.name} --target ${parent}.`;
    }
  }
}

/**
 * @param {SkillHost} host
 * @param {string} name
 * @param {{ global: boolean, target?: string, yes: boolean }} options
 * @returns {Promise<Outcome>}
 */
async function remove(host, name, options) {
  if (isPathLike(name)) return usage(`"${name}" is not a skill name.`);
  const targets =
    options.target !== undefined || options.global
      ? [targetOf(host, options)]
      : [targetOf(host, { global: false }), targetOf(host, { global: true })];
  const found = targets.map((target) => path.join(target, name)).find((dir) => lstatOrUndefined(dir) !== undefined);
  if (found !== undefined && !isSkillDirectory(found)) return fail(`${found} is not a skill directory (a directory with a SKILL.md), so it is not removed.`);
  if (found === undefined) {
    const { skills } = await loadSkills(host);
    const loaded = skills.find((skill) => skill.name === name);
    const where = targets.join(" or ");
    if (loaded === undefined) return fail(`no skill named "${name}" in ${where}, and none loads in this directory.`);
    return fail(`no skill named "${name}" in ${where}. ${removalAdvice(loaded)}`);
  }
  if (!options.yes) {
    if (!host.interactive) return fail(`remove asks before it deletes ${found}, and there is no terminal to ask in; pass --yes to delete it.`);
    if (!(await host.confirm(`Delete the skill ${name} in ${found}? [y/N] `))) return fail("nothing removed.");
  }
  rmSync(found, { recursive: true, force: true });
  host.out(`Removed ${name} from ${path.dirname(found)}\nRunning sessions drop it after /reload.\n`);
  return { code: 0 };
}
