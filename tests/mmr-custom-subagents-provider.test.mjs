import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

describe("mmr-custom-subagents provider", () => {
  it("identifies itself as mmr-custom-subagents", async () => {
    const { createMmrCustomSubagentsToolProvider, MMR_CUSTOM_SUBAGENTS_PROVIDER_NAME } = await importSource(
      "extensions/mmr-custom-subagents/provider.ts",
    );
    const provider = createMmrCustomSubagentsToolProvider();
    assert.equal(provider.name, "mmr-custom-subagents");
    assert.equal(provider.name, MMR_CUSTOM_SUBAGENTS_PROVIDER_NAME);
  });

  it("claims only enabled sa__ tool names", async () => {
    const { createMmrCustomSubagentsToolProvider } = await importSource("extensions/mmr-custom-subagents/provider.ts");
    const provider = createMmrCustomSubagentsToolProvider({ customTools: ["sa__alpha"] });
    assert.deepEqual(provider.resolve("sa__alpha"), { kind: "active" });
    assert.equal(provider.resolve("sa__beta"), undefined);
    assert.equal(provider.resolve("finder"), undefined);
  });

  it("evaluates the custom-subagents feature gate from enabled custom tools", async () => {
    const { createMmrCustomSubagentsFeatureGateProvider, MMR_CUSTOM_SUBAGENTS_FEATURE_GATE } = await importSource(
      "extensions/mmr-custom-subagents/provider.ts",
    );
    assert.equal(createMmrCustomSubagentsFeatureGateProvider().evaluate(MMR_CUSTOM_SUBAGENTS_FEATURE_GATE).status, "disabled");
    const enabled = createMmrCustomSubagentsFeatureGateProvider({ customTools: () => ["sa__alpha"] }).evaluate(MMR_CUSTOM_SUBAGENTS_FEATURE_GATE);
    assert.equal(enabled.status, "enabled");
    assert.match(enabled.reason, /sa__alpha/);
  });
});
