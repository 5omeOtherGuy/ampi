import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext } from "./helpers/pi-stub.mjs";
import { createAnsiTheme, expectFixture, plain } from "./helpers/tui-render.mjs";

after(cleanupLoadedSource);

let dialModule;
let runtime;
let modeRegistry;
const theme = createAnsiTheme();
const KEY = { ctrlS: "\x13", right: "\x1b[C", left: "\x1b[D", up: "\x1b[A", down: "\x1b[B", tab: "\t", esc: "\x1b", ctrlC: "\x03" };
/** Pi gives the dial 58 columns on an 80- or a 140-column terminal. */
const WIDTH = 58;

before(async () => {
  dialModule = await importSource("extensions/ampi-tui/overlays/mode-dial.ts");
  // The dial reads the mode state through the shared runtime singleton.
  runtime = await import(pathToFileURL(path.join(getPreparedSourceRoot(), "extensions/ampi-core/runtime.ts")).href);
  // The registry lives on globalThis, so any copy of the module reaches the dial's.
  modeRegistry = await importSource("extensions/ampi-core/mode-registry.ts");
});

const ROUTES = {
  low: { agent: "openai-codex/gpt-5.6-terra · medium", oracle: "openai-codex/gpt-5.6-sol · high" },
  medium: { agent: "openai-codex/gpt-5.6-sol · medium", oracle: "openai-codex/gpt-5.6-sol · high" },
  high: { agent: "anthropic/claude-opus-4-8 · xhigh", oracle: "openai-codex/gpt-5.6-sol · high" },
  ultra: { agent: undefined, oracle: "openai-codex/gpt-5.6-sol · high" },
  free: { agent: "faux/faux-1", oracle: undefined },
  review: { agent: "anthropic/claude-opus-4-8 · xhigh", oracle: "openai-codex/gpt-5.6-sol · high" },
  sketch: { agent: "faux/faux-1 · medium", oracle: "openai-codex/gpt-5.6-sol · high" },
};
const REVIEW = { key: "review", label: "Review", color: "#d97706", baseMode: "high", description: "Reads a change and reports what is wrong" };
const SKETCH = { key: "sketch", color: "#22c55e", baseMode: "low", source: "sketch-modes" };

/** A dial on `mode` with a fake clock, recording applied modes, closes and redraws. */
function setup({ mode = "medium", terminalRows } = {}) {
  let time = 0;
  const timers = [];
  const applied = [];
  const record = { closes: 0, renders: 0 };
  const dial = new dialModule.MmrModeDial({
    mode,
    theme,
    routes: (key) => ROUTES[key],
    apply: (key) => applied.push(key),
    onClose: () => {
      record.closes += 1;
    },
    requestRender: () => {
      record.renders += 1;
    },
    setTimer: (callback, ms) => {
      const timer = { callback, at: time + ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
    terminalRows: () => terminalRows,
  });
  return {
    dial,
    applied,
    record,
    send: (...keys) => {
      for (const key of keys) dial.handleInput(key);
    },
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

describe("ampi-tui mode dial rendering", () => {
  for (const mode of ["low", "medium", "high", "ultra", "free"]) {
    it(`draws the ${mode} dial`, () => {
      const lines = setup({ mode }).dial.render(WIDTH);
      for (const line of lines) assert.equal(visibleWidth(line), WIDTH);
      expectFixture("ampi-tui-mode-dial", `dial-${mode}-${WIDTH}`, lines);
    });
  }

  it("fills the bar to 1, 19, 36 and 54 of 54 dots, and to the first dot for free", () => {
    const fills = Object.fromEntries(
      ["low", "medium", "high", "ultra", "free"].map((mode) => {
        const bar = plain(setup({ mode }).dial.render(WIDTH))[1];
        return [mode, [...bar].filter((glyph) => glyph === "•").length];
      }),
    );
    assert.deepEqual(fills, { low: 1, medium: 19, high: 36, ultra: 54, free: 1 });
    const bar = plain(setup({ mode: "high" }).dial.render(WIDTH))[1];
    assert.equal(bar, `│ ${"•".repeat(36)}${"·".repeat(18)} │`);
  });

  it("lays out the labels under the bar and highlights only the current one", () => {
    const lines = setup({ mode: "high" }).dial.render(WIDTH);
    assert.equal(plain(lines)[2], "│ low             medium           high            ultra │");
    assert.match(lines[2], /\x1b\[1m[^ ]*high/, "high is bold");
    assert.doesNotMatch(lines[2], /\x1b\[1m[^ ]*medium/);
    const free = setup({ mode: "free" }).dial.render(WIDTH);
    assert.doesNotMatch(free[2], /\x1b\[1m/, "free highlights no label");
  });

  it("names the agent and oracle models for the mode, or says when none resolves", () => {
    const high = plain(setup({ mode: "high" }).dial.render(WIDTH));
    assert.equal(high[4], `│ Agent:  anthropic/claude-opus-4-8 · xhigh${" ".repeat(13)} │`);
    assert.equal(high[5], `│ Oracle: openai-codex/gpt-5.6-sol · high${" ".repeat(15)} │`);
    const ultra = plain(setup({ mode: "ultra" }).dial.render(WIDTH));
    assert.match(ultra[4], /│ Agent: {2}not available +│/);
    const free = plain(setup({ mode: "free" }).dial.render(WIDTH));
    assert.match(free[5], /│ Oracle: not available +│/);
  });

  it("shows the description and the key hints", () => {
    const lines = plain(setup({ mode: "medium" }).dial.render(WIDTH));
    assert.match(lines[7], /│ Balanced default for everyday coding +│/);
    assert.match(lines[8], /─ ctrl\+s\/→ next · ← previous · tab list · esc close ─╯$/);
    assert.equal(lines.length, 9, "two borders and seven rows, no padding row");
  });

  it("fits a narrow terminal, cutting the description and dropping hints", () => {
    const lines = setup({ mode: "high" }).dial.render(46);
    for (const line of lines) assert.equal(visibleWidth(line), 46);
    expectFixture("ampi-tui-mode-dial", "dial-high-46", lines);
  });

  it("draws the list with every mode, free last, the current one marked", () => {
    const t = setup({ mode: "high" });
    t.send(KEY.tab);
    const lines = t.dial.render(WIDTH);
    for (const line of lines) assert.equal(visibleWidth(line), WIDTH);
    expectFixture("ampi-tui-mode-dial", `list-high-${WIDTH}`, lines);
    const text = plain(lines);
    assert.match(text[0], /^╭─ Modes ─+╮$/);
    assert.deepEqual(
      text.slice(1, 6).map((line) => line.slice(2, 12)),
      ["   Low  Qu", "   Medium ", " ‣ High  D", "   Ultra  ", "   Free  S"],
    );
    assert.match(text[6], /─ ↑↓ choose · tab dial · esc close ─╯$/);
    assert.doesNotMatch(text.join("\n"), /[█▁▂▃▄▅▆▇]/, "no scrollbar when every mode fits");
  });

  it("scrolls the list on a short terminal, with a scrollbar", () => {
    const t = setup({ mode: "free", terminalRows: 12 });
    t.send(KEY.tab);
    const lines = t.dial.render(WIDTH);
    expectFixture("ampi-tui-mode-dial", "list-free-short", lines);
    const text = plain(lines);
    assert.equal(text.length, 5, "three rows between the borders");
    assert.match(text[3], /‣ Free/, "the selection stays in view");
  });
});

describe("ampi-tui mode dial keys", () => {
  it("opens on the current mode without changing it", () => {
    const t = setup({ mode: "high" });
    assert.equal(t.dial.getMode(), "high");
    assert.deepEqual(t.applied, []);
  });

  it("turns forward with Ctrl+S or →, wrapping from ultra to low, and applies each mode", () => {
    const t = setup({ mode: "medium" });
    t.send(KEY.ctrlS, KEY.ctrlS, KEY.right, KEY.ctrlS);
    assert.deepEqual(t.applied, ["high", "ultra", "low", "medium"]);
    assert.equal(t.dial.getMode(), "medium");
  });

  it("turns back with ←, wrapping from low to ultra", () => {
    const t = setup({ mode: "low" });
    t.send(KEY.left, KEY.left);
    assert.deepEqual(t.applied, ["ultra", "high"]);
  });

  it("enters the ring at medium from free, in either direction", () => {
    const forward = setup({ mode: "free" });
    forward.send(KEY.ctrlS);
    assert.deepEqual(forward.applied, ["medium"]);
    const back = setup({ mode: "free" });
    back.send(KEY.left);
    assert.deepEqual(back.applied, ["medium"]);
  });

  it("turns when the command runs again while it is open, and asks for a redraw", () => {
    const t = setup({ mode: "medium" });
    t.dial.turn(1);
    assert.deepEqual(t.applied, ["high"]);
    assert.equal(t.record.renders, 1);
  });

  it("switches to the list with Tab and back, choosing with ↑/↓ and applying at once", () => {
    const t = setup({ mode: "medium" });
    t.send(KEY.tab);
    assert.equal(t.dial.getView(), "list");
    t.send(KEY.up, KEY.up);
    assert.deepEqual(t.applied, ["low"], "the second ↑ stops at the first row");
    t.send(KEY.down, KEY.down, KEY.down, KEY.down, KEY.down);
    assert.deepEqual(t.applied, ["low", "medium", "high", "ultra", "free"], "free is reachable in the list, and ↓ stops there");
    t.send(KEY.ctrlS, KEY.right);
    assert.equal(t.applied.length, 5, "the list does not turn the dial");
    t.send(KEY.tab);
    assert.equal(t.dial.getView(), "dial");
    t.send(KEY.ctrlS);
    assert.equal(t.applied.at(-1), "medium");
  });

  it("closes on Esc once, and ignores keys after that", () => {
    const t = setup();
    t.send(KEY.esc);
    assert.equal(t.record.closes, 1);
    assert.equal(t.dial.isClosed(), true);
    t.send(KEY.ctrlS, KEY.esc);
    t.advance(5000);
    assert.equal(t.record.closes, 1);
    assert.deepEqual(t.applied, []);
  });

  it("closes from the list too, on Esc or Ctrl+C", () => {
    const t = setup();
    t.send(KEY.tab, KEY.ctrlC);
    assert.equal(t.record.closes, 1);
  });

  it("closes itself 2 s after opening", () => {
    const t = setup();
    t.advance(1999);
    assert.equal(t.record.closes, 0);
    t.advance(1);
    assert.equal(t.record.closes, 1);
  });

  it("restarts the 2 s wait on every key, in both views", () => {
    const t = setup();
    t.advance(1500);
    t.send(KEY.ctrlS);
    t.advance(1999);
    assert.equal(t.record.closes, 0, "the turn restarted the wait");
    t.send(KEY.tab);
    t.advance(1999);
    t.send(KEY.down);
    t.advance(1999);
    assert.equal(t.record.closes, 0);
    t.advance(1);
    assert.equal(t.record.closes, 1);
  });
});

describe("ampi-tui mode dial with registered modes", () => {
  beforeEach(() => {
    modeRegistry.__resetMmrModesForTests();
    modeRegistry.registerMmrMode(REVIEW);
    modeRegistry.registerMmrMode(SKETCH);
  });

  afterEach(() => {
    modeRegistry.__resetMmrModesForTests();
    runtime.setMmrModeState(undefined);
  });

  it("opens on the list when the mode is a registered one, with its row selected", () => {
    const t = setup({ mode: "review" });
    assert.equal(t.dial.getView(), "list");
    assert.equal(t.dial.getMode(), "review");
    assert.deepEqual(t.applied, []);
    assert.equal(setup({ mode: "free" }).dial.getView(), "dial", "free keeps the dial");
  });

  it("lists the ring modes, the registered modes in order, then free, each name in its own colour", () => {
    const lines = setup({ mode: "review" }).dial.render(WIDTH);
    for (const line of lines) assert.equal(visibleWidth(line), WIDTH);
    expectFixture("ampi-tui-mode-dial", `list-registered-${WIDTH}`, lines);
    const text = plain(lines);
    assert.deepEqual(
      text.slice(1, 8).map((line) => line.slice(2).replace(/ +│$/, "")),
      [
        "   Low  Quick, focused work on small, clear changes",
        "   Medium  Balanced default for everyday coding",
        "   High  Demanding work, with extra reasoning",
        "   Ultra  Maximum effort for the hardest problems",
        " ‣ Review  Reads a change and reports what is wrong",
        "   sketch  sketch-modes",
        "   Free  Stock Pi: your own model, no ampi routing",
      ],
    );
    // The test theme writes colours in the 256-colour palette: #d97706 is 172, #22c55e is 41.
    assert.match(lines[5], /\x1b\[38;5;172m\x1b\[1m ‣ Review/, "Review in #d97706, bold as the current row");
    assert.match(lines[6], /\x1b\[38;5;41m {3}sketch/, "sketch in #22c55e");
    assert.doesNotMatch(lines[6], /\x1b\[1m/);
    assert.doesNotMatch(text.join("\n"), /[█▁▂▃▄▅▆▇]/, "seven rows fit without a scrollbar");
  });

  it("fits a narrow terminal, cutting the second column first", () => {
    const lines = setup({ mode: "sketch" }).dial.render(30);
    for (const line of lines) assert.equal(visibleWidth(line), 30);
    expectFixture("ampi-tui-mode-dial", "list-registered-30", lines);
    assert.match(plain(lines)[5], /│ {4}Review {2}Reads a change… │/);
  });

  it("scrolls on a short terminal, keeping the registered row in view beside the scrollbar", () => {
    const t = setup({ mode: "review", terminalRows: 12 });
    const lines = t.dial.render(WIDTH);
    expectFixture("ampi-tui-mode-dial", "list-registered-short", lines);
    const text = plain(lines);
    assert.equal(text.length, 5, "three rows between the borders");
    assert.match(text[3], /‣ Review/);
    assert.match(text.slice(1, 4).join("\n"), /[█▁▂▃▄▅▆▇]/, "a scrollbar shows that more rows exist");
  });

  it("moves through every row with ↑/↓, applying registered keys, and turns from one onto medium", () => {
    const t = setup({ mode: "ultra" });
    t.send(KEY.tab, KEY.down, KEY.down, KEY.down, KEY.down, KEY.up);
    assert.deepEqual(t.applied, ["review", "sketch", "free", "sketch"], "↓ stops at free");
    t.send(KEY.ctrlS);
    assert.equal(t.applied.length, 4, "the list does not turn");
    t.send(KEY.tab);
    assert.match(plain(t.dial.render(WIDTH))[7], /│ sketch-modes +│/, "the dial shows the registered mode's second column");
    t.send(KEY.ctrlS);
    assert.equal(t.applied.at(-1), "medium");
  });

  it("opens from the active registered mode, as Ctrl+S does", async () => {
    runtime.setMmrModeState({ mode: "high", registeredMode: { key: "review", label: "Review", color: "#d97706", source: "extension" } });
    const { ctx, overlays } = createMockExtensionContext();
    void dialModule.openMmrModeDial(ctx, { apply: () => {}, setTimer: () => undefined, clearTimer: () => {}, offsetY: () => -5 });
    const dial = overlays.at(-1).component;
    assert.equal(dial.getMode(), "review");
    assert.equal(dial.getView(), "list");
    dial.close();
  });
});

describe("ampi-tui mode route reader", () => {
  let home;
  let previousHome;

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(path.join(tmpdir(), "ampi-mode-dial-"));
    process.env.HOME = home;
    runtime.setMmrModeState(undefined);
  });

  afterEach(() => {
    runtime.setMmrModeState(undefined);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  function registry(models) {
    return {
      getAll: () => models,
      find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
      hasConfiguredAuth: () => true,
      isUsingOAuth: () => false,
    };
  }

  it("reads the active mode from ampi-core and resolves the others from their preferences and settings", () => {
    const models = [
      { provider: "openai-codex", id: "gpt-5.6-sol" },
      { provider: "faux", id: "faux-1" },
    ];
    mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
    writeFileSync(
      path.join(home, ".pi/agent/settings.json"),
      JSON.stringify({ ampiCore: { modelPreferences: { high: ["faux/faux-1"] }, subagentModelPreferences: { oracle: ["faux/faux-1"] } } }),
    );
    runtime.setMmrModeState({ mode: "medium", modelApplied: true, provider: "openai-codex", model: "gpt-5.6-sol", thinkingLevel: "high" });
    const read = dialModule.createMmrModeRouteReader({ cwd: home, model: { provider: "faux", id: "faux-1" }, modelRegistry: registry(models) });

    assert.deepEqual(read("medium"), { agent: "openai-codex/gpt-5.6-sol · high", oracle: "faux/faux-1 · high" });
    assert.deepEqual(read("high"), { agent: "faux/faux-1 · xhigh", oracle: "faux/faux-1 · high" }, "settings override the mode's models");
    assert.equal(read("low").agent, undefined, "no low model is registered");
    assert.deepEqual(read("free"), { agent: "faux/faux-1", oracle: undefined }, "free names Pi's own model and has no oracle");
  });

  it("resolves a registered mode from its own preferences, or else its base mode's", () => {
    const models = [
      { provider: "openai-codex", id: "gpt-5.6-sol" },
      { provider: "faux", id: "faux-1" },
    ];
    mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
    writeFileSync(path.join(home, ".pi/agent/settings.json"), JSON.stringify({ ampiCore: { modelPreferences: { high: ["faux/faux-1"] } } }));
    modeRegistry.__resetMmrModesForTests();
    modeRegistry.registerMmrMode({ ...REVIEW, thinkingLevel: "medium" });
    modeRegistry.registerMmrMode({ ...SKETCH, modelPreferences: [{ model: "gpt-5.6-sol", providers: ["openai-codex"] }] });
    try {
      runtime.setMmrModeState({ mode: "high", modelApplied: true, provider: "openai-codex", model: "gpt-5.6-sol", thinkingLevel: "xhigh" });
      const read = dialModule.createMmrModeRouteReader({ cwd: home, model: undefined, modelRegistry: registry(models) });
      assert.equal(read("review").agent, "faux/faux-1 · medium", "the base mode's configured models, at the registered level");
      assert.equal(read("sketch").agent, "openai-codex/gpt-5.6-sol · medium", "its own models");
      assert.equal(read("high").agent, "openai-codex/gpt-5.6-sol · xhigh", "high is the active mode");
    } finally {
      modeRegistry.__resetMmrModesForTests();
    }
  });
});
