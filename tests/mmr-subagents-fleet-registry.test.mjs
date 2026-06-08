import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

const REGISTRY_MODULE = "extensions/mmr-subagents/async-task-registry.ts";

after(cleanupLoadedSource);

function makeWorkerResult(overrides = {}) {
  return {
    messages: [],
    finalOutput: "ok",
    truncatedFinalOutput: "ok",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 1, turns: 1 },
    prompt: "",
    cwd: "",
    command: "pi",
    args: [],
    exitCode: 0,
    signal: null,
    stderr: "",
    aborted: false,
    outputTruncated: false,
    ignoredJsonLines: 0,
    agentStarted: true,
    trail: [],
    ...overrides,
  };
}

function makeDeferredRun() {
  let resolveFn;
  const captured = { calls: 0 };
  const run = ({ signal, onProgress }) => {
    captured.calls += 1;
    captured.signal = signal;
    captured.onProgress = onProgress;
    return new Promise((resolve) => {
      resolveFn = resolve;
    });
  };
  return { run, captured, resolve: (r) => resolveFn(r) };
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function startArgs(overrides = {}) {
  return {
    sessionKey: "sess-A",
    originToolCallId: overrides.originToolCallId ?? "call-1",
    description: "do a thing",
    prompt: "prompt body",
    cwd: "/repo",
    resolvedModel: "prov/model",
    workerTools: ["read"],
    deliveryOptIn: false,
    ...overrides,
  };
}

function idCounter(prefix) {
  let n = 0;
  return () => `${prefix}_${++n}`;
}

describe("async-task-registry ready lifecycle (fleet)", () => {
  it("manual launchMode creates a ready task without invoking run", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let clock = 1000;
    const reg = createMmrAsyncTaskRegistry({ nowMs: () => clock, idFactory: () => "task_r" });
    const d = makeDeferredRun();
    const started = reg.startTask(startArgs({ run: d.run, launchMode: "manual" }));
    assert.equal(started.ok, true);
    assert.equal(started.snapshot.status, "ready");
    await flush();
    assert.equal(d.captured.calls, 0, "run thunk must not fire before launch");
    assert.equal(d.captured.signal, undefined);
  });

  it("lists a ready task in the active bucket with runtime 0 (no wall tick)", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let clock = 1000;
    const reg = createMmrAsyncTaskRegistry({ nowMs: () => clock, idFactory: () => "task_r" });
    const d = makeDeferredRun();
    reg.startTask(startArgs({ run: d.run, launchMode: "manual" }));
    clock = 50_000; // a ready task must not accrue elapsed time
    const board = reg.listTasks("sess-A");
    assert.equal(board.active.length, 1);
    assert.equal(board.active[0].status, "ready");
    assert.equal(board.active[0].runtimeMs, 0);
    assert.equal(board.active[0].freshness, "healthy", "a ready task is never stalled by wall time");
  });

  it("snapshots an all-ready group as ready with a 0/N settled counter", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let clock = 1000;
    const reg = createMmrAsyncTaskRegistry({
      nowMs: () => clock,
      idFactory: idCounter("task"),
      groupIdFactory: () => "group_aaa111",
    });
    const g = reg.openGroup({ sessionKey: "sess-A", deliveryOptIn: true });
    for (let i = 0; i < 3; i++) {
      reg.startTask(startArgs({
        run: makeDeferredRun().run,
        launchMode: "manual",
        groupId: g.groupId,
        originToolCallId: `call-${i}`,
        deliveryOptIn: false,
      }));
    }
    const snap = reg.getGroup("sess-A", g.groupId);
    assert.equal(snap.status, "ready");
    assert.equal(snap.counts.total, 3);
    const settled = snap.counts.succeeded + snap.counts.failed + snap.counts.cancelled + snap.counts.partial;
    assert.equal(settled, 0, "no member has settled");
  });

  it("launchTask flips ready -> running, invokes run once, and stamps startedAt", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let clock = 1000;
    const reg = createMmrAsyncTaskRegistry({ nowMs: () => clock, idFactory: () => "task_r" });
    const d = makeDeferredRun();
    reg.startTask(startArgs({ run: d.run, launchMode: "manual" }));
    clock = 5000;
    const launched = reg.launchTask("sess-A", "task_r");
    assert.equal(launched.status, "running");
    assert.equal(launched.startedAtMs, 5000, "startedAt is the launch time, not the declare time");
    await flush();
    assert.equal(d.captured.calls, 1, "run fires exactly once on launch");
    assert.ok(d.captured.signal, "run receives an abort signal");
    // Idempotent: launching again does not re-run.
    reg.launchTask("sess-A", "task_r");
    await flush();
    assert.equal(d.captured.calls, 1, "a second launch is a no-op");
  });

  it("a launched fleet that all succeed snapshots the group as completed", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let clock = 1000;
    const reg = createMmrAsyncTaskRegistry({
      nowMs: () => clock,
      idFactory: idCounter("task"),
      groupIdFactory: () => "group_bbb222",
    });
    const g = reg.openGroup({ sessionKey: "sess-A", deliveryOptIn: true });
    const runs = [makeDeferredRun(), makeDeferredRun()];
    const ids = [];
    for (let i = 0; i < runs.length; i++) {
      const s = reg.startTask(startArgs({
        run: runs[i].run,
        launchMode: "manual",
        groupId: g.groupId,
        originToolCallId: `call-${i}`,
        deliveryOptIn: false,
      }));
      ids.push(s.snapshot.taskId);
    }
    assert.equal(reg.getGroup("sess-A", g.groupId).status, "ready");
    for (const id of ids) reg.launchTask("sess-A", id);
    assert.equal(reg.getGroup("sess-A", g.groupId).status, "running");
    for (const r of runs) r.resolve(makeWorkerResult());
    await flush();
    assert.equal(reg.getGroup("sess-A", g.groupId).status, "completed");
  });

  it("cancelling a ready task marks it cancelled and never invokes run", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let clock = 1000;
    const reg = createMmrAsyncTaskRegistry({ nowMs: () => clock, idFactory: () => "task_r" });
    const d = makeDeferredRun();
    reg.startTask(startArgs({ run: d.run, launchMode: "manual" }));
    const snap = await reg.cancelTask({ sessionKey: "sess-A", taskId: "task_r" });
    assert.equal(snap.status, "cancelled");
    await flush();
    assert.equal(d.captured.calls, 0, "a cancelled ready task never runs");
  });

  it("immediate launchMode (default) still runs right away", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let clock = 1000;
    const reg = createMmrAsyncTaskRegistry({ nowMs: () => clock, idFactory: () => "task_i" });
    const d = makeDeferredRun();
    const started = reg.startTask(startArgs({ run: d.run }));
    assert.equal(started.snapshot.status, "running");
    await flush();
    assert.equal(d.captured.calls, 1, "immediate start runs without an explicit launch");
  });
});
