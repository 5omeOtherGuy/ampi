import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext } from "./helpers/pi-stub.mjs";
import { createAnsiTheme, expectFixture, plain } from "./helpers/tui-render.mjs";

after(cleanupLoadedSource);

let picker;
const theme = createAnsiTheme();

before(async () => {
  picker = await importSource("extensions/ampi-tui/overlays/thread-picker.ts");
});

const KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
  enter: "\r",
  esc: "\x1b",
  backspace: "\x7f",
  altW: "\x1bw",
  altA: "\x1ba",
  ctrlT: "\x14",
  ctrlP: "\x10",
  ctrlN: "\x0e",
};

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(NOW - ms);

/** A Pi session listing entry. */
function session(id, { name, firstMessage = "", modified, cwd = "/work/parser" }) {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd,
    name,
    created: ago(30 * DAY),
    modified,
    messageCount: 2,
    firstMessage,
    allMessagesText: firstMessage,
  };
}

const RENAME = "Rename the parser module and update its imports";

function workspaceSessions() {
  return [
    session("s-b", { firstMessage: "Why does the parser drop\ntrailing comments?", modified: ago(3 * HOUR + 10 * MINUTE) }),
    session("s-current", { firstMessage: RENAME, modified: ago(2 * DAY + 5 * MINUTE) }),
    session("s-arch", { name: "Old parser experiment", firstMessage: "Try a new parser", modified: ago(10 * DAY) }),
    session("s-a", { name: "Parser cleanup", firstMessage: "Clean up the parser", modified: ago(51 * MINUTE) }),
    session("s-c", { modified: ago(30_000) }),
  ];
}

function allSessions() {
  return [
    ...workspaceSessions(),
    session("s-other", { firstMessage: "Deploy the website preview", modified: ago(20 * MINUTE), cwd: "/work/site" }),
    // The same session found at an older path: listed once, with the newer record.
    { ...session("s-a", { name: "Parser cleanup", modified: ago(5 * DAY) }), path: "/sessions/old/s-a.jsonl" },
  ];
}

const THREADS = { "s-arch": { archived: "2026-10-10T10:00:00.000Z" }, "s-a": { labels: ["parser"] } };

const ASSISTANT_REPLY = "Renamed **parser** to `syntax`.\n\n- updated four imports\n- kept the old name as an alias";

function previews() {
  const steps = [];
  for (let step = 1; step <= 4; step++) {
    steps.push({ role: "user", content: `Do step ${step}` });
    steps.push({ role: "assistant", content: [{ type: "text", text: `Finished step ${step}. The tests pass and nothing else changed.` }] });
  }
  return {
    "s-current": [
      { role: "user", text: RENAME },
      { role: "assistant", text: ASSISTANT_REPLY },
    ],
    "s-a": picker.lastMmrThreadExchanges(steps),
  };
}

/** A Markdown theme with a few visible styles, so the fixtures show the Markdown rendering. */
const MARKDOWN_THEME = {
  heading: (text) => `\x1b[1;36m${text}\x1b[22;39m`,
  link: (text) => text,
  linkUrl: (text) => text,
  code: (text) => `\x1b[33m${text}\x1b[39m`,
  codeBlock: (text) => text,
  codeBlockBorder: (text) => text,
  quote: (text) => text,
  quoteBorder: (text) => text,
  hr: (text) => text,
  listBullet: (text) => text,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
  italic: (text) => `\x1b[3m${text}\x1b[23m`,
  strikethrough: (text) => text,
  underline: (text) => text,
};

function open({ variant = "switch", sessions = workspaceSessions(), all = allSessions(), threads = THREADS, terminalRows = 44 } = {}) {
  const closed = [];
  const loads = [];
  const previewReads = [];
  const renders = { count: 0 };
  let resolveAll;
  let rows = terminalRows;
  const component = new picker.MmrThreadPicker({
    variant,
    theme,
    markdownTheme: MARKDOWN_THEME,
    sessions,
    load: (scope) => {
      loads.push(scope);
      return new Promise((resolve) => {
        resolveAll = () => resolve(all);
      });
    },
    threads,
    currentId: "s-current",
    now: () => NOW,
    loadPreview: (row) => {
      previewReads.push(row.id);
      return previews()[row.id] ?? [];
    },
    onClose: (row) => closed.push(row),
    terminalRows: () => rows,
    requestRender: () => {
      renders.count += 1;
    },
  });
  const type = (text) => {
    for (const character of text) component.handleInput(character);
  };
  // Pi sizes the overlay from its options: the terminal less two columns on each side.
  const render = (columns, height = columns >= 120 ? 44 : 24) => {
    rows = height;
    return component.render(columns - 4);
  };
  const finishLoad = async () => {
    resolveAll();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { component, closed, loads, previewReads, renders, type, render, finishLoad };
}

const ids = (component) => component.getRows().map((row) => row.id);

describe("ampi-tui thread picker list", () => {
  it("formats relative times in whole minutes, hours, days, months and years", () => {
    const format = (ms) => picker.formatMmrRelativeTime(ago(ms), NOW);
    assert.equal(format(59_999), "now");
    assert.equal(format(MINUTE), "1m ago");
    assert.equal(format(51 * MINUTE + 59_000), "51m ago");
    assert.equal(format(59 * MINUTE + 59_999), "59m ago");
    assert.equal(format(HOUR), "1h ago");
    assert.equal(format(23 * HOUR + 59 * MINUTE), "23h ago");
    assert.equal(format(DAY), "1d ago");
    assert.equal(format(29 * DAY), "29d ago");
    assert.equal(format(30 * DAY), "1mo ago");
    assert.equal(format(364 * DAY), "12mo ago");
    assert.equal(format(365 * DAY), "1y ago");
    assert.equal(picker.formatMmrRelativeTime(new Date(NOW + HOUR), NOW), "now", "a clock running behind is not a negative time");
  });

  it("titles a session by its name, else its first message on one line, else untitled", () => {
    assert.equal(picker.mmrThreadTitle({ name: " Parser cleanup ", firstMessage: "Clean up" }), "Parser cleanup");
    assert.equal(picker.mmrThreadTitle({ firstMessage: "Why does the parser drop\n  trailing comments?" }), "Why does the parser drop trailing comments?");
    assert.equal(picker.mmrThreadTitle({ name: "", firstMessage: " \n " }), "untitled");
  });

  it("puts the current session first, then the rest by last activity, hiding archived ones", () => {
    const rows = picker.buildMmrThreadPickerRows(workspaceSessions(), {
      variant: "switch",
      threads: THREADS,
      showArchived: false,
      currentId: "s-current",
    });
    assert.deepEqual(
      rows.map((row) => [row.id, row.title, row.current]),
      [
        ["s-current", RENAME, true],
        ["s-c", "untitled", false],
        ["s-a", "Parser cleanup", false],
        ["s-b", "Why does the parser drop trailing comments?", false],
      ],
    );
    assert.equal(rows[0].path, "/sessions/s-current.jsonl");
  });

  it("lists archived sessions on request, keeps the current session even when archived, and lists each id once", () => {
    const options = { variant: "switch", threads: { ...THREADS, "s-current": { archived: "2026-10-17T00:00:00.000Z" } }, currentId: "s-current" };
    assert.deepEqual(
      picker.buildMmrThreadPickerRows(allSessions(), { ...options, showArchived: false }).map((row) => row.id),
      ["s-current", "s-c", "s-other", "s-a", "s-b"],
    );
    const shown = picker.buildMmrThreadPickerRows(allSessions(), { ...options, showArchived: true });
    assert.deepEqual(shown.map((row) => row.id), ["s-current", "s-c", "s-other", "s-a", "s-b", "s-arch"]);
    assert.equal(shown.find((row) => row.id === "s-a").path, "/sessions/s-a.jsonl", "the newer record of a duplicate wins");
  });

  it("leaves the current session out of the mention variant", () => {
    const rows = picker.buildMmrThreadPickerRows(workspaceSessions(), {
      variant: "mention",
      threads: {},
      showArchived: false,
      currentId: "s-current",
    });
    assert.deepEqual(rows.map((row) => row.id), ["s-c", "s-a", "s-b", "s-arch"]);
    assert.ok(rows.every((row) => !row.current));
  });

  it("keeps the last exchanges' user messages and assistant text only", () => {
    const messages = [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "first reply" }] },
      { role: "user", content: [{ type: "text", text: "second" }, { type: "image", data: "", mimeType: "image/png" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "toolCall", id: "t", name: "read", arguments: {} }] },
      { role: "toolResult", toolCallId: "t", toolName: "read", content: [{ type: "text", text: "file body" }] },
      { role: "assistant", content: [{ type: "text", text: "second reply" }, { type: "text", text: "and more" }] },
      { role: "bashExecution", command: "ls", output: "x" },
      { role: "user", content: "third" },
    ];
    assert.deepEqual(picker.lastMmrThreadExchanges(messages, 2), [
      { role: "user", text: "second" },
      { role: "assistant", text: "second reply\n\nand more" },
      { role: "user", text: "third" },
    ]);
    assert.equal(picker.lastMmrThreadExchanges(messages).length, 5, "three exchanges reach back to the first message");
    assert.deepEqual(picker.lastMmrThreadExchanges([]), []);
  });
});

describe("ampi-tui thread picker rendering", () => {
  it("puts the preview beside the list at 140 columns: title, filter, rows with times, preview box", () => {
    const p = open();
    const lines = p.render(140);
    assert.equal(lines.length, 40, "the terminal height less four");
    for (const line of lines) assert.equal(visibleWidth(line), 136, plain([line])[0]);
    const rows = plain(lines);
    assert.equal(rows[0], `╭─ Switch Thread ${"─".repeat(118)}╮`);
    // Content starts two columns in; the list takes 66 of the 132 content columns and the preview box the rest.
    assert.match(rows[2], /^│ > {65}╭─{64}╮ │$/, "the preview box starts on the filter row");
    assert.match(rows[4], /^│ {3}\(current\) Rename the parser module and update its imp… 2d ago {3}│ {25}Thread Preview {25}│ │$/);
    assert.match(rows[5], /^│ {3}untitled {50}now {3}│/);
    assert.match(rows[6], /^│ {3}Parser cleanup {40}51m ago {3}│/);
    assert.match(rows[7], /^│ {3}Why does the parser drop trailing comments\? {12}3h ago {3}│/);
    assert.ok(!rows.some((row) => row.includes("Old parser experiment")), "archived sessions are hidden");
    assert.equal(rows.at(-1), `╰${"─".repeat(70)} Alt+W/Ctrl+T all workspaces · Alt+A show archived · Esc close ─╯`);

    // The preview: the current session's exchange, the user message with its bar, the reply as Markdown.
    assert.match(rows[6], /│ {64}│ │$/, "the preview starts with a blank line");
    assert.match(rows[7], /│ {2}┃ Rename the parser module and update its imports {13}│ │$/);
    assert.match(rows[9], /│ {2}Renamed parser to syntax\. {37}│ │$/);
    assert.match(rows[11], /│ {2}- updated four imports {40}│ │$/);
    assert.match(rows[37], /^│ {67}╰─{64}╯ │$/, "the preview box ends a row above the bottom border");
    assert.match(rows[38], /^│ {134}│$/);
    assert.match(lines[9], /\x1b\[1mparser\x1b\[22m/, "bold Markdown");
    assert.match(lines[9], /\x1b\[33msyntax\x1b\[39m/, "inline code through the Markdown theme");
    assert.match(lines[7], /\x1b\[32m┃ \x1b\[39m\x1b\[3m\x1b\[32mRename/, "the user message bar and italic text");

    const selected = lines[4];
    assert.ok(selected.includes("\x1b[48;5;3m"), "the selected row has the warning color behind it");
    assert.ok(selected.includes("\x1b[38;5;0mRename"), "and black text");
    assert.ok(selected.includes("\x1b[32m(current) "), "the current marker is green");
    assert.ok(!lines[5].includes("\x1b[48;5;3m"));
    assert.deepEqual(p.previewReads, ["s-current"], "only the selected session's preview is read");

    expectFixture("ampi-tui-thread-picker", "list-140", lines);
  });

  it("keeps the preview beside the list at 120 columns and stacks it below at 119 and 80", () => {
    const p = open();
    const at120 = plain(p.render(120));
    assert.equal(at120.length, 40);
    assert.match(at120[2], /^│ > {55}╭─{54}╮ │$/, "56 list columns, 56 preview columns");
    expectFixture("ampi-tui-thread-picker", "list-120", p.render(120));

    const at119 = plain(p.render(119));
    assert.match(at119[2], /^│ > +│$/, "no preview box on the filter row");
    assert.ok(at119.some((row) => /^│ ╭─+╮ +│$/.test(row)), "a full-width preview box under the list");

    const lines = p.render(80);
    assert.equal(lines.length, 20);
    for (const line of lines) assert.equal(visibleWidth(line), 76, plain([line])[0]);
    const rows = plain(lines);
    assert.match(rows[4], /^│ {3}\(current\) Rename the parser module and update its imports {5}2d ago {3}│$/, "the whole title fits");
    assert.match(rows[8], /^│ {74}│$/, "five list rows; the fifth is empty");
    assert.match(rows[10], /^│ ╭─{70}╮ │$/);
    assert.match(rows[12], /^│ │ {28}Thread Preview {28}│ │$/);
    assert.match(rows[14], /^│ │ {2}- updated four imports {44}. │ │$/, "the end of the reply, with the preview's scrollbar");
    assert.match(rows[17], /^│ ╰─{70}╯ │$/);
    assert.match(rows[18], /^│ {74}│$/);
    assert.equal(rows[19], "╰────────── Alt+W/Ctrl+T all workspaces · Alt+A show archived · Esc close ─╯");
    expectFixture("ampi-tui-thread-picker", "list-80", lines);
  });

  it("says when there are no sessions and no messages to preview", () => {
    const p = open({ sessions: [] });
    const at140 = p.render(140);
    const rows = plain(at140);
    assert.match(rows[4], /^│ No Threads {56}│ {25}Thread Preview {25}│ │$/);
    assert.match(rows[6], /^│ Alt\+W\/Ctrl\+T all workspaces {39}│ {21}No messages to preview {21}│ │$/);
    assert.ok(at140[4].includes("\x1b[2mNo Threads"), "dim");
    assert.ok(at140[6].includes("\x1b[34mAlt+W/Ctrl+T"), "the key in the accent color");
    expectFixture("ampi-tui-thread-picker", "empty-140", at140);
    expectFixture("ampi-tui-thread-picker", "empty-80", p.render(80));
  });

  it("previews a session without messages as empty", () => {
    const p = open();
    p.component.handleInput(KEY.down);
    const rows = plain(p.render(140));
    assert.match(rows[6], /│ {21}No messages to preview {21}│ │$/);
  });

  it("titles the mention variant Mention Thread and shows no current marker", () => {
    const rows = plain(open({ variant: "mention" }).render(140));
    assert.match(rows[0], /^╭─ Mention Thread ─+╮$/);
    assert.match(rows[4], /^│ {3}untitled +now {3}│/);
    assert.ok(!rows.some((row) => row.includes("(current)")));
  });

  it("fits a short terminal", () => {
    const p = open();
    assert.equal(p.render(80, 12).length, 8, "the list alone when the preview has no room");
    assert.ok(!plain(p.render(80, 12)).some((row) => row.includes("Thread Preview")));
    assert.equal(p.render(140, 10).length, 7, "never fewer rows than the list needs");
  });
});

describe("ampi-tui thread picker keys", () => {
  it("moves with the arrows and Ctrl+P/Ctrl+N without wrapping, following the preview", () => {
    const p = open();
    p.component.handleInput(KEY.up);
    assert.equal(p.component.getSelectedIndex(), 0);
    p.component.handleInput(KEY.down);
    p.component.handleInput(KEY.ctrlN);
    assert.equal(p.component.getSelectedIndex(), 2);
    p.component.handleInput(KEY.ctrlP);
    p.component.handleInput(KEY.ctrlN);
    for (let i = 0; i < 10; i++) p.component.handleInput(KEY.down);
    assert.equal(p.component.getSelectedIndex(), 3, "no wrap at the bottom");
    p.render(140);
    assert.deepEqual(p.previewReads, ["s-b"]);
  });

  it("closes with the selected row on Enter and with nothing on Esc", () => {
    const p = open();
    p.component.handleInput(KEY.down);
    p.component.handleInput(KEY.down);
    p.component.handleInput(KEY.enter);
    assert.equal(p.closed.length, 1);
    assert.equal(p.closed[0].id, "s-a");
    assert.equal(p.closed[0].path, "/sessions/s-a.jsonl");
    p.component.handleInput(KEY.enter);
    assert.equal(p.closed.length, 1, "nothing happens after closing");

    const q = open();
    q.component.handleInput(KEY.esc);
    assert.deepEqual(q.closed, [undefined]);
  });

  it("filters by title ignoring case, and Enter does nothing while nothing matches", () => {
    const p = open();
    p.component.handleInput(KEY.down);
    p.type("PARSER");
    assert.equal(p.component.getQuery(), "PARSER");
    assert.deepEqual(ids(p.component), ["s-current", "s-a", "s-b"]);
    assert.equal(p.component.getSelectedIndex(), 0);
    assert.match(plain(p.render(80))[2], /^│ > PARSER +│$/);
    p.type("zzz");
    assert.deepEqual(ids(p.component), []);
    assert.match(plain(p.render(80))[4], /^│ No Threads +│$/);
    p.component.handleInput(KEY.enter);
    assert.deepEqual(p.closed, []);
    for (let i = 0; i < 3; i++) p.component.handleInput(KEY.backspace);
    assert.equal(ids(p.component).length, 3);
  });

  it("shows and hides archived sessions with Alt+A, naming the next step in the bottom border", () => {
    const p = open();
    p.component.handleInput(KEY.altA);
    assert.equal(p.component.isShowingArchived(), true);
    assert.deepEqual(ids(p.component), ["s-current", "s-c", "s-a", "s-b", "s-arch"]);
    assert.match(plain(p.render(140)).at(-1), / Alt\+A hide archived · Esc close ─╯$/);
    p.component.handleInput(KEY.altA);
    assert.deepEqual(ids(p.component), ["s-current", "s-c", "s-a", "s-b"]);
  });

  it("switches to every workspace with Alt+W and back with Ctrl+T, loading the listing once and keeping the filter", async () => {
    const p = open();
    p.type("p");
    p.component.handleInput(KEY.altW);
    assert.equal(p.component.getScope(), "all");
    assert.deepEqual(p.loads, ["all"]);
    assert.deepEqual(ids(p.component), [], "nothing to pick until the listing has loaded");
    assert.match(plain(p.render(140))[4], /^│ {67}│/, "and no empty notice while it loads");
    p.component.handleInput(KEY.enter);
    assert.deepEqual(p.closed, []);

    await p.finishLoad();
    assert.equal(p.renders.count, 1, "the picker asks to be drawn again once loaded");
    assert.deepEqual(ids(p.component), ["s-current", "s-other", "s-a", "s-b"]);
    assert.match(plain(p.render(140)).at(-1), /─ Alt\+W\/Ctrl\+T filter by workspace · Alt\+A show archived · Esc close ─╯$/);

    p.component.handleInput(KEY.ctrlT);
    assert.equal(p.component.getScope(), "workspace");
    p.component.handleInput(KEY.altW);
    assert.deepEqual(p.loads, ["all"], "a loaded scope is not listed again");
    assert.equal(p.component.getQuery(), "p");
  });

  it("scrolls the preview a page at a time with PageUp and PageDown, back to the end on a new selection", () => {
    const p = open();
    p.component.handleInput(KEY.down);
    p.component.handleInput(KEY.down);
    // At 80 columns the preview shows two lines at a time; it opens on the last.
    const previewText = () =>
      plain(p.render(80))
        .slice(14, 16)
        .map((row) => row.slice(5, 71).trim());
    assert.deepEqual(previewText(), ["", "Finished step 4. The tests pass and nothing else changed."]);
    p.component.handleInput(KEY.pageUp);
    assert.deepEqual(previewText(), ["┃ Do step 4", ""]);
    p.component.handleInput(KEY.pageUp);
    p.component.handleInput(KEY.pageDown);
    assert.deepEqual(previewText(), ["┃ Do step 4", ""]);
    for (let i = 0; i < 20; i++) p.component.handleInput(KEY.pageUp);
    assert.deepEqual(previewText(), ["", "┃ Do step 2"], "the top: three exchanges, starting with a blank line");
    p.component.handleInput(KEY.down);
    p.component.handleInput(KEY.up);
    assert.deepEqual(previewText(), ["", "Finished step 4. The tests pass and nothing else changed."]);
  });
});

describe("ampi-tui thread picker overlay", () => {
  let seam;
  let release;
  beforeEach(async () => {
    seam = await importSource("extensions/ampi-core/thread-index.ts");
  });
  afterEach(() => {
    release?.();
    release = undefined;
  });

  it("lists this workspace, hides the archived sessions the thread index names, and resolves with the pick", async () => {
    release = seam.registerMmrThreadIndex({ list: async () => THREADS, get: async () => undefined, update: async () => undefined });
    const context = createMockExtensionContext({ cwd: "/work/parser", sessionId: "s-current" });
    const lists = [];
    const result = picker.openMmrThreadPicker(context.ctx, "switch", {
      list: async (scope) => {
        lists.push(scope);
        return scope === "workspace" ? workspaceSessions() : allSessions();
      },
      readPreview: () => [],
      now: () => NOW,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const overlay = context.overlays[0];
    assert.deepEqual(lists, ["workspace"]);
    assert.equal(overlay.options.overlay, true);
    assert.deepEqual(overlay.options.overlayOptions, { width: "100%", maxHeight: "100%", margin: 2, anchor: "center" });
    assert.deepEqual(ids(overlay.component), ["s-current", "s-c", "s-a", "s-b"]);
    overlay.component.handleInput(KEY.down);
    overlay.component.handleInput(KEY.enter);
    assert.equal((await result).id, "s-c");
    assert.equal(overlay.closed, true);
  });

  it("treats every session as unarchived without ampi-threads", async () => {
    const context = createMockExtensionContext({ sessionId: "s-current" });
    const result = picker.openMmrThreadPicker(context.ctx, "mention", { list: async () => workspaceSessions(), readPreview: () => [] });
    await new Promise((resolve) => setImmediate(resolve));
    const overlay = context.overlays[0];
    assert.deepEqual(ids(overlay.component), ["s-c", "s-a", "s-b", "s-arch"]);
    overlay.component.handleInput(KEY.esc);
    assert.equal(await result, undefined);
  });
});

describe("ampi-tui thread.switch command", () => {
  let registry;
  let seam;
  let release;
  beforeEach(async () => {
    registry = await importSource("extensions/ampi-core/command-registry.ts");
    seam = await importSource("extensions/ampi-core/thread-index.ts");
    registry.__resetMmrCommandsForTests();
  });
  afterEach(() => {
    release?.();
    release = undefined;
    registry.__resetMmrCommandsForTests();
  });

  it("is the thread switch row with no key, available in the terminal UI with ampi-threads loaded", async () => {
    const { createMmrTuiCommands } = await importSource("extensions/ampi-tui/keys/commands.ts");
    const opened = [];
    const command = createMmrTuiCommands({ getTui: () => undefined, openThreadSwitcher: (ctx) => opened.push(ctx) }).find(
      (entry) => entry.id === "thread.switch",
    );
    assert.deepEqual([command.noun, command.verb, command.defaultKey], ["thread", "switch", undefined]);
    const tui = createMockExtensionContext().ctx;
    assert.deepEqual(command.availability(tui), { state: "unavailable", reason: "ampi-threads is not loaded" });
    release = seam.registerMmrThreadIndex({ list: async () => ({}), get: async () => undefined, update: async () => undefined });
    assert.deepEqual(command.availability(tui), { state: "available" });
    assert.deepEqual(command.availability(createMockExtensionContext({ mode: "rpc" }).ctx), {
      state: "unavailable",
      reason: "only in Pi's terminal UI",
    });
    command.run(tui);
    assert.deepEqual(opened, [tui]);
  });
});
