import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { GithubCommitSummary, GithubRepoSummary } from "./client.js";
import { COMMIT_MESSAGE_MAX_CHARS, READ_OUTPUT_BYTE_LIMIT } from "./tool-schemas.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function clamp(value: unknown, def: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return def;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function errorResult(message: string): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text: message }], details: { error: message } };
}

export function numberLines(text: string, startLine = 1): string {
  const lines = text.split("\n");
  return lines.map((line, i) => `${startLine + i}: ${line}`).join("\n");
}

export function pluralizeEntries(n: number): string {
  return n === 1 ? "entry" : "entries";
}

/** Render sorted directory entry lines (directories first, trailing slash). */
export function renderDirEntryLines(entries: readonly { name: string; type: string }[]): string[] {
  return sortDirEntries(entries).map((entry) => (entry.type === "dir" ? `${entry.name}/` : entry.name));
}

/**
 * Slice a directory listing to `read_range` (1-based, inclusive) with omitted
 * markers above and below the window, mirroring repository directory paging.
 */
export function sliceListingWithMarkers(lines: readonly string[], range: readonly number[] | undefined): string {
  const total = lines.length;
  const start = range && range.length === 2 ? Math.max(0, Math.floor(range[0]!) - 1) : 0;
  const end = range && range.length === 2 ? Math.min(total, Math.floor(range[1]!)) : total;
  const out: string[] = [];
  if (start > 0) out.push(`[... omitted ${start} ${pluralizeEntries(start)} ...]`);
  out.push(...lines.slice(start, end));
  if (end < total) out.push(`[... omitted ${total - end} more ...]`);
  return out.join("\n");
}

/**
 * Slice a file's text to `read_range` (1-based, inclusive) without numbering.
 * Returns the sliced text plus the 1-based start line so the caller can
 * enforce the output size gate before numbering.
 */
export function sliceReadRange(text: string, range: readonly number[] | undefined): { text: string; start: number } {
  if (!range || range.length !== 2) return { text, start: 1 };
  const lines = text.split("\n");
  const start = Math.max(1, Math.floor(range[0]!));
  const end = Math.min(lines.length, Math.max(start, Math.floor(range[1]!)));
  return { text: lines.slice(start - 1, end).join("\n"), start };
}

export function formatCommits(repository: string, commits: readonly GithubCommitSummary[]): string {
  if (commits.length === 0) return `No commits found in ${repository} for the given filters.`;
  const lines = [`# Commits in ${repository}`, ""];
  for (const c of commits) {
    let firstLine = c.message.split("\n")[0] ?? "";
    if (firstLine.length > COMMIT_MESSAGE_MAX_CHARS) {
      firstLine = `${firstLine.slice(0, COMMIT_MESSAGE_MAX_CHARS)}... (truncated)`;
    }
    lines.push(`## ${c.sha.slice(0, 12)} — ${firstLine}`);
    const meta = [c.author, c.date].filter((part) => part.length > 0).join(" · ");
    if (meta) lines.push(meta);
    if (c.htmlUrl) lines.push(c.htmlUrl);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function formatRepos(heading: string, repos: readonly GithubRepoSummary[]): string {
  if (repos.length === 0) return `No repositories found for ${heading}.`;
  const lines = [`# Repositories: ${heading}`, ""];
  for (const r of repos) {
    const flags = [
      r.isPrivate ? "private" : "public",
      r.isFork ? "fork" : undefined,
      r.isArchived ? "archived" : undefined,
    ].filter(Boolean).join(", ");
    lines.push(`## ${r.fullName}${r.language ? ` (${r.language})` : ""}`);
    const meta = [`★ ${r.stars}`, `⑂ ${r.forks}`, flags].filter(Boolean).join(" · ");
    if (meta) lines.push(meta);
    if (r.description) lines.push(r.description);
    if (r.htmlUrl) lines.push(r.htmlUrl);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function sortDirEntries<T extends { name: string; type: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => {
    const aDir = a.type === "dir" ? 0 : 1;
    const bDir = b.type === "dir" ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Render a directory listing (directories first, trailing slash) and gate it
 * at READ_OUTPUT_BYTE_LIMIT. When `limit` is provided the entries are sliced
 * first; if the rendered listing still exceeds the byte cap, return a clear
 * error pointing at a smaller `limit`.
 */
export function directoryListingResult(
  repository: string,
  dirPath: string,
  entries: readonly { name: string; type: string }[],
  limit: number | undefined,
): AgentToolResult<Record<string, unknown>> {
  const sorted = sortDirEntries(entries);
  const sliced = limit !== undefined ? sorted.slice(0, limit) : sorted;
  const suffix = sliced.length < sorted.length ? ` (showing ${sliced.length} of ${sorted.length} entries)` : ` (${sorted.length} entries)`;
  const heading = `# ${repository}${dirPath ? `/${dirPath}` : ""}${suffix}`;
  const body = sliced.length === 0
    ? "(empty directory)"
    : sliced.map((entry) => (entry.type === "dir" ? `${entry.name}/` : entry.name)).join("\n");
  const text = `${heading}\n\n${body}`;
  if (Buffer.byteLength(text, "utf8") > READ_OUTPUT_BYTE_LIMIT) {
    return errorResult(
      `${repository}${dirPath ? `/${dirPath}` : ""}: directory listing is too large (${sorted.length} entries). Pass a smaller limit to list_directory_github.`,
    );
  }
  return { content: [{ type: "text", text }], details: { path: dirPath, count: sorted.length, returned: sliced.length } };
}
