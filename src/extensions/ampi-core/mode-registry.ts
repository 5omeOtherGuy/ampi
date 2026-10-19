import { isThinkingLevel } from "./settings.js";
import type { MmrToggleThinkingLevel } from "./request-policy.js";
import type { MmrLockedModeKey, MmrModeKey, MmrModelPreference, MmrModeState } from "./types.js";
import { MMR_LEGACY_MODE_ALIASES, MMR_MODE_KEYS, resolveMmrModeKey } from "./modes.js";

/**
 * Registry of modes that other extensions add. A registered mode has its own
 * key, label, description and label colour, and runs as one of the four
 * locked modes (its base mode) with the overrides its definition names.
 *
 * Extensions register through {@link registerMmrMode}, or without importing
 * ampi by emitting a definition on {@link MMR_EVENT_REGISTER_MODE}. ampi-core
 * collects bus registrations from its factory onwards and asks for them again
 * with {@link MMR_EVENT_MODES_READY}; see `connectMmrModeRegistryEvents`.
 */

/** Thinking levels a registered mode may set: those its request policy can carry on every provider. */
export type MmrRegisteredModeThinkingLevel = MmrToggleThinkingLevel;

/** What an extension passes to register a mode. */
export interface MmrRegisteredModeDefinition {
  /** Lowercase letters, digits and dashes, 1 to 32 characters. */
  readonly key: string;
  /** Shown in compact pickers and the prompt box; up to 24 characters. Defaults to the key. */
  readonly label?: string;
  /** One line saying what the mode is for; up to 200 characters. */
  readonly description?: string;
  /** Label colour, `#rrggbb`. */
  readonly color: string;
  /**
   * The registering extension, for example its package name; up to 100
   * characters. Reads `extension` when unset. Only a registration that names
   * the same source can replace this one.
   */
  readonly source?: string;
  /** The locked mode it runs as; defaults to `medium`. */
  readonly baseMode?: MmrLockedModeKey;
  /** Replaces the base mode's effective model preferences. */
  readonly modelPreferences?: readonly MmrModelPreference[];
  /** Replaces the base mode's default thinking level. */
  readonly thinkingLevel?: MmrRegisteredModeThinkingLevel;
  /** Exact Pi tool names replacing the base mode's tool list. */
  readonly tools?: readonly string[];
  /** Text appended to the system prompt while the mode is active; up to 4000 characters. */
  readonly promptAppend?: string;
}

/** A registration as the registry holds it: validated, normalized and frozen. */
export interface MmrRegisteredMode {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  /** `#rrggbb`, lowercase. */
  readonly color: string;
  readonly source: string;
  readonly baseMode: MmrLockedModeKey;
  readonly modelPreferences?: readonly MmrModelPreference[];
  readonly thinkingLevel?: MmrRegisteredModeThinkingLevel;
  readonly tools?: readonly string[];
  readonly promptAppend?: string;
}

export type MmrModesChange = "registered" | "unregistered";

export interface MmrModesChangedEvent {
  readonly change: MmrModesChange;
  readonly key: string;
}

export type MmrModesChangedListener = (event: MmrModesChangedEvent) => void;

/** Emit a {@link MmrRegisteredModeDefinition} on this event to register a mode without importing ampi. */
export const MMR_EVENT_REGISTER_MODE = "ampi-core:register-mode";
/** Emit `{ key }` on this event to remove a mode registered over the event bus. */
export const MMR_EVENT_UNREGISTER_MODE = "ampi-core:unregister-mode";
/**
 * ampi-core emits `{ version: 1 }` on this event from its factory and at the
 * start of every session; an extension that registers over the bus emits its
 * definitions again, synchronously, when it hears it.
 */
export const MMR_EVENT_MODES_READY = "ampi-core:modes-ready";

/** The source a registration reads without one. */
export const MMR_REGISTERED_MODE_DEFAULT_SOURCE = "extension";
export const MMR_REGISTERED_MODE_KEY_MAX = 32;
export const MMR_REGISTERED_MODE_LABEL_MAX = 24;
export const MMR_REGISTERED_MODE_DESCRIPTION_MAX = 200;
export const MMR_REGISTERED_MODE_SOURCE_MAX = 100;
export const MMR_REGISTERED_MODE_PROMPT_APPEND_MAX = 4000;

/** Values of Pi's own `--mode`, which `ampi --mode` hands to Pi. */
const PI_OUTPUT_MODES = ["text", "json", "rpc"] as const;
const RESERVED_NAMES: ReadonlySet<string> = new Set([...MMR_MODE_KEYS, ...Object.keys(MMR_LEGACY_MODE_ALIASES), ...PI_OUTPUT_MODES]);
const BASE_MODES: readonly MmrLockedModeKey[] = ["low", "medium", "high", "ultra"];
const THINKING_LEVELS: readonly MmrRegisteredModeThinkingLevel[] = ["low", "medium", "high", "xhigh"];
const KEY_PATTERN = /^[a-z0-9-]+$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
// C0 and C1 controls, DEL, line and paragraph separators (U+2028, U+2029),
// which break a line, and format characters (bidi overrides and isolates,
// zero-width characters), which could disguise a label in a list.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]|[\p{Cf}\p{Zl}\p{Zp}]/u;

interface ModeStore {
  /** By lowercase key, in registration order. */
  readonly modes: Map<string, MmrRegisteredMode>;
  readonly listeners: Set<MmrModesChangedListener>;
}

// globalThis-anchored so every extension sees one registry even when Pi
// loads ampi-core modules under distinct module identities, or a third-party
// extension ships its own copy of this module.
const MODES_GLOBAL_KEY = "__pi_ampi_modes_v1__";
const globalStore = globalThis as typeof globalThis & { [MODES_GLOBAL_KEY]?: ModeStore };
const store: ModeStore = globalStore[MODES_GLOBAL_KEY] ?? { modes: new Map(), listeners: new Set() };
globalStore[MODES_GLOBAL_KEY] = store;

function notify(change: MmrModesChange, key: string): void {
  const event: MmrModesChangedEvent = { change, key };
  for (const listener of [...store.listeners]) {
    // As in command-registry.ts: a failing listener neither undoes the
    // change nor starves the listeners after it.
    try {
      listener(event);
    } catch {}
  }
}

function describe(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : String(value);
}

function checkLength(value: string, field: string, key: string, max: number): void {
  if ([...value].length > max) throw new Error(`Mode "${key}": ${field} must be at most ${max} characters.`);
}

function readLine(def: Record<string, unknown>, field: string, key: string, max: number): string | undefined {
  const value = def[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Mode "${key}": ${field} must be a non-empty string.`);
  if (CONTROL_CHARACTERS.test(value)) throw new Error(`Mode "${key}": ${field} must be one line without control or format characters.`);
  if (value.trim() !== value) throw new Error(`Mode "${key}": ${field} must not start or end with whitespace.`);
  checkLength(value, field, key, max);
  return value;
}

function readStringList(def: Record<string, unknown>, field: string, key: string): string[] | undefined {
  const value = def[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw new Error(`Mode "${key}": ${field} must be a non-empty array of strings.`);
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) throw new Error(`Mode "${key}": ${field} must hold non-empty strings.`);
  }
  return [...new Set(value as string[])];
}

function readModelPreferences(def: Record<string, unknown>, key: string): MmrModelPreference[] | undefined {
  const value = def.modelPreferences;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw new Error(`Mode "${key}": modelPreferences must be a non-empty array.`);
  return value.map((entry, index) => {
    const at = `modelPreferences[${index}]`;
    if (typeof entry !== "object" || entry === null) throw new Error(`Mode "${key}": ${at} must be an object.`);
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.model !== "string" || candidate.model.trim().length === 0) throw new Error(`Mode "${key}": ${at}.model must be a non-empty string.`);
    const preference: MmrModelPreference = { model: candidate.model };
    if (candidate.providers !== undefined) {
      const providers = candidate.providers;
      if (!Array.isArray(providers) || providers.length === 0 || providers.some((provider) => typeof provider !== "string" || provider.length === 0)) {
        throw new Error(`Mode "${key}": ${at}.providers must be a non-empty array of strings.`);
      }
      preference.providers = [...providers];
    }
    if (candidate.thinkingLevel !== undefined) {
      if (!isThinkingLevel(candidate.thinkingLevel)) throw new Error(`Mode "${key}": ${at}.thinkingLevel ${describe(candidate.thinkingLevel)} is not a Pi thinking level.`);
      preference.thinkingLevel = candidate.thinkingLevel;
    }
    return preference;
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Validate a definition on its own, without looking at the registry. Throws
 * an Error naming the first problem.
 */
export function normalizeMmrModeDefinition(input: unknown): MmrRegisteredMode {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("A mode definition must be an object.");
  const def = input as Record<string, unknown>;
  const key = def.key;
  if (typeof key !== "string" || key.length === 0 || key.length > MMR_REGISTERED_MODE_KEY_MAX || !KEY_PATTERN.test(key)) {
    throw new Error(`Invalid mode key ${describe(key)}: use 1 to ${MMR_REGISTERED_MODE_KEY_MAX} lowercase letters, digits and dashes.`);
  }
  if (RESERVED_NAMES.has(key)) throw new Error(`Mode key "${key}" is reserved for a built-in mode, alias or Pi output mode.`);

  const label = readLine(def, "label", key, MMR_REGISTERED_MODE_LABEL_MAX) ?? key;
  if (RESERVED_NAMES.has(label.toLowerCase())) throw new Error(`Mode "${key}": label "${label}" names a built-in mode, alias or Pi output mode.`);
  const description = readLine(def, "description", key, MMR_REGISTERED_MODE_DESCRIPTION_MAX);
  const source = readLine(def, "source", key, MMR_REGISTERED_MODE_SOURCE_MAX) ?? MMR_REGISTERED_MODE_DEFAULT_SOURCE;

  if (typeof def.color !== "string" || !COLOR_PATTERN.test(def.color)) {
    throw new Error(`Mode "${key}": color ${describe(def.color)} must be written as #rrggbb.`);
  }

  const baseMode = def.baseMode ?? "medium";
  if (typeof baseMode !== "string" || !(BASE_MODES as readonly string[]).includes(baseMode)) {
    throw new Error(`Mode "${key}": baseMode ${describe(baseMode)} must be low, medium, high or ultra.`);
  }

  const thinkingLevel = def.thinkingLevel;
  if (thinkingLevel !== undefined && (typeof thinkingLevel !== "string" || !(THINKING_LEVELS as readonly string[]).includes(thinkingLevel))) {
    throw new Error(`Mode "${key}": thinkingLevel ${describe(thinkingLevel)} must be low, medium, high or xhigh.`);
  }

  const promptAppend = def.promptAppend;
  if (promptAppend !== undefined && typeof promptAppend !== "string") throw new Error(`Mode "${key}": promptAppend must be a string.`);
  if (typeof promptAppend === "string") checkLength(promptAppend, "promptAppend", key, MMR_REGISTERED_MODE_PROMPT_APPEND_MAX);

  const modelPreferences = readModelPreferences(def, key);
  const tools = readStringList(def, "tools", key);
  return deepFreeze({
    key,
    label,
    ...(description !== undefined ? { description } : {}),
    color: def.color.toLowerCase(),
    source,
    baseMode: baseMode as MmrLockedModeKey,
    ...(modelPreferences ? { modelPreferences } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel: thinkingLevel as MmrRegisteredModeThinkingLevel } : {}),
    ...(tools ? { tools } : {}),
    ...(typeof promptAppend === "string" && promptAppend.trim().length > 0 ? { promptAppend } : {}),
  });
}

function sameMode(a: MmrRegisteredMode, b: MmrRegisteredMode): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Validate and store a definition. An identical definition changes nothing
 * (an extension answering {@link MMR_EVENT_MODES_READY} again). A different
 * one replaces the held registration only when both name the same source;
 * neither the API nor the event bus says which extension is calling, so a
 * definition without a source (read as the default) never replaces another.
 * Any other clash throws.
 */
function addMode(input: unknown): MmrRegisteredMode {
  const mode = normalizeMmrModeDefinition(input);
  const id = mode.key.toLowerCase();
  const held = store.modes.get(id);
  if (held && held.source !== mode.source) {
    throw new Error(`Mode key "${mode.key}" is already registered by ${held.source}.`);
  }
  if (held && mode.source === MMR_REGISTERED_MODE_DEFAULT_SOURCE && !sameMode(held, mode)) {
    throw new Error(`Mode key "${mode.key}" is already registered; a registration that replaces it must name its source.`);
  }
  const label = mode.label.toLowerCase();
  for (const [otherId, other] of store.modes) {
    if (otherId === id) continue;
    if (other.label.toLowerCase() === id) throw new Error(`Mode key "${mode.key}" is already the label of mode "${other.key}".`);
    if (otherId === label || other.label.toLowerCase() === label) {
      throw new Error(`Mode "${mode.key}": label "${mode.label}" is already taken by mode "${other.key}".`);
    }
  }
  if (held && sameMode(held, mode)) return held;
  store.modes.set(id, mode);
  notify("registered", mode.key);
  return mode;
}

function removeMode(mode: MmrRegisteredMode): boolean {
  const id = mode.key.toLowerCase();
  if (store.modes.get(id) !== mode) return false;
  store.modes.delete(id);
  notify("unregistered", mode.key);
  return true;
}

/**
 * Register a mode. Returns a function that removes it again; that function
 * does nothing once the registration has been replaced or removed. Throws on
 * an invalid definition or a key or label another registration holds.
 */
export function registerMmrMode(def: MmrRegisteredModeDefinition): () => void {
  let mode: MmrRegisteredMode | undefined = addMode(def);
  return () => {
    if (mode) removeMode(mode);
    mode = undefined;
  };
}

/** Remove a registered mode by key. Returns false when none had that key. */
export function unregisterMmrMode(key: string): boolean {
  const mode = store.modes.get(key.toLowerCase());
  return mode ? removeMode(mode) : false;
}

/** Registered modes in registration order. */
export function listMmrModes(): readonly MmrRegisteredMode[] {
  return [...store.modes.values()];
}

/** A registered mode by key, compared case-insensitively. */
export function getMmrRegisteredMode(key: string): MmrRegisteredMode | undefined {
  return store.modes.get(key.toLowerCase());
}

/**
 * The registered mode a typed name means: its key or its label, compared
 * case-insensitively. Built-in names never resolve here; check them first.
 */
export function resolveMmrRegisteredMode(name: string): MmrRegisteredMode | undefined {
  const wanted = name.trim().toLowerCase();
  if (wanted.length === 0) return undefined;
  const byKey = store.modes.get(wanted);
  if (byKey) return byKey;
  for (const mode of store.modes.values()) if (mode.label.toLowerCase() === wanted) return mode;
  return undefined;
}

/**
 * What a typed mode name means: a built-in key or alias (exact, as
 * `resolveMmrModeKey`), else a registered mode by key or label. `mode` is the
 * built-in key, or the registered mode's base mode.
 */
export function resolveMmrModeName(name: string): { mode: MmrModeKey; registered?: MmrRegisteredMode } | undefined {
  const builtin = resolveMmrModeKey(name);
  if (builtin) return { mode: builtin };
  const registered = resolveMmrRegisteredMode(name);
  return registered ? { mode: registered.baseMode, registered } : undefined;
}

/** The name a session's mode goes by: the registered key when one is active, else the mode key. */
export function getMmrModeName(state: Pick<MmrModeState, "mode" | "registeredMode">): string {
  return state.registeredMode?.key ?? state.mode;
}

/**
 * Listen for registry changes. Returns an unsubscribe function. A listener
 * that throws is skipped; the change and the other listeners are unaffected.
 */
export function onMmrModesChanged(listener: MmrModesChangedListener): () => void {
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

/** Remove every registration, telling listeners about each. ampi-core calls it when a session shuts down. */
export function clearMmrModes(): void {
  for (const mode of [...store.modes.values()]) removeMode(mode);
}

/** Test-only: clear modes and listeners. Production code must not call this. */
export function __resetMmrModesForTests(): void {
  store.modes.clear();
  store.listeners.clear();
}

/** The slice of Pi's event bus the bus protocol needs. */
export interface MmrModeRegistryEventHost {
  events: {
    emit(eventName: string, data: unknown): void;
    /** Pi's bus returns an unsubscribe function; a host that returns nothing is tolerated. */
    on(eventName: string, handler: (data: unknown) => void): unknown;
  };
}

export interface MmrModeRegistryEvents {
  /** Emit {@link MMR_EVENT_MODES_READY}; listening extensions register again before it returns. */
  emitReady(): void;
  /** Refused bus registrations not reported yet; each is returned once. */
  takeWarnings(): string[];
  /** Every refused bus registration of this runtime, reported or not. */
  listWarnings(): readonly string[];
  /** Stop listening and forget the warnings. */
  dispose(): void;
}

/**
 * Listen for registrations over the event bus. A refused one is kept as a
 * warning, once per distinct message, for ampi-core to show. Only modes
 * that came over the bus can be removed over it.
 */
export function connectMmrModeRegistryEvents(pi: MmrModeRegistryEventHost): MmrModeRegistryEvents {
  const viaBus = new Set<MmrRegisteredMode>();
  const warnings: string[] = [];
  let reported = 0;

  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };

  const offRegister = pi.events.on(MMR_EVENT_REGISTER_MODE, (data) => {
    try {
      viaBus.add(addMode(data));
    } catch (error) {
      warn(`Refused a mode registration: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const offUnregister = pi.events.on(MMR_EVENT_UNREGISTER_MODE, (data) => {
    // Reading `key` runs the payload's getters; a throwing one is ignored like any malformed message.
    try {
      const key = typeof data === "object" && data !== null ? (data as { key?: unknown }).key : undefined;
      if (typeof key !== "string") return;
      const mode = getMmrRegisteredMode(key);
      if (mode && viaBus.has(mode)) removeMode(mode);
    } catch {}
  });

  return {
    emitReady: () => pi.events.emit(MMR_EVENT_MODES_READY, { version: 1 }),
    takeWarnings: () => {
      const fresh = warnings.slice(reported);
      reported = warnings.length;
      return fresh;
    },
    listWarnings: () => [...warnings],
    dispose: () => {
      if (typeof offRegister === "function") offRegister();
      if (typeof offUnregister === "function") offUnregister();
      viaBus.clear();
      warnings.length = 0;
      reported = 0;
    },
  };
}
