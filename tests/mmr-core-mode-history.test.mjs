import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

function event(overrides = {}) {
  return {
    at: "2026-05-08T00:00:00.000Z",
    mode: "medium",
    previousMode: undefined,
    source: "command",
    model: "claude-subscription/claude-opus-4-8",
    thinkingLevel: "medium",
    fallbackApplied: false,
    fallbackReason: undefined,
    ...overrides,
  };
}

describe("mmr-core mode/fallback history ring buffer", () => {
  it("appends events oldest-to-newest", async () => {
    const { createMmrCoreRuntime } = await importSource("extensions/ampi-core/runtime.ts");
    const runtime = createMmrCoreRuntime();

    runtime.recordMmrModeEvent(event({ mode: "low", at: "t1" }));
    runtime.recordMmrModeEvent(event({ mode: "medium", previousMode: "low", at: "t2" }));

    const history = runtime.getMmrModeHistory();
    assert.equal(history.length, 2);
    assert.equal(history[0].mode, "low");
    assert.equal(history[1].mode, "medium");
    assert.equal(history[1].previousMode, "low");
  });

  it("collapses consecutive duplicate events but keeps distinct ones", async () => {
    const { createMmrCoreRuntime } = await importSource("extensions/ampi-core/runtime.ts");
    const runtime = createMmrCoreRuntime();

    // Same observable content, different timestamp -> collapsed.
    runtime.recordMmrModeEvent(event({ at: "t1" }));
    runtime.recordMmrModeEvent(event({ at: "t2" }));
    assert.equal(runtime.getMmrModeHistory().length, 1);

    // A fallback change is observable -> recorded.
    runtime.recordMmrModeEvent(event({ at: "t3", fallbackApplied: true, fallbackReason: "primary unavailable" }));
    assert.equal(runtime.getMmrModeHistory().length, 2);
  });

  it("trims FIFO to the bounded cap", async () => {
    const mod = await importSource("extensions/ampi-core/runtime.ts");
    const runtime = mod.createMmrCoreRuntime();
    const cap = mod.MMR_MODE_HISTORY_LIMIT;

    for (let i = 0; i < cap + 5; i += 1) {
      // Alternate source so consecutive entries are never collapsed.
      runtime.recordMmrModeEvent(event({ at: `t${i}`, source: i % 2 === 0 ? "command" : "session" }));
    }

    const history = runtime.getMmrModeHistory();
    assert.equal(history.length, cap);
    // Oldest retained entry is the one at index 5 (first 5 dropped).
    assert.equal(history[0].at, "t5");
    assert.equal(history[history.length - 1].at, `t${cap + 4}`);
  });

  it("returns copies that cannot mutate stored history", async () => {
    const { createMmrCoreRuntime } = await importSource("extensions/ampi-core/runtime.ts");
    const runtime = createMmrCoreRuntime();
    runtime.recordMmrModeEvent(event({ at: "t1" }));

    const first = runtime.getMmrModeHistory();
    first[0].mode = "MUTATED";
    assert.equal(runtime.getMmrModeHistory()[0].mode, "medium");
  });
});

describe("/mmr-status debug mode/fallback history rendering", () => {
  it("renders the history block newest-first only in debug mode", async () => {
    const { formatMmrStatus } = await importSource("extensions/ampi-core/status.ts");
    const { createMmrModeState } = await importSource("extensions/ampi-core/state.ts");
    const { getMmrMode } = await importSource("extensions/ampi-core/modes.ts");

    const state = createMmrModeState({
      mode: getMmrMode("medium"),
      source: "command",
      modelResolution: {
        targetModel: "claude-opus-4-8",
        requestedModels: ["claude-opus-4-8"],
        selectedProvider: "claude-subscription",
        selectedModel: "claude-opus-4-8",
        selectedThinkingLevel: "medium",
        modelFound: true,
        modelApplied: true,
        fallbackApplied: false,
        candidates: [],
      },
      tools: {
        requestedTools: [],
        activeTools: ["read"],
        missingTools: [],
        deferredTools: [],
        gatedTools: [],
        disabledTools: [],
        decisions: [],
      },
      appliedAt: "2026-05-08T00:00:00.000Z",
    });

    const modeHistory = [
      event({ at: "2026-05-08T00:00:00.000Z", mode: "low", source: "default", model: "gpt-5.5/x" }),
      event({
        at: "2026-05-08T00:01:00.000Z",
        mode: "medium",
        previousMode: "low",
        source: "command",
        model: "claude-subscription/claude-opus-4-8",
        fallbackApplied: true,
        fallbackReason: "primary provider unavailable",
      }),
    ];

    // Without debug: no history block.
    const plain = formatMmrStatus(state, { modeHistory });
    assert.ok(!plain.includes("Mode/fallback history"), "history must not appear without debug");

    // With debug: history block present, newest first, with transition + fallback.
    const debug = formatMmrStatus(state, { debug: true, modeHistory });
    assert.ok(debug.includes("Mode/fallback history (newest first):"));
    const newestIdx = debug.indexOf("low → medium (source: command)");
    const oldestIdx = debug.indexOf("low (source: default)");
    assert.ok(newestIdx >= 0, "expected newest transition line");
    assert.ok(oldestIdx >= 0, "expected oldest entry line");
    assert.ok(newestIdx < oldestIdx, "newest entry must render before oldest");
    assert.ok(debug.includes("fallback:yes - primary provider unavailable"));
  });

  it("omits the history block when there is no history", async () => {
    const { formatMmrStatus } = await importSource("extensions/ampi-core/status.ts");
    const { createMmrModeState } = await importSource("extensions/ampi-core/state.ts");
    const { getMmrMode } = await importSource("extensions/ampi-core/modes.ts");

    const state = createMmrModeState({
      mode: getMmrMode("medium"),
      source: "command",
      modelResolution: {
        targetModel: "claude-opus-4-8",
        requestedModels: ["claude-opus-4-8"],
        selectedProvider: "claude-subscription",
        selectedModel: "claude-opus-4-8",
        modelFound: true,
        modelApplied: true,
        fallbackApplied: false,
        candidates: [],
      },
      tools: {
        requestedTools: [],
        activeTools: ["read"],
        missingTools: [],
        deferredTools: [],
        gatedTools: [],
        disabledTools: [],
        decisions: [],
      },
      appliedAt: "2026-05-08T00:00:00.000Z",
    });

    const debug = formatMmrStatus(state, { debug: true, modeHistory: [] });
    assert.ok(debug.includes("Debug:"));
    assert.ok(!debug.includes("Mode/fallback history"));
  });
});
