# mmr-github

`mmr-github` ships read-only GitHub repository tools for `pi-mmr`. These tools
are the repository-provider surface used by the `mmr-subagents` `librarian`
worker, and they are also available to any caller that enables the extension.

## Tools

All tools are **read-only**. There is no mutation surface: no issue, pull
request, branch, or write endpoints are exposed.

| Tool | Purpose |
| --- | --- |
| `read_github` | Read a file (with line numbers, optional `read_range`) or fall back to a directory listing. |
| `list_directory_github` | List a directory's entries; subdirectories are marked with a trailing `/`. |
| `glob_github` | Find files whose paths match a `filePattern` glob (`*`, `**`, `?`, `{a,b}`, `[...]`) over the repository tree. Fails fast if the tree is too large to list recursively. |
| `search_github` | Code search within one repository, grouped by file with context fragments (each capped at 2048 chars). Requires a token. |
| `commit_search` | Search commit messages (`query`), or list recent commits filtered by path, author, or date. A `query`+`path` combination filters the listing client-side. |
| `diff_github` | Compare two refs and return file-level change stats; set `includePatches` to also return unified diff hunks (each patch truncated to ~4 KB). |
| `list_repositories` | Discover repositories by name `pattern`, `organization`, and `language`. Prioritizes repositories the token can access and supplements with public repository search. |

`diff_github` is deliberately named with a `_github` suffix (rather than a bare
`diff`) to avoid colliding with unrelated tool names.

## Configuration

Settings load from the standard MMR settings files (`~/.pi/agent/settings.json`,
`<cwd>/.pi/settings.json`) under the `mmrGithub` key, overlaid by environment
variables. Network access is **off by default**; nothing reaches GitHub until
the extension is explicitly enabled.

| Setting | Env | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | `MMR_GITHUB_ENABLE` | `false` | Master switch for outbound GitHub access. |
| `token` | `MMR_GITHUB_TOKEN` / `GITHUB_TOKEN` | _unset_ | **Env only.** Settings-file tokens are ignored with a warning. Required for code search, private repos, and higher rate limits. |
| `apiBaseUrl` | `MMR_GITHUB_API_URL` | `https://api.github.com` | Override for tests; GitHub Enterprise Server is not a supported target in this slice. |
| `requestTimeoutMs` | `MMR_GITHUB_TIMEOUT_MS` | `30000` | Per-request timeout. |
| `maxResultBytes` | `MMR_GITHUB_MAX_RESULT_BYTES` | `200000` | Hard cap on bytes read from a single response. `read_github` uses a larger dedicated ceiling (~1.5 MB) for the contents endpoint so a whole file can be fetched and sliced with `read_range`. |

Settings are sampled once at extension load. Like `mmr-web`, toggling access
mid-process is not supported because the Pi tool registry is one-directional;
enabling or disabling GitHub access requires restarting the Pi process.

## Ownership and gating

The extension records its entrypoint `sourceInfo.path` so consumers can confirm
that a live GitHub tool registration still belongs to `mmr-github` by source
path, not just by name. The `librarian` worker is gated on every GitHub tool
being **registered and source-owned** by `mmr-github`; a same-named tool from a
third-party extension does not satisfy the gate. The GitHub tools are not part
of any user-facing mode's active tool set — the librarian worker activates them
by name through its profile allowlist.

## Reading large files

`read_github` fetches the whole file (bounded by GitHub's contents API, which
only serves files up to 1 MB inline), applies `read_range` first, and then
gates the resulting slice at 128 KiB. A large file is therefore readable as
long as `read_range` selects a slice under the gate; an oversized slice returns
a clear "retry with a smaller read_range" error that reports the file's total
line count. Files larger than GitHub's 1 MB inline ceiling are reported as too
large. Directory listings are gated the same way; `list_directory_github`
accepts a `limit` to bound large directories.

## Safety

- Read-only: GET requests only; no mutation endpoints.
- `list_repositories` prioritizes repositories the configured token can already
  access (`/user/repos`) and supplements with public repository search. It only
  ever surfaces repositories the token is already entitled to see, and works
  without a token by falling back to public search.
- `read_github` fetches whole files only within GitHub's 1 MB contents-API
  ceiling, applies `read_range`, then gates the slice at 128 KiB.
- Repository inputs accept exactly one `owner/repo` or
  `https://github.com/owner/repo`; search, organization, and profile pages are
  rejected.
- Tokens are read from the environment only and are never logged or echoed.

## Public API

Re-exported from `pi-mmr`:

- `createMmrGithubExtension(overrides?)`, default export factory.
- `loadMmrGithubSettings(cwd, options?)`, `MMR_GITHUB_ENABLE_ENV`, defaults.
- `createMmrGithubFeatureGateProvider`, `createMmrGithubToolProvider`,
  `MMR_GITHUB_PROVIDER_NAME`, `MMR_GITHUB_FEATURE_GATE`.
- `MMR_GITHUB_TOOL_NAMES`, `hasMmrGithubOwnedTools`, `isMmrGithubOwnedToolInfo`,
  `isMmrGithubToolName`.
- `createGithubClient`, `parseGithubRepository`, `GithubApiError`,
  `GithubRepoParseError`.
- `registerMmrGithubTools`, `MMR_GITHUB_PROMPT_GUIDELINES`.
