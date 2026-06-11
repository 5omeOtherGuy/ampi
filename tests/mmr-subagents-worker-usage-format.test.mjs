import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

// Boundary-value parity pins for the worker-metadata compact token formatter.
// These outputs are byte-for-byte frozen so the Item 5b shared-helper
// refactor (routing through mmr-core/token-format.ts) cannot change them.
const WORKER_TOKEN_CASES = [
  [999, "999"],
  [1000, "1.0k"],
  [1500, "1.5k"],
  [12345, "12k"],
  [999999, "1000k"],
  [1000000, "1.0M"],
  [1500000, "1.5M"],
  [9999999, "10.0M"],
  [10000000, "10.0M"],
];

// Edge inputs (raw sub-1000 path, negatives, non-integer toFixed tier, NaN
// tail) — pinned so the shared-helper delegation stays byte-for-byte.
const WORKER_TOKEN_EDGE_CASES = [
  [0, "0"],
  [-1, "-1"],
  [-1500, "-1500"],
  [1234.5, "1.2k"],
  [Number.NaN, "NaNM"],
];

describe("mmr-subagents worker usage formatting", () => {
  it("formats compact worker token counts byte-for-byte across boundary values", async () => {
    const { formatMmrWorkerTokens } = await importSource("extensions/mmr-workers/worker-usage-format.ts");
    for (const [input, expected] of WORKER_TOKEN_CASES) {
      assert.equal(formatMmrWorkerTokens(input), expected, `formatMmrWorkerTokens(${input})`);
    }
  });

  it("formats edge inputs (zero, negatives, non-integers, NaN) byte-for-byte", async () => {
    const { formatMmrWorkerTokens } = await importSource("extensions/mmr-workers/worker-usage-format.ts");
    for (const [input, expected] of WORKER_TOKEN_EDGE_CASES) {
      assert.equal(formatMmrWorkerTokens(input), expected, `formatMmrWorkerTokens(${input})`);
    }
  });
});
