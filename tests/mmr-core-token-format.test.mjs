import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

// The shared lower-tier compact formatter owned by mmr-core. Its output is
// the single source of truth that both formatMmrWorkerTokens and
// formatFooterTokens (below 10M) route through; pin it byte-for-byte.
const COMPACT_TOKEN_CASES = [
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

// Non-boundary inputs that exercise the sub-1000 raw path, negatives, the
// non-integer toFixed tier, and the NaN tail. These encode the full parity
// proof so a future edit to the arithmetic cannot silently diverge.
const COMPACT_TOKEN_EDGE_CASES = [
  [0, "0"],
  [-1, "-1"],
  [-1500, "-1500"],
  [1234.5, "1.2k"],
  [Number.NaN, "NaNM"],
];

describe("mmr-core compact token formatter", () => {
  it("formats compact token counts byte-for-byte across boundary values", async () => {
    const { formatMmrCompactTokens } = await importSource("extensions/mmr-core/token-format.ts");
    for (const [input, expected] of COMPACT_TOKEN_CASES) {
      assert.equal(formatMmrCompactTokens(input), expected, `formatMmrCompactTokens(${input})`);
    }
  });

  it("formats edge inputs (zero, negatives, non-integers, NaN) byte-for-byte", async () => {
    const { formatMmrCompactTokens } = await importSource("extensions/mmr-core/token-format.ts");
    for (const [input, expected] of COMPACT_TOKEN_EDGE_CASES) {
      assert.equal(formatMmrCompactTokens(input), expected, `formatMmrCompactTokens(${input})`);
    }
  });
});
