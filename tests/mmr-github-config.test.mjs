import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const CONFIG_MODULE = "extensions/ampi-github/config.ts";

function makeTempProject() {
  const home = mkdtempSync(path.join(tmpdir(), "mmr-gh-home-"));
  const cwd = mkdtempSync(path.join(tmpdir(), "mmr-gh-cwd-"));
  return { home, cwd, cleanup: () => { rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); } };
}

function writeSettings(root, body) {
  const dir = path.join(root, ".pi");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify(body));
}

describe("loadMmrGithubSettings", () => {
  it("defaults to disabled with safe defaults and no token", async () => {
    const { loadMmrGithubSettings, DEFAULT_GITHUB_API_BASE_URL } = await importSource(CONFIG_MODULE);
    const { home, cwd, cleanup } = makeTempProject();
    try {
      const { settings } = loadMmrGithubSettings(cwd, { homeDirectory: home, env: {} });
      assert.equal(settings.enabled, false);
      assert.equal(settings.token, undefined);
      assert.equal(settings.apiBaseUrl, DEFAULT_GITHUB_API_BASE_URL);
      assert.equal(settings.requestTimeoutMs, 30000);
      assert.equal(settings.maxResultBytes, 200000);
    } finally {
      cleanup();
    }
  });

  it("enables via MMR_GITHUB_ENABLE and reads token from MMR_GITHUB_TOKEN then GITHUB_TOKEN", async () => {
    const { loadMmrGithubSettings } = await importSource(CONFIG_MODULE);
    const { home, cwd, cleanup } = makeTempProject();
    try {
      const a = loadMmrGithubSettings(cwd, { homeDirectory: home, env: { MMR_GITHUB_ENABLE: "true", MMR_GITHUB_TOKEN: "tok-a", GITHUB_TOKEN: "tok-b" } });
      assert.equal(a.settings.enabled, true);
      assert.equal(a.settings.token, "tok-a");
      const b = loadMmrGithubSettings(cwd, { homeDirectory: home, env: { MMR_GITHUB_ENABLE: "1", GITHUB_TOKEN: "tok-b" } });
      assert.equal(b.settings.token, "tok-b");
    } finally {
      cleanup();
    }
  });

  it("reads enabled/apiBaseUrl/timeouts from settings files but warns and ignores a settings-file token", async () => {
    const { loadMmrGithubSettings } = await importSource(CONFIG_MODULE);
    const { home, cwd, cleanup } = makeTempProject();
    try {
      writeSettings(cwd, { mmrGithub: { enabled: true, apiBaseUrl: "https://ghe.example.com/api/v3", requestTimeoutMs: 5000, token: "leak" } });
      const { settings, warnings } = loadMmrGithubSettings(cwd, { homeDirectory: home, env: {} });
      assert.equal(settings.enabled, true);
      assert.equal(settings.apiBaseUrl, "https://ghe.example.com/api/v3");
      assert.equal(settings.requestTimeoutMs, 5000);
      assert.equal(settings.token, undefined, "settings-file token must be ignored");
      assert.ok(warnings.some((w) => /mmrGithub\.token/.test(w)), "must warn about settings-file token");
    } finally {
      cleanup();
    }
  });

  it("env MMR_GITHUB_API_URL overrides and a non-http value warns", async () => {
    const { loadMmrGithubSettings, DEFAULT_GITHUB_API_BASE_URL } = await importSource(CONFIG_MODULE);
    const { home, cwd, cleanup } = makeTempProject();
    try {
      const ok = loadMmrGithubSettings(cwd, { homeDirectory: home, env: { MMR_GITHUB_API_URL: "http://127.0.0.1:8080/" } });
      assert.equal(ok.settings.apiBaseUrl, "http://127.0.0.1:8080");
      const bad = loadMmrGithubSettings(cwd, { homeDirectory: home, env: { MMR_GITHUB_API_URL: "ftp://nope" } });
      assert.equal(bad.settings.apiBaseUrl, DEFAULT_GITHUB_API_BASE_URL);
      assert.ok(bad.warnings.some((w) => /MMR_GITHUB_API_URL/.test(w)));
    } finally {
      cleanup();
    }
  });
});
