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
import type { MmrWorkerTrailItem, MmrWorkerUsageStats } from "../framework/runner.js";
import { readWorkerRunEnvelope } from "./worker-run-envelope.js";
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
 *    consolidated member-list card rendered live every frame (not gated).
 *  - `"spawn"` — start_task single/group-opener or a named tool's
 *    `background: true` start; GATED card (invisible until settled, then a
 *    latched static snapshot).
 *  - `"background-final"` — single-task poll/wait/cancel result; the rich
 *    N=1 result card (header, Markdown body, trail, final output, usage).
 *  - `"blocking"` — a blocking subagent result; the rich N=1 transcript card.
 *  - `"plain"` — no recognized worker payload; render the text content.
 */
export type WorkerRunView =
  | { surface: "fleet"; details: BackgroundTaskDetails; fleet: AsyncTaskFleetDetails; gated: true }
  | { surface: "board"; details: BackgroundTaskDetails; board: unknown }
  | { surface: "group-control"; details: BackgroundTaskDetails; groupId: string | undefined; gated: false }
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
      return { surface: "group-control", details: bg, groupId: bg.groupId, gated: false };
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
// WorkerRunFinal: the N=1 rich-card projection
// ---------------------------------------------------------------------------

/**
 * Coarse render status for a background-task poll/wait/cancel result. Mirrors
 * the async-task status vocabulary onto the three-value {@link RenderStatus}
 * the rich card draws: a user-initiated `cancelled` folds into the coarse
 * `failed` bucket for section gating, but the neutral colouring is preserved
 * separately via the raw status (see {@link WorkerRunFinal.backgroundStatus}).
 * `undefined` for a non-terminal-or-running status the card cannot render.
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
 * The ONE data projection both rich N=1 cards (blocking transcript card and
 * background-final poll card) consume. A pure view built from frozen details
 * plus a few render-time bits; the rich-card assembler in `progress-rendering`
 * turns it into components with zero surface branching beyond the flags carried
 * here. Live registry state is never required — replayed transcripts project
 * the same shape.
 *
 * Surface differences are encoded as data, not duplicate assembly:
 *  - `background` toggles the `• background` header badge; `partial` the
 *    partial-outcome chip.
 *  - `backgroundStatus` carries the raw async-task status so the neutral
 *    `cancelled` colouring (box bg + badge) survives the coarse
 *    {@link RenderStatus} fold (a blocking failure stays error-red).
 *  - `showTerminalSections` gates the final-output box and the usage line
 *    (`!isPartial` for blocking; `renderStatus !== "running"` for background).
 *  - `spaceBeforeTrailWhenExpanded` / `spaceBeforeOutputWhenExpanded` capture
 *    the two surfaces' distinct spacer placement in the expanded trail view.
 */
export interface WorkerRunFinal {
  surface: "blocking" | "background";
  /** Display name in the header title. */
  headerName: string;
  /** Tool name shown on the trailing usage status line. */
  statusLineName: string;
  model: string | undefined;
  contextWindow: number | undefined;
  /** Coarse status: box bg (blocking), section gating, diagnostic colour. */
  status: RenderStatus;
  /** Raw async-task status (background badge + neutral-cancelled bg). */
  backgroundStatus?: string;
  /** Whether the final-output box and usage line render. */
  showTerminalSections: boolean;
  collapsedBody: string | undefined;
  expandedBody: string | undefined;
  /** Cleaned final output text; surface-specific source. */
  output: string;
  trail: readonly MmrWorkerTrailItem[];
  trailWorkerPrompt: string | undefined;
  suppressDuplicateFinalOutput: boolean;
  usage: MmrWorkerUsageStats | undefined;
  diagnostic: string | undefined;
  diagnosticStatus: RenderStatus;
  fallbackNotice: string | undefined;
  /** Render the `• background` header badge. */
  background: boolean;
  /** Render the partial-outcome chip. */
  partial: boolean;
  spaceBeforeTrailWhenExpanded: "never" | "whenRawTrailNonEmpty";
  spaceBeforeOutputWhenExpanded: "always" | "conditional";
}

/** Discriminated input for {@link buildWorkerRunFinal}. */
export type WorkerRunFinalInput =
  | {
      surface: "blocking";
      toolName: string;
      details: SubagentProgressDetails | undefined;
      isPartial: boolean;
      context: RenderContextLike | undefined;
      /** Derived at the call site via `operationLabel` (needs `context.args`). */
      collapsedBody: string | undefined;
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

/**
 * Project a frozen worker-result payload into the {@link WorkerRunFinal} both
 * rich cards render. Pure: status/model/diagnostic/body precedence is derived
 * here (reusing `statusFromDetails`, `stripProvider`, `diagnosticMessage`, and
 * `backgroundTaskDisplayText`), so the two entry points never re-derive them
 * inline. During the envelope dual-write window the rich fields (trail, usage,
 * model, body) are read from the legacy details shape — which the producers
 * still stamp alongside the light envelope snapshot — so replay parity holds
 * without doubling the session-log size.
 */
export function buildWorkerRunFinal(input: WorkerRunFinalInput): WorkerRunFinal {
  if (input.surface === "background") {
    const { details, final } = input;
    const renderStatus = backgroundTaskRenderStatus(details.status) ?? "failed";
    const model = stripProvider(final.reportedModel ?? final.model ?? details.resolvedModel);
    const operation = backgroundTaskDisplayText(details, final, input.startDisplay);
    return {
      surface: "background",
      headerName: details.agent ?? "background task",
      statusLineName: details.agent ?? "background task",
      model,
      contextWindow: final.contextWindow ?? details.contextWindow,
      status: renderStatus,
      backgroundStatus: details.status,
      showTerminalSections: renderStatus !== "running",
      collapsedBody: operation.collapsed,
      expandedBody: operation.expanded,
      output: input.output,
      trail: final.trail ?? [],
      trailWorkerPrompt: operation.expanded ?? operation.collapsed,
      suppressDuplicateFinalOutput: true,
      usage: final.usage,
      // Neutral cancel stays neutral: only a hard `failed` surfaces the
      // error-coloured diagnostic (matches the pre-collapse gate).
      diagnostic: details.status === "failed" ? details.errorMessage : undefined,
      diagnosticStatus: renderStatus,
      fallbackNotice: undefined,
      background: true,
      partial: details.terminalOutcome === "partial",
      spaceBeforeTrailWhenExpanded: "whenRawTrailNonEmpty",
      spaceBeforeOutputWhenExpanded: "always",
    };
  }

  const { details } = input;
  const status = statusFromDetails(details, input.isPartial, input.context);
  const model = stripProvider(details?.reportedModel ?? details?.model);
  return {
    surface: "blocking",
    headerName: input.toolName,
    statusLineName: input.toolName,
    model,
    contextWindow: details?.contextWindow,
    status,
    showTerminalSections: !input.isPartial,
    collapsedBody: input.collapsedBody,
    expandedBody: input.expandedBody,
    output: input.output,
    trail: details?.trail ?? [],
    trailWorkerPrompt: input.trailWorkerPrompt,
    suppressDuplicateFinalOutput: !input.isPartial,
    usage: details?.usage,
    diagnostic: diagnosticMessage(details, status),
    diagnosticStatus: status,
    fallbackNotice: details?.fallbackNotice,
    background: false,
    partial: false,
    spaceBeforeTrailWhenExpanded: "never",
    spaceBeforeOutputWhenExpanded: "conditional",
  };
}
