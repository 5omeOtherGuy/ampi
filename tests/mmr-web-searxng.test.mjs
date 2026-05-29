import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function htmlResponse(body, init = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "text/html", ...(init.headers ?? {}) },
  });
}

function makeFetchMock(plan) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = typeof input === "string" || input instanceof URL ? new URL(String(input)) : new URL(input.url);
    calls.push({ url, init });
    const handler = plan.shift();
    if (!handler) throw new Error(`unexpected fetch call to ${url.toString()}`);
    return handler({ url, init });
  };
  return { fetchImpl, calls };
}

describe("mmr-web SearXNG client - search", () => {
  it("rejects an empty SearXNG URL", async () => {
    const { searxngSearch } = await importSource("extensions/mmr-web/search/searxng.ts");
    await assert.rejects(
      () => searxngSearch({ query: "ts", maxResults: 5, maxResultBytes: 10000 }, { url: "" }),
      /SearXNG URL/,
    );
  });

  it("rejects an empty query", async () => {
    const { searxngSearch } = await importSource("extensions/mmr-web/search/searxng.ts");
    await assert.rejects(
      () => searxngSearch({ query: "  ", maxResults: 5, maxResultBytes: 10000 }, { url: "http://127.0.0.1:8080" }),
      /non-empty query/,
    );
  });

  it("sends a GET request to /search?format=json with the user query", async () => {
    const { searxngSearch } = await importSource("extensions/mmr-web/search/searxng.ts");
    const { fetchImpl, calls } = makeFetchMock([
      () => jsonResponse({ results: [
        { title: "TypeScript", url: "https://example.com/ts", content: "Typed JS" },
      ] }),
    ]);
    const result = await searxngSearch(
      { query: "typescript", maxResults: 3, maxResultBytes: 100_000 },
      { url: "http://127.0.0.1:8080", fetchImpl },
    );
    assert.equal(calls.length, 1);
    const u = calls[0].url;
    assert.equal(u.protocol, "http:");
    assert.equal(u.hostname, "127.0.0.1");
    assert.equal(u.port, "8080");
    assert.equal(u.pathname, "/search");
    assert.equal(u.searchParams.get("q"), "typescript");
    assert.equal(u.searchParams.get("format"), "json");
    assert.equal(u.searchParams.get("safesearch"), "1");
    assert.equal(u.searchParams.get("language"), "en");
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].title, "TypeScript");
    assert.equal(result.results[0].url, "https://example.com/ts");
    assert.equal(result.results[0].description, "Typed JS");
  });

  it("preserves a base path prefix when the SearXNG URL is hosted under a subpath", async () => {
    const { searxngSearch } = await importSource("extensions/mmr-web/search/searxng.ts");
    const { fetchImpl, calls } = makeFetchMock([
      () => jsonResponse({ results: [] }),
    ]);
    await searxngSearch(
      { query: "x", maxResults: 1, maxResultBytes: 1000 },
      { url: "https://example.com/searx/", fetchImpl },
    );
    assert.equal(calls[0].url.pathname, "/searx/search");
  });

  it("rejects result URLs that would fail the public-web SSRF policy", async () => {
    const { searxngSearch } = await importSource("extensions/mmr-web/search/searxng.ts");
    const { fetchImpl } = makeFetchMock([
      () => jsonResponse({ results: [
        { title: "ok", url: "https://example.com/ok" },
        { title: "loop", url: "http://127.0.0.1/internal" },
        { title: "file", url: "file:///etc/passwd" },
        { title: "creds", url: "https://user:pass@example.com/" },
        { title: "ok2", url: "https://example.org/ok2" },
      ] }),
    ]);
    const result = await searxngSearch(
      { query: "x", maxResults: 10, maxResultBytes: 100_000 },
      { url: "http://127.0.0.1:8080", fetchImpl },
    );
    const urls = result.results.map((r) => r.url);
    assert.deepEqual(urls, ["https://example.com/ok", "https://example.org/ok2"]);
  });

  it("clamps to maxResults", async () => {
    const { searxngSearch } = await importSource("extensions/mmr-web/search/searxng.ts");
    const { fetchImpl } = makeFetchMock([
      () => jsonResponse({ results: Array.from({ length: 8 }, (_, i) => ({
        title: `t${i}`, url: `https://example.com/${i}`,
      })) }),
    ]);
    const result = await searxngSearch(
      { query: "x", maxResults: 3, maxResultBytes: 100_000 },
      { url: "http://127.0.0.1:8080", fetchImpl },
    );
    assert.equal(result.results.length, 3);
    assert.equal(result.results[2].url, "https://example.com/2");
  });

  it("surfaces an actionable error when the instance returns HTML (JSON not enabled)", async () => {
    const { searxngSearch } = await importSource("extensions/mmr-web/search/searxng.ts");
    const { fetchImpl } = makeFetchMock([
      () => htmlResponse("<!DOCTYPE html><html><body>SearXNG</body></html>"),
    ]);
    await assert.rejects(
      () => searxngSearch(
        { query: "x", maxResults: 5, maxResultBytes: 100_000 },
        { url: "http://127.0.0.1:8080", fetchImpl },
      ),
      /HTML instead of JSON.*settings\.yml/s,
    );
  });

  it("propagates HTTP error status with a diagnostic body preview", async () => {
    const { searxngSearch } = await importSource("extensions/mmr-web/search/searxng.ts");
    const { fetchImpl } = makeFetchMock([
      () => new Response("rate limited", { status: 429, headers: { "content-type": "text/plain" } }),
    ]);
    await assert.rejects(
      () => searxngSearch(
        { query: "x", maxResults: 5, maxResultBytes: 100_000 },
        { url: "http://127.0.0.1:8080", fetchImpl },
      ),
      /HTTP 429.*rate limited/s,
    );
  });

  it("normalizes publishedDate to age", async () => {
    const { searxngSearch } = await importSource("extensions/mmr-web/search/searxng.ts");
    const { fetchImpl } = makeFetchMock([
      () => jsonResponse({ results: [
        { title: "t", url: "https://example.com/", publishedDate: "2024-01-15" },
      ] }),
    ]);
    const result = await searxngSearch(
      { query: "x", maxResults: 5, maxResultBytes: 100_000 },
      { url: "http://127.0.0.1:8080", fetchImpl },
    );
    assert.equal(result.results[0].age, "2024-01-15");
  });

  it("createSearXNGSearchBackend returns a SearchBackend with id=searxng", async () => {
    const { createSearXNGSearchBackend } = await importSource("extensions/mmr-web/search/searxng.ts");
    const { fetchImpl } = makeFetchMock([
      () => jsonResponse({ results: [{ title: "t", url: "https://example.com/" }] }),
    ]);
    const backend = createSearXNGSearchBackend({ url: "http://127.0.0.1:8080", fetchImpl });
    assert.equal(backend.id, "searxng");
    const response = await backend.search({ query: "x", maxResults: 1, maxResultBytes: 1000 });
    assert.equal(response.results.length, 1);
  });
});
