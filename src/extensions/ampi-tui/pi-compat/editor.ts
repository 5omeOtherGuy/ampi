import type { TUI } from "@earendil-works/pi-tui";

/**
 * Pi's prompt editor and its app actions. The editor is a `CustomEditor`
 * that keeps its action handlers (`app.editor.external` and the like) in an
 * `actionHandlers` map; `TUI.getFocusedComponent()` tells whether it has
 * focus. The editor also reports whether its autocomplete list is open and
 * records how many text rows its last render drew, and its `onSubmit`
 * handler receives what Enter submits. None of this is part of Pi's
 * extension API.
 */

interface FocusAwareTui {
  getFocusedComponent?: () => unknown;
}

interface ActionEditor {
  actionHandlers: Map<string, () => void>;
  isShowingAutocomplete?: () => boolean;
  renderedVisibleLineCount?: unknown;
  renderedAutocompleteHeight?: unknown;
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

/** Whether the focused editor's autocomplete list is open. In Pi, Esc then closes the list and does nothing else. */
export function isMmrEditorShowingAutocomplete(tui: TUI | undefined): boolean {
  const editor = focusedEditor(tui);
  return typeof editor?.isShowingAutocomplete === "function" ? editor.isShowingAutocomplete() === true : false;
}

/**
 * Rows the focused editor drew in its last render: the wrapped text rows it
 * shows, its two borders, and an open autocomplete list. `undefined` when the
 * editor is not reachable or does not record its height.
 */
export function getMmrEditorRenderedHeight(tui: TUI | undefined): number | undefined {
  const editor = focusedEditor(tui);
  const rows = editor?.renderedVisibleLineCount;
  if (typeof rows !== "number") return undefined;
  const autocomplete = typeof editor?.renderedAutocompleteHeight === "number" ? editor.renderedAutocompleteHeight : 0;
  return rows + 2 + autocomplete;
}

interface SubmittingEditor extends ActionEditor {
  onSubmit?: (text: string) => unknown;
}

function submitHandler(tui: TUI | undefined): ((text: string) => unknown) | undefined {
  const onSubmit = (focusedEditor(tui) as SubmittingEditor | undefined)?.onSubmit;
  return typeof onSubmit === "function" ? onSubmit : undefined;
}

/** Whether {@link submitMmrEditorText} can reach the focused editor's submit handler. */
export function canMmrSubmitEditorText(tui: TUI | undefined): boolean {
  return submitHandler(tui) !== undefined;
}

/**
 * Hand `text` to the focused editor's submit handler, as Enter does. Pi runs
 * its built-in slash commands only from there. Returns false when the handler
 * is not reachable.
 */
export function submitMmrEditorText(tui: TUI | undefined, text: string): boolean {
  const onSubmit = submitHandler(tui);
  if (!onSubmit) return false;
  void Promise.resolve(onSubmit(text)).catch(() => {});
  return true;
}
