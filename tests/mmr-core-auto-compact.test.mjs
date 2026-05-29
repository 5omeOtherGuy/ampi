import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const SMART_OPUS = {
  provider: "claude-subscription",
  id: "claude-opus-4-8",
  contextWindow: 1_000_000,
  maxTokens: 128_000,
};

const GPT_FALLBACK = {
  provider: "openai-codex",
  id: "gpt-5.5",
  contextWindow: 400_000,
  maxTokens: 128_000,
};

async function importAutoCompact() {
  return importSource("extensions/mmr-core/auto-compact.ts");
}

async function importRuntime() {
  const runtimeUrl = pathToFileURL(path.join(getPreparedSourceRoot(), "extensions/mmr-core/runtime.ts")).href;
  return import(runtimeUrl);
}

beforeEach(async () => {
  const runtime = await importRuntime();
  runtime.setMmrModeState(undefined);
  runtime.setMmrSubagentState?.(undefined);
});

describe("decideAutoCompact (pure)", () => {
  it("exports a 900k token threshold tied to smart-mode opus-4-8", async () => {
    const mod = await importAutoCompact();
    assert.equal(mod.MMR_SMART_OPUS_COMPACT_THRESHOLD_TOKENS, 900_000);
  });

  it("triggers compact-and-replay at the threshold for smart + opus-4-8", async () => {
    const { decideAutoCompact } = await importAutoCompact();
    const decision = decideAutoCompact({
      source: "interactive",
      text: "next prompt",
      images: undefined,
      modeState: { mode: "smart", model: "claude-opus-4-8" },
      subagentActive: false,
      usageTokens: 900_000,
    });
    assert.deepEqual(decision, { kind: "compact-and-replay", text: "next prompt", images: undefined });
  });

  it("propagates images on replay decisions", async () => {
    const { decideAutoCompact } = await importAutoCompact();
    const images = [{ source: { type: "base64", media_type: "image/png", data: "..." } }];
    const decision = decideAutoCompact({
      source: "interactive",
      text: "with image",
      images,
      modeState: { mode: "smart", model: "claude-opus-4-8" },
      subagentActive: false,
      usageTokens: 910_000,
    });
    assert.equal(decision.kind, "compact-and-replay");
    assert.equal(decision.text, "with image");
    assert.equal(decision.images, images);
  });

  it("no-ops when usage is below the threshold", async () => {
    const { decideAutoCompact } = await importAutoCompact();
    const decision = decideAutoCompact({
      source: "interactive",
      text: "hi",
      images: undefined,
      modeState: { mode: "smart", model: "claude-opus-4-8" },
      subagentActive: false,
      usageTokens: 269_999,
    });
    assert.deepEqual(decision, { kind: "noop" });
  });

  it("no-ops when usage tokens are null (post-compaction or unavailable)", async () => {
    const { decideAutoCompact } = await importAutoCompact();
    const decision = decideAutoCompact({
      source: "interactive",
      text: "hi",
      images: undefined,
      modeState: { mode: "smart", model: "claude-opus-4-8" },
      subagentActive: false,
      usageTokens: null,
    });
    assert.deepEqual(decision, { kind: "noop" });
  });

  it("no-ops when usage is undefined", async () => {
    const { decideAutoCompact } = await importAutoCompact();
    const decision = decideAutoCompact({
      source: "interactive",
      text: "hi",
      images: undefined,
      modeState: { mode: "smart", model: "claude-opus-4-8" },
      subagentActive: false,
      usageTokens: undefined,
    });
    assert.deepEqual(decision, { kind: "noop" });
  });

  it("no-ops for non-smart modes even at high usage", async () => {
    const { decideAutoCompact } = await importAutoCompact();
    for (const mode of ["free", "large", "rush", "deep", "smartGPT"]) {
      const decision = decideAutoCompact({
        source: "interactive",
        text: "hi",
        images: undefined,
        modeState: { mode, model: "claude-opus-4-8" },
        subagentActive: false,
        usageTokens: 910_000,
      });
      assert.deepEqual(decision, { kind: "noop" }, `expected noop for mode=${mode}`);
    }
  });

  it("no-ops for smart mode on a different model (e.g. gpt-5.5)", async () => {
    const { decideAutoCompact } = await importAutoCompact();
    for (const model of ["gpt-5.5", "claude-haiku-4-5", ""]) {
      const decision = decideAutoCompact({
        source: "interactive",
        text: "hi",
        images: undefined,
        modeState: { mode: "smart", model },
        subagentActive: false,
        usageTokens: 910_000,
      });
      assert.deepEqual(decision, { kind: "noop" }, `expected noop for model=${model}`);
    }
  });

  it("no-ops when no mode state is set", async () => {
    const { decideAutoCompact } = await importAutoCompact();
    const decision = decideAutoCompact({
      source: "interactive",
      text: "hi",
      images: undefined,
      modeState: undefined,
      subagentActive: false,
      usageTokens: 910_000,
    });
    assert.deepEqual(decision, { kind: "noop" });
  });

  it("no-ops while a subagent worker is active (replay-loop and worker isolation)", async () => {
    const { decideAutoCompact } = await importAutoCompact();
    const decision = decideAutoCompact({
      source: "interactive",
      text: "hi",
      images: undefined,
      modeState: { mode: "smart", model: "claude-opus-4-8" },
      subagentActive: true,
      usageTokens: 910_000,
    });
    assert.deepEqual(decision, { kind: "noop" });
  });

  it("no-ops when source is 'extension' (replay arriving via pi.sendUserMessage)", async () => {
    const { decideAutoCompact } = await importAutoCompact();
    const decision = decideAutoCompact({
      source: "extension",
      text: "hi",
      images: undefined,
      modeState: { mode: "smart", model: "claude-opus-4-8" },
      subagentActive: false,
      usageTokens: 910_000,
    });
    assert.deepEqual(decision, { kind: "noop" });
  });
});

function createPi() {
  return createMockPi({
    activeTools: ["read", "bash"],
    allTools: ["read", "bash"],
    initialModel: SMART_OPUS,
  });
}

describe("mmr-core input hook (smart-mode auto-compact)", () => {
  it("registers an input handler at extension load", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const { pi, handlers } = createPi();
    extension(pi);
    assert.equal(typeof handlers.get("input"), "function", "expected pi.on('input', ...) registration");
  });

  it("returns { action: 'handled' }, triggers ctx.compact, and replays via pi.sendUserMessage on completion", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const { pi, handlers, calls } = createPi();
    const { ctx, compactCalls } = createMockExtensionContext({
      models: [SMART_OPUS],
      model: SMART_OPUS,
      getContextUsage: () => ({ tokens: 910_000, contextWindow: 1_000_000, percent: 90.5 }),
    });

    extension(pi);
    // Activate smart mode by running the standard session_start path.
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    const result = await handlers.get("input")(
      { type: "input", text: "next prompt", source: "interactive" },
      ctx,
    );

    assert.deepEqual(result, { action: "handled" });
    assert.equal(compactCalls.length, 1, "expected ctx.compact to be called once");
    assert.equal(calls.sendUserMessage.length, 0, "replay must wait for compact onComplete");

    // Simulate Pi firing onComplete after compaction succeeds.
    compactCalls[0].onComplete?.({ summary: "ok", firstKeptEntryId: "x", tokensBefore: 910_000 });

    assert.equal(calls.sendUserMessage.length, 1, "expected exactly one replay submission");
    assert.equal(calls.sendUserMessage[0].content, "next prompt");
  });

  it("preserves images on replay by combining text+images into the content array", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const { pi, handlers, calls } = createPi();
    const { ctx, compactCalls } = createMockExtensionContext({
      models: [SMART_OPUS],
      model: SMART_OPUS,
      getContextUsage: () => ({ tokens: 905_000, contextWindow: 1_000_000, percent: 90.5 }),
    });
    const images = [{ type: "image", source: { type: "base64", media_type: "image/png", data: "..." } }];

    extension(pi);
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    await handlers.get("input")(
      { type: "input", text: "look at this", images, source: "interactive" },
      ctx,
    );
    compactCalls[0].onComplete?.({ summary: "ok", firstKeptEntryId: "x", tokensBefore: 905_000 });

    const replay = calls.sendUserMessage[0].content;
    assert.ok(Array.isArray(replay), "expected replay content to be an array when images are present");
    assert.deepEqual(replay[0], { type: "text", text: "look at this" });
    assert.deepEqual(replay.slice(1), images);
  });

  it("does not trigger when below threshold", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const { pi, handlers, calls } = createPi();
    const { ctx, compactCalls } = createMockExtensionContext({
      models: [SMART_OPUS],
      model: SMART_OPUS,
      getContextUsage: () => ({ tokens: 200_000, contextWindow: 1_000_000, percent: 66 }),
    });

    extension(pi);
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    const result = await handlers.get("input")(
      { type: "input", text: "hi", source: "interactive" },
      ctx,
    );

    assert.equal(result, undefined);
    assert.equal(compactCalls.length, 0);
    assert.equal(calls.sendUserMessage.length, 0);
  });

  it("does not trigger on a non-smart model even at high usage", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const { pi, handlers, calls } = createPi();
    const { ctx, compactCalls } = createMockExtensionContext({
      models: [GPT_FALLBACK],
      model: GPT_FALLBACK,
      getContextUsage: () => ({ tokens: 910_000, contextWindow: 1_000_000, percent: 29 }),
    });

    extension(pi);
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    // Force the resolved model id to a non-Opus variant for this assertion.
    const runtime = await importRuntime();
    const state = runtime.getMmrModeState();
    if (state) runtime.setMmrModeState({ ...state, model: "gpt-5.5" });

    const result = await handlers.get("input")(
      { type: "input", text: "hi", source: "interactive" },
      ctx,
    );

    assert.equal(result, undefined);
    assert.equal(compactCalls.length, 0);
    assert.equal(calls.sendUserMessage.length, 0);
  });

  it("does not trigger on the replay (source = 'extension')", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const { pi, handlers, calls } = createPi();
    const { ctx, compactCalls } = createMockExtensionContext({
      models: [SMART_OPUS],
      model: SMART_OPUS,
      getContextUsage: () => ({ tokens: 910_000, contextWindow: 1_000_000, percent: 91 }),
    });

    extension(pi);
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    const result = await handlers.get("input")(
      { type: "input", text: "replayed", source: "extension" },
      ctx,
    );

    assert.equal(result, undefined);
    assert.equal(compactCalls.length, 0);
    assert.equal(calls.sendUserMessage.length, 0);
  });
});
