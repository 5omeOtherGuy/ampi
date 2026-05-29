/**
 * Backend-neutral types for `mmr-web` search providers.
 *
 * Every search backend (Brave, SearXNG, DuckDuckGo) returns the same
 * normalized {@link SearchResponse} shape so `tools.ts` can format results
 * uniformly without knowing which backend served the call.
 */

/**
 * Stable id for the backend that produced a given result. Used in
 * `WebSearchDetails.backend`, `/mmr-status` rows, and provider diagnostics
 * so users can see which path actually serviced a call.
 */
export type SearchBackendId = "brave" | "searxng" | "duckduckgo";

export interface SearchResultEntry {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
}

export interface SearchResponse {
  results: SearchResultEntry[];
  rawText: string;
  truncated: boolean;
  bytes: number;
  totalBytes: number;
}

export interface SearchArgs {
  query: string;
  maxResults: number;
  signal?: AbortSignal;
  maxResultBytes: number;
  timeoutMs?: number;
  /** Optional two-letter country code; backends that honor it use it as-is. */
  country?: string;
}

export interface SearchBackend {
  /** Stable id returned in `WebSearchDetails.backend`. */
  readonly id: SearchBackendId;
  /** Execute one search call. */
  search(args: SearchArgs): Promise<SearchResponse>;
}
