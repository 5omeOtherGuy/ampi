/**
 * Core-owned seam for prompt history: the prompts you sent, per workspace.
 *
 * `ampi-threads` records the prompts and registers its store here at load;
 * `ampi-tui` reads them for its prompt history picker without importing
 * `ampi-threads`. When `ampi-threads` is disabled nothing is registered and
 * the picker is unavailable.
 *
 * globalThis-anchored so registrations survive Pi's cache-isolated module
 * loads (each extension entrypoint may get its own copy of this module).
 */

/** One prompt as it was sent. */
export interface MmrPromptHistoryEntry {
  /** When it was sent (ISO 8601). */
  readonly ts: string;
  readonly text: string;
}

/** `workspace`: the prompts sent in one working directory; `all`: those sent anywhere. */
export type MmrPromptHistoryScope = "workspace" | "all";

export interface MmrPromptHistory {
  /** Prompts newest first: those sent in `cwd`, or in every workspace for `all`. */
  read(cwd: string, scope: MmrPromptHistoryScope): Promise<readonly MmrPromptHistoryEntry[]>;
}

const PROMPT_HISTORY_GLOBAL_KEY = "__pi_ampi_prompt_history_v1__";
const globalStore = globalThis as typeof globalThis & { [PROMPT_HISTORY_GLOBAL_KEY]?: MmrPromptHistory[] };

function getSources(): MmrPromptHistory[] {
  let sources = globalStore[PROMPT_HISTORY_GLOBAL_KEY];
  if (!sources) {
    sources = [];
    globalStore[PROMPT_HISTORY_GLOBAL_KEY] = sources;
  }
  return sources;
}

/**
 * Register the prompt history. The most recent registration wins. Returns
 * an idempotent function that removes exactly this registration.
 */
export function registerMmrPromptHistory(history: MmrPromptHistory): () => void {
  getSources().push(history);
  return () => {
    const sources = getSources();
    const position = sources.lastIndexOf(history);
    if (position !== -1) sources.splice(position, 1);
  };
}

/** The registered prompt history, or `undefined` when `ampi-threads` is not loaded. */
export function getMmrPromptHistory(): MmrPromptHistory | undefined {
  const sources = getSources();
  return sources[sources.length - 1];
}
