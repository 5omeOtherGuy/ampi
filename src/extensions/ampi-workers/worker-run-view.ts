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
import { isRecord } from "../ampi-core/internal/json.js";
import type { MmrWorkerRunEnvelopeV1 } from "../ampi-core/worker-contract.js";
import { readWorkerRunEnvelope } from "./worker-run-envelope.js";
import type {
  BackgroundTaskDetails,
  SubagentProgressDetails,
} from "./subagent-render-format.js";
import type { WidgetRow, WidgetSection } from "./background-task-view.js";
import type { AsyncTaskFleetDetails } from "./async-task-tool-schemas.js";

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
