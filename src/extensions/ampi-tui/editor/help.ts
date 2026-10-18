import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { MmrCommandDefinition } from "../../ampi-core/command-registry.js";
import { formatMmrKeyChord, type MmrResolvedKeymap } from "../../ampi-core/keymap.js";
import { displayMmrKeyChord, formatMmrKeyCombo } from "../keys/dispatcher.js";
import type { MmrPromptBoxTheme } from "./prompt-box.js";

/**
 * The shortcuts help the prompt box shows above its text after `?` on an
 * empty prompt:
 *
 * ```text
 * ╭──────────────────────────────────────────────────────── medium ─╮
 * │ Ctrl+S switch modes             Alt+D toggle thinking           │
 * │ Alt+Enter newline               @ mention files                 │
 * │ Ctrl+X leader key               Esc Esc interrupt               │
 * │ …                                                               │
 * │ ─────────────────────────────────────────────────────────────── │
 * │                                                                 │
 * ```
 *
 * Rows are built from the effective keymap and the command registry, so a
 * rebound or newly registered command shows up with its real key. A few
 * keys that are not registry commands come first: ampi-core's mode keys,
 * the box's newline key and Pi's file mention.
 */

export interface MmrShortcutHelpEntry {
  /** Display form of the key, e.g. `Ctrl+C Ctrl+C` or `Home/End`. */
  readonly key: string;
  readonly label: string;
}

/** What the help shows: its rows and an optional note under them. */
export interface MmrShortcutHelp {
  readonly entries: readonly MmrShortcutHelpEntry[];
  readonly note?: string;
}

/** Column of the box's text area where the second column starts; one more than the widest entry that fits beside it. */
export const MMR_SHORTCUT_HELP_COLUMN = 32;

/** Shown under the rows inside tmux when its `extended-keys` option is off. */
export const MMR_SHORTCUT_HELP_TMUX_NOTE = "Shift+Enter needs tmux's extended-keys option; Alt+Enter works without it.";

export interface MmrShortcutHelpSources {
  /** The effective keymap; without one only the fixed rows are listed. */
  readonly keymap?: Pick<MmrResolvedKeymap, "bindings" | "leader">;
  /** Registered commands, in registration order. */
  readonly commands: readonly Pick<MmrCommandDefinition, "id" | "noun" | "verb">[];
  /** ampi-core is loaded, so its mode keys (Ctrl+S, Alt+D) are bound. */
  readonly modeKeys: boolean;
}

/**
 * Two neighbouring commands of one noun whose verbs differ only in their last
 * word share a row: `Home/End scroll to top/bottom`.
 */
function mergedLabel(a: string, b: string): string | undefined {
  const left = a.split(" ");
  const right = b.split(" ");
  if (left.length < 2 || left.length !== right.length) return undefined;
  const stem = left.slice(0, -1).join(" ");
  if (stem !== right.slice(0, -1).join(" ")) return undefined;
  return `${stem} ${left.at(-1)}/${right.at(-1)}`;
}

/** The help rows: fixed keys first, then the leader, then each bound command in registration order. */
export function buildMmrShortcutHelpEntries(sources: MmrShortcutHelpSources): MmrShortcutHelpEntry[] {
  const entries: MmrShortcutHelpEntry[] = [];
  if (sources.modeKeys) entries.push({ key: "Ctrl+S", label: "switch modes" }, { key: "Alt+D", label: "toggle thinking" });
  entries.push({ key: "Alt+Enter", label: "newline" }, { key: "@", label: "mention files" });
  const keymap = sources.keymap;
  if (!keymap) return entries;
  entries.push({ key: formatMmrKeyCombo(keymap.leader, "display"), label: "leader key" });

  let previous: { noun: string; verb: string } | undefined;
  for (const command of sources.commands) {
    const chords = keymap.bindings.get(command.id) ?? [];
    if (chords.length === 0) continue;
    const key = chords.map((chord) => displayMmrKeyChord(formatMmrKeyChord(chord, { leader: keymap.leader }))).join("/");
    const merged = previous?.noun === command.noun ? mergedLabel(previous.verb, command.verb) : undefined;
    if (merged) {
      const last = entries[entries.length - 1];
      entries[entries.length - 1] = { key: `${last.key}/${key}`, label: merged };
      previous = undefined;
      continue;
    }
    entries.push({ key, label: command.verb });
    previous = command;
  }
  return entries;
}

function entryWidth(entry: MmrShortcutHelpEntry): number {
  return visibleWidth(entry.key) + 1 + visibleWidth(entry.label);
}

function paintEntry(entry: MmrShortcutHelpEntry, width: number, theme: MmrPromptBoxTheme): string {
  return truncateToWidth(`${theme.fg("accent", entry.key)} ${theme.fg("dim", entry.label)}`, width, "…", true);
}

/**
 * Render the help into lines of exactly `width` columns (the box's text area):
 * the rows, the note, then a rule. Two columns when every entry fits in the
 * first one and the text area is wide enough for the second, otherwise one,
 * with long entries cut. When the lines would exceed `maxLines`, the note
 * goes first, then rows from the end; the rule always stays.
 */
export function renderMmrShortcutHelp(
  help: MmrShortcutHelp,
  width: number,
  theme: MmrPromptBoxTheme,
  maxLines = Number.POSITIVE_INFINITY,
): string[] {
  const widest = Math.max(0, ...help.entries.map(entryWidth));
  const twoColumns = widest < MMR_SHORTCUT_HELP_COLUMN && width >= MMR_SHORTCUT_HELP_COLUMN + widest;
  const rows: string[] = [];
  if (twoColumns) {
    for (let index = 0; index < help.entries.length; index += 2) {
      const right = help.entries[index + 1];
      const left = paintEntry(help.entries[index], MMR_SHORTCUT_HELP_COLUMN, theme);
      rows.push(right ? left + paintEntry(right, width - MMR_SHORTCUT_HELP_COLUMN, theme) : truncateToWidth(left, width, "", true));
    }
  } else {
    for (const entry of help.entries) rows.push(paintEntry(entry, width, theme));
  }
  const room = Math.max(0, maxLines - 1);
  const note = help.note && rows.length < room ? [truncateToWidth(theme.fg("dim", help.note), width, "…", true)] : [];
  return [...rows.slice(0, room), ...note, theme.fg("border", "─".repeat(width))];
}
