import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  buildSessionContext,
  buildSessionProjection,
  calculateContextTokens,
  type ExtensionAPI,
  estimateTokens,
  type SessionEntry,
  type SessionInfo,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { isRecord } from "./extensions/ampi-core/internal/json.js";
import { createMmrSessionIndex } from "./extensions/ampi-core/session-catalog.js";
import { includesCaseInsensitive, matchesMmrThreadIndexFilters, parseSessionQuery, resolveParentSessionId } from "./extensions/ampi-core/session-query.js";
import type { MmrModelPrice } from "./extensions/ampi-core/session-usage.js";
import type { MmrThreadRecord } from "./extensions/ampi-core/thread-index.js";
import {
  type MmrContextSectionId,
  type MmrPriceLookup,
  type MmrThreadCostReport,
  type MmrThreadModelCost,
  summarizeMmrThreadCost,
} from "./extensions/ampi-core/thread-reports.js";
import { createGitIdentityResolver, matchesRepoToken } from "./extensions/ampi-history/git-identity.js";
import { analyzeMmrContext } from "./extensions/ampi-threads/context-analysis.js";
import { formatMmrSessionCost } from "./extensions/ampi-tui/editor/prompt-box.js";

/**
 * Thread functions of the `ampi` command that need ampi's TypeScript, run
 * outside a Pi session: session search for `ampi threads search`, the
 * context report for `ampi threads context`, and the cost reports for
 * `ampi threads usage` and `ampi usage`.
 *
 * The command lists Pi's sessions and reads the thread index and session
 * entries itself; search evaluates the query on them with the parser and
 * matchers that `find_session` uses. The results stay on this machine, so
 * nothing is redacted and session directories are matched as they are. The
 * reports use the same analysis and cost summary as the Analyze Context and
 * Thread Cost overlays, so the numbers agree.
 */

/** Why a filter in the query was not applied. */
export type MmrThreadSearchProblemKind = "unknown" | "hosted" | "invalid" | "unavailable";

export interface MmrThreadSearchProblem {
  readonly filter: string;
  readonly kind: MmrThreadSearchProblemKind;
}

export interface MmrThreadSearchMatch {
  readonly session: SessionInfo;
  /** The query's words and phrases, all of which the session contains. */
  readonly matchedTerms: readonly string[];
}

export interface MmrThreadSearchInput {
  readonly query: string;
  /** Pi's sessions, one per id. */
  readonly sessions: readonly SessionInfo[];
  /** The thread index records by session id; `undefined` when the index cannot be read. */
  readonly threads: Readonly<Record<string, MmrThreadRecord>> | undefined;
  /** The clock relative dates such as `after:7d` count from. */
  readonly now: Date;
  readonly limit: number;
}

export interface MmrThreadSearchResult {
  /** At most `limit` matches, most recently updated first. */
  readonly matches: readonly MmrThreadSearchMatch[];
  /** Every match, before the limit. */
  readonly total: number;
  /** Filters that were not applied; the matches ignore them. */
  readonly problems: readonly MmrThreadSearchProblem[];
}

/** Parser keys that only make sense for `find_session` results; search ignores them, readable or not. */
const FIND_SESSION_ONLY = /^(?:offset|sort):/i;

/**
 * Search `sessions` for `query`. Every word, phrase and filter must match.
 * Words and phrases match the session name, first message and message text;
 * `id:` and `parent:` take an id or its first characters; `after:`,
 * `before:` and `updated_before:` compare the last update, `created_after:`
 * and `created_before:` the creation time; `cwd:` and `project:` match part
 * of the session directory; `repo:` its git remote; `file:`, `model:`,
 * `provider:`, `tool:` and `has:` the session's entries; `label:`, `pinned:`
 * and `archived:` the thread index, with Pi's entry labels counting for
 * `label:` too.
 */
export async function searchMmrThreads(input: MmrThreadSearchInput): Promise<MmrThreadSearchResult> {
  const query = parseSessionQuery(input.query, input.now);
  const problems: MmrThreadSearchProblem[] = [
    ...query.unsupportedFilters.map((filter) => ({ filter, kind: query.hostedFilters.includes(filter) ? "hosted" : "unknown" }) as const),
    ...query.invalidFilters.map((filter) => ({ filter, kind: FIND_SESSION_ONLY.test(filter) ? "unavailable" : "invalid" }) as const),
    ...query.appliedFilterTokens.filter((token) => FIND_SESSION_ONLY.test(token)).map((filter) => ({ filter, kind: "unavailable" }) as const),
    ...query.projectRefTokens.map((filter) => ({ filter, kind: "unavailable" }) as const),
  ];
  const { threads } = input;
  if (!threads) {
    for (const token of query.appliedFilterTokens) {
      if (/^(?:pinned|archived):/i.test(token)) problems.push({ filter: token, kind: "unavailable" });
    }
  }
  const indexQuery = threads ? query : { ...query, pinned: undefined, archived: undefined };

  const idsByPath = new Map(input.sessions.map((session) => [session.path, session.id]));
  const sessionIndex = createMmrSessionIndex({ listSessions: async () => [...input.sessions], openSession: (file) => SessionManager.open(file) });
  const gitIdentity = createGitIdentityResolver();
  const needsEntries = query.file.length > 0 || query.provider.length > 0 || query.model.length > 0 || query.tool.length > 0 || query.has.length > 0 || query.label.length > 0;
  const startsWith = (id: string | undefined, prefix: string) => id?.toLowerCase().startsWith(prefix.toLowerCase()) === true;

  const matchOne = async (session: SessionInfo): Promise<MmrThreadSearchMatch | undefined> => {
    if (query.id && !startsWith(session.id, query.id)) return undefined;
    if (query.parent && !startsWith(resolveParentSessionId(session.parentSessionPath, idsByPath), query.parent)) return undefined;
    if (query.name && !includesCaseInsensitive(session.name ?? "", query.name)) return undefined;
    if (query.modifiedAfter && session.modified < query.modifiedAfter) return undefined;
    if (query.modifiedBefore && session.modified > query.modifiedBefore) return undefined;
    if (query.createdAfter && session.created < query.createdAfter) return undefined;
    if (query.createdBefore && session.created > query.createdBefore) return undefined;
    const cwd = session.cwd.toLowerCase();
    if (![...query.cwd, ...query.project].every((part) => cwd.includes(part))) return undefined;
    const text = [session.name ?? "", session.firstMessage, session.allMessagesText].join("\n");
    if (!query.terms.every((term) => includesCaseInsensitive(text, term))) return undefined;

    const record = threads && Object.hasOwn(threads, session.id) ? threads[session.id] : undefined;
    if (!matchesMmrThreadIndexFilters({ ...indexQuery, label: [] }, record)) return undefined;
    if (query.repo.length > 0) {
      const identity = session.cwd ? await gitIdentity.resolve(session.cwd).catch(() => undefined) : undefined;
      if (!identity || !query.repo.every((token) => matchesRepoToken(identity, token))) return undefined;
    }
    if (needsEntries) {
      const metadata = await sessionIndex.getMetadata(session);
      const has = (values: ReadonlySet<string>, tokens: readonly string[]) => tokens.every((token) => [...values].some((value) => value.includes(token)));
      if (!has(metadata.providers, query.provider) || !has(metadata.models, query.model) || !has(metadata.tools, query.tool)) return undefined;
      if (query.has.includes("tools") && !metadata.hasTools) return undefined;
      if (query.has.includes("errors") && !metadata.hasErrors) return undefined;
      if (!matchesMmrThreadIndexFilters({ label: query.label }, { labels: [...(record?.labels ?? []), ...metadata.labels] })) return undefined;
      if (query.file.length > 0 && !has(await sessionIndex.getTouchedFiles(session), query.file)) return undefined;
    }
    return { session, matchedTerms: query.terms };
  };

  const matches = (await Promise.all(input.sessions.map(matchOne)))
    .filter((match): match is MmrThreadSearchMatch => match !== undefined)
    .sort((a, b) => b.session.modified.getTime() - a.session.modified.getTime() || a.session.id.localeCompare(b.session.id));
  return { matches: matches.slice(0, input.limit), total: matches.length, problems };
}

/**
 * What the `ampi` command knows of a model, from Pi's model registry. Prices
 * are dollars per million tokens, as Pi's models carry them.
 */
export interface MmrCliModelInfo {
  readonly name?: string;
  readonly contextWindow?: number;
  readonly cost?: MmrModelPrice;
}

/** A model's registry entry, or `undefined` for a model the registry does not know. */
export type MmrCliModelLookup = (provider: string, model: string) => MmrCliModelInfo | undefined;

/** `ampi threads context` output: what fills a session's context window, section by section. */
export interface MmrThreadContextJson {
  readonly threadID: string;
  readonly scope: "current-context";
  /** `provider/model` that answers next, or `null` while the session names none. */
  readonly model: string | null;
  readonly modelDisplayName: string | null;
  readonly maxContextTokens: number | null;
  /** Share of the window in percent with one decimal, or `null` when the window is unknown. */
  readonly sections: readonly { id: MmrContextSectionId; name: string; tokens: number; percentage: number | null }[];
  readonly totalTokens: number;
  /** The window less the total, at least 0; `null` when the window is unknown. */
  readonly freeSpace: number | null;
  readonly compactionCount: number;
  readonly toolCounts: { builtin: number; mcp: number; total: number };
  /** Tokens counted at the last response and estimated for the messages after it, when one recorded usage since the latest compaction. */
  readonly measuredTokens?: number;
  /** `false` when the branch holds no system message yet: the prompt and tool sections are then 0. */
  readonly systemPromptRecorded?: false;
}

/** Tools from MCP servers are named `mcp__<server>__<tool>`. */
const MCP_TOOL_PREFIX = "mcp__";

/** The branch Pi opens a session on: from its last entry back to the root, root first. */
function currentBranch(entries: readonly SessionEntry[]): SessionEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch: SessionEntry[] = [];
  for (let entry = entries.at(-1); entry; entry = entry.parentId ? byId.get(entry.parentId) : undefined) branch.push(entry);
  return branch.reverse();
}

const hasContextUsage = (message: AgentMessage): message is Extract<AgentMessage, { role: "assistant" }> =>
  message.role === "assistant" && message.stopReason !== "aborted" && message.stopReason !== "error" && calculateContextTokens(message.usage) > 0;

/**
 * The context tokens Pi reports for a branch, as its `getContextUsage()`
 * counts them: the last response's usage plus estimates for the messages
 * after it. `undefined` when no response recorded usage since the latest
 * compaction or context edit.
 */
function measuredContextTokens(branch: readonly SessionEntry[]): number | undefined {
  const projection = buildSessionProjection([...branch]);
  let trailing = 0;
  for (let index = projection.entries.length - 1; index >= 0; index--) {
    const { sourceEntry, messages } = projection.entries[index];
    for (let position = messages.length - 1; position >= 0; position--) {
      const message = messages[position];
      if (!hasContextUsage(message)) {
        trailing += estimateTokens(message);
        continue;
      }
      const at = branch.findIndex((entry) => entry.id === sourceEntry.id);
      const invalidated = branch.some((entry, later) => later >= at && (entry.type === "compaction" || entry.type === "context_edit"));
      return invalidated ? undefined : calculateContextTokens(message.usage) + trailing;
    }
  }
  return undefined;
}

const percentOf = (tokens: number, window: number | undefined) => (window === undefined ? null : Math.round((tokens / window) * 1000) / 10);

/**
 * The context report of a session (its entries, header excluded), with the
 * window and name of the model that answers next from `models`. Reads the
 * branch Pi would open, and the system messages Pi recorded on it.
 */
export function reportMmrThreadContext(threadID: string, entries: readonly SessionEntry[], models: MmrCliModelLookup): MmrThreadContextJson {
  const branch = currentBranch(entries);
  const { messages, model: selected } = buildSessionContext(branch);
  const info = selected ? models(selected.provider, selected.modelId) : undefined;
  const recorded = messages.some((message) => message.role === "system");
  const toolNames = recorded
    ? new Set(messages.flatMap((message) => ((message as { toolsAdded?: { name: string }[] }).toolsAdded ?? []).map((tool) => tool.name)))
    : new Set<string>();
  const analysis = analyzeMmrContext({
    entries: branch,
    contextWindow: info?.contextWindow,
    mcpTools: new Set([...toolNames].filter((name) => name.startsWith(MCP_TOOL_PREFIX))),
  });
  const window = analysis.contextWindow;
  const countOf = (id: MmrContextSectionId) => analysis.sections.find((section) => section.id === id)?.count ?? 0;
  const builtin = countOf("builtin-tools");
  const mcp = countOf("mcp-tools");
  const measured = measuredContextTokens(branch);
  return {
    threadID,
    scope: "current-context",
    model: selected ? `${selected.provider}/${selected.modelId}` : null,
    modelDisplayName: info?.name ?? null,
    maxContextTokens: window ?? null,
    sections: analysis.sections.map(({ id, name, tokens }) => ({ id, name, tokens, percentage: percentOf(tokens, window) })),
    totalTokens: analysis.totalTokens,
    freeSpace: window === undefined ? null : Math.max(0, window - analysis.totalTokens),
    compactionCount: analysis.compactionCount,
    toolCounts: { builtin, mcp, total: builtin + mcp },
    ...(measured === undefined ? {} : { measuredTokens: measured }),
    ...(recorded ? {} : { systemPromptRecorded: false as const }),
  };
}

/** A time range: `start` included, `end` excluded; either may be open. */
export interface MmrUsageRange {
  readonly start?: Date;
  readonly end?: Date;
}

/** One model's tokens and cost in a usage report. */
export interface MmrUsageModelJson {
  /** `provider/model`, or "session summaries" for compaction and branch summaries. */
  readonly model: string;
  /** Dollars; `null` when some of its tokens have no recorded cost and no price. */
  readonly cost: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
}

/** `ampi threads usage` output. */
export interface MmrThreadUsageJson {
  readonly threadID: string;
  readonly title: string;
  readonly start: string | null;
  readonly end: string | null;
  /** Dollars counted for the models with a known cost; `null` when no model has one. */
  readonly cost: number | null;
  /** Models whose cost is unknown and left out of `cost`. */
  readonly unknownCostModels: number;
  readonly models: readonly MmrUsageModelJson[];
  /** Tool calls in the range per tool name. */
  readonly toolCalls: Readonly<Record<string, number>>;
}

/** One session in an `ampi usage` report. */
export interface MmrUsageSessionJson {
  readonly threadID: string;
  readonly title: string;
  readonly cwd: string;
  /** Dollars counted for the session's models with a known cost; `null` when none has one, or the session was imported. */
  readonly cost: number | null;
}

/** `ampi usage` output. */
export interface MmrUsageJson {
  readonly start: string;
  readonly end: string;
  /** Dollars counted for the models with a known cost; `null` when no model has one. */
  readonly cost: number | null;
  readonly unknownCostModels: number;
  readonly sessionCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly models: readonly MmrUsageModelJson[];
  /** Every session with usage in the range, the most expensive first. */
  readonly sessions: readonly MmrUsageSessionJson[];
}

/** A session for `ampi usage`. */
export interface MmrUsageSessionInput {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  /** The session's entries, every branch. */
  readonly entries: readonly unknown[];
  /** Imported from elsewhere: its costs are unknown, whatever its entries say. */
  readonly imported?: boolean;
}

/** Dollars rounded to a billionth, so sums print without floating-point noise. */
const dollars = (amount: number) => Math.round(amount * 1e9) / 1e9;

function inRange(entry: unknown, { start, end }: MmrUsageRange): boolean {
  if (start === undefined && end === undefined) return true;
  const time = Date.parse(String((entry as { timestamp?: unknown }).timestamp));
  return Number.isFinite(time) && (start === undefined || time >= start.getTime()) && (end === undefined || time < end.getTime());
}

const modelJson = (model: MmrThreadModelCost): MmrUsageModelJson => ({
  model: model.label,
  cost: model.cost === undefined ? null : dollars(model.cost),
  inputTokens: model.input,
  outputTokens: model.output,
  cacheReadInputTokens: model.cacheRead,
  cacheCreationInputTokens: model.cacheWrite,
});

const priceLookup =
  (models: MmrCliModelLookup): MmrPriceLookup =>
  (provider, model) =>
    models(provider, model)?.cost;

/** A session's cost report over the entries in `range`; an imported session's models all cost "unknown". */
function rangeCost(entries: readonly unknown[], range: MmrUsageRange, models: MmrCliModelLookup, imported = false): MmrThreadCostReport {
  const report = summarizeMmrThreadCost(
    entries.filter((entry) => inRange(entry, range)),
    priceLookup(models),
  );
  if (!imported) return report;
  return { total: 0, unknown: report.models.length, models: report.models.map((model) => ({ ...model, cost: undefined })) };
}

const reportCost = (report: MmrThreadCostReport) =>
  report.models.length > 0 && report.unknown === report.models.length ? null : dollars(report.total);

/**
 * The usage report of one session: its cost and tokens per model, and its
 * tool calls, counting the entries in `range`.
 */
export function reportMmrThreadUsage(
  session: { readonly id: string; readonly title: string; readonly entries: readonly unknown[] },
  range: MmrUsageRange,
  models: MmrCliModelLookup,
): MmrThreadUsageJson {
  const report = rangeCost(session.entries, range, models);
  const toolCalls: Record<string, number> = {};
  for (const entry of session.entries) {
    if (!inRange(entry, range) || !isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
    if (entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
    for (const block of entry.message.content) {
      if (isRecord(block) && block.type === "toolCall" && typeof block.name === "string") toolCalls[block.name] = (toolCalls[block.name] ?? 0) + 1;
    }
  }
  return {
    threadID: session.id,
    title: session.title,
    start: range.start?.toISOString() ?? null,
    end: range.end?.toISOString() ?? null,
    cost: reportCost(report),
    unknownCostModels: report.unknown,
    models: report.models.map(modelJson),
    toolCalls,
  };
}

/**
 * Usage over many sessions in `range`: the cost and tokens per model, and
 * each session with usage in the range, the most expensive first.
 */
export function reportMmrUsage(sessions: readonly MmrUsageSessionInput[], range: Required<MmrUsageRange>, models: MmrCliModelLookup): MmrUsageJson {
  const totals = new Map<string, { known: number; unknown: boolean; input: number; output: number; cacheRead: number; cacheWrite: number }>();
  const used: MmrUsageSessionJson[] = [];
  for (const session of sessions) {
    const report = rangeCost(session.entries, range, models, session.imported);
    if (report.models.length === 0) continue;
    used.push({ threadID: session.id, title: session.title, cwd: session.cwd, cost: reportCost(report) });
    for (const model of report.models) {
      const total = totals.get(model.label) ?? { known: 0, unknown: false, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      if (model.cost === undefined) total.unknown = true;
      else total.known += model.cost;
      total.input += model.input;
      total.output += model.output;
      total.cacheRead += model.cacheRead;
      total.cacheWrite += model.cacheWrite;
      totals.set(model.label, total);
    }
  }
  const all = [...totals].map(([label, { known, unknown, ...tokens }]) => ({ label, cost: unknown ? undefined : known, known, ...tokens }));
  const sum = (pick: (model: (typeof all)[number]) => number) => all.reduce((total, model) => total + pick(model), 0);
  const unknown = all.filter((model) => model.cost === undefined).length;
  return {
    start: range.start.toISOString(),
    end: range.end.toISOString(),
    // Every known cost, partly unknown models included, as a session's total counts them.
    cost: unknown > 0 && unknown === all.length ? null : dollars(sum((model) => model.known)),
    unknownCostModels: unknown,
    sessionCount: used.length,
    inputTokens: sum((model) => model.input),
    outputTokens: sum((model) => model.output),
    cacheReadInputTokens: sum((model) => model.cacheRead),
    cacheCreationInputTokens: sum((model) => model.cacheWrite),
    models: all.map(modelJson),
    sessions: used.sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || a.threadID.localeCompare(b.threadID)),
  };
}

/** Event channel on which this module's extension entry hands the `ampi` command its thread functions. */
export const MMR_CLI_THREADS_EVENT = "ampi:cli-threads";

/**
 * Entry for Pi's extension loader, used by `ampi threads search`, `threads
 * context`, `threads usage` and `usage`: the command loads this file with it
 * and receives these functions on Pi's event bus, with the cost format of the
 * prompt box's gauge. It is not one of the package's extensions and registers
 * nothing.
 */
export default function ampiCliThreadsEntry(pi: ExtensionAPI): void {
  pi.events.emit(MMR_CLI_THREADS_EVENT, {
    searchThreads: searchMmrThreads,
    reportThreadContext: reportMmrThreadContext,
    reportThreadUsage: reportMmrThreadUsage,
    reportUsage: reportMmrUsage,
    formatCost: formatMmrSessionCost,
  });
}
