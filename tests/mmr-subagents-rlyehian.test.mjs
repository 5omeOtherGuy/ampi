import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const RLYEHIAN_MODULE = "extensions/mmr-subagents/rlyehian.ts";

describe("toRlyehian deterministic transliteration", () => {
  it("is deterministic across calls", async () => {
    const { toRlyehian } = await importSource(RLYEHIAN_MODULE);
    const input = "Reading the auth middleware before editing it.";
    assert.equal(toRlyehian(input), toRlyehian(input));
  });

  it("preserves whitespace, newlines, digits, and punctuation verbatim", async () => {
    const { toRlyehian } = await importSource(RLYEHIAN_MODULE);
    const input = "- step 1: read file.ts (line 42)\n- step 2: done!";
    const out = toRlyehian(input);
    // Non-letter scaffolding survives.
    assert.ok(out.includes("- "), "list bullets preserved");
    assert.ok(out.includes("1"), "digit 1 preserved");
    assert.ok(out.includes("42"), "digit 42 preserved");
    assert.ok(out.includes("\n"), "newline preserved");
    assert.ok(out.includes("!"), "punctuation preserved");
    // Same number of newlines and the same digit substring positions.
    assert.equal((out.match(/\n/g) ?? []).length, (input.match(/\n/g) ?? []).length);
  });

  it("replaces ASCII letter words so the source prose is not readable", async () => {
    const { toRlyehian } = await importSource(RLYEHIAN_MODULE);
    const out = toRlyehian("reading middleware");
    assert.ok(!out.includes("reading"), "original word should be cloaked");
    assert.ok(!out.includes("middleware"), "original word should be cloaked");
    assert.match(out, /^[A-Za-z']+ [A-Za-z']+$/, "two incantation tokens separated by the original space");
  });

  it("preserves capitalization shape (ALL CAPS, Capitalized, lower)", async () => {
    const { toRlyehian } = await importSource(RLYEHIAN_MODULE);
    const upper = toRlyehian("ERROR");
    const cap = toRlyehian("Error");
    const lower = toRlyehian("error");
    assert.equal(upper, upper.toUpperCase(), "ALL CAPS stays upper");
    assert.match(cap, /^[A-Z]/, "Capitalized stays leading-cap");
    assert.equal(lower, lower.toLowerCase(), "lowercase stays lower");
  });

  it("returns empty/non-string inputs unchanged", async () => {
    const { toRlyehian } = await importSource(RLYEHIAN_MODULE);
    assert.equal(toRlyehian(""), "");
  });

  it("emits only mythos syllables and apostrophes within a token", async () => {
    const { toRlyehian } = await importSource(RLYEHIAN_MODULE);
    const out = toRlyehian("summon");
    assert.match(out, /^[a-z']+$/, "single lowercase token of letters and apostrophes");
  });
});

describe("toRlyehianBlend part-incantation, part-English", () => {
  it("is deterministic and preserves non-letter scaffolding", async () => {
    const { toRlyehianBlend } = await importSource(RLYEHIAN_MODULE);
    const input = "- step 1: read file.ts (line 42)\n- inspect the broken harness!";
    assert.equal(toRlyehianBlend(input), toRlyehianBlend(input));
    const out = toRlyehianBlend(input);
    assert.ok(out.includes("1") && out.includes("42"), "digits preserved");
    assert.ok(out.includes("\n"), "newline preserved");
    assert.ok(out.includes("!"), "punctuation preserved");
  });

  it("keeps short words readable and leaves a real mix of English and incantation", async () => {
    const { toRlyehianBlend, toRlyehian } = await importSource(RLYEHIAN_MODULE);
    const input = "Investigating the mutex reproduction harness deadlock failure now";
    const out = toRlyehianBlend(input);
    const inputWords = input.split(" ");
    const outWords = out.split(" ");
    assert.equal(outWords.length, inputWords.length, "word count preserved");
    // Short words (<= 3 letters) are always kept readable.
    assert.equal(outWords[inputWords.indexOf("the")], "the", "short word 'the' kept readable");
    assert.equal(outWords[inputWords.indexOf("now")], "now", "short word 'now' kept readable");
    // At least one long word survives in English and at least one is transliterated.
    const survivedEnglish = inputWords.some((w, i) => w.length > 3 && outWords[i] === w);
    const turnedIncantation = inputWords.some((w, i) => w.length > 3 && outWords[i] !== w);
    assert.ok(survivedEnglish, "some long words remain dread English");
    assert.ok(turnedIncantation, "some long words become incantation");
    // It is a genuine blend, not the full cloak.
    assert.notEqual(out, toRlyehian(input), "blend differs from full transliteration");
    assert.notEqual(out, input, "blend differs from the original English");
  });

  it("returns empty/non-string inputs unchanged", async () => {
    const { toRlyehianBlend } = await importSource(RLYEHIAN_MODULE);
    assert.equal(toRlyehianBlend(""), "");
  });
});
