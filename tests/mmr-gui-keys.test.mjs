// ampi-gui keys: the chord grammar, key presses as chords on both
// platforms, sequences on a fake clock, the rules for fields, conflicts,
// when() gating, the default command registry and the keymap overlay's
// columns. The client modules load in Node without a DOM; the page's wiring
// is checked in a browser.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const keys = () => importSource("extensions/ampi-gui/client/keys.js");
const commandsModule = () => importSource("extensions/ampi-gui/client/commands.js");
const keymap = () => importSource("extensions/ampi-gui/client/keymap.js");

/** A key press as the page sees it; `field` puts focus in a text area. */
const press = (key, { field = false, ...mods } = {}) => ({
  key,
  code: "",
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  isComposing: false,
  defaultPrevented: false,
  target: { closest: (selector) => (field && selector.includes("textarea") ? {} : null) },
  ...mods,
});

const command = (id, keyList, extra = {}) => ({ id, title: id, section: "Global", keys: keyList, run: () => {}, ...extra });

describe("ampi-gui keys: chords", () => {
  it("names a key press with modifiers in a fixed order, on Linux and Windows", async () => {
    const { eventChord } = await keys();
    assert.equal(eventChord(press("b", { ctrlKey: true })), "ctrl+b");
    assert.equal(eventChord(press("E", { ctrlKey: true, shiftKey: true })), "ctrl+shift+e");
    assert.equal(eventChord(press("ArrowUp", { ctrlKey: true, altKey: true })), "ctrl+alt+up");
    assert.equal(eventChord(press("ArrowDown", { shiftKey: true })), "shift+down");
    assert.equal(eventChord(press("Escape")), "esc");
    assert.equal(eventChord(press("Enter")), "enter");
    assert.equal(eventChord(press("[", { ctrlKey: true })), "ctrl+[");
    assert.equal(eventChord(press("A")), "a", "Caps Lock types an uppercase letter without shift");
  });

  it("names macOS presses the same way and resolves mod to ⌘ there and to Ctrl elsewhere", async () => {
    const { chordId, eventChord } = await keys();
    assert.equal(eventChord(press("b", { metaKey: true }), { mac: true }), "meta+b");
    assert.equal(chordId("mod+b", { mac: true }), "meta+b");
    assert.equal(chordId("mod+b"), "ctrl+b");
    assert.equal(chordId("mod+shift+e", { mac: true }), "shift+meta+e");
    assert.equal(chordId("ctrl+["), chordId("ctrl+[", { mac: true }), "ctrl stays ctrl on macOS");
    // Option types another character on macOS; the key comes from its position.
    assert.equal(eventChord(press("¿", { altKey: true, shiftKey: true, code: "Slash" }), { mac: true }), "alt+?");
    assert.equal(eventChord(press("∫", { altKey: true, code: "KeyB" }), { mac: true }), "alt+b");
  });

  it("treats a shifted symbol as the symbol it types", async () => {
    const { chordId, eventChord } = await keys();
    assert.equal(eventChord(press("?", { shiftKey: true })), "?");
    assert.equal(chordId("?"), "?");
    assert.equal(chordId("shift+/"), "?");
    assert.equal(eventChord(press("?", { altKey: true, shiftKey: true, code: "Slash" })), "alt+?");
    assert.equal(chordId("alt+shift+/"), "alt+?");
    assert.equal(chordId("G"), "shift+g", "a lone capital letter means shift");
  });

  it("takes a symbol as typed on a layout where it needs Shift, without shifting it again", async () => {
    const { eventChord } = await keys();
    // German and French keyboards type / with Shift on another key, and = with Shift+0.
    assert.equal(eventChord(press("/", { shiftKey: true, code: "Digit7" })), "/");
    assert.equal(eventChord(press("/", { shiftKey: true, code: "Period" })), "/");
    assert.equal(eventChord(press("=", { shiftKey: true, code: "Digit0" })), "=");
    assert.equal(eventChord(press("?", { shiftKey: true, code: "Minus" })), "?");
  });

  it("names a Ctrl or ⌘ letter by its Latin key on a non-Latin layout", async () => {
    const { eventChord } = await keys();
    assert.equal(eventChord(press("и", { ctrlKey: true, code: "KeyB" })), "ctrl+b");
    assert.equal(eventChord(press("У", { ctrlKey: true, shiftKey: true, code: "KeyE" })), "ctrl+shift+e");
    assert.equal(eventChord(press("β", { metaKey: true, code: "KeyB" }), { mac: true }), "meta+b");
    assert.equal(eventChord(press("и", { code: "KeyB" })), "и", "without Ctrl or ⌘ the letter is what it types");
  });

  it("ignores dead keys, bare modifiers and input methods", async () => {
    const { eventChord } = await keys();
    assert.equal(eventChord(press("Dead", { code: "Quote" })), null);
    assert.equal(eventChord(press("Shift", { shiftKey: true })), null);
    assert.equal(eventChord(press("Control", { ctrlKey: true })), null);
    assert.equal(eventChord(press("Process")), null);
    assert.equal(eventChord(press("a", { isComposing: true })), null);
  });

  it("parses the grammar and refuses what it does not know", async () => {
    const { chordId, parseChord } = await keys();
    assert.equal(chordId("Ctrl+G p"), "ctrl+g p");
    assert.equal(chordId("ctrl+g P"), "ctrl+g shift+p", "a lone capital is shift, also as a second step");
    assert.equal(chordId("cmd+option+ArrowUp"), "alt+meta+up");
    assert.equal(chordId("ctrl++"), "ctrl++");
    assert.match(parseChord("hyper+x").error, /modifier/);
    assert.match(parseChord("ctrl+nope").error, /key/);
    assert.match(parseChord("a b c").error, /one or two/);
  });

  it("labels chords with the platform's key names, one chip per step", async () => {
    const { chordLabels } = await keys();
    assert.deepEqual(chordLabels("mod+shift+e"), ["Ctrl+Shift+E"]);
    assert.deepEqual(chordLabels("mod+shift+e", { mac: true }), ["⇧⌘E"]);
    assert.deepEqual(chordLabels("ctrl+alt+up", { mac: true }), ["⌃⌥Up"]);
    assert.deepEqual(chordLabels("ctrl+g p"), ["Ctrl+G", "p"]);
    assert.deepEqual(chordLabels("g g"), ["g", "g"]);
    assert.deepEqual(chordLabels("esc esc"), ["Esc", "Esc"]);
    assert.deepEqual(chordLabels("?"), ["?"]);
    assert.deepEqual(chordLabels("alt+shift+/"), ["Alt+Shift+/"]);
    assert.deepEqual(chordLabels("shift+down"), ["Shift+Down"]);
  });
});

describe("ampi-gui keys: dispatcher", () => {
  it("runs a two-step sequence within the window and not after it", async () => {
    const { createKeyDispatcher, SEQUENCE_MS } = await keys();
    let now = 50_000;
    const pr = command("open-pr", ["ctrl+g p"]);
    const dispatcher = createKeyDispatcher({ commands: () => [pr], now: () => now });
    const first = dispatcher.handle(press("g", { ctrlKey: true }));
    assert.equal(first.kind, "pending");
    assert.equal(first.consume, true, "the browser must not act on ctrl+g");
    now += SEQUENCE_MS;
    assert.deepEqual(dispatcher.handle(press("p")), { kind: "run", command: pr, chord: "ctrl+g p" }, "the window's last millisecond still counts");

    dispatcher.handle(press("g", { ctrlKey: true }));
    now += SEQUENCE_MS + 1;
    assert.equal(dispatcher.handle(press("p")), null, "too late: p is just p");
  });

  it("swallows a wrong key after ctrl+g and fires nothing", async () => {
    const { createKeyDispatcher } = await keys();
    let ran = 0;
    const list = [command("open-pr", ["ctrl+g p"]), command("show-keymap", ["?"], { run: () => ran++ })];
    const dispatcher = createKeyDispatcher({ commands: () => list, now: () => 0 });
    dispatcher.handle(press("g", { ctrlKey: true }));
    assert.deepEqual(dispatcher.handle(press("?", { shiftKey: true })), { kind: "swallow" });
    assert.equal(dispatcher.handle(press("p")), null, "the sequence is over");
    assert.equal(ran, 0);
  });

  it("starts over after a plain first key, so a key after a lone g still works", async () => {
    const { createKeyDispatcher } = await keys();
    const home = command("go-home", ["g g"]);
    const help = command("show-keymap", ["?"]);
    const dispatcher = createKeyDispatcher({ commands: () => [home, help], now: () => 0 });
    assert.equal(dispatcher.handle(press("g")).consume, false);
    assert.equal(dispatcher.handle(press("?", { shiftKey: true })).command, help);
    dispatcher.handle(press("g"));
    assert.equal(dispatcher.handle(press("g")).command, home);
    assert.equal(dispatcher.handle(press("Shift", { shiftKey: true })), null, "a bare modifier neither runs nor breaks a sequence");
  });

  it("finds the sidebar search with / and the keymap with ? on any layout", async () => {
    const { createKeyDispatcher } = await keys();
    const { createCommandRegistry, DEFAULT_COMMANDS } = await commandsModule();
    const registry = createCommandRegistry(DEFAULT_COMMANDS);
    const dispatcher = createKeyDispatcher({ commands: () => registry.list(), now: () => 0 });
    assert.equal(dispatcher.handle(press("/", { shiftKey: true, code: "Digit7" })).command.id, "focus-sidebar-filter", "German Shift+7");
    assert.equal(dispatcher.handle(press("/", { code: "Slash" })).command.id, "focus-sidebar-filter", "US /");
    assert.equal(dispatcher.handle(press("?", { shiftKey: true, code: "Slash" })).command.id, "show-keymap", "US Shift+/");
  });

  it("lets a held key repeat single keys but never start or finish a sequence", async () => {
    const { createKeyDispatcher } = await keys();
    const home = command("go-home", ["g g"]);
    const interrupt = command("thread.interrupt", ["esc esc"]);
    const down = command("sidebar-down", ["j"]);
    const pr = command("open-pr", ["ctrl+g p"]);
    const dispatcher = createKeyDispatcher({ commands: () => [home, interrupt, down, pr], now: () => 0 });
    assert.equal(dispatcher.handle(press("g")).kind, "pending");
    assert.equal(dispatcher.handle(press("g", { repeat: true })), null, "holding g does not go home");
    assert.equal(dispatcher.handle(press("g", { repeat: true })), null);
    assert.equal(dispatcher.handle(press("g")).command, home, "a second press after the hold still does");
    assert.equal(dispatcher.handle(press("Escape")).kind, "pending");
    assert.equal(dispatcher.handle(press("Escape", { repeat: true })), null, "holding Esc does not interrupt");
    assert.equal(dispatcher.handle(press("j", { repeat: true })).command, down, "a held j keeps moving");
    assert.equal(dispatcher.handle(press("g", { ctrlKey: true })).kind, "pending");
    assert.deepEqual(dispatcher.handle(press("g", { ctrlKey: true, repeat: true })), { kind: "swallow" }, "a held Ctrl+G stays off the browser");
    assert.equal(dispatcher.handle(press("p")).command, pr);
  });

  it("fires only Ctrl, Alt or Meta chords and Esc while a field has focus", async () => {
    const { createKeyDispatcher } = await keys();
    const list = [command("sidebar-down", ["j"]), command("focus-prompt", ["ctrl+shift+a"]), command("show-keymap", ["?", "alt+shift+/"]), command("thread.interrupt", ["esc esc"])];
    const dispatcher = createKeyDispatcher({ commands: () => list, now: () => 0 });
    assert.equal(dispatcher.handle(press("j", { field: true })), null, "a letter typed into the composer stays there");
    assert.equal(dispatcher.handle(press("?", { field: true, shiftKey: true })), null);
    assert.equal(dispatcher.handle(press("A", { field: true, ctrlKey: true, shiftKey: true })).command.id, "focus-prompt");
    assert.equal(dispatcher.handle(press("?", { field: true, altKey: true, shiftKey: true, code: "Slash" })).command.id, "show-keymap");
    assert.equal(dispatcher.handle(press("Escape", { field: true })).kind, "pending");
    assert.equal(dispatcher.handle(press("Escape", { field: true })).command.id, "thread.interrupt", "Esc Esc interrupts from the composer");
    assert.equal(dispatcher.handle(press("j")).command.id, "sidebar-down", "outside a field the letter is a key");
  });

  it("finishes or swallows the key after Ctrl+G also in a field", async () => {
    const { createKeyDispatcher } = await keys();
    const list = [command("open-pr", ["ctrl+g p"]), command("go-home", ["g g"])];
    const dispatcher = createKeyDispatcher({ commands: () => list, now: () => 0 });
    assert.equal(dispatcher.handle(press("g", { field: true, ctrlKey: true })).kind, "pending");
    assert.equal(dispatcher.handle(press("p", { field: true })).command.id, "open-pr");
    dispatcher.handle(press("g", { field: true, ctrlKey: true }));
    assert.deepEqual(dispatcher.handle(press("x", { field: true })), { kind: "swallow" }, "a wrong key is not typed");
    assert.equal(dispatcher.handle(press("p", { field: true })), null, "after that p types again");
    dispatcher.handle(press("g"));
    assert.equal(dispatcher.handle(press("g", { field: true })), null, "a plain sequence does not finish in a field");
  });

  it("leaves a key another handler took, and forgets the sequence", async () => {
    const { createKeyDispatcher } = await keys();
    const dispatcher = createKeyDispatcher({ commands: () => [command("thread.interrupt", ["esc esc"])], now: () => 0 });
    dispatcher.handle(press("Escape"));
    assert.equal(dispatcher.handle(press("Escape", { defaultPrevented: true })), null, "the menu closed on this Escape");
    assert.equal(dispatcher.handle(press("Escape")).kind, "pending", "so the next one starts over");
  });

  it("gates on when(): a hidden command is passed over, an unavailable one says why", async () => {
    const { createKeyDispatcher } = await keys();
    const interrupt = command("thread.interrupt", ["esc esc"], {
      when: (state) => (state.busy ? { state: "available" } : { state: "unavailable", reason: "Nothing is running here" }),
    });
    const archive = command("thread.archive", ["ctrl+shift+e"], { when: () => ({ state: "unavailable", reason: "Already archived" }) });
    const messages = command("navigate-user-messages", ["up"], { when: () => ({ state: "hidden" }) });
    const dispatcher = createKeyDispatcher({ commands: () => [interrupt, archive, messages], now: () => 0 });
    assert.equal(dispatcher.handle(press("Escape"), { busy: false }), null, "no turn: Esc starts nothing and says nothing");
    assert.equal(dispatcher.handle(press("Escape"), { busy: true }).kind, "pending");
    assert.equal(dispatcher.handle(press("Escape"), { busy: false }), null, "the turn ended between the two presses");
    assert.deepEqual(dispatcher.handle(press("E", { ctrlKey: true, shiftKey: true })), {
      kind: "unavailable",
      command: archive,
      chord: "ctrl+shift+e",
      reason: "Already archived",
    });
    assert.equal(dispatcher.handle(press("ArrowUp")), null, "a hidden command leaves the arrow to the page");
  });

  it("prefers the focused context and ignores a context that does not listen", async () => {
    const { createKeyDispatcher } = await keys();
    const sidebarUp = command("sidebar-up", ["up"], { section: "Sidebar", context: "sidebar" });
    const messages = command("navigate-user-messages", ["up"]);
    const dispatcher = createKeyDispatcher({ commands: () => [messages, sidebarUp], now: () => 0 });
    assert.equal(dispatcher.handle(press("ArrowUp"), { contexts: ["sidebar", "global"] }).command, sidebarUp);
    assert.equal(dispatcher.handle(press("ArrowUp")).command, messages);
  });

  it("takes a user's keys over the defaults through the overrides hook", async () => {
    const { createKeyDispatcher } = await keys();
    const toggle = command("toggle-sidebar", ["mod+b"]);
    const dispatcher = createKeyDispatcher({ commands: () => [toggle], now: () => 0, overrides: { "toggle-sidebar": ["mod+shift+b"] } });
    assert.equal(dispatcher.handle(press("b", { ctrlKey: true })), null);
    assert.equal(dispatcher.handle(press("B", { ctrlKey: true, shiftKey: true })).command, toggle);
  });

  it("finds the same chord twice and a chord that starts another's sequence, per context and platform", async () => {
    const { findConflicts } = await keys();
    const list = [
      command("a", ["mod+b"]),
      command("b", ["ctrl+b"]),
      command("c", ["g"]),
      command("d", ["g g"]),
      command("e", ["up"], { context: "sidebar" }),
      command("f", ["up"]),
      command("g", ["?", "shift+/"]),
    ];
    assert.deepEqual(findConflicts(list), [
      { chord: "ctrl+b", ids: ["a", "b"], kind: "same" },
      { chord: "g", ids: ["c", "d"], kind: "prefix" },
    ]);
    assert.deepEqual(
      findConflicts(list, { mac: true }).map((conflict) => conflict.ids),
      [["c", "d"]],
      "on macOS mod+b is ⌘B and leaves Ctrl+B alone",
    );
  });

  it("knows the keys a browser tab never receives", async () => {
    const { chordId, isBrowserReserved } = await keys();
    for (const key of ["ctrl+t", "ctrl+w", "ctrl+n", "ctrl+tab", "ctrl+shift+t"]) assert.equal(isBrowserReserved(chordId(key)), true, key);
    assert.equal(isBrowserReserved(chordId("mod+n", { mac: true }), { mac: true }), true);
    assert.equal(isBrowserReserved(chordId("ctrl+n", { mac: true }), { mac: true }), false, "Ctrl+N reaches the page on macOS");
    assert.equal(isBrowserReserved(chordId("ctrl+b")), false);
  });
});

describe("ampi-gui commands", () => {
  it("has no conflicts among the default commands on either platform", async () => {
    const { findConflicts } = await keys();
    const { createCommandRegistry, DEFAULT_COMMANDS } = await commandsModule();
    const list = createCommandRegistry(DEFAULT_COMMANDS).list();
    assert.deepEqual(findConflicts(list), []);
    assert.deepEqual(findConflicts(list, { mac: true }), []);
  });

  it("reuses the terminal's ids where the meaning is the same and kebab-case ids for the page's own", async () => {
    const { DEFAULT_COMMANDS, SECTIONS } = await commandsModule();
    const ids = DEFAULT_COMMANDS.map((entry) => entry.id);
    for (const id of ["thread.archive", "thread.unarchive", "thread.rename", "thread.copyMarkdown", "thread.interrupt"]) assert.ok(ids.includes(id), id);
    for (const entry of DEFAULT_COMMANDS) {
      assert.ok(SECTIONS.includes(entry.section), entry.id);
      assert.ok(entry.id.startsWith("thread.") || /^[a-z]+(-[a-z]+)*$/.test(entry.id), entry.id);
    }
    const byId = Object.fromEntries(DEFAULT_COMMANDS.map((entry) => [entry.id, entry.keys]));
    assert.deepEqual(byId["toggle-sidebar"], ["mod+b"]);
    assert.deepEqual(byId["focus-sidebar-filter"], ["/"]);
    assert.deepEqual(byId["thread.archive"], ["mod+shift+e"]);
    assert.deepEqual(byId["show-keymap"], ["?", "alt+shift+/"]);
    assert.deepEqual(byId["thread.interrupt"], ["esc esc"]);
  });

  it("refuses an entry with a bad id, section or key, and replaces one registered again", async () => {
    const { createCommandRegistry } = await commandsModule();
    const registry = createCommandRegistry();
    assert.throws(() => registry.register(command("Bad_Id", [])), /Invalid command id/);
    assert.throws(() => registry.register(command("x-y", [], { section: "Elsewhere" })), /unknown section/);
    assert.throws(() => registry.register(command("x-y", ["ctrl+nope"])), /does not parse/);
    registry.register(command("x-y", ["a"])).register(command("z", ["b"])).register(command("x-y", ["c"]));
    assert.deepEqual(
      registry.list().map((entry) => [entry.id, entry.keys]),
      [
        ["x-y", ["c"]],
        ["z", ["b"]],
      ],
    );
  });

  it("archives the focused session, else the shown one, and says why it cannot", async () => {
    const { DEFAULT_COMMANDS } = await commandsModule();
    const archive = DEFAULT_COMMANDS.find((entry) => entry.id === "thread.archive");
    const actions = { archive: true, markdown: true };
    const shown = { id: "shown", archived: false, actions };
    const focused = { id: "focused", archived: false, actions };
    const calls = [];
    const ui = { sessionAction: (action, session) => calls.push([action, session.id]) };
    archive.run({ session: shown, focusedSession: focused, ui });
    archive.run({ session: shown, focusedSession: null, ui });
    assert.deepEqual(calls, [
      ["archive", "focused"],
      ["archive", "shown"],
    ]);
    assert.equal(archive.when({ session: shown }).state, "available");
    assert.equal(archive.when({ session: { ...shown, archived: true } }).state, "unavailable");
    assert.equal(archive.when({ session: { ...shown, actions: { archive: false } } }).reason, "Archiving needs ampi-threads");
    assert.equal(archive.when({ session: null }).state, "unavailable");
  });

  it("interrupts only while a turn runs and moves between messages only with an empty, unfocused prompt", async () => {
    const { DEFAULT_COMMANDS } = await commandsModule();
    const get = (id) => DEFAULT_COMMANDS.find((entry) => entry.id === id);
    assert.equal(get("thread.interrupt").when({ interruptible: true }).state, "available");
    assert.equal(get("thread.interrupt").when({ interruptible: false }).state, "unavailable");
    const idle = { threadPage: true, promptEmpty: true, promptFocused: false };
    assert.equal(get("navigate-user-messages").when(idle).state, "available");
    assert.equal(get("navigate-user-messages").when({ ...idle, promptEmpty: false }).state, "hidden", "a draft keeps the arrows for scrolling");
    assert.equal(get("navigate-all-messages").when({ ...idle, promptFocused: true }).state, "hidden");
    assert.equal(get("navigate-user-messages").when({ ...idle, threadPage: false }).state, "hidden", "ampi app's home page has no messages");
    const moves = [];
    const ui = { moveMessage: (step, userOnly) => moves.push([step, userOnly]) };
    get("navigate-user-messages").run({ ui }, { chord: "up" });
    get("navigate-all-messages").run({ ui }, { chord: "shift+down" });
    assert.deepEqual(moves, [
      [-1, true],
      [1, false],
    ]);
    assert.equal(get("focus-prompt").when({ threadPage: true, writable: false }).reason, "This session is read-only here");
  });

  it("offers the selection keys only with text selected, and the outline only for two or more of your messages", async () => {
    const { DEFAULT_COMMANDS } = await commandsModule();
    const get = (id) => DEFAULT_COMMANDS.find((entry) => entry.id === id);
    const selectionIds = ["reply-to-selection", "copy-selection-markdown", "copy-selection-styled", "copy-selection-link"];
    assert.deepEqual(
      selectionIds.map((id) => get(id).keys),
      [["r"], ["c"], ["s"], ["l"]],
    );
    const selected = { selection: true, writable: true, linkBlocked: null };
    for (const id of selectionIds) {
      assert.equal(get(id).when({ ...selected, selection: false }).state, "hidden", `${id} without a selection`);
      assert.equal(get(id).when(selected).state, "available", id);
      assert.equal(get(id).palette, false, `${id} stays out of the palette, which would take the selection`);
    }
    assert.equal(get("reply-to-selection").when({ ...selected, writable: false }).state, "unavailable");
    assert.equal(get("copy-selection-link").when({ ...selected, linkBlocked: "Not here" }).reason, "Not here");
    const outline = get("toggle-outline");
    assert.equal(outline.when({ threadPage: true, userMessages: 1 }).state, "unavailable");
    assert.equal(outline.when({ threadPage: true, userMessages: 2 }).state, "available");
    assert.equal(outline.when({ threadPage: false, userMessages: 3 }).state, "hidden");
    const ran = [];
    const ui = Object.fromEntries(["toggleOutline", "replyToSelection", "copySelectionMarkdown", "copySelectionStyled", "copySelectionLink"].map((name) => [name, () => ran.push(name)]));
    for (const id of ["toggle-outline", ...selectionIds]) get(id).run({ ui });
    assert.deepEqual(ran, ["toggleOutline", "replyToSelection", "copySelectionMarkdown", "copySelectionStyled", "copySelectionLink"]);
  });
});

describe("ampi-gui keymap overlay", () => {
  it("shows Global, Sidebar and Thread columns on a session page and only Global elsewhere", async () => {
    const { createCommandRegistry, DEFAULT_COMMANDS } = await commandsModule();
    const { keymapGroups } = await keymap();
    const list = createCommandRegistry(DEFAULT_COMMANDS).list();
    const thread = keymapGroups(list, { threadPage: true });
    assert.deepEqual(
      thread.map((group) => group.label),
      ["Global", "Sidebar", "Thread"],
    );
    const titles = (group) => group.rows.map((row) => row.title);
    assert.ok(titles(thread[0]).includes("Go back"), "Navigation entries sit in the Global column");
    assert.ok(titles(thread[2]).includes("Show chat and focus prompt"), "Thread Panes entries sit in the Thread column");
    assert.ok(!titles(thread[2]).includes("Rename session"), "commands without keys are left out");
    assert.deepEqual(
      keymapGroups(list, { threadPage: false }).map((group) => group.label),
      ["Global"],
    );
  });

  it("joins a command's keys as chips in the platform's names and marks the ones a tab keeps", async () => {
    const { DEFAULT_COMMANDS } = await commandsModule();
    const { keymapGroups } = await keymap();
    const row = (groups, id) => groups.flatMap((group) => group.rows).find((entry) => entry.id === id);
    const linux = keymapGroups(DEFAULT_COMMANDS, { threadPage: true });
    assert.deepEqual(row(linux, "show-keymap").chords, [
      { chips: ["?"], reserved: false },
      { chips: ["Alt+Shift+/"], reserved: false },
    ]);
    assert.deepEqual(row(linux, "go-home").chords, [{ chips: ["g", "g"], reserved: false }]);
    assert.deepEqual(
      row(linux, "sidebar-down").chords.map((chord) => [chord.chips.join(" "), chord.reserved]),
      [
        ["Down", false],
        ["j", false],
        ["Ctrl+N", true],
      ],
    );
    const mac = keymapGroups(DEFAULT_COMMANDS, { threadPage: true, mac: true });
    assert.deepEqual(row(mac, "toggle-sidebar").chords, [{ chips: ["⌘B"], reserved: false }]);
    assert.equal(row(mac, "sidebar-down").chords[2].reserved, false, "Ctrl+N reaches the page on macOS");
  });
});

describe("ampi-gui copy URL", () => {
  it("copies the address without the access token", async () => {
    const { shareableUrl } = await importSource("extensions/ampi-gui/client/app-mode.js");
    assert.equal(shareableUrl("http://127.0.0.1:4100/s/abc"), "http://127.0.0.1:4100/s/abc");
    assert.equal(shareableUrl("http://127.0.0.1:4100/?t=secret#/s/abc"), "http://127.0.0.1:4100/#/s/abc");
    assert.equal(shareableUrl("http://127.0.0.1:4100/?x=1&t=secret"), "http://127.0.0.1:4100/?x=1");
    assert.equal(shareableUrl("http://127.0.0.1:4100/#"), "http://127.0.0.1:4100/", "an empty fragment is dropped");
  });
});
