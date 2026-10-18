import { isRecord } from "./internal/json.js";

/**
 * Model usage recorded in a Pi session, and what it cost: the one reading
 * that the prompt box's cost gauge (`ampi-tui`) and the Thread Cost overlay
 * (`ampi-threads`) share, so the two always agree.
 *
 * It counts what Pi's own session totals count: assistant messages, tool
 * results that carry usage, `usage` entries (such as cache warming), and
 * the usage of compaction and branch summaries.
 */

/** Prices in dollars per million tokens, as Pi's models carry them (`model.cost`). */
export interface MmrModelPrice {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface MmrEntryUsage {
  /** Provider and model that used the tokens; absent for summaries, which do not record them. */
  readonly provider?: string;
  readonly model?: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** The cost Pi recorded, in dollars; 0 when the provider reported none. */
  readonly recordedCost: number;
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const text = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

function readUsage(usage: unknown, provider: unknown, model: unknown): MmrEntryUsage | undefined {
  if (!isRecord(usage)) return undefined;
  return {
    provider: text(provider),
    model: text(model),
    input: count(usage.input),
    output: count(usage.output),
    cacheRead: count(usage.cacheRead),
    cacheWrite: count(usage.cacheWrite),
    recordedCost: isRecord(usage.cost) ? count(usage.cost.total) : 0,
  };
}

/** The usage one session entry records, or `undefined` for an entry without any. */
export function readMmrEntryUsage(entry: unknown): MmrEntryUsage | undefined {
  if (!isRecord(entry)) return undefined;
  switch (entry.type) {
    case "message": {
      const message = entry.message;
      if (!isRecord(message) || (message.role !== "assistant" && message.role !== "toolResult")) return undefined;
      return readUsage(message.usage, message.provider, message.model);
    }
    case "usage":
      return readUsage(entry.usage, entry.provider, entry.model);
    case "compaction":
    case "branch_summary":
      return readUsage(entry.usage, undefined, undefined);
    default:
      return undefined;
  }
}

/** Whether a price says anything: Pi gives models without one all-zero prices. */
export function isMmrModelPriced(price: MmrModelPrice | undefined): price is MmrModelPrice {
  return price !== undefined && (price.input > 0 || price.output > 0 || price.cacheRead > 0 || price.cacheWrite > 0);
}

/**
 * What one entry's usage cost, in dollars: the cost Pi recorded, else the
 * tokens at `price` (base rates, without long-context tiers), else
 * `undefined` when tokens were used and nothing gives a price. No tokens
 * cost nothing.
 */
export function mmrEntryCost(usage: MmrEntryUsage, price: MmrModelPrice | undefined): number | undefined {
  if (usage.recordedCost > 0) return usage.recordedCost;
  if (isMmrModelPriced(price)) {
    return (
      (usage.input * price.input + usage.output * price.output + usage.cacheRead * price.cacheRead + usage.cacheWrite * price.cacheWrite) /
      1_000_000
    );
  }
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0 ? undefined : 0;
}
