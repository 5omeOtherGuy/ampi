/**
 * WorkerRunView: the ONE render view model every worker surface builds from
 * frozen tool `details` before drawing anything.
 *
 * Invariant: a renderer never branches on raw details shapes inline. It calls
 * {@link buildWorkerRunView} to classify the frozen payload into a surface
 * projection (blocking card, gated spawn card, group/fleet card, board list,
 * rich background result), then draws that projection — optionally overlaying
 * live async-task-registry state, which is an overlay and never a rendering
 * requirement (replayed transcripts and TTL-pruned records must render from
 * the frozen view alone).
 *
 * The row/section vocabulary is shared with the pinned widget: a
 * {@link WorkerRunRow} / {@link WorkerRunSection} IS the widget row/section
 * shape, so every surface projects the same rows.
 */
import { isRecord } from "../../ampi-core/internal/json.js";
import type { MmrWorkerRunEnvelopeV1 } from "../../ampi-core/worker-contract.js";
import { readWorkerRunEnvelope } from "./worker-run-envelope.js";
import { stripAgentPrefix, workerRowDetail, type WorkerRowStatus } from "./worker-row.js";
import type { WorkerRowView } from "./worker-row-lines.js";
import {
  diagnosticMessage,
  statusFromDetails,
  stripProvider,
  type BackgroundTaskDetails,
  type RenderContextLike,
  type RenderStatus,
  type SubagentProgressDetails,
} from "./subagent-render-format.js";
import type { WidgetRow, WidgetSection } from "./background-task-view.js";
import type { AsyncTaskFleetDetails } from "../background/async-task-tool-schemas.js";

/** Shared projection aliases: every worker surface renders these shapes. */
export type WorkerRunRow = WidgetRow;
export type WorkerRunSection = WidgetSection;

/**
 * The `details.worker` discriminators stamped on background-task payloads
 * (current and legacy package names). Centralized here so no renderer sniffs
 * the strings inline.
 */
export const MMR_BACKGROUND_DETAILS_WORKERS: readonly string[] = [
  "ampi-workers.async-task",
  "mmr-subagents.async-task",
];

/** Whether a frozen details payload is a background-task payload. */
export function isMmrBackgroundWorkerDetails(details: unknown): details is BackgroundTaskDetails {
  return isRecord(details)
    && typeof details.worker === "string"
    && MMR_BACKGROUND_DETAILS_WORKERS.includes(details.worker);
}

/**
 * One classified render surface. The variants mirror the pinned card
 * semantics:
 *  - `"fleet"` — start_task fleet declaration; all group sections in one
 *    GATED card (rows animate ready→running→terminal in place).
 *  - `"board"` — task_poll list mode; static grouped board snapshot.
 *  - `"group-control"` — group task_poll/task_wait/task_cancel; one
 *    consolidated member-list card, GATED like the spawn card (the live,
 *    animated group state lives only in the pinned widget, so it renders
 *    nothing until every member settles, then latches a static checklist).
 *  - `"spawn"` — start_task single/group-opener or a named tool's
 *    `background: true` start; GATED card (invisible until settled, then a
 *    latched static snapshot).
 *  - `"background-final"` — single-task poll/wait/cancel result; the task's
 *    one-line row, expandable to its trail, answer and usage.
 *  - `"blocking"` — a blocking subagent result; the same one-line row.
 *  - `"plain"` — no recognized worker payload; render the text content.
 */
export type WorkerRunView =
  | { surface: "fleet"; details: BackgroundTaskDetails; fleet: AsyncTaskFleetDetails; gated: true }
  | { surface: "board"; details: BackgroundTaskDetails; board: unknown }
  | { surface: "group-control"; details: BackgroundTaskDetails; groupId: string | undefined; gated: true }
  | { surface: "spawn"; details: BackgroundTaskDetails; groupId: string | undefined; groupOpener: boolean; gated: true }
  | { surface: "background-final"; details: BackgroundTaskDetails; final: SubagentProgressDetails }
  | { surface: "blocking"; details: SubagentProgressDetails | undefined; envelope?: MmrWorkerRunEnvelopeV1 }
  | { surface: "plain" };

/**
 * Classify a frozen `details` payload into its render surface. Pure and
 * registry-free: the result must be renderable with no live state (replay
 * contract); live board/group snapshots are overlaid by the card layer.
 *
 * Branch order is part of the pinned render contract: fleet → board →
 * group-control → (non-background → blocking) → spawn → background-final.
 */
export function buildWorkerRunView(details: unknown): WorkerRunView {
  // Dual-read: the canonical worker-run envelope is preferred when present.
  // During the dual-write window only the worker-tool factory writes it
  // (blocking + background-start runs of the factory tools); payloads that
  // still classify as background sections/results keep the legacy path so
  // rendering is unchanged.
  const envelope = readWorkerRunEnvelope(details);
  if (envelope && !isMmrBackgroundWorkerDetails(details) && !hasBackgroundSections(details)) {
    return { surface: "blocking", details: details as SubagentProgressDetails, envelope };
  }
  if (isMmrBackgroundWorkerDetails(details) || hasBackgroundSections(details)) {
    const bg = details as BackgroundTaskDetails;
    if (bg.fleet !== undefined) {
      return { surface: "fleet", details: bg, fleet: bg.fleet as AsyncTaskFleetDetails, gated: true };
    }
    if (bg.board !== undefined) {
      return { surface: "board", details: bg, board: bg.board };
    }
    if (bg.group !== undefined) {
      return { surface: "group-control", details: bg, groupId: bg.groupId, gated: true };
    }
    if (!isMmrBackgroundWorkerDetails(details)) return { surface: "plain" };
    if (bg.tool === "start_task" || bg.backgroundStart === true) {
      return {
        surface: "spawn",
        details: bg,
        groupId: bg.groupId,
        groupOpener: bg.groupOpener === true,
        gated: true,
      };
    }
    return {
      surface: "background-final",
      details: bg,
      final: (isRecord(bg.final) ? bg.final : {}) as SubagentProgressDetails,
    };
  }
  if (details === undefined || isRecord(details)) {
    return { surface: "blocking", details: details as SubagentProgressDetails | undefined };
  }
  return { surface: "plain" };
}

/**
 * Fleet/board/group payloads carry their section data even when the `worker`
 * discriminator is absent (older replayed records). Mirrors the pre-view
 * renderer, which checked `details.fleet` / `details.board` /
 * `details.group` BEFORE the worker-string branch.
 */
function hasBackgroundSections(details: unknown): boolean {
  return isRecord(details)
    && (details.fleet !== undefined || details.board !== undefined || details.group !== undefined);
}

// ---------------------------------------------------------------------------
// WorkerRunFinal: the N=1 row projection
// ---------------------------------------------------------------------------

/**
 * Coarse render status for a background-task poll/wait/cancel result:
 * `running` keeps the inline card gated, any other known status draws the
 * task's row. `undefined` for a status the row cannot draw.
 */
export function backgroundTaskRenderStatus(status: string | undefined): RenderStatus | undefined {
  if (status === "running" || status === "cancelling") return "running";
  if (status === "succeeded") return "succeeded";
  if (status === "failed" || status === "cancelled") return "failed";
  return undefined;
}

/**
 * Collapsed/expanded task-body precedence for a background result card. The
 * collapsed form prefers the short `description`; the expanded form prefers the
 * full `prompt`. Both fall back through the start_task args display and the
 * projected worker details so a replayed record with only partial fields still
 * resolves a body. Pure: no theme, no live registry.
 */
export function backgroundTaskDisplayText(
  details: BackgroundTaskDetails,
  subDetails: SubagentProgressDetails,
  startDisplay: { collapsed?: string; expanded?: string } | undefined,
): { collapsed?: string; expanded?: string } {
  const expanded = details.prompt
    ?? startDisplay?.expanded
    ?? subDetails.query
    ?? subDetails.prompt
    ?? subDetails.task
    ?? subDetails.description
    ?? details.description;
  const collapsed = details.description
    ?? startDisplay?.collapsed
    ?? subDetails.description
    ?? subDetails.query
    ?? subDetails.task
    ?? subDetails.prompt
    ?? expanded;
  return { collapsed, expanded };
}


/**
 * The ONE row projection both N=1 surfaces (a blocking worker's transcript
 * row and a polled background task's terminal row) draw. A pure view built
 * from frozen details plus a few render-time bits; `progress-rendering`
 * draws it with `worker-row.ts`. Live registry state is never required —
 * replayed transcripts project the same shape.
 */
export interface WorkerRunFinal extends WorkerRowView {
  surface: "blocking" | "background";
}

/** Discriminated input for {@link buildWorkerRunFinal}. */
export type WorkerRunFinalInput =
  | {
      surface: "blocking";
      toolName: string;
      details: SubagentProgressDetails | undefined;
      isPartial: boolean;
      context: RenderContextLike | undefined;
      /** What the worker was asked, derived at the call site via `operationLabel` (needs `context.args`). */
      collapsedBody: string | undefined;
      /** The full prompt, via `expandedOperationLabel`. */
      expandedBody: string | undefined;
      trailWorkerPrompt: string | undefined;
      /** `textContent(result).trim()`. */
      output: string;
    }
  | {
      surface: "background";
      details: BackgroundTaskDetails;
      /** Projected worker details (`details.final`), pre-narrowed by the view. */
      final: SubagentProgressDetails;
      startDisplay: { collapsed?: string; expanded?: string } | undefined;
      /** `details.finalOutput?.trim() ?? ""`. */
      output: string;
    };

/** A run stopped by its caller rather than failed on its own. */
function wasCancelled(details: SubagentProgressDetails | undefined): boolean {
  return details?.aborted === true || details?.stopReason === "aborted" || details?.status === "aborted";
}

function blockingRowStatus(status: RenderStatus, details: SubagentProgressDetails | undefined): WorkerRowStatus {
  if (status === "running") return "running";
  if (status === "succeeded") return "done";
  return wasCancelled(details) ? "cancelled" : "error";
}

function backgroundRowStatus(status: string | undefined): WorkerRowStatus {
  if (status === "running" || status === "cancelling") return "running";
  if (status === "succeeded") return "done";
  if (status === "cancelled") return "cancelled";
  return "error";
}

function readArg(args: unknown, key: string): string | undefined {
  const value = isRecord(args) ? args[key] : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Project a frozen worker-result payload into the {@link WorkerRunFinal} row.
 * Pure: status/model/diagnostic/body precedence is derived here (reusing
 * `statusFromDetails`, `stripProvider`, `diagnosticMessage`, and
 * `backgroundTaskDisplayText`), so the two entry points never re-derive them
 * inline. During the envelope dual-write window the rich fields (trail,
 * usage, model, body) are read from the legacy details shape — which the
 * producers still stamp alongside the light envelope snapshot.
 */
export function buildWorkerRunFinal(input: WorkerRunFinalInput): WorkerRunFinal {
  if (input.surface === "background") {
    const { details, final } = input;
    const agent = details.agent ?? "background task";
    const status = backgroundRowStatus(details.status);
    const operation = backgroundTaskDisplayText(details, final, input.startDisplay);
    const unprefixed = (text: string | undefined) => (text !== undefined ? stripAgentPrefix(text, agent) : undefined);
    const detail = workerRowDetail(unprefixed(operation.collapsed));
    const prompt = unprefixed(operation.expanded);
    const workerPrompt = prompt ?? unprefixed(operation.collapsed);
    const model = stripProvider(final.reportedModel ?? final.model ?? details.resolvedModel);
    const contextWindow = final.contextWindow ?? details.contextWindow;
    return {
      surface: "background",
      agent,
      status,
      ...(detail !== undefined ? { detail } : {}),
      ...(details.terminalOutcome === "partial" ? { tail: "(partial)" } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
      trail: final.trail ?? [],
      ...(workerPrompt !== undefined ? { workerPrompt } : {}),
      output: input.output,
      suppressDuplicateFinalOutput: true,
      finished: status !== "running",
      ...(final.usage !== undefined ? { usage: final.usage } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(model !== undefined ? { model } : {}),
      usageName: agent,
      // A cancel is not a failure: only a hard `failed` shows its error.
      ...(details.status === "failed" && details.errorMessage ? { diagnostic: details.errorMessage, diagnosticColor: "error" } : {}),
    };
  }

  const { details, toolName } = input;
  const coarse = statusFromDetails(details, input.isPartial, input.context);
  const status = blockingRowStatus(coarse, details);
  const model = stripProvider(details?.reportedModel ?? details?.model);
  const diagnostic = diagnosticMessage(details, coarse);
  const detail = workerRowDetail(input.collapsedBody);
  const variant = toolName === "Task" ? readArg(input.context?.args, "capabilityProfile") : undefined;
  return {
    surface: "blocking",
    agent: toolName,
    ...(variant !== undefined ? { variant } : {}),
    status,
    ...(detail !== undefined ? { detail } : {}),
    ...(input.expandedBody !== undefined ? { prompt: input.expandedBody } : {}),
    trail: details?.trail ?? [],
    ...(input.trailWorkerPrompt !== undefined ? { workerPrompt: input.trailWorkerPrompt } : {}),
    output: input.output,
    suppressDuplicateFinalOutput: !input.isPartial,
    finished: !input.isPartial,
    ...(details?.usage !== undefined ? { usage: details.usage } : {}),
    ...(details?.contextWindow !== undefined ? { contextWindow: details.contextWindow } : {}),
    ...(model !== undefined ? { model } : {}),
    usageName: toolName,
    // A provider error on a run that still answered is a note, not a failure;
    // a cancelled run needs no diagnostic, its glyph says it was stopped.
    ...(diagnostic !== undefined && status !== "cancelled" ? { diagnostic, diagnosticColor: status === "error" ? "error" : "warning" } : {}),
    ...(details?.fallbackNotice !== undefined ? { fallbackNotice: details.fallbackNotice } : {}),
  };
}
