import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

let createMmrTuiKeys;
let registry;
let runtime;

before(async () => {
  ({ createMmrTuiKeys } = await importSource("extensions/ampi-tui/keys/install.ts"));
  registry = await importSource("extensions/ampi-core/command-registry.ts");
  runtime = await importSource("extensions/ampi-core/runtime.ts");
});

/**
 * A TUI handle whose focused component is Pi's editor (it has an action map
 * and a submit handler), with scroll calls, render requests, submitted text
 * and the thinking toggle recorded. The toggle flips
 * `settings.hideThinkingBlock`, as Pi saves it. Set `editor.autocomplete` to
 * open its autocomplete list.
 */
function fakeTui({ scrollable = true } = {}, settings = {}) {
  const calls = [];
  const editor = {
    actionHandlers: new Map([
      ["app.editor.external", () => calls.push("external editor")],
      [
        "app.thinking.toggle",
        () => {
          settings.hideThinkingBlock = !settings.hideThinkingBlock;
          calls.push("thinking toggle");
        },
      ],
    ]),
    onSubmit: (text) => calls.push(`submit ${text}`),
    autocomplete: false,
    isShowingAutocomplete() {
      return this.autocomplete;
    },
  };
  const tui = {
    focused: editor,
    getFocusedComponent() {
      return this.focused;
    },
    requestRender: () => calls.push("render"),
  };
  if (scrollable) {
    tui.scrollToTop = () => calls.push("top");
    tui.scrollToBottom = () => calls.push("bottom");
  }
  return { tui, calls, editor };
}

/** Let pending promise callbacks run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Pi's event bus: `emit` calls every handler `on` registered for the channel. */
function eventBus() {
  const handlers = new Map();
  return {
    emit: (name, data) => {
      for (const handler of [...(handlers.get(name) ?? [])]) handler(data);
    },
    on: (name, handler) => {
      const list = handlers.get(name) ?? new Set();
      list.add(handler);
      handlers.set(name, list);
      return () => list.delete(handler);
    },
  };
}

function setup({ settings = {}, idle = true, editorText = "", tuiOptions, hooks = {}, mock = createMockPi({ settings }), context } = {}) {
  let time = 0;
  const timers = [];
  mock.pi.events = eventBus();
  context ??= createMockExtensionContext({ idle, editorText });
  const handle = fakeTui(tuiOptions, settings);
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
    ...hooks,
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
      "ampi.palette": "ctrl+o",
      "prompt.openPalette": "/",
      "thread.interrupt": "esc esc",
      "ampi.quit": "ctrl+c ctrl+c",
      "thread.scrollToTop": "home",
      "thread.scrollToBottom": "end",
      "prompt.openInEditor": "ctrl+g",
      "ampi.showVersion": undefined,
      "ampi.help": undefined,
      "ampi.keymapJson": undefined,
      "thread.toggleDetails": "alt+t",
      "prompt.toggleHelp": "?",
      "ampi.status": undefined,
      "ampi.changelog": undefined,
      "ampi.config": undefined,
      "mode.toggle": "ctrl+s",
      "mode.use.low": undefined,
      "mode.use.medium": undefined,
      "mode.use.high": undefined,
      "mode.use.ultra": undefined,
      "mode.use.free": undefined,
    });
    t.keys.stop();
    assert.deepEqual(registry.getMmrCommands(), [], "stopping removes them again");
  });

  it("routes the default keys through raw input, except Alt+T, which goes through registerShortcut", () => {
    const t = setup();
    assert.deepEqual([...t.shortcuts.keys()], ["alt+t"], "the other defaults are chords, reserved keys or conditional keys");
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
    assert.equal(placement.width, 48);
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

  it("places the popup above the prompt's rendered rows, so a wrapped line is not covered", () => {
    const t = setup({ editorText: "x".repeat(300) });
    t.handle.editor.renderedVisibleLineCount = 4;
    t.send("\x18");
    assert.equal(t.overlays[0].options.overlayOptions().offsetY, -6, "four wrapped rows plus two borders");
    t.handle.editor.renderedAutocompleteHeight = 5;
    assert.equal(t.overlays[0].options.overlayOptions().offsetY, -11, "an open autocomplete list pushes the prompt up");
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

  it("tells the prompt box about the first Esc, the pending quit and the interrupt", () => {
    const events = [];
    const t = setup({
      idle: false,
      hooks: {
        onEscapePending: () => events.push("esc pending"),
        onQuitPending: (until) => events.push(`quit until ${until}`),
        onInterrupt: () => events.push("interrupt"),
      },
    });
    t.send("\x1b");
    t.send("\x1b");
    assert.deepEqual(events, ["esc pending", "interrupt"]);
    assert.equal(t.lifecycle.abort, 1);

    events.length = 0;
    t.send("\x03");
    assert.deepEqual(events, ["quit until 1500"], "the hint lasts as long as the chord waits");
    t.advance(1500);
    assert.deepEqual(events, ["quit until 1500", "quit until undefined"], "the chord timed out");

    events.length = 0;
    t.send("\x18");
    t.send("\x1b");
    assert.deepEqual(events, [], "the leader is no quit chord, and Esc only cancels it");

    t.state.idle = true;
    t.send("\x1b");
    assert.deepEqual(events, [], "idle: the first Esc goes to the prompt box itself");
  });

  it("places the popup above the prompt box's own height when it reports one", () => {
    const t = setup({ hooks: { editorHeight: () => 9 } });
    t.send("\x18");
    assert.equal(t.overlays[0].options.overlayOptions().offsetY, -9);
  });

  it("ignores kitty key releases between the keys of a chord", () => {
    const quit = setup();
    const ctrlC = "\x1b[99;5u";
    const ctrlCRelease = "\x1b[99;5:3u";
    assert.deepEqual([ctrlC, ctrlCRelease, ctrlC, ctrlCRelease].map(quit.send), [true, false, true, false]);
    assert.equal(quit.lifecycle.shutdown, 1);
    assert.equal(quit.overlays.length, 1, "the release does not close the popup or reopen it");
    quit.keys.stop();

    const busy = setup({ idle: false });
    const escRelease = "\x1b[27;1:3u";
    for (const data of ["\x1b[27u", escRelease, "\x1b[27u", escRelease]) busy.send(data);
    assert.equal(busy.lifecycle.abort, 1);
    for (const data of ["\x1b", escRelease, "\x1b", escRelease]) busy.send(data);
    assert.equal(busy.lifecycle.abort, 2, "a raw Esc press followed by a CSI-u release");
    busy.keys.stop();

    const leader = setup({ settings: { ampi: { keymap: { "ampi.showVersion": "<leader>v" } } } });
    for (const data of ["\x1b[120;5u", "\x1b[120;5:3u", "\x1b[118u", "\x1b[118;1:3u"]) leader.send(data);
    assert.match(leader.notifications.at(-1).message, /^ampi \S+ on Pi/);
  });

  it("lets Esc close the prompt's autocomplete list without interrupting", () => {
    const t = setup({ idle: false });
    t.handle.editor.autocomplete = true;
    assert.equal(t.send("\x1b"), false);
    assert.equal(t.send("\x1b"), false);
    assert.equal(t.send("\x1b\x1b"), false);
    assert.equal(t.lifecycle.abort, 0);

    t.send("\x03");
    assert.equal(t.send("\x1b"), false, "Esc closes the list, not the Ctrl+C popup alone");
    assert.equal(t.overlays[0].closed, true, "and the pending chord is cancelled");

    t.handle.editor.autocomplete = false;
    t.send("\x1b");
    t.send("\x1b");
    assert.equal(t.lifecycle.abort, 1, "with the list closed, Esc Esc interrupts again");
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

  it("toggles the shortcuts help on ? only while the prompt is empty, and exposes the keymap it resolved", () => {
    let toggles = 0;
    let others = 0;
    const t = setup({ hooks: { onToggleHelp: () => (toggles += 1), onKeyCommand: () => (others += 1) } });
    assert.equal(t.send("?"), true);
    assert.equal(t.send("\x1b[47:63;2u"), true, "kitty's shifted form of ? counts too");
    assert.equal(toggles, 2);
    assert.equal(others, 0, "the toggle does not count as another command");
    t.state.editorText = "why";
    assert.equal(t.send("?"), false, "with text, ? is typed");
    assert.equal(toggles, 2);
    assert.deepEqual(t.keys.keymap().bindings.get("prompt.toggleHelp"), [
      { leader: false, combos: [{ key: "?", ctrl: false, alt: false, shift: false, meta: false }] },
    ]);
    t.keys.stop();
    assert.equal(t.keys.keymap(), undefined);
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

    assert.deepEqual([...t.shortcuts.keys()].sort(), ["alt+t", "f5"], "unconditional single keys that Pi does not reserve");
    assert.equal(t.shortcuts.get("f5").description, "Show the ampi and Pi versions");
    t.shortcuts.get("f5").handler(t.ctx);
    assert.match(t.notifications.at(-1).message, /^ampi \S+ on Pi \d+\.\d+\.\d+/);
  });

  it("routes a leader binding through raw input and lists it in the popup", () => {
    const t = setup({ settings: { ampi: { keymap: { "ampi.showVersion": "<leader>v" } } } });
    assert.deepEqual([...t.shortcuts.keys()], ["alt+t"]);
    t.send("\x18");
    const lines = t.overlays[0].component.render(t.overlays[0].options.overlayOptions().width);
    assert.match(lines[1], /│ v {2}Show the ampi and Pi versions +│/);
    assert.equal(t.send("v"), true);
    assert.match(t.notifications.at(-1).message, /^ampi /);
  });

  it("follows a changed leader", () => {
    const t = setup({ settings: { ampi: { keymap: { leader: "alt+x" } } } });
    assert.equal(t.send("\x18"), false, "Ctrl+X is Pi's again");
    assert.equal(t.send("\x1bx"), true);
    assert.match(t.overlays[0].component.render(40)[0], /Alt\+X then/);
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

describe("ampi-tui mode dial key", () => {
  beforeEach(() => {
    registry.__resetMmrCommandsForTests();
    runtime.setMmrModeState(undefined);
  });
  afterEach(() => {
    registry.__resetMmrCommandsForTests();
    runtime.setMmrModeState(undefined);
  });

  it("takes Ctrl+S through raw input, ahead of Pi's and ampi-core's bindings, and opens the dial once above the prompt", async () => {
    const t = setup();
    t.pi.registerCommand("mode", {});
    runtime.setMmrModeState({ mode: "medium" });
    const sent = () => t.calls.sendUserMessage.map((call) => call.content);
    assert.equal(t.shortcuts.has("ctrl+s"), false, "no registerShortcut for ctrl+s");
    assert.equal(t.send("\x13"), true);
    assert.equal(t.overlays.length, 1);
    const overlay = t.overlays[0];
    const placement = overlay.options.overlayOptions();
    assert.deepEqual(placement, { anchor: "bottom-right", width: 58, margin: { left: 4 }, offsetY: -3 });
    assert.equal(overlay.component.getMode(), "medium");
    assert.deepEqual(t.calls.sendUserMessage, [], "opening changes nothing");

    // Keys reach the open dial; each turn goes through /mode.
    overlay.component.handleInput("\x13");
    await settle();
    assert.deepEqual(t.calls.sendUserMessage, [{ content: "/mode high", options: { expandPromptTemplates: true } }]);
    // The command running again (from the palette, say) turns the open dial instead of opening a second one.
    assert.equal(t.send("\x13"), true);
    assert.equal(t.overlays.length, 1);
    assert.equal(overlay.component.getMode(), "ultra");
    await settle();
    assert.deepEqual(sent(), ["/mode high"], "the next switch waits for ampi-core to report this one");
    runtime.setMmrModeState({ mode: "high" });
    t.pi.events.emit(runtime.MMR_EVENT_STATE_CHANGED, runtime.getMmrModeState());
    t.advance(0);
    await settle();
    assert.deepEqual(sent(), ["/mode high", "/mode ultra"]);

    // A switch that reports nothing holds the next one back for 3 s at most,
    // and the dial's last turn still lands after it has closed.
    overlay.component.handleInput("\x13");
    t.advance(2000);
    assert.equal(overlay.closed, true, "the dial closes itself after 2 s");
    await settle();
    assert.deepEqual(sent(), ["/mode high", "/mode ultra"]);
    t.advance(1000);
    await settle();
    assert.deepEqual(sent(), ["/mode high", "/mode ultra", "/mode low"]);

    t.send("\x13");
    assert.equal(t.overlays.length, 2, "the next Ctrl+S opens a new dial");
    t.keys.stop();
    assert.equal(t.overlays[1].closed, true, "stopping closes an open dial");
  });

  it("leaves Ctrl+S to Pi when ampi-core's /mode is missing", () => {
    const t = setup();
    assert.equal(t.send("\x13"), false);
    assert.equal(t.overlays.length, 0);
  });

  it("switches one turn at a time with ampi-core, so fast turns end on the last mode and never drop to free", async () => {
    const core = (await importSource("extensions/ampi-core/index.ts")).default;
    const models = [
      { provider: "openai-codex", id: "gpt-5.6-terra" },
      { provider: "openai-codex", id: "gpt-5.6-sol" },
    ];
    // Pi's setModel takes a moment (checking the provider's auth), then
    // reports model_select before it returns; setThinkingLevel reports
    // thinking_level_select without waiting. The test releases each setModel.
    const inFlight = [];
    const mock = createMockPi({
      activeTools: ["read", "bash", "grep"],
      allTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      thinkingLevel: "off",
      onModelSet: async (model, { handlers, eventContext }) => {
        await new Promise((resolve) => inFlight.push(resolve));
        await handlers.get("model_select")?.({ type: "model_select", model, previousModel: undefined, source: "set" }, eventContext);
      },
      onThinkingLevelSet: (level, { handlers, eventContext }) => {
        void handlers.get("thinking_level_select")?.({ type: "thinking_level_select", level, previousLevel: "off" }, eventContext);
      },
    });
    const context = createMockExtensionContext({ models });
    mock.setEventContext(context.ctx);
    const t = setup({ mock, context });
    core(mock.pi);
    // As in Pi, an extension's /mode runs the command without the sender waiting for it.
    mock.pi.sendUserMessage = (content, options) => {
      mock.calls.sendUserMessage.push({ content, options });
      const [name, ...args] = content.slice(1).split(" ");
      void mock.commands.get(name).handler(args.join(" "), context.ctx);
    };
    const seen = [];
    mock.pi.events.on(runtime.MMR_EVENT_STATE_CHANGED, (state) => seen.push(state.mode));
    const run = async () => {
      // Release the setModel calls one by one, oldest first, and fire due timers, until nothing is left.
      for (let round = 0; round < 50; round++) {
        await settle();
        t.advance(0);
        await settle();
        if (inFlight.length === 0) return;
        inFlight.shift()();
      }
      assert.fail("the switches did not finish");
    };

    void mock.commands.get("mode").handler("medium", context.ctx);
    await run();
    assert.equal(runtime.getMmrModeState()?.mode, "medium");
    seen.length = 0;
    mock.calls.setModel.length = 0;

    t.send("\x13");
    const dial = t.overlays[0].component;
    // A turn to high, and while high is still switching, two more: ultra, low.
    dial.handleInput("\x13");
    await settle();
    assert.equal(inFlight.length, 1);
    dial.handleInput("\x13");
    dial.handleInput("\x13");
    assert.equal(dial.getMode(), "low");
    await settle();
    assert.equal(inFlight.length, 1, "one switch at a time");
    await run();

    assert.equal(runtime.getMmrModeState()?.mode, "low", "the last chosen mode wins");
    assert.deepEqual(seen, ["high", "low"], "never free, and the turns made during a switch collapse into the last one");
    assert.equal(mock.calls.setModel.at(-1)?.id, "gpt-5.6-terra");
    t.keys.stop();
  });
});

describe("ampi-tui command palette and details toggle", () => {
  beforeEach(() => {
    registry.__resetMmrCommandsForTests();
    runtime.setMmrModeState(undefined);
  });
  afterEach(() => {
    registry.__resetMmrCommandsForTests();
    runtime.setMmrModeState(undefined);
  });

  const ENTER = "\r";
  const labels = (overlay) => overlay.component.getRows().map((row) => `${row.command.noun} ${row.command.verb}`);
  /** Type `text` into the open palette, then press Enter. */
  const pick = (overlay, text) => {
    for (const character of text) overlay.component.handleInput(character);
    overlay.component.handleInput(ENTER);
  };
  /** Wait for the palette's result to reach the command it picked. */
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it("opens the palette on Ctrl+O, taking the key from Pi, and lists commands with their keys", () => {
    const t = setup();
    assert.equal(t.send("\x0f"), true);
    assert.equal(t.overlays.length, 1);
    const overlay = t.overlays[0];
    assert.equal(overlay.options.overlayOptions.anchor, "center");
    const rows = labels(overlay);
    assert.ok(!rows.some((row) => row.includes("open command palette")), "the palette does not list itself");
    assert.ok(rows.includes("thread toggle details"));
    assert.ok(rows.includes("pi /model"), "Pi's built-in slash commands are listed under pi");
    assert.ok(rows.includes("thread interrupt"), "unavailable while idle, but listed");
    assert.match(overlay.component.render(80).join("\n"), /toggle details +Alt\+T/);
    assert.match(overlay.component.render(80).join("\n"), /quit +Ctrl\+C Ctrl\+C/);
  });

  it("shows an overridden key in the key column", () => {
    const t = setup({ settings: { ampi: { keymap: { "ampi.showVersion": "<leader>v" } } } });
    t.send("\x0f");
    assert.match(t.overlays[0].component.render(80).join("\n"), /show version +Ctrl\+X v/);
  });

  it("opens the palette on / only while the prompt is empty", () => {
    const t = setup();
    assert.equal(t.send("/"), true, "the slash is not typed");
    assert.equal(t.overlays.length, 1);
    assert.equal(t.overlays[0].component.getQuery(), "");
    t.overlays[0].component.handleInput("\x1b");

    t.state.editorText = "x";
    assert.equal(t.send("/"), false, "with text, / is typed as usual");
    assert.equal(t.overlays.length, 1);

    t.state.editorText = "";
    t.handle.tui.focused = t.overlays[0].component;
    assert.equal(t.send("/"), false, "inside the open palette, / goes to its filter");
  });

  it("runs the picked command after the palette closes, reporting a failure", async () => {
    const t = setup();
    t.send("\x0f");
    pick(t.overlays[0], "show version");
    await settle();
    assert.equal(t.overlays[0].closed, true);
    assert.match(t.notifications.at(-1).message, /^ampi \S+ on Pi/);

    registry.registerMmrCommand({
      id: "prompt.broken",
      noun: "prompt",
      verb: "broken",
      description: "Broken",
      run: () => {
        throw new Error("boom");
      },
    });
    t.send("\x0f");
    pick(t.overlays[1], "broken");
    await settle();
    assert.match(t.notifications.at(-1).message, /prompt\.broken failed: boom/);
  });

  it("runs a Pi slash command through the prompt's submit path, only from an empty prompt", async () => {
    const t = setup();
    t.send("\x0f");
    pick(t.overlays[0], "/tree");
    await settle();
    assert.deepEqual(t.handle.calls, ["submit /tree"]);

    t.state.editorText = "draft";
    t.send("\x0f");
    const row = t.overlays[1].component.getRows().find((entry) => entry.command.verb === "/tree");
    assert.deepEqual({ state: row.state, reason: row.reason }, { state: "unavailable", reason: "the prompt has text" });
  });

  it("puts a command that takes arguments into the prompt instead of submitting it", async () => {
    const t = setup();
    t.pi.registerCommand("review", { description: "Review changes" });
    t.send("\x0f");
    pick(t.overlays[0], "/name");
    await settle();
    assert.equal(t.state.editorText, "/name ", "Pi's /name needs a name after it");
    assert.deepEqual(t.handle.calls, ["render"], "the prompt is redrawn and nothing is submitted");

    t.state.editorText = "";
    t.send("\x0f");
    pick(t.overlays[1], "/review");
    await settle();
    assert.equal(t.state.editorText, "/review ", "extension commands may take arguments");
    assert.deepEqual(t.handle.calls, ["render", "render"]);
    assert.deepEqual(t.calls.sendUserMessage, []);
  });

  it("ranks Pi's built-in commands by Pi's descriptions", () => {
    const t = setup();
    t.send("\x0f");
    for (const character of "session info") t.overlays[0].component.handleInput(character);
    assert.equal(labels(t.overlays[0])[0], "pi /session");
  });

  it("lists extension commands under pi, leaving out legacy mmr- aliases and commands ampi rows run", () => {
    const t = setup();
    for (const name of ["review", "mmr-status", "ampi-status", "ampi-changelog", "ampi-config", "mode", "ampi-thread"]) {
      t.pi.registerCommand(name, { description: name });
    }
    t.send("\x0f");
    const rows = labels(t.overlays[0]).filter((row) => row.startsWith("pi "));
    assert.ok(rows.includes("pi /review"));
    for (const name of ["mmr-status", "ampi-status", "ampi-changelog", "ampi-config", "mode", "ampi-thread"]) {
      assert.ok(!rows.includes(`pi /${name}`), name);
    }
  });

  it("runs ampi-core's slash commands through Pi's command path, and only when they exist", async () => {
    const t = setup();
    t.send("\x0f");
    const status = t.overlays[0].component.getRows().find((row) => row.command.id === "ampi.status");
    assert.deepEqual({ state: status.state, reason: status.reason }, { state: "unavailable", reason: "ampi-core is not loaded" });
    t.overlays[0].component.handleInput("\x1b");

    for (const name of ["ampi-status", "ampi-changelog", "ampi-config", "mode"]) t.pi.registerCommand(name, {});
    for (const [query, sent] of [
      ["show status", "/ampi-status"],
      ["ampi changelog", "/ampi-changelog"],
      ["ampi configure", "/ampi-config"],
      ["mode use ultra", "/mode ultra"],
    ]) {
      t.send("\x0f");
      pick(t.overlays.at(-1), query);
      await settle();
      assert.deepEqual(t.calls.sendUserMessage.at(-1), { content: sent, options: { expandPromptTemplates: true } }, query);
    }
  });

  it("marks the current mode unavailable", () => {
    const t = setup();
    t.pi.registerCommand("mode", {});
    runtime.setMmrModeState({ mode: "high" });
    t.send("\x0f");
    const rows = t.overlays[0].component.getRows().filter((row) => row.command.id.startsWith("mode.use."));
    assert.deepEqual(
      rows.map((row) => [row.command.verb, row.state, row.reason]),
      [
        ["use low", "available", undefined],
        ["use medium", "available", undefined],
        ["use ultra", "available", undefined],
        ["use free", "available", undefined],
        ["use high", "unavailable", "high is the current mode"],
      ],
    );
  });

  it("toggles tool output and thinking together with Alt+T", () => {
    const settings = {};
    const t = setup({ settings });
    const toggle = () => t.shortcuts.get("alt+t").handler(t.ctx);
    const state = () => ({ tools: t.state.toolsExpanded, thinkingHidden: settings.hideThinkingBlock === true });

    // Pi starts with tools collapsed and thinking shown: the first press
    // expands the tools and leaves thinking shown.
    toggle();
    assert.deepEqual(state(), { tools: true, thinkingHidden: false });
    assert.deepEqual(t.handle.calls, []);
    toggle();
    assert.deepEqual(state(), { tools: false, thinkingHidden: true });
    toggle();
    assert.deepEqual(state(), { tools: true, thinkingHidden: false });
    assert.deepEqual(t.handle.calls, ["thinking toggle", "thinking toggle"]);
  });
});
