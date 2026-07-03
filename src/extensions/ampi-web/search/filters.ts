import type { AppliedFilter, Recency } from "./types.js";

/**
 * Shared domain/recency filter logic for `ampi-web` search backends.
 *
 * Domains are always honorable: a backend that cannot express them in its
 * upstream request post-filters the parsed results on hostname. Recency is
 * "native or nothing" — backends that expose a freshness/time-range
 * parameter map it directly; backends without reliable result dates report
 * the filter as unsupported rather than faking it with query-string hacks.
 */

/** Brave Search `freshness` codes keyed by recency window. */
export const BRAVE_FRESHNESS_BY_RECENCY: Record<Recency, string> = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
};

/** SearXNG `time_range` values keyed by recency window. */
export const SEARXNG_TIME_RANGE_BY_RECENCY: Record<Recency, string> = {
  day: "day",
  week: "week",
  month: "month",
  year: "year",
};

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.+$/, "");
}

function normalizeDomain(value: string): string {
  return normalizeHost(value).replace(/^\.+/, "");
}

/**
 * Suffix-aware hostname match: `domain` matches `hostname` when they are
 * equal or when `hostname` ends at a label boundary with `.domain`. Both
 * sides are lowercased and trailing-dot/leading-dot tolerant.
 */
export function hostnameMatchesDomain(hostname: string, domain: string): boolean {
  const host = normalizeHost(hostname);
  const dom = normalizeDomain(domain);
  if (!host || !dom) return false;
  return host === dom || host.endsWith(`.${dom}`);
}

function hostnameOf(url: string | undefined): string | undefined {
  if (typeof url !== "string" || url.trim().length === 0) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export interface DomainFilterOptions {
  includeDomains?: string[];
  excludeDomains?: string[];
}

/**
 * Apply include/exclude domain filters to parsed search results.
 *
 * - `includeDomains`: keep only results whose hostname matches one of the
 *   domains. Results without a parseable URL cannot match and are dropped.
 * - `excludeDomains`: drop results whose hostname matches one of the
 *   domains. Results without a parseable URL are kept (cannot be excluded).
 *
 * Returns the filtered results plus one {@link AppliedFilter} per non-empty
 * filter, each reported as `post_filter`/`full` because the rule is fully
 * enforced over the retrieved set.
 */
export function applyDomainFilter<T extends { url?: string }>(
  results: T[],
  opts: DomainFilterOptions,
): { results: T[]; applied: AppliedFilter[] } {
  const include = (opts.includeDomains ?? []).filter((d) => d.trim().length > 0);
  const exclude = (opts.excludeDomains ?? []).filter((d) => d.trim().length > 0);
  const applied: AppliedFilter[] = [];

  let out = results;
  if (include.length > 0) {
    out = out.filter((row) => {
      const host = hostnameOf(row.url);
      if (host === undefined) return false;
      return include.some((domain) => hostnameMatchesDomain(host, domain));
    });
    applied.push({ filter: "include_domains", support: "post_filter", honored: "full" });
  }
  if (exclude.length > 0) {
    out = out.filter((row) => {
      const host = hostnameOf(row.url);
      if (host === undefined) return true;
      return !exclude.some((domain) => hostnameMatchesDomain(host, domain));
    });
    applied.push({ filter: "exclude_domains", support: "post_filter", honored: "full" });
  }

  return { results: out, applied };
}
