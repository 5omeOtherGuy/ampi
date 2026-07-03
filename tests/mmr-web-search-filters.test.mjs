import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

describe("mmr-web search filters — hostnameMatchesDomain", () => {
  it("matches an exact hostname", async () => {
    const { hostnameMatchesDomain } = await importSource("extensions/ampi-web/search/filters.ts");
    assert.equal(hostnameMatchesDomain("example.com", "example.com"), true);
  });

  it("matches a subdomain suffix-aware", async () => {
    const { hostnameMatchesDomain } = await importSource("extensions/ampi-web/search/filters.ts");
    assert.equal(hostnameMatchesDomain("docs.example.com", "example.com"), true);
    assert.equal(hostnameMatchesDomain("a.b.example.com", "example.com"), true);
  });

  it("does not match a different registrable domain or a non-boundary suffix", async () => {
    const { hostnameMatchesDomain } = await importSource("extensions/ampi-web/search/filters.ts");
    assert.equal(hostnameMatchesDomain("notexample.com", "example.com"), false);
    assert.equal(hostnameMatchesDomain("example.com.evil.com", "example.com"), false);
    assert.equal(hostnameMatchesDomain("example.org", "example.com"), false);
  });

  it("is case- and trailing-dot-insensitive and tolerates a leading dot on the domain", async () => {
    const { hostnameMatchesDomain } = await importSource("extensions/ampi-web/search/filters.ts");
    assert.equal(hostnameMatchesDomain("Docs.Example.COM.", "example.com"), true);
    assert.equal(hostnameMatchesDomain("docs.example.com", ".example.com"), true);
  });

  it("returns false for an empty domain", async () => {
    const { hostnameMatchesDomain } = await importSource("extensions/ampi-web/search/filters.ts");
    assert.equal(hostnameMatchesDomain("example.com", ""), false);
  });
});

describe("mmr-web search filters — applyDomainFilter", () => {
  const rows = () => [
    { url: "https://docs.example.com/a", title: "a" },
    { url: "https://blog.other.com/b", title: "b" },
    { url: "https://example.org/c", title: "c" },
    { title: "no url" },
    { url: "not a url", title: "malformed" },
  ];

  it("returns all rows and no applied filters when no domain filter is provided", async () => {
    const { applyDomainFilter } = await importSource("extensions/ampi-web/search/filters.ts");
    const out = applyDomainFilter(rows(), {});
    assert.equal(out.results.length, 5);
    assert.deepEqual(out.applied, []);
  });

  it("include_domains keeps only matching hostnames and drops rows without a parseable URL", async () => {
    const { applyDomainFilter } = await importSource("extensions/ampi-web/search/filters.ts");
    const out = applyDomainFilter(rows(), { includeDomains: ["example.com"] });
    assert.deepEqual(out.results.map((r) => r.title), ["a"]);
    const include = out.applied.find((f) => f.filter === "include_domains");
    assert.equal(include.support, "post_filter");
    assert.equal(include.honored, "full");
  });

  it("exclude_domains drops matching hostnames and keeps rows without a parseable URL", async () => {
    const { applyDomainFilter } = await importSource("extensions/ampi-web/search/filters.ts");
    const out = applyDomainFilter(rows(), { excludeDomains: ["example.com"] });
    assert.deepEqual(out.results.map((r) => r.title), ["b", "c", "no url", "malformed"]);
    const exclude = out.applied.find((f) => f.filter === "exclude_domains");
    assert.equal(exclude.support, "post_filter");
    assert.equal(exclude.honored, "full");
  });

  it("applies include then exclude together and reports both filters", async () => {
    const { applyDomainFilter } = await importSource("extensions/ampi-web/search/filters.ts");
    const out = applyDomainFilter(rows(), {
      includeDomains: ["example.com", "other.com"],
      excludeDomains: ["other.com"],
    });
    assert.deepEqual(out.results.map((r) => r.title), ["a"]);
    assert.equal(out.applied.length, 2);
    assert.ok(out.applied.every((f) => f.honored === "full"));
  });

  it("ignores empty domain arrays (no filter recorded)", async () => {
    const { applyDomainFilter } = await importSource("extensions/ampi-web/search/filters.ts");
    const out = applyDomainFilter(rows(), { includeDomains: [], excludeDomains: [] });
    assert.equal(out.results.length, 5);
    assert.deepEqual(out.applied, []);
  });
});

describe("mmr-web search filters — recency mapping tables", () => {
  it("maps recency to Brave freshness codes", async () => {
    const { BRAVE_FRESHNESS_BY_RECENCY } = await importSource("extensions/ampi-web/search/filters.ts");
    assert.deepEqual(BRAVE_FRESHNESS_BY_RECENCY, { day: "pd", week: "pw", month: "pm", year: "py" });
  });

  it("maps recency to SearXNG time_range values", async () => {
    const { SEARXNG_TIME_RANGE_BY_RECENCY } = await importSource("extensions/ampi-web/search/filters.ts");
    assert.deepEqual(SEARXNG_TIME_RANGE_BY_RECENCY, { day: "day", week: "week", month: "month", year: "year" });
  });
});
