import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

function settings(partial = {}) {
  return {
    enabled: false,
    backend: "auto",
    searchBackend: undefined,
    readerBackend: undefined,
    braveApiKey: undefined,
    searxngUrl: undefined,
    searchTimeoutMs: 30000,
    readTimeoutMs: 30000,
    maxResultBytes: 200000,
    ...partial,
  };
}

describe("mmr-web feature gate provider", () => {
  it("does not claim other feature gates", async () => {
    const { createMmrWebFeatureGateProvider } = await importSource("extensions/mmr-web/provider.ts");
    const provider = createMmrWebFeatureGateProvider(() => settings());
    assert.equal(provider.name, "mmr-web");
    assert.equal(provider.evaluate("mmr-review"), undefined);
  });

  it("reports mmr-web disabled when network access is off", async () => {
    const { createMmrWebFeatureGateProvider } = await importSource("extensions/mmr-web/provider.ts");
    const provider = createMmrWebFeatureGateProvider(() => settings({ enabled: false }));
    const decision = provider.evaluate("mmr-web");
    assert.equal(decision.status, "disabled");
    assert.match(decision.reason, /disabled/i);
  });

  it("reports the active search backend and the custom reader when network access is on", async () => {
    const { createMmrWebFeatureGateProvider } = await importSource("extensions/mmr-web/provider.ts");
    // No SearXNG / no Brave key: auto falls back to the no-key DuckDuckGo backend.
    const ddgAuto = createMmrWebFeatureGateProvider(() => settings({ enabled: true })).evaluate("mmr-web");
    assert.equal(ddgAuto.status, "enabled");
    assert.match(ddgAuto.reason, /web_search via duckduckgo/i);
    assert.match(ddgAuto.reason, /no-key|best-effort/i);
    assert.match(ddgAuto.reason, /read_web_page via custom/i);
    assert.doesNotMatch(ddgAuto.reason, /JINA/i);

    // BRAVE_API_KEY set: auto resolves to Brave.
    const braveAuto = createMmrWebFeatureGateProvider(() => settings({ enabled: true, braveApiKey: "brv" })).evaluate("mmr-web");
    assert.equal(braveAuto.status, "enabled");
    assert.match(braveAuto.reason, /web_search via brave/i);
    assert.match(braveAuto.reason, /read_web_page via custom/i);
    assert.doesNotMatch(braveAuto.reason, /JINA/i);

    // SearXNG URL set: auto prefers SearXNG even when Brave key is present.
    const sxng = createMmrWebFeatureGateProvider(() => settings({
      enabled: true,
      braveApiKey: "brv",
      searxngUrl: "http://127.0.0.1:8080",
    })).evaluate("mmr-web");
    assert.match(sxng.reason, /web_search via searxng/i);
  });
});

describe("mmr-web tool provider", () => {
  it("does not claim other logical tools", async () => {
    const { createMmrWebToolProvider } = await importSource("extensions/mmr-web/provider.ts");
    const provider = createMmrWebToolProvider(() => settings());
    assert.equal(provider.name, "mmr-web");
    assert.equal(provider.resolve("Read"), undefined);
    assert.equal(provider.resolve("oracle"), undefined);
  });

  it("gates both tools when network access is disabled", async () => {
    const { createMmrWebToolProvider } = await importSource("extensions/mmr-web/provider.ts");
    const provider = createMmrWebToolProvider(() => settings({ enabled: false }));
    for (const logical of ["web_search", "read_web_page"]) {
      const rule = provider.resolve(logical);
      assert.equal(rule?.kind, "gated");
      assert.equal(rule.gate, "mmr-web");
      assert.match(rule.reason, /disabled/i);
    }
  });

  it("activates both tools when enabled without API keys", async () => {
    const { createMmrWebToolProvider } = await importSource("extensions/mmr-web/provider.ts");
    const provider = createMmrWebToolProvider(() => settings({ enabled: true }));
    const search = provider.resolve("web_search");
    assert.equal(search.kind, "active");

    const reader = provider.resolve("read_web_page");
    assert.equal(reader.kind, "active");
  });

  it("activates both tools when enabled and BRAVE_API_KEY is set", async () => {
    const { createMmrWebToolProvider } = await importSource("extensions/mmr-web/provider.ts");
    const provider = createMmrWebToolProvider(() => settings({ enabled: true, braveApiKey: "free-key" }));
    const search = provider.resolve("web_search");
    assert.equal(search.kind, "active");

    const reader = provider.resolve("read_web_page");
    assert.equal(reader.kind, "active");
  });

  it("re-evaluates settings on every resolve call (latest-wins)", async () => {
    const { createMmrWebToolProvider } = await importSource("extensions/mmr-web/provider.ts");
    let current = settings();
    const provider = createMmrWebToolProvider(() => current);

    assert.equal(provider.resolve("web_search").kind, "gated");
    current = settings({ enabled: true, braveApiKey: "k" });
    assert.equal(provider.resolve("web_search").kind, "active");
  });
});
