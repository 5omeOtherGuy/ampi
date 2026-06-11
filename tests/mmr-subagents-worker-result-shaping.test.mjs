// Focused unit tests for the internal worker-result-shaping helper used by
// finder, oracle, Task, and librarian. Pins the small contract: the
// helper returns common spawned-subagent details fields without the
// `worker` discriminator, places typed placeholders for in-flight
// progress, and propagates spawnError / subagentActivationError from
// completed worker results so the renderer keeps showing a
// deterministic spawn-failed line.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const HELPER_MODULE = "extensions/mmr-workers/worker-result-shaping.ts";

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function makeSnapshot(overrides = {}) {
  return {
    messages: [],
    finalOutput: "",
    truncatedFinalOutput: "",
    usage: emptyUsage(),
    trail: [],
    ...overrides,
  };
}

function makeResult(overrides = {}) {
  return {
    messages: [],
    finalOutput: "",
    truncatedFinalOutput: "",
    usage: emptyUsage(),
    trail: [],
    prompt: "",
    cwd: "/tmp/p",
    command: "pi",
    args: ["--mode", "json"],
    exitCode: 0,
    signal: null,
    stderr: "",
    aborted: false,
    outputTruncated: false,
    ignoredJsonLines: 0,
    agentStarted: true,
    ...overrides,
  };
}

describe("progressTextOrPlaceholder", () => {
  it("returns the placeholder when no partial output is available", async () => {
    const { progressTextOrPlaceholder } = await importSource(HELPER_MODULE);
    assert.equal(
      progressTextOrPlaceholder(makeSnapshot(), "finder: searching codebase…"),
      "finder: searching codebase…",
    );
  });

  it("returns the placeholder when partial output is whitespace-only", async () => {
    const { progressTextOrPlaceholder } = await importSource(HELPER_MODULE);
    assert.equal(
      progressTextOrPlaceholder(
        makeSnapshot({ finalOutput: "   \n\t" }),
        "oracle: consulting…",
      ),
      "oracle: consulting…",
    );
  });

  it("prefers truncatedFinalOutput over finalOutput", async () => {
    const { progressTextOrPlaceholder } = await importSource(HELPER_MODULE);
    assert.equal(
      progressTextOrPlaceholder(
        makeSnapshot({ finalOutput: "full", truncatedFinalOutput: "truncated" }),
        "Task: worker running…",
      ),
      "truncated",
    );
  });

  it("falls back to finalOutput when truncatedFinalOutput is empty", async () => {
    const { progressTextOrPlaceholder } = await importSource(HELPER_MODULE);
    assert.equal(
      progressTextOrPlaceholder(
        makeSnapshot({ finalOutput: "partial answer" }),
        "librarian: researching repositories…",
      ),
      "partial answer",
    );
  });
});

describe("buildSpawnedProgressDetailsBase", () => {
  it("emits the in-flight placeholders for runner-observable fields", async () => {
    const { buildSpawnedProgressDetailsBase } = await importSource(HELPER_MODULE);
    const snapshot = makeSnapshot({ usage: { ...emptyUsage(), input: 12 } });
    const base = buildSpawnedProgressDetailsBase({
      snapshot,
      cwd: "/abs/project",
      workerTools: ["read", "grep"],
    });
    assert.equal(base.exitCode, null);
    assert.equal(base.signal, null);
    assert.equal(base.aborted, false);
    assert.equal(base.outputTruncated, false);
    assert.equal(base.ignoredJsonLines, 0);
    assert.equal(base.stderr, "");
    assert.equal(base.command, "");
    assert.deepEqual(base.args, []);
    assert.equal(base.cwd, "/abs/project");
    assert.deepEqual([...base.workerTools], ["read", "grep"]);
    assert.deepEqual(base.trail, []);
    assert.equal(base.usage.input, 12);
    // The `worker` discriminator is intentionally not part of the
    // shared helper output; callers add it locally.
    assert.equal("worker" in base, false);
  });

  it("propagates resolvedModel, contextWindow, reportedModel, stopReason, and errorMessage when set", async () => {
    const { buildSpawnedProgressDetailsBase } = await importSource(HELPER_MODULE);
    const base = buildSpawnedProgressDetailsBase({
      snapshot: makeSnapshot({
        model: "anthropic/claude-haiku-4-5",
        stopReason: "end_turn",
        errorMessage: "in-flight warning",
      }),
      cwd: "/p",
      workerTools: ["read"],
      resolvedModel: "openai-codex/gpt-5.4-mini",
      contextWindow: 200_000,
    });
    assert.equal(base.model, "openai-codex/gpt-5.4-mini");
    assert.equal(base.contextWindow, 200_000);
    assert.equal(base.reportedModel, "anthropic/claude-haiku-4-5");
    assert.equal(base.stopReason, "end_turn");
    assert.equal(base.errorMessage, "in-flight warning");
  });

  it("omits optional fields when not set", async () => {
    const { buildSpawnedProgressDetailsBase } = await importSource(HELPER_MODULE);
    const base = buildSpawnedProgressDetailsBase({
      snapshot: makeSnapshot(),
      cwd: "/p",
      workerTools: ["read"],
    });
    for (const key of ["model", "contextWindow", "reportedModel", "stopReason", "errorMessage"]) {
      assert.equal(key in base, false, `progress base must not declare ${key} when unset`);
    }
  });

  it("uses an explicit trail override (e.g. sanitized trail) instead of the snapshot trail", async () => {
    const { buildSpawnedProgressDetailsBase } = await importSource(HELPER_MODULE);
    const snapshot = makeSnapshot({ trail: [{ type: "assistant", text: "raw" }] });
    const sanitized = [{ type: "assistant", text: "sanitized" }];
    const base = buildSpawnedProgressDetailsBase({
      snapshot,
      cwd: "/p",
      workerTools: ["read"],
      trail: sanitized,
    });
    assert.deepEqual(base.trail, sanitized);
  });
});

describe("buildSpawnedFinalDetailsBase", () => {
  it("forwards exit / signal / aborted / usage / stderr / command / args / trail verbatim", async () => {
    const { buildSpawnedFinalDetailsBase } = await importSource(HELPER_MODULE);
    const result = makeResult({
      exitCode: 0,
      signal: null,
      aborted: false,
      outputTruncated: true,
      ignoredJsonLines: 3,
      usage: { ...emptyUsage(), input: 7, output: 11 },
      stderr: "warn line\n",
      command: "/abs/pi",
      args: ["--mode", "json", "-p", "--no-session"],
      trail: [{ type: "assistant", text: "answer" }],
    });
    const base = buildSpawnedFinalDetailsBase({
      result,
      cwd: "/abs/project",
      workerTools: ["web_search", "read_web_page"],
    });
    assert.equal(base.exitCode, 0);
    assert.equal(base.outputTruncated, true);
    assert.equal(base.ignoredJsonLines, 3);
    assert.equal(base.usage.input, 7);
    assert.equal(base.usage.output, 11);
    assert.equal(base.stderr, "warn line\n");
    assert.equal(base.command, "/abs/pi");
    assert.deepEqual(base.args, ["--mode", "json", "-p", "--no-session"]);
    assert.deepEqual(base.trail, [{ type: "assistant", text: "answer" }]);
    assert.equal(base.cwd, "/abs/project");
    assert.deepEqual([...base.workerTools], ["web_search", "read_web_page"]);
    assert.equal("worker" in base, false);
  });

  it("propagates resolvedModel, contextWindow, reportedModel, stopReason, errorMessage when set", async () => {
    const { buildSpawnedFinalDetailsBase } = await importSource(HELPER_MODULE);
    const base = buildSpawnedFinalDetailsBase({
      result: makeResult({
        model: "anthropic/claude-haiku-4-5",
        stopReason: "max_tokens",
        errorMessage: "explained",
      }),
      cwd: "/p",
      workerTools: ["read"],
      resolvedModel: "openai-codex/gpt-5.4-mini",
      contextWindow: 128_000,
    });
    assert.equal(base.model, "openai-codex/gpt-5.4-mini");
    assert.equal(base.contextWindow, 128_000);
    assert.equal(base.reportedModel, "anthropic/claude-haiku-4-5");
    assert.equal(base.stopReason, "max_tokens");
    assert.equal(base.errorMessage, "explained");
  });

  it("propagates spawnError verbatim (renderer prefers details.spawnError over errorMessage)", async () => {
    const { buildSpawnedFinalDetailsBase } = await importSource(HELPER_MODULE);
    const base = buildSpawnedFinalDetailsBase({
      result: makeResult({
        exitCode: 1,
        spawnError: "spawn ENOENT",
        errorMessage: "spawn ENOENT",
      }),
      cwd: "/p",
      workerTools: ["read"],
    });
    assert.equal(base.spawnError, "spawn ENOENT");
    assert.equal(base.errorMessage, "spawn ENOENT");
  });

  it("propagates subagentActivationError verbatim", async () => {
    const { buildSpawnedFinalDetailsBase } = await importSource(HELPER_MODULE);
    const base = buildSpawnedFinalDetailsBase({
      result: makeResult({
        exitCode: 1,
        subagentActivationError: "tools.mismatch: missing read_session",
      }),
      cwd: "/p",
      workerTools: ["read"],
    });
    assert.equal(base.subagentActivationError, "tools.mismatch: missing read_session");
  });

  it("omits optional fields when not set", async () => {
    const { buildSpawnedFinalDetailsBase } = await importSource(HELPER_MODULE);
    const base = buildSpawnedFinalDetailsBase({
      result: makeResult(),
      cwd: "/p",
      workerTools: ["read"],
    });
    for (const key of [
      "model",
      "contextWindow",
      "reportedModel",
      "stopReason",
      "errorMessage",
      "subagentActivationError",
      "spawnError",
    ]) {
      assert.equal(key in base, false, `final base must not declare ${key} when unset`);
    }
  });

  it("uses an explicit trail override (e.g. finder's sanitized trail) instead of the result trail", async () => {
    const { buildSpawnedFinalDetailsBase } = await importSource(HELPER_MODULE);
    const result = makeResult({ trail: [{ type: "assistant", text: "raw" }] });
    const sanitized = [{ type: "assistant", text: "sanitized" }];
    const base = buildSpawnedFinalDetailsBase({
      result,
      cwd: "/p",
      workerTools: ["read"],
      trail: sanitized,
    });
    assert.deepEqual(base.trail, sanitized);
  });
});
