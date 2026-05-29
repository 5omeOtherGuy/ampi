import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const CLIENT_MODULE = "extensions/mmr-github/client.ts";

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function makeFetchMock(plan) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input));
    calls.push({ url, init });
    const handler = Array.isArray(plan) ? plan.shift() : plan;
    if (!handler) throw new Error(`unexpected fetch to ${url.toString()}`);
    return handler({ url, init });
  };
  return { fetchImpl, calls };
}

async function makeClient(plan, opts = {}) {
  const mod = await importSource(CLIENT_MODULE);
  const { fetchImpl, calls } = makeFetchMock(plan);
  const client = mod.createGithubClient({
    apiBaseUrl: "https://api.github.test",
    requestTimeoutMs: 1000,
    maxResultBytes: 200000,
    fetchImpl,
    ...opts,
  });
  // Return the same module instance so `instanceof` checks line up: each
  // importSource call creates a fresh module realm with a distinct class.
  return { client, calls, mod };
}

describe("parseGithubRepository", () => {
  it("accepts owner/repo and github URLs, strips .git, rejects bad input", async () => {
    const { parseGithubRepository, GithubRepoParseError } = await importSource(CLIENT_MODULE);
    assert.deepEqual(parseGithubRepository("facebook/react"), { owner: "facebook", repo: "react" });
    assert.deepEqual(parseGithubRepository("https://github.com/acme/repo.git"), { owner: "acme", repo: "repo" });
    assert.deepEqual(parseGithubRepository("https://github.com/acme/repo/tree/main/src"), { owner: "acme", repo: "repo" });
    assert.deepEqual(parseGithubRepository("github.com/acme/repo"), { owner: "acme", repo: "repo" });
    for (const bad of ["", "just-one", "https://github.com/search?q=foo", "https://github.com/orgs", "https://gitlab.com/a/b", "a/b/c"]) {
      assert.throws(() => parseGithubRepository(bad), GithubRepoParseError, `must reject ${JSON.stringify(bad)}`);
    }
  });
});

describe("github client request behavior", () => {
  it("sets auth, accept, version, and user-agent headers and builds the URL", async () => {
    const { client, calls } = await makeClient(
      () => jsonResponse({ name: "repo", full_name: "acme/repo", default_branch: "main" }),
      { token: "secret-token" },
    );
    await client.getRepo({ owner: "acme", repo: "repo" });
    const { url, init } = calls[0];
    assert.equal(url.toString(), "https://api.github.test/repos/acme/repo");
    assert.equal(init.method, "GET");
    assert.equal(init.headers.Authorization, "Bearer secret-token");
    assert.equal(init.headers["X-GitHub-Api-Version"], "2022-11-28");
    assert.equal(init.headers.Accept, "application/vnd.github+json");
    assert.equal(init.headers["User-Agent"], "pi-mmr-github");
  });

  it("omits Authorization when no token is configured", async () => {
    const { client, calls } = await makeClient(() => jsonResponse({ full_name: "a/b" }));
    await client.getRepo({ owner: "a", repo: "b" });
    assert.equal(calls[0].init.headers.Authorization, undefined);
  });

  it("decodes base64 file contents", async () => {
    const text = "line1\nline2\nline3";
    const { client } = await makeClient(() => jsonResponse({
      type: "file", path: "src/a.ts", size: text.length, encoding: "base64",
      content: Buffer.from(text, "utf8").toString("base64"),
    }));
    const result = await client.getContents({ owner: "a", repo: "b" }, "src/a.ts", undefined);
    assert.equal(result.kind, "file");
    assert.equal(result.text, text);
    assert.equal(result.truncated, false);
  });

  it("fetches file contents up to the dedicated contents ceiling, not the shared per-call cap", async () => {
    const mod = await importSource(CLIENT_MODULE);
    // A 5000-char file far exceeds the tiny shared maxResultBytes, but the
    // contents fetch uses GITHUB_CONTENTS_READ_BYTE_CEILING so it still parses
    // and returns the full file (read_github applies its own line-range gate).
    const big = "x".repeat(5000);
    const client = mod.createGithubClient({
      apiBaseUrl: "https://api.github.test", requestTimeoutMs: 1000, maxResultBytes: 20,
      fetchImpl: async () => jsonResponse({ type: "file", path: "p", size: 5000, encoding: "base64", content: Buffer.from(big).toString("base64") }),
    });
    const result = await client.getContents({ owner: "a", repo: "b" }, "p", undefined);
    assert.equal(result.kind, "file");
    assert.equal(result.text.length, 5000);
    assert.equal(result.truncated, false);
  });

  it("returns a directory listing when contents is an array", async () => {
    const { client } = await makeClient(() => jsonResponse([
      { name: "src", path: "src", type: "dir", size: 0 },
      { name: "README.md", path: "README.md", type: "file", size: 12 },
    ]));
    const result = await client.getContents({ owner: "a", repo: "b" }, "", undefined);
    assert.equal(result.kind, "directory");
    assert.equal(result.entries.length, 2);
    assert.equal(result.entries[0].type, "dir");
  });

  it("getTree resolves the default branch when no revision is given, then requests recursive tree", async () => {
    const { client, calls } = await makeClient([
      () => jsonResponse({ full_name: "a/b", default_branch: "trunk" }),
      () => jsonResponse({ tree: [{ path: "src/a.ts", type: "blob", size: 10 }, { path: "src", type: "tree" }], truncated: false }),
    ]);
    const tree = await client.getTree({ owner: "a", repo: "b" }, undefined);
    assert.equal(tree.ref, "trunk");
    assert.equal(tree.entries.length, 2);
    assert.match(calls[1].url.toString(), /\/git\/trees\/trunk\?recursive=1/);
  });

  it("searchCode uses the text-match accept header and parses fragments", async () => {
    const { client, calls } = await makeClient(() => jsonResponse({
      total_count: 1, incomplete_results: false,
      items: [{ path: "src/a.ts", html_url: "https://github.com/a/b/blob/main/src/a.ts", repository: { full_name: "a/b" }, text_matches: [{ fragment: "const x = 1" }] }],
    }));
    const result = await client.searchCode("x repo:a/b", { perPage: 5, page: 1 });
    assert.equal(calls[0].init.headers.Accept, "application/vnd.github.text-match+json");
    assert.equal(result.items[0].fragments[0], "const x = 1");
  });

  it("searchCommits sorts by author-date desc and parses author email", async () => {
    const { client, calls } = await makeClient(() => jsonResponse({
      total_count: 1,
      items: [{ sha: "abc", html_url: "u", commit: { message: "fix", author: { name: "Ann", email: "ann@e", date: "2024-01-01" } } }],
    }));
    const result = await client.searchCommits("fix repo:a/b", { perPage: 5, page: 1 });
    assert.equal(calls[0].url.searchParams.get("sort"), "author-date");
    assert.equal(calls[0].url.searchParams.get("order"), "desc");
    assert.equal(result.items[0].authorEmail, "ann@e");
  });

  it("listAccessibleRepositories hits /user/repos with affiliation and parses forks", async () => {
    const { client, calls } = await makeClient(() => jsonResponse([
      { full_name: "acme/api", stargazers_count: 5, forks_count: 2, language: "TS", default_branch: "main" },
    ]));
    const repos = await client.listAccessibleRepositories({ perPage: 25, page: 1 });
    assert.match(calls[0].url.pathname, /\/user\/repos$/);
    assert.equal(calls[0].url.searchParams.get("affiliation"), "owner,collaborator,organization_member");
    assert.equal(repos[0].forks, 2);
  });

  it("compare returns files with patches", async () => {
    const { client } = await makeClient(() => jsonResponse({
      status: "ahead", ahead_by: 2, behind_by: 0, total_commits: 2,
      files: [{ filename: "a.ts", status: "modified", additions: 3, deletions: 1, changes: 4, patch: "@@ -1 +1 @@" }],
    }));
    const result = await client.compare({ owner: "a", repo: "b" }, "main", "feat");
    assert.equal(result.totalCommits, 2);
    assert.equal(result.files[0].patch, "@@ -1 +1 @@");
  });

  it("maps error statuses to clear GithubApiError messages", async () => {
    const cases = [
      { status: 401, headers: {}, re: /authentication failed \(401\)/ },
      { status: 403, headers: { "x-ratelimit-remaining": "0" }, re: /rate limit reached \(403\)/, rate: true },
      { status: 404, headers: {}, re: /not found \(404\)/ },
      { status: 422, headers: {}, re: /rejected the request \(422\)/ },
    ];
    for (const c of cases) {
      const { client, mod } = await makeClient(() => new Response(JSON.stringify({ message: "boom" }), { status: c.status, headers: { "content-type": "application/json", ...c.headers } }));
      await assert.rejects(
        client.getRepo({ owner: "a", repo: "b" }),
        (err) => {
          assert.ok(err instanceof mod.GithubApiError);
          assert.equal(err.status, c.status);
          assert.match(err.message, c.re);
          if (c.rate) assert.equal(err.rateLimited, true);
          return true;
        },
      );
    }
  });
});
