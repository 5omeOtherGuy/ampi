/**
 * `ampi` package root barrel — the public export surface.
 *
 * Exports here are organized into stability tiers. The same tiers, the
 * compatibility rule, and a per-tier breakdown of what each covers are
 * documented in `docs/public-api-surface.md` (the symbol-by-symbol API
 * reference lives in `docs/public-api.md` and `docs/ampi-core-api.md`);
 * keep the tier doc, this block, and the section banners below in sync
 * when the surface changes.
 *
 * Tiers:
 *
 * - Stable: supported public API. Removing or renaming a Stable export is
 *   a breaking change — it requires a semver-major bump and a `CHANGELOG.md`
 *   migration note. Covers mode keys/definitions, the model resolver,
 *   routing, feature gates, settings loaders, the `createMmr*Extension`
 *   factories, the public tool `create*`/`register*` functions, and the
 *   public type surface.
 *
 * - Internal / prompt-assembly: exported for cross-extension wiring and
 *   advanced embedders. Not part of the stability promise and may change
 *   without a major bump. Covers prompt-layer markers/builders, the
 *   prompt-assembly helpers, the planned-tool catalog, the debug-fixture
 *   renderers, and legacy convenience constants such as
 *   `ORACLE_DEFAULT_MODEL_PREFERENCES`.
 *
 * - Test seam: exported (or, in a few cases, deliberately NOT re-exported
 *   from this barrel) only for the repo's own tests. Do not depend on these
 *   externally.
 *
 * Compatibility rule: no export is ever pruned abruptly. Any future
 * removal or relocation must ship a staged compatibility plan — a
 * `CHANGELOG.md` deprecation note, a transition window, and (for
 * type-only members) a `@deprecated` JSDoc tag first.
 *
 * Section banner comments below mark the owning extension/module for each
 * export group; they are comment-only and add or remove no export.
 */

// --- ampi-core: public types (Stable) ---
export type {
  MmrActiveToolManifestEntry,
  MmrCoreSettings,
  MmrFeatureGateDecision,
  MmrFeatureGateProvider,
  MmrFeatureGateProviderDecision,
  MmrFeatureGateRegistry,
  MmrFeatureGateStatus,
  MmrModeDefinition,
  MmrModeKey,
  MmrModeSelection,
  MmrModeSelectionSource,
  MmrModeState,
  MmrModelCandidateResolution,
  MmrModelPreference,
  MmrModelResolution,
  MmrPlannedToolMetadata,
  MmrPolicyDiagnostic,
  MmrPolicyDiagnosticCode,
  MmrPolicyDiagnosticSeverity,
  MmrPromptAssemblyResult,
  MmrPromptBlock,
  MmrPromptBlockKind,
  MmrPromptRoute,
  MmrSessionIdentity,
  MmrSessionIdentitySource,
  MmrToolDecision,
  MmrToolProvider,
  MmrToolResolution,
  MmrToolRule,
  MmrToolStatus,
} from "./extensions/ampi-core/types.js";
export type { MmrPromptLayerContext } from "./extensions/ampi-core/prompt.js";
export type {
  MmrModelRouteSelection,
  ResolveAndApplyMmrModelArgs,
  SelectMmrModelRouteArgs,
  MmrModelRegistryLike,
  MmrRegisteredModelLike,
} from "./extensions/ampi-core/model-resolver.js";

// --- ampi-core: modes, model resolver & routing (Stable) ---
export { DEFAULT_MMR_MODE, MMR_MODE_KEYS, MMR_MODES, getMmrMode, isMmrModeKey } from "./extensions/ampi-core/modes.js";
export { resolveAndApplyMmrModel, selectMmrModelRoute } from "./extensions/ampi-core/model-resolver.js";
export { resolveMmrModeSelection } from "./extensions/ampi-core/routing.js";
export { createMmrFeatureGateRegistry } from "./extensions/ampi-core/feature-gates.js";
export { getMmrPolicyDiagnostics } from "./extensions/ampi-core/diagnostics.js";
export {
  MMR_EVENT_SESSION_IDENTITY_CHANGED,
  MMR_EVENT_STATE_CHANGED,
  createMmrCoreRuntime,
  getMmrModeState,
  getMmrModeStateSnapshot,
  getMmrPromptRoute,
  getMmrSessionIdentity,
  getMmrSessionIdentitySnapshot,
  isToolAllowed,
  onMmrSessionIdentityChanged,
  onMmrStateChanged,
  registerMmrFeatureGateProvider,
  registerMmrToolProvider,
  resolveMmrFeatureGates,
  resolveMmrModel,
  resolveMmrTools,
} from "./extensions/ampi-core/runtime.js";
export type {
  MmrEventBusHost,
  MmrSessionIdentityChangedHandler,
  MmrStateChangedHandler,
} from "./extensions/ampi-core/runtime.js";
export { loadMmrCoreSettings } from "./extensions/ampi-core/settings.js";
// --- ampi-core: prompt assembly & subagent wiring (Internal / prompt-assembly) ---
export { MMR_PROMPT_LAYER_END, MMR_PROMPT_LAYER_START, buildMmrPromptLayer } from "./extensions/ampi-core/prompt.js";
export {
  expandMmrModelPreferencesToStrings,
  getMmrSubagentProfile,
  listMmrSubagentProfiles,
} from "./extensions/ampi-core/subagent-profiles.js";
export type {
  MmrSubagentBaseMode,
  MmrSubagentPartialOutputPolicy,
  MmrSubagentProfile,
  MmrSubagentPromptRoute,
} from "./extensions/ampi-core/subagent-profiles.js";
// `clearMmrSubagentPromptBuilders` is an internal test seam and is
// intentionally not re-exported from the package root. Tests reach it
// through the module directly.
export {
  assembleMmrSubagentSurface,
  getMmrSubagentPromptBuilder,
  registerMmrSubagentPromptBuilder,
} from "./extensions/ampi-core/subagent-prompt-assembly.js";
export type {
  AssembleMmrSubagentSurfaceInput,
  MmrSubagentPromptAssemblyResult,
  MmrSubagentPromptBlockKind,
  MmrSubagentPromptBuilder,
  MmrSubagentPromptBuilderInput,
  MmrSubagentSurfaceBlock,
} from "./extensions/ampi-core/subagent-prompt-assembly.js";
export {
  MMR_SUBAGENT_ACTIVATION_FAILURE_STDERR_PREFIX,
  extractMmrSubagentActivationFailure,
  resolveMmrSubagentInvocation,
} from "./extensions/ampi-core/subagent-resolver.js";
export {
  MMR_SUBAGENT_CAPABILITY_PROFILE_KEYS,
  MMR_SUBAGENT_CUSTOM_DEFAULT_TOOLS,
  MMR_SUBAGENT_EXECUTION_TOOLS,
  MMR_SUBAGENT_MUTATION_TOOLS,
  MMR_SUBAGENT_READ_ONLY_TOOLS,
  MMR_SUBAGENT_READ_WRITE_TOOLS,
  MMR_SUBAGENT_RECURSIVE_ADVISORY_DENY_TOOLS,
  MMR_SUBAGENT_SHARED_DENY_TOOLS,
  MMR_SUBAGENT_TOOLBOX_MCP_DENY_TOOLS,
  isMmrCapabilityProfileKey,
  resolveMmrCapabilityAllowedTools,
} from "./extensions/ampi-core/subagent-tool-policy.js";
export type {
  MmrSubagentInvocation,
  MmrSubagentInvocationFail,
  MmrSubagentInvocationOk,
  MmrSubagentResolveCode,
  MmrSubagentResolveDiagnostic,
  MmrSubagentToolResolution,
  ResolveMmrSubagentInvocationArgs,
} from "./extensions/ampi-core/subagent-resolver.js";
export type { MmrCapabilityProfileKey } from "./extensions/ampi-core/subagent-tool-policy.js";
export { extractExplicitWorkerCliFlags } from "./extensions/ampi-core/worker-cli-flags.js";
export type { ExplicitWorkerCliFlags } from "./extensions/ampi-core/worker-cli-flags.js";
export { getMmrSubagentState } from "./extensions/ampi-core/runtime.js";
export type { MmrSubagentState } from "./extensions/ampi-core/runtime.js";
export {
  MMR_IN_PROCESS_SUBAGENT_RUNNER_AVAILABLE,
  MMR_SUBAGENT_RUN_STATUSES,
  MMR_SUBAGENT_TOOL_USE_STATUSES,
  MmrInProcessRunnerUnavailableError,
  runMmrSubagentInProcess,
} from "./extensions/ampi-core/subagent-runner-contract.js";
export type {
  MmrSubagentPermissionContext,
  MmrSubagentProgressEvent,
  MmrSubagentRunResult,
  MmrSubagentRunStatus,
  MmrSubagentToolUseProgress,
  MmrSubagentToolUseStatus,
  MmrSubagentTurnProgress,
  RunMmrSubagentInProcessOptions,
} from "./extensions/ampi-core/subagent-runner-contract.js";
export {
  MMR_ADDITIONAL_TOOLS_LINE,
  MMR_IDENTITY_LINE,
  MMR_RESPONSE_STYLE_HEADING,
  MMR_TOOL_USE_HEADING,
  MMR_TOOL_USE_POSTURE_LINE,
  assembleActiveSurface,
} from "./extensions/ampi-core/prompt-assembly.js";
export type { AssembleActiveSurfaceInput } from "./extensions/ampi-core/prompt-assembly.js";
export {
  MMR_BUILTIN_TOOL_GUIDANCE_HEADING,
  buildBuiltinToolGuidance,
  extractActiveBuiltinToolNames,
  listBuiltinToolGuidanceTools,
} from "./extensions/ampi-core/builtin-tool-guidance.js";
// --- ampi-core: planned-tool catalog & debug renderers (Internal / prompt-assembly) ---
export { MMR_PLANNED_TOOL_CATALOG } from "./extensions/ampi-core/planned-catalog.js";
export { renderMmrPromptDebugFixture, stringifyMmrToolSchema } from "./extensions/ampi-core/prompt-debug-renderer.js";
export { AMPI_MODE_STATE_ENTRY, MMR_MODE_STATE_ENTRY, findLatestPersistedModeState } from "./extensions/ampi-core/state.js";
export { createMmrToolRegistry, isMmrToolAllowed, resolveMmrTools as resolveMmrToolNames } from "./extensions/ampi-core/tool-registry.js";
// --- ampi-session-fallback (Stable) ---
export { createMmrSessionFallbackExtension } from "./extensions/ampi-session-fallback/index.js";
export { classifyMmrSessionFallbackError } from "./extensions/ampi-session-fallback/classifier.js";
export type { MmrSessionFallbackErrorClassification, MmrSessionFallbackQuotaKind } from "./extensions/ampi-session-fallback/classifier.js";
export {
  AMPI_SESSION_FALLBACK_ENTRY,
  MMR_SESSION_FALLBACK_ENTRY,
  MMR_SESSION_FALLBACK_STATE_VERSION,
  findLatestPersistedMmrSessionFallbackOverride,
  parsePersistedMmrSessionFallbackOverride,
  toPersistedMmrSessionFallbackOverride,
} from "./extensions/ampi-session-fallback/state.js";
export type { PersistedMmrSessionFallbackOverride } from "./extensions/ampi-session-fallback/state.js";
export { getMmrSessionFallbackOverrideSnapshot } from "./extensions/ampi-session-fallback/runtime.js";
// --- ampi-patch (Stable) ---
export { ApplyPatchError } from "./extensions/ampi-patch/apply-patch.js";
export { registerAmpiPatchProviders, registerMmrPatchProviders } from "./extensions/ampi-patch/index.js";
// --- ampi-tasks (Stable) ---
export { registerAmpiTasksProviders, registerMmrTasksProviders } from "./extensions/ampi-tasks/index.js";
export {
  LEGACY_TODO_STATE_ENTRY,
  TODO_STATE_ENTRY,
  TODO_STATE_VERSION,
  findLatestPersistedTodoState,
  parsePersistedTodoState,
  toPersistedTodoState,
} from "./extensions/ampi-tasks/todo-list.js";
export type {
  PersistedTodoState,
  TaskListItem,
  TaskListSubtask,
  TodoStatus,
} from "./extensions/ampi-tasks/todo-list.js";
export {
  TASK_LIST_WIDGET_ID,
  TodoValidationError,
  createTodoListTool,
  refreshTodoWidget,
} from "./extensions/ampi-tasks/todo-list-tool.js";
// --- mmr-toolbox (Deprecated compatibility shim: split into mmr-patch + mmr-tasks) ---
export { registerAmpiToolboxProviders, registerMmrToolboxProviders } from "./extensions/ampi-toolbox/index.js";
// --- ampi-history (Stable) ---
export {
  createAmpiHistoryExtension,
  createMmrHistoryExtension,
} from "./extensions/ampi-history/index.js";
export {
  AMPI_HISTORY_ENABLE_ENV,
  AMPI_HISTORY_PACKET_BYTE_BUDGET_ENV,
  AMPI_HISTORY_REDACT_ENV,
  DEFAULT_MMR_HISTORY_MAX_EXCERPT_BYTES,
  DEFAULT_MMR_HISTORY_MAX_RESULTS,
  MAX_MMR_HISTORY_RESULTS,
  MMR_HISTORY_ENABLE_ENV,
  loadMmrHistorySettings,
} from "./extensions/ampi-history/config.js";
export {
  DEFAULT_HISTORY_READER_PACKET_BYTE_LIMIT,
  HISTORY_READER_DEFAULT_MODEL_PREFERENCES,
  HISTORY_READER_SUBAGENT_PROFILE,
  HISTORY_READER_WORKER_TOOLS,
  buildHistoryReaderSessionPacket,
  runHistoryReaderAnalysis,
  selectHistoryReaderWorkerModel,
} from "./extensions/ampi-history/analysis-worker.js";
export type {
  HistoryAnalysisMode,
  HistoryReaderAnalysisResult,
  HistoryReaderWorkerDetails,
  SanitizedHistoryReaderSessionPacket,
} from "./extensions/ampi-history/analysis-worker.js";
export {
  formatSessionReadResult,
  readSessionForGoal,
} from "./extensions/ampi-history/read-session.js";
export type {
  SessionReadExcerpt,
  SessionReadResult,
} from "./extensions/ampi-history/read-session.js";
export {
  parseSessionQuery,
  tokenizeSessionQuery,
} from "./extensions/ampi-history/query.js";
export {
  resolveSessionById,
  searchSessions,
} from "./extensions/ampi-history/session-catalog.js";
export type {
  ResolvedSession,
  SearchSessionsOptions,
  SessionCatalogDeps,
  SessionSearchMatch,
} from "./extensions/ampi-history/session-catalog.js";
export { createSessionIndex } from "./extensions/ampi-history/session-index.js";
export type { SessionIndex } from "./extensions/ampi-history/session-index.js";
export {
  createDefaultMmrHistoryToolDeps,
  createFindSessionTool,
  createReadSessionTool,
  registerMmrHistoryTools,
} from "./extensions/ampi-history/tools.js";
export {
  AMPI_HISTORY_FEATURE_GATE,
  AMPI_HISTORY_PROVIDER_NAME,
  MMR_HISTORY_FEATURE_GATE,
  MMR_HISTORY_PROVIDER_NAME,
  createAmpiHistoryFeatureGateProvider,
  createAmpiHistoryToolProvider,
  createMmrHistoryFeatureGateProvider,
  createMmrHistoryToolProvider,
} from "./extensions/ampi-history/provider.js";
export type {
  FindSessionDetails,
  MmrHistoryToolDeps,
  ReadSessionDetails,
} from "./extensions/ampi-history/tools.js";
export type {
  CreateTodoListToolOptions,
  RefreshTodoWidgetOptions,
  TodoListDetails,
  TodoListErrorDetails,
} from "./extensions/ampi-tasks/todo-list-tool.js";

// --- ampi-web (Stable) ---
export type { MmrWebSettings, LoadedMmrWebSettings } from "./extensions/ampi-web/config.js";
export { DEFAULT_MAX_RESULT_BYTES, DEFAULT_TIMEOUT_MS, loadMmrWebSettings } from "./extensions/ampi-web/config.js";
export {
  AMPI_WEB_FEATURE_GATE,
  AMPI_WEB_PROVIDER_NAME,
  MMR_WEB_FEATURE_GATE,
  MMR_WEB_PROVIDER_NAME,
  createAmpiWebFeatureGateProvider,
  createAmpiWebToolProvider,
  createMmrWebFeatureGateProvider,
  createMmrWebToolProvider,
} from "./extensions/ampi-web/provider.js";
export { validateExternalHttpUrl } from "./extensions/ampi-web/url-policy.js";
export type { UrlValidationResult } from "./extensions/ampi-web/url-policy.js";
export { createAmpiWebExtension, createMmrWebExtension } from "./extensions/ampi-web/index.js";
export type { MmrWebFactoryOverrides } from "./extensions/ampi-web/index.js";

// --- ampi-github (Stable) ---
export type { MmrGithubSettings, LoadedMmrGithubSettings } from "./extensions/ampi-github/config.js";
export {
  AMPI_GITHUB_ENABLE_ENV,
  DEFAULT_GITHUB_API_BASE_URL,
  DEFAULT_GITHUB_MAX_RESULT_BYTES,
  DEFAULT_GITHUB_TIMEOUT_MS,
  MMR_GITHUB_ENABLE_ENV,
  loadMmrGithubSettings,
} from "./extensions/ampi-github/config.js";
export {
  AMPI_GITHUB_FEATURE_GATE,
  AMPI_GITHUB_PROVIDER_NAME,
  MMR_GITHUB_FEATURE_GATE,
  MMR_GITHUB_PROVIDER_NAME,
  createAmpiGithubFeatureGateProvider,
  createAmpiGithubToolProvider,
  createMmrGithubFeatureGateProvider,
  createMmrGithubToolProvider,
} from "./extensions/ampi-github/provider.js";
export {
  AMPI_GITHUB_TOOL_OWNER,
  AMPI_GITHUB_TOOL_NAMES,
  MMR_GITHUB_TOOL_NAMES,
  MMR_GITHUB_TOOL_OWNER,
  getAmpiGithubToolSourcePaths,
  registerAmpiGithubToolSourcePath,
  hasMmrGithubOwnedTools,
  isMmrGithubOwnedToolInfo,
  isMmrGithubToolName,
} from "./extensions/ampi-github/tool-ownership.js";
export type { AmpiGithubToolName, MmrGithubToolName, MmrGithubToolInfoLike } from "./extensions/ampi-github/tool-ownership.js";
export {
  GithubApiError,
  GithubRepoParseError,
  createGithubClient,
  parseGithubRepository,
} from "./extensions/ampi-github/client.js";
export type { GithubClient, GithubClientOptions, GithubRepoRef } from "./extensions/ampi-github/client.js";
export {
  MMR_GITHUB_PROMPT_GUIDELINES,
  registerMmrGithubTools,
} from "./extensions/ampi-github/tools.js";
export type { MmrGithubToolDeps } from "./extensions/ampi-github/tools.js";
export { createAmpiGithubExtension, createMmrGithubExtension } from "./extensions/ampi-github/index.js";
export type { MmrGithubFactoryOverrides } from "./extensions/ampi-github/index.js";

// --- ampi-workers: the merged worker extension (blocking subagent tools +
//     background task surface) and its providers (Stable;
//     ORACLE_DEFAULT_MODEL_PREFERENCES is an Internal/legacy convenience
//     constant). The pre-merge provider names and gate ids remain exported
//     for compatibility; the pre-merge extension factories
//     (createMmrSubagentsExtension / createMmrAsyncTasksExtension) are
//     REMOVED — use createMmrWorkersExtension. ---
export {
  AMPI_SUBAGENTS_OWNED_TOOLS,
  AMPI_SUBAGENTS_FEATURE_GATE,
  AMPI_SUBAGENTS_PROVIDER_NAME,
  MMR_SUBAGENTS_FEATURE_GATE,
  MMR_SUBAGENTS_OWNED_TOOLS,
  MMR_SUBAGENTS_PROVIDER_NAME,
  createAmpiSubagentsFeatureGateProvider,
  createAmpiSubagentsToolProvider,
  createMmrSubagentsFeatureGateProvider,
  createMmrSubagentsToolProvider,
} from "./extensions/ampi-workers/provider.js";
export {
  AMPI_ASYNC_TASK_TOOLS,
  AMPI_ASYNC_TASKS_FEATURE_GATE,
  AMPI_ASYNC_TASKS_PROVIDER_NAME,
  AMPI_SUBAGENTS_ASYNC_TASKS_FEATURE_GATE,
  AMPI_WORKERS_LEGACY_FEATURE_GATES,
  AMPI_WORKERS_FEATURE_GATE,
  AMPI_WORKERS_OWNED_TOOLS,
  AMPI_WORKERS_PROVIDER_NAME,
  MMR_ASYNC_TASKS_FEATURE_GATE,
  MMR_ASYNC_TASKS_PROVIDER_NAME,
  MMR_ASYNC_TASK_TOOLS,
  MMR_SUBAGENTS_ASYNC_TASKS_FEATURE_GATE,
  MMR_SUBAGENTS_ASYNC_TASK_TOOLS,
  MMR_WORKERS_FEATURE_GATE,
  MMR_WORKERS_LEGACY_FEATURE_GATES,
  MMR_WORKERS_OWNED_TOOLS,
  MMR_WORKERS_PROVIDER_NAME,
  createAmpiAsyncTasksFeatureGateProvider,
  createAmpiAsyncTasksToolProvider,
  createAmpiWorkersFeatureGateProvider,
  createAmpiWorkersToolProvider,
  createMmrAsyncTasksFeatureGateProvider,
  createMmrAsyncTasksToolProvider,
  createMmrWorkersFeatureGateProvider,
  createMmrWorkersToolProvider,
} from "./extensions/ampi-workers/provider.js";
export { createAmpiWorkersExtension, createMmrWorkersExtension } from "./extensions/ampi-workers/index.js";
export type { MmrWorkersFactoryOverrides } from "./extensions/ampi-workers/index.js";
export type { MmrAsyncTasksCapabilities } from "./extensions/ampi-workers/provider.js";
export type { MmrSubagentsCapabilities } from "./extensions/ampi-workers/provider.js";
export type { MmrWorkersCapabilities } from "./extensions/ampi-workers/provider.js";
export {
  FINDER_DEFAULT_MODEL_PREFERENCES,
  FINDER_DESCRIPTION,
  FINDER_PARAMETERS_SCHEMA,
  FINDER_PROGRESS_PLACEHOLDER,
  FINDER_PROMPT_GUIDELINES,
  FINDER_PROMPT_SNIPPET,
  FINDER_TOOL_NAME,
  FINDER_WORKER_TOOLS,
  buildFinderWorkerSystemPrompt,
  createFinderTool,
  registerFinderTool,
} from "./extensions/ampi-workers/builtin-workers/finder.js";
export type { FinderDetails, FinderParams, FinderToolDeps } from "./extensions/ampi-workers/builtin-workers/finder.js";
export {
  DEFAULT_ORACLE_PER_FILE_BYTE_LIMIT,
  ORACLE_DEFAULT_MODEL_PREFERENCES,
  ORACLE_DESCRIPTION,
  ORACLE_PARAMETERS_SCHEMA,
  ORACLE_PROGRESS_PLACEHOLDER,
  ORACLE_PROMPT_GUIDELINES,
  ORACLE_PROMPT_SNIPPET,
  ORACLE_TOOL_NAME,
  ORACLE_WORKER_TOOLS,
  buildOracleWorkerSystemPrompt,
  createMmrAdvisorTool,
  createOracleTool,
  registerOracleTool,
  requireMmrAdvisorProfile,
} from "./extensions/ampi-workers/builtin-workers/oracle.js";
export type {
  MmrAdvisorToolConfig,
  MmrAdvisorToolDeps,
  OracleAttachmentRecord,
  OracleDetails,
  OracleParams,
  OracleToolDeps,
} from "./extensions/ampi-workers/builtin-workers/oracle.js";
export {
  LIBRARIAN_DESCRIPTION,
  LIBRARIAN_GATING_REASON,
  LIBRARIAN_PARAMETERS_SCHEMA,
  LIBRARIAN_PROGRESS_PLACEHOLDER,
  LIBRARIAN_PROMPT_GUIDELINES,
  LIBRARIAN_PROMPT_SNIPPET,
  LIBRARIAN_SUBAGENT_PROFILE_NAME,
  LIBRARIAN_TOOL_NAME,
  LIBRARIAN_WORKER_TOOLS,
  MmrLibrarianContextWindowError,
  buildLibrarianWorkerSystemPrompt,
  createLibrarianTool,
  isLibrarianGithubToolPrerequisiteRegistered,
  registerLibrarianTool,
} from "./extensions/ampi-workers/builtin-workers/librarian.js";
export type {
  LibrarianDetails,
  LibrarianParams,
  LibrarianStatus,
  LibrarianToolDeps,
  ResolveLibrarianInvocationInput,
} from "./extensions/ampi-workers/builtin-workers/librarian.js";
export {
  REVIEWER_DESCRIPTION,
  REVIEWER_PARAMETERS_SCHEMA,
  REVIEWER_PROGRESS_PLACEHOLDER,
  REVIEWER_PROMPT_GUIDELINES,
  REVIEWER_PROMPT_SNIPPET,
  REVIEWER_SUBAGENT_PROFILE,
  REVIEWER_TOOL_NAME,
  REVIEWER_WORKER_TOOLS,
  buildReviewerUserPrompt,
  buildReviewerWorkerSystemPrompt,
  createReviewerTool,
  registerReviewerTool,
} from "./extensions/ampi-workers/builtin-workers/reviewer.js";
export type {
  ReviewerDetails,
  ReviewerParams,
  ReviewerToolDeps,
} from "./extensions/ampi-workers/builtin-workers/reviewer.js";
export {
  buildHistoryReaderWorkerSystemPrompt,
  registerMmrHistoryPromptBuilders,
} from "./extensions/ampi-history/prompts.js";
export {
  buildLibrarianWorkerSystemPrompt as buildLibrarianWorkerRolePrompt,
} from "./extensions/ampi-workers/profiles/prompts.js";
// Note: the worker outcome discriminator type is intentionally NOT
// re-exported from the package root. The legacy task-list coordination
// type that previously occupied that name is gone (see
// tests/mmr-pi-root-todo-exports.test.mjs negative guard), and re-exporting
// any matching identifier would conflict with that guard's source-text
// check. Consumers that need the new type can import it from the deep path
// `./extensions/ampi-workers/task.js` instead.
export {
  TASK_DESCRIPTION,
  TASK_DESCRIPTION_MAX_BYTES,
  TASK_PARAMETERS_SCHEMA,
  TASK_PROGRESS_PLACEHOLDER,
  TASK_PROMPT_GUIDELINES,
  TASK_PROMPT_MAX_BYTES,
  TASK_PROMPT_SNIPPET,
  TASK_SUBAGENT_PROFILE,
  TASK_TOOL_NAME,
  TASK_WORKER_TOOLS,
  TaskParamsError,
  buildTaskFinalResult,
  buildTaskProgressResult,
  buildTaskWorkerSystemPrompt,
  classifyTaskOutcome,
  coerceTaskParams,
  createTaskTool,
  hasUsableTaskFinalText,
  registerTaskTool,
  resolveTaskRunner,
} from "./extensions/ampi-workers/builtin-workers/task.js";
export type {
  ResolveTaskInvocationInput,
  TaskDetails,
  TaskDetailsContext,
  TaskOutcomeInput,
  TaskParams,
  TaskToolDeps,
  TaskWorkerSystemPromptInput,
} from "./extensions/ampi-workers/builtin-workers/task.js";
export {
  AMPI_SUBAGENTS_ASYNC_PUSH_ENV,
  ASYNC_TASK_AGENT_NAMES,
  ASYNC_TASK_TOOL_NAMES,
  MMR_SUBAGENTS_ASYNC_PUSH_ENV,
  START_TASK_TOOL_NAME,
  TASK_CANCEL_TOOL_NAME,
  TASK_POLL_TOOL_NAME,
  TASK_WAIT_TOOL_NAME,
  createStartTaskTool,
  createTaskCancelTool,
  createTaskPollTool,
  createTaskWaitTool,
  registerAsyncTaskTools,
} from "./extensions/ampi-workers/background/async-task-tools.js";
export type {
  AsyncTaskAgentName,
  AsyncTaskToolDeps,
  AsyncTaskToolDetails,
} from "./extensions/ampi-workers/background/async-task-tools.js";
export {
  ASYNC_TASK_CANCEL_DEAD_AFTER_MS,
  ASYNC_TASK_MAX_RUNTIME_MS,
  ASYNC_TASK_OBSERVED_TERMINAL_TTL_MS,
  ASYNC_TASK_STALLED_AFTER_MS,
  ASYNC_TASK_TERMINAL_TTL_MS,
  DEFAULT_ASYNC_TASK_MAX_PUSHES_PER_SESSION,
  DEFAULT_ASYNC_TASK_MAX_RUNNING_PER_SESSION,
  DEFAULT_TASK_WAIT_TIMEOUT_MS,
  MAX_TASK_WAIT_TIMEOUT_MS,
  createMmrAsyncTaskRegistry,
  getMmrAsyncTaskRegistry,
  isValidAsyncTaskGroupId,
  toPublicAsyncTaskSnapshot,
} from "./extensions/ampi-workers/background/async-task-registry.js";
export type {
  MmrAsyncTaskBoard,
  MmrAsyncTaskBoardEntry,
  MmrAsyncTaskFreshness,
  MmrAsyncTaskGroupSnapshot,
  MmrAsyncTaskGroupStatus,
  MmrAsyncTaskInternalSnapshot,
  MmrAsyncTaskRegistry,
  MmrAsyncTaskRegistryDeps,
  MmrAsyncTaskSnapshot,
  MmrAsyncTaskStatus,
  StartAsyncTaskArgs,
  StartAsyncTaskResult,
  WaitForAsyncTaskResult,
} from "./extensions/ampi-workers/background/async-task-registry.js";
export {
  DEFAULT_MMR_WORKER_KILL_TIMEOUT_MS,
  DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT,
  DEFAULT_MMR_WORKER_PARTIAL_OUTPUT_POLICY,
  MMR_SUBAGENT_DETAILS_STATUS_VALUES,
  MMR_WORKER_INLINE_PROMPT_BYTE_LIMIT,
  MMR_WORKER_OUTCOME_STATUS_VALUES,
  MMR_WORKER_TRAIL_LIMIT,
  buildMmrWorkerArgs,
  classifyMmrWorkerOutcome,
  classifyMmrWorkerOutcomeForProfile,
  deriveAsyncTerminalOutcome,
  resolveMmrWorkerPartialOutputPolicy,
  createChildCliMmrSubagentRunner,
  createMmrSubagentRunnerFromRunWorker,
  emptyMmrWorkerUsageStats,
  getMmrWorkerFinalOutput,
  hasUsableMmrWorkerFinalOutput,
  resolveMmrWorkerPiInvocation,
  resolveMmrWorkerPiInvocationFromEnv,
  runMmrSubagentWorker,
  truncateMmrWorkerOutput,
} from "./extensions/ampi-workers/framework/runner.js";
export type {
  ClassifyMmrWorkerOutcomeOptions,
  MmrAsyncTerminalOutcome,
  MmrSubagentDetailsStatus,
  MmrSpawnedSubagentWorkerDetailsBase,
  MmrSubagentRunOptions,
  MmrSubagentRunProgress,
  MmrSubagentRunner,
  MmrSubagentWorkerDetailsBase,
  MmrSubagentWorkerRunResult,
  MmrWorkerInvocation,
  MmrWorkerOutcomeStatus,
  MmrWorkerMessage,
  MmrWorkerPiInvocationEnv,
  MmrWorkerProcess,
  MmrWorkerProgressSnapshot,
  MmrWorkerResult,
  MmrWorkerRunnerDeps,
  MmrWorkerSpawn,
  MmrWorkerTrailItem,
  MmrWorkerUsageStats,
  RunMmrSubagentWorkerOptions,
} from "./extensions/ampi-workers/framework/runner.js";
export {
  AMPI_CUSTOM_SUBAGENTS_FEATURE_GATE,
  AMPI_CUSTOM_SUBAGENTS_PROVIDER_NAME,
  MMR_CUSTOM_SUBAGENTS_FEATURE_GATE,
  MMR_CUSTOM_SUBAGENTS_PROVIDER_NAME,
  createAmpiCustomSubagentsFeatureGateProvider,
  createAmpiCustomSubagentsToolProvider,
  createMmrCustomSubagentsFeatureGateProvider,
  createMmrCustomSubagentsToolProvider,
} from "./extensions/ampi-custom-subagents/provider.js";
export { createAmpiCustomSubagentsExtension, createMmrCustomSubagentsExtension } from "./extensions/ampi-custom-subagents/index.js";
export type { MmrCustomSubagentsFactoryOverrides } from "./extensions/ampi-custom-subagents/index.js";
export type { MmrCustomSubagentsCapabilities } from "./extensions/ampi-custom-subagents/provider.js";
export {
  DEFAULT_MMR_CUSTOM_SUBAGENT_MAX_SCAN_DEPTH,
  MMR_CUSTOM_SUBAGENT_MAX_FILE_BYTES,
  MMR_CUSTOM_SUBAGENT_MAX_TOOL_NAME_LENGTH,
  MMR_CUSTOM_SUBAGENT_TOOL_PREFIX,
  discoverMmrCustomSubagents,
  normalizeMmrCustomSubagentToolPatterns,
  parseMmrCustomSubagentMarkdown,
  toMmrCustomSubagentToolName,
} from "./extensions/ampi-custom-subagents/custom-loader.js";
export type {
  DiscoverMmrCustomSubagentsArgs,
  MmrCustomSubagentDefinition,
  ParseMmrCustomSubagentMarkdownArgs,
} from "./extensions/ampi-custom-subagents/custom-loader.js";
