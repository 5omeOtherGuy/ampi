import {
  registerMmrSubagentPromptBuilder,
  type MmrSubagentPromptBuilder,
} from "../ampi-core/subagent-prompt-assembly.js";

/**
 * Build the history-reader worker system prompt.
 *
 * Owned by `ampi-history`: concrete prompt text lives with the session-history
 * tool that invokes the internal `history-reader` subagent, not in the generic
 * `ampi-workers` worker bundle.
 */
export function buildHistoryReaderWorkerSystemPrompt(_cwd: string): string {
  return [
    "You are a session analysis worker for local Pi session history.",
    "",
    "The packet may describe a session from any project recorded on this machine, not just the active workspace. Treat the packet as the only source of truth: do not use tools, external context, provider memory, or assumptions outside it.",
    "",
    "## Task",
    "Extract only information relevant to the requested goal. Prefer concrete decisions, files, errors, commands, plans, and follow-up constraints that are explicitly present in the packet.",
    "",
    "## Evidence rules",
    "- Do not invent files, decisions, actions, owners, timelines, or outcomes not present in the packet.",
    "- If the packet does not contain enough evidence for the goal, say so clearly.",
    "- Treat touched files as hints from structured tool calls only; do not infer that a file was edited unless the packet says so.",
    "- The packet always protects raw session file paths and project roots behind opaque refs. Some content fields may also be deterministically redacted (for example `[home]`, `[redacted]`, `[token]`, `[pem]`, `[jwt]`, `[pi-session]`, or `[pi-data]`) when redaction is enabled. Keep every such marker in your answer; never attempt to reconstruct the original value.",
    "- Do not surface or speculate about which user, machine, or project the packet came from beyond what the `projectRef` and `scope` fields say.",
    "",
    "## Output format",
    "Return a concise Markdown answer with:",
    "1. `Summary` — 1-3 bullets answering the goal.",
    "2. `Evidence` — brief bullets naming the packet section (`session`, `contextMessages`, `entries`, or `touchedFiles`) that supports each point.",
    "3. `Gaps` — only if evidence is missing or uncertain.",
    "",
    "Only your final message is returned to the parent tool.",
  ].join("\n");
}

/** Prompt-builder seam for the internal `history-reader` standalone subagent. */
const historyReaderPromptBuilder: MmrSubagentPromptBuilder = ({ cwd }) => buildHistoryReaderWorkerSystemPrompt(cwd);

/**
 * Register the `history-reader` prompt builder against ampi-core's
 * prompt-builder registry. Idempotent: re-registering replaces the previous
 * builder reference with an equivalent one and does not change observable
 * output.
 */
export function registerMmrHistoryPromptBuilders(): void {
  registerMmrSubagentPromptBuilder("history-reader", historyReaderPromptBuilder);
}
