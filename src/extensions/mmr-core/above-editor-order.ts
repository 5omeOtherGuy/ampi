/**
 * Cross-extension ordering for `aboveEditor` pinned widgets.
 *
 * Pi renders `aboveEditor` widgets in Map INSERTION order (top→bottom) and
 * `setWidget(key, ...)` deletes the key then re-appends it, so the most
 * recently set widget always renders at the BOTTOM (closest to the editor).
 *
 * The mmr-subagents background-task widget must always sit ABOVE the
 * mmr-toolbox `task_list` widget. The two widgets live in separate extensions
 * and refresh independently, so whenever the background widget re-sets itself
 * it lands below an already-present task-list widget. To restore the invariant
 * the background widget, right after setting itself, asks every lower-priority
 * `aboveEditor` widget to re-emit itself; re-emitting re-appends it to the
 * bottom, back below the background widget.
 *
 * Lower widgets register a `reassert` callback that re-projects themselves from
 * their own source of truth (not a cached snapshot), so the callback is
 * self-correcting — e.g. a hidden task list stays cleared and an emptied list
 * clears — rather than replaying stale state.
 */

/**
 * Re-emit a lower-priority `aboveEditor` widget from its live state. `ctx` is
 * the host extension context forwarded by the caller (it carries `ui` and,
 * for the task list, `sessionManager`); it is typed `unknown` so the registry
 * stays decoupled from any one extension's context shape.
 */
export type AboveEditorReassert = (ctx: unknown) => void;

/** Widget id → reassert callback. Keyed so a re-registration overwrites cleanly. */
const lowerWidgets = new Map<string, AboveEditorReassert>();

/**
 * Register (or replace) a widget that must stay BELOW the background-task
 * widget in the `aboveEditor` stack. Idempotent per `id`.
 */
export function registerLowerAboveEditorWidget(id: string, reassert: AboveEditorReassert): void {
  lowerWidgets.set(id, reassert);
}

/**
 * Re-emit every registered lower-priority widget so it re-appends below the
 * widget that just set itself. Call this immediately AFTER setting the
 * higher-priority widget. Best-effort: a failing reassert never propagates, so
 * a widget refresh can never demote a successful tool call.
 */
export function reassertLowerAboveEditorWidgets(ctx: unknown): void {
  for (const reassert of lowerWidgets.values()) {
    try {
      reassert(ctx);
    } catch {
      // Best-effort ordering only.
    }
  }
}

/** Test-only: drop all registrations so a fresh extension load starts clean. */
export function resetLowerAboveEditorWidgetsForTest(): void {
  lowerWidgets.clear();
}
