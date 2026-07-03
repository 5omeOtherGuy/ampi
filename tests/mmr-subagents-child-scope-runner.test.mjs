import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const RUNNER = "extensions/ampi-workers/runner.ts";
const INVOCATION = "extensions/ampi-workers/runner-invocation.ts";

describe("buildMmrWorkerArgs: childExtensionScope", () => {
  it("prepends --no-extensions and -e <path> before the mode flags", async () => {
    const mod = await importSource(INVOCATION);
    const args = mod.buildMmrWorkerArgs({
      prompt: "do it",
      profileName: "finder",
      childExtensionScope: ["/pkg/src/extensions/ampi-core/index.ts", "/ext/provider/index.ts"],
    });
    assert.deepEqual(args.slice(0, 5), [
      "--no-extensions",
      "-e",
      "/pkg/src/extensions/ampi-core/index.ts",
      "-e",
      "/ext/provider/index.ts",
    ]);
    // Mode flags and profile still follow, unchanged.
    assert.ok(args.includes("--mode"));
    assert.ok(args.includes("--no-session"));
    assert.deepEqual(
      args.slice(5, 9),
      ["--mode", "json", "-p", "--no-session"],
    );
    assert.equal(args[args.length - 1], "Task: do it");
  });

  it("omits the restriction flags when no scope (full-discovery default)", async () => {
    const mod = await importSource(INVOCATION);
    const args = mod.buildMmrWorkerArgs({ prompt: "x", profileName: "finder" });
    assert.equal(args.includes("--no-extensions"), false);
    assert.equal(args.includes("-e"), false);
    assert.deepEqual(args.slice(0, 4), ["--mode", "json", "-p", "--no-session"]);
  });

  it("omits the restriction flags for an empty scope array", async () => {
    const mod = await importSource(INVOCATION);
    const args = mod.buildMmrWorkerArgs({ prompt: "x", profileName: "finder", childExtensionScope: [] });
    assert.equal(args.includes("--no-extensions"), false);
  });
});

describe("shouldRetryMmrChildWithFullDiscovery", () => {
  const base = {
    spawnError: undefined,
    subagentActivationError: undefined,
    aborted: false,
    exitCode: 0,
    finalOutput: "",
    truncatedFinalOutput: "",
    agentStarted: true,
  };
  const scope = ["/pkg/src/extensions/ampi-core/index.ts"];

  it("never retries an unrestricted run", async () => {
    const mod = await importSource(RUNNER);
    assert.equal(
      mod.shouldRetryMmrChildWithFullDiscovery({ ...base, subagentActivationError: "tools.mismatch" }, undefined),
      false,
    );
    assert.equal(
      mod.shouldRetryMmrChildWithFullDiscovery({ ...base, subagentActivationError: "tools.mismatch" }, []),
      false,
    );
  });

  it("retries a restricted run with an activation error", async () => {
    const mod = await importSource(RUNNER);
    assert.equal(
      mod.shouldRetryMmrChildWithFullDiscovery({ ...base, subagentActivationError: "model.no-route" }, scope),
      true,
    );
  });

  it("retries a restricted 'Model not found' shape (non-zero exit before the agent loop, no output)", async () => {
    const mod = await importSource(RUNNER);
    assert.equal(
      mod.shouldRetryMmrChildWithFullDiscovery({ ...base, exitCode: 1, agentStarted: false }, scope),
      true,
    );
  });

  it("does not retry aborts, spawn errors, in-loop failures, or clean empty output", async () => {
    const mod = await importSource(RUNNER);
    assert.equal(mod.shouldRetryMmrChildWithFullDiscovery({ ...base, aborted: true, exitCode: 1, agentStarted: false }, scope), false);
    assert.equal(mod.shouldRetryMmrChildWithFullDiscovery({ ...base, spawnError: "spawn ENOENT", exitCode: 1, agentStarted: false }, scope), false);
    // exited non-zero but the agent loop DID run -> genuine worker error, not restriction.
    assert.equal(mod.shouldRetryMmrChildWithFullDiscovery({ ...base, exitCode: 1, agentStarted: true }, scope), false);
    // clean exit, empty output, loop ran -> empty-output, not restriction.
    assert.equal(mod.shouldRetryMmrChildWithFullDiscovery({ ...base, exitCode: 0, agentStarted: true }, scope), false);
    // non-zero exit before loop but usable output present -> keep it.
    assert.equal(
      mod.shouldRetryMmrChildWithFullDiscovery(
        { ...base, exitCode: 1, agentStarted: false, finalOutput: "answer", truncatedFinalOutput: "answer" },
        scope,
      ),
      false,
    );
  });
});

describe("createMmrSubagentRunnerFromRunWorker: restricted retry", () => {
  const restrictedFail = {
    messages: [],
    finalOutput: "",
    truncatedFinalOutput: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    trail: [],
    prompt: "p",
    cwd: "/repo",
    command: "pi",
    args: [],
    exitCode: 1,
    signal: null,
    stderr: 'Error: Model "antigravity/x" not found.',
    aborted: false,
    outputTruncated: false,
    ignoredJsonLines: 0,
    agentStarted: false,
  };
  const ok = { ...restrictedFail, exitCode: 0, agentStarted: true, finalOutput: "done", truncatedFinalOutput: "done" };

  it("re-runs once with childExtensionScope cleared after a restricted activation/model failure", async () => {
    const mod = await importSource(RUNNER);
    const calls = [];
    const fakeRunWorker = async (opts) => {
      calls.push(opts.childExtensionScope);
      return calls.length === 1 ? { ...restrictedFail } : { ...ok };
    };
    const runner = mod.createMmrSubagentRunnerFromRunWorker(fakeRunWorker);
    const result = await runner.run({
      profileName: "finder",
      prompt: "p",
      cwd: "/repo",
      childExtensionScope: ["/pkg/src/extensions/ampi-core/index.ts"],
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], ["/pkg/src/extensions/ampi-core/index.ts"]);
    assert.equal(calls[1], undefined, "retry drops the scope -> full discovery");
    assert.equal(result.finalOutput, "done");
  });

  it("does not retry when the restricted run succeeds", async () => {
    const mod = await importSource(RUNNER);
    let count = 0;
    const fakeRunWorker = async () => {
      count += 1;
      return { ...ok };
    };
    const runner = mod.createMmrSubagentRunnerFromRunWorker(fakeRunWorker);
    await runner.run({
      profileName: "finder",
      prompt: "p",
      cwd: "/repo",
      childExtensionScope: ["/pkg/src/extensions/ampi-core/index.ts"],
    });
    assert.equal(count, 1);
  });

  it("does not retry an unrestricted run that fails", async () => {
    const mod = await importSource(RUNNER);
    let count = 0;
    const fakeRunWorker = async () => {
      count += 1;
      return { ...restrictedFail };
    };
    const runner = mod.createMmrSubagentRunnerFromRunWorker(fakeRunWorker);
    await runner.run({ profileName: "finder", prompt: "p", cwd: "/repo" });
    assert.equal(count, 1);
  });
});
