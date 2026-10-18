import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

// Expected statuses are written out from the status-line contract (labels,
// hints, busy/attention rules), not computed from the module under test.
const IDLE = { phase: "idle", label: "", detail: "", hint: "", busy: false, queued: 0, attention: false };
const STEER = "Enter to steer";
const STEER_DEQUEUE = "Enter to steer, Backspace to dequeue";
const FORCE_QUIT = "ctrl+c again to force quit";

function expected(fields) {
  return { ...IDLE, ...fields };
}

let createMmrThreadStatusReducer;

before(async () => {
  ({ createMmrThreadStatusReducer } = await importSource("extensions/ampi-core/thread-status.ts"));
});

/** Feed events in order and return a plain copy of the status after each one. */
function run(events, reducer = createMmrThreadStatusReducer()) {
  return events.map((event) => ({ ...reducer.apply(event) }));
}

describe("mmr-core thread status", () => {
  it("starts idle with nothing to show", () => {
    const reducer = createMmrThreadStatusReducer();
    assert.deepEqual({ ...reducer.status }, IDLE);
    assert.ok(Object.isFrozen(reducer.status));
  });

  it("follows a plain text turn from sending through thinking and streaming to idle", () => {
    const statuses = run([
      { type: "turnStart" },
      { type: "messageUpdate", content: "thinking" },
      { type: "messageUpdate", content: "thinking", outputTokens: 12 },
      { type: "messageUpdate", content: "text", outputTokens: 23 },
      { type: "messageUpdate", content: "text" },
      { type: "messageUpdate", content: "text", outputTokens: 1500 },
      { type: "turnEnd" },
      { type: "settled" },
    ]);
    assert.deepEqual(statuses, [
      expected({ phase: "sending", label: "Sending", hint: STEER, busy: true }),
      expected({ phase: "thinking", label: "Thinking", hint: STEER, busy: true }),
      expected({ phase: "thinking", label: "Thinking", detail: "12 tok", hint: STEER, busy: true }),
      expected({ phase: "streaming", label: "Streaming", detail: "23 tok", hint: STEER, busy: true }),
      expected({ phase: "streaming", label: "Streaming", detail: "23 tok", hint: STEER, busy: true }),
      expected({ phase: "streaming", label: "Streaming", detail: "1.5k tok", hint: STEER, busy: true }),
      expected({ phase: "sending", label: "Sending", hint: STEER, busy: true }),
      IDLE,
    ]);
  });

  it("tracks three tools finishing out of order, and a failed tool is not a thread error", () => {
    const statuses = run([
      { type: "turnStart" },
      { type: "messageUpdate", content: "toolCall", outputTokens: 80 },
      { type: "toolStart", toolCallId: "a", toolName: "read" },
      { type: "toolStart", toolCallId: "b", toolName: "bash" },
      { type: "toolStart", toolCallId: "c", toolName: "grep" },
      { type: "toolEnd", toolCallId: "b", outcome: "error" },
      { type: "toolEnd", toolCallId: "a", outcome: "success" },
      { type: "toolEnd", toolCallId: "zz", outcome: "success" },
      { type: "toolEnd", toolCallId: "c", outcome: "cancelled" },
      { type: "turnEnd" },
      { type: "turnStart" },
      { type: "messageUpdate", content: "text" },
      { type: "turnEnd" },
      { type: "settled" },
    ]);
    const tools = (detail) => expected({ phase: "runningTools", label: "Running Tools", detail, hint: STEER, busy: true });
    const sending = expected({ phase: "sending", label: "Sending", hint: STEER, busy: true });
    assert.deepEqual(statuses, [
      sending,
      expected({ phase: "streaming", label: "Streaming", detail: "80 tok", hint: STEER, busy: true }),
      tools("read"),
      tools("read"),
      tools("read"),
      tools("read"),
      tools("grep"),
      tools("grep"),
      sending,
      sending,
      sending,
      expected({ phase: "streaming", label: "Streaming", hint: STEER, busy: true }),
      sending,
      IDLE,
    ]);
  });

  it("clears a tool still marked running when its turn ends", () => {
    const statuses = run([
      { type: "turnStart" },
      { type: "toolStart", toolCallId: "t1", toolName: "bash" },
      { type: "turnEnd" },
      { type: "toolEnd", toolCallId: "t1", outcome: "success" },
      { type: "settled" },
    ]);
    assert.deepEqual(statuses.slice(2), [
      expected({ phase: "sending", label: "Sending", hint: STEER, busy: true }),
      expected({ phase: "sending", label: "Sending", hint: STEER, busy: true }),
      IDLE,
    ]);
  });

  it("shows compaction mid-turn and resumes the interrupted phase afterwards", () => {
    const statuses = run([
      { type: "turnStart" },
      { type: "messageUpdate", content: "text", outputTokens: 40 },
      { type: "compactionStart" },
      { type: "compactionEnd" },
      { type: "toolStart", toolCallId: "t1", toolName: "edit" },
      { type: "compactionStart" },
      { type: "compactionFailed" },
    ]);
    const compacting = expected({ phase: "compacting", label: "Auto-Compacting", hint: STEER, busy: true });
    assert.deepEqual(statuses.slice(1), [
      expected({ phase: "streaming", label: "Streaming", detail: "40 tok", hint: STEER, busy: true }),
      compacting,
      expected({ phase: "streaming", label: "Streaming", detail: "40 tok", hint: STEER, busy: true }),
      expected({ phase: "runningTools", label: "Running Tools", detail: "edit", hint: STEER, busy: true }),
      compacting,
      expected({ phase: "runningTools", label: "Running Tools", detail: "edit", hint: STEER, busy: true }),
    ]);
  });

  it("is busy during a compaction that starts while idle, and idle again after it", () => {
    const statuses = run([{ type: "compactionStart" }, { type: "compactionEnd" }]);
    assert.deepEqual(statuses, [
      expected({ phase: "compacting", label: "Auto-Compacting", hint: STEER, busy: true }),
      IDLE,
    ]);
  });

  it("shows cancelling from an abort until the turn ends, then goes idle", () => {
    const statuses = run([
      { type: "turnStart" },
      { type: "messageUpdate", content: "text", outputTokens: 5 },
      { type: "abort" },
      { type: "messageUpdate", content: "text", outputTokens: 9 },
      { type: "turnEnd" },
      { type: "settled" },
    ]);
    const cancelling = expected({ phase: "cancelling", label: "Cancelling", busy: true });
    assert.deepEqual(statuses.slice(2), [cancelling, cancelling, IDLE, IDLE]);
  });

  it("ignores an abort while idle", () => {
    const reducer = createMmrThreadStatusReducer();
    const before = reducer.status;
    assert.equal(reducer.apply({ type: "abort" }), before);
    assert.deepEqual({ ...reducer.apply({ type: "turnStart" }) }, expected({ phase: "sending", label: "Sending", hint: STEER, busy: true }));
  });

  it("waits for approval with attention, then resumes the running tool", () => {
    const statuses = run([
      { type: "turnStart" },
      { type: "toolStart", toolCallId: "t1", toolName: "bash" },
      { type: "approvalRequest", requestId: "r1" },
      { type: "approvalAnswer", requestId: "r1" },
      { type: "toolEnd", toolCallId: "t1", outcome: "success" },
    ]);
    assert.deepEqual(statuses.slice(2), [
      expected({ phase: "waitingApproval", label: "Waiting for Approval", busy: true, attention: true }),
      expected({ phase: "runningTools", label: "Running Tools", detail: "bash", hint: STEER, busy: true }),
      expected({ phase: "sending", label: "Sending", hint: STEER, busy: true }),
    ]);
  });

  it("keeps the queue count across phases and offers dequeue while something is queued", () => {
    const statuses = run([
      { type: "turnStart" },
      { type: "messageUpdate", content: "text" },
      { type: "queue", count: 2 },
      { type: "turnEnd" },
      { type: "settled" },
      { type: "turnStart" },
      { type: "queue", count: 0 },
    ]);
    assert.deepEqual(statuses.slice(2), [
      expected({ phase: "streaming", label: "Streaming", hint: STEER_DEQUEUE, busy: true, queued: 2 }),
      expected({ phase: "sending", label: "Sending", hint: STEER_DEQUEUE, busy: true, queued: 2 }),
      expected({ queued: 2 }),
      expected({ phase: "sending", label: "Sending", hint: STEER_DEQUEUE, busy: true, queued: 2 }),
      expected({ phase: "sending", label: "Sending", hint: STEER, busy: true }),
    ]);
  });

  it("shows the force-quit hint until its expiry time arrives through tick or any event", () => {
    const idle = run([
      { type: "quitPressed", now: 1_000, expiresAt: 3_000 },
      { type: "tick", now: 2_999 },
      { type: "tick", now: 3_000 },
    ]);
    assert.deepEqual(idle, [expected({ hint: FORCE_QUIT }), expected({ hint: FORCE_QUIT }), IDLE]);

    const busy = run([
      { type: "turnStart" },
      { type: "quitPressed", now: 10_000, expiresAt: 12_000 },
      { type: "messageUpdate", content: "text", now: 11_000 },
      { type: "messageUpdate", content: "text", now: 12_500 },
    ]);
    assert.deepEqual(busy.slice(1), [
      expected({ phase: "sending", label: "Sending", hint: FORCE_QUIT, busy: true }),
      expected({ phase: "streaming", label: "Streaming", hint: FORCE_QUIT, busy: true }),
      expected({ phase: "streaming", label: "Streaming", hint: STEER, busy: true }),
    ]);
  });

  it("keeps an error until the next turn starts", () => {
    const statuses = run([
      { type: "turnStart" },
      { type: "toolStart", toolCallId: "t1", toolName: "bash" },
      { type: "error" },
      { type: "turnEnd" },
      { type: "settled" },
      { type: "abort" },
      { type: "turnStart" },
    ]);
    const error = expected({ phase: "error", label: "Error", attention: true });
    assert.deepEqual(statuses.slice(2), [
      error,
      error,
      error,
      error,
      expected({ phase: "sending", label: "Sending", hint: STEER, busy: true }),
    ]);
  });

  it("returns the previous status object when nothing visible changed", () => {
    const reducer = createMmrThreadStatusReducer();
    const streaming = reducer.apply({ type: "messageUpdate", content: "text" });
    assert.equal(reducer.apply({ type: "messageUpdate", content: "text" }), streaming);
    assert.equal(reducer.apply({ type: "tick", now: 1 }), streaming);
    assert.equal(reducer.status, streaming);
    assert.notEqual(reducer.apply({ type: "queue", count: 1 }), streaming);
  });
});
