import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fuzzyMatch } from "@earendil-works/pi-tui";
import { parseMmrKeyChord } from "./keymap.js";

/**
 * Registry of palette commands: named actions such as `thread.new` that a
 * command palette lists as "noun verb", that the keymap binds to keys, and
 * that a help screen documents. Separate from Pi slash commands.
 */

export type MmrCommandAvailabilityState = "available" | "unavailable" | "hidden";

export interface MmrCommandAvailability {
  readonly state: MmrCommandAvailabilityState;
  /** Why the command cannot run right now; shown next to unavailable rows. */
  readonly reason?: string;
}

export interface MmrCommandDefinition {
  /** Dotted id, e.g. `thread.new`; the keymap key. Re-registering an id replaces it. */
  readonly id: string;
  readonly noun: string;
  readonly verb: string;
  readonly description: string;
  /** Default chord or chords in the keymap grammar, e.g. `ctrl+c ctrl+n` or `<leader>z`. */
  readonly defaultKey?: string | readonly string[];
  /** Extra words the palette filter matches. */
  readonly keywords?: readonly string[];
  /** Defaults to available. */
  availability?(ctx: ExtensionContext): MmrCommandAvailability;
  run(ctx: ExtensionContext): Promise<void> | void;
}

export type MmrCommandsChange = "registered" | "replaced" | "unregistered";

export interface MmrCommandsChangedEvent {
  readonly change: MmrCommandsChange;
  readonly id: string;
}

export type MmrCommandsChangedListener = (event: MmrCommandsChangedEvent) => void;

/** Name of the command-registry change notification, delivered through `onMmrCommandsChanged`. */
export const MMR_EVENT_COMMANDS_CHANGED = "mmr-core:commands-changed";

const COMMAND_ID = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

interface CommandStore {
  readonly commands: Map<string, MmrCommandDefinition>;
  readonly listeners: Set<MmrCommandsChangedListener>;
}

// globalThis-anchored so every extension sees one registry even when Pi
// loads ampi-core modules under distinct module identities.
const COMMANDS_GLOBAL_KEY = "__pi_ampi_commands_v1__";
const globalStore = globalThis as typeof globalThis & { [COMMANDS_GLOBAL_KEY]?: CommandStore };
const store: CommandStore = globalStore[COMMANDS_GLOBAL_KEY] ?? { commands: new Map(), listeners: new Set() };
globalStore[COMMANDS_GLOBAL_KEY] = store;

function notify(change: MmrCommandsChange, id: string): void {
  const event: MmrCommandsChangedEvent = { change, id };
  for (const listener of [...store.listeners]) listener(event);
}

/**
 * Register a palette command, or replace the one with the same id (it keeps
 * its position in registration order). Throws on an invalid id, an empty
 * noun, verb or description, or a `defaultKey` that does not parse.
 */
export function registerMmrCommand(def: MmrCommandDefinition): void {
  if (!COMMAND_ID.test(def.id)) {
    throw new Error(`Invalid command id "${def.id}": use dotted lowerCamel segments such as "thread.new".`);
  }
  for (const field of ["noun", "verb", "description"] as const) {
    if (typeof def[field] !== "string" || def[field].trim().length === 0) {
      throw new Error(`Command "${def.id}" needs a non-empty ${field}.`);
    }
  }
  const keys = def.defaultKey === undefined ? [] : typeof def.defaultKey === "string" ? [def.defaultKey] : def.defaultKey;
  for (const key of keys) {
    const parsed = parseMmrKeyChord(key);
    if ("error" in parsed) throw new Error(`Command "${def.id}" has an invalid defaultKey: ${parsed.error}.`);
  }
  const replaced = store.commands.has(def.id);
  store.commands.set(def.id, def);
  notify(replaced ? "replaced" : "registered", def.id);
}

/** Remove a command. Returns false when no command had that id. */
export function unregisterMmrCommand(id: string): boolean {
  if (!store.commands.delete(id)) return false;
  notify("unregistered", id);
  return true;
}

/** Registered commands in registration order. */
export function getMmrCommands(): readonly MmrCommandDefinition[] {
  return [...store.commands.values()];
}

export function getMmrCommand(id: string): MmrCommandDefinition | undefined {
  return store.commands.get(id);
}

/** Listen for registry changes. Returns an unsubscribe function. */
export function onMmrCommandsChanged(listener: MmrCommandsChangedListener): () => void {
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

/** Test-only: clear commands and listeners. Production code must not call this. */
export function __resetMmrCommandsForTests(): void {
  store.commands.clear();
  store.listeners.clear();
}

export interface MmrRankedCommand {
  readonly command: MmrCommandDefinition;
  readonly state: "available" | "unavailable";
  readonly reason?: string;
  /** Fuzzy score; lower is better. 0 for an empty query. */
  readonly score: number;
}

export interface MmrRankCommandsOptions {
  /** Passed to each command's `availability` check. */
  readonly ctx: ExtensionContext;
}

function evaluateAvailability(command: MmrCommandDefinition, ctx: ExtensionContext): MmrCommandAvailability {
  if (!command.availability) return { state: "available" };
  try {
    return command.availability(ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { state: "unavailable", reason: `availability check failed: ${message}` };
  }
}

function scoreCommand(command: MmrCommandDefinition, tokens: readonly string[]): number | undefined {
  const fields = [`${command.noun} ${command.verb}`, command.id, command.description, ...(command.keywords ?? [])];
  let total = 0;
  for (const token of tokens) {
    let best: number | undefined;
    for (const field of fields) {
      const match = fuzzyMatch(token, field);
      if (match.matches && (best === undefined || match.score < best)) best = match.score;
    }
    if (best === undefined) return undefined;
    total += best;
  }
  return total;
}

/**
 * Filter and order commands for a palette query. Each whitespace-separated
 * query word must fuzzy-match the "noun verb" label, the id, the description
 * or a keyword. Available commands come first, best match first, ties in
 * registration order; unavailable ones follow in the same order with their
 * reason. Hidden commands are never returned. An empty query keeps
 * registration order.
 */
export function rankMmrCommands(
  commands: readonly MmrCommandDefinition[],
  query: string,
  options: MmrRankCommandsOptions,
): MmrRankedCommand[] {
  const tokens = query.trim().split(/\s+/).filter((token) => token.length > 0);
  const rows: { row: MmrRankedCommand; order: number }[] = [];
  for (const [order, command] of commands.entries()) {
    const availability = evaluateAvailability(command, options.ctx);
    if (availability.state === "hidden") continue;
    const score = scoreCommand(command, tokens);
    if (score === undefined) continue;
    const row: MmrRankedCommand =
      availability.state === "unavailable"
        ? { command, state: "unavailable", ...(availability.reason ? { reason: availability.reason } : {}), score }
        : { command, state: "available", score };
    rows.push({ row, order });
  }
  const rank = (state: MmrRankedCommand["state"]) => (state === "unavailable" ? 1 : 0);
  rows.sort((a, b) => rank(a.row.state) - rank(b.row.state) || a.row.score - b.row.score || a.order - b.order);
  return rows.map(({ row }) => row);
}
