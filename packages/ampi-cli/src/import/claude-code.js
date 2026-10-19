// Claude Code's sessions, read for `ampi threads import claude` and converted
// into Pi messages. Claude Code keeps one JSONL file per session in
// <config dir>/projects/<encoded working directory>/<session id>.jsonl. Each
// line is an entry: user and assistant entries carry a `message` with the
// role and content blocks, the working directory and a timestamp; the other
// entry types are bookkeeping, apart from the titles some of them record.
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

/** The agent name in the import records, the custom entry and the output. */
export const CLAUDE_CODE_AGENT = "claude-code";
/** The provider of imported assistant messages: no Pi provider has that name, so Pi never treats them as its own turns. */
export const IMPORT_PROVIDER = "claude-code-import";
export const IMPORT_API = "imported";

/**
 * @typedef {{ id: string, file: string, modified: Date }} SourceSession A session file and when it last changed.
 *
 * @typedef {object} Conversion A session converted into Pi messages.
 * @property {string | undefined} cwd The working directory the session ran in.
 * @property {string | undefined} title The title Claude Code recorded: one set by the user, else a generated one.
 * @property {number | undefined} started The first message's time, in milliseconds.
 * @property {{ role: string }[]} messages Pi user, assistant and tool result messages, in order.
 */

/** Claude Code's session ids are the file names: letters, digits, dots, hyphens and underscores. */
export const CLAUDE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Claude Code's configuration directory: `$CLAUDE_CONFIG_DIR`, else `~/.claude`.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 */
export function claudeCodeDir(env, home) {
  return env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
}

/**
 * Every session file in `<dir>/projects`, one directory deep. A missing
 * directory has none.
 *
 * @param {string} dir Claude Code's configuration directory.
 * @returns {SourceSession[]}
 */
export function listClaudeCodeSessions(dir) {
  const projects = path.join(dir, "projects");
  /** @type {SourceSession[]} */
  const sessions = [];
  /** @type {string[]} */
  let folders;
  try {
    folders = readdirSync(projects);
  } catch {
    return sessions;
  }
  for (const folder of folders) {
    /** @type {string[]} */
    let names;
    try {
      names = readdirSync(path.join(projects, folder));
    } catch {
      continue;
    }
    for (const name of names) {
      const id = name.slice(0, -".jsonl".length);
      if (!name.endsWith(".jsonl") || !CLAUDE_SESSION_ID.test(id)) continue;
      const file = path.join(projects, folder, name);
      const stats = statSync(file, { throwIfNoEntry: false });
      if (stats?.isFile()) sessions.push({ id, file, modified: stats.mtime });
    }
  }
  return sessions;
}

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A Pi image from a Claude Code image block, or "(image)" when the block
 * holds no base64 data (a URL, or nothing).
 *
 * @param {Record<string, any>} block
 */
function convertImage(block) {
  const source = block.source;
  if (isObject(source) && source.type === "base64" && typeof source.data === "string" && typeof source.media_type === "string") {
    return { type: "image", data: source.data, mimeType: source.media_type };
  }
  return { type: "text", text: "(image)" };
}

/**
 * The text and images of a tool result.
 *
 * @param {unknown} content
 */
function convertResultContent(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (!isObject(block)) return [];
    if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
    if (block.type === "image") return [convertImage(block)];
    return [];
  });
}

/**
 * Pi's usage from Claude Code's token counts. Pi's usage always holds a
 * cost; it is left at zero here, which ampi's reports read as unknown,
 * because the provider of imported messages has no price.
 *
 * @param {unknown} usage
 */
function convertUsage(usage) {
  const count = (/** @type {unknown} */ value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const source = isObject(usage) ? usage : {};
  const input = count(source.input_tokens);
  const output = count(source.output_tokens);
  const cacheRead = count(source.cache_read_input_tokens);
  const cacheWrite = count(source.cache_creation_input_tokens);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * Convert a Claude Code session file's text into Pi messages, in file order.
 * Sidechain entries (a subagent's work) and meta entries (text Claude Code
 * added for the model) are skipped, as are every entry type but user and
 * assistant. Lines of one assistant message (they share its id) that follow
 * each other become one Pi message, with the last line's usage. When tool
 * results fall between them, each part stays a message of its own and only
 * the latest part keeps the usage, so the tokens count once. Tool results
 * become tool result messages named after the call they answer.
 *
 * @param {string} text
 * @returns {Conversion}
 */
export function convertClaudeCodeSession(text) {
  /** @type {string | undefined} */
  let cwd;
  /** @type {{ custom?: string, generated?: string, summary?: string }} */
  const titles = {};
  /** @type {any[]} */
  const messages = [];
  /** @type {Map<string, string>} */
  const toolNames = new Map();
  /** The Claude Code id of the assistant message last added, while nothing else followed it. */
  let openAssistant = "";
  /** The Pi message holding each Claude Code assistant message's usage. */
  const usageHolders = new Map();
  let time = 0;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    /** @type {unknown} */
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(entry)) continue;
    if (entry.type === "custom-title" && typeof entry.customTitle === "string") titles.custom = entry.customTitle;
    if (entry.type === "ai-title" && typeof entry.aiTitle === "string") titles.generated = entry.aiTitle;
    if (entry.type === "summary" && typeof entry.summary === "string") titles.summary = entry.summary;
    if ((entry.type !== "user" && entry.type !== "assistant") || entry.isSidechain === true || entry.isMeta === true) continue;
    const message = entry.message;
    if (!isObject(message)) continue;
    if (cwd === undefined && typeof entry.cwd === "string" && entry.cwd) cwd = entry.cwd;
    const parsed = Date.parse(String(entry.timestamp));
    if (Number.isFinite(parsed)) time = parsed;
    /** @type {unknown[]} */
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : [];

    if (entry.type === "assistant") {
      /** @type {object[]} */
      const content = blocks.flatMap((block) => {
        if (!isObject(block)) return [];
        /** @type {object[]} */
        const converted = [];
        if (block.type === "text" && typeof block.text === "string") converted.push({ type: "text", text: block.text });
        if (block.type === "thinking" && typeof block.thinking === "string") converted.push({ type: "thinking", thinking: block.thinking });
        if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          toolNames.set(block.id, block.name);
          converted.push({ type: "toolCall", id: block.id, name: block.name, arguments: isObject(block.input) ? block.input : {} });
        }
        return converted;
      });
      const id = typeof message.id === "string" ? message.id : "";
      const previous = messages.at(-1);
      const merged = id !== "" && id === openAssistant && previous?.role === "assistant";
      const target = merged
        ? previous
        : { role: "assistant", content: [], api: IMPORT_API, provider: IMPORT_PROVIDER, model: typeof message.model === "string" ? message.model : "unknown", timestamp: time };
      target.content.push(...content);
      target.usage = convertUsage(message.usage);
      target.stopReason = target.content.some((/** @type {any} */ block) => block.type === "toolCall")
        ? "toolUse"
        : message.stop_reason === "max_tokens"
          ? "length"
          : "stop";
      if (!merged) messages.push(target);
      if (id !== "") {
        const holder = usageHolders.get(id);
        if (holder !== undefined && holder !== target) holder.usage = convertUsage(undefined);
        usageHolders.set(id, target);
      }
      openAssistant = id;
      continue;
    }

    /** @type {object[]} */
    const parts = [];
    for (const block of blocks) {
      if (!isObject(block)) continue;
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        messages.push({
          role: "toolResult",
          toolCallId: block.tool_use_id,
          toolName: toolNames.get(block.tool_use_id) ?? "unknown",
          content: convertResultContent(block.content),
          isError: block.is_error === true,
          timestamp: time,
        });
      } else if (block.type === "text" && typeof block.text === "string") {
        parts.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        parts.push(convertImage(block));
      }
    }
    if (parts.length > 0) {
      const textOnly = parts.every((/** @type {any} */ part) => part.type === "text");
      const content = textOnly ? parts.map((/** @type {any} */ part) => part.text).join("\n\n") : parts;
      messages.push({ role: "user", content, timestamp: time });
    }
    openAssistant = "";
  }
  // An assistant line can hold only blocks Pi has no form for.
  const kept = messages.filter((message) => message.role !== "assistant" || message.content.length > 0);
  return { cwd, title: (titles.custom ?? titles.generated ?? titles.summary)?.trim() || undefined, started: kept[0]?.timestamp, messages: kept };
}
