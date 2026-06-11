import {
  type AgentToolResult,
  type MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { isRecord } from "../mmr-core/internal/json.js";
import {
  getAboveEditorDashboardSlotRowBudget,
  updateAboveEditorDashboardSlot,
} from "../mmr-core/above-editor-dashboard.js";
import { reassertLowerAboveEditorWidgets } from "../mmr-core/above-editor-order.js";
import {
  formatTitle,
  statusBgFn,
  statusFromDetails,
  stripProvider,
  textContent,
  type BackgroundTaskDetails,
  type RenderContextLike,
  type RenderStatus,
  type SubagentProgressDetails,
  type SubagentTheme,
} from "./subagent-render-format.js";
import {
  expandedOperationLabel,
  operationLabel,
  operationLabelFromArgs,
  startTaskDisplayFromArgs,
  workerPromptFromArgs,
} from "./tool-argument-display.js";
import {
  addDiagnostic,
  addFallbackNoticeBlock,
  addFinalOutputBox,
  addMarkdownBlock,
  addTaskBox,
  addTrailComponents,
  taskPreviewForDisplay,
  WorkerStatusLineComponent,
} from "./subagent-trail-components.js";
import { getMmrBackgroundCardExtras } from "./background-dispatch.js";
import {
  advanceLoaderFrame,
  backgroundStatusColor,
  backgroundStatusGlyph,
  backgroundStatusWord,
  compareRows,
  currentLoaderFrame,
  groupMembersFromBoard,
  isTerminalRowStatus,
  makeSafeFg,
  PI_LOADER_INTERVAL_MS,
  renderRowLine,
  renderWidgetSection,
  revealedRows,
  singleRowFromBoard,
  staticWidgetRow,
  synthesizeGroup,
  toRow,
  truncateWidgetLines,
  type BackgroundViewTheme,
  type MmrWidgetGroupResolver,
  type WidgetRow,
  type WidgetSection,
} from "./background-task-view.js";
import type {
  MmrAsyncTaskBoard,
  MmrAsyncTaskBoardEntry,
  MmrAsyncTaskGroupSnapshot,
} from "./async-task-registry.js";
import type { AsyncTaskFleetDetails } from "./async-task-tool-schemas.js";

/**
 * Live-state resolvers for the inline background card. Supplied by the async
 * task tools (which hold the registry) so the card reflects real-time child
 * status; absent on replayed transcripts, where the card falls back to the
 * static `details` snapshot. Mirrors the resolver the aboveEditor widget uses.
 */
export interface BackgroundCardExtras {
  resolveBoard?: (sessionKey: string) => MmrAsyncTaskBoard | undefined;
  resolveGroup?: (sessionKey: string, groupId: string) => MmrAsyncTaskGroupSnapshot | undefined;
}

/**
 * Result of a card `build` thunk: the current lines plus an optional `settled`
 * flag that drives gated spawn cards (see {@link BackgroundCardComponent}).
 */
interface CardBuild {
  lines: readonly string[];
  /**
   * Gated spawn cards only:
   * - `false` — run still in progress; render NOTHING inline.
   * - `true`  — run finished; `lines` are the static completed snapshot.
   * `undefined` — non-gated result card, rendered live every frame.
   */
  settled?: boolean;
}

/**
 * Borderless inline card body: theme-coloured lines truncated to the render
 * width.
 *
 * The lines are produced by a `build` thunk called inside {@link render} on
 * EVERY frame, not baked once at construction. The host's render loop
 * (`requestRender` → `doRender` → `render(width)`) re-invokes a mounted
 * component's `render`, but it does NOT re-run the tool's `renderResult`, so a
 * card that captured live state at construction would freeze.
 *
 * Spawn cards (start_task / fleet declaration / group-opener) are GATED: while
 * the run is in progress the live, animated state lives ONLY in the pinned
 * aboveEditor widget and the inline card renders nothing (`settled === false`).
 * Once the run finishes (`settled === true`) the card LATCHES a static
 * completed snapshot and keeps showing it even after the live board drops the
 * rows. Non-gated result cards (an explicit group task_poll/task_wait/
 * task_cancel) return `settled === undefined` and render live every frame.
 */
class BackgroundCardComponent implements Component {
  private build: (() => CardBuild) | undefined;
  private latched: readonly string[] | undefined;
  constructor(build: () => CardBuild) {
    this.build = build;
  }
  render(width: number): string[] {
    // Once a gated card settles it freezes: keep the completed snapshot even
    // after the live board drops the finished rows.
    if (this.latched !== undefined) return truncateWidgetLines(this.latched, width);
    if (!this.build) return [];
    const { lines, settled } = this.build();
    if (settled === undefined) return truncateWidgetLines(lines, width);
    if (!settled) return [];
    this.latched = lines;
    return truncateWidgetLines(lines, width);
  }
  /** Blank the card so a remembered call card does not duplicate the result. */
  clear(): void {
    this.build = undefined;
    this.latched = undefined;
  }
  invalidate(): void {
    // No cached state beyond the settle latch: the `build` thunk recomputes the
    // lines from the live board on every render(width) call until it latches.
  }
}

function rowsAnyRunning(rows: readonly WidgetRow[]): boolean {
  return rows.some((r) => r.status === "running" || r.status === "cancelling");
}

/**
 * Live state for one card render frame. Resolved ONCE per frame by
 * {@link renderBackgroundWorkerCard} — the single live-vs-replay decision
 * every card kind shares: the live board when the renderer-only `sessionKey`
 * resolves, else `undefined`, in which case each section falls back to its
 * frozen `details` snapshot.
 */
interface CardLiveState {
  board: MmrAsyncTaskBoard | undefined;
  resolveGroup(groupId: string): MmrAsyncTaskGroupSnapshot | undefined;
}

/**
 * Builds one card section for the current frame: live rows when the board is
 * available, frozen-fallback rows otherwise. `groupId: undefined` marks the
 * headerless N=1 section.
 */
type CardSectionBuilder = (live: CardLiveState) => WidgetSection;

/**
 * THE inline background card. Single, group, and fleet cards are this one
 * component at N=1 (a headerless row), N (one headed section), and N-groups
 * (a headed section per declared group) — the only thing a card kind supplies
 * is how its sections resolve rows for a frame.
 *
 * `gated` cards (every spawn surface: start_task single, group opener, fleet
 * declaration) render NOTHING while the run is in flight — the live, animated
 * state lives only in the pinned aboveEditor widget — then latch a static
 * completed snapshot once every row settles (see
 * {@link BackgroundCardComponent}). Non-gated cards (an explicit group
 * task_poll/task_wait/task_cancel result) render live every frame: staged
 * reveal on the shared cadence, the shared loader frame on running rows, and a
 * muted member-count fallback when no live registry backs a replayed group.
 */
function renderBackgroundWorkerCard(options: {
  sessionKey: string | undefined;
  extras: BackgroundCardExtras | undefined;
  theme: SubagentTheme;
  buildSections: readonly CardSectionBuilder[];
  gated: boolean;
}): Component {
  const { sessionKey, extras, theme, buildSections, gated } = options;
  // Everything live is computed inside the thunk so the card re-resolves the
  // board, reveal, loader frame and elapsed on every render(width) frame.
  const build = (): CardBuild => {
    const live: CardLiveState = {
      board: sessionKey ? extras?.resolveBoard?.(sessionKey) : undefined,
      resolveGroup: (groupId) =>
        sessionKey ? extras?.resolveGroup?.(sessionKey, groupId) : undefined,
    };
    const sections = buildSections.map((buildSection) => buildSection(live));
    const allRows = sections.flatMap((s) => s.rows);

    if (gated) {
      // Invisible until every row across every section settles; then a static
      // completed snapshot.
      const settled = allRows.length > 0 && allRows.every((r) => isTerminalRowStatus(r.status));
      if (!settled) return { lines: [], settled: false };
      return {
        lines: sections.flatMap((section) => renderWidgetSection(section, theme, undefined)),
        settled: true,
      };
    }

    // Staged reveal keeps a freshly resolved live card invisible during the
    // brief settle window, then reveals rows on the shared cadence;
    // `revealedRows` reveals everything at once when no row is active. During
    // the settle window return NO lines (mounted-but-invisible so a later tick
    // re-runs this thunk) rather than a static Container that would never
    // reappear. Replay / no live registry (a section with zero rows) shows the
    // whole card immediately.
    const revealed = sections.map((section) =>
      section.rows.length > 0 ? revealedRows(section.rows, Date.now()) : section.rows,
    );
    if (allRows.length > 0 && revealed.every((rows) => rows.length === 0)) return { lines: [] };

    const frame = sections.some((s) => rowsAnyRunning(s.rows) || s.group?.status === "running")
      ? currentLoaderFrame()
      : undefined;
    const lines: string[] = [];
    sections.forEach((section, index) => {
      lines.push(...renderWidgetSection({ ...section, rows: revealed[index] ?? [] }, theme, frame));
      if (section.rows.length === 0) {
        // Replay / no live registry: the header carries status + counts; add a
        // muted member-count line so the card is not a lone header.
        const total = section.group?.counts.total;
        if (typeof total === "number" && total > 0) {
          lines.push(`  ${theme.fg("muted", `${total} task${total === 1 ? "" : "s"}`)}`);
        }
      }
    });
    return { lines };
  };
  return new BackgroundCardComponent(build);
}

/**
 * Fleet sections (N-groups): every declared group is its own section,
 * decoupled from execution. Each member row is built in DECLARED order (by
 * the declaration's `rows`, never the running-first reorder) so a row animates
 * in place through ready→running→terminal instead of jumping. Live rows come
 * from the board; a member the live board does not (yet) have falls back to
 * its frozen `ready` declaration, so a freshly-declared fleet — and a replayed
 * transcript with no live registry — both resolve the full declared shape.
 */
function fleetSectionBuilders(fleet: AsyncTaskFleetDetails): CardSectionBuilder[] {
  return fleet.groups.map((group) => (live) => {
    const rows = group.rows.map((row) => {
      const liveRow = live.board && row.taskId ? singleRowFromBoard(live.board, row.taskId) : undefined;
      return liveRow ?? staticWidgetRow({
        taskId: row.taskId,
        status: "ready",
        agent: row.agent,
        description: row.description,
        deferredLaunch: true,
        groupId: group.groupId,
        resolvedModel: row.resolvedModel,
        capabilityProfile: row.capabilityProfile,
      });
    });
    const snapshot = live.resolveGroup(group.groupId);
    const synth = synthesizeGroup(rows);
    const label = snapshot?.label ?? group.label ?? synth.label;
    return {
      groupId: group.groupId,
      group: {
        status: snapshot?.status ?? synth.status,
        counts: snapshot?.counts ?? synth.counts,
        ...(label !== undefined ? { label } : {}),
      },
      rows,
    };
  });
}

/**
 * Group section (N): one header plus a row per member, drawn from the live
 * board when a resolver is available, else the static `details.group` counts.
 * Used for the group-opening start_task and for every group
 * task_poll/task_wait/task_cancel result — the verbose model-facing group text
 * never reaches the transcript.
 */
function groupSectionBuilder(details: BackgroundTaskDetails, groupId: string): CardSectionBuilder {
  return (live) => {
    const members = live.board ? groupMembersFromBoard(live.board, groupId) : [];
    const snapshot = (details.group as MmrAsyncTaskGroupSnapshot | undefined)
      ?? live.resolveGroup(groupId);
    const group = snapshot
      ? { status: snapshot.status, counts: snapshot.counts, ...(snapshot.label !== undefined ? { label: snapshot.label } : {}) }
      : members.length > 0 ? synthesizeGroup(members) : undefined;
    return { groupId, ...(group ? { group } : {}), rows: members };
  };
}

/**
 * Single section (N=1): the lone ungrouped task as one headerless row —
 * `⠋ finder <desc> · <elapsed> · <model>` — from the live board row when
 * available, else the frozen `details` snapshot.
 */
function singleSectionBuilder(details: BackgroundTaskDetails): CardSectionBuilder {
  return (live) => {
    const liveRow = live.board && details.taskId
      ? singleRowFromBoard(live.board, details.taskId)
      : undefined;
    const row = liveRow ?? staticWidgetRow({
      taskId: details.taskId,
      status: details.status,
      agent: details.agent,
      description: details.description,
      terminalOutcome: details.terminalOutcome as WidgetRow["terminalOutcome"],
      resolvedModel: details.resolvedModel,
      contextWindow: details.contextWindow,
      groupId: details.groupId,
    });
    return { groupId: undefined, rows: [row] };
  };
}

export const ASYNC_TASK_COMPLETION_CUSTOM_TYPE = "mmr-subagents.async-task-completion" as const;

/**
 * Structured payload carried on the async-task completion push message's
 * `details`. The renderer reads this instead of parsing the model-facing
 * XML `content`. `description` is included so the row can show the task
 * label without scraping the XML; older replayed messages may omit it.
 */
export interface AsyncTaskCompletionDetails {
  version: 1;
  kind: typeof ASYNC_TASK_COMPLETION_CUSTOM_TYPE;
  taskId?: string;
  groupId?: string;
  status: string;
  description?: string;
  outcomeText?: string;
}

const RESULT_RENDERED_STATE_KEY = "mmrSubagentResultRendered";
const CALL_COMPONENT_STATE_KEY = "mmrSubagentCallComponent";

function renderState(context: RenderContextLike | undefined): Record<string, unknown> | undefined {
  return isRecord(context?.state) ? context.state : undefined;
}

function rememberCallComponent(context: RenderContextLike | undefined, component: Component): void {
  const state = renderState(context);
  if (state) state[CALL_COMPONENT_STATE_KEY] = component;
}

function clearRenderedCall(context: RenderContextLike | undefined): void {
  const component = renderState(context)?.[CALL_COMPONENT_STATE_KEY];
  if (component instanceof Text) component.setText("");
  else if (component instanceof Container) component.clear();
  else if (component instanceof Box) component.clear();
  else if (component instanceof BackgroundCardComponent) component.clear();
}

function markResultRendered(context: RenderContextLike | undefined): void {
  const state = renderState(context);
  if (state) state[RESULT_RENDERED_STATE_KEY] = true;
}

function resultAlreadyRendered(context: RenderContextLike | undefined): boolean {
  return renderState(context)?.[RESULT_RENDERED_STATE_KEY] === true;
}

export function renderMmrBackgroundTaskCall(
  toolName: string,
  _args: unknown,
  _theme: SubagentTheme,
  _context?: RenderContextLike,
): Component {
  if (toolName !== "start_task") return new Container();
  // The result card owns the entire staged reveal, so the call renders nothing:
  // suppressing the transient "starting" row keeps it from flashing during the
  // post-spawn prep window before the result card takes over.
  return new Container();
}

export function renderMmrBackgroundTaskResult(
  _toolName: string,
  result: AgentToolResult<unknown>,
  options: { expanded?: boolean; isPartial?: boolean },
  theme: SubagentTheme,
  context?: RenderContextLike,
  extras?: BackgroundCardExtras,
): Component {
  const details = result.details as BackgroundTaskDetails | undefined;
  const output = textContent(result).trim();

  // 0. Fleet declaration (start_task.fleet) → all group sections in one card,
  //    decoupled from execution; rows animate ready→running→terminal in place.
  if (details?.fleet !== undefined) {
    clearRenderedCall(context);
    return renderBackgroundWorkerCard({
      sessionKey: details.sessionKey,
      extras,
      theme,
      buildSections: fleetSectionBuilders(details.fleet as AsyncTaskFleetDetails),
      gated: true,
    });
  }

  // 1. No-id board (task_poll list mode) → grouped board view.
  if (details?.board !== undefined) {
    const boardComponent = renderBackgroundTaskBoard(details.board, theme);
    if (boardComponent) return boardComponent;
    const container = new Container();
    addMarkdownBlock(container, output, theme, { paddingX: 1 });
    return container;
  }

  // 2. Group control result (task_poll / task_wait / task_cancel with group_id)
  //    → one consolidated member-list card, rendered live every frame. The
  //    verbose model-facing group text carried in `content` is intentionally
  //    never drawn into the transcript.
  if (details?.group !== undefined) {
    clearRenderedCall(context);
    if (!details.groupId) return new Container();
    return renderBackgroundWorkerCard({
      sessionKey: details.sessionKey,
      extras,
      theme,
      buildSections: [groupSectionBuilder(details, details.groupId)],
      gated: false,
    });
  }

  if (details?.worker !== "mmr-subagents.async-task") {
    const container = new Container();
    addMarkdownBlock(container, output, theme, { paddingX: 1 });
    return container;
  }

  // 3. start_task spawn → GATED inline card: the group section for the
  //    group-opening call, nothing for sibling starts (one card per group), and
  //    a single row when ungrouped. During startup and the run the inline card
  //    is invisible — the live, animated state lives only in the pinned
  //    aboveEditor widget; the card latches a static completed view once the
  //    run settles.
  if (details.tool === "start_task" || details.backgroundStart === true) {
    clearRenderedCall(context);
    if (details.groupId && !details.groupOpener) return new Container();
    return renderBackgroundWorkerCard({
      sessionKey: details.sessionKey,
      extras,
      theme,
      buildSections: [
        details.groupId
          ? groupSectionBuilder(details, details.groupId)
          : singleSectionBuilder(details),
      ],
      gated: true,
    });
  }

  // 4. Single-task task_poll / task_wait / task_cancel → rich result card
  //    (model header, Markdown body, trail, final output, usage line). This is
  //    the result-retrieval surface and is unchanged.
  const renderStatus = backgroundTaskRenderStatus(details.status);
  if (!renderStatus || !details.taskId || !details.agent) {
    const container = new Container();
    addMarkdownBlock(container, output || details.errorMessage, theme, { paddingX: 1 });
    return container;
  }

  // Reuse the subagent rendering building blocks so a polled background result
  // matches a blocking subagent (model in the header, Markdown task body,
  // trail, usage line), while keeping background-specific status semantics
  // (neutral cancelled, the `background` badge).
  const subDetails = (isRecord(details.final) ? details.final : {}) as SubagentProgressDetails;
  const model = stripProvider(subDetails.reportedModel ?? subDetails.model ?? details.resolvedModel);
  const contextWindow = subDetails.contextWindow ?? details.contextWindow;
  const expanded = options.expanded === true;
  const startDisplay = details.tool === "start_task" ? startTaskDisplayFromArgs(context?.args) : undefined;
  const operation = backgroundTaskDisplayText(details, subDetails, startDisplay);

  const container = new Container();
  const box = new Box(1, 1, backgroundStatusBgFn(details.status, theme));
  box.addChild(new Text(backgroundTaskHeaderLine(details, model, theme), 0, 0));
  const preview = taskPreviewForDisplay(operation.collapsed, operation.expanded, expanded);
  addMarkdownBlock(box, preview.body, theme, { paddingX: 1 });
  if (preview.hint) box.addChild(new Text(theme.fg("muted", preview.hint), 1, 0));
  // Gate the error diagnostic on the raw status, not the coarse renderStatus
  // (which folds cancelled into failed). A user-initiated cancel is neutral and
  // must not surface an error-colored diagnostic.
  if (details.errorMessage && details.status === "failed") {
    addDiagnostic(box, details.errorMessage, renderStatus, theme);
  }
  container.addChild(box);

  const cleanFinal = details.finalOutput?.trim() ?? "";
  const trail = subDetails.trail ?? [];
  if (expanded && trail.length > 0) {
    container.addChild(new Spacer(1));
    addTrailComponents(container, trail, cleanFinal, theme, context, operation.expanded ?? operation.collapsed, true);
  }

  if (cleanFinal && renderStatus !== "running") {
    container.addChild(new Spacer(1));
    addFinalOutputBox(container, cleanFinal, theme);
  }

  if (renderStatus !== "running" && (subDetails.usage || model)) {
    container.addChild(new Spacer(1));
    container.addChild(
      new WorkerStatusLineComponent(details.agent, subDetails.usage, contextWindow, model, theme),
    );
  }

  return container;
}

function asyncTaskCompletionHeaderLine(
  details: AsyncTaskCompletionDetails | undefined,
  theme: SubagentTheme,
): string {
  const title = theme.fg("toolTitle", theme.bold("background task"));
  const badge = theme.fg("muted", "finished");
  return `${title} ${theme.fg("muted", "•")} ${badge}  ${backgroundStatusBadge(details?.status, theme)}`;
}

/**
 * Renderer for the `mmr-subagents.async-task-completion` push message.
 *
 * The message `content` stays the model-facing `<task-notification>` XML
 * (the agent consumes it next turn); this renderer draws the human-facing
 * row from the structured `details` instead of dumping that XML into the
 * transcript. Returning `undefined` (e.g. malformed or legacy details)
 * makes the host fall back to its default custom-message box.
 */
export const renderAsyncTaskCompletionMessage: MessageRenderer<AsyncTaskCompletionDetails> = (
  message,
  _options,
  theme,
) => {
  try {
    const details = message.details;
    const box = new Box(1, 1, backgroundStatusBgFn(details?.status, theme));
    box.addChild(new Text(asyncTaskCompletionHeaderLine(details, theme), 0, 0));
    addMarkdownBlock(box, details?.description, theme, { paddingX: 1 });
    addMarkdownBlock(box, details?.outcomeText, theme, { paddingX: 1 });
    const groupId = details?.groupId?.trim();
    const taskId = details?.taskId?.trim();
    if (groupId) {
      box.addChild(new Text(theme.fg("muted", `task_poll({group_id:"${groupId}"})`), 0, 0));
    } else if (taskId) {
      box.addChild(new Text(theme.fg("muted", `task_poll({task_id:"${taskId}"})`), 0, 0));
    }
    const container = new Container();
    container.addChild(box);
    return container;
  } catch {
    return undefined;
  }
};

export function renderMmrSubagentCall(
  toolName: string,
  args: unknown,
  theme: SubagentTheme,
  context?: RenderContextLike,
): Component {
  if (context?.isPartial === false || resultAlreadyRendered(context)) return new Container();
  // v2 background call through a named worker tool: like start_task, the
  // result card owns the entire staged reveal, so the call renders nothing.
  if (isRecord(args) && args.background === true) return new Container();
  const title = theme.fg("toolTitle", theme.bold(toolName));
  const label = operationLabelFromArgs(toolName, args);
  const component = context?.lastComponent instanceof Box ? context.lastComponent : new Box(1, 1, statusBgFn("running", theme));
  component.setBgFn(statusBgFn("running", theme));
  component.clear();
  component.addChild(new Text(title, 0, 0));
  if (label?.trim()) {
    addMarkdownBlock(component, label, theme, { paddingX: 1 });
  }
  rememberCallComponent(context, component);
  return component;
}

export function renderMmrSubagentResult(
  toolName: string,
  result: AgentToolResult<unknown>,
  options: { expanded?: boolean; isPartial?: boolean },
  theme: SubagentTheme,
  context?: RenderContextLike,
): Component {
  // v2 background start through a named worker tool: the result is a
  // background-task payload, so it renders through the background card path
  // (live registry resolvers come from the dispatch seam — the named tools'
  // render wiring has no registry access of its own).
  const rawDetails = result.details as { worker?: string } | undefined;
  if (rawDetails?.worker === "mmr-subagents.async-task") {
    return renderMmrBackgroundTaskResult(toolName, result, options, theme, context, getMmrBackgroundCardExtras());
  }
  const details = result.details as SubagentProgressDetails | undefined;
  const output = textContent(result).trim();
  const expanded = options.expanded === true;
  const isPartial = options.isPartial === true;
  const model = stripProvider(details?.reportedModel ?? details?.model);
  const status = statusFromDetails(details, isPartial, context);
  const operation = operationLabel(toolName, details, context);
  const expandedOperation = expandedOperationLabel(toolName, details, context);
  const container = new Container();
  clearRenderedCall(context);
  markResultRendered(context);

  const hasTaskBody = addTaskBox(container, toolName, details, operation, expanded, status, theme, expandedOperation);
  addFallbackNoticeBlock(container, details?.fallbackNotice, theme);

  if (!expanded) {
    if (!isPartial && output) {
      container.addChild(new Spacer(1));
      addFinalOutputBox(container, output, theme);
    }
    if (!isPartial && (details?.usage || model)) {
      container.addChild(new Spacer(1));
      container.addChild(new WorkerStatusLineComponent(toolName, details?.usage, details?.contextWindow, model, theme));
    }
    return container;
  }

  const trail = details?.trail ?? [];
  const hasTrail = addTrailComponents(
    container,
    trail,
    output,
    theme,
    context,
    workerPromptFromArgs(toolName, details, context),
    !isPartial,
  );

  if (!isPartial && output) {
    if (hasTrail || hasTaskBody) container.addChild(new Spacer(1));
    addFinalOutputBox(container, output, theme);
  }

  if (!isPartial && (details?.usage || model)) {
    container.addChild(new Spacer(1));
    container.addChild(new WorkerStatusLineComponent(toolName, details?.usage, details?.contextWindow, model, theme));
  }

  return container;
}


// ---------------------------------------------------------------------------
// Background board + per-call status primitives (folded from the former
// background-task-rendering module: same consumers, one render module).
// ---------------------------------------------------------------------------

export function backgroundTaskRenderStatus(status: string | undefined): RenderStatus | undefined {
  if (status === "running" || status === "cancelling") return "running";
  if (status === "succeeded") return "succeeded";
  if (status === "failed" || status === "cancelled") return "failed";
  return undefined;
}

export function backgroundStatusBgFn(
  status: string | undefined,
  theme: SubagentTheme,
): (text: string) => string {
  if (status === "succeeded") return (text) => theme.bg?.("toolSuccessBg", text) ?? text;
  if (status === "failed") return (text) => theme.bg?.("toolErrorBg", text) ?? text;
  if (status === "running" || status === "cancelling") {
    return (text) => theme.bg?.("toolPendingBg", text) ?? text;
  }
  // cancelled / unknown: neutral background so an intentional cancel never
  // reads as a hard failure.
  return (text) => text;
}

export function backgroundStatusBadge(
  status: string | undefined,
  theme: SubagentTheme,
): string {
  // The shared glyph/colour helpers expect a concrete status; an unknown one
  // resolves to the neutral `•`/muted pair, matching the prior local behavior.
  const concrete = status ?? "";
  const color = backgroundStatusColor(concrete);
  return `${theme.fg(color, backgroundStatusGlyph(concrete))} ${theme.fg(color, backgroundStatusWord(status))}`;
}

export function backgroundTaskHeaderLine(
  details: BackgroundTaskDetails,
  model: string | undefined,
  theme: SubagentTheme,
): string {
  const title = formatTitle(details.agent ?? "background task", model, theme);
  const badge = theme.fg("muted", "background");
  const outcome = details.terminalOutcome === "partial" ? ` ${theme.fg("warning", "partial")}` : "";
  return `${title} ${theme.fg("muted", "•")} ${badge}  ${backgroundStatusBadge(details.status, theme)}${outcome}`;
}

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

const BACKGROUND_STATUS_VALUES: ReadonlySet<string> = new Set([
  "ready",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
]);
const BACKGROUND_FRESHNESS_VALUES: ReadonlySet<string> = new Set([
  "healthy",
  "stalled",
  "dead",
  "terminal",
]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// Validate only the fields the board renderer reads. The producer always emits
// the full entry; this localized narrowing keeps a malformed/replayed payload
// from reaching the row formatter (which would mis-render or throw).
function isBackgroundTaskBoardEntry(value: unknown): value is MmrAsyncTaskBoardEntry {
  return (
    isRecord(value) &&
    typeof value.taskId === "string" &&
    typeof value.agent === "string" &&
    typeof value.description === "string" &&
    typeof value.status === "string" &&
    BACKGROUND_STATUS_VALUES.has(value.status) &&
    typeof value.freshness === "string" &&
    BACKGROUND_FRESHNESS_VALUES.has(value.freshness)
  );
}

function isBackgroundTaskBoard(value: unknown): value is MmrAsyncTaskBoard {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.counts)) return false;
  const counts = value.counts;
  if (
    !isFiniteNumber(counts.active) ||
    !isFiniteNumber(counts.stalled) ||
    !isFiniteNumber(counts.finished)
  ) {
    return false;
  }
  return (
    Array.isArray(value.active) && value.active.every(isBackgroundTaskBoardEntry) &&
    Array.isArray(value.stalled) && value.stalled.every(isBackgroundTaskBoardEntry) &&
    Array.isArray(value.finished) && value.finished.every(isBackgroundTaskBoardEntry)
  );
}

function backgroundBoardEntryLine(entry: MmrAsyncTaskBoardEntry, theme: SubagentTheme): string {
  // The shared row formatter, led by the accent task id (the handle for a
  // follow-up task_poll) and trailed by the dim group id (the board is a flat
  // state-bucketed list with no group section headers). A zero board timestamp
  // keeps the elapsed chip frozen at the entry's recorded runtime — the board
  // card is a static transcript snapshot, not a live surface.
  return renderRowLine(toRow(entry, 0), theme, undefined, {
    indent: "  ",
    showTaskId: true,
    showGroupId: true,
  });
}

/**
 * Compact grouped board for `task_poll` with no task id. Renders the same
 * structured counts/sections the model receives, but as a glyph-led TUI board
 * instead of a plain-text dump. Returns undefined for malformed/legacy board
 * payloads so the caller can fall back to the text content.
 */
export function renderBackgroundTaskBoard(value: unknown, theme: SubagentTheme): Component | undefined {
  if (!isBackgroundTaskBoard(value)) return undefined;
  const board = value;
  const container = new Container();
  const total = board.counts.active + board.counts.stalled + board.counts.finished;
  const headGlyph = board.counts.active > 0
    ? theme.fg("warning", backgroundStatusGlyph("running"))
    : theme.fg("muted", "•");
  const counts = theme.fg(
    "muted",
    `${board.counts.active} active • ${board.counts.stalled} stalled • ${board.counts.finished} finished`,
  );
  container.addChild(
    new Text(`${theme.fg("toolTitle", theme.bold("background tasks"))}  ${headGlyph} ${counts}`, 1, 0),
  );
  if (total === 0) {
    container.addChild(new Text(theme.fg("muted", "No background tasks in this session."), 1, 0));
    return container;
  }
  const section = (title: string, entries: readonly MmrAsyncTaskBoardEntry[]): void => {
    if (entries.length === 0) return;
    container.addChild(new Text(theme.fg("dim", title), 1, 0));
    for (const entry of entries) {
      container.addChild(new Text(backgroundBoardEntryLine(entry, theme), 1, 0));
    }
  };
  section("Active", board.active);
  section("Stalled", board.stalled);
  section("Finished", board.finished);
  return container;
}


// ---------------------------------------------------------------------------
// Pinned aboveEditor widget (folded from the former background-task-widget
// module): the live, at-a-glance board for background workers. The widget is
// a pure UI mirror of the registry; the row/header/glyph vocabulary and the
// loader animation clock live in ./background-task-view.ts, and the inline
// transcript cards above render the SAME rows from there.
// ---------------------------------------------------------------------------

export type { MmrWidgetGroupResolver } from "./background-task-view.js";

/**
 * Stable widget id used with `ctx.ui.setWidget(...)`. Process-wide unique to
 * mmr-subagents so it never collides with the mmr-toolbox task-list widget.
 */
export const BACKGROUND_TASK_WIDGET_ID = "pi-mmr-background-tasks";

/** Cap visible lines (group headers + rows) so a long backlog never pushes the editor off-screen. */
const WIDGET_MAX_ROWS = 8;

/**
 * How long a finished task lingers in its group section before dropping off the
 * live widget. The registry retains terminal records far longer (for the result
 * card); this is purely the brief "show the wave settle in place" window so a
 * completed group flips to ✓/✕ for a beat before the section disappears. The
 * eventual task_poll/wait card remains the durable record of the outcome.
 */
const WIDGET_FINISHED_RETENTION_MS = 8_000;

/** Minimal view of the live Pi TUI the widget factory needs to animate. */
interface WidgetTuiLike {
  requestRender?(force?: boolean): void;
}

type WidgetFactory = (tui: WidgetTuiLike, theme: BackgroundViewTheme) => {
  render(width: number): string[];
  invalidate(): void;
  dispose?(): void;
};

interface WidgetUILike {
  setWidget(
    id: string,
    value: readonly string[] | WidgetFactory | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  theme?: BackgroundViewTheme;
}

interface WidgetCtxLike {
  hasUI?: boolean;
  /** Pi 0.78+ run mode (`"tui" | "rpc" | "json" | "print"`). */
  mode?: string;
  ui?: WidgetUILike;
}

/**
 * Whether `ctx` is a terminal UI that can host Pi's pinned custom widget.
 * Mirrors the mmr-toolbox task-list widget gate so behavior is identical
 * across our `>=0.77.0 <0.79.0` peer range: gate strictly on `mode === "tui"`
 * when `mode` is present (0.78+), else fall back to `hasUI` (0.77).
 */
export function isTuiWidgetSurface(ctx: WidgetCtxLike | undefined): boolean {
  if (!ctx?.ui) return false;
  if (typeof ctx.mode === "string") return ctx.mode === "tui";
  return ctx.hasUI === true;
}

/**
 * Bucket the board into per-group sections in display order: groups first
 * (earliest-launched group on top, mirroring how parallel waves stack), then a
 * trailing ungrouped bucket. In-flight rows (active + stalled) always show;
 * finished rows show only while within `WIDGET_FINISHED_RETENTION_MS` of
 * completion, so a settled wave lingers briefly in place before dropping.
 */
function boardSections(
  board: MmrAsyncTaskBoard,
  resolveGroup: MmrWidgetGroupResolver | undefined,
  nowMs: number,
): WidgetSection[] {
  const retainedFinished = board.finished.filter(
    (entry) =>
      typeof entry.completedAtMs === "number" &&
      Number.isFinite(entry.completedAtMs) &&
      nowMs - entry.completedAtMs <= WIDGET_FINISHED_RETENTION_MS,
  );
  const entries = [...board.active, ...board.stalled, ...retainedFinished];

  const order: (string | undefined)[] = [];
  const buckets = new Map<string | undefined, WidgetRow[]>();
  for (const entry of entries) {
    const key = entry.groupId;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.push(toRow(entry, board.generatedAtMs));
  }

  const grouped: { section: WidgetSection; minCreated: number }[] = [];
  let ungrouped: WidgetSection | undefined;
  for (const key of order) {
    const rows = buckets.get(key)!.slice().sort(compareRows);
    if (key === undefined) {
      ungrouped = { groupId: undefined, rows };
      continue;
    }
    const resolved = resolveGroup?.(key);
    const group = resolved
      ? {
          status: resolved.status,
          counts: resolved.counts,
          ...(resolved.label !== undefined ? { label: resolved.label } : {}),
        }
      : synthesizeGroup(rows);
    const minCreated = rows.reduce((min, r) => Math.min(min, r.createdAtMs), Number.POSITIVE_INFINITY);
    grouped.push({ section: { groupId: key, group, rows }, minCreated });
  }
  grouped.sort((a, b) => a.minCreated - b.minCreated);

  const sections = grouped.map((g) => g.section);
  if (ungrouped) sections.push(ungrouped);
  return sections;
}

function finishedOnlyClearDelayMs(board: MmrAsyncTaskBoard): number | undefined {
  const delays = board.finished.flatMap((entry) => {
    if (
      typeof entry.completedAtMs !== "number" ||
      !Number.isFinite(entry.completedAtMs)
    ) {
      return [];
    }
    const remainingMs = entry.completedAtMs + WIDGET_FINISHED_RETENTION_MS - board.generatedAtMs;
    return remainingMs >= 0 ? [remainingMs] : [];
  });
  if (delays.length === 0) return undefined;
  return Math.max(0, Math.min(...delays));
}

/**
 * Stage each section by its reveal cadence (see {@link revealedRows}). `nowMs`
 * is read fresh every frame so the reveal advances on the animation interval. A
 * section that reveals no rows is omitted ENTIRELY (header included) during its
 * prep window; otherwise only the revealed rows render, in section display
 * order. `revealedRows` reveals every row immediately when the section has no
 * active worker (no animation clock is guaranteed to tick it again), so a
 * finished-only section never gets stuck blank. The clear decision and timer
 * selection upstream stay based on the ACTUAL registry rows, never on this
 * staged view, so the animation interval keeps driving frames throughout the
 * reveal.
 */
function revealSections(sections: readonly WidgetSection[], nowMs: number): WidgetSection[] {
  const out: WidgetSection[] = [];
  for (const section of sections) {
    const rows = revealedRows(section.rows, nowMs);
    if (rows.length === 0) continue;
    out.push({ ...section, rows });
  }
  return out;
}

/**
 * Flatten sections into widget lines: each group prints a header then its
 * indented rows. A lone ungrouped section prints headerless and flush-left, so
 * non-grouped Task usage renders exactly as before. `WIDGET_MAX_ROWS` counts
 * headers + rows together and never splits a group across the cut — whole
 * trailing sections drop and collapse into `… N more`.
 */
function renderWidgetLines(
  sections: readonly WidgetSection[],
  theme: BackgroundViewTheme | undefined,
  activeFrame: string | undefined,
  maxRows = WIDGET_MAX_ROWS,
): string[] {
  const safeFg = makeSafeFg(theme);
  const hasGroups = sections.some((s) => s.groupId !== undefined);

  // Build each section as a self-contained block of lines so truncation can
  // drop whole sections rather than orphaning rows under a header. The
  // ungrouped bucket gets a header (and indented rows) only when grouped
  // sections are on screen alongside it.
  const blocks = sections.map((section) => ({
    lines: renderWidgetSection(section, theme, activeFrame, {
      header: section.groupId !== undefined || hasGroups,
    }),
    rowCount: section.rows.length,
  }));

  const out: string[] = [];
  let omittedRows = 0;
  let used = 0;
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    const remainingLineTotal = blocks.slice(i).reduce((sum, b) => sum + b.lines.length, 0);
    if (used + remainingLineTotal <= maxRows) {
      for (let j = i; j < blocks.length; j += 1) out.push(...blocks[j].lines);
      break;
    }

    const reserveOverflowLineLimit = maxRows - 1;
    if (used + block.lines.length <= reserveOverflowLineLimit) {
      out.push(...block.lines);
      used += block.lines.length;
      continue;
    }

    if (out.length === 0) {
      // First section alone exceeds the cap: show as many of its lines as fit
      // (header + leading rows) while still reserving the final overflow line.
      const slice = block.lines.slice(0, reserveOverflowLineLimit);
      out.push(...slice);
      used += slice.length;
      const shownRows = Math.max(0, slice.length - (block.lines.length - block.rowCount));
      omittedRows += block.rowCount - shownRows;
    } else {
      omittedRows += block.rowCount;
    }
    for (let j = i + 1; j < blocks.length; j += 1) omittedRows += blocks[j].rowCount;
    break;
  }
  if (omittedRows > 0) out.push(safeFg("dim", `… ${omittedRows} more`));
  return out;
}

/**
 * Project the current registry board onto Pi's persistent widget. Non-TUI
 * surfaces are no-ops; the widget is a UI mirror, not a state source. The
 * widget clears itself when no background agents remain.
 */
export function refreshBackgroundTaskWidget(
  ctx: WidgetCtxLike | undefined,
  board: MmrAsyncTaskBoard,
  resolveGroup?: MmrWidgetGroupResolver,
): void {
  if (!isTuiWidgetSurface(ctx) || !ctx?.ui) return;
  try {
    const sections = boardSections(board, resolveGroup, board.generatedAtMs);
    const rowTotal = sections.reduce((sum, s) => sum + s.rows.length, 0);
    if (rowTotal === 0) {
      updateAboveEditorDashboardSlot(ctx, "right", BACKGROUND_TASK_WIDGET_ID, undefined);
      return;
    }
    const hasActive = board.active.length > 0 || board.stalled.length > 0;
    const clearDelayMs = hasActive ? undefined : finishedOnlyClearDelayMs(board);
    updateAboveEditorDashboardSlot(ctx, "right", BACKGROUND_TASK_WIDGET_ID, (tui, theme) => {
      // Animate running rows with Pi's loader cadence by advancing the shared
      // loader frame (read by the inline card too) and re-rendering the whole
      // tree. Finished-only rows use a one-shot clear timer so the drop-off
      // window expires even when no active worker remains to drive future
      // widget refreshes.
      let timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout> | undefined;
      let timerKind: "interval" | "timeout" | undefined;
      if (hasActive && typeof tui?.requestRender === "function") {
        timerKind = "interval";
        timer = setInterval(() => {
          advanceLoaderFrame();
          try {
            tui.requestRender?.();
          } catch {
            if (timer !== undefined) {
              clearInterval(timer);
              timer = undefined;
              timerKind = undefined;
            }
          }
        }, PI_LOADER_INTERVAL_MS);
        (timer as { unref?: () => void }).unref?.();
      } else if (clearDelayMs !== undefined) {
        timerKind = "timeout";
        timer = setTimeout(() => {
          timer = undefined;
          timerKind = undefined;
          updateAboveEditorDashboardSlot(ctx, "right", BACKGROUND_TASK_WIDGET_ID, undefined);
        }, clearDelayMs);
        (timer as { unref?: () => void }).unref?.();
      }
      return {
        render: (width) =>
          // Read a fresh Date.now() each frame so the staged reveal advances on
          // the animation interval, mirroring currentLoaderFrame()'s clock.
          truncateWidgetLines(
            renderWidgetLines(
              revealSections(sections, Date.now()),
              theme,
              hasActive ? currentLoaderFrame() : undefined,
              Math.max(WIDGET_MAX_ROWS, getAboveEditorDashboardSlotRowBudget("right") ?? 0),
            ),
            width,
          ),
        invalidate: () => {},
        dispose: () => {
          if (timer !== undefined) {
            if (timerKind === "interval") clearInterval(timer);
            else clearTimeout(timer);
            timer = undefined;
            timerKind = undefined;
          }
        },
      };
    });
    // The background widget must stay ABOVE the task_list widget. Both live in
    // the aboveEditor stack and Pi re-appends the just-set widget to the
    // bottom, so re-emit any lower-priority widgets to push them back below.
    reassertLowerAboveEditorWidgets(ctx);
  } catch {
    // Best-effort: a widget failure must never demote a successful tool call.
  }
}
