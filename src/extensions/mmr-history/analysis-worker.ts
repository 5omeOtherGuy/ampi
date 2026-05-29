import type { ExtensionContext, SessionEntry, SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import type { MmrModelPreference } from "../mmr-core/types.js";
import { loadMmrCoreSettings, type LoadedMmrCoreSettings } from "../mmr-core/settings.js";
import { assembleMmrSubagentSurface } from "../mmr-core/subagent-prompt-assembly.js";
import { getMmrSubagentProfile } from "../mmr-core/subagent-profiles.js";
import {
  DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT,
  classifyMmrWorkerOutcome,
  createChildCliMmrSubagentRunner,
  type MmrSubagentRunner,
  type MmrSubagentWorkerDetailsBase,
  type MmrSubagentWorkerRunResult,
} from "../mmr-subagents/runner.js";
import { projectRefFromCwd, redactText } from "./redaction.js";
import { extractTouchedFilesFromEntries } from "./session-index.js";

export const HISTORY_READER_SUBAGENT_PROFILE = "history-reader";
export const DEFAULT_HISTORY_READER_PACKET_BYTE_LIMIT = 48_000;

export type HistoryAnalysisMode = "lexical" | "worker";

export interface SanitizedHistoryPacketMessage {
  role?: string;
  text: string;
}

export interface SanitizedHistoryPacketEntry {
  type: string;
  role?: string;
  timestamp?: string;
  text: string;
}

export interface SanitizedHistoryReaderSessionPacket {
  version: 1;
  /**
   * Scope marker. The catalog enumerates every local `~/.pi/agent/sessions/<cwd>`
   * directory, so a single packet may describe a session from a project
   * unrelated to the active workspace. All string fields are deterministically
   * redacted before the packet leaves the local process.
   */
  scope: "all_sessions";
  /** Opaque 8-char hex ref for the session's project cwd. Never the raw cwd. */
  projectRef: string;
  goal: string;
  session: {
    id: string;
    name?: string;
    createdAt: string;
    modifiedAt: string;
    messageCount: number;
    firstMessage: string;
  };
  touchedFiles: string[];
  contextMessages: SanitizedHistoryPacketMessage[];
  entries: SanitizedHistoryPacketEntry[];
  truncated: boolean;
}

export interface HistoryReaderWorkerDetails extends MmrSubagentWorkerDetailsBase {
  worker: "mmr-history.history-reader";
  profile: typeof HISTORY_READER_SUBAGENT_PROFILE;
  /** Bytes of the sanitized history packet passed to the worker. */
  packetBytes: number;
  /** Whether the sanitized history packet was truncated before sending. */
  packetTruncated: boolean;
}

export type HistoryReaderAnalysisResult =
  | { ok: true; text: string; details: HistoryReaderWorkerDetails }
  | { ok: false; fallbackReason: string };

export interface RunHistoryReaderAnalysisInput {
  info: SessionInfo;
  manager: SessionManager;
  goal: string;
  cwd: string;
  explicitModel?: string;
  ctx?: ExtensionContext;
  signal?: AbortSignal;
  runner?: MmrSubagentRunner;
  loadCoreSettings?: (cwd: string) => Pick<LoadedMmrCoreSettings, "settings">;
  packetByteLimit?: number;
  outputByteLimit?: number;
}

function requireHistoryReaderProfile() {
  const profile = getMmrSubagentProfile(HISTORY_READER_SUBAGENT_PROFILE);
  if (!profile) {
    throw new Error(`mmr-core does not expose a "${HISTORY_READER_SUBAGENT_PROFILE}" subagent profile.`);
  }
  return profile;
}

export const HISTORY_READER_WORKER_TOOLS: readonly string[] = Object.freeze([
  ...requireHistoryReaderProfile().tools,
]);

function providerHintsForModel(model: string): string[] {
  if (model.startsWith("gpt-")) return ["openai-codex", "github-copilot", "openai", "azure-openai-responses"];
  if (model.startsWith("claude-")) return ["claude-subscription", "anthropic"];
  if (model.startsWith("gemini-") || model.startsWith("gemma-")) return ["google", "google-vertex"];
  return [];
}

function expandModelPreferences(preferences: readonly MmrModelPreference[]): string[] {
  const out: string[] = [];
  for (const preference of preferences) {
    const model = preference.model.trim();
    if (!model) continue;
    const providers = preference.providers && preference.providers.length > 0 ? preference.providers : providerHintsForModel(model);
    for (const provider of providers) out.push(`${provider}/${model}`);
    out.push(model);
  }
  return [...new Set(out)];
}

export const HISTORY_READER_DEFAULT_MODEL_PREFERENCES: readonly string[] = Object.freeze(
  expandModelPreferences(requireHistoryReaderProfile().modelPreferences),
);

export function selectHistoryReaderWorkerModel(
  availableModels: readonly string[],
  preferences: readonly string[] = HISTORY_READER_DEFAULT_MODEL_PREFERENCES,
): string | undefined {
  const available = availableModels.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
  if (available.length === 0) return undefined;
  for (const preference of preferences) {
    const target = typeof preference === "string" ? preference.trim() : "";
    if (!target) continue;
    if (available.includes(target)) return target;
    const tail = target.split("/").pop() ?? target;
    const match = available.find((entry) => entry === tail || entry.endsWith(`/${tail}`));
    if (match) return match;
  }
  return undefined;
}

function listAvailableModelsFromCtx(ctx: ExtensionContext | undefined): string[] {
  const registry = (ctx as { modelRegistry?: { getAvailable?: () => unknown; getAll?: () => unknown; hasConfiguredAuth?: (model: unknown) => boolean } } | undefined)?.modelRegistry;
  if (!registry) return [];
  let models: unknown;
  try {
    models = typeof registry.getAvailable === "function" ? registry.getAvailable() : typeof registry.getAll === "function" ? registry.getAll() : [];
  } catch {
    return [];
  }
  if (!Array.isArray(models)) return [];
  const flat: string[] = [];
  for (const entry of models) {
    if (typeof entry !== "object" || entry === null) continue;
    if (typeof registry.hasConfiguredAuth === "function") {
      try {
        if (!registry.hasConfiguredAuth(entry)) continue;
      } catch {
        continue;
      }
    }
    const provider = (entry as { provider?: unknown }).provider;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof provider === "string" && provider.length > 0) flat.push(`${provider}/${id}`);
    flat.push(id);
  }
  return flat;
}

function configuredHistoryReaderPreferences(input: Pick<RunHistoryReaderAnalysisInput, "cwd" | "loadCoreSettings">): readonly MmrModelPreference[] | undefined {
  const loader = input.loadCoreSettings ?? ((cwd: string) => loadMmrCoreSettings(cwd));
  try {
    const loaded = loader(input.cwd);
    const prefs = loaded.settings.subagentModelPreferences?.[HISTORY_READER_SUBAGENT_PROFILE];
    return prefs && prefs.length > 0 ? prefs : undefined;
  } catch {
    return undefined;
  }
}

function resolveWorkerModel(input: RunHistoryReaderAnalysisInput): string | undefined {
  const available = listAvailableModelsFromCtx(input.ctx);
  if (input.explicitModel && input.explicitModel.trim()) {
    return selectHistoryReaderWorkerModel(available, [input.explicitModel.trim()]);
  }
  const configured = configuredHistoryReaderPreferences(input);
  if (configured) return selectHistoryReaderWorkerModel(available, expandModelPreferences(configured));
  return selectHistoryReaderWorkerModel(available);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Apply the deterministic redaction sanitizer to a string field of the
 * packet, then compact whitespace and truncate to `maxChars`. Truncation
 * happens after redaction so a marker insertion can never push the raw
 * value past the cap silently.
 */
function boundedText(value: string, _info: SessionInfo, maxChars = 2_000): string {
  return compact(redactText(value)).slice(0, maxChars);
}

function agentMessageRole(message: unknown): string | undefined {
  return message && typeof message === "object" && "role" in message && typeof message.role === "string"
    ? message.role
    : undefined;
}

function agentMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  if ("content" in message) return textFromContent(message.content);
  if ("command" in message && typeof message.command === "string") return message.command;
  return "";
}

/**
 * The packet entry-type allowlist. `custom`, `custom_message`, and
 * `extension` entries are intentionally excluded in this slice: they
 * can carry caller-defined free-form payloads whose redaction
 * contract is not enumerated here. Re-evaluate when callers request
 * inclusion.
 */
const ALLOWED_ENTRY_TYPES: ReadonlySet<SessionEntry["type"]> = new Set([
  "message",
  "compaction",
  "branch_summary",
  "session_info",
] as const);

function entryText(entry: SessionEntry): string {
  if (entry.type === "message") return agentMessageText(entry.message);
  if (entry.type === "compaction" || entry.type === "branch_summary") return entry.summary;
  if (entry.type === "session_info") return entry.name ?? "";
  return "";
}

function makeContextMessages(info: SessionInfo, manager: SessionManager): SanitizedHistoryPacketMessage[] {
  const messages: SanitizedHistoryPacketMessage[] = [];
  for (const message of manager.buildSessionContext().messages.slice(0, 40)) {
    const text = boundedText(agentMessageText(message), info);
    if (!text) continue;
    const role = agentMessageRole(message);
    messages.push(role ? { role, text } : { text });
  }
  return messages;
}

function makeEntries(info: SessionInfo, manager: SessionManager): SanitizedHistoryPacketEntry[] {
  const entries: SanitizedHistoryPacketEntry[] = [];
  for (const entry of manager.getEntries().slice(0, 80)) {
    if (!ALLOWED_ENTRY_TYPES.has(entry.type)) continue;
    const text = boundedText(entryText(entry), info);
    if (!text) continue;
    const record: SanitizedHistoryPacketEntry = { type: entry.type, text };
    if (entry.timestamp) record.timestamp = entry.timestamp;
    if (entry.type === "message") {
      const role = agentMessageRole(entry.message);
      if (role) record.role = role;
    }
    entries.push(record);
  }
  return entries;
}

function packetBytes(packet: SanitizedHistoryReaderSessionPacket): number {
  return Buffer.byteLength(JSON.stringify(packet), "utf8");
}

export function buildHistoryReaderSessionPacket(
  info: SessionInfo,
  manager: SessionManager,
  goal: string,
  options: { maxBytes?: number } = {},
): SanitizedHistoryReaderSessionPacket {
  const maxBytes = Math.max(1_000, Math.floor(options.maxBytes ?? DEFAULT_HISTORY_READER_PACKET_BYTE_LIMIT));
  const entries = manager.getEntries();
  const packet: SanitizedHistoryReaderSessionPacket = {
    version: 1,
    scope: "all_sessions",
    projectRef: projectRefFromCwd(info.cwd || ""),
    goal: boundedText(goal, info, 1_000),
    session: {
      id: info.id,
      ...(info.name ? { name: boundedText(info.name, info, 200) } : {}),
      createdAt: info.created.toISOString(),
      modifiedAt: info.modified.toISOString(),
      messageCount: info.messageCount,
      firstMessage: boundedText(info.firstMessage, info, 1_000),
    },
    // Touched-file paths are normalized to lowercase POSIX cwd-relative
    // form, but the path tail can still carry user-meaningful structure
    // or repository-internal naming. Route each through the same
    // deterministic redaction the rest of the packet uses before it
    // leaves the local catalog.
    touchedFiles: [...extractTouchedFilesFromEntries(entries, info.cwd || "")]
      .map((path) => redactText(path))
      .sort(),
    contextMessages: makeContextMessages(info, manager),
    entries: makeEntries(info, manager),
    truncated: false,
  };

  while (packetBytes(packet) > maxBytes && packet.entries.length > 0) {
    packet.entries.pop();
    packet.truncated = true;
  }
  while (packetBytes(packet) > maxBytes && packet.contextMessages.length > 0) {
    packet.contextMessages.pop();
    packet.truncated = true;
  }
  if (packetBytes(packet) > maxBytes) {
    packet.session.firstMessage = packet.session.firstMessage.slice(0, 200);
    packet.goal = packet.goal.slice(0, 200);
    packet.truncated = true;
  }
  return packet;
}

/**
 * Assemble the worker user prompt from the already-sanitized packet.
 * The packet's `goal` field is the canonical goal source for the
 * worker: it is run through `redactText` and length-bounded in
 * `buildHistoryReaderSessionPacket`. Do not prepend the caller's raw
 * goal string here; that would route an unredacted user-typed goal
 * straight to the worker.
 */
export function buildHistoryReaderUserPrompt(packet: SanitizedHistoryReaderSessionPacket): string {
  return [
    `Goal: ${packet.goal}`,
    "",
    "Sanitized session packet (JSON):",
    "```json",
    JSON.stringify(packet, null, 2),
    "```",
  ].join("\n");
}

function assembleHistoryReaderSystemPrompt(cwd: string): string {
  return assembleMmrSubagentSurface({
    profile: requireHistoryReaderProfile(),
    baseSystemPrompt: "",
    activeToolManifest: [],
    cwd,
  }).systemPrompt;
}

function buildDetails(result: MmrSubagentWorkerRunResult, selectedModel: string, packet: SanitizedHistoryReaderSessionPacket): HistoryReaderWorkerDetails {
  const details: HistoryReaderWorkerDetails = {
    worker: "mmr-history.history-reader",
    profile: HISTORY_READER_SUBAGENT_PROFILE,
    model: selectedModel,
    exitCode: result.exitCode,
    signal: result.signal,
    aborted: result.aborted,
    outputTruncated: result.outputTruncated,
    ignoredJsonLines: result.ignoredJsonLines,
    usage: result.usage,
    workerTools: HISTORY_READER_WORKER_TOOLS,
    packetBytes: packetBytes(packet),
    packetTruncated: packet.truncated,
  };
  if (result.model) details.reportedModel = result.model;
  if (result.stopReason) details.stopReason = result.stopReason;
  if (result.errorMessage) details.errorMessage = result.errorMessage;
  if (result.subagentActivationError) details.subagentActivationError = result.subagentActivationError;
  return details;
}

function failureFromWorkerResult(result: MmrSubagentWorkerRunResult): string | undefined {
  // history-reader uses `fail-on-nonzero`: its worker output is parsed
  // as the analysis result, so any nonzero exit is a failure even when
  // partial bytes were captured. The classifier provides the
  // deterministic precedence (spawn-error → activation-error →
  // aborted → worker-error → empty-output → success); the strings
  // below are history-reader-specific phrasing for the failure modes.
  const outcome = classifyMmrWorkerOutcome(result, {
    partialOutputPolicy: "fail-on-nonzero",
  });
  switch (outcome) {
    case "spawn-error": {
      const reason = result.spawnError ?? result.errorMessage ?? "unknown spawn error";
      return `history-reader worker spawn failed: ${reason}`;
    }
    case "activation-error":
      return `history-reader subagent activation failed: ${result.subagentActivationError}`;
    case "aborted":
      return "history-reader worker was cancelled before producing a result";
    case "worker-error":
      return `history-reader worker exited with code ${result.exitCode ?? "null"}`;
    case "no-agent-start":
      return "history-reader worker exited before the agent loop started; another Pi extension's input handler likely consumed the prompt";
    case "empty-output":
      return "history-reader worker produced no analysis output";
    case "success":
      return undefined;
  }
}

/**
 * Build a worker-analysis failure result. Every fallback-reason string
 * that leaves this module ends up on `details.analysisFallbackReason`
 * (see `lexicalReadDetails` in tools.ts) and is therefore subject to
 * the same redaction contract as the rest of the worker surface.
 * Funnel construction through this helper so a raw error message that
 * happens to include a home path, secret, or absolute path cannot
 * leak via the fallback string.
 */
function failure(reason: string): { ok: false; fallbackReason: string } {
  return { ok: false, fallbackReason: redactText(reason) };
}

export async function runHistoryReaderAnalysis(input: RunHistoryReaderAnalysisInput): Promise<HistoryReaderAnalysisResult> {
  const selectedModel = resolveWorkerModel(input);
  if (!selectedModel) {
    return failure("No authenticated history-reader model route is available for worker analysis.");
  }

  let systemPrompt: string;
  try {
    systemPrompt = assembleHistoryReaderSystemPrompt(input.cwd);
  } catch (error) {
    return failure(`Could not assemble history-reader system prompt: ${(error as Error).message}`);
  }

  const packet = buildHistoryReaderSessionPacket(input.info, input.manager, input.goal, { maxBytes: input.packetByteLimit });
  const runner = input.runner ?? createChildCliMmrSubagentRunner();
  try {
    const result = await runner.run({
      profileName: HISTORY_READER_SUBAGENT_PROFILE,
      prompt: buildHistoryReaderUserPrompt(packet),
      cwd: input.cwd,
      model: selectedModel,
      tools: HISTORY_READER_WORKER_TOOLS,
      systemPrompt,
      signal: input.signal,
      outputByteLimit: input.outputByteLimit ?? DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT,
    });
    const failureReason = failureFromWorkerResult(result);
    if (failureReason) return failure(failureReason);
    return {
      ok: true,
      text: (result.truncatedFinalOutput || result.finalOutput).trim(),
      details: buildDetails(result, selectedModel, packet),
    };
  } catch (error) {
    return failure(`history-reader worker failed: ${(error as Error).message}`);
  }
}
