/**
 * Shared environment-variable parsing helpers used by mmr extensions.
 *
 * Kept intentionally minimal: extensions that need richer parsing (fallback
 * values, capped maxima, fallback-on-invalid integer parsing) layer their
 * own logic on top of these primitives so each call site retains explicit
 * control over its observable behavior.
 */

/**
 * Tri-state boolean env parser used by `mmr-web` directly and by
 * `mmr-history` as `parseBoolEnv(value) ?? false` to preserve its
 * default-false semantics.
 *
 * - `undefined` and trimmed-empty values → `undefined` ("not set"). Callers
 *   that need a strict default must apply `?? defaultValue` at the call
 *   site so a wrapper rendering an unset shell variable as `""` does not
 *   silently override a previously-set value.
 * - Truthy strings (`"true"`, `"1"`, `"yes"`, `"on"`, case-insensitive) → `true`.
 * - Explicit falsy strings (`"false"`, `"0"`, `"no"`, `"off"`,
 *   case-insensitive) → `false`.
 * - Any other string → `undefined` ("unrecognized; treat as not set").
 */
export function parseBoolEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "") return undefined;
  if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  return undefined;
}
