import { resolveMmrFeatureGates } from "./feature-gates.js";
import { isMmrModeKey } from "./modes.js";
import { isThinkingLevel } from "./settings.js";
import type {
  MmrFeatureGateDecision,
  MmrModeDefinition,
  MmrModeResolution,
  MmrModeSelectionSource,
  MmrModeState,
  MmrModelResolution,
  MmrRejectedModeSource,
  MmrToolResolution,
  PersistedMmrModeState,
} from "./types.js";

// Allowlists used to sanitize values restored from persisted Pi entries. The
// settings.ts loader already validates inbound values; mirror the same
// allowlists here so a hand-edited or corrupted session entry cannot
// propagate invalid values into runtime state and /ampi-status rendering.
const MMR_MODE_SELECTION_SOURCES: ReadonlySet<MmrModeSelectionSource> = new Set([
  "flag",
  "command",
  "session",
  "settings",
  "default",
  "native",
]);

function isMmrModeSelectionSource(value: unknown): value is MmrModeSelectionSource {
  return typeof value === "string" && MMR_MODE_SELECTION_SOURCES.has(value as MmrModeSelectionSource);
}

export const AMPI_MODE_STATE_ENTRY = "ampi-core.mode-state";
/** Legacy persisted entry key read for existing sessions. */
export const MMR_MODE_STATE_ENTRY = "mmr-core.mode-state";
const MODE_STATE_ENTRY_KEYS: ReadonlySet<string> = new Set([AMPI_MODE_STATE_ENTRY, MMR_MODE_STATE_ENTRY]);
export const MMR_MODE_STATE_VERSION = 1;

export function createMmrModeState(args: {
  mode: MmrModeDefinition;
  source: MmrModeSelectionSource;
  modelResolution: MmrModelResolution;
  tools: MmrToolResolution;
  /**
   * Pre-resolved feature-gate decisions. When omitted, ampi-core falls back to
   * the built-in reserved/unknown resolver via `resolveMmrFeatureGates`. Pass
   * decisions from a runtime registry to honor registered providers.
   */
  featureGateDecisions?: readonly MmrFeatureGateDecision[];
  rejectedSources?: readonly MmrRejectedModeSource[];
  appliedAt?: string;
  /** Runtime-only total context profile; not persisted. */
  effectiveContextWindow?: number;
  /** Runtime-only max-output profile; not persisted. */
  effectiveMaxOutputTokens?: number;
  /** Runtime-only max-input cap; not persisted. */
  effectiveMaxInputTokens?: number;
  /** Runtime-only registered context window of the selected provider model; not persisted. */
  registeredContextWindow?: number;
  /** Runtime-only baseline diagnostics; not persisted. */
  baselineCaptured?: boolean;
  baselineModel?: string;
  /** Optional settings-load metadata; rendered by `/ampi-status` only. */
  settingsFilesRead?: readonly string[];
  /** Optional settings-load warnings; rendered by `/ampi-status` only. */
  settingsWarnings?: readonly string[];
}): MmrModeState {
  const featureGateDecisions = args.featureGateDecisions
    ? [...args.featureGateDecisions]
    : resolveMmrFeatureGates(args.mode.featureGates ?? []);

  // Defensive copies: callers may keep references to the inputs, and the
  // runtime singleton's live state is documented as read-only. Cloning every
  // array we hold prevents upstream mutations from reaching downstream listeners
  // (and matches the pre-existing behavior for featureGateDecisions).
  const toolDecisions = args.tools.decisions.map((decision) => ({ ...decision }));
  const resolution: MmrModeResolution = {
    selectedSource: args.source,
    rejectedSources: args.rejectedSources ? [...args.rejectedSources] : [],
    modelDecision: {
      fallbackApplied: args.modelResolution.fallbackApplied,
      reason: args.modelResolution.fallbackReason,
    },
    toolDecisions,
    featureGateDecisions,
  };

  return {
    version: MMR_MODE_STATE_VERSION,
    mode: args.mode.key,
    displayName: args.mode.displayName,
    source: args.source,
    targetModel: args.modelResolution.targetModel,
    requestedModels: [...args.modelResolution.requestedModels],
    provider: args.modelResolution.selectedProvider ?? "",
    model: args.modelResolution.selectedModel ?? "",
    modelFound: args.modelResolution.modelFound,
    modelApplied: args.modelResolution.modelApplied,
    modelFallbackApplied: args.modelResolution.fallbackApplied,
    modelFallbackReason: args.modelResolution.fallbackReason,
    modelCandidates: args.modelResolution.candidates.map((candidate) => ({ ...candidate })),
    thinkingLevel: args.modelResolution.selectedThinkingLevel,
    effectiveContextWindow: args.effectiveContextWindow,
    effectiveMaxOutputTokens: args.effectiveMaxOutputTokens,
    effectiveMaxInputTokens: args.effectiveMaxInputTokens,
    registeredContextWindow: args.registeredContextWindow,
    baselineCaptured: args.baselineCaptured,
    baselineModel: args.baselineModel,
    promptRoute: args.mode.promptRoute,
    requestedTools: [...args.tools.requestedTools],
    activeTools: [...args.tools.activeTools],
    missingTools: [...args.tools.missingTools],
    deferredTools: args.tools.deferredTools ? [...args.tools.deferredTools] : [],
    gatedTools: args.tools.gatedTools ? [...args.tools.gatedTools] : [],
    disabledTools: args.tools.disabledTools ? [...args.tools.disabledTools] : [],
    featureGates: args.mode.featureGates ? [...args.mode.featureGates] : [],
    availabilityNotes: args.mode.availabilityNotes ? [...args.mode.availabilityNotes] : [],
    resolution,
    appliedAt: args.appliedAt ?? new Date().toISOString(),
    ...(args.settingsFilesRead ? { settingsFilesRead: [...args.settingsFilesRead] } : {}),
    ...(args.settingsWarnings ? { settingsWarnings: [...args.settingsWarnings] } : {}),
  };
}

export function toPersistedModeState(state: MmrModeState): PersistedMmrModeState {
  return {
    version: MMR_MODE_STATE_VERSION,
    mode: state.mode,
    source: state.source,
    targetModel: state.targetModel,
    requestedModels: state.requestedModels,
    provider: state.provider,
    model: state.model,
    modelFallbackApplied: state.modelFallbackApplied,
    modelFallbackReason: state.modelFallbackReason,
    thinkingLevel: state.thinkingLevel,
    activeTools: state.activeTools,
    missingTools: state.missingTools,
    deferredTools: state.deferredTools,
    gatedTools: state.gatedTools,
    disabledTools: state.disabledTools,
    appliedAt: state.appliedAt,
  };
}

function isCustomEntryWithData(entry: unknown): entry is { type: string; customType?: string; data?: unknown } {
  return typeof entry === "object" && entry !== null && "type" in entry;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Validate the persisted state version.
 *
 * - undefined → legacy pre-versioning record; accept and normalize to v1.
 * - exact MMR_MODE_STATE_VERSION → accept.
 * - anything else (future numbers, non-numeric values) → reject.
 */
function validatePersistedVersion(value: unknown): number | undefined {
  if (value === undefined) return MMR_MODE_STATE_VERSION;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value !== MMR_MODE_STATE_VERSION) return undefined;
  return value;
}

function parsePersistedModeState(data: unknown): PersistedMmrModeState | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const candidate = data as Partial<PersistedMmrModeState> & { version?: unknown };

  const version = validatePersistedVersion(candidate.version);
  if (version === undefined) return undefined;

  if (typeof candidate.mode !== "string" || !isMmrModeKey(candidate.mode)) return undefined;

  const model = typeof candidate.model === "string" ? candidate.model : "";
  return {
    version,
    mode: candidate.mode,
    source: isMmrModeSelectionSource(candidate.source) ? candidate.source : "session",
    targetModel: typeof candidate.targetModel === "string" ? candidate.targetModel : model,
    requestedModels: readStringArray(candidate.requestedModels),
    provider: typeof candidate.provider === "string" ? candidate.provider : "",
    model,
    modelFallbackApplied: Boolean(candidate.modelFallbackApplied),
    modelFallbackReason: typeof candidate.modelFallbackReason === "string" ? candidate.modelFallbackReason : undefined,
    thinkingLevel: isThinkingLevel(candidate.thinkingLevel) ? candidate.thinkingLevel : undefined,
    activeTools: readStringArray(candidate.activeTools),
    missingTools: readStringArray(candidate.missingTools),
    deferredTools: readStringArray(candidate.deferredTools),
    gatedTools: readStringArray(candidate.gatedTools),
    disabledTools: readStringArray(candidate.disabledTools),
    appliedAt: typeof candidate.appliedAt === "string" ? candidate.appliedAt : new Date(0).toISOString(),
  };
}

export function findLatestPersistedModeState(entries: readonly unknown[]): PersistedMmrModeState | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!isCustomEntryWithData(entry)) continue;
    if (entry.type !== "custom" || !MODE_STATE_ENTRY_KEYS.has(entry.customType ?? "")) continue;

    const parsed = parsePersistedModeState(entry.data);
    if (parsed) return parsed;
  }

  return undefined;
}
