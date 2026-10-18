import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext } from "./helpers/pi-stub.mjs";
import { createAnsiTheme, expectFixture, plain } from "./helpers/tui-render.mjs";

after(cleanupLoadedSource);

let palette;
const theme = createAnsiTheme();

before(async () => {
  palette = await importSource("extensions/ampi-tui/overlays/palette.ts");
});

const KEY = { up: "\x1b[A", down: "\x1b[B", enter: "\r", esc: "\x1b", ctrlP: "\x10", ctrlN: "\x0e", backspace: "\x7f" };

function command(id, noun, verb, extra = {}) {
  return { id, noun, verb, description: extra.description ?? `${noun} ${verb}`, run() {}, ...extra };
}

const unavailable = (reason) => () => ({ state: "unavailable", reason });

/** A registry-like list: more rows than fit, keys, unavailable rows with and without a reason, a long label. */
function sampleItems() {
  return [
    { command: command("thread.new", "thread", "new"), key: "Ctrl+X n" },
    { command: command("thread.switch", "thread", "switch") },
    {
      command: command("thread.switchToPrevious", "thread", "switch to previous", {
        availability: unavailable("there is no earlier thread"),
      }),
    },
    { command: command("prompt.clear", "prompt", "clear", { availability: () => ({ state: "unavailable" }) }) },
    { command: command("ampi.quit", "ampi", "quit"), key: "Ctrl+C Ctrl+C" },
    { command: command("mode.switch", "mode", "switch"), key: "Ctrl+S" },
    { command: command("settings.showManaged", "settings", "show managed") },
    { command: command("secret.thing", "secret", "hidden row", { availability: () => ({ state: "hidden" }) }) },
    {
      command: command("notes.write", "notes", "write down a remark that is much too long for a narrow palette row"),
      key: "Ctrl+X w",
    },
    ...["settings", "model", "tree", "thinking", "export", "import", "share", "copy", "name", "session", "fork", "clone", "new"].map(
      (name) => ({ command: command(`pi.${name}`, "pi", `/${name}`) }),
    ),
  ];
}

function open({ items = sampleItems(), terminalRows } = {}) {
  const closed = [];
  const component = new palette.MmrPalette({
    items,
    ctx: {},
    theme,
    onClose: (picked) => closed.push(picked),
    terminalRows: terminalRows === undefined ? undefined : () => terminalRows,
  });
  const type = (text) => {
    for (const character of text) component.handleInput(character);
  };
  // Pi sizes the overlay from its options: the preferred width, at most the terminal less the two margins.
  const render = (columns) => component.render(Math.min(palette.MMR_PALETTE_WIDTH, columns - 4));
  const labels = () => component.getRows().map((row) => `${row.command.noun} ${row.command.verb}`);
  return { component, closed, type, render, labels };
}

describe("ampi-tui command palette rendering", () => {
  it("draws the box at 80 and 140 columns with the first rows selected and a scrollbar", () => {
    const p = open();
    const at140 = p.render(140);
    const at80 = p.render(80);
    assert.equal(visibleWidth(at140[0]), 80, "80 wide on a wide terminal");
    assert.equal(visibleWidth(at80[0]), 76, "the terminal width less four on an 80-column terminal");
    assert.equal(at140.length, 20, "title, padding, filter, blank, 15 rows, bottom border");
    const rows = plain(at140);
    assert.equal(rows[0], `╭─ Command Palette ${"─".repeat(60)}╮`);
    assert.match(rows[2], /^│ > {76}│$/);
    assert.equal(rows[4], `│${" ".repeat(9)}thread  new${" ".repeat(48)}Ctrl+X n █│`, "the category ends 15 columns in");
    assert.equal(rows[6], `│${" ".repeat(11)}ampi  quit${" ".repeat(42)}Ctrl+C Ctrl+C █│`);
    expectFixture("ampi-tui-palette", "empty-filter-140", at140);
    expectFixture("ampi-tui-palette", "empty-filter-80", at80);
  });

  it("sorts unavailable rows last, marks them, and leaves hidden commands out", () => {
    const p = open();
    const labels = p.labels();
    assert.ok(!labels.includes("secret hidden row"));
    assert.deepEqual(labels.slice(-2), ["thread switch to previous", "prompt clear"], "unavailable rows keep their order at the end");
    const lines = plain(p.render(140));
    assert.ok(!lines.some((line) => line.includes("(unavailable)")), "the first page holds only available rows");
  });

  it("ranks the filter: switch rows before other matches, unavailable ones last", () => {
    const p = open();
    p.type("sw");
    const labels = p.labels();
    assert.ok(labels.indexOf("thread switch") < labels.indexOf("settings show managed"));
    assert.ok(labels.indexOf("mode switch") < labels.indexOf("settings show managed"));
    assert.equal(labels.at(-1), "thread switch to previous");
    assert.equal(p.component.getSelectedIndex(), 0);
    expectFixture("ampi-tui-palette", "filter-sw-140", p.render(140));
  });

  it("shows the reason under the list while an unavailable row is selected", () => {
    const p = open();
    p.type("previous");
    const lines = p.render(140);
    const rows = plain(lines);
    assert.match(rows[4], /thread {2}switch to previous \(unavailable\)/);
    assert.equal(rows.at(-2), `│${" ".repeat(26)}there is no earlier thread${" ".repeat(26)}│`);
    assert.equal(rows.at(-3), `│${" ".repeat(78)}│`);
    assert.equal(lines.length, 20, "the reason takes the last two list rows; the box keeps its height");
    expectFixture("ampi-tui-palette", "unavailable-reason-140", lines);

    // Without a reason there is no reason line.
    const q = open();
    q.type("prompt clear");
    assert.match(plain(q.render(140))[4], /prompt {2}clear \(unavailable\)/);
    assert.equal(plain(q.render(140)).at(-2), `│${" ".repeat(78)}│`);
  });

  it("scrolls to keep the selection on screen", () => {
    const p = open();
    for (let i = 0; i < 18; i++) p.component.handleInput(KEY.down);
    const rows = plain(p.render(80));
    assert.match(rows[18], /pi {2}\/new/, "the selected row is the last one shown");
    assert.match(rows[4], /settings {2}show managed/);
    expectFixture("ampi-tui-palette", "scrolled-80", p.render(80));
  });

  it("cuts long labels and narrows the category field on a narrow terminal", () => {
    const p = open();
    p.type("remark");
    const lines = p.render(50);
    assert.equal(visibleWidth(lines[0]), 46);
    const row = plain(lines)[4];
    assert.equal(visibleWidth(row), 46);
    assert.match(row, /^│ {10}notes {2}write down a r… {2}Ctrl\+X w {2}│$/);
    expectFixture("ampi-tui-palette", "narrow-50", lines);
  });

  it("says so when nothing matches", () => {
    const p = open();
    p.type("zzz");
    const rows = plain(p.render(80));
    assert.match(rows[4], /^│ +No command matches "zzz" +│$/);
    expectFixture("ampi-tui-palette", "no-match-80", p.render(80));
  });

  it("shortens the list on a short terminal", () => {
    const p = open({ terminalRows: 12 });
    assert.equal(p.render(80).length, 12, "seven rows plus the five rows around them");
    assert.equal(open({ terminalRows: 4 }).render(80).length, 6, "never fewer than one row");
  });
});

describe("ampi-tui command palette keys", () => {
  it("moves with the arrows and Ctrl+P/Ctrl+N without wrapping", () => {
    const p = open();
    p.component.handleInput(KEY.up);
    assert.equal(p.component.getSelectedIndex(), 0, "no wrap at the top");
    p.component.handleInput(KEY.down);
    p.component.handleInput(KEY.ctrlN);
    assert.equal(p.component.getSelectedIndex(), 2);
    p.component.handleInput(KEY.ctrlP);
    assert.equal(p.component.getSelectedIndex(), 1);
    for (let i = 0; i < 50; i++) p.component.handleInput(KEY.down);
    assert.equal(p.component.getSelectedIndex(), p.component.getRows().length - 1, "no wrap at the bottom");
    assert.deepEqual(p.closed, []);
  });

  it("closes with the selected command on Enter, and only for an available row", () => {
    const p = open();
    p.component.handleInput(KEY.down);
    p.component.handleInput(KEY.enter);
    assert.equal(p.closed.length, 1);
    assert.equal(p.closed[0].id, "thread.switch");
    p.component.handleInput(KEY.enter);
    assert.equal(p.closed.length, 1, "nothing happens after closing");

    const q = open();
    q.type("previous");
    q.component.handleInput(KEY.enter);
    assert.deepEqual(q.closed, [], "an unavailable row does not run");
  });

  it("closes without a command on Esc", () => {
    const p = open();
    p.type("sw");
    p.component.handleInput(KEY.esc);
    assert.deepEqual(p.closed, [undefined]);
  });

  it("edits the filter, re-ranks and resets the selection", () => {
    const p = open();
    p.component.handleInput(KEY.down);
    p.component.handleInput(KEY.down);
    p.type("swi");
    assert.equal(p.component.getQuery(), "swi");
    assert.equal(p.component.getSelectedIndex(), 0);
    assert.ok(!p.labels().includes("settings show managed"), "swi no longer matches show managed");
    p.component.handleInput(KEY.backspace);
    assert.equal(p.component.getQuery(), "sw");
    assert.ok(p.labels().includes("settings show managed"));
    p.type("/");
    assert.equal(p.component.getQuery(), "sw/", "a slash is typed into the filter");
  });
});

describe("ampi-tui command palette overlay", () => {
  it("opens centred, 80 wide with two-column margins, and resolves with the original command after closing", async () => {
    const context = createMockExtensionContext();
    let checks = 0;
    const run = () => {};
    const counted = command("thread.counted", "thread", "counted", {
      availability: () => {
        checks += 1;
        return { state: "available" };
      },
      run,
    });
    const result = palette.openMmrPalette(context.ctx, [{ command: counted }]);
    const overlay = context.overlays[0];
    assert.equal(overlay.options.overlay, true);
    assert.deepEqual(overlay.options.overlayOptions, { width: 80, margin: { left: 2, right: 2 }, anchor: "center" });
    assert.equal(checks, 1, "availability is checked when the palette opens");
    overlay.component.handleInput("c");
    overlay.component.render(80);
    assert.equal(checks, 1, "and not again while filtering");
    overlay.component.handleInput(KEY.enter);
    const picked = await result;
    assert.equal(picked, counted, "the registry's own definition comes back");
    assert.equal(overlay.closed, true);
  });

  it("judges availability once, before the palette has focus", async () => {
    const context = createMockExtensionContext({ editorText: "" });
    const needsEmptyPrompt = command("prompt.thing", "prompt", "thing", {
      availability: (ctx) => (ctx.ui.getEditorText() ? { state: "unavailable", reason: "text" } : { state: "available" }),
    });
    const result = palette.openMmrPalette(context.ctx, [{ command: needsEmptyPrompt }]);
    context.state.editorText = "typed later";
    const overlay = context.overlays[0];
    assert.equal(overlay.component.getRows()[0].state, "available");
    overlay.component.handleInput(KEY.esc);
    assert.equal(await result, undefined);
  });
});
