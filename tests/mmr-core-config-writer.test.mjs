import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

describe("mmr-core config-writer", () => {
  it("applies a per-mode model preference update and preserves unrelated settings", async () => {
    const { applyMmrConfigUpdate } = await importSource("extensions/mmr-core/config-writer.ts");

    const existing = {
      mmrWeb: { enabled: true },
      mmrCore: {
        defaultMode: "deep",
        toolAliases: { oracle: ["mmr-oracle"] },
        modelPreferences: {
          rush: [{ model: "claude-haiku-4-5" }],
        },
      },
    };

    const next = applyMmrConfigUpdate(existing, {
      modeModelPreferences: {
        mode: "deep",
        preferences: [
          { model: "gpt-5.5", providers: ["openai-codex"], thinkingLevel: "high" },
        ],
      },
    });

    assert.deepEqual(next.mmrWeb, { enabled: true });
    assert.equal(next.mmrCore.defaultMode, "deep");
    assert.deepEqual(next.mmrCore.toolAliases, { oracle: ["mmr-oracle"] });
    assert.deepEqual(next.mmrCore.modelPreferences, {
      rush: [{ model: "claude-haiku-4-5" }],
      deep: [{ model: "gpt-5.5", providers: ["openai-codex"], thinkingLevel: "high" }],
    });

    // Input is not mutated.
    assert.deepEqual(existing.mmrCore.modelPreferences, { rush: [{ model: "claude-haiku-4-5" }] });
  });

  it("writes a subagent override and serializes a bare-model preference as a string", async () => {
    const { applyMmrConfigUpdate } = await importSource("extensions/mmr-core/config-writer.ts");

    const next = applyMmrConfigUpdate({}, {
      subagentModelPreferences: {
        profile: "finder",
        preferences: [{ model: "gpt-5.4-mini" }],
      },
    });

    assert.deepEqual(next, {
      mmrCore: {
        subagentModelPreferences: { finder: ["gpt-5.4-mini"] },
      },
    });
  });

  it("clears an existing override when preferences is empty", async () => {
    const { applyMmrConfigUpdate } = await importSource("extensions/mmr-core/config-writer.ts");

    const existing = {
      mmrCore: {
        defaultMode: "smart",
        subagentModelPreferences: {
          finder: ["gpt-5.4-mini"],
          oracle: ["gpt-5.4"],
        },
      },
    };

    const next = applyMmrConfigUpdate(existing, {
      subagentModelPreferences: { profile: "oracle", preferences: [] },
    });

    assert.deepEqual(next.mmrCore.subagentModelPreferences, { finder: ["gpt-5.4-mini"] });
    assert.equal(next.mmrCore.defaultMode, "smart");
  });

  it("removes the mmrCore block entirely when the last entry is cleared", async () => {
    const { applyMmrConfigUpdate } = await importSource("extensions/mmr-core/config-writer.ts");

    const existing = {
      mmrCore: {
        modelPreferences: { rush: ["claude-haiku-4-5"] },
      },
      mmrWeb: { enabled: true },
    };

    const next = applyMmrConfigUpdate(existing, {
      modeModelPreferences: { mode: "rush", preferences: [] },
    });

    assert.equal("mmrCore" in next, false);
    assert.deepEqual(next.mmrWeb, { enabled: true });
  });

  it("preserves the nested mmr.core layout when no flat mmrCore exists", async () => {
    const { applyMmrConfigUpdate } = await importSource("extensions/mmr-core/config-writer.ts");

    const existing = {
      mmr: {
        core: { defaultMode: "smart" },
      },
    };

    const next = applyMmrConfigUpdate(existing, {
      subagentModelPreferences: { profile: "finder", preferences: [{ model: "gpt-5.4-mini" }] },
    });

    assert.equal("mmrCore" in next, false);
    assert.deepEqual(next.mmr.core, {
      defaultMode: "smart",
      subagentModelPreferences: { finder: ["gpt-5.4-mini"] },
    });
  });

  it("writeMmrCoreConfigFile writes valid JSON that the loader can read back", async () => {
    const { writeMmrCoreConfigFile, getProjectMmrSettingsPath } = await importSource(
      "extensions/mmr-core/config-writer.ts",
    );
    const { loadMmrCoreSettings } = await importSource("extensions/mmr-core/settings.ts");

    const tempRoot = mkdtempSync(path.join(tmpdir(), "pi-mmr-config-writer-"));
    try {
      const project = path.join(tempRoot, "project");
      const home = path.join(tempRoot, "home");
      mkdirSync(home, { recursive: true });

      const filePath = getProjectMmrSettingsPath(project);
      assert.equal(existsSync(filePath), false);

      writeMmrCoreConfigFile(filePath, {
        modeModelPreferences: {
          mode: "deep",
          preferences: [{ model: "gpt-5.5", providers: ["openai-codex"], thinkingLevel: "high" }],
        },
      });
      writeMmrCoreConfigFile(filePath, {
        subagentModelPreferences: {
          profile: "finder",
          preferences: [{ model: "gpt-5.4-mini" }],
        },
      });

      const loaded = loadMmrCoreSettings(project, home);

      assert.deepEqual(loaded.settings.modelPreferences, {
        deep: [{ model: "gpt-5.5", providers: ["openai-codex"], thinkingLevel: "high" }],
      });
      assert.deepEqual(loaded.settings.subagentModelPreferences, {
        finder: [{ model: "gpt-5.4-mini" }],
      });
      assert.deepEqual(loaded.warnings, []);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite a settings file with invalid JSON", async () => {
    const { writeMmrCoreConfigFile, getProjectMmrSettingsPath } = await importSource(
      "extensions/mmr-core/config-writer.ts",
    );

    const tempRoot = mkdtempSync(path.join(tmpdir(), "pi-mmr-config-writer-"));
    try {
      const project = path.join(tempRoot, "project");
      mkdirSync(path.join(project, ".pi"), { recursive: true });
      const filePath = getProjectMmrSettingsPath(project);
      writeFileSync(filePath, "{ not json");

      assert.throws(
        () => writeMmrCoreConfigFile(filePath, {
          modeModelPreferences: { mode: "smart", preferences: [{ model: "gpt-5.5" }] },
        }),
        /not valid JSON/,
      );

      // File contents are untouched on refusal.
      assert.equal(readFileSync(filePath, "utf8"), "{ not json");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("mmr-core settings: subagentModelPreferences", () => {
  it("parses subagentModelPreferences from the project settings file", async () => {
    const { loadMmrCoreSettings } = await importSource("extensions/mmr-core/settings.ts");

    const tempRoot = mkdtempSync(path.join(tmpdir(), "pi-mmr-config-settings-"));
    try {
      const home = path.join(tempRoot, "home");
      const project = path.join(tempRoot, "project");
      mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
      mkdirSync(path.join(project, ".pi"), { recursive: true });

      writeFileSync(
        path.join(project, ".pi/settings.json"),
        JSON.stringify({
          mmrCore: {
            subagentModelPreferences: {
              finder: ["gpt-5.4-mini", { model: "claude-haiku-4-5", thinkingLevel: "minimal" }],
              oracle: ["openai-codex/gpt-5.4"],
            },
          },
        }),
      );

      const loaded = loadMmrCoreSettings(project, home);

      assert.deepEqual(loaded.settings.subagentModelPreferences, {
        finder: [
          { model: "gpt-5.4-mini" },
          { model: "claude-haiku-4-5", thinkingLevel: "minimal" },
        ],
        oracle: [{ model: "gpt-5.4", providers: ["openai-codex"] }],
      });
      assert.deepEqual(loaded.warnings, []);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("warns when subagentModelPreferences is the wrong shape and ignores it", async () => {
    const { loadMmrCoreSettings } = await importSource("extensions/mmr-core/settings.ts");

    const tempRoot = mkdtempSync(path.join(tmpdir(), "pi-mmr-config-settings-"));
    try {
      const home = path.join(tempRoot, "home");
      const project = path.join(tempRoot, "project");
      mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
      mkdirSync(path.join(project, ".pi"), { recursive: true });

      writeFileSync(
        path.join(project, ".pi/settings.json"),
        JSON.stringify({ mmrCore: { subagentModelPreferences: ["finder"] } }),
      );

      const loaded = loadMmrCoreSettings(project, home);

      assert.equal(loaded.settings.subagentModelPreferences, undefined);
      assert.ok(
        loaded.warnings.some(
          (w) => /subagentModelPreferences/.test(w) && /\/project\/\.pi\/settings\.json/.test(w),
        ),
        `expected a subagentModelPreferences-shape warning, got ${JSON.stringify(loaded.warnings)}`,
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
