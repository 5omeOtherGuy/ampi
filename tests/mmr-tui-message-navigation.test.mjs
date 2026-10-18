// Message navigation: the selection model, the selected frame, the keys in a
// session, the edit command and the scroll that brings a selection into view.
// The probes against the installed Pi live in tests/mmr-tui-pi-compat.test.mjs.

import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, stripTerminalSequences, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const plainTheme = { fg: (_token, text) => text, italic: (text) => text };
const taggedTheme = { fg: (token, text) => `<${token}>${text}</${token}>`, italic: (text) => `<i>${text}</i>` };
const stripOsc133 = (line) => line.replace(/\x1b\]133;[ABC]\x07/g, "");

const SHIFT_TAB = "\x1b[Z";
const TAB = "\t";
const ESC = "\x1b";

function userEntry(id, content) {
  return { type: "message", id, message: { role: "user", content } };
}

function assistantEntry(id, text) {
  return { type: "message", id, message: { role: "assistant", content: [{ type: "text", text }] } };
}

describe("ampi-tui message selection model", () => {
  it("Shift+Tab starts at the newest message, walks back and stops at the oldest", async () => {
    const { selectPreviousMmrMessage } = await importSource("extensions/ampi-tui/transcript/navigation.ts");
    assert.equal(selectPreviousMmrMessage(3, undefined), 2);
    assert.equal(selectPreviousMmrMessage(3, 2), 1);
    assert.equal(selectPreviousMmrMessage(3, 1), 0);
    assert.equal(selectPreviousMmrMessage(3, 0), 0, "the oldest stays selected");
    assert.equal(selectPreviousMmrMessage(2, 5), 1, "a selection beyond a shrunk thread moves to its newest");
    assert.equal(selectPreviousMmrMessage(0, undefined), undefined, "an empty thread selects nothing");
  });

  it("Tab walks forward and clears the selection past the newest", async () => {
    const { selectNextMmrMessage } = await importSource("extensions/ampi-tui/transcript/navigation.ts");
    assert.equal(selectNextMmrMessage(3, 0), 1);
    assert.equal(selectNextMmrMessage(3, 1), 2);
    assert.equal(selectNextMmrMessage(3, 2), undefined);
    assert.equal(selectNextMmrMessage(3, undefined), undefined, "without a selection Tab selects nothing");
    assert.equal(selectNextMmrMessage(0, undefined), undefined);
  });

  it("lists the user messages the transcript draws, oldest first", async () => {
    const { collectMmrEditableMessages } = await importSource("extensions/ampi-tui/transcript/navigation.ts");
    const skill = '<skill name="review" location="/skills/review/SKILL.md">\nSteps\n</skill>';
    const entries = [
      userEntry("u1", "first"),
      assistantEntry("a1", "reply"),
      userEntry("u2", [
        { type: "text", text: "two " },
        { type: "image", data: "", mimeType: "image/png" },
        { type: "text", text: "parts" },
      ]),
      userEntry("u3", [{ type: "image", data: "", mimeType: "image/png" }]),
      userEntry("u4", `${skill}\n\nwith my words`),
      userEntry("u5", skill),
      { type: "model_change", id: "m1" },
    ];
    assert.deepEqual(collectMmrEditableMessages(entries), [
      { id: "u1", text: "first", shown: "first" },
      { id: "u2", text: "two parts", shown: "two parts" },
      { id: "u4", text: `${skill}\n\nwith my words`, shown: "with my words" },
    ]);
  });
});

describe("ampi-tui selected user message", () => {
  it("draws a heavy frame with the edit hint in its bottom border", async () => {
    const { renderMmrUserMessage } = await importSource("extensions/ampi-tui/transcript/messages.ts");
    assert.deepEqual(renderMmrUserMessage("rename the parser and update imports", 24, 1, plainTheme, true), [
      "",
      " ┏━━━━━━━━━━━━━━━━━━━━┓",
      " ┃ rename the parser  ┃",
      " ┃ and update imports ┃",
      " ┗━e to edit━━━━━━━━━━┛",
    ]);
    const [, , line, bottom] = renderMmrUserMessage("hi", 20, 1, taggedTheme, true);
    assert.equal(
      line,
      " <userMessageText>┃ </userMessageText><i><userMessageText>hi</userMessageText></i>            <userMessageText> ┃</userMessageText>",
    );
    assert.equal(
      bottom,
      " <userMessageText>┗━</userMessageText><accent>e</accent><dim> to edit</dim><userMessageText>━━━━━━┛</userMessageText>",
    );
  });

  for (const width of [80, 140]) {
    it(`fills the width but the margins at ${width} columns, wrapped and blank lines included`, async () => {
      const { renderMmrUserMessage } = await importSource("extensions/ampi-tui/transcript/messages.ts");
      // 40 five-column words: 15 to a line at 80 columns (74 of the frame's
      // 74 text columns), 27 at 140, so the text takes 3 and 2 rows.
      const text = `${"word ".repeat(40).trim()}\n\nlast line`;
      const lines = renderMmrUserMessage(text, width, 1, plainTheme, true);
      assert.equal(lines[0], "", "a blank row above, as unselected");
      assert.equal(lines.length, 1 + 2 + (width === 80 ? 3 : 2) + 2, "blank row, frame, wrapped text, blank line, last line");
      for (const line of lines.slice(1)) assert.equal(visibleWidth(line), width - 1, "the last column stays free for the scrollbar");
      assert.match(lines[1], /^ ┏━+┓$/);
      assert.match(lines.at(-1), /^ ┗━e to edit━+┛$/);
      for (const line of lines.slice(2, -1)) assert.match(line, /^ ┃ .* ┃$/);
      assert.ok(lines.includes(` ┃ ${" ".repeat(width - 6)} ┃`), "the blank source line keeps its row");
      assert.ok(lines.some((line) => line.startsWith(" ┃ last line ")));
    });
  }

  it("leaves the hint out when the frame is too narrow for it", async () => {
    const { renderMmrUserMessage } = await importSource("extensions/ampi-tui/transcript/messages.ts");
    assert.deepEqual(renderMmrUserMessage("ab", 9, 1, plainTheme, true), ["", " ┏━━━━━┓", " ┃ ab  ┃", " ┗━━━━━┛"]);
  });
});

/** Pi's TUI on the main screen, which has no scroll view: navigation draws but cannot scroll. */
function fakeTui() {
  const terminal = new Proxy({ columns: 80, rows: 24 }, { get: (target, name) => (name in target ? target[name] : () => {}) });
  const tui = new TuiMainScreen(terminal);
  tui.renders = 0;
  tui.requestRender = () => {
    tui.renders += 1;
  };
  return tui;
}

const editorTheme = {
  borderColor: (text) => text,
  selectList: {
    selectedPrefix: (text) => text,
    selectedText: (text) => text,
    description: (text) => text,
    scrollInfo: (text) => text,
    noMatch: (text) => text,
  },
};

/**
 * The extension in an interactive session whose context holds `entries`, with
 * the prompt box focused and one real user message component per user entry.
 */
async function startSession(entries, { idle = true } = {}) {
  const { createMmrTuiExtension } = await importSource("extensions/ampi-tui/index.ts");
  const mock = createMockPi();
  createMmrTuiExtension({ loadSettings: () => ({ enabled: true }) })(mock.pi);
  const context = createMockExtensionContext({ hasUI: true, entries, idle });
  await mock.handlers.get("session_start")({ type: "session_start", reason: "startup" }, context.ctx);
  const tui = fakeTui();
  context.footers[0](tui, undefined, { getGitBranch: () => undefined, onBranchChange: () => () => {} });
  const box = context.editors[0](tui, editorTheme, new KeybindingsManager({}));
  tui.setFocus(box);
  const components = entries.filter((entry) => entry.message?.role === "user").map((entry) => new UserMessageComponent(entry.message.content));
  const framed = () =>
    components.map((component) => component.render(40).map((line) => stripTerminalSequences(stripOsc133(line))).some((line) => line.includes("┏")));
  return {
    ...mock,
    ...context,
    tui,
    framed,
    send: (data) => context.terminalInput.send(data),
    stop: () => mock.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, context.ctx),
  };
}

const thread = [
  userEntry("u1", "first question"),
  assistantEntry("a1", "first answer"),
  userEntry("u2", "second question"),
  assistantEntry("a2", "second answer"),
  userEntry("u3", "third question"),
  assistantEntry("a3", "third answer"),
];

describe("ampi-tui message navigation in a session", () => {
  let session;
  afterEach(async () => {
    await session?.stop();
    session = undefined;
  });

  it("selects with Shift+Tab and Tab on an empty prompt, frames the selection and clears it past the newest", async () => {
    session = await startSession(thread);
    assert.deepEqual(session.framed(), [false, false, false]);
    assert.equal(session.send(SHIFT_TAB), true);
    assert.deepEqual(session.framed(), [false, false, true], "the newest message first");
    assert.equal(session.send(SHIFT_TAB), true);
    assert.deepEqual(session.framed(), [false, true, false]);
    assert.equal(session.send(TAB), true);
    assert.deepEqual(session.framed(), [false, false, true]);
    assert.equal(session.send(TAB), true);
    assert.deepEqual(session.framed(), [false, false, false], "Tab past the newest clears the selection");
    assert.equal(session.send(TAB), false, "without a selection Tab is Pi's again");
    assert.ok(session.tui.renders > 0, "every change asks for a redraw");
  });

  it("leaves Shift+Tab to Pi while the prompt has text or the thread has no messages", async () => {
    session = await startSession(thread);
    session.state.editorText = "draft";
    assert.equal(session.send(SHIFT_TAB), false, "Pi cycles the thinking level");
    assert.deepEqual(session.framed(), [false, false, false]);
    await session.stop();

    session = await startSession([]);
    assert.equal(session.send(SHIFT_TAB), false);
  });

  it("leaves e to the prompt without a selection and clears the selection on Esc or typed text", async () => {
    session = await startSession(thread);
    assert.equal(session.send("e"), false, "e is typed as usual");
    session.send(SHIFT_TAB);
    assert.equal(session.send(ESC), true, "Esc takes the selection away");
    assert.deepEqual(session.framed(), [false, false, false]);
    assert.equal(session.send(ESC), false, "a second Esc is Pi's again");

    session.send(SHIFT_TAB);
    session.state.editorText = "x";
    assert.deepEqual(session.framed(), [false, false, false], "text in the prompt ends the selection");
    session.state.editorText = "";
    assert.deepEqual(session.framed(), [false, false, false], "and it does not come back");
    assert.equal(session.send(TAB), false);
  });

  it("e runs the edit command for the selected entry and waits for a running turn", async () => {
    session = await startSession(thread, { idle: false });
    session.send(SHIFT_TAB);
    session.send(SHIFT_TAB);
    assert.equal(session.send("e"), false, "a running turn leaves e to the prompt");
    assert.deepEqual(session.calls.sendUserMessage, []);
    await session.stop();

    session = await startSession(thread);
    session.send(SHIFT_TAB);
    session.send(SHIFT_TAB);
    assert.equal(session.send("e"), true);
    assert.deepEqual(session.calls.sendUserMessage, [
      { content: "/ampi-edit-message u2", options: { expandPromptTemplates: true } },
    ]);
    assert.deepEqual(session.framed(), [false, false, false], "the selection ends with the edit");
  });

  it("registers the three commands with their keys and keeps the edit command out of the palette", async () => {
    session = await startSession(thread);
    const registry = await importSource("extensions/ampi-core/command-registry.ts");
    const keys = Object.fromEntries(
      registry
        .getMmrCommands()
        .filter((command) => command.id.startsWith("thread.") && command.id.endsWith("Message"))
        .map((command) => [command.id, command.defaultKey]),
    );
    assert.deepEqual(keys, {
      "thread.selectPreviousMessage": "shift+tab",
      "thread.selectNextMessage": "tab",
      "thread.editSelectedMessage": "e",
    });
    const { createMmrSlashPaletteCommands } = await importSource("extensions/ampi-tui/keys/commands.ts");
    session.pi.getCommands = () => [...session.commands.keys()].map((name) => ({ name }));
    const rows = createMmrSlashPaletteCommands({ pi: session.pi, getTui: () => undefined }).map((command) => command.id);
    assert.equal(rows.includes("pi.ampi-edit-message"), false);
    await session.stop();
    session = undefined;
    assert.equal(registry.getMmrCommands().some((command) => command.id.endsWith("Message")), false, "unregistered on shutdown");
  });
});

describe("ampi-tui edit message command", () => {
  /** A command context over `entries`, recording tree moves and the prompt text. */
  function commandContext(entries, { cancelled = false } = {}) {
    const record = { navigated: [], editorText: "", notifications: [] };
    const ctx = {
      sessionManager: { getEntry: (id) => entries.find((entry) => entry.id === id) },
      navigateTree: async (id) => {
        record.navigated.push(id);
        return { cancelled };
      },
      ui: {
        setEditorText: (text) => {
          record.editorText = text;
        },
        notify: (message, level) => record.notifications.push({ message, level }),
      },
    };
    return { ctx, record };
  }

  async function editCommand() {
    const { createMmrMessageNavigation } = await importSource("extensions/ampi-tui/transcript/navigation.ts");
    const mock = createMockPi();
    createMmrMessageNavigation(mock.pi);
    return mock.commands.get("ampi-edit-message");
  }

  it("moves the thread to the message through Pi's tree and puts its text into the prompt", async () => {
    const command = await editCommand();
    const { ctx, record } = commandContext(thread);
    await command.handler(" u2 ", ctx);
    assert.deepEqual(record.navigated, ["u2"], "Pi's tree navigation to a user message continues from before it");
    assert.equal(record.editorText, "second question");
  });

  it("keeps the prompt when the move is cancelled, and refuses entries that are not user messages", async () => {
    const command = await editCommand();
    const cancelled = commandContext(thread, { cancelled: true });
    await command.handler("u1", cancelled.ctx);
    assert.deepEqual(cancelled.record.navigated, ["u1"]);
    assert.equal(cancelled.record.editorText, "");

    for (const id of ["a1", "missing", ""]) {
      const { ctx, record } = commandContext(thread);
      await command.handler(id, ctx);
      assert.deepEqual(record.navigated, [], `nothing moves for "${id}"`);
      assert.equal(record.notifications[0]?.level, "warning");
    }
  });
});

describe("ampi-tui transcript reveal", () => {
  /** A fullscreen TUI whose scroll view draws `lines`, with scrolls recorded. */
  function scrollingTui(lines, { scrollTop, viewportHeight }) {
    const scrolls = [];
    const view = {
      scrollTop,
      viewportHeight,
      render: (width) => {
        assert.equal(width, 100, "the transcript is drawn at the terminal's width");
        return lines;
      },
      scrollTo: (row) => scrolls.push(row),
    };
    return { tui: { terminal: { columns: 100 }, getPrimaryScrollView: () => view }, scrolls };
  }

  const transcript = [
    ...Array.from({ length: 10 }, (_, row) => `line ${row}`),
    "",
    "\x1b]133;A\x07 \x1b[32m┏━━━━┓\x1b[0m ",
    " ┃ hi ┃",
    " ┗━━━━┛",
    ...Array.from({ length: 10 }, (_, row) => `after ${row}`),
  ];

  it("finds the selected frame's rows in the drawn transcript", async () => {
    const { locateMmrSelectedMessage } = await importSource("extensions/ampi-tui/transcript/navigation.ts");
    assert.deepEqual(locateMmrSelectedMessage(transcript), { start: 11, end: 13 });
    assert.equal(locateMmrSelectedMessage(["line", " ┃ hi"]), undefined);
  });

  it("scrolls the least distance that shows the rows", async () => {
    const { revealMmrTranscriptRows } = await importSource("extensions/ampi-tui/pi-compat/scroll.ts");
    const { locateMmrSelectedMessage } = await importSource("extensions/ampi-tui/transcript/navigation.ts");
    const below = scrollingTui(transcript, { scrollTop: 0, viewportHeight: 8 });
    assert.equal(revealMmrTranscriptRows(below.tui, locateMmrSelectedMessage), true);
    assert.deepEqual(below.scrolls, [6], "from below, the frame's bottom row lands on the view's last row");

    const above = scrollingTui(transcript, { scrollTop: 16, viewportHeight: 8 });
    revealMmrTranscriptRows(above.tui, locateMmrSelectedMessage);
    assert.deepEqual(above.scrolls, [11], "from above, the frame's top row lands on the view's first row");

    const inView = scrollingTui(transcript, { scrollTop: 9, viewportHeight: 8 });
    revealMmrTranscriptRows(inView.tui, locateMmrSelectedMessage);
    assert.deepEqual(inView.scrolls, [], "a frame in view stays where it is");

    const tall = scrollingTui(transcript, { scrollTop: 0, viewportHeight: 2 });
    revealMmrTranscriptRows(tall.tui, locateMmrSelectedMessage);
    assert.deepEqual(tall.scrolls, [11], "a frame taller than the view shows its top");
  });

  it("does nothing without a scroll view or a frame", async () => {
    const { revealMmrTranscriptRows } = await importSource("extensions/ampi-tui/pi-compat/scroll.ts");
    const { locateMmrSelectedMessage } = await importSource("extensions/ampi-tui/transcript/navigation.ts");
    assert.equal(revealMmrTranscriptRows(undefined, locateMmrSelectedMessage), false);
    assert.equal(revealMmrTranscriptRows(fakeTui(), locateMmrSelectedMessage), false);
    const plain = scrollingTui(["no frame"], { scrollTop: 0, viewportHeight: 8 });
    assert.equal(revealMmrTranscriptRows(plain.tui, locateMmrSelectedMessage), false);
    assert.deepEqual(plain.scrolls, []);
  });
});
