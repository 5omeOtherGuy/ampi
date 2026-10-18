import { isRecord } from "./internal/json.js";

/**
 * Keymap model: key-string grammar, settings overrides, and the effective
 * command-id -> key-chord map.
 *
 * Grammar:
 *
 * - A chord is one or more key combos separated by spaces: `ctrl+c ctrl+n`,
 *   `esc esc`.
 * - A combo is zero or more modifiers plus one key, joined by `+`. Names are
 *   case-insensitive. Modifiers are `ctrl`, `alt`, `shift`, `meta`, with the
 *   aliases `option` (alt), `cmd` / `command` (meta), and `mod`, which always
 *   means `ctrl` here, on every platform.
 * - Keys: `esc` (`escape`), `enter` (`return`), `space`, `tab`, `backspace`,
 *   `delete`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup` (`pgup`),
 *   `pagedown` (`pgdn`), `f1` to `f12`, or any single character. `+` is a key
 *   too (`ctrl++`). A lone uppercase letter means shift plus that letter
 *   (`Z` is `shift+z`); next to a modifier, letter case does not matter, so
 *   the display form `Ctrl+C` reads back as `ctrl+c`.
 * - `<leader>` stands for the configured leader combo (default `ctrl+x`). It
 *   may only start a chord and must be followed by a key: `<leader>z` and
 *   `<leader> z` are the same chord.
 *
 * Nothing here throws on user input: parsing returns `{ error }`, and
 * settings problems are collected in a `problems` list.
 */

export interface MmrKeyCombo {
  /** Canonical lowercase key name, e.g. `c`, `esc`, `pageup`, `f5`, `+`. */
  readonly key: string;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
}

export interface MmrKeyChord {
  /** True when the chord starts with `<leader>`; `combos` then holds the keys pressed after the leader. */
  readonly leader: boolean;
  readonly combos: readonly MmrKeyCombo[];
}

export type MmrKeyChordParseResult = MmrKeyChord | { readonly error: string };

export interface MmrKeyChordFormatOptions {
  /** `canonical` (default): `ctrl+c ctrl+n`. `display`: `Ctrl+C Ctrl+N`. */
  readonly style?: "canonical" | "display";
  /** When given, a leading `<leader>` is replaced by this combo. */
  readonly leader?: MmrKeyCombo;
}

/** A keymap value: one chord, several chords, or `null` for unbound. */
export type MmrKeyBindingValue = string | readonly string[] | null;

export const MMR_DEFAULT_KEYMAP_LEADER = "ctrl+x";

const LEADER_TOKEN = "<leader>";

type ModifierName = "ctrl" | "alt" | "shift" | "meta";
const MODIFIER_ORDER: readonly ModifierName[] = ["ctrl", "alt", "shift", "meta"];

const MODIFIER_ALIASES = new Map<string, ModifierName>([
  ["ctrl", "ctrl"],
  ["mod", "ctrl"],
  ["alt", "alt"],
  ["option", "alt"],
  ["shift", "shift"],
  ["meta", "meta"],
  ["cmd", "meta"],
  ["command", "meta"],
]);

const NAMED_KEYS = new Map<string, string>([
  ["esc", "esc"],
  ["escape", "esc"],
  ["enter", "enter"],
  ["return", "enter"],
  ["space", "space"],
  ["tab", "tab"],
  ["backspace", "backspace"],
  ["delete", "delete"],
  ["up", "up"],
  ["down", "down"],
  ["left", "left"],
  ["right", "right"],
  ["home", "home"],
  ["end", "end"],
  ["pageup", "pageup"],
  ["pgup", "pageup"],
  ["pagedown", "pagedown"],
  ["pgdn", "pagedown"],
]);

const DISPLAY_KEY_NAMES = new Map<string, string>([
  ["esc", "Esc"],
  ["enter", "Enter"],
  ["space", "Space"],
  ["tab", "Tab"],
  ["backspace", "Backspace"],
  ["delete", "Delete"],
  ["up", "Up"],
  ["down", "Down"],
  ["left", "Left"],
  ["right", "Right"],
  ["home", "Home"],
  ["end", "End"],
  ["pageup", "PgUp"],
  ["pagedown", "PgDn"],
]);

const DISPLAY_MODIFIER_NAMES: Record<ModifierName, string> = {
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  meta: "Meta",
};

const FUNCTION_KEY = /^f([1-9]|1[0-2])$/;

function parseCombo(token: string): MmrKeyCombo | string {
  let keyText: string;
  let modifierTexts: string[];
  if (token === "+") {
    keyText = "+";
    modifierTexts = [];
  } else if (token.endsWith("++")) {
    keyText = "+";
    modifierTexts = token.slice(0, -2).split("+");
  } else {
    modifierTexts = token.split("+");
    keyText = modifierTexts.pop() ?? "";
  }
  if (keyText.length === 0) return `"${token}" has no key after the last "+"`;

  const modifiers = new Set<ModifierName>();
  for (const text of modifierTexts) {
    const modifier = MODIFIER_ALIASES.get(text.toLowerCase());
    if (!modifier) return `"${text}" is not a modifier (use ctrl, alt, shift, or meta)`;
    if (modifiers.has(modifier)) return `"${token}" repeats the ${modifier} modifier`;
    modifiers.add(modifier);
  }

  const lower = keyText.toLowerCase();
  let key: string;
  const named = NAMED_KEYS.get(lower);
  if (named) {
    key = named;
  } else if (FUNCTION_KEY.test(lower)) {
    key = lower;
  } else if ([...keyText].length === 1 && !/\s/.test(keyText)) {
    key = lower;
    if (lower !== keyText && modifiers.size === 0) modifiers.add("shift");
  } else {
    return `"${keyText}" is not a key name`;
  }

  return {
    key,
    ctrl: modifiers.has("ctrl"),
    alt: modifiers.has("alt"),
    shift: modifiers.has("shift"),
    meta: modifiers.has("meta"),
  };
}

/**
 * Parse a key string such as `ctrl+c ctrl+n`, `esc esc`, or `<leader>z`.
 * Returns the chord, or `{ error }` with a short reason.
 */
export function parseMmrKeyChord(text: string): MmrKeyChordParseResult {
  if (typeof text !== "string") return { error: "expected a key string" };
  const tokens = text.trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return { error: "empty key string" };

  let leader = false;
  const combos: MmrKeyCombo[] = [];
  for (const [index, token] of tokens.entries()) {
    let rest = token;
    if (rest.toLowerCase().startsWith(LEADER_TOKEN)) {
      if (index > 0) return { error: `${LEADER_TOKEN} may only start a chord: "${text}"` };
      leader = true;
      rest = rest.slice(LEADER_TOKEN.length);
      if (rest.length === 0) continue;
    }
    if (rest.toLowerCase().includes(LEADER_TOKEN)) {
      return { error: `${LEADER_TOKEN} may only start a chord: "${text}"` };
    }
    const combo = parseCombo(rest);
    if (typeof combo === "string") return { error: `${combo} in "${text}"` };
    combos.push(combo);
  }
  if (combos.length === 0) return { error: `${LEADER_TOKEN} must be followed by a key: "${text}"` };
  return { leader, combos };
}

function formatCombo(combo: MmrKeyCombo, display: boolean): string {
  const parts: string[] = [];
  for (const modifier of MODIFIER_ORDER) {
    if (combo[modifier]) parts.push(display ? DISPLAY_MODIFIER_NAMES[modifier] : modifier);
  }
  let key = combo.key;
  if (display) key = DISPLAY_KEY_NAMES.get(key) ?? key.toUpperCase();
  parts.push(key);
  return parts.join("+");
}

/**
 * Render a chord. Canonical form is lowercase with modifiers in the order
 * ctrl, alt, shift, meta (`ctrl+c ctrl+n`, `<leader>shift+z`); the display
 * form capitalises names (`Ctrl+C Ctrl+N`). Pass `leader` to expand
 * `<leader>` into that combo.
 */
export function formatMmrKeyChord(chord: MmrKeyChord, options: MmrKeyChordFormatOptions = {}): string {
  const display = options.style === "display";
  const combos = chord.combos.map((combo) => formatCombo(combo, display));
  if (!chord.leader) return combos.join(" ");
  if (options.leader) return [formatCombo(options.leader, display), ...combos].join(" ");
  return `${LEADER_TOKEN}${combos.join(" ")}`;
}

/**
 * True when two chords name the same keys. Without `leader`, a `<leader>`
 * chord only equals another `<leader>` chord; with it, both sides are
 * compared after expansion, so `<leader>z` equals `ctrl+x z`.
 */
export function areMmrKeyChordsEqual(a: MmrKeyChord, b: MmrKeyChord, leader?: MmrKeyCombo): boolean {
  return formatMmrKeyChord(a, { leader }) === formatMmrKeyChord(b, { leader });
}

export interface MmrKeymapSettings {
  /** Raw `leader` string, when set. */
  readonly leader?: string;
  /** Command id -> override, in settings order. Keys are not validated here. */
  readonly overrides: Readonly<Record<string, MmrKeyBindingValue>>;
  readonly problems: readonly string[];
}

/**
 * Read the `ampi.keymap` section of a parsed Pi settings object:
 * `{"ampi": {"keymap": {"leader": "ctrl+x", "<commandId>": "<chord>" | ["<chord>", ...] | null}}}`.
 * A missing section yields no overrides; malformed values are skipped and
 * described in `problems`.
 */
export function readMmrKeymapSettings(settings: unknown): MmrKeymapSettings {
  const overrides = Object.create(null) as Record<string, MmrKeyBindingValue>;
  const problems: string[] = [];
  const ampi = isRecord(settings) ? settings.ampi : undefined;
  if (!isRecord(ampi) || !("keymap" in ampi)) return { overrides, problems };
  const keymap = ampi.keymap;
  if (!isRecord(keymap)) {
    problems.push("Ignoring ampi.keymap: expected an object that maps command ids to key strings.");
    return { overrides, problems };
  }

  let leader: string | undefined;
  for (const [id, value] of Object.entries(keymap)) {
    if (id === "leader") {
      if (typeof value === "string") leader = value;
      else problems.push("Ignoring ampi.keymap.leader: expected a key string.");
      continue;
    }
    if (value === null || typeof value === "string") {
      overrides[id] = value;
    } else if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      overrides[id] = [...value];
    } else {
      problems.push(`Ignoring ampi.keymap.${id}: expected a key string, an array of key strings, or null.`);
    }
  }
  return { ...(leader !== undefined ? { leader } : {}), overrides, problems };
}

export interface MmrKeymapResolveInput {
  /** Every known command id with its default binding (`null` or `undefined` when it has none), in display order. */
  readonly defaults: Readonly<Record<string, MmrKeyBindingValue | undefined>>;
  /** Overrides, usually `readMmrKeymapSettings(...).overrides`. */
  readonly overrides?: Readonly<Record<string, MmrKeyBindingValue>>;
  /** Leader combo; defaults to `ctrl+x`. */
  readonly leader?: string;
}

export type MmrKeymapConflict =
  | {
      /** Several commands share one chord. */
      readonly kind: "duplicate";
      readonly chord: string;
      readonly ids: readonly string[];
    }
  | {
      /** `chord` is a strict prefix of `longerChord`, so pressing it alone is ambiguous. */
      readonly kind: "prefix";
      readonly chord: string;
      readonly ids: readonly string[];
      readonly longerChord: string;
      readonly longerIds: readonly string[];
    };

export interface MmrResolvedKeymap {
  /** The effective leader combo. */
  readonly leader: MmrKeyCombo;
  /** Every known command id -> its chords (empty when unbound), in `defaults` order. */
  readonly bindings: ReadonlyMap<string, readonly MmrKeyChord[]>;
  /** Canonical chord with `<leader>` expanded -> the first command id bound to it. */
  readonly byChord: ReadonlyMap<string, string>;
  readonly conflicts: readonly MmrKeymapConflict[];
  readonly problems: readonly string[];
}

function parseBindingValue(
  value: MmrKeyBindingValue | undefined,
  describe: string,
  problems: string[],
): MmrKeyChord[] | undefined {
  if (value === null || value === undefined) return [];
  const texts = typeof value === "string" ? [value] : value;
  const chords: MmrKeyChord[] = [];
  for (const text of texts) {
    const parsed = parseMmrKeyChord(text);
    if ("error" in parsed) {
      problems.push(`Ignoring ${describe}: ${parsed.error}.`);
      continue;
    }
    if (!chords.some((chord) => areMmrKeyChordsEqual(chord, parsed))) chords.push(parsed);
  }
  // Every entry failed to parse: let the caller keep what it had.
  if (chords.length === 0 && texts.length > 0) return undefined;
  return chords;
}

function parseLeader(text: string | undefined, problems: string[]): MmrKeyCombo {
  const fallback = parseMmrKeyChord(MMR_DEFAULT_KEYMAP_LEADER) as MmrKeyChord;
  if (text === undefined) return fallback.combos[0];
  const parsed = parseMmrKeyChord(text);
  if ("error" in parsed) {
    problems.push(`Ignoring leader: ${parsed.error}.`);
    return fallback.combos[0];
  }
  if (parsed.leader || parsed.combos.length !== 1) {
    problems.push(`Ignoring leader: "${text}" is not a single key combo.`);
    return fallback.combos[0];
  }
  return parsed.combos[0];
}

/**
 * Merge default bindings with overrides into the effective keymap.
 *
 * - A string override replaces the defaults with that chord.
 * - An array override replaces the defaults with every chord it lists; `[]`
 *   unbinds.
 * - `null` unbinds.
 * - Overrides for unknown ids and chords that do not parse are skipped and
 *   reported in `problems`. An override with no parsable chord leaves the
 *   default in place.
 *
 * Conflicts are computed on chords with `<leader>` expanded.
 */
export function resolveMmrKeymap(input: MmrKeymapResolveInput): MmrResolvedKeymap {
  const problems: string[] = [];
  const leader = parseLeader(input.leader, problems);
  const bindings = new Map<string, readonly MmrKeyChord[]>();

  for (const [id, value] of Object.entries(input.defaults)) {
    bindings.set(id, parseBindingValue(value, `default key for ${id}`, problems) ?? []);
  }
  for (const [id, value] of Object.entries(input.overrides ?? {})) {
    if (!bindings.has(id)) {
      problems.push(`Ignoring keymap entry "${id}": no command has that id.`);
      continue;
    }
    const chords = parseBindingValue(value, `key for ${id}`, problems);
    if (chords) bindings.set(id, chords);
  }

  const idsByChord = new Map<string, string[]>();
  for (const [id, chords] of bindings) {
    for (const chord of chords) {
      const key = formatMmrKeyChord(chord, { leader });
      const ids = idsByChord.get(key);
      if (!ids) idsByChord.set(key, [id]);
      else if (!ids.includes(id)) ids.push(id);
    }
  }

  const byChord = new Map<string, string>();
  const conflicts: MmrKeymapConflict[] = [];
  for (const [chord, ids] of idsByChord) {
    byChord.set(chord, ids[0]);
    if (ids.length > 1) conflicts.push({ kind: "duplicate", chord, ids });
  }
  for (const [chord, ids] of idsByChord) {
    for (const [longerChord, longerIds] of idsByChord) {
      if (longerChord.startsWith(`${chord} `)) {
        conflicts.push({ kind: "prefix", chord, ids, longerChord, longerIds });
      }
    }
  }

  return { leader, bindings, byChord, conflicts, problems };
}

/**
 * Render the effective keymap as JSONC: `leader` first, then one line per
 * command id in sorted order with its chord (a string, an array, or `null`)
 * and the command description as a trailing comment.
 */
export function formatMmrKeymapJsonc(
  commands: readonly { readonly id: string; readonly description: string }[],
  keymap: MmrResolvedKeymap,
): string {
  const sorted = [...commands].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const lines = [`  "leader": ${JSON.stringify(formatMmrKeyChord({ leader: false, combos: [keymap.leader] }))}`];
  const comments = [""];
  for (const command of sorted) {
    const chords = (keymap.bindings.get(command.id) ?? []).map((chord) => JSON.stringify(formatMmrKeyChord(chord)));
    const value = chords.length === 0 ? "null" : chords.length === 1 ? chords[0] : `[${chords.join(", ")}]`;
    lines.push(`  ${JSON.stringify(command.id)}: ${value}`);
    const description = command.description.replace(/\s+/g, " ").trim();
    comments.push(description ? ` // ${description}` : "");
  }
  const body = lines.map((line, index) => `${line}${index < lines.length - 1 ? "," : ""}${comments[index]}`);
  return ["{", ...body, "}"].join("\n");
}
