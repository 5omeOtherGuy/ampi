import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

const TYPES_MODULE = "extensions/mmr-async-tasks/async-task-types.ts";
const REGISTRY_MODULE = "extensions/mmr-async-tasks/async-task-registry.ts";

after(cleanupLoadedSource);

describe("mmr-async-tasks async-task-types", () => {
  it("classifies exactly the finished group statuses as terminal", async () => {
    const { isTerminalGroupStatus } = await importSource(TYPES_MODULE);

    for (const status of ["completed", "failed", "cancelled", "partial"]) {
      assert.equal(isTerminalGroupStatus(status), true, `${status} should be terminal`);
    }
    // `ready` (declared, not launched) and `running` must both be
    // non-terminal so a freshly declared fleet is never delivered or
    // "settled" before it launches.
    for (const status of ["ready", "running"]) {
      assert.equal(isTerminalGroupStatus(status), false, `${status} should not be terminal`);
    }
  });

  it("keeps the documented timing/cap constant values", async () => {
    const types = await importSource(TYPES_MODULE);

    assert.equal(types.DEFAULT_ASYNC_TASK_MAX_RUNNING_PER_SESSION, 10);
    assert.equal(types.ASYNC_TASK_STALLED_AFTER_MS, 5 * 60_000);
    assert.equal(types.ASYNC_TASK_MAX_RUNTIME_MS, 60 * 60_000);
    assert.equal(types.ASYNC_TASK_CANCEL_DEAD_AFTER_MS, 15_000);
    assert.equal(types.ASYNC_TASK_TERMINAL_TTL_MS, 15 * 60_000);
    assert.equal(types.ASYNC_TASK_OBSERVED_TERMINAL_TTL_MS, 2 * 60_000);
    assert.equal(types.DEFAULT_TASK_WAIT_TIMEOUT_MS, 30_000);
    assert.equal(types.MAX_TASK_WAIT_TIMEOUT_MS, 120_000);
    assert.equal(types.DEFAULT_ASYNC_TASK_MAX_PUSHES_PER_SESSION, 8);
  });

  it("keeps the constants' liveness ordering invariants", async () => {
    const types = await importSource(TYPES_MODULE);

    // A task must be classifiable as stalled well before the watchdog
    // hard-cancels it, and the default wait timeout must respect the cap.
    assert.ok(types.ASYNC_TASK_STALLED_AFTER_MS < types.ASYNC_TASK_MAX_RUNTIME_MS);
    assert.ok(types.DEFAULT_TASK_WAIT_TIMEOUT_MS <= types.MAX_TASK_WAIT_TIMEOUT_MS);
    // An observed terminal record is pruned no later than an unobserved one.
    assert.ok(types.ASYNC_TASK_OBSERVED_TERMINAL_TTL_MS <= types.ASYNC_TASK_TERMINAL_TTL_MS);
  });

  it("re-exports the moved runtime symbols unchanged from async-task-registry", async () => {
    const types = await importSource(TYPES_MODULE);
    const registry = await importSource(REGISTRY_MODULE);

    // `importSource` cache-busts per call, so the two modules are distinct
    // instances: compare values/behavior, not function reference identity.
    const movedConstantExports = [
      "ASYNC_TASK_CANCEL_DEAD_AFTER_MS",
      "ASYNC_TASK_MAX_RUNTIME_MS",
      "ASYNC_TASK_OBSERVED_TERMINAL_TTL_MS",
      "ASYNC_TASK_STALLED_AFTER_MS",
      "ASYNC_TASK_TERMINAL_TTL_MS",
      "DEFAULT_ASYNC_TASK_MAX_PUSHES_PER_SESSION",
      "DEFAULT_ASYNC_TASK_MAX_RUNNING_PER_SESSION",
      "DEFAULT_TASK_WAIT_TIMEOUT_MS",
      "MAX_TASK_WAIT_TIMEOUT_MS",
    ];
    for (const name of movedConstantExports) {
      assert.ok(name in types, `${name} missing from async-task-types`);
      assert.equal(
        registry[name],
        types[name],
        `${name} must keep resolving identically from async-task-registry`,
      );
    }

    assert.equal(typeof registry.isTerminalGroupStatus, "function");
    for (const status of ["ready", "running", "failed", "cancelled", "partial", "completed"]) {
      assert.equal(
        registry.isTerminalGroupStatus(status),
        types.isTerminalGroupStatus(status),
        `isTerminalGroupStatus(${status}) must agree across both import paths`,
      );
    }
  });
});
