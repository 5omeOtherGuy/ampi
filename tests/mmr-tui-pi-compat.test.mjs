// Probes for the Pi runtime surface that ampi-tui uses outside Pi's extension
// API. Each adapter in src/extensions/ampi-tui/pi-compat/ has a probe here
// against the installed Pi packages; a failure means Pi changed shape and the
// adapter needs updating.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

let editorCompat;
let scrollCompat;
let reservedKeys;
let terminalInput;

before(async () => {
  editorCompat = await importSource("extensions/ampi-tui/pi-compat/editor.ts");
  scrollCompat = await importSource("extensions/ampi-tui/pi-compat/scroll.ts");
  reservedKeys = await importSource("extensions/ampi-tui/pi-compat/reserved-keys.ts");
  terminalInput = await importSource("extensions/ampi-tui/pi-compat/terminal-input.ts");
});

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

  it("scroll: only Pi's fullscreen renderer can scroll the transcript", () => {
    assert.equal(typeof TuiAltScreen.prototype.scrollToTop, "function");
    assert.equal(typeof TuiAltScreen.prototype.scrollToBottom, "function");
    assert.ok(scrollCompat.getMmrTranscriptScroller(Object.create(TuiAltScreen.prototype)));
    assert.equal(scrollCompat.getMmrTranscriptScroller(new TuiMainScreen(stubTerminal())), undefined);
  });

  it("reserved keys: the reserved action list matches Pi's", () => {
    // The package entry is dist/index.js; the runner sits beside it.
    const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const source = readFileSync(path.join(path.dirname(entry), "core/extensions/runner.js"), "utf8");
    const match = /RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS = \[([^\]]*)\]/.exec(source);
    assert.ok(match, "Pi no longer declares its reserved shortcut list where the probe expects it");
    const piActions = [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]).sort();
    assert.deepEqual(Object.keys(reservedKeys.MMR_PI_RESERVED_ACTION_KEYS).sort(), piActions);
  });

  it("reserved keys: ampi combos map to Pi key ids", () => {
    const combo = (key, mods = {}) => ({ key, ctrl: false, alt: false, shift: false, meta: false, ...mods });
    assert.equal(reservedKeys.toMmrPiKeyId(combo("esc")), "escape");
    assert.equal(reservedKeys.toMmrPiKeyId(combo("pageup", { ctrl: true })), "ctrl+pageUp");
    assert.equal(reservedKeys.toMmrPiKeyId(combo("k", { meta: true, shift: true })), "shift+super+k");
    assert.equal(reservedKeys.toMmrPiKeyId(combo("f5")), "f5");
  });
});
