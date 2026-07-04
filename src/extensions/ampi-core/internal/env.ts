/**
 * Shared environment-variable parsing helpers used by mmr extensions.
 *
 * Kept intentionally minimal: extensions that need richer parsing (fallback
 * values, capped maxima, fallback-on-invalid integer parsing) layer their
 * own logic on top of these primitives so each call site retains explicit
 * control over its observable behavior.
 */

/**
 * Tri-state boolean env parser used by `ampi-web` directly and by
 * `ampi-history` as `parseBoolEnv(value) ?? false` to preserve its
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

export interface PreferredEnvValue {
  name: string;
  value: string;
}

/**
 * Read a preferred env variable with a legacy fallback.
 *
 * Non-empty preferred values take precedence even if the caller later rejects
 * the value as malformed. Empty strings behave like unset values so shell
 * wrappers that materialize absent env vars as `""` do not mask a legacy value.
 */
export function readPreferredEnv(
  env: NodeJS.ProcessEnv,
  preferredName: string,
  legacyName: string,
): PreferredEnvValue | undefined {
  const preferredValue = env[preferredName];
  if (typeof preferredValue === "string" && preferredValue.trim().length > 0) {
    return { name: preferredName, value: preferredValue };
  }

  const legacyValue = env[legacyName];
  if (typeof legacyValue === "string" && legacyValue.trim().length > 0) {
    return { name: legacyName, value: legacyValue };
  }

  return undefined;
}

/**
 * Read the first present (non-empty, non-whitespace) env variable from an
 * ordered list of names. Generalizes `readPreferredEnv` to more than two
 * candidates so a setting can accept several conventional aliases (e.g. a
 * GitHub token under branded names plus the ecosystem-standard
 * `GITHUB_TOKEN`, `GH_TOKEN`, and `GITHUB_PERSONAL_ACCESS_TOKEN`). Empty
 * strings are skipped so shell wrappers that materialize absent env vars as
 * `""` do not mask a later candidate.
 */
export function readFirstPresentEnv(
  env: NodeJS.ProcessEnv,
  ...names: string[]
): PreferredEnvValue | undefined {
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value.trim().length > 0) {
      return { name, value };
    }
  }
  return undefined;
}
