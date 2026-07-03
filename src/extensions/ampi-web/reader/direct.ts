import { isIP } from "node:net";
import {
  combineSignal,
  discardBody,
  enforceContentLengthBudget,
  parseMediaType,
  raceWithSignal,
  readErrorPreview,
  readTextWithByteLimit,
  redactApiKey,
  truncateUtf8,
} from "../http-utils.js";
import { isPrivateIpLiteral, validateExternalHttpUrl } from "../url-policy.js";
import { htmlToMarkdown } from "./extract.js";
import { extractArticleToMarkdown } from "./markdown.js";
import type {
  DnsLookup,
  DnsLookupAddress,
  ReaderArgs,
  ReaderBackend,
  ReaderResponse,
} from "./types.js";

/**
 * Custom in-process page reader for `ampi-web`.
 *
 * Direct-fetches public http(s) URLs, walks the redirect chain manually
 * with full SSRF re-validation on every hop, enforces a strict content-type
 * allowlist and byte cap, then converts HTML/XML responses to Markdown
 * through {@link htmlToMarkdown}. `text/plain` bodies are preserved
 * verbatim so logs/Markdown/docs are not corrupted by the converter.
 *
 * The model never receives raw network capabilities. Every call goes
 * through URL validation, DNS public-address re-resolution, per-call
 * timeouts, and a byte-budget truncation pass before returning to the
 * caller.
 *
 * Re-exported through `../brave.ts` (legacy `braveReader` name) so existing
 * callers/tests keep working.
 */

/** Browser-ish UA used when fetching arbitrary upstream pages. Many sites
 * gate non-browser UAs behind 403/429 responses. */
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Maximum number of HTTP redirects the custom reader will follow.
 * Each hop is validated against the same SSRF policy as the initial URL
 * before being fetched, so the cap is a defense-in-depth against open
 * redirect chains rather than against private targets.
 */
const MAX_READER_REDIRECTS = 5;

/**
 * Allowlisted response content types for the custom reader. Direct
 * in-process fetches of arbitrary user URLs can land on PDFs, archives,
 * images, audio/video, or `application/octet-stream` downloads; decoding
 * those as HTML would feed binary garbage to the model and waste the byte
 * budget. We allow only the text-shaped types the HTML\u2192Markdown
 * extractor can meaningfully process.
 */
const ALLOWED_READER_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "application/xml",
  "text/xml",
]);

export interface CustomReaderArgs extends ReaderArgs {}
export interface CustomReaderResponse extends ReaderResponse {}

/**
 * Minimum number of *distinct* content characters the extracted Markdown
 * must contain before we trust it as a real page rendering. A JavaScript
 * app shell typically renders to a handful of repeated placeholders
 * ("Loading…") or nothing at all, so the set of unique lines collapses
 * well below this bar. Kept in line with the article-extractor's
 * usefulness threshold.
 */
const MIN_READABLE_DISTINCT_CHARS = 80;

/**
 * Markers that indicate the response is a client-side-rendered application
 * shell (React/Next.js/Angular/etc.) whose real content is hydrated by
 * JavaScript and therefore absent from the static HTML we fetched.
 */
const APP_SHELL_MARKERS: readonly RegExp[] = [
  /id=["']__next["']/i,
  /__NEXT_DATA__/,
  /self\.__next_f/,
  /id=["']root["']/i,
  /data-reactroot/i,
  /ng-version=|ng-app=/i,
  /<noscript>[^<]*(enable|turn on)[^<]*javascript/i,
];

interface ReadableAssessment {
  readable: boolean;
  reason?: "requires_javascript" | "placeholder_only" | "empty";
}

/**
 * Decide whether the produced Markdown is a real page rendering or an
 * empty/placeholder shell. Operates on distinct content so a body made of
 * repeated "Loading…" placeholders is recognized as unreadable even though
 * its total length is non-trivial.
 */
function assessReadableContent(markdown: string, rawHtml: string): ReadableAssessment {
  const trimmed = markdown.trim();
  const appShell = APP_SHELL_MARKERS.some((re) => re.test(rawHtml));
  if (trimmed === "") {
    return { readable: false, reason: appShell ? "requires_javascript" : "empty" };
  }
  const contentLines = trimmed
    .split(/\n+/)
    .map((line) => line.replace(/^[#>\-*+\d.\s]+/, "").trim())
    .filter((line) => line.length > 0);
  const distinctLines = new Set(contentLines);
  const distinctChars = [...distinctLines].join("").length;
  // Only short bodies can be shells; anything with substantial distinct
  // content is a real page (including small-but-legitimate pages, which
  // must NOT be flagged just for being short).
  if (distinctChars >= MIN_READABLE_DISTINCT_CHARS) {
    return { readable: true };
  }
  // App-shell markers + little static text means JS hydration is required.
  if (appShell) return { readable: false, reason: "requires_javascript" };
  // Repeated short lines (e.g. many "Loading…" placeholders) collapse to a
  // tiny distinct set far smaller than the line count: a placeholder body.
  if (contentLines.length > distinctLines.size && contentLines.length >= 3) {
    return { readable: false, reason: "placeholder_only" };
  }
  // Otherwise treat it as a genuine (possibly small) page rendering.
  return { readable: true };
}

/**
 * Build the honest diagnostic returned when a page was fetched
 * successfully but yielded no readable static content.
 */
function buildNoContentDiagnostic(
  finalUrl: string,
  reason: "requires_javascript" | "placeholder_only" | "empty",
): string {
  const lines = [
    "# No readable content found",
    "",
    `The page at ${finalUrl} was fetched successfully, but no readable static content was found.`,
  ];
  if (reason === "requires_javascript") {
    lines.push(
      "",
      "The response appears to be a JavaScript-rendered application shell. " +
        "This reader does not execute JavaScript, so the page's content is not " +
        "present in the static HTML. Try a direct link to the underlying document, " +
        "a cached or print/AMP version of the page, or an alternative source.",
    );
  } else if (reason === "placeholder_only") {
    lines.push(
      "",
      "The static HTML contained only placeholder content (for example repeated " +
        "loading indicators). Try an alternative source or a direct link to the " +
        "underlying document.",
    );
  }
  return lines.join("\n");
}

export interface CustomReaderOptions {
  fetchImpl?: typeof fetch;
  userAgent?: string;
  /**
   * Optional API key used only to redact verbatim occurrences from error
   * preview bodies. The custom reader itself never sends an API key.
   */
  apiKey?: string;
  /**
   * DNS lookup used to enforce private-address rejection on the actual
   * resolved IPs (defense against hostnames like `127.0.0.1.nip.io` and
   * against attacker-controlled DNS pointing at private targets). Defaults
   * to `dns.promises.lookup` with `all: true`. Tests inject a deterministic
   * resolver so suites stay offline.
   *
   * Residual TOCTOU: this performs the lookup-then-connect dance against
   * Node's default DNS resolver, so a hostile authoritative server could
   * still return different addresses to our lookup and the connect call
   * (DNS rebinding). Treating that as in-scope would require pinning the
   * socket to the resolved IP and overriding TLS SNI, which is out of
   * scope for the no-dependency reader.
   */
  lookup?: DnsLookup;
}

/**
 * Reject responses the custom reader should not decode as HTML/text:
 *
 * - `Content-Disposition: attachment` indicates a download, not a document.
 * - `Content-Type` outside {@link ALLOWED_READER_CONTENT_TYPES} (PDFs,
 *   images, archives, audio/video, `application/octet-stream`, etc.) is
 *   refused so the model never receives decoded binary payloads.
 *
 * Missing `Content-Type` is allowed: many minimal upstreams omit it, and
 * the downstream HTML\u2192Markdown extractor degrades gracefully to plain
 * text for non-tag input.
 */
function enforceReaderContentPolicy(response: Response, label: string): void {
  const disposition = response.headers.get("content-disposition");
  if (disposition && /(^|;\s*)attachment\b/i.test(disposition)) {
    throw new Error(
      `${label}: refusing response with Content-Disposition: attachment ("${disposition.trim()}"); custom reader does not download files.`,
    );
  }
  const media = parseMediaType(response.headers.get("content-type"));
  if (!media) return; // tolerate missing content-type
  if (!ALLOWED_READER_CONTENT_TYPES.has(media)) {
    throw new Error(
      `${label}: refusing response with Content-Type "${media}"; custom reader only handles ${[...ALLOWED_READER_CONTENT_TYPES].join(", ")}.`,
    );
  }
}

async function defaultLookup(hostname: string, options: { all: true; verbatim: true }): Promise<DnsLookupAddress[]> {
  // Lazy import so loading this module from a runtime that never reads a
  // web page does not pull in `node:dns`.
  const dns = await import("node:dns");
  return dns.promises.lookup(hostname, options);
}

/**
 * For non-IP-literal hostnames, resolve the host and reject if ANY resolved
 * address (IPv4 or IPv6) is private/reserved/link-local. Run on the initial
 * URL and again on every redirect hop, so a redirect to a public-looking
 * hostname that DNS-resolves to a private IP is still refused.
 *
 * The lookup is raced against `signal` so the tool's per-call timeout
 * covers both the DNS phase and the fetch phase; a hung resolver cannot
 * push the wall-clock past `readTimeoutMs`.
 */
async function ensureHostResolvesPublicly(
  url: URL,
  lookup: DnsLookup,
  label: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const rawHost = url.hostname.toLowerCase();
  // Strip IPv6 brackets so isIP can classify the literal correctly.
  const bareHost = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
  if (isIP(bareHost) !== 0) {
    // URL-literal IP: already covered by validateExternalHttpUrl.
    return;
  }
  let addresses: DnsLookupAddress[];
  try {
    addresses = await raceWithSignal(lookup(bareHost, { all: true, verbatim: true }), signal);
  } catch (error) {
    // Preserve abort errors verbatim so callers see the original
    // AbortError / timeout reason rather than a wrapped "DNS lookup failed".
    if (signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: DNS lookup for "${bareHost}" failed: ${message}`);
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error(`${label}: DNS lookup for "${bareHost}" returned no addresses.`);
  }
  for (const entry of addresses) {
    if (isPrivateIpLiteral(entry.address)) {
      throw new Error(
        `${label}: hostname "${bareHost}" resolves to a private/reserved address (${entry.address}); refusing to fetch.`,
      );
    }
  }
}

export async function customReader(
  args: CustomReaderArgs,
  options: CustomReaderOptions = {},
): Promise<CustomReaderResponse> {
  const initial = validateExternalHttpUrl(args.url);
  if (!initial.ok) {
    throw new Error(`read_web_page rejected URL: ${initial.reason}`);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const lookup = options.lookup ?? defaultLookup;
  const sharedSignal = combineSignal(args.signal, args.timeoutMs);

  const headers: Record<string, string> = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": options.userAgent ?? BROWSER_USER_AGENT,
  };

  // Walk the redirect chain manually so the SSRF policy is enforced on every
  // hop. Node's default `redirect: "follow"` would happily 302 a public URL
  // to `http://127.0.0.1/` or `http://169.254.169.254/` after the first
  // request, bypassing `validateExternalHttpUrl` entirely. We also re-resolve
  // the hostname on every hop and reject if any resolved address is private,
  // which closes the `127.0.0.1.nip.io`-style DNS-based SSRF hole.
  let currentUrl = initial.url;
  await ensureHostResolvesPublicly(currentUrl, lookup, `Custom reader for ${args.url}`, sharedSignal);
  let response: Response | undefined;
  for (let hop = 0; hop <= MAX_READER_REDIRECTS; hop++) {
    const target = currentUrl.toString();
    response = await fetchImpl(target, {
      method: "GET",
      headers,
      signal: sharedSignal,
      redirect: "manual",
    });
    const status = response.status;
    const isRedirect = status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
    if (!isRedirect) break;
    if (hop === MAX_READER_REDIRECTS) {
      await discardBody(response);
      throw new Error(
        `Custom reader for ${args.url}: too many redirects (${MAX_READER_REDIRECTS} hops exceeded).`,
      );
    }
    const location = response.headers.get("location");
    if (!location || location.trim() === "") {
      await discardBody(response);
      throw new Error(
        `Custom reader for ${args.url}: HTTP ${status} redirect without a Location header.`,
      );
    }
    // Resolve relative Location headers against the current URL (matches
    // RFC 7231 §7.1.2) before validating it.
    let nextUrl: URL;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      await discardBody(response);
      throw new Error(
        `Custom reader for ${args.url}: redirect rejected — Location "${location}" is not a valid URL.`,
      );
    }
    const validated = validateExternalHttpUrl(nextUrl.toString());
    if (!validated.ok) {
      await discardBody(response);
      throw new Error(
        `Custom reader for ${args.url}: redirect rejected (${validated.reason}).`,
      );
    }
    await discardBody(response);
    await ensureHostResolvesPublicly(
      validated.url,
      lookup,
      `Custom reader for ${args.url}: redirect rejected`,
      sharedSignal,
    );
    currentUrl = validated.url;
  }
  if (!response) {
    // Unreachable: the loop runs at least once.
    throw new Error("Custom reader produced no response.");
  }

  const finalUrl = currentUrl.toString();
  if (!response.ok) {
    const body = redactApiKey(await readErrorPreview(response), options.apiKey);
    throw new Error(
      `Custom reader failed for ${finalUrl}: HTTP ${response.status} ${response.statusText}${body ? ` \u2014 ${body}` : ""}`,
    );
  }
  // Refuse responses we should not decode as HTML/text (binary downloads,
  // archives, attachments) before we touch the body.
  const mediaType = parseMediaType(response.headers.get("content-type"));
  enforceReaderContentPolicy(response, `Custom reader for ${finalUrl}`);
  enforceContentLengthBudget(response, args.maxResultBytes, `Custom reader for ${finalUrl}`);

  // Stream the body and cap raw input bytes at `maxResultBytes`. This stops
  // chunked / `Content-Length`-less responses from arbitrary origins from
  // streaming unbounded data into memory before any downstream truncation
  // runs.
  const streamed = await readTextWithByteLimit(
    response,
    args.maxResultBytes,
    `Custom reader for ${finalUrl}`,
  );
  const rawText = streamed.text;
  const totalBytes = streamed.totalBytes;
  // Preserve text/plain bodies verbatim: they may already be Markdown, logs,
  // or documentation. HTML/XML-shaped content goes through the high-fidelity
  // Readability + Turndown pipeline first; if that returns null (toolchain
  // unavailable, page is not an article, or output is empty), fall back to
  // the zero-dep extractor so the user still gets a Markdown rendering.
  // Downstream tools.ts still applies the final content cap and adds the
  // truncation marker.
  let markdown: string;
  if (mediaType === "text/plain") {
    markdown = rawText;
  } else {
    const article = await extractArticleToMarkdown(rawText, {
      maxBytes: args.maxResultBytes,
      sourceUrl: finalUrl,
    });
    markdown = article ?? htmlToMarkdown(rawText, { maxBytes: args.maxResultBytes });
  }
  // Guard against returning a JavaScript-rendered app shell or a
  // placeholder/cookie-banner-only body as if it were the page. text/plain
  // is preserved verbatim above and is never assessed here.
  if (mediaType !== "text/plain") {
    const assessment = assessReadableContent(markdown, rawText);
    if (!assessment.readable) {
      const reason = assessment.reason ?? "empty";
      const diagnostic = buildNoContentDiagnostic(finalUrl, reason);
      const cappedDiag = truncateUtf8(diagnostic, args.maxResultBytes);
      return {
        content: cappedDiag.content,
        truncated: cappedDiag.truncated || streamed.truncated,
        bytes: cappedDiag.outputBytes,
        totalBytes,
        url: finalUrl,
        readableContentFound: false,
        extractionReason: reason,
      };
    }
  }
  const truncated = truncateUtf8(markdown, args.maxResultBytes);
  return {
    content: truncated.content,
    truncated: truncated.truncated || streamed.truncated,
    bytes: truncated.outputBytes,
    totalBytes,
    url: finalUrl,
    readableContentFound: true,
  };
}

/**
 * Build a {@link ReaderBackend} that calls the custom direct reader.
 */
export function createCustomReader(options: CustomReaderOptions): ReaderBackend {
  return {
    id: "custom",
    read: (args) => customReader(args, options),
  };
}
