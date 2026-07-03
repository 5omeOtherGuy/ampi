import { spawn as nodeSpawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { isRecord } from "../../ampi-core/internal/json.js";
import {
  AMPI_SUBAGENT_MODEL_PREFERENCES_ENV,
  MMR_SUBAGENT_MODEL_PREFERENCES_ENV,
  serializeMmrSubagentModelPreferencesEnv,
} from "../../ampi-core/subagent-model-override-env.js";
import { extractMmrSubagentActivationFailure } from "../../ampi-core/subagent-resolver.js";
import type { MmrModelPreference } from "../../ampi-core/types.js";
import { buildMmrWorkerArgs, resolveMmrWorkerPiInvocation } from "./runner-invocation.js";
import type { MmrWorkerInvocation } from "./runner-invocation.js";
import { copyMmrWorkerTrailItem, createMmrWorkerTrailAggregator } from "../rendering/worker-trail.js";
import type { MmrWorkerTrailItem } from "../rendering/worker-trail.js";
import {
  DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT,
  getMmrWorkerFinalOutput,
  shouldRetryMmrChildWithFullDiscovery,
  truncateMmrWorkerOutput,
} from "./runner-outcome.js";
import { collectUsage, emptyMmrWorkerUsageStats, readString } from "./worker-usage.js";
export { buildMmrWorkerArgs, resolveMmrWorkerPiInvocation, resolveMmrWorkerPiInvocationFromEnv } from "./runner-invocation.js";
export type { MmrWorkerArgsOptions, MmrWorkerInvocation, MmrWorkerPiInvocationEnv } from "./runner-invocation.js";
export { MMR_WORKER_TRAIL_LIMIT } from "../rendering/worker-trail.js";
export type { MmrWorkerTrailItem } from "../rendering/worker-trail.js";
// Re-export the outcome classification/output-shaping helpers and the usage
// helpers from their new homes (`runner-outcome.ts`, `worker-usage.ts`) so
// this entry file remains the stable public surface for them.
export {
  DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT,
  DEFAULT_MMR_WORKER_PARTIAL_OUTPUT_POLICY,
  MMR_SUBAGENT_DETAILS_STATUS_VALUES,
  MMR_WORKER_OUTCOME_STATUS_VALUES,
  classifyMmrWorkerOutcome,
  classifyMmrWorkerOutcomeForProfile,
  deriveAsyncTerminalOutcome,
  getMmrWorkerFinalOutput,
  hasUsableMmrWorkerFinalOutput,
  resolveMmrWorkerPartialOutputPolicy,
  shouldRetryMmrChildWithFullDiscovery,
  truncateMmrWorkerOutput,
} from "./runner-outcome.js";
export type {
  ClassifyMmrWorkerOutcomeOptions,
  MmrAsyncTerminalOutcome,
  MmrSubagentDetailsStatus,
  MmrWorkerOutcomeStatus,
} from "./runner-outcome.js";
export { emptyMmrWorkerUsageStats } from "./worker-usage.js";

// Worker contract types are core-owned (`ampi-core/worker-contract.ts`) as
// part of the subagent unification; this entry file re-exports them so the
// historical `ampi-workers/runner.js` import path stays stable.
import type {
  MmrSubagentRunOptions,
  MmrWorkerMessage,
  MmrWorkerProgressSnapshot,
  MmrWorkerResult,
  MmrWorkerUsageStats,
} from "../../ampi-core/worker-contract.js";
export type {
  MmrSubagentRunOptions,
  MmrSubagentRunProgress,
  MmrSubagentRunner,
  MmrSubagentWorkerDetailsBase,
  MmrSubagentWorkerRunResult,
  MmrSpawnedSubagentWorkerDetailsBase,
  MmrWorkerMessage,
  MmrWorkerProgressSnapshot,
  MmrWorkerResult,
  MmrWorkerUsageStats,
} from "../../ampi-core/worker-contract.js";
import type { MmrSubagentRunner } from "../../ampi-core/worker-contract.js";

export const DEFAULT_MMR_WORKER_KILL_TIMEOUT_MS = 5_000;

/**
 * Maximum size (in bytes) of the inline `Task: ...` positional argv
 * before the runner spills the prompt to a temp file and references it
 * via Pi's `@<path>` syntax instead.
 *
 * Linux caps each individual argv string at `MAX_ARG_STRLEN`, which is
 * `32 * PAGE_SIZE = 131072` bytes on 4 KiB-page systems (essentially
 * every common Linux host today). Exceeding that limit fails the
 * `execve` of the spawned Pi worker with `E2BIG`, surfaced to callers
 * as `spawn E2BIG` — which has been observed in the wild for the
 * oracle when several attached files inline near their per-file cap.
 *
 * The threshold is intentionally conservative: it must leave room for
 * the `Task: ` framing, multi-byte UTF-8 expansion, and any future
 * prompt-prefix changes, while still keeping the small-prompt path
 * (which exercises the existing `"Task: <prompt>"` argv contract
 * asserted by the runner tests) for the common case.
 */
export const MMR_WORKER_INLINE_PROMPT_BYTE_LIMIT = 96 * 1024;




/**
 * Subagent worker invocation options.
 *
 * Required {@link profileName} activates the named `ampi-core` subagent
 * profile in the child Pi process via `--ampi-subagent <name>`. The
 * profile is authoritative at activation time; explicit `model` /
 * `tools` should mirror the profile route and exist for observability
 * and Pi-side parsing (ampi-core fails closed on mismatch). Optional
 * `parentMode` lets mode-derived workers validate mode-specific child
 * routes without inferring from model ids.
 */
export interface RunMmrSubagentWorkerOptions {
  /** Required subagent profile name passed as `--ampi-subagent <name>`. */
  profileName: string;
  /** Parent mode for mode-derived workers, passed as `--ampi-parent-mode`. */
  parentMode?: string;
  /** Bounded task prompt sent as the final positional prompt to `pi -p`. */
  prompt: string;
  /** Working directory for the isolated Pi worker process. */
  cwd: string;
  /** Optional worker model route. Omitted workers inherit Pi's default model selection. */
  model?: string;
  /** Concrete Pi tool allowlist passed through `--tools`. */
  tools?: readonly string[];
  /**
   * Optional restricted child extension keep set. When set to a non-empty
   * list of absolute extension entry paths the child spawns with
   * `--no-extensions -e <path>...` (faster startup); omitted/empty keeps full
   * discovery. Resolved by `computeMmrChildExtensionScope`.
   */
  childExtensionScope?: readonly string[];
  /**
   * Optional session-scoped model-preference override (issue #9). Forwarded
   * to the child Pi worker through the {@link MMR_SUBAGENT_MODEL_PREFERENCES_ENV}
   * env channel for this spawn only (never persisted), so the child's
   * activation guard resolves the same fallback route the parent selected
   * and passed via `model`/`--model`.
   */
  modelPreferencesOverride?: readonly MmrModelPreference[];
  /** Optional system prompt written to a temporary file. Delivered to the
   * child Pi via `--append-system-prompt` (default) or `--system-prompt`
   * depending on {@link systemPromptDelivery}. */
  systemPrompt?: string;
  /**
   * How the prompt file is delivered to the child Pi:
   *  - `"append"` (default): `--append-system-prompt <file>` so the worker
   *    inherits Pi's default coding-assistant head and appends the prompt.
   *  - `"replace"`: `--system-prompt <file>` so the worker uses the prompt
   *    file as the base, plus `--no-context-files --no-skills` so Pi does
   *    not extend it with project context or skills. Required by the Task
   *    tool so the assembled worker prompt is the only model-visible
   *    system prompt.
   */
  systemPromptDelivery?: "append" | "replace";
  /** Parent cancellation signal; aborting sends SIGTERM and then SIGKILL if needed. */
  signal?: AbortSignal;
  /** Maximum bytes returned in `truncatedFinalOutput`; `finalOutput` remains complete in details. */
  outputByteLimit?: number;
  /** Grace period between SIGTERM and SIGKILL after abort. */
  killTimeoutMs?: number;
  /** Progress callback invoked after parsed message/tool-result events. */
  onUpdate?: (snapshot: MmrWorkerProgressSnapshot) => void;
}

export interface MmrWorkerProcess {
  stdout: Readable;
  stderr: Readable;
  killed?: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export type MmrWorkerSpawn = (command: string, args: readonly string[], options: SpawnOptions) => MmrWorkerProcess;

export interface MmrWorkerRunnerDeps {
  spawn?: MmrWorkerSpawn;
  resolveInvocation?: (args: string[]) => MmrWorkerInvocation;
  tmpDir?: string;
}

interface PromptFileHandle {
  dir: string;
  filePath: string;
}

// Internal alias kept for the existing callsites in this file.
function emptyUsage(): MmrWorkerUsageStats {
  return emptyMmrWorkerUsageStats();
}

async function writeSystemPromptFile(systemPrompt: string, deps: Pick<MmrWorkerRunnerDeps, "tmpDir">): Promise<PromptFileHandle> {
  const dir = await mkdtemp(path.join(deps.tmpDir ?? tmpdir(), "ampi-subagent-"));
  const filePath = path.join(dir, "system-prompt.md");
  await writeFile(filePath, systemPrompt, { encoding: "utf8", mode: 0o600 });
  return { dir, filePath };
}

async function writeUserPromptFile(prompt: string, deps: Pick<MmrWorkerRunnerDeps, "tmpDir">): Promise<PromptFileHandle> {
  const dir = await mkdtemp(path.join(deps.tmpDir ?? tmpdir(), "ampi-subagent-"));
  const filePath = path.join(dir, "user-prompt.md");
  await writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600 });
  return { dir, filePath };
}

async function cleanupPromptFile(handle: PromptFileHandle | undefined): Promise<void> {
  if (!handle) return;
  await rm(handle.dir, { recursive: true, force: true });
}

function makeSnapshot(
  messages: MmrWorkerMessage[],
  usage: MmrWorkerUsageStats,
  trail: readonly MmrWorkerTrailItem[],
  byteLimit: number,
  fields: Pick<MmrWorkerProgressSnapshot, "model" | "stopReason" | "errorMessage">,
): MmrWorkerProgressSnapshot {
  const finalOutput = getMmrWorkerFinalOutput(messages);
  const truncated = truncateMmrWorkerOutput(finalOutput, byteLimit);
  return {
    messages: [...messages],
    finalOutput,
    truncatedFinalOutput: truncated.text,
    usage: { ...usage },
    trail: trail.map(copyMmrWorkerTrailItem),
    ...fields,
  };
}

function toWorkerMessage(value: unknown): MmrWorkerMessage | undefined {
  if (!isRecord(value)) return undefined;
  return value as MmrWorkerMessage;
}

/**
 * Canonical subagent worker entry. Spawns an isolated `pi --mode json -p
 * --no-session` child that activates the named `ampi-core` subagent
 * profile via `--ampi-subagent <name>`.
 *
 * Fails closed when `profileName` is empty: a worker invocation with no
 * profile would bypass `ampi-core`'s subagent activation guard and could
 * silently inherit the parent's locked-mode posture, so this is treated
 * as a programming error rather than a soft fallback.
 */
export async function runMmrSubagentWorker(
  options: RunMmrSubagentWorkerOptions,
  deps: MmrWorkerRunnerDeps = {},
): Promise<MmrWorkerResult> {
  const profileName = typeof options.profileName === "string" ? options.profileName.trim() : "";
  if (profileName.length === 0) {
    throw new Error(
      "runMmrSubagentWorker requires a non-empty profileName; pass the ampi-core subagent profile to activate.",
    );
  }
  const spawnImpl = deps.spawn ?? (nodeSpawn as unknown as MmrWorkerSpawn);
  const resolveInvocation = deps.resolveInvocation ?? resolveMmrWorkerPiInvocation;
  const outputByteLimit = options.outputByteLimit ?? DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT;
  const killTimeoutMs = options.killTimeoutMs ?? DEFAULT_MMR_WORKER_KILL_TIMEOUT_MS;
  const messages: MmrWorkerMessage[] = [];
  const usage = emptyUsage();
  const workerTrail = createMmrWorkerTrailAggregator();
  let stderr = "";
  let ignoredJsonLines = 0;
  let model: string | undefined;
  let stopReason: string | undefined;
  let errorMessage: string | undefined;
  let aborted = false;
  // Tracked to populate `MmrWorkerResult.agentStarted` so
  // `classifyMmrWorkerOutcome` can distinguish "worker entered the loop
  // and produced nothing" (empty-output) from "worker exited before the
  // agent loop began" (no-agent-start). The latter is the signature of
  // a sibling input-event handler swallowing the prompt; see the
  // outcome ladder docstring on `MmrWorkerOutcomeStatus`.
  let agentStarted = false;
  let promptFile: PromptFileHandle | undefined;
  let userPromptFile: PromptFileHandle | undefined;
  let args: string[] = [];
  let command: string;

  const emitUpdate = () => {
    options.onUpdate?.(makeSnapshot(messages, usage, workerTrail.snapshot(), outputByteLimit, { model, stopReason, errorMessage }));
  };

  try {
    const systemPrompt = options.systemPrompt?.trim();
    if (systemPrompt) promptFile = await writeSystemPromptFile(systemPrompt, deps);
    // Spill the user prompt to a temp file (and reference it via Pi's
    // `@<path>` syntax) when the inline `Task: ...` argv would exceed
    // Linux's per-arg `MAX_ARG_STRLEN`, which would otherwise fail the
    // spawn with `E2BIG`. Measured as a UTF-8 byte length so the cap
    // matches what the kernel actually counts.
    const inlinePromptBytes = Buffer.byteLength(`Task: ${options.prompt}`, "utf8");
    if (inlinePromptBytes > MMR_WORKER_INLINE_PROMPT_BYTE_LIMIT) {
      userPromptFile = await writeUserPromptFile(`Task: ${options.prompt}`, deps);
    }
    args = buildMmrWorkerArgs(options, promptFile?.filePath, userPromptFile?.filePath);
    const invocation = resolveInvocation(args);
    command = invocation.command;
    args = invocation.args;

    // Forward a session-scoped model-preference override (issue #9) to the
    // child through the env channel so child activation resolves the same
    // fallback route the parent selected. Always build the child env from a
    // copy of process.env and SCRUB the override var when this spawn has no
    // override: otherwise a nested worker (e.g. a fallback-spawned Task
    // child that itself calls finder) would inherit the parent's override
    // var and resolve the wrong route / fail child activation.
    const overrideEnv = serializeMmrSubagentModelPreferencesEnv(options.modelPreferencesOverride);
    const childEnv = { ...process.env };
    if (overrideEnv === undefined) {
      delete childEnv[AMPI_SUBAGENT_MODEL_PREFERENCES_ENV];
      delete childEnv[MMR_SUBAGENT_MODEL_PREFERENCES_ENV];
    } else {
      childEnv[AMPI_SUBAGENT_MODEL_PREFERENCES_ENV] = overrideEnv;
      delete childEnv[MMR_SUBAGENT_MODEL_PREFERENCES_ENV];
    }
    const proc = spawnImpl(command, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });

    let killTimer: NodeJS.Timeout | undefined;
    let stdoutBuffer = "";
    let childClosed = false;

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        ignoredJsonLines += 1;
        return;
      }
      if (!isRecord(event)) return;
      // Mark the agent loop as observed on any in-loop event. `agent_start`
      // is the canonical signal; the rest are defensive in case Pi reshuffles
      // its stream-event order in a future release (these events imply
      // `agent_start` already fired and never appear without it).
      if (
        event.type === "agent_start" ||
        event.type === "agent_end" ||
        event.type === "turn_start" ||
        event.type === "turn_end" ||
        event.type === "message_start" ||
        event.type === "message_end" ||
        event.type === "message_update" ||
        event.type === "tool_execution_start" ||
        event.type === "tool_execution_update" ||
        event.type === "tool_execution_end" ||
        event.type === "tool_result_end"
      ) {
        agentStarted = true;
      }
      if (event.type === "message_end") {
        const message = toWorkerMessage(event.message);
        if (!message) return;
        messages.push(message);
        collectUsage(message, usage);
        if (message.role === "assistant") {
          model = model ?? readString(message.model);
          stopReason = readString(message.stopReason) ?? stopReason;
          errorMessage = readString(message.errorMessage) ?? errorMessage;
        }
        workerTrail.captureMessage(message);
        emitUpdate();
        return;
      }
      if (event.type === "tool_result_end") {
        const message = toWorkerMessage(event.message);
        if (!message) return;
        messages.push(message);
        workerTrail.captureToolResult(message);
        emitUpdate();
        return;
      }
      if (event.type === "tool_execution_start") {
        if (workerTrail.startTool(event)) emitUpdate();
        return;
      }
      if (event.type === "tool_execution_update") {
        if (workerTrail.updateTool(event)) emitUpdate();
        return;
      }
      if (event.type === "tool_execution_end") {
        if (workerTrail.endTool(event)) emitUpdate();
      }
    };

    const finish = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; spawnError?: Error }>((resolve) => {
      let settled = false;
      const settle = (result: { exitCode: number | null; signal: NodeJS.Signals | null; spawnError?: Error }) => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        resolve(result);
      };

      proc.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });
      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      proc.on("close", (code, signal) => {
        childClosed = true;
        if (stdoutBuffer.trim()) processLine(stdoutBuffer);
        settle({ exitCode: code, signal });
      });
      proc.on("error", (error) => {
        childClosed = true;
        errorMessage = error.message;
        settle({ exitCode: 1, signal: null, spawnError: error });
      });

      const abortWorker = () => {
        aborted = true;
        errorMessage = "Subagent worker was aborted.";
        proc.kill("SIGTERM");
        // `proc.killed` flips true as soon as `kill()` successfully delivers
        // the signal, not when the child actually exits. Gate SIGKILL on
        // whether the `close` event has fired instead, otherwise a child that
        // ignores SIGTERM stays alive forever.
        killTimer = setTimeout(() => {
          if (!childClosed) proc.kill("SIGKILL");
        }, killTimeoutMs);
      };

      if (options.signal?.aborted) abortWorker();
      else options.signal?.addEventListener("abort", abortWorker, { once: true });
    });

    const spawnErrorMessage = finish.spawnError?.message;
    if (spawnErrorMessage) errorMessage = spawnErrorMessage;
    // Detect ampi-core's activation-failure marker on stderr. Must be
    // checked after stderr is fully drained (i.e. after the `close`
    // event has settled) so a marker that crossed a chunk boundary is
    // still seen. Treat marker presence as a hard failure even when Pi
    // exits 0, and surface the reason via both the structured
    // `subagentActivationError` field and `errorMessage` so existing
    // consumers that only inspect `errorMessage` still see the cause.
    const subagentActivationError = extractMmrSubagentActivationFailure(stderr);
    if (subagentActivationError) {
      errorMessage = `subagent activation failed: ${subagentActivationError}`;
    }
    const snapshot = makeSnapshot(messages, usage, workerTrail.snapshot(), outputByteLimit, { model, stopReason, errorMessage });
    const truncation = truncateMmrWorkerOutput(snapshot.finalOutput, outputByteLimit);
    return {
      ...snapshot,
      truncatedFinalOutput: truncation.text,
      prompt: options.prompt,
      cwd: options.cwd,
      command,
      args,
      exitCode: finish.exitCode,
      signal: finish.signal,
      stderr,
      aborted,
      outputTruncated: truncation.truncated,
      ignoredJsonLines,
      agentStarted,
      ...(subagentActivationError ? { subagentActivationError } : {}),
      ...(spawnErrorMessage ? { spawnError: spawnErrorMessage } : {}),
    };
  } finally {
    await cleanupPromptFile(promptFile);
    await cleanupPromptFile(userPromptFile);
  }
}





function toRunMmrSubagentWorkerOptions(
  options: MmrSubagentRunOptions,
): RunMmrSubagentWorkerOptions {
  const mapped: RunMmrSubagentWorkerOptions = {
    profileName: options.profileName,
    prompt: options.prompt,
    cwd: options.cwd,
  };
  if (options.parentMode !== undefined) mapped.parentMode = options.parentMode;
  if (options.model !== undefined) mapped.model = options.model;
  if (options.tools !== undefined) mapped.tools = options.tools;
  if (options.childExtensionScope !== undefined) mapped.childExtensionScope = options.childExtensionScope;
  if (options.systemPrompt !== undefined) mapped.systemPrompt = options.systemPrompt;
  if (options.systemPromptDelivery !== undefined) mapped.systemPromptDelivery = options.systemPromptDelivery;
  if (options.modelPreferencesOverride !== undefined) mapped.modelPreferencesOverride = options.modelPreferencesOverride;
  if (options.signal !== undefined) mapped.signal = options.signal;
  if (options.outputByteLimit !== undefined) mapped.outputByteLimit = options.outputByteLimit;
  if (options.killTimeoutMs !== undefined) mapped.killTimeoutMs = options.killTimeoutMs;
  if (options.onProgress) mapped.onUpdate = options.onProgress;
  return mapped;
}

/**
 * Build a {@link MmrSubagentRunner} backed by {@link runMmrSubagentWorker}
 * (i.e. an isolated `pi --mode json` subprocess that activates the named
 * subagent profile through `--ampi-subagent`).
 *
 * Optional {@link MmrWorkerRunnerDeps} are forwarded verbatim so tests can
 * inject a fake spawn or a custom invocation resolver.
 */
export function createChildCliMmrSubagentRunner(
  deps?: MmrWorkerRunnerDeps,
): MmrSubagentRunner {
  return createMmrSubagentRunnerFromRunWorker(runMmrSubagentWorker, deps);
}

/**
 * Build a {@link MmrSubagentRunner} from a caller-supplied `runWorker`
 * function with the same signature as {@link runMmrSubagentWorker}.
 *
 * Concrete subagent tools (`finder`, `oracle`, `Task`) accept a
 * `runWorker` test-injection dep so tests can stub the child-CLI
 * worker without spawning a real Pi process. This adapter centralizes
 * the `MmrSubagentRunOptions` → `RunMmrSubagentWorkerOptions` mapping
 * so every test seam goes through the same option translation as
 * production (in particular `systemPromptDelivery`, which earlier
 * per-tool adapters silently dropped).
 */
export function createMmrSubagentRunnerFromRunWorker(
  runWorker: typeof runMmrSubagentWorker,
  deps?: MmrWorkerRunnerDeps,
): MmrSubagentRunner {
  const invoke = (mapped: RunMmrSubagentWorkerOptions) =>
    deps ? runWorker(mapped, deps) : runWorker(mapped);
  return {
    async run(options) {
      const mapped = toRunMmrSubagentWorkerOptions(options);
      const first = await invoke(mapped);
      if (!shouldRetryMmrChildWithFullDiscovery(first, mapped.childExtensionScope)) {
        return first;
      }
      // A restricted child failed before/at activation in a way that a missing
      // extension would explain (activation mismatch or a model route whose
      // provider extension was not in the keep set). Re-run once with full
      // discovery so an invisible hook-only/provider extension cannot regress
      // the worker; the wasted spawn fails fast and is bounded to one retry.
      const retry: RunMmrSubagentWorkerOptions = { ...mapped };
      delete retry.childExtensionScope;
      return invoke(retry);
    },
  };
}
