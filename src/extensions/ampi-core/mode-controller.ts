import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createMmrAutoCompactor, type MmrAutoCompactor } from "./auto-compact.js";
import { withMmrModeContextCap } from "./context-cap.js";
import { getMmrPolicyDiagnostics } from "./diagnostics.js";
import { isRecord } from "./internal/json.js";
import {
  DEFAULT_MMR_MODE,
  getMmrMode,
  getMmrModeToolNames,
  isMmrModeKey,
  MMR_HOTKEY_MODE_KEYS,
  resolveMmrEditToolFamily,
} from "./modes.js";
import { formatActivationFailure, formatZeroToolActivationFailure } from "./activation-errors.js";
import { resolveAndApplyMmrModel } from "./model-resolver.js";
import { shouldDropToolForFreeMode, type ToolInfoLike } from "./owned-tools.js";
import {
  MMR_REQUEST_POLICIES,
  applyMmrThinkingLevelToPolicy,
  clampPolicyToRegisteredModel,
  getDefaultToggleThinkingLevel,
  getMmrPolicyMaxOutputTokens,
  getOtherToggleThinkingLevel,
  isToggleableMmrMode,
  type MmrRequestPolicy,
  type MmrToggleableModeKey,
  type MmrToggleThinkingLevel,
} from "./request-policy.js";
import { resolveMmrModeSelection } from "./routing.js";
import {
  MMR_EVENT_STATE_CHANGED,
  clearMmrManagedModelOverride,
  getMmrManagedModelOverride,
  getMmrModeState,
  getMmrSubagentState,
  isMmrManagedModelUpdateActive,
  recordMmrModeEvent,
  resolveMmrFeatureGates,
  resolveMmrModeExtraTools,
  resolveMmrTools,
  setMmrModeState,
} from "./runtime.js";
import { excludeReservedSubagentNames, mergeToolResolutions, relabelExtraOwners, selectExtraToolNames } from "./extra-tools.js";
import { resolveMmrTools as resolveMmrToolNames } from "./tool-registry.js";
import { loadMmrCoreSettings } from "./settings.js";
import {
  applyMmrToolDisable,
  createMmrToolDisableMatcher,
  listMmrDisabledTools,
  matchMmrDisabledTool,
  withoutMmrDisabledTools,
  type MmrToolDisableMatcher,
} from "./tool-disable.js";
import { AMPI_MODE_STATE_ENTRY, createMmrModeState, findLatestPersistedModeState, toPersistedModeState } from "./state.js";
import { updateMmrStatus } from "./status.js";
import type {
  MmrCoreSettings,
  MmrEditToolFamilyDecision,
  MmrEditToolsSetting,
  MmrLockedModeKey,
  MmrModeKey,
  MmrModeLock,
  MmrModeSelectionSource,
  MmrModeState,
  MmrModelPreference,
  MmrRejectedModeSource,
} from "./types.js";

// The picker includes every canonical mode; the cycle drops `free`.
const CYCLABLE_MMR_MODE_KEYS: MmrModeKey[] = MMR_HOTKEY_MODE_KEYS.filter((mode) => mode !== "free");

/** Why a mode change is refused once the session has a user message. */
const MMR_MODE_LOCK_REASON = "the mode is fixed once a session has messages; start a new session to change it";

/** Whether the session entries hold a user message (Pi's `message` entry with role `user`). */
function hasMmrUserMessage(entries: readonly unknown[]): boolean {
  return entries.some((entry) => isRecord(entry) && entry.type === "message" && isRecord(entry.message) && entry.message.role === "user");
}

export interface ApplyModeOptions {
  source: MmrModeSelectionSource;
  persist?: boolean;
  notify?: boolean;
  nativeControlOptOut?: boolean;
  rejectedSources?: readonly MmrRejectedModeSource[];
  nativeModel?: Parameters<ExtensionAPI["setModel"]>[0];
  nativeThinkingLevel?: ThinkingLevel;
  /**
   * Change the mode even when the session's mode is locked. Set by `/mode`,
   * the session's initial mode and native Pi model or thinking changes; the
   * cycle and picker shortcuts leave it unset and are refused while locked.
   */
  overrideModeLock?: boolean;
}

export interface MmrBaseline {
  model?: Parameters<ExtensionAPI["setModel"]>[0];
  thinkingLevel?: ThinkingLevel;
  activeTools: string[];
}

function readPreferredFlag(pi: ExtensionAPI, preferred: string, legacy: string): boolean | string | undefined {
  const preferredValue = pi.getFlag(preferred);
  if (typeof preferredValue === "string" && preferredValue.trim().length > 0) return preferredValue;
  if (typeof preferredValue === "boolean") return preferredValue;
  const legacyValue = pi.getFlag(legacy);
  if (typeof legacyValue === "string" && legacyValue.trim().length > 0) return legacyValue;
  return typeof legacyValue === "boolean" ? legacyValue : undefined;
}

/**
 * Emit a warning notification for each non-empty warning list. Shared by the
 * controller's initial-mode resolution and the lifecycle hooks' subagent
 * activation bindings.
 */
export function notifyWarnings(ctx: ExtensionContext, warnings: readonly string[]): void {
  if (warnings.length === 0) return;
  ctx.ui.notify(warnings.join("\n"), "warning");
}

/**
 * The single-source controller that owns all closure-captured mutable mode
 * state (see {@link createMmrModeController}). The entrypoint and the
 * registration modules talk to mode activation only through this surface; they
 * never re-declare the underlying state. Hook read-paths use the live
 * accessors `getActivePolicy()`/`isApplyingMmrMode()` rather than values
 * captured at registration time.
 */
export interface MmrModeController {
  applyMode(modeKey: MmrModeKey, ctx: ExtensionContext, options: ApplyModeOptions): Promise<MmrModeState | undefined>;
  resolveInitialMode(ctx: ExtensionContext): Promise<void>;
  /** Lock the mode once the session gets its first user message. */
  noteUserMessage(): void;
  switchLockedModeToFreeForNativeControl(
    ctx: ExtensionContext,
    options?: Pick<ApplyModeOptions, "nativeModel" | "nativeThinkingLevel">,
  ): Promise<void>;
  reassertActiveModelInvariants(ctx: ExtensionContext): Promise<void>;
  /**
   * Re-resolve the active tools when a published locked-mode state names a
   * route whose provider calls for another edit tool family (for example
   * after a session fallback switched providers). No-op otherwise.
   */
  refreshEditTools(state: MmrModeState | undefined): void;
  /**
   * Resolve the locked mode's tools and feature gates again, after a tool
   * provider's answer changed (`MMR_EVENT_TOOL_RULES_CHANGED`). Waits for a
   * mode apply in progress to end. No-op in `free` and in subagent workers.
   */
  refreshModeTools(): void;
  /** Run a refresh that was held back, if any. ampi-core calls it on every user input. */
  flushToolRefresh(): void;
  captureBaseline(
    ctx: ExtensionContext,
    options?: { force?: boolean; model?: Parameters<ExtensionAPI["setModel"]>[0]; thinkingLevel?: ThinkingLevel },
  ): MmrBaseline;
  selectModeFromShortcut(ctx: ExtensionContext): Promise<void>;
  cycleModeFromShortcut(ctx: ExtensionContext): Promise<void>;
  toggleThinkingFromShortcut(ctx: ExtensionContext): Promise<void>;
  getActivePolicy(): MmrRequestPolicy | undefined;
  isApplyingMmrMode(): boolean;
  getConfiguredModelPreferences(): Partial<Record<MmrModeKey, MmrModelPreference[]>>;
  getConfiguredSubagentModelPreferences(): Record<string, MmrModelPreference[]>;
  setConfiguredModePreferences(mode: MmrModeKey, preferences: MmrModelPreference[] | undefined): void;
  setConfiguredSubagentPreferences(profile: string, preferences: MmrModelPreference[] | undefined): void;
  setConfiguredSubagentModelPreferences(preferences: Record<string, MmrModelPreference[]>): void;
  setSettingsFilesRead(files: string[]): void;
  setSettingsWarnings(warnings: string[]): void;
  setApplyingMmrMode(value: boolean): void;
  /** Locked-mode auto-compaction; its setting is loaded with the other ampi-core settings. */
  getAutoCompactor(): MmrAutoCompactor;
  /** Replace the `ampi.tools.disable` matcher; subagent activation loads its own settings. */
  setToolDisableMatcher(matcher: MmrToolDisableMatcher): void;
  /** The `ampi.tools.disable` entry that turns off the tool named `name`, if any. */
  matchDisabledTool(name: string): string | undefined;
  /** Every registered tool `ampi.tools.disable` turns off, with the entry that matched. */
  listDisabledTools(): { tool: string; entry: string }[];
}

export function createMmrModeController(pi: ExtensionAPI): MmrModeController {
  const nativeFreeModeWarning = [
    "MMR switched to Free mode because the Pi model/thinking setting changed.",
    "",
    "Free mode implications:",
    "- Native Pi model/thinking controls are active.",
    "- MMR mode prompt is disabled.",
    "- MMR tool allowlist is disabled.",
    "- Standard Pi tools are restored.",
    "",
    "Use /mode low, /mode medium, /mode high, or /mode ultra to re-enter a managed mode.",
  ].join("\n");

  let configuredModelPreferences: Partial<Record<MmrModeKey, MmrModelPreference[]>> = {};
  let configuredSubagentModelPreferences: Record<string, MmrModelPreference[]> = {};
  let configuredLockedModeExtraTools: MmrCoreSettings["lockedModeExtraTools"] = {};
  let configuredEditTools: MmrEditToolsSetting = "auto";
  // `ampi.tools.disable`, compiled once per settings load.
  let toolDisableMatcher = createMmrToolDisableMatcher();
  // Workspace of the last locked-mode apply; scopes provider extras when the
  // edit tool family is refreshed outside an apply.
  let lockedModeCwd: string | undefined;
  let settingsFilesRead: string[] = [];
  let settingsWarnings: string[] = [];
  const autoCompactor = createMmrAutoCompactor({
    isPiCompactionDisabled: () => pi.getSettings().compaction?.enabled === false,
  });
  let baseline: MmrBaseline | undefined;
  let activePolicy: MmrRequestPolicy | undefined;
  let applyingMmrMode = false;
  // A tool provider asked for a refresh while a mode was being applied.
  let toolRefreshPending = false;
  let modeCycleQueue: Promise<void> = Promise.resolve();
  let thinkingToggleQueue: Promise<void> = Promise.resolve();
  // Per-mode, session-scoped thinking-level overrides for Medium, High, and
  // Ultra. Lives only in process memory: persisted mode
  // state records the applied thinking level for diagnostics, but the toggle
  // default is re-derived on each apply so stale persisted levels never pin a
  // mode away from its default after a reload.
  const modeThinkingOverrides: Partial<Record<MmrToggleableModeKey, MmrToggleThinkingLevel>> = {};
  // The mode lock: on unless `ampiCore.modeLock` is false, engaged once the
  // session has a user message. Both are re-read at every session start.
  let modeLockEnabled = true;
  let sessionHasUserMessage = false;

  function currentModeLock(): MmrModeLock {
    return modeLockEnabled && sessionHasUserMessage
      ? { enabled: true, locked: true, reason: MMR_MODE_LOCK_REASON }
      : { enabled: modeLockEnabled, locked: false };
  }

  function notifyModeLocked(ctx: ExtensionContext, mode: MmrModeKey): void {
    ctx.ui.notify(`Mode stays ${mode}: ${MMR_MODE_LOCK_REASON}. /mode <key> still switches it.`, "warning");
  }

  // Bring the live state's lock in line with the session, for example when
  // the first user message arrives between two mode changes.
  function publishModeLock(): void {
    const state = getMmrModeState();
    if (!state) return;
    const modeLock = currentModeLock();
    if (state.modeLock?.enabled === modeLock.enabled && state.modeLock?.locked === modeLock.locked) return;
    setMmrModeState({ ...state, modeLock });
    publishStateChange();
  }

  function safeGetThinkingLevel(): ThinkingLevel | undefined {
    try {
      return pi.getThinkingLevel?.();
    } catch {
      return undefined;
    }
  }

  function captureBaseline(ctx: ExtensionContext, options: { force?: boolean; model?: Parameters<ExtensionAPI["setModel"]>[0]; thinkingLevel?: ThinkingLevel } = {}): MmrBaseline {
    if (baseline && !options.force) return baseline;
    baseline = {
      model: options.model ?? ctx.model,
      thinkingLevel: options.thinkingLevel ?? safeGetThinkingLevel(),
      activeTools: pi.getActiveTools(),
    };
    return baseline;
  }

  function formatBaselineModel(model: Parameters<ExtensionAPI["setModel"]>[0] | undefined): string | undefined {
    if (!model) return undefined;
    return `${model.provider}/${model.id}`;
  }

  function currentBaselineFields(): Pick<MmrModeState, "baselineCaptured" | "baselineModel"> {
    return {
      baselineCaptured: Boolean(baseline),
      baselineModel: formatBaselineModel(baseline?.model),
    };
  }

  function createNativeControlModeState(
    modeKey: "free",
    source: MmrModeSelectionSource,
    tools: Parameters<typeof createMmrModeState>[0]["tools"],
    rejectedSources?: readonly MmrRejectedModeSource[],
  ): MmrModeState {
    const mode = getMmrMode(modeKey);
    return createMmrModeState({
      ...currentBaselineFields(),
      mode,
      source,
      rejectedSources,
      modelResolution: {
        targetModel: "",
        requestedModels: [],
        modelFound: false,
        modelApplied: false,
        fallbackApplied: false,
        candidates: [],
      },
      tools,
      featureGateDecisions: resolveMmrFeatureGates(mode.featureGates ?? []),
      settingsFilesRead,
      settingsWarnings,
      modeLock: currentModeLock(),
    });
  }

  function createFreeModeState(source: MmrModeSelectionSource, activeTools: string[], rejectedSources?: readonly MmrRejectedModeSource[]): MmrModeState {
    return createNativeControlModeState("free", source, {
      requestedTools: [],
      activeTools,
      missingTools: [],
      deferredTools: [],
      gatedTools: [],
      disabledTools: [],
      decisions: [],
    }, rejectedSources);
  }

  // The mode's tools plus the settings and provider extras, less the tools
  // `ampi.tools.disable` turns off.
  function resolveLockedModeTools(
    modeKey: MmrLockedModeKey,
    editTools: MmrEditToolFamilyDecision,
    allTools: readonly ToolInfoLike[],
    cwd: string,
  ): ReturnType<typeof resolveMmrTools> {
    const availableTools = allTools.map((tool) => tool.name);
    const baseToolNames = getMmrModeToolNames(modeKey, editTools.family);
    const baseResolution = resolveMmrTools(modeKey, availableTools, editTools.family);
    const settingsExtraNames = excludeReservedSubagentNames(selectExtraToolNames(
      modeKey,
      configuredLockedModeExtraTools,
      baseToolNames,
    ));
    const providerExtraNames = resolveMmrModeExtraTools(modeKey, cwd);
    const baseToolSet = new Set(baseToolNames);
    const seenExtra = new Set<string>();
    const extraToolNames: string[] = [];
    for (const name of [...settingsExtraNames, ...providerExtraNames]) {
      if (baseToolSet.has(name) || seenExtra.has(name)) continue;
      seenExtra.add(name);
      extraToolNames.push(name);
    }
    const resolution = extraToolNames.length > 0
      ? mergeToolResolutions(baseResolution, relabelExtraOwners(resolveMmrToolNames(extraToolNames, availableTools)))
      : baseResolution;
    return applyMmrToolDisable(resolution, toolDisableMatcher, allTools);
  }

  function notifyFreeMode(ctx: ExtensionContext, state: MmrModeState, options: ApplyModeOptions): void {
    if (!options.notify) return;

    if (options.nativeControlOptOut) {
      ctx.ui.notify(nativeFreeModeWarning, "warning");
      return;
    }

    ctx.ui.notify(
      [
        `MMR Free mode activated (${state.mode}).`,
        "Native Pi model/thinking controls are active.",
        "MMR prompt and tool allowlist enforcement are disabled.",
        "Standard Pi tools have been restored.",
      ].join("\n"),
      "info",
    );
  }

  function publishStateChange(): void {
    // Emit the live (deep-frozen) singleton reference. Raw `pi.events.on`
    // subscribers receive a frozen, read-only payload as documented on
    // MMR_EVENT_STATE_CHANGED; handlers that need a mutable copy attach via
    // `onMmrStateChanged`, which clones once per handler. Avoids the
    // previous double-clone (snapshot here + per-handler clone in
    // onMmrStateChanged) — addresses M8 in the run2 review.
    pi.events.emit(MMR_EVENT_STATE_CHANGED, getMmrModeState());
  }

  // Append a deterministic mode/fallback history entry for the just-applied
  // state. Records explicit applies and provider-failure fallbacks only; the
  // runtime collapses consecutive no-op duplicates. Surfaced by
  // `/ampi-status debug`.
  function recordModeTransition(previousState: MmrModeState | undefined, state: MmrModeState): void {
    recordMmrModeEvent({
      at: state.appliedAt,
      mode: state.mode,
      previousMode: previousState?.mode,
      source: state.source,
      model: state.modelApplied ? `${state.provider}/${state.model}` : undefined,
      thinkingLevel: state.thinkingLevel,
      fallbackApplied: state.modelFallbackApplied,
      fallbackReason: state.modelFallbackReason,
    });
  }

  async function applyFreeMode(ctx: ExtensionContext, options: ApplyModeOptions): Promise<MmrModeState> {
    activePolicy = undefined;
    clearMmrManagedModelOverride();
    const previousState = getMmrModeState();
    const shouldRestoreBaseline = Boolean(baseline && previousState && previousState.mode !== "free" && !options.nativeControlOptOut);
    // Free mode means "Pi as if `ampi` were not installed". Drop tools
    // registered by MMR package extensions (apply_patch, web_search,
    // read_web_page, ...) from the baseline before handing control back to
    // Pi. Pi rebuilds its system prompt and provider `tools` payload from
    // the active tool set, so removing them here also removes their
    // descriptions/schemas from the model context.
    //
    // Ownership is checked against `ToolInfo.sourceInfo.path` when Pi
    // provides it, so a third-party extension that re-registers a tool
    // with the same name as one we own (e.g. `apply_patch`) is preserved.
    // When Pi cannot tell us the source, we fall back to the name-only
    // registry so Free mode still removes the tools we know about. See
    // `shouldDropToolForFreeMode` for the full matrix.
    //
    // `ampi.tools.disable` still applies: it is the user's own choice, not
    // part of ampi's mode policy.
    const allTools = pi.getAllTools();
    const baselineTools = baseline ? [...baseline.activeTools] : pi.getActiveTools();
    const activeTools = withoutMmrDisabledTools(
      baselineTools.filter((name) => !shouldDropToolForFreeMode(name, allTools)),
      toolDisableMatcher,
      allTools,
    );

    applyingMmrMode = true;
    try {
      pi.setActiveTools(activeTools);
      if (shouldRestoreBaseline) {
        if (baseline?.model) await pi.setModel(baseline.model);
        if (baseline?.thinkingLevel) pi.setThinkingLevel(baseline.thinkingLevel);
      }
    } finally {
      applyingMmrMode = false;
      // Free mode resolves no locked tools, so a refresh asked for meanwhile has nothing to do.
      toolRefreshPending = false;
    }

    if (options.nativeControlOptOut) {
      captureBaseline(ctx, {
        force: true,
        model: options.nativeModel ?? ctx.model,
        thinkingLevel: options.nativeThinkingLevel ?? safeGetThinkingLevel(),
      });
    } else if (shouldRestoreBaseline) {
      baseline = undefined;
    }

    const state = createFreeModeState(options.source, activeTools, options.rejectedSources);
    setMmrModeState(state);
    publishStateChange();
    recordModeTransition(previousState, state);

    if (options.persist) {
      pi.appendEntry(AMPI_MODE_STATE_ENTRY, toPersistedModeState(state));
    }

    updateMmrStatus(ctx, state);
    notifyFreeMode(ctx, state, options);
    return state;
  }

  async function applyMode(modeKey: MmrModeKey, ctx: ExtensionContext, options: ApplyModeOptions): Promise<MmrModeState | undefined> {
    // Refuse before anything changes, so a refused cycle also keeps a
    // session-fallback route in place.
    const currentState = getMmrModeState();
    if (!options.overrideModeLock && currentState && currentState.mode !== modeKey && currentModeLock().locked) {
      if (options.notify) notifyModeLocked(ctx, currentState.mode);
      return currentState;
    }

    clearMmrManagedModelOverride();
    const mode = getMmrMode(modeKey);

    if (mode.key === "free") {
      return applyFreeMode(ctx, options);
    }

    captureBaseline(ctx);

    // Toggleable modes carry a runtime thinking-level override flipped by the
    // ampi-owned alt+d shortcut. Re-derive the effective level on every
    // apply (override or the mode default), force every candidate to it so the
    // active and fallback routes agree with the wire reasoning effort, and use
    // it as the mode thinking level passed to model resolution.
    const toggleableKey: MmrToggleableModeKey | undefined = isToggleableMmrMode(mode.key) ? mode.key : undefined;
    const toggleLevel: MmrToggleThinkingLevel | undefined = toggleableKey
      ? (modeThinkingOverrides[toggleableKey] ?? getDefaultToggleThinkingLevel(toggleableKey))
      : undefined;
    const effectiveThinkingLevel: ThinkingLevel | undefined = toggleLevel ?? mode.thinkingLevel;

    const configuredPreferences = configuredModelPreferences[mode.key] ?? mode.modelPreferences;
    const modelPreferences = toggleLevel
      ? configuredPreferences.map((preference) => ({ ...preference, thinkingLevel: toggleLevel }))
      : configuredPreferences;
    const previousState = getMmrModeState();

    const allTools = pi.getAllTools();
    // Base resolution drives the fail-closed activation check: only the mode's
    // own allowlist may satisfy (or fail) activation. User extras are merged
    // afterward so a typo'd or missing extra can never abort, nor mask a mode
    // that resolved zero of its own tools. The check runs before a route is
    // chosen, so it leaves out the provider-dependent file-editing tool. It
    // also runs before `ampi.tools.disable` applies, so turning tools off
    // never aborts a mode switch.
    const baseResolution = resolveMmrTools(mode.key, allTools.map((tool) => tool.name));
    if (mode.tools.length > 0 && baseResolution.activeTools.length === 0) {
      if (options.notify) ctx.ui.notify(formatZeroToolActivationFailure(mode, baseResolution, previousState), "error");
      updateMmrStatus(ctx, previousState);
      return previousState;
    }

    applyingMmrMode = true;
    try {
      const modelResolution = await resolveAndApplyMmrModel({
        modelPreferences,
        modeThinkingLevel: effectiveThinkingLevel,
        registry: ctx.modelRegistry,
        // Cap the active model's context window to the mode's advertised
        // profile window (Medium inherits a 300k cap). Modes without a profile
        // run at Pi's own registered window. Native Pi stores the passed object directly and
        // keys all compaction/overflow/footer/usage off `model.contextWindow`,
        // so a capped clone makes Pi compact and display exactly as it would at
        // the capped window. No-op for `free`, for modes without a cap, and for
        // routes already at/under the cap.
        setModel: async (model) => pi.setModel(withMmrModeContextCap(mode.key, model)),
      });

      if (!modelResolution.modelApplied) {
        if (options.notify) ctx.ui.notify(formatActivationFailure(mode, modelResolution, previousState), "error");
        return previousState;
      }

      // The file-editing tools follow the route that was just applied.
      // Provider-contributed extras (e.g. ampi-workers enabled custom `sa__*`
      // subagents scoped to this mode + project) are merged through the same
      // additive, fail-closed path as settings extras: they never satisfy the
      // zero-active-tools activation check and a missing name is a no-op. The
      // reserved `sa__*` namespace is filtered out of the user-controlled
      // settings extras so a custom subagent can only ever enter a mode through
      // this scope-aware provider.
      const editTools = resolveMmrEditToolFamily(modelResolution.selectedProvider ?? "", configuredEditTools);
      const toolResolution = resolveLockedModeTools(mode.key as MmrLockedModeKey, editTools, allTools, ctx.cwd);
      lockedModeCwd = ctx.cwd;
      pi.setActiveTools(toolResolution.activeTools);

      if (modelResolution.selectedThinkingLevel) {
        pi.setThinkingLevel(modelResolution.selectedThinkingLevel);
      }

      const registeredModel = modelResolution.selectedProvider && modelResolution.selectedModel
        ? ctx.modelRegistry.find(modelResolution.selectedProvider, modelResolution.selectedModel)
        : undefined;
      // Apply the same mode cap used at the setModel call site so policy
      // clamping and the recorded `registeredContextWindow` reflect the
      // window Pi will actually compact against, not the uncapped registry
      // value. For Medium this collapses both to 300k, so the
      // `context.registered-exceeds-profile` diagnostic stays quiet.
      const selectedModel = registeredModel ? withMmrModeContextCap(mode.key, registeredModel) : undefined;
      const basePolicy = clampPolicyToRegisteredModel(MMR_REQUEST_POLICIES[mode.key], selectedModel);
      activePolicy = toggleableKey && toggleLevel
        ? applyMmrThinkingLevelToPolicy(toggleableKey, basePolicy, toggleLevel)
        : basePolicy;
      const registeredContextWindow = typeof selectedModel?.contextWindow === "number" && Number.isFinite(selectedModel.contextWindow)
        ? selectedModel.contextWindow
        : undefined;

      const state = createMmrModeState({
        ...currentBaselineFields(),
        effectiveContextWindow: activePolicy.contextWindow,
        effectiveMaxOutputTokens: getMmrPolicyMaxOutputTokens(activePolicy),
        effectiveMaxInputTokens: activePolicy.effectiveMaxInputTokens,
        registeredContextWindow,
        mode,
        source: options.source,
        rejectedSources: options.rejectedSources,
        modelResolution,
        tools: toolResolution,
        editTools,
        featureGateDecisions: resolveMmrFeatureGates(mode.featureGates ?? []),
        settingsFilesRead,
        settingsWarnings,
        modeLock: currentModeLock(),
      });
      setMmrModeState(state);
      publishStateChange();
      recordModeTransition(previousState, state);

      if (options.persist) {
        pi.appendEntry(AMPI_MODE_STATE_ENTRY, toPersistedModeState(state));
      }

      updateMmrStatus(ctx, state);

      if (options.notify) {
        // Policy warnings come from the same diagnostic pipeline that drives
        // /ampi-status, so the two surfaces stay in sync. Deferred-tool messages
        // are intentionally not policy warnings (they are informational "what
        // is coming" announcements), so they are appended separately.
        const policyMessages = getMmrPolicyDiagnostics(state).map((diag) => diag.message);
        const deferredMessages = toolResolution.decisions
          .filter((decision) => decision.status === "deferred")
          .map((decision) => decision.diagnostic);
        const warnings = [...policyMessages, ...deferredMessages];

        const resolvedModel = state.modelApplied ? `${state.provider}/${state.model} thinking:${state.thinkingLevel ?? "Pi default"}` : "none";
        const modelLine = `\nResolved model: ${resolvedModel}`;
        const targetLine = `\nModel preference order: ${state.requestedModels.join(" → ") || state.targetModel || "none"}`;
        const suffix = warnings.length > 0 ? `\nWarnings:\n- ${warnings.join("\n- ")}` : "";
        ctx.ui.notify(`MMR mode activated: ${mode.displayName} (${mode.key})${targetLine}${modelLine}${suffix}`, warnings.length > 0 ? "warning" : "info");
      }

      return state;
    } finally {
      // Defer the guard reset by one microtask so that any `model_select` /
      // `thinking_level_select` events Pi delivers synchronously after
      // pi.setModel/setThinkingLevel inside this transaction still see
      // applyingMmrMode === true and bypass the native-control opt-out path.
      // If Pi ever delivers those events asynchronously, this defer is what
      // keeps the guard correct; revisit if event delivery semantics change.
      await Promise.resolve();
      endApplyingMmrMode();
    }
  }

  async function resolveInitialMode(ctx: ExtensionContext): Promise<void> {
    const loadedSettings = loadMmrCoreSettings(ctx.cwd);
    configuredModelPreferences = loadedSettings.settings.modelPreferences ?? {};
    configuredSubagentModelPreferences = loadedSettings.settings.subagentModelPreferences ?? {};
    configuredLockedModeExtraTools = loadedSettings.settings.lockedModeExtraTools ?? {};
    autoCompactor.setSetting(loadedSettings.settings.autoCompact);
    configuredEditTools = loadedSettings.settings.editTools ?? "auto";
    toolDisableMatcher = createMmrToolDisableMatcher(loadedSettings.settings.toolsDisable);
    settingsFilesRead = [...loadedSettings.filesRead];
    settingsWarnings = [...loadedSettings.warnings];
    notifyWarnings(ctx, loadedSettings.warnings);

    const entries = ctx.sessionManager.getEntries();
    modeLockEnabled = loadedSettings.settings.modeLock !== false;
    sessionHasUserMessage = hasMmrUserMessage(entries);

    const persisted = findLatestPersistedModeState(entries);
    const selection = resolveMmrModeSelection({
      flagValue: readPreferredFlag(pi, "ampi-mode", "mmr-mode"),
      persistedMode: persisted?.mode,
      settingsMode: loadedSettings.settings.defaultMode,
      defaultMode: DEFAULT_MMR_MODE,
    });

    notifyWarnings(ctx, selection.warnings);
    await applyMode(selection.mode, ctx, {
      source: selection.source,
      persist: selection.source === "flag",
      notify: selection.source === "flag",
      rejectedSources: selection.rejectedSources,
      overrideModeLock: true,
    });
    // A failed apply keeps the previous session's state; give it this session's lock.
    publishModeLock();
  }

  function noteUserMessage(): void {
    if (sessionHasUserMessage) return;
    sessionHasUserMessage = true;
    publishModeLock();
  }

  async function switchLockedModeToFreeForNativeControl(
    ctx: ExtensionContext,
    options: Pick<ApplyModeOptions, "nativeModel" | "nativeThinkingLevel"> = {},
  ): Promise<void> {
    const state = getMmrModeState();
    if (!state || state.mode === "free") {
      captureBaseline(ctx, {
        force: true,
        model: options.nativeModel ?? ctx.model,
        thinkingLevel: options.nativeThinkingLevel ?? safeGetThinkingLevel(),
      });
      updateMmrStatus(ctx, state);
      return;
    }

    await applyMode("free", ctx, {
      source: "native",
      persist: true,
      notify: true,
      nativeControlOptOut: true,
      // Pi has already switched the model or thinking level; follow it.
      overrideModeLock: true,
      ...options,
    });
  }

  /**
   * Re-apply Medium's context cap if the active model drifted back to an
   * uncapped window. The only Pi path that re-resolves the active model from
   * the registry (wiping our capped clone) is `_refreshCurrentModelFromRegistry`,
   * reached from provider (un)registration — e.g. `/login` or another
   * extension registering a provider. ampi-core never calls Pi's
   * `registerProvider`, so the override normally survives; this is the narrow,
   * self-healing repair for the transient drift case.
   *
   * Guards (ALL must hold before acting), so this never fights a genuine
   * native model change (which opts out to Free mode) or a subagent/in-flight
   * MMR transaction:
   *   - a locked mode is active (the per-mode cap below no-ops for `free`)
   *   - no subagent worker is active
   *   - no MMR-managed model update is in flight and we are not mid-apply
   *   - no MMR-managed model override is in effect (defer to its owner; the
   *     `before_provider_request` hook likewise skips policy under an override)
   *   - the active model still matches the locked-mode provider/id
   *   - capping the active model would actually change its window
   */
  async function reassertActiveModelInvariants(ctx: ExtensionContext): Promise<void> {
    const state = getMmrModeState();
    if (!state) return;
    if (getMmrSubagentState()) return;
    if (applyingMmrMode || isMmrManagedModelUpdateActive()) return;
    // A managed model override means another MMR path owns the active model;
    // do not re-cap underneath it, even when provider/id still match.
    if (getMmrManagedModelOverride()) return;

    const active = ctx.model;
    if (!active) return;
    // Do not fight a genuine native model change; that path releases to Free.
    if (active.provider !== state.provider || active.id !== state.model) return;

    // Cap to the active mode's advertised window. No-op for `free`, for modes
    // whose route is already at/under the profile, and when nothing changes.
    const capped = withMmrModeContextCap(state.mode, active);
    if (capped === active) return;

    applyingMmrMode = true;
    try {
      await pi.setModel(capped);
    } finally {
      // Mirror applyMode's microtask defer so the `model_select` Pi delivers
      // synchronously during setModel's await still sees applyingMmrMode ===
      // true and bypasses the native-control opt-out. (Re-capping the same
      // provider/id leaves the thinking level unchanged, so the fire-and-forget
      // `thinking_level_select` path is not exercised here.)
      await Promise.resolve();
      endApplyingMmrMode();
    }
  }

  /** Resolve the locked mode's tools and feature gates again and apply them; `state` is the live locked state. */
  function reapplyLockedModeTools(state: MmrModeState & { mode: MmrLockedModeKey }, editTools: MmrEditToolFamilyDecision, cwd: string): void {
    const tools = resolveLockedModeTools(state.mode, editTools, pi.getAllTools(), cwd);
    pi.setActiveTools(tools.activeTools);
    setMmrModeState({
      ...state,
      editTools,
      requestedTools: [...tools.requestedTools],
      activeTools: [...tools.activeTools],
      missingTools: [...tools.missingTools],
      deferredTools: [...tools.deferredTools],
      gatedTools: [...tools.gatedTools],
      disabledTools: [...tools.disabledTools],
      resolution: {
        ...state.resolution,
        toolDecisions: tools.decisions.map((decision) => ({ ...decision })),
        featureGateDecisions: resolveMmrFeatureGates(getMmrMode(state.mode).featureGates ?? []),
      },
    });
    publishStateChange();
  }

  function refreshEditTools(state: MmrModeState | undefined): void {
    // A refresh held back during a managed model update runs with the next
    // state change or user input; it covers the edit tool family too.
    if (toolRefreshPending && !applyingMmrMode && !isMmrManagedModelUpdateActive()) {
      refreshModeTools();
      return;
    }
    if (!state?.editTools || state.mode === "free" || !lockedModeCwd || getMmrSubagentState()) return;
    const editTools = resolveMmrEditToolFamily(state.provider, configuredEditTools);
    if (editTools.family === state.editTools.family && editTools.provider === state.editTools.provider) return;
    reapplyLockedModeTools(state as MmrModeState & { mode: MmrLockedModeKey }, editTools, lockedModeCwd);
  }

  function refreshModeTools(): void {
    if (applyingMmrMode || isMmrManagedModelUpdateActive()) {
      // The apply in progress may already have resolved its tools; run once it ends.
      toolRefreshPending = true;
      return;
    }
    toolRefreshPending = false;
    const state = getMmrModeState();
    if (!state?.editTools || state.mode === "free" || !lockedModeCwd || getMmrSubagentState()) return;
    const editTools = resolveMmrEditToolFamily(state.provider, configuredEditTools);
    reapplyLockedModeTools(state as MmrModeState & { mode: MmrLockedModeKey }, editTools, lockedModeCwd);
  }

  function flushToolRefresh(): void {
    if (toolRefreshPending) refreshModeTools();
  }

  /** Clear the apply guard, then run a tool refresh that arrived during the apply. */
  function endApplyingMmrMode(): void {
    applyingMmrMode = false;
    if (toolRefreshPending) refreshModeTools();
  }

  async function selectModeFromShortcut(ctx: ExtensionContext): Promise<void> {
    if (ctx.hasUI === false) return;

    const currentMode = getMmrModeState()?.mode;
    if (currentMode && currentModeLock().locked) {
      notifyModeLocked(ctx, currentMode);
      return;
    }
    const title = currentMode ? `MMR mode (current: ${currentMode})` : "MMR mode";
    const choice = await ctx.ui.select(title, [...MMR_HOTKEY_MODE_KEYS]);
    if (!choice || !isMmrModeKey(choice)) return;

    await applyMode(choice, ctx, { source: "command", persist: true, notify: true });
  }

  function getNextCycledMode(): MmrModeKey {
    const currentMode = getMmrModeState()?.mode;
    const currentIndex = currentMode ? CYCLABLE_MMR_MODE_KEYS.indexOf(currentMode) : -1;
    const nextIndex = (currentIndex + 1) % CYCLABLE_MMR_MODE_KEYS.length;
    return CYCLABLE_MMR_MODE_KEYS[nextIndex] ?? DEFAULT_MMR_MODE;
  }

  async function cycleModeNow(ctx: ExtensionContext): Promise<void> {
    await applyMode(getNextCycledMode(), ctx, { source: "command", persist: true, notify: true });
  }

  async function cycleModeFromShortcut(ctx: ExtensionContext): Promise<void> {
    const run = modeCycleQueue.then(() => cycleModeNow(ctx), () => cycleModeNow(ctx));
    // Keep the queue alive across failures, but surface the error so a
    // persistent fault (e.g. registry/setModel crashes) is not silently
    // swallowed every time the user presses the cycle shortcut.
    modeCycleQueue = run.then(
      () => undefined,
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`MMR mode cycle failed: ${message}`, "error");
      },
    );
    await run;
  }

  function formatToggleBudget(tokens: number | undefined): string {
    if (typeof tokens !== "number" || !Number.isFinite(tokens)) return "";
    const value = tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
    return `, max out ${value}`;
  }

  async function toggleThinkingNow(ctx: ExtensionContext): Promise<void> {
    // Re-read live state inside the queued task so rapid presses toggle from
    // the latest applied level, not a snapshot captured at enqueue time. The
    // toggle is bound to an MMR-owned shortcut (not Pi's reserved thinking
    // cycle), so MMR fully controls the level and its on-screen feedback.
    const state = getMmrModeState();
    if (!state || !isToggleableMmrMode(state.mode)) {
      if (state && ctx.hasUI !== false) {
        ctx.ui.notify(
          `MMR thinking toggle is only available in medium, high, or ultra (current: ${state?.mode ?? "none"}).`,
          "info",
        );
      }
      return;
    }
    const modeKey: MmrToggleableModeKey = state.mode;
    const previous = modeThinkingOverrides[modeKey];
    const next = getOtherToggleThinkingLevel(modeKey, state.thinkingLevel);
    modeThinkingOverrides[modeKey] = next;
    // notify:false keeps the toggle quiet — no full "mode activated" banner or
    // deferred-tool warnings on every press; a concise line is emitted below.
    const applied = await applyMode(modeKey, ctx, { source: "command", persist: true, notify: false });
    if (!applied || applied.mode !== modeKey || applied.thinkingLevel !== next) {
      // Re-apply did not land the toggled level (model not applied, zero active
      // tools, etc.); roll the override back so it matches the still-active state.
      if (previous === undefined) delete modeThinkingOverrides[modeKey];
      else modeThinkingOverrides[modeKey] = previous;
      if (ctx.hasUI !== false) ctx.ui.notify(`MMR thinking toggle failed for ${modeKey}.`, "error");
      return;
    }
    if (ctx.hasUI !== false) {
      ctx.ui.notify(`MMR thinking: ${modeKey} → ${next}${formatToggleBudget(applied.effectiveMaxOutputTokens)}`, "info");
    }
  }

  async function toggleThinkingFromShortcut(ctx: ExtensionContext): Promise<void> {
    const run = thinkingToggleQueue.then(() => toggleThinkingNow(ctx), () => toggleThinkingNow(ctx));
    thinkingToggleQueue = run.then(
      () => undefined,
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`MMR thinking toggle failed: ${message}`, "error");
      },
    );
    await run;
  }

  return {
    applyMode,
    resolveInitialMode,
    noteUserMessage,
    switchLockedModeToFreeForNativeControl,
    reassertActiveModelInvariants,
    refreshEditTools,
    refreshModeTools,
    flushToolRefresh,
    captureBaseline,
    selectModeFromShortcut,
    cycleModeFromShortcut,
    toggleThinkingFromShortcut,
    getActivePolicy: () => activePolicy,
    isApplyingMmrMode: () => applyingMmrMode,
    getConfiguredModelPreferences: () => configuredModelPreferences,
    getConfiguredSubagentModelPreferences: () => configuredSubagentModelPreferences,
    setConfiguredModePreferences: (mode, preferences) => {
      if (preferences) configuredModelPreferences[mode] = preferences;
      else delete configuredModelPreferences[mode];
    },
    setConfiguredSubagentPreferences: (profile, preferences) => {
      if (preferences) configuredSubagentModelPreferences[profile] = preferences;
      else delete configuredSubagentModelPreferences[profile];
    },
    setConfiguredSubagentModelPreferences: (preferences) => {
      configuredSubagentModelPreferences = preferences;
    },
    setSettingsFilesRead: (files) => {
      settingsFilesRead = files;
    },
    setSettingsWarnings: (warnings) => {
      settingsWarnings = warnings;
    },
    setApplyingMmrMode: (value) => {
      applyingMmrMode = value;
    },
    getAutoCompactor: () => autoCompactor,
    setToolDisableMatcher: (matcher) => {
      toolDisableMatcher = matcher;
    },
    matchDisabledTool: (name) =>
      toolDisableMatcher.entries.length === 0 ? undefined : matchMmrDisabledTool(toolDisableMatcher, name, pi.getAllTools()),
    listDisabledTools: () => listMmrDisabledTools(toolDisableMatcher, pi.getAllTools()),
  };
}
