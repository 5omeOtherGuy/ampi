// Groups of consecutive tool calls: the store that folds a run of calls into
// one transcript group, fed with hand-written event sequences.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const load = () => importSource("extensions/ampi-tui/transcript/activity-groups.ts");

const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const text = (value) => ({ type: "text", text: value });
const thinking = (value) => ({ type: "thinking", thinking: value });
const assistant = (content, stopReason = "toolUse") => ({ role: "assistant", content, stopReason });
const user = (value) => ({ role: "user", content: [text(value)] });
const output = (value, details) => ({ content: [{ type: "text", text: value }], details });

const read = (id, path = "src/a.ts") => call(id, "read", { path });
const bash = (id, command = "npm test") => call(id, "bash", { command });
const grep = (id, pattern = "retries") => call(id, "grep", { pattern });
const edit = (id, path = "src/a.ts") => call(id, "edit", { path, edits: [{ oldText: "a", newText: "b\nc" }] });

/** Stream an assistant message the way Pi reports it: start, one update per block, end. */
function stream(store, message) {
  store.messageStart({ ...message, content: [] });
  for (let i = 1; i <= message.content.length; i++) store.messageUpdate({ ...message, content: message.content.slice(0, i) });
  store.messageEnd(message);
}

/** Run every call of a message to the end, in order, each with an "ok" result. */
function runAll(store, message, results = {}) {
  for (const block of message.content.filter((b) => b.type === "toolCall")) {
    store.toolStart(block.id, block.name, block.arguments);
    const [result, isError] = results[block.id] ?? [output("ok"), false];
    store.toolEnd(block.id, result, isError);
  }
}

function turn(store, message, results) {
  stream(store, message);
  runAll(store, message, results);
}

/** The groups as lists of call ids, in transcript order; calls that stand alone are left out. */
function groupIds(store, ids) {
  const groups = [];
  for (const id of ids) {
    const position = store.lookup(id);
    if (!position) continue;
    if (position.index === 0) groups.push([]);
    groups.at(-1).push(id);
  }
  return groups;
}

function summaryOf(store, id) {
  return store.aggregate(store.lookup(id).group);
}

describe("ampi-tui activity groups: boundaries", () => {
  it("folds a plain run of three calls into one group with its summary", async () => {
    const { ActivityGroupStore } = await load();
    const store = new ActivityGroupStore();
    turn(store, assistant([read("r1"), bash("b1"), grep("g1")]));
    assert.deepEqual(groupIds(store, ["r1", "b1", "g1"]), [["r1", "b1", "g1"]]);
    assert.equal(store.lookup("b1").index, 1);
    const aggregate = summaryOf(store, "r1");
    assert.equal(aggregate.summary, "Read 1 file, ran 1 command, ran 1 search");
    assert.equal(aggregate.status, "done");
    assert.equal(aggregate.live, false);
    assert.deepEqual(
      aggregate.entries.map((entry) => [entry.activity.kind, entry.status]),
      [["read", "done"], ["command", "done"], ["search", "done"]],
    );
  });

  it("joins calls of several assistant messages and ends the run at a message with text", async () => {
    const { ActivityGroupStore } = await load();
    const store = new ActivityGroupStore();
    turn(store, assistant([read("r1")]));
    turn(store, assistant([bash("b1"), bash("b2")]));
    // Pi draws a message's text above all of its calls, so the text splits before e1.
    turn(store, assistant([edit("e1"), text("Now the fix.")]));
    turn(store, assistant([grep("g1")]));
    assert.deepEqual(groupIds(store, ["r1", "b1", "b2", "e1", "g1"]), [["r1", "b1", "b2"], ["e1", "g1"]]);
    assert.equal(summaryOf(store, "e1").summary, "Edited 1 file (+2 -1), ran 1 search");
  });

  it("keeps a run going across thinking and across whitespace-only text", async () => {
    const { ActivityGroupStore } = await load();
    const store = new ActivityGroupStore();
    turn(store, assistant([thinking("Look first."), read("r1")]));
    turn(store, assistant([thinking("Then run it."), text("  \n"), bash("b1")]));
    assert.deepEqual(groupIds(store, ["r1", "b1"]), [["r1", "b1"]]);
  });

  it("ends a run at a user or steered message and at a custom message that is shown", async () => {
    const { ActivityGroupStore } = await load();
    const store = new ActivityGroupStore();
    turn(store, assistant([read("r1")]));
    store.messageStart(user("also check the docs"));
    turn(store, assistant([read("r2")]));
    store.messageStart({ role: "custom", display: false, content: "hidden" });
    turn(store, assistant([read("r3")]));
    store.messageStart({ role: "custom", display: true, content: "shown" });
    turn(store, assistant([read("r4")]));
    assert.deepEqual(groupIds(store, ["r1", "r2", "r3", "r4"]), [["r1"], ["r2", "r3"], ["r4"]]);
  });

  it("lets a subagent call stand alone and split the run around it", async () => {
    const { ActivityGroupStore } = await load();
    const store = new ActivityGroupStore();
    turn(store, assistant([read("r1"), call("o1", "oracle", { task: "Review" }), read("r2"), call("m1", "mcp__docs__search", { query: "x" })]));
    assert.equal(store.lookup("o1"), undefined);
    assert.deepEqual(groupIds(store, ["r1", "o1", "r2", "m1"]), [["r1"], ["r2", "m1"]]);
    assert.equal(summaryOf(store, "r2").summary, "Read 1 file, ran 1 tool");
  });

  it("makes a group of one call", async () => {
    const { ActivityGroupStore } = await load();
    const store = new ActivityGroupStore();
    turn(store, assistant([bash("b1")]));
    const position = store.lookup("b1");
    assert.equal(position.index, 0);
    assert.equal(position.group.calls.length, 1);
    assert.equal(summaryOf(store, "b1").summary, "Ran 1 command");
  });
});

describe("ampi-tui activity groups: status", () => {
  it("keeps the group done when a call failed; only the call carries the error", async () => {
    const { ActivityGroupStore } = await load();
    const store = new ActivityGroupStore();
    turn(store, assistant([bash("b1"), bash("b2", "npm run lint")]), {
      b2: [output("lint failed\n\nCommand exited with code 1"), true],
    });
    const aggregate = summaryOf(store, "b1");
    assert.equal(aggregate.status, "done");
    assert.deepEqual(aggregate.entries.map((entry) => entry.status), ["done", "error"]);
    assert.equal(aggregate.entries[1].activity.exitCode, 1);
    assert.equal(aggregate.summary, "Ran 2 commands");
  });

  it("marks the group cancelled when a call was cancelled and counts it in the summary", async () => {
    const { ActivityGroupStore } = await load();
    const store = new ActivityGroupStore();
    turn(store, assistant([read("r1"), bash("b1")]), { b1: [output("Command aborted"), true] });
    const aggregate = summaryOf(store, "r1");
    assert.equal(aggregate.status, "cancelled");
    assert.equal(aggregate.summary, "Read 1 file, ran 1 command (1 cancelled)");
  });

  it("runs until the last of several calls finishes, whatever their order", async () => {
    const { ActivityGroupStore } = await load();
    const store = new ActivityGroupStore();
    const message = assistant([read("r1"), bash("b1"), grep("g1")]);
    stream(store, message);
    const before = summaryOf(store, "r1");
    assert.equal(before.status, "running");
    assert.equal(before.live, false, "calls whose arguments stream are not running yet");
    for (const block of message.content) store.toolStart(block.id, block.name, block.arguments);
    assert.equal(summaryOf(store, "r1").summary, "Reading 1 file, running 1 command, running 1 search");
    store.toolEnd("g1", output("src/a.ts:1"), false);
    store.toolEnd("r1", output("text"), false);
    let aggregate = summaryOf(store, "r1");
    assert.equal(aggregate.status, "running");
    assert.equal(aggregate.live, true);
    assert.equal(aggregate.summary, "Read 1 file, running 1 command, ran 1 search");
    store.toolEnd("b1", output("ok"), false);
    aggregate = summaryOf(store, "r1");
    assert.deepEqual([aggregate.status, aggregate.live], ["done", false]);
  });

  it("cancels the calls of an aborted message and lets an aborted message without calls end the run", async () => {
    const { ActivityGroupStore } = await load();
    const store = new ActivityGroupStore();
    turn(store, assistant([read("r1")]));
    stream(store, assistant([bash("b1"), bash("b2")], "aborted"));
    let aggregate = summaryOf(store, "r1");
    assert.deepEqual(aggregate.entries.map((entry) => entry.status), ["done", "cancelled", "cancelled"]);
    assert.equal(aggregate.status, "cancelled");
    // Pi draws "Operation aborted" under a message without calls.
    stream(store, assistant([], "aborted"));
    turn(store, assistant([read("r2")]));
    assert.deepEqual(groupIds(store, ["r1", "b1", "b2", "r2"]), [["r1", "b1", "b2"], ["r2"]]);
    stream(store, assistant([bash("b3")], "error"));
    aggregate = summaryOf(store, "b3");
    assert.deepEqual(aggregate.entries.map((entry) => entry.status), ["done", "error"]);
  });

  it("takes the arguments a call started with over the ones its message streamed", async () => {
    const { ActivityGroupStore } = await load();
    const store = new ActivityGroupStore();
    store.messageStart(assistant([]));
    store.messageUpdate(assistant([bash("b1", "cat src/a.ts")]));
    store.toolStart("b1", "bash", { command: "npm test" });
    store.messageEnd(assistant([bash("b1", "cat src/a.ts")]));
    assert.equal(summaryOf(store, "b1").summary, "Running 1 command");
  });
});

describe("ampi-tui activity groups: sessions", () => {
  it("rebuilds groups and statuses from a resumed session's messages", async () => {
    const { ActivityGroupStore } = await load();
    const store = new ActivityGroupStore();
    const result = (toolCallId, value, isError = false) => ({ role: "toolResult", toolCallId, content: [text(value)], isError });
    store.rebuild([
      user("look around"),
      assistant([read("r1"), bash("b1")]),
      result("r1", "text"),
      result("b1", "x\n\nCommand exited with code 2", true),
      assistant([text("One more."), grep("g1"), bash("b2")]),
      result("g1", "src/a.ts:1"),
      // b2 never got a result: the session ended while it ran.
      { role: "compactionSummary", summary: "earlier work" },
      assistant([bash("b3")], "aborted"),
      result("b3", "late result that Pi ignores for an aborted message"),
    ]);
    assert.deepEqual(groupIds(store, ["r1", "b1", "g1", "b2", "b3"]), [["r1", "b1"], ["g1", "b2"], ["b3"]]);
    assert.deepEqual(summaryOf(store, "r1").entries.map((entry) => entry.status), ["done", "error"]);
    assert.equal(summaryOf(store, "r1").status, "done");
    const orphan = summaryOf(store, "g1");
    assert.deepEqual([orphan.status, orphan.live], ["running", false], "a restored call never animates");
    assert.equal(summaryOf(store, "b3").status, "cancelled");
  });

  it("forgets a session on clear and replaces it on rebuild", async () => {
    const { ActivityGroupStore } = await load();
    const store = new ActivityGroupStore();
    turn(store, assistant([read("r1"), read("r2")]));
    store.clear();
    assert.equal(store.lookup("r1"), undefined);
    turn(store, assistant([read("r3")]));
    store.rebuild([assistant([read("r9")])]);
    assert.equal(store.lookup("r3"), undefined);
    assert.equal(store.lookup("r9").index, 0);
  });
});

describe("ampi-tui activity groups: redraws", () => {
  it("redraws the summary row when a later call changes, and only that row", async () => {
    const { ActivityGroupStore } = await load();
    const store = new ActivityGroupStore();
    const message = assistant([read("r1"), bash("b1")]);
    stream(store, message);
    const drawn = [];
    for (const id of ["r1", "b1"]) store.attach(id, () => drawn.push(id));
    store.toolStart("r1", "read", message.content[0].arguments);
    store.toolStart("b1", "bash", message.content[1].arguments);
    store.toolEnd("b1", output("ok"), false);
    // Pi redraws a call's own row; the store redraws the first row for b1's changes only.
    assert.deepEqual(drawn, ["r1", "r1"]);
  });

  it("redraws rows that move to another group and the summaries of both groups", async () => {
    const { ActivityGroupStore } = await load();
    const store = new ActivityGroupStore();
    turn(store, assistant([read("r1")]));
    store.messageStart(assistant([]));
    store.messageUpdate(assistant([read("r2"), read("r3")]));
    assert.deepEqual(groupIds(store, ["r1", "r2", "r3"]), [["r1", "r2", "r3"]]);
    const drawn = new Set();
    for (const id of ["r1", "r2", "r3"]) store.attach(id, () => drawn.add(id));
    // Text that arrives after the calls moves them into a group of their own.
    store.messageEnd(assistant([read("r2"), read("r3"), text("Done.")]));
    assert.deepEqual(groupIds(store, ["r1", "r2", "r3"]), [["r1"], ["r2", "r3"]]);
    assert.deepEqual([...drawn].sort(), ["r1", "r2", "r3"]);
  });

  it("lets the first row decide the group's expansion and redraws the others when it changes", async () => {
    const { ActivityGroupStore } = await load();
    const store = new ActivityGroupStore();
    turn(store, assistant([read("r1"), bash("b1"), grep("g1")]));
    const drawn = [];
    for (const id of ["r1", "b1", "g1"]) store.attach(id, () => drawn.push(id));
    store.setExpanded("r1", false);
    assert.deepEqual(drawn, ["b1", "g1"]);
    store.setExpanded("r1", false);
    store.setExpanded("b1", true);
    assert.deepEqual(drawn, ["b1", "g1"], "unchanged or later rows redraw nothing");
    assert.equal(store.lookup("g1").group.calls[0].expanded, false);
  });

  it("redraws every known row after a rebuild and drops rows the new session lacks", async () => {
    const { ActivityGroupStore } = await load();
    const store = new ActivityGroupStore();
    const drawn = [];
    store.attach("r1", () => drawn.push("r1"));
    store.attach("gone", () => drawn.push("gone"));
    store.rebuild([assistant([read("r1"), read("r2")])]);
    store.rebuild([assistant([read("r1")])]);
    assert.deepEqual(drawn, ["r1", "r1"]);
  });
});
