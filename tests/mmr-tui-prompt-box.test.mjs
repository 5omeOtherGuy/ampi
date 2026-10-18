// Render and key tests for ampi-tui's prompt box, drawn by Pi's real editor
// classes. Render fixtures live in tests/fixtures/mmr-tui-prompt-box/: each
// holds the plain rendering for review followed by the exact lines with ANSI
// kept, at 80x24 and 140x44. PI_MMR_UPDATE_FIXTURES=1 rewrites them; review
// the diff before committing.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import { stripTerminalSequences, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { isolateAnimationEnv, setNoAnimation } from "./helpers/animation-env.mjs";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);
isolateAnimationEnv();

const FIXTURE_DIR = path.join(import.meta.dirname, "fixtures/mmr-tui-prompt-box");
const UPDATE_FIXTURES = process.env.PI_MMR_UPDATE_FIXTURES === "1";
const SIZES = [
  [80, 24],
  [140, 44],
];

// Loaded up front: the cases below build their statuses at module level.
const box = await importSource("extensions/ampi-tui/editor/prompt-box.ts");
const { createMmrThreadStatusReducer } = await importSource("extensions/ampi-core/thread-status.ts");
const { createMmrPromptBoxInstall } = await importSource("extensions/ampi-tui/editor/install.ts");
const help = await importSource("extensions/ampi-tui/editor/help.ts");
const { createMmrTuiCommands } = await importSource("extensions/ampi-tui/keys/commands.ts");
const { resolveMmrKeymap } = await importSource("extensions/ampi-core/keymap.ts");
// Pi's app keybindings (Esc as app.interrupt and so on) are not exported from the package entry.
const piDist = path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { KeybindingsManager: PiKeybindings } = await import(pathToFileURL(path.join(piDist, "core/keybindings.js")).href);

/** Theme tokens as distinct 256-colour codes, so fixtures show which token styled what. */
const TOKEN_CODES = { border: 244, dim: 242, muted: 246, accent: 6, error: 1, warning: 3 };
const theme = { fg: (token, text) => `\x1b[38;5;${TOKEN_CODES[token]}m${text}\x1b[39m` };

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

function status(...events) {
  const reducer = createMmrThreadStatusReducer();
  for (const event of events) reducer.apply(event);
  return reducer.status;
}

/** The help's rows as a session with ampi-core and the default keymap lists them. */
function defaultHelpEntries() {
  const commands = createMmrTuiCommands({ getTui: () => undefined });
  const keymap = resolveMmrKeymap({ defaults: Object.fromEntries(commands.map((command) => [command.id, command.defaultKey ?? null])) });
  return help.buildMmrShortcutHelpEntries({ keymap, commands, modeKeys: true });
}

/** `shortcuts`: open the shortcuts help with this content. */
function makeBox({ rows = 24, text = "", slots = {}, onDequeued, steerQueued, shortcuts } = {}) {
  const terminal = new Proxy({ columns: 140, rows }, { get: (target, name) => (name in target ? target[name] : () => {}) });
  const tui = new TuiMainScreen(terminal);
  const current = { mode: "medium", status: status(), waveFrame: 0, location: "/work/demo (main)", overlay: false, ...slots };
  const host = { slots: () => current, theme: () => theme, dequeued: onDequeued, steerQueued, help: shortcuts ? () => shortcuts : undefined };
  const editor = new box.MmrPromptBox(tui, editorTheme, new PiKeybindings({}), host);
  editor.setText(text);
  if (shortcuts) editor.setHelpOpen(true);
  return { editor, slots: current, terminal };
}

const plain = (line) => stripTerminalSequences(line);
const lines30 = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");

const CASES = {
  empty: {},
  "one-line": { text: "Fix the flaky parser test" },
  multiline: { text: "first line\nsecond line\nthird\nfourth\nfifth line" },
  wrapped: { text: `${"A long request that keeps going ".repeat(7).trim()}.` },
  "max-height": { text: lines30 },
  "mode-low": { slots: { mode: "low" } },
  "mode-medium": { slots: { mode: "medium", gauge: "$0.02" } },
  "mode-high": { slots: { mode: "high" } },
  "mode-ultra": { slots: { mode: "ultra" } },
  "mode-free": { slots: { mode: "free" } },
  "status-thinking": {
    slots: {
      gauge: "$····",
      waveFrame: 1,
      status: status({ type: "turnStart" }, { type: "messageUpdate", content: "thinking", outputTokens: 23 }),
    },
  },
  "status-running-tools": {
    slots: {
      gauge: "$0.003",
      waveFrame: 2,
      status: status({ type: "turnStart" }, { type: "toolStart", toolCallId: "t1", toolName: "bash" }),
    },
  },
  "status-waiting-approval": {
    slots: { gauge: "$0.02", status: status({ type: "turnStart" }, { type: "approvalRequest", requestId: "a1" }) },
  },
  "status-queued": {
    text: "and also check the docs",
    slots: {
      gauge: "$0.02",
      status: status({ type: "turnStart" }, { type: "messageUpdate", content: "text", outputTokens: 1234 }, { type: "queue", count: 1 }),
    },
  },
  "status-quit-hint": {
    slots: { gauge: "$1.25", status: status({ type: "quitPressed", expiresAt: 1500, now: 0 }) },
  },
  overlay: {
    text: "draft",
    slots: { gauge: "$0.02", overlay: true, status: status({ type: "turnStart" }, { type: "messageUpdate", content: "text" }) },
  },
};

function renderCase({ text, slots }, width, rows) {
  return makeBox({ rows, text, slots }).editor.render(width);
}

function fixtureText(name, renders) {
  const parts = [`# ${name}`];
  for (const { width, rows, lines } of renders) {
    parts.push("", `## ${width}x${rows}`, ...lines.map(plain), "", ...lines.map((line) => JSON.stringify(line)));
  }
  return `${parts.join("\n")}\n`;
}

function assertFixture(name, renders) {
  const file = path.join(FIXTURE_DIR, `${name}.txt`);
  const actual = fixtureText(name, renders);
  if (UPDATE_FIXTURES) {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(file, actual);
    return;
  }
  assert.ok(existsSync(file), `missing fixture ${file}; run with PI_MMR_UPDATE_FIXTURES=1`);
  assert.equal(actual, readFileSync(file, "utf8"), `fixture drift in ${file}; rerun with PI_MMR_UPDATE_FIXTURES=1 and review`);
}

describe("ampi-tui prompt box: render fixtures", () => {
  for (const [name, spec] of Object.entries(CASES)) {
    it(name, () => {
      const renders = SIZES.map(([width, rows]) => ({ width, rows, lines: renderCase(spec, width, rows) }));
      for (const { width, lines } of renders) {
        for (const line of lines) assert.equal(visibleWidth(line), width, `every row fills ${width} columns: ${plain(line)}`);
      }
      assertFixture(name, renders);
    });
  }

  it("narrow: the path shrinks from the left, then goes, and the status keeps its room", () => {
    const spec = {
      slots: {
        location: "/srv/projects/a-rather-long-directory-name/nested/deeper (feature/prompt-box-borders)",
        status: status({ type: "turnStart" }, { type: "messageUpdate", content: "thinking", outputTokens: 23 }),
      },
    };
    const renders = [
      [80, 24],
      [56, 24],
      [36, 24],
    ].map(([width, rows]) => ({ width, rows, lines: renderCase(spec, width, rows) }));
    const bottoms = renders.map(({ lines }) => plain(lines.at(-1)));
    assert.match(bottoms[0], /^╰ ∼ Thinking 23 tok · Enter to steer ─+ …[^ ]*deeper \(feature\/prompt-box-borders\) ─╯$/);
    // 56 columns: 53 between the corners and one line cell, 36 for the status, 3 for the spaces and "─"
    // around the path, which keeps its last 13 columns after "…".
    assert.match(bottoms[1], /^╰ ∼ Thinking 23 tok · Enter to steer ─ …-box-borders\) ─╯$/);
    assert.match(bottoms[2], /^╰ ∼ Thinking 23 tok · Enter to s… ─╯$/, "no room for the path; the hint is cut");
    for (const { width, lines } of renders) assert.equal(visibleWidth(lines.at(-1)), width);
    assertFixture("narrow", renders);
  });

  it("drops the frame below 4 columns and shows only the text", () => {
    const { editor } = makeBox({ text: "ab" });
    const lines = editor.render(3);
    assert.ok(lines.length > 0);
    assert.equal(editor.renderedHeight(), lines.length);
    assert.equal(lines.map(plain).join("").replace(/ /g, ""), "ab", "text rows only: no border or marker");
    for (const row of lines) assert.ok(visibleWidth(row) <= 3, JSON.stringify(row));
  });
});

describe("ampi-tui prompt box: geometry", () => {
  it("grows from 3 text rows to a third of the terminal height, then scrolls with the cursor", () => {
    // 24 rows: 24 / 3 = 8 text rows; 44 rows: 44 / 3 = 14.67, so 14.
    assert.equal(box.mmrPromptBoxMaxRows(24), 8);
    assert.equal(box.mmrPromptBoxMaxRows(44), 14);
    assert.equal(box.mmrPromptBoxMaxRows(9), 3, "never below the 3-row minimum");
    const cases = [
      [24, "", 3],
      [24, "a\nb\nc", 3],
      [24, "a\nb\nc\nd", 4],
      [24, lines30, 8],
      [44, lines30, 14],
    ];
    for (const [rows, text, textRows] of cases) {
      const { editor } = makeBox({ rows, text });
      const lines = editor.render(80);
      assert.equal(lines.length, textRows + 2, `${rows} rows, ${JSON.stringify(text.slice(0, 8))}`);
      assert.equal(editor.renderedHeight(), lines.length);
    }
    const scrolled = makeBox({ rows: 44, text: lines30 }).editor.render(140).map(plain);
    assert.match(scrolled[1], /^│ line 17 +│$/, "the last 14 of 30 lines show, the cursor's line last");
    assert.match(scrolled[14], /^│ line 30/);
  });

  it("draws a rounded frame over the full width with one column of padding", () => {
    for (const width of [80, 140]) {
      const lines = makeBox({ text: "hello\nworld" }).editor.render(width).map(plain);
      assert.equal(lines[0][0], "╭");
      assert.equal(lines[0].at(-1), "╮");
      assert.equal(lines.at(-1)[0], "╰");
      assert.equal(lines.at(-1).at(-1), "╯");
      for (const row of lines.slice(1, -1)) {
        assert.equal(row[0], "│");
        assert.equal(row.at(-1), "│");
      }
      assert.equal(lines[1].slice(0, 7), "│ hello", "text starts at column 2");
    }
  });

  it("wraps like Pi's editor inside the frame: 76 text columns at 80", () => {
    const lines = makeBox({ text: "x".repeat(100) }).editor.render(80).map(plain);
    assert.equal(lines[1], `│ ${"x".repeat(76)} │`);
    assert.match(lines[2], /^│ x{24}/);
  });

  it("puts the mode label and gauge at the right of the top border", () => {
    const width = 140;
    const top = plain(makeBox({ slots: { gauge: "$0.02" } }).editor.render(width)[0]);
    // "╭" + fill + " $0.02 ─ medium ─╮": the label ends 3 columns before the edge.
    assert.equal(top.indexOf("medium"), width - 3 - "medium".length);
    assert.equal(top.indexOf("$0.02"), width - 3 - "medium".length - 3 - "$0.02".length);
    const narrow = plain(makeBox({ slots: { gauge: "$0.02" } }).editor.render(12)[0]);
    // 12 columns leave 9 for the slot after the corners and one line cell: " medium ─" fits, the gauge does not.
    assert.equal(narrow, "╭─ medium ─╮", "the gauge goes first");
  });

  it("shows no label without a mode and the free mode in the border colour", () => {
    assert.equal(plain(makeBox({ slots: { mode: undefined } }).editor.render(20)[0]), `╭${"─".repeat(18)}╮`);
    const free = makeBox({ slots: { mode: "free" } }).editor.render(40)[0];
    // 40 columns: corners, " free ─" (7) and 31 line cells, all one run in the border token.
    assert.equal(free, `\x1b[38;5;244m╭${"─".repeat(31)} free ─╮\x1b[39m`);
  });

  it("colours each mode label in truecolor", () => {
    const expected = { low: "255;215;0", medium: "61;255;166", high: "61;212;255", ultra: "216;179;255" };
    for (const [mode, rgb] of Object.entries(expected)) {
      const top = makeBox({ slots: { mode } }).editor.render(80)[0];
      assert.ok(top.includes(`\x1b[38;2;${rgb}m${mode}\x1b[39m`), mode);
    }
  });

  it("dims the whole frame under an overlay, keeping only the mode colour", () => {
    const lines = makeBox({ slots: { overlay: true, gauge: "$0.02" } }).editor.render(80);
    for (const index of [0, 1, lines.length - 1]) assert.ok(lines[index].startsWith("\x1b[2m"), `row ${index}`);
    assert.ok(!lines[0].includes("38;5;"), "no theme colours inside the dim run");
    assert.ok(lines[0].includes("\x1b[38;2;61;255;166mmedium\x1b[39m"));
  });

  it("draws the frame in Pi's border colour while the prompt is a `!` shell command", () => {
    const shell = (text) => `\x1b[35m${text}\x1b[39m`;
    const render = (text) => {
      const { editor } = makeBox({ text });
      editor.borderColor = shell; // as Pi sets it for a `!` prompt
      return editor.render(80);
    };
    const bash = render("  !ls");
    for (const index of [0, 1, bash.length - 1]) assert.ok(bash[index].startsWith("\x1b[35m"), `row ${index}`);
    assert.ok(!bash[0].includes("\x1b[38;5;244m"), "no theme border token");
    assert.ok(bash[0].includes("\x1b[38;2;61;255;166mmedium"), "the mode keeps its colour");
    assert.ok(bash.at(-1).includes("\x1b[38;5;242m/work/demo (main)"), "the path stays dim");
    assert.ok(render("ls !")[0].startsWith("\x1b[38;5;244m"), "only a leading `!` counts");
  });

  it("steps the wave glyph only while a turn runs", () => {
    const busy = status({ type: "turnStart" });
    const glyphs = [0, 1, 2, 3].map((waveFrame) => plain(makeBox({ slots: { status: busy, waveFrame } }).editor.render(80).at(-1))[2]);
    assert.deepEqual(glyphs, ["∼", "≈", "≋", "∼"]);
    const idle = plain(makeBox({ slots: { waveFrame: 1 } }).editor.render(80).at(-1));
    assert.match(idle, /^╰─+ \/work\/demo \(main\) ─╯$/);
  });

  it("formats the session cost for the gauge", () => {
    assert.equal(box.formatMmrSessionCost(undefined), "$····");
    assert.equal(box.formatMmrSessionCost(0), "$0.00");
    assert.equal(box.formatMmrSessionCost(0.0031), "$0.003");
    assert.equal(box.formatMmrSessionCost(0.0234), "$0.02");
    assert.equal(box.formatMmrSessionCost(6.111), "$6.11");
  });
});

describe("ampi-tui prompt box: keys", () => {
  it("submits on Enter", () => {
    const { editor } = makeBox({ text: "ship it" });
    const submitted = [];
    editor.onSubmit = (text) => submitted.push(text);
    editor.handleInput("\r");
    assert.deepEqual(submitted, ["ship it"]);
  });

  it("inserts a newline on Alt+Enter instead of queueing a follow-up, like Shift+Enter and Ctrl+J", () => {
    for (const key of ["\x1b\r", "\x1b[13;3u", "\x1b[13;2u", "\n"]) {
      const { editor } = makeBox({ text: "one" });
      const followUps = [];
      editor.onAction("app.message.followUp", () => followUps.push(key));
      editor.onSubmit = () => assert.fail("no submit");
      editor.handleInput(key);
      editor.handleInput("t");
      assert.equal(editor.getText(), "one\nt", JSON.stringify(key));
      assert.deepEqual(followUps, []);
    }
  });

  it("clears the prompt on Esc and leaves Esc on an empty prompt to Pi", () => {
    const { editor } = makeBox({ text: "draft" });
    let piEscapes = 0;
    editor.onEscape = () => {
      piEscapes += 1;
    };
    editor.handleInput("\x1b");
    assert.equal(editor.getText(), "");
    assert.equal(piEscapes, 0);
    editor.handleInput("\x1b");
    assert.equal(piEscapes, 1, "Pi keeps its own Esc on an empty prompt");
  });

  it("takes queued messages back on Backspace with an empty prompt", () => {
    let dequeued = 0;
    let told = 0;
    const queued = status({ type: "turnStart" }, { type: "queue", count: 2 });
    const { editor, slots } = makeBox({ slots: { status: queued }, onDequeued: () => (told += 1) });
    editor.onAction("app.message.dequeue", () => {
      dequeued += 1;
    });
    editor.handleInput("\x7f");
    assert.deepEqual([dequeued, told], [1, 1]);

    editor.setText("ab");
    editor.handleInput("\x7f");
    assert.equal(editor.getText(), "a", "with text Backspace deletes");
    slots.status = status({ type: "turnStart" });
    editor.setText("");
    editor.handleInput("\x7f");
    assert.equal(dequeued, 1, "nothing queued: nothing to take back");
  });

  it("steers with the next queued message on Enter with an empty prompt", () => {
    let queuedFollowUps = 1;
    let steered = 0;
    const submitted = [];
    const { editor } = makeBox({
      steerQueued: () => {
        if (queuedFollowUps === 0) return false;
        queuedFollowUps -= 1;
        steered += 1;
        return true;
      },
    });
    editor.onSubmit = (text) => submitted.push(text);
    editor.handleInput("\r");
    assert.equal(steered, 1);
    editor.handleInput("\r");
    assert.deepEqual([steered, submitted], [1, [""]], "nothing left to steer: Enter goes to Pi's editor");
    editor.setText("new message");
    queuedFollowUps = 1;
    editor.handleInput("\r");
    assert.deepEqual([steered, submitted], [1, ["", "new message"]], "with text Enter sends the prompt");
  });

  it("pages by the box's visible rows on PageUp", () => {
    // 44 rows: the box shows 14 text rows, so PageUp from line 30 lands on line 16
    // (Pi's own rule for a 44-row terminal would page by 13, to line 17).
    const { editor } = makeBox({ rows: 44, text: lines30 });
    editor.render(140);
    editor.handleInput("\x1b[5~");
    editor.handleInput("X");
    assert.equal(editor.getText().split("\n")[15].includes("X"), true, editor.getText().split("\n").slice(14, 17).join(" | "));
  });

  it("keeps one column of padding when Pi copies its editor's padding", () => {
    const { editor } = makeBox({ text: "x" });
    editor.setPaddingX(0);
    assert.equal(plain(editor.render(80)[1]).slice(0, 3), "│ x");
  });
});

describe("ampi-tui prompt box: shortcuts help", () => {
  const note = help.MMR_SHORTCUT_HELP_TMUX_NOTE;
  const rule = (width) => `│ ${"─".repeat(width - 4)} │`;

  it("lists the fixed keys, the leader and every bound command with its effective key", () => {
    const rows = (entries) => entries.map(({ key, label }) => `${key} ${label}`);
    assert.deepEqual(rows(defaultHelpEntries()), [
      "Ctrl+S switch modes",
      "Alt+D toggle thinking",
      "Alt+Enter newline",
      "@ mention files",
      "Ctrl+X leader key",
      "Ctrl+O open command palette",
      "/ open command palette",
      "Esc Esc interrupt",
      "Ctrl+C Ctrl+C quit",
      "Home/End scroll to top/bottom",
      "Ctrl+G open in editor",
      "Ctrl+R history",
      "Alt+T toggle details",
      "? toggle shortcuts help",
    ]);

    const commands = createMmrTuiCommands({ getTui: () => undefined });
    const keymap = resolveMmrKeymap({
      defaults: Object.fromEntries(commands.map((command) => [command.id, command.defaultKey ?? null])),
      overrides: {
        "ampi.showVersion": "<leader>v",
        "ampi.palette": null,
        "thread.scrollToTop": ["home", "ctrl+up"],
        "prompt.toggleHelp": ["?", "f1"],
        "mode.toggle": "alt+m",
      },
      leader: "alt+x",
    });
    // Keys of one command are joined with "or"; a command with two keys shares no row.
    // The mode dial's key is listed once, as the first mode key, and only with ampi-core.
    const withCore = rows(help.buildMmrShortcutHelpEntries({ keymap, commands, modeKeys: true }));
    assert.deepEqual(withCore.slice(0, 2), ["Alt+M switch modes", "Alt+D toggle thinking"]);
    assert.equal(withCore.filter((row) => row.startsWith("Alt+M ")).length, 1);
    assert.deepEqual(rows(help.buildMmrShortcutHelpEntries({ keymap, commands, modeKeys: false })), [
      "Alt+Enter newline",
      "@ mention files",
      "Alt+X leader key",
      "/ open command palette",
      "Esc Esc interrupt",
      "Ctrl+C Ctrl+C quit",
      "Home or Ctrl+Up scroll to top",
      "End scroll to bottom",
      "Ctrl+G open in editor",
      "Ctrl+R history",
      "Alt+X v show version",
      "Alt+T toggle details",
      "? or F1 toggle shortcuts help",
    ]);
    assert.deepEqual(rows(help.buildMmrShortcutHelpEntries({ commands, modeKeys: false })), ["Alt+Enter newline", "@ mention files"]);
  });

  it("render fixture: two columns at 80 and 140, one column at 50, the rule inside the frame", () => {
    const shortcuts = { entries: defaultHelpEntries(), note };
    const renders = [
      [80, 24],
      [80, 44],
      [140, 44],
      [50, 24],
    ].map(([width, rows]) => ({ width, rows, lines: makeBox({ rows, shortcuts }).editor.render(width) }));
    for (const { width, rows, lines } of renders) {
      const text = lines.map(plain);
      for (const line of lines) assert.equal(visibleWidth(line), width, `${width}x${rows} row fills its width: ${plain(line)}`);
      assert.ok(text.includes(rule(width)), `${width}x${rows}: a rule across the text area, inside the side borders`);
      assert.equal(text[1].slice(0, 9), "│ Ctrl+S ", "the help starts right under the top border");
    }
    const [small, tall, wide, narrow] = renders.map(({ lines }) => lines.map(plain));
    for (const lines of [small, tall, wide]) {
      // Column 34 of the box: the frame, one column of padding, then 32 columns of the first entry.
      assert.equal(lines[1].indexOf("Alt+D toggle thinking"), 34);
    }
    for (const lines of [tall, wide]) {
      assert.match(lines[7], /^│ Alt\+T toggle details +\? toggle shortcuts help +│$/);
      assert.equal(lines[8], `│ ${note.padEnd(lines[8].length - 4)} │`, "the note, whole and inside the frame");
      assert.equal(lines[9], rule(lines[9].length));
    }
    // 80x24 has room for six rows: the note goes, and the last entry before the toggle makes way for it.
    assert.equal(small[6].indexOf("? toggle shortcuts help"), 34);
    assert.equal(small[7], rule(80));
    assert.ok(!small.some((line) => line.includes("Alt+T") || line.includes("extended-keys")));
    assert.match(narrow[1], /^│ Ctrl\+S switch modes +│$/, "one entry per row when two columns do not fit");
    assert.match(narrow[2], /^│ Alt\+D toggle thinking +│$/);
    assertFixture("help", renders);
  });

  it("grows the box by the help and keeps within a third of the terminal height", () => {
    const shortcuts = { entries: defaultHelpEntries(), note };
    // 44 rows: 7 rows, the note and the rule over the 3 text rows, all within 14.
    const tall = makeBox({ rows: 44, shortcuts }).editor;
    assert.equal(tall.render(140).length, 1 + 9 + 3 + 1);
    assert.equal(tall.renderedHeight(), 14);
    // 24 rows: at most 8 rows inside the frame, so the text area shrinks to one row.
    assert.equal(makeBox({ rows: 24, shortcuts }).editor.render(80).length, 1 + 7 + 1 + 1);
    // One column at 50 needs 14 rows: the note goes, then entries from the end
    // except the help's own toggle, and the rule stays.
    const narrow = makeBox({ rows: 24, shortcuts }).editor.render(50).map(plain);
    assert.equal(narrow.length, 10);
    assert.match(narrow[5], /^│ Ctrl\+X leader key +│$/);
    assert.match(narrow[6], /^│ \? toggle shortcuts help +│$/);
    assert.equal(narrow[7], rule(50));
    assert.ok(!narrow.some((line) => line.includes("extended-keys")));
    // Without the note the rule follows the rows directly.
    const plainHelp = makeBox({ rows: 44, shortcuts: { entries: defaultHelpEntries() } }).editor.render(140).map(plain);
    assert.equal(plainHelp[8], rule(140));
  });

  it("uses two columns only when the widest entry is under 32 columns and the second column fits", () => {
    const entries = (width) => [
      { key: "K", label: "x".repeat(width - 2) },
      { key: "A", label: "b" },
    ];
    const render = (list, width) => help.renderMmrShortcutHelp({ entries: list }, width, theme).map(plain);
    assert.equal(render(entries(31), 63).length, 2, "31 columns wide at 32 + 31: one row and the rule");
    assert.equal(render(entries(31), 62).length, 3, "one column less: one entry per row");
    assert.equal(render(entries(32), 200).length, 3, "a 32-column entry never shares a row");

  });

  it("closes on Esc without clearing anything or reaching Pi", () => {
    const { editor } = makeBox({ shortcuts: { entries: defaultHelpEntries() } });
    let piEscapes = 0;
    editor.onEscape = () => {
      piEscapes += 1;
    };
    editor.handleInput("\x1b");
    assert.equal(editor.isHelpOpen(), false);
    assert.equal(piEscapes, 0);
    assert.equal(editor.render(80).length, 5, "back to the empty box");
  });

  it("closes on any other key, which then does what it always does", () => {
    const { editor } = makeBox({ shortcuts: { entries: defaultHelpEntries() } });
    editor.handleInput("x");
    assert.equal(editor.isHelpOpen(), false);
    assert.equal(editor.getText(), "x");
    assert.equal(plain(editor.render(80)[1]).slice(0, 4), "│ x ");
  });

  it("closes when text arrives from elsewhere", () => {
    const { editor } = makeBox({ shortcuts: { entries: defaultHelpEntries() } });
    editor.setText("from the external editor");
    assert.equal(plain(editor.render(80)[1]).slice(0, 8), "│ from t");
    assert.equal(editor.isHelpOpen(), false);
  });
});

describe("ampi-tui prompt box: installation", () => {
  function install({ busy = false, entries = [] } = {}) {
    const intervals = [];
    const feed = {
      status: busy ? status({ type: "turnStart" }) : status(),
      refreshQueue() {},
    };
    const { pi } = createMockPi();
    const context = createMockExtensionContext({ cwd: "/work/demo", entries });
    context.ctx.ui.theme = theme;
    const promptBox = createMmrPromptBoxInstall(pi, feed, {
      setInterval: (callback, ms) => {
        const interval = { callback, ms, cleared: false };
        intervals.push(interval);
        return interval;
      },
      clearInterval: (interval) => {
        interval.cleared = true;
      },
    });
    promptBox.start(context.ctx, () => ({ getGitBranch: () => "main", onBranchChange: () => () => {} }));
    const terminal = new Proxy({ columns: 80, rows: 24 }, { get: (target, name) => (name in target ? target[name] : () => {}) });
    const tui = new TuiMainScreen(terminal);
    let renders = 0;
    tui.requestRender = () => {
      renders += 1;
    };
    const editor = context.editors[0](tui, editorTheme, new PiKeybindings({}));
    return { promptBox, feed, editor, intervals, context, renders: () => renders };
  }

  it("steps the wave glyph every 200 ms while busy and stops when idle", () => {
    const t = install();
    t.feed.status = status({ type: "turnStart" });
    t.promptBox.statusChanged();
    assert.equal(t.intervals.length, 1);
    assert.equal(t.intervals[0].ms, 200);
    const glyph = () => plain(t.editor.render(80).at(-1))[2];
    assert.equal(glyph(), "∼");
    t.intervals[0].callback();
    assert.equal(glyph(), "≈");
    t.intervals[0].callback();
    t.intervals[0].callback();
    assert.equal(glyph(), "∼", "three frames, then around again");
    t.promptBox.statusChanged();
    assert.equal(t.intervals.length, 1, "one timer per busy stretch");

    t.feed.status = status();
    t.promptBox.statusChanged();
    assert.equal(t.intervals[0].cleared, true);
  });

  it("keeps the wave on its first glyph with no timer when NO_ANIMATION is set", (t) => {
    setNoAnimation(t);
    const box = install();
    box.feed.status = status({ type: "turnStart" });
    box.promptBox.statusChanged();
    assert.equal(box.intervals.length, 0);
    assert.equal(plain(box.editor.render(80).at(-1))[2], "∼");
  });

  it("reads the gauge from the session's assistant messages", () => {
    const usage = (total) => ({ type: "message", message: { role: "assistant", usage: { cost: { total } } } });
    const top = (t) => plain(t.editor.render(80)[0]);
    assert.ok(!top(install()).includes("$"), "fresh and idle: no gauge");
    assert.match(top(install({ busy: true })), / \$···· ─/, "first turn, no response yet");
    assert.match(top(install({ entries: [usage(0.001), { type: "message", message: { role: "user" } }, usage(0.002)] })), / \$0\.003 ─/);
  });

  it("dims the frame while an overlay is open and reports its height", () => {
    const t = install();
    assert.equal(t.promptBox.renderedHeight(), undefined, "nothing drawn yet");
    t.editor.render(80);
    assert.equal(t.promptBox.renderedHeight(), 5);
    t.promptBox.setOverlayOpen(true);
    assert.ok(t.editor.render(80)[0].startsWith("\x1b[2m"));
    t.promptBox.setOverlayOpen(false);
    assert.ok(!t.editor.render(80)[0].startsWith("\x1b[2m"));
  });

  it("toggles the help with its rows and checks tmux once, adding the note when extended keys are off", async () => {
    for (const [value, noted] of [
      ["off", true],
      ["on", false],
      ["always", false],
      [undefined, false],
    ]) {
      let checks = 0;
      const { pi } = createMockPi();
      const context = createMockExtensionContext({ cwd: "/work/demo" });
      context.ctx.ui.theme = theme;
      const promptBox = createMmrPromptBoxInstall(pi, { status: status(), refreshQueue() {} }, {
        helpEntries: () => [{ key: "?", label: "toggle shortcuts help" }],
        tmuxExtendedKeys: async () => {
          checks += 1;
          return value;
        },
      });
      promptBox.start(context.ctx, () => undefined);
      const terminal = new Proxy({ columns: 80, rows: 24 }, { get: (target, name) => (name in target ? target[name] : () => {}) });
      const tui = new TuiMainScreen(terminal);
      tui.requestRender = () => {};
      const editor = context.editors[0](tui, editorTheme, new PiKeybindings({}));
      assert.equal(checks, 0, "nothing runs before the help opens");

      promptBox.toggleHelp();
      await new Promise((resolve) => setImmediate(resolve));
      let lines = editor.render(80).map(plain);
      assert.match(lines[1], /^│ \? toggle shortcuts help +│$/, String(value));
      assert.equal(lines.some((line) => line.includes("extended-keys")), noted, String(value));
      promptBox.toggleHelp();
      assert.equal(editor.render(80).length, 5, "a second toggle closes it");
      promptBox.toggleHelp();
      assert.equal(checks, 1, "tmux is asked once");

      context.state.editorText = "draft";
      promptBox.clearPrompt();
      lines = editor.render(80).map(plain);
      assert.equal(lines.length, 5, "the first Esc of Esc Esc closes the help too");
      promptBox.stop();
    }
  });

  it("hides Pi's working row and clears the prompt on request", () => {
    const t = install();
    assert.deepEqual(t.context.workingVisible, [false]);
    t.context.state.editorText = "draft";
    t.promptBox.clearPrompt();
    assert.equal(t.context.state.editorText, "");
  });
});
