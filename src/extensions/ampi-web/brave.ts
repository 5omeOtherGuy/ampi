/**
 * Legacy re-export barrel for `mmr-web` clients that still import
 * `braveSearch` / `braveReader` from this path.
 *
 * The original monolithic `brave.ts` is split into focused modules:
 *
 *   - {@link ./search/brave.js}   — Brave Search client + SearchBackend.
 *   - {@link ./reader/direct.js}  — Custom in-process direct reader.
 *   - {@link ./reader/extract.js} — Minimal HTML\u2192Markdown extractor.
 *   - {@link ../ampi-core/internal/http-utils.js}     — Shared streaming/abort/byte-cap helpers.
 *
 * New code should import from those modules directly. This barrel keeps
 * the previous symbol names available while consumers migrate. It can be
 * removed once all callers are updated.
 *
 * Symbol renames preserved here for back-compat:
 *
 *   - `braveReader` (legacy) \u2192 `customReader` (new).
 *   - `BraveReaderArgs`/`BraveReaderResponse` (legacy) \u2192 reader/types.ts.
 *   - `BraveClientOptions` (legacy combined options) is reconstructed from
 *     `BraveSearchOptions` + `CustomReaderOptions`.
 */

export {
  BRAVE_SEARCH_BASE,
  braveSearch,
  createBraveSearchBackend,
  type BraveSearchArgs,
  type BraveSearchOptions,
  type BraveSearchResponse,
  type BraveSearchResultEntry,
} from "./search/brave.js";

export {
  customReader as braveReader,
  createCustomReader,
  type CustomReaderArgs as BraveReaderArgs,
  type CustomReaderResponse as BraveReaderResponse,
  type CustomReaderOptions,
} from "./reader/direct.js";

export {
  htmlToMarkdown,
  type ConvertOptions,
} from "./reader/extract.js";

export type {
  DnsLookup,
  DnsLookupAddress,
} from "./reader/types.js";

import type { BraveSearchOptions } from "./search/brave.js";
import type { CustomReaderOptions } from "./reader/direct.js";

/**
 * Legacy combined options shape used by `tools.ts` and tests. Contains
 * fields for both the Brave search client and the custom direct reader so
 * a single `getBraveOptions()` factory can configure both. New code should
 * use the per-backend option types instead.
 */
export type BraveClientOptions = BraveSearchOptions & CustomReaderOptions;
