import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

describe("ampi-custom-subagents provider", () => {
  it("identifies itself as ampi-custom-subagents", async () => {
    const { createMmrCustomSubagentsToolProvider, AMPI_CUSTOM_SUBAGENTS_PROVIDER_NAME, MMR_CUSTOM_SUBAGENTS_PROVIDER_NAME } = await importSource(
      "extensions/ampi-custom-subagents/provider.ts",
    );
    const provider = createMmrCustomSubagentsToolProvider();
    assert.equal(provider.name, "ampi-custom-subagents");
    assert.equal(provider.name, AMPI_CUSTOM_SUBAGENTS_PROVIDER_NAME);
    assert.equal(MMR_CUSTOM_SUBAGENTS_PROVIDER_NAME, "mmr-custom-subagents");
  });

  it("claims only enabled sa__ tool names", async () => {
    const { createMmrCustomSubagentsToolProvider } = await importSource("extensions/ampi-custom-subagents/provider.ts");
    const provider = createMmrCustomSubagentsToolProvider({ customTools: ["sa__alpha"] });
    assert.deepEqual(provider.resolve("sa__alpha"), { kind: "active" });
    assert.equal(provider.resolve("sa__beta"), undefined);
    assert.equal(provider.resolve("finder"), undefined);
  });

  it("evaluates the custom-subagents feature gate from enabled custom tools", async () => {
    const { createMmrCustomSubagentsFeatureGateProvider, AMPI_CUSTOM_SUBAGENTS_FEATURE_GATE, MMR_CUSTOM_SUBAGENTS_FEATURE_GATE } = await importSource(
      "extensions/ampi-custom-subagents/provider.ts",
    );
    assert.equal(createMmrCustomSubagentsFeatureGateProvider().evaluate(AMPI_CUSTOM_SUBAGENTS_FEATURE_GATE).status, "disabled");
    assert.equal(createMmrCustomSubagentsFeatureGateProvider().evaluate(MMR_CUSTOM_SUBAGENTS_FEATURE_GATE).status, "disabled");
    // Canonical and legacy gate ids must stay behaviorally equivalent when enabled.
    const enabledProvider = createMmrCustomSubagentsFeatureGateProvider({ customTools: () => ["sa__alpha"] });
    for (const gateId of [AMPI_CUSTOM_SUBAGENTS_FEATURE_GATE, MMR_CUSTOM_SUBAGENTS_FEATURE_GATE]) {
      const enabled = enabledProvider.evaluate(gateId);
      assert.equal(enabled.status, "enabled", `${gateId} must enable when custom tools exist`);
      assert.match(enabled.reason, /sa__alpha/);
    }
  });
});
