// `/ampi-review-run`: the extension command `ampi review` runs in Pi's print
// mode. It reads the request file named by --ampi-review-request, runs the
// reviewer pipeline once on it (the same preparer the `reviewer` tool uses,
// with no model turn of the session), and writes the outcome to the file
// named by --ampi-review-output. Both files are the command's own contract
// with ampi-cli (packages/ampi-cli/src/review.js), not a public format; the
// JSON document inside a successful outcome is public and documented there.
import { readFileSync, writeFileSync } from "node:fs";
import type { AgentToolResult, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadMmrCoreSettings } from "../../ampi-core/settings.js";
import { getMmrSubagentProfile } from "../../ampi-core/subagent-profiles.js";
import type { MmrModelPreference } from "../../ampi-core/types.js";
import type { MmrSubagentRunner } from "../framework/runner.js";
import { resolveEffectiveRunner } from "../framework/worker-fallback-run.js";
import { resolveWorkerModelPreferencesOverride } from "../framework/worker-tool-factory.js";
import { type AmpiReviewFinding, ampiReviewSummary, parseAmpiReviewFindings } from "../review/findings.js";
import {
  type AmpiReviewerReports,
  createReviewerRunPreparer,
  REVIEWER_SUBAGENT_PROFILE,
  type ReviewerCheckStatus,
  type ReviewerDetails,
  type ReviewerToolDeps,
  readAmpiReviewerReports,
} from "./reviewer.js";

export const AMPI_REVIEW_RUN_COMMAND = "ampi-review-run";
export const AMPI_REVIEW_REQUEST_FLAG = "ampi-review-request";
export const AMPI_REVIEW_OUTPUT_FLAG = "ampi-review-output";

/** The thinking levels `ampi review --thinking` takes. */
export type AmpiReviewThinking = "low" | "high";

/** The request file: the reviewer parameters and the children's thinking level. */
export interface AmpiReviewRequest {
  version: 1;
  params: {
    diff_description: string;
    files?: string[];
    instructions?: string;
    checks_only?: boolean;
    check_filter?: string[];
    check_scope?: string;
  };
  thinking: AmpiReviewThinking;
}

/** One finding of the document; `check` names the check it came from, absent for the main review. */
export interface AmpiReviewDocumentFinding extends AmpiReviewFinding {
  check?: string;
}

/** One check of the document, from `ReviewerDetails.checks`. */
export interface AmpiReviewDocumentCheck {
  name: string;
  path: string;
  scope: string;
  status: Extract<ReviewerCheckStatus, "no-issues" | "findings" | "failed">;
  findings: number;
  error?: string;
}

/** The JSON document `ampi review --json` prints. */
export interface AmpiReviewDocument {
  diff: string;
  summary: string;
  findings: AmpiReviewDocumentFinding[];
  checks: AmpiReviewDocumentCheck[];
  report: string;
}

/** The output file. */
export type AmpiReviewOutcome =
  | { ok: true; result: AmpiReviewDocument; mainReviewFailure?: string }
  | { ok: false; error: string };

function oneLine(text: string, max = 400): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function contentText(result: AgentToolResult<unknown>): string {
  return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

/**
 * The model preferences of one review: the ones in effect for the reviewer
 * (explicit, else `subagentModelPreferences.reviewer` from the ampi-core
 * settings, else the reviewer profile's), each with the thinking level the
 * command asked for.
 */
export function ampiReviewModelPreferences(cwd: string, thinking: AmpiReviewThinking, deps: ReviewerToolDeps = {}): MmrModelPreference[] {
  const inEffect =
    resolveWorkerModelPreferencesOverride({
      profileName: REVIEWER_SUBAGENT_PROFILE,
      cwd,
      ...(deps.modelPreferences !== undefined ? { explicit: deps.modelPreferences } : {}),
      ...(deps.subagentModelPreferencesOverride !== undefined ? { settingsOverride: deps.subagentModelPreferencesOverride } : {}),
      loadSettings: (loadCwd) =>
        (deps.loadSubagentModelPreferences ? deps.loadSubagentModelPreferences(loadCwd) : loadMmrCoreSettings(loadCwd).settings)
          ?.subagentModelPreferences,
    }) ??
    getMmrSubagentProfile(REVIEWER_SUBAGENT_PROFILE)?.modelPreferences ??
    [];
  return inEffect.map((preference) => ({ ...preference, thinkingLevel: thinking }));
}

/**
 * The document of a review that ran: the combined report the reviewer tool
 * returns, with the findings of each run parsed from that run's own report.
 */
export function buildAmpiReviewDocument(
  diff: string,
  projected: AgentToolResult<ReviewerDetails>,
  reports: AmpiReviewerReports,
): AmpiReviewDocument {
  const text = contentText(projected);
  const mainReport = reports.main?.report;
  const findings: AmpiReviewDocumentFinding[] = mainReport === undefined ? [] : parseAmpiReviewFindings(mainReport);
  const checks: AmpiReviewDocumentCheck[] = [];
  (projected.details?.checks ?? []).forEach((check, index) => {
    const report = reports.checks[index]?.report;
    const parsed = report === undefined ? [] : parseAmpiReviewFindings(report);
    findings.push(...parsed.map((finding) => ({ ...finding, check: check.name })));
    const status = check.status === "findings" || check.status === "no-issues" ? check.status : "failed";
    checks.push({
      name: check.name,
      path: check.file,
      scope: check.scope,
      status,
      findings: parsed.length,
      ...(check.failureReason !== undefined ? { error: check.failureReason } : {}),
    });
  });
  return {
    diff,
    summary: mainReport === undefined ? "" : ampiReviewSummary(mainReport),
    findings,
    checks,
    report: text.endsWith("\n") ? text : `${text}\n`,
  };
}

/** Why a review in which no run succeeded failed, on one line. */
function failureOf(reports: AmpiReviewerReports, details: ReviewerDetails | undefined): string {
  const runs: [string, string][] = [];
  if (reports.main?.failure !== undefined) runs.push(["main review", reports.main.failure]);
  (details?.checks ?? []).forEach((check, index) => {
    const failure = reports.checks[index]?.failure;
    if (failure !== undefined) runs.push([check.name, failure]);
  });
  if (runs.length === 0) return "the review produced no report";
  if (runs.length === 1) return oneLine(runs[0][1]);
  // Runs that fail for one reason (no model route, say) name it once.
  const reasons = new Set(runs.map(([, failure]) => failure));
  if (reasons.size === 1) return oneLine(`every review run failed: ${runs[0][1]}`);
  return oneLine(`every review run failed (${runs.map(([name, failure]) => `${name}: ${failure}`).join("; ")})`);
}

function readRequest(file: string): AmpiReviewRequest {
  const request = JSON.parse(readFileSync(file, "utf8")) as Partial<AmpiReviewRequest> | null;
  if (request?.version !== 1) throw new Error("the review request was written by a different version of the ampi command; update ampi and ampi-cli together.");
  if (typeof request.params !== "object" || request.params === null) throw new Error("the review request has no reviewer parameters.");
  if (request.thinking !== "low" && request.thinking !== "high") throw new Error("the review request has no thinking level.");
  return request as AmpiReviewRequest;
}

/**
 * Run the review a request file asks for and return the outcome. Never
 * throws: an error while preparing or running the review is the outcome.
 */
export async function runAmpiReviewRequest(
  requestFile: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  deps: ReviewerToolDeps = {},
): Promise<AmpiReviewOutcome> {
  try {
    const request = readRequest(requestFile);
    const preferences = ampiReviewModelPreferences(ctx.cwd, request.thinking, deps);
    // The children resolve their route themselves: hand them the same
    // preferences, thinking level included, so they agree with the parent.
    const base = resolveEffectiveRunner(deps, AMPI_REVIEW_RUN_COMMAND);
    const runner: MmrSubagentRunner = {
      run: (options) => base.run({ ...options, modelPreferencesOverride: options.modelPreferencesOverride ?? preferences }),
    };
    const { runWorker: _runWorker, ...rest } = deps;
    const prepare = createReviewerRunPreparer({ ...rest, pi, runner, modelPreferences: preferences });
    const prep = prepare(request.params, ctx);
    if (!prep.ok) return { ok: false, error: oneLine(contentText(prep.result)) };
    const { prepared } = prep;
    const controller = new AbortController();
    ctx.signal?.addEventListener("abort", () => controller.abort(), { once: true });
    const result = await prepared.run({ signal: controller.signal, onProgress: () => {} });
    if (prepared.runError !== undefined) return { ok: false, error: oneLine(messageOf(prepared.runError)) };
    const project = prepared.projectResult;
    if (!project) return { ok: false, error: "the reviewer returned no result." };
    const projected = project(result as Parameters<typeof project>[0]);
    const reports = readAmpiReviewerReports(prepared, result as Parameters<typeof project>[0]);
    if (projected.details?.status !== "success") return { ok: false, error: failureOf(reports, projected.details) };
    const document = buildAmpiReviewDocument(request.params.diff_description, projected, reports);
    const mainFailure = reports.main?.failure;
    return { ok: true, result: document, ...(mainFailure !== undefined ? { mainReviewFailure: oneLine(mainFailure) } : {}) };
  } catch (error) {
    return { ok: false, error: oneLine(messageOf(error)) };
  }
}

/**
 * Register `/ampi-review-run` and its two flags. Pi 1.3 has no hidden
 * commands, so the command is listed with the others; typed in a session,
 * without the flags, it only says what runs it.
 */
export function registerAmpiReviewRunCommand(pi: ExtensionAPI, deps: ReviewerToolDeps = {}): void {
  pi.registerFlag(AMPI_REVIEW_REQUEST_FLAG, {
    description: "Used by ampi review: the review request file /ampi-review-run reads",
    type: "string",
  });
  pi.registerFlag(AMPI_REVIEW_OUTPUT_FLAG, {
    description: "Used by ampi review: the file /ampi-review-run writes the review to",
    type: "string",
  });
  pi.registerCommand(AMPI_REVIEW_RUN_COMMAND, {
    description: "Run one review for the ampi review shell command (used by ampi review; does nothing when typed)",
    handler: async (_args, ctx) => {
      const requestFile = pi.getFlag(AMPI_REVIEW_REQUEST_FLAG);
      const outputFile = pi.getFlag(AMPI_REVIEW_OUTPUT_FLAG);
      if (typeof requestFile !== "string" || requestFile === "" || typeof outputFile !== "string" || outputFile === "") {
        const notice = `/${AMPI_REVIEW_RUN_COMMAND} runs a review for the ampi review shell command; to review changes, run ampi review in a shell or ask for a review.`;
        // Without a UI (print or JSON mode) a notification shows nothing, so the error is the message.
        if (!ctx.hasUI) throw new Error(notice);
        ctx.ui.notify(notice, "info");
        return;
      }
      const outcome = await runAmpiReviewRequest(requestFile, ctx, pi, deps);
      writeFileSync(outputFile, `${JSON.stringify(outcome)}\n`, { mode: 0o600 });
    },
  });
}
