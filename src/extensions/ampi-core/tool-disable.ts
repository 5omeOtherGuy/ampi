/**
 * `ampi.tools.disable`: turn tools off by name.
 *
 * Each entry is one of:
 *
 * - an exact tool name (`web_search`);
 * - a glob over tool names (`task_*`, `mcp__github__*`), with the syntax of
 *   `glob.ts`;
 * - `builtin:<name or glob>`, which matches only Pi's own built-in tools
 *   (`read`, `bash`, `grep`, ...). A tool another extension registers under a
 *   built-in name stays on, and so do the tools of Pi's built-in extensions
 *   (MCP tools, `codemode`, `tool_search`).
 *
 * ampi-core compiles the entries once per settings load into one matcher. It
 * leaves matching tools out of every active-tool set it applies, blocks calls
 * to them (nested calls from `codemode` included), and reports them in
 * `/ampi-status`.
 */

import { GlobPatternError, globToRegExp } from "./glob.js";
import type { ToolInfoLike } from "./owned-tools.js";
import type { MmrToolDecision, MmrToolResolution } from "./types.js";

/** The setting's name, used in warnings, status rows and the reason a blocked call gets. */
export const MMR_TOOLS_DISABLE_SETTING = "ampi.tools.disable";

const BUILTIN_ENTRY_PREFIX = "builtin:";

/**
 * Pi's own built-in tools. Pi gives each of them the source path
 * `builtin:<tool name>`. Tools of Pi's built-in extensions get
 * `builtin:<extension name>`, which for `codemode` is also the tool's name,
 * so this list is what tells the two kinds apart.
 */
export const PI_BUILTIN_TOOL_NAMES: readonly string[] = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];

interface CompiledEntry {
  readonly entry: string;
  readonly builtinOnly: boolean;
  readonly regex: RegExp;
}

/**
 * Compile one entry. Throws {@link GlobPatternError} for a pattern the glob
 * matcher does not support and for a `builtin:` entry that names no tool.
 */
export function compileMmrToolDisableEntry(entry: string): CompiledEntry {
  const builtinOnly = entry.startsWith(BUILTIN_ENTRY_PREFIX);
  const pattern = builtinOnly ? entry.slice(BUILTIN_ENTRY_PREFIX.length) : entry;
  if (pattern.length === 0) throw new GlobPatternError(entry, "no tool name after builtin:");
  return { entry, builtinOnly, regex: globToRegExp(pattern) };
}

function isPiBuiltinTool(tool: ToolInfoLike): boolean {
  return tool.sourceInfo?.path === `${BUILTIN_ENTRY_PREFIX}${tool.name}` && PI_BUILTIN_TOOL_NAMES.includes(tool.name);
}

export interface MmrToolDisableMatcher {
  /** The entries in settings order. Empty when nothing is turned off. */
  readonly entries: readonly string[];
  /** The first entry that turns `tool` off, or `undefined` when it stays on. */
  match(tool: ToolInfoLike): string | undefined;
}

/** Build the matcher from entries the settings loader already checked. */
export function createMmrToolDisableMatcher(entries: readonly string[] = []): MmrToolDisableMatcher {
  const compiled = entries.map(compileMmrToolDisableEntry);
  return {
    entries: compiled.map((entry) => entry.entry),
    match(tool) {
      for (const entry of compiled) {
        if (entry.builtinOnly && !isPiBuiltinTool(tool)) continue;
        if (entry.regex.test(tool.name)) return entry.entry;
      }
      return undefined;
    },
  };
}

/** Pi's record of the tool named `name`, or the bare name when Pi has none. */
function findTool(name: string, tools: readonly ToolInfoLike[]): ToolInfoLike {
  return tools.find((tool) => tool.name === name) ?? { name };
}

/** The setting entry that turns off the tool named `name`, looked up in Pi's tool list. */
export function matchMmrDisabledTool(
  matcher: MmrToolDisableMatcher,
  name: string,
  tools: readonly ToolInfoLike[],
): string | undefined {
  return matcher.entries.length === 0 ? undefined : matcher.match(findTool(name, tools));
}

/** `names` without the tools the setting turns off, in their order. */
export function withoutMmrDisabledTools(
  names: readonly string[],
  matcher: MmrToolDisableMatcher,
  tools: readonly ToolInfoLike[],
): string[] {
  return names.filter((name) => matchMmrDisabledTool(matcher, name, tools) === undefined);
}

/** Every registered tool the setting turns off, with the entry that matched, in Pi's order. */
export function listMmrDisabledTools(
  matcher: MmrToolDisableMatcher,
  tools: readonly ToolInfoLike[],
): { tool: string; entry: string }[] {
  if (matcher.entries.length === 0) return [];
  return tools.flatMap((tool) => {
    const entry = matcher.match(tool);
    return entry === undefined ? [] : [{ tool: tool.name, entry }];
  });
}

/**
 * Turn the setting into decisions: a requested tool that an entry matches is
 * `disabled`, whatever the resolver decided, and is never counted as active,
 * missing, deferred or gated.
 */
export function applyMmrToolDisable(
  resolution: MmrToolResolution,
  matcher: MmrToolDisableMatcher,
  tools: readonly ToolInfoLike[],
): MmrToolResolution {
  const disabled = new Set<string>();
  const decisions = resolution.decisions.map((decision): MmrToolDecision => {
    const entry = matchMmrDisabledTool(matcher, decision.requested, tools);
    if (entry === undefined) return decision;
    disabled.add(decision.requested);
    return {
      requested: decision.requested,
      chosenTools: [],
      candidates: [],
      status: "disabled",
      owner: decision.owner,
      diagnostic: `${decision.requested}: turned off by ${MMR_TOOLS_DISABLE_SETTING} entry "${entry}"`,
    };
  });
  if (disabled.size === 0) return resolution;
  const keep = (names: readonly string[]) => names.filter((name) => !disabled.has(name));
  return {
    requestedTools: [...resolution.requestedTools],
    activeTools: keep(resolution.activeTools),
    missingTools: keep(resolution.missingTools),
    deferredTools: keep(resolution.deferredTools),
    gatedTools: keep(resolution.gatedTools),
    disabledTools: [...new Set([...resolution.disabledTools, ...disabled])],
    decisions,
  };
}
