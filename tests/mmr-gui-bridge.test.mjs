// ampi-gui live bridge: Pi events in, numbered client events out, and the
// transcript snapshot that joins the saved branch with the running turn.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const loadBridge = () => importSource("extensions/ampi-gui/bridge.ts");
const loadViewModel = () => importSource("extensions/ampi-gui/view-model.ts");

const user = (text, timestamp) => ({ role: "user", content: [{ type: "text", text }], timestamp });
const assistant = (content, timestamp, extra = {}) => ({ role: "assistant", content, timestamp, stopReason: "stop", ...extra });
const toolResult = (toolCallId, text, isError = false) => ({
  role: "toolResult",
  toolCallId,
  toolName: "bash",
  content: [{ type: "text", text }],
  isError,
  timestamp: 0,
});
const entry = (id, message) => ({ type: "message", id, message });

async function setup({ entries = [], sessionName } = {}) {
  const { createMmrGuiBridge } = await loadBridge();
  const { pi, handlers } = createMockPi();
  const { ctx } = createMockExtensionContext({ entries, cwd: "/work/app", sessionId: "s-1", sessionName });
  const bridge = createMmrGuiBridge(pi, { now: () => 1000, home: "/home/u" });
  const events = [];
  const fire = (name, event) => handlers.get(name)?.({ type: name, ...event }, ctx);
  return { bridge, ctx, events, fire, entries };
}

describe("ampi-gui bridge", () => {
  it("ignores Pi events until it is started", async () => {
    const { bridge, fire } = await setup();
    fire("turn_start", {});
    fire("message_start", { message: user("hi", 1) });
    assert.equal(bridge.lastEventId, 0);
  });

  it("mirrors a streamed turn: status, user item, assistant item, text deltas and the end of the turn", async () => {
    const { bridge, ctx, fire } = await setup();
    bridge.start(ctx);
    const seen = [];
    bridge.subscribe((event) => seen.push(event));

    fire("turn_start", {});
    fire("message_start", { message: user("Explain the plan", 10) });
    const partial = assistant([{ type: "text", text: "" }], 20);
    fire("message_start", { message: partial });
    fire("message_update", { message: partial, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    const grown = assistant([{ type: "text", text: "Hello **world**" }], 20);
    fire("message_update", { message: grown, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello **world**" } });
    fire("message_end", { message: grown });
    fire("turn_end", { turnIndex: 0, message: grown });
    fire("agent_settled", {});

    const kinds = seen.map((event) => event.event);
    // Every delta also moves the streamed-token count in the status; a turn
    // that ends leaves the thread sending until Pi settles.
    assert.deepEqual(kinds, ["status", "item", "session", "item", "status", "item", "status", "delta", "item", "status", "turn_end", "status"]);
    assert.deepEqual(
      seen.map((event) => event.id),
      seen.map((_e, i) => i + 1),
      "ids count up from 1",
    );
    assert.equal(seen[0].data.phase, "sending");
    assert.equal(seen[0].data.busy, true);
    assert.deepEqual(seen[1].data, { type: "user", id: "u10", text: "Explain the plan", images: 0, timestamp: 10 });
    assert.equal(seen[2].data.title, "Explain the plan", "the first prompt names an unnamed session");
    assert.equal(seen[4].data.label, "Streaming");
    assert.equal(seen[6].data.detail, "4 tok", "15 bytes streamed, four to a token");
    assert.deepEqual(seen[7].data, { itemId: "a20", part: 0, text: "Hello **world**" });
    assert.deepEqual(seen[8].data.parts, [{ type: "text", text: "Hello **world**" }]);
    assert.equal(seen.at(-1).data.phase, "idle");
    assert.equal(seen.at(-1).data.busy, false);
  });

  it("never sends streamed text twice when Pi's partial message runs ahead of its events", async () => {
    const { bridge, ctx, fire } = await setup();
    bridge.start(ctx);
    const seen = [];
    bridge.subscribe((event) => seen.push(event));
    // Pi hands each event a shallow copy of one partial message whose blocks
    // the provider has already filled further. Here the whole reply is in the
    // partial before the first event is handled.
    const partial = assistant([], 20);
    partial.content.push({ type: "thinking", thinking: "Plan it." }, { type: "text", text: "Hello world" });
    const update = (assistantMessageEvent) => fire("message_update", { message: { ...partial }, assistantMessageEvent });
    fire("turn_start", {});
    fire("message_start", { message: { ...partial } });
    update({ type: "thinking_start", contentIndex: 0 });
    update({ type: "thinking_delta", contentIndex: 0, delta: "Plan " });
    const midway = bridge.snapshot();
    update({ type: "thinking_delta", contentIndex: 0, delta: "it." });
    update({ type: "thinking_end", contentIndex: 0, content: "Plan it." });
    update({ type: "text_start", contentIndex: 1 });
    update({ type: "text_delta", contentIndex: 1, delta: "Hello " });
    update({ type: "text_delta", contentIndex: 1, delta: "world" });

    // The client: an item replaces the whole item, a delta appends to its part.
    const replay = (items, events) => {
      for (const { event, data } of events) {
        if (event === "item") items.set(data.id, structuredClone(data));
        if (event === "delta") items.get(data.itemId).parts[data.part].text += data.text;
      }
      return items.get("a20").parts.map((part) => part.text);
    };
    assert.deepEqual(replay(new Map(), seen), ["Plan it.", "Hello world"], "from the first event");
    const fromSnapshot = new Map(midway.items.map((item) => [item.id, structuredClone(item)]));
    assert.deepEqual(midway.items.at(-1).parts, [{ type: "thinking", text: "Plan " }], "the snapshot holds only what its events described");
    assert.deepEqual(replay(fromSnapshot, bridge.eventsAfter(midway.lastEventId)), ["Plan it.", "Hello world"], "from a snapshot taken mid-stream");

    fire("message_end", { message: { ...partial } });
    assert.deepEqual(
      seen.at(-1).data.parts.map((part) => part.text),
      ["Plan it.", "Hello world"],
      "the finished message replaces the streamed copy",
    );
  });

  it("lets an interrupted message, which Pi ends with a new timestamp, take the streamed copy's place", async () => {
    const { bridge, ctx, fire } = await setup();
    bridge.start(ctx);
    const seen = [];
    bridge.subscribe((event) => seen.push(event));
    fire("turn_start", {});
    fire("message_start", { message: user("explain", 10) });
    const partial = assistant([{ type: "text", text: "Half a" }], 20);
    fire("message_start", { message: partial });
    fire("message_update", { message: partial, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    fire("message_update", { message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Half a" } });
    const aborted = assistant([{ type: "text", text: "Half a" }], 35, { stopReason: "aborted" });
    fire("message_end", { message: aborted });
    const end = seen.at(-1);
    assert.equal(end.event, "item");
    assert.equal(end.data.id, "a35");
    assert.equal(end.data.replaces, "a20");
    assert.deepEqual(
      bridge.snapshot().items.map((item) => item.id),
      ["u10", "a35"],
      "the snapshot holds the message once",
    );
    // A message that ends with its own id replaces nothing.
    fire("message_start", { message: assistant([], 50) });
    fire("message_end", { message: assistant([{ type: "text", text: "done" }], 50) });
    assert.equal(seen.at(-1).data.replaces, undefined);
  });

  it("labels tool calls with activity words and follows them from start to result", async () => {
    const { bridge, ctx, fire } = await setup();
    bridge.start(ctx);
    const seen = [];
    bridge.subscribe((event) => seen.push(event));
    fire("turn_start", {});
    const call = { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test" } };
    const message = assistant([call], 30, { stopReason: "toolUse" });
    fire("message_start", { message });
    fire("message_end", { message });
    fire("tool_execution_start", { toolCallId: "call-1", toolName: "bash", args: call.arguments });
    fire("tool_execution_end", { toolCallId: "call-1", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "1 failing\n\nCommand exited with code 1" }] } });

    const tools = seen.filter((event) => event.event === "tool");
    assert.equal(tools.length, 2);
    assert.equal(tools[0].data.itemId, "a30");
    assert.equal(tools[0].data.part.status, "running");
    assert.equal(tools[0].data.part.title.map((part) => part.text).join(""), "Running npm test");
    assert.equal(tools[1].data.part.status, "error");
    assert.equal(tools[1].data.part.title.map((part) => part.text).join(""), "Ran npm test (exit code: 1)");
    assert.match(tools[1].data.part.output, /1 failing/);
    const running = seen.find((event) => event.event === "status" && event.data.phase === "runningTools");
    assert.ok(running, "the status shows the running tool");
  });

  it("snapshots the saved branch plus the messages Pi has not written yet, without repeats", async () => {
    const saved = [
      entry("e1", user("first", 1)),
      entry("e2", assistant([{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/work/app/src/a.ts" } }], 2, { stopReason: "toolUse" })),
      entry("e3", toolResult("c1", "line one\nline two")),
      entry("e4", assistant([{ type: "text", text: "Done." }], 3)),
    ];
    const { bridge, ctx, fire, entries } = await setup({ entries: saved });
    bridge.start(ctx);
    fire("turn_start", {});
    fire("message_start", { message: user("second", 4) });
    // Pi writes the user message, then streams the reply.
    entries.push(entry("e5", user("second", 4)));
    const streaming = assistant([{ type: "text", text: "Work" }], 5);
    fire("message_start", { message: streaming });
    fire("message_update", { message: streaming, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    fire("message_update", { message: streaming, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Work" } });

    const snapshot = bridge.snapshot();
    assert.deepEqual(
      snapshot.items.map((item) => item.id),
      ["u1", "a2", "a3", "u4", "a5"],
    );
    const read = snapshot.items[1].parts[0];
    assert.equal(read.status, "done");
    assert.equal(read.title.map((part) => part.text).join(""), "Read src/a.ts");
    assert.equal(snapshot.items[4].parts[0].text, "Work");
    assert.equal(snapshot.lastEventId, bridge.lastEventId);
    assert.equal(snapshot.status.busy, true);
    assert.deepEqual(snapshot.session, { id: "s-1", title: "first", cwd: "/work/app", mode: null, model: null });
  });

  it("shows calls without a result as cancelled once the run has ended", async () => {
    const saved = [entry("e1", assistant([{ type: "toolCall", id: "c9", name: "bash", arguments: { command: "sleep 60" } }], 2, { stopReason: "toolUse" }))];
    const { bridge, ctx } = await setup({ entries: saved });
    bridge.start(ctx);
    assert.equal(bridge.snapshot().items[0].parts[0].status, "cancelled");
  });

  it("replays buffered events after an id, and asks for a fresh snapshot when they are gone", async () => {
    const { createMmrGuiBridge } = await loadBridge();
    const { pi, handlers } = createMockPi();
    const { ctx } = createMockExtensionContext({ sessionId: "s" });
    const bridge = createMmrGuiBridge(pi, { replayLimit: 3, now: () => 0 });
    bridge.start(ctx);
    for (let i = 0; i < 5; i++) handlers.get("session_info_changed")({ type: "session_info_changed", name: `n${i}` }, ctx);
    assert.equal(bridge.lastEventId, 5);
    assert.deepEqual(
      bridge.eventsAfter(3).map((event) => event.id),
      [4, 5],
    );
    assert.deepEqual(bridge.eventsAfter(5), []);
    assert.deepEqual(
      bridge.eventsAfter(2).map((event) => event.id),
      [3, 4, 5],
      "the oldest buffered event is still reachable",
    );
    assert.equal(bridge.eventsAfter(1), undefined, "event 2 has left the buffer");
    assert.equal(bridge.eventsAfter(9), undefined, "an id from another server");
  });

  it("counts messages queued while a turn runs", async () => {
    const { bridge, ctx, fire } = await setup();
    bridge.start(ctx);
    fire("turn_start", {});
    fire("input", { text: "also this", source: "interactive", streamingBehavior: "steer" });
    assert.equal(bridge.status().queued, 1);
    fire("message_start", { message: user("also this", 50) });
    assert.equal(bridge.status().queued, 0);
  });

  it("mirrors the queue ampi-core's seam publishes, texts and count, and forgets it when the owner leaves", async () => {
    const { registerMmrPromptQueue } = await importSource("extensions/ampi-core/prompt-queue.ts");
    const { bridge, ctx, fire } = await setup();
    bridge.start(ctx);
    assert.equal(bridge.snapshot().queue, null, "no owner: the texts are unknown");
    const seen = [];
    bridge.subscribe((event) => seen.push(event));
    const owner = registerMmrPromptQueue({ remove: () => false });
    try {
      fire("turn_start", {});
      owner.update({ steering: ["now"], followUp: ["later", "after that"] });
      assert.deepEqual(seen.at(-1), { id: bridge.lastEventId, event: "queue", data: { steering: ["now"], followUp: ["later", "after that"] } });
      assert.equal(bridge.status().queued, 3);
      // The published queue is the count; input events no longer add to it.
      fire("input", { text: "more", source: "interactive", streamingBehavior: "followUp" });
      assert.equal(bridge.status().queued, 3);
      assert.deepEqual(bridge.snapshot().queue, { steering: ["now"], followUp: ["later", "after that"] });
    } finally {
      owner.release();
    }
    assert.equal(seen.at(-1).event, "queue");
    assert.equal(seen.at(-1).data, null);
    assert.equal(bridge.snapshot().queue, null);
  });

  it("shows an interruption the user asked for as cancelling", async () => {
    const { bridge, ctx, fire } = await setup();
    bridge.start(ctx);
    assert.equal(bridge.context(), ctx);
    fire("turn_start", {});
    bridge.interrupted();
    assert.equal(bridge.status().phase, "cancelling");
    bridge.stop();
    assert.equal(bridge.context(), undefined);
  });
});

describe("ampi-gui view model", () => {
  it("keeps the assistant's content in order and counts images in user messages", async () => {
    const { buildMmrGuiTranscript } = await loadViewModel();
    const items = buildMmrGuiTranscript([
      entry("e1", { role: "user", content: [{ type: "text", text: "see" }, { type: "image", data: "", mimeType: "image/png" }], timestamp: 1 }),
      entry("e2", assistant([{ type: "thinking", thinking: "hmm" }, { type: "text", text: "ok" }], 2)),
      { type: "compaction", id: "e3" },
    ]);
    assert.deepEqual(items, [
      { type: "user", id: "u1", timestamp: 1, text: "see", images: 1 },
      { type: "assistant", id: "a2", timestamp: 2, parts: [{ type: "thinking", text: "hmm" }, { type: "text", text: "ok" }] },
    ]);
  });

  it("cuts long tool output and reports the error of a failed response", async () => {
    const { buildMmrGuiItem, MMR_GUI_OUTPUT_LIMIT } = await loadViewModel();
    const results = new Map([["c1", { content: [{ type: "text", text: "x".repeat(MMR_GUI_OUTPUT_LIMIT + 5) }], isError: false }]]);
    const item = buildMmrGuiItem(
      assistant([{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "yes" } }], 7, { stopReason: "error", errorMessage: "Overloaded" }),
      results,
    );
    assert.equal(item.parts[0].output.length, MMR_GUI_OUTPUT_LIMIT);
    assert.equal(item.parts[0].outputTruncated, true);
    assert.equal(item.stopReason, "error");
    assert.equal(item.error, "Overloaded");
  });

  it("titles a session by its name, else by its first prompt", async () => {
    const { mmrGuiSessionTitle } = await loadViewModel();
    assert.equal(mmrGuiSessionTitle("  Named  ", []), "Named");
    assert.equal(mmrGuiSessionTitle(undefined, [{ type: "user", id: "u1", text: "\nfix the build\nplease", images: 0, timestamp: 1 }]), "fix the build");
    assert.equal(mmrGuiSessionTitle(undefined, []), "New thread");
  });
});
