// ampi-gui work groups: runs of tool calls folded into one line by the
// terminal's rules, their labels, statuses and durations, the live `groups`
// events, and the client's drawing of groups, call details and the work fold.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { ACTIVITY_RUN_CASES } from "./helpers/activity-run-cases.mjs";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const loadViewModel = () => importSource("extensions/ampi-gui/view-model.ts");
const loadBridge = () => importSource("extensions/ampi-gui/bridge.ts");
const loadClient = () => importSource("extensions/ampi-gui/client/transcript.js");

const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const text = (value) => ({ type: "text", text: value });
const assistant = (content, timestamp, stopReason = "toolUse") => ({ role: "assistant", content, timestamp, stopReason });
const user = (value, timestamp) => ({ role: "user", content: [text(value)], timestamp });
const result = (toolCallId, timestamp, value = "ok", extra = {}) => ({ role: "toolResult", toolCallId, content: [text(value)], isError: false, timestamp, ...extra });
const entry = (id, message) => ({ type: "message", id, message });

describe("ampi-gui work groups: the cases the terminal shares", () => {
  for (const { name, messages, runs, labels } of ACTIVITY_RUN_CASES) {
    it(name, async () => {
      const { buildMmrGuiGroups, collectMmrGuiToolResults } = await loadViewModel();
      const groups = buildMmrGuiGroups(messages, collectMmrGuiToolResults(messages));
      assert.deepEqual(
        groups.map((group) => group.callIds),
        runs,
      );
      assert.deepEqual(
        groups.map((group) => group.label),
        labels,
      );
      assert.deepEqual(
        groups.map((group) => group.id),
        runs.map((run) => run[0]),
        "a group is named after its first call",
      );
    });
  }
});

describe("ampi-gui work groups: status and duration", () => {
  it("spans from the first call's message to the last result, and is done even when a call failed", async () => {
    const { buildMmrGuiGroups, collectMmrGuiToolResults } = await loadViewModel();
    const messages = [
      assistant([call("b1", "bash", { command: "npm test" })], 1_000),
      result("b1", 4_000, "1 failing\n\nCommand exited with code 1", { isError: true }),
      assistant([call("r1", "read", { path: "/work/a.ts" })], 5_000),
      result("r1", 130_000),
    ];
    const [group] = buildMmrGuiGroups(messages, collectMmrGuiToolResults(messages), { cwd: "/work" });
    assert.deepEqual(group, { id: "b1", callIds: ["b1", "r1"], label: "Ran 1 command, read 1 file", status: "done", startedAt: 1_000, endedAt: 130_000 });
  });

  it("runs while a call may still run, with no end, and counts calls that never ended as cancelled", async () => {
    const { buildMmrGuiGroups, collectMmrGuiToolResults } = await loadViewModel();
    const messages = [assistant([call("b1", "bash", { command: "npm test" }), call("b2", "bash", { command: "npm run lint" })], 10), result("b1", 20)];
    const results = collectMmrGuiToolResults(messages);
    const [running] = buildMmrGuiGroups(messages, results, { pending: () => true });
    assert.deepEqual([running.status, running.label, running.endedAt], ["running", "Running 2 commands", undefined]);
    const [stopped] = buildMmrGuiGroups(messages, results);
    assert.deepEqual([stopped.status, stopped.label, stopped.endedAt], ["cancelled", "Ran 2 commands (1 cancelled)", 20]);
  });

  it("splits runs at the summaries and shown custom messages a saved session holds as entries of their own", async () => {
    const { buildMmrGuiTranscript } = await loadViewModel();
    const { items, groups } = buildMmrGuiTranscript([
      entry("e1", assistant([call("r1", "read", { path: "a.ts" })], 1)),
      entry("e2", result("r1", 2)),
      { type: "compaction", id: "e3", summary: "earlier", tokensBefore: 10, timestamp: "2026-10-18T10:00:00.000Z" },
      entry("e4", assistant([call("r2", "read", { path: "b.ts" })], 3)),
      entry("e5", result("r2", 4)),
      { type: "custom_message", id: "e6", customType: "note", content: "shown", display: true, timestamp: "2026-10-18T10:00:01.000Z" },
      entry("e7", assistant([call("r3", "read", { path: "c.ts" })], 5)),
      entry("e8", result("r3", 6)),
    ]);
    assert.deepEqual(
      groups.map((group) => group.callIds),
      [["r1"], ["r2"], ["r3"]],
    );
    assert.deepEqual(
      items.map((item) => item.id),
      ["a1", "a3", "a5"],
      "summaries and custom messages are not items",
    );
  });
});

describe("ampi-gui work groups: call details", () => {
  it("carries a command's full text, an edit's diff, a new file's lines and a generic tool's arguments", async () => {
    const { buildMmrGuiToolPart } = await loadViewModel();
    const ok = (details) => ({ content: [text("done")], details, isError: false });
    const command = buildMmrGuiToolPart({ id: "b1", name: "bash", arguments: { command: "cd src && npm test -- --grep 'a b'" } }, ok());
    assert.equal(command.command, "cd src && npm test -- --grep 'a b'");
    const diff = "  1 keep\n-2 old <b>\n+2 new <b>";
    const edited = buildMmrGuiToolPart({ id: "e1", name: "edit", arguments: { path: "a.ts", edits: [] } }, ok({ diff }));
    assert.equal(edited.diff, diff);
    const failed = buildMmrGuiToolPart({ id: "e2", name: "edit", arguments: { path: "a.ts", edits: [] } }, { content: [text("no match")], isError: true });
    assert.equal(failed.diff, undefined, "a failed edit changed nothing");
    const created = buildMmrGuiToolPart({ id: "w1", name: "write", arguments: { path: "n.ts", content: "one\ntwo\n" } }, ok());
    assert.equal(created.diff, "+one\n+two");
    const generic = buildMmrGuiToolPart({ id: "m1", name: "mcp__docs__search", arguments: { query: "retry" } }, ok());
    assert.equal(generic.args, '{\n  "query": "retry"\n}');
    const read = buildMmrGuiToolPart({ id: "r1", name: "read", arguments: { path: "a.ts", offset: 3, limit: 4 } }, ok());
    assert.deepEqual([read.command, read.diff, read.args], [undefined, undefined, undefined], "a read says it all in its title");
    assert.equal(read.title.map((part) => part.text).join(""), "Read a.ts L3-6");
  });
});

describe("ampi-gui work groups: live events", () => {
  async function setup(entries = []) {
    const { createMmrGuiBridge } = await loadBridge();
    const { pi, handlers } = createMockPi();
    const { ctx } = createMockExtensionContext({ entries, cwd: "/work/app", sessionId: "s-1" });
    let clock = 100;
    const bridge = createMmrGuiBridge(pi, { now: () => clock, home: "/home/u" });
    const fire = (name, event) => handlers.get(name)?.({ type: name, ...event }, ctx);
    bridge.start(ctx);
    const seen = [];
    bridge.subscribe((event) => seen.push(event));
    return { bridge, fire, seen, entries, tick: (ms) => (clock += ms) };
  }

  /** The client's view of the groups: the snapshot's, then each `groups` event applied. */
  function replay(groups, events) {
    const byId = new Map(groups.map((group) => [group.id, group]));
    for (const { event, data } of events) {
      if (event !== "groups") continue;
      for (const id of data.removed) byId.delete(id);
      for (const group of data.groups) byId.set(group.id, group);
    }
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  it("sends a group before the item and tool events that change it, and its final label when the calls end", async () => {
    const { fire, seen, tick } = await setup();
    const b1 = call("b1", "bash", { command: "npm test" });
    const r1 = call("r1", "read", { path: "/work/app/src/a.ts" });
    fire("turn_start", {});
    fire("message_start", { message: user("check", 50) });
    fire("message_start", { message: assistant([b1, r1], 60) });
    fire("message_update", { message: assistant([b1, r1], 60), assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 } });
    fire("message_update", { message: assistant([b1, r1], 60), assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 } });
    fire("message_end", { message: assistant([b1, r1], 60) });
    fire("tool_execution_start", { toolCallId: "b1", toolName: "bash", args: b1.arguments });
    fire("tool_execution_start", { toolCallId: "r1", toolName: "read", args: r1.arguments });
    tick(5_000);
    fire("tool_execution_end", { toolCallId: "r1", toolName: "read", isError: false, result: { content: [text("x")] } });
    tick(1_000);
    fire("tool_execution_end", { toolCallId: "b1", toolName: "bash", isError: false, result: { content: [text("ok")] } });

    const firstGroups = seen.findIndex((event) => event.event === "groups");
    const firstItem = seen.findIndex((event) => event.event === "item" && event.data.id === "a60" && event.data.parts.length > 0);
    assert.ok(firstGroups >= 0 && firstGroups < firstItem, "the group arrives before the item that shows its call");
    const labels = seen.filter((event) => event.event === "groups").map((event) => event.data.groups.map((group) => `${group.label}|${group.status}`).join());
    assert.deepEqual(labels, [
      "Running 1 command|running",
      "Running 1 command, reading 1 file|running",
      "Running 1 command, read 1 file|running",
      "Ran 1 command, read 1 file|done",
    ]);
    const last = seen.findLast((event) => event.event === "groups").data.groups[0];
    assert.deepEqual([last.startedAt, last.endedAt], [60, 6_100]);
    const lastTool = seen.at(-1);
    assert.equal(lastTool.event, "tool", "the tool event follows the group it changed");
  });

  it("removes a group that a message's first text splits, and agrees with a snapshot taken midway", async () => {
    const { bridge, fire, seen } = await setup([
      entry("e1", user("go", 1)),
      entry("e2", assistant([call("r1", "read", { path: "a.ts" })], 2)),
      entry("e3", result("r1", 3)),
    ]);
    fire("turn_start", {});
    const r2 = call("r2", "read", { path: "b.ts" });
    const streaming = assistant([text(""), r2], 4);
    fire("message_start", { message: assistant([], 4) });
    fire("message_update", { message: streaming, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    fire("message_update", { message: streaming, assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 } });
    const midway = bridge.snapshot();
    assert.deepEqual(
      midway.groups.map((group) => group.callIds),
      [["r1", "r2"]],
      "blank text does not split the run",
    );
    fire("message_update", { message: assistant([text("Next: b."), r2], 4), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Next: b." } });
    const split = seen.findLast((event) => event.event === "groups");
    assert.deepEqual(split.data.removed, []);
    assert.deepEqual(
      split.data.groups.map((group) => group.callIds),
      [["r1"], ["r2"]],
    );
    const final = bridge.snapshot();
    assert.deepEqual(replay(midway.groups, bridge.eventsAfter(midway.lastEventId)), final.groups);
  });

  it("marks calls that never ended as cancelled once the run settles", async () => {
    const { bridge, fire, entries } = await setup();
    const b1 = call("b1", "bash", { command: "sleep 60" });
    fire("turn_start", {});
    fire("message_start", { message: assistant([b1], 10) });
    fire("message_end", { message: assistant([b1], 10) });
    entries.push(entry("e1", assistant([b1], 10)));
    fire("tool_execution_start", { toolCallId: "b1", toolName: "bash", args: b1.arguments });
    assert.equal(bridge.snapshot().groups[0].status, "running");
    fire("turn_end", { turnIndex: 0, message: assistant([b1], 10) });
    fire("agent_settled", {});
    assert.deepEqual([bridge.snapshot().groups[0].status, bridge.snapshot().groups[0].label], ["cancelled", "Ran 1 command (1 cancelled)"]);
  });
});

describe("ampi-gui work groups: drawing", () => {
  it("formats work durations in seconds, minutes and hours", async () => {
    const { formatWorkDuration } = await loadClient();
    assert.equal(formatWorkDuration(0), "1 second");
    assert.equal(formatWorkDuration(1_400), "1 second");
    assert.equal(formatWorkDuration(44_600), "45 seconds");
    assert.equal(formatWorkDuration(59_400), "59 seconds");
    assert.equal(formatWorkDuration(60_000), "1 minute");
    assert.equal(formatWorkDuration(119_000), "1 minute");
    assert.equal(formatWorkDuration(10 * 60_000 + 30_000), "10 minutes");
    assert.equal(formatWorkDuration(3_600_000), "1 hour");
    assert.equal(formatWorkDuration(2 * 3_600_000 + 5 * 60_000), "2 hours 5 minutes");
  });

  it("draws a diff line by line, coloured by kind, with everything escaped", async () => {
    const { diffHtml } = await loadClient();
    const html = diffHtml('  3 const a = "<b>";\n-4 old </pre><script>x()</script>\n+4 new & improved\n*** Update File: a.ts\n\n');
    assert.equal(html.includes("<script>"), false);
    assert.equal(html.includes("</pre><"), false);
    assert.equal(
      html,
      '<pre class="tool-diff">' +
        '<span class="diff-line diff-context">  3 const a = &quot;&lt;b&gt;&quot;;</span>' +
        '<span class="diff-line diff-remove">-4 old &lt;/pre&gt;&lt;script&gt;x()&lt;/script&gt;</span>' +
        '<span class="diff-line diff-add">+4 new &amp; improved</span>' +
        '<span class="diff-line diff-meta">*** Update File: a.ts</span>' +
        '<span class="diff-line diff-context"> </span>' +
        "</pre>",
    );
  });

  it("expands a command to its full call and output, escaped", async () => {
    const { toolBodyHtml } = await loadClient();
    const html = toolBodyHtml({ command: "echo '<i>' && rm -rf x", output: "<i>\n", status: "done", title: [] });
    assert.equal(html, '<div class="tool-card"><pre class="tool-command"><span class="part-muted">$ </span>echo &#39;&lt;i&gt;&#39; &amp;&amp; rm -rf x</pre><pre class="tool-output">&lt;i&gt;\n</pre></div>');
    assert.equal(toolBodyHtml({ status: "done", title: [] }), "", "nothing to expand");
  });

  function transcriptOf(client, items, groups) {
    const transcript = client.createTranscript();
    client.setGroups(transcript, groups);
    for (const item of items) client.setItem(transcript, item);
    return transcript;
  }

  const tool = (id, verb, object, extra = {}) => ({
    type: "tool",
    toolCallId: id,
    name: "bash",
    status: "done",
    title: [
      { text: verb, role: "verb" },
      { text: ` ${object}`, role: "object" },
    ],
    output: "ok",
    ...extra,
  });
  const group = (id, callIds, label, extra = {}) => ({ id, callIds, label, status: "done", ...extra });

  it("draws a group at its first call, its calls inside it as one accordion, and nothing at the later calls", async () => {
    const client = await loadClient();
    const items = [
      { type: "assistant", id: "a1", timestamp: 1, parts: [tool("b1", "Ran", "npm test"), text("Checking <now>.")] },
      { type: "assistant", id: "a2", timestamp: 2, parts: [tool("r1", "Read", "a.ts")] },
    ];
    const transcript = transcriptOf(client, items, [group("b1", ["b1", "r1"], "Ran 1 command, read 1 <file>", { startedAt: 1_000, endedAt: 61_000 })]);
    const open = new Set(["tool:r1"]);
    const first = client.itemHtml(transcript, items[0], open);
    assert.ok(first.indexOf("Checking &lt;now&gt;.") < first.indexOf("work-group"), "the text comes before the calls, as in the terminal");
    assert.match(first, /<summary title="Took 1 minute"><span class="work-label">Ran 1 command, read 1 &lt;file&gt;<\/span>/);
    const rows = [...first.matchAll(/<details class="row"[^>]*>/g)].map((match) => match[0]);
    assert.deepEqual(rows, [
      '<details class="row" data-status="done" data-key="tool:b1" name="group:b1">',
      '<details class="row" data-status="done" data-key="tool:r1" name="group:b1" open>',
    ]);
    assert.equal(client.itemHtml(transcript, items[1], open), "", "the later call is drawn inside the group");
    assert.equal(client.groupOf(transcript, "r1").id, "b1");
    assert.deepEqual([...client.groupItemIds(transcript, client.groupOf(transcript, "r1"))], ["a1", "a2"]);
  });

  it("keeps a call that belongs to no group on its own row", async () => {
    const client = await loadClient();
    const item = { type: "assistant", id: "a1", timestamp: 1, parts: [tool("o1", "Ran", "oracle")] };
    const html = client.itemHtml(transcriptOf(client, [item], []), item, new Set());
    assert.match(html, /^<div class="part" data-part="0" data-kind="tool"><details class="row" data-status="done" data-key="tool:o1">/);
  });

  it("folds a finished turn's work behind 'Worked for', keeping the final answer and a short turn's one line", async () => {
    const client = await loadClient();
    const items = [
      { type: "user", id: "u1", timestamp: 0, text: "fix it", images: 0 },
      { type: "assistant", id: "a1", timestamp: 1_000, parts: [tool("r1", "Read", "a.ts")] },
      { type: "assistant", id: "a2", timestamp: 2_000, parts: [text("Found it."), tool("e1", "Edited", "a.ts")] },
      { type: "assistant", id: "a3", timestamp: 125_000, parts: [{ type: "thinking", text: "done?" }, text("Fixed.")] },
      { type: "user", id: "u2", timestamp: 200_000, text: "thanks", images: 0 },
      { type: "assistant", id: "a4", timestamp: 201_000, parts: [tool("b1", "Ran", "npm test")] },
      { type: "assistant", id: "a5", timestamp: 209_000, parts: [text("All green.")] },
      { type: "user", id: "u3", timestamp: 300_000, text: "again", images: 0 },
      { type: "assistant", id: "a6", timestamp: 301_000, parts: [tool("b2", "Ran", "npm test")] },
      // A subagent call: no group, a line of its own.
      { type: "assistant", id: "a7", timestamp: 302_000, parts: [tool("o1", "Ran", "oracle")] },
    ];
    const groups = [group("r1", ["r1"], "Read 1 file"), group("e1", ["e1"], "Edited 1 file"), group("b1", ["b1"], "Ran 1 command"), group("b2", ["b2"], "Ran 1 command", { endedAt: 340_000 })];
    const transcript = transcriptOf(client, items, groups);
    // The second turn's work is one group: its label stands on its own.
    assert.deepEqual(client.planWorkFolds(transcript, false), [
      { key: "work:a1", firstId: "a1", lastId: "a3", itemIds: ["a1", "a2", "a3"], answer: true, label: "Worked for 2 minutes" },
      { key: "work:a6", firstId: "a6", lastId: "a7", itemIds: ["a6", "a7"], answer: false, label: "Worked for 40 seconds" },
    ]);
    const busy = client.planWorkFolds(transcript, true);
    assert.deepEqual(
      busy.map((fold) => fold.key),
      ["work:a1"],
      "the running turn stays open",
    );
  });

  it("folds a turn that ended without an answer, up to its last call's end", async () => {
    const client = await loadClient();
    const items = [
      { type: "user", id: "u1", timestamp: 0, text: "go", images: 0 },
      { type: "assistant", id: "a1", timestamp: 1_000, parts: [text("Looking."), tool("b1", "Ran", "npm test")] },
      { type: "assistant", id: "a2", timestamp: 3_000, parts: [tool("b2", "Ran", "npm run lint")], stopReason: "aborted" },
    ];
    const transcript = transcriptOf(client, items, [group("b1", ["b1", "b2"], "Ran 2 commands", { endedAt: 45_000 })]);
    assert.deepEqual(client.planWorkFolds(transcript, false), [
      { key: "work:a1", firstId: "a1", lastId: "a2", itemIds: ["a1", "a2"], answer: false, label: "Worked for 45 seconds" },
    ]);
  });
});
