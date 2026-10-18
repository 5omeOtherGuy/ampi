import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MmrCommandDefinition } from "./extensions/ampi-core/command-registry.js";
import { formatMmrKeymapJsonc, readMmrKeymapSettings, resolveMmrKeymap } from "./extensions/ampi-core/keymap.js";
import { createMmrThreadCommands, type MmrThreadCommandHost } from "./extensions/ampi-threads/commands.js";
import { loadMmrThreadsSettings } from "./extensions/ampi-threads/config.js";
import { loadMmrTuiSettings } from "./extensions/ampi-tui/config.js";
import { createMmrPromptQueue } from "./extensions/ampi-tui/editor/queue.js";
import type { MmrStatusFeed } from "./extensions/ampi-tui/editor/status-feed.js";
import { createMmrTuiCommands, type MmrTuiCommandHost } from "./extensions/ampi-tui/keys/commands.js";
import { describeMmrKeymapConflict } from "./extensions/ampi-tui/keys/install.js";
import { createMmrMessageNavigation } from "./extensions/ampi-tui/transcript/navigation.js";

/**
 * The keymap outside a Pi session, for `ampi config keymap`.
 *
 * In a terminal session `ampi-tui` and `ampi-threads` register their palette
 * commands in ampi-core's command registry. This module builds the same
 * definitions without a session, so the command line lists the same ids,
 * descriptions and default keys. The hosts below are never called: the
 * definitions are only read, never run.
 */

const nothing = (): undefined => undefined;

/**
 * Every palette command ampi's extensions register in a terminal session, in
 * the order they register; without ampi-threads' when `threads` is false.
 * Commands that other packages register at run time are not included.
 */
export function collectMmrDefaultCommands(options: { threads?: boolean } = {}): MmrCommandDefinition[] {
  const pi = {
    getCommands: () => [],
    getSettings: () => ({}),
    sendUserMessage: nothing,
    on: () => nothing,
    registerCommand: nothing,
  };
  const tuiHost: MmrTuiCommandHost = {
    getTui: nothing,
    pi,
    openPalette: nothing,
    openModeDial: nothing,
    openHelpKeymap: nothing,
    openKeymapJson: nothing,
    openPromptHistory: nothing,
    openThreadSwitcher: nothing,
    openThreadMention: nothing,
    openThreadCost: nothing,
    openContextAnalysis: nothing,
    toggleOutline: nothing,
    openSkills: nothing,
    openExtensions: nothing,
    openVersion: nothing,
  };
  const threadHost = { pi, now: () => "" } as unknown as MmrThreadCommandHost;
  const queue = createMmrPromptQueue(pi, { feed: {} as MmrStatusFeed, getTui: nothing });
  const navigation = createMmrMessageNavigation(pi);
  const threadCommands = options.threads === false ? [] : createMmrThreadCommands(threadHost);
  return [...threadCommands, ...queue.commands, ...createMmrTuiCommands(tuiHost), ...navigation.commands];
}

export interface MmrEffectiveKeymapJsonc {
  /** The keymap as `formatMmrKeymapJsonc` prints it. */
  readonly jsonc: string;
  /** Settings entries that were skipped and keys bound twice, as the terminal UI reports them. */
  readonly problems: readonly string[];
}

/**
 * The keymap in effect in `cwd` for Pi settings `settings` (global and project
 * settings merged), with the commands of ampi's extensions that are turned on
 * there. ampi-tui and ampi-threads read their own switches, so these are read
 * the same way.
 */
export function formatMmrEffectiveKeymapJsonc(settings: unknown, cwd: string = process.cwd()): MmrEffectiveKeymapJsonc {
  const commands = collectMmrDefaultCommands({ threads: loadMmrThreadsSettings(cwd).enabled });
  const tuiOff = loadMmrTuiSettings(cwd).enabled ? [] : ["ampi-tui is turned off, so none of these keys are bound."];
  const keymapSettings = readMmrKeymapSettings(settings);
  const keymap = resolveMmrKeymap({
    defaults: Object.fromEntries(commands.map((command) => [command.id, command.defaultKey ?? null])),
    overrides: keymapSettings.overrides,
    leader: keymapSettings.leader,
  });
  return {
    jsonc: formatMmrKeymapJsonc(commands, keymap),
    problems: [...tuiOff, ...keymapSettings.problems, ...keymap.problems, ...keymap.conflicts.map(describeMmrKeymapConflict)],
  };
}

/** Event channel on which this module's extension entry hands `ampi config keymap` its formatter. */
export const MMR_CONFIG_KEYMAP_EVENT = "ampi:config-keymap";

/**
 * Entry for Pi's extension loader, used by `ampi config keymap`: ampi ships
 * TypeScript that only Pi's loader imports, so the command loads this file
 * with it and receives `formatMmrEffectiveKeymapJsonc` on Pi's event bus. It
 * is not one of the package's extensions and registers nothing.
 */
export default function ampiConfigKeymapEntry(pi: ExtensionAPI): void {
  pi.events.emit(MMR_CONFIG_KEYMAP_EVENT, { formatKeymapJsonc: formatMmrEffectiveKeymapJsonc });
}
