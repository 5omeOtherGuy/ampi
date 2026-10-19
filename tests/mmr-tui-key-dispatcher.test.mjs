import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

let createMmrKeyDispatcher;
let resolveMmrKeymap;
let parseMmrKeyChord;

before(async () => {
  ({ createMmrKeyDispatcher } = await importSource("extensions/ampi-tui/keys/dispatcher.ts"));
  ({ resolveMmrKeymap, parseMmrKeyChord } = await importSource("extensions/ampi-core/keymap.ts"));
});

const DEFAULTS = {
  "thread.interrupt": "esc esc",
  "ampi.quit": "ctrl+c ctrl+c",
  "thread.archive": "ctrl+c ctrl+n",
  "thread.scrollToTop": "home",
  "prompt.undo": "<leader>z",
  "prompt.redo": "<leader>shift+z",
  "puck.open": "<leader>p",
};

const DESCRIPTIONS = {
  "thread.interrupt": "Stop the running turn",
  "ampi.quit": "Quit",
  "thread.archive": "Archive and start over",
  "thread.scrollToTop": "Jump to the start",
  "prompt.undo": "Undo the last edit",
  "prompt.redo": "Redo the last undone edit",
  "puck.open": "Open the helper",
};

/** One combo from a key string such as `ctrl+c`. */
function key(text) {
  const parsed = parseMmrKeyChord(text);
  assert.ok(!("error" in parsed), `bad key ${text}`);
  return parsed.combos[0];
}

function setup({ defaults = DEFAULTS, unavailable = [], hidden = [] } = {}) {
  let time = 1000;
  const runs = [];
  const hints = [];
  const unavailableRuns = [];
  let cleared = 0;
  const state = { unavailable: new Set(unavailable), hidden: new Set(hidden) };
  const dispatcher = createMmrKeyDispatcher({
    keymap: resolveMmrKeymap({ defaults }),
    now: () => time,
    onRun: (id) => runs.push(id),
    onHint: (hint) => hints.push(hint),
    onClearHint: () => {
      cleared += 1;
    },
    onUnavailable: (id) => unavailableRuns.push(id),
    availability: (id) => (state.hidden.has(id) ? "hidden" : state.unavailable.has(id) ? "unavailable" : "available"),
    describe: (id) => DESCRIPTIONS[id],
  });
  return {
    dispatcher,
    runs,
    hints,
    unavailableRuns,
    state,
    cleared: () => cleared,
    press: (text, context) => dispatcher.handle(key(text), context),
    advance: (ms) => {
      time += ms;
    },
    now: () => time,
  };
}

describe("ampi-tui key dispatcher", () => {
  it("completes a leader chord and runs its command", () => {
    const t = setup();
    assert.equal(t.press("ctrl+x"), true);
    assert.equal(t.dispatcher.isPending(), true);
    t.advance(1499);
    assert.equal(t.press("z"), true);
    assert.deepEqual(t.runs, ["prompt.undo"]);
    assert.equal(t.dispatcher.isPending(), false);
    assert.equal(t.cleared(), 1, "the hint closes when the chord completes");
  });

  it("reports the pending prefix as canonical keys until it completes, is cancelled or lapses", () => {
    const t = setup({ defaults: { ...DEFAULTS, "thread.goto": "<leader>g g" } });
    assert.equal(t.dispatcher.pendingKeys(), undefined);
    t.press("ctrl+x");
    assert.equal(t.dispatcher.pendingKeys(), "ctrl+x");
    t.press("g");
    assert.equal(t.dispatcher.pendingKeys(), "ctrl+x g", "every key of a longer prefix");
    t.press("g");
    assert.deepEqual(t.runs, ["thread.goto"]);
    assert.equal(t.dispatcher.pendingKeys(), undefined);

    t.press("ctrl+c");
    assert.equal(t.dispatcher.pendingKeys(), "ctrl+c");
    t.press("q");
    assert.equal(t.dispatcher.pendingKeys(), undefined, "an unrelated key cancels");

    t.press("esc");
    t.advance(499);
    assert.equal(t.dispatcher.pendingKeys(), "esc");
    t.advance(1);
    assert.equal(t.dispatcher.pendingKeys(), undefined, "the deadline lapses without expire()");
    assert.deepEqual(t.runs, ["thread.goto"]);
  });

  it("lets the leader lapse after the chord timeout", () => {
    const t = setup();
    t.press("ctrl+x");
    assert.equal(t.hints[0].deadline, t.now() + 1500);
    t.advance(1500);
    t.dispatcher.expire();
    assert.equal(t.dispatcher.isPending(), false);
    assert.equal(t.cleared(), 1);
    assert.equal(t.press("z"), false, "z after the timeout is ordinary typing");
    assert.deepEqual(t.runs, []);
  });

  it("passes an unrelated key through after a prefix", () => {
    const t = setup();
    t.press("ctrl+x");
    assert.equal(t.press("q"), false);
    assert.equal(t.dispatcher.isPending(), false);
    assert.equal(t.cleared(), 1);
    assert.deepEqual(t.runs, []);
  });

  it("treats a second key that starts another chord as that chord's first key", () => {
    const t = setup();
    t.press("ctrl+x");
    assert.equal(t.press("ctrl+c"), true, "ctrl+c arms its own chord instead of passing through");
    assert.equal(t.hints.at(-1).prefix, "Ctrl+C");
    assert.equal(t.press("ctrl+c"), true);
    assert.deepEqual(t.runs, ["ampi.quit"]);
  });

  it("cancels a pending prefix on Esc and swallows the Esc", () => {
    const t = setup();
    t.press("ctrl+x");
    assert.equal(t.press("esc"), true);
    assert.equal(t.dispatcher.isPending(), false);
    assert.equal(t.cleared(), 1);
    assert.deepEqual(t.runs, []);
  });

  it("interrupts on Esc Esc inside the window while a turn runs", () => {
    const t = setup();
    assert.equal(t.press("esc"), true, "the first Esc is swallowed while busy");
    assert.equal(t.hints.length, 0, "Esc shows no popup");
    t.advance(499);
    assert.equal(t.press("esc"), true);
    assert.deepEqual(t.runs, ["thread.interrupt"]);
  });

  it("does not interrupt when the second Esc comes after the window", () => {
    const t = setup();
    t.press("esc");
    t.advance(500);
    assert.equal(t.press("esc"), true, "it arms a new double press instead");
    assert.deepEqual(t.runs, []);
    t.advance(100);
    t.press("esc");
    assert.deepEqual(t.runs, ["thread.interrupt"]);
  });

  it("leaves a single Esc to Pi when nothing is running", () => {
    const t = setup({ unavailable: ["thread.interrupt"] });
    assert.equal(t.press("esc"), false);
    assert.equal(t.press("esc"), false);
    assert.deepEqual(t.runs, []);
  });

  it("lets every key through while the editor does not have focus", () => {
    const t = setup();
    const unfocused = { editorFocused: false };
    assert.equal(t.press("esc", unfocused), false);
    assert.equal(t.press("ctrl+x", unfocused), false);
    t.press("ctrl+c");
    assert.equal(t.press("ctrl+c", unfocused), false, "focus moving away cancels a pending chord");
    assert.equal(t.dispatcher.isPending(), false);
    assert.deepEqual(t.runs, []);
  });

  it("quits on Ctrl+C Ctrl+C", () => {
    const t = setup();
    assert.equal(t.press("ctrl+c"), true);
    assert.equal(t.press("ctrl+c"), true);
    assert.deepEqual(t.runs, ["ampi.quit"]);
  });

  it("passes the second key of Ctrl+C then an unbound key through", () => {
    const t = setup();
    t.press("ctrl+c");
    assert.equal(t.press("ctrl+a"), false);
    assert.deepEqual(t.runs, []);
    assert.equal(t.dispatcher.isPending(), false);
  });

  it("reports a completed chord whose command is unavailable instead of running it", () => {
    const t = setup({ unavailable: ["thread.archive"] });
    t.press("ctrl+c");
    assert.equal(t.press("ctrl+n"), true);
    assert.deepEqual(t.runs, []);
    assert.deepEqual(t.unavailableRuns, ["thread.archive"]);
  });

  it("runs Home only while its command is available, otherwise lets Home reach the editor", () => {
    const t = setup();
    assert.equal(t.press("home"), true);
    assert.deepEqual(t.runs, ["thread.scrollToTop"]);
    t.state.unavailable.add("thread.scrollToTop");
    assert.equal(t.press("home"), false, "with text in the prompt Home moves the cursor");
    assert.deepEqual(t.runs, ["thread.scrollToTop"]);
  });

  it("lists every visible continuation in the hint, sorted by key", () => {
    const t = setup({ hidden: ["prompt.redo"] });
    t.press("ctrl+x");
    assert.equal(t.hints[0].prefix, "Ctrl+X");
    assert.deepEqual(
      t.hints[0].rows.map((row) => [row.key, row.description]),
      [
        ["p", "Open the helper"],
        ["z", "Undo the last edit"],
      ],
    );
    t.press("esc");
    t.state.hidden.clear();
    t.press("ctrl+c");
    assert.deepEqual(
      t.hints.at(-1).rows.map((row) => [row.key, row.id]),
      [
        ["Ctrl+C", "ampi.quit"],
        ["Ctrl+N", "thread.archive"],
      ],
    );
  });

  it("sorts rows by canonical key text and shows shift as a modifier", () => {
    const t = setup();
    t.press("ctrl+x");
    assert.deepEqual(
      t.hints[0].rows.map((row) => row.key),
      ["p", "Shift+Z", "z"],
    );
  });

  it("shows the leader popup even when nothing is bound after it", () => {
    const t = setup({ defaults: { "ampi.quit": "ctrl+c ctrl+c" } });
    assert.equal(t.press("ctrl+x"), true);
    assert.deepEqual(t.hints[0].rows, []);
  });

  it("does not arm a prefix whose continuations are all unavailable, except the leader", () => {
    const t = setup({ unavailable: ["ampi.quit", "thread.archive", "prompt.undo", "prompt.redo", "puck.open"] });
    assert.equal(t.press("ctrl+c"), false);
    assert.equal(t.press("ctrl+x"), true);
  });

  it("follows a changed leader and reports the keys it must see raw", () => {
    const t = setup();
    assert.deepEqual([...t.dispatcher.rawKeys()].sort(), ["ctrl+c", "ctrl+x", "esc", "home"]);
    t.dispatcher.setKeymap(resolveMmrKeymap({ defaults: DEFAULTS, leader: "ctrl+t" }));
    assert.deepEqual([...t.dispatcher.rawKeys()].sort(), ["ctrl+c", "ctrl+t", "esc", "home"]);
    assert.equal(t.press("ctrl+x"), false);
    t.press("ctrl+t");
    t.press("z");
    assert.deepEqual(t.runs, ["prompt.undo"]);
  });

  it("treats input that is not a key as an unrelated key", () => {
    const t = setup();
    t.press("ctrl+x");
    assert.equal(t.dispatcher.handle(undefined), false);
    assert.equal(t.dispatcher.isPending(), false);
  });
});
