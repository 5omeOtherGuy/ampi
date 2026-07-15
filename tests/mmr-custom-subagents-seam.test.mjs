// Slice 3 of the subagent unification: custom Markdown subagents run on the
// shared worker-tool factory THROUGH the core worker-host seam.
//
// Pinned here:
//   1. ampi-custom-subagents has ZERO direct ampi-workers imports (the #212
//      boundary; consumption goes through ampi-core only).
//   2. A blocking sa__* run registers in the async-task registry (board and
//      widget visibility — previously invisible).
//   3. A seam-registered custom subagent is offered and dispatched by the
//      background surface (start_task) through the SAME factory preparer.
//   4. Custom workers never inherit the shared model-fallback wrapper:
//      a failing run spawns exactly once (modelFallback: "disabled").
//   5. The blocking result carries the dual-written worker-run envelope.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const repoRoot = path.resolve(import.meta.dirname, "..");
const CUSTOM_RUNTIME_MODULE = "extensions/ampi-custom-subagents/custom-runtime.ts";
const CUSTOM_LOADER_MODULE = "extensions/ampi-custom-subagents/custom-loader.ts";
const HOST_IMPL_MODULE = "extensions/ampi-workers/framework/worker-host-impl.ts";
const REGISTRY_MODULE = "extensions/ampi-workers/background/async-task-registry.ts";

beforeEach(async () => {
  const { clearMmrDynamicSubagentProfiles } = await importSource("extensions/ampi-core/subagent-profiles.ts");
  const { clearMmrSubagentPromptBuilders } = await importSource("extensions/ampi-core/subagent-prompt-assembly.ts");
  const { clearMmrDynamicBackgroundAgents } = await importSource("extensions/ampi-workers/framework/worker-binding-registry.ts");
  clearMmrDynamicSubagentProfiles();
  clearMmrSubagentPromptBuilders();
  clearMmrDynamicBackgroundAgents();
});

function makeWorkerResult(overrides = {}) {
  return {
    messages: [],
    finalOutput: "custom answer",
    truncatedFinalOutput: "custom answer",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    trail: [],
    prompt: "",
    cwd: "/repo",
    command: "pi",
    args: [],
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

function makeRegistryStub(models) {
  return {
    getAll: () => models,
    getAvailable: () => models,
    find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
    hasConfiguredAuth: () => true,
  };
}

async function makeDefinition() {
  const { parseMmrCustomSubagentMarkdown } = await importSource(CUSTOM_LOADER_MODULE);
  return parseMmrCustomSubagentMarkdown({
    filePath: path.join("/repo", ".pi", "subagents", "writer.md"),
    markdown: [
      "---",
      "type: subagent",
      "name: Seam Writer",
      "description: Writes through the seam.",
      "model: openai-codex/gpt-5.5",
      "tools: read",
      "background: true",
      "---",
      "Write.",
    ].join("\n"),
  });
}

async function setup({ runner, taskIds = ["c1", "c2"] } = {}) {
  const { registerMmrWorkersWorkerHost } = await importSource(HOST_IMPL_MODULE);
  const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
  const { registerMmrCustomSubagentDefinition } = await importSource(CUSTOM_RUNTIME_MODULE);
  const { pi, tools } = createMockPi({ activeTools: ["read"], allTools: ["read"] });
  registerMmrWorkersWorkerHost(pi);
  const definition = await makeDefinition();
  registerMmrCustomSubagentDefinition(pi, definition, { runner });
  let next = 0;
  const registry = createMmrAsyncTaskRegistry({ idFactory: () => taskIds[next++] ?? `c${next}` });
  return { pi, tools, registry, definition };
}

const CTX = (registry) => ({
  cwd: "/repo",
  modelRegistry: makeRegistryStub([{ provider: "openai-codex", id: "gpt-5.5", contextWindow: 1234 }]),
  ...(registry ? {} : {}),
});

describe("custom subagents through the worker-host seam", () => {
  it("has zero direct ampi-workers imports (boundary pinned)", () => {
    const dir = path.join(repoRoot, "src", "extensions", "ampi-custom-subagents");
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".ts")) continue;
      const source = readFileSync(path.join(dir, file), "utf8");
      assert.ok(
        !source.includes("../ampi-workers/"),
        `${file} must not import from ampi-workers (found a direct import edge)`,
      );
    }
  });

  it("registers a blocking sa__* run in the async-task registry (board visibility)", async () => {
    let release;
    const runner = {
      run: (options) =>
        new Promise((resolve) => {
          release = () => resolve(makeWorkerResult({ prompt: options.prompt }));
        }),
    };
    const { tools } = await setup({ runner });
    const tool = tools.get("sa__seam_writer");
    assert.ok(tool, "the sa__ tool must be registered");
    // Inject a deterministic registry through the process singleton partition:
    // blocking factory runs resolve their session key from ctx (cwd fallback).
    const { getMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const registry = getMmrAsyncTaskRegistry();
    const sessionKey = "cwd:/repo";
    const before = registry.listTasks(sessionKey).counts.active;
    const pending = tool.execute("call-1", { task: "write the tests" }, undefined, undefined, CTX());
    const board = registry.listTasks(sessionKey);
    assert.equal(board.counts.active, before + 1, "a blocking sa__ run is a live board row");
    const row = board.active.find((entry) => entry.agent === "sa__seam_writer");
    assert.ok(row, "the board row carries the sa__ agent name");
    assert.equal(row.runMode, "blocking");
    assert.equal(row.description, "sa__seam_writer: write the tests");
    release();
    const result = await pending;
    assert.equal(result.content[0].text, "custom answer");
    // Envelope dual-write on the projected final details.
    assert.equal(result.details.kind, "worker-run");
    assert.equal(result.details.run.agent, "sa__seam_writer");
    assert.equal(result.details.run.runMode, "blocking");
    assert.equal(result.details.run.status, "succeeded");
    // Legacy details intact.
    assert.equal(result.details.worker, "ampi-custom-subagents.sa__seam_writer");
    assert.deepEqual(result.details.workerTools, ["read"]);
  });

  it("is offered and dispatched by the background surface through the factory preparer", async () => {
    const runCalls = [];
    const runner = { run: async (options) => { runCalls.push(options); return makeWorkerResult(); } };
    const { registry } = await setup({ runner });
    const { listMmrBackgroundAgents, getMmrBackgroundAgent } = await importSource(
      "extensions/ampi-workers/framework/worker-binding-registry.ts",
    );
    const agents = listMmrBackgroundAgents().map((descriptor) => descriptor.agent);
    assert.ok(agents.includes("sa__seam_writer"), `start_task must offer the custom worker (got: ${agents.join(", ")})`);
    const descriptor = getMmrBackgroundAgent("sa__seam_writer");
    const prep = descriptor.start.prepareRun({}, { task: "background write" }, CTX(), { toolCallId: "t1" });
    assert.equal(prep.ok, true, "the seam preparer must produce a registry-ready run");
    assert.equal(prep.prepared.agent, "sa__seam_writer");
    assert.equal(prep.prepared.displayPrompt, "background write");
    const outcome = await prep.prepared.run({ signal: new AbortController().signal, onProgress: () => {} });
    assert.equal(runCalls.length, 1);
    assert.equal(runCalls[0].profileName, "sa__seam_writer");
    assert.equal(outcome.finalOutput, "custom answer");
    void registry;
  });

  it("never inherits the shared model fallback: a failing run spawns exactly once", async () => {
    const runCalls = [];
    const runner = {
      run: async (options) => {
        runCalls.push(options);
        return makeWorkerResult({ exitCode: 1, finalOutput: "", truncatedFinalOutput: "", errorMessage: "boom" });
      },
    };
    const { tools } = await setup({ runner });
    const result = await tools.get("sa__seam_writer").execute(
      "call-1",
      { task: "fail please" },
      undefined,
      undefined,
      CTX(),
    );
    assert.equal(runCalls.length, 1, "modelFallback is pinned disabled: exactly one spawn, no fallback retry");
    assert.match(result.content[0].text, /worker failed/);
    assert.equal(result.details.status, "worker-error");
    assert.equal(result.details.run.status, "failed");
  });
});
