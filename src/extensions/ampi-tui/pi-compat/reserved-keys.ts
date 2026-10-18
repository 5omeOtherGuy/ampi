import type { MmrKeyCombo } from "../../ampi-core/keymap.js";

/**
 * Keys `pi.registerShortcut` cannot take. Pi skips an extension shortcut
 * whose key is bound by default to one of the app actions it reserves for
 * itself (interrupt, clear, exit, copy, submit and so on). Pi keeps that
 * action list internal; the probe test compares it with Pi's source.
 */

/** Pi's reserved app actions with their default keys (Linux and macOS, then Windows), in ampi's canonical key form. */
export const MMR_PI_RESERVED_ACTION_KEYS: Readonly<Record<string, readonly string[]>> = {
  "app.interrupt": ["esc"],
  "app.clear": ["ctrl+c"],
  "app.exit": ["ctrl+d"],
  "app.suspend": ["ctrl+z"],
  "app.thinking.cycle": ["shift+tab"],
  "app.model.cycleForward": ["ctrl+p"],
  "app.model.cycleBackward": ["ctrl+shift+p", "alt+p"],
  "app.model.select": ["ctrl+l"],
  "app.tools.expand": ["ctrl+o"],
  "app.thinking.toggle": ["ctrl+t"],
  "app.editor.external": ["ctrl+g"],
  "app.message.copy": ["ctrl+x"],
  "app.message.followUp": ["alt+enter", "ctrl+q"],
  "tui.input.submit": ["enter"],
  "tui.select.confirm": ["enter"],
  "tui.select.cancel": ["esc", "ctrl+c"],
  "tui.input.copy": ["ctrl+c"],
  "tui.editor.deleteToLineEnd": ["ctrl+k"],
};

/** Every key in {@link MMR_PI_RESERVED_ACTION_KEYS}. */
export const MMR_PI_RESERVED_SHORTCUT_KEYS: ReadonlySet<string> = new Set(Object.values(MMR_PI_RESERVED_ACTION_KEYS).flat());

const PI_KEY_NAMES: Readonly<Record<string, string>> = { esc: "escape", pageup: "pageUp", pagedown: "pageDown" };

/** Pi's key id for an ampi combo: `meta` is `super`, `esc` is `escape`, page keys are camel-cased. */
export function toMmrPiKeyId(combo: MmrKeyCombo): string {
  const parts: string[] = [];
  if (combo.ctrl) parts.push("ctrl");
  if (combo.alt) parts.push("alt");
  if (combo.shift) parts.push("shift");
  if (combo.meta) parts.push("super");
  parts.push(PI_KEY_NAMES[combo.key] ?? combo.key);
  return parts.join("+");
}
