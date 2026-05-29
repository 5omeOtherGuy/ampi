/**
 * High-fidelity HTML→Markdown extraction for the custom direct reader.
 *
 * Pipeline:
 *
 *   parsed HTML  ──(linkedom)──▶  DOM
 *                                  │
 *                                  ▼
 *                  (@mozilla/readability extracts the article body)
 *                                  │
 *                                  ▼
 *                       (turndown + turndown-plugin-gfm)
 *                                  │
 *                                  ▼
 *                          article Markdown
 *
 * Both `linkedom`, `@mozilla/readability`, `turndown`, and
 * `turndown-plugin-gfm` are dynamic-imported lazily on first use so
 * Pi sessions that never read a web page do not pay their load cost,
 * and a missing or broken module triggers a clean fallback to the
 * legacy zero-dep extractor in `./extract.ts`.
 *
 * Readability runs on the parsed DOM. If it returns no article, or
 * the generated Markdown is too short to be useful, this module
 * returns `null` and the caller falls back to the minimal extractor.
 */

import { truncateUtf8 } from "../http-utils.js";

/**
 * Minimum number of characters Readability+Turndown must produce
 * before we trust the article-mode output. Pages that would generate
 * shorter Markdown (link directories, login walls, error pages,
 * pre/listing-only documents) fall back to the legacy extractor so
 * the caller still receives the full page content.
 */
const ARTICLE_MIN_CHARS = 80;

/**
 * Minimum HTML length required before we attempt Readability at all.
 * Very short HTML responses (error pages, snippets, JSON-ish payloads
 * mis-tagged as text/html) skip the heavy pipeline.
 */
const READABILITY_MIN_INPUT_CHARS = 200;

export interface ArticleExtractOptions {
  /** UTF-8 byte budget for the produced Markdown. */
  maxBytes: number;
  /** Final URL (after redirects) used as the Readability base URI. */
  sourceUrl?: string;
}

/**
 * Attribute-value patterns that mark cookie/consent/privacy UI chrome.
 * Matched against `id`, `class`, and `data-*` attribute values (a
 * structural signal) rather than against extracted text, so legitimate
 * articles *about* cookies or privacy are not mistaken for banners.
 */
const CONSENT_ATTR_RE =
  /(cookie|consent|gdpr|ccpa|onetrust|cookiebot|osano|trustarc|truste|cmp[-_]?(banner|consent)|privacy[-_]?(banner|notice|consent))/i;

/**
 * Upper bound on the text length of a node we are willing to delete as
 * consent chrome. Real cookie/consent banners are short; a full article
 * that happens to discuss cookies is much larger, so this guard keeps us
 * from nuking legitimate long-form content that matches the attribute
 * pattern.
 */
const CONSENT_NODE_MAX_TEXT = 2_000;

interface DomElement {
  remove?: () => void;
  getAttribute?: (name: string) => string | null;
  getAttributeNames?: () => string[];
  textContent?: string | null;
}

interface DomDocument {
  querySelectorAll: (selector: string) => Iterable<DomElement>;
}

/**
 * Remove non-content UI chrome from the parsed DOM before Readability
 * scores it. JS-rendered pages frequently ship an app shell whose only
 * substantial static text is a cookie/consent banner; left in place,
 * Readability latches onto the banner and returns it as the "article".
 *
 * We remove two structurally-identifiable classes of nodes:
 *  - hidden / dialog / modal chrome (`[hidden]`, `aria-hidden`,
 *    `role=dialog|alertdialog`, `aria-modal`), and
 *  - short nodes whose `id`/`class`/`data-*` attributes match
 *    {@link CONSENT_ATTR_RE}.
 *
 * Detection is attribute-based, never text-based, so an article about
 * cookie policy is preserved while a `data-testid="consent-banner"`
 * toast is dropped.
 */
function stripNonContentNodes(document: DomDocument): void {
  // Structural UI chrome: safe to remove unconditionally.
  const chromeSelectors =
    '[hidden],[aria-hidden="true"],[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
  for (const el of document.querySelectorAll(chromeSelectors)) {
    el.remove?.();
  }
  // Consent/cookie containers identified by attribute values.
  for (const el of document.querySelectorAll("*")) {
    const names = el.getAttributeNames?.() ?? [];
    let matched = false;
    for (const name of names) {
      if (name !== "id" && name !== "class" && !name.startsWith("data-")) continue;
      const value = el.getAttribute?.(name);
      if (value && CONSENT_ATTR_RE.test(`${name} ${value}`)) {
        matched = true;
        break;
      }
    }
    if (!matched) continue;
    const text = typeof el.textContent === "string" ? el.textContent : "";
    if (text.length <= CONSENT_NODE_MAX_TEXT) el.remove?.();
  }
}

interface Toolchain {
  parseHTML: (html: string, mimeType?: string) => { document: unknown };
  Readability: new (doc: unknown, opts?: Record<string, unknown>) => {
    parse(): {
      title?: string;
      byline?: string;
      excerpt?: string;
      siteName?: string;
      content?: string;
      textContent?: string;
      length?: number;
    } | null;
  };
  turndown: (html: string) => string;
}

/**
 * Cached toolchain. We retain three states:
 *  - `undefined`  — not loaded yet
 *  - `Promise<Toolchain>` — load in flight; subsequent callers await
 *  - `null` — load previously failed; do not retry, fall back to legacy
 */
let toolchainState: Promise<Toolchain> | null | undefined;

/**
 * Test seam: reset cached toolchain state so deterministic specs can
 * stub failures and re-runs in isolation.
 */
export function __resetReaderToolchainForTests(): void {
  toolchainState = undefined;
}

async function loadToolchain(): Promise<Toolchain | null> {
  if (toolchainState === null) return null;
  if (toolchainState === undefined) {
    toolchainState = (async () => {
      const [{ parseHTML }, readabilityMod, turndownMod, gfmMod] = await Promise.all([
        import("linkedom"),
        import("@mozilla/readability"),
        import("turndown"),
        import("turndown-plugin-gfm"),
      ]);
      const Readability = readabilityMod.Readability;
      const TurndownService = (turndownMod as { default: new (opts?: Record<string, unknown>) => {
        use(plugin: unknown): void;
        turndown(html: string): string;
        addRule(name: string, rule: unknown): void;
      } }).default;
      const td = new TurndownService({
        headingStyle: "atx",
        codeBlockStyle: "fenced",
        bulletListMarker: "-",
        emDelimiter: "_",
        strongDelimiter: "**",
        hr: "---",
        linkStyle: "inlined",
      });
      td.use((gfmMod as { gfm: unknown }).gfm);
      // Preserve the language hint on `<pre><code class="language-XYZ">`.
      // Turndown's default fenced-code rule emits ``` without a language;
      // we override it so syntax highlighting in the consumer Markdown
      // matches what the upstream page advertised.
      td.addRule("fencedCodeBlockWithLanguage", {
        filter: (node: unknown) => {
          const el = node as { nodeName?: string; firstChild?: { nodeName?: string } | null };
          return el.nodeName === "PRE" && el.firstChild?.nodeName === "CODE";
        },
        replacement: (_content: string, node: unknown) => {
          const codeEl = (node as { firstChild?: { className?: string; textContent?: string } }).firstChild ?? {};
          const cls = typeof codeEl.className === "string" ? codeEl.className : "";
          const langMatch = /(?:^|\s)language-([a-zA-Z0-9_+#.-]+)/.exec(cls);
          const lang = langMatch?.[1] ?? "";
          const text = typeof codeEl.textContent === "string" ? codeEl.textContent : "";
          const fence = text.includes("```") ? "~~~" : "```";
          return `\n\n${fence}${lang}\n${text.replace(/\n$/u, "")}\n${fence}\n\n`;
        },
      });
      // Turndown emits `*` / `-   ` with 3-space padding by default; collapse
      // to a single space after the marker so output matches CommonMark/GFM
      // norms and downstream regex-based tests stay readable.
      const tdProxy = {
        turndown(html: string) {
          return td.turndown(html).replace(/^([*+-])\s{2,}/gm, "$1 ").replace(/^(\d+\.)\s{2,}/gm, "$1 ");
        },
      };
      return {
        parseHTML: parseHTML as Toolchain["parseHTML"],
        Readability: Readability as unknown as Toolchain["Readability"],
        turndown: tdProxy.turndown.bind(tdProxy),
      };
    })();
  }
  try {
    return await toolchainState;
  } catch {
    toolchainState = null;
    return null;
  }
}

/**
 * Try to extract an article from `rawHtml` and convert it to Markdown.
 *
 * Returns `null` when:
 * - the toolchain failed to load (missing module, etc.),
 * - the HTML is too small to bother parsing,
 * - Readability did not detect an article,
 * - the generated Markdown is too short to be useful, or
 * - any unexpected error is thrown during parse / extract / convert.
 *
 * In all those cases the caller should fall back to the minimal
 * extractor in `./extract.ts` so the user still gets a Markdown
 * rendering of the page.
 */
export async function extractArticleToMarkdown(
  rawHtml: string,
  options: ArticleExtractOptions,
): Promise<string | null> {
  if (typeof rawHtml !== "string") return null;
  if (rawHtml.length < READABILITY_MIN_INPUT_CHARS) return null;
  const toolchain = await loadToolchain();
  if (!toolchain) return null;
  try {
    const { document } = toolchain.parseHTML(rawHtml, "text/html") as { document: unknown };
    if (!document) return null;
    stripNonContentNodes(document as DomDocument);
    const reader = new toolchain.Readability(document, {
      charThreshold: 200,
      // Keep CSS classes so Turndown's fenced-code rule can read
      // `class="language-XYZ"` and emit the right syntax-highlight hint.
      keepClasses: true,
    });
    const article = reader.parse();
    if (!article || typeof article.content !== "string" || article.content.trim() === "") {
      return null;
    }
    // Prepend the article title as an H1 if Readability surfaced one and
    // the extracted content does not already start with a heading.
    const contentHtml = article.content;
    const titleHtml = article.title && !/^\s*<h[1-6]\b/i.test(contentHtml)
      ? `<h1>${escapeHtmlMinimal(article.title)}</h1>`
      : "";
    const markdownRaw = toolchain.turndown(`${titleHtml}${contentHtml}`).trim();
    if (markdownRaw.length < ARTICLE_MIN_CHARS) return null;
    // Apply the same UTF-8-aware byte cap the legacy extractor uses.
    const capped = truncateUtf8(markdownRaw, options.maxBytes);
    return capped.content;
  } catch {
    return null;
  }
}

function escapeHtmlMinimal(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
