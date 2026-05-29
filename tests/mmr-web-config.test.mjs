import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

function setupTempEnv() {
  const root = mkdtempSync(path.join(tmpdir(), "pi-mmr-web-cfg-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
  mkdirSync(path.join(project, ".pi"), { recursive: true });
  return {
    root,
    home,
    project,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("mmr-web config", () => {
  it("defaults to disabled with no settings file and no env opt-in", async () => {
    const { loadMmrWebSettings, DEFAULT_MAX_RESULT_BYTES, DEFAULT_TIMEOUT_MS } = await importSource("extensions/mmr-web/config.ts");
    const env = setupTempEnv();
    try {
      const result = loadMmrWebSettings(env.project, { homeDirectory: env.home, env: {} });
      assert.equal(result.settings.enabled, false);
      assert.equal(result.settings.braveApiKey, undefined);
      assert.equal(result.settings.backend, "auto");
      assert.equal(result.settings.searchBackend, undefined);
      assert.equal(result.settings.readerBackend, undefined);
      assert.equal(result.settings.maxResultBytes, DEFAULT_MAX_RESULT_BYTES);
      assert.equal(result.settings.searchTimeoutMs, DEFAULT_TIMEOUT_MS);
      assert.equal(result.settings.readTimeoutMs, DEFAULT_TIMEOUT_MS);
      assert.deepEqual(result.filesRead, []);
      assert.deepEqual(result.warnings, []);
    } finally {
      env.cleanup();
    }
  });

  it("reads mmrWeb block from project settings.json (toggles only, no key)", async () => {
    const { loadMmrWebSettings } = await importSource("extensions/mmr-web/config.ts");
    const env = setupTempEnv();
    try {
      writeFileSync(path.join(env.project, ".pi/settings.json"), JSON.stringify({
        mmrWeb: { enabled: true, maxResultBytes: 12345 },
      }));
      const result = loadMmrWebSettings(env.project, { homeDirectory: env.home, env: {} });
      assert.equal(result.settings.enabled, true);
      assert.equal(result.settings.braveApiKey, undefined);
      assert.equal(result.settings.maxResultBytes, 12345);
      assert.equal(result.filesRead.length, 1);
      assert.deepEqual(result.warnings, []);
    } finally {
      env.cleanup();
    }
  });

  it("also accepts the nested `mmr.web` block", async () => {
    const { loadMmrWebSettings } = await importSource("extensions/mmr-web/config.ts");
    const env = setupTempEnv();
    try {
      writeFileSync(path.join(env.project, ".pi/settings.json"), JSON.stringify({
        mmr: { web: { enabled: true } },
      }));
      const result = loadMmrWebSettings(env.project, { homeDirectory: env.home, env: {} });
      assert.equal(result.settings.enabled, true);
    } finally {
      env.cleanup();
    }
  });

  it("ignores deprecated jinaApiKey in settings.json and warns the user it is unsupported", async () => {
    const { loadMmrWebSettings } = await importSource("extensions/mmr-web/config.ts");
    for (const layout of ["flat", "nested"]) {
      const env = setupTempEnv();
      try {
        const body = layout === "flat"
          ? { mmrWeb: { enabled: true, jinaApiKey: "from-file" } }
          : { mmr: { web: { enabled: true, jinaApiKey: "from-file" } } };
        writeFileSync(path.join(env.project, ".pi/settings.json"), JSON.stringify(body));
        const result = loadMmrWebSettings(env.project, { homeDirectory: env.home, env: {} });
        assert.equal(result.settings.enabled, true, `${layout}: enabled passes through`);
        assert.equal("jinaApiKey" in result.settings, false, `${layout}: Jina key must not be part of runtime settings`);
        assert.equal(result.warnings.length, 1, `${layout}: warning expected`);
        assert.match(result.warnings[0], /jinaApiKey/);
        assert.match(result.warnings[0], /no longer uses Jina|unsupported/i);
      } finally {
        env.cleanup();
      }
    }
  });

  it("does not warn when deprecated jinaApiKey is declared with a non-string value", async () => {
    const { loadMmrWebSettings } = await importSource("extensions/mmr-web/config.ts");
    const env = setupTempEnv();
    try {
      writeFileSync(path.join(env.project, ".pi/settings.json"), JSON.stringify({
        mmrWeb: { enabled: true, jinaApiKey: null },
      }));
      const result = loadMmrWebSettings(env.project, { homeDirectory: env.home, env: {} });
      assert.equal(result.settings.enabled, true);
      assert.deepEqual(result.warnings, [], "non-string jinaApiKey is not a leaked secret and must not warn");
    } finally {
      env.cleanup();
    }
  });

  it("environment JINA_API_KEY is ignored silently while BRAVE_API_KEY is honored", async () => {
    const { loadMmrWebSettings } = await importSource("extensions/mmr-web/config.ts");
    const env = setupTempEnv();
    try {
      const result = loadMmrWebSettings(env.project, {
        homeDirectory: env.home,
        env: {
          JINA_API_KEY: "from-env",
          BRAVE_API_KEY: "from-brave-env",
        },
      });
      assert.equal("jinaApiKey" in result.settings, false);
      assert.equal(result.settings.braveApiKey, "from-brave-env");
      assert.deepEqual(result.warnings, []);
    } finally {
      env.cleanup();
    }
  });

  it("empty MMR_WEB_ENABLE does not override file-set enabled=true", async () => {
    const { loadMmrWebSettings } = await importSource("extensions/mmr-web/config.ts");
    const env = setupTempEnv();
    try {
      writeFileSync(path.join(env.project, ".pi/settings.json"), JSON.stringify({
        mmrWeb: { enabled: true },
      }));
      // Wrappers that render unset shell vars as "" must not silently disable.
      const result = loadMmrWebSettings(env.project, {
        homeDirectory: env.home,
        env: { MMR_WEB_ENABLE: "" },
      });
      assert.equal(result.settings.enabled, true, "file enabled=true must survive empty MMR_WEB_ENABLE");
    } finally {
      env.cleanup();
    }
  });

  it("reads mmrWeb backend fields and ignores removed Jina values", async () => {
    const { loadMmrWebSettings } = await importSource("extensions/mmr-web/config.ts");
    for (const value of ["auto", "brave"]) {
      const env = setupTempEnv();
      try {
        writeFileSync(path.join(env.project, ".pi/settings.json"), JSON.stringify({
          mmrWeb: { enabled: true, backend: value, searchBackend: value, readerBackend: value },
        }));
        const result = loadMmrWebSettings(env.project, { homeDirectory: env.home, env: {} });
        assert.equal(result.settings.backend, value);
        assert.equal(result.settings.searchBackend, value);
        assert.equal(result.settings.readerBackend, value);
      } finally {
        env.cleanup();
      }
    }

    const env = setupTempEnv();
    try {
      writeFileSync(path.join(env.project, ".pi/settings.json"), JSON.stringify({
        mmrWeb: { enabled: true, backend: "jina", searchBackend: "jina", readerBackend: "jina" },
      }));
      const result = loadMmrWebSettings(env.project, { homeDirectory: env.home, env: {} });
      assert.equal(result.settings.backend, "auto", "removed backend falls back to auto");
      assert.equal(result.settings.searchBackend, undefined);
      assert.equal(result.settings.readerBackend, undefined);
      assert.equal(result.warnings.filter((w) => /jina/.test(w)).length, 3);
    } finally {
      env.cleanup();
    }
  });

  it("environment backend overrides accept only auto/brave", async () => {
    const { loadMmrWebSettings } = await importSource("extensions/mmr-web/config.ts");
    const env = setupTempEnv();
    try {
      writeFileSync(path.join(env.project, ".pi/settings.json"), JSON.stringify({
        mmrWeb: { enabled: true, backend: "auto" },
      }));
      const result = loadMmrWebSettings(env.project, {
        homeDirectory: env.home,
        env: {
          MMR_WEB_BACKEND: "brave",
          MMR_WEB_SEARCH_BACKEND: "jina",
          MMR_WEB_READER_BACKEND: "bing",
        },
      });
      assert.equal(result.settings.backend, "brave");
      assert.equal(result.settings.searchBackend, undefined);
      assert.equal(result.settings.readerBackend, undefined);
      assert.ok(result.warnings.some((w) => /MMR_WEB_SEARCH_BACKEND/.test(w) && /jina/.test(w)));
      assert.ok(result.warnings.some((w) => /MMR_WEB_READER_BACKEND/.test(w) && /bing/.test(w)));
    } finally {
      env.cleanup();
    }
  });

  it("environment BRAVE_API_KEY is honored; file mmrWeb.braveApiKey is ignored with a warning", async () => {
    const { loadMmrWebSettings } = await importSource("extensions/mmr-web/config.ts");
    for (const layout of ["flat", "nested"]) {
      const env = setupTempEnv();
      try {
        const body = layout === "flat"
          ? { mmrWeb: { enabled: true, braveApiKey: "from-file" } }
          : { mmr: { web: { enabled: true, braveApiKey: "from-file" } } };
        writeFileSync(path.join(env.project, ".pi/settings.json"), JSON.stringify(body));
        const result = loadMmrWebSettings(env.project, {
          homeDirectory: env.home,
          env: { BRAVE_API_KEY: "from-env" },
        });
        assert.equal(result.settings.braveApiKey, "from-env", `${layout}: env BRAVE_API_KEY must win`);
        assert.equal(
          result.warnings.some((w) => /braveApiKey/.test(w) && /BRAVE_API_KEY/.test(w)),
          true,
          `${layout}: warning for file braveApiKey must be emitted`,
        );
      } finally {
        env.cleanup();
      }
    }
  });

  it("reads searxngUrl from MMR_WEB_SEARXNG_URL env", async () => {
    const { loadMmrWebSettings } = await importSource("extensions/mmr-web/config.ts");
    const env = setupTempEnv();
    try {
      const result = loadMmrWebSettings(env.project, {
        homeDirectory: env.home,
        env: { MMR_WEB_ENABLE: "true", MMR_WEB_SEARXNG_URL: "http://127.0.0.1:8080" },
      });
      assert.equal(result.settings.searxngUrl, "http://127.0.0.1:8080");
      assert.deepEqual(result.warnings, []);
    } finally {
      env.cleanup();
    }
  });

  it("reads searxngUrl from the mmrWeb settings block", async () => {
    const { loadMmrWebSettings } = await importSource("extensions/mmr-web/config.ts");
    const env = setupTempEnv();
    try {
      writeFileSync(path.join(env.project, ".pi/settings.json"), JSON.stringify({
        mmrWeb: { enabled: true, searxngUrl: "https://searxng.example.com/" },
      }));
      const result = loadMmrWebSettings(env.project, { homeDirectory: env.home, env: {} });
      assert.equal(result.settings.searxngUrl, "https://searxng.example.com/");
    } finally {
      env.cleanup();
    }
  });

  it("warns and ignores a non-http(s) searxngUrl", async () => {
    const { loadMmrWebSettings } = await importSource("extensions/mmr-web/config.ts");
    for (const layout of ["file", "env"]) {
      const env = setupTempEnv();
      try {
        if (layout === "file") {
          writeFileSync(path.join(env.project, ".pi/settings.json"), JSON.stringify({
            mmrWeb: { enabled: true, searxngUrl: "file:///tmp/bad" },
          }));
        }
        const result = loadMmrWebSettings(env.project, {
          homeDirectory: env.home,
          env: layout === "env" ? { MMR_WEB_SEARXNG_URL: "file:///tmp/bad" } : {},
        });
        assert.equal(result.settings.searxngUrl, undefined);
        assert.ok(
          result.warnings.some((w) => /searxngUrl|MMR_WEB_SEARXNG_URL/.test(w)),
          `${layout}: expected an ignored-searxngUrl warning, got ${JSON.stringify(result.warnings)}`,
        );
      } finally {
        env.cleanup();
      }
    }
  });

  it("accepts MMR_WEB_SEARCH_BACKEND=searxng (new in Phase 2)", async () => {
    const { loadMmrWebSettings } = await importSource("extensions/mmr-web/config.ts");
    const env = setupTempEnv();
    try {
      const result = loadMmrWebSettings(env.project, {
        homeDirectory: env.home,
        env: { MMR_WEB_ENABLE: "true", MMR_WEB_SEARCH_BACKEND: "searxng" },
      });
      assert.equal(result.settings.searchBackend, "searxng");
      assert.deepEqual(result.warnings, []);
    } finally {
      env.cleanup();
    }
  });

  it("emits a warning for malformed JSON without throwing", async () => {
    const { loadMmrWebSettings } = await importSource("extensions/mmr-web/config.ts");
    const env = setupTempEnv();
    try {
      writeFileSync(path.join(env.project, ".pi/settings.json"), "{ not valid json");
      const result = loadMmrWebSettings(env.project, { homeDirectory: env.home, env: {} });
      assert.equal(result.settings.enabled, false);
      assert.equal(result.warnings.length, 1);
      assert.match(result.warnings[0], /Could not read MMR web settings/);
    } finally {
      env.cleanup();
    }
  });
});
