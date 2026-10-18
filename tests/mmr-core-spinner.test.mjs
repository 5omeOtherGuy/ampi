// ampi-core's running glyph (spinner.ts) and the switch that stills it
// (animation.ts). Patterns are written as pictures, four rows of two
// columns, and turned into cell masks with the layout spinner.ts documents
// (bit column * 4 + row); expected glyphs come from Unicode's braille dot
// numbering. Every expected value below is worked out by hand.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const loadSpinner = () => importSource("extensions/ampi-core/spinner.ts");
const loadAnimation = () => importSource("extensions/ampi-core/animation.ts");

/** `["#.", "..", "..", ".#"]`: live cells marked `#`, top row first. */
function cells(picture) {
  assert.equal(picture.length, 4);
  let mask = 0;
  picture.forEach((row, r) => {
    for (const c of [0, 1]) if (row[c] === "#") mask |= 1 << (c * 4 + r);
  });
  return mask;
}

/** A small seeded generator (mulberry32), so reseeds are reproducible. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function counting(random) {
  const calls = { count: 0 };
  return { calls, random: () => (calls.count++, random()) };
}

/** Live dots of a glyph: the set bits of its offset from U+2800. */
function liveDots(glyph) {
  let bits = glyph.codePointAt(0) - 0x2800;
  let count = 0;
  for (; bits; bits &= bits - 1) count++;
  return count;
}

describe("ampi-core spinner: next generation", () => {
  it("brings a dead cell with exactly three live neighbours to life and keeps cells with two", async () => {
    const { nextMmrSpinnerCells } = await loadSpinner();
    // Left rows 0-1 and right row 0 each have two live neighbours; right row 1 has three.
    assert.equal(nextMmrSpinnerCells(cells(["##", "#.", "..", ".."])), cells(["##", "##", "..", ".."]));
    // A 2x2 block is a still life.
    assert.equal(nextMmrSpinnerCells(cells(["##", "##", "..", ".."])), cells(["##", "##", "..", ".."]));
  });

  it("wraps from the bottom row to the top one", async () => {
    const { nextMmrSpinnerCells } = await loadSpinner();
    // Only through the wrap: left row 0, right row 0 and left row 3 keep two
    // live neighbours each, and right row 3 sees all three and comes alive.
    // Without the wrap every cell would die.
    assert.equal(nextMmrSpinnerCells(cells(["##", "..", "..", "#."])), cells(["##", "..", "..", "##"]));
  });

  it("kills a live cell with four live neighbours", async () => {
    const { nextMmrSpinnerCells } = await loadSpinner();
    // Left row 1 sees left rows 0 and 2 and right rows 0 and 2: four, so it dies.
    // The other live cells keep two; right row 1 sees five and stays dead.
    assert.equal(nextMmrSpinnerCells(cells(["##", "#.", "##", ".."])), cells(["##", "..", "##", ".."]));
  });

  it("lets a lone cell die out", async () => {
    const { nextMmrSpinnerCells } = await loadSpinner();
    assert.equal(nextMmrSpinnerCells(cells(["..", "..", "#.", ".."])), 0);
  });
});

describe("ampi-core spinner: glyphs", () => {
  it("maps each cell to its braille dot", async () => {
    const { mmrSpinnerGlyph } = await loadSpinner();
    const expected = [
      [["#.", "..", "..", ".."], "⠁"], // dot 1
      [["..", "#.", "..", ".."], "⠂"], // dot 2
      [["..", "..", "#.", ".."], "⠄"], // dot 3
      [["..", "..", "..", "#."], "⡀"], // dot 7
      [[".#", "..", "..", ".."], "⠈"], // dot 4
      [["..", ".#", "..", ".."], "⠐"], // dot 5
      [["..", "..", ".#", ".."], "⠠"], // dot 6
      [["..", "..", "..", ".#"], "⢀"], // dot 8
    ];
    for (const [picture, glyph] of expected) assert.equal(mmrSpinnerGlyph(cells(picture)), glyph, picture.join("/"));
    assert.equal(mmrSpinnerGlyph(cells(["##", "##", "##", "##"])), "⣿");
  });

  it("starts every spinner on ⠋, then steps to ⠛", async () => {
    const { createMmrSpinner, MMR_SPINNER_FIRST_GLYPH, MMR_SPINNER_INTERVAL_MS } = await loadSpinner();
    assert.equal(MMR_SPINNER_FIRST_GLYPH, "⠋");
    assert.equal(MMR_SPINNER_INTERVAL_MS, 200);
    const { calls, random } = counting(seeded(1));
    const spinner = createMmrSpinner({ random });
    assert.equal(spinner.glyph(), "⠋");
    assert.equal(createMmrSpinner().glyph(), "⠋");
    // ⠋ is dots 1, 2, 4; dot 5 has exactly those three as neighbours.
    assert.equal(spinner.step(), "⠛");
    assert.equal(spinner.glyph(), "⠛");
    assert.equal(calls.count, 0, "no reseed yet");
  });
});

describe("ampi-core spinner: reseeding", () => {
  const block = cells(["##", "##", "..", ".."]);
  const first = cells(["##", "#.", "..", ".."]);

  it("reseeds when the pattern would die out", async () => {
    const { stepMmrSpinnerState, mmrSpinnerGlyph } = await loadSpinner();
    const { calls, random } = counting(seeded(2));
    const next = stepMmrSpinnerState({ cells: cells(["..", "..", "#.", ".."]), generation: 3 }, random);
    assert.equal(calls.count, 1);
    assert.equal(next.generation, 0);
    assert.ok(liveDots(mmrSpinnerGlyph(next.cells)) >= 3);
  });

  it("reseeds on a still life", async () => {
    const { createMmrSpinner, stepMmrSpinnerState, mmrSpinnerGlyph } = await loadSpinner();
    const { calls, random } = counting(seeded(3));
    const next = stepMmrSpinnerState({ cells: block, generation: 1 }, random);
    assert.equal(calls.count, 1);
    assert.notEqual(next.cells, block);
    assert.ok(liveDots(mmrSpinnerGlyph(next.cells)) >= 3);

    // The same through a spinner: ⠋, then the block ⠛, which would stay put.
    const counted = counting(seeded(3));
    const spinner = createMmrSpinner({ random: counted.random });
    spinner.step();
    const glyph = spinner.step();
    assert.equal(counted.calls.count, 1);
    assert.notEqual(glyph, "⠛");
    assert.ok(liveDots(glyph) >= 3);
  });

  it("reseeds on a two-step cycle", async () => {
    const { stepMmrSpinnerState, mmrSpinnerGlyph } = await loadSpinner();
    const { calls, random } = counting(seeded(4));
    // `first` steps to the block, which is what came before it.
    const next = stepMmrSpinnerState({ cells: first, previous: block, generation: 2 }, random);
    assert.equal(calls.count, 1);
    assert.notEqual(next.cells, block);
    assert.ok(liveDots(mmrSpinnerGlyph(next.cells)) >= 3);
  });

  it("reseeds once 15 generations have run", async () => {
    const { stepMmrSpinnerState, mmrSpinnerGlyph } = await loadSpinner();
    const { calls, random } = counting(seeded(5));
    assert.deepEqual(stepMmrSpinnerState({ cells: first, generation: 14 }, random), { cells: block, previous: first, generation: 15 });
    assert.equal(calls.count, 0, "the 15th generation still runs");
    const next = stepMmrSpinnerState({ cells: first, generation: 15 }, random);
    assert.equal(calls.count, 1);
    assert.equal(next.generation, 0);
    assert.ok(liveDots(mmrSpinnerGlyph(next.cells)) >= 3);
  });

  it("never shows the blank pattern and changes the glyph on every step", async () => {
    const { createMmrSpinner } = await loadSpinner();
    const spinner = createMmrSpinner({ random: seeded(6) });
    let previous = spinner.glyph();
    for (let i = 0; i < 10_000; i++) {
      const glyph = spinner.step();
      assert.notEqual(glyph, "⠀");
      assert.ok(liveDots(glyph) >= 2, `step ${i}: ${glyph}`);
      assert.notEqual(glyph, previous, `step ${i}`);
      previous = glyph;
    }
  });

  it("still changes the glyph when the random pattern equals the current one", async () => {
    const { stepMmrSpinnerState } = await loadSpinner();
    // Patterns with at least three cells, in increasing order: 7 (three cells) is the first.
    const next = stepMmrSpinnerState({ cells: 7, generation: 15 }, () => 0);
    assert.notEqual(next.cells, 7);
  });
});

describe("ampi-core isMmrAnimationDisabled", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ampi-animation-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const project = path.join(root, "project");

  function writeSettings(file, value) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
  }
  const userFile = path.join(home, ".pi/agent/settings.json");
  const projectFile = path.join(project, ".pi/settings.json");

  it("animates unless NO_ANIMATION is set to a non-empty value", async () => {
    const { isMmrAnimationDisabled } = await loadAnimation();
    const check = (env) => isMmrAnimationDisabled({ cwd: project, homeDirectory: home, env });
    assert.equal(check({}), false);
    assert.equal(check({ NO_ANIMATION: "" }), false);
    assert.equal(check({ NO_ANIMATION: "1" }), true);
  });

  it("reads ampiTui.animations from the user settings, overridden by the project", async () => {
    const { isMmrAnimationDisabled } = await loadAnimation();
    const check = () => isMmrAnimationDisabled({ cwd: project, homeDirectory: home, env: {} });
    writeSettings(userFile, { ampiTui: { animations: false } });
    assert.equal(check(), true);
    writeSettings(projectFile, { ampiTui: { animations: true } });
    assert.equal(check(), false, "the project setting wins");
    writeSettings(userFile, {});
    writeSettings(projectFile, { ampi: { tui: { animations: false } } });
    assert.equal(check(), true, "the nested ampi.tui block works too");
    writeSettings(projectFile, { ampiTui: { animations: "no" } });
    assert.equal(check(), false, "a value that is not a boolean is ignored");
  });
});
