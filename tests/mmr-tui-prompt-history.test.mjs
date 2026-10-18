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
  picker = await importSource("extensions/ampi-tui/overlays/prompt-history.ts");
});

const KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  enter: "\r",
  esc: "\x1b",
  backspace: "\x7f",
  altW: "\x1bw",
  ctrlT: "\x14",
  ctrlP: "\x10",
  ctrlN: "\x0e",
};

const LONG =
  "Move the tokenizer into its own module, keep the public parse function where it is, and update every import in the tests and the benchmarks";

/** 25 prompts for this workspace, newest first: more than the list shows. */
function workspaceEntries() {
  const entries = [
    { ts: "2026-10-18T10:30:00.000Z", text: "Rename the parser module and update its imports" },
    { ts: "2026-10-18T10:29:00.000Z", text: "Why does the parser drop\ntrailing comments?" },
    { ts: "2026-10-18T10:28:00.000Z", text: LONG },
  ];
  for (let index = 0; index < 22; index++) {
    entries.push({ ts: `2026-10-18T09:${String(59 - index).padStart(2, "0")}:00.000Z`, text: `Earlier prompt ${index + 1}` });
  }
  return entries;
}

const ALL_ENTRIES = [
  { ts: "2026-10-18T11:00:00.000Z", text: "Deploy the website preview" },
  { ts: "2026-10-18T10:30:00.000Z", text: "Rename the parser module and update its imports" },
];

function open({ entries = workspaceEntries(), all = ALL_ENTRIES, terminalRows } = {}) {
  const closed = [];
  const loads = [];
  const renders = { count: 0 };
  let resolveAll;
  const component = new picker.MmrPromptHistoryPicker({
    theme,
    entries,
    load: (scope) => {
      loads.push(scope);
      return new Promise((resolve) => {
        resolveAll = () => resolve(all);
      });
    },
    onClose: (text) => closed.push(text),
    terminalRows: terminalRows === undefined ? undefined : () => terminalRows,
    requestRender: () => {
      renders.count += 1;
    },
  });
  const type = (text) => {
    for (const character of text) component.handleInput(character);
  };
  // Pi sizes the overlay from its options: the preferred width, at most the terminal less the two margins.
  const render = (columns) => component.render(Math.min(picker.MMR_PROMPT_HISTORY_WIDTH, columns - 4));
  const finishLoad = async () => {
    resolveAll();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { component, closed, loads, renders, type, render, finishLoad };
}

const texts = (component) => component.getRows().map((entry) => entry.text);

describe("ampi-tui prompt history rendering", () => {
  it("draws the box at 140 and 80 columns: title, filter row, one prompt per row, scope in the bottom border", () => {
    const p = open();
    const at140 = p.render(140);
    const at80 = p.render(80);
    assert.equal(visibleWidth(at140[0]), 110, "110 wide on a wide terminal");
    assert.equal(visibleWidth(at80[0]), 76, "the terminal width less four on an 80-column terminal");
    assert.equal(at140.length, 26, "title, padding, filter, blank, 21 rows, bottom border");
    for (const line of at140) assert.equal(visibleWidth(line), 110, plain([line])[0]);
    for (const line of at80) assert.equal(visibleWidth(line), 76, plain([line])[0]);

    const rows = plain(at140);
    assert.equal(rows[0], `╭─ Prompt History ${"─".repeat(91)}╮`);
    assert.equal(rows[2], `│ >${" ".repeat(106)}│`, "the filter row");
    assert.equal(rows[3], `│${" ".repeat(108)}│`);
    assert.equal(rows[4], `│   Rename the parser module and update its imports${" ".repeat(57)}█│`, "two columns of indent, the scrollbar after");
    assert.match(rows[5], /^│ {3}Why does the parser drop trailing comments\? +█│$/, "a line break shows as a space");
    // The long prompt is cut to the inner width less two columns each side: 102 columns, ending in an ellipsis.
    assert.equal(rows[6], `│   ${LONG.slice(0, 101)}…  █│`);
    assert.equal(rows.at(-1), `╰${"─".repeat(50)} Alt+W/Ctrl+T toggle filter · Showing: current workspace ─╯`);
    assert.ok(rows.slice(4, 25).some((row) => row.endsWith("█│")), "a scrollbar, since 25 prompts do not fit in 21 rows");

    const selected = at140[4];
    assert.ok(selected.includes("\x1b[48;5;3m"), "the selected row has the warning color behind it");
    assert.ok(selected.includes("\x1b[38;5;0m"), "and black text");
    assert.ok(!at140[5].includes("\x1b[48;5;3m"), "other rows have no background");

    expectFixture("ampi-tui-prompt-history", "list-140", at140);
    expectFixture("ampi-tui-prompt-history", "list-80", at80);
  });

  it("centres a dim notice when this workspace has no history", () => {
    const p = open({ entries: [] });
    const at140 = p.render(140);
    const rows = plain(at140);
    assert.equal(rows[4], `│${" ".repeat(40)}No history for this workspace${" ".repeat(39)}│`, "the odd column goes left");
    assert.ok(at140[4].includes("\x1b[2mNo history for this workspace"), "dim");
    assert.equal(rows.length, 26, "the box keeps its height");
    expectFixture("ampi-tui-prompt-history", "empty-140", at140);
    expectFixture("ampi-tui-prompt-history", "empty-80", p.render(80));
  });

  it("filters to prompts containing the typed text, ignoring case, newest first", () => {
    const p = open();
    p.type("PARSER");
    assert.equal(p.component.getQuery(), "PARSER");
    assert.deepEqual(texts(p.component), ["Rename the parser module and update its imports", "Why does the parser drop\ntrailing comments?"]);
    const lines = p.render(140);
    assert.match(plain(lines)[2], /^│ > PARSER +│$/);
    assert.ok(!plain(lines).some((row) => row.includes("Earlier prompt")));
    expectFixture("ampi-tui-prompt-history", "filtered-140", lines);

    p.type("zzz");
    assert.match(plain(p.render(80))[4], /^│ +No prompt contains "PARSERzzz" +│$/);
  });

  it("names the scope in the bottom border after a toggle, and drops the scope text before the key hint when narrow", async () => {
    const p = open();
    p.component.handleInput(KEY.altW);
    await p.finishLoad();
    const at140 = p.render(140);
    assert.equal(plain(at140).at(-1), `╰${"─".repeat(53)} Alt+W/Ctrl+T toggle filter · Showing: all workspaces ─╯`);
    assert.match(plain(at140)[4], /^│ {3}Deploy the website preview +│$/);
    expectFixture("ampi-tui-prompt-history", "all-workspaces-140", at140);
    expectFixture("ampi-tui-prompt-history", "all-workspaces-80", p.render(80));
    assert.equal(plain(p.component.render(40)).at(-1), `╰${"─".repeat(9)} Alt+W/Ctrl+T toggle filter ─╯`);
  });

  it("says when no workspace has history", async () => {
    const p = open({ all: [] });
    p.component.handleInput(KEY.ctrlT);
    await p.finishLoad();
    assert.match(plain(p.render(140))[4], /^│ +No history in any workspace +│$/);
  });

  it("shortens the list on a short terminal", () => {
    assert.equal(open({ terminalRows: 24 }).render(80).length, 24, "19 rows plus the five rows around them");
    assert.equal(open({ terminalRows: 4 }).render(80).length, 6, "never fewer than one row");
  });
});

describe("ampi-tui prompt history keys", () => {
  it("moves with the arrows and Ctrl+P/Ctrl+N without wrapping, scrolling to keep the selection on screen", () => {
    const p = open();
    p.component.handleInput(KEY.up);
    assert.equal(p.component.getSelectedIndex(), 0, "no wrap at the top");
    p.component.handleInput(KEY.down);
    p.component.handleInput(KEY.ctrlN);
    assert.equal(p.component.getSelectedIndex(), 2);
    p.component.handleInput(KEY.ctrlP);
    assert.equal(p.component.getSelectedIndex(), 1);
    for (let i = 0; i < 40; i++) p.component.handleInput(KEY.down);
    assert.equal(p.component.getSelectedIndex(), 24, "no wrap at the bottom");
    const rows = plain(p.render(140));
    assert.match(rows[24], /^│ {3}Earlier prompt 22 +.│$/, "the selected row is the last one shown");
    assert.match(rows[4], /^│ {3}Earlier prompt 2 +.│$/);
    assert.deepEqual(p.closed, []);
  });

  it("closes with the whole selected prompt on Enter", () => {
    const p = open();
    p.component.handleInput(KEY.down);
    p.component.handleInput(KEY.enter);
    assert.deepEqual(p.closed, ["Why does the parser drop\ntrailing comments?"], "line breaks are kept");
    p.component.handleInput(KEY.enter);
    assert.equal(p.closed.length, 1, "nothing happens after closing");
  });

  it("closes without a prompt on Esc, and Enter does nothing while nothing matches", () => {
    const p = open();
    p.type("zzz");
    p.component.handleInput(KEY.enter);
    assert.deepEqual(p.closed, []);
    p.component.handleInput(KEY.esc);
    assert.deepEqual(p.closed, [undefined]);
  });

  it("edits the filter and resets the selection", () => {
    const p = open();
    p.component.handleInput(KEY.down);
    p.type("earlier prompt 1");
    assert.equal(p.component.getSelectedIndex(), 0);
    assert.equal(texts(p.component).length, 11, "1 and 10 to 19");
    p.component.handleInput(KEY.backspace);
    assert.equal(p.component.getQuery(), "earlier prompt ");
    assert.equal(texts(p.component).length, 22);
  });

  it("toggles the scope with Alt+W and Ctrl+T, loading all workspaces once and keeping the filter", async () => {
    const p = open();
    p.type("parser");
    p.component.handleInput(KEY.down);
    p.component.handleInput(KEY.altW);
    assert.equal(p.component.getScope(), "all");
    assert.deepEqual(p.loads, ["all"]);
    assert.deepEqual(texts(p.component), [], "nothing to pick until the scope has loaded");
    p.component.handleInput(KEY.enter);
    assert.deepEqual(p.closed, []);

    await p.finishLoad();
    assert.equal(p.renders.count, 1, "the picker asks to be drawn again once loaded");
    assert.deepEqual(texts(p.component), ["Rename the parser module and update its imports"]);
    assert.equal(p.component.getSelectedIndex(), 0);

    p.component.handleInput(KEY.ctrlT);
    assert.equal(p.component.getScope(), "workspace");
    assert.equal(texts(p.component).length, 2);
    p.component.handleInput(KEY.altW);
    assert.deepEqual(p.loads, ["all"], "a loaded scope is not read again");
    assert.equal(texts(p.component).length, 1);
    assert.equal(p.component.getQuery(), "parser");
  });
});

describe("ampi-tui prompt history overlay", () => {
  it("reads this workspace's prompts, opens centred 110 wide with two-column margins, and resolves with the pick", async () => {
    const context = createMockExtensionContext({ cwd: "/work/parser" });
    const reads = [];
    const history = {
      read: async (cwd, scope) => {
        reads.push([cwd, scope]);
        return scope === "workspace" ? [{ ts: "2026-10-18T10:00:00.000Z", text: "only prompt" }] : [];
      },
    };
    const result = picker.openMmrPromptHistory(context.ctx, history);
    await new Promise((resolve) => setImmediate(resolve));
    const overlay = context.overlays[0];
    assert.deepEqual(reads, [["/work/parser", "workspace"]]);
    assert.equal(overlay.options.overlay, true);
    assert.deepEqual(overlay.options.overlayOptions, { width: 110, margin: { left: 2, right: 2 }, anchor: "center" });
    overlay.component.handleInput(KEY.altW);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(reads.at(-1), ["/work/parser", "all"]);
    overlay.component.handleInput(KEY.ctrlT);
    overlay.component.handleInput(KEY.enter);
    assert.equal(await result, "only prompt");
    assert.equal(overlay.closed, true);
  });
});

describe("ampi-tui prompt.history command", () => {
  let registry;
  let seam;
  let release;

  beforeEach(async () => {
    registry = await importSource("extensions/ampi-core/command-registry.ts");
    seam = await importSource("extensions/ampi-core/prompt-history.ts");
    registry.__resetMmrCommandsForTests();
  });
  afterEach(() => {
    release?.();
    release = undefined;
    registry.__resetMmrCommandsForTests();
  });

  async function command(opened = []) {
    const { createMmrTuiCommands } = await importSource("extensions/ampi-tui/keys/commands.ts");
    const commands = createMmrTuiCommands({
      getTui: () => undefined,
      openPromptHistory: (ctx, history) => opened.push({ ctx, history }),
    });
    return commands.find((entry) => entry.id === "prompt.history");
  }

  it("is the prompt history row on Ctrl+R", async () => {
    const history = await command();
    assert.deepEqual([history.noun, history.verb, history.defaultKey], ["prompt", "history", "ctrl+r"]);
  });

  it("is available in the terminal UI once a prompt history is registered", async () => {
    const opened = [];
    const history = await command(opened);
    const tui = createMockExtensionContext().ctx;
    assert.deepEqual(history.availability(tui), { state: "unavailable", reason: "ampi-threads is not loaded" });
    const source = { read: async () => [] };
    release = seam.registerMmrPromptHistory(source);
    assert.deepEqual(history.availability(tui), { state: "available" });
    for (const mode of ["print", "json", "rpc"]) {
      assert.deepEqual(history.availability(createMockExtensionContext({ mode }).ctx), {
        state: "unavailable",
        reason: "only in Pi's terminal UI",
      });
    }
    history.run(tui);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].history, source);
  });
});
