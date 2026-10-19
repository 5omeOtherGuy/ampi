// ampi-gui command palette: fuzzy ranking, the palette's sections as a view
// of the command registry (order, unavailable rows, the message fallback),
// the Switch Thread rows, and Archive Inactive over a fixture thread index.
// The client modules load in Node without a DOM; the page's wiring is
// checked in a browser.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const fuzzy = () => importSource("extensions/ampi-gui/client/fuzzy.js");
const palette = () => importSource("extensions/ampi-gui/client/palette.js");
const commandsModule = () => importSource("extensions/ampi-gui/client/commands.js");

const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const ago = (hours) => new Date(NOW - hours * HOUR).toISOString();

/** A session page with a writable, unarchived session shown and ampi-threads loaded. */
function sessionState(extra = {}) {
  const actions = { archive: true, markdown: true, cost: true };
  return {
    threadPage: true,
    writable: true,
    interruptible: false,
    session: { id: "shown", title: "Shown", archived: false, held: false, actions },
    focusedSession: null,
    sessionList: {
      currentId: "shown",
      actions,
      groups: [
        { id: "project:/w", kind: "project", label: "w", sessions: [{ id: "shown", title: "Shown", cwd: "/w", modified: ago(0) }] },
        { id: "inactive-72h", kind: "inactive", label: "Inactive Last 72h", sessions: [{ id: "old", title: "Old", cwd: "/w", modified: ago(100) }] },
      ],
    },
    shownId: "shown",
    ...extra,
  };
}

const titles = (sections) => sections.flatMap((section) => section.rows.map((row) => row.title));

describe("ampi-gui palette: fuzzy ranking", () => {
  it("ranks a word start followed by a run above a run inside a word, and that above scattered letters", async () => {
    const { fuzzyRank } = await fuzzy();
    const items = ["Answer now", "Crosswalk", "Switch Thread…"];
    assert.deepEqual(
      fuzzyRank(items, "sw", (text) => text).map((match) => match.item),
      ["Switch Thread…", "Crosswalk", "Answer now"],
    );
  });

  it("finds the best placement, not the first one: a later word start beats an earlier letter", async () => {
    const { fuzzyScore } = await fuzzy();
    // A greedy matcher takes the first s, inside "Hosts", and scores worse; the best placement is the start of "Show".
    assert.equal(fuzzyScore("sh", "Hosts Show"), fuzzyScore("sh", "Show"));
    assert.ok(fuzzyScore("sh", "Hosts Show") > fuzzyScore("sh", "Hosts xhow"));
    assert.equal(fuzzyScore("xyz", "Switch Thread"), null);
    assert.equal(fuzzyScore("ba", "ab"), null, "letters must come in order");
    assert.ok(fuzzyScore("ct", "copyText") > fuzzyScore("ct", "copytext"), "a capital after a lowercase letter starts a word");
  });

  it("needs every word of the query, puts a title equal to the query first, and breaks ties by the shorter title", async () => {
    const { fuzzyRank } = await fuzzy();
    // "Backlog" matches back but holds no g before an o.
    const items = ["Go Back Home", "Go Back", "Backlog"];
    assert.deepEqual(
      fuzzyRank(items, "go back", (text) => text).map((match) => match.item),
      ["Go Back", "Go Back Home"],
    );
    assert.deepEqual(
      fuzzyRank(["Archive Inactive Threads", "Archive Thread"], "arch", (text) => text).map((match) => match.item),
      ["Archive Thread", "Archive Inactive Threads"],
    );
    assert.deepEqual(
      fuzzyRank(items, "  ", (text) => text).map((match) => match.item),
      items,
      "an empty query keeps the order",
    );
  });

  it("ranks Archive Thread above Search Threads and Switch Thread above Show Chat Pane in the default palette", async () => {
    const { paletteSections } = await palette();
    const { DEFAULT_COMMANDS } = await commandsModule();
    const arch = titles(paletteSections(DEFAULT_COMMANDS, sessionState(), "arch"));
    assert.equal(arch[0], "Archive Thread");
    assert.ok(arch.indexOf("Archive Thread") < arch.indexOf("Search Threads…"), arch.join(", "));
    const sw = paletteSections(DEFAULT_COMMANDS, sessionState(), "sw").flatMap((section) => section.rows);
    const rank = (title) => sw.findIndex((row) => row.title === title);
    // "Show Where" starts both words with s and w, so it may rank with Switch; "Show" holds its w inside the word.
    assert.ok(rank("Switch Thread…") >= 0 && rank("Switch Thread…") < rank("Show Chat Pane"), sw.map((row) => row.title).join(", "));
  });
});

describe("ampi-gui palette: sections", () => {
  it("lists the sections in palette order and each section's commands in registration order when nothing is typed", async () => {
    const { paletteSections } = await palette();
    const run = () => {};
    const list = [
      { id: "nav-a", title: "Nav A", section: "Navigation", keys: [], run },
      { id: "thread-a", title: "Thread A", section: "Thread", keys: [], run },
      { id: "global-b", title: "Global B", section: "Global", keys: [], run },
      { id: "sidebar-a", title: "Sidebar A", section: "Sidebar", keys: [], run },
      { id: "global-a", title: "Global A", section: "Global", keys: ["mod+shift+k"], run },
      { id: "moved", title: "moved to Thread", section: "Sidebar", keys: [], palette: { title: "Moved", section: "Thread" }, run },
      { id: "left-out", title: "Left out", section: "Global", keys: [], palette: false, run },
      { id: "focus-only", title: "Focus only", section: "Global", context: "sidebar", keys: [], run },
      { id: "pane-a", title: "Pane A", section: "Thread Panes", keys: [], run },
    ];
    const sections = paletteSections(list, {}, "");
    assert.deepEqual(
      sections.map((section) => [section.section, section.rows.map((row) => row.title)]),
      [
        ["Global", ["Global B", "Global A"]],
        ["Thread", ["Thread A", "Moved"]],
        ["Thread Panes", ["Pane A"]],
        ["Navigation", ["Nav A"]],
      ],
    );
    assert.deepEqual(sections[0].rows[1].chips, ["Ctrl+Shift+K"]);
    assert.deepEqual(paletteSections(list, {}, "", { mac: true })[0].rows[1].chips, ["⇧⌘K"]);
  });

  it("shows the default registry with Title Case palette titles, without itself or key-only commands", async () => {
    const { paletteSections } = await palette();
    const { DEFAULT_COMMANDS } = await commandsModule();
    const sections = paletteSections(DEFAULT_COMMANDS, sessionState(), "");
    const byName = Object.fromEntries(sections.map((section) => [section.section, section.rows.map((row) => row.title)]));
    assert.deepEqual(Object.keys(byName), ["Global", "Thread", "Thread Panes", "Navigation"]);
    assert.deepEqual(byName.Global.slice(0, 7), [
      "Search Threads…",
      "Switch Thread…",
      "Open Activity",
      "Change Theme…",
      "Archive Inactive Threads Older than 72h",
      "Sidebar: Collapse All Projects",
      "Sidebar: Expand All Projects",
    ]);
    assert.ok(byName.Global.includes("Reload Page"));
    assert.deepEqual(byName.Navigation, ["Go Home", "Go Back", "Go Forward"]);
    assert.deepEqual(byName["Thread Panes"], ["Show Chat Pane", "Toggle Full Width"]);
    assert.equal(byName.Thread[0], "Archive Thread", "the sidebar's archive key is listed under Thread");
    const all = Object.values(byName).flat();
    for (const absent of ["Toggle command palette", "Move between user messages", "Move sidebar selection down", "Toggle sidebar"]) {
      assert.ok(!all.includes(absent), absent);
    }
  });

  it("lists commands that cannot run with their reason and leaves hidden ones out", async () => {
    const { paletteSections } = await palette();
    const { DEFAULT_COMMANDS } = await commandsModule();
    const home = { threadPage: false, writable: false, session: null, focusedSession: null, sessionList: { groups: [], actions: {} }, shownId: null };
    const rows = paletteSections(DEFAULT_COMMANDS, home, "").flatMap((section) => section.rows);
    const row = (title) => rows.find((candidate) => candidate.title === title);
    assert.deepEqual([row("Delete Thread").state, row("Delete Thread").reason], ["unavailable", "No session is shown"]);
    assert.deepEqual([row("Switch Thread…").state, row("Switch Thread…").reason], ["unavailable", "No other session is listed"]);
    assert.equal(row("Archive Inactive Threads Older than 72h").reason, "Archiving needs ampi-threads");
    assert.equal(row("Rename Thread"), undefined, "Rename is hidden without a session");
    assert.equal(row("Show Chat Pane"), undefined, "the composer is not on the home page");
    assert.equal(row("Go Home").state, "available");

    // With a query the commands that can run come first in their section, and the section with the best match first.
    const typed = paletteSections(DEFAULT_COMMANDS, sessionState(), "archive");
    assert.deepEqual(
      typed.map((section) => [section.section, section.rows.map((entry) => [entry.title, entry.state])]),
      [
        [
          "Thread",
          [
            ["Archive Thread", "available"],
            ["Unarchive Thread", "unavailable"],
          ],
        ],
        ["Global", [["Archive Inactive Threads Older than 72h", "available"]]],
      ],
    );
    assert.equal(typed[0].rows[1].reason, "This session is not archived");
  });

  it("offers to send the text as a message only when no command matches it well", async () => {
    const { paletteSections, SEND_TITLE } = await palette();
    const { DEFAULT_COMMANDS } = await commandsModule();
    const prose = paletteSections(DEFAULT_COMMANDS, sessionState(), "please fix the parser");
    assert.deepEqual(prose[0], {
      section: "Message",
      rows: [{ kind: "message", id: "send-message", title: SEND_TITLE, text: "please fix the parser", state: "available" }],
    });
    assert.equal(prose.length, 1);

    // One letter inside a word matches, but not well: the message comes first, the weak matches after it.
    const weak = paletteSections(DEFAULT_COMMANDS, sessionState(), "z");
    assert.equal(weak[0].section, "Message");
    assert.ok(titles(weak).includes("Snooze or Unsnooze Thread"));

    for (const query of ["arch", "sw", "theme", "go home"]) {
      assert.ok(!paletteSections(DEFAULT_COMMANDS, sessionState(), query).some((section) => section.section === "Message"), query);
    }
    assert.ok(!paletteSections(DEFAULT_COMMANDS, sessionState(), "").some((section) => section.section === "Message"));

    const readOnly = paletteSections(DEFAULT_COMMANDS, sessionState({ writable: false }), "hello there")[0].rows[0];
    assert.deepEqual([readOnly.state, readOnly.reason], ["unavailable", "This session is read-only here"]);
    const home = paletteSections(DEFAULT_COMMANDS, sessionState({ threadPage: false }), "hello there")[0].rows[0];
    assert.equal(home.state, "unavailable");
  });
});

describe("ampi-gui palette: Switch Thread", () => {
  it("lists every other session, the most recently active first, and filters them by title", async () => {
    const { switchRows } = await palette();
    const list = {
      groups: [
        { kind: "pinned", sessions: [{ id: "p", title: "Pinned plan", cwd: "/w/app", modified: ago(5) }] },
        {
          kind: "project",
          sessions: [
            { id: "current", title: "Current work", cwd: "/w/app", modified: ago(0) },
            { id: "b", title: "Build fixes", cwd: "/w/lib", modified: ago(1) },
          ],
        },
        { kind: "archived", sessions: [{ id: "a", title: "Archived sweep", cwd: "/w/old", modified: ago(200) }] },
      ],
    };
    const rows = switchRows(list, "current", "", NOW);
    assert.deepEqual(
      rows.map((row) => row.id),
      ["b", "p", "a"],
    );
    assert.deepEqual(rows[0], { kind: "session", id: "b", title: "Build fixes", description: "lib", time: "1h", state: "available" });
    assert.deepEqual(
      switchRows(list, "current", "sw", NOW).map((row) => row.id),
      ["a"],
    );
    assert.deepEqual(
      switchRows(list, null, "", NOW).map((row) => row.id),
      ["current", "b", "p", "a"],
      "on Activity no session is shown",
    );
  });

  it("is unavailable when no other session is listed", async () => {
    const { DEFAULT_COMMANDS } = await commandsModule();
    const command = DEFAULT_COMMANDS.find((entry) => entry.id === "switch-thread");
    const only = { groups: [{ kind: "project", sessions: [{ id: "shown" }] }] };
    assert.equal(command.when({ sessionList: only, shownId: "shown" }).state, "unavailable");
    assert.equal(command.when({ sessionList: only, shownId: null }).state, "available");
    assert.deepEqual(command.keys, ["mod+p"]);
  });
});

describe("ampi-gui palette: Archive Inactive", () => {
  it("archives exactly the Inactive group of a fixture thread index, after asking with the count", async () => {
    const { groupMmrGuiSessions } = await importSource("extensions/ampi-gui/sessions.ts");
    const { DEFAULT_COMMANDS } = await commandsModule();
    const { archiveInactiveDialogHtml, archiveSessions } = await importSource("extensions/ampi-gui/client/titlebar.js");
    const info = (id, ageHours, extra = {}) => ({
      path: `/sessions/${id}.jsonl`,
      id,
      cwd: "/work/app",
      created: new Date(NOW - ageHours * HOUR - HOUR),
      modified: new Date(NOW - ageHours * HOUR),
      messageCount: 2,
      firstMessage: `First prompt of ${id}`,
      allMessagesText: "",
      ...extra,
    });
    const groups = groupMmrGuiSessions({
      sessions: [
        info("recent", 2),
        info("stale-1", 80),
        info("pinned-old", 300),
        info("snoozed-old", 300),
        info("archived-old", 300),
        info("stale-2", 400),
        info("running-old", 500),
      ],
      threads: {
        "pinned-old": { pinned: true },
        "snoozed-old": { snoozed: "2026-10-17T00:00:00.000Z" },
        "archived-old": { archived: "2026-10-01T00:00:00.000Z" },
      },
      elsewhere: new Set(["/sessions/running-old.jsonl"]),
      now: NOW,
      home: "/home/someone",
    });
    const list = { currentId: null, groups, actions: { archive: true, markdown: true, cost: false } };
    const command = DEFAULT_COMMANDS.find((entry) => entry.id === "archive-inactive");
    assert.equal(command.when({ sessionList: list }).state, "available");

    let asked;
    command.run({ sessionList: list, ui: { archiveInactive: (ids) => (asked = ids) } });
    assert.deepEqual(asked, ["stale-1", "stale-2"]);
    assert.match(archiveInactiveDialogHtml(asked.length), /2 sessions/);
    assert.match(archiveInactiveDialogHtml(1), /1 session /);

    const posted = [];
    const post = async (route, body) => {
      posted.push([route, body]);
      return { ok: body.sessionId !== "stale-2", body: {} };
    };
    assert.deepEqual(await archiveSessions(asked, post), { archived: 1, failed: 1 });
    assert.deepEqual(posted, [
      ["archive", { sessionId: "stale-1", archived: true }],
      ["archive", { sessionId: "stale-2", archived: true }],
    ]);

    assert.equal(command.when({ sessionList: { ...list, actions: { archive: false } } }).reason, "Archiving needs ampi-threads");
    const none = { ...list, groups: groups.filter((group) => group.kind !== "inactive") };
    assert.equal(command.when({ sessionList: none }).reason, "No session has been inactive for 72 hours");
  });
});
