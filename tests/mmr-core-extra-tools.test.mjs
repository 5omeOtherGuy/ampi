import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

async function importRuntime() {
  const runtimeUrl = pathToFileURL(path.join(getPreparedSourceRoot(), "extensions/ampi-core/runtime.ts")).href;
  return import(runtimeUrl);
}

function emptyResolution(overrides = {}) {
  return {
    requestedTools: [],
    activeTools: [],
    missingTools: [],
    deferredTools: [],
    gatedTools: [],
    disabledTools: [],
    decisions: [],
    ...overrides,
  };
}

describe("mmr-core locked-mode extra tools - helpers", () => {
  it("selectExtraToolNames combines all + per-mode, dedupes, and excludes base tools", async () => {
    const { selectExtraToolNames } = await importSource("extensions/ampi-core/extra-tools.ts");
    const extras = {
      all: ["alpha", "beta", "read", " beta "],
      high: ["gamma", "alpha"],
      medium: ["delta"],
    };

    const names = selectExtraToolNames("high", extras, ["read", "bash"]);
    // read excluded (base), beta deduped/trimmed, alpha from all wins once, gamma from deep.
    assert.deepEqual(names, ["alpha", "beta", "gamma"]);
  });

  it("selectExtraToolNames returns empty for undefined extras or no matches", async () => {
    const { selectExtraToolNames } = await importSource("extensions/ampi-core/extra-tools.ts");
    assert.deepEqual(selectExtraToolNames("medium", undefined, ["read"]), []);
    assert.deepEqual(selectExtraToolNames("medium", { high: ["x"] }, ["read"]), []);
  });

  it("relabelExtraOwners rewrites only mmr-core owners to user-allowlist", async () => {
    const { relabelExtraOwners, USER_ALLOWLIST_OWNER } = await importSource("extensions/ampi-core/extra-tools.ts");
    const resolution = emptyResolution({
      activeTools: ["my_tool"],
      decisions: [
        { requested: "my_tool", chosenTools: ["my_tool"], candidates: ["my_tool"], status: "active", owner: "ampi-core", diagnostic: "" },
        { requested: "web_search", chosenTools: [], candidates: [], status: "deferred", owner: "ampi-web", diagnostic: "" },
      ],
    });

    const relabeled = relabelExtraOwners(resolution);
    assert.equal(relabeled.decisions[0].owner, USER_ALLOWLIST_OWNER);
    assert.equal(relabeled.decisions[1].owner, "ampi-web");
  });

  it("mergeToolResolutions concatenates buckets/decisions and dedupes names", async () => {
    const { mergeToolResolutions } = await importSource("extensions/ampi-core/extra-tools.ts");
    const base = emptyResolution({
      requestedTools: ["read", "bash"],
      activeTools: ["read", "bash"],
      decisions: [{ requested: "read", chosenTools: ["read"], candidates: ["read"], status: "active", owner: "mmr-core", diagnostic: "" }],
    });
    const extra = emptyResolution({
      requestedTools: ["my_tool", "bash"],
      activeTools: ["my_tool", "bash"],
      missingTools: ["ghost"],
      decisions: [{ requested: "my_tool", chosenTools: ["my_tool"], candidates: ["my_tool"], status: "active", owner: "user-allowlist", diagnostic: "" }],
    });

    const merged = mergeToolResolutions(base, extra);
    assert.deepEqual(merged.activeTools, ["read", "bash", "my_tool"]);
    assert.deepEqual(merged.missingTools, ["ghost"]);
    assert.equal(merged.decisions.length, 2);
  });
});

describe("mmr-core locked-mode extra tools - activation", () => {
  function writeProjectSettings(cwd, mmrCore) {
    mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    writeFileSync(path.join(cwd, ".pi/settings.json"), JSON.stringify({ mmrCore }));
  }

  it("adds configured extra tools to the active set when their Pi tool exists", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrModeState(undefined);

    const tempRoot = mkdtempSync(path.join(tmpdir(), "ampi-extra-"));
    try {
      writeProjectSettings(tempRoot, {
        lockedModeExtraTools: { all: ["my_tool"], high: ["deep_tool"], medium: ["smart_only"] },
      });

      const { pi, calls, commands, handlers } = createMockPi({
        allTools: [
          { name: "read" }, { name: "bash" }, { name: "edit" }, { name: "write" },
          { name: "grep" }, { name: "find" }, { name: "ls" },
          { name: "my_tool" }, { name: "deep_tool" }, { name: "smart_only" },
        ],
        setModelResult: true,
      });
      const { ctx } = createMockExtensionContext({
        cwd: tempRoot,
        models: [{ provider: "openai-codex", id: "gpt-5.6-sol" }],
        authenticated: true,
      });
      extension(pi);

      await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
      await commands.get("mode").handler("high", ctx);

      const active = calls.setActiveTools.at(-1);
      assert.equal(active.includes("my_tool"), true, "all-bucket extra is active");
      assert.equal(active.includes("deep_tool"), true, "deep-bucket extra is active");
      assert.equal(active.includes("smart_only"), false, "smart-only extra is not active in deep");
      // Base deep tools still present.
      assert.equal(active.includes("write"), true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("never activates a reserved sa__ custom-subagent name via lockedModeExtraTools", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrModeState(undefined);

    const tempRoot = mkdtempSync(path.join(tmpdir(), "ampi-extra-sa-"));
    try {
      // A user tries to force a custom subagent into deep through the
      // scope-free settings extras path; even though sa__foo is a registered
      // tool, it must not become active (only the scoped provider may add it).
      writeProjectSettings(tempRoot, { lockedModeExtraTools: { all: ["my_tool", "sa__foo"] } });

      const { pi, calls, commands, handlers } = createMockPi({
        allTools: [
          { name: "read" }, { name: "bash" }, { name: "edit" }, { name: "write" },
          { name: "grep" }, { name: "find" }, { name: "my_tool" }, { name: "sa__foo" },
        ],
        setModelResult: true,
      });
      const { ctx } = createMockExtensionContext({
        cwd: tempRoot,
        models: [{ provider: "openai-codex", id: "gpt-5.6-sol" }],
        authenticated: true,
      });
      extension(pi);

      await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
      await commands.get("mode").handler("high", ctx);

      const active = calls.setActiveTools.at(-1);
      assert.equal(active.includes("my_tool"), true, "non-reserved extra still active");
      assert.equal(active.includes("sa__foo"), false, "reserved sa__ name is filtered out of settings extras");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("treats a missing extra tool as a non-fatal no-op (surfaced as missing, not active)", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrModeState(undefined);

    const tempRoot = mkdtempSync(path.join(tmpdir(), "ampi-extra-"));
    try {
      writeProjectSettings(tempRoot, { lockedModeExtraTools: { all: ["ghost_tool"] } });

      const { pi, calls, commands, handlers } = createMockPi({
        allTools: [
          { name: "read" }, { name: "bash" }, { name: "edit" }, { name: "write" },
          { name: "grep" }, { name: "find" }, { name: "ls" },
        ],
        setModelResult: true,
      });
      const { ctx } = createMockExtensionContext({
        cwd: tempRoot,
        models: [{ provider: "openai-codex", id: "gpt-5.6-sol" }],
        authenticated: true,
      });
      extension(pi);

      await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
      await commands.get("mode").handler("high", ctx);

      // Activation succeeded (deep base tools applied); ghost tool not active.
      const active = calls.setActiveTools.at(-1);
      assert.equal(active.includes("ghost_tool"), false);
      assert.equal(active.includes("write"), true);
      const state = runtime.getMmrModeState();
      assert.equal(state.mode, "high");
      assert.equal(state.missingTools.includes("ghost_tool"), true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("extra tools never satisfy the fail-closed zero-base-tools abort", async () => {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const runtime = await importRuntime();
    const previousState = { mode: "medium", displayName: "Smart", activeTools: ["read"], missingTools: [], deferredTools: [] };
    runtime.setMmrModeState(previousState);

    const tempRoot = mkdtempSync(path.join(tmpdir(), "ampi-extra-"));
    try {
      // The extra tool exists, but NONE of deep's base tools do.
      writeProjectSettings(tempRoot, { lockedModeExtraTools: { all: ["my_tool"] } });

      const { pi, calls, commands, handlers } = createMockPi({
        allTools: [{ name: "my_tool" }],
        setModelResult: true,
      });
      const { ctx, notifications } = createMockExtensionContext({
        cwd: tempRoot,
        models: [{ provider: "openai-codex", id: "gpt-5.6-sol" }],
        authenticated: true,
      });
      extension(pi);

      await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
      const setActiveBefore = calls.setActiveTools.length;
      await commands.get("mode").handler("high", ctx);

      // Deep activation aborts: no base tools resolved, extra must not rescue it.
      assert.equal(calls.setActiveTools.length, setActiveBefore, "no new setActiveTools after aborted deep");
      assert.equal(notifications.at(-1)?.level, "error");
      assert.match(notifications.at(-1)?.message, /no active tools/i);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
