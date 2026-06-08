import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

const VIEW_MODULE = "extensions/mmr-subagents/background-task-view.ts";

after(cleanupLoadedSource);

/** Minimal WidgetRow with only the fields revealedRowCount reads. */
function row(createdAtMs) {
  return {
    taskId: `task_${createdAtMs}`,
    status: "running",
    freshness: "healthy",
    agent: "finder",
    description: "",
    runtimeMs: 0,
    createdAtMs,
  };
}

describe("revealedRowCount", () => {
  it("exports the tunable cadence constants", async () => {
    const { SPAWN_SETTLE_MS, REVEAL_INTERVAL_MS } = await importSource(VIEW_MODULE);
    assert.equal(SPAWN_SETTLE_MS, 200);
    assert.equal(REVEAL_INTERVAL_MS, 70);
  });

  it("returns 0 for an empty row-set", async () => {
    const { revealedRowCount } = await importSource(VIEW_MODULE);
    assert.equal(revealedRowCount([], 1_000_000), 0);
  });

  it("returns 0 before the reveal epoch (invisible prep window)", async () => {
    const { revealedRowCount, SPAWN_SETTLE_MS } = await importSource(VIEW_MODULE);
    const rows = [row(100), row(200), row(300)];
    const epoch = 300 + SPAWN_SETTLE_MS;
    assert.equal(revealedRowCount(rows, epoch - 1), 0);
    assert.equal(revealedRowCount(rows, 0), 0);
  });

  it("reveals exactly 1 row at the epoch", async () => {
    const { revealedRowCount, SPAWN_SETTLE_MS } = await importSource(VIEW_MODULE);
    const rows = [row(100), row(200), row(300)];
    const epoch = 300 + SPAWN_SETTLE_MS;
    assert.equal(revealedRowCount(rows, epoch), 1);
  });

  it("reveals one more row per REVEAL_INTERVAL_MS", async () => {
    const { revealedRowCount, SPAWN_SETTLE_MS, REVEAL_INTERVAL_MS } = await importSource(VIEW_MODULE);
    const rows = [row(0), row(0), row(0), row(0)];
    const epoch = 0 + SPAWN_SETTLE_MS;
    assert.equal(revealedRowCount(rows, epoch + REVEAL_INTERVAL_MS - 1), 1);
    assert.equal(revealedRowCount(rows, epoch + REVEAL_INTERVAL_MS), 2);
    assert.equal(revealedRowCount(rows, epoch + 2 * REVEAL_INTERVAL_MS), 3);
    assert.equal(revealedRowCount(rows, epoch + 3 * REVEAL_INTERVAL_MS), 4);
  });

  it("clamps the revealed count to rows.length", async () => {
    const { revealedRowCount, SPAWN_SETTLE_MS, REVEAL_INTERVAL_MS } = await importSource(VIEW_MODULE);
    const rows = [row(0), row(0)];
    const epoch = 0 + SPAWN_SETTLE_MS;
    assert.equal(revealedRowCount(rows, epoch + 100 * REVEAL_INTERVAL_MS), 2);
  });

  it("uses the NEWEST spawn (max createdAtMs) for the epoch", async () => {
    const { revealedRowCount, SPAWN_SETTLE_MS } = await importSource(VIEW_MODULE);
    const rows = [row(0), row(500), row(50)];
    const epoch = 500 + SPAWN_SETTLE_MS;
    assert.equal(revealedRowCount(rows, epoch - 1), 0);
    assert.equal(revealedRowCount(rows, epoch), 1);
  });

  it("reveals in lockstep for two row-sets sharing the same max createdAtMs", async () => {
    const { revealedRowCount, SPAWN_SETTLE_MS, REVEAL_INTERVAL_MS } = await importSource(VIEW_MODULE);
    const groupA = [row(10), row(40), row(100)];
    const groupB = [row(20), row(70), row(100)];
    const epoch = 100 + SPAWN_SETTLE_MS;
    for (const offset of [0, REVEAL_INTERVAL_MS, 2 * REVEAL_INTERVAL_MS, 5 * REVEAL_INTERVAL_MS]) {
      const now = epoch + offset;
      assert.equal(
        revealedRowCount(groupA, now),
        revealedRowCount(groupB, now),
        `lockstep at offset ${offset}`,
      );
    }
  });
});
