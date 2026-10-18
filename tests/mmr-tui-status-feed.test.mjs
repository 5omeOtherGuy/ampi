// The prompt box's status feed: Pi agent events in, ampi-core thread status out.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

let createMmrStatusFeed;

before(async () => {
  ({ createMmrStatusFeed } = await importSource("extensions/ampi-tui/editor/status-feed.ts"));
});

function setup() {
  let time = 0;
  const timers = [];
  const changes = [];
  const mock = createMockPi();
  const context = createMockExtensionContext({ idle: false });
  const feed = createMmrStatusFeed(mock.pi, {
    onChange: (status) => changes.push(status),
    now: () => time,
    setTimer: (callback, ms) => {
      const timer = { callback, at: time + ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  feed.reset(context.ctx);
  const emit = (type, event = {}) => mock.handlers.get(type)({ type, ...event }, context.ctx);
  const view = () => [feed.status.label, feed.status.detail, feed.status.hint];
  return {
    feed,
    emit,
    view,
    changes,
    state: context.state,
    timers,
    advance(ms) {
      time += ms;
      for (const timer of timers) {
        if (!timer.cleared && timer.at <= time) {
          timer.cleared = true;
          timer.callback();
        }
      }
    },
  };
}

const assistant = (usage) => ({ role: "assistant", content: [], usage });
const update = (deltaType, output) => ({
  message: assistant(output === undefined ? undefined : { output }),
  assistantMessageEvent: { type: deltaType },
});

describe("ampi-tui status feed", () => {
  it("follows a turn: sending, thinking with tokens, streaming, a running tool, then idle", () => {
    const t = setup();
    assert.deepEqual(t.view(), ["", "", ""]);
    t.emit("turn_start", { turnIndex: 0, timestamp: 0 });
    assert.deepEqual(t.view(), ["Sending", "", "Enter to steer"]);
    t.emit("message_update", update("thinking_delta", 23));
    assert.deepEqual(t.view(), ["Thinking", "23 tok", "Enter to steer"]);
    t.emit("message_update", update("text_delta", 1500));
    assert.deepEqual(t.view(), ["Streaming", "1.5k tok", "Enter to steer"]);
    t.emit("message_update", update("start"));
    assert.equal(t.feed.status.label, "Streaming", "events without content change nothing");
    t.emit("tool_execution_start", { toolCallId: "c1", toolName: "bash", args: {} });
    assert.deepEqual(t.view(), ["Running Tools", "bash", "Enter to steer"]);
    t.emit("tool_execution_end", { toolCallId: "c1", toolName: "bash", result: {}, isError: true });
    assert.equal(t.feed.status.label, "Sending", "a failed tool does not fail the turn");
    t.emit("turn_end", { message: assistant(), toolResults: [] });
    t.emit("agent_settled", { aborted: false });
    assert.deepEqual(t.view(), ["", "", ""]);
    assert.equal(t.feed.status.busy, false);
  });

  it("reports only visible changes", () => {
    const t = setup();
    t.emit("turn_start");
    t.emit("message_update", update("text_delta"));
    t.emit("message_update", update("text_delta"));
    assert.deepEqual(
      t.changes.map((status) => status.label),
      ["Sending", "Streaming"],
    );
  });

  it("shows compaction over the phase it interrupts, and after a failed one too", () => {
    const t = setup();
    t.emit("turn_start");
    t.emit("session_before_compact", { reason: "threshold" });
    assert.equal(t.feed.status.label, "Auto-Compacting");
    t.emit("session_compact", { reason: "threshold" });
    assert.equal(t.feed.status.label, "Sending");
    t.emit("session_before_compact", { reason: "threshold" });
    t.emit("session_compact_failed", { reason: "threshold", aborted: false });
    assert.equal(t.feed.status.label, "Sending");
  });

  it("shows Error after a failed response until the next turn", () => {
    const t = setup();
    t.emit("turn_start");
    t.emit("turn_end", { message: { ...assistant(), stopReason: "error" }, toolResults: [] });
    t.emit("agent_settled", { aborted: false });
    assert.equal(t.feed.status.label, "Error");
    assert.equal(t.feed.status.attention, true);
    t.emit("turn_start");
    assert.equal(t.feed.status.label, "Sending");
  });

  it("shows Cancelling from the interrupt until the run settles", () => {
    const t = setup();
    t.feed.abort();
    assert.equal(t.feed.status.label, "", "nothing to cancel while idle");
    t.emit("turn_start");
    t.feed.abort();
    assert.equal(t.feed.status.label, "Cancelling");
    t.emit("turn_end", { message: { ...assistant(), stopReason: "aborted" }, toolResults: [] });
    t.emit("agent_settled", { aborted: true });
    assert.equal(t.feed.status.label, "");
  });

  it("counts messages queued while a turn runs, and forgets them once Pi has none", () => {
    const t = setup();
    t.emit("turn_start");
    t.emit("input", { text: "idle prompt", source: "interactive" });
    assert.equal(t.feed.status.queued, 0, "input while idle is no queued message");
    t.emit("input", { text: "also this", source: "interactive", streamingBehavior: "steer" });
    t.emit("input", { text: "and that", source: "interactive", streamingBehavior: "followUp" });
    t.state.pendingMessages = true;
    assert.equal(t.feed.status.queued, 2);
    assert.equal(t.feed.status.hint, "Enter to steer, Backspace to dequeue");
    t.emit("message_start", { message: { role: "user", content: "also this" } });
    assert.equal(t.feed.status.queued, 1);
    t.emit("message_start", { message: assistant() });
    assert.equal(t.feed.status.queued, 1, "assistant messages deliver nothing");
    t.state.pendingMessages = false;
    t.feed.refreshQueue();
    assert.equal(t.feed.status.queued, 0);
    assert.equal(t.feed.status.hint, "Enter to steer");
  });

  it("shows the force-quit hint until the quit chord ends", () => {
    const t = setup();
    t.feed.setQuitHint(1500);
    assert.equal(t.feed.status.hint, "ctrl+c again to force quit");
    t.advance(1499);
    assert.equal(t.feed.status.hint, "ctrl+c again to force quit");
    t.advance(1);
    assert.equal(t.feed.status.hint, "");

    t.feed.setQuitHint(3000);
    t.feed.setQuitHint(undefined);
    assert.equal(t.feed.status.hint, "", "an early end removes it at once");
    assert.ok(t.timers.every((timer) => timer.cleared));
  });

  it("starts over on reset", () => {
    const t = setup();
    t.emit("turn_start");
    t.emit("input", { text: "queued", source: "interactive", streamingBehavior: "steer" });
    t.feed.reset(createMockExtensionContext().ctx);
    assert.deepEqual(t.view(), ["", "", ""]);
    assert.equal(t.feed.status.queued, 0);
  });
});
