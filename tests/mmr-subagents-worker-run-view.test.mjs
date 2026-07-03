import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const VIEW_MODULE = "extensions/ampi-workers/worker-run-view.ts";

describe("worker-run-view", () => {
  it("classifies background payloads by the pinned branch order: fleet → board → group → spawn → final", async () => {
    const { buildWorkerRunView } = await importSource(VIEW_MODULE);
    const base = { worker: "ampi-workers.async-task" };

    const fleet = buildWorkerRunView({ ...base, fleet: { groups: [] }, board: {}, group: {} });
    assert.equal(fleet.surface, "fleet");
    assert.equal(fleet.gated, true);

    const board = buildWorkerRunView({ ...base, board: { version: 1 }, group: {} });
    assert.equal(board.surface, "board");

    const group = buildWorkerRunView({ ...base, group: { status: "running" }, groupId: "group_abc123" });
    assert.equal(group.surface, "group-control");
    assert.equal(group.groupId, "group_abc123");
    assert.equal(group.gated, false);

    const spawn = buildWorkerRunView({ ...base, tool: "start_task", taskId: "t1" });
    assert.equal(spawn.surface, "spawn");
    assert.equal(spawn.gated, true);
    assert.equal(spawn.groupOpener, false);

    const namedSpawn = buildWorkerRunView({ ...base, backgroundStart: true, taskId: "t2" });
    assert.equal(namedSpawn.surface, "spawn");

    const opener = buildWorkerRunView({ ...base, tool: "start_task", groupId: "g", groupOpener: true });
    assert.equal(opener.groupOpener, true);

    const final = buildWorkerRunView({
      ...base,
      taskId: "t3",
      agent: "finder",
      status: "succeeded",
      final: { usage: { turns: 2 } },
    });
    assert.equal(final.surface, "background-final");
    assert.deepEqual(final.final, { usage: { turns: 2 } });
  });

  it("treats a malformed final snapshot as an empty projection, never a throw", async () => {
    const { buildWorkerRunView } = await importSource(VIEW_MODULE);
    const view = buildWorkerRunView({
      worker: "mmr-subagents.async-task",
      taskId: "t",
      agent: "Task",
      status: "succeeded",
      final: "not-a-record",
    });
    assert.equal(view.surface, "background-final");
    assert.deepEqual(view.final, {});
  });

  it("classifies non-background record details (and undefined) as the blocking surface", async () => {
    const { buildWorkerRunView } = await importSource(VIEW_MODULE);
    const blocking = buildWorkerRunView({ model: "m", usage: { turns: 1 } });
    assert.equal(blocking.surface, "blocking");
    assert.deepEqual(blocking.details, { model: "m", usage: { turns: 1 } });
    assert.equal(buildWorkerRunView(undefined).surface, "blocking");
    assert.equal(buildWorkerRunView("plain text").surface, "plain");
  });

  it("classifies replayed section payloads without a worker discriminator (frozen-details replay contract)", async () => {
    const { buildWorkerRunView } = await importSource(VIEW_MODULE);
    // Older replayed records carry fleet/board/group sections without the
    // worker string; they must still resolve to their section surface.
    assert.equal(buildWorkerRunView({ fleet: { groups: [] } }).surface, "fleet");
    assert.equal(buildWorkerRunView({ board: { version: 1 } }).surface, "board");
    assert.equal(buildWorkerRunView({ group: {}, groupId: "g" }).surface, "group-control");
  });

  it("recognizes both current and legacy background worker discriminators", async () => {
    const { isMmrBackgroundWorkerDetails } = await importSource(VIEW_MODULE);
    assert.equal(isMmrBackgroundWorkerDetails({ worker: "ampi-workers.async-task" }), true);
    assert.equal(isMmrBackgroundWorkerDetails({ worker: "mmr-subagents.async-task" }), true);
    assert.equal(isMmrBackgroundWorkerDetails({ worker: "ampi-custom-subagents.sa__x" }), false);
    assert.equal(isMmrBackgroundWorkerDetails(undefined), false);
  });
});
