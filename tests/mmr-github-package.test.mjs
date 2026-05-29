import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const repoRoot = path.resolve(import.meta.dirname, "..");
const githubExtensionPath = "./src/extensions/mmr-github/index.ts";

async function readPackageJson() {
  return JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
}

describe("mmr-github package wiring", () => {
  it("registers mmr-github after mmr-core and before mmr-subagents", async () => {
    const pkg = await readPackageJson();
    const core = pkg.pi.extensions.indexOf("./src/extensions/mmr-core/index.ts");
    const github = pkg.pi.extensions.indexOf(githubExtensionPath);
    const subagents = pkg.pi.extensions.indexOf("./src/extensions/mmr-subagents/index.ts");
    assert.ok(core !== -1 && github !== -1 && subagents !== -1);
    assert.ok(github > core, "mmr-github must load after mmr-core");
    assert.ok(github < subagents, "mmr-github must load before mmr-subagents so librarian gating sees the GitHub tools");
  });

  it("exposes a package subpath for direct extension loading", async () => {
    const pkg = await readPackageJson();
    assert.equal(pkg.exports["./extensions/mmr-github"], githubExtensionPath);
  });

  it("exports a default factory and a createMmrGithubExtension test seam", async () => {
    const mod = await importSource("extensions/mmr-github/index.ts");
    assert.equal(typeof mod.default, "function");
    assert.equal(typeof mod.createMmrGithubExtension, "function");
  });

  it("re-exports the mmr-github public surface from the package root", async () => {
    const root = await importSource("index.ts");
    assert.equal(typeof root.loadMmrGithubSettings, "function");
    assert.equal(typeof root.createMmrGithubToolProvider, "function");
    assert.equal(typeof root.createMmrGithubFeatureGateProvider, "function");
    assert.equal(typeof root.createGithubClient, "function");
    assert.equal(typeof root.parseGithubRepository, "function");
    assert.equal(typeof root.registerMmrGithubTools, "function");
    assert.equal(typeof root.createMmrGithubExtension, "function");
    assert.equal(root.MMR_GITHUB_PROVIDER_NAME, "mmr-github");
    assert.equal(root.MMR_GITHUB_FEATURE_GATE, "mmr-github");
    assert.deepEqual([...root.MMR_GITHUB_TOOL_NAMES], [
      "read_github",
      "list_directory_github",
      "glob_github",
      "search_github",
      "commit_search",
      "diff_github",
      "list_repositories",
    ]);
  });

  it("registers all GitHub tools when enabled and drains warnings on session_start", async () => {
    const { createMmrGithubExtension } = await importSource("extensions/mmr-github/index.ts");
    const registered = [];
    const handlers = new Map();
    const pi = {
      registerTool: (t) => registered.push(t.name),
      on: (name, handler) => handlers.set(name, handler),
    };
    const warning = "mmrGithub.token ignored; use MMR_GITHUB_TOKEN.";
    createMmrGithubExtension({
      loadSettings: () => ({
        settings: { enabled: true, token: undefined, apiBaseUrl: "https://api.github.test", requestTimeoutMs: 1000, maxResultBytes: 200000 },
        warnings: [warning],
      }),
      createClient: () => ({}),
    })(pi);
    assert.equal(registered.length, 7);

    const notes = [];
    await handlers.get("session_start")({}, { ui: { notify: (m, level) => notes.push({ m, level }) } });
    assert.deepEqual(notes, [{ m: warning, level: "warning" }]);
  });

  it("registers no tools when disabled", async () => {
    const { createMmrGithubExtension } = await importSource("extensions/mmr-github/index.ts");
    const registered = [];
    const pi = { registerTool: (t) => registered.push(t.name), on: () => {} };
    createMmrGithubExtension({
      loadSettings: () => ({ settings: { enabled: false, apiBaseUrl: "https://api.github.com", requestTimeoutMs: 30000, maxResultBytes: 200000 } }),
    })(pi);
    assert.deepEqual(registered, []);
  });
});
