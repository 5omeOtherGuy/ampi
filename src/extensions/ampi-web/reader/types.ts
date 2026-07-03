/**
 * Backend-neutral types for `ampi-web` page-reader providers.
 *
 * The package ships a single in-process custom direct reader. It runs the
 * Readability + Turndown HTML→Markdown pipeline (falling back to a minimal
 * extractor) behind the {@link ReaderBackend} interface.
 */

export type ReaderBackendId = "custom";

export interface ReaderArgs {
  url: string;
  signal?: AbortSignal;
  maxResultBytes: number;
  timeoutMs?: number;
}

export interface ReaderResponse {
  content: string;
  truncated: boolean;
  bytes: number;
  totalBytes: number;
  /** Final URL after redirects (may differ from the input URL). */
  url: string;
  /**
   * `false` when the fetch succeeded but no readable static content was
   * found (JavaScript-rendered app shell, placeholder-only body, or empty
   * page). In that case {@link ReaderResponse.content} carries an honest
   * diagnostic instead of misleading boilerplate, and callers should not
   * excerpt it. Omitted (treated as readable) on the normal path.
   */
  readableContentFound?: boolean;
  /** Why readable content was not found, when `readableContentFound` is false. */
  extractionReason?: "requires_javascript" | "placeholder_only" | "empty";
}

export interface ReaderBackend {
  readonly id: ReaderBackendId;
  read(args: ReaderArgs): Promise<ReaderResponse>;
}

/**
 * Subset of `dns.LookupAddress` and `dns.promises.lookup` the custom
 * reader depends on. Declared locally so tests can inject a deterministic
 * resolver without pulling `node:dns` into the type surface.
 */
export interface DnsLookupAddress {
  address: string;
  family: number;
}
export type DnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<DnsLookupAddress[]>;
