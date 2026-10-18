// ampi-tui's prompt commands (prompt clear, the line moves, copy selection)
// and ampi.terminal.detailsExpandedByDefault: availability, what each one
// changes, the line moves in ampi's own prompt box, and the details expanded
// at session start once the prompt editor can be reached.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, afterEach, before, describe, it } from "node:test";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

let commands;
let registry;
let tuiExtension;
before(async () => {
  commands = await importSource("extensions/ampi-tui/keys/commands.ts");
  registry = await importSource("extensions/ampi-core/command-registry.ts");
  tuiExtension = await importSource("extensions/ampi-tui/index.ts");
});

const AVAILABLE = { state: "available" };
const NOT_FOCUSED = { state: "unavailable", reason: "the prompt is not focused" };

/**
 * A TUI whose focused component is a stand-in for Pi's prompt editor (it
 * records the input it is handed) or, with `focused: false`, an overlay.
 * `selection`: `undefined` for Pi's regular renderer, else the fullscreen
 * renderer's selection state.
 */
function fakeTui({ focused = true, selection } = {}) {
  const editor = {
    actionHandlers: new Map([["app.editor.external", () => {}]]),
    inputs: [],
    handleInput(data) {
      this.inputs.push(data);
    },
  };
  const tui = {
    focused,
    renders: 0,
    copies: 0,
    editor,
    getFocusedComponent: () => (tui.focused ? editor : { handleInput() {}, render: () => [] }),
    requestRender: () => {
      tui.renders += 1;
    },
  };
  if (selection) {
    tui.hasActiveSelection = () => selection.text !== undefined;
    tui.copyActiveSelectionToClipboard = async () => {
      tui.copies += 1;
      return selection.text !== undefined;
    };
  }
  return tui;
}

function setup({ text = "", ...tuiOptions } = {}) {
  const tui = fakeTui(tuiOptions);
  const list = commands.createMmrTuiCommands({ getTui: () => tui, pi: { getCommands: () => [], getSettings: () => ({}) } });
  const context = createMockExtensionContext({ editorText: text });
  const find = (id) => list.find((command) => command.id === id);
  return { tui, context, ctx: context.ctx, find, availability: (id) => find(id).availability?.(context.ctx) ?? AVAILABLE };
}

describe("ampi-tui prompt commands", () => {
  it("lists prompt clear, the line moves and copy selection under prompt, with no default key", () => {
    const { find } = setup();
    for (const [id, verb] of [
      ["prompt.clear", "clear"],
      ["prompt.moveToLineStart", "move to line start"],
      ["prompt.moveToLineEnd", "move to line end"],
      ["prompt.copySelection", "copy selection"],
    ]) {
      assert.equal(find(id).noun, "prompt", id);
      assert.equal(find(id).verb, verb, id);
      assert.equal(find(id).defaultKey, undefined, id);
    }
  });

  it("offers prompt clear only for a focused prompt with text", () => {
    assert.deepEqual(setup({ text: "draft" }).availability("prompt.clear"), AVAILABLE);
    assert.deepEqual(setup({ text: "" }).availability("prompt.clear"), { state: "unavailable", reason: "the prompt is empty" });
    assert.deepEqual(setup({ text: "draft", focused: false }).availability("prompt.clear"), NOT_FOCUSED);
  });

  it("prompt clear empties the prompt and redraws at once", () => {
    const t = setup({ text: "draft" });
    t.find("prompt.clear").run(t.ctx);
    assert.equal(t.context.state.editorText, "");
    assert.equal(t.tui.renders, 1);
  });

  it("offers the line moves whenever the prompt is focused, empty or not", () => {
    for (const id of ["prompt.moveToLineStart", "prompt.moveToLineEnd"]) {
      assert.deepEqual(setup({ text: "" }).availability(id), AVAILABLE, id);
      assert.deepEqual(setup({ text: "two\nlines" }).availability(id), AVAILABLE, id);
      assert.deepEqual(setup({ text: "two\nlines", focused: false }).availability(id), NOT_FOCUSED, id);
    }
  });

  it("moves the cursor by handing the editor the first key pi-tui binds to the action, then redraws", () => {
    const t = setup({ text: "draft" });
    t.find("prompt.moveToLineStart").run(t.ctx);
    t.find("prompt.moveToLineEnd").run(t.ctx);
    // pi-tui binds Home, then Ctrl+A, to the line start, and End, then Ctrl+E, to the line end.
    assert.deepEqual(t.tui.editor.inputs, ["\x1b[H", "\x1b[F"]);
    assert.equal(t.tui.renders, 2);
    t.tui.focused = false;
    assert.throws(() => t.find("prompt.moveToLineEnd").run(t.ctx), /the prompt is not focused/);
    assert.equal(t.tui.editor.inputs.length, 2);
  });

  it("offers copy selection only in fullscreen mode with transcript text selected", () => {
    assert.deepEqual(setup().availability("prompt.copySelection"), {
      state: "unavailable",
      reason: "transcript text can be selected only in Pi's fullscreen mode",
    });
    assert.deepEqual(setup({ selection: {} }).availability("prompt.copySelection"), {
      state: "unavailable",
      reason: "no transcript text is selected",
    });
    assert.deepEqual(setup({ selection: { text: "hello" } }).availability("prompt.copySelection"), AVAILABLE);
  });

  it("copy selection copies through Pi's fullscreen copy, and says so when the selection is gone", async () => {
    const selection = { text: "hello" };
    const t = setup({ selection });
    await t.find("prompt.copySelection").run(t.ctx);
    assert.equal(t.tui.copies, 1);
    assert.deepEqual(t.context.notifications, [], "Pi flashes its own confirmation");
    selection.text = undefined;
    await t.find("prompt.copySelection").run(t.ctx);
    assert.equal(t.tui.copies, 1);
    assert.deepEqual(t.context.notifications, [{ message: "Nothing to copy: the selection was cleared.", level: "info" }]);
  });
});

describe("ampi-tui line moves in the prompt box", () => {
  it("moves the cursor to either end of the current line in ampi's prompt box", async () => {
    const box = await importSource("extensions/ampi-tui/editor/prompt-box.ts");
    const piDist = path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
    const { KeybindingsManager } = await import(pathToFileURL(path.join(piDist, "core/keybindings.js")).href);
    const terminal = new Proxy({ columns: 80, rows: 24 }, { get: (target, name) => (name in target ? target[name] : () => {}) });
    const tui = new TuiMainScreen(terminal);
    const host = {
      slots: () => ({ mode: "medium", status: { busy: false }, waveFrame: 0, location: "/work", overlay: false }),
      theme: () => ({ fg: (_token, text) => text }),
    };
    const editorTheme = { borderColor: (text) => text, selectList: {} };
    const editor = new box.MmrPromptBox(tui, editorTheme, new KeybindingsManager({}), host);
    editor.onAction("app.editor.external", () => {});
    editor.setText("first line\nsecond line");
    tui.setFocus(editor);
    const list = commands.createMmrTuiCommands({ getTui: () => tui, pi: { getCommands: () => [], getSettings: () => ({}) } });
    const run = (id) => list.find((command) => command.id === id).run(createMockExtensionContext().ctx);

    assert.deepEqual(editor.getCursor(), { line: 1, col: 11 });
    run("prompt.moveToLineStart");
    assert.deepEqual(editor.getCursor(), { line: 1, col: 0 });
    run("prompt.moveToLineEnd");
    assert.deepEqual(editor.getCursor(), { line: 1, col: 11 });
    assert.equal(editor.getText(), "first line\nsecond line", "the text stays as it was");
  });
});

describe("ampi.terminal.detailsExpandedByDefault", () => {
  afterEach(() => registry.__resetMmrCommandsForTests());

  /**
   * ampi-tui started with the setting, in a session whose Pi settings hide
   * thinking. The footer factory runs as Pi mounts it, with a TUI whose
   * focus the test moves; `toggles` counts runs of Pi's thinking toggle.
   */
  async function start({ setting, reason = "startup", editorFocused = true }) {
    const mock = createMockPi({ settings: { hideThinkingBlock: true } });
    tuiExtension.createMmrTuiExtension({ loadSettings: () => ({ enabled: true, detailsExpandedByDefault: setting }) })(mock.pi);
    const context = createMockExtensionContext();
    let toggles = 0;
    const editor = { actionHandlers: new Map([["app.thinking.toggle", () => (toggles += 1)]]), handleInput() {}, render: () => [] };
    const tui = {
      focused: editorFocused,
      getFocusedComponent: () => (tui.focused ? editor : { handleInput() {}, render: () => [] }),
      requestRender() {},
    };
    let footer;
    context.ctx.ui.setFooter = (factory) => {
      footer = factory(tui, context.ctx.ui.theme, { onBranchChange: () => () => {} });
    };
    await mock.handlers.get("session_start")({ type: "session_start", reason }, context.ctx);
    /** Draw a frame and let the work queued after it run. */
    const frame = async () => {
      footer.render(80);
      await Promise.resolve();
    };
    const stop = () => mock.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, context.ctx);
    return { tui, state: context.state, toggles: () => toggles, frame, stop };
  }

  it("expands tool output and shows thinking at session start when the editor is reachable at once", async () => {
    const t = await start({ setting: true });
    try {
      assert.equal(t.state.toolsExpanded, true);
      assert.equal(t.toggles(), 1);
      await t.frame();
      assert.equal(t.toggles(), 1, "only once per session start");
    } finally {
      await t.stop();
    }
  });

  it("waits for the first frame that reaches the editor when it is not focused at session start", async () => {
    const t = await start({ setting: true, editorFocused: false });
    try {
      assert.equal(t.state.toolsExpanded, false);
      await t.frame();
      assert.equal(t.state.toolsExpanded, false, "still no editor");
      assert.equal(t.toggles(), 0);
      t.tui.focused = true;
      await t.frame();
      assert.equal(t.state.toolsExpanded, true);
      assert.equal(t.toggles(), 1);
      await t.frame();
      assert.equal(t.toggles(), 1, "only once per session start");
    } finally {
      await t.stop();
    }
  });

  it("expands on new, resumed and forked sessions too", async () => {
    for (const reason of ["new", "resume", "fork"]) {
      const t = await start({ setting: true, reason });
      try {
        assert.equal(t.state.toolsExpanded, true, reason);
        assert.equal(t.toggles(), 1, reason);
      } finally {
        await t.stop();
      }
    }
  });

  it("changes nothing when the setting is off, or on a reload", async () => {
    for (const [setting, reason] of [
      [false, "startup"],
      [undefined, "startup"],
      [true, "reload"],
    ]) {
      const t = await start({ setting, reason });
      try {
        await t.frame();
        assert.equal(t.state.toolsExpanded, false, `${setting} ${reason}`);
        assert.equal(t.toggles(), 0, `${setting} ${reason}`);
      } finally {
        await t.stop();
      }
    }
  });
});
