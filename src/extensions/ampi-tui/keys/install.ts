import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
  getMmrCommand,
  getMmrCommands,
  type MmrCommandDefinition,
  onMmrCommandsChanged,
} from "../../ampi-core/command-registry.js";
import {
  formatMmrKeyChord,
  type MmrKeymapConflict,
  type MmrResolvedKeymap,
  parseMmrKeyChord,
  readMmrKeymapSettings,
  resolveMmrKeymap,
} from "../../ampi-core/keymap.js";
import { type MmrPaletteItem, openMmrPalette } from "../overlays/palette.js";
import { getMmrEditorRenderedHeight, isMmrEditorFocused, isMmrEditorShowingAutocomplete } from "../pi-compat/editor.js";
import { MMR_PI_RESERVED_SHORTCUT_KEYS, toMmrPiKeyId } from "../pi-compat/reserved-keys.js";
import { subscribeMmrTerminalInput } from "../pi-compat/terminal-input.js";
import {
  createMmrSlashPaletteCommands,
  MMR_PALETTE_COMMAND_IDS,
  type MmrTuiCommandHost,
  registerMmrTuiCommands,
} from "./commands.js";
import { decodeMmrTerminalKeys } from "./decode.js";
import {
  createMmrKeyDispatcher,
  displayMmrKeyChord,
  formatMmrKeyCombo,
  type MmrKeyAvailability,
  type MmrKeyDispatcher,
  type MmrKeyHint,
} from "./dispatcher.js";
import { MMR_HINT_POPUP_WIDTH, renderMmrHintPopup } from "./hint-popup.js";

/**
 * Wires the key dispatcher into Pi.
 *
 * At each session start, and whenever the command registry changes, the
 * keymap is resolved from the commands' default keys and the `ampi.keymap`
 * section of Pi's settings. Each chord then takes one of two routes:
 *
 * - `pi.registerShortcut` for a single key that Pi does not reserve, that
 *   starts no longer chord, and whose command is always available. Pi reads
 *   shortcuts once per session start, so a single-key binding that appears
 *   later takes effect after `/reload`.
 * - The raw terminal input path for everything else: chords, the leader,
 *   keys Pi reserves, and keys that must reach the editor when their command
 *   is unavailable (Home and End while the prompt has text).
 */

export interface MmrTuiKeysOptions {
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly chordTimeoutMs?: number;
  readonly escapeWindowMs?: number;
}

export interface MmrTuiKeys {
  /** Install for a TUI session. Safe to call again on the next session start. */
  start(ctx: ExtensionContext, getTui: () => TUI | undefined): void;
  stop(): void;
}

function describeConflict(conflict: MmrKeymapConflict): string {
  if (conflict.kind === "duplicate") {
    return `Key "${conflict.chord}" is bound to ${conflict.ids.join(", ")}; only ${conflict.ids[0]} runs.`;
  }
  return `Key "${conflict.chord}" (${conflict.ids.join(", ")}) starts "${conflict.longerChord}" (${conflict.longerIds.join(", ")}); it only works as the start of the longer chord.`;
}

function readSettings(pi: ExtensionAPI): unknown {
  try {
    return typeof pi.getSettings === "function" ? pi.getSettings() : undefined;
  } catch {
    return undefined;
  }
}

export function createMmrTuiKeys(pi: ExtensionAPI, options: MmrTuiKeysOptions = {}): MmrTuiKeys {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let ctx: ExtensionContext | undefined;
  let getTui: () => TUI | undefined = () => undefined;
  let dispatcher: MmrKeyDispatcher | undefined;
  let unsubscribeInput: (() => void) | undefined;
  let unsubscribeCommands: (() => void) | undefined;
  let unregisterCommands: (() => void) | undefined;
  /** Canonical single key -> command id, for keys routed through `registerShortcut`. */
  const shortcutIds = new Map<string, string>();
  const registeredShortcuts = new Set<string>();
  const warned = new Set<string>();
  let hint: { close(): void } | undefined;
  let hintTimer: unknown;
  let resolved: MmrResolvedKeymap | undefined;
  const host: MmrTuiCommandHost = { getTui: () => getTui(), pi, openPalette };

  function availability(id: string): MmrKeyAvailability {
    const command = getMmrCommand(id);
    if (!command || !ctx) return "unavailable";
    if (!command.availability) return "available";
    try {
      return command.availability(ctx).state;
    } catch {
      return "unavailable";
    }
  }

  function run(id: string | undefined): void {
    const command = id === undefined ? undefined : getMmrCommand(id);
    if (command) runCommand(command);
  }

  function runCommand(command: MmrCommandDefinition): void {
    if (!ctx) return;
    const current = ctx;
    const report = (error: unknown) =>
      current.ui.notify(`${command.id} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    try {
      const result = command.run(current);
      if (result instanceof Promise) result.catch(report);
    } catch (error) {
      report(error);
    }
  }

  /** The command's first effective key in display form, as the palette shows it. */
  function displayKey(id: string): string | undefined {
    const chord = resolved?.bindings.get(id)?.[0];
    return chord && resolved ? displayMmrKeyChord(formatMmrKeyChord(chord, { leader: resolved.leader })) : undefined;
  }

  function openPalette(current: ExtensionContext): void {
    const items: MmrPaletteItem[] = [
      ...getMmrCommands()
        .filter((command) => !MMR_PALETTE_COMMAND_IDS.has(command.id))
        .map((command) => ({ command, key: displayKey(command.id) })),
      ...createMmrSlashPaletteCommands(host).map((command) => ({ command })),
    ];
    void openMmrPalette(current, items)
      .then((command) => {
        if (command) runCommand(command);
      })
      .catch(() => {});
  }

  function reportUnavailable(id: string): void {
    const command = getMmrCommand(id);
    if (!command || !ctx) return;
    let reason: string | undefined;
    try {
      reason = command.availability?.(ctx).reason;
    } catch {}
    ctx.ui.notify(`${command.noun} ${command.verb} is not available${reason ? `: ${reason}` : ""}.`, "info");
  }

  function closeHint(): void {
    if (hintTimer !== undefined) clearTimer(hintTimer);
    hintTimer = undefined;
    hint?.close();
    hint = undefined;
  }

  function showHint(next: MmrKeyHint): void {
    closeHint();
    if (!ctx) return;
    const content = { prefix: next.prefix, rows: next.rows };
    let done: ((result: undefined) => void) | undefined;
    let closed = false;
    hint = {
      close() {
        closed = true;
        done?.(undefined);
      },
    };
    const ui = ctx.ui;
    void ui
      .custom<undefined>(
        (_tui, theme, _keybindings, finish) => {
          done = finish;
          if (closed) queueMicrotask(() => finish(undefined));
          return { render: (columns: number) => renderMmrHintPopup(content, columns, theme), invalidate() {} };
        },
        {
          overlay: true,
          overlayOptions: () => ({
            anchor: "bottom-right",
            // Pi narrows an overlay to the terminal width; the popup truncates its rows.
            width: MMR_HINT_POPUP_WIDTH,
            // Sit on the row above the prompt box. Without a rendered height,
            // count its text lines plus two borders.
            offsetY: -(getMmrEditorRenderedHeight(getTui()) ?? ui.getEditorText().split("\n").length + 2),
            nonCapturing: true,
          }),
        },
      )
      .catch(() => {});
    hintTimer = setTimer(() => {
      hintTimer = undefined;
      dispatcher?.expire();
    }, Math.max(0, next.deadline - now()));
  }

  function rebuild(): void {
    const commands = getMmrCommands();
    const defaults = Object.fromEntries(commands.map((command) => [command.id, command.defaultKey ?? null]));
    const settings = readMmrKeymapSettings(readSettings(pi));
    const keymap = resolveMmrKeymap({ defaults, overrides: settings.overrides, leader: settings.leader });
    resolved = keymap;

    const fresh = [...settings.problems, ...keymap.problems, ...keymap.conflicts.map(describeConflict)].filter(
      (message) => !warned.has(message),
    );
    for (const message of fresh) warned.add(message);
    if (fresh.length > 0) ctx?.ui.notify(`ampi keymap: ${fresh.join(" ")}`, "warning");

    const leader = formatMmrKeyCombo(keymap.leader);
    const firstKeys = new Set([...keymap.byChord.keys()].filter((chord) => chord.includes(" ")).map((chord) => chord.split(" ")[0]));
    const raw = new Map<string, string>();
    shortcutIds.clear();
    for (const [chord, id] of keymap.byChord) {
      const single = !chord.includes(" ");
      const shortcut =
        single &&
        chord !== leader &&
        !firstKeys.has(chord) &&
        !MMR_PI_RESERVED_SHORTCUT_KEYS.has(chord) &&
        getMmrCommand(id)?.availability === undefined;
      if (shortcut) shortcutIds.set(chord, id);
      else raw.set(chord, id);
    }
    for (const [chord] of shortcutIds) registerShortcut(chord);

    const rawKeymap: Pick<MmrResolvedKeymap, "byChord" | "leader"> = { byChord: raw, leader: keymap.leader };
    if (dispatcher) {
      closeHint();
      dispatcher.setKeymap(rawKeymap);
      return;
    }
    dispatcher = createMmrKeyDispatcher({
      keymap: rawKeymap,
      now,
      onRun: run,
      onHint: showHint,
      onClearHint: closeHint,
      onUnavailable: reportUnavailable,
      availability,
      describe: (id) => getMmrCommand(id)?.description,
      chordTimeoutMs: options.chordTimeoutMs,
      escapeWindowMs: options.escapeWindowMs,
    });
  }

  function registerShortcut(chord: string): void {
    if (registeredShortcuts.has(chord)) return;
    const parsed = parseMmrKeyChord(chord);
    if ("error" in parsed) return;
    registeredShortcuts.add(chord);
    const command = getMmrCommand(shortcutIds.get(chord) ?? "");
    pi.registerShortcut(toMmrPiKeyId(parsed.combos[0]) as Parameters<ExtensionAPI["registerShortcut"]>[0], {
      description: command?.description,
      // Look the key up again on each press: overrides may have moved it.
      handler: () => run(shortcutIds.get(chord)),
    });
  }

  function onInput(data: string): boolean {
    const active = dispatcher;
    if (!active) return false;
    const combos = decodeMmrTerminalKeys(data);
    // A key release (kitty keyboard protocol) is no key press: it must not
    // cancel a pending chord.
    if (combos?.length === 0) return false;
    const raw = active.rawKeys();
    if (!active.isPending() && !combos?.some((combo) => raw.has(formatMmrKeyCombo(combo)))) return false;
    const tui = getTui();
    // As in Pi, Esc first closes the prompt's autocomplete list; it neither
    // completes nor starts a chord.
    if (combos?.some((combo) => formatMmrKeyCombo(combo) === "esc") && isMmrEditorShowingAutocomplete(tui)) {
      active.cancel();
      return false;
    }
    const context = { editorFocused: isMmrEditorFocused(tui) };
    if (!combos) return active.handle(undefined, context);
    let consumed = false;
    for (const combo of combos) consumed = active.handle(combo, context) || consumed;
    return consumed;
  }

  return {
    start(nextCtx, nextGetTui) {
      ctx = nextCtx;
      getTui = nextGetTui;
      unregisterCommands ??= registerMmrTuiCommands(host);
      rebuild();
      unsubscribeCommands ??= onMmrCommandsChanged(() => rebuild());
      unsubscribeInput?.();
      unsubscribeInput = subscribeMmrTerminalInput(nextCtx.ui, onInput);
    },
    stop() {
      dispatcher?.cancel();
      closeHint();
      unsubscribeInput?.();
      unsubscribeInput = undefined;
      unsubscribeCommands?.();
      unsubscribeCommands = undefined;
      unregisterCommands?.();
      unregisterCommands = undefined;
      dispatcher = undefined;
      ctx = undefined;
    },
  };
}
