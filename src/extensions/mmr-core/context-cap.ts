/**
 * Per-mode active-model context-window cap.
 *
 * `smart` mode runs on a 300k context window even when its registered route
 * (e.g. Opus 4.8) declares a 1M native window. Native Pi keys all
 * compaction, overflow, footer, percent, and `getContextUsage()` behavior off
 * `agent.state.model.contextWindow`, and `pi.setModel(model)` stores the
 * passed object directly. Passing a clone whose `contextWindow` is capped
 * therefore makes Pi compact and display exactly as it natively would at the
 * capped window — no bespoke compaction shim required.
 *
 * The cap is applied at the `setModel` call site (see `mode-controller.ts`)
 * and reasserted defensively if another extension or `/login` transiently
 * re-resolves the active model from the registry.
 */

/** Smart-mode active-model context window. */
export const MMR_SMART_CONTEXT_WINDOW = 300_000;

/**
 * Clone-and-cap a model's `contextWindow` for a given mode. No-op unless the
 * mode caps (only `smart`) and the model's window exceeds the cap. Caps DOWN
 * only, so a custom provider with a smaller window stays authoritative.
 *
 * Returns the input reference unchanged when no cap applies, so callers can
 * use identity comparison (`result !== model`) to detect whether a cap was
 * applied. A shallow clone preserves provider/id and every other field;
 * Pi's auth (`hasConfiguredAuth`/`isUsingOAuth`), `modelsAreEqual`
 * (model cycling), and compaction's `sameModel` check all compare
 * provider+id and never `contextWindow`, so the clone is safe.
 */
export function withMmrModeContextCap<T extends { contextWindow?: number }>(
  modeKey: string,
  model: T,
): T {
  if (modeKey !== "smart") return model;
  const current = model.contextWindow;
  if (typeof current !== "number" || !Number.isFinite(current)) return model;
  if (current <= MMR_SMART_CONTEXT_WINDOW) return model;
  return { ...model, contextWindow: MMR_SMART_CONTEXT_WINDOW };
}
