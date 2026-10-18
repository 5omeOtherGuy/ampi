// Onboarding intro: stage navigation, key names from the keymap in effect,
// layout fixtures, the mark's animation on a fake clock, and the rules that
// open it once per user, with its record in a temporary directory.
//
// PI_MMR_UPDATE_FIXTURES=1 rewrites the layout snapshots in
// tests/fixtures/ampi-tui-intro/; every other run pins them.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { isolateAnimationEnv, setNoAnimation } from "./helpers/animation-env.mjs";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);
isolateAnimationEnv();

const fixtureDir = path.join(import.meta.dirname, "fixtures/ampi-tui-intro");
const UPDATE_FIXTURES = process.env.PI_MMR_UPDATE_FIXTURES === "1";

const plainTheme = { fg: (_token, text) => text, bold: (text) => text, style: (text) => text };
const taggedTheme = {
  fg: (token, text) => `<${token}>${text}</${token}>`,
  bold: (text) => `<b>${text}</b>`,
  style: (text, { fg, bold }) => `<rgb ${fg.r},${fg.g},${fg.b}${bold ? " bold" : ""}>${text}</rgb>`,
};

const stripSgr = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");

function assertFixture(name, lines) {
  const actual = `${lines.map((line) => stripSgr(line).trimEnd()).join("\n")}\n`;
  const fixturePath = path.join(fixtureDir, name);
  if (UPDATE_FIXTURES) {
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(fixturePath, actual);
    return;
  }
  assert.ok(existsSync(fixturePath), `missing fixture ${name}; rerun with PI_MMR_UPDATE_FIXTURES=1`);
  assert.equal(actual, readFileSync(fixturePath, "utf8"), `fixture ${name} drift; rerun with PI_MMR_UPDATE_FIXTURES=1 to refresh`);
}

function fakeTimers() {
  const intervals = new Map();
  let next = 1;
  let created = 0;
  return {
    timers: {
      setInterval: (callback, ms) => {
        created += 1;
        intervals.set(next, { callback, ms });
        return next++;
      },
      clearInterval: (handle) => intervals.delete(handle),
    },
    intervals,
    get created() {
      return created;
    },
    tick() {
      for (const { callback } of [...intervals.values()]) callback();
    },
  };
}

const KEYS = {
  space: " ",
  enter: "\r",
  esc: "\x1b",
  ctrlC: "\x03",
  right: "\x1b[C",
  left: "\x1b[D",
  backspace: "\x7f",
  l: "l",
  h: "h",
};

let intro;
let registry;
let keymapModule;
let welcome;
const dirs = [];

before(async () => {
  intro = await importSource("extensions/ampi-tui/overlays/intro.ts");
  registry = await importSource("extensions/ampi-core/command-registry.ts");
  keymapModule = await importSource("extensions/ampi-core/keymap.ts");
  welcome = await importSource("extensions/ampi-tui/chrome/welcome.ts");
});

afterEach(() => registry.__resetMmrCommandsForTests());
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempRecordPath() {
  const dir = mkdtempSync(path.join(tmpdir(), "ampi-intro-"));
  dirs.push(dir);
  return path.join(dir, "data", "ampi", "tui", "intro.json");
}

/** The keymap ampi-tui would resolve from these defaults and `ampi.keymap` overrides. */
function keymap(overrides = {}, leader) {
  return keymapModule.resolveMmrKeymap({
    defaults: {
      "mode.toggle": "ctrl+s",
      "thread.archive": "ctrl+c ctrl+n",
      "thread.interrupt": "esc esc",
      "ampi.palette": "ctrl+o",
      "prompt.toggleHelp": "?",
      "thread.switch": null,
      "prompt.queue": null,
      "thread.new": "<leader>n",
    },
    overrides,
    leader,
  });
}

function register(id, noun, verb) {
  registry.registerMmrCommand({ id, noun, verb, description: `${noun} ${verb}`, run: () => {} });
}

function component(options = {}) {
  let closes = 0;
  const clock = fakeTimers();
  const instance = new intro.MmrIntro({
    theme: plainTheme,
    keyName: intro.createMmrIntroKeyNames(keymap()),
    rows: () => 44,
    animate: true,
    timers: clock.timers,
    onClose: () => {
      closes += 1;
    },
    ...options,
  });
  return { instance, clock, closes: () => closes };
}

const render = (stage, { width = 140, rows = 44, frame = 0, keyName = intro.createMmrIntroKeyNames(keymap()), theme = plainTheme } = {}) =>
  intro.renderMmrIntro({ width, rows, stage, frame, keyName, theme });

describe("ampi-tui intro navigation", () => {
  it("goes forward with Space, Enter, → and l, and back with ←, h and Backspace, staying on the first stage", () => {
    const { instance, closes } = component();
    assert.equal(instance.stage, 0);
    for (const key of [KEYS.left, KEYS.h, KEYS.backspace]) instance.handleInput(key);
    assert.equal(instance.stage, 0, "going back on the first stage does nothing");
    for (const [key, stage] of [
      [KEYS.space, 1],
      [KEYS.enter, 2],
      [KEYS.right, 3],
      [KEYS.l, 4],
    ]) {
      instance.handleInput(key);
      assert.equal(instance.stage, stage);
    }
    for (const [key, stage] of [
      [KEYS.left, 3],
      [KEYS.h, 2],
      [KEYS.backspace, 1],
    ]) {
      instance.handleInput(key);
      assert.equal(instance.stage, stage);
    }
    assert.equal(closes(), 0);
  });

  it("closes with Esc or Ctrl+C from a middle stage and with Enter on the last one, but not with Space or →", () => {
    const middle = component();
    for (let i = 0; i < 3; i++) middle.instance.handleInput(KEYS.space);
    assert.equal(middle.instance.stage, 3);
    middle.instance.handleInput(KEYS.esc);
    assert.equal(middle.closes(), 1);
    assert.equal(middle.instance.isClosed, true);
    middle.instance.handleInput(KEYS.space);
    assert.equal(middle.instance.stage, 3, "keys after closing are ignored");

    const cancelled = component();
    cancelled.instance.handleInput(KEYS.space);
    cancelled.instance.handleInput(KEYS.ctrlC);
    assert.equal(cancelled.closes(), 1, "Ctrl+C, Pi's other cancel key, closes it too");

    const last = component();
    for (let i = 0; i < 10; i++) last.instance.handleInput(KEYS.space);
    assert.equal(last.instance.stage, intro.MMR_INTRO_STAGES.length - 1, "Space stops on the last stage");
    last.instance.handleInput(KEYS.right);
    last.instance.handleInput(KEYS.l);
    assert.equal(last.closes(), 0, "Space, → and l leave the last stage open");
    last.instance.handleInput(KEYS.enter);
    assert.equal(last.closes(), 1);
  });

  it("has a welcome stage, five numbered stages and a closing stage", () => {
    assert.equal(intro.MMR_INTRO_STAGES.length, 7);
    assert.equal(intro.MMR_INTRO_NUMBERED_STAGES, 5);
    for (let stage = 0; stage < 7; stage++) {
      const text = render(stage).join("\n");
      const counters = text.match(/\b\d\/5\b/g) ?? [];
      if (stage === 0 || stage === 6) assert.deepEqual(counters, [], `stage ${stage} has no counter`);
      else assert.deepEqual(counters, [`${stage}/5`]);
      assert.match(text, stage === 6 ? /Enter to start/ : /Space to continue/);
      assert.ok(text.includes(intro.MMR_INTRO_STAGES[stage].title));
    }
  });
});

describe("ampi-tui intro key names", () => {
  it("names the keys in effect, overrides and the leader included", () => {
    const defaults = intro.createMmrIntroKeyNames(keymap());
    assert.equal(defaults("mode.toggle"), "Ctrl+S");
    assert.equal(defaults("thread.archive"), "Ctrl+C Ctrl+N");
    assert.equal(defaults("thread.interrupt"), "Esc Esc");
    assert.equal(defaults("prompt.toggleHelp"), "?");
    assert.equal(defaults("leader"), "Ctrl+X");

    const custom = intro.createMmrIntroKeyNames(keymap({ "mode.toggle": "alt+s", "thread.new": "<leader>t" }, "alt+x"));
    assert.equal(custom("mode.toggle"), "Alt+S");
    assert.equal(custom("leader"), "Alt+X");
    assert.equal(custom("thread.new"), "Alt+X t", "a leader chord expands the leader");
    assert.match(render(1, { keyName: custom }).join("\n"), /Alt\+S turns the mode dial/);
    assert.doesNotMatch(render(1, { keyName: custom }).join("\n"), /Ctrl\+S/);
  });

  it("names a command without a key by its palette name, and an unknown id as it is", () => {
    register("thread.switch", "thread", "switch");
    register("prompt.queue", "prompt", "queue message");
    const names = intro.createMmrIntroKeyNames(keymap({ "thread.archive": null }));
    assert.equal(names("thread.switch"), '"thread switch"');
    assert.equal(names("prompt.queue"), '"prompt queue message"');
    assert.equal(names("thread.archive"), "thread.archive", "unbound and not registered");
    register("thread.archive", "thread", "archive and new");
    assert.equal(names("thread.archive"), '"thread archive and new"');
  });

  it("paints keys in the key colour and the title and mark in the stage's mode colour, cycling low to ultra", async () => {
    const { MMR_MODE_LABEL_COLORS } = await importSource("extensions/ampi-tui/editor/prompt-box.ts");
    const order = ["low", "medium", "high", "ultra", "low", "medium", "high"];
    for (let stage = 0; stage < 7; stage++) {
      const [r, g, b] = MMR_MODE_LABEL_COLORS[order[stage]];
      const text = render(stage, { width: 400, theme: taggedTheme }).join("\n");
      assert.ok(text.includes(`<rgb ${r},${g},${b} bold>${intro.MMR_INTRO_STAGES[stage].title}</rgb>`), `stage ${stage} title colour`);
      assert.ok(text.includes(`<rgb ${r},${g},${b} bold>●</rgb>`), `stage ${stage} mark colour`);
    }
    const modes = render(1, { width: 400, theme: taggedTheme }).join("\n");
    assert.match(modes, /<b><accent>Ctrl\+S<\/accent><\/b> turns the mode dial/);
    assert.match(modes, /<dim>1\/5<\/dim>/);
    assert.match(modes, /<b><accent>Space<\/accent><\/b><dim> to continue<\/dim>/);
    assert.match(render(6, { width: 400, theme: taggedTheme }).join("\n"), /<b><accent>Enter<\/accent><\/b><dim> to start<\/dim>/);
  });
});

describe("ampi-tui intro layout", () => {
  for (const [width, rows] of [
    [140, 44],
    [80, 24],
    [50, 20],
  ]) {
    it(`matches the ${width}x${rows} fixtures and fills exactly the terminal`, () => {
      for (let stage = 0; stage < 7; stage++) {
        const lines = render(stage, { width, rows });
        assert.equal(lines.length, rows, `stage ${stage} has ${rows} rows`);
        for (const line of lines) assert.ok(visibleWidth(line) <= width, `line wider than ${width}: ${JSON.stringify(line)}`);
        if (stage === 0 || stage === 1 || stage === 6) assertFixture(`${width}x${rows}-stage${stage}.txt`, lines);
      }
    });
  }

  it("puts the title on the middle row and the counter and hint near the bottom of a large terminal", () => {
    const lines = render(1).map((line) => line.trim());
    assert.equal(lines.indexOf(intro.MMR_INTRO_STAGES[1].title), 22);
    assert.equal(lines.indexOf("1/5"), 40);
    assert.equal(lines.indexOf("Space to continue"), 41);
    const markRows = lines.slice(0, 21).filter((line) => line.length > 0).length;
    assert.equal(markRows, 15, "the large mark sits above the title");
  });

  it("uses the compact mark from 16 rows, and only text below 60 columns or 16 rows", () => {
    const compact = render(1, { width: 80, rows: 24 });
    assert.equal(compact.filter((line) => /[·•●]/.test(line)).length, 5, "the five-row mark");
    for (const [width, rows] of [
      [59, 44],
      [140, 15],
    ]) {
      const lines = render(1, { width, rows });
      assert.equal(lines.length, rows);
      assert.ok(!lines.some((line) => /[·•●]/.test(line)), `${width}x${rows} draws no mark`);
      assert.ok(lines.some((line) => line.includes(intro.MMR_INTRO_STAGES[1].title)));
    }
    assert.equal(render(1, { width: 30, rows: 3 }).length, 3, "a tiny terminal still gets exactly its rows");
  });
});

describe("ampi-tui intro animation", () => {
  it("advances only on the injected timer, rests after its frame count, restarts per stage and stops on close", () => {
    const { MMR_WELCOME_FRAME_COUNT, MMR_WELCOME_FRAME_MS } = welcome;
    let renders = 0;
    const { instance, clock } = component({ requestRender: () => renders++ });
    assert.equal(clock.intervals.size, 1);
    assert.equal([...clock.intervals.values()][0].ms, MMR_WELCOME_FRAME_MS);
    const first = instance.render(140).join("\n");
    clock.tick();
    assert.equal(instance.frame, 1);
    assert.notEqual(instance.render(140).join("\n"), first, "the mark moves");
    for (let i = 0; i < MMR_WELCOME_FRAME_COUNT + 5; i++) clock.tick();
    assert.equal(instance.frame, MMR_WELCOME_FRAME_COUNT - 1, "rests on its last frame");
    assert.equal(clock.intervals.size, 0);
    assert.equal(renders, MMR_WELCOME_FRAME_COUNT - 1);

    instance.handleInput(KEYS.space);
    assert.equal(instance.frame, 0, "a new stage starts the mark again");
    assert.equal(clock.intervals.size, 1);
    clock.tick();
    instance.handleInput(KEYS.esc);
    assert.equal(instance.animating, false);
    assert.equal(clock.intervals.size, 0, "closing clears the timer");
  });

  it("starts no timer when the animation is off", () => {
    const { instance, clock } = component({ animate: false });
    instance.handleInput(KEYS.space);
    assert.equal(clock.created, 0);
    assert.equal(instance.frame, 0, "the mark rests on its first frame");
  });
});

describe("ampi-tui intro launcher", () => {
  const SETTINGS = { quietStartup: false };

  function launcher(recordPath, overrides = {}) {
    const clock = fakeTimers();
    const opened = [];
    const instance = intro.createMmrIntroLauncher({
      settings: SETTINGS,
      keymap: () => keymap(),
      recordPath,
      now: () => new Date("2026-10-19T12:00:00.000Z"),
      timers: clock.timers,
      onOpen: (component) => opened.push(component),
      ...overrides,
    });
    return { instance, clock, opened };
  }

  it("opens on the first fresh interactive start, records it when closed, and stays shut afterwards", () => {
    const recordPath = tempRecordPath();
    const first = launcher(recordPath);
    const context = createMockExtensionContext({ hasUI: true });
    first.instance.start(context.ctx);
    assert.equal(context.overlays.length, 1);
    const { options } = context.overlays[0];
    assert.equal(options.overlay, true);
    assert.deepEqual(options.overlayOptions, { width: "100%", maxHeight: "100%", row: 0, col: 0 });
    assert.equal(options.overlayOptions.nonCapturing, undefined, "it takes the keys");
    assert.equal(existsSync(recordPath), false, "nothing is written while it is open");

    first.opened[0].handleInput(KEYS.space);
    first.opened[0].handleInput(KEYS.space);
    first.opened[0].handleInput(KEYS.space);
    first.opened[0].handleInput(KEYS.esc);
    assert.equal(context.overlays[0].closed, true);
    assert.deepEqual(JSON.parse(readFileSync(recordPath, "utf8")), { version: 1, seenAt: "2026-10-19T12:00:00.000Z" });

    const second = launcher(recordPath);
    const again = createMockExtensionContext({ hasUI: true });
    second.instance.start(again.ctx);
    assert.equal(again.overlays.length, 0);
  });

  it("stays shut with quietStartup, ampiTui.intro false, a session with messages, or outside the terminal UI", () => {
    const recordPath = tempRecordPath();
    const cases = [
      [{ settings: { quietStartup: true } }, {}],
      [{ settings: { quietStartup: false, intro: false } }, {}],
      [{}, { entries: [{ type: "message", message: { role: "user", content: "hi" } }] }],
      [{}, { mode: "print" }],
      [{}, { mode: "rpc" }],
    ];
    for (const [overrides, contextOptions] of cases) {
      const { instance } = launcher(recordPath, overrides);
      const context = createMockExtensionContext({ hasUI: true, ...contextOptions });
      instance.start(context.ctx);
      assert.equal(context.overlays.length, 0, JSON.stringify({ overrides, contextOptions }));
    }
    assert.equal(existsSync(recordPath), false);
  });

  it("treats a corrupt record as seen and never overwrites it, even after opening the intro by command", () => {
    for (const content of ["{ not json", JSON.stringify({ version: 99 })]) {
      const recordPath = tempRecordPath();
      mkdirSync(path.dirname(recordPath), { recursive: true });
      writeFileSync(recordPath, content);
      const { instance, opened } = launcher(recordPath);
      const context = createMockExtensionContext({ hasUI: true });
      instance.start(context.ctx);
      assert.equal(context.overlays.length, 0);
      void instance.open(context.ctx);
      assert.equal(context.overlays.length, 1);
      opened[0].handleInput(KEYS.esc);
      assert.equal(readFileSync(recordPath, "utf8"), content, "left untouched");
    }
  });

  it("records the intro when the session ends while it is open, and opens it only once at a time", () => {
    const recordPath = tempRecordPath();
    const { instance, clock } = launcher(recordPath);
    const context = createMockExtensionContext({ hasUI: true });
    instance.start(context.ctx);
    void instance.open(context.ctx);
    assert.equal(context.overlays.length, 1, "a second open while it shows is ignored");
    instance.stop();
    assert.equal(context.overlays[0].closed, true);
    assert.equal(clock.intervals.size, 0);
    assert.equal(JSON.parse(readFileSync(recordPath, "utf8")).version, 1);
  });

  it("creates no animation timer with NO_ANIMATION set", (t) => {
    setNoAnimation(t);
    const { instance, clock, opened } = launcher(tempRecordPath());
    const context = createMockExtensionContext({ hasUI: true });
    instance.start(context.ctx);
    assert.equal(opened.length, 1);
    assert.equal(clock.created, 0);
    assert.equal(opened[0].animating, false);
  });
});

describe("ampi-tui intro in the extension", () => {
  it("registers ampi.showWelcome, opens on the first session start and again from the command", async () => {
    const { createMmrTuiExtension } = await importSource("extensions/ampi-tui/index.ts");
    const recordPath = tempRecordPath();
    const mock = createMockPi();
    createMmrTuiExtension({ loadSettings: () => ({ enabled: true }), introRecordPath: recordPath })(mock.pi);
    const context = createMockExtensionContext({ hasUI: true });
    await mock.handlers.get("session_start")({ type: "session_start", reason: "startup" }, context.ctx);
    const opened = () => context.overlays.filter((overlay) => overlay.options.overlayOptions?.width === "100%");
    assert.equal(opened().length, 1, "the intro opens by itself");
    opened()[0].component.handleInput(KEYS.esc);
    assert.ok(existsSync(recordPath));

    const command = registry.getMmrCommand("ampi.showWelcome");
    assert.equal(command.noun, "ampi");
    assert.equal(command.verb, "show welcome");
    assert.deepEqual(command.keywords, ["intro", "onboarding", "tour"]);
    assert.equal(command.defaultKey, undefined);
    assert.equal(command.availability(context.ctx).state, "available");
    assert.equal(command.availability(createMockExtensionContext({ hasUI: false }).ctx).state, "unavailable");
    command.run(context.ctx);
    assert.equal(opened().length, 2);
    assert.equal(opened()[1].closed, false);

    await mock.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "reload" }, context.ctx);
    assert.equal(opened()[1].closed, true, "the session end closes it");
  });
});
