import {
  type MmrSessionRowFields,
  matchMmrSessionRow,
  parseSessionQuery,
  type SessionQuery,
  unevaluatedMmrSessionRowFilters,
} from "../ampi-core/session-query.js";
import { type MmrGuiSearchableRow, type MmrGuiSessionRow, mmrGuiProjectLabel } from "./sessions.js";

/**
 * The web GUI's Activity page (`GET /api/feed`) and Search Threads dialog
 * (`GET /api/search`): the session list's rows, filtered with ampi-core's
 * session search language and its row matcher (`matchMmrSessionRow`), the
 * same ones `ampi threads search` uses. Filters a row cannot answer (those
 * that need the transcript, git or a hosted service) are reported back in
 * `applied.unsupported`, and the rows are matched without them; values that
 * do not parse are reported in `applied.invalid`.
 *
 * Everything here is pure: the routes in `server.ts` pass the rows and the
 * clock in.
 */

export const MMR_GUI_FEED_TIMES = ["24h", "72h", "7d", "all"] as const;
export type MmrGuiFeedTime = (typeof MMR_GUI_FEED_TIMES)[number];
export const MMR_GUI_FEED_STATUSES = ["all", "active", "archived", "snoozed"] as const;
export type MmrGuiFeedStatus = (typeof MMR_GUI_FEED_STATUSES)[number];

const HOUR_MS = 60 * 60 * 1000;
/** How far back each time window reaches from now, by last activity; the boundary is included. */
const WINDOW_MS: Readonly<Record<MmrGuiFeedTime, number>> = { "24h": 24 * HOUR_MS, "72h": 72 * HOUR_MS, "7d": 7 * 24 * HOUR_MS, all: Infinity };

/** Search answers this many results unless `limit` says otherwise, and never more than `max`. */
export const MMR_GUI_SEARCH_LIMIT = { default: 50, max: 200 } as const;
/** Longest query either route reads. */
const MAX_QUERY_CHARS = 2000;
/** Characters of the first message a search result previews. */
const PREVIEW_CHARS = 280;

export interface MmrGuiFeedRequest {
  time: MmrGuiFeedTime;
  status: MmrGuiFeedStatus;
  /** A working directory, `""` for sessions without one (`project=none`), or `null` for every project. */
  project: string | null;
  q: string;
  /** IANA time zone that days are counted in. */
  timeZone: string;
  /** BCP 47 locale the day labels after Yesterday are written in. */
  locale: string;
}

export interface MmrGuiSearchRequest {
  q: string;
  limit: number;
}

export type MmrGuiParsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** What a query applied, and what it could not. */
export interface MmrGuiQueryReport {
  q: string;
  /** Filters the rows cannot answer, as typed; the results ignore them. */
  unsupported: string[];
  /** Filters whose value did not parse, as typed; the results ignore them. */
  invalid: string[];
}

export interface MmrGuiFeedProject {
  cwd: string;
  label: string;
  /** Sessions in this project that pass every filter but the project. */
  count: number;
}

export interface MmrGuiFeedDay {
  /** `YYYY-MM-DD` in the request's time zone. */
  date: string;
  /** `Today`, `Yesterday`, else the weekday and date in the request's locale. */
  label: string;
  /** The day's rows, newest first. */
  sessions: MmrGuiSessionRow[];
}

export interface MmrGuiFeed {
  applied: { time: MmrGuiFeedTime; status: MmrGuiFeedStatus; project: string | null } & MmrGuiQueryReport;
  projects: MmrGuiFeedProject[];
  total: number;
  days: MmrGuiFeedDay[];
}

export interface MmrGuiSearchResult extends MmrGuiSessionRow {
  /** The project's name, as the sidebar names its group. */
  project: string;
  /** The first message on one line, at most 280 characters. */
  preview: string;
}

export interface MmrGuiSearchAnswer {
  applied: MmrGuiQueryReport;
  /** Every match, before the limit. */
  total: number;
  /** At most `limit` matches, newest first. */
  results: MmrGuiSearchResult[];
}

function oneOf<T extends string>(values: readonly T[], value: string | null, fallback: T, name: string): MmrGuiParsed<T> {
  if (value === null) return { ok: true, value: fallback };
  return (values as readonly string[]).includes(value)
    ? { ok: true, value: value as T }
    : { ok: false, error: `${name} must be one of ${values.join(", ")}.` };
}

function readQuery(params: URLSearchParams): MmrGuiParsed<string> {
  const q = params.get("q") ?? "";
  return q.length > MAX_QUERY_CHARS ? { ok: false, error: `q is longer than ${MAX_QUERY_CHARS} characters.` } : { ok: true, value: q };
}

/** `GET /api/feed`'s query string; an unknown value is an error, a missing one takes its default (`24h`, `all`, every project). */
export function parseMmrGuiFeedRequest(params: URLSearchParams): MmrGuiParsed<MmrGuiFeedRequest> {
  const time = oneOf(MMR_GUI_FEED_TIMES, params.get("time"), "24h", "time");
  if (!time.ok) return time;
  const status = oneOf(MMR_GUI_FEED_STATUSES, params.get("status"), "all", "status");
  if (!status.ok) return status;
  const q = readQuery(params);
  if (!q.ok) return q;
  const project = params.get("project");
  const timeZone = params.get("tz") ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    return { ok: false, error: "tz is not a time zone this server knows." };
  }
  let locale: string;
  try {
    locale = Intl.getCanonicalLocales(params.get("locale") ?? "en")[0] ?? "en";
  } catch {
    return { ok: false, error: "locale is not a language tag." };
  }
  return {
    ok: true,
    value: { time: time.value, status: status.value, project: project === null || project === "" ? null : project === "none" ? "" : project, q: q.value, timeZone, locale },
  };
}

/** `GET /api/search`'s query string: `q` and `limit` (1 to 200, default 50). */
export function parseMmrGuiSearchRequest(params: URLSearchParams): MmrGuiParsed<MmrGuiSearchRequest> {
  const q = readQuery(params);
  if (!q.ok) return q;
  const raw = params.get("limit");
  if (raw === null || raw === "") return { ok: true, value: { q: q.value, limit: MMR_GUI_SEARCH_LIMIT.default } };
  const limit = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(limit >= 1 && limit <= MMR_GUI_SEARCH_LIMIT.max)) return { ok: false, error: `limit must be a whole number from 1 to ${MMR_GUI_SEARCH_LIMIT.max}.` };
  return { ok: true, value: { q: q.value, limit } };
}

/** What the row matcher reads of a listed session. `live`: any running Pi has it open, this process or another. */
function rowFields({ row, name, firstMessage }: MmrGuiSearchableRow): MmrSessionRowFields {
  return {
    id: row.id,
    title: row.title,
    name,
    firstMessage,
    cwd: row.cwd,
    labels: row.labels,
    modified: new Date(row.modified),
    archived: row.archived,
    snoozed: row.snoozed,
    pinned: row.pinned,
    live: row.live || row.elsewhere || Boolean(row.host),
    unread: row.unread,
  };
}

function evaluate(q: string, now: number): { query: SessionQuery; report: MmrGuiQueryReport } {
  const query = parseSessionQuery(q, new Date(now));
  return { query, report: { q, unsupported: unevaluatedMmrSessionRowFilters(query), invalid: [...query.invalidFilters] } };
}

/** A moment's calendar day in `timeZone`, as `YYYY-MM-DD`. */
export function mmrGuiDayKey(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(ms);
  const part = (type: string) => parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function dayParts(date: string): [number, number, number] {
  const [year, month, day] = date.split("-").map(Number);
  return [year ?? 1970, month ?? 1, day ?? 1];
}

/** `Today`, `Yesterday`, else the weekday and date in `locale`, with the year when it is not this year's. */
export function mmrGuiDayLabel(date: string, today: string, locale: string): string {
  if (date === today) return "Today";
  const [year, month, day] = dayParts(today);
  if (date === new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10)) return "Yesterday";
  const [shownYear, shownMonth, shownDay] = dayParts(date);
  // Noon UTC of that date, written in UTC: the calendar date itself, whatever the zone.
  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(shownYear === year ? {} : { year: "numeric" }),
    timeZone: "UTC",
  }).format(Date.UTC(shownYear, shownMonth - 1, shownDay, 12));
}

function matchesStatus(row: MmrGuiSessionRow, status: MmrGuiFeedStatus): boolean {
  if (status === "archived") return row.archived;
  // As the sidebar groups them: an archived session is in Archived, not Snoozed.
  if (status === "snoozed") return row.snoozed && !row.archived;
  if (status === "active") return !row.archived && !row.snoozed;
  return true;
}

/**
 * The Activity page: the rows (newest first) active within the time window,
 * with the status and matching the query, counted per project, then those of
 * the chosen project grouped by calendar day.
 */
export function buildMmrGuiFeed(rows: readonly MmrGuiSearchableRow[], request: MmrGuiFeedRequest, { now, home }: { now: number; home?: string }): MmrGuiFeed {
  const { query, report } = evaluate(request.q, now);
  const reach = WINDOW_MS[request.time];
  const kept = rows.filter((entry) => now - Date.parse(entry.row.modified) <= reach && matchesStatus(entry.row, request.status) && matchMmrSessionRow(query, rowFields(entry)));

  const counts = new Map<string, number>();
  for (const { row } of kept) counts.set(row.cwd, (counts.get(row.cwd) ?? 0) + 1);
  const projects = [...counts]
    .map(([cwd, count]) => ({ cwd, label: mmrGuiProjectLabel(cwd, home), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label) || a.cwd.localeCompare(b.cwd));

  const today = mmrGuiDayKey(now, request.timeZone);
  const days: MmrGuiFeedDay[] = [];
  let total = 0;
  for (const { row } of kept) {
    if (request.project !== null && row.cwd !== request.project) continue;
    total++;
    const date = mmrGuiDayKey(Date.parse(row.modified), request.timeZone);
    const last = days.at(-1);
    if (last?.date === date) last.sessions.push(row);
    else days.push({ date, label: mmrGuiDayLabel(date, today, request.locale), sessions: [row] });
  }
  return { applied: { time: request.time, status: request.status, project: request.project, ...report }, projects, total, days };
}

/** Search Threads: the rows (newest first) that match the query; every row when it is empty. */
export function searchMmrGuiSessions(rows: readonly MmrGuiSearchableRow[], request: MmrGuiSearchRequest, { now, home }: { now: number; home?: string }): MmrGuiSearchAnswer {
  const { query, report } = evaluate(request.q, now);
  const matches = rows.filter((entry) => matchMmrSessionRow(query, rowFields(entry)));
  return {
    applied: report,
    total: matches.length,
    results: matches.slice(0, request.limit).map(({ row, firstMessage }) => ({
      ...row,
      project: mmrGuiProjectLabel(row.cwd, home),
      preview: firstMessage.replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS),
    })),
  };
}
