import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { selectMmrModelRoute } from "./model-resolver.js";
import { getMmrModeName, getMmrRegisteredMode } from "./mode-registry.js";
import { MMR_MODES } from "./modes.js";
import { getDefaultToggleThinkingLevel, isToggleableMmrMode } from "./request-policy.js";
import { getMmrModeState } from "./runtime.js";
import { loadMmrCoreSettings } from "./settings.js";
import { getMmrSubagentProfile } from "./subagent-profiles.js";
import type { MmrCoreSettings, MmrModeKey, MmrModelPreference } from "./types.js";

/** One model a mode would run: Pi's provider and model id, and the thinking level it would ask for. */
export interface MmrModeRoute {
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel?: string;
}

/** The models a mode would run: the main agent and the oracle subagent; a missing one has no usable model. */
export interface MmrModeRouteSet {
  readonly agent?: MmrModeRoute;
  readonly oracle?: MmrModeRoute;
}

function isBuiltinMode(mode: string): mode is MmrModeKey {
  return Object.hasOwn(MMR_MODES, mode);
}

/**
 * Read, without applying anything, the models a mode would run. The active
 * mode reports what ampi-core applied (thinking toggles included). Other
 * modes are resolved from their model preferences, with project and user
 * overrides, against Pi's model registry, the way ampi-core would resolve
 * them on a switch; a registered mode by its own preferences, or else its
 * base mode's. The oracle follows the oracle subagent profile and its
 * overrides. `free` names Pi's own model and no oracle, since it drops
 * ampi's tools. Settings are read once per reader and only when first needed.
 */
export function createMmrModeRouteResolver(ctx: Pick<ExtensionContext, "cwd" | "model" | "modelRegistry">): (mode: string) => MmrModeRouteSet {
  let settings: MmrCoreSettings | undefined;
  const readSettings = (): MmrCoreSettings => {
    settings ??= loadMmrCoreSettings(ctx.cwd).settings;
    return settings;
  };
  const resolved = new Map<string, MmrModeRoute | undefined>();

  function select(key: string, preferences: readonly MmrModelPreference[], thinking: MmrModelPreference["thinkingLevel"]): MmrModeRoute | undefined {
    if (!resolved.has(key)) {
      let route: MmrModeRoute | undefined;
      try {
        const { selected } = selectMmrModelRoute({ modelPreferences: preferences, modeThinkingLevel: thinking, registry: ctx.modelRegistry });
        if (selected) route = { provider: selected.provider, model: selected.model, thinkingLevel: selected.thinkingLevel };
      } catch {}
      resolved.set(key, route);
    }
    return resolved.get(key);
  }

  function agent(mode: string): MmrModeRoute | undefined {
    if (mode === "free") return ctx.model ? { provider: ctx.model.provider, model: ctx.model.id } : undefined;
    const state = getMmrModeState();
    if (state && getMmrModeName(state) === mode && state.modelApplied) {
      return { provider: state.provider, model: state.model, thinkingLevel: state.thinkingLevel };
    }
    const registered = isBuiltinMode(mode) ? undefined : getMmrRegisteredMode(mode);
    const base = isBuiltinMode(mode) ? mode : registered?.baseMode;
    if (!base) return undefined;
    const definition = MMR_MODES[base];
    const preferences = registered?.modelPreferences ?? readSettings().modelPreferences?.[base] ?? definition.modelPreferences;
    // As on a switch, a mode with thinking presets runs every route at its
    // first preset, or at the level a registered mode sets.
    const toggle = isToggleableMmrMode(base) ? (registered?.thinkingLevel ?? getDefaultToggleThinkingLevel(base)) : registered?.thinkingLevel;
    const routed = toggle ? preferences.map((preference) => ({ ...preference, thinkingLevel: toggle })) : preferences;
    return select(`mode:${mode}`, routed, toggle ?? definition.thinkingLevel);
  }

  function oracle(): MmrModeRoute | undefined {
    const profile = getMmrSubagentProfile("oracle");
    if (!profile) return undefined;
    const preferences = readSettings().subagentModelPreferences?.oracle ?? profile.modelPreferences;
    return select("oracle", preferences, profile.thinkingLevel);
  }

  return (mode) => ({ agent: agent(mode), oracle: mode === "free" ? undefined : oracle() });
}
