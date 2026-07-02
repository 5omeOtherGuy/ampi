// Canonical subagent runner API.
//
// Pins the `runMmrSubagentWorker` contract. This is the only public
// entry point for spawning a subagent worker; the previous
// `runMmrWorker` compat wrapper has been retired. The API:
//
//   runMmrSubagentWorker({
//     profileName,            // required: --mmr-subagent <name>
//     prompt,                 // required: positional Pi prompt
//     cwd,                    // required
//     parentMode?,            // optional: --mmr-parent-mode
//     model?,                 // optional: --model
//     tools?,                 // optional: --tools
//     systemPrompt?,          // optional: --append-system-prompt
//     outputByteLimit?,
//     ...runner controls
//   }, deps?)
//
// Behavior pinned here:
//
//   - profileName is required and forwarded as `--mmr-subagent <name>`.
//   - missing profileName fails closed before any spawn attempt.
//   - tools / model / systemPrompt are forwarded to the Pi worker
//     invocation.
//   - the activation-failure marker on stderr surfaces as
//     `result.subagentActivationError` and `errorMessage`.
//   - the prompt file is removed after the child process exits.
//   - the progress/result shape (messages, finalOutput, usage,
//     truncatedFinalOutput, etc.) is stable.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const RUNNER_MODULE = "extensions/mmr-workers/runner.ts";

class MockProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
    this.killCalls = [];
  }
  kill(signal) {
    this.killed = true;
    this.killCalls.push(signal);
    return true;
  }
  close(code = 0, signal = null) {
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
  writeStderr(text) {
    this.stderr.write(text);
  }
}

function makeSpawnMock() {
  const calls = [];
  const processes = [];
  const spawn = (command, args, options) => {
    const proc = new MockProcess();
    calls.push({ command, args, options, proc });
    processes.push(proc);
    return proc;
  };
  return { spawn, calls, processes };
}

describe("runMmrSubagentWorker — public API", () => {
  it("exports runMmrSubagentWorker as a function", async () => {
    const mod = await importSource(RUNNER_MODULE);
    assert.equal(typeof mod.runMmrSubagentWorker, "function");
  });

  it("does not export the retired runMmrWorker compatibility wrapper", async () => {
    const mod = await importSource(RUNNER_MODULE);
    assert.equal(mod.runMmrWorker, undefined);
  });
});

describe("runMmrSubagentWorker — invocation shape", () => {
  it("builds --mmr-subagent <profile> args and forwards parent mode, model, and tools", async () => {
    const { runMmrSubagentWorker } = await importSource(RUNNER_MODULE);
    const { spawn, calls } = makeSpawnMock();
    const promise = runMmrSubagentWorker(
      {
        profileName: "task-subagent",
        parentMode: "rush",
        prompt: "Find routing code",
        cwd: "/tmp/project",
        model: "openai-codex/gpt-5.4-mini",
        tools: ["grep", "find", "read"],
      },
      { spawn, resolveInvocation: (args) => ({ command: "pi", args }) },
    );
    calls[0].proc.close(0);
    await promise;

    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "pi");
    assert.deepEqual(calls[0].args, [
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--mmr-subagent",
      "task-subagent",
      "--mmr-parent-mode",
      "rush",
      "--model",
      "openai-codex/gpt-5.4-mini",
      "--tools",
      "grep,find,read",
      "Task: Find routing code",
    ]);
    assert.equal(calls[0].options.cwd, "/tmp/project");
    assert.equal(calls[0].options.shell, false);
  });

  it("rejects without spawning when profileName is missing or blank", async () => {
    const { runMmrSubagentWorker } = await importSource(RUNNER_MODULE);
    const { spawn, calls } = makeSpawnMock();
    await assert.rejects(
      runMmrSubagentWorker(
        { prompt: "x", cwd: "/tmp", profileName: "" },
        { spawn, resolveInvocation: (args) => ({ command: "pi", args }) },
      ),
      /profileName|subagent profile/i,
    );
    await assert.rejects(
      runMmrSubagentWorker(
        { prompt: "x", cwd: "/tmp" },
        { spawn, resolveInvocation: (args) => ({ command: "pi", args }) },
      ),
      /profileName|subagent profile/i,
    );
    assert.equal(calls.length, 0, "must not spawn when profileName is missing");
  });

  it("omits --model and --tools when not supplied", async () => {
    const { runMmrSubagentWorker } = await importSource(RUNNER_MODULE);
    const { spawn, calls } = makeSpawnMock();
    const promise = runMmrSubagentWorker(
      { profileName: "finder", prompt: "x", cwd: "/tmp" },
      { spawn, resolveInvocation: (args) => ({ command: "pi", args }) },
    );
    calls[0].proc.close(0);
    await promise;
    assert.equal(calls[0].args.includes("--model"), false);
    assert.equal(calls[0].args.includes("--tools"), false);
    assert.ok(calls[0].args.includes("--mmr-subagent"));
    assert.ok(calls[0].args.includes("finder"));
  });
});

describe("runMmrSubagentWorker — activation failure marker", () => {
  it("surfaces the activation-failure marker via subagentActivationError + errorMessage", async () => {
    const { runMmrSubagentWorker } = await importSource(RUNNER_MODULE);
    const { spawn, calls } = makeSpawnMock();
    const promise = runMmrSubagentWorker(
      { profileName: "finder", prompt: "x", cwd: "/tmp" },
      { spawn, resolveInvocation: (args) => ({ command: "pi", args }) },
    );
    const proc = calls[0].proc;
    proc.writeStderr(
      'ampi: subagent activation failed: Unknown subagent profile "no-such". Known profiles: finder.\n',
    );
    proc.close(0);
    const result = await promise;
    assert.equal(
      result.subagentActivationError,
      'Unknown subagent profile "no-such". Known profiles: finder.',
    );
    assert.match(result.errorMessage ?? "", /subagent activation failed/i);
  });
});


