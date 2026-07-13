import { DEFAULT_MMR_MODE, resolveMmrModeKey } from "./modes.js";
import type { MmrModeKey, MmrModeSelection, MmrModeSelectionSource, MmrRejectedModeSource } from "./types.js";

export interface ResolveMmrModeSelectionInput {
  flagValue?: boolean | string;
  persistedMode?: string;
  settingsMode?: string;
  defaultMode?: MmrModeKey;
}

interface SourceEntry {
  source: MmrModeSelectionSource;
  /** Logical source name used in rejectedSources entries. */
  rejectedName: string;
  invalidDescription: string;
  value: unknown;
}

function normalizeMode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveMmrModeSelection(input: ResolveMmrModeSelectionInput): MmrModeSelection {
  const warnings: string[] = [];
  const rejectedSources: MmrRejectedModeSource[] = [];

  const sources: SourceEntry[] = [
    { source: "flag", rejectedName: "flag", invalidDescription: "--ampi-mode/--mmr-mode", value: input.flagValue },
    { source: "session", rejectedName: "session", invalidDescription: "persisted session", value: input.persistedMode },
    { source: "settings", rejectedName: "settings", invalidDescription: "settings", value: input.settingsMode },
  ];

  let selected: { mode: MmrModeKey; source: MmrModeSelectionSource } | undefined;

  for (const entry of sources) {
    const candidate = normalizeMode(entry.value);
    if (!candidate) continue;
    const mode = resolveMmrModeKey(candidate);
    if (mode) {
      if (candidate !== mode) {
        warnings.push(`Legacy ampi mode "${candidate}" maps to "${mode}".`);
      }
      if (!selected) selected = { mode, source: entry.source };
      continue;
    }
    warnings.push(`Ignoring invalid ${entry.invalidDescription} ampi mode "${candidate}".`);
    rejectedSources.push({ source: entry.rejectedName, value: candidate, reason: "invalid mode" });
  }

  if (selected) {
    return { ...selected, warnings, rejectedSources };
  }

  return {
    mode: input.defaultMode ?? DEFAULT_MMR_MODE,
    source: "default",
    warnings,
    rejectedSources,
  };
}
