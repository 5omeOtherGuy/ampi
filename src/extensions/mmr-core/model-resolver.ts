import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { MmrModelCandidateResolution, MmrModelPreference, MmrModelResolution } from "./types.js";

export interface MmrRegisteredModelLike {
  provider: string;
  id: string;
}

export interface MmrModelRegistryLike<TModel extends MmrRegisteredModelLike = MmrRegisteredModelLike> {
  getAll(): TModel[];
  find(provider: string, modelId: string): TModel | undefined;
  hasConfiguredAuth?(model: TModel): boolean;
  isUsingOAuth?(model: TModel): boolean;
}

export interface ResolveAndApplyMmrModelArgs<TModel extends MmrRegisteredModelLike = MmrRegisteredModelLike> {
  modelPreferences: readonly MmrModelPreference[];
  modeThinkingLevel?: ThinkingLevel;
  registry: MmrModelRegistryLike<TModel>;
  setModel: (model: TModel) => Promise<boolean>;
}

export interface SelectMmrModelRouteArgs<TModel extends MmrRegisteredModelLike = MmrRegisteredModelLike> {
  modelPreferences: readonly MmrModelPreference[];
  modeThinkingLevel?: ThinkingLevel;
  registry: MmrModelRegistryLike<TModel>;
}

/**
 * Non-mutating model preference resolution for worker tools (subagents, oracle,
 * librarian, etc.) that need to pick a registered+authenticated provider/model
 * route from a preference list without changing Pi's currently active model.
 */
export interface MmrModelRouteSelection<TModel extends MmrRegisteredModelLike = MmrRegisteredModelLike> {
  selected?: {
    provider: string;
    model: string;
    thinkingLevel?: ThinkingLevel;
    registeredModel: TModel;
  };
  candidates: MmrModelCandidateResolution[];
}

/**
 * Model-id aliases. Each entry pairs canonical IDs that refer to the same
 * logical model so a mode preference written either way still resolves
 * against a registered Pi model. Order does not matter; the resolver
 * enumerates every alias of every preference when matching.
 *
 * Add new aliases sparingly and only when two IDs are observably the same
 * model (typically a bare ID and its date-suffixed publication ID). Do not
 * use aliases for distinct revisions or sizes.
 */
const MODEL_ALIASES: readonly (readonly string[])[] = [
  ["claude-haiku-4-5", "claude-haiku-4-5-20251001"],
];

function getModelAliases(model: string): string[] {
  for (const group of MODEL_ALIASES) {
    if (group.includes(model)) return group.filter((alias) => alias !== model);
  }
  return [];
}

const SUBSCRIPTION_PROVIDERS = new Set(["claude-subscription", "openai-codex", "github-copilot"]);
const API_PROVIDERS = new Set(["anthropic", "openai", "azure-openai-responses"]);
const DEFAULT_PROVIDER_PRIORITY = [
  "claude-subscription",
  "openai-codex",
  "github-copilot",
  "anthropic",
  "openai",
  "azure-openai-responses",
  "google",
  "google-vertex",
  "openrouter",
  "vercel-ai-gateway",
];

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function normalizeProvider(value: string): string {
  return value.trim();
}

function normalizeModel(value: string): string {
  return value.trim();
}

function getDefaultProvidersForModel(model: string): string[] {
  if (model.startsWith("claude-")) return ["claude-subscription", "anthropic"];
  if (model.startsWith("gpt-")) return ["openai-codex", "github-copilot", "openai", "azure-openai-responses"];
  if (model.startsWith("gemini-") || model.startsWith("gemma-")) return ["google", "google-vertex"];
  return [];
}

function providerPriority(provider: string): number {
  const priority = DEFAULT_PROVIDER_PRIORITY.indexOf(provider);
  return priority >= 0 ? priority : DEFAULT_PROVIDER_PRIORITY.length;
}

function providerGroup(provider: string, subscription: boolean): number {
  if (subscription || SUBSCRIPTION_PROVIDERS.has(provider)) return 0;
  if (API_PROVIDERS.has(provider)) return 1;
  return 2;
}

/**
 * Outcome of a defensive registry call. The registry may throw on auth
 * misconfiguration or schema drift; capture the message so callers can
 * surface it through `MmrModelCandidateResolution.reason` instead of
 * silently treating the model as unauthenticated/unregistered.
 */
interface RegistryProbe<T> {
  value: T;
  error?: string;
}

function registryErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function safeHasConfiguredAuth<TModel extends MmrRegisteredModelLike>(registry: MmrModelRegistryLike<TModel>, model: TModel): RegistryProbe<boolean> {
  if (!registry.hasConfiguredAuth) return { value: true };
  try {
    return { value: registry.hasConfiguredAuth(model) };
  } catch (error) {
    return { value: false, error: `registry threw on hasConfiguredAuth: ${registryErrorMessage(error)}` };
  }
}

function safeIsSubscription<TModel extends MmrRegisteredModelLike>(registry: MmrModelRegistryLike<TModel>, model: TModel): RegistryProbe<boolean> {
  if (SUBSCRIPTION_PROVIDERS.has(model.provider)) return { value: true };
  if (!registry.isUsingOAuth) return { value: false };
  try {
    return { value: registry.isUsingOAuth(model) };
  } catch (error) {
    return { value: false, error: `registry threw on isUsingOAuth: ${registryErrorMessage(error)}` };
  }
}

function getRegisteredProvidersForModel<TModel extends MmrRegisteredModelLike>(registry: MmrModelRegistryLike<TModel>, model: string): RegistryProbe<string[]> {
  try {
    const aliases = [model, ...getModelAliases(model)];
    const providers = registry.getAll()
      .filter((registered) => aliases.includes(registered.id))
      .map((registered) => registered.provider);
    return { value: providers };
  } catch (error) {
    return { value: [], error: `registry threw on getAll: ${registryErrorMessage(error)}` };
  }
}

/**
 * Find a registered model for a given provider/model pair, retrying with
 * known aliases. Returns the registered entry whose `id` actually matches
 * the registry, so callers can pass the resulting object straight to
 * `pi.setModel`.
 */
function findRegisteredModelWithAliases<TModel extends MmrRegisteredModelLike>(
  registry: MmrModelRegistryLike<TModel>,
  provider: string,
  model: string,
): TModel | undefined {
  const direct = registry.find(provider, model);
  if (direct) return direct;
  for (const alias of getModelAliases(model)) {
    const aliased = registry.find(provider, alias);
    if (aliased) return aliased;
  }
  return undefined;
}

function getProvidersForPreference<TModel extends MmrRegisteredModelLike>(
  preference: MmrModelPreference,
  registry: MmrModelRegistryLike<TModel>,
): { providers: string[]; error?: string } {
  if (preference.providers && preference.providers.length > 0) {
    return { providers: unique(preference.providers.map(normalizeProvider).filter(Boolean)) };
  }

  const model = normalizeModel(preference.model);
  const registeredProbe = getRegisteredProvidersForModel(registry, model);
  const providers = unique([...getDefaultProvidersForModel(model), ...registeredProbe.value]);
  const sorted = providers.sort((a, b) => {
    const aModel = findRegisteredModelWithAliases(registry, a, model);
    const bModel = findRegisteredModelWithAliases(registry, b, model);
    const aSubscription = aModel ? safeIsSubscription(registry, aModel).value : SUBSCRIPTION_PROVIDERS.has(a);
    const bSubscription = bModel ? safeIsSubscription(registry, bModel).value : SUBSCRIPTION_PROVIDERS.has(b);
    const groupDelta = providerGroup(a, aSubscription) - providerGroup(b, bSubscription);
    if (groupDelta !== 0) return groupDelta;
    const priorityDelta = providerPriority(a) - providerPriority(b);
    if (priorityDelta !== 0) return priorityDelta;
    return a.localeCompare(b);
  });
  return { providers: sorted, error: registeredProbe.error };
}

function candidateReason(candidate: Pick<MmrModelCandidateResolution, "registered" | "authenticated" | "attempted" | "applied" | "reason">): string {
  if (candidate.reason) return candidate.reason;
  if (!candidate.registered) return "not registered";
  if (!candidate.authenticated) return "registered but not authenticated";
  if (candidate.attempted && !candidate.applied) return "Pi rejected model selection";
  return "not selected";
}

function buildFallbackReason(candidates: readonly MmrModelCandidateResolution[], selectedIndex: number): string | undefined {
  if (selectedIndex <= 0) return undefined;
  const skipped = candidates.slice(0, selectedIndex).map((candidate) => {
    return `${candidate.provider}/${candidate.model}: ${candidateReason(candidate)}`;
  });
  return `Selected fallback after skipping ${skipped.join("; ")}.`;
}

function createEmptyResolution(modelPreferences: readonly MmrModelPreference[]): MmrModelResolution {
  const requestedModels = modelPreferences.map((preference) => preference.model);
  return {
    targetModel: requestedModels[0] ?? "",
    requestedModels,
    modelFound: false,
    modelApplied: false,
    fallbackApplied: false,
    candidates: [],
  };
}

export function createMmrModelPlan(modelPreferences: readonly MmrModelPreference[]): MmrModelResolution {
  return createEmptyResolution(modelPreferences);
}

function normalizePreferences(modelPreferences: readonly MmrModelPreference[]): MmrModelPreference[] {
  return modelPreferences
    .map((preference) => ({
      ...preference,
      model: normalizeModel(preference.model),
      providers: preference.providers?.map(normalizeProvider).filter(Boolean),
    }))
    .filter((preference) => preference.model.length > 0);
}

function enumerateCandidates<TModel extends MmrRegisteredModelLike>(
  normalizedPreferences: readonly MmrModelPreference[],
  registry: MmrModelRegistryLike<TModel>,
  modeThinkingLevel: ThinkingLevel | undefined,
): { candidates: MmrModelCandidateResolution[]; registeredModels: Map<number, TModel> } {
  const candidates: MmrModelCandidateResolution[] = [];
  const registeredModels = new Map<number, TModel>();

  for (const preference of normalizedPreferences) {
    const { providers, error: enumerationError } = getProvidersForPreference(preference, registry);
    for (const provider of providers) {
      const registeredModel = findRegisteredModelWithAliases(registry, provider, preference.model);
      const authProbe = registeredModel ? safeHasConfiguredAuth(registry, registeredModel) : { value: false };
      const subscriptionProbe = registeredModel
        ? safeIsSubscription(registry, registeredModel)
        : { value: SUBSCRIPTION_PROVIDERS.has(provider) };
      // When the candidate matched via an alias, surface the actually-registered
      // model id so `state.model` and `pi.setModel(...)` agree.
      const resolvedModelId = registeredModel ? registeredModel.id : preference.model;
      // Surface registry errors in `reason` so /mmr-status and activation
      // warnings show the actual diagnostic instead of treating the route as
      // a vanilla "unauthenticated" candidate. Auth/subscription probe errors
      // dominate (the route is observably broken at probe time); fall back to
      // the enumeration error from getAll() only when no per-route probe error
      // is available.
      const probeError = authProbe.error ?? subscriptionProbe.error ?? enumerationError;
      let reason: string | undefined;
      if (!registeredModel) reason = probeError ? `not registered (${probeError})` : "not registered";
      else if (!authProbe.value) reason = probeError ?? "registered but not authenticated";
      const candidate: MmrModelCandidateResolution = {
        requestedModel: preference.model,
        provider,
        model: resolvedModelId,
        thinkingLevel: preference.thinkingLevel ?? modeThinkingLevel,
        registered: Boolean(registeredModel),
        authenticated: authProbe.value,
        subscription: subscriptionProbe.value,
        attempted: false,
        applied: false,
        reason,
      };
      const index = candidates.push(candidate) - 1;
      if (registeredModel) registeredModels.set(index, registeredModel);
    }
  }

  return { candidates, registeredModels };
}

/**
 * Pick a registered+authenticated provider/model route from an ordered
 * preference list. Worker-tool / subagent extensions use this to plan a route
 * without applying it through Pi's `setModel`.
 *
 * The first registered+authenticated candidate wins. Use `candidates` for
 * diagnostics (which routes were skipped and why).
 */
export function selectMmrModelRoute<TModel extends MmrRegisteredModelLike>(
  args: SelectMmrModelRouteArgs<TModel>,
): MmrModelRouteSelection<TModel> {
  const normalizedPreferences = normalizePreferences(args.modelPreferences);
  const { candidates, registeredModels } = enumerateCandidates(normalizedPreferences, args.registry, args.modeThinkingLevel);

  for (const [index, candidate] of candidates.entries()) {
    const registeredModel = registeredModels.get(index);
    if (!registeredModel || !candidate.authenticated) continue;
    return {
      selected: {
        provider: candidate.provider,
        model: candidate.model,
        thinkingLevel: candidate.thinkingLevel,
        registeredModel,
      },
      candidates,
    };
  }

  return { candidates };
}

export async function resolveAndApplyMmrModel<TModel extends MmrRegisteredModelLike>(
  args: ResolveAndApplyMmrModelArgs<TModel>,
): Promise<MmrModelResolution> {
  const normalizedPreferences = normalizePreferences(args.modelPreferences);

  const base = createEmptyResolution(normalizedPreferences);
  const { candidates, registeredModels } = enumerateCandidates(normalizedPreferences, args.registry, args.modeThinkingLevel);

  let selectedIndex = -1;
  for (const [index, candidate] of candidates.entries()) {
    const registeredModel = registeredModels.get(index);
    if (!registeredModel || !candidate.authenticated) continue;

    candidate.attempted = true;
    candidate.reason = undefined;
    const applied = await args.setModel(registeredModel);
    candidate.applied = applied;
    if (applied) {
      selectedIndex = index;
      break;
    }
    candidate.reason = "Pi rejected model selection";
  }

  if (selectedIndex < 0) {
    return {
      ...base,
      modelFound: candidates.some((candidate) => candidate.registered),
      candidates,
    };
  }

  const selected = candidates[selectedIndex];
  const fallbackReason = buildFallbackReason(candidates, selectedIndex);
  return {
    ...base,
    selectedProvider: selected.provider,
    selectedModel: selected.model,
    selectedThinkingLevel: selected.thinkingLevel,
    modelFound: true,
    modelApplied: true,
    fallbackApplied: selectedIndex > 0,
    fallbackReason,
    candidates,
  };
}
