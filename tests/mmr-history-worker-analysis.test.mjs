import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

const PROMPTS_MODULE = "extensions/mmr-history/prompts.ts";
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
    getSettings: () => ({ enabled: true, maxResults: 10, maxExcerptBytes: 10_000, redactionEnabled: false, packetByteBudget: 512_000, ...settings }),
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
  const { registerMmrHistoryPromptBuilders } = await importSource(PROMPTS_MODULE);
  clearMmrSubagentPromptBuilders();
  registerMmrHistoryPromptBuilders();
});

describe("mmr-history settings (single gate)", () => {
  it("loadMmrHistorySettings only honors MMR_HISTORY_ENABLE as the tool gate", async () => {
    const { loadMmrHistorySettings } = await importSource("extensions/mmr-history/config.ts");
    assert.deepEqual(
      loadMmrHistorySettings({ MMR_HISTORY_ENABLE: "true" }),
      { enabled: true, maxResults: 10, maxExcerptBytes: 24_000, redactionEnabled: false, packetByteBudget: 512_000 },
    );
    assert.equal(loadMmrHistorySettings({}).enabled, false);
    // The old second gate must not silently re-enter the settings shape.
    assert.equal(Object.hasOwn(loadMmrHistorySettings({ MMR_HISTORY_ENABLE: "true" }), "modelAnalysisEnabled"), false);
  });

  it("CONTENT redaction is opt-in: default OFF, MMR_HISTORY_REDACT turns it ON", async () => {
    const { loadMmrHistorySettings } = await importSource("extensions/mmr-history/config.ts");
    // Default (unset) => raw content for the local same-user case.
    assert.equal(loadMmrHistorySettings({}).redactionEnabled, false);
    assert.equal(loadMmrHistorySettings({ MMR_HISTORY_ENABLE: "true" }).redactionEnabled, false);
    // Explicit opt-in.
    assert.equal(loadMmrHistorySettings({ MMR_HISTORY_REDACT: "true" }).redactionEnabled, true);
    assert.equal(loadMmrHistorySettings({ MMR_HISTORY_REDACT: "1" }).redactionEnabled, true);
    assert.equal(loadMmrHistorySettings({ MMR_HISTORY_REDACT: "false" }).redactionEnabled, false);
  });

  it("MMR_HISTORY_PACKET_BYTE_BUDGET overrides the default and is capped at the ceiling", async () => {
    const { loadMmrHistorySettings, MAX_MMR_HISTORY_PACKET_BYTE_BUDGET } = await importSource("extensions/mmr-history/config.ts");
    // A modest override is honored verbatim.
    assert.equal(
      loadMmrHistorySettings({ MMR_HISTORY_ENABLE: "true", MMR_HISTORY_PACKET_BYTE_BUDGET: "123456" }).packetByteBudget,
      123_456,
    );
    // Over-the-ceiling requests clamp to the ceiling.
    assert.equal(
      loadMmrHistorySettings({ MMR_HISTORY_ENABLE: "true", MMR_HISTORY_PACKET_BYTE_BUDGET: "99999999" }).packetByteBudget,
      MAX_MMR_HISTORY_PACKET_BYTE_BUDGET,
    );
    // Garbage / non-positive falls back to the liberal default.
    assert.equal(
      loadMmrHistorySettings({ MMR_HISTORY_ENABLE: "true", MMR_HISTORY_PACKET_BYTE_BUDGET: "-5" }).packetByteBudget,
      512_000,
    );
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
      modelRegistry: makeModelRegistry([["antigravity", "gemini-3.5-flash-extra-low"], ["openai-codex", "gpt-5.4-mini"]]),
    });

    assert.equal(result.details.analysisUsed, "worker");
    assert.equal(result.details.analysisFallbackReason, undefined);
    assert.equal(captured.profileName, "history-reader");
    assert.equal(captured.model, "antigravity/gemini-3.5-flash-extra-low");
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

    const packet = buildHistoryReaderSessionPacket(info, manager, "auth decision", { maxBytes: 16_000, redactionEnabled: true });
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
      settings: { redactionEnabled: true },
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
    // The first line is the goal, sourced from the packet's sanitized goal field.
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
    const packet = buildHistoryReaderSessionPacket(info, manager, "check touched files", { maxBytes: 16_000, redactionEnabled: true });

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

describe("mmr-history opt-in content redaction (default OFF)", () => {
  const SENSITIVE = [
    "open /home/someuser/projects/private-project/src/Auth.ts",
    "JINA_API_KEY=jina_AAAAAAAAAAAAAAAAAAAA in env",
  ].join("\n");

  it("buildHistoryReaderSessionPacket leaves content RAW by default (redactionEnabled omitted => product opt-in is OFF at the tools seam)", async () => {
    const { buildHistoryReaderSessionPacket } = await importSource("extensions/mmr-history/analysis-worker.ts");
    const info = sessionInfo({ id: "S-raw", cwd: "/home/someuser/projects/private-project" });
    const manager = await makeManager([
      { role: "user", content: SENSITIVE },
      { role: "assistant", content: "ack" },
    ]);

    // Explicitly false: this is the product default the tools seam passes.
    const packet = buildHistoryReaderSessionPacket(info, manager, "recover /home/someuser/notes", { maxBytes: 16_000, redactionEnabled: false });
    const json = JSON.stringify(packet);

    // Raw artifacts the user asked to recover survive verbatim.
    assert.ok(json.includes("/home/someuser/projects/private-project/src/Auth.ts"), `raw path must survive when redaction is OFF: ${json}`);
    assert.ok(json.includes("jina_AAAAAAAAAAAAAAAAAAAA"), "raw token must survive when redaction is OFF");
    assert.ok(packet.goal.includes("/home/someuser/notes"), "raw goal must survive when redaction is OFF");
    // No content markers leaked in.
    for (const marker of ["[home]", "[token]", "[abs-path]"]) {
      assert.ok(!json.includes(marker), `no content marker expected when redaction is OFF: ${marker}`);
    }
    // projectRef hashing stays ALWAYS on.
    assert.match(packet.projectRef, /^[0-9a-f]{8}$/);
    assert.ok(!json.includes("/home/someuser/projects/private-project\""), "raw cwd must never be surfaced as projectRef");
  });

  it("buildHistoryReaderSessionPacket redacts content when opted in, and projectRef is identical in both modes", async () => {
    const { buildHistoryReaderSessionPacket } = await importSource("extensions/mmr-history/analysis-worker.ts");
    const info = sessionInfo({ id: "S-toggle", cwd: "/home/someuser/projects/private-project" });
    const rawManager = await makeManager([{ role: "user", content: SENSITIVE }, { role: "assistant", content: "ack" }]);
    const redManager = await makeManager([{ role: "user", content: SENSITIVE }, { role: "assistant", content: "ack" }]);

    const raw = buildHistoryReaderSessionPacket(info, rawManager, "goal", { maxBytes: 16_000, redactionEnabled: false });
    const redacted = buildHistoryReaderSessionPacket(info, redManager, "goal", { maxBytes: 16_000, redactionEnabled: true });
    const redJson = JSON.stringify(redacted);

    assert.ok(!redJson.includes("jina_AAAAAAAAAAAAAAAAAAAA"), "token must be redacted when opted in");
    assert.ok(!redJson.includes("/home/someuser"), "home path must be redacted when opted in");
    assert.ok(redJson.includes("[token]"), "token marker must appear when opted in");
    assert.ok(redJson.includes("[home]"), "home marker must appear when opted in");

    // projectRef is a stable hash of cwd, never gated by the toggle.
    assert.equal(raw.projectRef, redacted.projectRef);
    assert.match(raw.projectRef, /^[0-9a-f]{8}$/);
  });

  it("read_session lexical fallback returns RAW excerpts under default settings (redaction opt-in OFF)", async () => {
    const { tool, sessions } = await makeReadSessionTool({
      // default settings: redactionEnabled is unset => false (raw).
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
    assert.ok(text.includes("hunter2"), `raw token must survive lexical read when redaction is OFF: ${text}`);
    assert.ok(text.includes("/home/alice/secret.ts"), `raw path must survive lexical read when redaction is OFF: ${text}`);
    // projectRef hashing is still applied.
    assert.match(result.details.projectRef, /^[0-9a-f]{8}$/);
  });
});

describe("mmr-history worker packet budget-driven selection", () => {
  function fakeManagerWithEntries(count, { textFor, context = true } = {}) {
    const entries = [];
    for (let i = 0; i < count; i++) {
      const tag = String(i).padStart(4, "0");
      entries.push({
        type: "message",
        id: `m${tag}`,
        parentId: i === 0 ? null : `m${String(i - 1).padStart(4, "0")}`,
        timestamp: `2026-05-20T00:00:${tag.slice(-2)}.000Z`,
        message: { role: i % 2 === 0 ? "user" : "assistant", content: textFor ? textFor(i, tag) : `ENTRY-${tag} content` },
      });
    }
    return {
      getEntries: () => entries,
      buildSessionContext: () => ({ messages: context ? entries.map((e) => e.message) : [] }),
    };
  }

  it("preserves far more than the old 40/80 caps under the liberal default budget", async () => {
    const { buildHistoryReaderSessionPacket } = await importSource("extensions/mmr-history/analysis-worker.ts");
    const info = sessionInfo({ id: "S-large", cwd: "/repo/private-project" });
    const manager = fakeManagerWithEntries(300);

    // Default budget (no maxBytes override): liberal, large-context sizing.
    const packet = buildHistoryReaderSessionPacket(info, manager, "survey the whole session");

    assert.equal(packet.truncated, false, "a 300-entry small-text session fits under the default budget");
    assert.ok(packet.entries.length >= 300, `expected all 300 entries, got ${packet.entries.length}`);
    assert.ok(packet.contextMessages.length >= 250, `expected far more than 40 context messages, got ${packet.contextMessages.length}`);
    // Both the earliest and most recent entries are present — nothing was lost head- or tail-first.
    const texts = packet.entries.map((e) => e.text);
    assert.ok(texts.some((t) => t.includes("ENTRY-0000")), "earliest entry must survive");
    assert.ok(texts.some((t) => t.includes("ENTRY-0299")), "most recent entry must survive");
  });

  it("keeps both early and recent content when over budget (balanced, not tail-first loss)", async () => {
    const { buildHistoryReaderSessionPacket } = await importSource("extensions/mmr-history/analysis-worker.ts");
    const info = sessionInfo({ id: "S-overflow", cwd: "/repo/private-project" });
    // Isolate entry selection: empty context so the budget governs entries.
    const manager = fakeManagerWithEntries(200, { context: false });

    // Small budget forces dropping, but the middle-drop strategy keeps the ends.
    const packet = buildHistoryReaderSessionPacket(info, manager, "goal", { maxBytes: 8_000 });

    assert.equal(packet.truncated, true, "an over-budget packet must report truncation");
    assert.ok(packet.entries.length < 200, "some entries must be dropped");
    assert.ok(packet.entries.length >= 3, "the budget should still preserve a head+tail subset");
    const texts = packet.entries.map((e) => e.text);
    assert.ok(texts.some((t) => t.includes("ENTRY-0000")), "earliest entry must survive over-budget trimming");
    assert.ok(texts.some((t) => t.includes("ENTRY-0199")), "most recent entry must survive over-budget trimming");
    // Proof it is not pure tail loss: a middle entry was the one dropped.
    assert.ok(!texts.some((t) => t.includes("ENTRY-0100")), "a middle entry should be dropped first");
  });

  it("shrinks the largest fields before dropping entries when over budget", async () => {
    const { buildHistoryReaderSessionPacket } = await importSource("extensions/mmr-history/analysis-worker.ts");
    const info = sessionInfo({ id: "S-bigfields", cwd: "/repo/private-project" });
    // A handful of entries, each with a very large text field.
    const manager = fakeManagerWithEntries(6, { textFor: (i, tag) => `ENTRY-${tag} ` + "x".repeat(20_000) });

    const packet = buildHistoryReaderSessionPacket(info, manager, "goal", { maxBytes: 20_000 });

    assert.equal(packet.truncated, true);
    // All entries still present (none dropped) because field-shrink reclaimed enough bytes.
    assert.equal(packet.entries.length, 6, "field shrink should run before entry drops");
    for (const entry of packet.entries) {
      assert.ok(entry.text.length < 20_000, "large fields must be shrunk under budget pressure");
    }
  });
});

describe("mmr-history packet tool-call / tool-result fidelity", () => {
  // Fabricated manager: only getEntries() and buildSessionContext() are
  // read by buildHistoryReaderSessionPacket / readSessionForGoal. Carries
  // an assistant tool call (bash with a SQL query), an apply_patch diff,
  // a tool result with command output, and a bashExecution with output.
  function toolActivityManager() {
    const assistant = {
      role: "assistant",
      content: [
        { type: "text", text: "Running the lookup." },
        { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "SELECT id FROM users WHERE active = 1" } },
        { type: "toolCall", id: "tc2", name: "apply_patch", arguments: { patchText: "*** Update File: src/fix.ts\n-old\n+new-line-marker" } },
      ],
    };
    const toolResult = {
      role: "toolResult",
      toolCallId: "tc1",
      toolName: "bash",
      content: [{ type: "text", text: "id\n42\nstdout-result-marker" }],
      isError: false,
    };
    const bashExecution = {
      role: "bashExecution",
      command: "npm run build-step",
      output: "compiled bash-output-marker",
      exitCode: 0,
      cancelled: false,
      truncated: false,
    };
    const entries = [
      { type: "message", id: "m1", parentId: null, timestamp: "2026-05-20T00:00:00.000Z", message: { role: "user", content: "run the lookup" } },
      { type: "message", id: "m2", parentId: "m1", timestamp: "2026-05-20T00:01:00.000Z", message: assistant },
      { type: "message", id: "m3", parentId: "m2", timestamp: "2026-05-20T00:02:00.000Z", message: toolResult },
      { type: "message", id: "m4", parentId: "m3", timestamp: "2026-05-20T00:03:00.000Z", message: bashExecution },
    ];
    return {
      getEntries: () => entries,
      buildSessionContext: () => ({ messages: [assistant, toolResult] }),
    };
  }

  it("includes assistant tool-call name+arguments and tool-result output in the built packet", async () => {
    const { buildHistoryReaderSessionPacket } = await importSource("extensions/mmr-history/analysis-worker.ts");
    const info = sessionInfo({ id: "S-tools", cwd: "/repo/private-project" });
    const packet = buildHistoryReaderSessionPacket(info, toolActivityManager(), "recover query and diff", { maxBytes: 32_000 });

    const toolCalls = packet.entries.flatMap((e) => e.toolCalls ?? []);
    const bashCall = toolCalls.find((c) => c.name === "bash");
    const patchCall = toolCalls.find((c) => c.name === "apply_patch");
    assert.ok(bashCall, "packet entries must surface the bash tool call");
    assert.match(bashCall.args, /SELECT id FROM users WHERE active = 1/);
    assert.ok(patchCall, "packet entries must surface the apply_patch tool call");
    assert.match(patchCall.args, /Update File: src\/fix\.ts/);
    assert.match(patchCall.args, /new-line-marker/);

    const toolResults = packet.entries.flatMap((e) => (e.toolResult ? [e.toolResult] : []));
    assert.ok(
      toolResults.some((r) => r.name === "bash" && /stdout-result-marker/.test(r.text)),
      "packet entries must surface the bash tool-result output",
    );
    // bashExecution: command kept as text, output carried as a synthetic bash result.
    assert.ok(
      packet.entries.some((e) => /npm run build-step/.test(e.text) && e.toolResult && /bash-output-marker/.test(e.toolResult.text)),
      "packet must surface bashExecution command text and captured output",
    );

    // Context messages mirror the same tool fidelity.
    const ctxCalls = packet.contextMessages.flatMap((m) => m.toolCalls ?? []);
    assert.ok(ctxCalls.some((c) => c.name === "bash" && /SELECT id FROM users/.test(c.args)));
    assert.ok(packet.contextMessages.some((m) => m.toolResult && /stdout-result-marker/.test(m.toolResult.text)));
  });

  it("surfaces tool-call args and tool-result output in the lexical fallback excerpts", async () => {
    const { readSessionForGoal } = await importSource("extensions/mmr-history/read-session.ts");
    const info = sessionInfo({ id: "S-tools", cwd: "/repo/private-project" });
    // Each goal token matches a distinct tool-activity excerpt so the
    // term-filtered selection keeps the assistant call, the tool result,
    // and the bashExecution rows.
    const result = readSessionForGoal(info, toolActivityManager(), "select stdout-result-marker build-step bash-output-marker", 32_000);

    const joined = result.excerpts.map((e) => e.text).join("\n");
    assert.match(joined, /SELECT id FROM users WHERE active = 1/);
    assert.match(joined, /stdout-result-marker/);
    assert.match(joined, /npm run build-step/);
    assert.match(joined, /bash-output-marker/);
    // Lexical term matching now reaches into tool activity.
    assert.ok(result.matchedTerms.includes("select"));
    assert.ok(result.matchedTerms.includes("stdout-result-marker"));
  });
});

describe("mmr-history lexical fallback redaction", () => {
  it("lexical excerpts strip secrets and home paths", async () => {
    const { tool, sessions } = await makeReadSessionTool({
      settings: { redactionEnabled: true },
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
