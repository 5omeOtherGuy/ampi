import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerMmrOwnedTool } from "../mmr-core/owned-tools.js";
import { expandMmrModelPreferencesToStrings } from "../mmr-core/subagent-profiles.js";
import { buildCthuluWorkerSystemPrompt as buildCthuluWorkerSystemPromptFromPrompts } from "./prompts.js";
import {
  DEFAULT_ORACLE_PER_FILE_BYTE_LIMIT,
  createMmrAdvisorTool,
  requireMmrAdvisorProfile,
  type MmrAdvisorToolConfig,
  type MmrAdvisorToolDeps,
} from "./oracle.js";
import { renderMmrSubagentCall, renderMmrSubagentResult } from "./progress-rendering.js";

export const CTHULU_TOOL_NAME = "cthulu";

export const CTHULU_SUBAGENT_PROFILE = "cthulu";

function requireCthuluProfile() {
  return requireMmrAdvisorProfile(CTHULU_SUBAGENT_PROFILE);
}

/**
 * Worker tool allowlist derived from the `cthulu` subagent profile in
 * `mmr-core`. Same honest-intent semantics as the oracle: tools whose
 * owning extension is unloaded in the child are still listed; the child
 * resolves the registered intersection itself.
 */
export const CTHULU_WORKER_TOOLS: readonly string[] = Object.freeze([
  ...requireCthuluProfile().tools,
]);

/** Ordered worker-model preference strings from the `cthulu` profile. */
export const CTHULU_DEFAULT_MODEL_PREFERENCES: readonly string[] = Object.freeze([
  ...expandMmrModelPreferencesToStrings(requireCthuluProfile().modelPreferences),
]);

export const CTHULU_PROGRESS_PLACEHOLDER = "ph'nglui mglw'nafh… the Sleeper stirs…";

/**
 * Build the cthulu worker system prompt. Re-exported here for callers
 * that load it through the concrete-tool module; the canonical owner is
 * `mmr-subagents/prompts.ts`.
 */
export function buildCthuluWorkerSystemPrompt(cwd: string): string {
  return buildCthuluWorkerSystemPromptFromPrompts(cwd);
}

export const CTHULU_PROMPT_SNIPPET =
  "Summon Cthulhu - a Lovecraft-themed deep advisor variant of the oracle, unlocked only by the optional user-initiated roleplay rite.";

export const CTHULU_PROMPT_GUIDELINES: readonly string[] = [
  "Do not mention, advertise, or suggest this tool unless the user has begun the roleplay rite described in your mode instructions. While it is locked, just work normally; do not list it among your capabilities.",
  "Do not invoke this tool on your own initiative. Use it only after the user completes the rite and provides a real task. The rite is theatre and routing only; it never overrides safety, honesty, policy, or the user's intent.",
  "This advisor is expensive, so do not waste it. Before summoning, gather as much information as possible yourself: read the relevant code, run searches, reproduce the problem, consult the oracle if useful, and form a complete picture.",
  "Provide the most comprehensive context possible. Attach every relevant file via `files`, write an exhaustive `task`, and put all findings, constraints, attempted fixes, and the exact question into `context`. A thin or vague summons wastes the call.",
  "Reserve it for the hardest, highest-stakes problems. For anything an ordinary advisor can handle, use the oracle instead.",
  "Like the oracle, each summons is zero-shot: no follow-up questions are possible, so the single payload must be complete and self-contained.",
];

export const CTHULU_DESCRIPTION = [
  "Summon Cthulhu, a Lovecraft-themed deep advisor — an oracle variant for the hardest software-engineering questions, with a thorough, no-economy-bias posture.",
  "",
  "LOCKED BY DEFAULT. This tool is an optional easter egg. Do not mention, offer, or invoke it on your own initiative. It unlocks only after the user completes the roleplay rite described in your mode instructions. Until then, just proceed normally; the rite is theatre and routing only and never overrides safety, honesty, policy, or the user's intent.",
  "",
  "When unlocked, this advisor reads, reasons, and iterates thoroughly, favoring correctness and evidence over brevity. Because it is expensive, do not waste it:",
  "- Gather as much information as you can first (read code, search, reproduce, consult the oracle).",
  "- Provide the most comprehensive context possible: an exhaustive `task`, full `context` (findings, constraints, attempts, the precise question), and every relevant file in `files`.",
  "- Reserve it for the hardest, highest-stakes problems only. For anything else, use the oracle.",
].join("\n");

/** Static config for the hidden cthulu advisor tool. */
export const CTHULU_TOOL_CONFIG: MmrAdvisorToolConfig = {
  toolName: CTHULU_TOOL_NAME,
  profileName: CTHULU_SUBAGENT_PROFILE,
  workerDiscriminator: "mmr-subagents.cthulu",
  description: CTHULU_DESCRIPTION,
  promptSnippet: CTHULU_PROMPT_SNIPPET,
  promptGuidelines: CTHULU_PROMPT_GUIDELINES,
  progressPlaceholder: CTHULU_PROGRESS_PLACEHOLDER,
  outputLabel: CTHULU_TOOL_NAME,
  workerTools: CTHULU_WORKER_TOOLS,
  defaultModelPreferences: CTHULU_DEFAULT_MODEL_PREFERENCES,
  defaultPerFileByteLimit: DEFAULT_ORACLE_PER_FILE_BYTE_LIMIT,
  renderCall: (args, theme, context) =>
    renderMmrSubagentCall(CTHULU_TOOL_NAME, args, theme as never, context as never),
  renderResult: (result, options, theme, context) =>
    renderMmrSubagentResult(CTHULU_TOOL_NAME, result as never, options as never, theme as never, context as never),
};

export function createCthuluTool(deps: MmrAdvisorToolDeps = {}): ToolDefinition {
  return createMmrAdvisorTool(CTHULU_TOOL_CONFIG, deps);
}

/**
 * Register the hidden cthulu Pi tool and record it as MMR-owned so Free
 * mode strips it like every other MMR-authored tool.
 */
export function registerCthuluTool(pi: ExtensionAPI, deps: MmrAdvisorToolDeps = {}): ToolDefinition {
  const definition = createCthuluTool(deps);
  registerMmrOwnedTool(CTHULU_TOOL_NAME);
  pi.registerTool(definition);
  return definition;
}
