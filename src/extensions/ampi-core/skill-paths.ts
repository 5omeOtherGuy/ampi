/**
 * Skill folders ampi adds to Pi's own: Claude Code's `.claude/skills` and the
 * directories in `ampi.skills.path`.
 *
 * ampi-core hands them to Pi through the `resources_discover` event. Pi puts
 * them after its own skill locations and keeps the first skill of each name,
 * so the order below is the precedence among them:
 *
 * 1. `.claude/skills` in the working directory and each parent up to the
 *    repository root (the nearest directory with `.git`), nearest first.
 *    Outside a repository only the working directory counts. These are
 *    project files, so they load only when Pi trusts the project.
 * 2. `~/.claude/skills`.
 * 3. The entries of `ampi.skills.path`, in order.
 *
 * `ampi.skills.disableClaudeCodeSkills: true` leaves out 1 and 2. Only
 * directories that exist are returned, each once.
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { MmrCoreSettings } from "./types.js";

export interface MmrSkillPathsInput {
  /** The working directory Pi discovers resources for. */
  cwd: string;
  /** Whether Pi trusts the project (`ctx.isProjectTrusted()`). */
  projectTrusted: boolean;
  settings: Pick<MmrCoreSettings, "skillsPath" | "disableClaudeCodeSkills">;
  /** Defaults to the user's home directory. */
  home?: string;
}

/** The nearest directory from `cwd` upward that holds `.git`, or `undefined` outside a repository. */
export function findMmrRepositoryRoot(cwd: string): string | undefined {
  let current = path.resolve(cwd);
  while (true) {
    if (existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function isDirectory(directory: string): boolean {
  try {
    return statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

/** `cwd` and its parents up to `root`, nearest first; only `cwd` without a root. */
function projectDirectories(cwd: string, root: string | undefined): string[] {
  const directories = [cwd];
  if (root === undefined) return directories;
  let current = cwd;
  while (current !== root) {
    current = path.dirname(current);
    directories.push(current);
  }
  return directories;
}

/**
 * Split `ampi.skills.path` into absolute directories: `:` separates entries
 * (`;` on Windows), a leading `~` is the home directory, and a relative entry
 * resolves against `base`.
 */
function splitSkillsPath(value: string, home: string, base: string): string[] {
  return value.split(path.delimiter).flatMap((raw) => {
    const entry = raw.trim();
    if (entry.length === 0) return [];
    if (entry === "~") return [home];
    if (entry.startsWith("~/") || entry.startsWith(`~${path.sep}`)) return [path.join(home, entry.slice(2))];
    return [path.resolve(base, entry)];
  });
}

/** The skill directories ampi adds, in precedence order. */
export function resolveMmrSkillPaths(input: MmrSkillPathsInput): string[] {
  const home = path.resolve(input.home ?? homedir());
  const cwd = path.resolve(input.cwd);
  const root = findMmrRepositoryRoot(cwd);
  const candidates: string[] = [];

  if (input.settings.disableClaudeCodeSkills !== true) {
    if (input.projectTrusted) {
      for (const directory of projectDirectories(cwd, root)) candidates.push(path.join(directory, ".claude", "skills"));
    }
    candidates.push(path.join(home, ".claude", "skills"));
  }

  // core's settings loader reads the project file whatever the trust; the
  // project value of this key counts only with trust.
  const skillsPath = input.projectTrusted
    ? (input.settings.skillsPath?.project ?? input.settings.skillsPath?.user)
    : input.settings.skillsPath?.user;
  if (skillsPath !== undefined) candidates.push(...splitSkillsPath(skillsPath, home, root ?? cwd));

  return [...new Set(candidates)].filter(isDirectory);
}

/** Whether Pi was started with `--no-skills` (`-ns`), which ampi follows too. */
export function isMmrSkillsDisabledByCli(argv: readonly string[]): boolean {
  return argv.includes("--no-skills") || argv.includes("-ns");
}
