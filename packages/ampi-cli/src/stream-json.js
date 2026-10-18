// Stream JSON (`ampi -x --stream-json`): Pi's JSON event stream (`pi --mode
// json`, documented in Pi's docs/json.md) turned into Claude Code-compatible
// stream-json records, one JSON object per line: a `system`/`init` record, a
// `user` record per user message and tool result, an `assistant` record per
// completed assistant message, and a `result` record when the run ends (one
// per run when `--stream-json-input` sends several messages).
//
// Not covered: subagent output is not streamed (`parent_tool_use_id` is always
// null), Pi has no turn limit (no `error_max_turns` result), Pi does not tell
// extensions the connection state of its MCP servers (`mcp_servers` is always
// empty), and images in user messages and tool results are left out.

/**
 * The global ampi-core registers its runtime under (see
 * `src/extensions/ampi-core/runtime.ts`). ampi ships TypeScript that only Pi's
 * loader can import, so the command reads the registration directly.
 */
export const AMPI_CORE_RUNTIME_GLOBAL_KEY = "__pi_ampi_core_runtime_v2__";

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

  /**
   * @param {string} role
   * @param {any[]} content
   * @param {Record<string, unknown>} [fields]
   */
  const messageRecord = (role, content, fields = {}) => ({
    type: role,
    message: { ...(role === "assistant" ? { type: "message" } : {}), role, content, ...fields },
    parent_tool_use_id: null,
    session_id: sessionId,
  });

  /** @param {any} message */
  const assistantBlocks = (message) =>
    message.content.flatMap((/** @type {any} */ block) => {
      // A failed request can leave an empty text block behind.
      if (block.type === "text") return block.text === "" ? [] : [{ type: "text", text: block.text }];
      if (block.type === "toolCall") return [{ type: "tool_use", id: block.id, name: block.name, input: block.arguments }];
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
  const agentMode = /** @type {any} */ (globalThis)[AMPI_CORE_RUNTIME_GLOBAL_KEY]?.getMmrModeState?.()?.mode;
  return { tools, mcpServers: [], ...(typeof agentMode === "string" ? { agentMode } : {}) };
}
