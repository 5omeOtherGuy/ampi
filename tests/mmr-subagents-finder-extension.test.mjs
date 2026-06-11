// RED-first tests pinning the provider/extension behavior the finder slice
// must produce. The existing `mmr-subagents-provider.test.mjs` and
// `mmr-subagents-extension.test.mjs` files assert the *shell-slice*
// behavior (gate disabled, every owned tool gated, no Pi tools
// registered). This file pins the *post-finder-slice* behavior:
//
//   1. `createMmrSubagentsFeatureGateProvider({ finder: true })` reports
//      the gate as `enabled` with a reason that names finder.
//   2. The default-args factory still reports `disabled` so other tests
//      that exercise the shell behavior keep working until the index.ts
//      wiring flips.
//   3. `createMmrSubagentsToolProvider({ finder: true })` resolves
//      `finder` to `{ kind: "oneOf", candidates: ["finder"] }` while
//      `Task`, `oracle`, and `librarian` stay gated.
//   4. `createMmrWorkersExtension()(pi)` actually registers a concrete
//      Pi tool named `finder` via `pi.registerTool`.
//   5. After loading the extension, `resolveMmrTools("smart", ...)` shows
//      `finder` as `active` with owner `mmr-subagents` (gated `Task`/
//      `oracle`/`librarian` still appear, but never `finder`).

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

function makePi() {
  const tools = [];
  const handlers = new Map();
  return {
    tools,
    handlers,
    pi: {
      registerTool: (definition) => tools.push(definition),
      on: (name, handler) => handlers.set(name, handler),
      getAllTools: () => tools.map((tool) => ({ name: tool.name, sourceInfo: { path: "test" } })),
    },
  };
}

async function importRuntime() {
  const url = pathToFileURL(path.join(getPreparedSourceRoot(), "extensions/mmr-core/runtime.ts")).href;
  return import(url);
}

describe("mmr-subagents providers with finder capability", () => {
  it("feature gate flips to enabled when finder is shipped", async () => {
    const { createMmrSubagentsFeatureGateProvider, MMR_SUBAGENTS_FEATURE_GATE } = await importSource(
      "extensions/mmr-workers/provider.ts",
    );
    const provider = createMmrSubagentsFeatureGateProvider({ finder: true });
    const decision = provider.evaluate(MMR_SUBAGENTS_FEATURE_GATE);
    assert.ok(decision);
    assert.equal(decision.status, "enabled");
    assert.match(decision.reason, /finder/i);
  });

  it("feature gate stays disabled with default args (preserves shell behavior)", async () => {
    const { createMmrSubagentsFeatureGateProvider, MMR_SUBAGENTS_FEATURE_GATE } = await importSource(
      "extensions/mmr-workers/provider.ts",
    );
    const provider = createMmrSubagentsFeatureGateProvider();
    const decision = provider.evaluate(MMR_SUBAGENTS_FEATURE_GATE);
    assert.ok(decision);
    assert.equal(decision.status, "disabled");
  });

  it("tool provider claims finder as active when shipped and keeps others gated", async () => {
    const { createMmrSubagentsToolProvider, MMR_SUBAGENTS_FEATURE_GATE } = await importSource(
      "extensions/mmr-workers/provider.ts",
    );
    // Capability matrix isolated to finder so this test continues to
    // assert the pre-oracle behavior of the provider switch.
    const provider = createMmrSubagentsToolProvider({ finder: true });
    const finderRule = provider.resolve("finder");
    assert.ok(finderRule);
    assert.equal(finderRule.kind, "active");
    for (const stillGated of ["Task", "oracle", "librarian"]) {
      const rule = provider.resolve(stillGated);
      assert.ok(rule, `${stillGated} must still produce a rule`);
      assert.equal(rule.kind, "gated", `${stillGated} must stay gated until its slice ships`);
      assert.equal(rule.gate, MMR_SUBAGENTS_FEATURE_GATE);
    }
  });

  it("tool provider with default args keeps every owned tool gated (preserves shell behavior)", async () => {
    const { createMmrSubagentsToolProvider } = await importSource("extensions/mmr-workers/provider.ts");
    const provider = createMmrSubagentsToolProvider();
    for (const logical of ["Task", "finder", "oracle", "librarian"]) {
      const rule = provider.resolve(logical);
      assert.ok(rule);
      assert.equal(rule.kind, "gated");
    }
  });
});

describe("mmr-subagents extension factory wires up finder", () => {
  it("registers a concrete Pi tool named `finder` via pi.registerTool", async () => {
    const { createMmrWorkersExtension } = await importSource("extensions/mmr-workers/index.ts");
    const { pi, tools } = makePi();
    createMmrWorkersExtension()(pi);
    const finder = tools.find((tool) => tool.name === "finder");
    assert.ok(finder, "extension must register a Pi tool named finder");
    assert.equal(typeof finder.execute, "function");
    assert.equal(typeof finder.description, "string");
    assert.ok(Array.isArray(finder.promptGuidelines) && finder.promptGuidelines.length > 0);
  });

  it("after loading, smart-mode resolution shows finder as active and owned by mmr-subagents", async () => {
    const { createMmrWorkersExtension } = await importSource("extensions/mmr-workers/index.ts");
    const runtime = await importRuntime();
    const { pi } = makePi();
    createMmrWorkersExtension()(pi);

    const resolved = runtime.resolveMmrTools(
      "smart",
      ["read", "bash", "edit", "write", "grep", "find", "finder", "Task"],
    );
    for (const shipped of ["finder", "Task"]) {
      const decision = resolved.decisions.find((d) => d.requested === shipped);
      assert.ok(decision, `smart mode must produce a decision for ${shipped}`);
      assert.equal(decision.status, "active");
      assert.equal(decision.owner, "mmr-workers");
      assert.equal(resolved.activeTools.includes(shipped), true);
      assert.equal(resolved.gatedTools.includes(shipped), false);
    }
    // Unshipped owned tools must still be gated.
    const decision = resolved.decisions.find((d) => d.requested === "librarian");
    assert.ok(decision);
    assert.equal(decision.status, "gated", "librarian must remain gated until its slice ships");
  });

  it("after loading, feature gate decision for mmr-subagents reports enabled", async () => {
    const { createMmrWorkersExtension } = await importSource("extensions/mmr-workers/index.ts");
    const runtime = await importRuntime();
    const { pi } = makePi();
    createMmrWorkersExtension()(pi);

    const [decision] = runtime.resolveMmrFeatureGates(["mmr-subagents"]);
    assert.equal(decision.gate, "mmr-subagents");
    assert.equal(decision.status, "enabled");
    assert.equal(decision.source, "mmr-workers");
  });
});
