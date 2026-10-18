import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

let summarizeMmrThreadCost;

before(async () => {
  ({ summarizeMmrThreadCost } = await importSource("extensions/ampi-threads/cost.ts"));
});

/** Dollars per million tokens. `acme/local` has the all-zero price Pi gives a model without one. */
const PRICES = {
  "acme/priced": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "acme/local": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const priceOf = (provider, model) => PRICES[`${provider}/${model}`];

function usage(input, output, cacheRead, cacheWrite, total = 0) {
  return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { total } };
}
const assistant = (provider, model, use) => ({ type: "message", message: { role: "assistant", provider, model, content: [], usage: use } });

/** Compare dollar amounts to a tenth of a millionth of a cent. */
function assertDollars(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);
}

describe("thread cost", () => {
  it("sums the cost Pi recorded in a session, abandoned branches included, as Pi's own totals do", () => {
    const entries = readFileSync(path.join(import.meta.dirname, "fixtures", "ampi-threads-markdown", "session.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const report = summarizeMmrThreadCost(entries, () => undefined);
    // e05, e07, e09, e11, e13 (the abandoned branch) and e17.
    assertDollars(report.total, 0.00375 + 0.0036 + 0.00405 + 0.0042 + 0.00435 + 0.004575);
    assert.equal(report.unknown, 0);
    assert.equal(report.models.length, 1);
    const [model] = report.models;
    assert.equal(model.label, "anthropic/claude-sonnet-4-5");
    assertDollars(model.cost, report.total);
    assert.deepEqual([model.input, model.output, model.cacheRead, model.cacheWrite], [7500, 135, 0, 0]);
  });

  it("prices tokens the provider reported no cost for, prefers a recorded cost, and marks models without a price unknown", () => {
    const report = summarizeMmrThreadCost(
      [
        // No recorded cost: (1000 × 3 + 200 × 15 + 10000 × 0.3 + 2000 × 3.75) / 1e6 = 0.0165.
        assistant("acme", "priced", usage(1000, 200, 10000, 2000)),
        // A recorded cost wins over the price.
        assistant("acme", "priced", usage(10, 10, 0, 0, 0.5)),
        assistant("acme", "local", usage(500, 50, 0, 0)),
        { type: "usage", kind: "cache_warm", provider: "acme", model: "priced", usage: usage(0, 0, 4000, 0, 0.01) },
        assistant("other", "unlisted", usage(20, 5, 0, 0)),
        { type: "compaction", summary: "…", firstKeptEntryId: "x", tokensBefore: 9000, usage: usage(9000, 300, 0, 0, 0.002) },
        { type: "message", message: { role: "user", content: "no usage here" } },
      ],
      priceOf,
    );
    assert.deepEqual(
      report.models.map((model) => [model.label, model.cost === undefined ? "unknown" : Number(model.cost.toFixed(6))]),
      [
        ["acme/priced", 0.5265],
        ["acme/local", "unknown"],
        ["other/unlisted", "unknown"],
        ["session summaries", 0.002],
      ],
    );
    assertDollars(report.total, 0.5285);
    assert.equal(report.unknown, 2);
    assert.deepEqual(
      [report.models[0].input, report.models[0].output, report.models[0].cacheRead, report.models[0].cacheWrite],
      [1010, 210, 14000, 2000],
    );
  });

  it("counts the known part of a model with one unpriced entry in the total, as the gauge does, and shows the model unknown", () => {
    const report = summarizeMmrThreadCost(
      [assistant("other", "mixed", usage(10, 10, 0, 0, 0.25)), assistant("other", "mixed", usage(10, 10, 0, 0))],
      priceOf,
    );
    assert.equal(report.models[0].cost, undefined);
    assert.equal(report.unknown, 1);
    assertDollars(report.total, 0.25);
  });

  it("costs nothing for usage without tokens, even without a price", () => {
    const report = summarizeMmrThreadCost([assistant("other", "aborted", usage(0, 0, 0, 0))], priceOf);
    assert.equal(report.models[0].cost, 0);
    assert.equal(report.unknown, 0);
    assert.deepEqual(summarizeMmrThreadCost([], priceOf), { total: 0, unknown: 0, models: [] });
  });
});
