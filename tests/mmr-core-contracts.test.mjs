import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

function fakeRegistry(models, authenticatedProviders = new Set(models.map((model) => `${model.provider}/${model.id}`))) {
  return {
    getAll() {
      return models;
    },
    find(provider, modelId) {
      return models.find((model) => model.provider === provider && model.id === modelId);
    },
    hasConfiguredAuth(model) {
      return authenticatedProviders.has(`${model.provider}/${model.id}`);
    },
    isUsingOAuth(model) {
      return model.provider.endsWith("subscription") || model.provider.endsWith("codex");
    },
  };
}

async function buildSampleState(overrides = {}) {
  const { createMmrModeState } = await importSource("extensions/mmr-core/state.ts");
  const { getMmrMode } = await importSource("extensions/mmr-core/modes.ts");
  const mode = { ...getMmrMode(overrides.modeKey ?? "smart"), ...(overrides.modeOverrides ?? {}) };

  const modelResolution = {
    targetModel: "claude-opus-4-8",
    requestedModels: ["claude-opus-4-8", "gpt-5.5"],
    selectedProvider: "claude-subscription",
    selectedModel: "claude-opus-4-8",
    selectedThinkingLevel: "medium",
    modelFound: true,
    modelApplied: true,
    fallbackApplied: false,
    candidates: [],
    ...(overrides.modelResolution ?? {}),
  };
  const tools = {
    requestedTools: ["read", "oracle"],
    activeTools: ["read"],
    missingTools: [],
    deferredTools: ["oracle"],
    gatedTools: [],
    disabledTools: [],
    decisions: [
      { requested: "read", chosen: "read", chosenTools: ["read"], candidates: ["read"], status: "active", owner: "mmr-core", diagnostic: "read \u2192 read" },
      { requested: "oracle", chosenTools: [], candidates: [], status: "deferred", owner: "mmr-subagents", diagnostic: "oracle: deferred until mmr-subagents ships" },
    ],
    ...(overrides.tools ?? {}),
  };

  return createMmrModeState({
    mode,
    source: overrides.source ?? "command",
    rejectedSources: overrides.rejectedSources,
    modelResolution,
    tools,
    appliedAt: "2026-05-08T00:00:00.000Z",
  });
}

describe("mmr-core public API surface", () => {
  it("does not export setMmrModeState or the runtime singleton from the package root", async () => {
    const root = await importSource("index.ts");
    assert.equal("setMmrModeState" in root, false, "setMmrModeState must remain internal");
    assert.equal("mmrCoreRuntime" in root, false, "runtime singleton object must not leak to root");
    assert.equal("getMmrToolRegistry" in root, false, "raw mutable tool registry must stay internal");
    assert.equal("getMmrFeatureGateRegistry" in root, false, "raw mutable feature gate registry must stay internal");
  });

  it("exports the documented stable helpers from the package root", async () => {
    const root = await importSource("index.ts");
    const expected = [
      "getMmrModeState",
      "getMmrModeStateSnapshot",
      "getMmrPromptRoute",
      "getMmrPolicyDiagnostics",
      "isToolAllowed",
      "onMmrStateChanged",
      "registerMmrToolProvider",
      "registerMmrFeatureGateProvider",
      "resolveMmrFeatureGates",
      "resolveMmrModel",
      "resolveMmrTools",
      "selectMmrModelRoute",
      "MMR_EVENT_STATE_CHANGED",
    ];
    for (const name of expected) {
      assert.equal(typeof root[name] !== "undefined", true, `expected root export "${name}"`);
    }
  });
});

describe("mmr-core mode-state snapshot", () => {
  it("returns a deep copy that callers cannot use to mutate live runtime state", async () => {
    const runtime = await importSource("extensions/mmr-core/runtime.ts");
    const state = await buildSampleState();

    runtime.setMmrModeState(state);

    const snapshot1 = runtime.getMmrModeStateSnapshot();
    assert.notEqual(snapshot1, state, "snapshot must not be the same reference as the live state");
    assert.notEqual(snapshot1.activeTools, state.activeTools, "nested arrays must be cloned");
    assert.notEqual(snapshot1.resolution, state.resolution, "nested objects must be cloned");

    snapshot1.activeTools.push("compromised");
    snapshot1.resolution.toolDecisions.push({ requested: "evil" });

    const snapshot2 = runtime.getMmrModeStateSnapshot();
    assert.deepEqual(snapshot2.activeTools, state.activeTools, "mutating snapshot must not affect live state");
    assert.equal(snapshot2.resolution.toolDecisions.length, state.resolution.toolDecisions.length);

    runtime.setMmrModeState(undefined);
    assert.equal(runtime.getMmrModeStateSnapshot(), undefined);
  });

  it("root getMmrModeStateSnapshot is exported and observes the same singleton as root getMmrModeState", async () => {
    const root = await importSource("index.ts");
    assert.equal(typeof root.getMmrModeStateSnapshot, "function");
    // No state has been set on this fresh module instance, so both views agree.
    assert.equal(root.getMmrModeStateSnapshot(), undefined);
    assert.equal(root.getMmrModeState(), undefined);
  });
});

describe("mmr-core worker model preference resolution", () => {
  it("selectMmrModelRoute picks the highest-priority registered+authenticated route without applying", async () => {
    const { selectMmrModelRoute } = await importSource("extensions/mmr-core/model-resolver.ts");

    const registry = fakeRegistry([
      { provider: "openai", id: "gpt-5.5" },
      { provider: "openai-codex", id: "gpt-5.5" },
    ]);

    const selection = selectMmrModelRoute({
      modeThinkingLevel: "xhigh",
      modelPreferences: [{ model: "gpt-5.5" }],
      registry,
    });

    assert.ok(selection.selected, "expected a selected route");
    assert.equal(selection.selected.provider, "openai-codex");
    assert.equal(selection.selected.model, "gpt-5.5");
    assert.equal(selection.selected.thinkingLevel, "xhigh");
    assert.equal(selection.selected.registeredModel.provider, "openai-codex");
    assert.ok(selection.candidates.length >= 1);
    assert.equal(selection.candidates[0].provider, "openai-codex");
    // Worker selection must not flip Pi's setModel; only the route description is returned.
    assert.equal("setModel" in selection, false);
  });

  it("selectMmrModelRoute falls back across families when preferred routes are unauthenticated", async () => {
    const { selectMmrModelRoute } = await importSource("extensions/mmr-core/model-resolver.ts");

    const registry = fakeRegistry(
      [
        { provider: "openai-codex", id: "gpt-5.5" },
        { provider: "claude-subscription", id: "claude-opus-4-8" },
      ],
      new Set(["claude-subscription/claude-opus-4-8"]),
    );

    const selection = selectMmrModelRoute({
      modelPreferences: [{ model: "gpt-5.5" }, { model: "claude-opus-4-8" }],
      registry,
    });

    assert.ok(selection.selected);
    assert.equal(selection.selected.provider, "claude-subscription");
    assert.equal(selection.selected.model, "claude-opus-4-8");
    const skipped = selection.candidates.find((candidate) => candidate.provider === "openai-codex");
    assert.equal(skipped?.reason, "registered but not authenticated");
  });

  it("selectMmrModelRoute returns undefined selection when no candidate is registered", async () => {
    const { selectMmrModelRoute } = await importSource("extensions/mmr-core/model-resolver.ts");

    const registry = fakeRegistry([]);
    const selection = selectMmrModelRoute({
      modelPreferences: [{ model: "gpt-5.5" }],
      registry,
    });

    assert.equal(selection.selected, undefined);
    assert.equal(selection.candidates.every((candidate) => !candidate.registered), true);
  });

  it("resolveAndApplyMmrModel still works and yields the same primary route as selectMmrModelRoute when Pi accepts the model", async () => {
    const { selectMmrModelRoute, resolveAndApplyMmrModel } = await importSource("extensions/mmr-core/model-resolver.ts");
    const registry = fakeRegistry([
      { provider: "openai-codex", id: "gpt-5.5" },
      { provider: "openai", id: "gpt-5.5" },
    ]);

    const planned = selectMmrModelRoute({ modelPreferences: [{ model: "gpt-5.5" }], registry });
    const applied = await resolveAndApplyMmrModel({
      modelPreferences: [{ model: "gpt-5.5" }],
      registry,
      setModel: async () => true,
    });

    assert.equal(planned.selected?.provider, applied.selectedProvider);
    assert.equal(planned.selected?.model, applied.selectedModel);
  });
});

describe("mmr-core prompt route helper", () => {
  it("getMmrPromptRoute returns the prompt route for any mode key", async () => {
    const { getMmrPromptRoute } = await importSource("extensions/mmr-core/runtime.ts");
    assert.equal(getMmrPromptRoute("smart"), "default");
    assert.equal(getMmrPromptRoute("rush"), "rush");
    assert.equal(getMmrPromptRoute("deep"), "deep");
    assert.equal(getMmrPromptRoute("free"), "default");
  });

  it("root getMmrPromptRoute is exported", async () => {
    const root = await importSource("index.ts");
    assert.equal(root.getMmrPromptRoute("rush"), "rush");
  });
});

describe("mmr-core policy diagnostics", () => {
  it("returns an empty diagnostics array for a clean locked-mode state", async () => {
    const { getMmrPolicyDiagnostics } = await importSource("extensions/mmr-core/diagnostics.ts");
    const state = await buildSampleState({
      modeOverrides: { availabilityNotes: [] },
      tools: {
        requestedTools: ["read"],
        activeTools: ["read"],
        missingTools: [],
        deferredTools: [],
        gatedTools: [],
        disabledTools: [],
        decisions: [],
      },
    });
    assert.deepEqual(getMmrPolicyDiagnostics(state), []);
  });

  it("returns an empty diagnostics array in free mode regardless of model state", async () => {
    const { getMmrPolicyDiagnostics } = await importSource("extensions/mmr-core/diagnostics.ts");
    const state = await buildSampleState({
      modeKey: "free",
      modelResolution: {
        targetModel: "",
        requestedModels: [],
        modelFound: false,
        modelApplied: false,
        fallbackApplied: false,
        candidates: [],
      },
      tools: {
        requestedTools: [],
        activeTools: ["read", "bash"],
        missingTools: [],
        deferredTools: [],
        gatedTools: [],
        disabledTools: [],
        decisions: [],
      },
    });
    assert.deepEqual(getMmrPolicyDiagnostics(state), []);
  });

  it("emits structured diagnostics with codes and severity for fallback, missing tools, and availability notes", async () => {
    const { getMmrPolicyDiagnostics } = await importSource("extensions/mmr-core/diagnostics.ts");
    const state = await buildSampleState({
      modeOverrides: { availabilityNotes: ["Runtime subagent behavior is not implemented in mmr-core."] },
      modelResolution: {
        fallbackApplied: true,
        fallbackReason: "Selected fallback after skipping openai-codex/gpt-5.5: not registered.",
      },
      tools: {
        requestedTools: ["read", "oracle"],
        activeTools: ["read"],
        missingTools: ["oracle"],
        deferredTools: [],
        gatedTools: ["chart"],
        disabledTools: ["disabled_example"],
        decisions: [],
      },
    });

    const diagnostics = getMmrPolicyDiagnostics(state);
    const codes = diagnostics.map((diag) => diag.code);
    assert.deepEqual(codes, [
      "model.fallback-applied",
      "tools.missing",
      "tools.gated",
      "tools.disabled",
      "availability",
    ]);
    for (const diag of diagnostics) {
      assert.equal(diag.source, "mmr-core");
      assert.equal(diag.severity, "warning");
      assert.equal(typeof diag.message, "string");
      assert.notEqual(diag.message.length, 0);
    }
    assert.match(diagnostics[0].message, /fallback/);
    assert.deepEqual(diagnostics[1].data?.tools, ["oracle"]);
    assert.deepEqual(diagnostics[2].data?.tools, ["chart"]);
    assert.deepEqual(diagnostics[3].data?.tools, ["disabled_example"]);
    assert.equal(diagnostics[4].data?.note, "Runtime subagent behavior is not implemented in mmr-core.");
  });

  it("emits a model.not-applied diagnostic when a locked mode resolved no usable model", async () => {
    const { getMmrPolicyDiagnostics } = await importSource("extensions/mmr-core/diagnostics.ts");
    const state = await buildSampleState({
      modelResolution: {
        targetModel: "gpt-5.5",
        requestedModels: ["gpt-5.5"],
        selectedProvider: undefined,
        selectedModel: undefined,
        selectedThinkingLevel: undefined,
        modelFound: false,
        modelApplied: false,
        fallbackApplied: false,
        candidates: [],
      },
      tools: {
        requestedTools: ["read"],
        activeTools: ["read"],
        missingTools: [],
        deferredTools: [],
        gatedTools: [],
        disabledTools: [],
        decisions: [],
      },
    });

    const diagnostics = getMmrPolicyDiagnostics(state);
    assert.equal(diagnostics[0].code, "model.not-applied");
    assert.equal(diagnostics[0].data?.modelFound, false);
  });

  it("emits a tools.none-active diagnostic when activeTools is empty", async () => {
    const { getMmrPolicyDiagnostics } = await importSource("extensions/mmr-core/diagnostics.ts");
    const state = await buildSampleState({
      tools: {
        requestedTools: ["oracle"],
        activeTools: [],
        missingTools: ["oracle"],
        deferredTools: [],
        gatedTools: [],
        disabledTools: [],
        decisions: [],
      },
    });
    const diagnostics = getMmrPolicyDiagnostics(state);
    const codes = diagnostics.map((diag) => diag.code);
    assert.equal(codes.includes("tools.none-active"), true);
  });

  it("status output joins diagnostic messages so the human-readable warnings remain stable", async () => {
    const { formatMmrStatus } = await importSource("extensions/mmr-core/status.ts");
    const state = await buildSampleState({
      modeOverrides: { availabilityNotes: ["Runtime subagent behavior is not implemented in mmr-core."] },
      modelResolution: {
        fallbackApplied: true,
        fallbackReason: "Selected fallback after skipping openai-codex/gpt-5.5: not registered.",
      },
      tools: {
        requestedTools: ["read", "oracle"],
        activeTools: ["read"],
        missingTools: ["oracle"],
        deferredTools: [],
        gatedTools: [],
        disabledTools: [],
        decisions: [],
      },
    });

    const status = formatMmrStatus(state);
    assert.match(
      status,
      /Policy warnings: model fallback applied: Selected fallback after skipping openai-codex\/gpt-5\.5: not registered\. Using only one provider is not recommended because MMR modes are optimized around model-specific strengths and weaknesses\.; missing tools: oracle; Runtime subagent behavior is not implemented in mmr-core\./,
    );
  });
});

describe("mmr-core activation notifications use the policy diagnostic pipeline", () => {
  it("renders activation warnings from getMmrPolicyDiagnostics messages, with deferred tools appended separately", async () => {
    const runtime = await importSource("extensions/mmr-core/runtime.ts");
    runtime.setMmrModeState(undefined);
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;

    const handlers = new Map();
    const commands = new Map();
    const pi = {
      registerFlag: () => {},
      getFlag: () => undefined,
      getActiveTools: () => ["read", "bash"],
      getAllTools: () => ["read", "bash", "edit", "write", "grep", "find", "ls"].map((name) => ({ name })),
      setActiveTools: () => {},
      setModel: async () => true,
      setThinkingLevel: () => {},
      appendEntry: () => {},
      registerCommand: (name, command) => commands.set(name, command),
      registerShortcut: () => {},
      on: (name, handler) => handlers.set(name, handler),
      events: { emit: () => {}, on: () => {}, off: () => {} },
    };
    extension(pi);

    const notifications = [];
    // Fallback scenario: deep mode prefers gpt-5.5 first; only the Opus
    // fallback is registered, so a fallback diagnostic and per-mode
    // availability/deferred messages should fire.
    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      ui: {
        notify: (message, level) => notifications.push({ message, level }),
        setStatus: () => {},
        theme: { fg: (_color, value) => value },
      },
      sessionManager: { getEntries: () => [] },
      modelRegistry: {
        getAll: () => [{ provider: "claude-subscription", id: "claude-opus-4-8" }],
        find: (provider, modelId) => (provider === "claude-subscription" && modelId === "claude-opus-4-8" ? { provider, id: modelId } : undefined),
        hasConfiguredAuth: () => true,
        isUsingOAuth: (model) => model.provider.endsWith("subscription") || model.provider.endsWith("codex"),
      },
    };

    await handlers.get("session_start")({}, ctx);
    await commands.get("mode").handler("deep", ctx);

    const activation = notifications.at(-1);
    assert.equal(activation.level, "warning");
    // Diagnostic-derived: model.fallback-applied message.
    assert.match(activation.message, /model fallback applied: /);
    // Deferred-tool messages still surface, appended after policy warnings.
    assert.match(activation.message, /oracle: deferred until mmr-subagents ships/);
  });
});

describe("mmr-core event constants", () => {
  it("exports a stable state-change event name from runtime and root", async () => {
    const runtime = await importSource("extensions/mmr-core/runtime.ts");
    const root = await importSource("index.ts");
    assert.equal(typeof runtime.MMR_EVENT_STATE_CHANGED, "string");
    assert.notEqual(runtime.MMR_EVENT_STATE_CHANGED.length, 0);
    assert.equal(runtime.MMR_EVENT_STATE_CHANGED, root.MMR_EVENT_STATE_CHANGED);
    assert.match(runtime.MMR_EVENT_STATE_CHANGED, /^mmr-core:/);
  });

  it("onMmrStateChanged hands each handler its own deep-cloned snapshot per emission", async () => {
    const { onMmrStateChanged, MMR_EVENT_STATE_CHANGED } = await importSource("extensions/mmr-core/runtime.ts");

    const subscribers = new Map();
    const pi = {
      events: {
        on(name, handler) {
          if (!subscribers.has(name)) subscribers.set(name, []);
          subscribers.get(name).push(handler);
        },
      },
    };

    const seenA = [];
    const seenB = [];
    onMmrStateChanged(pi, (state) => seenA.push(state));
    onMmrStateChanged(pi, (state) => seenB.push(state));

    const livePayload = {
      mode: "smart",
      activeTools: ["read"],
      missingTools: [],
      deferredTools: [],
      gatedTools: [],
      disabledTools: [],
      resolution: { toolDecisions: [], featureGateDecisions: [], rejectedSources: [], modelDecision: { fallbackApplied: false }, selectedSource: "command" },
    };

    // Fan out a single emission to both subscribers, the way Pi's bus does.
    for (const handler of subscribers.get(MMR_EVENT_STATE_CHANGED) ?? []) handler(livePayload);

    assert.equal(seenA.length, 1);
    assert.equal(seenB.length, 1);
    assert.notEqual(seenA[0], seenB[0], "each handler must receive its own clone");
    assert.notEqual(seenA[0], livePayload, "clone must not be the live payload");

    // Mutating handler A's clone must not affect handler B's clone or the
    // live payload that other (raw) listeners might still observe.
    seenA[0].activeTools.push("compromised");
    assert.equal(seenB[0].activeTools.includes("compromised"), false);
    assert.equal(livePayload.activeTools.includes("compromised"), false);
  });

  it("onMmrStateChanged forwards undefined payloads (state cleared) without throwing", async () => {
    const { onMmrStateChanged, MMR_EVENT_STATE_CHANGED } = await importSource("extensions/mmr-core/runtime.ts");
    const handlers = [];
    const pi = { events: { on: (_name, handler) => { handlers.push(handler); return () => {}; } } };
    const seen = [];
    onMmrStateChanged(pi, (state) => seen.push(state));
    handlers[0](undefined);
    assert.equal(seen.length, 1);
    assert.equal(seen[0], undefined);
    assert.equal(MMR_EVENT_STATE_CHANGED.length > 0, true);
  });

  it("onMmrStateChanged returns the underlying unsubscribe function from Pi's event bus", async () => {
    const { onMmrStateChanged } = await importSource("extensions/mmr-core/runtime.ts");

    let detached = 0;
    const subscribers = new Map();
    const pi = {
      events: {
        on(name, handler) {
          if (!subscribers.has(name)) subscribers.set(name, []);
          subscribers.get(name).push(handler);
          return () => {
            detached += 1;
            const list = subscribers.get(name) ?? [];
            const idx = list.indexOf(handler);
            if (idx >= 0) list.splice(idx, 1);
          };
        },
      },
    };

    const unsubscribe = onMmrStateChanged(pi, () => {});
    assert.equal(typeof unsubscribe, "function");
    unsubscribe();
    assert.equal(detached, 1);
  });

  it("onMmrStateChanged returns a no-op unsubscribe when the host's events.on returns void", async () => {
    const { onMmrStateChanged } = await importSource("extensions/mmr-core/runtime.ts");
    const pi = { events: { on: () => undefined } };
    const unsubscribe = onMmrStateChanged(pi, () => {});
    assert.equal(typeof unsubscribe, "function");
    unsubscribe(); // must not throw
  });

  it("the mmr-core extension emits MMR_EVENT_STATE_CHANGED on the Pi event bus when a mode is applied", async () => {
    const runtime = await importSource("extensions/mmr-core/runtime.ts");
    runtime.setMmrModeState(undefined);
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;

    const handlers = new Map();
    const commands = new Map();
    const emissions = [];
    const pi = {
      registerFlag: () => {},
      getFlag: () => undefined,
      getActiveTools: () => ["read", "bash"],
      getAllTools: () => ["read", "bash", "edit", "write"].map((name) => ({ name })),
      setActiveTools: () => {},
      setModel: async () => true,
      setThinkingLevel: () => {},
      appendEntry: () => {},
      registerCommand: (name, command) => commands.set(name, command),
      registerShortcut: () => {},
      on: (name, handler) => handlers.set(name, handler),
      events: {
        emit: (name, payload) => emissions.push({ name, payload }),
        on: () => {},
        off: () => {},
      },
    };

    extension(pi);

    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (_color, value) => value } },
      sessionManager: { getEntries: () => [] },
      modelRegistry: {
        getAll: () => [{ provider: "openai-codex", id: "gpt-5.5" }, { provider: "anthropic", id: "claude-opus-4-8" }],
        find: (provider, modelId) => ({ provider, id: modelId }),
        hasConfiguredAuth: () => true,
        isUsingOAuth: (model) => model.provider.endsWith("codex"),
      },
    };

    await handlers.get("session_start")({}, ctx);
    await commands.get("mode").handler("deep", ctx);
    const afterDeep = emissions.filter((entry) => entry.name === runtime.MMR_EVENT_STATE_CHANGED).length;
    assert.notEqual(afterDeep, 0, "expected at least one state-change emission after applying a mode");

    const lastDeep = emissions.findLast((entry) => entry.name === runtime.MMR_EVENT_STATE_CHANGED);
    assert.equal(lastDeep.payload?.mode, "deep");

    // Raw bus payload is the deep-frozen runtime singleton (single-clone
    // contract): attempts to mutate must throw, and consecutive emissions
    // must be distinct objects so subscribers cannot bleed state across
    // applications via the shared reference.
    assert.equal(Object.isFrozen(lastDeep.payload), true);
    assert.throws(() => lastDeep.payload.activeTools.push("compromised"), /read only|object is not extensible|Cannot add property/i);
    await commands.get("mode").handler("rush", ctx);
    const lastRush = emissions.findLast((entry) => entry.name === runtime.MMR_EVENT_STATE_CHANGED);
    assert.equal(lastRush.payload?.mode, "rush");
    assert.notEqual(lastRush.payload, lastDeep.payload, "each apply produces a fresh state object");
  });
});
