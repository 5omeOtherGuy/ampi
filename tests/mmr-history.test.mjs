import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

function sessionInfo(overrides = {}) {
  return {
    path: `/tmp/session-${overrides.id ?? "S-1"}.jsonl`,
    id: overrides.id ?? "S-1",
    cwd: overrides.cwd ?? "/repo",
    name: overrides.name,
    parentSessionPath: undefined,
    created: overrides.created ?? new Date("2026-05-20T00:00:00Z"),
    modified: overrides.modified ?? new Date("2026-05-21T00:00:00Z"),
    messageCount: overrides.messageCount ?? 2,
    firstMessage: overrides.firstMessage ?? "Implement history search",
    allMessagesText: overrides.allMessagesText ?? "We discussed session search and lexical excerpts.",
  };
}

after(cleanupLoadedSource);

describe("mmr-history query parsing and catalog search", () => {
  it("parses supported filters including file:, and reports unknown keys as unsupported", async () => {
    const { parseSessionQuery } = await importSource("extensions/mmr-history/query.ts");
    const parsed = parseSessionQuery('"history search" name:planning after:7d file:src/Index.ts ref:main author:me', new Date("2026-05-24T00:00:00Z"));

    assert.deepEqual(parsed.terms, ["history search"]);
    assert.equal(parsed.name, "planning");
    assert.equal(parsed.after.toISOString(), "2026-05-17T00:00:00.000Z");
    assert.deepEqual(parsed.file, ["src/index.ts"]);
    assert.deepEqual(parsed.fileTokens, ["file:src/Index.ts"]);
    assert.deepEqual(parsed.unsupportedFilters, ["ref:main", "author:me"]);
    assert.ok(parsed.appliedFilterTokens.includes("name:planning"));
    assert.ok(parsed.appliedFilterTokens.includes("after:7d"));
  });

  it("returns global Pi sessions newest-first with projectRef and never raw cwd/path", async () => {
    const { searchSessions } = await importSource("extensions/mmr-history/session-catalog.ts");
    const sessions = [
      sessionInfo({ id: "S-old", cwd: "/repo/a", name: "Old", modified: new Date("2026-05-20T00:00:00Z"), allMessagesText: "history search" }),
      sessionInfo({ id: "S-new", cwd: "/repo/b", name: "New", modified: new Date("2026-05-22T00:00:00Z"), allMessagesText: "history search with read_session" }),
      sessionInfo({ id: "S-miss", cwd: "/repo/a", name: "Other", modified: new Date("2026-05-23T00:00:00Z"), firstMessage: "Unrelated work", allMessagesText: "unrelated" }),
    ];

    const matches = await searchSessions({ listSessions: async () => sessions }, "history search", { limit: 10 });

    assert.deepEqual(matches.map((match) => match.sessionId), ["S-new", "S-old"]);
    for (const match of matches) {
      assert.equal(Object.hasOwn(match, "path"), false);
      assert.equal(Object.hasOwn(match, "cwd"), false);
      assert.match(match.projectRef, /^[0-9a-f]{8}$/);
    }
    // Different project cwds must yield different projectRefs.
    assert.notEqual(matches[0].projectRef, matches[1].projectRef);
    assert.deepEqual(matches[0].matchedTerms, ["history", "search"]);
  });

  it("reports queryDiagnostics for applied and unsupported filters", async () => {
    const { searchSessionsWithDiagnostics } = await importSource("extensions/mmr-history/session-catalog.ts");
    const sessions = [sessionInfo({ id: "S-1", allMessagesText: "history search" })];

    const { matches, queryDiagnostics } = await searchSessionsWithDiagnostics(
      { listSessions: async () => sessions },
      "history ref:main author:me task:42",
      { limit: 10 },
    );

    assert.equal(matches.length, 1);
    const filters = queryDiagnostics.map((d) => `${d.status}:${d.filter}`);
    assert.ok(filters.includes("applied:keyword:history"));
    assert.ok(filters.includes("unsupported:ref:main"));
    assert.ok(filters.includes("unsupported:author:me"));
    assert.ok(filters.includes("unsupported:task:42"));
  });

  it("dedupes by session id keeping the newest mtime", async () => {
    const { searchSessions } = await importSource("extensions/mmr-history/session-catalog.ts");
    const sessions = [
      sessionInfo({ id: "S-dup", cwd: "/repo/a", modified: new Date("2026-05-20T00:00:00Z"), allMessagesText: "history search" }),
      sessionInfo({ id: "S-dup", cwd: "/repo/a-renamed", modified: new Date("2026-05-22T00:00:00Z"), allMessagesText: "history search again" }),
    ];

    const matches = await searchSessions({ listSessions: async () => sessions }, "history", { limit: 10 });

    assert.equal(matches.length, 1);
    assert.equal(matches[0].sessionId, "S-dup");
    assert.equal(matches[0].modifiedAt, new Date("2026-05-22T00:00:00Z").toISOString());
  });

  it("dedupes by session id with a deterministic tie-break (modified, created, path, id)", async () => {
    const { searchSessions } = await importSource("extensions/mmr-history/session-catalog.ts");
    // Same id, same modified, different created/path. Newest `created`
    // must win; if created also tied, lower `path` then lower `id`.
    const sameModified = new Date("2026-05-22T00:00:00Z");
    const winner = sessionInfo({
      id: "S-dup",
      cwd: "/repo/a",
      modified: sameModified,
      created: new Date("2026-05-21T00:00:00Z"),
      allMessagesText: "history search winner",
    });
    winner.path = "/tmp/session-S-dup-b.jsonl";
    const loserA = sessionInfo({
      id: "S-dup",
      cwd: "/repo/a",
      modified: sameModified,
      created: new Date("2026-05-20T00:00:00Z"),
      allMessagesText: "history search loser-a",
    });
    loserA.path = "/tmp/session-S-dup-a.jsonl";
    const loserB = sessionInfo({
      id: "S-dup",
      cwd: "/repo/a",
      modified: sameModified,
      created: new Date("2026-05-19T00:00:00Z"),
      allMessagesText: "history search loser-b",
    });
    loserB.path = "/tmp/session-S-dup-c.jsonl";

    const orderings = [
      [winner, loserA, loserB],
      [loserB, loserA, winner],
      [loserA, winner, loserB],
      [loserB, winner, loserA],
    ];

    const results = [];
    for (const ordering of orderings) {
      const matches = await searchSessions(
        { listSessions: async () => ordering },
        "history",
        { limit: 10 },
      );
      assert.equal(matches.length, 1, "dedup must collapse to one entry");
      results.push(matches[0]);
    }

    // Every ordering must pick the same record (newest `created`),
    // which also pins the deterministic preview to the winner's text.
    for (const match of results) {
      assert.equal(match.sessionId, "S-dup");
      assert.equal(match.createdAt, winner.created.toISOString());
      assert.equal(match.modifiedAt, sameModified.toISOString());
      assert.equal(match.preview, results[0].preview, "preview must be identical across reordered inputs");
    }
  });

  it("queryDiagnostics filter strings redact sensitive substrings (file:/home/<user>/...)", async () => {
    const { searchSessionsWithDiagnostics } = await importSource("extensions/mmr-history/session-catalog.ts");
    const sessions = {
      "S-1": { info: sessionInfo({ id: "S-1", allMessagesText: "history" }), files: new Set(["x.ts"]) },
    };
    const index = {
      async list() { return [sessions["S-1"].info]; },
      async getTouchedFiles() { return sessions["S-1"].files; },
    };

    const { queryDiagnostics } = await searchSessionsWithDiagnostics(
      { listSessions: async () => [sessions["S-1"].info], openSession: () => { throw new Error("unused"); } },
      "history file:/home/alice/x.ts",
      { limit: 10, index },
    );

    const fileEntry = queryDiagnostics.find((d) => d.filter.startsWith("file:"));
    assert.ok(fileEntry, "file: filter must produce a diagnostic");
    assert.ok(!fileEntry.filter.includes("alice"), `diagnostic must redact /home/<user>: ${fileEntry.filter}`);
    assert.ok(fileEntry.filter.includes("[home]"), `diagnostic must carry redaction marker: ${fileEntry.filter}`);
  });

  it("buildMatch.matchedTerms redacts query tokens that carry sensitive substrings", async () => {
    const { searchSessions } = await importSource("extensions/mmr-history/session-catalog.ts");
    const sessions = [
      sessionInfo({
        id: "S-match",
        // The lexical matcher pulls terms out of the query and tests
        // them against this text. The raw term value is what would
        // otherwise echo back to the caller in `matchedTerms`.
        allMessagesText: "discussion about /home/alice/secret.ts",
      }),
    ];

    const matches = await searchSessions({ listSessions: async () => sessions }, "/home/alice/secret.ts", { limit: 10 });
    assert.equal(matches.length, 1);
    const term = matches[0].matchedTerms[0];
    assert.ok(typeof term === "string");
    assert.ok(!term.includes("alice"), `matchedTerms must redact /home/<user>: ${term}`);
    assert.ok(term.includes("[home]"), `matchedTerms must carry redaction marker: ${term}`);
  });

  it("find_session details.query is the redacted form, not the raw user query", async () => {
    const { createFindSessionTool } = await importSource("extensions/mmr-history/tools.ts");
    const sessions = [sessionInfo({ id: "S-1", allMessagesText: "alice" })];
    const deps = {
      getSettings: () => ({ enabled: true, maxResults: 10, maxExcerptBytes: 10_000 }),
      listSessions: async () => sessions,
      openSession: () => { throw new Error("unused"); },
    };
    const tool = createFindSessionTool(deps);

    const result = await tool.execute("call", { query: "open /home/alice/secret.ts" }, undefined, undefined, { cwd: "/repo" });

    assert.ok(typeof result.details.query === "string");
    assert.ok(!result.details.query.includes("/home/alice"), `details.query must redact /home/<user>: ${result.details.query}`);
    assert.ok(result.details.query.includes("[home]"), `details.query must include redaction marker: ${result.details.query}`);
  });

  it("redacts sensitive content in name / firstMessage / preview", async () => {
    const { searchSessions } = await importSource("extensions/mmr-history/session-catalog.ts");
    const sessions = [
      sessionInfo({
        id: "S-secret",
        name: "Inspect /home/alice/projects/foo plan",
        firstMessage: "TOKEN=hunter2 in env; please read /home/alice/secret.ts",
        allMessagesText: "history search TOKEN=hunter2 with /home/alice paths",
      }),
    ];

    const [match] = await searchSessions({ listSessions: async () => sessions }, "history", { limit: 10 });

    assert.ok(!match.name.includes("alice"), `name must be redacted: ${match.name}`);
    assert.ok(!match.firstMessage.includes("alice"), `firstMessage must be redacted: ${match.firstMessage}`);
    assert.ok(!match.firstMessage.includes("hunter2"), `firstMessage must be redacted: ${match.firstMessage}`);
    assert.ok(!match.preview.includes("hunter2"), `preview must be redacted: ${match.preview}`);
  });

  it("find_session.execute returns cross-project matches with deterministic redaction in both markdown and details", async () => {
    const { createFindSessionTool } = await importSource("extensions/mmr-history/tools.ts");
    // Two sessions belonging to two different project cwds. The
    // catalog enumerates every local Pi session regardless of the
    // active workspace, so both must surface. Each fixture seeds
    // name / firstMessage / allMessagesText with sensitive content
    // (home paths and a provider token) that the deterministic
    // redaction contract must scrub before the result shape leaves
    // the tool. The query word "secret" is matched against the raw
    // text; the result strings are then redacted.
    const sessions = [
      sessionInfo({
        id: "S-a",
        cwd: "/home/alice/projects/proj-a",
        name: "Inspect /home/alice/secret.txt",
        firstMessage: "Found token sk-ant-1234567890abcdef1234 in /home/alice/proj-a",
        allMessagesText: "We discussed secret data in /home/alice/proj-a; token sk-ant-1234567890abcdef1234.",
        modified: new Date("2026-05-22T00:00:00Z"),
      }),
      sessionInfo({
        id: "S-b",
        cwd: "/home/bob/work/proj-b",
        name: "Review /home/bob/secret.txt notes",
        firstMessage: "Found token sk-ant-1234567890abcdef1234 in /home/bob/work",
        allMessagesText: "We discussed secret data in /home/bob/work; token sk-ant-1234567890abcdef1234.",
        modified: new Date("2026-05-21T00:00:00Z"),
      }),
    ];
    const deps = {
      getSettings: () => ({ enabled: true, maxResults: 50, maxExcerptBytes: 4_000 }),
      listSessions: async () => sessions,
      // find_session does not open sessions for keyword-only queries,
      // but the deps shape still requires an openSession entry. Return
      // a minimal stub manager with no entries so any accidental call
      // is observable rather than crashing.
      openSession: () => ({ getEntries: () => [], buildSessionContext: () => ({ messages: [] }) }),
      gitIdentity: { async resolve() { return undefined; } },
    };
    const tool = createFindSessionTool(deps);

    const result = await tool.execute("tcid", { query: "secret" }, undefined, undefined, { cwd: "/anywhere" });

    // Both project cwds reach the result list (cross-project visibility).
    const ids = result.details.matches.map((m) => m.sessionId).sort();
    assert.deepEqual(ids, ["S-a", "S-b"]);

    // Each match exposes an opaque projectRef and the two cwds hash
    // to distinct refs.
    for (const match of result.details.matches) {
      assert.match(match.projectRef, /^[0-9a-f]{8}$/, `projectRef must be an 8-char hex hash: ${match.projectRef}`);
    }
    assert.notEqual(
      result.details.matches[0].projectRef,
      result.details.matches[1].projectRef,
      "distinct project cwds must hash to distinct projectRefs",
    );

    const markdown = result.content[0].text;
    const detailsJson = JSON.stringify(result.details);

    // No raw usernames, raw tokens, or raw `/home/` prefixes may leak
    // through either surface. `secret.txt` is intentionally not in
    // this list: the redaction contract preserves project-relative
    // path tails (`/home/<user>` collapses to `[home]`, the rest is
    // kept verbatim) and that behavior is covered elsewhere.
    for (const forbidden of ["alice", "bob", "sk-ant-1234567890abcdef1234", "/home/"]) {
      assert.ok(
        !markdown.includes(forbidden),
        `markdown must not contain raw '${forbidden}': ${markdown}`,
      );
      assert.ok(
        !detailsJson.includes(forbidden),
        `JSON.stringify(details) must not contain raw '${forbidden}'`,
      );
    }

    // The markdown lists each match's opaque projectRef.
    for (const match of result.details.matches) {
      assert.ok(
        markdown.includes(match.projectRef),
        `markdown must list projectRef ${match.projectRef} for session ${match.sessionId}`,
      );
    }

    // Every match's `name`, `firstMessage`, and `preview` carries the
    // deterministic redaction markers for the substrings that were
    // sensitive in the source fixture.
    for (const match of result.details.matches) {
      assert.ok(typeof match.name === "string");
      assert.ok(match.name.includes("[home]"), `match.name must carry [home] marker: ${match.name}`);
      assert.ok(match.firstMessage.includes("[token]"), `match.firstMessage must carry [token] marker: ${match.firstMessage}`);
      assert.ok(match.firstMessage.includes("[home]"), `match.firstMessage must carry [home] marker: ${match.firstMessage}`);
      assert.ok(match.preview.includes("[token]"), `match.preview must carry [token] marker: ${match.preview}`);
      assert.ok(match.preview.includes("[home]"), `match.preview must carry [home] marker: ${match.preview}`);
    }
  });
});

describe("mmr-history file: filter", () => {
  function makeIndex({ touched }) {
    return {
      async list() { return Object.values(touched).map((entry) => entry.info); },
      async getTouchedFiles(info) { return touched[info.id]?.files ?? new Set(); },
    };
  }

  it("matches sessions whose structured tool calls touched the requested path", async () => {
    const { searchSessionsWithDiagnostics } = await importSource("extensions/mmr-history/session-catalog.ts");
    const sessions = {
      "S-hit": { info: sessionInfo({ id: "S-hit", allMessagesText: "work on auth" }), files: new Set(["src/auth.ts", "src/util.ts"]) },
      "S-miss": { info: sessionInfo({ id: "S-miss", allMessagesText: "work on auth" }), files: new Set(["src/other.ts"]) },
    };
    const index = makeIndex({ touched: sessions });

    const { matches, queryDiagnostics } = await searchSessionsWithDiagnostics(
      { listSessions: async () => Object.values(sessions).map((s) => s.info), openSession: () => { throw new Error("unused"); } },
      "auth file:auth.ts",
      { limit: 10, index },
    );

    assert.deepEqual(matches.map((m) => m.sessionId), ["S-hit"]);
    assert.ok(queryDiagnostics.some((d) => d.filter === "file:auth.ts" && d.status === "applied"));
  });

  it("case-insensitive partial path match", async () => {
    const { searchSessionsWithDiagnostics } = await importSource("extensions/mmr-history/session-catalog.ts");
    const sessions = {
      "S-1": { info: sessionInfo({ id: "S-1", allMessagesText: "x" }), files: new Set(["src/auth.ts"]) },
    };
    const index = makeIndex({ touched: sessions });

    const { matches } = await searchSessionsWithDiagnostics(
      { listSessions: async () => Object.values(sessions).map((s) => s.info), openSession: () => { throw new Error("unused"); } },
      "file:AUTH",
      { limit: 10, index },
    );

    assert.deepEqual(matches.map((m) => m.sessionId), ["S-1"]);
  });

  it("requires ALL file: tokens to match (implicit AND)", async () => {
    const { searchSessionsWithDiagnostics } = await importSource("extensions/mmr-history/session-catalog.ts");
    const sessions = {
      "S-both": { info: sessionInfo({ id: "S-both", allMessagesText: "x" }), files: new Set(["src/auth.ts", "src/util.ts"]) },
      "S-one": { info: sessionInfo({ id: "S-one", allMessagesText: "x" }), files: new Set(["src/auth.ts"]) },
    };
    const index = makeIndex({ touched: sessions });

    const { matches } = await searchSessionsWithDiagnostics(
      { listSessions: async () => Object.values(sessions).map((s) => s.info), openSession: () => { throw new Error("unused"); } },
      "file:auth file:util",
      { limit: 10, index },
    );

    assert.deepEqual(matches.map((m) => m.sessionId), ["S-both"]);
  });

  it("matches the same relative path against two different project cwds with distinct projectRefs", async () => {
    const { searchSessionsWithDiagnostics } = await importSource("extensions/mmr-history/session-catalog.ts");
    const sessions = {
      "S-a": { info: sessionInfo({ id: "S-a", cwd: "/repo/a", allMessagesText: "auth" }), files: new Set(["src/auth.ts"]) },
      "S-b": { info: sessionInfo({ id: "S-b", cwd: "/repo/b", allMessagesText: "auth", modified: new Date("2026-05-19T00:00:00Z") }), files: new Set(["src/auth.ts"]) },
    };
    const index = makeIndex({ touched: sessions });

    const { matches } = await searchSessionsWithDiagnostics(
      { listSessions: async () => Object.values(sessions).map((s) => s.info), openSession: () => { throw new Error("unused"); } },
      "file:auth.ts",
      { limit: 10, index },
    );

    const refs = new Set(matches.map((m) => m.projectRef));
    assert.equal(matches.length, 2);
    assert.equal(refs.size, 2, "each project cwd must produce a distinct projectRef");
  });

  it("derives touched files from structured tool calls only, not bash output", async () => {
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const { createSessionIndex } = await importSource("extensions/mmr-history/session-index.ts");

    const structured = SessionManager.inMemory("/repo");
    structured.appendMessage({ role: "user", content: "please edit src/auth.ts" });
    structured.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "editing" },
        { type: "toolCall", id: "t1", name: "edit", arguments: { path: "src/auth.ts", edits: [] } },
        { type: "toolCall", id: "t2", name: "read", arguments: { path: "/repo/src/util.ts" } },
        { type: "toolCall", id: "t3", name: "write", arguments: { file_path: "./src/new.ts", content: "" } },
        { type: "toolCall", id: "t4", name: "apply_patch", arguments: { patchText: "*** Update File: src/patched.ts\n@@" } },
        { type: "toolCall", id: "t5", name: "bash", arguments: { command: "cat src/should-not-count.ts" } },
        { type: "toolCall", id: "t6", name: "grep", arguments: { pattern: "x", path: "src/grep-dir" } },
      ],
      api: "anthropic", provider: "anthropic", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0,
    });

    const info = sessionInfo({ id: structured.getSessionId(), messageCount: 2, modified: new Date("2026-05-22T00:00:00Z") });
    info.path = "/in-memory";
    info.cwd = "/repo";

    const index = createSessionIndex({
      listSessions: async () => [info],
      openSession: () => structured,
    });

    const touched = await index.getTouchedFiles(info);
    const arr = Array.from(touched).sort();
    assert.deepEqual(arr, ["src/auth.ts", "src/new.ts", "src/patched.ts", "src/util.ts"]);
    assert.ok(!touched.has("src/should-not-count.ts"));
    assert.ok(!touched.has("src/grep-dir"));
  });

  it("absolute paths outside session cwd are dropped", async () => {
    const { normalizeTouchedPath } = await importSource("extensions/mmr-history/session-index.ts");
    assert.equal(normalizeTouchedPath("/repo/src/auth.ts", "/repo"), "src/auth.ts");
    assert.equal(normalizeTouchedPath("/other/src/auth.ts", "/repo"), undefined);
    assert.equal(normalizeTouchedPath("./src/auth.ts", "/repo"), "src/auth.ts");
    assert.equal(normalizeTouchedPath("src/Auth.TS", "/repo"), "src/auth.ts");
    assert.equal(normalizeTouchedPath("", "/repo"), undefined);
    assert.equal(normalizeTouchedPath(undefined, "/repo"), undefined);
  });

  it("file: with no index available returns empty matches + non_applicable diagnostic, never a lexical fallthrough", async () => {
    const { searchSessionsWithDiagnostics } = await importSource("extensions/mmr-history/session-catalog.ts");
    const sessions = [sessionInfo({ id: "S-1", allMessagesText: "auth" })];

    const { matches, queryDiagnostics } = await searchSessionsWithDiagnostics(
      { listSessions: async () => sessions },
      "auth file:auth.ts",
      { limit: 10 },
    );

    assert.equal(matches.length, 0);
    const entry = queryDiagnostics.find((d) => d.filter === "file:auth.ts");
    assert.equal(entry?.status, "non_applicable");
    assert.ok(entry?.reason);
  });

  it("file: against sessions with no structured tool-call evidence promotes to non_applicable", async () => {
    const { searchSessionsWithDiagnostics } = await importSource("extensions/mmr-history/session-catalog.ts");
    const empty = { info: sessionInfo({ id: "S-empty", allMessagesText: "auth work" }), files: new Set() };
    const index = {
      async list() { return [empty.info]; },
      async getTouchedFiles() { return empty.files; },
    };

    const { matches, queryDiagnostics } = await searchSessionsWithDiagnostics(
      { listSessions: async () => [empty.info], openSession: () => { throw new Error("unused"); } },
      "auth file:auth.ts",
      { limit: 10, index },
    );

    assert.equal(matches.length, 0);
    const entry = queryDiagnostics.find((d) => d.filter === "file:auth.ts");
    assert.equal(entry?.status, "non_applicable");
  });
});

describe("mmr-history git-identity canonicalization", () => {
  it("strips credentials from URL remotes and produces alias set", async () => {
    const { repoIdentityFromUrl } = await importSource("extensions/mmr-history/git-identity.ts");
    const id = repoIdentityFromUrl("https://user:token@github.com/Owner/Repo.git");

    assert.ok(id);
    assert.ok(id.aliases.has("github.com/owner/repo"));
    assert.ok(id.aliases.has("owner/repo"));
    assert.ok(id.aliases.has("https://github.com/owner/repo"));
    assert.ok(id.aliases.has("https://github.com/owner/repo.git"));
    // No alias retains the credentials.
    for (const alias of id.aliases) {
      assert.ok(!alias.includes("token"), `alias must not retain credentials: ${alias}`);
      assert.ok(!alias.includes("user:"), `alias must not retain credentials: ${alias}`);
    }
    assert.ok(!id.display.includes("token"));
    assert.ok(!id.display.includes("user:"));
  });

  it("parses SCP-style remotes (git@host:path)", async () => {
    const { repoIdentityFromUrl } = await importSource("extensions/mmr-history/git-identity.ts");
    const id = repoIdentityFromUrl("git@github.com:owner/repo.git");

    assert.ok(id);
    assert.ok(id.aliases.has("github.com/owner/repo"));
    assert.ok(id.aliases.has("owner/repo"));
  });

  it("parses https remotes without .git", async () => {
    const { repoIdentityFromUrl } = await importSource("extensions/mmr-history/git-identity.ts");
    const id = repoIdentityFromUrl("https://github.com/owner/repo");

    assert.ok(id);
    assert.ok(id.aliases.has("github.com/owner/repo"));
    assert.ok(id.aliases.has("owner/repo"));
  });

  it("returns undefined for empty, local-path, or malformed inputs", async () => {
    const { repoIdentityFromUrl } = await importSource("extensions/mmr-history/git-identity.ts");
    assert.equal(repoIdentityFromUrl(""), undefined);
    assert.equal(repoIdentityFromUrl("   "), undefined);
    assert.equal(repoIdentityFromUrl("/local/repo/path"), undefined);
    assert.equal(repoIdentityFromUrl("not a url"), undefined);
  });

  it("matchesRepoToken is case-insensitive and exact across aliases", async () => {
    const { repoIdentityFromUrl, matchesRepoToken } = await importSource("extensions/mmr-history/git-identity.ts");
    const id = repoIdentityFromUrl("git@github.com:Owner/Repo.git");
    assert.ok(matchesRepoToken(id, "Owner/Repo"));
    assert.ok(matchesRepoToken(id, "github.com/owner/repo"));
    assert.ok(!matchesRepoToken(id, "repo"));
    assert.ok(!matchesRepoToken(id, "different/repo"));
  });

  it("extractRemoteUrlFromGitConfig prefers origin and ignores other sections", async () => {
    const { extractRemoteUrlFromGitConfig } = await importSource("extensions/mmr-history/git-identity.ts");
    const config = [
      "[core]",
      "\trepositoryformatversion = 0",
      "[remote \"upstream\"]",
      "\turl = https://github.com/upstream/repo.git",
      "[remote \"origin\"]",
      "\turl = git@github.com:owner/repo.git",
      "\tfetch = +refs/heads/*:refs/remotes/origin/*",
    ].join("\n");
    assert.equal(extractRemoteUrlFromGitConfig(config), "git@github.com:owner/repo.git");
  });
});

describe("mmr-history repo: filter (per-session)", () => {
  function makeResolver(map) {
    return {
      async resolve(cwd) {
        const url = map[cwd];
        if (!url) return undefined;
        const { repoIdentityFromUrl } = await importSource("extensions/mmr-history/git-identity.ts");
        return repoIdentityFromUrl(url);
      },
    };
  }

  it("matches sessions whose own project cwd canonicalizes to the queried alias", async () => {
    const { searchSessionsWithDiagnostics } = await importSource("extensions/mmr-history/session-catalog.ts");
    const sessions = [sessionInfo({ id: "S-1", cwd: "/repo/owner-repo" })];
    const resolver = makeResolver({ "/repo/owner-repo": "git@github.com:owner/repo.git" });

    const { matches, queryDiagnostics } = await searchSessionsWithDiagnostics(
      { listSessions: async () => sessions, gitIdentity: resolver },
      "repo:owner/repo",
      { limit: 10 },
    );

    assert.deepEqual(matches.map((m) => m.sessionId), ["S-1"]);
    const entry = queryDiagnostics.find((d) => d.filter === "repo:owner/repo");
    assert.equal(entry?.status, "applied");
  });

  it("only returns the session whose own cwd matches when two projects are enumerated", async () => {
    const { searchSessionsWithDiagnostics } = await importSource("extensions/mmr-history/session-catalog.ts");
    const sessions = [
      sessionInfo({ id: "S-a", cwd: "/repo/a", modified: new Date("2026-05-22T00:00:00Z") }),
      sessionInfo({ id: "S-b", cwd: "/repo/b", modified: new Date("2026-05-21T00:00:00Z") }),
    ];
    const resolver = makeResolver({
      "/repo/a": "git@github.com:owner/project-a.git",
      "/repo/b": "git@github.com:owner/project-b.git",
    });

    const { matches } = await searchSessionsWithDiagnostics(
      { listSessions: async () => sessions, gitIdentity: resolver },
      "repo:owner/project-a",
      { limit: 10 },
    );

    assert.deepEqual(matches.map((m) => m.sessionId), ["S-a"]);
  });

  it("matches the host/owner/repo alias too", async () => {
    const { searchSessionsWithDiagnostics } = await importSource("extensions/mmr-history/session-catalog.ts");
    const sessions = [sessionInfo({ id: "S-1", cwd: "/repo" })];
    const resolver = makeResolver({ "/repo": "https://github.com/owner/repo.git" });

    const { matches } = await searchSessionsWithDiagnostics(
      { listSessions: async () => sessions, gitIdentity: resolver },
      "repo:github.com/owner/repo",
      { limit: 10 },
    );

    assert.deepEqual(matches.map((m) => m.sessionId), ["S-1"]);
  });

  it("matches the credential-stripped URL alias even when query is credentialed", async () => {
    const { searchSessionsWithDiagnostics } = await importSource("extensions/mmr-history/session-catalog.ts");
    const sessions = [sessionInfo({ id: "S-1", cwd: "/repo" })];
    const resolver = makeResolver({ "/repo": "https://user:token@github.com/owner/repo.git" });

    const { matches, queryDiagnostics } = await searchSessionsWithDiagnostics(
      { listSessions: async () => sessions, gitIdentity: resolver },
      "repo:https://github.com/owner/repo.git",
      { limit: 10 },
    );

    assert.deepEqual(matches.map((m) => m.sessionId), ["S-1"]);
    for (const d of queryDiagnostics) {
      assert.ok(!d.filter.includes("token"), `diagnostic must not retain credentials: ${d.filter}`);
    }
  });

  it("non-matching repo: returns zero matches with the filter still applied", async () => {
    const { searchSessionsWithDiagnostics } = await importSource("extensions/mmr-history/session-catalog.ts");
    const sessions = [sessionInfo({ id: "S-1", cwd: "/repo" })];
    const resolver = makeResolver({ "/repo": "git@github.com:owner/repo.git" });

    const { matches, queryDiagnostics } = await searchSessionsWithDiagnostics(
      { listSessions: async () => sessions, gitIdentity: resolver },
      "repo:other/project",
      { limit: 10 },
    );

    assert.equal(matches.length, 0);
    const entry = queryDiagnostics.find((d) => d.filter === "repo:other/project");
    assert.equal(entry?.status, "applied");
  });

  it("repo: with NO candidate carrying a resolvable remote promotes to non_applicable", async () => {
    const { searchSessionsWithDiagnostics } = await importSource("extensions/mmr-history/session-catalog.ts");
    const sessions = [sessionInfo({ id: "S-1", cwd: "/repo", allMessagesText: "history search" })];
    const resolver = makeResolver({}); // no remote for any cwd

    const { matches, queryDiagnostics } = await searchSessionsWithDiagnostics(
      { listSessions: async () => sessions, gitIdentity: resolver },
      "history repo:owner/repo",
      { limit: 10 },
    );

    assert.equal(matches.length, 0);
    const entry = queryDiagnostics.find((d) => d.filter === "repo:owner/repo");
    assert.equal(entry?.status, "non_applicable");
    assert.match(entry?.reason ?? "", /no candidate/i);
  });

  it("session with no remote does not match repo: but does not flip the diagnostic when another candidate resolves", async () => {
    const { searchSessionsWithDiagnostics } = await importSource("extensions/mmr-history/session-catalog.ts");
    const sessions = [
      sessionInfo({ id: "S-noremote", cwd: "/repo/no-remote", modified: new Date("2026-05-22T00:00:00Z") }),
      sessionInfo({ id: "S-match", cwd: "/repo/owner-repo", modified: new Date("2026-05-21T00:00:00Z") }),
    ];
    const resolver = makeResolver({ "/repo/owner-repo": "git@github.com:owner/repo.git" });

    const { matches, queryDiagnostics } = await searchSessionsWithDiagnostics(
      { listSessions: async () => sessions, gitIdentity: resolver },
      "repo:owner/repo",
      { limit: 10 },
    );

    assert.deepEqual(matches.map((m) => m.sessionId), ["S-match"]);
    const entry = queryDiagnostics.find((d) => d.filter === "repo:owner/repo");
    assert.equal(entry?.status, "applied");
  });

  it("multiple repo: tokens combine with implicit AND", async () => {
    const { searchSessionsWithDiagnostics } = await importSource("extensions/mmr-history/session-catalog.ts");
    const sessions = [sessionInfo({ id: "S-1", cwd: "/repo" })];
    const resolver = makeResolver({ "/repo": "git@github.com:owner/repo.git" });

    const matchBoth = await searchSessionsWithDiagnostics(
      { listSessions: async () => sessions, gitIdentity: resolver },
      "repo:owner/repo repo:github.com/owner/repo",
      { limit: 10 },
    );
    assert.equal(matchBoth.matches.length, 1);

    const matchOneMiss = await searchSessionsWithDiagnostics(
      { listSessions: async () => sessions, gitIdentity: resolver },
      "repo:owner/repo repo:other/project",
      { limit: 10 },
    );
    assert.equal(matchOneMiss.matches.length, 0);
  });
});

describe("mmr-history read_session", () => {
  it("extracts goal-focused excerpts from the active session context", async () => {
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const { readSessionForGoal } = await importSource("extensions/mmr-history/read-session.ts");
    const manager = SessionManager.inMemory("/repo");
    manager.appendMessage({ role: "user", content: "We need a query parser for session history." });
    manager.appendMessage({ role: "assistant", content: "Use lexical excerpts first and keep paths private." });

    const result = readSessionForGoal(
      sessionInfo({ id: manager.getSessionId(), messageCount: 2, firstMessage: "We need a query parser for session history." }),
      manager,
      "query parser private paths",
      10_000,
    );

    assert.equal(result.sessionId, manager.getSessionId());
    assert.ok(result.excerptCount >= 1);
    assert.ok(result.matchedTerms.includes("query"));
    assert.ok(result.excerpts.some((excerpt) => excerpt.text.includes("query parser")));
  });

  it("resolveSessionById finds a session whose cwd is different from the active workspace", async () => {
    const { resolveSessionById } = await importSource("extensions/mmr-history/session-catalog.ts");
    const sessions = [
      sessionInfo({ id: "S-here", cwd: "/repo/here" }),
      sessionInfo({ id: "S-elsewhere", cwd: "/repo/elsewhere" }),
    ];

    const resolved = await resolveSessionById({ listSessions: async () => sessions }, "S-elsewhere");
    assert.ok(resolved);
    assert.equal(resolved.info.id, "S-elsewhere");
    assert.equal(resolved.ambiguous, false);
  });

  it("tool resolves a unique session prefix and rejects ambiguous prefixes", async () => {
    const { createReadSessionTool } = await importSource("extensions/mmr-history/tools.ts");
    const sessions = [sessionInfo({ id: "abc123" }), sessionInfo({ id: "abc999" })];
    const deps = {
      getSettings: () => ({ enabled: true, maxResults: 10, maxExcerptBytes: 10_000 }),
      listSessions: async () => sessions,
      openSession: () => {
        throw new Error("must not open ambiguous session");
      },
    };
    const tool = createReadSessionTool(deps);

    await assert.rejects(
      () => tool.execute("call", { sessionId: "abc", goal: "history" }, undefined, undefined, { cwd: "/repo" }),
      /ambiguous/,
    );
  });
});

describe("mmr-history extension registration", () => {
  it("keeps tools unregistered while the privacy gate is disabled", async () => {
    const { createMmrHistoryExtension } = await importSource("extensions/mmr-history/index.ts");
    const registered = [];
    const pi = {
      registerTool(tool) { registered.push(tool.name); },
      on() {},
    };
    createMmrHistoryExtension({ loadSettings: () => ({ enabled: false, maxResults: 10, maxExcerptBytes: 10_000 }) })(pi);

    assert.deepEqual(registered, []);
  });

  it("registers only the canonical session tool names when enabled", async () => {
    const { createMmrHistoryExtension } = await importSource("extensions/mmr-history/index.ts");
    const registered = [];
    const pi = {
      registerTool(tool) { registered.push(tool.name); },
      on() {},
    };
    createMmrHistoryExtension({
      loadSettings: () => ({ enabled: true, maxResults: 10, maxExcerptBytes: 10_000 }),
      deps: (getSettings) => ({ getSettings, listSessions: async () => [], openSession: () => undefined }),
    })(pi);

    assert.deepEqual(registered.sort(), ["find_session", "read_session"]);
    // The previous `find_thread` / `read_thread` registrations were a
    // legacy alias pair that no consumer needs anymore. Locked modes
    // and the oracle subagent profile now reference the canonical
    // `_session` names directly; pinning this absence here makes a
    // reintroduction visible immediately.
    assert.equal(registered.includes("find_thread"), false);
    assert.equal(registered.includes("read_thread"), false);
  });

  it("mmr-history provider does not claim the legacy thread aliases", async () => {
    const { createMmrHistoryToolProvider } = await importSource("extensions/mmr-history/provider.ts");
    const provider = createMmrHistoryToolProvider(() => ({ enabled: true, maxResults: 10, maxExcerptBytes: 10_000 }));
    assert.ok(provider.resolve("find_session"));
    assert.ok(provider.resolve("read_session"));
    assert.equal(provider.resolve("find_thread"), undefined);
    assert.equal(provider.resolve("read_thread"), undefined);
  });
});

describe("mmr-history shared SessionIndex (cache reuse)", () => {
  it("createDefaultMmrHistoryToolDeps exposes a shared sessionIndex", async () => {
    const { createDefaultMmrHistoryToolDeps } = await importSource("extensions/mmr-history/tools.ts");
    const deps = createDefaultMmrHistoryToolDeps(() => ({ enabled: true, maxResults: 10, maxExcerptBytes: 10_000 }));
    assert.ok(deps.sessionIndex, "default deps must carry a sessionIndex");
    assert.equal(typeof deps.sessionIndex.list, "function");
    assert.equal(typeof deps.sessionIndex.getTouchedFiles, "function");
  });

  it("find_session routes through the shared sessionIndex instead of calling deps.listSessions directly", async () => {
    const { createFindSessionTool } = await importSource("extensions/mmr-history/tools.ts");
    const sessions = [sessionInfo({ id: "S-1", allMessagesText: "auth work" })];
    let listCalls = 0;
    let indexListCalls = 0;
    const sessionIndex = {
      async list() {
        indexListCalls += 1;
        return sessions;
      },
      async getTouchedFiles() { return new Set(); },
    };
    const deps = {
      getSettings: () => ({ enabled: true, maxResults: 10, maxExcerptBytes: 10_000 }),
      listSessions: async () => {
        listCalls += 1;
        return sessions;
      },
      openSession: () => { throw new Error("unused"); },
      sessionIndex,
    };
    const tool = createFindSessionTool(deps);

    const result = await tool.execute("call", { query: "auth" }, undefined, undefined, { cwd: "/repo" });

    assert.equal(result.details.resultCount, 1);
    assert.equal(indexListCalls, 1, "shared sessionIndex.list() should be invoked once");
    assert.equal(listCalls, 0, "deps.listSessions should be bypassed when sessionIndex is provided");
  });

  it("read_session routes through the shared sessionIndex when resolving by id prefix", async () => {
    const { createReadSessionTool } = await importSource("extensions/mmr-history/tools.ts");
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const sessions = [sessionInfo({ id: "abc123" })];
    let listCalls = 0;
    let indexListCalls = 0;
    const sessionIndex = {
      async list() {
        indexListCalls += 1;
        return sessions;
      },
      async getTouchedFiles() { return new Set(); },
    };
    const deps = {
      getSettings: () => ({ enabled: true, maxResults: 10, maxExcerptBytes: 10_000 }),
      listSessions: async () => {
        listCalls += 1;
        return sessions;
      },
      openSession: () => SessionManager.inMemory("/repo"),
      sessionIndex,
    };
    const tool = createReadSessionTool(deps);

    await tool.execute("call", { sessionId: "abc", goal: "history" }, undefined, undefined, { cwd: "/repo" });

    assert.equal(indexListCalls, 1, "resolveSessionById should hit the shared sessionIndex.list()");
    assert.equal(listCalls, 0, "deps.listSessions should be bypassed when sessionIndex is provided");
  });
});
