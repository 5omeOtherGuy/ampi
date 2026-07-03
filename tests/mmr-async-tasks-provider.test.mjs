import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

describe("mmr-async-tasks provider", () => {
  it("identifies itself as ampi-async-tasks while retaining the legacy constant", async () => {
    const { createMmrAsyncTasksToolProvider, AMPI_ASYNC_TASKS_PROVIDER_NAME, MMR_ASYNC_TASKS_PROVIDER_NAME } = await importSource(
      "extensions/ampi-workers/provider.ts",
    );
    const provider = createMmrAsyncTasksToolProvider();
    assert.equal(provider.name, "ampi-async-tasks");
    assert.equal(provider.name, AMPI_ASYNC_TASKS_PROVIDER_NAME);
    assert.equal(MMR_ASYNC_TASKS_PROVIDER_NAME, "mmr-async-tasks");
  });

  it("gates and activates the async background task tools behind ampi-async-tasks", async () => {
    const {
      createMmrAsyncTasksFeatureGateProvider,
      createMmrAsyncTasksToolProvider,
      AMPI_ASYNC_TASKS_FEATURE_GATE,
      MMR_ASYNC_TASKS_FEATURE_GATE,
      MMR_ASYNC_TASK_TOOLS,
    } = await importSource("extensions/ampi-workers/provider.ts");

    const inactive = createMmrAsyncTasksToolProvider();
    for (const logical of MMR_ASYNC_TASK_TOOLS) {
      const rule = inactive.resolve(logical);
      assert.equal(rule.kind, "gated");
      assert.equal(rule.gate, AMPI_ASYNC_TASKS_FEATURE_GATE);
    }
    assert.equal(inactive.resolve("finder"), undefined);

    const active = createMmrAsyncTasksToolProvider({ asyncTasks: true });
    for (const logical of MMR_ASYNC_TASK_TOOLS) {
      assert.deepEqual(active.resolve(logical), { kind: "active" }, `${logical} must resolve active when enabled`);
    }

    const gate = createMmrAsyncTasksFeatureGateProvider({ asyncTasks: true });
    const disabledGate = createMmrAsyncTasksFeatureGateProvider();
    // Canonical and legacy gate ids must stay behaviorally equivalent.
    for (const gateId of [AMPI_ASYNC_TASKS_FEATURE_GATE, MMR_ASYNC_TASKS_FEATURE_GATE]) {
      assert.equal(gate.evaluate(gateId).status, "enabled", `${gateId} must enable when asyncTasks is on`);
      assert.equal(disabledGate.evaluate(gateId).status, "disabled", `${gateId} must report disabled when asyncTasks is off`);
    }
  });

  it("retains the deprecated mmr-subagents.async-tasks gate as compatibility", async () => {
    const {
      createMmrAsyncTasksFeatureGateProvider,
      MMR_SUBAGENTS_ASYNC_TASKS_FEATURE_GATE,
      MMR_SUBAGENTS_ASYNC_TASK_TOOLS,
      MMR_ASYNC_TASK_TOOLS,
    } = await importSource("extensions/ampi-workers/provider.ts");
    assert.deepEqual([...MMR_SUBAGENTS_ASYNC_TASK_TOOLS], [...MMR_ASYNC_TASK_TOOLS]);
    const decision = createMmrAsyncTasksFeatureGateProvider({ asyncTasks: true }).evaluate(MMR_SUBAGENTS_ASYNC_TASKS_FEATURE_GATE);
    assert.equal(decision.status, "enabled");
  });
});
