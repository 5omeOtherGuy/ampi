import type { MmrModeDefinition, MmrModeKey } from "./types.js";
import { MMR_REQUEST_POLICIES, formatMmrPolicyContext, formatMmrPolicyThinking } from "./request-policy.js";

export const DEFAULT_MMR_MODE: MmrModeKey = "medium";

export const MMR_MODE_KEYS = ["low", "medium", "high", "ultra", "free"] as const satisfies readonly MmrModeKey[];

/** Legacy mode names accepted at configuration and command boundaries. */
export const MMR_LEGACY_MODE_ALIASES = {
  rush: "low",
  smart: "medium",
  deep: "high",
  fable: "ultra",
} as const satisfies Record<string, MmrModeKey>;

/** Resolve a canonical mode key or a legacy compatibility alias. */
export function resolveMmrModeKey(value: string): MmrModeKey | undefined {
  if ((MMR_MODE_KEYS as readonly string[]).includes(value)) return value as MmrModeKey;
  return Object.hasOwn(MMR_LEGACY_MODE_ALIASES, value)
    ? MMR_LEGACY_MODE_ALIASES[value as keyof typeof MMR_LEGACY_MODE_ALIASES]
    : undefined;
}

/** Modes intentionally hidden from the interactive mode picker and cycle. */
export const MMR_HOTKEY_HIDDEN_MODE_KEYS = [] as const satisfies readonly MmrModeKey[];

/** Mode keys offered through the interactive hotkeys (picker + cycle). */
export const MMR_HOTKEY_MODE_KEYS: readonly MmrModeKey[] = MMR_MODE_KEYS.filter(
  (mode) => !(MMR_HOTKEY_HIDDEN_MODE_KEYS as readonly MmrModeKey[]).includes(mode),
);

export const MMR_SMART_TOOL_NAMES = [
  "read",
  "bash",
  "write",
  "edit",
  "web_search",
  "read_web_page",
  "read_session",
  "find_session",
  "skill",
  "oracle",
  "librarian",
  "Task",
  "start_task",
  "task_poll",
  "task_wait",
  "task_cancel",
  "task_list",
  "finder",
  "reviewer",
  "handoff",
  "read_mcp_resource",
] satisfies string[];

export const MMR_RUSH_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "finder",
  "bash",
  "write",
  "edit",
  "web_search",
  "read_web_page",
  "read_mcp_resource",
  "chart",
  "read_session",
  "find_session",
  "skill",
  "oracle",
  "handoff",
  "librarian",
  "Task",
  "start_task",
  "task_poll",
  "task_wait",
  "task_cancel",
  "task_list",
] satisfies string[];

/**
 * MMR mode table.
 *
 * Model preferences are provider-neutral and per-mode-scoped: each locked
 * mode lists its model preference order, including explicit cross-provider
 * fallback preferences where a mode has a supported OpenAI or Anthropic
 * substitute. ampi-core resolves each model ID against the local
 * Pi model registry, prefers subscription-backed provider entries (for
 * example claude-subscription or openai-codex) over API-key providers, and
 * applies provider/model aliases (see `model-resolver.ts`) so the same
 * preference resolves against either bare or date-suffixed registrations.
 *
 * Tool lists name concrete Pi tools directly. ampi-core resolves each name
 * by identity against the active Pi tool inventory and reports unavailable
 * extension-owned tools as deferred via the exact-name status catalog.
 */
export const MMR_DEEP_TOOL_NAMES = [
  "bash",
  "apply_patch",
  "write",
  "web_search",
  "read_web_page",
  "chart",
  "skill",
  "read_session",
  "find_session",
  "librarian",
  "oracle",
  "Task",
  "start_task",
  "task_poll",
  "task_wait",
  "task_cancel",
  "finder",
  "reviewer",
  "task_list",
  "handoff",
] satisfies string[];

export const MMR_MODES: Record<MmrModeKey, MmrModeDefinition> = {
  low: {
    key: "low",
    displayName: "Low",
    description: "Fast, low-cost mode for small, well-defined tasks.",
    modelPreferences: [
      { model: "gpt-5.6-terra" },
      { model: "gpt-5.5" },
    ],
    thinkingLevel: "medium",
    tools: MMR_RUSH_TOOL_NAMES,
    promptRoute: "default",
    featureGates: ["ampi-workers"],
  },

  medium: {
    key: "medium",
    displayName: "Medium",
    description: "Balanced intelligence, speed, and cost for most tasks.",
    modelPreferences: [
      { model: "gpt-5.5" },
      { model: "claude-opus-4-8" },
    ],
    thinkingLevel: "medium",
    tools: MMR_SMART_TOOL_NAMES,
    promptRoute: "default",
    featureGates: ["ampi-workers"],
  },

  high: {
    key: "high",
    displayName: "High",
    description: "Deep reasoning for hard tasks.",
    modelPreferences: [
      { model: "gpt-5.5" },
      { model: "claude-opus-4-8" },
    ],
    thinkingLevel: "xhigh",
    tools: MMR_DEEP_TOOL_NAMES,
    promptRoute: "deep",
    featureGates: ["ampi-workers", "ampi-history", "ampi-web"],
  },

  ultra: {
    key: "ultra",
    displayName: "Ultra",
    description: "Maximum-effort GPT-5.6 Sol mode for hard, open-ended tasks.",
    modelPreferences: [
      { model: "gpt-5.6-sol" },
      { model: "gpt-5.5" },
    ],
    // Pi exposes xhigh as its highest OpenAI reasoning level; GPT-5.6 Sol uses
    // that lane for the requested maximum-effort profile.
    thinkingLevel: "xhigh",
    tools: MMR_DEEP_TOOL_NAMES,
    promptRoute: "deep",
    featureGates: ["ampi-workers", "ampi-history", "ampi-web"],
  },

  free: {
    key: "free",
    displayName: "Free",
    description: "Normal native Pi controls with no MMR model, thinking, prompt, or tool enforcement.",
    modelPreferences: [],
    tools: [],
    promptRoute: "default",
  },
};

export function isMmrModeKey(value: string): value is MmrModeKey {
  return (MMR_MODE_KEYS as readonly string[]).includes(value);
}

export function getMmrMode(key: MmrModeKey): MmrModeDefinition {
  return MMR_MODES[key];
}

export function formatMmrModeList(): string {
  return MMR_MODE_KEYS.map((key) => {
    const mode = MMR_MODES[key];
    const policy = key === "free" ? undefined : MMR_REQUEST_POLICIES[key];
    const models = mode.modelPreferences.length > 0
      ? mode.modelPreferences
        .map((preference) => preference.model)
        .join(" → ")
      : "native Pi controls";
    const policySummary = policy
      ? ` — thinking: ${formatMmrPolicyThinking(policy)}; context: ${formatMmrPolicyContext(policy)}`
      : "";
    return `${mode.key.padEnd(5)} ${models}${policySummary} — ${mode.description}`;
  }).join("\n");
}
