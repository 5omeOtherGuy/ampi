import type { SessionEntry, SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import { includesCaseInsensitive, tokenizeSessionQuery } from "./query.js";
import { redactText } from "./redaction.js";

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

function goalTerms(goal: string): string[] {
  const stop = new Set(["the", "and", "for", "with", "from", "that", "this", "what", "when", "where", "which", "about", "need", "extract", "relevant", "information", "content"]);
  // Goal tokens flow out via `result.matchedTerms` and downstream tool
  // details. Route them through the same deterministic redaction the
  // packet uses so a sensitive substring in the user-typed goal can
  // never leave the local catalog raw. Idempotent for short, common
  // tokens.
  return [...new Set(
    tokenizeSessionQuery(goal)
      .map((term) => term.toLowerCase())
      .filter((term) => term.length >= 3 && !stop.has(term))
      .map((term) => redactText(term)),
  )];
}

function makeExcerpt(source: SessionReadExcerpt["source"], text: string, terms: readonly string[], options: { role?: string; timestamp?: string } = {}): SessionReadExcerpt | undefined {
  // Run the deterministic sanitizer on every excerpt before it leaves
  // the local catalog, then re-compact whitespace so the truncation
  // bound counts real characters. Term matching uses the redacted
  // text so a `[redacted]` value never "matches" by accident.
  const sanitized = compactText(redactText(compactText(text)));
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

function entryText(entry: SessionEntry): string {
  // Keep this allowlist aligned with `ALLOWED_ENTRY_TYPES` in
  // analysis-worker.ts. `custom_message`/`custom`/`extension` carry
  // caller-defined free-form payloads whose redaction contract is
  // not enumerated here.
  if (entry.type === "message") return agentMessageText(entry.message);
  if (entry.type === "compaction" || entry.type === "branch_summary") return entry.summary;
  if (entry.type === "session_info") return entry.name ?? "";
  return "";
}

export function readSessionForGoal(info: SessionInfo, manager: SessionManager, goal: string, maxBytes: number): SessionReadResult {
  const terms = goalTerms(goal);
  const excerpts: SessionReadExcerpt[] = [];

  const sessionExcerpt = makeExcerpt("session", [info.name ?? "", info.firstMessage].join("\n"), terms);
  if (sessionExcerpt) excerpts.push(sessionExcerpt);

  for (const message of manager.buildSessionContext().messages) {
    const text = agentMessageText(message);
    const role = agentMessageRole(message);
    const excerpt = makeExcerpt("message", text, terms, { role });
    if (excerpt) excerpts.push(excerpt);
  }

  for (const entry of manager.getEntries()) {
    const excerpt = makeExcerpt("entry", entryText(entry), terms, { timestamp: entry.timestamp });
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
    name: info.name ? redactText(info.name) : undefined,
    messageCount: info.messageCount,
    excerptCount: selected.length,
    truncated,
    matchedTerms: [...new Set(selected.flatMap((excerpt) => excerpt.matchedTerms))],
    excerpts: selected,
  };
}

export function formatSessionReadResult(result: SessionReadResult, goal: string): string {
  const lines = [`# Session ${result.sessionId}`, ""];
  if (result.name) lines.push(`Name: ${result.name}`);
  lines.push(`Goal: ${goal}`);
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
