const MMR_WEB_TOOL_SOURCE_PATHS_GLOBAL_KEY = "__pi_mmr_web_tool_source_paths_v1__";

const globalStore = globalThis as typeof globalThis & {
  [MMR_WEB_TOOL_SOURCE_PATHS_GLOBAL_KEY]?: Set<string>;
};

const toolSourcePaths: Set<string> = (globalStore[MMR_WEB_TOOL_SOURCE_PATHS_GLOBAL_KEY] ??= new Set<string>());

export const MMR_WEB_TOOL_NAMES = ["web_search", "read_web_page"] as const;
export type MmrWebToolName = typeof MMR_WEB_TOOL_NAMES[number];

export interface MmrWebToolInfoLike {
  name: string;
  sourceInfo?: { path?: string };
}

export function registerMmrWebToolSourcePath(absolutePath: string): void {
  const trimmed = absolutePath.trim();
  if (trimmed.length === 0) return;
  toolSourcePaths.add(trimmed);
}

export function getMmrWebToolSourcePaths(): readonly string[] {
  return [...toolSourcePaths];
}

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
