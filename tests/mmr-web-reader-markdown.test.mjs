import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

/**
 * Build a long, article-shaped HTML body. Readability requires a
 * minimum amount of textual content (charThreshold) before it decides
 * the page is an article worth extracting.
 */
function articleHtml({ title = "An Excellent Article", body = "", site = "Example" } = {}) {
  const paragraphs = body || `
    <p>Welcome to <strong>${site}</strong>. This is the opening paragraph of an article that
    should be long enough for Mozilla Readability to recognise it as the main
    content of the page. We say a few more sentences here so the character
    threshold is comfortably exceeded.</p>
    <p>The second paragraph adds more substance. It mentions <a href="https://example.org/related">related work</a>
    and provides context for what follows. Article extraction needs density of
    text, not just markup, before it commits to a particular subtree.</p>
    <p>The third paragraph is also reasonably long so that Readability's
    scoring algorithm gives this section the highest score on the page and
    promotes it as the article body. We mention <em>emphasis</em> here for
    coverage.</p>
  `;
  return `<!DOCTYPE html><html><head><title>${title}</title>
<meta name="description" content="A test fixture for Readability + Turndown.">
</head><body>
  <header><nav><ul><li><a href="/">Home</a></li><li><a href="/blog">Blog</a></li></ul></nav></header>
  <main>
    <article>
      <h1>${title}</h1>
      ${paragraphs}
    </article>
  </main>
  <aside><p>Sidebar that should NOT appear in the extracted Markdown.</p></aside>
  <footer><p>Copyright \u00a9 ${site}. All rights reserved.</p></footer>
</body></html>`;
}

describe("mmr-web reader/markdown — Readability + Turndown pipeline", () => {
  beforeEach(async () => {
    const { __resetReaderToolchainForTests } = await importSource("extensions/ampi-web/reader/markdown.ts");
    __resetReaderToolchainForTests();
  });

  it("returns null when the HTML is shorter than the minimum input threshold", async () => {
    const { extractArticleToMarkdown } = await importSource("extensions/ampi-web/reader/markdown.ts");
    const md = await extractArticleToMarkdown("<p>tiny</p>", { maxBytes: 10_000 });
    assert.equal(md, null);
  });

  it("extracts the article body and drops nav/header/aside/footer chrome", async () => {
    const { extractArticleToMarkdown } = await importSource("extensions/ampi-web/reader/markdown.ts");
    const md = await extractArticleToMarkdown(articleHtml(), { maxBytes: 100_000 });
    assert.ok(md, "expected article extraction to succeed");
    assert.match(md, /An Excellent Article/);
    assert.match(md, /\*\*Example\*\*/);
    assert.match(md, /opening paragraph/);
    assert.match(md, /\[related work\]\(https:\/\/example\.org\/related\)/);
    assert.match(md, /_emphasis_/);
    assert.doesNotMatch(md, /Sidebar that should NOT appear/);
    assert.doesNotMatch(md, /All rights reserved/);
    // nav links should be excluded from the article body
    assert.doesNotMatch(md, /\[Blog\]\(\/blog\)/);
  });

  it("converts GFM tables to Markdown tables", async () => {
    const { extractArticleToMarkdown } = await importSource("extensions/ampi-web/reader/markdown.ts");
    const html = articleHtml({
      title: "Benchmarks",
      body: `
        <p>Benchmark results across three configurations of the system, all
        measured on the same hardware to make the comparison meaningful enough
        for Readability to treat this body as an article worth extracting.</p>
        <table>
          <thead><tr><th>Backend</th><th>RPS</th><th>p99 (ms)</th></tr></thead>
          <tbody>
            <tr><td>A</td><td>1200</td><td>40</td></tr>
            <tr><td>B</td><td>1500</td><td>35</td></tr>
            <tr><td>C</td><td>900</td><td>55</td></tr>
          </tbody>
        </table>
        <p>The numbers above show that B is the fastest on this workload, but
        also that the gap between B and A is small. C is consistently slower
        than the other two backends in every column.</p>
      `,
    });
    const md = await extractArticleToMarkdown(html, { maxBytes: 100_000 });
    assert.ok(md);
    // Turndown + gfm renders tables with pipe-delimited rows and a header divider.
    assert.match(md, /\|\s*Backend\s*\|\s*RPS\s*\|/);
    assert.match(md, /---\s*\|\s*---\s*\|\s*---/);
    assert.match(md, /\|\s*B\s*\|\s*1500\s*\|\s*35\s*\|/);
  });

  it("converts fenced code blocks with a language hint", async () => {
    const { extractArticleToMarkdown } = await importSource("extensions/ampi-web/reader/markdown.ts");
    const html = articleHtml({
      title: "Code example",
      body: `
        <p>The snippet below shows how the API is used. We include extra prose
        around it so that the page passes Readability's article-density check
        and we actually exercise the fenced-code branch of the converter.</p>
        <pre><code class="language-js">const x = 1;
const y = 2;
console.log(x + y);</code></pre>
        <p>After the snippet we continue with another paragraph so the article
        body is well above the minimum length threshold for extraction.</p>
      `,
    });
    const md = await extractArticleToMarkdown(html, { maxBytes: 100_000 });
    assert.ok(md);
    assert.match(md, /```js\nconst x = 1;\nconst y = 2;\nconsole\.log\(x \+ y\);\n```/);
  });

  it("returns non-null when Readability extracts any substantive body (caller uses Readability output)", async () => {
    const { extractArticleToMarkdown } = await importSource("extensions/ampi-web/reader/markdown.ts");
    // Even a sparse page (lots of one-character paragraphs) is treated as an
    // article by Readability’s scoring algorithm; the wrapper passes the
    // resulting Markdown through. The caller-side fallback to the legacy
    // extractor is only used when Readability returns null OR the converted
    // Markdown is below ARTICLE_MIN_CHARS. We verify the non-null branch here
    // and rely on the toolchain-failure / short-input tests for the null path.
    const html = `<!DOCTYPE html><html><body>${"<p>x</p>".repeat(60)}</body></html>`;
    const md = await extractArticleToMarkdown(html, { maxBytes: 100_000 });
    assert.ok(md, "Readability should extract some Markdown here");
  });

  it("caches the toolchain across calls; the reset seam restores cold-load behavior", async () => {
    // Sanity check the test seam: after a reset the next call still produces
    // valid output, proving the cache rebuild path is clean.
    const mod = await importSource("extensions/ampi-web/reader/markdown.ts");
    mod.__resetReaderToolchainForTests();
    const md1 = await mod.extractArticleToMarkdown(articleHtml(), { maxBytes: 100_000 });
    assert.ok(md1);
    mod.__resetReaderToolchainForTests();
    const md2 = await mod.extractArticleToMarkdown(articleHtml(), { maxBytes: 100_000 });
    assert.ok(md2);
  });

  it("applies the maxBytes UTF-8 cap and appends a truncation marker when exceeded", async () => {
    const { extractArticleToMarkdown } = await importSource("extensions/ampi-web/reader/markdown.ts");
    // Build a long article so the natural Markdown output far exceeds 200 bytes.
    const md = await extractArticleToMarkdown(articleHtml(), { maxBytes: 200 });
    assert.ok(md);
    // truncateUtf8 caps the body at ~maxBytes then appends a single-line
    // marker. Total output is bounded at maxBytes + a small constant marker.
    assert.match(md, /\[truncated to ~200 bytes; original \d+ bytes\]/);
    assert.ok(
      Buffer.byteLength(md, "utf8") <= 350,
      `bytes=${Buffer.byteLength(md, "utf8")} should be near 200 + marker`,
    );
  });
});

describe("mmr-web custom reader — end-to-end through Readability", () => {
  it("renders an article page through the new pipeline (no nav/footer chrome)", async () => {
    const { braveReader } = await importSource("extensions/ampi-web/brave.ts");
    const PUBLIC_DNS_STUB = async () => [{ address: "203.0.113.10", family: 4 }];
    const html = articleHtml({ title: "End-to-end" });
    const calls = [];
    const fetchImpl = async (input) => {
      calls.push(String(input));
      return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    };
    const result = await braveReader(
      { url: "https://example.com/article", maxResultBytes: 100_000 },
      { fetchImpl, lookup: PUBLIC_DNS_STUB },
    );
    assert.equal(calls.length, 1);
    assert.match(result.content, /End-to-end/);
    assert.match(result.content, /opening paragraph/);
    assert.doesNotMatch(result.content, /Sidebar that should NOT appear/);
    assert.doesNotMatch(result.content, /All rights reserved/);
  });

  it("ignores a cookie-consent banner and extracts the real article body", async () => {
    const { braveReader } = await importSource("extensions/ampi-web/brave.ts");
    const PUBLIC_DNS_STUB = async () => [{ address: "203.0.113.10", family: 4 }];
    // A page that DOES have a real article, plus a consent banner whose only
    // identifying signal is a data-* attribute (no "cookie" in id/class).
    const html = articleHtml({ title: "Real Article" }).replace(
      "</body>",
      `<div data-testid="consent-banner"><h2>Cookie settings</h2><p>We use cookies to deliver and improve our services. You can read our Cookie Policy here.</p><button>Accept</button></div></body>`,
    );
    const result = await braveReader(
      { url: "https://example.com/article", maxResultBytes: 100_000 },
      { fetchImpl: async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }), lookup: PUBLIC_DNS_STUB },
    );
    assert.equal(result.readableContentFound, true);
    assert.match(result.content, /Real Article/);
    assert.match(result.content, /opening paragraph/);
    assert.doesNotMatch(result.content, /Cookie Policy/i);
    assert.doesNotMatch(result.content, /Cookie settings/i);
  });

  it("preserves a legitimate article that is ABOUT cookies/privacy", async () => {
    const { braveReader } = await importSource("extensions/ampi-web/brave.ts");
    const PUBLIC_DNS_STUB = async () => [{ address: "203.0.113.10", family: 4 }];
    const html = articleHtml({
      title: "How browser cookies work",
      body: `
        <p>This article explains how HTTP cookies are set, read, and expired by
        browsers, and why the consent and privacy regulations around cookies
        matter for site operators who must obtain user consent before storing
        non-essential cookies on a device.</p>
        <p>We cover the Set-Cookie header, SameSite attributes, and the GDPR and
        CCPA consent requirements in enough depth that Readability scores this
        body as the primary article content on the page.</p>`,
    });
    const result = await braveReader(
      { url: "https://example.com/cookies", maxResultBytes: 100_000 },
      { fetchImpl: async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }), lookup: PUBLIC_DNS_STUB },
    );
    assert.equal(result.readableContentFound, true);
    assert.match(result.content, /How browser cookies work/);
    assert.match(result.content, /SameSite attributes/);
  });

  it("returns an honest diagnostic for a JavaScript app-shell page", async () => {
    const { braveReader } = await importSource("extensions/ampi-web/brave.ts");
    const PUBLIC_DNS_STUB = async () => [{ address: "203.0.113.10", family: 4 }];
    const shell = `<!DOCTYPE html><html><head><title>App</title></head><body>` +
      `<div id="__next">${"<div>Loading...</div>".repeat(12)}</div>` +
      `<script>self.__next_f=self.__next_f||[];self.__next_f.push([1,"hydration"]);</script>` +
      `</body></html>`;
    const result = await braveReader(
      { url: "https://example.com/app", maxResultBytes: 100_000 },
      { fetchImpl: async () => new Response(shell, { status: 200, headers: { "content-type": "text/html" } }), lookup: PUBLIC_DNS_STUB },
    );
    assert.equal(result.readableContentFound, false);
    assert.equal(result.extractionReason, "requires_javascript");
    assert.match(result.content, /No readable content found/);
    assert.match(result.content, /JavaScript-rendered/);
    assert.doesNotMatch(result.content, /Loading\.\.\./);
  });

  it("returns a placeholder diagnostic for a loading-only body without shell markers", async () => {
    const { braveReader } = await importSource("extensions/ampi-web/brave.ts");
    const PUBLIC_DNS_STUB = async () => [{ address: "203.0.113.10", family: 4 }];
    const body = `<!DOCTYPE html><html><head><title>Wait</title></head><body><main>${"<p>Loading...</p>".repeat(10)}</main></body></html>`;
    const result = await braveReader(
      { url: "https://example.com/wait", maxResultBytes: 100_000 },
      { fetchImpl: async () => new Response(body, { status: 200, headers: { "content-type": "text/html" } }), lookup: PUBLIC_DNS_STUB },
    );
    assert.equal(result.readableContentFound, false);
    assert.equal(result.extractionReason, "placeholder_only");
    assert.match(result.content, /placeholder content/);
  });

  it("keeps small-but-legitimate pages readable (not flagged as empty)", async () => {
    const { braveReader } = await importSource("extensions/ampi-web/brave.ts");
    const PUBLIC_DNS_STUB = async () => [{ address: "203.0.113.10", family: 4 }];
    const html = `<html><body><main><h1>Doc</h1><p>Hello <strong>world</strong>.</p></main></body></html>`;
    const result = await braveReader(
      { url: "https://example.com/doc", maxResultBytes: 100_000 },
      { fetchImpl: async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }), lookup: PUBLIC_DNS_STUB },
    );
    assert.notEqual(result.readableContentFound, false);
    assert.match(result.content, /# Doc/);
    assert.match(result.content, /\*\*world\*\*/);
  });

  it("preserves text/plain bodies verbatim (no Readability/Turndown applied)", async () => {
    const { braveReader } = await importSource("extensions/ampi-web/brave.ts");
    const PUBLIC_DNS_STUB = async () => [{ address: "203.0.113.10", family: 4 }];
    const verbatim = "# Already markdown\n\nSecond *line*.\n\n```js\nlet x = 1;\n```\n";
    const fetchImpl = async () =>
      new Response(verbatim, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    const result = await braveReader(
      { url: "https://example.com/doc.md", maxResultBytes: 100_000 },
      { fetchImpl, lookup: PUBLIC_DNS_STUB },
    );
    assert.equal(result.content, verbatim);
  });
});
