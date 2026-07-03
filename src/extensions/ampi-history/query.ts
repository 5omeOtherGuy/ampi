export type SessionSortKey = "modified" | "created";

export interface SessionQuery {
  terms: string[];
  id?: string;
  name?: string;
  /** Modified-time lower bound. `after:`/`since:` are aliases for this. */
  modifiedAfter?: Date;
  /** Backwards-compatible alias for `modifiedAfter`. */
  after?: Date;
  /** Modified-time upper bound. `before:`/`until:` are aliases for this. */
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
  /** Number of sorted matches to skip before returning results. */
  offset: number;
  /** Result sorting key. */
  sort: SessionSortKey;
  unsupportedFilters: string[];
  /** Date/number/sort/has filters whose values could not be parsed. */
  invalidFilters: string[];
  /** Original tokens that parsed as `key:value` filters (used for diagnostics). */
  appliedFilterTokens: string[];
}

const FILTER_RE = /^([a-zA-Z_][\w-]*):(.*)$/;
const SUPPORTED_HAS_FILTERS = new Set(["tools", "errors"]);

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

export function tokenizeSessionQuery(query: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]+)"|'([^']+)'|(\S+)/g;
  for (const match of query.matchAll(re)) {
    const token = match[1] ?? match[2] ?? match[3];
    if (token) tokens.push(token);
  }
  return tokens;
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
    offset: 0,
    sort: "modified",
    unsupportedFilters: [],
    invalidFilters: [],
    appliedFilterTokens: [],
  };
  for (const token of tokenizeSessionQuery(query)) {
    const filter = FILTER_RE.exec(token);
    if (!filter) {
      parsed.terms.push(token);
      continue;
    }
    const key = filter[1]!.toLowerCase();
    const value = filter[2]!.trim();
    if (!value) continue;
    if (key === "id") {
      parsed.id = value;
      parsed.appliedFilterTokens.push(`id:${value}`);
    } else if (key === "name") {
      parsed.name = value;
      parsed.appliedFilterTokens.push(`name:${value}`);
    } else if (key === "after" || key === "since" || key === "modified_after") {
      pushDateFilter(parsed, key, value, now, (date) => { parsed.modifiedAfter = date; parsed.after = date; });
    } else if (key === "before" || key === "until" || key === "modified_before") {
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
      parsed.unsupportedFilters.push(`${key}:${value}`);
    }
  }
  return parsed;
}

export function includesCaseInsensitive(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}
