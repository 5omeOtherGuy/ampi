/**
 * Where Pi found a skill, read from the `sourceInfo` Pi attaches to it.
 *
 * Pi tags every resource with a scope (`user`, `project`, `temporary`), an
 * origin (`package` or `top-level`) and a source: `auto` for its default
 * directories, `local` for paths listed in a settings file, `cli` for paths
 * given on the command line, or the package source for a Pi package. This
 * module turns that into one group per skill, so every ampi surface that
 * lists skills sorts them the same way:
 *
 * - `temporary`: loaded for this run only (`--skill`, `-e`), whatever its origin;
 * - `package`: from a Pi package, named by its source;
 * - `settings`: from a path in the `skills` setting;
 * - `user` and `project`: from Pi's default directories for that scope.
 *
 * Skill folders an extension adds through `resources_discover` (ampi-core's
 * Claude Code folders and `ampi.skills.path`) reach Pi as temporary, with
 * the source `extension:<name>`. They are grouped by their path instead:
 * `~/.claude/skills` is `user`, any other `.claude/skills` `project`, and
 * the rest `settings`.
 *
 * Separately, `origin` says whether the skill sits in an Agent Skills
 * directory (`~/.agents/skills` or a project's `.agents/skills`), a Claude
 * Code one (`.claude/skills`), or Pi's own.
 */

import { homedir } from "node:os";

/** The parts of Pi's `SourceInfo` the classification reads. */
export interface MmrSkillSourceInfo {
  readonly path: string;
  readonly source: string;
  readonly scope: string;
  readonly origin: string;
}

export type MmrSkillGroup = "user" | "project" | "package" | "settings" | "temporary";

export interface MmrSkillSource {
  readonly group: MmrSkillGroup;
  /** `agents` under an `.agents/skills` directory, `claude` under `.claude/skills`, `pi` otherwise. */
  readonly origin: "pi" | "agents" | "claude";
  /** The package source (`npm:…`, `git:…` or a local path) when the group is `package`. */
  readonly packageName?: string;
}

/** Groups in the order lists show them. */
export const MMR_SKILL_GROUPS: readonly MmrSkillGroup[] = ["user", "project", "package", "settings", "temporary"];

const AGENTS_SKILLS = /(^|[\\/])\.agents[\\/]skills([\\/]|$)/;
const CLAUDE_SKILLS = /(^|[\\/])\.claude[\\/]skills([\\/]|$)/;
const EXTENSION_SOURCE = "extension:";

/**
 * Classify one skill. `path` is the skill's file (Pi's `Skill.filePath`);
 * without it, `sourceInfo.path` is read. `home` tells `~/.claude/skills`
 * from a project's.
 */
export function classifyMmrSkillSource(sourceInfo: MmrSkillSourceInfo, path = sourceInfo.path, home = homedir()): MmrSkillSource {
  const origin = AGENTS_SKILLS.test(path) ? "agents" : CLAUDE_SKILLS.test(path) ? "claude" : "pi";
  if (sourceInfo.source.startsWith(EXTENSION_SOURCE)) {
    if (origin !== "claude") return { group: "settings", origin };
    const userSkills = `${home.replaceAll("\\", "/")}/.claude/skills/`;
    return { group: path.replaceAll("\\", "/").startsWith(userSkills) ? "user" : "project", origin };
  }
  if (sourceInfo.scope === "temporary") return { group: "temporary", origin };
  if (sourceInfo.origin === "package") return { group: "package", origin, packageName: sourceInfo.source };
  if (sourceInfo.source === "local") return { group: "settings", origin };
  return { group: sourceInfo.scope === "project" ? "project" : "user", origin };
}
