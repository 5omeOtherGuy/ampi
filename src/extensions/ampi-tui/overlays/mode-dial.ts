import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, matchesKey, rgbColor, visibleWidth } from "@earendil-works/pi-tui";
import { selectMmrModelRoute } from "../../ampi-core/model-resolver.js";
import { getMmrModeName, getMmrRegisteredMode, listMmrModes, type MmrRegisteredMode } from "../../ampi-core/mode-registry.js";
import { MMR_MODES } from "../../ampi-core/modes.js";
import { getDefaultToggleThinkingLevel, isToggleableMmrMode } from "../../ampi-core/request-policy.js";
import { getMmrModeState } from "../../ampi-core/runtime.js";
import { loadMmrCoreSettings } from "../../ampi-core/settings.js";
import { getMmrSubagentProfile } from "../../ampi-core/subagent-profiles.js";
import type { MmrCoreSettings, MmrModeKey, MmrModelPreference } from "../../ampi-core/types.js";
import { MMR_MODE_LABEL_COLORS, parseMmrHexColor } from "../editor/prompt-box.js";
import { fitMmrText, type MmrFrameHint, type MmrFrameTheme, mmrFrameInnerWidth, renderMmrFrame, renderMmrScrollbar } from "../ui/frame.js";

/**
 * The mode dial: a capturing overlay at the right edge, just above the
 * prompt box, that shows the mode and turns it.
 *
 * ```
 * ╭────────────────────────────────────────────────────────╮
 * │ •••••••••••••••••••··································· │  filled up to the mode, in its colour
 * │ low             medium           high            ultra │  the current mode bold, in its colour
 * │                                                        │
 * │ Agent:  openai-codex/gpt-5.6-sol · medium              │
 * │ Oracle: openai-codex/gpt-5.6-sol · high                │
 * │                                                        │
 * │ Balanced default for everyday coding                   │
 * ╰──────── ctrl+s/→ next · ← previous · tab list · esc close ─╯
 * ```
 *
 * - 58 columns wide, or the terminal width less four. No padding row.
 * - Ctrl+S or → turns to the next mode (low → medium → high → ultra →
 *   low), ← to the previous one. From `free` either direction lands on
 *   `medium`. Each turn applies the mode at once.
 * - Tab switches to the list view: the four ring modes, then the modes
 *   other extensions registered, then `free`, one row each. ↑/↓ move the
 *   selection and apply that mode at once; Tab goes back.
 * - On a registered mode the dial opens on the list. Turning from one, as
 *   from `free`, lands on `medium`.
 * - Esc closes. So does a quiet spell: the dial closes itself
 *   {@link MMR_MODE_DIAL_IDLE_MS} after the last key.
 */

/** Preferred width; Pi narrows the box to the terminal width less four. */
export const MMR_MODE_DIAL_WIDTH = 58;
/** The dial closes itself this long after the last key. */
export const MMR_MODE_DIAL_IDLE_MS = 2000;
/** List rows shown at most; matches the dial's content height. */
export const MMR_MODE_LIST_ROWS = 7;
export const MMR_MODE_LIST_TITLE = "Modes";

/** The modes on the dial, in turning order. `free` and registered modes sit outside the ring. */
export const MMR_MODE_DIAL_RING = ["low", "medium", "high", "ultra"] as const satisfies readonly MmrModeKey[];

/** One line per mode for the dial and the list. */
export const MMR_MODE_DIAL_DESCRIPTIONS: Readonly<Record<MmrModeKey, string>> = {
  low: "Quick, focused work on small, clear changes",
  medium: "Balanced default for everyday coding",
  high: "Demanding work, with extra reasoning",
  ultra: "Maximum effort for the hardest problems",
  free: "Stock Pi: your own model, no ampi routing",
};

const DIAL_HINTS: readonly MmrFrameHint[] = [
  { key: "ctrl+s/→", text: "next" },
  { key: "←", text: "previous" },
  { key: "tab", text: "list" },
  { key: "esc", text: "close" },
];
const LIST_HINTS: readonly MmrFrameHint[] = [
  { key: "↑↓", text: "choose" },
  { key: "tab", text: "dial" },
  { key: "esc", text: "close" },
];
const NOT_AVAILABLE = "not available";
/** Rows a short terminal keeps for the prompt box and the list's borders. */
const LIST_RESERVED_ROWS = 9;

/** The models a mode would run: the main agent and the oracle subagent. */
export interface MmrModeRoutes {
  readonly agent?: string;
  readonly oracle?: string;
}

export type MmrModeDialView = "dial" | "list";

/** One row of the list view. */
export interface MmrModeDialRow {
  /** The mode's key: a built-in key or a registered key. */
  readonly key: string;
  readonly name: string;
  /** The dim second column. */
  readonly detail: string;
}

/**
 * The list view's rows: `low`, `medium`, `high`, `ultra`, the registered
 * modes in registration order, then `free`. A registered row's second column
 * is its description, else its source.
 */
export function listMmrModeDialRows(): MmrModeDialRow[] {
  const builtin = (key: MmrModeKey): MmrModeDialRow => ({ key, name: MMR_MODES[key].displayName, detail: MMR_MODE_DIAL_DESCRIPTIONS[key] });
  return [
    ...MMR_MODE_DIAL_RING.map(builtin),
    ...listMmrModes().map((mode) => ({ key: mode.key, name: mode.label, detail: registeredDetail(mode) })),
    builtin("free"),
  ];
}

function registeredDetail(mode: MmrRegisteredMode): string {
  return mode.description ?? mode.source;
}

function isBuiltinMode(mode: string): mode is MmrModeKey {
  return Object.hasOwn(MMR_MODES, mode);
}

export interface MmrModeDialOptions {
  /** The active mode when the dial opens (a built-in or registered key); `undefined` counts as `medium`. */
  readonly mode: string | undefined;
  readonly theme: MmrFrameTheme;
  /** The models the dial names for a mode. */
  readonly routes: (mode: string) => MmrModeRoutes;
  /** Switch to `mode` (a built-in or registered key) now. */
  readonly apply: (mode: string) => void;
  /** Called once, when the dial closes. */
  readonly onClose: () => void;
  /** Redraw after a change that came from a timer or a command, not a key. */
  readonly requestRender?: () => void;
  readonly setTimer: (callback: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly idleMs?: number;
  /** Terminal height, to shorten the list on short terminals. */
  readonly terminalRows?: () => number | undefined;
}

function modeColor(mode: string): readonly [number, number, number] | undefined {
  if (isBuiltinMode(mode)) return MMR_MODE_LABEL_COLORS[mode];
  const registered = getMmrRegisteredMode(mode);
  return registered ? parseMmrHexColor(registered.color) : undefined;
}

function paintMode(theme: MmrFrameTheme, mode: string, text: string, bold: boolean): string {
  const rgb = modeColor(mode);
  if (!rgb) return bold ? theme.bold(text) : text;
  return theme.style(text, { fg: rgbColor(rgb[0], rgb[1], rgb[2]), bold });
}

/** Filled cells of a bar `width` cells long: the first cell for `low` and `free`, all of them for `ultra`. */
export function mmrModeDialFill(mode: string, width: number): number {
  const step = Math.max(0, (MMR_MODE_DIAL_RING as readonly string[]).indexOf(mode));
  return 1 + Math.round(((width - 1) * step) / (MMR_MODE_DIAL_RING.length - 1));
}

export class MmrModeDial implements Component {
  private readonly theme: MmrFrameTheme;
  private readonly options: MmrModeDialOptions;
  private mode: string;
  private view: MmrModeDialView;
  private listOffset = 0;
  private timer: unknown;
  private closed = false;

  constructor(options: MmrModeDialOptions) {
    this.options = options;
    this.theme = options.theme;
    this.mode = options.mode ?? "medium";
    // A registered mode has no place on the ring; the list shows it.
    this.view = isBuiltinMode(this.mode) ? "dial" : "list";
    this.armTimer();
  }

  /** The mode the dial points at. */
  getMode(): string {
    return this.mode;
  }

  getView(): MmrModeDialView {
    return this.view;
  }

  isClosed(): boolean {
    return this.closed;
  }

  /** Turn the dial `step` places along the ring and apply the mode. */
  turn(step: 1 | -1): void {
    if (this.closed) return;
    const ring: readonly string[] = MMR_MODE_DIAL_RING;
    const index = ring.indexOf(this.mode);
    const next = index === -1 ? "medium" : ring[(index + step + ring.length) % ring.length];
    this.select(next);
    this.armTimer();
    this.options.requestRender?.();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== undefined) this.options.clearTimer(this.timer);
    this.timer = undefined;
    this.options.onClose();
  }

  handleInput(data: string): void {
    if (this.closed) return;
    const keybindings = getKeybindings();
    if (keybindings.matches(data, "tui.select.cancel")) {
      this.close();
      return;
    }
    this.armTimer();
    if (matchesKey(data, "tab")) {
      this.view = this.view === "dial" ? "list" : "dial";
    } else if (this.view === "dial") {
      if (matchesKey(data, "ctrl+s") || matchesKey(data, "right")) this.turn(1);
      else if (matchesKey(data, "left")) this.turn(-1);
    } else if (keybindings.matches(data, "tui.select.up")) {
      this.moveInList(-1);
    } else if (keybindings.matches(data, "tui.select.down")) {
      this.moveInList(1);
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    return this.view === "dial" ? this.renderDial(width) : this.renderList(width);
  }

  private select(mode: string): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.options.apply(mode);
  }

  private moveInList(delta: number): void {
    const keys = listMmrModeDialRows().map((row) => row.key);
    const index = keys.indexOf(this.mode);
    const next = keys[Math.max(0, Math.min(keys.length - 1, index + delta))];
    if (next) this.select(next);
  }

  private armTimer(): void {
    if (this.timer !== undefined) this.options.clearTimer(this.timer);
    this.timer = this.options.setTimer(() => {
      this.timer = undefined;
      this.close();
    }, this.options.idleMs ?? MMR_MODE_DIAL_IDLE_MS);
  }

  private renderDial(width: number): string[] {
    const theme = this.theme;
    const inner = mmrFrameInnerWidth(width);
    const mode = this.mode;

    const filled = mmrModeDialFill(mode, inner);
    const bar = `${paintMode(theme, mode, "•".repeat(filled), true)}${theme.fg("dim", "·".repeat(Math.max(0, inner - filled)))}`;

    // Each label sits at its share of the free space, so `low` starts the
    // row, `ultra` ends it, and the middle two fall under their part of the bar.
    let labels = "";
    MMR_MODE_DIAL_RING.forEach((label, step) => {
      const start = Math.round(((inner - label.length) * step) / (MMR_MODE_DIAL_RING.length - 1));
      const gap = Math.max(labels.length === 0 ? 0 : 1, start - visibleWidth(labels));
      labels += " ".repeat(gap);
      labels += label === mode ? paintMode(theme, label, label, true) : theme.fg("dim", label);
    });

    const routes = this.options.routes(mode);
    const route = (label: string, value: string | undefined) => `${label}${theme.fg("dim", fitMmrText(value ?? NOT_AVAILABLE, inner - label.length))}`;
    const detail = isBuiltinMode(mode) ? MMR_MODE_DIAL_DESCRIPTIONS[mode] : listMmrModeDialRows().find((row) => row.key === mode)?.detail ?? "";
    const description = theme.fg("dim", fitMmrText(detail, inner));

    return renderMmrFrame(
      {
        lines: [bar, labels, "", route("Agent:  ", routes.agent), route("Oracle: ", routes.oracle), "", description],
        hints: DIAL_HINTS,
        topPadding: false,
      },
      width,
      theme,
    );
  }

  private renderList(width: number): string[] {
    const theme = this.theme;
    const inner = mmrFrameInnerWidth(width);
    const rows = listMmrModeDialRows();
    const total = rows.length;
    const terminalRows = this.options.terminalRows?.();
    const visible = Math.max(
      1,
      Math.min(total, MMR_MODE_LIST_ROWS, terminalRows === undefined ? total : terminalRows - LIST_RESERVED_ROWS),
    );
    const selected = rows.findIndex((row) => row.key === this.mode);
    if (selected < this.listOffset) this.listOffset = selected;
    if (selected >= this.listOffset + visible) this.listOffset = selected - visible + 1;
    this.listOffset = Math.max(0, Math.min(this.listOffset, total - visible));

    const lines: string[] = [];
    for (let index = this.listOffset; index < this.listOffset + visible; index++) {
      const row = rows[index];
      const current = row.key === this.mode;
      const marker = current ? " ‣ " : "   ";
      const name = fitMmrText(row.name, Math.max(1, inner - marker.length));
      const room = Math.max(0, inner - marker.length - visibleWidth(name) - 2);
      const description = fitMmrText(row.detail, room);
      lines.push(`${paintMode(theme, row.key, `${marker}${name}`, current)}  ${theme.fg("dim", description)}`);
    }
    const scrollbar = renderMmrScrollbar({ total, visible, offset: this.listOffset }, theme);
    return renderMmrFrame(
      { title: MMR_MODE_LIST_TITLE, lines, gutter: scrollbar, hints: LIST_HINTS, topPadding: false },
      width,
      theme,
    );
  }
}

export interface MmrModeDialOpenOptions extends Pick<MmrModeDialOptions, "apply" | "setTimer" | "clearTimer" | "idleMs"> {
  /** Rows from the bottom of the screen to the top of the prompt box, as a negative offset. */
  readonly offsetY: () => number;
  /** Called with the dial once Pi has created it. */
  readonly onOpen?: (dial: MmrModeDial) => void;
}

/**
 * Open the dial on the active mode as a capturing overlay at the right edge,
 * its bottom border on the row above the prompt box. Resolves when it closes.
 */
export async function openMmrModeDial(ctx: ExtensionContext, options: MmrModeDialOpenOptions): Promise<void> {
  await ctx.ui.custom<undefined>(
    (tui, theme, _keybindings, done) => {
      const dial = new MmrModeDial({
        mode: currentModeName(),
        theme,
        routes: createMmrModeRouteReader(ctx),
        apply: options.apply,
        onClose: () => done(undefined),
        requestRender: () => tui?.requestRender(),
        setTimer: options.setTimer,
        clearTimer: options.clearTimer,
        idleMs: options.idleMs,
        terminalRows: () => tui?.terminal?.rows,
      });
      options.onOpen?.(dial);
      return dial;
    },
    {
      overlay: true,
      // A left margin of four narrows the box to the terminal width less four; the right edge stays flush.
      overlayOptions: () => ({ anchor: "bottom-right", width: MMR_MODE_DIAL_WIDTH, margin: { left: 4 }, offsetY: options.offsetY() }),
    },
  );
}

function currentModeName(): string | undefined {
  const state = getMmrModeState();
  return state ? getMmrModeName(state) : undefined;
}

function formatRoute(provider: string, model: string, thinking: string | undefined): string {
  return thinking ? `${provider}/${model} · ${thinking}` : `${provider}/${model}`;
}

/**
 * Read, without applying anything, the models a mode would run. The active
 * mode reports what ampi-core applied (thinking toggles included). Other
 * modes are resolved from their model preferences, with project and user
 * overrides, against Pi's model registry, the way ampi-core would resolve
 * them on a switch; a registered mode by its own preferences, or else its
 * base mode's. The oracle line follows the oracle subagent profile and
 * its overrides. `free` names Pi's own model and no oracle, since it drops
 * ampi's tools. Settings are read once per reader and only when first needed.
 */
export function createMmrModeRouteReader(ctx: Pick<ExtensionContext, "cwd" | "model" | "modelRegistry">): (mode: string) => MmrModeRoutes {
  let settings: MmrCoreSettings | undefined;
  const readSettings = (): MmrCoreSettings => {
    settings ??= loadMmrCoreSettings(ctx.cwd).settings;
    return settings;
  };
  const resolved = new Map<string, string | undefined>();

  function select(key: string, preferences: readonly MmrModelPreference[], thinking: MmrModelPreference["thinkingLevel"]): string | undefined {
    if (!resolved.has(key)) {
      let text: string | undefined;
      try {
        const route = selectMmrModelRoute({ modelPreferences: preferences, modeThinkingLevel: thinking, registry: ctx.modelRegistry });
        if (route.selected) text = formatRoute(route.selected.provider, route.selected.model, route.selected.thinkingLevel);
      } catch {}
      resolved.set(key, text);
    }
    return resolved.get(key);
  }

  function agent(mode: string): string | undefined {
    if (mode === "free") return ctx.model ? formatRoute(ctx.model.provider, ctx.model.id, undefined) : undefined;
    const state = getMmrModeState();
    if (state && getMmrModeName(state) === mode && state.modelApplied) return formatRoute(state.provider, state.model, state.thinkingLevel);
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

  function oracle(): string | undefined {
    const profile = getMmrSubagentProfile("oracle");
    if (!profile) return undefined;
    const preferences = readSettings().subagentModelPreferences?.oracle ?? profile.modelPreferences;
    return select("oracle", preferences, profile.thinkingLevel);
  }

  return (mode) => ({ agent: agent(mode), oracle: mode === "free" ? undefined : oracle() });
}
