import type { MmrThreadRecord } from "./thread-index.js";

/**
 * The session search language shared by `find_session` (ampi-history),
 * `ampi threads search` and the web GUI's Activity page and Search Threads
 * dialog: bare words and quoted phrases plus `key:value` filters. Parsing is
 * pure; each caller evaluates the filters it can.
 *
 * `matchMmrSessionRow` evaluates the filters a session list row can answer:
 * words and phrases, `id:`, `name:`, `label:`, `project:`, `cwd:`, `is:`,
 * `pinned:`, `archived:` and the last-activity dates (`after:`, `before:`
 * and their aliases). `ampi threads search` and the web GUI both use it;
 * `unevaluatedMmrSessionRowFilters` names the rest, which need the
 * transcript or other data, so a caller that cannot evaluate them reports
 * them instead of ignoring them.
 */

export type SessionSortKey = "modified" | "created";

/** The flags `is:` takes. */
export const MMR_SESSION_FLAGS = ["archived", "snoozed", "pinned", "live", "unread"] as const;
export type MmrSessionFlag = (typeof MMR_SESSION_FLAGS)[number];

export interface SessionQuery {
  terms: string[];
  id?: string;
  name?: string;
  /** `parent:<id>`: sessions whose parent session has this id or id prefix. */
  parent?: string;
  /** `pinned:true|false`, from the thread index. */
  pinned?: boolean;
  /** `archived:true|false`, from the thread index. */
  archived?: boolean;
  /** Modified-time lower bound. `after:`/`since:` are aliases for this. */
  modifiedAfter?: Date;
  /** Backwards-compatible alias for `modifiedAfter`. */
  after?: Date;
  /** Modified-time upper bound. `before:`/`until:`/`updated_before:` are aliases for this. */
  modifiedBefore?: Date;
  /** Backwards-compatible alias for `modifiedBefore`. */
  before?: Date;
  /** Created-time lower bound. */
  createdAfter?: Date;
  /** Created-time upper bound. */
  createdBefore?: Date;
  /** One entry per `file:<value>` token; values are lowercased for matching. */
  file: string[];
  /** Original `file:<value>` tokens, preserved for diagnostics. */
  fileTokens: string[];
  /** One entry per `repo:<value>` token; values are lowercased for matching. */
  repo: string[];
  /** Original `repo:<value>` tokens, preserved for diagnostics. */
  repoTokens: string[];
  /** Internal cwd/project substring filters; raw cwd is never returned. */
  project: string[];
  projectTokens: string[];
  cwd: string[];
  cwdTokens: string[];
  /** Opaque projectRef filters from prior find_session results. */
  projectRef: string[];
  projectRefTokens: string[];
  /** Entry metadata filters; evaluated via SessionIndex. */
  provider: string[];
  providerTokens: string[];
  model: string[];
  modelTokens: string[];
  tool: string[];
  toolTokens: string[];
  label: string[];
  labelTokens: string[];
  has: string[];
  hasTokens: string[];
  /** One entry per `is:<flag>` token, lowercased; every flag must hold. */
  is: MmrSessionFlag[];
  isTokens: string[];
  /** Number of sorted matches to skip before returning results. */
  offset: number;
  /** Result sorting key. */
  sort: SessionSortKey;
  /** Filters no local session can evaluate: unknown keys and the keys in `hostedFilters`. */
  unsupportedFilters: string[];
  /**
   * Filters on keys that need data a hosted service keeps (`commit:`, `pr:`,
   * `author:`); they are also in `unsupportedFilters`.
   */
  hostedFilters: string[];
  /** Date/number/sort/has/boolean filters whose values could not be parsed. */
  invalidFilters: string[];
  /** Original tokens that parsed as `key:value` filters (used for diagnostics). */
  appliedFilterTokens: string[];
}

const FILTER_RE = /^([a-zA-Z_][\w-]*):(.*)$/;
const SUPPORTED_HAS_FILTERS = new Set(["tools", "errors"]);
/** Keys of the search language whose data only a hosted service has. */
const HOSTED_FILTER_KEYS = new Set(["commit", "pr", "author"]);
/** Every key `parseSessionQuery` reads, so a key without a value can be told from ordinary text such as `Error:`. */
const FILTER_KEYS = new Set([
  "id", "name", "parent", "pinned", "archived",
  "after", "since", "modified_after", "before", "until", "modified_before", "updated_before", "created_after", "created_before",
  "file", "repo", "project", "cwd", "projectref", "project-ref", "provider", "model", "tool", "label", "has", "is", "offset", "sort",
  ...HOSTED_FILTER_KEYS,
]);

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function parseRelativeDate(value: string, now: Date): Date | undefined {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "today") return startOfUtcDay(now);
  if (trimmed === "yesterday") return new Date(startOfUtcDay(now).getTime() - 24 * 60 * 60 * 1000);
  if (trimmed === "week") return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (trimmed === "month") return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const match = /^(\d+)([dw])$/i.exec(trimmed);
  if (!match) return undefined;
  const amount = Number.parseInt(match[1]!, 10);
  const unit = match[2]!.toLowerCase();
  const days = unit === "w" ? amount * 7 : amount;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function parseDateFilter(value: string, now: Date): Date | undefined {
  const relative = parseRelativeDate(value, now);
  if (relative) return relative;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function parseOffset(value: string): number | undefined {
  if (!/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) return undefined;
  return parsed;
}

function parseBoolean(value: string): boolean | undefined {
  const normalized = value.toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

/** Split a query into words and quoted phrases, remembering which were quoted. */
function tokenize(query: string): { text: string; quoted: boolean }[] {
  const tokens: { text: string; quoted: boolean }[] = [];
  const re = /"([^"]+)"|'([^']+)'|(\S+)/g;
  for (const match of query.matchAll(re)) {
    const quoted = match[1] ?? match[2];
    const text = quoted ?? match[3];
    if (text) tokens.push({ text, quoted: quoted !== undefined });
  }
  return tokens;
}

export function tokenizeSessionQuery(query: string): string[] {
  return tokenize(query).map((token) => token.text);
}

function pushDateFilter(
  parsed: SessionQuery,
  key: string,
  value: string,
  now: Date,
  apply: (date: Date) => void,
): void {
  const date = parseDateFilter(value, now);
  if (date) {
    apply(date);
    parsed.appliedFilterTokens.push(`${key}:${value}`);
  } else {
    parsed.invalidFilters.push(`${key}:${value}`);
  }
}

function pushLowercaseFilter(values: string[], tokens: string[], key: string, value: string): void {
  values.push(value.toLowerCase());
  tokens.push(`${key}:${value}`);
}

export function parseSessionQuery(query: string, now = new Date()): SessionQuery {
  const parsed: SessionQuery = {
    terms: [],
    file: [],
    fileTokens: [],
    repo: [],
    repoTokens: [],
    project: [],
    projectTokens: [],
    cwd: [],
    cwdTokens: [],
    projectRef: [],
    projectRefTokens: [],
    provider: [],
    providerTokens: [],
    model: [],
    modelTokens: [],
    tool: [],
    toolTokens: [],
    label: [],
    labelTokens: [],
    has: [],
    hasTokens: [],
    is: [],
    isTokens: [],
    offset: 0,
    sort: "modified",
    unsupportedFilters: [],
    hostedFilters: [],
    invalidFilters: [],
    appliedFilterTokens: [],
  };
  for (const { text: token, quoted } of tokenize(query)) {
    // A quoted phrase is always text, even when it starts like a filter ("Error: ENOENT").
    const filter = quoted ? null : FILTER_RE.exec(token);
    if (!filter) {
      parsed.terms.push(token);
      continue;
    }
    const key = filter[1]!.toLowerCase();
    const value = filter[2]!.trim();
    if (!value) {
      // `archived:` alone is a filter missing its value; `TypeError:` is text.
      if (FILTER_KEYS.has(key)) parsed.invalidFilters.push(token);
      else parsed.terms.push(token);
      continue;
    }
    if (key === "id") {
      parsed.id = value;
      parsed.appliedFilterTokens.push(`id:${value}`);
    } else if (key === "name") {
      parsed.name = value;
      parsed.appliedFilterTokens.push(`name:${value}`);
    } else if (key === "parent") {
      parsed.parent = value;
      parsed.appliedFilterTokens.push(`parent:${value}`);
    } else if (key === "pinned" || key === "archived") {
      const flag = parseBoolean(value);
      if (flag === undefined) parsed.invalidFilters.push(`${key}:${value}`);
      else {
        parsed[key] = flag;
        parsed.appliedFilterTokens.push(`${key}:${value}`);
      }
    } else if (key === "after" || key === "since" || key === "modified_after") {
      pushDateFilter(parsed, key, value, now, (date) => { parsed.modifiedAfter = date; parsed.after = date; });
    } else if (key === "before" || key === "until" || key === "modified_before" || key === "updated_before") {
      pushDateFilter(parsed, key, value, now, (date) => { parsed.modifiedBefore = date; parsed.before = date; });
    } else if (key === "created_after") {
      pushDateFilter(parsed, key, value, now, (date) => { parsed.createdAfter = date; });
    } else if (key === "created_before") {
      pushDateFilter(parsed, key, value, now, (date) => { parsed.createdBefore = date; });
    } else if (key === "file") {
      pushLowercaseFilter(parsed.file, parsed.fileTokens, key, value);
    } else if (key === "repo") {
      pushLowercaseFilter(parsed.repo, parsed.repoTokens, key, value);
    } else if (key === "project") {
      pushLowercaseFilter(parsed.project, parsed.projectTokens, key, value);
    } else if (key === "cwd") {
      pushLowercaseFilter(parsed.cwd, parsed.cwdTokens, key, value);
    } else if (key === "projectref" || key === "project-ref") {
      pushLowercaseFilter(parsed.projectRef, parsed.projectRefTokens, "projectRef", value);
    } else if (key === "provider") {
      pushLowercaseFilter(parsed.provider, parsed.providerTokens, key, value);
    } else if (key === "model") {
      pushLowercaseFilter(parsed.model, parsed.modelTokens, key, value);
    } else if (key === "tool") {
      pushLowercaseFilter(parsed.tool, parsed.toolTokens, key, value);
    } else if (key === "label") {
      pushLowercaseFilter(parsed.label, parsed.labelTokens, key, value);
    } else if (key === "has") {
      const normalized = value.toLowerCase();
      if (SUPPORTED_HAS_FILTERS.has(normalized)) {
        parsed.has.push(normalized);
        parsed.hasTokens.push(`has:${value}`);
      } else {
        parsed.invalidFilters.push(`has:${value}`);
      }
    } else if (key === "is") {
      const flag = value.toLowerCase();
      if ((MMR_SESSION_FLAGS as readonly string[]).includes(flag)) {
        parsed.is.push(flag as MmrSessionFlag);
        parsed.isTokens.push(`is:${value}`);
      } else {
        parsed.invalidFilters.push(`is:${value}`);
      }
    } else if (key === "offset") {
      const offset = parseOffset(value);
      if (offset === undefined) parsed.invalidFilters.push(`offset:${value}`);
      else {
        parsed.offset = offset;
        parsed.appliedFilterTokens.push(`offset:${value}`);
      }
    } else if (key === "sort") {
      const normalized = value.toLowerCase();
      if (normalized === "modified" || normalized === "created") {
        parsed.sort = normalized;
        parsed.appliedFilterTokens.push(`sort:${value}`);
      } else {
        parsed.invalidFilters.push(`sort:${value}`);
      }
    } else {
      if (HOSTED_FILTER_KEYS.has(key)) parsed.hostedFilters.push(`${key}:${value}`);
      parsed.unsupportedFilters.push(`${key}:${value}`);
    }
  }
  return parsed;
}

/**
 * The id of the session a `parentSession` header path names: the id of the
 * listed session stored at that path, otherwise the id in Pi's
 * `<time>_<id>.jsonl` file name, so children still resolve after the agent
 * directory moves or is reached through another spelling of its path.
 */
export function resolveParentSessionId(parentPath: string | undefined, idsByPath: ReadonlyMap<string, string>): string | undefined {
  if (!parentPath) return undefined;
  return idsByPath.get(parentPath) ?? /_([^_/\\]+)\.jsonl$/.exec(parentPath)?.[1];
}

export function includesCaseInsensitive(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Whether a session's thread-index record satisfies the query's `label:`,
 * `pinned:` and `archived:` filters. A session without a record is unpinned,
 * not archived and unlabelled. Each `label:` value must be contained in one of
 * the record's labels, case-insensitively; callers that also know Pi's entry
 * labels pass them in `labels` too.
 */
export function matchesMmrThreadIndexFilters(
  query: Pick<SessionQuery, "label" | "pinned" | "archived">,
  record: MmrThreadRecord | undefined,
): boolean {
  if (query.archived !== undefined && (record?.archived !== undefined) !== query.archived) return false;
  if (query.pinned !== undefined && (record?.pinned === true) !== query.pinned) return false;
  const labels = (record?.labels ?? []).map((label) => label.toLowerCase());
  return query.label.every((token) => labels.some((label) => label.includes(token)));
}

/** What `matchMmrSessionRow` reads of a session. */
export interface MmrSessionRowFields {
  id: string;
  /** The title a list shows (the session name, else its first message). */
  title: string;
  /** Pi's session name, when it has one. */
  name?: string;
  firstMessage?: string;
  /** More text that words and phrases may match, such as every message's text. */
  text?: string;
  /** The working directory. */
  cwd: string;
  /** Labels from the thread index. */
  labels: readonly string[];
  /** Last activity. */
  modified: Date;
  archived: boolean;
  snoozed: boolean;
  pinned: boolean;
  /** A running Pi process has the session open. */
  live: boolean;
  unread: boolean;
}

/**
 * Whether a session row passes the query's words, phrases and the filters
 * listed at the top of this module. Matching ignores case: words and phrases
 * must each appear in the title, name, first message or `text`; `id:` is the
 * id or its start; `name:` part of the name; each `label:` part of one
 * label; each `project:` and `cwd:` part of the working directory; each
 * `is:` flag must hold; `pinned:` and `archived:` compare the flag; `after:`
 * and `before:` bound the last activity, both ends included.
 */
export function matchMmrSessionRow(query: SessionQuery, row: MmrSessionRowFields): boolean {
  if (query.id && !row.id.toLowerCase().startsWith(query.id.toLowerCase())) return false;
  if (query.name && !includesCaseInsensitive(row.name ?? "", query.name)) return false;
  if (query.modifiedAfter && row.modified < query.modifiedAfter) return false;
  if (query.modifiedBefore && row.modified > query.modifiedBefore) return false;
  if (query.pinned !== undefined && row.pinned !== query.pinned) return false;
  if (query.archived !== undefined && row.archived !== query.archived) return false;
  if (!query.is.every((flag) => row[flag])) return false;
  const cwd = row.cwd.toLowerCase();
  if (![...query.cwd, ...query.project].every((part) => cwd.includes(part))) return false;
  const labels = row.labels.map((label) => label.toLowerCase());
  if (!query.label.every((token) => labels.some((label) => label.includes(token)))) return false;
  const text = [row.title, row.name ?? "", row.firstMessage ?? "", row.text ?? ""].join("\n");
  return query.terms.every((term) => includesCaseInsensitive(text, term));
}

/** Keys `matchMmrSessionRow` leaves to its caller even when they parse. */
const UNEVALUATED_ROW_KEYS = /^(?:parent|created_after|created_before|offset|sort):/i;

/**
 * The query's filters `matchMmrSessionRow` does not evaluate, as typed:
 * those that need a session's entries (`file:`, `provider:`, `model:`,
 * `tool:`, `has:`), its git remote (`repo:`), its parent or creation date,
 * `find_session`'s `projectRef:`, `offset:` and `sort:`, and the keys the
 * parser does not know or that need a hosted service (`unsupportedFilters`).
 * Filters whose value did not parse are in `invalidFilters`, not here.
 */
export function unevaluatedMmrSessionRowFilters(query: SessionQuery): string[] {
  return [
    ...query.appliedFilterTokens.filter((token) => UNEVALUATED_ROW_KEYS.test(token)),
    ...query.fileTokens,
    ...query.repoTokens,
    ...query.projectRefTokens,
    ...query.providerTokens,
    ...query.modelTokens,
    ...query.toolTokens,
    ...query.hasTokens,
    ...query.unsupportedFilters,
  ];
}
