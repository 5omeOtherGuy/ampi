// Stream JSON (`ampi -x --stream-json`): Pi's JSON event stream (`pi --mode
// json`, documented in Pi's docs/json.md) turned into Claude Code-compatible
// stream-json records, one JSON object per line: a `system`/`init` record, a
// `user` record per user message and tool result, an `assistant` record per
// completed assistant message, and a `result` record when the run ends (one
// per run when `--stream-json-input` sends several messages).
//
// Subagents: while the main agent runs a blocking ampi worker tool (`Task`,
// `finder`, `oracle` and the others), the tool's progress updates carry a
// bounded trail of what the child process has done. Its answers, its tool calls
// and their results become `assistant` and `user` records whose
// `parent_tool_use_id` is the main agent's tool call id; its thinking only with
// `--stream-json-thinking`. They are an approximation: the trail holds
// shortened text (answers up to 4000 characters, tool results up to 180), child
// records have no usage and a null `stop_reason`, items the trail drops before
// an update shows them are never streamed, the `result` record counts turns and
// usage of the main agent only, and background tasks (`start_task`) and
// subagents of subagents are not streamed.
//
// Not covered: Pi has no turn limit (no `error_max_turns` result), Pi does not
// tell extensions the connection state of its MCP servers (`mcp_servers` is
// always empty), and images in user messages and tool results are left out.

/**
 * The global ampi-core registers its runtime under (see
 * `src/extensions/ampi-core/runtime.ts`). ampi ships TypeScript that only Pi's
 * loader can import, so the command reads the registration directly.
 */
export const AMPI_CORE_RUNTIME_GLOBAL_KEY = "__pi_ampi_core_runtime_v2__";

/**
 * The `kind` and `version` of the worker run envelope ampi's worker tools stamp
 * onto their tool result details (see
 * `src/extensions/ampi-workers/rendering/worker-run-envelope.ts`).
 */
export const WORKER_RUN_ENVELOPE_KIND = "worker-run";
export const WORKER_RUN_ENVELOPE_VERSION = 1;
const WORKER_RUN_MODES = ["blocking", "background", "internal"];

/** The trail item types ampi's workers report (`MmrWorkerTrailItem` in `src/extensions/ampi-core/worker-contract.ts`). */
const TRAIL_ITEM_TYPES = new Set(["user", "assistant", "thinking", "tool", "toolResult", "bashExecution", "compactionSummary", "branchSummary", "custom", "skillInvocation"]);

/** Pi's assistant `stopReason` values that have a stream JSON `stop_reason`; the others map to null. */
const STOP_REASONS = /** @type {Record<string, string>} */ ({ stop: "end_turn", length: "max_tokens", toolUse: "tool_use" });

/**
 * @typedef {object} StreamJsonContext What the init record reports besides Pi's events.
 * @property {string[]} tools Names of the tools declared to the model.
 * @property {{ name: string, status: string }[]} mcpServers
 * @property {string} [agentMode] The ampi mode, when ampi is loaded.
 *
 * @typedef {object} StreamJsonOptions
 * @property {boolean} thinking Include thinking blocks (`--stream-json-thinking`).
 * @property {() => number} now A clock in milliseconds, for `duration_ms`.
 * @property {() => StreamJsonContext} context Read once, when the first event after the session header arrives.
 *
 * @typedef {Record<string, any>} StreamJsonRecord
 *
 * @typedef {object} StreamJsonEncoder
 * @property {(event: any) => StreamJsonRecord[]} push The records for one Pi JSON event, in order.
 * @property {(failure?: string) => { records: StreamJsonRecord[], exitCode: 0 | 1 }} finish The records
 *   that end the current run, ending with its result; `failure` reports a run that failed outside
 *   the model's answer. The next events start a new run with its own turns, usage and duration.
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The `run` of the worker run envelope on a tool result's details, or undefined
 * when the details carry none. The same rule as ampi's `readWorkerRunEnvelope`,
 * which the command cannot import.
 *
 * @param {unknown} details
 * @returns {{ runMode: string } & Record<string, any> | undefined}
 */
export function readWorkerRun(details) {
  if (!isRecord(details) || details.kind !== WORKER_RUN_ENVELOPE_KIND || details.version !== WORKER_RUN_ENVELOPE_VERSION) return undefined;
  const run = details.run;
  if (!isRecord(run)) return undefined;
  if (typeof run.profileName !== "string" || typeof run.toolName !== "string" || typeof run.agent !== "string") return undefined;
  if (!WORKER_RUN_MODES.includes(run.runMode) || typeof run.status !== "string") return undefined;
  return /** @type {any} */ (run);
}

/**
 * The trail of a blocking worker run's details, without items the encoder
 * cannot read, or undefined for other details.
 *
 * @param {unknown} details
 * @returns {Record<string, any>[] | undefined}
 */
function blockingTrailOf(details) {
  if (readWorkerRun(details)?.runMode !== "blocking") return undefined;
  const run = /** @type {Record<string, any>} */ (details);
  const trail = Array.isArray(run.trail) ? run.trail : Array.isArray(run.snapshot?.trail) ? run.snapshot.trail : undefined;
  if (trail === undefined) return undefined;
  return trail.filter(
    (/** @type {unknown} */ item) =>
      isRecord(item) && TRAIL_ITEM_TYPES.has(item.type) && (item.type !== "tool" || (typeof item.toolCallId === "string" && typeof item.toolName === "string")),
  );
}

/**
 * What identifies a trail item across updates: a tool item by its call id (it
 * changes in place), any other item by its whole content (it never changes).
 *
 * @param {Record<string, any>} item
 */
const trailKeyOf = (item) => (item.type === "tool" ? `tool\u0000${item.toolCallId}` : JSON.stringify(item));

/**
 * Where the items not in the previous trail start in the next one. Between two
 * updates the trail only drops items from its front and adds items at its end,
 * so the end of the previous trail is the start of the next; of the possible
 * overlaps the longest wins, so an item is never streamed twice.
 *
 * @param {string[]} previous Keys of the previous trail.
 * @param {string[]} next Keys of the next trail.
 * @returns {number} The overlap's length; 0 when the trails share nothing.
 */
function trailOverlap(previous, next) {
  for (let dropped = Math.max(0, previous.length - next.length); dropped < previous.length; dropped++) {
    let matches = true;
    for (let index = dropped; index < previous.length && matches; index++) matches = previous[index] === next[index - dropped];
    if (matches) return previous.length - dropped;
  }
  return 0;
}

/** @param {any} usage Pi's usage of one assistant message. */
const usageOf = (usage) => ({
  input_tokens: usage?.input ?? 0,
  output_tokens: usage?.output ?? 0,
  cache_creation_input_tokens: usage?.cacheWrite ?? 0,
  cache_read_input_tokens: usage?.cacheRead ?? 0,
});

/** @param {any[]} content */
const textOf = (content) =>
  content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

/** @param {string | any[]} content A user message's or tool result's content. */
const textBlocksOf = (content) =>
  typeof content === "string" ? [{ type: "text", text: content }] : content.filter((block) => block.type === "text").map((block) => ({ type: "text", text: block.text }));

/**
 * Why the run failed, from its last assistant message, or undefined when it
 * succeeded. An answer cut off at the output limit counts as a failure, as in
 * plain execute mode.
 *
 * @param {any} message
 * @returns {string | undefined}
 */
function failureOf(message) {
  switch (message?.stopReason) {
    case "error":
      return message.errorMessage || "The model request failed.";
    case "aborted":
      return message.errorMessage || "The request was aborted.";
    case "length":
      return "The answer was cut off at the model's output limit.";
    default:
      return undefined;
  }
}

/**
 * Create an encoder from Pi's JSON events to stream JSON records. Pure: it
 * keeps the run's state and returns records; writing them is the caller's job.
 *
 * @param {StreamJsonOptions} options
 * @returns {StreamJsonEncoder}
 */
export function createStreamJsonEncoder({ thinking, now, context }) {
  /** @type {number | undefined} When the current run started: at creation for the first, at its agent_start for later ones. */
  let startedAt = now();
  let sessionId = "";
  let cwd = "";
  let started = false;
  let turns = 0;
  /** @type {any} */
  let lastAssistant;
  let usage = usageOf(undefined);
  /** @type {Map<string, string>} The calling tool of each tool another tool called. */
  const callerOf = new Map();
  /** @type {Set<string>} Ids of the main agent's tool_use blocks. */
  const toolUseIds = new Set();
  /**
   * @typedef {object} WorkerCall What has been streamed of one worker call's child.
   * @property {string[]} trail Keys of the trail of the last update.
   * @property {Map<string, Record<string, any>>} tools The child's tool items by call id, as last seen.
   * @property {Set<string>} toolUses Child tool calls whose tool_use was streamed.
   * @property {Set<string>} toolResults Child tool calls whose tool_result was streamed.
   */
  /** @type {Map<string, WorkerCall>} By the worker's tool call id. */
  const workerCalls = new Map();

  /**
   * @param {string} role
   * @param {any[]} content
   * @param {Record<string, unknown>} [fields]
   * @param {string | null} [parentToolUseId] The main agent's tool call that started the subagent, for its records.
   */
  const messageRecord = (role, content, fields = {}, parentToolUseId = null) => ({
    type: role,
    message: { ...(role === "assistant" ? { type: "message" } : {}), role, content, ...fields },
    parent_tool_use_id: parentToolUseId,
    session_id: sessionId,
  });

  /**
   * The outermost call a reader has seen as a tool_use, for a tool that another
   * tool may have called (a codemode script, for example). When no call in the
   * chain was shown (a worker a command ran, for example), the outermost call
   * id is used, so the child's records still name the call that owns them.
   *
   * @param {string} toolCallId
   */
  function visibleCallOf(toolCallId) {
    const chain = [toolCallId];
    for (let id = callerOf.get(toolCallId); id !== undefined && !chain.includes(id); id = callerOf.get(id)) chain.push(id);
    const visible = chain.filter((id) => toolUseIds.has(id));
    return visible.length > 0 ? visible[visible.length - 1] : chain[chain.length - 1];
  }

  /**
   * The records of the child's trail items that earlier updates of the same
   * worker call have not streamed.
   *
   * @param {string} toolCallId The worker's tool call id.
   * @param {Record<string, any>[]} trail
   * @param {boolean} final Whether the trail is the worker call's last.
   */
  function recordsOfTrail(toolCallId, trail, final) {
    const keys = trail.map(trailKeyOf);
    let call = workerCalls.get(toolCallId);
    let overlap = call ? trailOverlap(call.trail, keys) : 0;
    // A shorter trail that shares nothing with the last one is a new run of the
    // child, as after a model fallback; within one run the trail never shrinks.
    if (!call || (overlap === 0 && keys.length < call.trail.length)) {
      call = { trail: [], tools: new Map(), toolUses: new Set(), toolResults: new Set() };
      workerCalls.set(toolCallId, call);
      overlap = 0;
    }
    const current = call;
    const parent = visibleCallOf(toolCallId);
    /** @type {StreamJsonRecord[]} */
    const records = [];
    /**
     * @param {string} id
     * @param {string} content
     * @param {boolean} isError
     */
    const toolResult = (id, content, isError) => {
      current.toolResults.add(id);
      records.push(messageRecord("user", [{ type: "tool_result", tool_use_id: id, content, is_error: isError }], {}, parent));
    };
    let read = trail.length;
    for (const [index, item] of trail.entries()) {
      if (item.type === "tool") {
        // Tool items change in place, so they are read wherever they are.
        current.tools.set(item.toolCallId, item);
        if (!current.toolUses.has(item.toolCallId)) {
          // The child's answer names the tool before the child starts it with
          // its arguments, an update later: the items from here on wait for
          // them, or for the tool or the worker call to end.
          if (item.args === undefined && item.status === "running" && !final) {
            read = index;
            break;
          }
          current.toolUses.add(item.toolCallId);
          const input = isRecord(item.args) ? item.args : {};
          records.push(messageRecord("assistant", [{ type: "tool_use", id: item.toolCallId, name: item.toolName, input }], { stop_reason: null }, parent));
        }
        if ((item.status === "completed" || item.status === "failed") && !current.toolResults.has(item.toolCallId)) {
          toolResult(item.toolCallId, typeof item.resultPreview === "string" ? item.resultPreview : "", item.status === "failed");
        }
        continue;
      }
      if (index < overlap) continue;
      if (item.type === "assistant" && typeof item.text === "string" && item.text !== "") {
        records.push(messageRecord("assistant", [{ type: "text", text: item.text }], { stop_reason: null }, parent));
      } else if (item.type === "thinking" && thinking && typeof item.text === "string" && item.text !== "") {
        records.push(messageRecord("assistant", [{ type: "thinking", thinking: item.text }], { stop_reason: null }, parent));
      } else if (item.type === "toolResult" && typeof item.toolCallId === "string") {
        // The trail keeps a separate result only once the tool's own item has
        // been dropped: it completes a tool_use that was streamed.
        const tool = current.tools.get(item.toolCallId);
        if (current.toolUses.has(item.toolCallId) && !current.toolResults.has(item.toolCallId)) {
          const preview = typeof tool?.resultPreview === "string" ? tool.resultPreview : typeof item.text === "string" ? item.text : "";
          toolResult(item.toolCallId, preview, item.isError === true);
        }
      }
      // The child's prompt is the input of the worker's tool call; summaries,
      // shell commands, skills and custom messages are not model messages.
    }
    // The next update is aligned with the items read so far.
    current.trail = keys.slice(0, read);
    return records;
  }

  /**
   * The child records a worker tool's progress or final result adds.
   *
   * @param {any} event A tool_execution_start, _update or _end event.
   */
  function recordsOfToolExecution(event) {
    if (typeof event.toolCallId !== "string") return [];
    if (typeof event.parentToolCallId === "string") callerOf.set(event.toolCallId, event.parentToolCallId);
    if (event.type === "tool_execution_start") return [];
    const trail = blockingTrailOf(event.type === "tool_execution_update" ? event.partialResult?.details : event.result?.details);
    const records = trail ? recordsOfTrail(event.toolCallId, trail, event.type === "tool_execution_end") : [];
    if (event.type === "tool_execution_end") workerCalls.delete(event.toolCallId);
    return records;
  }

  /** @param {any} message */
  const assistantBlocks = (message) =>
    message.content.flatMap((/** @type {any} */ block) => {
      // A failed request can leave an empty text block behind.
      if (block.type === "text") return block.text === "" ? [] : [{ type: "text", text: block.text }];
      if (block.type === "toolCall") {
        toolUseIds.add(block.id);
        return [{ type: "tool_use", id: block.id, name: block.name, input: block.arguments }];
      }
      if (block.type === "thinking" && thinking) {
        return block.redacted ? [{ type: "redacted_thinking", data: block.thinkingSignature ?? "" }] : [{ type: "thinking", thinking: block.thinking }];
      }
      return [];
    });

  /** @param {any} message */
  function recordsOfMessage(message) {
    if (message.role === "user") {
      const content = textBlocksOf(message.content);
      return content.length > 0 ? [messageRecord("user", content)] : [];
    }
    if (message.role === "toolResult") {
      const block = { type: "tool_result", tool_use_id: message.toolCallId, content: textOf(message.content), is_error: message.isError === true };
      return [messageRecord("user", [block])];
    }
    if (message.role === "assistant") {
      lastAssistant = message;
      const messageUsage = usageOf(message.usage);
      for (const key of /** @type {(keyof typeof usage)[]} */ (Object.keys(usage))) usage[key] += messageUsage[key];
      const content = assistantBlocks(message);
      if (content.length === 0) return [];
      return [messageRecord("assistant", content, { stop_reason: STOP_REASONS[message.stopReason] ?? null, usage: messageUsage })];
    }
    // System, custom, bash and summary messages have no stream JSON record.
    return [];
  }

  /** @returns {StreamJsonRecord[]} */
  function init() {
    if (started) return [];
    started = true;
    const { tools, mcpServers, agentMode } = context();
    return [
      {
        type: "system",
        subtype: "init",
        cwd,
        session_id: sessionId,
        tools,
        mcp_servers: mcpServers,
        ...(agentMode === undefined ? {} : { agent_mode: agentMode }),
      },
    ];
  }

  return {
    push(event) {
      if (event.type === "session") {
        sessionId = event.id;
        cwd = event.cwd;
        return [];
      }
      const records = init();
      if (event.type === "agent_start") startedAt ??= now();
      if (event.type === "turn_start") turns++;
      if (event.type === "message_end") records.push(...recordsOfMessage(event.message));
      if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
        records.push(...recordsOfToolExecution(event));
      }
      return records;
    },

    finish(failure) {
      const records = init();
      const error = failure ?? failureOf(lastAssistant);
      const end = now();
      const common = { duration_ms: Math.round(end - (startedAt ?? end)), num_turns: turns, session_id: sessionId, usage: { ...usage } };
      const result = lastAssistant ? textOf(lastAssistant.content) : "";
      startedAt = undefined;
      turns = 0;
      lastAssistant = undefined;
      usage = usageOf(undefined);
      workerCalls.clear();
      callerOf.clear();
      toolUseIds.clear();
      if (error === undefined) {
        records.push({ type: "result", subtype: "success", is_error: false, ...common, result });
        return { records, exitCode: 0 };
      }
      records.push({ type: "result", subtype: "error_during_execution", is_error: true, ...common, error });
      return { records, exitCode: 1 };
    },
  };
}

/**
 * What the init record reports, read from the running session: the active
 * tools from Pi's extension API and the mode from ampi-core's runtime.
 *
 * @param {any} pi The extension API of the run, or undefined before Pi loaded extensions.
 * @returns {StreamJsonContext}
 */
export function readStreamJsonContext(pi) {
  /** @type {string[]} */
  let tools = [];
  try {
    tools = pi?.getActiveTools() ?? [];
  } catch {
    // The extension API of a runtime that has already been replaced.
  }
  // A registered mode reports its own key; `mode` holds only its base mode.
  const state = /** @type {any} */ (globalThis)[AMPI_CORE_RUNTIME_GLOBAL_KEY]?.getMmrModeState?.();
  const agentMode = state?.registeredMode?.key ?? state?.mode;
  return { tools, mcpServers: [], ...(typeof agentMode === "string" ? { agentMode } : {}) };
}
