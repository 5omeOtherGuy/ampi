import { enforceContentLengthBudget, truncateUtf8 } from "../http-utils.js";
import type { SearchResponse } from "./types.js";

/**
 * The subset of {@link SearchResponse} fields produced from the upstream
 * response body: the (possibly truncated) `rawText`, the `truncated` flag,
 * and the input/output byte counts. Search backends spread this directly
 * into their `SearchResponse` return value alongside parsed `results`.
 */
export type SearchResponseBody = Pick<
  SearchResponse,
  "rawText" | "truncated" | "bytes" | "totalBytes"
>;

/**
 * Read a buffered upstream search response body under the per-call byte
 * budget. Centralizes the contract every JSON/HTML search backend shares:
 *
 *   1. Fast-fail when an advertised `Content-Length` far exceeds the
 *      per-call cap, so an obviously oversized response never reaches
 *      `response.text()`.
 *   2. Fully buffer the body via `response.text()` so callers can parse
 *      JSON/HTML and run backend-specific checks (block-page detection,
 *      JSON-vs-HTML sniffing) against the untruncated text.
 *   3. Cap the surfaced `rawText` and report byte counts via
 *      {@link truncateUtf8}, producing the four `SearchResponseBody`
 *      fields exactly the same way for every backend.
 *
 * Callers receive both the untruncated `text` (for parsing/diagnostics)
 * and the truncated `body` to spread into their `SearchResponse`.
 */
export async function readSearchResponseBody(
  response: Response,
  maxResultBytes: number,
  label: string,
): Promise<{ text: string; body: SearchResponseBody }> {
  enforceContentLengthBudget(response, maxResultBytes, label);
  const text = await response.text();
  const truncated = truncateUtf8(text, maxResultBytes);
  return {
    text,
    body: {
      rawText: truncated.content,
      truncated: truncated.truncated,
      bytes: truncated.outputBytes,
      totalBytes: truncated.totalBytes,
    },
  };
}
