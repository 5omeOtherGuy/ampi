import type { SessionEntry, SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import { includesCaseInsensitive, tokenizeSessionQuery } from "./query.js";
import { maybeRedact } from "./redaction.js";

export interface SessionReadExcerpt {
  source: "message" | "entry" | "session";
  role?: string;
  timestamp?: string;
  text: string;
  matchedTerms: string[];
}

export interface SessionReadResult {
  sessionId: string;
  name?: string;
  messageCount: number;
  excerptCount: number;
  truncated: boolean;
  matchedTerms: string[];
  excerpts: SessionReadExcerpt[];
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

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function goalTerms(goal: string, redactionEnabled: boolean): string[] {
  const stop = new Set(["the", "and", "for", "with", "from", "that", "this", "what", "when", "where", "which", "about", "need", "extract", "relevant", "information", "content"]);
  // Goal tokens flow out via `result.matchedTerms` and downstream tool
  // details. When CONTENT redaction is opted in, route them through the
  // same deterministic redaction the packet uses so a sensitive
  // substring in the user-typed goal can never leave the local catalog
  // raw. Idempotent for short, common tokens.
  return [...new Set(
    tokenizeSessionQuery(goal)
      .map((term) => term.toLowerCase())
      .filter((term) => term.length >= 3 && !stop.has(term))
      .map((term) => maybeRedact(term, redactionEnabled)),
  )];
}

function makeExcerpt(source: SessionReadExcerpt["source"], text: string, terms: readonly string[], redactionEnabled: boolean, options: { role?: string; timestamp?: string } = {}): SessionReadExcerpt | undefined {
  // Optionally run the deterministic sanitizer on every excerpt before
  // it leaves the local catalog, then re-compact whitespace so the
  // truncation bound counts real characters. Term matching uses the
  // (possibly redacted) text so a `[redacted]` value never "matches"
  // by accident.
  const sanitized = compactText(maybeRedact(compactText(text), redactionEnabled));
  if (!sanitized) return undefined;
  const matchedTerms = terms.filter((term) => includesCaseInsensitive(sanitized, term));
  return { source, role: options.role, timestamp: options.timestamp, text: sanitized.slice(0, 2_000), matchedTerms };
}

function agentMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  if ("content" in message) return textFromContent(message.content);
  if ("command" in message && typeof message.command === "string") return message.command;
  return "";
}

function agentMessageRole(message: unknown): string | undefined {
  return message && typeof message === "object" && "role" in message && typeof message.role === "string"
    ? message.role
    : undefined;
}

/** Render a tool call's arguments to scannable text (verbatim string or JSON). */
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
 * Flatten a message to a single scannable string for lexical term matching,
 * folding in tool activity that plain text extraction drops: assistant tool
 * calls (`tool: <name> args: …`), tool results (`result (<name>): …`), and
 * bash command/output. Keeps parity with the worker packet so both paths can
 * answer goals that reference SQL queries, fixes, scripts, diffs, or command
 * output living in tool activity.
 */
function messageScanText(message: unknown): string {
  if (!message || typeof message !== "object") return agentMessageText(message);
  const parts: string[] = [];
  const content = (message as { content?: unknown }).content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const record = block as { type?: unknown; name?: unknown; arguments?: unknown };
      if (record.type !== "toolCall") continue;
      const name = typeof record.name === "string" ? record.name : "";
      if (!name) continue;
      const args = renderToolArguments(record.arguments);
      parts.push(args ? `tool: ${name} args: ${args}` : `tool: ${name}`);
    }
  }
  const role = (message as { role?: unknown }).role;
  if (role === "toolResult") {
    const resultText = textFromContent(content);
    const toolName = (message as { toolName?: unknown }).toolName;
    const label = typeof toolName === "string" && toolName ? `result (${toolName})` : "result";
    if (resultText) parts.push(`${label}: ${resultText}`);
  } else if (role === "bashExecution") {
    const command = (message as { command?: unknown }).command;
    if (typeof command === "string" && command) parts.push(`tool: bash args: ${command}`);
    const output = (message as { output?: unknown }).output;
    if (typeof output === "string" && output.trim()) parts.push(`result (bash): ${output}`);
  } else {
    const base = agentMessageText(message);
    if (base) parts.unshift(base);
  }
  return parts.join("\n");
}

function entryText(entry: SessionEntry): string {
  // Keep this allowlist aligned with `ALLOWED_ENTRY_TYPES` in
  // analysis-worker.ts. `custom_message`/`custom`/`extension` carry
  // caller-defined free-form payloads whose redaction contract is
  // not enumerated here.
  if (entry.type === "message") return messageScanText(entry.message);
  if (entry.type === "compaction" || entry.type === "branch_summary") return entry.summary;
  if (entry.type === "session_info") return entry.name ?? "";
  return "";
}

/**
 * Deterministic lexical extraction. `redactionEnabled` is the opt-in
 * CONTENT toggle (default `true` for direct callers/tests; the tools
 * seam passes the resolved product setting, whose default is OFF/raw).
 */
export function readSessionForGoal(info: SessionInfo, manager: SessionManager, goal: string, maxBytes: number, redactionEnabled = true): SessionReadResult {
  const terms = goalTerms(goal, redactionEnabled);
  const excerpts: SessionReadExcerpt[] = [];

  const sessionExcerpt = makeExcerpt("session", [info.name ?? "", info.firstMessage].join("\n"), terms, redactionEnabled);
  if (sessionExcerpt) excerpts.push(sessionExcerpt);

  for (const message of manager.buildSessionContext().messages) {
    const text = messageScanText(message);
    const role = agentMessageRole(message);
    const excerpt = makeExcerpt("message", text, terms, redactionEnabled, { role });
    if (excerpt) excerpts.push(excerpt);
  }

  for (const entry of manager.getEntries()) {
    const excerpt = makeExcerpt("entry", entryText(entry), terms, redactionEnabled, { timestamp: entry.timestamp });
    if (excerpt) excerpts.push(excerpt);
  }

  const relevant = excerpts.some((excerpt) => excerpt.matchedTerms.length > 0)
    ? excerpts.filter((excerpt) => excerpt.matchedTerms.length > 0)
    : excerpts.slice(0, 8);

  const selected: SessionReadExcerpt[] = [];
  let bytes = 0;
  let truncated = false;
  for (const excerpt of relevant) {
    const nextBytes = Buffer.byteLength(excerpt.text, "utf8");
    if (selected.length > 0 && bytes + nextBytes > maxBytes) {
      truncated = true;
      break;
    }
    selected.push(excerpt);
    bytes += nextBytes;
  }

  return {
    sessionId: info.id,
    name: info.name ? maybeRedact(info.name, redactionEnabled) : undefined,
    messageCount: info.messageCount,
    excerptCount: selected.length,
    truncated,
    matchedTerms: [...new Set(selected.flatMap((excerpt) => excerpt.matchedTerms))],
    excerpts: selected,
  };
}

/**
 * `redactionEnabled` mirrors the opt-in CONTENT toggle so the echoed
 * `Goal:` line cannot leak a raw sensitive substring when redaction is on.
 * Defaults to `true` for direct callers/tests; the tools seam passes the
 * resolved product setting (default OFF/raw).
 */
export function formatSessionReadResult(result: SessionReadResult, goal: string, redactionEnabled = true): string {
  const lines = [`# Session ${result.sessionId}`, ""];
  if (result.name) lines.push(`Name: ${result.name}`);
  lines.push(`Goal: ${maybeRedact(goal, redactionEnabled)}`);
  lines.push(`Messages: ${result.messageCount}`);
  lines.push(`Excerpts: ${result.excerptCount}${result.truncated ? " (truncated)" : ""}`);
  if (result.matchedTerms.length > 0) lines.push(`Matched terms: ${result.matchedTerms.join(", ")}`);
  lines.push("");
  result.excerpts.forEach((excerpt, index) => {
    const label = [excerpt.source, excerpt.role, excerpt.timestamp].filter(Boolean).join(" · ");
    lines.push(`## Excerpt ${index + 1}${label ? ` (${label})` : ""}`);
    lines.push(excerpt.text);
    lines.push("");
  });
  if (result.excerpts.length === 0) lines.push("No readable session content matched the requested goal.");
  return lines.join("\n").trimEnd();
}
