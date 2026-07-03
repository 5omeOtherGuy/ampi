/**
 * Source-path ownership registry for the `ampi-github` tools.
 *
 * Mirrors `ampi-web/tool-ownership.ts`: the extension entrypoint records its
 * `sourceInfo.path` here so consumers (the `librarian` gating in
 * workers and child-process activation in `ampi-core`) can confirm
 * that the live registration for a GitHub tool name still belongs to
 * `ampi-github` by source path, not just by name. A third-party extension that
 * later re-registers any of these names is therefore preserved and never
 * satisfies the librarian gate.
 *
 * Registration also mirrors each source path into `ampi-core`'s generic
 * owner-scoped registry under canonical `"ampi-github"` and legacy
 * `"mmr-github"` owners, so child-process subagent activation can gate
 * `librarian` on AMPI-owned repo tools without `ampi-core` importing this
 * module.
 */

import { registerAmpiOwnedToolSourcePath } from "../ampi-core/owned-tools.js";

/** Canonical owner key used in `ampi-core`'s owner-scoped tool registry. */
export const AMPI_GITHUB_TOOL_OWNER = "ampi-github";
/** Legacy owner key mirrored for existing custom profile prerequisites. */
export const MMR_GITHUB_TOOL_OWNER = "mmr-github";

const AMPI_GITHUB_TOOL_SOURCE_PATHS_GLOBAL_KEY = "__pi_ampi_github_tool_source_paths_v1__";
const MMR_GITHUB_TOOL_SOURCE_PATHS_GLOBAL_KEY = "__pi_mmr_github_tool_source_paths_v1__";

const globalStore = globalThis as typeof globalThis & {
  [AMPI_GITHUB_TOOL_SOURCE_PATHS_GLOBAL_KEY]?: Set<string>;
  [MMR_GITHUB_TOOL_SOURCE_PATHS_GLOBAL_KEY]?: Set<string>;
};

const toolSourcePaths: Set<string> = globalStore[AMPI_GITHUB_TOOL_SOURCE_PATHS_GLOBAL_KEY]
  ?? globalStore[MMR_GITHUB_TOOL_SOURCE_PATHS_GLOBAL_KEY]
  ?? new Set<string>();
globalStore[AMPI_GITHUB_TOOL_SOURCE_PATHS_GLOBAL_KEY] = toolSourcePaths;
globalStore[MMR_GITHUB_TOOL_SOURCE_PATHS_GLOBAL_KEY] = toolSourcePaths;

export const AMPI_GITHUB_TOOL_NAMES = [
  "read_github",
  "list_directory_github",
  "glob_github",
  "search_github",
  "commit_search",
  "diff_github",
  "list_repositories",
] as const;
export const MMR_GITHUB_TOOL_NAMES = AMPI_GITHUB_TOOL_NAMES;
export type MmrGithubToolName = typeof MMR_GITHUB_TOOL_NAMES[number];
export type AmpiGithubToolName = MmrGithubToolName;

export interface MmrGithubToolInfoLike {
  name: string;
  sourceInfo?: { path?: string };
}

export function registerAmpiGithubToolSourcePath(absolutePath: string): void {
  const trimmed = absolutePath.trim();
  if (trimmed.length === 0) return;
  toolSourcePaths.add(trimmed);
  registerAmpiOwnedToolSourcePath(AMPI_GITHUB_TOOL_OWNER, trimmed);
  registerAmpiOwnedToolSourcePath(MMR_GITHUB_TOOL_OWNER, trimmed);
}

export const registerMmrGithubToolSourcePath = registerAmpiGithubToolSourcePath;

export function getAmpiGithubToolSourcePaths(): readonly string[] {
  return [...toolSourcePaths];
}

export const getMmrGithubToolSourcePaths = getAmpiGithubToolSourcePaths;

export function isMmrGithubToolName(name: string): name is MmrGithubToolName {
  return (MMR_GITHUB_TOOL_NAMES as readonly string[]).includes(name);
}

export function isMmrGithubOwnedToolInfo(tool: MmrGithubToolInfoLike, expectedName?: MmrGithubToolName): boolean {
  if (expectedName !== undefined && tool.name !== expectedName) return false;
  if (!isMmrGithubToolName(tool.name)) return false;
  const sourcePath = tool.sourceInfo?.path;
  if (typeof sourcePath !== "string" || sourcePath.length === 0) return false;
  return toolSourcePaths.has(sourcePath);
}

export function hasMmrGithubOwnedTools(
  allTools: readonly MmrGithubToolInfoLike[],
  requiredTools: readonly MmrGithubToolName[] = MMR_GITHUB_TOOL_NAMES,
): boolean {
  return requiredTools.every((name) => allTools.some((tool) => isMmrGithubOwnedToolInfo(tool, name)));
}

export function __resetMmrGithubToolSourcePathsForTests(): void {
  toolSourcePaths.clear();
}
