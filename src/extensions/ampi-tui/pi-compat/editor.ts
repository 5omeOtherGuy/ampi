import type { TUI } from "@earendil-works/pi-tui";

/**
 * Pi's prompt editor and its app actions. The editor is a `CustomEditor`
 * that keeps its action handlers (`app.editor.external` and the like) in an
 * `actionHandlers` map; `TUI.getFocusedComponent()` tells whether it has
 * focus. Neither is part of Pi's extension API.
 */

interface FocusAwareTui {
  getFocusedComponent?: () => unknown;
}

interface ActionEditor {
  actionHandlers: Map<string, () => void>;
}

function focusedEditor(tui: TUI | undefined): ActionEditor | undefined {
  const getFocused = (tui as (TUI & FocusAwareTui) | undefined)?.getFocusedComponent;
  if (typeof getFocused !== "function") return undefined;
  const focused = getFocused.call(tui) as Partial<ActionEditor> | null | undefined;
  return focused?.actionHandlers instanceof Map ? (focused as ActionEditor) : undefined;
}

/**
 * Whether Pi's prompt editor has keyboard focus. True when focus cannot be
 * determined (no TUI handle yet), so keys keep working rather than going dead.
 * False while a selector, dialog or capturing overlay has focus.
 */
export function isMmrEditorFocused(tui: TUI | undefined): boolean {
  const getFocused = (tui as (TUI & FocusAwareTui) | undefined)?.getFocusedComponent;
  if (typeof getFocused !== "function") return true;
  return focusedEditor(tui) !== undefined;
}

/** Whether the focused editor has a handler for Pi app action `action`. */
export function hasMmrEditorAction(tui: TUI | undefined, action: string): boolean {
  return focusedEditor(tui)?.actionHandlers.has(action) ?? false;
}

/** Run Pi app action `action` on the focused editor. Returns false when it is not reachable. */
export function runMmrEditorAction(tui: TUI | undefined, action: string): boolean {
  const handler = focusedEditor(tui)?.actionHandlers.get(action);
  if (typeof handler !== "function") return false;
  handler();
  return true;
}
