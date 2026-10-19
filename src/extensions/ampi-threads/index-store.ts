import { randomBytes } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../ampi-core/internal/json.js";
import { isUnsafeObjectKey, writeFileAtomic } from "../ampi-core/internal/settings-file.js";
import {
  checkMmrThreadLabels,
  MMR_THREAD_LABEL_MAX_LENGTH,
  MMR_THREAD_LABELS_MAX,
  type MmrThreadIndex,
  type MmrThreadRecord,
  type MmrThreadRecordPatch,
  type MmrThreadTitleSource,
} from "../ampi-core/thread-index.js";

/**
 * The thread index on disk: one JSON file under Pi's agent directory,
 * `<agentDir>/data/ampi/threads/index.json`, shaped
 * `{ "version": 1, "threads": { "<session id>": { archived?, labels?, color?, pinned?, titleSource?, snoozed?, unread?, readAt? } } }`.
 *
 * - Writes go to a temp file that is renamed over the index, so a reader
 *   never sees half a file.
 * - A file that is not a valid index is moved aside to
 *   `index.json.<random>.corrupt`, never overwritten; the store warns once
 *   and starts empty. A file from a newer index version is left alone and
 *   every operation fails until ampi is updated.
 * - Operations on one path run one at a time within the process. Across Pi
 *   processes the last writer wins: each update reads the file afresh, so
 *   only two updates landing at the same moment can lose one.
 */

export const MMR_THREAD_INDEX_VERSION = 1;
export const MMR_THREAD_INDEX_FILE = "index.json";
export { MMR_THREAD_LABEL_MAX_LENGTH, MMR_THREAD_LABELS_MAX };
export const MMR_THREAD_COLORS: readonly string[] = Object.freeze([
  "blue",
  "purple",
  "pink",
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "gray",
]);

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const TITLE_SOURCES: ReadonlySet<MmrThreadTitleSource> = new Set(["model", "user"]);

/** A request the index refuses: an invalid field, or an index file it must not change. */
export class MmrThreadIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MmrThreadIndexError";
  }
}

/** `<agentDir>/data/ampi/threads`, the directory the index lives in. */
export function resolveDefaultMmrThreadIndexDir(): string {
  return path.join(getAgentDir(), "data", "ampi", "threads");
}

/**
 * Check a label list and return it without duplicates, in order. Labels are
 * 1 to 32 lowercase letters, digits or hyphens; a session has at most 20
 * (`checkMmrThreadLabels`).
 */
export function validateMmrThreadLabels(labels: unknown): string[] {
  const checked = checkMmrThreadLabels(labels);
  if (checked.ok) return checked.labels;
  if (checked.problem === "list") throw new MmrThreadIndexError("labels must be a list of strings.");
  if (checked.problem === "characters") {
    throw new MmrThreadIndexError(
      `label ${JSON.stringify(checked.label)} is not allowed: use lowercase letters, digits and hyphens.`,
    );
  }
  if (checked.problem === "length") {
    throw new MmrThreadIndexError(`label "${checked.label}" is longer than ${MMR_THREAD_LABEL_MAX_LENGTH} characters.`);
  }
  throw new MmrThreadIndexError(`a session takes at most ${MMR_THREAD_LABELS_MAX} labels, not ${checked.count}.`);
}

function validColor(value: unknown): value is string {
  return typeof value === "string" && (MMR_THREAD_COLORS.includes(value) || HEX_COLOR.test(value));
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function checkSessionId(sessionId: unknown): asserts sessionId is string {
  if (typeof sessionId !== "string" || sessionId.trim().length === 0 || isUnsafeObjectKey(sessionId)) {
    throw new MmrThreadIndexError(`${JSON.stringify(sessionId)} is not a session id.`);
  }
}

/** Whether a stored record has the documented field types. Unknown fields are kept as they are. */
function isThreadRecord(value: unknown): value is MmrThreadRecord {
  if (!isRecord(value)) return false;
  if (value.archived !== undefined && typeof value.archived !== "string") return false;
  if (value.labels !== undefined && !(Array.isArray(value.labels) && value.labels.every((l) => typeof l === "string"))) {
    return false;
  }
  if (value.color !== undefined && typeof value.color !== "string") return false;
  if (value.pinned !== undefined && typeof value.pinned !== "boolean") return false;
  if (value.titleSource !== undefined && !TITLE_SOURCES.has(value.titleSource as MmrThreadTitleSource)) return false;
  if (value.snoozed !== undefined && typeof value.snoozed !== "string") return false;
  if (value.unread !== undefined && typeof value.unread !== "boolean") return false;
  if (value.readAt !== undefined && typeof value.readAt !== "string") return false;
  return true;
}

type Threads = Map<string, MmrThreadRecord>;

type Parsed = { kind: "ok"; threads: Threads } | { kind: "corrupt"; reason: string } | { kind: "newer"; version: unknown };

function parseIndex(text: string): Parsed {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "corrupt", reason: "it is not valid JSON" };
  }
  if (!isRecord(value)) return { kind: "corrupt", reason: "it is not a JSON object" };
  if (typeof value.version === "number" && value.version > MMR_THREAD_INDEX_VERSION) {
    return { kind: "newer", version: value.version };
  }
  if (value.version !== MMR_THREAD_INDEX_VERSION) return { kind: "corrupt", reason: "its version is missing or unknown" };
  if (!isRecord(value.threads)) return { kind: "corrupt", reason: "it has no threads object" };
  const threads: Threads = new Map();
  for (const [id, record] of Object.entries(value.threads)) {
    if (isUnsafeObjectKey(id) || !isThreadRecord(record)) {
      return { kind: "corrupt", reason: `the entry for ${JSON.stringify(id)} is malformed` };
    }
    threads.set(id, record);
  }
  return { kind: "ok", threads };
}

function applyPatch(current: MmrThreadRecord | undefined, patch: MmrThreadRecordPatch): MmrThreadRecord | undefined {
  if (!isRecord(patch)) throw new MmrThreadIndexError("an update needs an object of fields.");
  const next: Record<string, unknown> = { ...current };
  const set = (key: keyof MmrThreadRecord, value: unknown, valid: (value: unknown) => boolean, problem: string) => {
    if (value === undefined) return;
    if (value === null) {
      delete next[key];
      return;
    }
    if (!valid(value)) throw new MmrThreadIndexError(problem);
    next[key] = value;
  };
  set("archived", patch.archived, validDate, "archived must be a date string such as 2026-01-31T12:00:00.000Z.");
  set("color", patch.color, validColor, `color must be one of ${MMR_THREAD_COLORS.join(", ")} or #rrggbb.`);
  set("pinned", patch.pinned, (value) => typeof value === "boolean", "pinned must be true or false.");
  set(
    "titleSource",
    patch.titleSource,
    (value) => TITLE_SOURCES.has(value as MmrThreadTitleSource),
    'titleSource must be "model" or "user".',
  );
  set("snoozed", patch.snoozed, validDate, "snoozed must be a date string such as 2026-01-31T12:00:00.000Z.");
  set("unread", patch.unread, (value) => typeof value === "boolean", "unread must be true or false.");
  set("readAt", patch.readAt, validDate, "readAt must be a date string such as 2026-01-31T12:00:00.000Z.");
  if (patch.labels === null) delete next.labels;
  else if (patch.labels !== undefined) {
    const labels = validateMmrThreadLabels(patch.labels);
    if (labels.length > 0) next.labels = labels;
    else delete next.labels;
  }
  return Object.keys(next).length > 0 ? (next as MmrThreadRecord) : undefined;
}

// One promise chain per absolute file path, shared by every copy of this
// module that Pi loads, so two extensions writing the same file still queue.
const LOCKS_GLOBAL_KEY = "__pi_ampi_thread_index_locks_v1__";
const globalLocks = globalThis as typeof globalThis & { [LOCKS_GLOBAL_KEY]?: Map<string, Promise<void>> };
const locks: Map<string, Promise<void>> = globalLocks[LOCKS_GLOBAL_KEY] ?? new Map();
globalLocks[LOCKS_GLOBAL_KEY] = locks;

/** Run `task` after every earlier task on `key` (an absolute file path) has settled. The prompt history store queues on it too. */
export function withMmrThreadsFileLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const result = previous.then(task);
  const tail = result.then(
    () => {},
    () => {},
  );
  locks.set(key, tail);
  void tail.finally(() => {
    // Drop the entry once nothing else queued behind this task, so the map stays bounded.
    if (locks.get(key) === tail) locks.delete(key);
  });
  return result;
}

/** Test seam: how many index paths have an operation queued or running. */
export function countMmrThreadIndexLocks(): number {
  return locks.size;
}

export interface MmrThreadIndexStoreOptions {
  /** Directory holding `index.json`; defaults to `<agentDir>/data/ampi/threads`. */
  readonly baseDir?: string;
  /** Suffix for the name a corrupt file is moved to; defaults to 16 random hex characters. */
  readonly randomId?: () => string;
  /** Receives the corrupt-file warning, once per store. */
  readonly onWarning?: (message: string) => void;
}

export interface MmrThreadIndexStore extends MmrThreadIndex {
  /** Absolute path of `index.json`. */
  readonly path: string;
  /** The record as last read or written by this store, without touching the disk. */
  peek(sessionId: string): MmrThreadRecord | undefined;
}

export function createMmrThreadIndexStore(options: MmrThreadIndexStoreOptions = {}): MmrThreadIndexStore {
  const filePath = path.resolve(options.baseDir ?? resolveDefaultMmrThreadIndexDir(), MMR_THREAD_INDEX_FILE);
  const randomId = options.randomId ?? (() => randomBytes(8).toString("hex"));
  let warned = false;
  let known: Threads = new Map();

  async function load(): Promise<Threads> {
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return (known = new Map());
      throw error;
    }
    const parsed = parseIndex(text);
    if (parsed.kind === "ok") return (known = parsed.threads);
    if (parsed.kind === "newer") {
      throw new MmrThreadIndexError(
        `${filePath} has index version ${String(parsed.version)}, written by a newer ampi; update ampi to change it.`,
      );
    }
    const aside = `${filePath}.${randomId()}.corrupt`;
    await rename(filePath, aside);
    if (!warned) {
      warned = true;
      options.onWarning?.(`The thread index at ${filePath} could not be read (${parsed.reason}). It was moved to ${aside}; starting with an empty index.`);
    }
    return (known = new Map());
  }

  function save(threads: Threads): void {
    const document = { version: MMR_THREAD_INDEX_VERSION, threads: Object.fromEntries(threads) };
    writeFileAtomic(filePath, `${JSON.stringify(document, null, 2)}\n`);
    known = threads;
  }

  return {
    path: filePath,
    peek: (sessionId) => known.get(sessionId),
    list: () => withMmrThreadsFileLock(filePath, async () => Object.freeze(Object.fromEntries(await load()))),
    get(sessionId) {
      return withMmrThreadsFileLock(filePath, async () => {
        checkSessionId(sessionId);
        return (await load()).get(sessionId);
      });
    },
    update(sessionId, patch) {
      return withMmrThreadsFileLock(filePath, async () => {
        checkSessionId(sessionId);
        const threads = new Map(await load());
        const record = applyPatch(threads.get(sessionId), patch);
        if (record) threads.set(sessionId, record);
        else threads.delete(sessionId);
        save(threads);
        return record;
      });
    },
    remove(sessionId) {
      return withMmrThreadsFileLock(filePath, async () => {
        checkSessionId(sessionId);
        const threads = new Map(await load());
        if (threads.delete(sessionId)) save(threads);
      });
    },
  };
}

