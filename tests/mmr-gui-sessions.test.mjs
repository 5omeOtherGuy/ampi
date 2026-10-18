// ampi-gui sessions: the sidebar's groups from a session catalogue and the
// thread index (pinned, one per project, Inactive Last 72h, Archived), and
// the read-only view of a saved session, which never writes its file.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const load = () => importSource("extensions/ampi-gui/sessions.ts");

const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

/** A catalogue record as Pi's session listing returns it. */
function info(id, cwd, ageMs, extra = {}) {
  return {
    path: `/sessions/${id}.jsonl`,
    id,
    cwd,
    created: new Date(NOW - ageMs - HOUR),
    modified: new Date(NOW - ageMs),
    messageCount: 2,
    firstMessage: `First prompt of ${id}`,
    allMessagesText: "",
    ...extra,
  };
}

const ids = (group) => group.sessions.map((session) => session.id);

describe("ampi-gui sessions: groups", () => {
  it("groups pinned, per project, Inactive Last 72h and Archived, each newest first", async () => {
    const { groupMmrGuiSessions } = await load();
    const groups = groupMmrGuiSessions({
      sessions: [
        info("app-old", "/work/app", 72 * HOUR),
        info("pinned", "/work/app", 1 * HOUR),
        info("lib-new", "/work/lib", 0.5 * HOUR),
        info("app-new", "/work/app", 2 * HOUR, { name: "Named session" }),
        info("stale", "/work/app", 72 * HOUR + 1000),
        info("archived-pinned", "/work/app", 0.1 * HOUR),
        info("lib-running", "/work/lib", 240 * HOUR),
        info("archived-old", "/work/lib", 500 * HOUR),
      ],
      threads: {
        pinned: { pinned: true },
        "archived-pinned": { pinned: true, archived: "2026-10-17T00:00:00.000Z" },
        "archived-old": { archived: "2026-10-01T00:00:00.000Z", color: "#123456" },
        "app-new": { color: "green" },
      },
      current: { id: "live", title: "Live session", cwd: "/work/app" },
      elsewhere: new Set(["/sessions/../sessions/lib-running.jsonl"]),
      now: NOW,
      home: "/home/someone",
    });

    assert.deepEqual(
      groups.map((group) => [group.id, group.kind, group.label, ids(group)]),
      [
        ["pinned", "pinned", "Pinned", ["pinned"]],
        // The live session, not saved yet, counts as now: its project comes first.
        ["project:/work/app", "project", "app", ["live", "app-new", "app-old"]],
        ["project:/work/lib", "project", "lib", ["lib-new", "lib-running"]],
        ["inactive-72h", "inactive", "Inactive Last 72h", ["stale"]],
        ["archived", "archived", "Archived", ["archived-pinned", "archived-old"]],
      ],
    );
    const rows = Object.fromEntries(groups.flatMap((group) => group.sessions).map((row) => [row.id, row]));
    assert.equal(rows.live.live, true);
    assert.equal(rows.live.title, "Live session");
    assert.equal(rows.live.messageCount, 0);
    assert.equal(rows.live.modified, new Date(NOW).toISOString());
    assert.equal(rows["lib-running"].elsewhere, true, "another Pi runs it, so it stays with its project");
    assert.equal(rows["app-new"].title, "Named session");
    assert.equal(rows["app-old"].title, "First prompt of app-old");
    assert.equal(rows["app-new"].color, "green");
    assert.equal(rows["archived-old"].color, "#123456");
    assert.equal(rows.stale.color, null);
    assert.equal(rows["archived-pinned"].pinned, true);
    assert.equal(rows["archived-pinned"].archived, true);
    assert.equal(groups[1].cwd, "/work/app");
  });

  it("lists the live session once, from the catalogue when Pi has saved it, and drops empty groups", async () => {
    const { groupMmrGuiSessions } = await load();
    const groups = groupMmrGuiSessions({
      sessions: [info("live", "/work/app", 3 * HOUR, { name: "Saved title" }), info("live", "/other/dir", 4 * HOUR)],
      threads: {},
      current: { id: "live", title: "Current title", cwd: "/work/app" },
      now: NOW,
    });
    assert.deepEqual(
      groups.map((group) => [group.id, ids(group)]),
      [["project:/work/app", ["live"]]],
    );
    const [row] = groups[0].sessions;
    assert.equal(row.title, "Current title", "the running process knows the newest title");
    assert.equal(row.modified, new Date(NOW - 3 * HOUR).toISOString());
  });

  it("names projects by their last directory, ~ for home and No project without a directory", async () => {
    const { mmrGuiProjectLabel } = await load();
    assert.equal(mmrGuiProjectLabel("/work/app", "/home/someone"), "app");
    assert.equal(mmrGuiProjectLabel("/home/someone", "/home/someone"), "~");
    assert.equal(mmrGuiProjectLabel("/home/someone/", "/home/someone"), "~");
    assert.equal(mmrGuiProjectLabel("", "/home/someone"), "No project");
  });
});

/** A small saved session: a prompt, a reply on an abandoned branch, a mode entry and the current reply. */
function sessionFile(id) {
  const entries = [
    { type: "session", version: 3, id, timestamp: "2026-10-18T09:00:00.000Z", cwd: "/work/app" },
    { type: "message", id: "e1", parentId: null, timestamp: "2026-10-18T09:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Explain the parser" }], timestamp: 1 } },
    { type: "message", id: "e2", parentId: "e1", timestamp: "2026-10-18T09:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "Abandoned reply" }], timestamp: 2, stopReason: "stop" } },
    { type: "custom", id: "e3", parentId: "e1", timestamp: "2026-10-18T09:00:03.000Z", customType: "ampi-core.mode-state", data: { version: 1, mode: "high", model: "faux/faux-1" } },
    { type: "message", id: "e4", parentId: "e3", timestamp: "2026-10-18T09:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "The parser reads tokens." }], timestamp: 4, stopReason: "stop" } },
  ];
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

describe("ampi-gui sessions: reading", () => {
  it("follows the current branch from the last entry, like Pi", async () => {
    const { readMmrGuiSessionEntries } = await load();
    const { header, branch } = readMmrGuiSessionEntries(sessionFile("s-saved"));
    assert.equal(header.id, "s-saved");
    assert.deepEqual(
      branch.map((entry) => entry.id),
      ["e1", "e3", "e4"],
    );
  });

  it("lists, finds and shows a saved session read-only, without writing its file", async () => {
    const { createMmrGuiSessions } = await load();
    const dir = mkdtempSync(path.join(tmpdir(), "ampi-gui-sessions-"));
    try {
      const file = path.join(dir, "s-saved.jsonl");
      writeFileSync(file, sessionFile("s-saved"));
      const before = statSync(file).mtimeMs;
      let listed = 0;
      let clock = NOW;
      const sessions = createMmrGuiSessions({
        source: {
          listSessions: async () => {
            listed += 1;
            return [{ ...info("s-saved", "/work/app", HOUR), path: file }];
          },
        },
        current: () => ({ id: "live", title: "Live", cwd: "/work/app", mode: "medium", model: null }),
        threadIndex: () => ({ list: async () => ({ "s-saved": { color: "cyan" } }) }),
        now: () => clock,
        home: "/home/someone",
      });

      const list = await sessions.list();
      assert.equal(list.currentId, "live");
      assert.equal(list.actions.archive, true);
      assert.deepEqual(
        list.groups.map((group) => ids(group)),
        [["live", "s-saved"]],
      );

      const view = await sessions.view("s-saved");
      assert.equal(view.session.id, "s-saved");
      assert.equal(view.session.title, "First prompt of s-saved");
      assert.equal(view.session.mode, "high");
      assert.equal(view.row.color, "cyan");
      assert.deepEqual(
        view.items.map((item) => (item.type === "user" ? `user: ${item.text}` : `assistant: ${item.parts[0].text}`)),
        ["user: Explain the parser", "assistant: The parser reads tokens."],
      );
      assert.equal(await sessions.view("missing"), undefined);
      assert.equal(await sessions.find("s-sav"), undefined, "ids match exactly");

      assert.equal(listed, 1, "the catalogue is listed once while it is fresh");
      clock += 10_000;
      await sessions.list();
      assert.equal(listed, 2, "and again once it is stale");

      assert.equal(readFileSync(file, "utf8"), sessionFile("s-saved"));
      assert.equal(statSync(file).mtimeMs, before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists every session as unarchived when the thread index cannot be read", async () => {
    const { createMmrGuiSessions } = await load();
    const sessions = createMmrGuiSessions({
      source: { listSessions: async () => [info("s-1", "/work/app", 100 * HOUR)] },
      current: () => undefined,
      threadIndex: () => ({
        list: async () => {
          throw new Error("unreadable");
        },
      }),
      now: () => NOW,
    });
    const list = await sessions.list();
    assert.equal(list.currentId, null);
    assert.deepEqual(
      list.groups.map((group) => [group.id, ids(group)]),
      [["inactive-72h", ["s-1"]]],
    );
  });
});
