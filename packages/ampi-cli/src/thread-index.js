// ampi's thread index file, read and changed from the `ampi threads`
// commands, which run outside Pi and so cannot reach the index that
// ampi-threads registers inside a session. The file format and the label and
// color rules are those of src/extensions/ampi-threads/index-store.ts, which
// this plain JavaScript cannot import; tests/mmr-cli-threads.test.mjs checks
// that both read each other's files and accept the same labels and colors.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * @typedef {object} ThreadRecord The metadata ampi keeps for one session.
 * @property {string} [archived] When the session was archived (ISO 8601).
 * @property {string[]} [labels]
 * @property {string} [color]
 * @property {boolean} [pinned]
 * @property {"model" | "user"} [titleSource]
 * @property {string} [snoozed] When the session was snoozed (ISO 8601); a newer message ends it.
 * @property {boolean} [unread] Marked unread in the web GUI.
 * @property {string} [readAt] When the web GUI last opened the session (ISO 8601).
 */

const INDEX_VERSION = 1;
const LABELS_MAX = 20;
const LABEL_MAX_LENGTH = 32;
const LABEL = /^[a-z0-9-]+$/;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
/** Session ids ampi-threads refuses as index keys: it sets aside an index that holds one. */
const UNSAFE_IDS = new Set(["__proto__", "prototype", "constructor"]);

/** A thread index that cannot be read or changed, or a label that is not allowed. */
export class ThreadIndexError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ThreadIndexError";
  }
}

/**
 * `<agentDir>/data/ampi/threads/index.json`.
 *
 * @param {string} agentDir Pi's configuration directory.
 * @returns {string}
 */
export function threadIndexPath(agentDir) {
  return path.join(agentDir, "data", "ampi", "threads", "index.json");
}

/**
 * Check a label list and return it without duplicates, in order. Labels are
 * 1 to 32 lowercase letters, digits or hyphens; a session has at most 20.
 *
 * @param {unknown} labels
 * @returns {string[]}
 */
export function validateThreadLabels(labels) {
  if (!Array.isArray(labels)) throw new ThreadIndexError("labels must be a list of strings.");
  /** @type {string[]} */
  const unique = [];
  for (const label of labels) {
    if (typeof label !== "string" || !LABEL.test(label)) {
      throw new ThreadIndexError(`label ${JSON.stringify(label)} is not allowed: use lowercase letters, digits and hyphens.`);
    }
    if (label.length > LABEL_MAX_LENGTH) {
      throw new ThreadIndexError(`label "${label}" is longer than ${LABEL_MAX_LENGTH} characters.`);
    }
    if (!unique.includes(label)) unique.push(label);
  }
  if (unique.length > LABELS_MAX) {
    throw new ThreadIndexError(`a session takes at most ${LABELS_MAX} labels, not ${unique.length}.`);
  }
  return unique;
}

/** The color names a session can have besides an RGB hex color. */
export const THREAD_COLORS = Object.freeze(["blue", "purple", "pink", "red", "orange", "yellow", "green", "cyan", "gray"]);

/**
 * Whether ampi-threads accepts `value` as a session's color: one of
 * `THREAD_COLORS` as written, or `#rrggbb` in either case.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
export function isThreadColor(value) {
  return typeof value === "string" && (THREAD_COLORS.includes(value) || HEX_COLOR.test(value));
}

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Every session's record, keyed by session id. A missing file is an empty
 * index. A file that is not a version 1 index is left as it is and reported:
 * ampi-threads sets a damaged file aside the next time a session starts.
 *
 * @param {string} file
 * @returns {Record<string, ThreadRecord>}
 */
export function readThreadIndex(file) {
  /** @type {string} */
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return {};
    throw error;
  }
  /** @type {unknown} */
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    document = undefined;
  }
  if (isObject(document) && typeof document.version === "number" && document.version > INDEX_VERSION) {
    throw new ThreadIndexError(`${file} has index version ${document.version}, written by a newer ampi; update ampi-cli to use it.`);
  }
  if (!isObject(document) || document.version !== INDEX_VERSION || !isObject(document.threads)) {
    throw new ThreadIndexError(`${file} is not a thread index ampi can read; start Pi with ampi once to set it aside.`);
  }
  /** @type {Record<string, ThreadRecord>} No prototype, so an id such as `constructor` finds no inherited value. */
  const threads = Object.create(null);
  for (const [id, record] of Object.entries(document.threads)) {
    if (isObject(record)) threads[id] = record;
  }
  return threads;
}

/**
 * Change one session's record and write the index back through a temporary
 * file, so a reader never sees half a file. `patch` sets fields; a `null`
 * value removes one, and `null` for the whole patch removes the record.
 * Fields the patch does not name stay as they are, the snooze, unread and
 * read dates the web GUI writes included.
 * Returns the record as written, or `undefined` when none is left. A session
 * id ampi-threads refuses is refused here too, before anything is written.
 *
 * @param {string} file
 * @param {string} sessionId
 * @param {{ [K in keyof ThreadRecord]?: ThreadRecord[K] | null } | null} patch
 * @returns {ThreadRecord | undefined}
 */
export function updateThreadRecord(file, sessionId, patch) {
  if (sessionId.trim() === "" || UNSAFE_IDS.has(sessionId)) {
    throw new ThreadIndexError(`ampi keeps no thread metadata for the session id ${JSON.stringify(sessionId)}.`);
  }
  const threads = readThreadIndex(file);
  /** @type {Record<string, unknown>} */
  const next = patch === null ? {} : { ...threads[sessionId] };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  if (Array.isArray(next.labels) && next.labels.length === 0) delete next.labels;
  if (Object.keys(next).length > 0) threads[sessionId] = /** @type {ThreadRecord} */ (next);
  else delete threads[sessionId];
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: INDEX_VERSION, threads }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temporary, file);
  return threads[sessionId];
}
