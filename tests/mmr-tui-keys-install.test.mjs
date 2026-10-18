import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

let createMmrTuiKeys;
let registry;

before(async () => {
  ({ createMmrTuiKeys } = await importSource("extensions/ampi-tui/keys/install.ts"));
  registry = await importSource("extensions/ampi-core/command-registry.ts");
});

/** A TUI handle whose focused component is Pi's editor (it has an action map), with scroll calls recorded. */
function fakeTui({ scrollable = true } = {}) {
  const calls = [];
  const editor = { actionHandlers: new Map([["app.editor.external", () => calls.push("external editor")]]) };
  const tui = {
    focused: editor,
    getFocusedComponent() {
      return this.focused;
    },
  };
  if (scrollable) {
    tui.scrollToTop = () => calls.push("top");
    tui.scrollToBottom = () => calls.push("bottom");
  }
  return { tui, calls, editor };
}

function setup({ settings = {}, idle = true, editorText = "", tuiOptions } = {}) {
  let time = 0;
  const timers = [];
  const mock = createMockPi({ settings });
  const context = createMockExtensionContext({ idle, editorText });
  const handle = fakeTui(tuiOptions);
  const keys = createMmrTuiKeys(mock.pi, {
    now: () => time,
    setTimer: (callback, ms) => {
      const timer = { callback, at: time + ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  keys.start(context.ctx, () => handle.tui);
  return {
    ...mock,
    ...context,
    handle,
    keys,
    send: (data) => context.terminalInput.send(data),
    advance(ms) {
      time += ms;
      for (const timer of timers) {
        if (!timer.cleared && timer.at <= time) {
          timer.cleared = true;
          timer.callback();
        }
      }
    },
  };
}

describe("ampi-tui key installation", () => {
  beforeEach(() => registry.__resetMmrCommandsForTests());
  afterEach(() => registry.__resetMmrCommandsForTests());

  it("registers the first commands with their default keys", () => {
    const t = setup();
    const keysById = Object.fromEntries(registry.getMmrCommands().map((command) => [command.id, command.defaultKey]));
    assert.deepEqual(keysById, {
      "thread.interrupt": "esc esc",
      "ampi.quit": "ctrl+c ctrl+c",
      "thread.scrollToTop": "home",
      "thread.scrollToBottom": "end",
      "prompt.openInEditor": "ctrl+g",
      "ampi.showVersion": undefined,
    });
    t.keys.stop();
    assert.deepEqual(registry.getMmrCommands(), [], "stopping removes them again");
  });

  it("routes every default key through raw input, none through registerShortcut", () => {
    const t = setup();
    assert.deepEqual([...t.shortcuts.keys()], [], "the defaults are chords, reserved keys or conditional keys");
    assert.equal(t.terminalInput.listeners.size, 1);
    assert.equal(t.send("a"), false, "keys that start no chord are left alone");
    assert.equal(t.send("\x07"), true, "ctrl+g is taken from Pi and runs the same editor action");
    assert.deepEqual(t.handle.calls, ["external editor"]);
  });

  it("shows the Ctrl+X popup as a non-capturing overlay that closes when the chord times out", () => {
    const t = setup();
    assert.equal(t.send("\x18"), true);
    assert.equal(t.overlays.length, 1);
    const overlay = t.overlays[0];
    assert.equal(overlay.options.overlay, true);
    const placement = overlay.options.overlayOptions();
    assert.equal(placement.nonCapturing, true);
    assert.equal(placement.anchor, "bottom-right");
    assert.equal(placement.offsetY, -3, "just above an empty prompt and its two borders");
    const lines = overlay.component.render(placement.width);
    assert.match(lines[0], /^╭─ Ctrl\+X then ─+╮$/);
    assert.match(lines[1], /Nothing is bound to Ctrl\+X yet/);
    assert.match(lines.at(-2), /Esc cancel/);

    t.advance(1499);
    assert.equal(overlay.closed, false);
    t.advance(1);
    assert.equal(overlay.closed, true);
    assert.equal(t.send("v"), false, "after the timeout keys are typed normally");
  });

  it("swallows the first Ctrl+C, offers Quit, and quits on the second", () => {
    const t = setup({ editorText: "draft" });
    assert.equal(t.send("\x03"), true, "Pi's clear-input on Ctrl+C no longer runs");
    const lines = t.overlays[0].component.render(t.overlays[0].options.overlayOptions().width);
    assert.match(lines[0], /Ctrl\+C then/);
    assert.match(lines[1], /│ Ctrl\+C {2}Quit +│/);
    assert.equal(t.send("\x03"), true);
    assert.equal(t.lifecycle.shutdown, 1);
    assert.equal(t.lifecycle.abort, 0, "an idle session needs no abort before quitting");
    assert.equal(t.overlays[0].closed, true);
  });

  it("stops a running turn before quitting", () => {
    const t = setup({ idle: false });
    t.send("\x03");
    t.send("\x03");
    assert.deepEqual(t.lifecycle, { abort: 1, shutdown: 1 });
  });

  it("interrupts on Esc Esc only while a turn runs, including a merged double Escape", () => {
    const t = setup({ idle: false });
    assert.equal(t.send("\x1b"), true);
    assert.equal(t.lifecycle.abort, 0, "one Esc does not interrupt");
    assert.equal(t.send("\x1b"), true);
    assert.equal(t.lifecycle.abort, 1);
    assert.equal(t.send("\x1b\x1b"), true);
    assert.equal(t.lifecycle.abort, 2);

    t.state.idle = true;
    assert.equal(t.send("\x1b"), false, "idle: Esc goes to Pi");
    assert.equal(t.send("\x1b\x1b"), false);
    assert.equal(t.lifecycle.abort, 2);
  });

  it("leaves Esc to a selector or dialog that has focus", () => {
    const t = setup({ idle: false });
    t.handle.tui.focused = { handleInput() {} };
    assert.equal(t.send("\x1b"), false);
    assert.equal(t.send("\x18"), false);
  });

  it("scrolls with Home and End only while the prompt is empty", () => {
    const t = setup();
    assert.equal(t.send("\x1b[1~"), true);
    assert.equal(t.send("\x1b[F"), true);
    assert.deepEqual(t.handle.calls, ["top", "bottom"]);
    t.state.editorText = "abc";
    assert.equal(t.send("\x1b[1~"), false, "Home moves the cursor in text");
    assert.deepEqual(t.handle.calls, ["top", "bottom"]);
  });

  it("leaves Home and End alone when Pi's renderer cannot scroll", () => {
    const t = setup({ tuiOptions: { scrollable: false } });
    assert.equal(t.send("\x1b[1~"), false);
  });

  it("applies ampi.keymap overrides: a moved chord, an unbound key and a single-key shortcut", () => {
    const t = setup({
      settings: {
        ampi: { keymap: { "ampi.quit": "ctrl+q ctrl+q", "thread.scrollToTop": null, "ampi.showVersion": "f5" } },
      },
    });
    assert.equal(t.send("\x03"), false, "Ctrl+C goes back to Pi once quit moves away");
    assert.equal(t.send("\x1b[1~"), false, "an unbound Home is left to the editor");
    t.send("\x11");
    t.send("\x11");
    assert.equal(t.lifecycle.shutdown, 1);

    assert.deepEqual([...t.shortcuts.keys()], ["f5"], "an unconditional single key that Pi does not reserve");
    assert.equal(t.shortcuts.get("f5").description, "Show the ampi and Pi versions");
    t.shortcuts.get("f5").handler(t.ctx);
    assert.match(t.notifications.at(-1).message, /^ampi \S+ on Pi \d+\.\d+\.\d+/);
  });

  it("routes a leader binding through raw input and lists it in the popup", () => {
    const t = setup({ settings: { ampi: { keymap: { "ampi.showVersion": "<leader>v" } } } });
    assert.deepEqual([...t.shortcuts.keys()], []);
    t.send("\x18");
    const lines = t.overlays[0].component.render(t.overlays[0].options.overlayOptions().width);
    assert.match(lines[1], /│ v {2}Show the ampi and Pi versions │/);
    assert.equal(t.send("v"), true);
    assert.match(t.notifications.at(-1).message, /^ampi /);
  });

  it("follows a changed leader", () => {
    const t = setup({ settings: { ampi: { keymap: { leader: "ctrl+t" } } } });
    assert.equal(t.send("\x18"), false, "Ctrl+X is Pi's again");
    assert.equal(t.send("\x14"), true);
    assert.match(t.overlays[0].component.render(40)[0], /Ctrl\+T then/);
  });

  it("warns about keymap problems and conflicts once", () => {
    const t = setup({
      settings: { ampi: { keymap: { "thread.scrollToTop": "ctrl+c ctrl+c", "no.suchCommand": "f2" } } },
    });
    const warnings = () => t.notifications.filter((entry) => entry.level === "warning");
    assert.equal(warnings().length, 1);
    assert.match(warnings()[0].message, /ctrl\+c ctrl\+c" is bound to ampi\.quit, thread\.scrollToTop/);
    assert.match(warnings()[0].message, /no\.suchCommand/);

    registry.registerMmrCommand({ id: "other.thing", noun: "other", verb: "thing", description: "Other", run() {} });
    assert.equal(warnings().length, 1, "a rebuild does not repeat the warning");
  });

  it("picks up commands registered later, and their keys", () => {
    const t = setup();
    const runs = [];
    registry.registerMmrCommand({
      id: "prompt.undo",
      noun: "prompt",
      verb: "undo",
      description: "Undo the last edit",
      defaultKey: "<leader>z",
      run: () => runs.push("undo"),
    });
    t.send("\x18");
    t.send("z");
    assert.deepEqual(runs, ["undo"]);
  });

  it("reports a failing command instead of throwing into Pi's input loop", () => {
    const t = setup();
    registry.registerMmrCommand({
      id: "prompt.broken",
      noun: "prompt",
      verb: "broken",
      description: "Broken",
      defaultKey: "<leader>b",
      run: () => {
        throw new Error("boom");
      },
    });
    t.send("\x18");
    assert.equal(t.send("b"), true);
    assert.equal(t.notifications.at(-1).level, "error");
    assert.match(t.notifications.at(-1).message, /prompt\.broken failed: boom/);
  });

  it("unsubscribes raw input on stop", () => {
    const t = setup();
    t.keys.stop();
    assert.equal(t.terminalInput.listeners.size, 0);
  });
});
