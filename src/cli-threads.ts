import { type ExtensionAPI, type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import { createMmrSessionIndex } from "./extensions/ampi-core/session-catalog.js";
import { includesCaseInsensitive, matchesMmrThreadIndexFilters, parseSessionQuery, resolveParentSessionId } from "./extensions/ampi-core/session-query.js";
import type { MmrThreadRecord } from "./extensions/ampi-core/thread-index.js";
import { createGitIdentityResolver, matchesRepoToken } from "./extensions/ampi-history/git-identity.js";

/**
 * Session search for `ampi threads search`, outside a Pi session.
 *
 * The command lists Pi's sessions and reads the thread index itself; this
 * module evaluates the query on them with the parser and matchers that
 * `find_session` uses. The results stay on this machine, so nothing is
 * redacted and session directories are matched as they are.
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

/** Event channel on which this module's extension entry hands `ampi threads search` its search function. */
export const MMR_CLI_THREADS_EVENT = "ampi:cli-threads";

/**
 * Entry for Pi's extension loader, used by `ampi threads search`: the command
 * loads this file with it and receives `searchMmrThreads` on Pi's event bus.
 * It is not one of the package's extensions and registers nothing.
 */
export default function ampiCliThreadsEntry(pi: ExtensionAPI): void {
  pi.events.emit(MMR_CLI_THREADS_EVENT, { searchThreads: searchMmrThreads });
}
