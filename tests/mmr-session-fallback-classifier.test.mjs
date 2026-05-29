import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

describe("mmr-session-fallback quota classifier", () => {
  it("prompts for subscription usage-limit messages", async () => {
    const { classifyMmrSessionFallbackError } = await importSource("extensions/mmr-session-fallback/classifier.ts");

    const result = classifyMmrSessionFallbackError({
      provider: "openai-codex",
      errorMessage: "You have hit your ChatGPT usage limit (plus plan). Try again in ~17 min.",
    });

    assert.equal(result.shouldPrompt, true);
    assert.equal(result.kind, "openai-usage-limit");
    assert.match(result.friendlyMessage, /usage limit/i);
  });

  it("prompts for claude-subscription rate limits and for a persistent overload", async () => {
    const { classifyMmrSessionFallbackError } = await importSource("extensions/mmr-session-fallback/classifier.ts");

    assert.equal(classifyMmrSessionFallbackError({ provider: "claude-subscription", errorMessage: "rate_limit_error: 429" }).shouldPrompt, true);
    // Overload reaches message_end only after Pi's auto-retry is exhausted, so a
    // persistent overload of the active Claude route is offered an interactive
    // fallback instead of dead-ending the turn.
    const overload = classifyMmrSessionFallbackError({ provider: "claude-subscription", errorMessage: "overloaded_error: try again" });
    assert.equal(overload.shouldPrompt, true);
    assert.equal(overload.kind, "anthropic-overload");
    // A non-Claude provider's plain overload is still left to Pi's retry.
    assert.equal(classifyMmrSessionFallbackError({ provider: "openai-codex", errorMessage: "overloaded_error: try again" }).shouldPrompt, false);
  });

  it("recognizes OpenAI Codex rate-limit variants", async () => {
    const { classifyMmrSessionFallbackError } = await importSource("extensions/mmr-session-fallback/classifier.ts");

    for (const errorMessage of [
      "rate_limit_error: please slow down",
      "too many requests",
      "rate limit reached",
      "insufficient_quota: billing quota exceeded",
    ]) {
      const result = classifyMmrSessionFallbackError({ provider: "openai-codex", errorMessage });
      assert.equal(result.shouldPrompt, true, errorMessage);
      assert.equal(result.kind, "openai-usage-limit", errorMessage);
    }

    assert.equal(classifyMmrSessionFallbackError({ provider: "openai-codex", errorMessage: "overloaded_error" }).shouldPrompt, false);
  });

  it("leaves generic API-key 429s to Pi retry unless the message is a hard quota", async () => {
    const { classifyMmrSessionFallbackError } = await importSource("extensions/mmr-session-fallback/classifier.ts");

    assert.equal(classifyMmrSessionFallbackError({ provider: "anthropic", errorMessage: "HTTP 429 rate limit" }).shouldPrompt, false);
    assert.equal(classifyMmrSessionFallbackError({ provider: "openai", errorMessage: "insufficient_quota: billing quota exceeded" }).shouldPrompt, true);
  });
});
