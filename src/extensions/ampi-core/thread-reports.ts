import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Core-owned seam for reports about the current session: what it cost,
 * what fills its context window, and the session as Markdown.
 *
 * `ampi-threads` computes them and registers itself here at load; `ampi-tui`
 * shows them in its Thread Cost and Analyze Context overlays, and reads
 * `showCosts` for its cost gauge, and `ampi-gui` copies sessions as
 * Markdown, without importing `ampi-threads`. When `ampi-threads` is
 * disabled nothing is registered: the overlays and the GUI's copy are
 * unavailable and the gauge shows.
 *
 * globalThis-anchored so registrations survive Pi's cache-isolated module
 * loads (each extension entrypoint may get its own copy of this module).
 */

/** What one model, or the session's summaries, used and cost. */
export interface MmrThreadModelCost {
  /** `provider/model`, or "session summaries" for compaction and branch summaries, which name no model. */
  readonly label: string;
  /** Dollars; `undefined` when tokens were used and no price is known. */
  readonly cost: number | undefined;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface MmrThreadCostReport {
  /** Dollars, summed over every entry with a known cost: what the prompt box's gauge shows. */
  readonly total: number;
  /** Number of models in {@link models} whose cost is unknown. */
  readonly unknown: number;
  /** In order of first use; empty while the session has used no model. */
  readonly models: readonly MmrThreadModelCost[];
}

export type MmrContextSectionId =
  | "system-prompt"
  | "builtin-tools"
  | "agents-files"
  | "mcp-tools"
  | "loaded-skills"
  | "compaction-summary"
  | "messages";

export interface MmrContextSection {
  readonly id: MmrContextSectionId;
  readonly name: string;
  /** Estimated tokens. */
  readonly tokens: number;
  /** How many tools, files or skills the section holds; absent for sections that are not lists. */
  readonly count?: number;
}

export interface MmrContextAnalysis {
  /** `provider/model` the window belongs to, when known. */
  readonly model?: string;
  /** The model's context window in tokens; `undefined` when unknown. */
  readonly contextWindow?: number;
  /** In a fixed order: system prompt, built-in tools, AGENTS.md files, MCP tools, loaded skills, compaction summary, messages. */
  readonly sections: readonly MmrContextSection[];
  /** Sum of the section estimates. */
  readonly totalTokens: number;
  /** Tokens Pi measured at the last response, or `undefined` when it has none (no response yet, or just compacted). */
  readonly measuredTokens?: number;
  /** Compactions on the current branch. */
  readonly compactionCount: number;
}

export interface MmrThreadReports {
  /** `ampiThreads.showCosts`: show costs (the gauge and the Thread Cost overlay). */
  readonly showCosts: boolean;
  /** The current session's cost. */
  cost(ctx: ExtensionContext): MmrThreadCostReport;
  /** What fills the current session's context window. */
  analyzeContext(ctx: ExtensionContext): MmrContextAnalysis;
  /**
   * A session as Markdown, the same text as `thread copy markdown`.
   * `entries` are the session header followed by the branch to export.
   */
  markdown(entries: readonly unknown[], options?: { readonly title?: string; readonly mode?: string }): string;
}

const THREAD_REPORTS_GLOBAL_KEY = "__pi_ampi_thread_reports_v1__";
const globalStore = globalThis as typeof globalThis & { [THREAD_REPORTS_GLOBAL_KEY]?: MmrThreadReports[] };

function getSources(): MmrThreadReports[] {
  let sources = globalStore[THREAD_REPORTS_GLOBAL_KEY];
  if (!sources) {
    sources = [];
    globalStore[THREAD_REPORTS_GLOBAL_KEY] = sources;
  }
  return sources;
}

/**
 * Register the thread reports. The most recent registration wins. Returns
 * an idempotent function that removes exactly this registration.
 */
export function registerMmrThreadReports(reports: MmrThreadReports): () => void {
  getSources().push(reports);
  return () => {
    const sources = getSources();
    const position = sources.lastIndexOf(reports);
    if (position !== -1) sources.splice(position, 1);
  };
}

/** The registered thread reports, or `undefined` when `ampi-threads` is not loaded. */
export function getMmrThreadReports(): MmrThreadReports | undefined {
  const sources = getSources();
  return sources[sources.length - 1];
}
