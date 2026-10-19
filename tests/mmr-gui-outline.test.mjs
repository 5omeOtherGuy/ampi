// ampi-gui floating controls: the conversation outline's rows and the jump
// button's unread dot. Pure functions from the client module; the popover
// and the buttons are checked in a browser.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const controls = () => importSource("extensions/ampi-gui/client/controls.js");

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const MINUTE = 60_000;
const user = (id, text, ago, images = 0) => ({ type: "user", id, text, images, timestamp: NOW - ago });
const assistant = (id, ago) => ({ type: "assistant", id, parts: [{ type: "text", text: "Answer" }], timestamp: NOW - ago });

describe("ampi-gui conversation outline", () => {
  it("lists only your messages, oldest first, with their anchors and ages", async () => {
    const { outlineRows } = await controls();
    const items = [user("u1", "Fix the build", 3 * 60 * MINUTE), assistant("a1", 179 * MINUTE), user("u2", "Now the tests", 5 * MINUTE), assistant("a2", 4 * MINUTE), user("u3", "Thanks", 10_000)];
    assert.deepEqual(outlineRows(items, NOW), [
      { id: "u1", anchor: "m-u1", text: "Fix the build", age: "3h ago" },
      { id: "u2", anchor: "m-u2", text: "Now the tests", age: "5m ago" },
      { id: "u3", anchor: "m-u3", text: "Thanks", age: "just now" },
    ]);
  });

  it("shows a message's first line, with an ellipsis when more follows or the line is cut", async () => {
    const { outlineRows, OUTLINE_TEXT_MAX } = await controls();
    const long = `${"word ".repeat(30)}end`;
    const [several, cut, exact, images] = outlineRows(
      [user("u1", "\n  First line  \nsecond line", MINUTE), user("u2", long, MINUTE), user("u3", "x".repeat(OUTLINE_TEXT_MAX), MINUTE), user("u4", "", MINUTE, 2)],
      NOW,
    );
    assert.equal(several.text, "First line…");
    assert.ok(cut.text.endsWith("…"));
    assert.ok([...cut.text].length <= OUTLINE_TEXT_MAX, cut.text);
    assert.ok(long.startsWith(cut.text.slice(0, -1)), "the cut keeps the start of the line");
    assert.equal(exact.text, "x".repeat(OUTLINE_TEXT_MAX), "a line exactly at the limit is not cut");
    assert.equal(images.text, "2 images");
  });

  it("reads the ages from the clock it is given", async () => {
    const { outlineRows } = await controls();
    const items = [user("u1", "Hello", 2 * 24 * 60 * MINUTE)];
    assert.equal(outlineRows(items, NOW)[0].age, "2d ago");
    assert.equal(outlineRows(items, NOW + 7 * 24 * 60 * MINUTE)[0].age, "1w ago");
  });
});

describe("ampi-gui jump button dot", () => {
  it("lights when an item is added or changed while the reader is away from the bottom", async () => {
    const { nextUnread } = await controls();
    assert.equal(nextUnread(false, { atBottom: false, changed: true }), true);
    assert.equal(nextUnread(true, { atBottom: false }), true, "scrolling further up keeps it");
    assert.equal(nextUnread(false, { atBottom: false }), false, "scrolling up alone sets nothing");
  });

  it("clears at the bottom, and an item added there sets nothing", async () => {
    const { nextUnread } = await controls();
    assert.equal(nextUnread(true, { atBottom: true }), false);
    assert.equal(nextUnread(false, { atBottom: true, changed: true }), false);
  });
});
