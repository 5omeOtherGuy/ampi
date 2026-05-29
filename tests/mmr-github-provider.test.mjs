import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const PROVIDER_MODULE = "extensions/mmr-github/provider.ts";
const OWNERSHIP_MODULE = "extensions/mmr-github/tool-ownership.ts";

function settings(partial = {}) {
  return { enabled: false, token: undefined, apiBaseUrl: "https://api.github.test", requestTimeoutMs: 1000, maxResultBytes: 200000, ...partial };
}

describe("mmr-github provider", () => {
  it("gates every GitHub tool when disabled and claims them when enabled", async () => {
    const { createMmrGithubToolProvider, MMR_GITHUB_FEATURE_GATE } = await importSource(PROVIDER_MODULE);
    const { MMR_GITHUB_TOOL_NAMES } = await importSource(OWNERSHIP_MODULE);

    const disabled = createMmrGithubToolProvider(() => settings({ enabled: false }));
    for (const name of MMR_GITHUB_TOOL_NAMES) {
      const rule = disabled.resolve(name);
      assert.ok(rule);
      assert.equal(rule.kind, "gated");
      assert.equal(rule.gate, MMR_GITHUB_FEATURE_GATE);
    }
    assert.equal(disabled.resolve("read"), undefined, "must not claim unrelated names");

    const enabled = createMmrGithubToolProvider(() => settings({ enabled: true }));
    for (const name of MMR_GITHUB_TOOL_NAMES) {
      assert.equal(enabled.resolve(name).kind, "active");
    }
  });

  it("reports disabled and enabled feature-gate reasons including auth state", async () => {
    const { createMmrGithubFeatureGateProvider, MMR_GITHUB_FEATURE_GATE } = await importSource(PROVIDER_MODULE);
    const off = createMmrGithubFeatureGateProvider(() => settings({ enabled: false })).evaluate(MMR_GITHUB_FEATURE_GATE);
    assert.equal(off.status, "disabled");
    assert.match(off.reason, /MMR_GITHUB_ENABLE=true/);

    const anon = createMmrGithubFeatureGateProvider(() => settings({ enabled: true })).evaluate(MMR_GITHUB_FEATURE_GATE);
    assert.equal(anon.status, "enabled");
    assert.match(anon.reason, /anonymous/);

    const auth = createMmrGithubFeatureGateProvider(() => settings({ enabled: true, token: "t" })).evaluate(MMR_GITHUB_FEATURE_GATE);
    assert.match(auth.reason, /authenticated/);

    const other = createMmrGithubFeatureGateProvider(() => settings()).evaluate("mmr-web");
    assert.equal(other, undefined, "must only claim the mmr-github gate");
  });
});

describe("mmr-github tool ownership", () => {
  it("recognizes owned tools only by registered source path", async () => {
    const {
      __resetMmrGithubToolSourcePathsForTests,
      registerMmrGithubToolSourcePath,
      hasMmrGithubOwnedTools,
      MMR_GITHUB_TOOL_NAMES,
    } = await importSource(OWNERSHIP_MODULE);
    const SRC = "/virtual/mmr-github/index.ts";
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
