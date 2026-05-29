import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

const PROMPTS_MODULE = "extensions/mmr-subagents/prompts.ts";
const PROMPT_ASSEMBLY_MODULE = "extensions/mmr-core/subagent-prompt-assembly.ts";

function sessionInfo(overrides = {}) {
  return {
    path: overrides.path ?? `/tmp/private/session-${overrides.id ?? "S-1"}.jsonl`,
    id: overrides.id ?? "S-1",
    cwd: overrides.cwd ?? "/repo/private-project",
    name: overrides.name,
    parentSessionPath: undefined,
    created: overrides.created ?? new Date("2026-05-20T00:00:00Z"),
    modified: overrides.modified ?? new Date("2026-05-21T00:00:00Z"),
    messageCount: overrides.messageCount ?? 2,
    firstMessage: overrides.firstMessage ?? "Implement history worker analysis",
    allMessagesText: overrides.allMessagesText ?? "We discussed worker analysis and lexical fallback.",
  };
}

function makeWorkerResult(overrides = {}) {
  return {
    messages: [],
    finalOutput: overrides.finalOutput ?? "Worker extracted the requested decision from the sanitized packet.",
    truncatedFinalOutput: overrides.truncatedFinalOutput ?? overrides.finalOutput ?? "Worker extracted the requested decision from the sanitized packet.",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 15, turns: 1 },
    model: overrides.reportedModel ?? "gpt-5.4-mini",
    stopReason: "end_turn",
    errorMessage: undefined,
    prompt: "prompt",
    cwd: "/repo/private-project",
    command: "pi",
    args: ["--mode", "json"],
    exitCode: overrides.exitCode ?? 0,
    signal: null,
    stderr: overrides.stderr ?? "",
    aborted: false,
    outputTruncated: false,
    ignoredJsonLines: 0,
    agentStarted: true,
    ...overrides,
  };
}

function makeModelRegistry(models) {
  return {
    getAvailable() {
      return models.map(([provider, id]) => ({ provider, id }));
    },
  };
}

async function makeManager(messages = []) {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const manager = SessionManager.inMemory("/repo/private-project");
  if (messages.length === 0) {
    manager.appendMessage({ role: "user", content: "Find worker analysis decisions." });
    manager.appendMessage({ role: "assistant", content: "Use lexical fallback when worker analysis is unavailable." });
  } else {
    for (const message of messages) manager.appendMessage(message);
  }
  return manager;
}

async function makeReadSessionTool({ settings = {}, runner, sessions, manager, loadCoreSettings } = {}) {
  const { createReadSessionTool } = await importSource("extensions/mmr-history/tools.ts");
  const activeManager = manager ?? await makeManager();
  const activeSessions = sessions ?? [sessionInfo({ id: activeManager.getSessionId(), messageCount: 2 })];
  const deps = {
    getSettings: () => ({ enabled: true, maxResults: 10, maxExcerptBytes: 10_000, ...settings }),
    listSessions: async () => activeSessions,
    openSession: () => activeManager,
  };
  if (runner) deps.analysisRunner = runner;
  if (loadCoreSettings) deps.loadCoreSettings = loadCoreSettings;
  return { tool: createReadSessionTool(deps), sessions: activeSessions, manager: activeManager };
}

after(cleanupLoadedSource);

beforeEach(async () => {
  const { clearMmrSubagentPromptBuilders } = await importSource(PROMPT_ASSEMBLY_MODULE);
  const { registerMmrSubagentsPromptBuilders } = await importSource(PROMPTS_MODULE);
  clearMmrSubagentPromptBuilders();
  registerMmrSubagentsPromptBuilders();
});

describe("mmr-history settings (single gate)", () => {
  it("loadMmrHistorySettings only honors MMR_HISTORY_ENABLE", async () => {
    const { loadMmrHistorySettings } = await importSource("extensions/mmr-history/config.ts");
    assert.deepEqual(
      loadMmrHistorySettings({ MMR_HISTORY_ENABLE: "true" }),
      { enabled: true, maxResults: 10, maxExcerptBytes: 24_000 },
    );
    assert.equal(loadMmrHistorySettings({}).enabled, false);
    // The old second gate must not silently re-enter the settings shape.
    assert.equal(Object.hasOwn(loadMmrHistorySettings({ MMR_HISTORY_ENABLE: "true" }), "modelAnalysisEnabled"), false);
  });

  it("the legacy MMR_HISTORY_MODEL_ANALYSIS_ENABLE env constant is no longer exported", async () => {
    const mod = await importSource("extensions/mmr-history/config.ts");
    assert.equal("MMR_HISTORY_MODEL_ANALYSIS_ENABLE_ENV" in mod, false);
  });
});

describe("mmr-history worker-first read_session", () => {
  it("calls the history-reader worker by default, even with no analysis opt-in", async () => {
    let captured;
    const { tool, sessions } = await makeReadSessionTool({
      runner: {
        async run(options) {
          captured = options;
          return makeWorkerResult({ finalOutput: "Worker said hi." });
        },
      },
    });

    const result = await tool.execute("call", { sessionId: sessions[0].id, goal: "worker fallback" }, undefined, undefined, {
      cwd: "/repo/private-project",
      modelRegistry: makeModelRegistry([["openai-codex", "gpt-5.4-mini"]]),
    });

    assert.equal(result.details.analysisUsed, "worker");
    assert.equal(result.details.analysisFallbackReason, undefined);
    assert.equal(captured.profileName, "history-reader");
    assert.equal(captured.model, "openai-codex/gpt-5.4-mini");
    assert.deepEqual(captured.tools, []);
    assert.equal(result.details.scope, "all_sessions");
    assert.match(result.details.projectRef, /^[0-9a-f]{8}$/);
    assert.equal(result.content[0].text, "Worker said hi.");
  });

  it("falls back to lexical (with redaction) when no authenticated history-reader route is available", async () => {
    let calls = 0;
    const { tool, sessions } = await makeReadSessionTool({
      runner: { async run() { calls += 1; return makeWorkerResult(); } },
    });

    const result = await tool.execute("call", { sessionId: sessions[0].id, goal: "worker route" }, undefined, undefined, {
      cwd: "/repo/private-project",
      modelRegistry: makeModelRegistry([]),
    });

    assert.equal(calls, 0);
    assert.equal(result.details.analysisUsed, "lexical");
    assert.match(result.details.analysisFallbackReason, /No authenticated history-reader model route/);
    assert.equal(result.details.scope, "all_sessions");
  });

  it("honors explicit per-call worker model before configured or profile defaults", async () => {
    let captured;
    const { tool, sessions } = await makeReadSessionTool({
      loadCoreSettings: () => ({ settings: { subagentModelPreferences: { "history-reader": [{ model: "gpt-5.4-mini" }] } } }),
      runner: { async run(options) { captured = options; return makeWorkerResult(); } },
    });

    await tool.execute("call", { sessionId: sessions[0].id, goal: "model override", model: "anthropic/claude-haiku-4-5" }, undefined, undefined, {
      cwd: "/repo/private-project",
      modelRegistry: makeModelRegistry([["anthropic", "claude-haiku-4-5"], ["openai-codex", "gpt-5.4-mini"]]),
    });

    assert.equal(captured.model, "anthropic/claude-haiku-4-5");
  });

  it("falls back to lexical when the worker runner throws", async () => {
    const { tool, sessions } = await makeReadSessionTool({
      runner: { async run() { throw new Error("worker exploded"); } },
    });

    const result = await tool.execute("call", { sessionId: sessions[0].id, goal: "worker error" }, undefined, undefined, {
      cwd: "/repo/private-project",
      modelRegistry: makeModelRegistry([["openai-codex", "gpt-5.4-mini"]]),
    });

    assert.equal(result.details.analysisUsed, "lexical");
    assert.match(result.details.analysisFallbackReason, /worker exploded/);
    assert.match(result.content[0].text, /# Session/);
  });

  it("falls back to lexical when the worker produces no output", async () => {
    const { tool, sessions } = await makeReadSessionTool({
      runner: { async run() { return makeWorkerResult({ finalOutput: "", truncatedFinalOutput: "" }); } },
    });

    const result = await tool.execute("call", { sessionId: sessions[0].id, goal: "empty output" }, undefined, undefined, {
      cwd: "/repo/private-project",
      modelRegistry: makeModelRegistry([["openai-codex", "gpt-5.4-mini"]]),
    });

    assert.equal(result.details.analysisUsed, "lexical");
    assert.match(result.details.analysisFallbackReason, /no analysis output|empty/i);
  });
});

describe("mmr-history read_session deprecated input handling", () => {
  it("declares only 'goal' as schema-required so threadID-only callers are not rejected at the boundary", async () => {
    const { READ_SESSION_PARAMETERS_SCHEMA } = await importSource("extensions/mmr-history/tools.ts");
    assert.deepEqual([...READ_SESSION_PARAMETERS_SCHEMA.required], ["goal"]);
    assert.ok(
      /threadID/.test(READ_SESSION_PARAMETERS_SCHEMA.properties.sessionId.description),
      "sessionId description must still mention the legacy threadID alias for callers",
    );
  });

  it("accepts legacy threadID with a deprecation warning and still runs the worker", async () => {
    let captured;
    const { tool, sessions } = await makeReadSessionTool({
      runner: { async run(options) { captured = options; return makeWorkerResult({ finalOutput: "ok" }); } },
    });

    const result = await tool.execute(
      "call",
      { threadID: sessions[0].id, goal: "compat alias" },
      undefined,
      undefined,
      { cwd: "/repo/private-project", modelRegistry: makeModelRegistry([["openai-codex", "gpt-5.4-mini"]]) },
    );

    assert.ok(captured, "worker must still be attempted when only the legacy threadID arrived");
    assert.equal(result.details.analysisUsed, "worker");
    assert.ok(Array.isArray(result.details.warnings) && result.details.warnings.length >= 1);
    assert.ok(result.details.warnings.some((w) => /threadID/.test(w)));
  });

  it("warns about threadID even when sessionId is also supplied and uses the sessionId value", async () => {
    let captured;
    const { tool, sessions, manager } = await makeReadSessionTool({
      runner: { async run(options) { captured = options; return makeWorkerResult({ finalOutput: "ok" }); } },
    });
    const realId = sessions[0].id;
    const bogusThreadId = `${realId}-not-the-canonical-one`;

    const result = await tool.execute(
      "call",
      { sessionId: realId, threadID: bogusThreadId, goal: "both ids supplied" },
      undefined,
      undefined,
      { cwd: "/repo/private-project", modelRegistry: makeModelRegistry([["openai-codex", "gpt-5.4-mini"]]) },
    );

    assert.ok(captured, "worker must still run when both ids are supplied");
    assert.equal(result.details.analysisUsed, "worker");
    // sessionId wins; the resolved session id matches the canonical one provided.
    assert.equal(result.details.sessionId, manager.getSessionId());
    assert.ok(Array.isArray(result.details.warnings));
    assert.ok(
      result.details.warnings.some((w) => /threadID/.test(w)),
      `expected threadID deprecation warning even when sessionId is set; got ${JSON.stringify(result.details.warnings)}`,
    );
  });

  it("emits no warnings for the common sessionId-only call", async () => {
    const { tool, sessions } = await makeReadSessionTool({
      runner: { async run() { return makeWorkerResult({ finalOutput: "ok" }); } },
    });

    const result = await tool.execute(
      "call",
      { sessionId: sessions[0].id, goal: "no deprecation" },
      undefined,
      undefined,
      { cwd: "/repo/private-project", modelRegistry: makeModelRegistry([["openai-codex", "gpt-5.4-mini"]]) },
    );

    assert.equal(result.details.analysisUsed, "worker");
    assert.equal(result.details.warnings, undefined);
  });

  it("ignores the legacy analysis param and emits a deprecation warning", async () => {
    let captured;
    const { tool, sessions } = await makeReadSessionTool({
      runner: { async run(options) { captured = options; return makeWorkerResult({ finalOutput: "ok" }); } },
    });

    const result = await tool.execute(
      "call",
      { sessionId: sessions[0].id, goal: "compat alias", analysis: "lexical" },
      undefined,
      undefined,
      { cwd: "/repo/private-project", modelRegistry: makeModelRegistry([["openai-codex", "gpt-5.4-mini"]]) },
    );

    assert.ok(captured, "worker must still be attempted even when the deprecated analysis param is passed");
    assert.equal(result.details.analysisUsed, "worker");
    assert.ok(result.details.warnings.some((w) => /analysis/.test(w)));
  });
});

describe("mmr-history worker packet redaction", () => {
  it("emits a packet whose strings carry redaction markers and no raw secrets, JWTs, or sensitive paths", async () => {
    const { buildHistoryReaderSessionPacket } = await importSource("extensions/mmr-history/analysis-worker.ts");
    const info = sessionInfo({
      id: "S-private",
      path: "/home/someuser/.pi/agent/sessions/abc/S-private.jsonl",
      cwd: "/home/someuser/projects/private-project",
    });
    const manager = await makeManager([
      {
        role: "user",
        content: [
          "JINA_API_KEY=jina_AAAAAAAAAAAAAAAAAAAA in env",
          "Authorization: Bearer abc-bearer-token-value",
          "standalone JWT eyJhbGciOi.eyJzdWIiOj.SflKxwRJSM here",
          "open ~/.pi/agent/sessions/abc/S-private.jsonl please",
          "also look at /home/otheruser/elsewhere/secret.txt",
          "-----BEGIN RSA PRIVATE KEY-----",
          "MIIEpAIBAAKCAQEAv8VXt-key-bytes",
          "-----END RSA PRIVATE KEY-----",
        ].join("\n"),
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will inspect the project." },
          { type: "toolCall", id: "t1", name: "read", arguments: { path: "/home/someuser/projects/private-project/src/Auth.ts" } },
        ],
        api: "anthropic", provider: "anthropic", model: "x",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: 0,
      },
    ]);

    const packet = buildHistoryReaderSessionPacket(info, manager, "auth decision", { maxBytes: 16_000 });
    const json = JSON.stringify(packet);

    // Shape: scope + projectRef replaced the legacy currentProjectOnly flag.
    assert.equal(packet.scope, "all_sessions");
    assert.match(packet.projectRef, /^[0-9a-f]{8}$/);
    assert.equal(Object.hasOwn(packet, "currentProjectOnly"), false);
    assert.equal(Object.hasOwn(packet.session, "path"), false);

    // None of the raw sensitive fragments must survive in the assembled packet.
    for (const forbidden of [
      "jina_AAAAAAAAAAAAAAAAAAAA",
      "eyJhbGciOi.eyJzdWIiOj.SflKxwRJSM",
      "MIIEpAIBAAKCAQEAv8VXt-key-bytes",
      "/home/someuser/projects/private-project",
      "/home/otheruser/elsewhere/secret.txt",
      "someuser",
      "otheruser",
      info.path,
      info.cwd,
    ]) {
      assert.ok(!json.includes(forbidden), `packet must not contain raw fragment: ${forbidden}`);
    }

    // And every redaction marker fired at least once.
    for (const marker of ["[token]", "[jwt]", "[pem]", "[redacted]"]) {
      assert.ok(json.includes(marker), `packet must contain redaction marker: ${marker}\n${json}`);
    }
  });

  it("drops custom_message entries from the packet (entry-type allowlist) while keeping message / compaction / branch_summary / session_info", async () => {
    const { buildHistoryReaderSessionPacket } = await importSource("extensions/mmr-history/analysis-worker.ts");
    // Lightweight fake satisfies the buildHistoryReaderSessionPacket
    // signature directly: only getEntries() and buildSessionContext()
    // are read. This proves the entry-type allowlist deterministically
    // without reaching into the real SessionManager's mutable
    // internal entries array.
    const fakeManager = {
      getEntries: () => [
        {
          type: "message",
          id: "m1",
          parentId: null,
          timestamp: "2026-05-20T00:00:00.000Z",
          message: { role: "user", content: "regular message text" },
        },
        {
          type: "compaction",
          id: "c1",
          parentId: "m1",
          timestamp: "2026-05-20T00:01:00.000Z",
          summary: "compaction summary kept by the allowlist",
          firstKeptEntryId: "m1",
          tokensBefore: 100,
        },
        {
          type: "branch_summary",
          id: "b1",
          parentId: "m1",
          timestamp: "2026-05-20T00:02:00.000Z",
          fromId: "m1",
          summary: "branch summary kept by the allowlist",
        },
        {
          type: "session_info",
          id: "s1",
          parentId: null,
          timestamp: "2026-05-20T00:03:00.000Z",
          name: "labeled session kept by the allowlist",
        },
        {
          type: "custom_message",
          id: "x1",
          parentId: null,
          timestamp: "2026-05-20T00:04:00.000Z",
          customType: "extension/payload",
          content: "custom payload that must not enter the worker packet",
          display: false,
        },
      ],
      buildSessionContext: () => ({ messages: [] }),
    };
    const info = sessionInfo({ id: "S-fake", cwd: "/repo/private-project" });

    const packet = buildHistoryReaderSessionPacket(info, fakeManager, "goal", { maxBytes: 16_000 });

    const types = new Set(packet.entries.map((e) => e.type));
    assert.equal(types.has("custom_message"), false, "custom_message must be filtered out by the entry-type allowlist");
    for (const allowed of ["message", "compaction", "branch_summary", "session_info"]) {
      assert.ok(types.has(allowed), `allowlisted entry type '${allowed}' must reach the packet`);
    }
    // Defense in depth: the custom_message payload string must not
    // leak into any other field of the assembled packet either.
    assert.ok(
      !JSON.stringify(packet).includes("custom payload that must not enter the worker packet"),
      "custom_message content must not survive anywhere in the assembled packet JSON",
    );
  });
});

describe("mmr-history leaving-string redaction (additional)", () => {
  it("workerReadDetails.name redacts a sensitive substring in info.name", async () => {
    const manager = await makeManager();
    const sessions = [
      sessionInfo({
        id: manager.getSessionId(),
        messageCount: 2,
        name: "Plan for /home/alice/secret",
      }),
    ];
    const { tool } = await makeReadSessionTool({
      runner: { async run() { return makeWorkerResult({ finalOutput: "ok" }); } },
      sessions,
      manager,
    });

    const result = await tool.execute(
      "call",
      { sessionId: sessions[0].id, goal: "worker name redaction" },
      undefined,
      undefined,
      { cwd: "/repo/private-project", modelRegistry: makeModelRegistry([["openai-codex", "gpt-5.4-mini"]]) },
    );

    assert.equal(result.details.analysisUsed, "worker");
    assert.ok(typeof result.details.name === "string");
    assert.ok(!result.details.name.includes("alice"), `worker details.name must be redacted: ${result.details.name}`);
    assert.ok(result.details.name.includes("[home]"), `worker details.name must carry redaction marker: ${result.details.name}`);
  });

  it("runner exception flows through redactText before reaching analysisFallbackReason", async () => {
    const { tool, sessions } = await makeReadSessionTool({
      runner: { async run() { throw new Error("failure inspecting /home/alice/private/file.ts"); } },
    });

    const result = await tool.execute(
      "call",
      { sessionId: sessions[0].id, goal: "runner throws" },
      undefined,
      undefined,
      { cwd: "/repo/private-project", modelRegistry: makeModelRegistry([["openai-codex", "gpt-5.4-mini"]]) },
    );

    assert.equal(result.details.analysisUsed, "lexical");
    const reason = result.details.analysisFallbackReason ?? "";
    assert.ok(!reason.includes("alice"), `fallbackReason must redact /home/<user>: ${reason}`);
    assert.ok(!reason.includes("/home/alice"), `fallbackReason must redact /home/<user>: ${reason}`);
    assert.ok(reason.includes("[home]"), `fallbackReason must include redaction marker: ${reason}`);
  });

  it("buildHistoryReaderUserPrompt does NOT prepend the raw caller goal", async () => {
    const { buildHistoryReaderSessionPacket, buildHistoryReaderUserPrompt } = await importSource("extensions/mmr-history/analysis-worker.ts");
    const manager = await makeManager();
    const info = sessionInfo({ id: manager.getSessionId(), messageCount: 2, cwd: "/repo/private-project" });

    const packet = buildHistoryReaderSessionPacket(info, manager, "extract plan from /home/alice/notes", { maxBytes: 16_000 });
    const prompt = buildHistoryReaderUserPrompt(packet);

    assert.ok(!prompt.includes("/home/alice"), `prompt must not contain raw home path: ${prompt}`);
    assert.ok(!prompt.includes("alice"), `prompt must not contain raw username fragment: ${prompt}`);
    // The first line is the goal, sourced from the already-redacted packet.
    const firstLine = prompt.split("\n")[0];
    assert.match(firstLine, /^Goal: /);
    assert.ok(firstLine.includes("[home]"), `goal line must echo redacted goal: ${firstLine}`);
    assert.equal(firstLine, `Goal: ${packet.goal}`);
  });

  it("buildHistoryReaderSessionPacket redacts touchedFiles entries", async () => {
    const { buildHistoryReaderSessionPacket } = await importSource("extensions/mmr-history/analysis-worker.ts");
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const manager = SessionManager.inMemory("/repo/private-project");
    manager.appendMessage({ role: "user", content: "please read the secret" });
    manager.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "reading" },
        // Relative path inside cwd; the inner basename contains a
        // provider-prefixed token that redactText must collapse to
        // `[token]` before it leaves the local catalog.
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "secret/sk-ant-aaaaaaaaaaaaaaaaaaaa.ts" } },
      ],
      api: "anthropic", provider: "anthropic", model: "x",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: 0,
    });

    const info = sessionInfo({ id: manager.getSessionId(), messageCount: 2, cwd: "/repo/private-project" });
    const packet = buildHistoryReaderSessionPacket(info, manager, "check touched files", { maxBytes: 16_000 });

    assert.ok(packet.touchedFiles.length > 0, "packet must include the structured tool call's touched file");
    for (const entry of packet.touchedFiles) {
      assert.ok(!entry.includes("sk-ant-aaaaaaaaaaaaaaaaaaaa"), `touchedFiles entry must redact provider token: ${entry}`);
    }
    assert.ok(
      packet.touchedFiles.some((entry) => entry.includes("[token]")),
      `at least one touchedFiles entry must carry the [token] marker: ${packet.touchedFiles.join(", ")}`,
    );
  });
});

describe("mmr-history lexical fallback redaction", () => {
  it("lexical excerpts strip secrets and home paths", async () => {
    const { tool, sessions } = await makeReadSessionTool({
      runner: { async run() { return makeWorkerResult({ finalOutput: "", truncatedFinalOutput: "" }); } },
      manager: await makeManager([
        { role: "user", content: "TOKEN=hunter2 and please open /home/alice/secret.ts" },
        { role: "assistant", content: "ack" },
      ]),
    });

    const result = await tool.execute("call", { sessionId: sessions[0].id, goal: "secret token" }, undefined, undefined, {
      cwd: "/repo/private-project",
      modelRegistry: makeModelRegistry([["openai-codex", "gpt-5.4-mini"]]),
    });

    assert.equal(result.details.analysisUsed, "lexical");
    const text = result.content[0].text;
    assert.ok(!text.includes("hunter2"), `lexical fallback must redact secrets: ${text}`);
    assert.ok(!text.includes("/home/alice"), `lexical fallback must redact /home/<user>: ${text}`);
  });
});
