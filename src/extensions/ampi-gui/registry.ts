import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../ampi-core/internal/json.js";

/**
 * The live registry: one small JSON file per Pi process that serves the web
 * GUI, at `<agentDir>/data/ampi/live/<pid>.json`. Other tools on the same
 * machine read it to find running sessions and their local GUI port.
 *
 * Each process writes and removes only its own file, so there is no
 * cross-process contention. A process that ends without removing its file
 * (a crash, a kill) leaves a stale entry; every writer first removes the
 * entries whose process no longer runs. The file holds a hash of the access
 * token, never the token itself.
 */

export const MMR_GUI_LIVE_REGISTRY_VERSION = 1;

export interface MmrGuiLiveEntry {
  version: number;
  pid: number;
  /** The session file, or `null` for a session that is not saved. */
  sessionPath: string | null;
  cwd: string;
  port: number;
  /** SHA-256 of the access token, hex. */
  tokenHash: string;
  /** ISO timestamp of when the server started. */
  startedAt: string;
}

export interface MmrGuiRegistryOptions {
  /** Directory holding the entries; defaults to `<agentDir>/data/ampi/live`. */
  baseDir?: string;
  /** Whether a process runs; defaults to a signal-0 probe. */
  isAlive?: (pid: number) => boolean;
}

export function resolveDefaultMmrGuiLiveDir(): string {
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

function parseEntry(value: unknown): MmrGuiLiveEntry | undefined {
  if (!isRecord(value) || value.version !== MMR_GUI_LIVE_REGISTRY_VERSION) return undefined;
  const { pid, sessionPath, cwd, port, tokenHash, startedAt } = value;
  if (!Number.isInteger(pid) || !Number.isInteger(port)) return undefined;
  if (typeof cwd !== "string" || typeof tokenHash !== "string" || typeof startedAt !== "string") return undefined;
  if (sessionPath !== null && typeof sessionPath !== "string") return undefined;
  return { version: MMR_GUI_LIVE_REGISTRY_VERSION, pid: pid as number, sessionPath, cwd, port: port as number, tokenHash, startedAt };
}

/**
 * The entries of running processes. Removes the files of processes that no
 * longer run; files that are not valid entries are skipped and left alone.
 */
export async function readMmrGuiLiveEntries(options: MmrGuiRegistryOptions = {}): Promise<MmrGuiLiveEntry[]> {
  const baseDir = options.baseDir ?? resolveDefaultMmrGuiLiveDir();
  const isAlive = options.isAlive ?? processIsAlive;
  let names: string[];
  try {
    names = await readdir(baseDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: MmrGuiLiveEntry[] = [];
  for (const name of names.filter((n) => /^\d+\.json$/.test(n)).sort()) {
    const file = path.join(baseDir, name);
    let entry: MmrGuiLiveEntry | undefined;
    try {
      entry = parseEntry(JSON.parse(await readFile(file, "utf8")));
    } catch {
      continue;
    }
    if (!entry || `${entry.pid}.json` !== name) continue;
    if (isAlive(entry.pid)) entries.push(entry);
    else await rm(file, { force: true });
  }
  return entries;
}

/** Write this process's entry atomically, after removing stale ones. */
export async function writeMmrGuiLiveEntry(entry: Omit<MmrGuiLiveEntry, "version">, options: MmrGuiRegistryOptions = {}): Promise<string> {
  const baseDir = options.baseDir ?? resolveDefaultMmrGuiLiveDir();
  await mkdir(baseDir, { recursive: true });
  await readMmrGuiLiveEntries({ ...options, baseDir });
  const file = path.join(baseDir, `${entry.pid}.json`);
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const body: MmrGuiLiveEntry = { version: MMR_GUI_LIVE_REGISTRY_VERSION, ...entry };
  await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  try {
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return file;
}

/** Remove this process's entry; a missing file is fine. */
export async function removeMmrGuiLiveEntry(pid: number, options: MmrGuiRegistryOptions = {}): Promise<void> {
  const baseDir = options.baseDir ?? resolveDefaultMmrGuiLiveDir();
  await rm(path.join(baseDir, `${pid}.json`), { force: true });
}
