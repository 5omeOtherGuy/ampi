import { findLatestPersistedModeState } from "../ampi-core/state.js";

/**
 * A Pi session as Markdown, in the Amp-compatible thread layout:
 *
 * ````markdown
 * ---
 * title: "Rename the parser module"
 * sessionId: "0199…"
 * created: "2026-10-18T10:00:00.000Z"
 * mode: "medium"
 * ---
 *
 * # Rename the parser module
 *
 * ## User
 *
 * Rename the parser module.
 *
 * ## Assistant
 *
 * Let me look first.
 *
 * **Tool Use:** `bash`
 *
 * ```json
 * {
 *   "command": "ls src"
 * }
 * ```
 *
 * **Tool Result:** `call_1`
 *
 * ```
 * parser.ts
 * ```
 * ````
 *
 * - Front matter values are JSON strings, which YAML reads as quoted
 *   scalars. A value that is unknown is left out.
 * - A `## User` or `## Assistant` heading starts each change of speaker. Tool
 *   results belong to the assistant's part; a shell command run with `!` to
 *   the user's.
 * - Text is copied as it is. Thinking, images, system prompts, extension
 *   messages and summaries are left out; an image is noted as `(image)`.
 * - Fences are longer than any run of backticks inside them.
 *
 * Pure: no files, no clock. The future `ampi` command line uses it on
 * session files too.
 */

export interface MmrThreadMarkdownOptions {
  /** Defaults to the session's name (its latest name entry), else its first prompt on one line, else "Untitled". */
  readonly title?: string;
  /** Defaults to the id in the session header, when the entries include it. */
  readonly sessionId?: string;
  /** ISO 8601; defaults to the session header's timestamp. */
  readonly created?: string;
  /** The ampi mode; defaults to the latest mode the session recorded. */
  readonly mode?: string;
}

const UNTITLED = "Untitled";
/** A title taken from the first prompt is cut to this many characters. */
const TITLE_MAX = 80;

type Speaker = "User" | "Assistant";

interface Entry {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly parentId?: unknown;
  readonly timestamp?: unknown;
  readonly name?: unknown;
  readonly message?: unknown;
}

function asEntry(value: unknown): Entry {
  return value && typeof value === "object" ? (value as Entry) : {};
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * The entries from the root to the last one, following `parentId`: the
 * branch Pi opens a session file on. Entries without ids (or a list that
 * is already one branch) come back as they are.
 */
function branchOf(entries: readonly Entry[]): readonly Entry[] {
  const byId = new Map<unknown, Entry>();
  for (const entry of entries) if (typeof entry.id === "string") byId.set(entry.id, entry);
  const leaf = [...entries].reverse().find((entry) => typeof entry.id === "string");
  if (!leaf) return entries;
  const path: Entry[] = [];
  for (let entry: Entry | undefined = leaf; entry; entry = typeof entry.parentId === "string" ? byId.get(entry.parentId) : undefined) {
    path.push(entry);
    if (path.length > entries.length) break;
  }
  return path.reverse();
}

/** Text blocks joined by blank lines; images become `(image)`. */
function blocksText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
    else if (record.type === "image") parts.push("(image)");
  }
  return parts.join("\n\n");
}

function fenced(text: string, info = ""): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${text}\n${fence}`;
}

function code(text: string): string {
  return text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``;
}

/** The parts one message adds, and whose part they belong to. */
function renderMessage(message: Record<string, unknown>): { speaker: Speaker; parts: string[] } | undefined {
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
      const parts: string[] = [];
      for (const block of Array.isArray(message.content) ? message.content : []) {
        const record = asRecord(block);
        if (record.type === "text" && typeof record.text === "string" && record.text.trim()) parts.push(record.text.trim());
        else if (record.type === "toolCall") {
          parts.push(`**Tool Use:** ${code(String(record.name ?? ""))}`, fenced(JSON.stringify(record.arguments ?? {}, null, 2), "json"));
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

function firstPrompt(entries: readonly Entry[]): string | undefined {
  for (const entry of entries) {
    const message = asRecord(entry.message);
    if (entry.type !== "message" || message.role !== "user") continue;
    const line = blocksText(message.content).replace(/\s+/g, " ").trim();
    if (line) return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
  }
  return undefined;
}

function sessionName(entries: readonly Entry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type === "session_info" && typeof entry.name === "string") return entry.name.trim() || undefined;
  }
  return undefined;
}

/**
 * Render a session as Markdown. `entries` are the session's entries in file
 * order, with or without its header; the branch that ends with the last
 * entry is rendered.
 */
export function formatMmrThreadMarkdown(entries: readonly unknown[], options: MmrThreadMarkdownOptions = {}): string {
  const all = entries.map(asEntry);
  const header = all.find((entry) => entry.type === "session");
  const branch = branchOf(all.filter((entry) => entry.type !== "session"));
  // Pi names a session by its latest name entry on any branch.
  const title = (options.title ?? sessionName(all) ?? firstPrompt(branch) ?? UNTITLED).replace(/\s+/g, " ").trim() || UNTITLED;
  const front: [string, string | undefined][] = [
    ["title", title],
    ["sessionId", options.sessionId ?? (typeof header?.id === "string" ? header.id : undefined)],
    ["created", options.created ?? (typeof header?.timestamp === "string" ? header.timestamp : undefined)],
    ["mode", options.mode ?? findLatestPersistedModeState(branch)?.mode],
  ];

  const out = ["---", ...front.flatMap(([key, value]) => (value === undefined ? [] : [`${key}: ${JSON.stringify(value)}`])), "---", "", `# ${title}`];
  let speaker: Speaker | undefined;
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const rendered = renderMessage(asRecord(entry.message));
    if (!rendered) continue;
    if (rendered.speaker !== speaker) {
      speaker = rendered.speaker;
      out.push("", `## ${speaker}`);
    }
    for (const part of rendered.parts) out.push("", part);
  }
  return `${out.join("\n")}\n`;
}
