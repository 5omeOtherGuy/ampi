/**
 * Auto-compaction for locked modes.
 *
 * Pi compacts on its own once the context passes `contextWindow -
 * compaction.reserveTokens`, a fixed token reserve that extensions cannot
 * change at runtime. Locked modes add an earlier, proportional trigger: once a
 * run has fully settled and the context holds at least `threshold` of the
 * active window (90% by default), ampi asks Pi to compact once.
 *
 * The trigger runs only on Pi's `agent_settled` event, never between turns:
 * `ctx.compact()` aborts any running agent operation first, so calling it
 * mid-run would cut the run short. Pi's own reserve-based check still covers
 * long runs between turns.
 *
 * Guards:
 * - one compaction at a time: no new request while an earlier one is running;
 * - backoff after a failure: no retry until the context grows past the token
 *   count of the failed attempt;
 * - only the interactive TUI auto-compacts: it queues messages sent during a
 *   compaction and sends them afterwards. `rpc` clients may send their next
 *   prompt as soon as `agent_settled` arrives, which Pi rejects while a
 *   compaction runs, so `rpc` is skipped along with one-shot runs (`print`,
 *   `json`);
 * - `free` mode, subagent workers and a session whose Pi settings turn
 *   `compaction.enabled` off never auto-compact.
 *
 * The window is the active model's `contextWindow`, which already carries the
 * mode's context profile cap (Medium's 300k), so the threshold follows the
 * window the mode advertises.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./internal/json.js";
import type { MmrCoreSettings, MmrModeKey } from "./types.js";

/** Fraction of the context window at which a locked mode compacts by default. */
export const MMR_AUTO_COMPACT_DEFAULT_THRESHOLD = 0.9;

/** A finished auto-compaction, kept for `/ampi-status debug`. */
export interface MmrAutoCompactRecord {
  /** ISO timestamp of the compaction's completion. */
  at: string;
  tokensBefore: number;
  /** Pi's estimate of the context after compaction, when it reports one. */
  tokensAfter?: number;
  contextWindow: number;
}

/** A failed auto-compaction and the token count the backoff waits to exceed. */
export interface MmrAutoCompactFailure {
  at: string;
  tokens: number;
  message: string;
}

export interface MmrAutoCompactStatus {
  /** Active threshold as a fraction of the window, or undefined when turned off. */
  threshold: number | undefined;
  /** Why auto-compaction is off, when `threshold` is undefined. */
  offReason?: string;
  running: boolean;
  last?: MmrAutoCompactRecord;
  /** Set while the backoff after a failed attempt is in effect. */
  failure?: MmrAutoCompactFailure;
}

export interface MmrAutoCompactor {
  /** Apply the loaded `ampiCore.autoCompact` value (undefined means the default). */
  setSetting(setting: MmrCoreSettings["autoCompact"]): void;
  /**
   * Called once a run has settled. Starts a compaction and returns true when
   * every guard passes and the context is at or above the threshold.
   */
  maybeCompact(ctx: ExtensionContext, mode: MmrModeKey | undefined): boolean;
  getStatus(mode: MmrModeKey | undefined): MmrAutoCompactStatus;
}

export interface CreateMmrAutoCompactorOptions {
  /** True when Pi's own settings turn automatic compaction off. */
  isPiCompactionDisabled?: () => boolean;
  now?: () => Date;
}

/**
 * Read `ampiCore.autoCompact`: `false` turns auto-compaction off, an object
 * with an optional `threshold` above 0 and at most 1 sets the trigger. Any
 * other value is ignored with a warning, which keeps the default.
 */
export function readMmrAutoCompactSetting(
  value: unknown,
  context: { filePath: string; settingPath: string; warnings: string[] },
): MmrCoreSettings["autoCompact"] | undefined {
  if (value === false) return false;
  if (isRecord(value)) {
    if (!("threshold" in value)) return { threshold: MMR_AUTO_COMPACT_DEFAULT_THRESHOLD };
    const threshold = value.threshold;
    if (typeof threshold === "number" && threshold > 0 && threshold <= 1) return { threshold };
  }
  context.warnings.push(
    `Ignoring ${context.settingPath} in ${context.filePath}: expected false or { "threshold": <number above 0 and at most 1> }.`,
  );
  return undefined;
}

export function createMmrAutoCompactor(options: CreateMmrAutoCompactorOptions = {}): MmrAutoCompactor {
  const now = options.now ?? (() => new Date());
  let setting: MmrCoreSettings["autoCompact"];
  let running = false;
  let last: MmrAutoCompactRecord | undefined;
  let failure: MmrAutoCompactFailure | undefined;

  function resolve(mode: MmrModeKey | undefined): { threshold?: number; offReason?: string } {
    if (setting === false) return { offReason: "ampiCore.autoCompact is false" };
    if (!mode) return { offReason: "no mode resolved" };
    if (mode === "free") return { offReason: "free mode" };
    if (options.isPiCompactionDisabled?.()) return { offReason: "Pi compaction.enabled is false" };
    return { threshold: setting?.threshold ?? MMR_AUTO_COMPACT_DEFAULT_THRESHOLD };
  }

  return {
    setSetting(value) {
      setting = value;
    },

    maybeCompact(ctx, mode) {
      if (ctx.mode !== "tui") return false;
      const { threshold } = resolve(mode);
      if (threshold === undefined || running) return false;

      const usage = ctx.getContextUsage();
      if (!usage || usage.tokens === null || usage.contextWindow <= 0) return false;
      const tokens = usage.tokens;
      if (tokens < threshold * usage.contextWindow) return false;
      if (failure && tokens <= failure.tokens) return false;

      running = true;
      ctx.compact({
        onComplete: (result) => {
          running = false;
          failure = undefined;
          last = {
            at: now().toISOString(),
            tokensBefore: result.tokensBefore,
            ...(result.estimatedTokensAfter !== undefined ? { tokensAfter: result.estimatedTokensAfter } : {}),
            contextWindow: usage.contextWindow,
          };
        },
        onError: (error) => {
          running = false;
          failure = { at: now().toISOString(), tokens, message: error.message.replace(/\s+/g, " ").trim() };
        },
      });
      return true;
    },

    getStatus(mode) {
      const { threshold, offReason } = resolve(mode);
      return {
        threshold,
        ...(offReason ? { offReason } : {}),
        running,
        ...(last ? { last } : {}),
        ...(failure ? { failure } : {}),
      };
    },
  };
}
