// Probes for the Pi runtime surface that ampi-tui uses outside Pi's extension
// API. Each adapter in src/extensions/ampi-tui/pi-compat/ has a probe here
// against the installed Pi packages; a failure means Pi changed shape and the
// adapter needs updating.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { CustomEditor, createAgentSession, InteractiveMode, SessionManager } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, ScrollView, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
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
let overlayCompat;

before(async () => {
  queueCompat = await importSource("extensions/ampi-tui/pi-compat/queue.ts");
  overlayCompat = await importSource("extensions/ampi-tui/pi-compat/overlay.ts");
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

  it("editor: a prompt added to the editor's history comes back on Up", () => {
    const tui = new TuiMainScreen(stubTerminal());
    const editor = new CustomEditor(tui, editorTheme, new KeybindingsManager({}));
    tui.setFocus(editor);
    assert.equal(editorCompat.addMmrEditorHistory(tui, "queued from the palette"), true);
    editor.handleInput("\x1b[A");
    assert.equal(editor.getText(), "queued from the palette");

    tui.setFocus({ handleInput() {}, render: () => [], invalidate() {} });
    assert.equal(editorCompat.addMmrEditorHistory(tui, "lost"), false);
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

  it("scroll: the fullscreen renderer's scroll view draws the transcript and scrolls to a row", () => {
    assert.equal(typeof TuiAltScreen.prototype.getPrimaryScrollView, "function", "Pi no longer has getPrimaryScrollView()");
    for (const member of ["render", "scrollTo"]) assert.equal(typeof ScrollView.prototype[member], "function", `ScrollView.${member}`);
    for (const getter of ["scrollTop", "viewportHeight"]) {
      assert.equal(typeof Object.getOwnPropertyDescriptor(ScrollView.prototype, getter)?.get, "function", `ScrollView.${getter}`);
    }
    const tui = new TuiAltScreen(stubTerminal());
    tui.addChild({ render: () => ["one", "two", "three"], invalidate() {} });
    assert.ok(tui.getPrimaryScrollView() instanceof ScrollView);
    let seen;
    const revealed = scrollCompat.revealMmrTranscriptRows(tui, (lines) => {
      seen = lines;
      return { start: 1, end: 1 };
    });
    assert.equal(revealed, true);
    assert.deepEqual(seen, ["one", "two", "three"], "the scroll view draws the transcript the TUI holds");
    assert.equal(scrollCompat.revealMmrTranscriptRows(new TuiMainScreen(stubTerminal()), () => ({ start: 0, end: 0 })), false);
  });

  it("overlay: Pi reads an overlay's offsetY again on every frame", () => {
    for (const TuiClass of [TuiMainScreen, TuiAltScreen]) {
      const tui = new TuiClass(stubTerminal());
      let offset = -3;
      const options = overlayCompat.withMmrLiveOffsetY({ anchor: "bottom-right", width: 10, nonCapturing: true }, () => offset);
      const handle = tui.showOverlay({ render: () => ["a", "b"], invalidate() {} }, options);
      tui.compositeOverlays([], 80, 24);
      assert.deepEqual(handle.getBounds(), { row: 19, col: 70, width: 10, height: 2 }, TuiClass.name);
      offset = -6;
      tui.compositeOverlays([], 80, 24);
      assert.equal(handle.getBounds().row, 16, `${TuiClass.name} moved the overlay with the new offset`);
      handle.hide();
    }
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

  it("queue: steering a queued follow-up moves only that message inside a live Pi session", async () => {
    assert.equal(queueCompat.probeMmrPiQueue(), undefined, "Pi changed InteractiveMode; update src/extensions/ampi-tui/pi-compat/queue.ts");
    const original = InteractiveMode.prototype.updatePendingMessagesDisplay;
    const offline = process.env.PI_OFFLINE;
    process.env.PI_OFFLINE = "1";
    const dir = mkdtempSync(path.join(os.tmpdir(), "ampi-queue-"));
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, sessionManager: SessionManager.inMemory(dir), noTools: "all" });
    const drawn = ["Pi's list"];
    // Pi's interactive mode around the live session, with the fields its own methods read.
    const mode = Object.assign(Object.create(InteractiveMode.prototype), {
      runtimeHost: { session },
      compactionQueuedMessages: [{ text: "after compaction", mode: "followUp" }],
      pendingMessagesContainer: { clear: () => drawn.splice(0), addChild: (child) => drawn.push(child) },
    });
    session.subscribe((event) => {
      if (event.type === "queue_update") mode.updatePendingMessagesDisplay();
    });
    const reports = [];
    const watch = queueCompat.watchMmrPiQueue((queue) => reports.push(queue));
    try {
      assert.equal(queueCompat.probeMmrPiQueueSession(session), undefined, "Pi changed AgentSession; update src/extensions/ampi-tui/pi-compat/queue.ts");
      assert.ok(watch);
      assert.equal(watch.steerNext(), false, "nothing to steer before Pi reported its queue");

      await session.steer("already steering");
      // What pi.sendMessage(..., { deliverAs: "followUp" }) does while a turn runs.
      session._isAgentRunActive = true;
      await session.sendCustomMessage({ customType: "review-note", content: "note", display: true }, { deliverAs: "followUp" });
      session._isAgentRunActive = false;
      const image = { type: "image", data: "aW1n", mimeType: "image/png" };
      await session.followUp("look at this", [image]);
      await session.followUp("then the docs");
      const queued = () => session.agent.followUpQueue.messages.map((message) => message.customType ?? message.content[0].text);
      assert.deepEqual(queued(), ["review-note", "look at this", "then the docs"], "the custom message waits in the agent's follow-up queue");
      const lookAtThis = session.agent.followUpQueue.messages[1];
      assert.deepEqual(reports.at(-1), { steering: ["already steering"], followUp: ["look at this", "then the docs", "after compaction"] });
      assert.deepEqual(drawn, [], "Pi's own list is left empty");

      assert.equal(watch.steerBlocked(), undefined);
      assert.equal(watch.steerNext(), true);
      assert.deepEqual(queued(), ["review-note", "then the docs"], "the custom message stays queued");
      assert.equal(session.agent.steeringQueue.messages.at(-1), lookAtThis, "the same message steers, image included");
      assert.deepEqual(lookAtThis.content.at(-1), image);
      assert.deepEqual(session.getSteeringMessages(), ["already steering", "look at this"]);
      assert.deepEqual(session.getFollowUpMessages(), ["then the docs"]);
      assert.deepEqual(reports.at(-1), { steering: ["already steering", "look at this"], followUp: ["then the docs", "after compaction"] });

      assert.equal(watch.steerNext(), true);
      assert.equal(watch.steerNext(), false, "no user follow-up is left in the session");
      assert.equal(watch.steerBlocked(), "the queued message waits for compaction to finish");
      assert.deepEqual(queued(), ["review-note"]);
    } finally {
      watch?.stop();
      session.dispose();
      rmSync(dir, { recursive: true, force: true });
      if (offline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = offline;
    }
    assert.equal(InteractiveMode.prototype.updatePendingMessagesDisplay, original, "stop gives Pi its own method back");
  });

  it("queue: removing one queued message takes only it out of a live Pi session", async () => {
    const offline = process.env.PI_OFFLINE;
    process.env.PI_OFFLINE = "1";
    const dir = mkdtempSync(path.join(os.tmpdir(), "ampi-queue-"));
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, sessionManager: SessionManager.inMemory(dir), noTools: "all" });
    const mode = Object.assign(Object.create(InteractiveMode.prototype), {
      runtimeHost: { session },
      compactionQueuedMessages: [],
      pendingMessagesContainer: { clear() {}, addChild() {} },
    });
    session.subscribe((event) => {
      if (event.type === "queue_update") mode.updatePendingMessagesDisplay();
    });
    const reports = [];
    const watch = queueCompat.watchMmrPiQueue((queue) => reports.push(queue));
    try {
      assert.equal(queueCompat.probeMmrPiQueueSession(session), undefined, "Pi changed AgentSession; update src/extensions/ampi-tui/pi-compat/queue.ts");
      await session.steer("steer this");
      session._isAgentRunActive = true;
      await session.sendCustomMessage({ customType: "review-note", content: "note", display: true }, { deliverAs: "followUp" });
      session._isAgentRunActive = false;
      await session.followUp("same");
      await session.followUp("other");
      await session.followUp("same");
      const marked = session.agent.followUpQueue.messages[3];
      const queued = () => session.agent.followUpQueue.messages.map((message) => message.customType ?? message.content[0].text);

      assert.equal(watch.remove("followUp", 0, "other"), false, "the text at the index must match");
      assert.equal(watch.remove("followUp", 5, "same"), false, "an index past the end");
      assert.equal(watch.remove("followUp", 2, "same"), true);
      assert.deepEqual(session.getFollowUpMessages(), ["same", "other"]);
      assert.deepEqual(queued(), ["review-note", "same", "other"], "the custom message and the first equal text stay");
      assert.equal(session.agent.followUpQueue.messages.includes(marked), false, "the second equal message went");
      assert.deepEqual(reports.at(-1), { steering: ["steer this"], followUp: ["same", "other"] });

      assert.equal(watch.remove("steering", 0, "steer this"), true);
      assert.deepEqual(session.getSteeringMessages(), []);
      assert.equal(session.agent.steeringQueue.messages.length, 0);
      assert.equal(queueCompat.removeMmrPiQueuedMessage({}, "followUp", 0, "same"), false, "a session of another shape is left alone");
    } finally {
      watch?.stop();
      session.dispose();
      rmSync(dir, { recursive: true, force: true });
      if (offline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = offline;
    }
  });

  it("reserved keys: ampi combos map to Pi key ids", () => {
    const combo = (key, mods = {}) => ({ key, ctrl: false, alt: false, shift: false, meta: false, ...mods });
    assert.equal(reservedKeys.toMmrPiKeyId(combo("esc")), "escape");
    assert.equal(reservedKeys.toMmrPiKeyId(combo("pageup", { ctrl: true })), "ctrl+pageUp");
    assert.equal(reservedKeys.toMmrPiKeyId(combo("k", { meta: true, shift: true })), "shift+super+k");
    assert.equal(reservedKeys.toMmrPiKeyId(combo("f5")), "f5");
  });
});
