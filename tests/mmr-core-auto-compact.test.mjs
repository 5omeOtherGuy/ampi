import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const MODELS = [
  { provider: "openai-codex", id: "gpt-5.4-mini", contextWindow: 400_000, maxTokens: 128_000 },
  { provider: "openai-codex", id: "gpt-5.5", contextWindow: 400_000, maxTokens: 128_000 },
  { provider: "openai-codex", id: "gpt-5.6-terra", contextWindow: 372_000, maxTokens: 128_000 },
  { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 372_000, maxTokens: 128_000 },
];
const WINDOW = 300_000;

async function importRuntime() {
  return import(pathToFileURL(path.join(getPreparedSourceRoot(), "extensions/ampi-core/runtime.ts")).href);
}

let tempRoot;
let project;
let previousHome;

beforeEach(async () => {
  // Settings come only from this temporary home and project, never the
  // developer's own Pi settings.
  tempRoot = mkdtempSync(path.join(tmpdir(), "ampi-auto-compact-"));
  project = path.join(tempRoot, "project");
  mkdirSync(path.join(tempRoot, "home"), { recursive: true });
  mkdirSync(path.join(project, ".pi"), { recursive: true });
  previousHome = process.env.HOME;
  process.env.HOME = path.join(tempRoot, "home");
  const runtime = await importRuntime();
  runtime.setMmrModeState(undefined);
  runtime.setMmrSubagentState(undefined);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(tempRoot, { recursive: true, force: true });
});

function writeProjectSettings(value) {
  writeFileSync(path.join(project, ".pi/settings.json"), JSON.stringify(value));
}

/** Load ampi-core, start a session and return a way to settle runs at a given usage. */
async function startSession({ piSettings, flags, mode, hasUI } = {}) {
  const extension = (await importSource("extensions/ampi-core/index.ts")).default;
  const usage = { tokens: 0, contextWindow: WINDOW };
  const mock = createMockExtensionContext({
    models: MODELS,
    cwd: project,
    ...(mode ? { mode } : {}),
    ...(hasUI === undefined ? {} : { hasUI }),
    getContextUsage: () => ({ ...usage, percent: usage.tokens === null ? null : (usage.tokens / usage.contextWindow) * 100 }),
  });
  const { pi, handlers, commands } = createMockPi({
    activeTools: ["read", "bash", "grep"],
    allTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    ...(piSettings ? { settings: piSettings } : {}),
    ...(flags ? { flags } : {}),
  });
  extension(pi);
  await handlers.get("session_start")({ type: "session_start", reason: "new" }, mock.ctx);

  async function settle(tokens, { aborted = false } = {}) {
    usage.tokens = tokens;
    await handlers.get("agent_settled")({ type: "agent_settled", aborted }, mock.ctx);
  }
  async function debugStatus() {
    await commands.get("ampi-status").handler("debug", mock.ctx);
    return mock.notifications.at(-1).message;
  }
  return { ...mock, commands, settle, debugStatus };
}

describe("ampi-core auto-compaction", () => {
  it("compacts once a settled run reaches 90% of the window, not below it", async () => {
    const session = await startSession();

    await session.settle(269_999);
    assert.equal(session.compactCalls.length, 0);

    await session.settle(270_000);
    assert.equal(session.compactCalls.length, 1);
    assert.equal(session.compactCalls[0].customInstructions, undefined);
  });

  it("compacts above the threshold and again after a finished compaction", async () => {
    const session = await startSession();

    await session.settle(290_000);
    assert.equal(session.compactCalls.length, 1);
    session.compactCalls[0].onComplete({ tokensBefore: 290_000, estimatedTokensAfter: 41_000 });

    await session.settle(285_000);
    assert.equal(session.compactCalls.length, 2);
  });

  it("does not start a second compaction while one is running", async () => {
    const session = await startSession();

    await session.settle(280_000);
    await session.settle(295_000);
    assert.equal(session.compactCalls.length, 1);
  });

  it("backs off after a failed compaction until the context grows past the failed size", async () => {
    const session = await startSession();

    await session.settle(280_000);
    session.compactCalls[0].onError(new Error("Nothing to compact (session too small)"));

    await session.settle(280_000);
    assert.equal(session.compactCalls.length, 1);

    await session.settle(280_001);
    assert.equal(session.compactCalls.length, 2);
  });

  it("skips runs whose token count is unknown and interrupted runs", async () => {
    const session = await startSession();

    await session.settle(null);
    await session.settle(299_000, { aborted: true });
    assert.equal(session.compactCalls.length, 0);
  });

  it("uses the threshold from ampiCore.autoCompact", async () => {
    writeProjectSettings({ ampiCore: { autoCompact: { threshold: 0.5 } } });
    const session = await startSession();

    await session.settle(149_999);
    assert.equal(session.compactCalls.length, 0);
    await session.settle(150_000);
    assert.equal(session.compactCalls.length, 1);
  });

  it("never compacts when ampiCore.autoCompact is false", async () => {
    writeProjectSettings({ ampiCore: { autoCompact: false } });
    const session = await startSession();

    await session.settle(299_000);
    assert.equal(session.compactCalls.length, 0);
    assert.match(await session.debugStatus(), /^ {2}Auto-compaction: off \(ampiCore\.autoCompact is false\)$/m);
  });

  it("respects Pi's own compaction.enabled = false", async () => {
    const session = await startSession({ piSettings: { compaction: { enabled: false } } });

    await session.settle(299_000);
    assert.equal(session.compactCalls.length, 0);
  });

  it("never compacts in free mode", async () => {
    const session = await startSession();
    await session.commands.get("mode").handler("free", session.ctx);

    await session.settle(299_000);
    assert.equal(session.compactCalls.length, 0);
    assert.match(await session.debugStatus(), /^ {2}Auto-compaction: off \(free mode\)$/m);
  });

  it("never compacts in print or json runs", async () => {
    const print = await startSession({ hasUI: false });
    await print.settle(299_000);
    assert.equal(print.compactCalls.length, 0);

    const json = await startSession({ hasUI: false, mode: "json" });
    await json.settle(299_000);
    assert.equal(json.compactCalls.length, 0);
  });

  it("never compacts in rpc sessions, whose clients may prompt right after agent_settled", async () => {
    const session = await startSession({ mode: "rpc" });
    await session.settle(299_000);
    assert.equal(session.compactCalls.length, 0);
  });

  it("never compacts in a subagent worker, even with a locked mode left in the runtime", async () => {
    await startSession();
    const runtime = await importRuntime();
    assert.equal(runtime.getMmrModeState()?.mode, "medium");

    const worker = await startSession({ flags: { "ampi-subagent": "finder" } });
    await worker.settle(299_000);
    assert.equal(worker.compactCalls.length, 0);
  });

  it("shows the threshold and the last auto-compaction in /ampi-status debug", async () => {
    const session = await startSession();
    const before = await session.debugStatus();
    assert.match(before, /^ {2}Auto-compaction: at 90% of the context window$/m);
    assert.match(before, /^ {2}Last auto-compaction: none$/m);

    await session.settle(281_000);
    session.compactCalls[0].onComplete({ tokensBefore: 281_000, estimatedTokensAfter: 42_000 });
    assert.match(
      await session.debugStatus(),
      /^ {2}Last auto-compaction: \d{4}-\d{2}-\d{2}T[\d:.]+Z, 281k -> 42k of 300k tokens$/m,
    );

    await session.settle(290_000);
    session.compactCalls[1].onError(new Error("Summary failed:\n  provider said no"));
    assert.match(
      await session.debugStatus(),
      /^ {2}Auto-compaction backoff: attempt at 290k tokens failed or was cancelled \(Summary failed: provider said no\); next try once the context grows past it$/m,
    );
  });

  it("reads ampiCore.autoCompact and warns on invalid values, keeping the default", async () => {
    const { loadMmrCoreSettings } = await importSource("extensions/ampi-core/settings.ts");
    const cases = [
      { settings: { ampiCore: { autoCompact: {} } }, expected: { threshold: 0.9 } },
      { settings: { ampiCore: { autoCompact: { threshold: 1 } } }, expected: { threshold: 1 } },
      { settings: { ampi: { core: { autoCompact: false } } }, expected: false },
      { settings: { ampiCore: { autoCompact: { threshold: 1.5 } } }, warns: true },
      { settings: { ampiCore: { autoCompact: { threshold: 0 } } }, warns: true },
      { settings: { ampiCore: { autoCompact: { threshold: -0.1 } } }, warns: true },
      { settings: { ampiCore: { autoCompact: { threshold: "0.9" } } }, warns: true },
      { settings: { ampiCore: { autoCompact: true } }, warns: true },
    ];
    for (const { settings, expected, warns } of cases) {
      writeProjectSettings(settings);
      const loaded = loadMmrCoreSettings(project, path.join(tempRoot, "home"));
      const label = JSON.stringify(settings);
      assert.deepEqual(loaded.settings.autoCompact, expected, label);
      if (warns) {
        assert.match(loaded.warnings.join("\n"), /Ignoring ampiCore\.autoCompact in .*settings\.json: expected false or/, label);
      } else {
        assert.deepEqual(loaded.warnings, [], label);
      }
    }
  });

  it("lets a project ampiCore.autoCompact replace the global one", async () => {
    const { loadMmrCoreSettings } = await importSource("extensions/ampi-core/settings.ts");
    mkdirSync(path.join(tempRoot, "home/.pi/agent"), { recursive: true });
    writeFileSync(
      path.join(tempRoot, "home/.pi/agent/settings.json"),
      JSON.stringify({ ampiCore: { autoCompact: false } }),
    );
    writeProjectSettings({ ampiCore: { autoCompact: { threshold: 0.75 } } });

    const loaded = loadMmrCoreSettings(project, path.join(tempRoot, "home"));
    assert.deepEqual(loaded.settings.autoCompact, { threshold: 0.75 });
  });
});
