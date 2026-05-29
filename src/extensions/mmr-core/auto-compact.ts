/**
 * Smart-mode auto-compact pre-prompt trigger for the Opus route.
 *
 * Pi's built-in compaction check fires when
 *   contextTokens > model.contextWindow - settings.reserveTokens
 * with `reserveTokens` defaulting to 16384, i.e. about 98.4% of a 1M window.
 * For the `claude-opus-4-8` route used by `smart`, the registered window
 * is 1M and the next user prompt can push context past the cap before Pi's
 * threshold fires (the pre-prompt check evaluated at agent-session time uses
 * the prior assistant's reported usage, not the upcoming prompt size), so this
 * module can trigger compaction earlier.
 *
 * This module decides, on each user-originated `input` event, whether to
 * preempt Pi's check and trigger compaction earlier — specifically at 90% of
 * the 1M registered window (900k tokens). The trigger is intentionally
 * narrow:
 *
 *   - Only when the active MMR mode is `smart`.
 *   - Only when the selected model id is exactly `claude-opus-4-8`.
 *   - Only when the input source is `interactive` or `rpc`. Inputs with
 *     source `extension` (the source tag Pi emits for replays submitted via
 *     `pi.sendUserMessage`) are treated as the replay arriving after a
 *     successful compaction and are passed through unchanged. This is the
 *     replay guard against re-entrant compaction loops.
 *   - Never while a subagent worker is active, regardless of mode/model.
 *   - Only when `ctx.getContextUsage()` reports a numeric token count at or
 *     above the threshold; null/undefined usage (e.g. right after a previous
 *     compaction) is treated as below-threshold.
 *
 * Inflating `assistant.usage.totalTokens` to coerce Pi's native check into
 * firing is explicitly avoided — it would distort `/mmr-status`, usage
 * accounting, and any extension that reads `ctx.getContextUsage()`.
 */

/** Tokens at which the smart-mode Opus route triggers auto-compact. */
export const MMR_SMART_OPUS_COMPACT_THRESHOLD_TOKENS = 900_000;

/** Backward-compatible export for callers that used the previous constant name. */
export const MMR_SMART_OPUS_300K_COMPACT_THRESHOLD_TOKENS = MMR_SMART_OPUS_COMPACT_THRESHOLD_TOKENS;

/** Mode key + resolved model id that the trigger is scoped to. */
export const MMR_SMART_OPUS_300K_COMPACT_MODE = "smart" as const;
export const MMR_SMART_OPUS_300K_COMPACT_MODEL_ID = "claude-opus-4-8" as const;

/** Input-event source tags that mmr-core treats as user-originated. */
export type AutoCompactInputSource = "interactive" | "rpc" | "extension";

export interface AutoCompactDecisionInput {
  /** `event.source` from Pi's `InputEvent`. */
  source: AutoCompactInputSource;
  /** `event.text` from Pi's `InputEvent`. */
  text: string;
  /** `event.images` from Pi's `InputEvent`, if any. Preserved opaquely. */
  images: readonly unknown[] | undefined;
  /** Active MMR mode state, or undefined if no mode is set. */
  modeState: { mode: string; model: string } | undefined;
  /** True when a subagent worker session is active. */
  subagentActive: boolean;
  /** Most recent context-tokens count reported by Pi for the active model. */
  usageTokens: number | null | undefined;
}

export type AutoCompactDecision =
  | { kind: "noop" }
  | {
      kind: "compact-and-replay";
      text: string;
      images: readonly unknown[] | undefined;
    };

/**
 * Pure decision for whether the smart-mode auto-compact trigger should fire
 * for the given input event. Splitting the decision from the side-effecting
 * wiring keeps the gating rules unit-testable without spinning up the full
 * extension host.
 */
export function decideAutoCompact(input: AutoCompactDecisionInput): AutoCompactDecision {
  if (input.subagentActive) return { kind: "noop" };
  if (input.source === "extension") return { kind: "noop" };
  if (!input.modeState) return { kind: "noop" };
  if (input.modeState.mode !== MMR_SMART_OPUS_300K_COMPACT_MODE) return { kind: "noop" };
  if (input.modeState.model !== MMR_SMART_OPUS_300K_COMPACT_MODEL_ID) return { kind: "noop" };
  if (typeof input.usageTokens !== "number" || !Number.isFinite(input.usageTokens)) {
    return { kind: "noop" };
  }
  if (input.usageTokens < MMR_SMART_OPUS_COMPACT_THRESHOLD_TOKENS) {
    return { kind: "noop" };
  }
  return { kind: "compact-and-replay", text: input.text, images: input.images };
}

/**
 * Build the user-message content payload that should be passed to
 * `pi.sendUserMessage` when replaying after compaction. When the original
 * input carries images, Pi's `sendUserMessage` requires the content-array
 * form `[{type:"text", text}, ...images]`; otherwise the bare string form is
 * preferred to avoid wrapping single-text prompts in an array.
 */
export function buildReplayContent(
  text: string,
  images: readonly unknown[] | undefined,
): string | unknown[] {
  if (!images || images.length === 0) return text;
  return [{ type: "text", text }, ...images];
}
