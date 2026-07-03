const AMPI_WEB_TOOL_SOURCE_PATHS_GLOBAL_KEY = "__pi_ampi_web_tool_source_paths_v1__";
const MMR_WEB_TOOL_SOURCE_PATHS_GLOBAL_KEY = "__pi_mmr_web_tool_source_paths_v1__";

const globalStore = globalThis as typeof globalThis & {
  [AMPI_WEB_TOOL_SOURCE_PATHS_GLOBAL_KEY]?: Set<string>;
  [MMR_WEB_TOOL_SOURCE_PATHS_GLOBAL_KEY]?: Set<string>;
};

const toolSourcePaths: Set<string> = globalStore[AMPI_WEB_TOOL_SOURCE_PATHS_GLOBAL_KEY]
  ?? globalStore[MMR_WEB_TOOL_SOURCE_PATHS_GLOBAL_KEY]
  ?? new Set<string>();
globalStore[AMPI_WEB_TOOL_SOURCE_PATHS_GLOBAL_KEY] = toolSourcePaths;
globalStore[MMR_WEB_TOOL_SOURCE_PATHS_GLOBAL_KEY] = toolSourcePaths;

export const AMPI_WEB_TOOL_NAMES = ["web_search", "read_web_page"] as const;
export const MMR_WEB_TOOL_NAMES = AMPI_WEB_TOOL_NAMES;
export type MmrWebToolName = typeof MMR_WEB_TOOL_NAMES[number];
export type AmpiWebToolName = MmrWebToolName;

export interface MmrWebToolInfoLike {
  name: string;
  sourceInfo?: { path?: string };
}

export function registerAmpiWebToolSourcePath(absolutePath: string): void {
  const trimmed = absolutePath.trim();
  if (trimmed.length === 0) return;
  toolSourcePaths.add(trimmed);
}

export const registerMmrWebToolSourcePath = registerAmpiWebToolSourcePath;

export function getAmpiWebToolSourcePaths(): readonly string[] {
  return [...toolSourcePaths];
}

export const getMmrWebToolSourcePaths = getAmpiWebToolSourcePaths;

export function isMmrWebToolName(name: string): name is MmrWebToolName {
  return (MMR_WEB_TOOL_NAMES as readonly string[]).includes(name);
}

export function isMmrWebOwnedToolInfo(tool: MmrWebToolInfoLike, expectedName?: MmrWebToolName): boolean {
  if (expectedName !== undefined && tool.name !== expectedName) return false;
  if (!isMmrWebToolName(tool.name)) return false;
  const sourcePath = tool.sourceInfo?.path;
  if (typeof sourcePath !== "string" || sourcePath.length === 0) return false;
  return toolSourcePaths.has(sourcePath);
}

export function hasMmrWebOwnedTools(
  allTools: readonly MmrWebToolInfoLike[],
  requiredTools: readonly MmrWebToolName[] = MMR_WEB_TOOL_NAMES,
): boolean {
  return requiredTools.every((name) => allTools.some((tool) => isMmrWebOwnedToolInfo(tool, name)));
}

export function __resetMmrWebToolSourcePathsForTests(): void {
  toolSourcePaths.clear();
}
