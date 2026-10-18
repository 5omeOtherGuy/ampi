import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createAnsiTheme, expectFixture, plain } from "./helpers/tui-render.mjs";

after(cleanupLoadedSource);

let frame;
const theme = createAnsiTheme();

before(async () => {
  frame = await importSource("extensions/ampi-tui/ui/frame.ts");
});

const HINTS = [
  { key: "Esc", text: "close" },
  { key: "↑↓", text: "scroll" },
  { key: "o", text: "open manual" },
];

/** A list of `total` numbered lines, `visible` of them shown from `offset`, with the scrollbar in the gutter. */
function scrolledBox(width, { total, visible, offset }) {
  const lines = Array.from({ length: visible }, (_, index) => `item ${offset + index + 1} of ${total}`);
  const gutter = frame.renderMmrScrollbar({ total, visible, offset }, theme);
  return frame.renderMmrFrame({ title: "Skills", hints: HINTS.slice(0, 2), lines, gutter }, width, theme);
}

describe("ampi-tui overlay frame", () => {
  it("draws the title in the top border, one padding row, and right-aligned hints in the bottom border", () => {
    const lines = frame.renderMmrFrame({ title: "Shortcuts", hints: HINTS, lines: ["first line", "second line"] }, 48, theme);
    assert.deepEqual(plain(lines), [
      "╭─ Shortcuts ──────────────────────────────────╮",
      "│                                              │",
      "│ first line                                   │",
      "│ second line                                  │",
      "╰────── Esc close · ↑↓ scroll · o open manual ─╯",
    ]);
    assert.ok(lines.every((line) => visibleWidth(line) === 48));
    assert.equal(frame.mmrFrameInnerWidth(48), 44);
    expectFixture("ampi-tui-frame", "title-hints-48", lines);
  });

  it("drops hints from the end and cuts a long title when the box is narrow", () => {
    const lines = frame.renderMmrFrame(
      { title: "A title much longer than the box", hints: HINTS, lines: ["a line that is too long to fit"] },
      24,
      theme,
    );
    assert.deepEqual(plain(lines), [
      "╭─ A title much longe… ╮",
      "│                      │",
      "│ a line that is too … │",
      "╰────────── Esc close ─╯",
    ]);
    assert.ok(lines.every((line) => visibleWidth(line) === 24));
    expectFixture("ampi-tui-frame", "narrow-24", lines);
  });

  it("draws a plain border without a title or hints", () => {
    assert.deepEqual(plain(frame.renderMmrFrame({ lines: ["x"] }, 10, theme)), [
      "╭────────╮",
      "│        │",
      "│ x      │",
      "╰────────╯",
    ]);
  });

  it("puts the scrollbar thumb at the top, middle and bottom of the track", () => {
    expectFixture("ampi-tui-frame", "scrollbar-top-40", scrolledBox(40, { total: 30, visible: 6, offset: 0 }));
    expectFixture("ampi-tui-frame", "scrollbar-middle-40", scrolledBox(40, { total: 30, visible: 6, offset: 11 }));
    expectFixture("ampi-tui-frame", "scrollbar-bottom-80", scrolledBox(80, { total: 30, visible: 6, offset: 24 }));
  });

  it("sizes the thumb by the visible share and draws its ends in eighths", () => {
    const cells = (input) => plain(frame.renderMmrScrollbar(input, theme)).join("");
    assert.equal(cells({ total: 30, visible: 6, offset: 0 }), "█▆    ", "6 of 30 rows: a thumb of 1.2 cells");
    assert.equal(cells({ total: 30, visible: 6, offset: 24 }), "    ▂█", "the thumb ends on the last cell");
    assert.equal(cells({ total: 12, visible: 6, offset: 3 }), " ▄██▄ ", "half the list, half way");
    assert.equal(cells({ total: 1000, visible: 4, offset: 500 }).replace(/ /g, "").length, 2, "a thumb is never thinner than one cell");
    assert.equal(frame.renderMmrScrollbar({ total: 6, visible: 6, offset: 0 }, theme), undefined, "no scrollbar when everything fits");
    assert.equal(frame.renderMmrScrollbar({ total: 3, visible: 6, offset: 0 }, theme), undefined);
  });

  it("draws the upper part of a thumb end with the colors swapped", () => {
    const [top, end] = frame.renderMmrScrollbar({ total: 30, visible: 6, offset: 0 }, theme);
    assert.equal(top, "\x1b[38;5;243m\x1b[48;5;236m█\x1b[49m\x1b[39m");
    assert.equal(end, "\x1b[38;5;243m\x1b[48;5;236m\x1b[7m▆\x1b[27m\x1b[49m\x1b[39m");
  });
});
