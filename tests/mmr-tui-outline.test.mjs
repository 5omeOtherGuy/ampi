import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";
import { createAnsiTheme, expectFixture, plain } from "./helpers/tui-render.mjs";

after(cleanupLoadedSource);

let outlineModule;
let frame;
let createMmrTuiKeys;
let registry;
let runtime;
const theme = createAnsiTheme();

before(async () => {
  outlineModule = await importSource("extensions/ampi-tui/overlays/outline.ts");
  frame = await importSource("extensions/ampi-tui/ui/frame.ts");
  ({ createMmrTuiKeys } = await importSource("extensions/ampi-tui/keys/install.ts"));
  registry = await importSource("extensions/ampi-core/command-registry.ts");
  runtime = await importSource("extensions/ampi-core/runtime.ts");
});

let nextId = 0;
const entry = (message) => ({ type: "message", id: `e${++nextId}`, parentId: null, timestamp: "", message });
const user = (content) => entry({ role: "user", content, timestamp: 0 });
const assistant = (...content) =>
  entry({ role: "assistant", content: content.map((part) => (typeof part === "string" ? { type: "text", text: part } : part)) });
const toolCall = (name) => ({ type: "toolCall", id: `call-${name}`, name, arguments: {} });
const toolResult = (name) => entry({ role: "toolResult", toolCallId: `call-${name}`, toolName: name, content: [], isError: false });
const thinking = (text) => ({ type: "thinking", thinking: text });

const extract = (...entries) => outlineModule.extractMmrOutline(entries);
const texts = (outline) => outline.headings.map((heading) => `${heading.level} ${heading.text}`);

describe("ampi-tui outline: extraction", () => {
  it("has no prompt row before the first message, and only the prompt before the first response", () => {
    assert.deepEqual(extract(), { headings: [] });
    assert.deepEqual(extract(user("Plan the release\nwith notes")), { prompt: "Plan the release", headings: [] });
    assert.deepEqual(
      extract(user("Plan it"), assistant(thinking("# Not a heading"), toolCall("read"))),
      { prompt: "Plan it", headings: [] },
      "thinking and tool calls are no response",
    );
  });

  it("keeps the last response with text while a newer turn has only called tools", () => {
    const outline = extract(
      user("Explain the cache"),
      assistant("# Cache\n\n## Keys\n\nText."),
      user([{ type: "text", text: "Now run the tests" }]),
      assistant(toolCall("bash")),
      toolResult("bash"),
    );
    assert.equal(outline.prompt, "Explain the cache");
    assert.deepEqual(texts(outline), ["1 Cache", "2 Keys"]);
  });

  it("reads a response spread over several assistant messages, up to the next user message", () => {
    const outline = extract(
      user("Review"),
      assistant("## Findings", toolCall("grep")),
      toolResult("grep"),
      assistant(thinking("## Hidden"), "## Fixes\n### First fix"),
      user("Thanks"),
    );
    assert.equal(outline.prompt, "Review");
    assert.deepEqual(texts(outline), ["2 Findings", "2 Fixes", "3 First fix"]);
  });

  it("ignores heading-like lines inside backtick and tilde fences", () => {
    const outline = extract(
      user("Show code"),
      assistant(
        [
          "# Shell",
          "```sh",
          "# a comment",
          "```",
          "~~~~ python",
          "# another comment",
          "~~~",
          "## still inside the tilde fence",
          "~~~~",
          "## After the fences",
        ].join("\n"),
      ),
    );
    assert.deepEqual(texts(outline), ["1 Shell", "2 After the fences"]);
  });

  it("keeps a fence of four backticks open past a line of three", () => {
    const outline = extract(
      user("Nested"),
      assistant(["````md", "```", "# inside", "```", "````", "# Outside"].join("\n")),
    );
    assert.deepEqual(texts(outline), ["1 Outside"]);
  });

  it("reads a line of dashes under a paragraph as a heading, and after a blank line as a break", () => {
    const outline = extract(
      user("Setext"),
      assistant(
        [
          "Title one",
          "=========",
          "",
          "Subtitle",
          "--------",
          "",
          "Some text.",
          "",
          "---",
          "",
          "- a list item",
          "---",
          "> a quote",
          "---",
          "A paragraph that",
          "goes over two lines",
          "---",
        ].join("\n"),
      ),
    );
    assert.deepEqual(texts(outline), ["1 Title one", "2 Subtitle", "2 A paragraph that goes over two lines"]);
  });

  it("strips closing hashes and inline Markdown from heading text", () => {
    const outline = extract(
      user("Inline"),
      assistant(
        [
          "## Closing hashes ##",
          "### C# stays",
          "#### **Bold**, _italic_ and `code`",
          "##### See [the docs](https://example.com/docs) and snake_case",
          "###### Escaped \\*star\\* and 2 * 3",
          "#NoSpace is text",
        ].join("\n"),
      ),
    );
    assert.deepEqual(texts(outline), [
      "2 Closing hashes",
      "3 C# stays",
      "4 Bold, italic and code",
      "5 See the docs and snake_case",
      "6 Escaped *star* and 2 * 3",
    ]);
  });

  it("shows the words typed with a skill call as the prompt", () => {
    const skill = '<skill name="release" location="/skills/release/SKILL.md">\n# Release steps\n</skill>\n\nCut the 1.2 release';
    const outline = extract(user(skill), assistant("## Done"));
    assert.equal(outline.prompt, "Cut the 1.2 release");
    assert.deepEqual(texts(outline), ["2 Done"]);
  });
});

/** The outline box as the controller draws it, `columns` wide, on a terminal `rows` high. */
function box(entries, columns, rows = 44) {
  const ctx = createMockExtensionContext().ctx;
  ctx.sessionManager.buildContextEntries = () => entries;
  let component;
  ctx.ui.custom = (factory) => {
    component = factory({ terminal: { rows }, requestRender() {} }, theme, undefined, () => {});
    return new Promise(() => {});
  };
  outlineModule.createMmrOutline({ offsetY: () => -5 }).open(ctx);
  return component.render(columns);
}

const ANSWER = [
  user("Explain how the cache works and where it is configured"),
  assistant("# Cache layout\n\nText.\n\n## Keys\n\n## Eviction\n\n```\n# not a heading\n```\n\n### Least recently used\n"),
];

describe("ampi-tui outline: rendering", () => {
  it("draws the prompt and the headings, indented by level, at 60 and 36 columns", () => {
    const at60 = box(ANSWER, 60);
    assert.deepEqual(plain(at60), [
      "╭─ Outline ────────────────────────────────────────────────╮",
      "│ ↑  Explain how the cache works and where it is configur… │",
      "│ Cache layout                                             │",
      "│   Keys                                                   │",
      "│   Eviction                                               │",
      "│     Least recently used                                  │",
      "╰──────────────────────────────────────────────────────────╯",
    ]);
    assert.ok(at60[0].includes("\x1b[1m\x1b[36mOutline\x1b[39m\x1b[22m"), "the title is bold in the heading colour");
    assert.ok(at60[1].includes("\x1b[36m\x1b[2m↑  Explain"), "the prompt is dim in the heading colour");
    assert.ok(at60[2].includes("\x1b[1mCache layout\x1b[22m"), "level 1 is bold");
    assert.ok(!at60[3].includes("\x1b[1m"), "deeper levels are not");
    expectFixture("ampi-tui-outline", "headings-60", at60);

    const at36 = box(ANSWER, 36);
    assert.ok(at36.every((line) => visibleWidth(line) === 36));
    assert.equal(plain(at36)[1], "│ ↑  Explain how the cache works … │");
    expectFixture("ampi-tui-outline", "headings-36", at36);
  });

  it("indents relative to the shallowest level present", () => {
    const lines = plain(box([user("Steps"), assistant("## Install\n### From npm\n## Use")], 60));
    assert.deepEqual(lines.slice(2, 5), [
      "│ Install                                                  │",
      "│   From npm                                               │",
      "│ Use                                                      │",
    ]);
  });

  it("says there are no headings in one dim row", () => {
    const lines = box([user("Hello"), assistant("Hi there, no headings here.")], 60);
    assert.deepEqual(plain(lines).slice(1, 3), [
      "│ ↑  Hello                                                 │",
      "│ No headings                                              │",
    ]);
    assert.ok(lines[2].includes("\x1b[2mNo headings\x1b[22m"));
    expectFixture("ampi-tui-outline", "empty-60", lines);
    assert.deepEqual(plain(box([], 60)).slice(1, -1), ["│ No headings                                              │"], "no prompt row before a message");
  });

  it("takes at most a third of the terminal's rows and says how many rows it leaves out", () => {
    const many = Array.from({ length: 12 }, (_, index) => `## Section ${index + 1}`).join("\n");
    const lines = box([user("Long answer"), assistant(many)], 60, 24);
    assert.equal(lines.length, 8, "24 rows: eight, borders included");
    assert.deepEqual(plain(lines).slice(1, -1), [
      "│ ↑  Long answer                                           │",
      "│ Section 1                                                │",
      "│ Section 2                                                │",
      "│ Section 3                                                │",
      "│ Section 4                                                │",
      "│ … 8 more                                                 │",
    ]);
    assert.ok(lines.at(-2).includes("\x1b[2m… 8 more\x1b[22m"));
    expectFixture("ampi-tui-outline", "cut-60x24", lines);
  });
});

describe("ampi-tui outline: command", () => {
  beforeEach(() => {
    registry.__resetMmrCommandsForTests();
    runtime.setMmrModeState(undefined);
  });
  afterEach(() => {
    registry.__resetMmrCommandsForTests();
    runtime.setMmrModeState(undefined);
  });

  function setup(entries = [...ANSWER]) {
    let time = 0;
    const timers = [];
    const mock = createMockPi();
    mock.pi.events = { emit() {}, on: () => () => {} };
    const context = createMockExtensionContext({ entries });
    const keys = createMmrTuiKeys(mock.pi, {
      now: () => time,
      setTimer: (callback, ms) => {
        const timer = { callback, at: time + ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: (timer) => {
        timer.cleared = true;
      },
      editorHeight: () => 5,
    });
    keys.start(context.ctx, () => undefined);
    const command = registry.getMmrCommand("thread.toggleOutline");
    return {
      ...mock,
      ...context,
      keys,
      command,
      run: () => command.run(context.ctx),
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

  it("is a palette command without a key, only in the interactive terminal", () => {
    const t = setup();
    assert.equal(t.command.noun, "thread");
    assert.equal(t.command.verb, "toggle outline");
    assert.equal(t.command.defaultKey, undefined);
    assert.deepEqual(t.command.keywords, ["outline", "headings", "contents"]);
    assert.deepEqual(t.command.availability(t.ctx), { state: "available" });
    const print = createMockExtensionContext({ hasUI: false }).ctx;
    assert.equal(t.command.availability(print).state, "unavailable");
    t.keys.stop();
  });

  it("opens a non-capturing box at the bottom right above the prompt, and the same command closes it", () => {
    const t = setup();
    t.run();
    assert.equal(t.overlays.length, 1);
    const overlay = t.overlays[0];
    assert.equal(overlay.options.overlay, true);
    const placement = overlay.options.overlayOptions();
    assert.equal(placement.nonCapturing, true);
    assert.equal(placement.anchor, "bottom-right");
    assert.equal(placement.width, 60);
    assert.deepEqual(placement.margin, { left: 2, right: 2 });
    assert.equal(placement.offsetY, -5, "the bottom border sits on the row above the prompt box");
    assert.match(overlay.component.render(60)[1], /↑ {2}Explain how the cache works/);

    t.run();
    assert.equal(overlay.closed, true);
    t.run();
    assert.equal(t.overlays.length, 2, "it opens again");
    t.keys.stop();
    assert.equal(t.overlays[1].closed, true, "the session ending closes it");
  });

  it("hides on a narrow terminal and while the mode dial or the key hint popup is open", () => {
    const t = setup();
    t.pi.registerCommand("mode", {});
    runtime.setMmrModeState({ mode: "medium" });
    t.run();
    const { visible } = t.overlays[0].options.overlayOptions();
    assert.equal(visible(140, 44), true);
    assert.equal(visible(40, 24), true);
    assert.equal(visible(39, 24), false);

    t.terminalInput.send("\x13");
    const dial = t.overlays[1];
    assert.equal(visible(140, 44), false, "hidden while the dial is open");
    dial.component.handleInput("\x1b");
    assert.equal(dial.closed, true);
    assert.equal(visible(140, 44), true, "back once the dial closes");

    t.terminalInput.send("\x18");
    assert.equal(visible(140, 44), false, "hidden while the Ctrl+X popup is open");
    t.advance(1500);
    assert.equal(visible(140, 44), true);
    assert.equal(t.overlays[0].closed, false);
    t.keys.stop();
  });

  it("follows each response that ends and each move through the session tree", () => {
    const t = setup();
    t.run();
    const rows = () => plain(t.overlays[0].component.render(60)).slice(1, -1).map((line) => line.slice(2, -1).trimEnd());
    assert.deepEqual(rows(), ["↑  Explain how the cache works and where it is configur…", "Cache layout", "  Keys", "  Eviction", "    Least recently used"]);

    // A new prompt keeps the previous response until the new one has text.
    t.entries.push(user("Say hi"));
    const handlers = t.handlers;
    const toolOnly = assistant(toolCall("bash")).message;
    handlers.get("message_end")({ type: "message_end", message: toolOnly }, t.ctx);
    assert.equal(rows()[0], "↑  Explain how the cache works and where it is configur…");
    // Pi stores a message after the message_end handlers ran, so the ended one is passed along.
    const reply = assistant("Hi!").message;
    handlers.get("message_end")({ type: "message_end", message: reply }, t.ctx);
    assert.deepEqual(rows(), ["↑  Say hi", "No headings"]);

    // Moving back in the tree shows the response at that point.
    t.entries.splice(2);
    handlers.get("session_tree")({ type: "session_tree" }, t.ctx);
    assert.equal(rows()[0], "↑  Explain how the cache works and where it is configur…");
    t.keys.stop();
  });
});

describe("ampi-tui outline: frame title colour", () => {
  it("keeps the warning colour unless the content names another", () => {
    const [top] = frame.renderMmrFrame({ title: "Default", lines: [] }, 30, theme);
    assert.ok(top.includes("\x1b[33mDefault"));
  });
});
