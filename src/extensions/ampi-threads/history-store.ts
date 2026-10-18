import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../ampi-core/internal/json.js";
import { writeFileAtomic } from "../ampi-core/internal/settings-file.js";
import type { MmrPromptHistory, MmrPromptHistoryEntry, MmrPromptHistoryScope } from "../ampi-core/prompt-history.js";
import { withMmrThreadsFileLock } from "./index-store.js";

/**
 * Prompt history on disk: one JSON Lines file per workspace under Pi's agent
 * directory, `<agentDir>/data/ampi/threads/history/<workspace key>.jsonl`,
 * one `{ "ts": "<ISO 8601>", "text": "<prompt>" }` line per prompt, oldest
 * first. The workspace key is a hash of the working directory, so file names
 * carry no paths.
 *
 * - A prompt identical to the last one in the file is not added again.
 * - A file keeps at most {@link MMR_PROMPT_HISTORY_MAX} prompts. It grows
 *   past that by appending until it holds {@link MMR_PROMPT_HISTORY_REWRITE_AT}
 *   lines; the next prompt rewrites it with the newest prompts only, through
 *   a temp file renamed over it.
 * - A line that is not a valid entry is skipped when reading and dropped when
 *   the file is rewritten.
 * - Operations on one file run one at a time within the process. Across Pi
 *   processes appends interleave safely; a rewrite racing an append from
 *   another process can lose that one prompt.
 */

/** Prompts a file keeps, and the most one read returns per workspace. */
export const MMR_PROMPT_HISTORY_MAX = 1000;
/** Lines a file may reach before the next prompt rewrites it down to {@link MMR_PROMPT_HISTORY_MAX}. */
export const MMR_PROMPT_HISTORY_REWRITE_AT = 1200;
const FILE_SUFFIX = ".jsonl";

/** `<agentDir>/data/ampi/threads/history`, the directory the history files live in. */
export function resolveDefaultMmrPromptHistoryDir(): string {
  return path.join(getAgentDir(), "data", "ampi", "threads", "history");
}

/** The file name stem for a working directory: the first 32 hex digits of the SHA-256 of its absolute path. */
export function mmrPromptHistoryKey(cwd: string): string {
  return createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 32);
}

function parseLine(line: string): MmrPromptHistoryEntry | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || typeof value.ts !== "string" || Number.isNaN(Date.parse(value.ts))) return undefined;
  if (typeof value.text !== "string" || value.text.trim().length === 0) return undefined;
  return { ts: value.ts, text: value.text };
}

function formatLine(entry: MmrPromptHistoryEntry): string {
  return `${JSON.stringify({ ts: entry.ts, text: entry.text })}\n`;
}

interface FileContents {
  /** The raw text, or "" for a missing file. */
  readonly raw: string;
  /** Valid entries, oldest first. */
  readonly entries: MmrPromptHistoryEntry[];
  /** Non-empty lines, valid or not. */
  readonly lines: number;
}

async function readHistoryFile(filePath: string): Promise<FileContents> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { raw: "", entries: [], lines: 0 };
    throw error;
  }
  const entries: MmrPromptHistoryEntry[] = [];
  let lines = 0;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    lines += 1;
    const entry = parseLine(line);
    if (entry) entries.push(entry);
  }
  return { raw, entries, lines };
}

/** The newest `MMR_PROMPT_HISTORY_MAX` entries, newest first. */
function newestFirst(entries: readonly MmrPromptHistoryEntry[]): MmrPromptHistoryEntry[] {
  return entries.slice(-MMR_PROMPT_HISTORY_MAX).reverse();
}

export interface MmrPromptHistoryStoreOptions {
  /** Directory holding the history files; defaults to `<agentDir>/data/ampi/threads/history`. */
  readonly baseDir?: string;
  /** Time a prompt is recorded with (ISO 8601); defaults to the current time. */
  readonly now?: () => string;
}

export interface MmrPromptHistoryStore extends MmrPromptHistory {
  /** Absolute directory of the history files. */
  readonly dir: string;
  /** Absolute path of the history file for `cwd`. */
  pathFor(cwd: string): string;
  /**
   * Record `text` as sent in `cwd`. Resolves to false, writing nothing, for
   * blank text or a repeat of the file's last prompt.
   */
  append(cwd: string, text: string): Promise<boolean>;
}

export function createMmrPromptHistoryStore(options: MmrPromptHistoryStoreOptions = {}): MmrPromptHistoryStore {
  const dir = path.resolve(options.baseDir ?? resolveDefaultMmrPromptHistoryDir());
  const now = options.now ?? (() => new Date().toISOString());
  const pathFor = (cwd: string) => path.join(dir, `${mmrPromptHistoryKey(cwd)}${FILE_SUFFIX}`);
  const readLocked = (filePath: string) => withMmrThreadsFileLock(filePath, () => readHistoryFile(filePath));

  async function readAll(): Promise<MmrPromptHistoryEntry[]> {
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith(FILE_SUFFIX)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const merged: MmrPromptHistoryEntry[] = [];
    for (const name of names) merged.push(...newestFirst((await readLocked(path.join(dir, name))).entries));
    // A stable sort keeps each file's own order for prompts with the same time.
    return merged.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  }

  return {
    dir,
    pathFor,
    async read(cwd, scope: MmrPromptHistoryScope) {
      if (scope === "all") return readAll();
      return newestFirst((await readLocked(pathFor(cwd))).entries);
    },
    append(cwd, text) {
      const filePath = pathFor(cwd);
      return withMmrThreadsFileLock(filePath, async () => {
        if (text.trim().length === 0) return false;
        const current = await readHistoryFile(filePath);
        if (current.entries.at(-1)?.text === text) return false;
        const entry: MmrPromptHistoryEntry = { ts: now(), text };
        if (current.lines + 1 > MMR_PROMPT_HISTORY_REWRITE_AT) {
          const kept = [...current.entries, entry].slice(-MMR_PROMPT_HISTORY_MAX);
          writeFileAtomic(filePath, kept.map(formatLine).join(""));
          return true;
        }
        await mkdir(dir, { recursive: true });
        // A crash may have left the last line without its newline; start a fresh line.
        const separator = current.raw.length > 0 && !current.raw.endsWith("\n") ? "\n" : "";
        await appendFile(filePath, `${separator}${formatLine(entry)}`, { encoding: "utf8", mode: 0o600 });
        return true;
      });
    },
  };
}
