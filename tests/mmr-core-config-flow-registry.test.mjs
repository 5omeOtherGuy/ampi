// Inverted /mmr-config section ownership: siblings register their config
// sub-flows into a core-owned registry, so mmr-core dispatches without
// importing them (MMR_CORE_SIBLING_IMPORT_EXCEPTIONS is empty).

import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const REGISTRY_MODULE = "extensions/ampi-core/config-flow-registry.ts";

async function freshRegistry() {
  const mod = await importSource(REGISTRY_MODULE);
  mod.__resetMmrConfigFlowSectionsForTests();
  return mod;
}

describe("config-flow section registry", () => {
  beforeEach(async () => {
    await freshRegistry();
  });

  it("lists sections in (order, label) order and replaces by id", async () => {
    const { registerMmrConfigFlowSection, listMmrConfigFlowSections } = await importSource(REGISTRY_MODULE);
    registerMmrConfigFlowSection({ id: "b", label: "web", order: 20, run: () => {} });
    registerMmrConfigFlowSection({ id: "a", label: "subagent (setup/import custom)", order: 10, run: () => {} });
    assert.deepEqual(
      listMmrConfigFlowSections().map((s) => s.label),
      ["subagent (setup/import custom)", "web"],
    );
    // re-register same id replaces, does not duplicate
    registerMmrConfigFlowSection({ id: "a", label: "renamed", order: 10, run: () => {} });
    const labels = listMmrConfigFlowSections().map((s) => s.label);
    assert.deepEqual(labels, ["renamed", "web"]);
  });

  it("ignores empty id or label", async () => {
    const { registerMmrConfigFlowSection, listMmrConfigFlowSections } = await importSource(REGISTRY_MODULE);
    registerMmrConfigFlowSection({ id: "", label: "x", order: 1, run: () => {} });
    registerMmrConfigFlowSection({ id: "y", label: "   ", order: 1, run: () => {} });
    assert.deepEqual(listMmrConfigFlowSections(), []);
  });
});

describe("/mmr-config dispatch via registry", () => {
  beforeEach(async () => {
    await freshRegistry();
  });

  it("routes a selected registered label to that section's run()", async () => {
    const { registerMmrConfigFlowSection } = await importSource(REGISTRY_MODULE);
    const { runMmrConfigFlow } = await importSource("extensions/ampi-core/config-flow.ts");
    let ran = null;
    const tools = ["read_file", "web_search"];
    registerMmrConfigFlowSection({
      id: "ampi-web",
      label: "web",
      order: 20,
      run: (_ctx, sectionCtx) => {
        ran = sectionCtx.getAvailableTools?.() ?? null;
      },
    });

    const presented = [];
    const ctx = {
      cwd: "/tmp/cfg",
      hasUI: true,
      ui: {
        select: async (_title, options) => {
          presented.push(...options);
          return "web";
        },
        notify: () => {},
      },
    };
    await runMmrConfigFlow(ctx, { getAvailableTools: () => tools });
    assert.ok(presented.includes("mode") && presented.includes("subagent") && presented.includes("web"));
    assert.deepEqual(ran, tools);
  });
});

describe("siblings register their /mmr-config sections on load", () => {
  beforeEach(async () => {
    await freshRegistry();
  });

  it("mmr-web registers the \"web\" section", async () => {
    await importSource("extensions/ampi-web/index.ts");
    const { listMmrConfigFlowSections } = await importSource(REGISTRY_MODULE);
    assert.ok(listMmrConfigFlowSections().some((s) => s.id === "ampi-web" && s.label === "web"));
  });

  it("mmr-custom-subagents registers the custom setup/import section", async () => {
    const mod = await importSource("extensions/ampi-custom-subagents/index.ts");
    // touch the factory so module side effects are unquestionably evaluated
    const { pi } = createMockPi();
    mod.createMmrCustomSubagentsExtension({ customSubagents: { cwd: "/tmp/none" } })(pi);
    const { listMmrConfigFlowSections } = await importSource(REGISTRY_MODULE);
    assert.ok(
      listMmrConfigFlowSections().some(
        (s) => s.id === "ampi-custom-subagents" && s.label === "subagent (setup/import custom)",
      ),
    );
  });
});
