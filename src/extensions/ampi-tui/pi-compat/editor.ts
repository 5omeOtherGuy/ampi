import { getKeybindings, type Keybinding, matchesKey, type TUI } from "@earendil-works/pi-tui";

/**
 * Pi's prompt editor and its app actions. The editor is a `CustomEditor`
 * that keeps its action handlers (`app.editor.external` and the like) in an
 * `actionHandlers` map; `TUI.getFocusedComponent()` tells whether it has
 * focus. The editor also reports whether its autocomplete list is open and
 * records how many text rows its last render drew, its `onSubmit` handler
 * receives what Enter submits, and `addToHistory` keeps a prompt for Up to
 * recall. It has no cursor setter: the cursor moves only through the keys
 * its `handleInput` reads. None of this is part of Pi's extension API.
 */

interface FocusAwareTui {
  getFocusedComponent?: () => unknown;
}

interface ActionEditor {
  actionHandlers: Map<string, () => void>;
  handleInput?: (data: string) => void;
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

/** The pi-tui editor actions that move the cursor to either end of its line. */
export const MMR_EDITOR_LINE_ACTIONS = {
  start: "tui.editor.cursorLineStart",
  end: "tui.editor.cursorLineEnd",
} as const satisfies Record<string, Keybinding>;

const CSI_FINALS: Readonly<Record<string, string>> = { up: "A", down: "B", right: "C", left: "D", home: "H", end: "F" };

/**
 * Terminal input for pi-tui key id `key` (`home`, `ctrl+e`, `alt+left` …),
 * checked against pi-tui's own key matcher; `undefined` when none of the
 * encodings tried here reads back as that key.
 */
function encodeKey(key: string): string | undefined {
  const parts = key.toLowerCase().split("+");
  const base = parts.pop() ?? "";
  const mods = new Set(parts);
  const modifier = 1 + (mods.has("shift") ? 1 : 0) + (mods.has("alt") ? 2 : 0) + (mods.has("ctrl") ? 4 : 0);
  const candidates: string[] = [];
  const final = CSI_FINALS[base];
  if (final) candidates.push(modifier === 1 ? `\x1b[${final}` : `\x1b[1;${modifier}${final}`);
  if ([...base].length === 1) {
    if (mods.size === 0) candidates.push(base);
    if (mods.size === 1 && mods.has("ctrl") && /^[a-z]$/.test(base)) candidates.push(String.fromCharCode(base.charCodeAt(0) - 96));
    if (mods.size === 1 && mods.has("alt")) candidates.push(`\x1b${base}`);
    candidates.push(`\x1b[${base.codePointAt(0)};${modifier}u`);
  }
  return candidates.find((data) => matchesKey(data, key as Parameters<typeof matchesKey>[1]));
}

/**
 * Move the focused editor's cursor to the start or end of its current line,
 * by handing it the first key pi-tui binds to that action (Home or End by
 * default, or the key rebound in Pi's keybindings). Returns false when the
 * editor is not reachable or no bound key can be encoded. The caller redraws.
 */
export function moveMmrEditorCursorInLine(tui: TUI | undefined, to: keyof typeof MMR_EDITOR_LINE_ACTIONS): boolean {
  const editor = focusedEditor(tui);
  if (typeof editor?.handleInput !== "function") return false;
  for (const key of getKeybindings().getKeys(MMR_EDITOR_LINE_ACTIONS[to])) {
    const data = encodeKey(key);
    if (data === undefined) continue;
    editor.handleInput(data);
    return true;
  }
  return false;
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

/** Add `text` to the focused editor's history, so Up recalls it. Returns false when the editor is not reachable. */
export function addMmrEditorHistory(tui: TUI | undefined, text: string): boolean {
  const editor = focusedEditor(tui) as (ActionEditor & { addToHistory?: (text: string) => void }) | undefined;
  if (typeof editor?.addToHistory !== "function") return false;
  editor.addToHistory(text);
  return true;
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
