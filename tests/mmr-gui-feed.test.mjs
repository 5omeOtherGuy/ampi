// ampi-gui Activity and Search Threads: the `is:` keys of ampi-core's
// session search language and its row matcher, the filters a row cannot
// answer reported back, the feed's time windows, status filters, project
// counts and day groups, the GET /api/feed and /api/search routes on a
// session server and on ampi app's hub (validation and the request policy),
// and the client helpers that keep the filters in the address and escape
// what they draw. The fixture sessions and the clock are fixed; every
// expected list below is written by hand from the fixture table.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const NOW = Date.parse("2026-10-18T12:00:00.000Z"); // a Sunday; 08:00 in New York
const HOUR = 60 * 60 * 1000;
const TOKEN = ["feed", "test", "token"].join("-");

/**
 * | id     | cwd         | last activity          | thread index                  |
 * | ------ | ----------- | ---------------------- | ----------------------------- |
 * | live-1 | /work/ampi  | now (not saved yet)    |                               |
 * | a      | /work/ampi  | now - 1h               | pinned, label bug             |
 * | b      | /work/docs  | 03:30Z today           | (named "Release notes")       |
 * | c      | /work/ampi  | now - 24h exactly      | snoozed after its activity    |
 * | d      | /work/ampi  | now - 24h - 1ms        | archived                      |
 * | e      | (none)      | now - 72h exactly      | unread                        |
 * | f      | /work/docs  | now - 72h - 1ms        | labels docs, bug-triage       |
 * | g      | /work/site  | now - 10 days          | title with markup             |
 */
const SESSIONS = [
  info("a", "/work/ampi", NOW - HOUR, { firstMessage: "Fix the parser bug in the tokenizer" }),
  info("b", "/work/docs", Date.parse("2026-10-18T03:30:00.000Z"), { name: "Release notes", firstMessage: "Write the release notes for 0.9" }),
  info("c", "/work/ampi", NOW - 24 * HOUR, { firstMessage: "Snoozed refactor of the parser" }),
  info("d", "/work/ampi", NOW - 24 * HOUR - 1, { firstMessage: "Old archived experiment" }),
  info("e", "", NOW - 72 * HOUR, { firstMessage: "Question without a project" }),
  info("f", "/work/docs", NOW - 72 * HOUR - 1, { firstMessage: "Triage the docs bugs" }),
  info("g", "/work/site", NOW - 10 * 24 * HOUR, { firstMessage: '<img src=x onerror="alert(1)"> & friends' }),
];

const THREADS = {
  a: { pinned: true, labels: ["bug"] },
  c: { snoozed: new Date(NOW - 12 * HOUR).toISOString() },
  d: { archived: "2026-10-17T00:00:00.000Z" },
  e: { unread: true },
  f: { labels: ["docs", "bug-triage"] },
};

function info(id, cwd, modified, extra = {}) {
  return {
    path: `/sessions/${id}.jsonl`,
    id,
    cwd,
    created: new Date(modified - HOUR),
    modified: new Date(modified),
    messageCount: 2,
    firstMessage: "",
    allMessagesText: "",
    ...extra,
  };
}

let sessionsModule;
let activity;
let query;
let rows;
const dirs = [];

/** The sessions as the GUI lists them, with `hosts` for the hub's rows. */
function createSessions(options = {}) {
  return sessionsModule.createMmrGuiSessions({
    source: { listSessions: async () => SESSIONS },
    current: () => options.current,
    hosts: options.hosts,
    threadIndex: () => ({ list: async () => structuredClone(THREADS) }),
    now: () => NOW,
    home: "/home/someone",
  });
}

before(async () => {
  sessionsModule = await importSource("extensions/ampi-gui/sessions.ts");
  activity = await importSource("extensions/ampi-gui/activity.ts");
  query = await importSource("extensions/ampi-core/session-query.ts");
  rows = (await createSessions({ current: { id: "live-1", title: "Live work", cwd: "/work/ampi" } }).searchable()).rows;
});
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const ids = (list) => list.map((row) => row.id);
const feed = (params) => {
  const parsed = activity.parseMmrGuiFeedRequest(new URLSearchParams({ tz: "UTC", locale: "en-US", ...params }));
  assert.equal(parsed.ok, true, parsed.error);
  return activity.buildMmrGuiFeed(rows, parsed.value, { now: NOW, home: "/home/someone" });
};
const feedIds = (params) => feed(params).days.flatMap((day) => ids(day.sessions));
const search = (q, limit = 50) => activity.searchMmrGuiSessions(rows, { q, limit }, { now: NOW, home: "/home/someone" });

describe("session query: is: and the row matcher", () => {
  it("parses each is: flag in any case and refuses other values", () => {
    const parsed = query.parseSessionQuery("is:Archived is:snoozed is:PINNED is:live is:unread is:open is:", new Date(NOW));
    assert.deepEqual(parsed.is, ["archived", "snoozed", "pinned", "live", "unread"]);
    assert.deepEqual(parsed.isTokens, ["is:Archived", "is:snoozed", "is:PINNED", "is:live", "is:unread"]);
    assert.deepEqual(parsed.invalidFilters, ["is:open", "is:"]);
    assert.deepEqual(parsed.terms, []);
  });

  it("reports the filters a row cannot answer, and nothing it can", () => {
    const parsed = query.parseSessionQuery(
      'parser "exact phrase" label:x project:y cwd:z is:live pinned:true archived:false after:7d before:today id:01 name:n provider:p model:m tool:t file:f has:tools repo:o/r parent:01 created_after:7d offset:2 sort:created commit:abc colour:red',
      new Date(NOW),
    );
    assert.deepEqual(query.unevaluatedMmrSessionRowFilters(parsed).sort(), [
      "colour:red",
      "commit:abc",
      "created_after:7d",
      "file:f",
      "has:tools",
      "model:m",
      "offset:2",
      "parent:01",
      "provider:p",
      "repo:o/r",
      "sort:created",
      "tool:t",
    ]);
  });

  it("matches words anywhere in the title, name or first message, and phrases only as written", () => {
    assert.deepEqual(ids(search("parser").results), ["a", "c"]);
    assert.deepEqual(ids(search("PARSER tokenizer").results), ["a"]);
    assert.deepEqual(ids(search('"release notes"').results), ["b"]);
    assert.deepEqual(ids(search("notes release").results), ["b"]);
    assert.deepEqual(ids(search('"notes release"').results), []);
  });

  it("matches label:, project: and cwd: by part, ignoring case", () => {
    assert.deepEqual(ids(search("label:bug").results), ["a", "f"]);
    assert.deepEqual(ids(search("label:DOCS").results), ["f"]);
    assert.deepEqual(ids(search("project:docs").results), ["b", "f"]);
    assert.deepEqual(ids(search("cwd:/work/ampi").results), ["live-1", "a", "c", "d"]);
    assert.deepEqual(ids(search("label:bug project:ampi").results), ["a"]);
  });

  it("matches each is: flag, and needs all of them together", () => {
    assert.deepEqual(ids(search("is:pinned").results), ["a"]);
    assert.deepEqual(ids(search("is:snoozed").results), ["c"]);
    assert.deepEqual(ids(search("is:archived").results), ["d"]);
    assert.deepEqual(ids(search("is:unread").results), ["e"]);
    assert.deepEqual(ids(search("is:live").results), ["live-1"]);
    assert.deepEqual(ids(search("is:live is:pinned").results), []);
    assert.deepEqual(ids(search("archived:false is:pinned").results), ["a"]);
  });

  it("bounds after: and before: by the last activity", () => {
    assert.deepEqual(ids(search("after:3d").results), ["live-1", "a", "b", "c", "d", "e"]);
    assert.deepEqual(ids(search("before:2026-10-10").results), ["g"]);
  });

  it("reports filters that need the transcript, and values it cannot read, and matches without them", () => {
    const answer = search("parser provider:anthropic has:tools commit:abc after:soon is:open");
    assert.deepEqual(answer.applied, {
      q: "parser provider:anthropic has:tools commit:abc after:soon is:open",
      unsupported: ["provider:anthropic", "has:tools", "commit:abc"],
      invalid: ["after:soon", "is:open"],
    });
    assert.deepEqual(ids(answer.results), ["a", "c"]);
  });

  it("lists every session, newest first, for an empty query, up to the limit, with the project and a one-line preview", () => {
    const answer = search("", 3);
    assert.equal(answer.total, 8);
    assert.deepEqual(ids(answer.results), ["live-1", "a", "b"]);
    assert.deepEqual(
      answer.results.map((result) => [result.project, result.preview, result.title]),
      [
        ["ampi", "", "Live work"],
        ["ampi", "Fix the parser bug in the tokenizer", "Fix the parser bug in the tokenizer"],
        ["docs", "Write the release notes for 0.9", "Release notes"],
      ],
    );
    assert.equal(search("is:unread").results[0].project, "No project");
  });
});

describe("Activity feed", () => {
  it("includes a session active exactly 24 or 72 hours ago in that window, and not one a millisecond older", () => {
    assert.deepEqual(feedIds({ time: "24h" }), ["live-1", "a", "b", "c"]);
    assert.deepEqual(feedIds({ time: "72h" }), ["live-1", "a", "b", "c", "d", "e"]);
    assert.deepEqual(feedIds({ time: "7d" }), ["live-1", "a", "b", "c", "d", "e", "f"]);
    assert.deepEqual(feedIds({ time: "all" }), ["live-1", "a", "b", "c", "d", "e", "f", "g"]);
    assert.deepEqual(feedIds({}), feedIds({ time: "24h" }), "the window defaults to 24h");
  });

  it("filters by status: active is neither archived nor snoozed", () => {
    assert.deepEqual(feedIds({ time: "all", status: "active" }), ["live-1", "a", "b", "e", "f", "g"]);
    assert.deepEqual(feedIds({ time: "all", status: "archived" }), ["d"]);
    assert.deepEqual(feedIds({ time: "all", status: "snoozed" }), ["c"]);
    assert.deepEqual(feedIds({ time: "all", status: "all" }), feedIds({ time: "all" }));
  });

  it("counts each project over every other filter, and narrows to one with project=", () => {
    const all = feed({ time: "all" });
    assert.deepEqual(all.projects, [
      { cwd: "/work/ampi", label: "ampi", count: 4 },
      { cwd: "/work/docs", label: "docs", count: 2 },
      { cwd: "", label: "No project", count: 1 },
      { cwd: "/work/site", label: "site", count: 1 },
    ]);
    assert.equal(all.total, 8);
    const docs = feed({ time: "all", project: "/work/docs" });
    assert.deepEqual(docs.projects, all.projects, "counts ignore the project filter");
    assert.equal(docs.total, 2);
    assert.deepEqual(feedIds({ time: "all", project: "/work/docs" }), ["b", "f"]);
    assert.deepEqual(feedIds({ time: "all", project: "none" }), ["e"]);
    assert.deepEqual(feed({ time: "24h", status: "active", q: "label:bug" }).projects, [{ cwd: "/work/ampi", label: "ampi", count: 1 }]);
  });

  it("applies the query and reports what it applied", () => {
    const answer = feed({ time: "all", q: "label:bug tool:bash", project: "/work/docs" });
    assert.deepEqual(answer.applied, { time: "all", status: "all", project: "/work/docs", q: "label:bug tool:bash", unsupported: ["tool:bash"], invalid: [] });
    assert.deepEqual(ids(answer.days.flatMap((day) => day.sessions)), ["f"]);
  });

  it("groups by calendar day in the time zone passed in, so a session before midnight there is Yesterday", () => {
    const newYork = feed({ time: "72h", tz: "America/New_York" });
    assert.deepEqual(
      newYork.days.map((day) => [day.date, day.label, ids(day.sessions)]),
      [
        ["2026-10-18", "Today", ["live-1", "a"]],
        ["2026-10-17", "Yesterday", ["b", "c", "d"]],
        ["2026-10-15", "Thursday, October 15", ["e"]],
      ],
    );
    const utc = feed({ time: "72h", tz: "UTC" });
    assert.deepEqual(
      utc.days.map((day) => [day.date, day.label, ids(day.sessions)]),
      [
        ["2026-10-18", "Today", ["live-1", "a", "b"]],
        ["2026-10-17", "Yesterday", ["c", "d"]],
        ["2026-10-15", "Thursday, October 15", ["e"]],
      ],
    );
    assert.equal(feed({ time: "72h", locale: "de-DE" }).days[2].label, "Donnerstag, 15. Oktober");
    assert.equal(feed({ time: "all" }).days.at(-1).label, "Thursday, October 8");
  });

  it("names the year of a day in another year", () => {
    assert.equal(activity.mmrGuiDayLabel("2025-12-31", "2026-01-01", "en-US"), "Yesterday");
    assert.equal(activity.mmrGuiDayLabel("2025-12-30", "2026-01-01", "en-US"), "Tuesday, December 30, 2025");
  });

  it("refuses a time, status, zone, language or limit it does not know, and a query that is too long", () => {
    const bad = (params) => activity.parseMmrGuiFeedRequest(new URLSearchParams(params));
    assert.match(bad({ time: "1h" }).error, /^time must be one of 24h, 72h, 7d, all\.$/);
    assert.match(bad({ status: "committed" }).error, /^status must be one of all, active, archived, snoozed\.$/);
    assert.equal(bad({ tz: "Mars/Olympus" }).ok, false);
    assert.equal(bad({ locale: "not a tag" }).ok, false);
    assert.equal(bad({ q: "x".repeat(2001) }).ok, false);
    assert.equal(bad({ q: "x".repeat(2000) }).ok, true);
    const limit = (value) => activity.parseMmrGuiSearchRequest(new URLSearchParams({ limit: value }));
    for (const value of ["0", "201", "-1", "2.5", "ten"]) assert.equal(limit(value).ok, false, value);
    assert.deepEqual(limit("200").value, { q: "", limit: 200 });
    assert.deepEqual(activity.parseMmrGuiSearchRequest(new URLSearchParams()).value, { q: "", limit: 50 });
  });
});

/** A raw request with exactly the headers given (no default Host). */
function send(port, target, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: target, headers, setHost: false, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: text, json: () => JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("GET /api/feed and /api/search", () => {
  const clientDir = () => path.join(getPreparedSourceRoot(), "extensions/ampi-gui/client");
  const servers = [];
  after(async () => {
    for (const server of servers) await server.close();
  });

  async function sessionServer() {
    const { startMmrGuiServer } = await importSource("extensions/ampi-gui/server.ts");
    const server = await startMmrGuiServer({
      bridge: {},
      commands: {},
      exportSession: async () => ({ status: 404, body: {} }),
      sessions: createSessions({ current: { id: "live-1", title: "Live work", cwd: "/work/ampi" } }),
      token: TOKEN,
      clientDir: clientDir(),
    });
    servers.push(server);
    return server;
  }

  async function hub() {
    const { startMmrGuiHub } = await importSource("extensions/ampi-gui/hub.ts");
    const registry = mkdtempSync(path.join(tmpdir(), "ampi-gui-feed-"));
    dirs.push(registry);
    const server = await startMmrGuiHub({
      token: TOKEN,
      clientDir: clientDir(),
      startSession: async () => {
        throw new Error("no workers here");
      },
      // The hub's rows carry `host`: f is open in a terminal.
      sessions: createSessions({ hosts: async () => new Map([["/sessions/f.jsonl", { kind: "tui", pid: 7, gui: false, phase: "idle" }]]) }),
      commands: {},
      exportSession: async () => ({ status: 404, body: {} }),
      registry: { dir: registry },
      setTimer: () => 0,
      clearTimer: () => {},
    });
    servers.push(server);
    return server;
  }

  for (const [name, start] of [
    ["a session server", sessionServer],
    ["ampi app's hub", hub],
  ]) {
    it(`answers on ${name}, and refuses a bad value with 400`, async () => {
      const { port } = await start();
      const headers = { host: `127.0.0.1:${port}`, cookie: `ampi_gui_${port}=${TOKEN}` };
      const answer = await send(port, "/api/feed?time=all&status=active&project=%2Fwork%2Fdocs&tz=UTC", headers);
      assert.equal(answer.status, 200);
      assert.match(answer.headers["content-type"], /^application\/json/);
      assert.equal(answer.headers["access-control-allow-origin"], undefined);
      assert.deepEqual(
        answer.json().days.flatMap((day) => ids(day.sessions)),
        ["b", "f"],
      );
      const live = await send(port, `/api/search?q=${encodeURIComponent("is:live")}`, headers);
      assert.deepEqual(ids(live.json().results), name === "a session server" ? ["live-1"] : ["f"]);
      const bad = await send(port, "/api/feed?time=1h", headers);
      assert.equal(bad.status, 400);
      assert.match(bad.json().error, /^time must be one of/);
      assert.equal((await send(port, "/api/search?limit=500", headers)).status, 400);
      const page = await send(port, "/feed?time=7d", headers);
      assert.equal(page.status, 200);
      assert.match(page.headers["content-type"], /^text\/html/);
      assert.match(page.body, /id="feed"/);
    });

    it(`keeps the request policy on ${name}: token, Host and Origin`, async () => {
      const { port } = await start();
      const host = `127.0.0.1:${port}`;
      const cookie = `ampi_gui_${port}=${TOKEN}`;
      for (const target of ["/api/feed", "/api/search?q=x", "/feed"]) {
        assert.equal((await send(port, target, { host })).status, 401, target);
        assert.equal((await send(port, target, { host: `evil.test:${port}`, cookie })).status, 403, target);
        assert.equal((await send(port, target, { host, cookie, origin: "http://evil.test" })).status, 403, target);
        assert.equal((await send(port, target, { host, cookie, origin: `http://localhost:${port}` })).status, 200, target);
      }
    });
  }
});

describe("Activity and Search Threads: client helpers", () => {
  const client = () => importSource("extensions/ampi-gui/client/activity.js");
  const searchClient = () => importSource("extensions/ampi-gui/client/thread-search.js");

  it("keeps the filters in the address without the defaults, and reads them back", async () => {
    const { feedPath, parseFeedSearch, FEED_DEFAULTS } = await client();
    const mine = { time: "7d", status: "all" };
    const filters = { time: "72h", status: "archived", project: "/work/a b", q: 'label:bug "two words"' };
    const url = feedPath(filters, mine);
    assert.equal(url, "/feed?time=72h&status=archived&project=%2Fwork%2Fa+b&q=label%3Abug+%22two+words%22");
    assert.deepEqual(parseFeedSearch(url.slice("/feed".length), mine), filters);
    assert.equal(feedPath({ time: "7d", status: "all", project: null, q: "" }, mine), "/feed");
    assert.deepEqual(parseFeedSearch("", mine), { time: "7d", status: "all", project: null, q: "" });
    assert.equal(feedPath({ ...FEED_DEFAULTS, project: "", q: "" }), "/feed?project=none");
    assert.deepEqual(parseFeedSearch("?project=none&time=1h&status=committed"), { time: "24h", status: "all", project: "", q: "" });
  });

  it("marks the chosen option and the default, and links each to its address", async () => {
    const { choiceOptionsHtml, FEED_TIMES } = await client();
    const html = choiceOptionsHtml("time", FEED_TIMES, { time: "72h", status: "all", project: null, q: "" }, { time: "7d", status: "all" });
    assert.match(html, /<a class="feed-option" href="\/feed\?time=72h" data-key="time" data-value="72h" aria-current="true">/);
    assert.match(html, /href="\/feed" data-key="time" data-value="7d" title="Default">/);
    assert.equal(html.match(/aria-current/g).length, 1);
  });

  it("escapes titles, project names and previews", async () => {
    const { feedRowHtml, projectOptionsHtml } = await client();
    const { searchResultHtml } = await searchClient();
    const evil = '<img src=x onerror="alert(1)">';
    const row = { id: 'x"y', title: evil, cwd: "/w", modified: new Date(NOW - 5 * 60_000).toISOString(), color: '"><b>', unread: true };
    const html = feedRowHtml(row, { href: '/s/x"y', project: "<b>p</b>", now: NOW });
    assert.doesNotMatch(html, /<img|<b>|onerror="/);
    assert.match(html, /&#60;img src=x onerror=&#34;alert\(1\)&#34;&#62;/);
    assert.match(html, />5m ago<\/time> · &#60;b&#62;p&#60;\/b&#62;/);
    assert.match(html, /data-id="x&#34;y"/);
    const projects = projectOptionsHtml([{ cwd: "/w/<i>", label: "<i>", count: 2 }], { time: "24h", status: "all", project: null, q: "" });
    assert.doesNotMatch(projects, /<i>/);
    assert.match(projects, /All<\/span><span class="feed-count">2</);
    const result = searchResultHtml({ ...row, project: "<p>", preview: "</span><script>x</script>", archived: true, snoozed: true, host: { kind: "tui" } }, { index: 0, selected: true, href: "/s/x", now: NOW });
    assert.doesNotMatch(result, /<script>|<img|<p>/);
    assert.match(result, /&#60;\/span&#62;&#60;script&#62;x&#60;\/script&#62;/);
    assert.match(result, /<span class="badge" data-badge="archived">Archived<\/span><span class="badge" data-badge="live">Live<\/span>/);
  });

  it("moves the search selection without wrapping", async () => {
    const { stepSelection } = await searchClient();
    assert.equal(stepSelection(0, -1, 3), 0);
    assert.equal(stepSelection(0, 1, 3), 1);
    assert.equal(stepSelection(2, 1, 3), 2);
    assert.equal(stepSelection(-1, 1, 0), -1);
  });
});
