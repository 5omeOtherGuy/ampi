import type { ExtensionContext, SessionEntry, SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import type { MmrModelPreference } from "../mmr-core/types.js";
import { loadMmrCoreSettings, type LoadedMmrCoreSettings } from "../mmr-core/settings.js";
import { assembleMmrSubagentSurface } from "../mmr-core/subagent-prompt-assembly.js";
import { getMmrSubagentProfile, selectFirstMatchingAvailableModel } from "../mmr-core/subagent-profiles.js";
import {
  DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT,
  classifyMmrWorkerOutcomeForProfile,
  createChildCliMmrSubagentRunner,
  type MmrSubagentRunner,
  type MmrSubagentWorkerDetailsBase,
  type MmrSubagentWorkerRunResult,
} from "../mmr-workers/runner.js";
import { maybeRedact, projectRefFromCwd, redactText } from "./redaction.js";
import { extractTouchedFilesFromEntries } from "./session-index.js";

export const HISTORY_READER_SUBAGENT_PROFILE = "history-reader";
// The history-reader subagent runs on a large-context extraction model, so the
// packet budget is sized to preserve far more of the session than the legacy
// 48KB cap. 512KB of sanitized JSON is roughly 100-150K tokens — comfortably
// within a large-context model's window while leaving headroom for the system
// prompt and the worker's own output. The byte budget (not a fixed message
// count) drives selection so the packet degrades gracefully as entries grow
// larger or more numerous, including the tool-call/tool-result content below.
export const DEFAULT_HISTORY_READER_PACKET_BYTE_LIMIT = 512_000;
// Per-field char cap applied as content is collected, before budget-driven
// trimming. Liberal by default; the trimming pass shrinks the largest fields
// toward MIN_* only when the packet exceeds its byte budget.
export const DEFAULT_HISTORY_READER_PACKET_FIELD_CHARS = 16_000;
const MIN_HISTORY_READER_PACKET_FIELD_CHARS = 200;

export type HistoryAnalysisMode = "lexical" | "worker";

/**
 * One assistant tool call rendered for the packet: the tool name plus a
 * bounded rendering of its arguments. `args` carries artifact-bearing
 * payloads such as `apply_patch` diffs, `write` content, or shell commands
 * so the extraction model can recover them.
 */
export interface SanitizedHistoryPacketToolCall {
  name: string;
  args?: string;
}

/**
 * One tool result rendered for the packet: the producing tool name, its
 * error flag, and the bounded output text (bash stdout/stderr, file
 * contents, command output).
 */
export interface SanitizedHistoryPacketToolResult {
  name?: string;
  isError?: boolean;
  text: string;
}

export interface SanitizedHistoryPacketMessage {
  role?: string;
  text: string;
  toolCalls?: SanitizedHistoryPacketToolCall[];
  toolResult?: SanitizedHistoryPacketToolResult;
}

export interface SanitizedHistoryPacketEntry {
  type: string;
  role?: string;
  timestamp?: string;
  text: string;
  toolCalls?: SanitizedHistoryPacketToolCall[];
  toolResult?: SanitizedHistoryPacketToolResult;
}

export interface SanitizedHistoryReaderSessionPacket {
  version: 1;
  /**
   * Scope marker. The catalog enumerates every local `~/.pi/agent/sessions/<cwd>`
   * directory, so a single packet may describe a session from a project
   * unrelated to the active workspace. String fields are deterministically
   * redacted before the packet leaves the local process only when content
   * redaction is opted in (MMR_HISTORY_REDACT); by default content is raw.
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
  /**
   * Whether session CONTENT is redacted before assembly. Threaded from
   * the `redactionEnabled` setting at the tools seam. Default OFF
   * (opt-in) means raw content reaches the packet. Omitted by direct
   * callers/tests defaults to redacting (safe), since the product opt-in
   * is enforced explicitly at the tools layer.
   */
  redactionEnabled?: boolean;
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
  return selectFirstMatchingAvailableModel(availableModels, preferences);
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
 * Mutable state threaded through packet assembly so the initial per-field
 * char cap is reflected in `packet.truncated`. Without this, a field clipped
 * at `maxChars` during collection would not flip the flag if the assembled
 * packet still fit under the byte budget.
 */
interface PacketBuildState {
  truncated: boolean;
}

/**
 * Optionally apply the deterministic redaction sanitizer to a string
 * field of the packet, then compact whitespace and truncate to
 * `maxChars`. Truncation happens after redaction so a marker insertion
 * can never push the raw value past the cap silently. `redactionEnabled`
 * is the opt-in CONTENT toggle: when `false` the raw value is compacted
 * and bounded but not rewritten. When a field is clipped at `maxChars`,
 * `state.truncated` is set so the packet honestly reports content loss.
 */
function boundedText(
  value: string,
  _info: SessionInfo,
  redactionEnabled: boolean,
  maxChars = DEFAULT_HISTORY_READER_PACKET_FIELD_CHARS,
  state?: PacketBuildState,
): string {
  const text = compact(maybeRedact(value, redactionEnabled));
  if (state && text.length > maxChars) state.truncated = true;
  return text.slice(0, maxChars);
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

/**
 * Render a tool call's arguments to a single string before bounding/redaction.
 * Strings pass through verbatim; objects are JSON-serialized so structured
 * payloads (patch text, write content, query strings) survive as readable text.
 */
function renderToolArguments(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return "";
  }
}

/**
 * Extract the assistant tool-call content blocks from a message using the same
 * `blockRecord.type === "toolCall"` shape detection as `session-index.ts`.
 * Each call's name and rendered arguments are routed through `boundedText`.
 */
function extractToolCalls(
  message: unknown,
  info: SessionInfo,
  redactionEnabled: boolean,
  maxFieldChars: number,
  state: PacketBuildState,
): SanitizedHistoryPacketToolCall[] {
  if (!message || typeof message !== "object") return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const calls: SanitizedHistoryPacketToolCall[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as { type?: unknown; name?: unknown; arguments?: unknown };
    if (record.type !== "toolCall") continue;
    const name = typeof record.name === "string" ? record.name : "";
    if (!name) continue;
    const call: SanitizedHistoryPacketToolCall = { name: boundedText(name, info, redactionEnabled, 200, state) };
    const args = boundedText(renderToolArguments(record.arguments), info, redactionEnabled, maxFieldChars, state);
    if (args) call.args = args;
    calls.push(call);
  }
  return calls;
}

/**
 * The text, tool calls, and tool result a single message contributes to the
 * packet. `toolResult` messages carry their output via `toolResult.text`
 * (not `text`) to avoid duplicating the same content under both fields;
 * `bashExecution` keeps its command as `text` and its captured output as
 * a synthetic bash `toolResult`.
 */
interface MessagePacketParts {
  text: string;
  toolCalls: SanitizedHistoryPacketToolCall[];
  toolResult?: SanitizedHistoryPacketToolResult;
}

function messagePacketParts(
  message: unknown,
  info: SessionInfo,
  redactionEnabled: boolean,
  maxFieldChars: number,
  state: PacketBuildState,
): MessagePacketParts {
  const toolCalls = extractToolCalls(message, info, redactionEnabled, maxFieldChars, state);
  const role = agentMessageRole(message);
  if (role === "toolResult") {
    const result: SanitizedHistoryPacketToolResult = {
      text: boundedText(textFromContent((message as { content?: unknown }).content), info, redactionEnabled, maxFieldChars, state),
    };
    const toolName = (message as { toolName?: unknown }).toolName;
    if (typeof toolName === "string" && toolName) result.name = boundedText(toolName, info, redactionEnabled, 200, state);
    const isError = (message as { isError?: unknown }).isError;
    if (typeof isError === "boolean") result.isError = isError;
    return { text: "", toolCalls, toolResult: result };
  }
  if (role === "bashExecution") {
    const command = (message as { command?: unknown }).command;
    const text = typeof command === "string" ? boundedText(command, info, redactionEnabled, maxFieldChars, state) : "";
    const output = (message as { output?: unknown }).output;
    const outputText = typeof output === "string" ? boundedText(output, info, redactionEnabled, maxFieldChars, state) : "";
    return outputText
      ? { text, toolCalls, toolResult: { name: "bash", text: outputText } }
      : { text, toolCalls };
  }
  return { text: boundedText(agentMessageText(message), info, redactionEnabled, maxFieldChars, state), toolCalls };
}

// Budget-driven selection: include every context message / allowlisted entry
// and let the deterministic trimming pass shrink/drop them only if the packet
// exceeds its byte budget, instead of a fixed head slice that drops recent
// activity.
function makeContextMessages(
  info: SessionInfo,
  manager: SessionManager,
  redactionEnabled: boolean,
  maxFieldChars: number,
  state: PacketBuildState,
): SanitizedHistoryPacketMessage[] {
  const messages: SanitizedHistoryPacketMessage[] = [];
  for (const message of manager.buildSessionContext().messages) {
    const { text, toolCalls, toolResult } = messagePacketParts(message, info, redactionEnabled, maxFieldChars, state);
    if (!text && toolCalls.length === 0 && !toolResult) continue;
    const role = agentMessageRole(message);
    const record: SanitizedHistoryPacketMessage = role ? { role, text } : { text };
    if (toolCalls.length > 0) record.toolCalls = toolCalls;
    if (toolResult) record.toolResult = toolResult;
    messages.push(record);
  }
  return messages;
}

function makeEntries(
  info: SessionInfo,
  manager: SessionManager,
  redactionEnabled: boolean,
  maxFieldChars: number,
  state: PacketBuildState,
): SanitizedHistoryPacketEntry[] {
  const entries: SanitizedHistoryPacketEntry[] = [];
  for (const entry of manager.getEntries()) {
    if (!ALLOWED_ENTRY_TYPES.has(entry.type)) continue;
    let text: string;
    let toolCalls: SanitizedHistoryPacketToolCall[] = [];
    let toolResult: SanitizedHistoryPacketToolResult | undefined;
    let role: string | undefined;
    if (entry.type === "message") {
      const parts = messagePacketParts(entry.message, info, redactionEnabled, maxFieldChars, state);
      text = parts.text;
      toolCalls = parts.toolCalls;
      toolResult = parts.toolResult;
      role = agentMessageRole(entry.message);
    } else {
      text = boundedText(entryText(entry), info, redactionEnabled, maxFieldChars, state);
    }
    if (!text && toolCalls.length === 0 && !toolResult) continue;
    const record: SanitizedHistoryPacketEntry = { type: entry.type, text };
    if (entry.timestamp) record.timestamp = entry.timestamp;
    if (role) record.role = role;
    if (toolCalls.length > 0) record.toolCalls = toolCalls;
    if (toolResult) record.toolResult = toolResult;
    entries.push(record);
  }
  return entries;
}

function packetBytes(packet: SanitizedHistoryReaderSessionPacket): number {
  return Buffer.byteLength(JSON.stringify(packet), "utf8");
}

/**
 * Remove the lowest-value element from a list while preserving both ends.
 * The middle of a session is the least informative slice to drop: the
 * earliest entries establish context/goal and the most recent entries carry
 * current activity. Removing the median index repeatedly converges on a
 * head+tail subset deterministically.
 */
function dropMiddle<T>(list: T[]): void {
  if (list.length === 0) return;
  list.splice(Math.floor((list.length - 1) / 2), 1);
}

/** Shrink one packet message/entry's large text fields to `cap`. */
function shrinkRecordFields(
  record: { text: string; toolCalls?: SanitizedHistoryPacketToolCall[]; toolResult?: SanitizedHistoryPacketToolResult },
  cap: number,
): boolean {
  let shrank = false;
  if (record.text.length > cap) {
    record.text = record.text.slice(0, cap);
    shrank = true;
  }
  if (record.toolResult && record.toolResult.text.length > cap) {
    record.toolResult.text = record.toolResult.text.slice(0, cap);
    shrank = true;
  }
  for (const call of record.toolCalls ?? []) {
    if (call.args && call.args.length > cap) {
      call.args = call.args.slice(0, cap);
      shrank = true;
    }
  }
  return shrank;
}

/**
 * Deterministic, balanced trimming. Strategy, in order, each step only
 * applied while still over budget:
 *   1. Proportionally shrink the largest text fields — message/entry text,
 *      tool-result output, and tool-call arguments — by repeatedly halving a
 *      per-field char cap down to a floor, so no single field (including a
 *      large diff or bash dump) dominates the packet.
 *   2. Drop entries from the middle (see dropMiddle) so early context and
 *      recent activity both survive instead of popping the tail head-first.
 *   3. Drop context messages from the middle for the same reason.
 *   4. Drop touched-file paths, then hard-truncate the goal/firstMessage
 *      summary fields, as a last resort to honor the byte budget.
 * Any reduction sets `truncated = true`.
 */
function trimPacketToBudget(
  packet: SanitizedHistoryReaderSessionPacket,
  maxBytes: number,
  fieldChars: number,
): void {
  let fieldCap = fieldChars;
  while (packetBytes(packet) > maxBytes && fieldCap > MIN_HISTORY_READER_PACKET_FIELD_CHARS) {
    fieldCap = Math.max(MIN_HISTORY_READER_PACKET_FIELD_CHARS, Math.floor(fieldCap / 2));
    for (const entry of packet.entries) {
      if (shrinkRecordFields(entry, fieldCap)) packet.truncated = true;
    }
    for (const message of packet.contextMessages) {
      if (shrinkRecordFields(message, fieldCap)) packet.truncated = true;
    }
  }
  while (packetBytes(packet) > maxBytes && packet.entries.length > 0) {
    dropMiddle(packet.entries);
    packet.truncated = true;
  }
  while (packetBytes(packet) > maxBytes && packet.contextMessages.length > 0) {
    dropMiddle(packet.contextMessages);
    packet.truncated = true;
  }
  while (packetBytes(packet) > maxBytes && packet.touchedFiles.length > 0) {
    packet.touchedFiles.pop();
    packet.truncated = true;
  }
  if (packetBytes(packet) > maxBytes) {
    packet.session.firstMessage = packet.session.firstMessage.slice(0, 200);
    packet.goal = packet.goal.slice(0, 200);
    packet.truncated = true;
  }
}

export function buildHistoryReaderSessionPacket(
  info: SessionInfo,
  manager: SessionManager,
  goal: string,
  options: { maxBytes?: number; maxFieldChars?: number; redactionEnabled?: boolean } = {},
): SanitizedHistoryReaderSessionPacket {
  const maxBytes = Math.max(1_000, Math.floor(options.maxBytes ?? DEFAULT_HISTORY_READER_PACKET_BYTE_LIMIT));
  const maxFieldChars = Math.max(
    MIN_HISTORY_READER_PACKET_FIELD_CHARS,
    Math.floor(options.maxFieldChars ?? DEFAULT_HISTORY_READER_PACKET_FIELD_CHARS),
  );
  // Opt-in CONTENT redaction. Direct callers/tests that omit the flag
  // default to redacting (safe); the product opt-in default (raw) is
  // enforced by the tools seam passing the resolved setting explicitly.
  const redactionEnabled = options.redactionEnabled ?? true;
  // Tracks whether the initial per-field char cap clipped any field, so the
  // packet reports truncation even when the assembled packet fits the budget.
  const state: PacketBuildState = { truncated: false };
  const entries = manager.getEntries();
  const packet: SanitizedHistoryReaderSessionPacket = {
    version: 1,
    scope: "all_sessions",
    // projectRef hashing is ALWAYS on, independent of the content toggle.
    projectRef: projectRefFromCwd(info.cwd || ""),
    goal: boundedText(goal, info, redactionEnabled, 1_000, state),
    session: {
      id: info.id,
      ...(info.name ? { name: boundedText(info.name, info, redactionEnabled, 200, state) } : {}),
      createdAt: info.created.toISOString(),
      modifiedAt: info.modified.toISOString(),
      messageCount: info.messageCount,
      firstMessage: boundedText(info.firstMessage, info, redactionEnabled, 1_000, state),
    },
    // Touched-file paths are normalized to lowercase POSIX cwd-relative
    // form, but the path tail can still carry user-meaningful structure
    // or repository-internal naming. Route each through the same
    // deterministic redaction the rest of the packet uses before it
    // leaves the local catalog (only when content redaction is opted in).
    touchedFiles: [...extractTouchedFilesFromEntries(entries, info.cwd || "")]
      .map((path) => maybeRedact(path, redactionEnabled))
      .sort(),
    contextMessages: makeContextMessages(info, manager, redactionEnabled, maxFieldChars, state),
    entries: makeEntries(info, manager, redactionEnabled, maxFieldChars, state),
    truncated: false,
  };
  packet.truncated = state.truncated;

  trimPacketToBudget(packet, maxBytes, maxFieldChars);
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
  const outcome = classifyMmrWorkerOutcomeForProfile(
    result,
    getMmrSubagentProfile(HISTORY_READER_SUBAGENT_PROFILE),
  );
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

  const packet = buildHistoryReaderSessionPacket(input.info, input.manager, input.goal, {
    maxBytes: input.packetByteLimit,
    redactionEnabled: input.redactionEnabled,
  });
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
