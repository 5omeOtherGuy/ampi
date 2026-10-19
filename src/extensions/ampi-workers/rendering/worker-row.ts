/**
 * One-line worker rows: the Amp-compatible vocabulary every ampi-workers
 * surface draws a worker with.
 *
 * Collapsed, a worker is one line: a status glyph, a phrase that says what
 * the worker does ("Consulting oracle" while it runs, "Consulted oracle" once
 * it finished) and, muted after ` · `, what it was asked. Expanded, the row is
 * followed by the worker's trail (its latest events, dim and indented) and,
 * once it finished, its answer and a dim usage line.
 *
 * The transcript rows of blocking and polled workers, the pinned background
 * widget, the `task_poll` board and the inline background cards all take
 * their phrases and glyphs from here; `worker-row-lines.ts` draws the
 * transcript rows. With `ampi-tui` on, the transcript row is still drawn by
 * these renderers (see `ampi-tui/transcript/tool-renderers.ts`).
 */

import { MMR_SPINNER_FIRST_GLYPH } from "../../ampi-core/spinner.js";

export type WorkerRowStatus = "running" | "done" | "error" | "cancelled";

/** Present and past phrases of the built-in workers that read best as a phrase of their own. */
const PHRASES: Record<string, readonly [present: string, past: string]> = {
  finder: ["Searching codebase", "Searched codebase"],
  oracle: ["Consulting oracle", "Consulted oracle"],
  librarian: ["Researching with librarian", "Researched with librarian"],
  reviewer: ["Reviewing changes", "Reviewed changes"],
  view_media: ["Viewing media", "Viewed media"],
};

/** Prefix of custom Markdown subagent tool names (`sa__<name>`). */
const CUSTOM_SUBAGENT_PREFIX = "sa__";

/**
 * The phrase for a worker: `Searching codebase` / `Searched codebase` for
 * the built-in workers, `Running subagent (<variant>)` / `Subagent
 * (<variant>) finished` for `Task` (variant: its capability profile) and
 * custom subagents (variant: their name).
 */
export function workerRowPhrase(agent: string, running: boolean, variant?: string): string {
  const known = PHRASES[agent];
  if (known) return running ? known[0] : known[1];
  const name = agent === "Task" ? variant : agent.startsWith(CUSTOM_SUBAGENT_PREFIX) ? agent.slice(CUSTOM_SUBAGENT_PREFIX.length) : agent;
  const tag = name ? ` (${name})` : "";
  return running ? `Running subagent${tag}` : `Subagent${tag} finished`;
}

/** Trail events an expanded row shows; older ones are counted in "… N earlier events". */
export const WORKER_ROW_TRAIL_EVENTS = 8;
/** Answer lines an expanded row shows before "… N more lines". */
export const WORKER_ROW_ANSWER_LINES = 20;
/** Prompt lines an expanded row shows before "… N more lines". */
export const WORKER_ROW_PROMPT_LINES = 5;

const GLYPHS: Record<Exclude<WorkerRowStatus, "running">, string> = { done: "✓", error: "✗", cancelled: "⊘" };
const COLORS: Record<WorkerRowStatus, "accent" | "success" | "error" | "warning"> = { running: "accent", done: "success", error: "error", cancelled: "warning" };

/** The status glyph; a running row shows `spinner`, the current glyph of its spinner (`ampi-core/spinner.ts`). */
export function workerRowGlyph(status: WorkerRowStatus, spinner: string = MMR_SPINNER_FIRST_GLYPH): string {
  return status === "running" ? spinner : GLYPHS[status];
}

export function workerRowColor(status: WorkerRowStatus): (typeof COLORS)[WorkerRowStatus] {
  return COLORS[status];
}

/** First line of a text, with " …" when more lines follow, whitespace collapsed. */
export function workerRowDetail(text: string | undefined): string | undefined {
  const lines = (text ?? "").trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return undefined;
  const first = (lines[0] as string).replace(/\s+/g, " ");
  return lines.length > 1 ? `${first} …` : first;
}

/**
 * Drop a leading `<agent>: ` from a run description: blocking runs register
 * as `oracle: <task>`, which the phrase already names.
 */
export function stripAgentPrefix(description: string, agent: string): string {
  const prefix = `${agent}: `;
  return description.startsWith(prefix) ? description.slice(prefix.length) : description;
}

