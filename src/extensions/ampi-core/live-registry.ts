import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { getMmrGuiHost } from "./gui-host.js";
import { isRecord } from "./internal/json.js";
import { getMmrModeState, onMmrStateChanged } from "./runtime.js";
import { createMmrThreadStatusEventMapper, onMmrThreadStatusEvents } from "./thread-status-events.js";
import { createMmrThreadStatusReducer, type MmrThreadPhase } from "./thread-status.js";
import type { MmrModeKey } from "./types.js";

/**
 * The live registry: one small JSON file per running Pi process whose
 * session has a file, at `<agentDir>/data/ampi/live/<pid>.json`. Other
 * processes on the same machine read it to list running sessions and to
 * find the process that writes a session file. Pi does not lock session
 * files, so a second writer would interleave its messages with the first.
 *
 * ampi-core writes the entry from `session_start` to `session_shutdown`,
 * whatever other ampi extensions are on; they add fields through
 * `setMmrLiveFields`. Each process writes and removes only its own file.
 * Readers remove the files of processes that no longer run, and of a pid
 * that now belongs to another process (its start time differs). The file
 * holds paths, pids, a title and a hash of the GUI's access token, never the
 * token itself. The plain JavaScript reader for the `ampi` command,
 * `packages/ampi-cli/src/live-registry.js`, follows the same rules.
 */

export const MMR_LIVE_REGISTRY_VERSION = 2;

/** At most one write per this many milliseconds after the first, then one trailing write. */
export const MMR_LIVE_WRITE_INTERVAL_MS = 250;

/**
 * What kind of process wrote the entry: an interactive terminal session
 * (`tui`), a print, JSON or RPC run (`execute`), a multi-session host
 * (`app`) or a session such a host serves (`app-session`).
 */
export type MmrLiveKind = "tui" | "execute" | "app" | "app-session";

export interface MmrLiveGui {
  port: number;
  /** SHA-256 of the access token, hex. */
  tokenHash: string;
}

export interface MmrLiveStatus {
  phase: MmrThreadPhase;
  label: string;
}

export interface MmrLiveEntry {
  /** 2; readers also return version 1 files, normalised to these fields. */
  version: number;
  pid: number;
  /** The process start time from `/proc/<pid>/stat` (clock ticks after boot), or `null` off Linux. */
  procStart: number | null;
  kind: MmrLiveKind;
  sessionId: string | null;
  sessionPath: string | null;
  cwd: string;
  title: string | null;
  mode: MmrModeKey | null;
  status: MmrLiveStatus | null;
  /** ISO timestamp of when the session started in this process. */
  startedAt: string;
  /** ISO timestamp of the last write. */
  updatedAt: string;
  gui: MmrLiveGui | null;
  /** The host process that serves an `app-session` entry. */
  ownerPid?: number;
}

export interface MmrLiveRegistryOptions {
  /** Directory holding the entries; defaults to `<agentDir>/data/ampi/live`. */
  dir?: string;
  /** Whether a process runs; defaults to a signal-0 probe. */
  isAlive?: (pid: number) => boolean;
  /** A process's start time; defaults to `/proc/<pid>/stat`, `null` where there is none. */
  procStart?: (pid: number) => number | null;
}

export function resolveDefaultMmrLiveDir(): string {
  return path.join(getAgentDir(), "data", "ampi", "live");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Field 22 of `/proc/<pid>/stat`, or `null` when it cannot be read. */
export function readMmrProcStart(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name (field 2) is in parentheses and may hold spaces.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const value = Number(fields[19]);
    return Number.isSafeInteger(value) ? value : null;
  } catch {
    return null;
  }
}

const KINDS: ReadonlySet<string> = new Set(["tui", "execute", "app", "app-session"]);
const isPid = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const isStringOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";

function parseGui(value: unknown): MmrLiveGui | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !Number.isInteger(value.port) || typeof value.tokenHash !== "string") return undefined;
  return { port: value.port as number, tokenHash: value.tokenHash };
}

function parseStatus(value: unknown): MmrLiveStatus | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.phase !== "string" || typeof value.label !== "string") return undefined;
  return { phase: value.phase as MmrThreadPhase, label: value.label };
}

/** A version 1 or 2 entry with every field checked, or `undefined`. */
function parseEntry(value: unknown): MmrLiveEntry | undefined {
  if (!isRecord(value)) return undefined;
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
  if (value.version !== MMR_LIVE_REGISTRY_VERSION) return undefined;
  const { procStart, kind, sessionId, title, mode, updatedAt, ownerPid } = value;
  if (procStart !== null && !Number.isSafeInteger(procStart)) return undefined;
  if (typeof kind !== "string" || !KINDS.has(kind)) return undefined;
  if (!isStringOrNull(sessionId) || !isStringOrNull(title) || !isStringOrNull(mode) || typeof updatedAt !== "string") return undefined;
  const status = parseStatus(value.status);
  const gui = parseGui(value.gui);
  if (status === undefined || gui === undefined) return undefined;
  if (kind === "app-session" && !isPid(ownerPid)) return undefined;
  return {
    version: MMR_LIVE_REGISTRY_VERSION,
    pid,
    procStart: procStart as number | null,
    kind: kind as MmrLiveKind,
    sessionId,
    sessionPath,
    cwd,
    title,
    mode: mode as MmrModeKey | null,
    status,
    startedAt,
    updatedAt,
    gui,
    ...(kind === "app-session" ? { ownerPid: ownerPid as number } : {}),
  };
}

/**
 * The entries of running processes, by pid. Removes the files of processes
 * that no longer run, and of a pid whose process started at another time
 * than the entry says. Files that are not valid entries, or whose name is
 * not their pid, are skipped and left alone.
 */
export async function readMmrLiveEntries(options: MmrLiveRegistryOptions = {}): Promise<MmrLiveEntry[]> {
  const dir = options.dir ?? resolveDefaultMmrLiveDir();
  const isAlive = options.isAlive ?? processIsAlive;
  const procStart = options.procStart ?? readMmrProcStart;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: MmrLiveEntry[] = [];
  for (const name of names.filter((n) => /^\d+\.json$/.test(n))) {
    const file = path.join(dir, name);
    let entry: MmrLiveEntry | undefined;
    try {
      entry = parseEntry(JSON.parse(await readFile(file, "utf8")));
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
    else await rm(file, { force: true });
  }
  return entries.sort((a, b) => a.pid - b.pid);
}

/** Write an entry atomically (a temp file renamed over `<pid>.json`), readable only by the owner. */
export async function writeMmrLiveEntry(entry: Omit<MmrLiveEntry, "version">, options: Pick<MmrLiveRegistryOptions, "dir"> = {}): Promise<string> {
  const dir = options.dir ?? resolveDefaultMmrLiveDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${entry.pid}.json`);
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const body: MmrLiveEntry = { version: MMR_LIVE_REGISTRY_VERSION, ...entry };
  await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  try {
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return file;
}

/** Remove a process's entry; a missing file is fine. */
export async function removeMmrLiveEntry(pid: number, options: Pick<MmrLiveRegistryOptions, "dir"> = {}): Promise<void> {
  await rm(path.join(options.dir ?? resolveDefaultMmrLiveDir(), `${pid}.json`), { force: true });
}

/** A path with its symbolic links resolved, as far as it exists. */
function realPath(file: string): string {
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

/** The live entry of another process that names `sessionPath` (compared as real paths), or `undefined`. */
export async function findMmrLiveOwner(
  sessionPath: string,
  options: MmrLiveRegistryOptions & { exceptPid?: number } = {},
): Promise<MmrLiveEntry | undefined> {
  const target = realPath(sessionPath);
  return (await readMmrLiveEntries(options)).find(
    (entry) => entry.pid !== options.exceptPid && entry.sessionPath !== null && realPath(entry.sessionPath) === target,
  );
}

/**
 * The kind of entry this process writes for its session, or `undefined` for
 * a session without a file (`--no-session`, which every subagent worker
 * uses, and in-memory sessions), which writes none. A session that
 * `ampi app` hosts (see `gui-host.ts`) is `app-session`, with the host's pid.
 */
export function resolveMmrLiveKind(
  ctx: Pick<ExtensionContext, "mode" | "sessionManager">,
): { kind: MmrLiveKind; ownerPid?: number } | undefined {
  // Feature-detected like the session identity: hosts that lack the accessor have no file to share.
  if (!ctx.sessionManager.getSessionFile?.()) return undefined;
  const host = getMmrGuiHost();
  if (host?.role === "session") return { kind: "app-session", ownerPid: host.ownerPid };
  return { kind: ctx.mode === "tui" ? "tui" : "execute" };
}

/** Fields other extensions contribute to this process's entry. */
export interface MmrLiveFields {
  /** A generated session title; Pi's session name wins when there is one. */
  title?: string | null;
  /** The web GUI's port and token hash, or `null` when it is not serving. */
  gui?: MmrLiveGui | null;
}

interface LiveFieldsStore {
  fields: MmrLiveFields;
  writers: Set<() => void>;
}

// globalThis-anchored so every cache-isolated copy of this module shares one store.
const LIVE_FIELDS_GLOBAL_KEY = "__pi_ampi_live_registry_v2__";
const globalStore = globalThis as typeof globalThis & { [LIVE_FIELDS_GLOBAL_KEY]?: LiveFieldsStore };

function liveStore(): LiveFieldsStore {
  let store = globalStore[LIVE_FIELDS_GLOBAL_KEY];
  if (!store) {
    store = { fields: {}, writers: new Set() };
    globalStore[LIVE_FIELDS_GLOBAL_KEY] = store;
  }
  return store;
}

/**
 * Merge `fields` into this process's live entry: a key that is present sets
 * the field (`null` clears it), an absent key leaves it alone. The entry is
 * rewritten within the write throttle. Contributions last until the session
 * ends.
 */
export function setMmrLiveFields(fields: MmrLiveFields): void {
  const store = liveStore();
  store.fields = { ...store.fields, ...fields };
  for (const schedule of store.writers) schedule();
}

export interface MmrLiveRegistryHooksOptions extends MmrLiveRegistryOptions {
  /** Epoch milliseconds; defaults to `Date.now`. */
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Receives the conflict warning outside the terminal; defaults to stderr. */
  writeStderr?: (line: string) => void;
}

export interface MmrLiveRegistryWriter {
  /** Resolves once every write started so far has finished. */
  idle(): Promise<void>;
}

/**
 * Write this process's entry for the session's lifetime: at `session_start`
 * (and again after `/new`, `/resume` or `/fork`, which end one session and
 * start another), throttled on every change of mode, status phase or
 * contributed field, and removed at `session_shutdown` and, best effort,
 * when the process exits. At `session_start` it warns when another live
 * process names the same session file; the warning does not stop anything,
 * because Pi has opened the file before extensions run.
 */
export function registerMmrLiveRegistry(
  pi: Pick<ExtensionAPI, "on" | "events">,
  options: MmrLiveRegistryHooksOptions = {},
): MmrLiveRegistryWriter {
  const storage: MmrLiveRegistryOptions = { dir: options.dir, isAlive: options.isAlive, procStart: options.procStart };
  const procStart = options.procStart ?? readMmrProcStart;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const writeStderr = options.writeStderr ?? ((line: string) => void process.stderr.write(line));

  let session:
    | {
        ctx: ExtensionContext;
        kind: MmrLiveKind;
        ownerPid?: number;
        sessionPath: string;
        procStart: number | null;
        startedAt: string;
      }
    | undefined;
  let reducer = createMmrThreadStatusReducer();
  const mapper = createMmrThreadStatusEventMapper();
  /** The mode and status the last write recorded, to skip events that change neither. */
  let written = "";
  let lastWrite = Number.NEGATIVE_INFINITY;
  let timer: unknown;
  let pending = false;
  let chain: Promise<unknown> = Promise.resolve();

  function removeOnExit(): void {
    try {
      rmSync(path.join(storage.dir ?? resolveDefaultMmrLiveDir(), `${process.pid}.json`), { force: true });
    } catch {
      // Best effort: the next reader removes a dead process's entry.
    }
  }

  function snapshot(): Omit<MmrLiveEntry, "version"> | undefined {
    if (!session) return undefined;
    const { ctx } = session;
    const fields = liveStore().fields;
    let sessionId: string | null = null;
    let sessionName: string | undefined;
    try {
      sessionId = ctx.sessionManager.getSessionId() ?? null;
      sessionName = ctx.sessionManager.getSessionName();
    } catch {
      // A context Pi has retired; the next session_start replaces it.
    }
    const status = reducer.status;
    return {
      pid: process.pid,
      procStart: session.procStart,
      kind: session.kind,
      sessionId,
      sessionPath: session.sessionPath,
      cwd: ctx.cwd,
      title: sessionName || fields.title || null,
      mode: getMmrModeState()?.mode ?? null,
      status: { phase: status.phase, label: status.label },
      startedAt: session.startedAt,
      updatedAt: new Date(now()).toISOString(),
      gui: fields.gui ?? null,
      ...(session.ownerPid !== undefined ? { ownerPid: session.ownerPid } : {}),
    };
  }

  function write(): Promise<unknown> {
    pending = false;
    lastWrite = now();
    const entry = snapshot();
    if (!entry) return chain;
    written = `${entry.mode}|${entry.status?.phase}|${entry.status?.label}`;
    chain = chain.then(() => writeMmrLiveEntry(entry, storage)).catch(() => {});
    return chain;
  }

  function schedule(): void {
    if (!session) return;
    pending = true;
    if (timer !== undefined) return;
    const wait = lastWrite + MMR_LIVE_WRITE_INTERVAL_MS - now();
    if (wait <= 0) {
      write();
      return;
    }
    timer = setTimer(() => {
      timer = undefined;
      if (pending) write();
    }, wait);
  }

  function scheduleIfChanged(): void {
    const status = reducer.status;
    if (`${getMmrModeState()?.mode ?? null}|${status.phase}|${status.label}` !== written) schedule();
  }

  liveStore().writers.add(schedule);

  pi.on("session_start", async (_event, ctx) => {
    const identity = resolveMmrLiveKind(ctx);
    if (!identity) return;
    const sessionPath = ctx.sessionManager.getSessionFile() as string;
    reducer = createMmrThreadStatusReducer();
    mapper.reset();
    session = { ctx, ...identity, sessionPath, procStart: procStart(process.pid), startedAt: new Date(now()).toISOString() };
    process.off("exit", removeOnExit);
    process.on("exit", removeOnExit);
    await write();

    let owner: MmrLiveEntry | undefined;
    try {
      owner = await findMmrLiveOwner(sessionPath, { ...storage, exceptPid: process.pid });
    } catch {
      return;
    }
    if (!owner) return;
    const message = `This session file is also open in process ${owner.pid} (${owner.kind}). Two processes writing one session file can lose messages; close one of them.`;
    if (ctx.mode === "tui") ctx.ui.notify(message, "warning");
    else writeStderr(`ampi: ${message}\n`);
  });

  pi.on("session_shutdown", async () => {
    if (!session) return;
    session = undefined;
    pending = false;
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    lastWrite = Number.NEGATIVE_INFINITY;
    written = "";
    liveStore().fields = {};
    process.off("exit", removeOnExit);
    await chain;
    await removeMmrLiveEntry(process.pid, storage).catch(() => {});
  });

  onMmrThreadStatusEvents(
    pi,
    ({ events }) => {
      if (!session) return;
      for (const event of events) reducer.apply(event);
      scheduleIfChanged();
    },
    mapper,
  );

  onMmrStateChanged(pi, () => {
    if (session) scheduleIfChanged();
  });

  return { idle: () => chain.then(() => {}) };
}
