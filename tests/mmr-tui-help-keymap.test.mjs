import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";
import { createAnsiTheme, expectFixture, plain } from "./helpers/tui-render.mjs";

after(cleanupLoadedSource);

let help;
let keymapModule;
let registry;
let createMmrTuiKeys;
const theme = createAnsiTheme();

before(async () => {
  help = await importSource("extensions/ampi-tui/overlays/help-keymap.ts");
  keymapModule = await importSource("extensions/ampi-core/keymap.ts");
  registry = await importSource("extensions/ampi-core/command-registry.ts");
  ({ createMmrTuiKeys } = await importSource("extensions/ampi-tui/keys/install.ts"));
});

const KEY = { up: "\x1b[A", down: "\x1b[B", pageUp: "\x1b[5~", pageDown: "\x1b[6~", esc: "\x1b" };

/** Pi's keys as its keybindings would report them, fixed here so the fixtures do not follow Pi's defaults. */
const PI_KEYS = {
  "tui.input.submit": ["enter"],
  "tui.input.newLine": ["shift+enter", "ctrl+j"],
  "tui.input.tab": ["tab"],
  "tui.editor.cursorUp": ["up"],
  "tui.editor.cursorDown": ["down"],
  "tui.editor.cursorLeft": ["left", "ctrl+b"],
  "tui.editor.cursorRight": ["right", "ctrl+f"],
  "tui.editor.cursorWordLeft": ["alt+left", "ctrl+left", "alt+b"],
  "tui.editor.cursorWordRight": ["alt+right", "ctrl+right", "alt+f"],
  "tui.editor.cursorLineStart": ["home", "ctrl+a"],
  "tui.editor.cursorLineEnd": ["end", "ctrl+e"],
  "tui.editor.deleteCharBackward": ["backspace"],
  "tui.editor.deleteCharForward": ["delete", "ctrl+d"],
  "tui.editor.deleteWordBackward": ["ctrl+w", "alt+backspace"],
  "tui.editor.deleteWordForward": ["alt+d", "alt+delete"],
  "tui.editor.deleteToLineStart": ["ctrl+u"],
  "tui.editor.deleteToLineEnd": ["ctrl+k"],
  "tui.editor.yank": ["ctrl+y"],
  "tui.editor.undo": ["ctrl+-"],
  "app.clipboard.pasteImage": ["ctrl+v"],
  "tui.altScreen.pageUp": ["pageUp"],
  "tui.altScreen.pageDown": ["pageDown"],
  "tui.altScreen.top": ["ctrl+home"],
  "tui.altScreen.bottom": ["ctrl+end"],
};

const available = () => ({ state: "available" });

function command(id, noun, verb, description, extra = {}) {
  return { id, noun, verb, description, run() {}, ...extra };
}

/** A registry-like list: chords, a leader chord, two keys on one command, unbound commands, conditional keys, a long description. */
function sampleCommands() {
  return [
    command("ampi.palette", "ampi", "open command palette", "Open the command palette", { defaultKey: "ctrl+o" }),
    command("thread.interrupt", "thread", "interrupt", "Stop the running turn", { defaultKey: "esc esc", availability: available }),
    command("ampi.quit", "ampi", "quit", "Quit", { defaultKey: "ctrl+c ctrl+c" }),
    command("thread.scrollToTop", "thread", "scroll to top", "Jump to the start of the transcript", {
      defaultKey: "home",
      availability: available,
    }),
    command("thread.scrollToBottom", "thread", "scroll to bottom", "Jump to the end of the transcript and follow new output", {
      defaultKey: "end",
      availability: available,
    }),
    command("ampi.showVersion", "ampi", "show version", "Show the ampi and Pi versions", { defaultKey: "<leader>v" }),
    command("ampi.help", "ampi", "help", "List every key and command with the key it is bound to"),
    command("mode.toggle", "mode", "switch", "Show the mode dial; each further press turns it to the next mode", {
      defaultKey: ["ctrl+s", "f2"],
      availability: available,
    }),
    command("mode.use.low", "mode", "use low", "Switch to the low mode"),
  ];
}

function sources({ commands = sampleCommands(), overrides, leader, piKeys = PI_KEYS, modeKeys = true, scrolling = true } = {}) {
  const keymap = keymapModule.resolveMmrKeymap({
    defaults: Object.fromEntries(commands.map((entry) => [entry.id, entry.defaultKey ?? null])),
    overrides,
    leader,
  });
  return { keymap, commands, piKeys: (id) => piKeys[id] ?? [], modeKeys, scrolling };
}

function rowsOf(sections, title) {
  return sections.find((section) => section.title === title)?.rows ?? [];
}

function keysFor(sections, title, text) {
  return rowsOf(sections, title).find((row) => row.text === text)?.keys;
}

/** The help or keymap screen as Pi sizes it: the preferred width, at most the terminal less the two margins. */
function open(content, terminalRows) {
  const closed = [];
  const view = new help.MmrScrollOverlay({
    title: "Title",
    content,
    theme,
    onClose: () => closed.push(true),
    terminalRows: () => terminalRows,
  });
  const render = (columns) => view.render(Math.min(help.MMR_HELP_KEYMAP_WIDTH, columns - 4));
  const press = (key, times = 1) => {
    for (let i = 0; i < times; i++) view.handleInput(key);
  };
  return { view, closed, render, press };
}

function openHelp({ terminalRows = 44, ...options } = {}) {
  const sections = help.buildMmrHelpKeymapSections(sources(options));
  return open((width, t) => help.renderMmrHelpKeymapLines(sections, width, t), terminalRows);
}

function openJson({ terminalRows = 44, ...options } = {}) {
  const { keymap, commands } = sources(options);
  const jsonc = keymapModule.formatMmrKeymapJsonc(commands, keymap);
  return open((width, t) => help.renderMmrKeymapJsonLines(jsonc, width, t), terminalRows);
}

describe("ampi-tui help screen sections", () => {
  it("lists the editor keys, the bound navigation keys and every command, in three sections", () => {
    const sections = help.buildMmrHelpKeymapSections(sources());
    assert.deepEqual(
      sections.map((section) => section.title),
      ["Editor Shortcuts", "Scrolling & Navigation", "Command Palette Commands"],
    );
    assert.equal(keysFor(sections, "Editor Shortcuts", "Insert a newline"), "Alt+Enter, Shift+Enter, Ctrl+J");
    assert.equal(keysFor(sections, "Editor Shortcuts", "Mention files"), "@");
    assert.equal(keysFor(sections, "Editor Shortcuts", "Leader key; a popup lists the keys that can follow"), "Ctrl+X");
    assert.deepEqual(
      rowsOf(sections, "Scrolling & Navigation").map((row) => row.keys),
      ["Home", "End", "PgUp, PgDn", "Ctrl+Home, Ctrl+End", "Mouse wheel"],
    );
    const commands = rowsOf(sections, "Command Palette Commands");
    assert.deepEqual(
      commands.map((row) => `${row.command.noun} ${row.command.verb} = ${row.keys}`),
      [
        "ampi help = —",
        "ampi open command palette = Ctrl+O",
        "ampi quit = Ctrl+C Ctrl+C",
        "ampi show version = Ctrl+X v",
        "mode switch = Ctrl+S, F2",
        "mode use low = —",
        "thread interrupt = Esc Esc",
        "thread scroll to bottom = End",
        "thread scroll to top = Home",
      ],
      "sorted by category, then name; unbound commands show a dash",
    );
  });

  it("leaves out Pi's keys that ampi always takes first, and keeps conditional ones", () => {
    const sections = help.buildMmrHelpKeymapSections(sources({ overrides: { "ampi.showVersion": "ctrl+k", "mode.toggle": "ctrl+u" } }));
    assert.equal(keysFor(sections, "Editor Shortcuts", "Delete to the end of the line"), undefined, "Ctrl+K now shows the version");
    assert.equal(keysFor(sections, "Editor Shortcuts", "Delete to the start of the line"), "Ctrl+U", "mode.toggle only runs when available");
    assert.equal(keysFor(sections, "Editor Shortcuts", "Go to the start of the line"), "Home, Ctrl+A", "Home moves the cursor while the prompt has text");
  });

  it("lists ampi-core's mode picker keys and gives Alt+D to the thinking preset only while ampi-core is loaded", () => {
    const withCore = help.buildMmrHelpKeymapSections(sources({ modeKeys: true }));
    assert.equal(keysFor(withCore, "Editor Shortcuts", "Open the mode picker"), "Ctrl+Shift+S, Alt+M");
    assert.equal(keysFor(withCore, "Editor Shortcuts", "Delete the word after the cursor"), "Alt+Delete");
    assert.equal(keysFor(withCore, "Editor Shortcuts", "Toggle the thinking preset of the active mode"), "Alt+D");
    const withoutCore = help.buildMmrHelpKeymapSections(sources({ modeKeys: false }));
    assert.equal(keysFor(withoutCore, "Editor Shortcuts", "Delete the word after the cursor"), "Alt+D, Alt+Delete");
    assert.equal(keysFor(withoutCore, "Editor Shortcuts", "Toggle the thinking preset of the active mode"), undefined);
    assert.equal(keysFor(withoutCore, "Editor Shortcuts", "Open the mode picker"), undefined);
  });

  it("follows the keymap and Pi's keybindings in effect", () => {
    const sections = help.buildMmrHelpKeymapSections(
      sources({
        leader: "alt+x",
        overrides: { "ampi.help": ["f1", "<leader>h"], "thread.scrollToTop": null },
        piKeys: { ...PI_KEYS, "tui.editor.cursorLineStart": ["ctrl+a", "f9"], "tui.editor.yank": [] },
      }),
    );
    assert.equal(keysFor(sections, "Editor Shortcuts", "Leader key; a popup lists the keys that can follow"), "Alt+X");
    assert.equal(keysFor(sections, "Editor Shortcuts", "Go to the start of the line"), "Ctrl+A, F9");
    assert.equal(keysFor(sections, "Editor Shortcuts", "Paste the text deleted last"), undefined, "a Pi action without keys is left out");
    const commands = rowsOf(sections, "Command Palette Commands");
    assert.equal(commands.find((row) => row.command.verb === "help").keys, "F1, Alt+X h");
    assert.equal(commands.find((row) => row.command.verb === "show version").keys, "Alt+X v");
    assert.equal(commands.find((row) => row.command.verb === "scroll to top").keys, "—");
    assert.deepEqual(
      rowsOf(sections, "Scrolling & Navigation").map((row) => row.keys).slice(0, 2),
      ["End", "PgUp, PgDn"],
      "an unbound navigation command leaves the section",
    );
  });

  it("drops Scrolling & Navigation when nothing in it has a key", () => {
    const sections = help.buildMmrHelpKeymapSections(
      sources({ scrolling: false, overrides: { "thread.scrollToTop": null, "thread.scrollToBottom": null } }),
    );
    assert.deepEqual(
      sections.map((section) => section.title),
      ["Editor Shortcuts", "Command Palette Commands"],
    );
    const regular = help.buildMmrHelpKeymapSections(sources({ scrolling: false }));
    assert.deepEqual(
      rowsOf(regular, "Scrolling & Navigation").map((row) => row.keys),
      ["Home", "End"],
      "without fullscreen scrolling only the registry's own keys are listed",
    );
  });
});

describe("ampi-tui help screen rendering", () => {
  it("draws the screen at 140 and 80 columns, as tall as the terminal less two", () => {
    const at140 = openHelp().render(140);
    const at80 = openHelp().render(80);
    assert.equal(visibleWidth(at140[0]), 100, "100 wide on a wide terminal");
    assert.equal(visibleWidth(at80[0]), 76, "the terminal width less four on an 80-column terminal");
    assert.equal(at140.length, 42);
    assert.ok(at140.every((line) => visibleWidth(line) === 100));
    const rows = plain(at140);
    assert.equal(rows[0], `╭─ Title ${"─".repeat(90)}╮`);
    assert.match(rows[2], /^│ {2}Editor Shortcuts +█│$/);
    assert.match(rows.at(-1), /─ Esc close · ↑↓\/j\/k scroll ─╯$/);
    expectFixture("ampi-tui-help-keymap", "help-top-140", at140);
    expectFixture("ampi-tui-help-keymap", "help-top-80", at80);
  });

  it("lines up command rows in three columns and marks unbound ones", () => {
    const rows = plain(openHelp({ terminalRows: 200 }).render(140));
    const quit = rows.find((row) => row.includes("ampi quit"));
    const unbound = rows.find((row) => row.includes("mode use low"));
    assert.match(quit, /^│ {5}ampi quit +Ctrl\+C Ctrl\+C +Quit +│$/);
    assert.match(unbound, /^│ {5}mode use low +— +Switch to the low mode +│$/);
    assert.equal(quit.indexOf("Ctrl+C"), unbound.indexOf("—"), "keys share a column");
    assert.equal(quit.indexOf("Quit"), unbound.indexOf("Switch"), "descriptions share a column");
  });

  it("puts a command's keys under its name on a narrow screen", () => {
    const view = openHelp({ terminalRows: 200 });
    const lines = view.render(50);
    assert.equal(visibleWidth(lines[0]), 46);
    const rows = plain(lines);
    const at = rows.findIndex((row) => row.includes("ampi quit"));
    assert.match(rows[at + 1], /^│ {5}Ctrl\+C Ctrl\+C +│$/);
    expectFixture("ampi-tui-help-keymap", "help-narrow-50", lines);
  });

  it("scrolls with j/k and the arrows, a page less one row with PageUp/PageDown, and stops at both ends", () => {
    const h = openHelp({ terminalRows: 24 });
    const first = plain(h.render(80));
    const visible = first.length - 3;
    assert.equal(first.length, 22);
    h.press("j", 2);
    h.press(KEY.down);
    h.press("k");
    assert.equal(h.view.getOffset(), 2);
    h.press("k", 2);
    h.press(KEY.pageDown);
    assert.equal(h.view.getOffset(), visible - 1);
    const paged = h.render(80);
    assert.equal(plain(paged)[2], first.at(-2), "the last row of a page starts the next one");
    expectFixture("ampi-tui-help-keymap", "help-paged-80", paged);
    h.press(KEY.pageDown, 20);
    const end = h.render(80);
    assert.match(plain(end).at(-3), /thread scroll to top +Home +Jump to the start of the +.│$/, "the last command ends the list");
    assert.match(plain(end).at(-2), /^│ +transcript +.│$/);
    expectFixture("ampi-tui-help-keymap", "help-end-80", end);
    h.press(KEY.pageUp);
    h.press(KEY.up, 200);
    assert.equal(h.view.getOffset(), 0);
    assert.deepEqual(plain(h.render(80)), first);
    assert.deepEqual(h.closed, []);
  });

  it("closes once on Esc and ignores other keys", () => {
    const h = openHelp();
    h.press("x");
    h.press("\r");
    assert.deepEqual(h.closed, []);
    h.press(KEY.esc);
    h.press(KEY.esc);
    assert.deepEqual(h.closed, [true]);
  });

  it("keeps at least one row on a very short terminal", () => {
    assert.equal(openHelp({ terminalRows: 3 }).render(80).length, 4);
  });
});

describe("ampi-tui keymap JSONC screen", () => {
  it("shows the note and the JSONC at 140 and 80 columns", () => {
    const at140 = openJson().render(140);
    const rows = plain(at140);
    assert.match(rows[2], /^│ To change a key, copy its line into Pi's settings/);
    const note = rows.slice(2, 5).map((row) => row.slice(1, -2).trim()).join(" ");
    assert.match(note, /inside \{ "ampi": \{ "keymap": \{ … \} \} \}/, "the note shows the nested settings key");
    assert.ok(rows.some((row) => /^│ {3}"ampi\.help": null, \/\/ List every key and command/.test(row)));
    assert.ok(rows.some((row) => /^│ {3}"mode\.toggle": \["ctrl\+s", "f2"\], \/\/ Show the mode dial/.test(row)));
    assert.ok(rows.some((row) => /^│ {3}"ampi\.showVersion": "<leader>v", /.test(row)), "a leader chord keeps <leader>");
    expectFixture("ampi-tui-help-keymap", "keymap-json-140", at140);
    const j = openJson({ terminalRows: 24 });
    expectFixture("ampi-tui-help-keymap", "keymap-json-80", j.render(80));
    j.press(KEY.pageDown, 5);
    const end = j.render(80);
    assert.match(plain(end).at(-2), /^│ \} +.│$/, "the closing brace is the last line");
    expectFixture("ampi-tui-help-keymap", "keymap-json-end-80", end);
  });

  it("wraps a long comment onto lines that start with // too", () => {
    const lines = plain(help.renderMmrKeymapJsonLines('{\n  "a.b": "ctrl+/", // one two three four five six seven eight nine ten\n}', 40, theme));
    const at = lines.indexOf("{");
    assert.deepEqual(lines.slice(at + 1, at + 4), [
      '  "a.b": "ctrl+/", // one two three four',
      "                   // five six seven",
      "                   // eight nine ten",
    ]);
    const narrow = plain(help.renderMmrKeymapJsonLines('{\n  "thread.scrollToBottom": "end", // follow new output\n}', 36, theme));
    const start = narrow.indexOf("{");
    assert.deepEqual(
      narrow.slice(start + 1, start + 3),
      ['  "thread.scrollToBottom": "end",', "    // follow new output"],
      "without room beside the code the comment moves under it",
    );
  });
});

describe("ampi-tui help and keymap commands", () => {
  beforeEach(() => registry.__resetMmrCommandsForTests());
  afterEach(() => registry.__resetMmrCommandsForTests());

  function start() {
    const mock = createMockPi();
    const context = createMockExtensionContext();
    const keys = createMmrTuiKeys(mock.pi);
    keys.start(context.ctx, () => undefined);
    return { ...context, keys };
  }

  it("registers ampi.help and ampi.keymapJson without keys, always available", () => {
    const t = start();
    for (const id of ["ampi.help", "ampi.keymapJson"]) {
      const entry = registry.getMmrCommand(id);
      assert.ok(entry, `${id} is registered`);
      assert.equal(entry.defaultKey, undefined);
      assert.equal(entry.availability, undefined);
    }
    assert.equal(registry.getMmrCommand("ampi.help").verb, "help");
    assert.equal(registry.getMmrCommand("ampi.keymapJson").verb, "show keymap");
    t.keys.stop();
  });

  it("lists both in the palette, and 'keymap' finds show keymap first", () => {
    const t = start();
    registry.getMmrCommand("ampi.palette").run(t.ctx);
    const palette = t.overlays[0].component;
    const labels = palette.getRows().map((row) => `${row.command.noun} ${row.command.verb}`);
    assert.ok(labels.includes("ampi help"));
    assert.ok(labels.includes("ampi show keymap"));
    for (const character of "keymap") palette.handleInput(character);
    assert.equal(palette.getRows()[0].command.id, "ampi.keymapJson");
    t.keys.stop();
  });

  it("opens the help screen centred, 100 wide with margins, listing every registered command", async () => {
    const t = start();
    registry.getMmrCommand("ampi.help").run(t.ctx);
    const overlay = t.overlays[0];
    assert.deepEqual(overlay.options.overlayOptions, {
      width: 100,
      margin: { left: 2, right: 2, top: 1, bottom: 1 },
      anchor: "center",
    });
    const rows = plain(overlay.component.render(100));
    assert.match(rows[0], /^╭─ ampi — Help & Keymap ─+╮$/);
    assert.equal(rows.length, 22, "without a terminal height, a 24-row terminal is assumed");
    overlay.component.handleInput(KEY.esc);
    assert.equal(overlay.closed, true);

    const sections = help.buildMmrHelpKeymapSections({
      keymap: t.keys.keymap(),
      commands: registry.getMmrCommands(),
      piKeys: () => [],
      modeKeys: false,
      scrolling: false,
    });
    assert.deepEqual(
      rowsOf(sections, "Command Palette Commands").map((row) => row.command.verb).sort(),
      registry
        .getMmrCommands()
        .map((entry) => entry.verb)
        .sort(),
      "every registered command has a row",
    );
    t.keys.stop();
  });

  it("opens the keymap as JSONC for the keymap in effect", () => {
    const mock = createMockPi({ settings: { ampi: { keymap: { "ampi.showVersion": "f5" } } } });
    const context = createMockExtensionContext();
    const keys = createMmrTuiKeys(mock.pi);
    keys.start(context.ctx, () => undefined);
    registry.getMmrCommand("ampi.keymapJson").run(context.ctx);
    const overlay = context.overlays[0];
    const rows = plain(overlay.component.render(100));
    assert.match(rows[0], /^╭─ ampi — Keymap \(JSONC\) ─+╮$/);
    assert.ok(rows.some((row) => row.includes('"ampi.showVersion": "f5"')), "the override shows");
    overlay.component.handleInput(KEY.esc);
    assert.equal(overlay.closed, true);
    keys.stop();
  });
});
