import type {
  AgentToolResult,
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { MMR_BACKGROUND_RUN_PARAMETER_FIELDS } from "../background/background-dispatch.js";
import { checkMmrToolParams } from "../../ampi-core/tool-params.js";
import { registerAmpiOwnedTool } from "../../ampi-core/owned-tools.js";
import {
  assembleMmrSubagentSurface,
  getMmrSubagentPromptBuilder,
  registerMmrSubagentPromptBuilder,
  unregisterMmrSubagentPromptBuilder,
} from "../../ampi-core/subagent-prompt-assembly.js";
import { getMmrSubagentProfile } from "../../ampi-core/subagent-profiles.js";
import {
  resolveMmrSubagentInvocation,
  type MmrSubagentInvocation,
} from "../../ampi-core/subagent-resolver.js";
import { loadMmrCoreSettings, type LoadedMmrCoreSettings } from "../../ampi-core/settings.js";
import type { MmrModelPreference } from "../../ampi-core/types.js";
import { REVIEWER_BACKGROUND_GUIDANCE } from "../../ampi-core/worker-tool-guidance.js";
import { buildReviewerWorkerSystemPrompt as buildReviewerWorkerSystemPromptFromPrompts } from "../profiles/prompts.js";
import { resolveEffectiveRunner } from "../framework/worker-fallback-run.js";
import {
  clipMmrWorkerDescription,
  createWorkerRunPreparer,
  createWorkerTool,
  resolveWorkerModelPreferencesOverride,
  syntheticAbortedWorkerResult,
  type MmrPreparedWorkerRun,
  type MmrWorkerRunPreparer,
  type MmrWorkerToolResolveInput,
  type MmrWorkerToolSpec,
} from "../framework/worker-tool-factory.js";
import { resolveWorkerCwd, type ToolHostLike } from "../framework/worker-host.js";
import {
  AMPI_REVIEW_NO_COUNTED_FINDINGS_LABEL,
  countAmpiReviewFindings,
  planAmpiReviewChecks,
  type AmpiReviewCheck,
  type AmpiReviewCheckEnv,
  type AmpiReviewCheckPlan,
  type AmpiReviewCheckSelection,
  type AmpiReviewRepositoryKind,
} from "../review/checks.js";
import {
  resolveCtxMmrModelRegistry,
  resolveMmrWorkerModelContextWindowFromCtx,
} from "../worker-model-metadata.js";
import {
  classifyMmrWorkerOutcomeForProfile,
  type MmrSpawnedSubagentWorkerDetailsBase,
  type MmrWorkerOutcomeStatus,
  type MmrSubagentRunner,
  type MmrWorkerProgressSnapshot,
  type MmrWorkerResult,
  type MmrWorkerRunnerDeps,
  runMmrSubagentWorker,
} from "../framework/runner.js";
import {
  buildSpawnedFinalDetailsBase,
  buildSpawnedProgressDetailsBase,
} from "../worker-result-shaping.js";

export const REVIEWER_TOOL_NAME = "reviewer";

export const REVIEWER_SUBAGENT_PROFILE = "reviewer";

function requireReviewerProfile() {
  const profile = getMmrSubagentProfile(REVIEWER_SUBAGENT_PROFILE);
  if (!profile) {
    throw new Error(
      `ampi-core does not expose a "${REVIEWER_SUBAGENT_PROFILE}" subagent profile; reviewer cannot run without it.`,
    );
  }
  return profile;
}

/**
 * Read-only review tool allowlist passed through `pi --tools` to the
 * isolated review subprocess: local reads/searches plus bash for the
 * whitelisted merge-base git diff commands. The worker prompt forbids
 * edits and git state mutation.
 *
 * Source of truth: the `reviewer` subagent profile in ampi-core. This
 * export is a derived constant for callers and tests; the profile remains
 * authoritative at runtime.
 */
export const REVIEWER_WORKER_TOOLS: readonly string[] = Object.freeze([
  ...requireReviewerProfile().tools,
]);

export const REVIEWER_PROMPT_SNIPPET =
  "Run an expert review of a code diff (uncommitted work, branch or staged changes) and return prioritized findings";

/**
 * Single routing guideline for Pi's `<rules>` section. The full when/how
 * guidance lives only in {@link REVIEWER_DESCRIPTION} (the schema the
 * model already receives); cross-worker policy renders once in the
 * `## Using workers` block (`ampi-core/worker-tool-guidance.ts`).
 */
export const REVIEWER_PROMPT_GUIDELINES: readonly string[] = [
  "Use reviewer when a unit of work is complete or the user asks for a review of changes: pass a natural-language description of which diff to review (the worker computes and reads the diff itself). The reviewer is read-only and reports findings; acting on them stays with you.",
];

export const REVIEWER_DESCRIPTION = [
  "Review code changes, diffs, outstanding changes, or modified files: an independent expert reviewer reads the diff in a fresh context and returns a prioritized findings report (severity, file, line range, suggested fix).",
  "",
  REVIEWER_BACKGROUND_GUIDANCE,
  "",
  "It takes a description of the diff or code change that can be used to generate the full diff, which is then reviewed. Do not run git diff or any other tool to generate the diff yourself; pass a natural language description of how to compute the diff in diff_description (it may name a git command or describe the changes, e.g. \"all uncommitted changes\" or \"the changes on this branch since diverging from the upstream default branch\").",
  "",
  "WHEN TO USE THIS TOOL:",
  "- A coherent unit of work is complete and you want an independent review before finalizing",
  "- The user asks to review changes, check code quality, or analyze uncommitted work",
  "- You want a second model to catch bugs, hackiness, or abstraction problems in a diff",
  "",
  "WHEN NOT TO USE THIS TOOL:",
  "- Reviewing code that is not a change — read the files directly instead",
  "- Generating or applying fixes — the reviewer is read-only and only reports findings",
  "- Very large diffs (more than ~100 changed files or ~10,000 lines); the reviewer aborts those with a single critical finding",
  "",
  "USAGE GUIDELINES:",
  "1. Describe which diff to review, not its contents; the worker computes and reads the diff itself.",
  "2. Use files to focus the review on specific paths and instructions to set emphasis (e.g. \"focus on concurrency\").",
  "3. Relay the important findings to the user and act on the ones you agree with; the reviewer never edits files.",
  "4. Review checks are standing rules kept as Markdown files under .agents/checks/ in the repository. Each check whose directory holds changed files runs as its own reviewer, and its outcome is listed after the main report; checks_only, check_filter and check_scope narrow which ones run.",
].join("\n");

export const REVIEWER_PARAMETERS_SCHEMA = Type.Object(
  {
    diff_description: Type.String({
      description:
        "A description of the diff or code change that can be used to generate the full diff. This can include a git command to generate the diff or a description of the change which the reviewer turns into the right git command itself.",
    }),
    files: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Specific files to focus the review on. If empty, all changed files covered by the diff description are reviewed.",
      }),
    ),
    instructions: Type.Optional(
      Type.String({
        description: "Additional instructions to guide the review (e.g. areas of emphasis).",
      }),
    ),
    checks_only: Type.Optional(
      Type.Boolean({
        description:
          "Run only the review checks from .agents/checks/ that apply to the change, without the main review. Fails when no check applies.",
      }),
    ),
    check_filter: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Names of the review checks to run (the front-matter name, or the file name without .md). Other checks are skipped; an unknown name is an error that lists the available checks.",
      }),
    ),
    check_scope: Type.Optional(
      Type.String({
        description:
          "Run only the review checks defined in this directory (relative to the working directory) or in directories below it.",
      }),
    ),
    ...MMR_BACKGROUND_RUN_PARAMETER_FIELDS,
  },
  { additionalProperties: false },
);

export const reviewerParameters = REVIEWER_PARAMETERS_SCHEMA;

export type ReviewerParams = Static<typeof REVIEWER_PARAMETERS_SCHEMA>;

/**
 * Outcome of one review check: `pending` / `running` appear only in progress
 * details. `no-issues` means the check answered with no counted finding (see
 * `countAmpiReviewFindings`), not that its report is free of findings.
 */
export type ReviewerCheckStatus = "pending" | "running" | "no-issues" | "findings" | "failed";

/** Per-check entry of {@link ReviewerDetails.checks}. */
export interface ReviewerCheckDetails {
  name: string;
  /** Directory that contains the check's `.agents`, relative to the repository root; `.` for the root. */
  scope: string;
  /** The check file, relative to the repository root. */
  file: string;
  status: ReviewerCheckStatus;
  /** Findings in the check's report (see `countAmpiReviewFindings`); 0 unless `status` is `findings`. */
  findings: number;
  /** One-line reason, set when `status` is `failed`. */
  failureReason?: string;
  /** Front-matter warning for the check file. */
  warning?: string;
  /** Changed files under the scope, when the parent could resolve them. */
  changedFiles?: string[];
}

export interface ReviewerDetails extends MmrSpawnedSubagentWorkerDetailsBase {
  worker: "ampi-workers.reviewer";
  // Final-run outcome from the shared classifier. The renderer reads this
  // first, so a successful run that merely preserved a non-fatal provider
  // `errorMessage` still renders as completed instead of failed. With
  // review checks it is the call's outcome: `success` when any run
  // succeeded, while the other fields still describe the main review.
  status?: MmrWorkerOutcomeStatus;
  /** Review checks that ran, in report order. Absent when no check applied. */
  checks?: ReviewerCheckDetails[];
  /**
   * Outcome of the main review when checks ran: `skipped` under
   * `checks_only`, in which case the other worker fields describe the
   * check run the call reports through.
   */
  mainReview?: MmrWorkerOutcomeStatus | "skipped";
}

/** Reviewer children that run at once, the main review included. */
export const REVIEWER_MAX_CONCURRENT_RUNS = 4;

/** Compact "thinking" status surfaced to the model before the worker finishes. */
export const REVIEWER_PROGRESS_PLACEHOLDER = "reviewer: reviewing changes…";

/**
 * Build the reviewer worker system prompt. Re-exported here for
 * symmetry with the other worker modules; the canonical owner is
 * `ampi-workers/profiles/prompts.ts`, which also registers the reviewer builder
 * against ampi-core's prompt-assembly registry.
 */
export function buildReviewerWorkerSystemPrompt(cwd: string): string {
  return buildReviewerWorkerSystemPromptFromPrompts(cwd);
}

/**
 * Build the worker task text: the diff description verbatim, then the
 * optional files focus and extra instructions. The report format is part
 * of the system prompt, not the task text.
 */
export function buildReviewerUserPrompt(params: {
  diff_description: string;
  files?: readonly string[];
  instructions?: string;
}): string {
  const parts = [`Review the following diff: ${params.diff_description}`];
  const files = (params.files ?? []).map((file) => file.trim()).filter((file) => file.length > 0);
  if (files.length > 0) {
    parts.push(`Focus the review on these files:\n${files.map((file) => `- ${file}`).join("\n")}`);
  }
  const instructions = params.instructions?.trim() ?? "";
  if (instructions.length > 0) {
    parts.push(instructions);
  }
  return parts.join("\n\n");
}

function scopeLabel(scope: string): string {
  return scope === "." ? "the repository root" : scope;
}

/**
 * Build the task text of one review-check child: the main review's task
 * line for the diff, then which check applies, its scope directory, the
 * changed files under that scope when the parent resolved them, how to get
 * the diff in a Jujutsu repository, the check's description and its body
 * as the instructions to apply.
 */
export function buildReviewerCheckUserPrompt(input: {
  diff_description: string;
  check: Pick<AmpiReviewCheck, "name" | "file" | "scope" | "description" | "instructions">;
  repositoryRoot: string;
  repositoryKind: AmpiReviewRepositoryKind;
  changedFiles?: readonly string[];
}): string {
  const { check } = input;
  const scope = scopeLabel(check.scope);
  const parts = [
    buildReviewerUserPrompt({ diff_description: input.diff_description }),
    `This review applies a single review check, "${check.name}", defined in ${check.file}: report only what the check asks about.`,
  ];
  const where = `Scope: ${scope}. Review only changed files under ${check.scope === "." ? "it" : "this directory"}; paths are relative to the repository root, ${input.repositoryRoot}.`;
  if (input.changedFiles !== undefined) {
    parts.push(`${where}\nChanged files in scope:\n${input.changedFiles.map((file) => `- ${file}`).join("\n")}`);
  } else {
    parts.push(`${where}\nThe changed files were not resolved in advance: work out which files the diff touches and keep to those under ${scope}.`);
  }
  if (input.repositoryKind === "jj") {
    parts.push("This is a Jujutsu repository: get the diff with `jj diff --git` (add `-r <revision>`, or `--from` and `--to`, when the description names revisions) instead of the git commands.");
  }
  if (check.description !== undefined && check.description.trim().length > 0) {
    parts.push(`Check description: ${check.description.trim()}`);
  }
  const instructions = check.instructions.trim();
  parts.push(
    instructions.length > 0
      ? `Check instructions:\n\n${instructions}`
      : "Check instructions: the check file has no body; apply its description.",
  );
  return parts.join("\n\n");
}

function coerceReviewerParams(raw: unknown): ReviewerParams {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("reviewer expects an object with a `diff_description` field.");
  }
  const params = checkMmrToolParams(REVIEWER_TOOL_NAME, REVIEWER_PARAMETERS_SCHEMA, raw);
  if (params.diff_description.trim().length === 0) {
    throw new Error("reviewer.diff_description is required and must be a non-empty string.");
  }
  return params;
}

export interface ReviewerToolDeps {
  /**
   * Generic subagent runner. When set, reviewer uses this instead of
   * the default child-CLI runner. Preferred entry point for new callers.
   */
  runner?: MmrSubagentRunner;
  /**
   * Legacy seam: run the underlying Pi subagent worker directly. Retained
   * for parity with the other worker tools' test seams. Prefer
   * {@link ReviewerToolDeps.runner}; when both are set, `runner` wins.
   */
  runWorker?: typeof runMmrSubagentWorker;
  /**
   * Override the ordered worker-model preference list. Wins over both the
   * settings-driven `subagentModelPreferences.reviewer` block and the
   * profile defaults.
   */
  modelPreferences?: readonly MmrModelPreference[];
  /**
   * Settings-driven override: wins over the profile defaults but loses to
   * an explicit `modelPreferences`. When omitted, `execute()` reads
   * `loadMmrCoreSettings(cwd).settings.subagentModelPreferences["reviewer"]`
   * on every invocation so a `/ampi-config` update takes effect on the
   * next call, matching the child activation path.
   */
  subagentModelPreferencesOverride?: readonly MmrModelPreference[];
  /** Settings loader seam. Defaults to `loadMmrCoreSettings(cwd)`. */
  loadSubagentModelPreferences?: (cwd: string) =>
    | Pick<LoadedMmrCoreSettings["settings"], "subagentModelPreferences">
    | undefined;
  /** Override the worker output byte cap. */
  outputByteLimit?: number;
  /** Override prompt text while still flowing through the subagent surface API. Tests inject deterministic text. */
  buildSystemPrompt?: (cwd: string) => string;
  /** Pi host, captured by registerReviewerTool so child startup can keep provider/extension paths. */
  pi?: ToolHostLike;
  /** Forwarded to the underlying runner (custom spawner / invocation resolver seams). */
  runnerDeps?: MmrWorkerRunnerDeps;
  /**
   * File and command seams review-check discovery reads through. Defaults
   * to the real file system and `git` / `jj` commands.
   */
  reviewCheckEnv?: AmpiReviewCheckEnv;
}

function buildProgressDetails(
  snapshot: MmrWorkerProgressSnapshot,
  resolvedModel: string | undefined,
  cwd: string,
  contextWindow: number | undefined,
): ReviewerDetails {
  const base = buildSpawnedProgressDetailsBase({
    snapshot,
    cwd,
    workerTools: REVIEWER_WORKER_TOOLS,
    ...(resolvedModel !== undefined ? { resolvedModel } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  });
  return { worker: "ampi-workers.reviewer", ...base };
}

function buildDetails(
  result: MmrWorkerResult,
  resolvedModel: string | undefined,
  cwd: string,
  contextWindow: number | undefined,
): ReviewerDetails {
  const base = buildSpawnedFinalDetailsBase({
    result,
    cwd,
    workerTools: REVIEWER_WORKER_TOOLS,
    ...(resolvedModel !== undefined ? { resolvedModel } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  });
  const status = classifyMmrWorkerOutcomeForProfile(result, requireReviewerProfile());
  return { worker: "ampi-workers.reviewer", status, ...base };
}

function buildFinalContent(result: MmrWorkerResult): string {
  // Failure-state precedence is owned by the shared worker-outcome
  // classifier under the reviewer profile's fail-on-nonzero policy;
  // the messages below mirror that precedence with reviewer phrasing.
  const outcome = classifyMmrWorkerOutcomeForProfile(result, requireReviewerProfile());
  if (outcome === "spawn-error") {
    const reason = result.spawnError ?? result.errorMessage ?? "unknown spawn error";
    return `reviewer: worker spawn failed: ${reason}`;
  }
  if (outcome === "activation-error") {
    return `reviewer: subagent activation failed: ${result.subagentActivationError}`;
  }
  if (outcome === "aborted") {
    return "reviewer: the review was cancelled before producing a report.";
  }
  if (outcome === "worker-error") {
    const tail = result.stderr.trim().split("\n").slice(-3).join("\n");
    const detailText = tail.length > 0 ? tail : (result.errorMessage ?? "");
    const detail = detailText.length > 0 ? `\n\n${detailText}` : "";
    return `reviewer: worker exited with code ${result.exitCode ?? "null"}.${detail}`;
  }
  if (outcome === "no-agent-start") {
    const tail = result.stderr.trim().split("\n").slice(-3).join("\n");
    const detail = tail.length > 0 ? `\n\n${tail}` : "";
    return `reviewer: worker exited before the agent loop started. The prompt was not processed by the worker model; another Pi extension's input handler likely consumed it. Check stderr for extension diagnostics.${detail}`;
  }
  if (outcome === "success") {
    return result.truncatedFinalOutput || result.finalOutput;
  }
  // empty-output
  if (result.errorMessage && result.errorMessage.length > 0) {
    return `reviewer: worker reported an error: ${result.errorMessage}`;
  }
  return "reviewer: the review produced no report. Check the diff description and try again.";
}

function assembleReviewerSystemPrompt(
  cwd: string,
  buildSystemPrompt: ((cwd: string) => string) | undefined,
): string {
  const profile = requireReviewerProfile();
  if (!buildSystemPrompt) {
    return assembleMmrSubagentSurface({
      profile,
      baseSystemPrompt: "",
      activeToolManifest: [],
      cwd,
    }).systemPrompt;
  }

  const previous = getMmrSubagentPromptBuilder(profile.promptBuilder);
  registerMmrSubagentPromptBuilder(profile.promptBuilder, ({ cwd: builderCwd }) => buildSystemPrompt(builderCwd));
  try {
    return assembleMmrSubagentSurface({
      profile,
      baseSystemPrompt: "",
      activeToolManifest: [],
      cwd,
    }).systemPrompt;
  } finally {
    if (previous) registerMmrSubagentPromptBuilder(profile.promptBuilder, previous);
    else unregisterMmrSubagentPromptBuilder(profile.promptBuilder);
  }
}

/**
 * Default parent-side invocation resolution: the shared
 * `resolveMmrSubagentInvocation` against `ctx.modelRegistry`. The
 * reviewer spec runs in degrade mode (the finder contract): a
 * resolution failure means "spawn with no explicit --model and let the
 * child resolve the route" rather than a pre-spawn error.
 */
function resolveReviewerInvocation(
  input: MmrWorkerToolResolveInput,
): MmrSubagentInvocation {
  const profile = requireReviewerProfile();
  const registry = resolveCtxMmrModelRegistry(input.ctx);
  if (!registry) {
    return {
      ok: false,
      profile,
      code: "model.no-route",
      message: "reviewer could not resolve a model registry from the extension context; expected ctx.modelRegistry to expose getAll/find.",
      tools: profile.tools,
      promptRoute: profile.promptRoute,
      candidates: [],
      diagnostics: [],
      workerTools: [],
      toolResolution: {
        intendedTools: [...profile.tools],
        deniedTools: profile.denyTools ?? [],
        omittedTools: [],
      },
    };
  }
  return resolveMmrSubagentInvocation({
    profile,
    registry,
    ...(input.registeredTools !== undefined ? { registeredTools: input.registeredTools } : {}),
    ...(input.modelPreferencesOverride !== undefined
      ? { modelPreferencesOverride: input.modelPreferencesOverride }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// Review checks: one extra reviewer child per check that applies
// ---------------------------------------------------------------------------

/** One check child of a reviewer call. */
interface ReviewerCheckRun {
  selection: AmpiReviewCheckSelection;
  state: "pending" | "running" | "settled";
  result?: MmrWorkerResult;
}

/**
 * Per-call state shared by the main run, the check children and the result
 * projection (the spec's run data). Absent when no check applies, so such a
 * call keeps the reviewer's original content and details.
 */
interface ReviewerRunState {
  plan: AmpiReviewCheckPlan;
  checksOnly: boolean;
  checks: ReviewerCheckRun[];
  mainResult?: MmrWorkerResult;
}

function isReviewerSuccess(result: MmrWorkerResult): boolean {
  return classifyMmrWorkerOutcomeForProfile(result, requireReviewerProfile()) === "success";
}

function oneLine(text: string, max = 240): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** One-line reason a failed reviewer run gives, in the same precedence as {@link buildFinalContent}. */
function reviewerFailureReason(result: MmrWorkerResult): string {
  const outcome = classifyMmrWorkerOutcomeForProfile(result, requireReviewerProfile());
  const lastStderrLine = result.stderr.trim().split("\n").at(-1)?.trim() ?? "";
  switch (outcome) {
    case "spawn-error":
      return oneLine(`worker spawn failed: ${result.spawnError ?? result.errorMessage ?? "unknown spawn error"}`);
    case "activation-error":
      return oneLine(`subagent activation failed: ${result.subagentActivationError}`);
    case "aborted":
      return "cancelled";
    case "worker-error": {
      const detail = result.errorMessage ?? lastStderrLine;
      return oneLine(`worker exited with code ${result.exitCode ?? "null"}${detail ? `: ${detail}` : ""}`);
    }
    case "no-agent-start":
      return "the worker exited before the agent loop started";
    case "success":
      return "";
    default:
      return result.errorMessage ? oneLine(`worker reported an error: ${result.errorMessage}`) : "the check produced no report";
  }
}

function reviewerReportText(result: MmrWorkerResult): string {
  return (result.truncatedFinalOutput || result.finalOutput).trim();
}

function checkRunDetails(run: ReviewerCheckRun, final: boolean): ReviewerCheckDetails {
  const { check, changedFiles } = run.selection;
  const base = {
    name: check.name,
    scope: check.scope,
    file: check.file,
    ...(check.warning !== undefined ? { warning: check.warning } : {}),
    ...(changedFiles !== undefined ? { changedFiles: [...changedFiles] } : {}),
  };
  const result = run.result;
  if (!result) {
    // A projection before the run settled (the registry finalized a
    // cancelled call first) reports the unsettled checks as cancelled.
    if (final) return { ...base, status: "failed", findings: 0, failureReason: "cancelled" };
    return { ...base, status: run.state === "running" ? "running" : "pending", findings: 0 };
  }
  if (!isReviewerSuccess(result)) {
    return { ...base, status: "failed", findings: 0, failureReason: reviewerFailureReason(result) };
  }
  const findings = countAmpiReviewFindings(reviewerReportText(result));
  return { ...base, status: findings > 0 ? "findings" : "no-issues", findings };
}

function checkOutcomeLabel(details: ReviewerCheckDetails): string {
  if (details.status === "failed") return `failed: ${details.failureReason ?? "unknown reason"}`;
  if (details.status === "findings") return `${details.findings} ${details.findings === 1 ? "finding" : "findings"}`;
  if (details.status === "no-issues") return AMPI_REVIEW_NO_COUNTED_FINDINGS_LABEL;
  return details.status;
}

/**
 * The `Checks` section after the main report: a heading per check with its
 * scope and outcome, the check's report below it whenever the check
 * answered, then the front-matter warnings. The findings count only labels
 * the heading: a report whose findings use a shape the counter does not
 * recognize still reaches the parent in full.
 */
function buildChecksSection(state: ReviewerRunState): string {
  const parts = ["## Checks"];
  for (const run of state.checks) {
    const details = checkRunDetails(run, true);
    const scope = details.scope === "." ? "repository root" : details.scope;
    parts.push(`### ${details.name} (${scope}): ${checkOutcomeLabel(details)}`);
    const report = details.status !== "failed" && run.result ? reviewerReportText(run.result) : "";
    if (report.length > 0) parts.push(report);
  }
  const warnings = state.checks.flatMap((run) => (run.selection.check.warning ? [run.selection.check.warning] : []));
  if (warnings.length > 0) parts.push(`Warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`);
  return parts.join("\n\n");
}

/** Every run of the call that has a result, the main review first. */
function settledRunResults(state: ReviewerRunState): MmrWorkerResult[] {
  const results: MmrWorkerResult[] = [];
  if (!state.checksOnly && state.mainResult) results.push(state.mainResult);
  for (const run of state.checks) if (run.result) results.push(run.result);
  return results;
}

/**
 * The result the call settles with in the task registry: the main review's
 * when it succeeded or nothing did, otherwise a successful check's, so the
 * call fails only when every run failed.
 */
function representativeResult(state: ReviewerRunState, fallback: MmrWorkerResult): MmrWorkerResult {
  const results = settledRunResults(state);
  const success = results.find(isReviewerSuccess);
  if (!state.checksOnly && state.mainResult && (success === undefined || isReviewerSuccess(state.mainResult))) {
    return state.mainResult;
  }
  return success ?? results[0] ?? fallback;
}

function buildReviewerFinalContent(result: MmrWorkerResult, state: ReviewerRunState | undefined): string {
  if (!state) return buildFinalContent(result);
  const parts: string[] = [];
  if (!state.checksOnly) parts.push(buildFinalContent(state.mainResult ?? result));
  parts.push(buildChecksSection(state));
  return parts.join("\n\n");
}

function buildReviewerFinalDetails(
  result: MmrWorkerResult,
  state: ReviewerRunState | undefined,
  resolvedModel: string | undefined,
  cwd: string,
  contextWindow: number | undefined,
): ReviewerDetails {
  if (!state) return buildDetails(result, resolvedModel, cwd, contextWindow);
  const lead = state.checksOnly ? result : (state.mainResult ?? result);
  const details = buildDetails(lead, resolvedModel, cwd, contextWindow);
  const anySuccess = settledRunResults(state).some(isReviewerSuccess);
  return {
    ...details,
    ...(anySuccess ? { status: "success" as const } : {}),
    mainReview: state.checksOnly
      ? "skipped"
      : classifyMmrWorkerOutcomeForProfile(state.mainResult ?? result, requireReviewerProfile()),
    checks: state.checks.map((run) => checkRunDetails(run, true)),
  };
}

function buildReviewerProgressDetails(
  snapshot: MmrWorkerProgressSnapshot,
  state: ReviewerRunState | undefined,
  resolvedModel: string | undefined,
  cwd: string,
  contextWindow: number | undefined,
): ReviewerDetails {
  const details = buildProgressDetails(snapshot, resolvedModel, cwd, contextWindow);
  if (!state) return details;
  return { ...details, checks: state.checks.map((run) => checkRunDetails(run, false)) };
}

/**
 * Plan the checks of one call. Returns `undefined` when no check applies
 * (the call then runs exactly as a plain review); throws for an unknown
 * `check_filter` name, a `check_scope` outside the repository, or
 * `checks_only` without any applicable check.
 */
function planReviewerRun(params: ReviewerParams, cwd: string, deps: ReviewerToolDeps): ReviewerRunState | undefined {
  const plan = planAmpiReviewChecks({
    cwd,
    diffDescription: params.diff_description,
    ...(params.check_scope !== undefined ? { scope: params.check_scope } : {}),
    ...(params.check_filter !== undefined ? { filter: params.check_filter } : {}),
    ...(deps.reviewCheckEnv !== undefined ? { env: deps.reviewCheckEnv } : {}),
  });
  const checksOnly = params.checks_only === true;
  if (plan.selected.length === 0) {
    if (checksOnly) {
      const found = plan.discovered.length;
      throw new Error(
        `reviewer: checks_only is set, but no review check applies to this change (${found} check ${found === 1 ? "file" : "files"} found under .agents/checks/).`,
      );
    }
    return undefined;
  }
  return {
    plan,
    checksOnly,
    checks: plan.selected.map((selection) => ({ selection, state: "pending" })),
  };
}

/**
 * Concurrency gate for the runs of one call. A finishing run hands its slot
 * straight to the next waiting one, so the number of runs in flight never
 * exceeds `limit`.
 */
function createRunLimiter(limit: number): <T>(job: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  const acquire = (): Promise<void> => {
    if (active < limit) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
  return async (job) => {
    await acquire();
    try {
      return await job();
    } finally {
      release();
    }
  };
}

type ReviewerSpec = MmrWorkerToolSpec<ReviewerParams, ReviewerDetails, ReviewerRunState | undefined>;
type ReviewerFactoryOptions = Parameters<typeof createWorkerRunPreparer<ReviewerParams, ReviewerDetails, ReviewerRunState | undefined>>[2];

/**
 * One spec + factory-options pair shared by the blocking tool definition and
 * the background run preparer, so both surfaces are generated from the same
 * declarative source.
 */
function reviewerToolBlueprint(deps: ReviewerToolDeps): {
  spec: ReviewerSpec;
  factoryOptions: ReviewerFactoryOptions;
} {
  const effectiveRunner = resolveEffectiveRunner(deps, "createReviewerTool");
  return {
    spec: {
      toolName: REVIEWER_TOOL_NAME,
      profileName: REVIEWER_SUBAGENT_PROFILE,
      description: REVIEWER_DESCRIPTION,
      promptSnippet: REVIEWER_PROMPT_SNIPPET,
      promptGuidelines: REVIEWER_PROMPT_GUIDELINES,
      parameters: reviewerParameters,
      progressPlaceholder: REVIEWER_PROGRESS_PLACEHOLDER,
      // Invalid params propagate as a thrown error to the Pi tool host
      // (the finder/oracle contract), so no paramsFailure here.
      backgroundCapable: true,
      coerceParams: coerceReviewerParams,
      resolveInvocation: resolveReviewerInvocation,
      resolutionFailure: "degrade",
      // The child Pi process computes its own workerTools via
      // `resolveMmrSubagentInvocation` against its registered-tool
      // inventory; the profile lists only Pi built-ins, so skipping
      // explicit --tools keeps parent and child agreement (the finder
      // rationale).
      mirrorWorkerTools: false,
      detailsWorkerTools: "profile-constant",
      workerToolsConstant: REVIEWER_WORKER_TOOLS,
      progressModelBinding: "per-attempt",
      buildUserPrompt: (params) => buildReviewerUserPrompt(params),
      assembleSystemPrompt: (cwd) => assembleReviewerSystemPrompt(cwd, deps.buildSystemPrompt),
      resolveContextWindow: (ctx, model) => resolveMmrWorkerModelContextWindowFromCtx(ctx, model),
      candidatePreferences: () => requireReviewerProfile().modelPreferences,
      buildProgressDetails: (snapshot, runCtx) =>
        buildReviewerProgressDetails(snapshot, runCtx.runData, runCtx.resolvedModel, runCtx.cwd, runCtx.contextWindow),
      buildFinalDetails: (result, runCtx) =>
        buildReviewerFinalDetails(result, runCtx.runData, runCtx.resolvedModel, runCtx.cwd, runCtx.contextWindow),
      buildFinalContent: (result, runCtx) => buildReviewerFinalContent(result, runCtx.runData),
      describeRun: (params) => ({
        description: `reviewer: ${clipMmrWorkerDescription(params.diff_description)}`,
        displayPrompt: params.diff_description,
      }),
    },
    factoryOptions: {
      effectiveRunner,
      resolveModelPreferencesOverride: (cwd) =>
        resolveWorkerModelPreferencesOverride({
          profileName: REVIEWER_SUBAGENT_PROFILE,
          cwd,
          ...(deps.modelPreferences !== undefined ? { explicit: deps.modelPreferences } : {}),
          ...(deps.subagentModelPreferencesOverride !== undefined
            ? { settingsOverride: deps.subagentModelPreferencesOverride }
            : {}),
          loadSettings: (loadCwd) =>
            (deps.loadSubagentModelPreferences
              ? deps.loadSubagentModelPreferences(loadCwd)
              : loadMmrCoreSettings(loadCwd).settings
            )?.subagentModelPreferences,
        }),
    },
  };
}

/**
 * The reviewer's run preparer, shared by the blocking tool and the
 * background surface. It prepares the main review through the worker
 * factory; when review checks apply it also prepares one child per check
 * from the same spec (same profile, model preferences, fallback and system
 * prompt, its own task text) and replaces the run thunk with one that runs
 * them all, at most {@link REVIEWER_MAX_CONCURRENT_RUNS} at once, on the
 * call's abort signal. Progress comes from the main review, or from the
 * first check under `checks_only`; when a check starts or settles, the last
 * progress update is sent again with the checks' new states.
 */
function createReviewerCallPreparer(deps: ReviewerToolDeps): MmrWorkerRunPreparer<ReviewerDetails> {
  const { spec, factoryOptions } = reviewerToolBlueprint(deps);
  return (rawParams, ctx, opts = {}) => {
    let state: ReviewerRunState | undefined;
    const callSpec: ReviewerSpec = {
      ...spec,
      computeRunData: (params, cwd) => {
        state = planReviewerRun(params, cwd, deps);
        return state;
      },
    };
    const prep = createWorkerRunPreparer(callSpec, deps, factoryOptions)(rawParams, ctx, opts);
    const runState = state as ReviewerRunState | undefined;
    if (!prep.ok || !runState) return prep;

    const prepared = prep.prepared;
    const cwd = resolveWorkerCwd(ctx);
    const { repository } = runState.plan;
    const params = coerceReviewerParams(rawParams);
    const checkPrepared = runState.checks.map((run, index) => {
      const checkSpec: ReviewerSpec = {
        ...spec,
        computeRunData: () => runState,
        buildUserPrompt: () =>
          buildReviewerCheckUserPrompt({
            diff_description: params.diff_description,
            check: run.selection.check,
            repositoryRoot: repository.root,
            repositoryKind: repository.kind,
            ...(run.selection.changedFiles !== undefined ? { changedFiles: run.selection.changedFiles } : {}),
          }),
      };
      const lead = runState.checksOnly && index === 0;
      const checkPrep = createWorkerRunPreparer(checkSpec, deps, factoryOptions)(rawParams, ctx, lead ? opts : {});
      return checkPrep.ok ? checkPrep.prepared : undefined;
    });

    const mainRun = prepared.run;
    const syncBoardRef = (child: MmrPreparedWorkerRun<ReviewerDetails>): void => {
      if (prepared.runMode !== undefined) child.runMode = prepared.runMode;
      if (prepared.sessionKey !== undefined) child.sessionKey = prepared.sessionKey;
      if (prepared.taskId !== undefined) child.taskId = prepared.taskId;
    };
    prepared.run = async ({ signal, onProgress }) => {
      const limit = createRunLimiter(REVIEWER_MAX_CONCURRENT_RUNS);
      // The lead run's latest shaped progress (the one with content and
      // details), re-sent with fresh check states when a check starts or
      // settles. Refreshes begin only after the lead run's first shaped
      // progress: before it there is no update to re-send.
      let lastShaped: AgentToolResult<ReviewerDetails> | undefined;
      const leadProgress: typeof onProgress = (update) => {
        if (isShapedProgress(update)) lastShaped = update as AgentToolResult<ReviewerDetails>;
        onProgress(update);
      };
      const refreshChecks = (): void => {
        if (!lastShaped) return;
        const refreshed: AgentToolResult<ReviewerDetails> = {
          ...lastShaped,
          details: { ...lastShaped.details, checks: runState.checks.map((run) => checkRunDetails(run, false)) },
        };
        lastShaped = refreshed;
        onProgress(refreshed as Parameters<typeof onProgress>[0]);
        opts.onUpdate?.(refreshed);
      };
      const cancelled = (): MmrWorkerResult => syntheticAbortedWorkerResult(prepared.displayPrompt, cwd);
      const jobs: Promise<void>[] = [];
      if (!runState.checksOnly) {
        jobs.push(
          limit(async () => {
            const result = signal.aborted ? cancelled() : await mainRun({ signal, onProgress: leadProgress });
            runState.mainResult = result as MmrWorkerResult;
          }),
        );
      }
      runState.checks.forEach((run, index) => {
        jobs.push(
          limit(async () => {
            const child = checkPrepared[index];
            if (signal.aborted || !child) {
              run.result = child ? cancelled() : buildSpawnFailure("the check run could not be prepared", cwd);
            } else {
              run.state = "running";
              refreshChecks();
              syncBoardRef(child);
              const lead = runState.checksOnly && index === 0;
              run.result = (await child.run({ signal, onProgress: lead ? leadProgress : () => {} })) as MmrWorkerResult;
            }
            run.state = "settled";
            refreshChecks();
          }),
        );
      });
      await Promise.all(jobs);
      return representativeResult(runState, cancelled());
    };
    return prep;
  };
}

function isShapedProgress(update: unknown): boolean {
  return typeof update === "object" && update !== null && Array.isArray((update as { content?: unknown }).content)
    && "details" in update;
}

function buildSpawnFailure(reason: string, cwd: string): MmrWorkerResult {
  return { ...syntheticAbortedWorkerResult("", cwd), aborted: false, spawnError: reason, errorMessage: reason };
}

export function createReviewerTool(deps: ReviewerToolDeps = {}): ToolDefinition {
  const { spec, factoryOptions } = reviewerToolBlueprint(deps);
  return createWorkerTool(spec, deps, { ...factoryOptions, prepareRun: createReviewerCallPreparer(deps) });
}

/** Background-surface seam: prepare a registry-ready reviewer run from raw params. */
export function createReviewerRunPreparer(deps: ReviewerToolDeps = {}): MmrWorkerRunPreparer<ReviewerDetails> {
  return createReviewerCallPreparer(deps);
}

/**
 * Register the reviewer Pi tool on the supplied extension API and record
 * it as ampi-owned so Free mode strips it like every other ampi-authored tool.
 */
export function registerReviewerTool(pi: ExtensionAPI, deps: ReviewerToolDeps = {}): ToolDefinition {
  const definition = createReviewerTool({ ...deps, pi });
  registerAmpiOwnedTool(REVIEWER_TOOL_NAME);
  pi.registerTool(definition);
  return definition;
}
