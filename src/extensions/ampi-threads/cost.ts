import { type MmrModelPrice, mmrEntryCost, readMmrEntryUsage } from "../ampi-core/session-usage.js";
import type { MmrThreadCostReport, MmrThreadModelCost } from "../ampi-core/thread-reports.js";

/**
 * What a session cost, per model: the Thread Cost overlay's numbers. Each
 * entry costs what Pi recorded for it, or its tokens at the model's price
 * when Pi recorded nothing (a provider that reports no cost); the prompt
 * box's gauge reads the same entries the same way (`ampi-core/session-usage.ts`).
 * A model with no recorded cost and no price is "unknown"; the total
 * counts what is known.
 */

/** Label for the usage of compaction and branch summaries, which names no model. */
export const MMR_SUMMARY_COST_LABEL = "session summaries";

/** A model's price, or `undefined` when none is known. */
export type MmrPriceLookup = (provider: string, model: string) => MmrModelPrice | undefined;

interface Tally {
  label: string;
  /** Sum of the entries with a known cost. */
  known: number;
  /** An entry used tokens without a known cost. */
  unknown: boolean;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Sum the cost of `entries` (a session's entries, every branch) per model. */
export function summarizeMmrThreadCost(entries: readonly unknown[], priceOf: MmrPriceLookup): MmrThreadCostReport {
  const tallies = new Map<string, Tally>();
  for (const entry of entries) {
    const usage = readMmrEntryUsage(entry);
    if (!usage) continue;
    const named = usage.provider !== undefined && usage.model !== undefined;
    const label = named ? `${usage.provider}/${usage.model}` : MMR_SUMMARY_COST_LABEL;
    let tally = tallies.get(label);
    if (!tally) {
      tally = { label, known: 0, unknown: false, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      tallies.set(label, tally);
    }
    const cost = mmrEntryCost(usage, named ? priceOf(usage.provider as string, usage.model as string) : undefined);
    if (cost === undefined) tally.unknown = true;
    else tally.known += cost;
    tally.input += usage.input;
    tally.output += usage.output;
    tally.cacheRead += usage.cacheRead;
    tally.cacheWrite += usage.cacheWrite;
  }
  const all = [...tallies.values()];
  // A model shows "unknown" once any of its entries has no cost; the total
  // still counts every known entry, as the gauge does.
  const models: MmrThreadModelCost[] = all.map(({ known, unknown, ...rest }) => ({ ...rest, cost: unknown ? undefined : known }));
  return {
    total: all.reduce((sum, tally) => sum + tally.known, 0),
    unknown: models.filter((model) => model.cost === undefined).length,
    models,
  };
}
