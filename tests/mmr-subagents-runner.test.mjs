import assert from "node:assert/strict";
import { homedir } from "node:os";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

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

  writeStdout(text) {
    this.stdout.write(text);
  }

  writeStderr(text) {
    this.stderr.write(text);
  }

  close(code = 0, signal = null) {
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }

  fail(error) {
    this.emit("error", error);
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

function assistantMessage(text, usage = undefined) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    ...(usage ? { usage } : {}),
  };
}

async function waitForSpawnCall(calls, timeoutMs = 2_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (calls.length > 0) return calls[0];
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`spawn was not called within ${timeoutMs}ms`);
}

describe("mmr-subagents worker runner", () => {
  it("builds a Pi JSON-mode invocation with prompt, named subagent profile, model, tools, and cwd", async () => {
    const { runMmrSubagentWorker } = await importSource("extensions/mmr-workers/runner.ts");
    const { spawn, calls } = makeSpawnMock();
    const promise = runMmrSubagentWorker(
      {
        prompt: "Find routing code",
        cwd: "/tmp/project",
        profileName: "finder",
        model: "provider/model",
        tools: ["read", "grep", "find"],
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
      "finder",
      "--model",
      "provider/model",
      "--tools",
      "read,grep,find",
      "Task: Find routing code",
    ]);
    // Must not invoke locked-mode Free as a side effect or disable extensions globally.
    assert.equal(calls[0].args.includes("--mmr-mode"), false);
    assert.equal(calls[0].args.includes("--no-extensions"), false);
    assert.equal(calls[0].options.cwd, "/tmp/project");
    assert.equal(calls[0].options.shell, false);
    assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  });

  it("writes a temporary system prompt file, passes --append-system-prompt, and removes it after close", async () => {
    const { runMmrSubagentWorker } = await importSource("extensions/mmr-workers/runner.ts");
    const { spawn, calls } = makeSpawnMock();
    const promise = runMmrSubagentWorker(
      { profileName: "finder", prompt: "Investigate", cwd: "/tmp/project", systemPrompt: "You are a focused worker." },
      { spawn, resolveInvocation: (args) => ({ command: "pi", args }) },
    );

    const call = await waitForSpawnCall(calls);
    const promptFlagIndex = call.args.indexOf("--append-system-prompt");
    assert.notEqual(promptFlagIndex, -1);
    const promptPath = call.args[promptFlagIndex + 1];
    assert.equal(existsSync(promptPath), true, "prompt file should exist while child process is running");

    call.proc.close(0);
    await promise;
    assert.equal(existsSync(promptPath), false, "prompt file should be removed after the child exits");
  });

  it("spills oversized user prompts to a temp file and references it via @path to avoid spawn E2BIG", async () => {
    // Linux caps each argv string at MAX_ARG_STRLEN (32 * PAGE_SIZE = 131072 on 4 KiB-page systems).
    // When the inline `Task: <prompt>` argv exceeds the runner's conservative inline cap, the runner
    // must spill the prompt to a temp file and reference it via Pi's `@<path>` syntax instead, or
    // the spawn will fail with `spawn E2BIG`. Regression coverage for that path.
    const { runMmrSubagentWorker, MMR_WORKER_INLINE_PROMPT_BYTE_LIMIT } = await importSource(
      "extensions/mmr-workers/runner.ts",
    );
    const { readFile } = await import("node:fs/promises");
    const { spawn, calls } = makeSpawnMock();
    // 8 KiB over the cap is more than enough to exercise the spill path and well below any
    // Node string-length concerns.
    const oversized = "x".repeat(MMR_WORKER_INLINE_PROMPT_BYTE_LIMIT + 8 * 1024);
    const promise = runMmrSubagentWorker(
      { profileName: "finder", prompt: oversized, cwd: "/tmp/project" },
      { spawn, resolveInvocation: (args) => ({ command: "pi", args }) },
    );

    const call = await waitForSpawnCall(calls);
    const positional = call.args[call.args.length - 1];
    assert.equal(
      positional.startsWith("@"),
      true,
      `positional argv should be a @<path> reference when the prompt exceeds the inline cap, got: ${positional.slice(0, 64)}…`,
    );
    assert.equal(
      call.args.some((a) => a.startsWith("Task: ")),
      false,
      "oversized prompts must not also be inlined as a Task: argv",
    );
    const userPromptPath = positional.slice(1);
    assert.equal(existsSync(userPromptPath), true, "user-prompt file should exist while child is running");
    const onDisk = await readFile(userPromptPath, "utf8");
    assert.equal(onDisk, `Task: ${oversized}`, "user-prompt file should contain the full `Task: <prompt>` body");

    call.proc.close(0);
    await promise;
    assert.equal(existsSync(userPromptPath), false, "user-prompt file should be removed after the child exits");
  });

  it("keeps small user prompts inline as `Task: <prompt>` so the common-case argv contract is preserved", async () => {
    const { runMmrSubagentWorker } = await importSource("extensions/mmr-workers/runner.ts");
    const { spawn, calls } = makeSpawnMock();
    const promise = runMmrSubagentWorker(
      { profileName: "finder", prompt: "small ask", cwd: "/tmp/project" },
      { spawn, resolveInvocation: (args) => ({ command: "pi", args }) },
    );

    const call = await waitForSpawnCall(calls);
    assert.equal(call.args[call.args.length - 1], "Task: small ask");
    assert.equal(
      call.args.some((a) => a.startsWith("@")),
      false,
      "small prompts must not be spilled to a @<path> file",
    );

    call.proc.close(0);
    await promise;
  });

  it("parses message_end and tool_result_end events, aggregates assistant usage, and returns final output", async () => {
    const { runMmrSubagentWorker } = await importSource("extensions/mmr-workers/runner.ts");
    const { spawn, calls } = makeSpawnMock();
    const updates = [];
    const promise = runMmrSubagentWorker(
      { profileName: "finder", prompt: "Investigate", cwd: "/tmp/project", onUpdate: (snapshot) => updates.push(snapshot) },
      { spawn, resolveInvocation: (args) => ({ command: "pi", args }) },
    );

    calls[0].proc.writeStdout(`${JSON.stringify({ type: "message_end", message: assistantMessage("first", { input: 10, output: 3, cacheRead: 4, cacheWrite: 5, cost: { total: 0.25 }, totalTokens: 99 }) })}\n`);
    calls[0].proc.writeStdout(`${JSON.stringify({ type: "tool_result_end", message: { role: "tool", content: [{ type: "text", text: "tool done" }] } })}\n`);
    calls[0].proc.writeStdout(`${JSON.stringify({ type: "message_end", message: { ...assistantMessage("final"), model: "provider/model", stopReason: "end_turn" } })}\n`);
    calls[0].proc.close(0);

    const result = await promise;
    assert.equal(result.exitCode, 0);
    assert.equal(result.finalOutput, "final");
    assert.equal(result.truncatedFinalOutput, "final");
    assert.equal(result.model, "provider/model");
    assert.equal(result.stopReason, "end_turn");
    assert.equal(result.messages.length, 3);
    assert.deepEqual(result.usage, {
      input: 10,
      output: 3,
      cacheRead: 4,
      cacheWrite: 5,
      cost: 0.25,
      contextTokens: 99,
      turns: 2,
    });
    assert.ok(updates.length >= 2, "runner should emit progress after parsed message/tool events");
  });

  it("captures child tool execution events in bounded trail snapshots", async () => {
    // Regression: the runner builds the same ordered trail entries for
    // tool_execution_start / tool_execution_update / tool_execution_end
    // that the renderer reads from `details.trail`. The legacy
    // `toolActivity` shape was removed; `trail` is the only progress
    // representation.
    const { runMmrSubagentWorker } = await importSource("extensions/mmr-workers/runner.ts");
    const { spawn, calls } = makeSpawnMock();
    const updates = [];
    const promise = runMmrSubagentWorker(
      { profileName: "finder", prompt: "Investigate", cwd: "/tmp/project", onUpdate: (snapshot) => updates.push(snapshot) },
      { spawn, resolveInvocation: (args) => ({ command: "pi", args }) },
    );

    calls[0].proc.writeStdout(`${JSON.stringify({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "grep", args: { pattern: "auth", path: "src" } })}\n`);
    calls[0].proc.writeStdout(`${JSON.stringify({ type: "tool_execution_update", toolCallId: "tool-1", toolName: "grep", args: { pattern: "auth", path: "src" }, partialResult: { content: [{ type: "text", text: "src/auth.ts:12: login" }] } })}\n`);
    calls[0].proc.writeStdout(`${JSON.stringify({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "grep", result: { content: [{ type: "text", text: "src/auth.ts:12: login" }] }, isError: false })}\n`);
    calls[0].proc.writeStdout(`${JSON.stringify({ type: "message_end", message: assistantMessage("final") })}\n`);
    calls[0].proc.close(0);

    const result = await promise;
    assert.ok(updates.length >= 3, "tool start/update/end events should stream progress before final output");
    assert.equal("toolActivity" in updates[0], false, "snapshots no longer carry the legacy toolActivity field");
    const firstTool = updates[0].trail.find((item) => item.type === "tool");
    assert.ok(firstTool, "first snapshot trail should include the running tool entry");
    assert.equal(firstTool.toolName, "grep");
    assert.equal(firstTool.status, "running");
    assert.match(firstTool.argsPreview, /auth/);
    const lastUpdate = updates.at(-1);
    const lastTool = lastUpdate.trail.find((item) => item.type === "tool");
    assert.equal(lastTool.status, "completed");
    assert.match(lastTool.resultPreview, /src\/auth\.ts/);
    assert.equal("toolActivity" in result, false, "final result no longer carries the legacy toolActivity field");
    assert.deepEqual(result.trail, lastUpdate.trail);
  });

  it("builds an ordered worker trail from assistant text and child tool calls", async () => {
    const { runMmrSubagentWorker } = await importSource("extensions/mmr-workers/runner.ts");
    const { spawn, calls } = makeSpawnMock();
    const updates = [];
    const filePath = `${homedir()}/projects/repo/src/extensions/mmr-workers/finder.ts`;
    const promise = runMmrSubagentWorker(
      { profileName: "finder", prompt: "Investigate", cwd: "/tmp/project", onUpdate: (snapshot) => updates.push(snapshot) },
      { spawn, resolveInvocation: (args) => ({ command: "pi", args }) },
    );

    calls[0].proc.writeStdout(`${JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        model: "google/gemini-3.5-flash",
        stopReason: "toolUse",
        content: [
          { type: "text", text: "Now read finder.ts buildFinalContent:" },
          { type: "toolCall", id: "read-1", name: "read", arguments: { path: filePath, offset: 430, limit: 160 } },
        ],
      },
    })}\n`);
    calls[0].proc.writeStdout(`${JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "read-1",
      toolName: "read",
      args: { path: filePath, offset: 430, limit: 160 },
      result: { content: [{ type: "text", text: "full expanded file contents should not be part of the trail item" }] },
      isError: false,
    })}\n`);
    calls[0].proc.writeStdout(`${JSON.stringify({ type: "message_end", message: assistantMessage("Final concise answer") })}\n`);
    calls[0].proc.close(0);

    const result = await promise;
    assert.ok(updates.some((snapshot) => Array.isArray(snapshot.trail) && snapshot.trail.length >= 2));
    assert.equal(result.trail[0].type, "assistant");
    assert.match(result.trail[0].text, /Now read finder\.ts/);
    assert.equal(result.trail[1].type, "tool");
    assert.equal(result.trail[1].toolName, "read");
    assert.equal(result.trail[1].status, "completed");
    assert.match(result.trail[1].argsPreview, /finder\.ts/);
    assert.equal(result.trail[2].type, "assistant");
    assert.match(result.trail[2].text, /Final concise answer/);
  });

  it("captures worker transcript roles and content blocks in the ordered trail", async () => {
    const { runMmrSubagentWorker } = await importSource("extensions/mmr-workers/runner.ts");
    const { spawn, calls } = makeSpawnMock();
    const updates = [];
    const promise = runMmrSubagentWorker(
      { profileName: "finder", prompt: "Investigate", cwd: "/tmp/project", onUpdate: (snapshot) => updates.push(snapshot) },
      { spawn, resolveInvocation: (args) => ({ command: "pi", args }) },
    );

    calls[0].proc.writeStdout(`${JSON.stringify({
      type: "message_end",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: '<skill name="tdd-workflow" location="/skills/tdd/SKILL.md">\nUse tests before edits\n</skill>\n\nPlease inspect auth flow',
          },
          { type: "image", data: "abc123", mimeType: "image/png" },
        ],
      },
    })}\n`);
    calls[0].proc.writeStdout(`${JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        model: "provider/model",
        stopReason: "toolUse",
        content: [
          { type: "thinking", thinking: "Need to locate the handler." },
          { type: "text", text: "I'll inspect the route." },
          { type: "toolCall", id: "read-1", name: "read", arguments: { path: "/tmp/project/src/auth.ts", offset: 5, limit: 2 } },
        ],
      },
    })}\n`);
    calls[0].proc.writeStdout(`${JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "read-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "full file contents should stay out of the rendered trail" }] },
      isError: false,
    })}\n`);
    calls[0].proc.writeStdout(`${JSON.stringify({
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "search-1",
        toolName: "web_search",
        content: [{ type: "text", text: "2 results" }],
        isError: false,
      },
    })}\n`);
    calls[0].proc.writeStdout(`${JSON.stringify({
      type: "message_end",
      message: { role: "bashExecution", command: "npm test", output: "pass", exitCode: 0, cancelled: false, truncated: false },
    })}\n`);
    calls[0].proc.writeStdout(`${JSON.stringify({
      type: "message_end",
      message: { role: "compactionSummary", summary: "Reduced prior context", tokensBefore: 12_000 },
    })}\n`);
    calls[0].proc.writeStdout(`${JSON.stringify({
      type: "message_end",
      message: { role: "branchSummary", summary: "Side branch changed tests", fromId: "branch-1" },
    })}\n`);
    calls[0].proc.writeStdout(`${JSON.stringify({
      type: "message_end",
      message: { role: "custom", customType: "hidden", content: "hidden payload", display: false },
    })}\n`);
    calls[0].proc.writeStdout(`${JSON.stringify({
      type: "message_end",
      message: { role: "custom", customType: "notice", content: "extension payload", display: true },
    })}\n`);
    calls[0].proc.close(0);

    const result = await promise;
    assert.ok(updates.some((snapshot) => snapshot.trail.some((item) => item.type === "user")));
    assert.deepEqual(result.trail.map((item) => item.type), [
      "skillInvocation",
      "user",
      "thinking",
      "assistant",
      "tool",
      "toolResult",
      "bashExecution",
      "compactionSummary",
      "branchSummary",
      "custom",
    ]);
    assert.equal(result.trail[0].name, "tdd-workflow");
    assert.match(result.trail[1].text, /Please inspect auth flow/);
    assert.equal(result.trail[1].imageCount, 1);
    assert.match(result.trail[2].text, /locate the handler/);
    assert.match(result.trail[3].text, /inspect the route/);
    assert.equal(result.trail[4].toolName, "read");
    assert.equal(result.trail[4].status, "completed");
    assert.match(result.trail[4].resultPreview, /full file contents/);
    assert.equal(result.trail[5].toolName, "web_search");
    assert.match(result.trail[5].text, /2 results/);
    assert.equal(result.trail[6].command, "npm test");
    assert.match(result.trail[7].summary, /Reduced prior context/);
    assert.match(result.trail[8].summary, /Side branch changed tests/);
    assert.equal(result.trail[9].customType, "notice");
    assert.equal(result.trail.some((item) => item.customType === "hidden"), false);
  });

  it("treats literal <skill> XML in user prose as ordinary user text (anchored parse)", async () => {
    const { runMmrSubagentWorker } = await importSource("extensions/mmr-workers/runner.ts");
    const { spawn, calls } = makeSpawnMock();
    const promise = runMmrSubagentWorker(
      { profileName: "finder", prompt: "Investigate", cwd: "/tmp/project" },
      { spawn, resolveInvocation: (args) => ({ command: "pi", args }) },
    );

    calls[0].proc.writeStdout(`${JSON.stringify({
      type: "message_end",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: 'Here is an example: <skill name="x" location="y">\nfake body\n</skill> illustrating what the syntax looks like.',
          },
        ],
      },
    })}\n`);
    calls[0].proc.close(0);

    const result = await promise;
    const types = result.trail.map((item) => item.type);
    assert.deepEqual(types, ["user"], "non-anchored <skill> XML must not produce a skillInvocation trail item");
    assert.match(result.trail[0].text, /Here is an example: <skill/);
  });

  it("detects a skill block whose body exceeds the trail truncation cap", async () => {
    const { runMmrSubagentWorker, MMR_WORKER_TRAIL_TEXT_CHAR_LIMIT } = await importSource(
      "extensions/mmr-workers/runner.ts",
    );
    const charCap = typeof MMR_WORKER_TRAIL_TEXT_CHAR_LIMIT === "number" ? MMR_WORKER_TRAIL_TEXT_CHAR_LIMIT : 4000;
    const longBody = "x".repeat(charCap + 500);
    const { spawn, calls } = makeSpawnMock();
    const promise = runMmrSubagentWorker(
      { profileName: "finder", prompt: "Investigate", cwd: "/tmp/project" },
      { spawn, resolveInvocation: (args) => ({ command: "pi", args }) },
    );

    calls[0].proc.writeStdout(`${JSON.stringify({
      type: "message_end",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: `<skill name="verbose" location="/skills/verbose/SKILL.md">\n${longBody}\n</skill>\n\nNow do the work`,
          },
        ],
      },
    })}\n`);
    calls[0].proc.close(0);

    const result = await promise;
    const types = result.trail.map((item) => item.type);
    assert.deepEqual(types, ["skillInvocation", "user"], "a skill block must be detected even when its body exceeds the trail char cap");
    assert.equal(result.trail[0].name, "verbose");
    assert.match(result.trail[1].text, /Now do the work/);
  });

  it("keeps a failed tool status when a later toolResult message omits isError", async () => {
    const { runMmrSubagentWorker } = await importSource("extensions/mmr-workers/runner.ts");
    const { spawn, calls } = makeSpawnMock();
    const promise = runMmrSubagentWorker(
      { profileName: "finder", prompt: "Investigate", cwd: "/tmp/project" },
      { spawn, resolveInvocation: (args) => ({ command: "pi", args }) },
    );

    calls[0].proc.writeStdout(`${JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "bash-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "command failed" }] },
      isError: true,
    })}\n`);
    calls[0].proc.writeStdout(`${JSON.stringify({
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "bash-1",
        toolName: "bash",
        content: [{ type: "text", text: "command failed" }],
      },
    })}\n`);
    calls[0].proc.close(0);

    const result = await promise;
    const toolItem = result.trail.find((item) => item.type === "tool" && item.toolCallId === "bash-1");
    assert.ok(toolItem, "a tool trail row should exist for bash-1");
    assert.equal(toolItem.status, "failed", "a missing isError field on a later toolResult must not flip the row back to completed");
    assert.equal(toolItem.isError, true);
  });

  it("ignores malformed JSON lines and records ignored-line count", async () => {
    const { runMmrSubagentWorker } = await importSource("extensions/mmr-workers/runner.ts");
    const { spawn, calls } = makeSpawnMock();
    const promise = runMmrSubagentWorker(
      { profileName: "finder", prompt: "Investigate", cwd: "/tmp/project" },
      { spawn, resolveInvocation: (args) => ({ command: "pi", args }) },
    );
    calls[0].proc.writeStdout("not json\n");
    calls[0].proc.writeStdout(`${JSON.stringify({ type: "message_end", message: assistantMessage("ok") })}\n`);
    calls[0].proc.close(0);

    const result = await promise;
    assert.equal(result.finalOutput, "ok");
    assert.equal(result.ignoredJsonLines, 1);
  });

  it("detects the subagent-activation failure marker on stderr and surfaces it as a hard failure even on exit 0", async () => {
    // mmr-core writes `pi-mmr: subagent activation failed: <reason>` to
    // stderr when subagent activation rejects (unknown profile, no
    // model route, explicit --model / --tools mismatch). Pi currently
    // does not propagate extension `session_start` throws into a
    // nonzero exit code, so the runner MUST treat the marker on stderr
    // as an unmissable failure or callers (finder, future Task) will
    // silently consume an un-policied worker run.
    const { runMmrSubagentWorker } = await importSource("extensions/mmr-workers/runner.ts");
    const { spawn, calls } = makeSpawnMock();
    const promise = runMmrSubagentWorker(
      {
        prompt: "noop",
        cwd: "/tmp/project",
        profileName: "no-such-profile",
      },
      { spawn, resolveInvocation: (args) => ({ command: "pi", args }) },
    );
    calls[0].proc.writeStderr(
      'pi-mmr: subagent activation failed: Unknown subagent profile "no-such-profile". Known profiles: finder.\n',
    );
    // Pi exits 0 in current behavior even after an extension throw.
    calls[0].proc.close(0);

    const result = await promise;
    assert.equal(result.exitCode, 0, "Pi exits 0 today; the runner must not depend on that signal");
    assert.equal(
      result.subagentActivationError,
      'Unknown subagent profile "no-such-profile". Known profiles: finder.',
      "runner must expose the parsed subagent activation error",
    );
    assert.match(
      result.errorMessage ?? "",
      /subagent activation failed/i,
      "errorMessage must reflect the activation failure so existing consumers that inspect it surface a clear cause",
    );
  });

  it("detects the activation failure marker even when it is mixed with other stderr noise", async () => {
    const { runMmrSubagentWorker } = await importSource("extensions/mmr-workers/runner.ts");
    const { spawn, calls } = makeSpawnMock();
    const promise = runMmrSubagentWorker(
      { profileName: "finder", prompt: "noop", cwd: "/tmp/project" },
      { spawn, resolveInvocation: (args) => ({ command: "pi", args }) },
    );
    calls[0].proc.writeStderr("Warning: noise before\n");
    calls[0].proc.writeStderr(
      'pi-mmr: subagent activation failed: Subagent "finder" was invoked with --tools bash,write, but the profile tool allowlist is grep,find,read.\n',
    );
    calls[0].proc.writeStderr("Extension error (...): downstream noise\n");
    calls[0].proc.close(0);

    const result = await promise;
    assert.match(
      result.subagentActivationError ?? "",
      /tools bash,write.*profile tool allowlist is grep,find,read/,
    );
  });

  it("leaves subagentActivationError undefined when no marker is present", async () => {
    const { runMmrSubagentWorker } = await importSource("extensions/mmr-workers/runner.ts");
    const { spawn, calls } = makeSpawnMock();
    const promise = runMmrSubagentWorker(
      { profileName: "finder", prompt: "noop", cwd: "/tmp/project" },
      { spawn, resolveInvocation: (args) => ({ command: "pi", args }) },
    );
    calls[0].proc.writeStderr("some unrelated warning\n");
    calls[0].proc.close(0);

    const result = await promise;
    assert.equal(result.subagentActivationError, undefined);
  });

  it("reports agentStarted=false when the child exits cleanly after only emitting `session` (no agent loop)", async () => {
    // Regression guard for the silent empty-success trap. When a sibling
    // extension's `input` event handler returns { action: "handled" } in
    // non-interactive mode, the child Pi process exits 0 with stdout
    // containing only `{"type":"session",...}` and never emits
    // `agent_start`. The runner must surface this via `result.agentStarted
    // === false` so `classifyMmrWorkerOutcome` can emit `no-agent-start`
    // instead of the cheerful `empty-output` outcome.
    const { runMmrSubagentWorker, classifyMmrWorkerOutcome } = await importSource("extensions/mmr-workers/runner.ts");
    const { spawn, calls } = makeSpawnMock();
    const promise = runMmrSubagentWorker(
      { profileName: "finder", prompt: "noop", cwd: "/tmp/project" },
      { spawn, resolveInvocation: (args) => ({ command: "pi", args }) },
    );
    calls[0].proc.writeStdout(`${JSON.stringify({ type: "session", version: 3, id: "sess", timestamp: "t", cwd: "/tmp" })}\n`);
    calls[0].proc.close(0);

    const result = await promise;
    assert.equal(result.exitCode, 0);
    assert.equal(result.agentStarted, false, "agentStarted must be false when only `session` was observed");
    assert.equal(
      classifyMmrWorkerOutcome(result, { partialOutputPolicy: "fail-on-nonzero" }),
      "no-agent-start",
    );
  });

  it("reports agentStarted=true once any in-loop event is observed (agent_start)", async () => {
    // Positive case: a normal worker run that fires `agent_start` (and
    // beyond) must flip the flag. Used by `classifyMmrWorkerOutcome` to
    // preserve `empty-output` for legitimate empty assistant responses.
    const { runMmrSubagentWorker, classifyMmrWorkerOutcome } = await importSource("extensions/mmr-workers/runner.ts");
    const { spawn, calls } = makeSpawnMock();
    const promise = runMmrSubagentWorker(
      { profileName: "finder", prompt: "noop", cwd: "/tmp/project" },
      { spawn, resolveInvocation: (args) => ({ command: "pi", args }) },
    );
    calls[0].proc.writeStdout(`${JSON.stringify({ type: "session", version: 3, id: "sess", timestamp: "t", cwd: "/tmp" })}\n`);
    calls[0].proc.writeStdout(`${JSON.stringify({ type: "agent_start" })}\n`);
    calls[0].proc.writeStdout(`${JSON.stringify({ type: "agent_end", messages: [], willRetry: false })}\n`);
    calls[0].proc.close(0);

    const result = await promise;
    assert.equal(result.agentStarted, true);
    assert.equal(
      classifyMmrWorkerOutcome(result, { partialOutputPolicy: "fail-on-nonzero" }),
      "empty-output",
      "agent ran with no usable text → empty-output, not no-agent-start",
    );
  });

  it("returns stderr and non-zero exit code without throwing", async () => {
    const { runMmrSubagentWorker } = await importSource("extensions/mmr-workers/runner.ts");
    const { spawn, calls } = makeSpawnMock();
    const promise = runMmrSubagentWorker(
      { profileName: "finder", prompt: "Investigate", cwd: "/tmp/project" },
      { spawn, resolveInvocation: (args) => ({ command: "pi", args }) },
    );
    calls[0].proc.writeStderr("child failed");
    calls[0].proc.close(7);

    const result = await promise;
    assert.equal(result.exitCode, 7);
    assert.equal(result.stderr, "child failed");
    assert.equal(result.finalOutput, "");
    assert.equal(result.aborted, false);
  });

  it("captures spawn errors as structured failures and tags result.spawnError", async () => {
    const { runMmrSubagentWorker } = await importSource("extensions/mmr-workers/runner.ts");
    const { spawn, calls } = makeSpawnMock();
    const promise = runMmrSubagentWorker(
      { profileName: "finder", prompt: "Investigate", cwd: "/tmp/project" },
      { spawn, resolveInvocation: (args) => ({ command: "pi", args }) },
    );
    calls[0].proc.fail(new Error("spawn ENOENT"));

    const result = await promise;
    assert.equal(result.exitCode, 1);
    assert.match(result.errorMessage, /spawn ENOENT/);
    // Behavioral pin: spawn-error must take precedence over partial output (rule 2):
    // structured spawn failures must surface a stable discriminator the
    // Task classifier can read without inspecting the error message text.
    assert.equal(
      result.spawnError,
      "spawn ENOENT",
      "result.spawnError must carry the spawn-error reason verbatim",
    );
  });

  it("truncates final output by UTF-8 byte length", async () => {
    const { runMmrSubagentWorker } = await importSource("extensions/mmr-workers/runner.ts");
    const { spawn, calls } = makeSpawnMock();
    const promise = runMmrSubagentWorker(
      { profileName: "finder", prompt: "Investigate", cwd: "/tmp/project", outputByteLimit: 8 },
      { spawn, resolveInvocation: (args) => ({ command: "pi", args }) },
    );
    calls[0].proc.writeStdout(`${JSON.stringify({ type: "message_end", message: assistantMessage("αβγδε") })}\n`);
    calls[0].proc.close(0);

    const result = await promise;
    assert.equal(result.finalOutput, "αβγδε");
    assert.match(result.truncatedFinalOutput, /^αβγδ\n\n\[Output truncated:/);
    assert.equal(result.outputTruncated, true);
  });

  it("propagates abort by sending SIGTERM and returns an aborted result", async () => {
    const { runMmrSubagentWorker } = await importSource("extensions/mmr-workers/runner.ts");
    const { spawn, calls } = makeSpawnMock();
    const controller = new AbortController();
    const promise = runMmrSubagentWorker(
      { profileName: "finder", prompt: "Investigate", cwd: "/tmp/project", signal: controller.signal, killTimeoutMs: 1_000 },
      { spawn, resolveInvocation: (args) => ({ command: "pi", args }) },
    );
    const call = await waitForSpawnCall(calls);

    controller.abort();
    assert.deepEqual(call.proc.killCalls, ["SIGTERM"]);
    call.proc.close(null, "SIGTERM");

    const result = await promise;
    assert.equal(result.aborted, true);
    assert.equal(result.exitCode, null);
    assert.equal(result.signal, "SIGTERM");
    assert.match(result.errorMessage, /aborted/);
  });

  it("escalates to SIGKILL when the child does not exit within killTimeoutMs, even after kill() reports success", async () => {
    const { runMmrSubagentWorker } = await importSource("extensions/mmr-workers/runner.ts");
    const { spawn, calls } = makeSpawnMock();
    const controller = new AbortController();
    const promise = runMmrSubagentWorker(
      { profileName: "finder", prompt: "Investigate", cwd: "/tmp/project", signal: controller.signal, killTimeoutMs: 5 },
      { spawn, resolveInvocation: (args) => ({ command: "pi", args }) },
    );
    const call = await waitForSpawnCall(calls);

    controller.abort();
    // Mock kill() flips proc.killed = true even though no exit event was emitted.
    // The runner must still escalate because the *child* has not closed.
    assert.equal(call.proc.killed, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(call.proc.killCalls, ["SIGTERM", "SIGKILL"]);

    call.proc.close(null, "SIGKILL");
    const result = await promise;
    assert.equal(result.aborted, true);
  });
});

describe("resolveMmrWorkerPiInvocationFromEnv", () => {
  it("re-invokes the current Pi script via the runtime executable when the script exists", async () => {
    const { resolveMmrWorkerPiInvocationFromEnv } = await importSource("extensions/mmr-workers/runner.ts");
    const invocation = resolveMmrWorkerPiInvocationFromEnv(["--mode", "json"], {
      argv1: "/usr/local/bin/pi",
      execPath: "/usr/bin/node",
      scriptExists: (filePath) => filePath === "/usr/local/bin/pi",
    });
    assert.deepEqual(invocation, {
      command: "/usr/bin/node",
      args: ["/usr/local/bin/pi", "--mode", "json"],
    });
  });

  it("falls back to pi on PATH when no current script is available and the runtime is a generic node", async () => {
    const { resolveMmrWorkerPiInvocationFromEnv } = await importSource("extensions/mmr-workers/runner.ts");
    const invocation = resolveMmrWorkerPiInvocationFromEnv(["--mode", "json"], {
      argv1: "/missing/script",
      execPath: "/usr/bin/node",
      scriptExists: () => false,
    });
    assert.deepEqual(invocation, { command: "pi", args: ["--mode", "json"] });
  });

  it("uses process.execPath when the runtime is a packaged Pi binary, not node/bun", async () => {
    const { resolveMmrWorkerPiInvocationFromEnv } = await importSource("extensions/mmr-workers/runner.ts");
    const invocation = resolveMmrWorkerPiInvocationFromEnv(["--mode", "json"], {
      argv1: undefined,
      execPath: "/usr/local/bin/pi",
      scriptExists: () => false,
    });
    assert.deepEqual(invocation, { command: "/usr/local/bin/pi", args: ["--mode", "json"] });
  });

  it("does not re-invoke a bun virtual script and falls back to pi on PATH under a generic runtime", async () => {
    const { resolveMmrWorkerPiInvocationFromEnv } = await importSource("extensions/mmr-workers/runner.ts");
    const invocation = resolveMmrWorkerPiInvocationFromEnv(["--mode", "json"], {
      argv1: "/$bunfs/root/pi",
      execPath: "/usr/bin/node",
      scriptExists: () => true,
    });
    assert.deepEqual(invocation, { command: "pi", args: ["--mode", "json"] });
  });
});
