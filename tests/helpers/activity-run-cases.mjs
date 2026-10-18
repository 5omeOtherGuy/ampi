// Saved sessions and the runs of tool calls they fold into, shared by the
// terminal's activity groups (mmr-tui-activity-groups) and the web GUI's
// work groups (mmr-gui-work-groups), so both apply the same boundaries and
// labels. Every call has a result: a call without one is labelled
// differently on purpose (the terminal shows it running, the GUI cancelled).

const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const text = (value) => ({ type: "text", text: value });
const thinking = (value) => ({ type: "thinking", thinking: value });

let clock = 0;
const assistant = (content, stopReason = "toolUse") => ({ role: "assistant", content, stopReason, timestamp: ++clock });
const user = (value) => ({ role: "user", content: [text(value)], timestamp: ++clock });
const result = (toolCallId, value = "ok", isError = false) => ({ role: "toolResult", toolCallId, content: [text(value)], isError, timestamp: ++clock });
const image = (toolCallId) => ({
  role: "toolResult",
  toolCallId,
  content: [text("Read image file [image/png]"), { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
  isError: false,
  timestamp: ++clock,
});

const read = (id, path = "src/a.ts") => call(id, "read", { path });
const bash = (id, command = "npm test") => call(id, "bash", { command });
const grep = (id, pattern = "retries") => call(id, "grep", { pattern });
const edit = (id, path = "src/a.ts") => call(id, "edit", { path, edits: [{ oldText: "a", newText: "b\nc" }] });

/** `{ name, messages, runs, labels, images? }`: `runs` lists each group's call ids, `labels` its summary. */
export const ACTIVITY_RUN_CASES = [
  {
    name: "folds calls of several assistant messages into one run",
    messages: [user("look"), assistant([read("r1"), bash("b1")]), result("r1"), result("b1"), assistant([grep("g1")]), result("g1", "src/a.ts:1")],
    runs: [["r1", "b1", "g1"]],
    labels: ["Read 1 file, ran 1 command, ran 1 search"],
  },
  {
    name: "ends a run at a message with text, which is drawn above its calls",
    messages: [
      assistant([read("r1")]),
      result("r1"),
      assistant([bash("b1"), bash("b2")]),
      result("b1"),
      result("b2"),
      assistant([edit("e1"), text("Now the fix.")]),
      result("e1"),
      assistant([grep("g1")]),
      result("g1"),
    ],
    runs: [
      ["r1", "b1", "b2"],
      ["e1", "g1"],
    ],
    labels: ["Read 1 file, ran 2 commands", "Edited 1 file (+2 -1), ran 1 search"],
  },
  {
    name: "keeps a run going across thinking, whitespace-only text and a failed call",
    messages: [
      assistant([thinking("Look first."), read("r1")]),
      result("r1"),
      assistant([thinking("Then run it."), text("  \n"), bash("b1")]),
      result("b1", "1 failing\n\nCommand exited with code 1", true),
    ],
    runs: [["r1", "b1"]],
    labels: ["Read 1 file, ran 1 command"],
  },
  {
    name: "ends a run at a user message and a custom message that is shown, not at a hidden one",
    messages: [
      assistant([read("r1")]),
      result("r1"),
      user("also check the docs"),
      assistant([read("r2")]),
      result("r2"),
      { role: "custom", customType: "note", display: false, content: "hidden", timestamp: ++clock },
      assistant([read("r3")]),
      result("r3"),
      { role: "custom", customType: "note", display: true, content: "shown", timestamp: ++clock },
      assistant([read("r4")]),
      result("r4"),
    ],
    runs: [["r1"], ["r2", "r3"], ["r4"]],
    labels: ["Read 1 file", "Read 2 files", "Read 1 file"],
  },
  {
    name: "lets a subagent call stand alone and split the run around it",
    messages: [
      assistant([read("r1"), call("o1", "oracle", { task: "Review" }), read("r2"), call("m1", "mcp__docs__search", { query: "x" })]),
      result("r1"),
      result("o1", "Looks fine."),
      result("r2"),
      result("m1"),
    ],
    runs: [["r1"], ["r2", "m1"]],
    labels: ["Read 1 file", "Read 1 file, ran 1 tool"],
  },
  {
    name: "ends a run at a message cut off at the length limit, a compaction and an interrupted message without calls",
    messages: [
      assistant([read("r1")]),
      result("r1"),
      assistant([read("r2")], "length"),
      result("r2"),
      { role: "compactionSummary", summary: "earlier work", tokensBefore: 1000, timestamp: ++clock },
      assistant([read("r3")]),
      result("r3"),
      assistant([], "aborted"),
      assistant([read("r4")]),
      result("r4"),
    ],
    runs: [["r1"], ["r2"], ["r3"], ["r4"]],
    labels: ["Read 1 file", "Read 1 file", "Read 1 file", "Read 1 file"],
  },
  {
    name: "lets a call whose result shows an image stand alone where images can be shown",
    images: true,
    messages: [assistant([bash("b1"), read("r1", "shot.png"), grep("g1")]), result("b1"), image("r1"), result("g1")],
    runs: [["b1"], ["g1"]],
    labels: ["Ran 1 command", "Ran 1 search"],
  },
];
