import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { MmrModelPreference } from "../mmr-core/types.js";
import { getMmrSessionFallbackThinkingLevels } from "./thinking.js";

export interface MmrSessionFallbackRegisteredModel {
  provider: string;
  id: string;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

export interface MmrSessionFallbackModelRegistry<TModel extends MmrSessionFallbackRegisteredModel = MmrSessionFallbackRegisteredModel> {
  getAll(): TModel[];
  hasConfiguredAuth?(model: TModel): boolean;
  isUsingOAuth?(model: TModel): boolean;
}

function safeGetAll<TModel extends MmrSessionFallbackRegisteredModel>(registry: MmrSessionFallbackModelRegistry<TModel>): TModel[] {
  try {
    return registry.getAll();
  } catch {
    return [];
  }
}

export interface MmrSessionFallbackCandidate<TModel extends MmrSessionFallbackRegisteredModel = MmrSessionFallbackRegisteredModel> {
  provider: string;
  model: string;
  registeredModel: TModel;
  label: string;
  suggested: boolean;
  thinkingLevels: ThinkingLevel[];
}

function safeHasConfiguredAuth<TModel extends MmrSessionFallbackRegisteredModel>(
  registry: MmrSessionFallbackModelRegistry<TModel>,
  model: TModel,
): boolean {
  try {
    return registry.hasConfiguredAuth ? registry.hasConfiguredAuth(model) : true;
  } catch {
    return false;
  }
}

function preferenceRank(model: MmrSessionFallbackRegisteredModel, preferences: readonly MmrModelPreference[]): number {
  const rank = preferences.findIndex((preference) => preference.model === model.id);
  return rank < 0 ? Number.MAX_SAFE_INTEGER : rank;
}

export function buildMmrSessionFallbackCandidates<TModel extends MmrSessionFallbackRegisteredModel>(args: {
  registry: MmrSessionFallbackModelRegistry<TModel>;
  modePreferences?: readonly MmrModelPreference[];
  failingProvider?: string;
  failingModel?: string;
}): MmrSessionFallbackCandidate<TModel>[] {
  const modePreferences = args.modePreferences ?? [];
  const seen = new Set<string>();
  const authenticated = safeGetAll(args.registry)
    .filter((model) => safeHasConfiguredAuth(args.registry, model))
    .filter((model) => !(model.provider === args.failingProvider && model.id === args.failingModel))
    .filter((model) => {
      const key = `${model.provider}\u0000${model.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const sorted = [...authenticated].sort((a, b) => {
    const rankDelta = preferenceRank(a, modePreferences) - preferenceRank(b, modePreferences);
    if (rankDelta !== 0) return rankDelta;
    const providerDelta = a.provider.localeCompare(b.provider);
    if (providerDelta !== 0) return providerDelta;
    return a.id.localeCompare(b.id);
  });

  const suggestedIndex = sorted.findIndex((model) => preferenceRank(model, modePreferences) < Number.MAX_SAFE_INTEGER);

  return sorted.map((model, index) => {
    const suggested = index === suggestedIndex;
    const label = `${suggested ? "Suggested: " : ""}${model.provider}/${model.id}`;
    return {
      provider: model.provider,
      model: model.id,
      registeredModel: model,
      label,
      suggested,
      thinkingLevels: getMmrSessionFallbackThinkingLevels(model),
    };
  });
}
