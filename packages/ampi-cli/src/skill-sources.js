// Where Pi found a skill, for `ampi skill`: a plain-JS copy of the rules in
// ampi-core's skill-sources.ts (`classifyMmrSkillSource`), which the terminal
// UI's Skills dialog uses, plus the label the command prints.
// tests/mmr-cli-skill.test.mjs runs both over one set of skills and fails when
// they disagree.
import { homedir } from "node:os";

/**
 * @typedef {object} PiSkillSourceInfo The parts of Pi's `SourceInfo` the classification reads.
 * @property {string} path
 * @property {string} source `auto` (Pi's default directories), `local` (a settings path), `cli`,
 *   `extension:<name>` (a folder an extension adds) or a package source.
 * @property {string} scope `user`, `project` or `temporary`.
 * @property {string} origin `package` or `top-level`.
 *
 * @typedef {"user" | "project" | "package" | "settings" | "temporary"} SkillGroup
 *
 * @typedef {object} SkillSource
 * @property {SkillGroup} group
 * @property {"pi" | "agents" | "claude"} origin `agents` under an `.agents/skills` directory, `claude`
 *   under `.claude/skills`, `pi` otherwise.
 * @property {string} [packageName] The package source (`npm:…`, `git:…` or a path) for the `package` group.
 */

const AGENTS_SKILLS = /(^|[\\/])\.agents[\\/]skills([\\/]|$)/;
const CLAUDE_SKILLS = /(^|[\\/])\.claude[\\/]skills([\\/]|$)/;
const EXTENSION_SOURCE = "extension:";

/**
 * Classify one skill. Folders an extension adds (ampi's Claude Code folders
 * and `ampi.skills.path`) reach Pi as temporary with the source
 * `extension:<name>`, so they are grouped by their path: `~/.claude/skills`
 * is `user`, any other `.claude/skills` `project`, the rest `settings`.
 *
 * @param {PiSkillSourceInfo} sourceInfo
 * @param {string} [path] The skill's file; defaults to `sourceInfo.path`.
 * @param {string} [home] Tells `~/.claude/skills` from a project's.
 * @returns {SkillSource}
 */
export function classifySkillSource(sourceInfo, path = sourceInfo.path, home = homedir()) {
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

/**
 * The source label `ampi skill` prints: `user` and `project` for Pi's own
 * directories, `agents-user` and `agents-project` for the `.agents/skills`
 * directories, `claude-user` and `claude-project` for Claude Code's,
 * `package:<source>`, `settings` or `temporary`.
 *
 * @param {SkillSource} source
 * @returns {string}
 */
export function skillSourceLabel({ group, origin, packageName }) {
  if (group === "package") return `package:${packageName}`;
  if ((group === "user" || group === "project") && origin !== "pi") return `${origin}-${group}`;
  return group;
}
