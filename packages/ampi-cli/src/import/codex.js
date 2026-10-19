// Codex's sessions, read for `ampi threads import codex` and converted into
// Pi messages. Codex keeps one JSONL file per session ("rollout") in
// <sessions dir>/YYYY/MM/DD/rollout-<time>-<id>.jsonl. Each line is
// {timestamp, type, payload}: `session_meta` opens the file with the id and
// working directory, `turn_context` records a turn's model, `response_item`
// lines are the conversation (messages, reasoning, tool calls and their
// outputs) and `event_msg` lines are events, among them a turn's start and
// end and the token counts.
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { IMPORT_API, importedUsage, isObject, tokenCount, userContent } from "./messages.js";

/** @typedef {import("./messages.js").SourceSession} SourceSession @typedef {import("./messages.js").Conversion} Conversion */

export const CODEX_AGENT = "codex";
const IMPORT_PROVIDER = "codex-import";
/** The name of the tool call a `local_shell_call` item becomes. */
const SHELL_TOOL = "shell";

/** Codex's session ids are UUIDs, which also end the rollout file names. */
export const CODEX_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLLOUT_FILE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
/** How deep rollouts sit below the sessions directory: year, month, day. */
const DEPTH = 3;

/**
 * User messages that only carry context Codex adds for the model: the
 * environment, the user's instructions and AGENTS.md files, and the note on
 * an interrupted turn.
 */
const CONTEXT_TEXT = /^\s*(?:<(?:environment_context|user_instructions|turn_aborted)>|# AGENTS\.md instructions for )/;

/**
 * Codex's sessions directory: `$CODEX_HOME/sessions`, else `~/.codex/sessions`.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 */
export function codexSessionsDir(env, home) {
  return path.join(env.CODEX_HOME || path.join(home, ".codex"), "sessions");
}

/**
 * The first line of a file, read in chunks so the rest of a long rollout is
 * never loaded; "" when the file cannot be read.
 *
 * @param {string} file
 */
function firstLine(file) {
  /** @type {number | undefined} */
  let fd;
  try {
    fd = openSync(file, "r");
    const chunk = Buffer.alloc(64 * 1024);
    /** @type {Buffer[]} */
    const read = [];
    for (;;) {
      const bytes = readSync(fd, chunk, 0, chunk.length, null);
      if (bytes === 0) break;
      const end = chunk.subarray(0, bytes).indexOf(10);
      read.push(Buffer.from(chunk.subarray(0, end === -1 ? bytes : end)));
      if (end !== -1) break;
    }
    return Buffer.concat(read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Whether a helper agent ran the rollout: Codex records the `source` of a
 * review, a compaction, a thread another thread spawned and similar runs as
 * an object with a `subagent` key in the `session_meta` that opens the file.
 *
 * @param {string} file
 */
function isHelperRollout(file) {
  try {
    const entry = JSON.parse(firstLine(file));
    return isObject(entry) && entry.type === "session_meta" && isObject(entry.payload) && isObject(entry.payload.source) && "subagent" in entry.payload.source;
  } catch {
    return false;
  }
}

/**
 * Every rollout file below `dir`, up to the day folders, with the id its name
 * ends with, and whether a helper agent ran it. A missing directory has none.
 *
 * @param {string} dir Codex's sessions directory.
 * @returns {SourceSession[]}
 */
export function listCodexSessions(dir) {
  /** @type {SourceSession[]} */
  const sessions = [];
  /** @param {string} folder @param {number} depth */
  const visit = (folder, depth) => {
    /** @type {import("node:fs").Dirent[]} */
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory() && depth < DEPTH) visit(file, depth + 1);
      const id = ROLLOUT_FILE.exec(entry.name)?.[1];
      if (!entry.isFile() || id === undefined) continue;
      const stats = statSync(file, { throwIfNoEntry: false });
      if (stats?.isFile()) sessions.push({ id, file, modified: stats.mtime, ...(isHelperRollout(file) ? { subagent: true } : {}) });
    }
  };
  visit(dir, 0);
  return sessions;
}

/**
 * A Pi image from an `input_image` item's data URL, or "(image)" for any
 * other image.
 *
 * @param {Record<string, any>} item
 */
function convertImage(item) {
  const match = typeof item.image_url === "string" ? /^data:([^;,]+);base64,(.*)$/s.exec(item.image_url) : null;
  return match === null ? { type: "text", text: "(image)" } : { type: "image", data: match[2], mimeType: match[1] };
}

/**
 * The text and images of a tool's output: a string, a list of content items,
 * or an object holding the text as `content`.
 *
 * @param {unknown} output
 */
function convertOutput(output) {
  if (typeof output === "string") return [{ type: "text", text: output }];
  if (isObject(output) && typeof output.content === "string") return [{ type: "text", text: output.content }];
  if (!Array.isArray(output)) return [];
  return output.flatMap((item) => {
    if (!isObject(item)) return [];
    if ((item.type === "input_text" || item.type === "output_text") && typeof item.text === "string") return [{ type: "text", text: item.text }];
    if (item.type === "input_image") return [convertImage(item)];
    return [];
  });
}

/**
 * A tool call's arguments: the JSON object the text holds, else the text
 * itself as `input`.
 *
 * @param {unknown} text
 */
function convertArguments(text) {
  if (typeof text !== "string") return isObject(text) ? text : {};
  try {
    const parsed = JSON.parse(text);
    if (isObject(parsed)) return parsed;
  } catch {}
  return { input: text };
}

/**
 * Pi's usage from the tokens a turn used: the difference between Codex's
 * running totals at its end and before it. Codex counts cached input inside
 * the input tokens, as Pi's OpenAI providers subtract it.
 *
 * @param {Record<string, any>} end
 * @param {Record<string, any>} start
 */
function turnUsage(end, start) {
  /** @param {string} field */
  const used = (field) => tokenCount(end[field]) - tokenCount(start[field]);
  const counts = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens"].map(used);
  if (counts.some((value) => value < 0)) return undefined;
  const [input, cacheRead, cacheWrite, output] = counts;
  return importedUsage({ input: Math.max(0, input - cacheRead - cacheWrite), output, cacheRead, cacheWrite });
}

/**
 * Convert a Codex rollout file's text into Pi messages, in file order.
 * Developer and system messages, user messages that only carry context, and
 * every line but `session_meta`, `turn_context`, `response_item` and the turn
 * and token events are skipped. Reasoning summaries become thinking; the
 * encrypted reasoning is dropped. The items of one reply (reasoning, text,
 * tool calls) become one assistant message until a tool output or a user
 * message follows. A turn's tokens go to its last assistant message when the
 * file records the turn's start and end and its token counts; otherwise no
 * message carries them.
 *
 * @param {string} text
 * @returns {Conversion}
 */
export function convertCodexSession(text) {
  /** @type {string | undefined} */
  let cwd;
  let model = "unknown";
  /** @type {any[]} */
  const messages = [];
  /** @type {Map<string, string>} */
  const toolNames = new Map();
  /** @type {any} The assistant message the next reply item joins, until something else follows it. */
  let open;
  let time = 0;
  /** @type {Record<string, any>} Codex's running token totals, as of the last token count. */
  let totals = {};
  /** @type {{ before: Record<string, any>, start: number, counted: boolean } | undefined} The turn in progress: the totals before it, its first message, and whether a token count fell in it. */
  let turn;

  /** @param {object} block */
  const reply = (block) => {
    if (open === undefined) {
      open = { role: "assistant", content: [], api: IMPORT_API, provider: IMPORT_PROVIDER, model, timestamp: time, usage: importedUsage(), stopReason: "stop" };
      messages.push(open);
    }
    open.content.push(block);
    if (/** @type {any} */ (block).type === "toolCall") open.stopReason = "toolUse";
  };
  /** @param {string} id @param {string} name @param {object} args */
  const call = (id, name, args) => {
    toolNames.set(id, name);
    reply({ type: "toolCall", id, name, arguments: args });
  };

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    /** @type {unknown} */
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(entry) || !isObject(entry.payload)) continue;
    const payload = entry.payload;
    const parsed = Date.parse(String(entry.timestamp));
    if (Number.isFinite(parsed)) time = parsed;

    if (entry.type === "session_meta" || entry.type === "turn_context") {
      if (cwd === undefined && typeof payload.cwd === "string" && payload.cwd) cwd = payload.cwd;
      if (entry.type === "turn_context" && typeof payload.model === "string" && payload.model) model = payload.model;
      continue;
    }
    if (entry.type === "event_msg") {
      if (payload.type === "task_started") {
        open = undefined;
        turn = { before: totals, start: messages.length, counted: false };
      } else if (payload.type === "token_count" && isObject(payload.info) && isObject(payload.info.total_token_usage)) {
        totals = payload.info.total_token_usage;
        if (turn !== undefined) turn.counted = true;
      } else if ((payload.type === "task_complete" || payload.type === "turn_aborted") && turn !== undefined) {
        const last = messages.slice(turn.start).filter((message) => message.role === "assistant").at(-1);
        const usage = turn.counted ? turnUsage(totals, turn.before) : undefined;
        if (last !== undefined && usage !== undefined) last.usage = usage;
        turn = undefined;
      }
      continue;
    }
    if (entry.type !== "response_item") continue;

    if (payload.type === "message") {
      const items = Array.isArray(payload.content) ? payload.content.filter(isObject) : [];
      if (payload.role === "assistant") {
        for (const item of items) if (item.type === "output_text" && typeof item.text === "string") reply({ type: "text", text: item.text });
      } else if (payload.role === "user") {
        /** @type {object[]} */
        const parts = [];
        for (const item of items) {
          if (item.type === "input_text" && typeof item.text === "string" && !CONTEXT_TEXT.test(item.text)) parts.push({ type: "text", text: item.text });
          if (item.type === "input_image") parts.push(convertImage(item));
        }
        if (parts.length > 0) {
          messages.push({ role: "user", content: userContent(parts), timestamp: time });
          open = undefined;
        }
      }
    } else if (payload.type === "reasoning") {
      const summary = Array.isArray(payload.summary) ? payload.summary.filter((part) => isObject(part) && typeof part.text === "string" && part.text) : [];
      if (summary.length > 0) reply({ type: "thinking", thinking: summary.map((part) => part.text).join("\n\n") });
    } else if ((payload.type === "function_call" || payload.type === "custom_tool_call") && typeof payload.call_id === "string" && typeof payload.name === "string") {
      call(payload.call_id, payload.name, convertArguments(payload.type === "function_call" ? payload.arguments : payload.input));
    } else if (payload.type === "local_shell_call" && isObject(payload.action)) {
      const id = typeof payload.call_id === "string" ? payload.call_id : typeof payload.id === "string" ? payload.id : "";
      const command = Array.isArray(payload.action.command) ? payload.action.command.map(String).join(" ") : "";
      if (id) call(id, SHELL_TOOL, { command });
    } else if ((payload.type === "function_call_output" || payload.type === "custom_tool_call_output") && typeof payload.call_id === "string") {
      messages.push({
        role: "toolResult",
        toolCallId: payload.call_id,
        toolName: toolNames.get(payload.call_id) ?? "unknown",
        content: convertOutput(payload.output),
        isError: isObject(payload.output) && payload.output.success === false,
        timestamp: time,
      });
      open = undefined;
    }
  }
  return { cwd, title: undefined, started: messages[0]?.timestamp, messages };
}
