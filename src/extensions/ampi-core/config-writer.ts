import path from "node:path";
import { isRecord } from "./internal/json.js";
import { isUnsafeObjectKey, rewriteJsonSettingsFile } from "./internal/settings-file.js";
import type { MmrModeKey, MmrModelPreference } from "./types.js";

/**
 * Update payload accepted by `applyMmrConfigUpdate` and `writeMmrCoreConfigFile`.
 *
 * Each field, when present, sets the matching preference list for a single
 * mode key or subagent profile name. Setting `preferences: []` clears the
 * entry. Omitted fields are not touched.
 *
 * Updates are scoped to the preferred `ampiCore` block of a Pi settings file,
 * while preserving existing `ampi.core`, `mmrCore`, or `mmr.core` layouts.
 * Other top-level settings keys (e.g. `ampiWeb`) and unrelated core fields
 * (e.g. `defaultMode`) are preserved verbatim. The removed `toolAliases`
 * field, if present in legacy files, is preserved verbatim as a dead key
 * (ampi-core ignores it and emits a deprecation warning at load time).
 */
export interface MmrConfigUpdate {
  modeModelPreferences?: { mode: MmrModeKey; preferences: MmrModelPreference[] };
  subagentModelPreferences?: { profile: string; preferences: MmrModelPreference[] };
}

function preferencesToJson(preferences: readonly MmrModelPreference[]): unknown[] {
  return preferences.map((preference) => {
    const hasProviders = Array.isArray(preference.providers) && preference.providers.length > 0;
    if (!hasProviders && !preference.thinkingLevel) {
      return preference.model;
    }
    const out: Record<string, unknown> = { model: preference.model };
    if (hasProviders) out.providers = [...preference.providers!];
    if (preference.thinkingLevel) out.thinkingLevel = preference.thinkingLevel;
    return out;
  });
}

/**
 * Apply a `MmrConfigUpdate` to a parsed settings JSON value and return a new
 * settings object. The input is not mutated; unrelated keys are preserved.
 *
 * `ampiCore`, nested `ampi.core`, and the legacy `mmrCore` / `mmr.core`
 * shapes are supported. The writer keeps an existing recognized layout;
 * when all are absent it defaults to the flat `ampiCore` block.
 */
export function applyMmrConfigUpdate(existing: unknown, update: MmrConfigUpdate): Record<string, unknown> {
  const root: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};

  const flatAmpiCore = isRecord(root.ampiCore) ? { ...root.ampiCore } : undefined;
  const ampiBlock = isRecord(root.ampi) ? { ...root.ampi } : undefined;
  const nestedAmpiCore = ampiBlock && isRecord(ampiBlock.core) ? { ...ampiBlock.core } : undefined;

  const flatMmrCore = isRecord(root.mmrCore) ? { ...root.mmrCore } : undefined;
  const mmrBlock = isRecord(root.mmr) ? { ...root.mmr } : undefined;
  const nestedMmrCore = mmrBlock && isRecord(mmrBlock.core) ? { ...mmrBlock.core } : undefined;

  const target = flatAmpiCore
    ? { kind: "flat" as const, flatKey: "ampiCore", core: flatAmpiCore }
    : nestedAmpiCore
      ? { kind: "nested" as const, rootKey: "ampi", block: ampiBlock ?? {}, core: nestedAmpiCore }
      : flatMmrCore
        ? { kind: "flat" as const, flatKey: "mmrCore", core: flatMmrCore }
        : nestedMmrCore
          ? { kind: "nested" as const, rootKey: "mmr", block: mmrBlock ?? {}, core: nestedMmrCore }
          : { kind: "flat" as const, flatKey: "ampiCore", core: {} };
  const core: Record<string, unknown> = target.core;

  if (update.modeModelPreferences) {
    const { mode, preferences } = update.modeModelPreferences;
    if (isUnsafeObjectKey(mode)) {
      throw new Error(`Refusing to write unsafe mode key "${mode}".`);
    }
    const existingModelPrefs = isRecord(core.modelPreferences) ? { ...core.modelPreferences } : {};
    if (preferences.length === 0) {
      delete existingModelPrefs[mode];
    } else {
      existingModelPrefs[mode] = preferencesToJson(preferences);
    }
    if (Object.keys(existingModelPrefs).length === 0) {
      delete core.modelPreferences;
    } else {
      core.modelPreferences = existingModelPrefs;
    }
  }

  if (update.subagentModelPreferences) {
    const { profile, preferences } = update.subagentModelPreferences;
    if (isUnsafeObjectKey(profile)) {
      throw new Error(`Refusing to write unsafe subagent profile key "${profile}".`);
    }
    const existingSubPrefs = isRecord(core.subagentModelPreferences)
      ? { ...core.subagentModelPreferences }
      : {};
    if (preferences.length === 0) {
      delete existingSubPrefs[profile];
    } else {
      existingSubPrefs[profile] = preferencesToJson(preferences);
    }
    if (Object.keys(existingSubPrefs).length === 0) {
      delete core.subagentModelPreferences;
    } else {
      core.subagentModelPreferences = existingSubPrefs;
    }
  }

  if (target.kind === "nested") {
    const nextBlock = { ...target.block };
    if (Object.keys(core).length === 0) {
      delete nextBlock.core;
    } else {
      nextBlock.core = core;
    }
    if (Object.keys(nextBlock).length === 0) {
      delete root[target.rootKey];
    } else {
      root[target.rootKey] = nextBlock;
    }
  } else {
    if (Object.keys(core).length === 0) {
      delete root[target.flatKey];
    } else {
      root[target.flatKey] = core;
    }
  }

  return root;
}

/**
 * Atomically rewrite a Pi settings file with the given config update applied.
 * Returns the resolved file path. Creates the parent directory if needed.
 *
 * The file is rewritten with 2-space JSON indentation; if the file did not
 * exist, only the keys touched by `update` are present.
 */
export function writeMmrCoreConfigFile(filePath: string, update: MmrConfigUpdate): string {
  return rewriteJsonSettingsFile(filePath, (existing) => applyMmrConfigUpdate(existing, update));
}

/**
 * Project settings path for the given cwd. The MMR config command writes
 * here by default so changes are scoped to the workspace.
 */
export function getProjectMmrSettingsPath(cwd: string): string {
  return path.join(cwd, ".pi/settings.json");
}
