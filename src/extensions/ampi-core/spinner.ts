/**
 * The running glyph: one braille character whose eight dots are a tiny
 * cellular automaton.
 *
 * The dots form a grid of two columns and four rows that wraps from the
 * bottom row to the top one, so every dot has five neighbours: the dots
 * above and below it in its own column and the three dots beside it in the
 * other column. Each step computes the next generation (a dot comes alive
 * with exactly three live neighbours and stays alive with two or three).
 * When the pattern is about to die out, settles into a still life or a
 * two-step loop, or has run for {@link MMR_SPINNER_MAX_GENERATIONS}
 * generations, it starts over from a random pattern of at least three dots,
 * so the glyph changes on every step and is never blank.
 *
 * A fresh spinner always shows {@link MMR_SPINNER_FIRST_GLYPH}, so a running
 * row that has not ticked yet draws the same glyph every time. The module is
 * pure: callers own the timer and call `step()` every
 * {@link MMR_SPINNER_INTERVAL_MS}.
 */

/** Milliseconds between two steps of a running glyph. */
export const MMR_SPINNER_INTERVAL_MS = 200;

/** Generations a pattern runs before the spinner starts over. */
export const MMR_SPINNER_MAX_GENERATIONS = 15;

/**
 * Cells are an 8-bit mask, column by column: bit `column * 4 + row`, so
 * bits 0 to 3 are the left column top to bottom and bits 4 to 7 the right
 * one. Each cell's braille dot bit, in the same order (dots 1, 2, 3, 7 and
 * 4, 5, 6, 8).
 */
const DOT_BITS = [0x01, 0x02, 0x04, 0x40, 0x08, 0x10, 0x20, 0x80] as const;

/** The first pattern: the top two dots of the left column and the top dot of the right one (`⠋`). */
const FIRST_CELLS = 0b0001_0011;

/** The glyph every fresh spinner starts on. */
export const MMR_SPINNER_FIRST_GLYPH = "⠋";

function liveCount(cells: number): number {
  let count = 0;
  for (let bits = cells; bits !== 0; bits &= bits - 1) count += 1;
  return count;
}

/** Every pattern a spinner may start over from: those with at least three live cells. */
const SEEDS: readonly number[] = Array.from({ length: 256 }, (_, cells) => cells).filter((cells) => liveCount(cells) >= 3);

function isAlive(cells: number, column: number, row: number): number {
  return (cells >> (column * 4 + ((row + 4) % 4))) & 1;
}

/** The next generation of a pattern (cells as described at {@link DOT_BITS}). */
export function nextMmrSpinnerCells(cells: number): number {
  let next = 0;
  for (let column = 0; column < 2; column += 1) {
    const other = 1 - column;
    for (let row = 0; row < 4; row += 1) {
      const neighbours =
        isAlive(cells, column, row - 1) +
        isAlive(cells, column, row + 1) +
        isAlive(cells, other, row - 1) +
        isAlive(cells, other, row) +
        isAlive(cells, other, row + 1);
      const alive = isAlive(cells, column, row) === 1;
      if (neighbours === 3 || (alive && neighbours === 2)) next |= 1 << (column * 4 + row);
    }
  }
  return next;
}

/** The braille character that shows a pattern. */
export function mmrSpinnerGlyph(cells: number): string {
  let bits = 0;
  for (let cell = 0; cell < 8; cell += 1) {
    if ((cells >> cell) & 1) bits |= DOT_BITS[cell] as number;
  }
  return String.fromCodePoint(0x2800 + bits);
}

export interface MmrSpinnerState {
  readonly cells: number;
  /** The pattern before `cells`; absent right after a seed. */
  readonly previous?: number;
  /** Generations since the last seed. */
  readonly generation: number;
}

/**
 * One step: the next generation, or a random pattern when the run should
 * start over. The new pattern always differs from the current one, so the
 * glyph changes on every step.
 */
export function stepMmrSpinnerState(state: MmrSpinnerState, random: () => number): MmrSpinnerState {
  if (state.generation < MMR_SPINNER_MAX_GENERATIONS) {
    const next = nextMmrSpinnerCells(state.cells);
    if (liveCount(next) >= 2 && next !== state.cells && next !== state.previous) {
      return { cells: next, previous: state.cells, generation: state.generation + 1 };
    }
  }
  const index = Math.floor(random() * SEEDS.length);
  const seed = SEEDS[index] === state.cells ? SEEDS[(index + 1) % SEEDS.length] : SEEDS[index];
  return { cells: seed as number, generation: 0 };
}

export interface MmrSpinner {
  /** The current glyph. */
  glyph(): string;
  /** Advance one generation and return the new glyph. */
  step(): string;
}

export interface MmrSpinnerOptions {
  /** Source of new patterns, returning a number in [0, 1). Default: `Math.random`. */
  random?: () => number;
}

export function createMmrSpinner(options: MmrSpinnerOptions = {}): MmrSpinner {
  const random = options.random ?? Math.random;
  let state: MmrSpinnerState = { cells: FIRST_CELLS, generation: 0 };
  return {
    glyph: () => mmrSpinnerGlyph(state.cells),
    step() {
      state = stepMmrSpinnerState(state, random);
      return mmrSpinnerGlyph(state.cells);
    },
  };
}
