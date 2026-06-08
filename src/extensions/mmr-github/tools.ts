import type {
  AgentToolResult,
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerMmrOwnedTool } from "../mmr-core/owned-tools.js";
import { checkMmrToolParams } from "../mmr-core/tool-params.js";
import {
  createGithubClient,
  GithubApiError,
  GithubRepoParseError,
  parseGithubRepository,
  type GithubClient,
  type GithubRepoSummary,
} from "./client.js";
import type { MmrGithubSettings } from "./config.js";
import { matchGlob } from "./glob.js";
import {
  clamp,
  directoryListingResult,
  errorResult,
  formatCommits,
  formatRepos,
  numberLines,
  pluralizeEntries,
  renderDirEntryLines,
  sliceListingWithMarkers,
  sliceReadRange,
} from "./tool-format.js";
import {
  COMMIT_SEARCH_DESCRIPTION,
  COMMIT_SEARCH_PARAMETERS_SCHEMA,
  DEFAULT_COMMIT_LIMIT,
  DEFAULT_DIRECTORY_LIMIT,
  DEFAULT_GLOB_LIMIT,
  DEFAULT_LIST_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  DIFF_GITHUB_DESCRIPTION,
  DIFF_GITHUB_PARAMETERS_SCHEMA,
  DIFF_PATCH_MAX_CHARS,
  GLOB_GITHUB_DESCRIPTION,
  GLOB_GITHUB_PARAMETERS_SCHEMA,
  LIST_DIRECTORY_GITHUB_DESCRIPTION,
  LIST_DIRECTORY_GITHUB_PARAMETERS_SCHEMA,
  LIST_REPOSITORIES_DESCRIPTION,
  LIST_REPOSITORIES_PARAMETERS_SCHEMA,
  MAX_COMMIT_LIMIT,
  MAX_DIRECTORY_LIMIT,
  MAX_GLOB_LIMIT,
  MAX_LIST_LIMIT,
  MAX_SEARCH_LIMIT,
  MMR_GITHUB_PROMPT_GUIDELINES,
  READ_GITHUB_DESCRIPTION,
  READ_GITHUB_PARAMETERS_SCHEMA,
  READ_OUTPUT_BYTE_LIMIT,
  SEARCH_FRAGMENT_MAX_CHARS,
  SEARCH_GITHUB_DESCRIPTION,
  SEARCH_GITHUB_PARAMETERS_SCHEMA,
  type CommitSearchParams,
  type DiffGithubParams,
  type GlobGithubParams,
  type ListDirectoryGithubParams,
  type ListRepositoriesParams,
  type ReadGithubParams,
  type SearchGithubParams,
} from "./tool-schemas.js";
import { registerMmrGithubToolSourcePath } from "./tool-ownership.js";

// Re-export the schema/contract and formatting surfaces so every previously
// exported symbol stays importable from `./tools.js`.
export {
  COMMIT_MESSAGE_MAX_CHARS,
  COMMIT_SEARCH_DESCRIPTION,
  COMMIT_SEARCH_PARAMETERS_SCHEMA,
  DEFAULT_COMMIT_LIMIT,
  DEFAULT_DIRECTORY_LIMIT,
  DEFAULT_GLOB_LIMIT,
  DEFAULT_LIST_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  DIFF_GITHUB_DESCRIPTION,
  DIFF_GITHUB_PARAMETERS_SCHEMA,
  DIFF_PATCH_MAX_CHARS,
  GLOB_GITHUB_DESCRIPTION,
  GLOB_GITHUB_PARAMETERS_SCHEMA,
  LIST_DIRECTORY_GITHUB_DESCRIPTION,
  LIST_DIRECTORY_GITHUB_PARAMETERS_SCHEMA,
  LIST_REPOSITORIES_DESCRIPTION,
  LIST_REPOSITORIES_PARAMETERS_SCHEMA,
  MAX_COMMIT_LIMIT,
  MAX_DIRECTORY_LIMIT,
  MAX_GLOB_LIMIT,
  MAX_LIST_LIMIT,
  MAX_SEARCH_LIMIT,
  MMR_GITHUB_PROMPT_GUIDELINES,
  READ_GITHUB_DESCRIPTION,
  READ_GITHUB_PARAMETERS_SCHEMA,
  READ_OUTPUT_BYTE_LIMIT,
  SEARCH_FRAGMENT_MAX_CHARS,
  SEARCH_GITHUB_DESCRIPTION,
  SEARCH_GITHUB_PARAMETERS_SCHEMA,
} from "./tool-schemas.js";
export type {
  CommitSearchParams,
  DiffGithubParams,
  GlobGithubParams,
  ListDirectoryGithubParams,
  ListRepositoriesParams,
  ReadGithubParams,
  SearchGithubParams,
} from "./tool-schemas.js";

export interface MmrGithubToolDeps {
  getSettings: () => MmrGithubSettings;
  /** Client factory seam for deterministic tests. */
  createClient?: (settings: MmrGithubSettings) => GithubClient;
}

export type GithubToolDetails = Record<string, unknown>;
type GithubToolResult = AgentToolResult<GithubToolDetails>;

// ---------------------------------------------------------------------------
// Client / coercion / error mapping
// ---------------------------------------------------------------------------

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

function toToolError(toolName: string, err: unknown): GithubToolResult {
  if (err instanceof GithubRepoParseError) return errorResult(`${toolName}: ${err.message}`);
  if (err instanceof GithubApiError) return errorResult(`${toolName}: ${err.message}`);
  const message = err instanceof Error ? err.message : String(err);
  return errorResult(`${toolName}: ${message}`);
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
