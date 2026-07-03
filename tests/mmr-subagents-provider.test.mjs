import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

describe("mmr-subagents feature gate provider", () => {
  it("identifies itself as ampi-subagents while retaining the legacy constant", async () => {
    const { createMmrSubagentsFeatureGateProvider, AMPI_SUBAGENTS_PROVIDER_NAME, MMR_SUBAGENTS_PROVIDER_NAME } = await importSource(
      "extensions/ampi-workers/provider.ts",
    );
    const provider = createMmrSubagentsFeatureGateProvider();
    assert.equal(provider.name, "ampi-subagents");
    assert.equal(provider.name, AMPI_SUBAGENTS_PROVIDER_NAME);
    assert.equal(MMR_SUBAGENTS_PROVIDER_NAME, "mmr-subagents");
  });

  it("claims canonical and legacy subagent gates only", async () => {
    const { createMmrSubagentsFeatureGateProvider, AMPI_SUBAGENTS_FEATURE_GATE, MMR_SUBAGENTS_FEATURE_GATE } = await importSource("extensions/ampi-workers/provider.ts");
    const provider = createMmrSubagentsFeatureGateProvider();
    assert.ok(provider.evaluate(AMPI_SUBAGENTS_FEATURE_GATE));
    assert.ok(provider.evaluate(MMR_SUBAGENTS_FEATURE_GATE));
    for (const other of ["ampi-web", "ampi-history", "ampi-toolbox", "ampi-toolbox-mcp", "totally-unknown"]) {
      assert.equal(provider.evaluate(other), undefined, `must not claim gate ${other}`);
    }
  });

  it("reports the gate as disabled while no worker tools ship", async () => {
    const { createMmrSubagentsFeatureGateProvider, AMPI_SUBAGENTS_FEATURE_GATE } = await importSource(
      "extensions/ampi-workers/provider.ts",
    );
    const provider = createMmrSubagentsFeatureGateProvider();
    const decision = provider.evaluate(AMPI_SUBAGENTS_FEATURE_GATE);
    assert.ok(decision, "must return a decision for its own gate");
    assert.equal(decision.gate, "ampi-subagents");
    assert.equal(decision.status, "disabled");
    assert.match(decision.reason, /worker tools are not yet implemented/);
  });

  it("reports active capabilities including librarian when available", async () => {
    const { createMmrSubagentsFeatureGateProvider, AMPI_SUBAGENTS_FEATURE_GATE } = await importSource(
      "extensions/ampi-workers/provider.ts",
    );
    const provider = createMmrSubagentsFeatureGateProvider({ finder: true, oracle: true, Task: true, librarian: true });
    const decision = provider.evaluate(AMPI_SUBAGENTS_FEATURE_GATE);
    assert.equal(decision.status, "enabled");
    assert.match(decision.reason, /finder/);
    assert.match(decision.reason, /oracle/);
    assert.match(decision.reason, /Task/);
    assert.match(decision.reason, /librarian/);
  });
});

describe("mmr-subagents tool provider", () => {
  it("identifies itself as ampi-subagents while retaining the legacy constant", async () => {
    const { createMmrSubagentsToolProvider, AMPI_SUBAGENTS_PROVIDER_NAME, MMR_SUBAGENTS_PROVIDER_NAME } = await importSource(
      "extensions/ampi-workers/provider.ts",
    );
    const provider = createMmrSubagentsToolProvider();
    assert.equal(provider.name, "ampi-subagents");
    assert.equal(provider.name, AMPI_SUBAGENTS_PROVIDER_NAME);
    assert.equal(MMR_SUBAGENTS_PROVIDER_NAME, "mmr-subagents");
  });

  it("only claims its owned logical tool names", async () => {
    const { createMmrSubagentsToolProvider, MMR_SUBAGENTS_OWNED_TOOLS } = await importSource(
      "extensions/ampi-workers/provider.ts",
    );
    const provider = createMmrSubagentsToolProvider();
    assert.deepEqual(
      [...MMR_SUBAGENTS_OWNED_TOOLS].sort(),
      ["Task", "finder", "librarian", "oracle", "reviewer"],
    );
    for (const unowned of [
      "Read",
      "Bash",
      "Edit",
      "Write",
      "Grep",
      "glob",
      "task_list",
      "apply_patch",
      "web_search",
      "read_web_page",
      "read_session",
      "find_session",
      "skill",
      "totally-unknown",
      "",
    ]) {
      assert.equal(provider.resolve(unowned), undefined, `must not claim ${JSON.stringify(unowned)}`);
    }
  });

  it("returns gated rules keyed to the ampi-subagents gate for inactive owned tools", async () => {
    const { createMmrSubagentsToolProvider, MMR_SUBAGENTS_OWNED_TOOLS, AMPI_SUBAGENTS_FEATURE_GATE } = await importSource(
      "extensions/ampi-workers/provider.ts",
    );
    const provider = createMmrSubagentsToolProvider();
    for (const logical of MMR_SUBAGENTS_OWNED_TOOLS) {
      const rule = provider.resolve(logical);
      assert.ok(rule, `must produce a rule for ${logical}`);
      assert.equal(rule.kind, "gated");
      if (logical === "librarian") {
        assert.equal(rule.gate, AMPI_SUBAGENTS_FEATURE_GATE);
        assert.equal(rule.reason, "librarian: requires ampi-github read-only GitHub tools (set AMPI_GITHUB_ENABLE=true or legacy MMR_GITHUB_ENABLE=true).");
      } else {
        assert.equal(rule.gate, AMPI_SUBAGENTS_FEATURE_GATE);
        assert.match(rule.reason, new RegExp(`${logical}: implementation pending in ampi-subagents`));
      }
    }
  });

  it("returns active rules for shipped capabilities including librarian", async () => {
    const { createMmrSubagentsToolProvider } = await importSource("extensions/ampi-workers/provider.ts");
    const provider = createMmrSubagentsToolProvider({ finder: true, oracle: true, Task: true, librarian: true });
    for (const logical of ["finder", "oracle", "Task", "librarian"]) {
      assert.deepEqual(provider.resolve(logical), { kind: "active" }, `${logical} must resolve active`);
    }
  });
});
