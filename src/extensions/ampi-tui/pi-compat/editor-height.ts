import type { TUI } from "@earendil-works/pi-tui";

/**
 * Text rows of Pi's prompt editor. Pi's `Editor.render` shows at most
 * `max(5, floor(rows * 0.3))` wrapped text rows, where `rows` is the
 * terminal height it reads from its protected `tui` field
 * (`tui.terminal.rows`), and scrolls the text to keep the cursor visible.
 * Neither the rule nor a way to change it is part of Pi's API.
 *
 * To show a different maximum while keeping Pi's wrapping, cursor and
 * scrolling, the prompt box hands `Editor.render` a view of the TUI whose
 * terminal reports a height for which Pi's rule yields the wanted count.
 * Pi's PageUp and PageDown use the same rule for their page size, so the box
 * hands the view to `Editor.handleInput` too. Pi's floor of 5 rows still
 * applies.
 */

/** Pi's minimum for its maximum number of text rows. */
export const MMR_PI_EDITOR_MIN_MAX_LINES = 5;

/** The smallest terminal height for which Pi's rule shows `maxLines` text rows (or its floor of 5). */
export function mmrPiEditorRowsForMaxLines(maxLines: number): number {
  let rows = Math.max(1, Math.floor(maxLines / 0.3) - 1);
  while (Math.floor(rows * 0.3) < maxLines) rows += 1;
  return rows;
}

const views = new WeakMap<TUI, { rows: number; view: TUI }>();

/**
 * A view of `tui` whose `terminal.rows` makes Pi's editor show at most
 * `maxLines` text rows. Every other member is the real TUI's, with methods
 * bound to it, so a render request from inside the editor reaches the real
 * TUI. Views are cached per TUI and height.
 */
export function mmrTuiWithEditorMaxLines(tui: TUI, maxLines: number): TUI {
  const rows = mmrPiEditorRowsForMaxLines(maxLines);
  const cached = views.get(tui);
  if (cached?.rows === rows) return cached.view;
  const forward = <T extends object>(target: T, override: Record<PropertyKey, unknown>): T =>
    new Proxy(target, {
      get(object, name) {
        if (Object.hasOwn(override, name)) return override[name];
        const value = Reflect.get(object, name, object);
        return typeof value === "function" ? value.bind(object) : value;
      },
    });
  const view = forward(tui, { terminal: forward(tui.terminal, { rows }) });
  views.set(tui, { rows, view });
  return view;
}
