// Probes for the Pi runtime surface that ampi-tui uses outside Pi's extension
// API. Each adapter in src/extensions/ampi-tui/pi-compat/ has a probe here
// against the installed Pi packages; a failure means Pi changed shape and the
// adapter needs updating.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { CustomEditor, InteractiveMode } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

let editorCompat;
let editorHeight;
let scrollCompat;
let reservedKeys;
let terminalInput;
let messages;
let keymap;
let slashCommands;
let queueCompat;

before(async () => {
  queueCompat = await importSource("extensions/ampi-tui/pi-compat/queue.ts");
  slashCommands = await importSource("extensions/ampi-tui/pi-compat/slash-commands.ts");
  editorCompat = await importSource("extensions/ampi-tui/pi-compat/editor.ts");
  editorHeight = await importSource("extensions/ampi-tui/pi-compat/editor-height.ts");
  scrollCompat = await importSource("extensions/ampi-tui/pi-compat/scroll.ts");
  reservedKeys = await importSource("extensions/ampi-tui/pi-compat/reserved-keys.ts");
  terminalInput = await importSource("extensions/ampi-tui/pi-compat/terminal-input.ts");
  messages = await importSource("extensions/ampi-tui/pi-compat/messages.ts");
  keymap = await importSource("extensions/ampi-core/keymap.ts");
});

/** Pi's coding-agent dist directory; the package entry is dist/index.js. */
function piDist() {
  return path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
}

/** A terminal whose every method is a no-op, enough for a TUI that never starts. */
function stubTerminal() {
  return new Proxy({ columns: 80, rows: 24 }, { get: (target, name) => (name in target ? target[name] : () => {}) });
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

describe("ampi-tui Pi compatibility probes", () => {
  it("terminal input: listeners run before the focused component and can consume a key", () => {
    const tui = new TuiMainScreen(stubTerminal());
    const seen = [];
    tui.setFocus({ handleInput: (data) => seen.push(`component:${data}`), render: () => [], invalidate() {} });
    const ui = { onTerminalInput: (handler) => tui.addInputListener(handler) };
    const unsubscribe = terminalInput.subscribeMmrTerminalInput(ui, (data) => data === "x");
    tui.handleTerminalInput("x");
    tui.handleTerminalInput("y");
    assert.deepEqual(seen, ["component:y"]);
    unsubscribe();
    tui.handleTerminalInput("x");
    assert.deepEqual(seen, ["component:y", "component:x"]);
  });

  it("editor: Pi's prompt editor keeps app actions in an actionHandlers map and is found through focus", () => {
    const tui = new TuiMainScreen(stubTerminal());
    const editor = new CustomEditor(tui, editorTheme, new KeybindingsManager({}));
    let ran = 0;
    editor.onAction("app.editor.external", () => {
      ran += 1;
    });
    tui.setFocus(editor);
    assert.equal(editorCompat.isMmrEditorFocused(tui), true);
    assert.equal(editorCompat.hasMmrEditorAction(tui, "app.editor.external"), true);
    assert.equal(editorCompat.runMmrEditorAction(tui, "app.editor.external"), true);
    assert.equal(ran, 1);

    tui.setFocus({ handleInput() {}, render: () => [], invalidate() {} });
    assert.equal(editorCompat.isMmrEditorFocused(tui), false);
    assert.equal(editorCompat.runMmrEditorAction(tui, "app.editor.external"), false);
    assert.equal(editorCompat.isMmrEditorFocused(undefined), true, "unknown focus keeps keys working");
  });

  it("editor: Pi's prompt editor reports an open autocomplete list, which Esc closes", async () => {
    const tui = new TuiMainScreen(stubTerminal());
    const editor = new CustomEditor(tui, editorTheme, new KeybindingsManager({}));
    editor.setAutocompleteProvider({
      getSuggestions: async () => ({ items: [{ value: "help", label: "help" }], prefix: "/" }),
      applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
    });
    tui.setFocus(editor);
    assert.equal(editorCompat.isMmrEditorShowingAutocomplete(tui), false);
    editor.handleInput("/");
    // The suggestions arrive through a promise chain inside the editor.
    for (let turn = 0; turn < 10 && !editorCompat.isMmrEditorShowingAutocomplete(tui); turn++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(editorCompat.isMmrEditorShowingAutocomplete(tui), true);
    editor.handleInput("\x1b");
    assert.equal(editorCompat.isMmrEditorShowingAutocomplete(tui), false);
    assert.equal(editor.getText(), "/", "Esc only closed the list");
  });

  it("editor: the recorded height matches the rows Pi's prompt editor rendered", () => {
    const tui = new TuiMainScreen(stubTerminal());
    const editor = new CustomEditor(tui, editorTheme, new KeybindingsManager({}));
    tui.setFocus(editor);
    for (const text of ["", "one line", "x".repeat(300), "a\nb\nc"]) {
      editor.setText(text);
      const rendered = editor.render(80).length;
      assert.equal(editorCompat.getMmrEditorRenderedHeight(tui), rendered, JSON.stringify(text.slice(0, 12)));
    }
    assert.ok(editorCompat.getMmrEditorRenderedHeight(tui) >= 5, "a 300-column line wraps at 80 columns");
    tui.setFocus({ handleInput() {}, render: () => [], invalidate() {} });
    assert.equal(editorCompat.getMmrEditorRenderedHeight(tui), undefined);
  });

  it("editor: Enter hands the prompt text to the editor's onSubmit handler, which the adapter can call", () => {
    const tui = new TuiMainScreen(stubTerminal());
    const editor = new CustomEditor(tui, editorTheme, new KeybindingsManager({}));
    const submitted = [];
    editor.onSubmit = (text) => submitted.push(text);
    tui.setFocus(editor);
    editor.setText("typed");
    editor.handleInput("\r");
    assert.deepEqual(submitted, ["typed"], "Pi's editor submits through onSubmit");
    assert.equal(editorCompat.canMmrSubmitEditorText(tui), true);
    assert.equal(editorCompat.submitMmrEditorText(tui, "/tree"), true);
    assert.deepEqual(submitted, ["typed", "/tree"]);

    tui.setFocus({ handleInput() {}, render: () => [], invalidate() {} });
    assert.equal(editorCompat.canMmrSubmitEditorText(tui), false);
    assert.equal(editorCompat.submitMmrEditorText(tui, "/tree"), false);
  });

  it("editor: Pi's interactive mode runs slash commands from onSubmit and toggles thinking through an editor action", () => {
    const source = readFileSync(path.join(piDist(), "modes/interactive/interactive-mode.js"), "utf8");
    assert.match(source, /defaultEditor\.onSubmit = async \(text\) => \{[\s\S]{0,400}text === "\/settings"/, "onSubmit handles built-in commands");
    assert.match(source, /onAction\("app\.thinking\.toggle", \(\) => this\.toggleThinkingBlockVisibility\(\)\)/);
    assert.match(
      source,
      /toggleThinkingBlockVisibility\(\) \{\s*this\.hideThinkingBlock = !this\.hideThinkingBlock;\s*this\.settingsManager\.setHideThinkingBlock\(this\.hideThinkingBlock\);/,
      "the toggle saves hideThinkingBlock, which pi.getSettings() reports",
    );
  });

  it("slash commands: the built-in command list matches Pi's", async () => {
    const { BUILTIN_SLASH_COMMANDS } = await import(pathToFileURL(path.join(piDist(), "core/slash-commands.js")).href);
    assert.deepEqual(
      slashCommands.MMR_PI_BUILTIN_SLASH_COMMANDS.map(({ name, description }) => ({ name, description })),
      BUILTIN_SLASH_COMMANDS.map(({ name, description }) => ({ name, description })),
    );
  });

  it("slash commands: the commands marked as taking arguments are the ones Pi's submit handler reads arguments for", () => {
    const source = readFileSync(path.join(piDist(), "modes/interactive/interactive-mode.js"), "utf8");
    const withArguments = [...source.matchAll(/text\.startsWith\("\/([a-z-]+) "\)/g)].map((match) => match[1]);
    assert.ok(withArguments.length > 0, "Pi no longer reads slash command arguments where the probe expects it");
    assert.deepEqual(
      slashCommands.MMR_PI_BUILTIN_SLASH_COMMANDS.filter((command) => command.takesArguments)
        .map((command) => command.name)
        .sort(),
      [...new Set(withArguments)].sort(),
    );
  });

  it("editor height: Pi's editor shows at most max(5, 30% of the terminal rows) text rows", () => {
    for (const rows of [10, 24, 44, 60]) {
      const tui = new TuiMainScreen(new Proxy({ columns: 80, rows }, { get: (t, n) => (n in t ? t[n] : () => {}) }));
      const editor = new CustomEditor(tui, editorTheme, new KeybindingsManager({}));
      editor.setText(Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n"));
      assert.equal(editor.render(80).length - 2, Math.max(5, Math.floor(rows * 0.3)), `${rows} rows`);
    }
  });

  it("editor height: a TUI view with a stand-in terminal height sets the editor's maximum", () => {
    const tui = new TuiMainScreen(stubTerminal());
    let renders = 0;
    tui.requestRender = () => {
      renders += 1;
    };
    const editor = new CustomEditor(tui, editorTheme, new KeybindingsManager({}));
    editor.setText(Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n"));
    for (const maxLines of [5, 6, 8, 13, 14, 20, 33]) {
      editor.tui = editorHeight.mmrTuiWithEditorMaxLines(tui, maxLines);
      assert.equal(editor.render(80).length - 2, maxLines, `${maxLines} lines`);
    }
    editor.tui = editorHeight.mmrTuiWithEditorMaxLines(tui, 3);
    assert.equal(editor.render(80).length - 2, editorHeight.MMR_PI_EDITOR_MIN_MAX_LINES, "Pi keeps its floor");
    editor.tui.requestRender();
    assert.equal(renders, 1, "the view forwards calls to the real TUI");
    assert.equal(editorHeight.mmrTuiWithEditorMaxLines(tui, 14), editorHeight.mmrTuiWithEditorMaxLines(tui, 14));
  });

  it("scroll: only Pi's fullscreen renderer can scroll the transcript", () => {
    assert.equal(typeof TuiAltScreen.prototype.scrollToTop, "function");
    assert.equal(typeof TuiAltScreen.prototype.scrollToBottom, "function");
    assert.ok(scrollCompat.getMmrTranscriptScroller(Object.create(TuiAltScreen.prototype)));
    assert.equal(scrollCompat.getMmrTranscriptScroller(new TuiMainScreen(stubTerminal())), undefined);
  });

  it("reserved keys: the reserved action list matches Pi's", () => {
    const source = readFileSync(path.join(piDist(), "core/extensions/runner.js"), "utf8");
    const match = /RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS = \[([^\]]*)\]/.exec(source);
    assert.ok(match, "Pi no longer declares its reserved shortcut list where the probe expects it");
    const piActions = [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]).sort();
    assert.deepEqual(Object.keys(reservedKeys.MMR_PI_RESERVED_ACTION_KEYS).sort(), piActions);
  });

  it("reserved keys: every default key Pi gives a reserved action is listed", async () => {
    // Pi's app keybinding table is not exported from the package entry.
    const { KeybindingsManager: PiKeybindings } = await import(pathToFileURL(path.join(piDist(), "core/keybindings.js")).href);
    const defaults = new PiKeybindings({});
    const canonical = (key) => {
      const parsed = keymap.parseMmrKeyChord(key);
      assert.ok(!("error" in parsed), `Pi key "${key}" does not parse`);
      return keymap.formatMmrKeyChord(parsed);
    };
    for (const [action, keys] of Object.entries(reservedKeys.MMR_PI_RESERVED_ACTION_KEYS)) {
      const piKeys = defaults.getKeys(action).map(canonical);
      assert.ok(piKeys.length > 0, `${action} has no default key in Pi`);
      for (const key of piKeys) assert.ok(keys.includes(key), `${action}: Pi binds ${key} by default`);
    }
  });

  it("messages: Pi's user message component has the shape the drawing patch relies on", () => {
    assert.equal(
      messages.probeMmrUserMessageComponent(),
      undefined,
      "Pi changed UserMessageComponent; update src/extensions/ampi-tui/pi-compat/messages.ts",
    );
  });

  it("queue: Pi's interactive mode reads, empties and reports its queue through the methods the watch uses", () => {
    assert.equal(queueCompat.probeMmrPiQueue(), undefined, "Pi changed InteractiveMode; update src/extensions/ampi-tui/pi-compat/queue.ts");
    const original = InteractiveMode.prototype.updatePendingMessagesDisplay;
    // A stand-in with the fields Pi's own methods read; they run unchanged on it.
    let steering = ["steer now"];
    let followUp = ["later one", "later two"];
    const drawn = ["Pi's list"];
    const session = {
      getSteeringMessages: () => steering,
      getFollowUpMessages: () => followUp,
      clearQueue() {
        const taken = { steering, followUp };
        steering = [];
        followUp = [];
        return taken;
      },
    };
    // `session` is a getter that reads the runtime host's session.
    const mode = Object.assign(Object.create(InteractiveMode.prototype), {
      runtimeHost: { session },
      compactionQueuedMessages: [{ text: "after compaction", mode: "followUp" }],
      pendingMessagesContainer: { clear: () => drawn.splice(0), addChild: (child) => drawn.push(child) },
    });
    const reports = [];
    const watch = queueCompat.watchMmrPiQueue((queue) => reports.push(queue));
    try {
      assert.ok(watch);
      assert.equal(watch.take(), undefined, "nothing to take before Pi reported its queue");
      mode.updatePendingMessagesDisplay();
      assert.deepEqual(reports, [{ steering: ["steer now"], followUp: ["later one", "later two", "after compaction"] }]);
      assert.deepEqual(drawn, [], "Pi's own list is left empty");
      assert.deepEqual(watch.take(), { steering: ["steer now"], followUp: ["later one", "later two", "after compaction"] });
      assert.deepEqual(reports.at(-1), { steering: [], followUp: [] }, "the emptied queue is reported");
    } finally {
      watch?.stop();
    }
    assert.equal(InteractiveMode.prototype.updatePendingMessagesDisplay, original, "stop gives Pi its own method back");
  });

  it("reserved keys: ampi combos map to Pi key ids", () => {
    const combo = (key, mods = {}) => ({ key, ctrl: false, alt: false, shift: false, meta: false, ...mods });
    assert.equal(reservedKeys.toMmrPiKeyId(combo("esc")), "escape");
    assert.equal(reservedKeys.toMmrPiKeyId(combo("pageup", { ctrl: true })), "ctrl+pageUp");
    assert.equal(reservedKeys.toMmrPiKeyId(combo("k", { meta: true, shift: true })), "shift+super+k");
    assert.equal(reservedKeys.toMmrPiKeyId(combo("f5")), "f5");
  });
});
