# ampi non-core public API

**Audience.** Developers writing code that imports from `ampi` and wants the stable programmatic surface owned by the non-core extensions.

**Scope.** Package-root re-exports owned by `mmr-patch`, `mmr-tasks`, `mmr-web`, `mmr-subagents`, `mmr-async-tasks`, `mmr-custom-subagents`, `mmr-history`, and `mmr-session-fallback`. The `mmr-core` runtime, locked-mode resolution, prompt assembly, and feature-gate APIs live in [`mmr-core-api.md`](./mmr-core-api.md).

**Related.** Package overview: [`../README.md`](../README.md). Documentation conventions: [`documentation-style-guide.md`](./documentation-style-guide.md).

Anything not listed here (or in `mmr-core-api.md`) is internal and may change without warning. Names re-exported from the package root are the stable contract; deep imports under `src/extensions/<name>/<file>` are not part of the public surface unless this document calls them out.

## Public principles

Identical to `mmr-core`:

1. Provider claims are identity-only. Tool and feature-gate providers
   claim logical names through `mmr-core` provider registration; the
   live tool inventory is the source of truth for active vs deferred.
2. State snapshots are deep-cloned; raw event payloads are read-only
   for the duration of an emission.
3. Each extension keeps its own model/tool resolution, gating, and persistence
   invariants. Document any change in the extension's own README and in
   tests before changing the public surface.
4. Public-safe wording only. Names, statuses, and reasons described
   here are owned `ampi` concepts.

## Import paths

- **Package root** — `import { ... } from "ampi"` (resolves to
  `src/index.ts`). Use this in production code.
- **Preferred extension entrypoint** — `import extension from
  "ampi/extensions/ampi-<family>"` when wiring an extension into a Pi
  package manifest.
- **Compatibility entrypoint** — `import extension from
  "ampi/extensions/mmr-<family>"`. The `mmr-*` subpaths remain supported
  for existing consumers.

| Family | Preferred subpath | Compatibility subpath |
| --- | --- | --- |
| Core | `ampi/extensions/ampi-core` | `ampi/extensions/mmr-core` |
| Patch | `ampi/extensions/ampi-patch` | `ampi/extensions/mmr-patch` |
| Tasks | `ampi/extensions/ampi-tasks` | `ampi/extensions/mmr-tasks` |
| Workers | `ampi/extensions/ampi-workers` | `ampi/extensions/mmr-workers` |
| Custom subagents | `ampi/extensions/ampi-custom-subagents` | `ampi/extensions/mmr-custom-subagents` |
| Session fallback | `ampi/extensions/ampi-session-fallback` | `ampi/extensions/mmr-session-fallback` |
| Web | `ampi/extensions/ampi-web` | `ampi/extensions/mmr-web` |
| GitHub | `ampi/extensions/ampi-github` | `ampi/extensions/mmr-github` |
| History | `ampi/extensions/ampi-history` | `ampi/extensions/mmr-history` |
| Deprecated toolbox shim | `ampi/extensions/ampi-toolbox` | `ampi/extensions/mmr-toolbox` |

Runtime commands, environment variables, and settings keys remain the shipped
compatibility identifiers (`/mmr-*`, `MMR_*`, `mmrCore`, `mmrWeb`, and sibling
settings) until explicit `ampi` aliases are implemented.

The entrypoint default export and any `create<Extension>Extension(...)`
factory are stable; everything else listed below is re-exported through
the package root.

---

## `mmr-patch`

Local-utility extension: ships a real `apply_patch` custom tool for safe
workspace edits.

### Stability

Stable. The `apply_patch` Pi tool, its schema, and its result shape are
part of the supported surface.

### Re-exports from the package root

| Export | Kind | Notes |
| --- | --- | --- |
| `registerMmrPatchProviders` | function | Registers the patch MMR tool provider. Called by the extension entrypoint; safe to call from a host that bypasses the default extension load. |
| `ApplyPatchError` | class | Thrown by the apply-patch engine for structured patch failures. |

### Usage

Hosts that load `ampi` through Pi's extension manifest do not need to
call any of these directly. See
[`../src/extensions/mmr-patch/README.md`](../src/extensions/mmr-patch/README.md).

---

## `mmr-tasks`

Local-utility extension: ships a session-local `task_list` (todo) tool
and its pinned task-list widget.

### Stability

Stable. The `task_list` Pi tool, its schema, and its session-state shape
are part of the supported surface.

### Re-exports from the package root

| Export | Kind | Notes |
| --- | --- | --- |
| `registerMmrTasksProviders` | function | Registers the tasks MMR tool provider. Called by the extension entrypoint; safe to call from a host that bypasses the default extension load. |
| `createTodoListTool` | function | Constructs the `task_list` Pi tool (returns the Pi tool definition). |
| `refreshTodoWidget` | function | Refreshes the pinned task-list widget. |
| `TASK_LIST_WIDGET_ID` | constant | Stable widget id for the pinned task list. |
| `TodoValidationError` | class | Validation error surfaced by the `task_list` schema. |
| `TODO_STATE_ENTRY`, `TODO_STATE_VERSION` | constants | Persisted session-state entry name and version. |
| `findLatestPersistedTodoState`, `parsePersistedTodoState`, `toPersistedTodoState` | functions | Read/parse/serialize the persisted task-list state. |

> Deprecated: `registerMmrToolboxProviders` is still re-exported from the
> package root by the unregistered `mmr-toolbox` compatibility shim, which
> now only re-exports `mmr-patch` and `mmr-tasks`. New code should call
> `registerMmrPatchProviders` and `registerMmrTasksProviders` directly.

### Re-exported types

`PersistedTodoState`, `TaskListItem`, `TaskListSubtask`, `TodoStatus`,
`CreateTodoListToolOptions`, `RefreshTodoWidgetOptions`,
`TodoListDetails`, `TodoListErrorDetails`.

### Usage

Hosts that load `ampi` through Pi's extension manifest do not need to
call any of these directly. Consumers that build their own Pi runtime,
or that want to inspect persisted task-list state from outside a Pi
session, can use the `PersistedTodoState` helpers safely; they perform
their own validation and never throw on malformed input. See
[`../src/extensions/mmr-tasks/README.md`](../src/extensions/mmr-tasks/README.md).

---

## `mmr-web`

Network-backed extension. Owns the `web_search` and `read_web_page`
logical tools and registers them with Pi only when network access is
explicitly enabled. Disabled by default.

### Stability

Stable. Settings shape (`MmrWebSettings`), SSRF validation result, the
feature-gate name, and the provider-factory entrypoints are part of the
supported surface.

### Re-exports from the package root

| Export | Kind | Notes |
| --- | --- | --- |
| `createMmrWebExtension` | function | Factory producing the Pi extension. Accepts `MmrWebFactoryOverrides` for tests; production callers pass no overrides. |
| `createMmrWebToolProvider` | function | Constructs the `mmr-web` MMR tool provider. |
| `createMmrWebFeatureGateProvider` | function | Constructs the feature-gate provider. |
| `MMR_WEB_FEATURE_GATE` | constant | Feature-gate name (`"mmr-web"`). |
| `MMR_WEB_PROVIDER_NAME` | constant | Provider identity string used in diagnostics. |
| `loadMmrWebSettings` | function | Reads non-secret settings from Pi's settings files and env. |
| `DEFAULT_MAX_RESULT_BYTES`, `DEFAULT_TIMEOUT_MS` | constants | Defaults applied when settings are absent. |
| `validateExternalHttpUrl` | function | SSRF/policy gate used by `read_web_page`. Rejects non-`http(s)`, localhost, private IPs, link-local hosts, and non-Internet URLs. |

### Re-exported types

`MmrWebSettings`, `LoadedMmrWebSettings`, `MmrWebFactoryOverrides`,
`UrlValidationResult`.

### Usage

`validateExternalHttpUrl` is the only piece other extensions should
reach for directly: when an extension wants to dereference a
user-supplied URL with the same SSRF policy that `mmr-web` applies, it
should call this helper rather than reimplement the checks.

API keys (e.g. `BRAVE_API_KEY`) remain environment-only and are never
exposed through this surface.

---

## `mmr-github`

Read-only GitHub repository tools. Owns the seven repository-provider tool
names (`read_github`, `list_directory_github`, `glob_github`, `search_github`,
`commit_search`, `diff_github`, `list_repositories`) and the `mmr-github`
feature gate. Network access is off by default (`MMR_GITHUB_ENABLE`); the token
is environment-only (`MMR_GITHUB_TOKEN` / `GITHUB_TOKEN`).

### Stability

Stable for: provider/factory entrypoints, settings loader and defaults, the
client factory and repository parser, ownership helpers, and the owned tool
name constants. Tool descriptions and schema text are model-visible behavior
covered by deterministic tests.

### Re-exports from the package root

| Export | Kind | Notes |
| --- | --- | --- |
| `createMmrGithubExtension` | function | Factory producing the Pi extension. Accepts `MmrGithubFactoryOverrides` for tests. |
| `loadMmrGithubSettings`, `MMR_GITHUB_ENABLE_ENV`, `DEFAULT_GITHUB_API_BASE_URL`, `DEFAULT_GITHUB_TIMEOUT_MS`, `DEFAULT_GITHUB_MAX_RESULT_BYTES` | function/constants | Settings loader and defaults. |
| `createMmrGithubToolProvider`, `createMmrGithubFeatureGateProvider`, `MMR_GITHUB_PROVIDER_NAME`, `MMR_GITHUB_FEATURE_GATE` | functions/constants | Provider entrypoints and identifiers. |
| `MMR_GITHUB_TOOL_NAMES`, `hasMmrGithubOwnedTools`, `isMmrGithubOwnedToolInfo`, `isMmrGithubToolName` | constants/functions | Source-path ownership helpers used by librarian gating and child activation. |
| `createGithubClient`, `parseGithubRepository`, `GithubApiError`, `GithubRepoParseError` | functions/classes | Read-only client and repository-reference parser. |
| `registerMmrGithubTools`, `MMR_GITHUB_PROMPT_GUIDELINES` | function/constant | Tool registration and shared prompt guidelines. |

### Usage

The GitHub tools are the repository-provider surface for the `mmr-subagents`
`librarian` worker. They are read-only (GET requests only) and never expose
issue, pull request, branch, or write endpoints. See
[`../src/extensions/mmr-github/README.md`](../src/extensions/mmr-github/README.md).

---

## `mmr-workers`

The merged worker extension (formerly the separate `mmr-subagents` and
`mmr-async-tasks` extensions). It owns the blocking `Task`, `finder`,
`oracle`, and `librarian` worker tools, the background task surface
(`background: true` on finder/librarian/Task, the deprecated `start_task`
alias, and `task_poll`/`task_wait`/`task_cancel`), the session-scoped
background registry, and the `mmr-workers` feature gate. The pre-merge
gate ids (`mmr-subagents`, `mmr-async-tasks`, `mmr-subagents.async-tasks`)
remain accepted aliases answered by the same provider. `librarian`
resolves as `active` only when the read-only `mmr-github` tools are
registered and source-owned by `mmr-github`.

### v2 background parameters

`finder`, `librarian`, and `Task` accept three optional parameters
(`oracle` stays blocking-only):

- `background?: boolean` — run the worker as a background task and return
  an opaque task id immediately instead of blocking.
- `group?: string` — caller-chosen group key for background runs;
  parallel calls sharing a key land in one worker group (one card, one
  grouped completion notification). Requires `background: true`.
- `notify?: boolean` — automatic completion delivery opt-out for a
  background run. Requires `background: true`.

`start_task` is deprecated and remains as a thin compatibility alias for
one release; its description and results carry a deprecation notice.

### Removed in the merge (breaking)

- `createMmrSubagentsExtension` and `createMmrAsyncTasksExtension` →
  use `createMmrWorkersExtension`.
- `MmrSubagentsFactoryOverrides` and `MmrAsyncTasksFactoryOverrides` →
  use `MmrWorkersFactoryOverrides`.
- The package subpaths `ampi/extensions/mmr-subagents` and
  `ampi/extensions/mmr-async-tasks` → use the preferred
  `ampi/extensions/ampi-workers` subpath (or compatibility
  `ampi/extensions/mmr-workers`).

Every other package-root symbol below kept its name.

### Stability

Stable for: provider/factory entrypoints, owned-tool name constants,
worker model-preference defaults, prompt-builder functions, worker
runner contracts (`MmrSubagentRunner`, `MmrSubagentWorkerRunResult`,
`MmrWorkerInvocation`), registry constructors and snapshot helpers, and
registry/board types.

Worker prompt text and tool descriptions are model-visible behavior
covered by deterministic tests; treat changes to them as behavior
changes.

### Re-exports from the package root

| Export | Kind | Notes |
| --- | --- | --- |
| `createMmrWorkersExtension` | function | Factory producing the merged Pi extension. |
| `createMmrWorkersToolProvider`, `createMmrWorkersFeatureGateProvider` | functions | Unified providers covering the whole worker surface. |
| `MMR_WORKERS_FEATURE_GATE`, `MMR_WORKERS_LEGACY_FEATURE_GATES`, `MMR_WORKERS_OWNED_TOOLS`, `MMR_WORKERS_PROVIDER_NAME` | constants | Unified identifiers. |
| `createMmrSubagentsToolProvider`, `createMmrSubagentsFeatureGateProvider`, `createMmrAsyncTasksToolProvider`, `createMmrAsyncTasksFeatureGateProvider` | functions | Pre-merge provider factories, kept for callers that compose providers manually. |
| `MMR_SUBAGENTS_FEATURE_GATE`, `MMR_SUBAGENTS_OWNED_TOOLS`, `MMR_SUBAGENTS_PROVIDER_NAME`, `MMR_ASYNC_TASKS_FEATURE_GATE`, `MMR_ASYNC_TASKS_PROVIDER_NAME`, `MMR_ASYNC_TASK_TOOLS` | constants | Pre-merge identifiers (still answered/claimed by the unified provider). |
| `MMR_SUBAGENTS_ASYNC_TASKS_FEATURE_GATE`, `MMR_SUBAGENTS_ASYNC_TASK_TOOLS`, `MMR_SUBAGENTS_ASYNC_PUSH_ENV` | constants | Backward-compatible aliases. |
| `createFinderTool`, `registerFinderTool`, `buildFinderWorkerSystemPrompt` | functions | Finder worker surface. |
| `createOracleTool`, `registerOracleTool`, `buildOracleWorkerSystemPrompt` | functions | Oracle worker surface. |
| `createLibrarianTool`, `registerLibrarianTool`, `buildLibrarianWorkerSystemPrompt`, `isLibrarianGithubToolPrerequisiteRegistered`, `MmrLibrarianContextWindowError`, `LIBRARIAN_SUBAGENT_PROFILE_NAME`, `LIBRARIAN_GATING_REASON` | functions/values | Librarian worker surface and gating helpers (gated on `mmr-github` tools). |
| `createTaskTool`, `registerTaskTool`, `buildTaskWorkerSystemPrompt`, `classifyTaskOutcome`, `coerceTaskParams`, `hasUsableTaskFinalText`, `TaskParamsError`, `TASK_SUBAGENT_PROFILE` | functions/values | Task worker surface. |
| `*_TOOL_NAME`, `*_DESCRIPTION`, `*_PARAMETERS_SCHEMA`, `*_PROGRESS_PLACEHOLDER`, `*_PROMPT_GUIDELINES`, `*_PROMPT_SNIPPET`, `*_WORKER_TOOLS`, `*_DEFAULT_MODEL_PREFERENCES` | constants | Per-worker metadata. Tested directly. |
| `buildHistoryReaderWorkerSystemPrompt`, `buildLibrarianWorkerRolePrompt` | functions | Cross-extension prompt builders kept in `mmr-workers/prompts.ts`. |
| `runMmrSubagentWorker`, `createChildCliMmrSubagentRunner`, `createMmrSubagentRunnerFromRunWorker`, `buildMmrWorkerArgs`, `classifyMmrWorkerOutcome`, `truncateMmrWorkerOutput`, `getMmrWorkerFinalOutput`, `hasUsableMmrWorkerFinalOutput`, `emptyMmrWorkerUsageStats`, `resolveMmrWorkerPiInvocation`, `resolveMmrWorkerPiInvocationFromEnv` | functions | Worker-runner contract and helpers. |
| `DEFAULT_MMR_WORKER_KILL_TIMEOUT_MS`, `DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT`, `MMR_WORKER_INLINE_PROMPT_BYTE_LIMIT`, `MMR_WORKER_TRAIL_LIMIT` | constants | Worker-runner defaults. |
| `ASYNC_TASK_TOOL_NAMES`, `ASYNC_TASK_AGENT_NAMES`, `START_TASK_TOOL_NAME`, `TASK_POLL_TOOL_NAME`, `TASK_WAIT_TOOL_NAME`, `TASK_CANCEL_TOOL_NAME` | constants | Background tool-name identifiers. Tested directly. |
| `createStartTaskTool`, `createTaskPollTool`, `createTaskWaitTool`, `createTaskCancelTool`, `registerAsyncTaskTools` | functions | Individual background tool factories and the bulk registrar. |
| `createMmrAsyncTaskRegistry`, `getMmrAsyncTaskRegistry`, `isValidAsyncTaskGroupId`, `toPublicAsyncTaskSnapshot` | functions | Session-scoped registry constructor/accessor and snapshot helpers. |
| `ASYNC_TASK_MAX_RUNTIME_MS`, `ASYNC_TASK_STALLED_AFTER_MS`, `ASYNC_TASK_CANCEL_DEAD_AFTER_MS`, `ASYNC_TASK_TERMINAL_TTL_MS`, `ASYNC_TASK_OBSERVED_TERMINAL_TTL_MS`, `DEFAULT_ASYNC_TASK_MAX_RUNNING_PER_SESSION`, `DEFAULT_ASYNC_TASK_MAX_PUSHES_PER_SESSION`, `DEFAULT_TASK_WAIT_TIMEOUT_MS`, `MAX_TASK_WAIT_TIMEOUT_MS` | constants | Registry lifecycle, concurrency, and wait-timeout defaults. |

### Re-exported types

`MmrWorkersFactoryOverrides`, `MmrWorkersCapabilities`,
`MmrSubagentsCapabilities`, `MmrAsyncTasksCapabilities`,
`FinderDetails`, `FinderParams`, `FinderToolDeps`, `OracleDetails`,
`OracleParams`, `OracleToolDeps`, `OracleAttachmentRecord`,
`LibrarianDetails`, `LibrarianParams`, `LibrarianStatus`,
`LibrarianToolDeps`, `ResolveLibrarianInvocationInput`,
`TaskDetails`, `TaskParams`, `TaskToolDeps`,
`TaskWorkerSystemPromptInput`, `TaskOutcomeInput`,
`ResolveTaskInvocationInput`,
`MmrSubagentRunner`, `MmrSubagentRunOptions`, `MmrSubagentRunProgress`,
`MmrSubagentWorkerRunResult`, `MmrSubagentWorkerDetailsBase`,
`MmrSpawnedSubagentWorkerDetailsBase`, `MmrWorkerInvocation`,
`MmrWorkerOutcomeStatus`, `MmrWorkerMessage`,
`MmrWorkerPiInvocationEnv`, `MmrWorkerProcess`,
`MmrWorkerProgressSnapshot`, `MmrWorkerResult`, `MmrWorkerRunnerDeps`,
`MmrWorkerSpawn`, `MmrWorkerTrailItem`, `MmrWorkerUsageStats`,
`RunMmrSubagentWorkerOptions`, `ClassifyMmrWorkerOutcomeOptions`,
`AsyncTaskAgentName`, `AsyncTaskToolDeps`, `AsyncTaskToolDetails`,
`MmrAsyncTaskRegistry`, `MmrAsyncTaskRegistryDeps`,
`MmrAsyncTaskSnapshot`, `MmrAsyncTaskInternalSnapshot`,
`MmrAsyncTaskStatus`, `MmrAsyncTaskFreshness`, `MmrAsyncTaskBoard`,
`MmrAsyncTaskBoardEntry`, `MmrAsyncTaskGroupSnapshot`,
`MmrAsyncTaskGroupStatus`, `StartAsyncTaskArgs`, `StartAsyncTaskResult`,
`WaitForAsyncTaskResult`.

> Note: `TaskStatus` is intentionally **not** a named package-root export.
> Consumers that need the status discriminator should use
> `TaskDetails["status"]` so the public surface stays tied to the details
> shape instead of a deep import path.

### Usage

The runner-contract helpers and worker prompt builders are intended for
hosts that compose their own subagent pipelines (for example, tests
that exercise the worker contract without spawning a child Pi). The
registry constructor and snapshot helpers serve hosts and tests that
drive background workers without a live session. The default extension
factory wires everything Pi needs in a normal load.

---

## `mmr-custom-subagents`

Custom Markdown subagent extension extracted from `mmr-subagents`. It
discovers project-local Markdown subagent definitions, persists which are
enabled, and registers per-subagent worker tools (named with the
`MMR_CUSTOM_SUBAGENT_TOOL_PREFIX`) behind the `mmr-custom-subagents`
feature gate.

Stable for: provider/factory entrypoints, the Markdown discovery/parse
helpers, owned tool-name prefix and scan limits, and discovery types.
Discovery is separate from registration; registration is an explicit
step wired by the extension factory.

### Re-exports from the package root

| Export | Kind | Notes |
| --- | --- | --- |
| `createMmrCustomSubagentsExtension` | function | Factory producing the Pi extension. |
| `createMmrCustomSubagentsToolProvider` | function | MMR tool provider for discovered custom-subagent tools. |
| `createMmrCustomSubagentsFeatureGateProvider` | function | Feature-gate provider for `mmr-custom-subagents`. |
| `MMR_CUSTOM_SUBAGENTS_FEATURE_GATE`, `MMR_CUSTOM_SUBAGENTS_PROVIDER_NAME` | constants | Stable identifiers. |
| `discoverMmrCustomSubagents`, `parseMmrCustomSubagentMarkdown`, `normalizeMmrCustomSubagentToolPatterns`, `toMmrCustomSubagentToolName` | functions | Markdown discovery, parsing, tool-pattern normalization, and tool-name derivation. Discovery only. |
| `MMR_CUSTOM_SUBAGENT_TOOL_PREFIX`, `MMR_CUSTOM_SUBAGENT_MAX_FILE_BYTES`, `MMR_CUSTOM_SUBAGENT_MAX_TOOL_NAME_LENGTH`, `DEFAULT_MMR_CUSTOM_SUBAGENT_MAX_SCAN_DEPTH` | constants | Owned tool-name prefix and discovery bounds. |

### Re-exported types

`MmrCustomSubagentsFactoryOverrides`, `MmrCustomSubagentsCapabilities`,
`DiscoverMmrCustomSubagentsArgs`, `MmrCustomSubagentDefinition`,
`ParseMmrCustomSubagentMarkdownArgs`.

### Usage

The discovery and parse helpers let hosts and tests enumerate
project-local Markdown subagent definitions without registering tools.
The default extension factory wires discovery, the `/mmr-config` flow,
and gated tool registration in a normal load.

---

## `mmr-history`

Opt-in extension that lets the agent search and read prior local Pi
sessions across every project on disk, with deterministic redaction and
a model-backed reader. Disabled by default; enabled by setting
`MMR_HISTORY_ENABLE=true` before Pi starts.

### Stability

Stable for: settings, env-gate name, public tool factories, the
`history-reader` worker contract (profile, default model preferences,
packet-byte limit), and the persisted query/index shapes.

### Re-exports from the package root

| Export | Kind | Notes |
| --- | --- | --- |
| `createMmrHistoryExtension` | function | Factory producing the Pi extension. |
| `loadMmrHistorySettings` | function | Reads settings from env. |
| `MMR_HISTORY_ENABLE_ENV`, `DEFAULT_MMR_HISTORY_MAX_RESULTS`, `MAX_MMR_HISTORY_RESULTS`, `DEFAULT_MMR_HISTORY_MAX_EXCERPT_BYTES` | constants | Env name and limits. |
| `createFindSessionTool`, `createReadSessionTool`, `registerMmrHistoryTools`, `createDefaultMmrHistoryToolDeps` | functions | Tool factories and default dependency wiring. |
| `parseSessionQuery`, `tokenizeSessionQuery` | functions | Query DSL parser/tokenizer. |
| `searchSessions`, `resolveSessionById` | functions | Catalog operations. |
| `createSessionIndex` | function | Builds the in-memory session index. |
| `readSessionForGoal`, `formatSessionReadResult` | functions | `read_session` core. |
| `runHistoryReaderAnalysis`, `buildHistoryReaderSessionPacket`, `selectHistoryReaderWorkerModel` | functions | History-reader worker helpers. |
| `HISTORY_READER_SUBAGENT_PROFILE`, `HISTORY_READER_WORKER_TOOLS`, `HISTORY_READER_DEFAULT_MODEL_PREFERENCES`, `DEFAULT_HISTORY_READER_PACKET_BYTE_LIMIT` | constants | History-reader worker metadata. |

### Re-exported types

`HistoryAnalysisMode`, `HistoryReaderAnalysisResult`,
`HistoryReaderWorkerDetails`, `SanitizedHistoryReaderSessionPacket`,
`SessionReadExcerpt`, `SessionReadResult`,
`ResolvedSession`, `SearchSessionsOptions`, `SessionCatalogDeps`,
`SessionSearchMatch`, `SessionIndex`,
`FindSessionDetails`, `ReadSessionDetails`, `MmrHistoryToolDeps`.

### Usage

The query parser, catalog functions, and reader helpers are safe to use
outside Pi (for example, in tests or analysis scripts). Tool results
never surface raw file paths or raw project cwds; matches are
identified by Pi session id and an opaque `projectRef` hash, and that
contract holds across every consumer of these helpers.

---

## `mmr-session-fallback`

Reactive extension that classifies provider quota / rate-limit errors
and offers a session-scoped fallback override. Persists override state
in the session log so a resumed session keeps the same model preference state.

### Stability

Stable for: the persisted state shape (`PersistedMmrSessionFallbackOverride`,
entry name, version), the classifier output type, the snapshot
accessor, and the extension factory.

The override is intentionally session-scoped; nothing in this surface
writes outside Pi's session log.

### Re-exports from the package root

| Export | Kind | Notes |
| --- | --- | --- |
| `createMmrSessionFallbackExtension` | function | Factory producing the Pi extension. |
| `classifyMmrSessionFallbackError` | function | Pure classifier: takes `{ provider?, errorMessage? }` and returns a `MmrSessionFallbackErrorClassification`. Use this to decide whether to prompt for a fallback. |
| `MMR_SESSION_FALLBACK_ENTRY`, `MMR_SESSION_FALLBACK_STATE_VERSION` | constants | Session-state entry name and version. |
| `findLatestPersistedMmrSessionFallbackOverride`, `parsePersistedMmrSessionFallbackOverride`, `toPersistedMmrSessionFallbackOverride` | functions | Read/parse/serialize persisted override entries. |
| `getMmrSessionFallbackOverrideSnapshot` | function | Returns the current in-memory override snapshot (deep-cloned). |

### Re-exported types

`MmrSessionFallbackErrorClassification`,
`MmrSessionFallbackQuotaKind`,
`PersistedMmrSessionFallbackOverride`.

### Usage

`classifyMmrSessionFallbackError` is the recommended entry point for
other extensions or hosts that want to reuse the quota/rate-limit
heuristics without taking on the rest of the fallback prompt UI.
Persisted-state helpers tolerate malformed input (they return
`undefined` rather than throwing) and are safe to use from outside a
running Pi session.

---

## Compatibility expectations

- Names listed above will not be removed without a deprecation cycle.
- Constant **values** (defaults, byte limits, gate names) may be tuned
  in minor releases when the behavior change is documented in
  `CHANGELOG.md`; the **identifiers** themselves are stable.
- Worker prompt and tool-description text is behavior, not commentary.
  Changes to it are accompanied by deterministic test updates and
  changelog entries; do not parse or pattern-match against it from
  external code.
- Deep imports under `src/extensions/<name>/<file>` are not stable
  except where this document or `mmr-core-api.md` explicitly calls them
  out.
