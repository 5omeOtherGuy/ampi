import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

/**
 * Settings stub for resolveBackend. Defaults mirror loadMmrWebSettings
 * defaults; tests override only the fields under test.
 */
function settings(overrides = {}) {
  return {
    enabled: true,
    backend: "auto",
    searchBackend: undefined,
    readerBackend: undefined,
    braveApiKey: undefined,
    searxngUrl: undefined,
    searchTimeoutMs: 30_000,
    readTimeoutMs: 30_000,
    maxResultBytes: 200_000,
    ...overrides,
  };
}

describe("resolveBackend - Brave search and custom reader", () => {
  it("disables both web tools when mmr-web network access is disabled", async () => {
    const { resolveBackend } = await importSource("extensions/ampi-web/backend.ts");
    const search = resolveBackend("web_search", settings({ enabled: false, braveApiKey: "brv" }));
    const reader = resolveBackend("read_web_page", settings({ enabled: false }));
    assert.equal(search.backend, undefined);
    assert.equal(search.reason, "disabled");
    assert.equal(reader.backend, undefined);
    assert.equal(reader.reason, "disabled");
  });

  it("uses Brave exclusively for web_search when BRAVE_API_KEY is configured", async () => {
    const { resolveBackend } = await importSource("extensions/ampi-web/backend.ts");
    const decision = resolveBackend("web_search", settings({ braveApiKey: "brv" }));
    assert.equal(decision.backend, "brave");
    assert.equal(decision.reason, "ok");
    assert.match(decision.message, /Brave/);
  });

  it("falls back to DuckDuckGo in auto mode when no SearXNG URL and no Brave key are set", async () => {
    const { resolveBackend } = await importSource("extensions/ampi-web/backend.ts");
    const decision = resolveBackend("web_search", settings());
    assert.equal(decision.backend, "duckduckgo");
    assert.equal(decision.reason, "ok");
    assert.match(decision.message, /no-key|best-effort/i);
  });

  it("uses the custom direct reader for read_web_page without any API key", async () => {
    const { resolveBackend } = await importSource("extensions/ampi-web/backend.ts");
    const decision = resolveBackend("read_web_page", settings());
    assert.equal(decision.backend, "custom");
    assert.equal(decision.reason, "ok");
    assert.match(decision.message, /custom/i);
  });

  it("does not switch providers when deprecated backend settings are present", async () => {
    const { resolveBackend } = await importSource("extensions/ampi-web/backend.ts");
    const search = resolveBackend("web_search", settings({ backend: "brave", searchBackend: "auto", braveApiKey: "brv" }));
    const reader = resolveBackend("read_web_page", settings({ backend: "brave", readerBackend: "auto" }));
    assert.equal(search.backend, "brave");
    assert.equal(reader.backend, "custom");
  });
});

describe("resolveBackend - SearXNG", () => {
  it("prefers SearXNG in auto mode when searxngUrl is configured", async () => {
    const { resolveBackend } = await importSource("extensions/ampi-web/backend.ts");
    const decision = resolveBackend("web_search", settings({ searxngUrl: "http://127.0.0.1:8080" }));
    assert.equal(decision.backend, "searxng");
    assert.equal(decision.reason, "ok");
    assert.match(decision.message, /SearXNG/);
    assert.match(decision.message, /127\.0\.0\.1:8080/);
  });

  it("prefers SearXNG ahead of Brave when both are configured (auto mode)", async () => {
    const { resolveBackend } = await importSource("extensions/ampi-web/backend.ts");
    const decision = resolveBackend("web_search", settings({
      searxngUrl: "http://127.0.0.1:8080",
      braveApiKey: "brv",
    }));
    assert.equal(decision.backend, "searxng");
  });

  it("honors explicit searchBackend=searxng even without URL (execute will report setup error)", async () => {
    const { resolveBackend } = await importSource("extensions/ampi-web/backend.ts");
    const decision = resolveBackend("web_search", settings({
      searchBackend: "searxng",
      braveApiKey: "brv",
    }));
    assert.equal(decision.backend, "searxng");
    assert.match(decision.message, /MMR_WEB_SEARXNG_URL/);
  });

  it("honors explicit searchBackend=brave even when searxngUrl is set", async () => {
    const { resolveBackend } = await importSource("extensions/ampi-web/backend.ts");
    const decision = resolveBackend("web_search", settings({
      searchBackend: "brave",
      searxngUrl: "http://127.0.0.1:8080",
      braveApiKey: "brv",
    }));
    assert.equal(decision.backend, "brave");
  });
});

describe("resolveBackend - DuckDuckGo", () => {
  it("honors explicit searchBackend=duckduckgo (no config required)", async () => {
    const { resolveBackend } = await importSource("extensions/ampi-web/backend.ts");
    const decision = resolveBackend("web_search", settings({ searchBackend: "duckduckgo" }));
    assert.equal(decision.backend, "duckduckgo");
    assert.match(decision.message, /no-key|best-effort/i);
  });

  it("is overridden by SearXNG in auto mode when searxngUrl is set", async () => {
    const { resolveBackend } = await importSource("extensions/ampi-web/backend.ts");
    const decision = resolveBackend("web_search", settings({ searxngUrl: "http://127.0.0.1:8080" }));
    assert.equal(decision.backend, "searxng");
  });

  it("is overridden by Brave in auto mode when BRAVE_API_KEY is set", async () => {
    const { resolveBackend } = await importSource("extensions/ampi-web/backend.ts");
    const decision = resolveBackend("web_search", settings({ braveApiKey: "brv" }));
    assert.equal(decision.backend, "brave");
  });
});

describe("getSearchBackend factory", () => {
  it("returns a SearXNG backend instance when searxngUrl is set", async () => {
    const { getSearchBackend } = await importSource("extensions/ampi-web/backend.ts");
    const backend = getSearchBackend(settings({ searxngUrl: "http://127.0.0.1:8080" }));
    assert.ok(backend);
    assert.equal(backend.id, "searxng");
  });

  it("throws an actionable setup error when searxng is selected without a URL", async () => {
    const { getSearchBackend } = await importSource("extensions/ampi-web/backend.ts");
    assert.throws(
      () => getSearchBackend(settings({ searchBackend: "searxng" })),
      /MMR_WEB_SEARXNG_URL/,
    );
  });

  it("returns a Brave backend instance when brave is the selected backend", async () => {
    const { getSearchBackend } = await importSource("extensions/ampi-web/backend.ts");
    const backend = getSearchBackend(settings({ braveApiKey: "brv" }));
    assert.ok(backend);
    assert.equal(backend.id, "brave");
  });

  it("returns a DuckDuckGo backend instance when duckduckgo is the resolved fallback", async () => {
    const { getSearchBackend } = await importSource("extensions/ampi-web/backend.ts");
    const backend = getSearchBackend(settings());
    assert.ok(backend);
    assert.equal(backend.id, "duckduckgo");
  });

  it("returns a DuckDuckGo backend instance when explicitly selected", async () => {
    const { getSearchBackend } = await importSource("extensions/ampi-web/backend.ts");
    const backend = getSearchBackend(settings({ searchBackend: "duckduckgo" }));
    assert.ok(backend);
    assert.equal(backend.id, "duckduckgo");
  });
});
