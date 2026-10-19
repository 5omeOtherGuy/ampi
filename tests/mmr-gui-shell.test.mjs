// ampi-gui shell helpers: session disc colours, relative times, the sidebar
// search, the sidebar width and the More Actions entries (the page's keys
// are in mmr-gui-keys.test.mjs).
// Pure functions from the client modules; the page wiring is checked in a
// browser.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const sidebar = () => importSource("extensions/ampi-gui/client/sidebar.js");
const titlebar = () => importSource("extensions/ampi-gui/client/titlebar.js");

describe("ampi-gui sidebar helpers", () => {
  it("keeps a session's set colour and hashes the others onto the named colours, never gray", async () => {
    const { threadColor, THREAD_COLORS } = await sidebar();
    assert.equal(threadColor("any", "pink"), "pink");
    assert.equal(threadColor("any", "#A1b2C3"), "#A1b2C3");
    const hashed = threadColor("0193f0aa-1111-7000-8000-000000000001", null);
    assert.equal(threadColor("0193f0aa-1111-7000-8000-000000000001", "not-a-colour"), hashed, "an unknown colour falls back to the hash");
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(threadColor(`session-${i}`, null));
    assert.ok(seen.size >= 6, `ids spread over the colours (${[...seen]})`);
    assert.ok(!seen.has("gray"));
    for (const color of seen) assert.ok(THREAD_COLORS.includes(color), color);
  });

  it("writes relative times in the short form, on both sides of each unit", async () => {
    const { relativeTime } = await sidebar();
    const now = Date.parse("2026-10-18T12:00:00.000Z");
    const ago = (ms) => relativeTime(new Date(now - ms).toISOString(), now);
    const s = 1000;
    const m = 60 * s;
    const h = 60 * m;
    const d = 24 * h;
    assert.equal(ago(59 * s), "now");
    assert.equal(ago(60 * s), "1m");
    assert.equal(ago(59 * m), "59m");
    assert.equal(ago(60 * m), "1h");
    assert.equal(ago(23 * h + 59 * m), "23h");
    assert.equal(ago(d), "1d");
    assert.equal(ago(6 * d), "6d");
    assert.equal(ago(7 * d), "1w");
    assert.equal(ago(29 * d), "4w");
    assert.equal(ago(30 * d), "1mo");
    assert.equal(ago(364 * d), "12mo");
    assert.equal(ago(365 * d), "1y");
    assert.equal(ago(-5 * m), "now", "a clock ahead of the browser's");
    assert.equal(relativeTime("not a date", now), "");
  });

  it("filters by every word in the title, the project or the directory, and drops empty groups", async () => {
    const { filterGroups } = await sidebar();
    const groups = [
      { id: "pinned", kind: "pinned", label: "Pinned", sessions: [{ id: "a", title: "Fix the parser", cwd: "/work/app" }] },
      {
        id: "project:/work/lib",
        kind: "project",
        label: "lib",
        cwd: "/work/lib",
        sessions: [
          { id: "b", title: "Release notes", cwd: "/work/lib" },
          { id: "c", title: "Parser tests", cwd: "/work/lib" },
        ],
      },
    ];
    const ids = (result) => result.map((group) => [group.id, group.sessions.map((session) => session.id)]);
    assert.equal(filterGroups(groups, "  "), groups);
    assert.deepEqual(ids(filterGroups(groups, "PARSER")), [
      ["pinned", ["a"]],
      ["project:/work/lib", ["c"]],
    ]);
    assert.deepEqual(ids(filterGroups(groups, "lib notes")), [["project:/work/lib", ["b"]]]);
    assert.deepEqual(ids(filterGroups(groups, "pinned")), [], "a group's own label matches only for projects");
    assert.deepEqual(ids(filterGroups(groups, "parser release")), []);
  });

  it("keeps the sidebar between its narrowest and widest width", async () => {
    const { clampSidebarWidth, SIDEBAR_WIDTH } = await sidebar();
    assert.equal(SIDEBAR_WIDTH.default, 256);
    assert.equal(clampSidebarWidth(100), SIDEBAR_WIDTH.min);
    assert.equal(clampSidebarWidth(300.6), 301);
    assert.equal(clampSidebarWidth(5000), SIDEBAR_WIDTH.max);
    assert.equal(clampSidebarWidth(Number.NaN), 256, "a stored width that is not a number");
  });
});

describe("ampi-gui More Actions", () => {
  it("offers copy, rename and archive for the live session", async () => {
    const { menuItems } = await titlebar();
    const items = menuItems({ live: true, archived: false, actions: { archive: true, markdown: true } });
    assert.deepEqual(
      items.map((item) => (item.separator ? "---" : `${item.label}${item.disabled ? " (disabled)" : ""}`)),
      ["Copy as Markdown", "Rename…", "---", "Archive"],
    );
  });

  it("disables rename for another session, offers unarchive, and leaves out what the server cannot do", async () => {
    const { menuItems } = await titlebar();
    const saved = menuItems({ live: false, archived: true, actions: { archive: true, markdown: true } });
    const rename = saved.find((item) => item.action === "rename");
    assert.equal(rename.disabled, true);
    assert.match(rename.hint, /terminal/);
    assert.equal(saved.at(-1).label, "Unarchive");
    const bare = menuItems({ live: true, archived: false, actions: { archive: false, markdown: false } });
    assert.deepEqual(
      bare.map((item) => item.action),
      ["rename"],
    );
  });
});
