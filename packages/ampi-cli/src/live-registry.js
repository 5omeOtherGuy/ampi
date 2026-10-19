// ampi's live registry, read from the `ampi` command, which runs outside Pi
// and cannot import ampi's TypeScript. ampi-core writes one file per running
// Pi process whose session has a file, at <agentDir>/data/ampi/live/<pid>.json;
// the format and the reading rules are those of
// src/extensions/ampi-core/live-registry.ts. tests/mmr-cli-live-registry.test.mjs
// checks that both readers return the same entries for the same files.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * @typedef {object} LiveEntry One running process.
 * @property {number} version 2, or 1 for a file an older ampi wrote.
 * @property {number} pid
 * @property {number | null} procStart The process start time from /proc/<pid>/stat, or null.
 * @property {"tui" | "execute" | "app" | "app-session"} kind
 * @property {string | null} sessionId
 * @property {string | null} sessionPath
 * @property {string} cwd
 * @property {string | null} title
 * @property {string | null} mode
 * @property {{ phase: string, label: string } | null} status
 * @property {string} startedAt
 * @property {string} updatedAt
 * @property {{ port: number, tokenHash: string } | null} gui
 * @property {number} [ownerPid] The host process of an `app-session` entry.
 *
 * @typedef {object} LiveRegistryOptions
 * @property {string} dir The registry directory (liveRegistryDir).
 * @property {(pid: number) => boolean} [isAlive] Whether a process runs; defaults to a signal-0 probe.
 * @property {(pid: number) => number | null} [procStart] A process's start time; defaults to /proc/<pid>/stat.
 */

const VERSION = 2;
const KINDS = new Set(["tui", "execute", "app", "app-session"]);

/**
 * `<agentDir>/data/ampi/live`.
 *
 * @param {string} agentDir Pi's configuration directory.
 * @returns {string}
 */
export function liveRegistryDir(agentDir) {
  return path.join(agentDir, "data", "ampi", "live");
}

/** @param {number} pid @returns {boolean} */
function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM";
  }
}

/**
 * Field 22 of /proc/<pid>/stat, or null when it cannot be read.
 *
 * @param {number} pid
 * @returns {number | null}
 */
export function readProcStart(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name (field 2) is in parentheses and may hold spaces.
    const value = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
    return Number.isSafeInteger(value) ? value : null;
  } catch {
    return null;
  }
}

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** @param {unknown} value @returns {value is number} */
const isPid = (value) => Number.isSafeInteger(value) && /** @type {number} */ (value) > 0;
/** @param {unknown} value @returns {value is string | null} */
const isStringOrNull = (value) => value === null || typeof value === "string";

/** @param {unknown} value */
function parseGui(value) {
  if (value === null) return null;
  if (!isObject(value) || !Number.isInteger(value.port) || typeof value.tokenHash !== "string") return undefined;
  return { port: value.port, tokenHash: value.tokenHash };
}

/** @param {unknown} value */
function parseStatus(value) {
  if (value === null) return null;
  if (!isObject(value) || typeof value.phase !== "string" || typeof value.label !== "string") return undefined;
  return { phase: value.phase, label: value.label };
}

/**
 * A version 1 or 2 entry with every field checked, or undefined.
 *
 * @param {unknown} value
 * @returns {LiveEntry | undefined}
 */
function parseEntry(value) {
  if (!isObject(value)) return undefined;
  const { pid, cwd, sessionPath, startedAt } = value;
  if (!isPid(pid) || typeof cwd !== "string" || !isStringOrNull(sessionPath) || typeof startedAt !== "string") return undefined;
  if (value.version === 1) {
    const gui = parseGui({ port: value.port, tokenHash: value.tokenHash });
    if (!gui) return undefined;
    return {
      version: 1,
      pid,
      procStart: null,
      kind: "tui",
      sessionId: null,
      sessionPath,
      cwd,
      title: null,
      mode: null,
      status: null,
      startedAt,
      updatedAt: startedAt,
      gui,
    };
  }
  if (value.version !== VERSION) return undefined;
  const { procStart, kind, sessionId, title, mode, updatedAt, ownerPid } = value;
  if (procStart !== null && !Number.isSafeInteger(procStart)) return undefined;
  if (!KINDS.has(kind)) return undefined;
  if (!isStringOrNull(sessionId) || !isStringOrNull(title) || !isStringOrNull(mode) || typeof updatedAt !== "string") return undefined;
  const status = parseStatus(value.status);
  const gui = parseGui(value.gui);
  if (status === undefined || gui === undefined) return undefined;
  if (kind === "app-session" && !isPid(ownerPid)) return undefined;
  return {
    version: VERSION,
    pid,
    procStart,
    kind,
    sessionId,
    sessionPath,
    cwd,
    title,
    mode,
    status,
    startedAt,
    updatedAt,
    gui,
    ...(kind === "app-session" ? { ownerPid } : {}),
  };
}

/**
 * The entries of running processes, by pid. Removes the files (the entry
 * and its token file) of processes that no longer run, and of a pid whose
 * process started at another time than the entry says. Files that are not
 * valid entries, or whose name is not their pid, are skipped and left alone.
 * A missing directory has none.
 *
 * @param {LiveRegistryOptions} options
 * @returns {LiveEntry[]}
 */
export function readLiveEntries({ dir, isAlive = processIsAlive, procStart = readProcStart }) {
  /** @type {string[]} */
  let names;
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return [];
    throw error;
  }
  /** @type {LiveEntry[]} */
  const entries = [];
  for (const name of names.filter((n) => /^\d+\.json$/.test(n))) {
    const file = path.join(dir, name);
    /** @type {LiveEntry | undefined} */
    let entry;
    try {
      entry = parseEntry(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      continue;
    }
    if (!entry || `${entry.pid}.json` !== name) continue;
    let running = isAlive(entry.pid);
    if (running && entry.procStart !== null) {
      // The pid now names another process when its start time differs.
      const current = procStart(entry.pid);
      running = current === null || current === entry.procStart;
    }
    if (running) entries.push(entry);
    else {
      rmSync(file, { force: true });
      rmSync(path.join(dir, `${entry.pid}.token`), { force: true });
    }
  }
  return entries.sort((a, b) => a.pid - b.pid);
}

/**
 * The GUI access token of a live entry, from `<pid>.token` next to it, or
 * undefined when the entry has no GUI or the file is missing, unreadable or
 * holds another token than the entry's hash names.
 *
 * @param {string} dir The registry directory.
 * @param {LiveEntry} entry
 * @returns {string | undefined}
 */
export function readLiveToken(dir, entry) {
  if (!entry.gui) return undefined;
  let token;
  try {
    token = readFileSync(path.join(dir, `${entry.pid}.token`), "utf8");
  } catch {
    return undefined;
  }
  return token !== "" && createHash("sha256").update(token, "utf8").digest("hex") === entry.gui.tokenHash ? token : undefined;
}

/**
 * A path with its symbolic links resolved, as far as it exists.
 *
 * @param {string} file
 * @returns {string}
 */
function realPath(file) {
  try {
    return realpathSync(file);
  } catch {
    // A new session's file does not exist until its first message.
    try {
      return path.join(realpathSync(path.dirname(file)), path.basename(file));
    } catch {
      return path.resolve(file);
    }
  }
}

/**
 * The live entry of another process that names `sessionPath` (compared as
 * real paths), or undefined.
 *
 * @param {string} sessionPath
 * @param {LiveRegistryOptions & { exceptPid?: number }} options
 * @returns {LiveEntry | undefined}
 */
export function findLiveOwner(sessionPath, options) {
  const target = realPath(sessionPath);
  return readLiveEntries(options).find(
    (entry) => entry.pid !== options.exceptPid && entry.sessionPath !== null && realPath(entry.sessionPath) === target,
  );
}
