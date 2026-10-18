import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type Keybinding, type TUI } from "@earendil-works/pi-tui";
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
import type { MmrPromptHistory } from "../../ampi-core/prompt-history.js";
import { getMmrModeState, onMmrStateChanged } from "../../ampi-core/runtime.js";
import type { MmrModeKey } from "../../ampi-core/types.js";
import { openMmrHelpKeymap, openMmrKeymapJson } from "../overlays/help-keymap.js";
import { type MmrModeDial, openMmrModeDial } from "../overlays/mode-dial.js";
import { type MmrPaletteItem, openMmrPalette } from "../overlays/palette.js";
import { openMmrPromptHistory } from "../overlays/prompt-history.js";
import { getMmrEditorRenderedHeight, isMmrEditorFocused, isMmrEditorShowingAutocomplete } from "../pi-compat/editor.js";
import { MMR_PI_RESERVED_SHORTCUT_KEYS, toMmrPiKeyId } from "../pi-compat/reserved-keys.js";
import { getMmrTranscriptScroller } from "../pi-compat/scroll.js";
import { subscribeMmrTerminalInput } from "../pi-compat/terminal-input.js";
import {
  createMmrSlashPaletteCommands,
  MMR_HELP_COMMAND_ID,
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

/**
 * A dial switch that ampi-core never reports (the mode's model or tools are
 * missing, say) holds the next one back this long at most.
 */
const MODE_SWITCH_TIMEOUT_MS = 3000;

export interface MmrTuiKeysOptions {
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly chordTimeoutMs?: number;
  readonly escapeWindowMs?: number;
  /** Rows the prompt editor drew last; defaults to the height Pi's editor records. */
  readonly editorHeight?: () => number | undefined;
  /** The first Esc of Esc Esc was taken while a turn runs (the prompt box clears its text). */
  readonly onEscapePending?: () => void;
  /** The quit chord waits for its second Ctrl+C until `until` (epoch ms), or stopped waiting (`undefined`). */
  readonly onQuitPending?: (until: number | undefined) => void;
  /** The `thread.interrupt` command ran. */
  readonly onInterrupt?: () => void;
  /** The command palette opened (`true`) or closed (`false`); the prompt box dims its frame meanwhile. */
  readonly onPaletteOpen?: (open: boolean) => void;
  /** The `prompt.toggleHelp` command ran. */
  readonly onToggleHelp?: () => void;
  /** A key is about to run a command other than `prompt.toggleHelp`; the prompt box closes its help. */
  readonly onKeyCommand?: () => void;
}

export interface MmrTuiKeys {
  /** Install for a TUI session. Safe to call again on the next session start. */
  start(ctx: ExtensionContext, getTui: () => TUI | undefined): void;
  stop(): void;
  /** The keymap in effect, once started. */
  keymap(): MmrResolvedKeymap | undefined;
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
  let quitPending = false;
  let modeDial: MmrModeDial | undefined;
  /** The mode the dial last chose, and the dial's switches, one after another. */
  let dialMode: MmrModeKey | undefined;
  let dialSwitches: Promise<void> = Promise.resolve();
  const host: MmrTuiCommandHost = {
    getTui: () => getTui(),
    pi,
    openPalette,
    openModeDial,
    openHelpKeymap,
    openKeymapJson,
    openPromptHistory,
    onInterrupt: options.onInterrupt,
    toggleHelp: options.onToggleHelp,
  };

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
    if (!command) return;
    if (command.id !== MMR_HELP_COMMAND_ID) options.onKeyCommand?.();
    runCommand(command);
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
    options.onPaletteOpen?.(true);
    void openMmrPalette(current, items)
      .finally(() => options.onPaletteOpen?.(false))
      .then((command) => {
        if (command) runCommand(command);
      })
      .catch(() => {});
  }

  function openHelpKeymap(current: ExtensionContext): void {
    if (!resolved) return;
    void openMmrHelpKeymap(current, {
      keymap: resolved,
      commands: getMmrCommands(),
      piKeys: (id) => getKeybindings().getKeys(id as Keybinding),
      modeKeys: getMmrModeState() !== undefined,
      scrolling: getMmrTranscriptScroller(getTui()) !== undefined,
    }).catch(() => {});
  }

  function openKeymapJson(current: ExtensionContext): void {
    if (!resolved) return;
    void openMmrKeymapJson(current, getMmrCommands(), resolved).catch(() => {});
  }

  /** Open the prompt history picker; the prompt picked replaces the prompt's text, unsent. */
  function openPromptHistory(current: ExtensionContext, history: MmrPromptHistory): void {
    const report = (error: unknown) =>
      current.ui.notify(`Could not read the prompt history: ${error instanceof Error ? error.message : String(error)}`, "error");
    options.onPaletteOpen?.(true);
    void openMmrPromptHistory(current, history)
      .finally(() => options.onPaletteOpen?.(false))
      .then((text) => {
        if (text === undefined) return;
        current.ui.setEditorText(text);
        // Pi's setEditorText does not redraw; without this the text shows only after the next key.
        getTui()?.requestRender();
      })
      .catch(report);
  }

  /**
   * Offset that puts an overlay anchored at the bottom on the row above the
   * prompt box. Without a rendered height, count the prompt's text lines
   * plus two borders.
   */
  function abovePrompt(): number {
    return -(
      options.editorHeight?.() ??
      getMmrEditorRenderedHeight(getTui()) ??
      (ctx?.ui.getEditorText().split("\n").length ?? 1) + 2
    );
  }

  function openModeDial(current: ExtensionContext): void {
    // The dial switches through /mode, which overrides the lock, so a locked
    // session refuses here as ampi-core's cycle and picker do.
    const state = getMmrModeState();
    if (state?.modeLock?.locked) {
      current.ui.notify(`Mode stays ${state.mode}: ${state.modeLock.reason}. /mode <key> still switches it.`, "warning");
      return;
    }
    if (modeDial && !modeDial.isClosed()) {
      modeDial.turn(1);
      return;
    }
    void openMmrModeDial(current, {
      apply: (mode) => {
        dialMode = mode;
        dialSwitches = dialSwitches.then(switchToDialMode).catch(() => {});
      },
      setTimer,
      clearTimer,
      offsetY: abovePrompt,
      onOpen: (dial) => {
        modeDial = dial;
      },
    }).catch(() => {});
  }

  /**
   * Switch to the mode the dial points at now, unless it is already active,
   * through the same path as typing /mode (applied, persisted and reported by
   * ampi-core), and resolve once ampi-core has finished. Switches never
   * overlap: ampi-core tells its own model changes from native ones by a flag
   * that one switch would clear while another is still changing the model,
   * which drops the mode to free. Turns made meanwhile collapse into the
   * latest one.
   */
  function switchToDialMode(): Promise<void> {
    const mode = dialMode;
    if (mode === undefined || mode === getMmrModeState()?.mode) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        unsubscribe();
        clearTimer(timeout);
        // ampi-core reports the switch a little before it clears that flag;
        // let it finish before the next switch starts.
        setTimer(resolve, 0);
      };
      // Pi's sendUserMessage does not wait for the command, so the state
      // change ampi-core reports marks the end of the switch.
      const unsubscribe = onMmrStateChanged(pi, settle);
      const timeout = setTimer(settle, MODE_SWITCH_TIMEOUT_MS);
      pi.sendUserMessage(`/mode ${mode}`, { expandPromptTemplates: true });
    });
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
    if (quitPending) {
      quitPending = false;
      options.onQuitPending?.(undefined);
    }
  }

  function showHint(next: MmrKeyHint): void {
    closeHint();
    if (!ctx) return;
    // The prompt box's force-quit hint names Ctrl+C, so only that chord sets it.
    if (next.prefix === "Ctrl+C" && next.rows.some((row) => row.id === "ampi.quit" && row.key === "Ctrl+C")) {
      quitPending = true;
      options.onQuitPending?.(next.deadline);
    }
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
            offsetY: abovePrompt(),
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
    for (const combo of combos) {
      const taken = active.handle(combo, context);
      consumed = taken || consumed;
      // Esc took and now waits for its second press: a turn is running.
      if (taken && formatMmrKeyCombo(combo) === "esc" && active.isPending()) options.onEscapePending?.();
    }
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
      modeDial?.close();
      modeDial = undefined;
      // Switches still waiting belong to this session; drop them.
      dialMode = undefined;
      unsubscribeInput?.();
      unsubscribeInput = undefined;
      unsubscribeCommands?.();
      unsubscribeCommands = undefined;
      unregisterCommands?.();
      unregisterCommands = undefined;
      dispatcher = undefined;
      resolved = undefined;
      ctx = undefined;
    },
    keymap: () => resolved,
  };
}
