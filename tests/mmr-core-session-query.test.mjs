// The session search language in ampi-core (session-query.ts), shared by
// find_session and `ampi threads search`: the parent:, pinned:, archived: and
// updated_before: keys, relative dates against a fixed clock, keys that need
// hosted data, and the thread-index matcher.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const MODULE = "extensions/ampi-core/session-query.ts";
const NOW = new Date("2026-10-18T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

describe("session query keys", () => {
  it("parses parent:, and pinned: and archived: with both values in any case", async () => {
    const { parseSessionQuery } = await importSource(MODULE);
    const yes = parseSessionQuery("parent:019a pinned:true archived:TRUE", NOW);
    assert.equal(yes.parent, "019a");
    assert.equal(yes.pinned, true);
    assert.equal(yes.archived, true);
    assert.deepEqual(yes.appliedFilterTokens, ["parent:019a", "pinned:true", "archived:TRUE"]);

    const no = parseSessionQuery("pinned:False archived:false", NOW);
    assert.equal(no.pinned, false);
    assert.equal(no.archived, false);
    assert.deepEqual(no.invalidFilters, []);

    const absent = parseSessionQuery("parser", NOW);
    assert.equal(absent.pinned, undefined);
    assert.equal(absent.archived, undefined);
  });

  it("records a boolean that is not true or false as invalid and does not apply it", async () => {
    const { parseSessionQuery } = await importSource(MODULE);
    const parsed = parseSessionQuery("pinned:yes archived:1", NOW);
    assert.equal(parsed.pinned, undefined);
    assert.equal(parsed.archived, undefined);
    assert.deepEqual(parsed.invalidFilters, ["pinned:yes", "archived:1"]);
    assert.deepEqual(parsed.appliedFilterTokens, []);
  });

  it("takes updated_before: as before:, an upper bound on the last update", async () => {
    const { parseSessionQuery } = await importSource(MODULE);
    const alias = parseSessionQuery("updated_before:2026-10-01", NOW);
    const before = parseSessionQuery("before:2026-10-01", NOW);
    assert.equal(alias.modifiedBefore.toISOString(), "2026-10-01T00:00:00.000Z");
    assert.equal(alias.before.toISOString(), before.before.toISOString());
    assert.equal(alias.createdBefore, undefined);
    assert.deepEqual(alias.appliedFilterTokens, ["updated_before:2026-10-01"]);
  });

  it("counts relative dates back from now, so a time on each side of the bound falls on that side", async () => {
    const { parseSessionQuery } = await importSource(MODULE);
    const bound = (text) => parseSessionQuery(text, NOW).modifiedAfter.getTime();
    assert.equal(bound("after:7d"), NOW.getTime() - 7 * DAY);
    assert.equal(bound("after:2w"), NOW.getTime() - 14 * DAY);
    assert.equal(bound("after:week"), NOW.getTime() - 7 * DAY);
    assert.equal(bound("after:month"), NOW.getTime() - 30 * DAY);
    // today and yesterday start at midnight UTC, not 24 hours back.
    assert.equal(new Date(bound("after:today")).toISOString(), "2026-10-18T00:00:00.000Z");
    assert.equal(new Date(bound("after:yesterday")).toISOString(), "2026-10-17T00:00:00.000Z");
    const sevenDays = bound("after:7d");
    const justInside = new Date("2026-10-11T10:00:01.000Z").getTime();
    const justOutside = new Date("2026-10-11T09:59:59.000Z").getTime();
    assert.ok(justInside >= sevenDays && justOutside < sevenDays);
    assert.deepEqual(parseSessionQuery("after:soon", NOW).invalidFilters, ["after:soon"]);
  });

  it("lists commit:, pr: and author: as needing hosted data, apart from unknown keys", async () => {
    const { parseSessionQuery } = await importSource(MODULE);
    const parsed = parseSessionQuery("commit:abc123 pr:42 Author:me visibility:private", NOW);
    assert.deepEqual(parsed.hostedFilters, ["commit:abc123", "pr:42", "author:me"]);
    // find_session reports both kinds as unsupported.
    assert.deepEqual(parsed.unsupportedFilters, ["commit:abc123", "pr:42", "author:me", "visibility:private"]);
    assert.deepEqual(parsed.terms, []);
  });

  it("keeps the names ampi-history exports", async () => {
    const core = await importSource(MODULE);
    const history = await importSource("extensions/ampi-history/query.ts");
    assert.equal(history.parseSessionQuery("pinned:true", NOW).pinned, true);
    for (const name of ["parseSessionQuery", "tokenizeSessionQuery", "includesCaseInsensitive"]) {
      assert.equal(typeof history[name], "function", name);
      assert.equal(typeof core[name], "function", name);
    }
  });
});

describe("thread index matcher", () => {
  const ARCHIVED = "2026-10-17T00:00:00.000Z";

  it("matches archived: and pinned: against the record, a missing record being neither", async () => {
    const { matchesMmrThreadIndexFilters: matches, parseSessionQuery } = await importSource(MODULE);
    const q = (text) => parseSessionQuery(text, NOW);
    const archived = { archived: ARCHIVED };
    const pinned = { pinned: true };
    const unpinned = { pinned: false };

    assert.equal(matches(q("archived:true"), archived), true);
    assert.equal(matches(q("archived:true"), undefined), false);
    assert.equal(matches(q("archived:false"), archived), false);
    assert.equal(matches(q("archived:false"), undefined), true);
    assert.equal(matches(q("pinned:true"), pinned), true);
    assert.equal(matches(q("pinned:true"), unpinned), false);
    assert.equal(matches(q("pinned:false"), unpinned), true);
    assert.equal(matches(q("pinned:false"), undefined), true);
    assert.equal(matches(q("pinned:false"), pinned), false);
    // Without the keys, every record passes.
    assert.equal(matches(q("parser"), archived), true);
  });

  it("needs every label: value in one of the labels, ignoring case", async () => {
    const { matchesMmrThreadIndexFilters: matches, parseSessionQuery } = await importSource(MODULE);
    const record = { labels: ["Release-Notes", "docs"] };
    assert.equal(matches(parseSessionQuery("label:docs", NOW), record), true);
    assert.equal(matches(parseSessionQuery("label:release", NOW), record), true);
    assert.equal(matches(parseSessionQuery("label:docs label:bug", NOW), record), false);
    assert.equal(matches(parseSessionQuery("label:docs", NOW), undefined), false);
  });
});
