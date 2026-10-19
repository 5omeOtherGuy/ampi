/**
 * Core-owned seam for the thread index: per-session metadata that Pi's own
 * session files do not carry (archived, labels, colour, pinned, where the
 * title came from, snoozed, unread).
 *
 * `ampi-threads` owns the store and registers it here at load; any other
 * extension reads and updates it through `getMmrThreadIndex()` without
 * importing `ampi-threads`. When `ampi-threads` is disabled nothing is
 * registered, and callers treat every session as unarchived and unlabelled.
 *
 * globalThis-anchored so registrations survive Pi's cache-isolated module
 * loads (each extension entrypoint may get its own copy of this module).
 */

export type MmrThreadTitleSource = "model" | "user";

/** Metadata kept for one session, keyed by Pi's session id. Every field is optional. */
export interface MmrThreadRecord {
  /** When the session was archived (ISO 8601); absent while it is not archived. */
  readonly archived?: string;
  readonly labels?: readonly string[];
  /** A colour name such as `blue`, or `#rrggbb`. */
  readonly color?: string;
  readonly pinned?: boolean;
  /** Whether the session title was generated or typed by the user. */
  readonly titleSource?: MmrThreadTitleSource;
  /** When the session was snoozed (ISO 8601): it stays snoozed until a message newer than this. */
  readonly snoozed?: string;
  /** Marked unread by the user. */
  readonly unread?: boolean;
  /** When a page last opened the session (ISO 8601): a message newer than this makes it unread. */
  readonly readAt?: string;
}

export const MMR_THREAD_LABELS_MAX = 20;
export const MMR_THREAD_LABEL_MAX_LENGTH = 32;
const LABEL = /^[a-z0-9-]+$/;

/** A label list without duplicates, in order, or the first rule it breaks. */
export type MmrThreadLabelsCheck =
  | { ok: true; labels: string[] }
  | { ok: false; problem: "list" }
  | { ok: false; problem: "characters"; label: unknown }
  | { ok: false; problem: "length"; label: string }
  | { ok: false; problem: "count"; count: number };

/**
 * The thread index's label rules, for the index and for every caller that
 * checks labels before handing them to it: a list of 1 to
 * {@link MMR_THREAD_LABEL_MAX_LENGTH} lowercase letters, digits or hyphens,
 * at most {@link MMR_THREAD_LABELS_MAX} different ones per session. Each
 * caller words the problem its own way.
 */
export function checkMmrThreadLabels(labels: unknown): MmrThreadLabelsCheck {
  if (!Array.isArray(labels)) return { ok: false, problem: "list" };
  const unique: string[] = [];
  for (const label of labels) {
    if (typeof label !== "string" || !LABEL.test(label)) return { ok: false, problem: "characters", label };
    if (label.length > MMR_THREAD_LABEL_MAX_LENGTH) return { ok: false, problem: "length", label };
    if (!unique.includes(label)) unique.push(label);
  }
  return unique.length > MMR_THREAD_LABELS_MAX ? { ok: false, problem: "count", count: unique.length } : { ok: true, labels: unique };
}

/** Whether a session is snoozed: it has a snooze date and its last activity (epoch ms) is not newer. */
export function isMmrThreadSnoozed(record: MmrThreadRecord | undefined, lastActivity: number): boolean {
  if (record?.snoozed === undefined) return false;
  const until = Date.parse(record.snoozed);
  return !Number.isNaN(until) && lastActivity <= until;
}

/** Whether a session is unread: marked so, or active (epoch ms) after a page last opened it. */
export function isMmrThreadUnread(record: MmrThreadRecord | undefined, lastActivity: number): boolean {
  if (record?.unread === true) return true;
  if (record?.readAt === undefined) return false;
  const readAt = Date.parse(record.readAt);
  return !Number.isNaN(readAt) && lastActivity > readAt;
}

/** Fields to change: a value sets the field, `null` removes it, an absent key leaves it alone. */
export type MmrThreadRecordPatch = {
  readonly [K in keyof MmrThreadRecord]?: MmrThreadRecord[K] | null;
};

export interface MmrThreadIndex {
  /** Every session that has metadata, keyed by session id. */
  list(): Promise<Readonly<Record<string, MmrThreadRecord>>>;
  get(sessionId: string): Promise<MmrThreadRecord | undefined>;
  /**
   * Apply `patch` to the session's record and return the result, or
   * `undefined` when no field is left (the record is then removed).
   */
  update(sessionId: string, patch: MmrThreadRecordPatch): Promise<MmrThreadRecord | undefined>;
  /** Remove the session's whole record, fields this version does not know included; for a deleted session. */
  remove(sessionId: string): Promise<void>;
}

/**
 * The slash command `ampi-threads` runs session-replacing actions through
 * (`/ampi-thread new`, `/ampi-thread archive`). Palette commands reach it
 * with `pi.sendUserMessage`, because only a command handler may replace the
 * session; command palettes leave it out of their slash-command rows.
 */
export const MMR_THREAD_SLASH_COMMAND = "ampi-thread";

const THREAD_INDEX_GLOBAL_KEY = "__pi_ampi_thread_index_v1__";
const globalStore = globalThis as typeof globalThis & { [THREAD_INDEX_GLOBAL_KEY]?: MmrThreadIndex[] };

function getIndexes(): MmrThreadIndex[] {
  let indexes = globalStore[THREAD_INDEX_GLOBAL_KEY];
  if (!indexes) {
    indexes = [];
    globalStore[THREAD_INDEX_GLOBAL_KEY] = indexes;
  }
  return indexes;
}

/**
 * Register the thread index. The most recent registration wins. Returns an
 * idempotent function that removes exactly this registration.
 */
export function registerMmrThreadIndex(index: MmrThreadIndex): () => void {
  getIndexes().push(index);
  return () => {
    const indexes = getIndexes();
    const position = indexes.lastIndexOf(index);
    if (position !== -1) indexes.splice(position, 1);
  };
}

/** The registered thread index, or `undefined` when `ampi-threads` is not loaded. */
export function getMmrThreadIndex(): MmrThreadIndex | undefined {
  const indexes = getIndexes();
  return indexes[indexes.length - 1];
}

/**
 * Keep the sessions whose archived state matches `archived`, in their
 * original order. `threads` is a `list()` result; a session without a record
 * is not archived. Works on the session catalogue's `SessionInfo` records or
 * anything else with an `id`.
 */
export function filterMmrSessionsByArchived<T extends { readonly id: string }>(
  sessions: readonly T[],
  threads: Readonly<Record<string, MmrThreadRecord>>,
  archived: boolean,
): T[] {
  return sessions.filter((session) => {
    const record = Object.hasOwn(threads, session.id) ? threads[session.id] : undefined;
    return (record?.archived !== undefined) === archived;
  });
}

