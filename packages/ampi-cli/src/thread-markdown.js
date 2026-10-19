// `ampi threads markdown`: a Pi session as Markdown, in the same layout as
// ampi-threads' Markdown export (formatMmrThreadMarkdown). That one is
// TypeScript, which this plain JavaScript cannot import, so this is a copy of
// its rules; tests/mmr-cli-threads.test.mjs renders the same session file and
// compares it with the same hand-written Markdown. Change both together.
//
// - YAML front matter with `title`, `sessionId`, `created` and `mode` as JSON
//   strings; an unknown value is left out. Then `# <title>`.
// - A `## User` or `## Assistant` heading at each change of speaker. Tool
//   calls are `**Tool Use:**` with the input in a `json` block, tool results
//   `**Tool Result:**` with the output in a plain block; both belong to the
//   assistant. A `!` shell command is `**Shell:**` in the user's part.
// - Text is copied as it is; thinking, images (noted as `(image)`), system
//   prompts and extension messages are left out, except a review that
//   `ampi review` recorded (an `ampi-review` extension message), whose report
//   is the assistant's. Fences are longer than any run of backticks inside
//   them.
// - The branch that ends with the last entry is rendered, as Pi opens it.

const UNTITLED = "Untitled";
/** A title taken from the first prompt is cut to this many characters. */
const TITLE_MAX = 80;
/** Custom entries in which ampi-core records the session's mode. */
const MODE_STATE_ENTRIES = new Set(["ampi-core.mode-state", "mmr-core.mode-state"]);
const MODES = new Set(["low", "medium", "high", "ultra", "free"]);
/** @type {Record<string, string>} */
const LEGACY_MODES = { rush: "low", smart: "medium", deep: "high", fable: "ultra" };
/** The extension message `ampi review` records its report in. */
const REVIEW_MESSAGE_TYPE = "ampi-review";

/** @typedef {Record<string, any>} Entry */

/** @param {unknown} value @returns {Entry} */
const asRecord = (value) => (value && typeof value === "object" ? /** @type {Entry} */ (value) : {});

/**
 * The entries from the root to the last one, following `parentId`.
 *
 * @param {Entry[]} entries
 * @returns {Entry[]}
 */
function branchOf(entries) {
  const byId = new Map();
  for (const entry of entries) if (typeof entry.id === "string") byId.set(entry.id, entry);
  const leaf = [...entries].reverse().find((entry) => typeof entry.id === "string");
  if (!leaf) return entries;
  const path = [];
  for (let entry = leaf; entry; entry = typeof entry.parentId === "string" ? byId.get(entry.parentId) : undefined) {
    path.push(entry);
    if (path.length > entries.length) break;
  }
  return path.reverse();
}

/** @param {unknown} content @returns {string} */
function blocksText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content.map(asRecord)) {
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "image") parts.push("(image)");
  }
  return parts.join("\n\n");
}

/** @param {string} text @param {string} [info] */
function fenced(text, info = "") {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${text}\n${fence}`;
}

/** @param {string} text */
const code = (text) => (text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``);

/**
 * @param {Entry} message
 * @returns {{ speaker: "User" | "Assistant", parts: string[] } | undefined}
 */
function renderMessage(message) {
  switch (message.role) {
    case "user": {
      const text = blocksText(message.content).trim();
      return text ? { speaker: "User", parts: [text] } : undefined;
    }
    case "bashExecution": {
      const output = typeof message.output === "string" ? message.output.replace(/\n+$/, "") : "";
      return { speaker: "User", parts: [`**Shell:** ${code(String(message.command ?? ""))}`, fenced(output)] };
    }
    case "assistant": {
      const parts = [];
      for (const block of (Array.isArray(message.content) ? message.content : []).map(asRecord)) {
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) parts.push(block.text.trim());
        else if (block.type === "toolCall") {
          parts.push(`**Tool Use:** ${code(String(block.name ?? ""))}`, fenced(JSON.stringify(block.arguments ?? {}, null, 2), "json"));
        }
      }
      return parts.length > 0 ? { speaker: "Assistant", parts } : undefined;
    }
    case "toolResult": {
      const marker = `**Tool Result:** ${code(String(message.toolCallId ?? ""))}${message.isError === true ? " (error)" : ""}`;
      return { speaker: "Assistant", parts: [marker, fenced(blocksText(message.content).replace(/\n+$/, ""))] };
    }
    default:
      return undefined;
  }
}

/**
 * The parts a message entry, or an `ampi review` report, adds.
 *
 * @param {Entry} entry
 */
function renderEntry(entry) {
  if (entry.type === "message") return renderMessage(asRecord(entry.message));
  if (entry.type === "custom_message" && entry.customType === REVIEW_MESSAGE_TYPE) {
    const text = blocksText(entry.content).trim();
    return text ? { speaker: /** @type {const} */ ("Assistant"), parts: [text] } : undefined;
  }
  return undefined;
}

/** @param {Entry[]} entries */
function firstPrompt(entries) {
  for (const entry of entries) {
    const message = asRecord(entry.message);
    if (entry.type !== "message" || message.role !== "user") continue;
    const line = blocksText(message.content).replace(/\s+/g, " ").trim();
    if (line) return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
  }
  return undefined;
}

/** Pi names a session by its latest name entry on any branch. @param {Entry[]} entries */
function sessionName(entries) {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type === "session_info" && typeof entry.name === "string") return entry.name.trim() || undefined;
  }
  return undefined;
}

/** The latest mode ampi-core recorded on the branch. @param {Entry[]} entries */
function latestMode(entries) {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || !MODE_STATE_ENTRIES.has(entry.customType)) continue;
    const data = asRecord(entry.data);
    if (data.version !== undefined && data.version !== 1) continue;
    if (typeof data.mode !== "string") continue;
    const mode = MODES.has(data.mode) ? data.mode : Object.hasOwn(LEGACY_MODES, data.mode) ? LEGACY_MODES[data.mode] : undefined;
    if (mode) return mode;
  }
  return undefined;
}

/**
 * Render a session as Markdown. `entries` are the session's entries in file
 * order, its header first.
 *
 * @param {readonly unknown[]} entries
 * @returns {string}
 */
export function formatThreadMarkdown(entries) {
  const all = entries.map(asRecord);
  const header = all.find((entry) => entry.type === "session");
  const branch = branchOf(all.filter((entry) => entry.type !== "session"));
  const title = (sessionName(all) ?? firstPrompt(branch) ?? UNTITLED).replace(/\s+/g, " ").trim() || UNTITLED;
  /** @type {[string, unknown][]} */
  const front = [
    ["title", title],
    ["sessionId", header?.id],
    ["created", header?.timestamp],
    ["mode", latestMode(branch)],
  ];
  const out = [
    "---",
    ...front.flatMap(([key, value]) => (typeof value === "string" ? [`${key}: ${JSON.stringify(value)}`] : [])),
    "---",
    "",
    `# ${title}`,
  ];
  /** @type {string | undefined} */
  let speaker;
  for (const entry of branch) {
    const rendered = renderEntry(entry);
    if (!rendered) continue;
    if (rendered.speaker !== speaker) {
      speaker = rendered.speaker;
      out.push("", `## ${speaker}`);
    }
    for (const part of rendered.parts) out.push("", part);
  }
  return `${out.join("\n")}\n`;
}
