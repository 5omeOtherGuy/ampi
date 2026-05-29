import type {
  AgentToolResult,
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { registerMmrOwnedTool } from "../mmr-core/owned-tools.js";
import { checkMmrToolParams } from "../mmr-core/tool-params.js";
import {
  createGithubClient,
  GithubApiError,
  GithubRepoParseError,
  parseGithubRepository,
  type GithubClient,
  type GithubCommitSummary,
  type GithubRepoSummary,
} from "./client.js";
import type { MmrGithubSettings } from "./config.js";
import { matchGlob } from "./glob.js";
import { registerMmrGithubToolSourcePath } from "./tool-ownership.js";

export const DEFAULT_SEARCH_LIMIT = 30;
export const MAX_SEARCH_LIMIT = 100;
export const DEFAULT_LIST_LIMIT = 30;
export const MAX_LIST_LIMIT = 100;
export const DEFAULT_COMMIT_LIMIT = 50;
export const MAX_COMMIT_LIMIT = 100;

/** Per-fragment context cap for search_github results (characters). */
export const SEARCH_FRAGMENT_MAX_CHARS = 2048;
/** Per-commit message cap for commit_search output (characters). */
export const COMMIT_MESSAGE_MAX_CHARS = 1024;
/** Per-file patch cap for diff_github output (characters). */
export const DIFF_PATCH_MAX_CHARS = 4096;
export const DEFAULT_GLOB_LIMIT = 100;
export const MAX_GLOB_LIMIT = 300;
export const DEFAULT_DIRECTORY_LIMIT = 100;
export const MAX_DIRECTORY_LIMIT = 1000;

/**
 * Maximum rendered size (UTF-8 bytes) of a single file read or directory
 * listing returned to the model. Mirrors GitHub-tooling convention: a file is
 * fetched in full, `read_range` is applied first, and only the resulting slice
 * is gated here so `read_range` is a working escape hatch for large files.
 */
export const READ_OUTPUT_BYTE_LIMIT = 131072;

export interface MmrGithubToolDeps {
  getSettings: () => MmrGithubSettings;
  /** Client factory seam for deterministic tests. */
  createClient?: (settings: MmrGithubSettings) => GithubClient;
}

export type GithubToolDetails = Record<string, unknown>;
type GithubToolResult = AgentToolResult<GithubToolDetails>;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const REPOSITORY_DESCRIPTION =
  'Single GitHub repository to operate on. Use "owner/repo" or "https://github.com/owner/repo". Do not pass GitHub search pages, organization pages, or profile pages.';

export const READ_GITHUB_PARAMETERS_SCHEMA = Type.Object(
  {
    repository: Type.String({ description: REPOSITORY_DESCRIPTION }),
    path: Type.String({
      description:
        "Path within the repository to read. If it resolves to a directory, a directory listing is returned instead of file contents.",
    }),
    read_range: Type.Optional(
      Type.Array(Type.Number(), {
        minItems: 2,
        maxItems: 2,
        description: "Optional [start_line, end_line] (1-based, inclusive) to limit a large file read.",
      }),
    ),
    revision: Type.Optional(
      Type.String({ description: "Optional branch, tag, or commit SHA. Defaults to the repository's default branch." }),
    ),
  },
  { additionalProperties: false },
);

export const LIST_DIRECTORY_GITHUB_PARAMETERS_SCHEMA = Type.Object(
  {
    repository: Type.String({ description: REPOSITORY_DESCRIPTION }),
    path: Type.Optional(
      Type.String({ description: "Directory path within the repository. Defaults to the repository root." }),
    ),
    revision: Type.Optional(
      Type.String({ description: "Optional branch, tag, or commit SHA. Defaults to the repository's default branch." }),
    ),
    limit: Type.Optional(
      Type.Number({ description: `Maximum number of directory entries to return (default ${DEFAULT_DIRECTORY_LIMIT}, max ${MAX_DIRECTORY_LIMIT}).` }),
    ),
  },
  { additionalProperties: false },
);

export const GLOB_GITHUB_PARAMETERS_SCHEMA = Type.Object(
  {
    repository: Type.String({ description: REPOSITORY_DESCRIPTION }),
    filePattern: Type.String({
      description:
        "Glob pattern matched against repository file paths. Supported syntax: `*` (any chars except `/`), `**` (any path segments), `?` (one char except `/`), `{a,b}` alternation, and `[...]` character classes. Examples: `**/*.ts`, `src/**/*.{js,ts}`.",
    }),
    revision: Type.Optional(
      Type.String({ description: "Optional branch, tag, or commit SHA. Defaults to the repository's default branch." }),
    ),
    limit: Type.Optional(
      Type.Number({ description: `Maximum number of matching paths to return (default ${DEFAULT_GLOB_LIMIT}, max ${MAX_GLOB_LIMIT}).` }),
    ),
    offset: Type.Optional(
      Type.Number({ description: "Number of matches to skip for pagination (default 0)." }),
    ),
  },
  { additionalProperties: false },
);

export const SEARCH_GITHUB_PARAMETERS_SCHEMA = Type.Object(
  {
    repository: Type.String({ description: REPOSITORY_DESCRIPTION }),
    pattern: Type.String({
      description:
        "GitHub code search query to run inside the selected repository. Supports operators (AND, OR, NOT) and qualifiers (language:, path:, extension:, in:). At most 256 characters and 5 boolean operators; must include at least one search term.",
    }),
    path: Type.Optional(
      Type.String({ description: "Optional path within the repository to limit the search." }),
    ),
    limit: Type.Optional(
      Type.Number({ description: `Maximum results to return (default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}).` }),
    ),
    offset: Type.Optional(
      Type.Number({ description: "Number of results to skip for pagination (default 0). Must be a multiple of limit." }),
    ),
  },
  { additionalProperties: false },
);

export const COMMIT_SEARCH_PARAMETERS_SCHEMA = Type.Object(
  {
    repository: Type.String({ description: REPOSITORY_DESCRIPTION }),
    query: Type.Optional(
      Type.String({ description: "Optional commit-message text to search for. When omitted, the most recent commits matching the filters are returned." }),
    ),
    path: Type.Optional(
      Type.String({ description: "Optional file or directory path to restrict commits to (only applies when `query` is omitted)." }),
    ),
    author: Type.Optional(
      Type.String({ description: "Optional author filter (GitHub username or email)." }),
    ),
    since: Type.Optional(
      Type.String({ description: "Optional ISO-8601 lower bound on commit date, e.g. 2024-01-01." }),
    ),
    until: Type.Optional(
      Type.String({ description: "Optional ISO-8601 upper bound on commit date." }),
    ),
    limit: Type.Optional(
      Type.Number({ description: `Maximum commits to return (default ${DEFAULT_COMMIT_LIMIT}, max ${MAX_COMMIT_LIMIT}).` }),
    ),
  },
  { additionalProperties: false },
);

export const DIFF_GITHUB_PARAMETERS_SCHEMA = Type.Object(
  {
    repository: Type.String({ description: REPOSITORY_DESCRIPTION }),
    base: Type.String({ description: "Base ref (branch, tag, or commit SHA) of the comparison." }),
    head: Type.String({ description: "Head ref (branch, tag, or commit SHA) of the comparison." }),
    path: Type.Optional(
      Type.String({ description: "Optional single file path to limit the diff to one file." }),
    ),
    includePatches: Type.Optional(
      Type.Boolean({
        description:
          "Include unified diff hunks per file (token-heavy; each patch is truncated). Default false, which returns file-level change stats only.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const LIST_REPOSITORIES_PARAMETERS_SCHEMA = Type.Object(
  {
    pattern: Type.Optional(
      Type.String({ description: "Optional substring to match in repository names." }),
    ),
    organization: Type.Optional(
      Type.String({ description: "Optional organization (or user) login to filter repositories by." }),
    ),
    language: Type.Optional(
      Type.String({ description: "Optional primary language to filter repositories by (e.g. TypeScript)." }),
    ),
    limit: Type.Optional(
      Type.Number({ description: `Maximum repositories to return (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}).` }),
    ),
    offset: Type.Optional(
      Type.Number({ description: "Number of results to skip for pagination (default 0). Must be a multiple of limit." }),
    ),
  },
  { additionalProperties: false },
);

export type ReadGithubParams = Static<typeof READ_GITHUB_PARAMETERS_SCHEMA>;
export type ListDirectoryGithubParams = Static<typeof LIST_DIRECTORY_GITHUB_PARAMETERS_SCHEMA>;
export type GlobGithubParams = Static<typeof GLOB_GITHUB_PARAMETERS_SCHEMA>;
export type SearchGithubParams = Static<typeof SEARCH_GITHUB_PARAMETERS_SCHEMA>;
export type CommitSearchParams = Static<typeof COMMIT_SEARCH_PARAMETERS_SCHEMA>;
export type DiffGithubParams = Static<typeof DIFF_GITHUB_PARAMETERS_SCHEMA>;
export type ListRepositoriesParams = Static<typeof LIST_REPOSITORIES_PARAMETERS_SCHEMA>;

// ---------------------------------------------------------------------------
// Descriptions / prompt metadata
// ---------------------------------------------------------------------------

export const READ_GITHUB_DESCRIPTION =
  "Read a file from a GitHub repository. If the path resolves to a directory, returns a directory listing instead. Returned file contents include line numbers; use read_range to limit large files. Pass a single repository as owner/repo or https://github.com/owner/repo.";
export const LIST_DIRECTORY_GITHUB_DESCRIPTION =
  "List the contents of a directory in a GitHub repository. Subdirectories are marked with a trailing slash. Defaults to the repository root when no path is given.";
export const GLOB_GITHUB_DESCRIPTION =
  "Find files in a GitHub repository whose paths match a glob pattern (`*`, `**`, `?`, `{a,b}`, `[...]`). Useful for locating files by name or extension across the repository tree.";
export const SEARCH_GITHUB_DESCRIPTION =
  "Search code inside a single GitHub repository and return matches grouped by file with surrounding context. Use this for repository-wide code search rather than raw line matching. The code search API requires a configured GitHub token.";
export const COMMIT_SEARCH_DESCRIPTION =
  "Search a GitHub repository's commit history. Provide a query to search commit messages, or omit it to list recent commits filtered by path, author, or date. Use this to understand how code evolved.";
export const DIFF_GITHUB_DESCRIPTION =
  "Compare two refs (branches, tags, or commit SHAs) in a GitHub repository and return file-level change stats. Set includePatches to also return unified diff hunks (token-heavy; patches are truncated). Optionally limit the diff to a single file.";
export const LIST_REPOSITORIES_DESCRIPTION =
  "List GitHub repositories, prioritizing repositories the configured token can already access and supplementing with public repository search when needed. Filter by name pattern, organization, and language. Use this to discover repositories before reading, searching, or comparing them.";

const READ_ONLY_GUIDELINE =
  "These tools are read-only GitHub repository tools; they never modify repositories, branches, issues, or pull requests.";

export const MMR_GITHUB_PROMPT_GUIDELINES = [
  READ_ONLY_GUIDELINE,
  "Pass exactly one repository as `owner/repo` or `https://github.com/owner/repo`; do not pass search, organization, or profile pages.",
  "Set MMR_GITHUB_TOKEN for private repositories, higher rate limits, and code search (search_github requires a token).",
  "Do not put secrets, tokens, or credentials in any tool argument.",
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(value: unknown, def: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return def;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function resolveClient(deps: MmrGithubToolDeps): GithubClient {
  const settings = deps.getSettings();
  if (deps.createClient) return deps.createClient(settings);
  return createGithubClient({
    ...(settings.token !== undefined ? { token: settings.token } : {}),
    apiBaseUrl: settings.apiBaseUrl,
    requestTimeoutMs: settings.requestTimeoutMs,
    maxResultBytes: settings.maxResultBytes,
  });
}

function coerce<T>(toolName: string, schema: Parameters<typeof checkMmrToolParams>[1], raw: unknown): T {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${toolName} expects an object of parameters.`);
  }
  return checkMmrToolParams(toolName, schema, raw) as T;
}

function errorResult(message: string): GithubToolResult {
  return { content: [{ type: "text", text: message }], details: { error: message } };
}

function toToolError(toolName: string, err: unknown): GithubToolResult {
  if (err instanceof GithubRepoParseError) return errorResult(`${toolName}: ${err.message}`);
  if (err instanceof GithubApiError) return errorResult(`${toolName}: ${err.message}`);
  const message = err instanceof Error ? err.message : String(err);
  return errorResult(`${toolName}: ${message}`);
}

function numberLines(text: string, startLine = 1): string {
  const lines = text.split("\n");
  return lines.map((line, i) => `${startLine + i}: ${line}`).join("\n");
}

function pluralizeEntries(n: number): string {
  return n === 1 ? "entry" : "entries";
}

/** Render sorted directory entry lines (directories first, trailing slash). */
function renderDirEntryLines(entries: readonly { name: string; type: string }[]): string[] {
  return sortDirEntries(entries).map((entry) => (entry.type === "dir" ? `${entry.name}/` : entry.name));
}

/**
 * Slice a directory listing to `read_range` (1-based, inclusive) with omitted
 * markers above and below the window, mirroring repository directory paging.
 */
function sliceListingWithMarkers(lines: readonly string[], range: readonly number[] | undefined): string {
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
function sliceReadRange(text: string, range: readonly number[] | undefined): { text: string; start: number } {
  if (!range || range.length !== 2) return { text, start: 1 };
  const lines = text.split("\n");
  const start = Math.max(1, Math.floor(range[0]!));
  const end = Math.min(lines.length, Math.max(start, Math.floor(range[1]!)));
  return { text: lines.slice(start - 1, end).join("\n"), start };
}

function formatCommits(repository: string, commits: readonly GithubCommitSummary[]): string {
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

function formatRepos(heading: string, repos: readonly GithubRepoSummary[]): string {
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

// ---------------------------------------------------------------------------
// Tool factories
// ---------------------------------------------------------------------------

export function createReadGithubTool(deps: MmrGithubToolDeps): ToolDefinition {
  return {
    name: "read_github",
    label: "read_github",
    description: READ_GITHUB_DESCRIPTION,
    promptSnippet: "Read a file or directory listing from a GitHub repository.",
    promptGuidelines: [...MMR_GITHUB_PROMPT_GUIDELINES],
    parameters: READ_GITHUB_PARAMETERS_SCHEMA,
    async execute(_id, raw, signal): Promise<GithubToolResult> {
      try {
        const params = coerce<ReadGithubParams>("read_github", READ_GITHUB_PARAMETERS_SCHEMA, raw);
        const ref = parseGithubRepository(params.repository);
        const client = resolveClient(deps);
        const result = await client.getContents(ref, params.path ?? "", params.revision, signal);
        if (result.kind === "directory") {
          const lines = renderDirEntryLines(result.entries);
          const listing = sliceListingWithMarkers(lines, params.read_range);
          if (Buffer.byteLength(listing, "utf8") > READ_OUTPUT_BYTE_LIMIT) {
            return errorResult(
              `read_github: directory listing is too large (${lines.length} ${pluralizeEntries(lines.length)}). Use read_range to inspect a smaller slice, or list_directory_github with a limit.`,
            );
          }
          const heading = `# ${ref.owner}/${ref.repo}${result.path ? `/${result.path}` : ""} (${lines.length} ${pluralizeEntries(lines.length)})`;
          return {
            content: [{ type: "text", text: `${heading}\n\n${lines.length === 0 ? "(empty directory)" : listing}` }],
            details: { kind: "directory", path: result.path, count: lines.length },
          };
        }
        if (result.truncated) {
          return errorResult(
            `read_github: "${result.path}" is too large for the contents API to return inline (over 1 MB). GitHub does not serve files this large through this tool.`,
          );
        }
        const totalLines = result.text.split("\n").length;
        const sliced = sliceReadRange(result.text, params.read_range);
        const slicedBytes = Buffer.byteLength(sliced.text, "utf8");
        if (slicedBytes > READ_OUTPUT_BYTE_LIMIT) {
          return errorResult(
            `read_github: file is too large (${Math.round(slicedBytes / 1024)} KB, ${totalLines} lines). Retry with a smaller read_range to read a specific line range.`,
          );
        }
        const header = `# ${ref.owner}/${ref.repo}:${result.path}${result.size ? ` (${result.size} bytes)` : ""}`;
        return {
          content: [{ type: "text", text: `${header}\n\n${numberLines(sliced.text, sliced.start)}` }],
          details: { kind: "file", path: result.path, size: result.size },
        };
      } catch (err) {
        return toToolError("read_github", err);
      }
    },
  } satisfies ToolDefinition;
}

function sortDirEntries<T extends { name: string; type: string }>(entries: readonly T[]): T[] {
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
function directoryListingResult(
  repository: string,
  dirPath: string,
  entries: readonly { name: string; type: string }[],
  limit: number | undefined,
): GithubToolResult {
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

export function createListDirectoryGithubTool(deps: MmrGithubToolDeps): ToolDefinition {
  return {
    name: "list_directory_github",
    label: "list_directory_github",
    description: LIST_DIRECTORY_GITHUB_DESCRIPTION,
    promptSnippet: "List a directory's contents in a GitHub repository.",
    promptGuidelines: [...MMR_GITHUB_PROMPT_GUIDELINES],
    parameters: LIST_DIRECTORY_GITHUB_PARAMETERS_SCHEMA,
    async execute(_id, raw, signal): Promise<GithubToolResult> {
      try {
        const params = coerce<ListDirectoryGithubParams>(
          "list_directory_github",
          LIST_DIRECTORY_GITHUB_PARAMETERS_SCHEMA,
          raw,
        );
        const ref = parseGithubRepository(params.repository);
        const client = resolveClient(deps);
        const limit = clamp(params.limit, DEFAULT_DIRECTORY_LIMIT, 1, MAX_DIRECTORY_LIMIT);
        const result = await client.getContents(ref, params.path ?? "", params.revision, signal);
        if (result.kind === "file") {
          return errorResult(
            `list_directory_github: "${result.path}" is a file, not a directory. Use read_github to read it.`,
          );
        }
        return directoryListingResult(`${ref.owner}/${ref.repo}`, result.path, result.entries, limit);
      } catch (err) {
        return toToolError("list_directory_github", err);
      }
    },
  } satisfies ToolDefinition;
}

export function createGlobGithubTool(deps: MmrGithubToolDeps): ToolDefinition {
  return {
    name: "glob_github",
    label: "glob_github",
    description: GLOB_GITHUB_DESCRIPTION,
    promptSnippet: "Find repository files by glob pattern.",
    promptGuidelines: [...MMR_GITHUB_PROMPT_GUIDELINES],
    parameters: GLOB_GITHUB_PARAMETERS_SCHEMA,
    async execute(_id, raw, signal): Promise<GithubToolResult> {
      try {
        const params = coerce<GlobGithubParams>("glob_github", GLOB_GITHUB_PARAMETERS_SCHEMA, raw);
        const ref = parseGithubRepository(params.repository);
        const limit = clamp(params.limit, DEFAULT_GLOB_LIMIT, 1, MAX_GLOB_LIMIT);
        const offset = clamp(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);
        const client = resolveClient(deps);
        const tree = await client.getTree(ref, params.revision, signal);
        if (tree.truncated) {
          return errorResult(
            "glob_github: the repository tree is too large for a recursive listing. Use a more specific pattern/path or search_github instead.",
          );
        }
        const all = tree.entries
          .filter((entry) => entry.type === "blob")
          .map((entry) => entry.path)
          .filter((p) => matchGlob(params.filePattern, p));
        const page = all.slice(offset, offset + limit);
        const heading = `# Glob \`${params.filePattern}\` in ${ref.owner}/${ref.repo}@${tree.ref} (${all.length} matches)`;
        const body = page.length > 0 ? page.join("\n") : "(no files matched)";
        return {
          content: [{ type: "text", text: `${heading}\n\n${body}` }],
          details: { matches: all.length, returned: page.length, offset },
        };
      } catch (err) {
        return toToolError("glob_github", err);
      }
    },
  } satisfies ToolDefinition;
}

export function createSearchGithubTool(deps: MmrGithubToolDeps): ToolDefinition {
  return {
    name: "search_github",
    label: "search_github",
    description: SEARCH_GITHUB_DESCRIPTION,
    promptSnippet: "Search code inside a single GitHub repository.",
    promptGuidelines: [...MMR_GITHUB_PROMPT_GUIDELINES],
    parameters: SEARCH_GITHUB_PARAMETERS_SCHEMA,
    async execute(_id, raw, signal): Promise<GithubToolResult> {
      try {
        const params = coerce<SearchGithubParams>("search_github", SEARCH_GITHUB_PARAMETERS_SCHEMA, raw);
        const ref = parseGithubRepository(params.repository);
        const pattern = params.pattern.trim();
        if (pattern.length === 0) return errorResult("search_github: pattern must include at least one search term.");
        const limit = clamp(params.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
        const offset = clamp(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);
        if (offset % limit !== 0) {
          return errorResult(`search_github: offset (${offset}) must be a multiple of limit (${limit}).`);
        }
        const qualifiers = [`repo:${ref.owner}/${ref.repo}`];
        if (params.path) qualifiers.push(`path:${params.path}`);
        const q = `${pattern} ${qualifiers.join(" ")}`.trim();
        const client = resolveClient(deps);
        const result = await client.searchCode(q, { perPage: limit, page: offset / limit + 1 }, signal);
        const heading = `# Code search in ${ref.owner}/${ref.repo}: \`${pattern}\` (${result.totalCount} total)`;
        if (result.items.length === 0) {
          return { content: [{ type: "text", text: `${heading}\n\n(no matches)` }], details: { total: result.totalCount } };
        }
        const blocks = result.items.map((item) => {
          const frags = item.fragments.length > 0
            ? item.fragments
                .map((f) => {
                  const trimmed = f.trimEnd();
                  const capped = trimmed.length > SEARCH_FRAGMENT_MAX_CHARS
                    ? `${trimmed.slice(0, SEARCH_FRAGMENT_MAX_CHARS)}... (truncated)`
                    : trimmed;
                  return "```text\n" + capped + "\n```";
                })
                .join("\n")
            : "(no context fragment)";
          return `## ${item.path}\n${item.htmlUrl}\n\n${frags}`;
        });
        const incomplete = result.incompleteResults ? "\n\n[GitHub reported incomplete results; try a narrower query]" : "";
        return {
          content: [{ type: "text", text: `${heading}\n\n${blocks.join("\n\n")}${incomplete}` }],
          details: { total: result.totalCount, returned: result.items.length, offset },
        };
      } catch (err) {
        return toToolError("search_github", err);
      }
    },
  } satisfies ToolDefinition;
}

export function createCommitSearchTool(deps: MmrGithubToolDeps): ToolDefinition {
  return {
    name: "commit_search",
    label: "commit_search",
    description: COMMIT_SEARCH_DESCRIPTION,
    promptSnippet: "Search or list a GitHub repository's commit history.",
    promptGuidelines: [...MMR_GITHUB_PROMPT_GUIDELINES],
    parameters: COMMIT_SEARCH_PARAMETERS_SCHEMA,
    async execute(_id, raw, signal): Promise<GithubToolResult> {
      try {
        const params = coerce<CommitSearchParams>("commit_search", COMMIT_SEARCH_PARAMETERS_SCHEMA, raw);
        const ref = parseGithubRepository(params.repository);
        const limit = clamp(params.limit, DEFAULT_COMMIT_LIMIT, 1, MAX_COMMIT_LIMIT);
        const client = resolveClient(deps);
        const query = params.query?.trim();
        const hasQuery = query !== undefined && query.length > 0;
        const hasPath = typeof params.path === "string" && params.path.trim().length > 0;
        // Commit-message search only routes through the commit search API when
        // a query is given without a path; a path (or no query) uses the REST
        // commits listing, and a query+path combination filters the listing
        // client-side (GitHub commit search does not accept a path qualifier).
        if (hasQuery && !hasPath) {
          const qualifiers = [`repo:${ref.owner}/${ref.repo}`];
          if (params.author) qualifiers.push(`author:${params.author}`);
          if (params.since) qualifiers.push(`author-date:>=${params.since}`);
          if (params.until) qualifiers.push(`author-date:<=${params.until}`);
          const q = `${query} ${qualifiers.join(" ")}`.trim();
          const result = await client.searchCommits(q, { perPage: limit, page: 1 }, signal);
          return {
            content: [{ type: "text", text: formatCommits(`${ref.owner}/${ref.repo}`, result.items) }],
            details: { mode: "search", total: result.totalCount, returned: result.items.length },
          };
        }
        let commits = await client.listCommits(
          ref,
          {
            perPage: limit,
            ...(params.path ? { path: params.path } : {}),
            ...(params.author ? { author: params.author } : {}),
            ...(params.since ? { since: params.since } : {}),
            ...(params.until ? { until: params.until } : {}),
          },
          signal,
        );
        if (hasQuery) {
          const needle = query!.toLowerCase();
          commits = commits.filter((c) =>
            c.message.toLowerCase().includes(needle)
            || c.author.toLowerCase().includes(needle)
            || c.authorEmail.toLowerCase().includes(needle));
        }
        return {
          content: [{ type: "text", text: formatCommits(`${ref.owner}/${ref.repo}`, commits) }],
          details: { mode: "list", returned: commits.length },
        };
      } catch (err) {
        return toToolError("commit_search", err);
      }
    },
  } satisfies ToolDefinition;
}

export function createDiffGithubTool(deps: MmrGithubToolDeps): ToolDefinition {
  return {
    name: "diff_github",
    label: "diff_github",
    description: DIFF_GITHUB_DESCRIPTION,
    promptSnippet: "Compare two refs in a GitHub repository and return a diff.",
    promptGuidelines: [...MMR_GITHUB_PROMPT_GUIDELINES],
    parameters: DIFF_GITHUB_PARAMETERS_SCHEMA,
    async execute(_id, raw, signal): Promise<GithubToolResult> {
      try {
        const params = coerce<DiffGithubParams>("diff_github", DIFF_GITHUB_PARAMETERS_SCHEMA, raw);
        const ref = parseGithubRepository(params.repository);
        const client = resolveClient(deps);
        const comparison = await client.compare(ref, params.base, params.head, signal);
        let files = comparison.files;
        if (params.path) {
          const want = params.path.replace(/^\/+/, "");
          files = files.filter((f) => f.filename === want);
        }
        const includePatches = params.includePatches === true;
        const heading = `# Diff ${ref.owner}/${ref.repo} ${params.base}...${params.head} (${comparison.status}, ${comparison.totalCommits} commits, ${files.length} files)`;
        if (files.length === 0) {
          return { content: [{ type: "text", text: `${heading}\n\n(no file changes${params.path ? " for the given path" : ""})` }], details: { files: 0 } };
        }
        const blocks = files.map((f) => {
          const stat = `${f.status} +${f.additions} -${f.deletions}`;
          if (!includePatches) return `## ${f.filename} (${stat})`;
          if (!f.patch) return `## ${f.filename} (${stat})\n\n(no patch available; file may be binary or too large)`;
          const patch = f.patch.length > DIFF_PATCH_MAX_CHARS
            ? `${f.patch.slice(0, DIFF_PATCH_MAX_CHARS)}\n... [truncated]`
            : f.patch;
          return `## ${f.filename} (${stat})\n\n\`\`\`diff\n${patch}\n\`\`\``;
        });
        return {
          content: [{ type: "text", text: `${heading}\n\n${blocks.join("\n\n")}` }],
          details: { files: files.length, status: comparison.status, totalCommits: comparison.totalCommits, includePatches },
        };
      } catch (err) {
        return toToolError("diff_github", err);
      }
    },
  } satisfies ToolDefinition;
}

export function createListRepositoriesTool(deps: MmrGithubToolDeps): ToolDefinition {
  return {
    name: "list_repositories",
    label: "list_repositories",
    description: LIST_REPOSITORIES_DESCRIPTION,
    promptSnippet: "List or search GitHub repositories by name, organization, or language.",
    promptGuidelines: [...MMR_GITHUB_PROMPT_GUIDELINES],
    parameters: LIST_REPOSITORIES_PARAMETERS_SCHEMA,
    async execute(_id, raw, signal): Promise<GithubToolResult> {
      try {
        const params = coerce<ListRepositoriesParams>("list_repositories", LIST_REPOSITORIES_PARAMETERS_SCHEMA, raw);
        const pattern = params.pattern?.trim();
        const organization = params.organization?.trim();
        const language = params.language?.trim();
        const limit = clamp(params.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
        const offset = clamp(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);
        if (offset % limit !== 0) {
          return errorResult(`list_repositories: offset (${offset}) must be a multiple of limit (${limit}).`);
        }
        const client = resolveClient(deps);

        // Prioritize repositories the token can already access (over-fetched
        // for client-side filtering), then supplement with public repository
        // search when the accessible set is short. The accessible call is
        // best-effort: without a token it 401s, so we fall back to public
        // search only.
        const overFetch = limit * 5;
        const accessiblePage = Math.floor(offset / overFetch) + 1;
        let results: GithubRepoSummary[] = [];
        let total = 0;
        try {
          let accessible = await client.listAccessibleRepositories({ perPage: overFetch, page: accessiblePage }, signal);
          if (pattern) accessible = accessible.filter((r) => r.fullName.toLowerCase().includes(pattern.toLowerCase()));
          if (organization) {
            const org = organization.toLowerCase();
            accessible = accessible.filter((r) => r.fullName.split("/")[0]?.toLowerCase() === org);
          }
          if (language) accessible = accessible.filter((r) => r.language.toLowerCase() === language.toLowerCase());
          accessible.sort((a, b) => b.stars - a.stars);
          results = [...accessible];
          total = accessible.length;
        } catch (err) {
          // Best-effort: a GitHub API error (e.g. 401 without a token) means no
          // accessible enumeration; fall through to public search. Match by
          // name as well so the check is robust across module realms.
          if (!(err instanceof GithubApiError) && !(err instanceof Error && err.name === "GithubApiError")) throw err;
        }

        if (results.length < limit) {
          const qualifiers: string[] = [];
          if (pattern) qualifiers.push(`${pattern} in:name`);
          if (organization) qualifiers.push(`org:${organization}`);
          if (language) qualifiers.push(`language:${language}`);
          const q = qualifiers.length > 0 ? qualifiers.join(" ") : "*";
          const remaining = limit - results.length;
          const search = await client.searchRepositories(q, { perPage: Math.min(remaining, 100), page: 1 }, signal);
          const seen = new Set(results.map((r) => r.fullName));
          const fresh = search.items.filter((r) => !seen.has(r.fullName));
          results.push(...fresh.slice(0, remaining));
          total += fresh.length;
        }

        const filterLabel = [
          pattern ? `pattern "${pattern}"` : undefined,
          organization ? `org:${organization}` : undefined,
          language ? `language:${language}` : undefined,
        ].filter(Boolean).join(", ") || "accessible + public";
        return {
          content: [{ type: "text", text: formatRepos(filterLabel, results.slice(0, limit)) }],
          details: { total, returned: Math.min(results.length, limit) },
        };
      } catch (err) {
        return toToolError("list_repositories", err);
      }
    },
  } satisfies ToolDefinition;
}

const TOOL_FACTORIES = [
  createReadGithubTool,
  createListDirectoryGithubTool,
  createGlobGithubTool,
  createSearchGithubTool,
  createCommitSearchTool,
  createDiffGithubTool,
  createListRepositoriesTool,
] as const;

export interface RegisterMmrGithubToolsResult {
  registered: string[];
}

/**
 * Register the concrete read-only GitHub tools when network access is
 * enabled. When disabled, no Pi tools are registered; the `mmr-github`
 * provider still emits `gated` decisions so `/mmr-status` explains why.
 */
export function registerMmrGithubTools(
  pi: ExtensionAPI,
  deps: MmrGithubToolDeps,
  entrypointPath?: string,
): RegisterMmrGithubToolsResult {
  const settings = deps.getSettings();
  if (!settings.enabled) return { registered: [] };
  if (entrypointPath) registerMmrGithubToolSourcePath(entrypointPath);
  const registered: string[] = [];
  for (const factory of TOOL_FACTORIES) {
    const tool = factory(deps);
    registerMmrOwnedTool(tool.name);
    pi.registerTool(tool);
    registered.push(tool.name);
  }
  return { registered };
}
