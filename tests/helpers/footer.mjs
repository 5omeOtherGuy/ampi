// Helpers for asserting against MMR's footer renderer.
//
// `updateMmrStatus` registers a footer factory via `ctx.ui.setFooter`. The
// factory takes a `(host, theme, statusBus)` triple and returns an object
// with a `render(width)` method that emits the two-line footer:
//
//   [0] cwd (branch)
//   [1] "<native Pi stats> <pct>%/<window> (<source>)   <model> • <mode>"
//
// These helpers remove the boilerplate from per-test footer assertions.

const DEFAULT_STATUS_BUS = {
  getGitBranch: () => undefined,
  onBranchChange: () => () => {},
  getExtensionStatuses: () => new Map(),
  getAvailableProviderCount: () => 1,
};

const PASSTHROUGH_THEME = { fg: (_name, value) => value };

/**
 * Invoke a footer factory captured by `setFooter` and return its rendered
 * lines at the given width.
 *
 * Options:
 *  - `width` (default 100): width passed to `render`.
 *  - `branch`, `extensionStatuses`, `providerCount`: overrides for the
 *    StatusBus surface the factory consumes.
 */
export function renderFooter(setFooterFactory, options = {}) {
  if (typeof setFooterFactory !== "function") {
    throw new TypeError("renderFooter: expected a footer factory function");
  }
  const statusBus = {
    ...DEFAULT_STATUS_BUS,
    getGitBranch: () => options.branch,
    getExtensionStatuses: () => options.extensionStatuses ?? new Map(),
    getAvailableProviderCount: () => options.providerCount ?? 1,
  };
  const footer = setFooterFactory({ requestRender: () => {} }, PASSTHROUGH_THEME, statusBus);
  return footer.render(options.width ?? 100);
}

/**
 * Build a regex matching MMR's status-line tail (the `<pct>%/<window> (auto)
 * ... <model> • <mode>` segment). Use with `assert.match(line, expected)`.
 */
export function statusLineMatcher({ percent, contextWindow, model, mode }) {
  if (percent == null || !contextWindow || !model || !mode) {
    throw new TypeError("statusLineMatcher: percent, contextWindow, model, and mode are required");
  }
  const pctText = String(percent).replace(".", "\\.");
  const windowText = String(contextWindow).replace(".", "\\.");
  const modelText = escapeRegex(model);
  const modeText = escapeRegex(mode);
  return new RegExp(`${pctText}%\\/${windowText} \\(auto\\).*${modelText} • ${modeText}$`);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
