import { Type, type Static } from "typebox";

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
  "Set AMPI_GITHUB_TOKEN (legacy MMR_GITHUB_TOKEN) for private repositories, higher rate limits, and code search (search_github requires a token).",
  "Do not put secrets, tokens, or credentials in any tool argument.",
] as const;
