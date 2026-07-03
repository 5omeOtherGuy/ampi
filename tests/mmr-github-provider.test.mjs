import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const PROVIDER_MODULE = "extensions/ampi-github/provider.ts";
const OWNERSHIP_MODULE = "extensions/ampi-github/tool-ownership.ts";

function settings(partial = {}) {
  return { enabled: false, token: undefined, apiBaseUrl: "https://api.github.test", requestTimeoutMs: 1000, maxResultBytes: 200000, ...partial };
}

describe("ampi-github provider", () => {
  it("gates every GitHub tool when disabled and claims them when enabled", async () => {
    const { createMmrGithubToolProvider, AMPI_GITHUB_FEATURE_GATE } = await importSource(PROVIDER_MODULE);
    const { MMR_GITHUB_TOOL_NAMES } = await importSource(OWNERSHIP_MODULE);

    const disabled = createMmrGithubToolProvider(() => settings({ enabled: false }));
    for (const name of MMR_GITHUB_TOOL_NAMES) {
      const rule = disabled.resolve(name);
      assert.ok(rule);
      assert.equal(rule.kind, "gated");
      assert.equal(rule.gate, AMPI_GITHUB_FEATURE_GATE);
    }
    assert.equal(disabled.resolve("read"), undefined, "must not claim unrelated names");

    const enabled = createMmrGithubToolProvider(() => settings({ enabled: true }));
    for (const name of MMR_GITHUB_TOOL_NAMES) {
      assert.equal(enabled.resolve(name).kind, "active");
    }
  });

  it("reports disabled and enabled feature-gate reasons including auth state", async () => {
    const { createMmrGithubFeatureGateProvider, AMPI_GITHUB_FEATURE_GATE, MMR_GITHUB_FEATURE_GATE } = await importSource(PROVIDER_MODULE);
    const off = createMmrGithubFeatureGateProvider(() => settings({ enabled: false })).evaluate(AMPI_GITHUB_FEATURE_GATE);
    assert.equal(off.status, "disabled");
    assert.match(off.reason, /AMPI_GITHUB_ENABLE=true/);
    assert.equal(createMmrGithubFeatureGateProvider(() => settings({ enabled: false })).evaluate(MMR_GITHUB_FEATURE_GATE).status, "disabled");

    const anon = createMmrGithubFeatureGateProvider(() => settings({ enabled: true })).evaluate(AMPI_GITHUB_FEATURE_GATE);
    assert.equal(anon.status, "enabled");
    assert.match(anon.reason, /anonymous/);

    const auth = createMmrGithubFeatureGateProvider(() => settings({ enabled: true, token: "t" })).evaluate(AMPI_GITHUB_FEATURE_GATE);
    assert.match(auth.reason, /authenticated/);

    const other = createMmrGithubFeatureGateProvider(() => settings()).evaluate("ampi-web");
    assert.equal(other, undefined, "must only claim the ampi-github gate");
  });
});

describe("ampi-github tool ownership", () => {
  it("recognizes owned tools only by registered source path", async () => {
    const {
      __resetMmrGithubToolSourcePathsForTests,
      registerMmrGithubToolSourcePath,
      hasMmrGithubOwnedTools,
      MMR_GITHUB_TOOL_NAMES,
    } = await importSource(OWNERSHIP_MODULE);
    const SRC = "/virtual/ampi-github/index.ts";
    __resetMmrGithubToolSourcePathsForTests();
    registerMmrGithubToolSourcePath(SRC);

    const owned = MMR_GITHUB_TOOL_NAMES.map((name) => ({ name, sourceInfo: { path: SRC } }));
    assert.equal(hasMmrGithubOwnedTools(owned), true);

    const foreign = MMR_GITHUB_TOOL_NAMES.map((name) => ({ name, sourceInfo: { path: "/other/index.ts" } }));
    assert.equal(hasMmrGithubOwnedTools(foreign), false);

    const noSource = MMR_GITHUB_TOOL_NAMES.map((name) => ({ name }));
    assert.equal(hasMmrGithubOwnedTools(noSource), false);

    const partial = owned.slice(0, 3);
    assert.equal(hasMmrGithubOwnedTools(partial), false, "must require every tool");
  });
});
