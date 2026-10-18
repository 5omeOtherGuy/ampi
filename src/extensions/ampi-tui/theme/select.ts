import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Name of the theme `ampi-tui` ships in `theme/ampi.json`. */
export const MMR_TUI_THEME_NAME = "ampi";

/** Widget key of the empty component that keeps the theme in place. */
export const MMR_TUI_THEME_KEEPER = "ampi-tui-theme";

/**
 * Use the ampi theme while Pi is on its default `system` theme. A theme the
 * user picked in `/settings` (or with `--use-theme`) stays. The theme object
 * is passed rather than its name, because switching by name would write
 * `theme` into the user's settings file.
 */
export function applyMmrTuiTheme(ctx: ExtensionContext): void {
  if (ctx.ui.theme.name !== "system") return;
  const theme = ctx.ui.getTheme(MMR_TUI_THEME_NAME);
  if (theme) ctx.ui.setTheme(theme);
}

/**
 * Apply the ampi theme for this session and keep it there. After `/reload`,
 * `/new`, `/resume` and `/fork`, Pi applies the theme from settings again once
 * `session_start` has run. Pi invalidates every component when the theme
 * changes, so an empty widget below the editor (which draws no rows there)
 * puts the ampi theme back whenever Pi returns to `system`. Pi clears the
 * widget with the rest of the extension UI when the session ends.
 */
export function keepMmrTuiTheme(ctx: ExtensionContext): void {
  applyMmrTuiTheme(ctx);
  ctx.ui.setWidget(
    MMR_TUI_THEME_KEEPER,
    () => ({
      render: () => [],
      invalidate: () => applyMmrTuiTheme(ctx),
    }),
    { placement: "belowEditor" },
  );
}
