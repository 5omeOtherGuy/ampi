import type { MmrSubagentProfile } from "./subagent-profiles.js";

// Annotated as `boolean` (not the inferred literal `false`) so flipping
// this constant when the host seam lands does not break public-typed
// callers that branched on `MMR_IN_PROCESS_SUBAGENT_RUNNER_AVAILABLE`.
export const MMR_IN_PROCESS_SUBAGENT_RUNNER_AVAILABLE: boolean = false;

export const MMR_SUBAGENT_RUN_STATUSES = ["in-progress", "done", "error", "cancelled"] as const;
export type MmrSubagentRunStatus = typeof MMR_SUBAGENT_RUN_STATUSES[number];

export const MMR_SUBAGENT_TOOL_USE_STATUSES = [
  "queued",
  "in-progress",
  "done",
  "error",
  "cancelled",
  "rejected-by-user",
] as const;
export type MmrSubagentToolUseStatus = typeof MMR_SUBAGENT_TOOL_USE_STATUSES[number];

export interface MmrSubagentToolUseProgress {
  id?: string;
  toolName: string;
  normalizedName?: string;
  status: MmrSubagentToolUseStatus;
  input?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface MmrSubagentTurnProgress {
  message?: string;
  reasoning?: string;
  isThinking?: boolean;
  toolUses: MmrSubagentToolUseProgress[];
}

export interface MmrSubagentProgressEvent {
  status: MmrSubagentRunStatus;
  progress: MmrSubagentTurnProgress[];
  result?: string;
  error?: { message: string };
  reason?: string;
  debug?: Record<string, unknown>;
}

export interface MmrSubagentPermissionContext {
  context: "thread" | "subagent";
  threadId?: string;
  mainThreadId?: string;
  parentToolUseId?: string;
  subagentSpec?: {
    name: string;
    displayName?: string;
  };
}

export interface RunMmrSubagentInProcessOptions {
  profile: Pick<MmrSubagentProfile, "name" | "displayName">;
  prompt: string;
  cwd: string;
  parentToolUseId?: string;
  signal?: AbortSignal;
  onProgress?: (event: MmrSubagentProgressEvent) => void;
}

/**
 * Terminal result returned by `runMmrSubagentInProcess` once Pi exposes
 * the host seam. Defined as a forward-compatible placeholder so the
 * public return type is stable today and does not need to change when
 * the runner becomes available.
 */
export interface MmrSubagentRunResult {
  status: MmrSubagentRunStatus;
  result?: string;
  error?: { message: string };
  reason?: string;
  debug?: Record<string, unknown>;
}

export class MmrInProcessRunnerUnavailableError extends Error {
  constructor(message = "The pi-mmr in-process subagent runner requires host support that is not available in this Pi runtime.") {
    super(message);
    this.name = "MmrInProcessRunnerUnavailableError";
  }
}

export async function runMmrSubagentInProcess(
  _options: RunMmrSubagentInProcessOptions,
): Promise<MmrSubagentRunResult> {
  throw new MmrInProcessRunnerUnavailableError(
    "The pi-mmr in-process subagent runner is not available yet: Pi must expose host support for nested runs, filtered shared tool access, and subagent-aware permission/progress events.",
  );
}
