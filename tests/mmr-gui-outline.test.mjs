// ampi-gui floating controls: the conversation outline's rows and the jump
// button's unread dot as pure functions, and the outline popover and the
// End key on a linkedom page; layout is checked in a browser.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { parseHTML } from "linkedom";
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

describe("ampi-gui outline popover", () => {
  /** A linkedom page with the outline mounted over `rows`; the global document and window are the page's while `run` runs. */
  async function withOutline(rows, run) {
    const { endJumps, mountOutline } = await controls();
    const { window, document } = parseHTML(
      '<!doctype html><html><body><div id="chat"></div><button id="outline"></button><div id="outline-menu" role="menu" hidden></div><textarea id="prompt"></textarea></body></html>',
    );
    let active = document.body;
    Object.defineProperty(document, "activeElement", { get: () => active, configurable: true });
    window.HTMLElement.prototype.focus = function focus() {
      active = this;
    };
    const saved = { document: globalThis.document, window: globalThis.window };
    globalThis.document = document;
    globalThis.window = window;
    try {
      const menu = document.getElementById("outline-menu");
      const outline = mountOutline({ button: document.getElementById("outline"), menu, scroller: document.getElementById("chat"), rows: () => rows });
      // The page's own End listener, added after the outline as the page adds it.
      const jumps = [];
      document.addEventListener("keydown", (event) => jumps.push(endJumps(event)));
      const end = (target) => target.dispatchEvent(Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key: "End" }));
      const texts = () => [...menu.querySelectorAll('[role="menuitem"]')].map((option) => option.querySelector(".outline-text").textContent);
      await run({ document, menu, outline, jumps, end, texts, active: () => active });
    } finally {
      globalThis.document = saved.document;
      globalThis.window = saved.window;
    }
  }

  const row = (id, text) => ({ id, anchor: `m-${id}`, text, age: "1m" });

  it("leaves End to the open outline, which moves to its last row without scrolling the chat", async () => {
    await withOutline([row("u1", "first"), row("u2", "second")], async ({ document, menu, outline, jumps, end, active }) => {
      end(document.body);
      assert.deepEqual(jumps, [true], "End on the page jumps to the newest output");
      end(document.getElementById("prompt"));
      assert.deepEqual(jumps, [true, false], "End in the prompt is the field's");
      outline.setCount(2);
      outline.toggle();
      assert.equal(menu.hidden, false);
      end(menu.querySelector('[role="menuitem"]'));
      assert.deepEqual(jumps, [true, false, false], "the outline used End");
      assert.equal(active().dataset.anchor, "m-u2");
    });
  });

  it("redraws its rows when the count of your messages changes while it is open, keeping the focused row", async () => {
    const rows = [row("u1", "first"), row("u2", "second")];
    await withOutline(rows, async ({ menu, outline, texts, active }) => {
      outline.setCount(2);
      outline.toggle();
      assert.deepEqual(texts(), ["first", "second"]);
      const focused = menu.querySelector('[data-anchor="m-u1"]');
      focused.focus();
      rows.push(row("u3", "third"));
      outline.setCount(3);
      assert.deepEqual(texts(), ["first", "second", "third"]);
      assert.equal(active().dataset.anchor, "m-u1", "focus stays on the row it was on");
      const drawn = menu.querySelector('[data-anchor="m-u1"]');
      outline.setCount(3);
      assert.equal(menu.querySelector('[data-anchor="m-u1"]'), drawn, "the same count draws nothing");
      rows.splice(0, 1);
      outline.setCount(2);
      assert.deepEqual(texts(), ["second", "third"]);
      assert.equal(active().dataset.anchor, "m-u3", "a row that is gone hands focus to the newest");
    });
  });

  it("leaves a closed outline's rows to the next open", async () => {
    const rows = [row("u1", "first"), row("u2", "second")];
    await withOutline(rows, async ({ menu, outline, texts }) => {
      outline.setCount(2);
      rows.push(row("u3", "third"));
      outline.setCount(3);
      assert.equal(menu.hidden, true);
      assert.deepEqual(texts(), []);
      outline.toggle();
      assert.deepEqual(texts(), ["first", "second", "third"]);
    });
  });
});
