// The core worker-host seam (ampi-core/worker-host.ts): globalThis-anchored,
// replace-by-id registration; fail-closed consumers when no host is
// registered; exactly the four seam capabilities. Also pins the contract
// presets and the versioned worker-run envelope helpers.

import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const HOST_MODULE = "extensions/ampi-core/worker-host.ts";
const CONTRACT_MODULE = "extensions/ampi-core/worker-contract.ts";
const ENVELOPE_MODULE = "extensions/ampi-workers/worker-run-envelope.ts";

function makeHost(overrides = {}) {
  return {
    registerWorkerBinding: () => ({ tool: {}, prepareRun: () => ({ ok: false, result: {} }) }),
    prepareWorkerRun: () => ({ ok: false, result: {} }),
    runWorker: async () => ({}),
    defaultWorkerRenderers: { renderCall: () => undefined, renderResult: () => undefined },
    ...overrides,
  };
}

describe("core worker-host seam", () => {
  beforeEach(async () => {
    const { __resetMmrWorkerHostForTests } = await importSource(HOST_MODULE);
    __resetMmrWorkerHostForTests();
  });

  it("registers, resolves, and replaces the host by id (globalThis-anchored)", async () => {
    const { registerMmrWorkerHost, getMmrWorkerHost } = await importSource(HOST_MODULE);
    assert.equal(getMmrWorkerHost(), undefined);
    const first = makeHost();
    registerMmrWorkerHost("ampi-workers", first);
    assert.equal(getMmrWorkerHost(), first);
    const second = makeHost();
    registerMmrWorkerHost("ampi-workers", second);
    assert.equal(getMmrWorkerHost(), second, "re-registration with the same id replaces the host");
    const key = Object.keys(globalThis).find((k) => k.includes("worker_host"));
    assert.ok(key, "the host registration must be anchored on globalThis");
  });

  it("fails closed when no host is registered", async () => {
    const { requireMmrWorkerHost, registerMmrWorkerBinding, MmrWorkerHostUnavailableError } =
      await importSource(HOST_MODULE);
    assert.throws(() => requireMmrWorkerHost(), MmrWorkerHostUnavailableError);
    assert.throws(() => registerMmrWorkerBinding({ spec: {}, exposure: ["tool"] }), MmrWorkerHostUnavailableError);
  });

  it("rejects an empty host id", async () => {
    const { registerMmrWorkerHost } = await importSource(HOST_MODULE);
    assert.throws(() => registerMmrWorkerHost("  ", makeHost()), /non-empty id/);
  });

  it("routes registerMmrWorkerBinding through the registered host", async () => {
    const { registerMmrWorkerHost, registerMmrWorkerBinding } = await importSource(HOST_MODULE);
    const seen = [];
    registerMmrWorkerHost("ampi-workers", makeHost({
      registerWorkerBinding: (binding) => {
        seen.push(binding);
        return { tool: { name: binding.spec.toolName }, prepareRun: () => ({ ok: false, result: {} }) };
      },
    }));
    const registered = registerMmrWorkerBinding({
      spec: { toolName: "sa__example" },
      exposure: ["tool", "background"],
      contractPreset: "strict-delegated",
      paramsHint: "{task}",
      promptParamKey: "task",
    });
    assert.equal(registered.tool.name, "sa__example");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].contractPreset, "strict-delegated");
  });
});

describe("worker contract presets", () => {
  it("pins the two behavior-named presets and their knobs", async () => {
    const { MMR_WORKER_CONTRACT_PRESETS } = await importSource(CONTRACT_MODULE);
    assert.deepEqual(Object.keys(MMR_WORKER_CONTRACT_PRESETS).sort(), ["degrading-advisory", "strict-delegated"]);
    assert.deepEqual(MMR_WORKER_CONTRACT_PRESETS["degrading-advisory"], {
      paramsFailure: "throw-to-host",
      resolutionFailure: "degrade",
      mirrorWorkerTools: false,
      detailsWorkerTools: "profile-constant",
      progressModelBinding: "per-attempt",
      runError: "throw-to-host",
    });
    assert.deepEqual(MMR_WORKER_CONTRACT_PRESETS["strict-delegated"], {
      paramsFailure: "structured",
      resolutionFailure: "fail-closed",
      mirrorWorkerTools: true,
      detailsWorkerTools: "invocation",
      progressModelBinding: "initial",
      runError: "structured",
    });
  });
});

describe("worker-run envelope", () => {
  it("builds a v1 envelope and reads it back off a dual-written details object", async () => {
    const { buildWorkerRunEnvelope, readWorkerRunEnvelope, attachWorkerRunEnvelope } =
      await importSource(ENVELOPE_MODULE);
    const envelope = buildWorkerRunEnvelope({
      profileName: "finder",
      toolName: "finder",
      agent: "finder",
      runMode: "blocking",
      status: "succeeded",
      terminalOutcome: "success",
      workerTools: ["grep", "find", "read"],
      description: "Find call sites",
      sessionKey: "S",
      taskId: "t1",
      resolvedModel: "prov/model-x",
    });
    assert.equal(envelope.kind, "worker-run");
    assert.equal(envelope.version, 1);
    const legacy = { worker: "ampi-workers.finder", model: "prov/model-x", exitCode: 0 };
    const details = attachWorkerRunEnvelope(legacy, envelope);
    // Dual-write: legacy fields intact, envelope readable.
    assert.equal(details.worker, "ampi-workers.finder");
    assert.equal(details.exitCode, 0);
    const read = readWorkerRunEnvelope(details);
    assert.ok(read, "envelope must be readable off the dual-written details");
    assert.equal(read.run.agent, "finder");
    assert.equal(read.run.runMode, "blocking");
    assert.equal(read.run.status, "succeeded");
    assert.equal(read.run.terminalOutcome, "success");
    assert.deepEqual(read.run.workerTools, ["grep", "find", "read"]);
  });

  it("returns undefined for legacy payloads, unknown versions, and malformed envelopes", async () => {
    const { readWorkerRunEnvelope } = await importSource(ENVELOPE_MODULE);
    assert.equal(readWorkerRunEnvelope(undefined), undefined);
    assert.equal(readWorkerRunEnvelope({ worker: "ampi-workers.finder" }), undefined);
    assert.equal(readWorkerRunEnvelope({ kind: "worker-run", version: 2, run: {} }), undefined);
    assert.equal(readWorkerRunEnvelope({ kind: "worker-run", version: 1, run: { profileName: "x" } }), undefined);
    assert.equal(
      readWorkerRunEnvelope({
        kind: "worker-run",
        version: 1,
        run: { profileName: "x", toolName: "x", agent: "x", runMode: "sideways", status: "running" },
      }),
      undefined,
    );
  });
});

describe("worker-host exposure gating (ampi-workers host impl)", () => {
  it("prepareWorkerRun fails closed when the run mode is outside the binding's exposure", async () => {
    const { __resetMmrWorkerHostForTests, getMmrWorkerHost } = await importSource(HOST_MODULE);
    const { registerMmrWorkersWorkerHost } = await importSource("extensions/ampi-workers/worker-host-impl.ts");
    __resetMmrWorkerHostForTests();
    registerMmrWorkersWorkerHost({ getAllTools: () => [], getActiveTools: () => [], getCommands: () => [] });
    const host = getMmrWorkerHost();
    host.registerWorkerBinding({
      spec: {
        toolName: "sa__gated",
        profileName: "sa__gated",
        description: "d",
        promptSnippet: "s",
        promptGuidelines: [],
        parameters: { type: "object" },
        progressPlaceholder: "p",
        coerceParams: (raw) => raw,
        resolveInvocation: () => ({ ok: true, workerTools: [] }),
        resolutionFailure: "fail-closed",
        resolutionFailureResult: () => ({ content: [], details: {} }),
        mirrorWorkerTools: false,
        detailsWorkerTools: "profile-constant",
        workerToolsConstant: [],
        progressModelBinding: "initial",
        describeRun: () => ({ description: "d", displayPrompt: "p" }),
        buildUserPrompt: () => "p",
        assembleSystemPrompt: () => "sys",
        candidatePreferences: () => [],
        buildProgressDetails: () => ({}),
        buildFinalDetails: () => ({}),
        buildFinalContent: () => "",
      },
      exposure: ["tool"],
      contractPreset: "strict-delegated",
      paramsHint: "{task}",
      promptParamKey: "task",
    });
    assert.throws(
      () => host.prepareWorkerRun({ agent: "sa__gated", rawParams: {}, ctx: { cwd: "/repo" }, runMode: "internal" }),
      /does not expose the "internal" surface/,
    );
    assert.throws(
      () => host.prepareWorkerRun({ agent: "sa__gated", rawParams: {}, ctx: { cwd: "/repo" }, runMode: "background" }),
      /does not expose the "background" surface/,
    );
    const ok = host.prepareWorkerRun({ agent: "sa__gated", rawParams: {}, ctx: { cwd: "/repo" }, runMode: "blocking" });
    assert.equal(ok.ok, true, "the declared exposure surface still prepares");
  });
});
