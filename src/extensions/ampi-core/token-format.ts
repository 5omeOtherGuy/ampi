/**
 * Shared compact token-count formatter owned by ampi-core.
 *
 * This is the single source of truth for the lower-tier `k`/`M` compact format
 * that both `ampi-workers/worker-usage-format.ts` (`formatMmrWorkerTokens`) and
 * `ampi-core/status.ts` (`formatFooterTokens`, below 10M) render. Keeping it in
 * neutral ampi-core respects the established cross-extension import direction
 * (other extensions depend on ampi-core, never the reverse).
 *
 * `Intl.NumberFormat({ notation: "compact" })` is intentionally NOT used: it
 * changes casing (`K`/`M`), precision, and introduces locale variance into
 * operator-facing footer text, so it would not be byte-for-byte equivalent to
 * this stable, locale-independent format.
 */

/**
 * Format a non-negative token count using ampi-core's compact tiers:
 *   - `< 1_000`      -> the raw count
 *   - `< 10_000`     -> one-decimal `k` (e.g. `1.5k`)
 *   - `< 1_000_000`  -> rounded whole `k` (e.g. `12k`)
 *   - otherwise      -> one-decimal `M` (e.g. `1.5M`)
 */
export function formatMmrCompactTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}
