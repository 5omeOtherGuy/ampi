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
 * one `{ "v": 1, "ts": "<ISO 8601>", "text": "<prompt>" }` line per prompt,
 * oldest first. The workspace key is a hash of the working directory, so
 * file names carry no paths.
 *
 * - Each line carries its format version, `v`. Reading uses only lines of
 *   {@link MMR_PROMPT_HISTORY_VERSION}; a JSON object with any other `v`
 *   (or none) was written by another ampi version and is left as it is.
 * - A prompt identical to the last one in the file is not added again.
 * - A file keeps at most {@link MMR_PROMPT_HISTORY_MAX} prompts. It grows
 *   past that by appending until it holds {@link MMR_PROMPT_HISTORY_REWRITE_AT}
 *   prompts; the next prompt rewrites it, through a temp file renamed over
 *   it, with the newest prompts and every line of another version, in their
 *   order.
 * - A line that cannot be read (cut off by a crash, or a version 1 line
 *   without a valid time or text) is skipped when reading and dropped when
 *   the file is rewritten. This is the one place the store discards data it
 *   did not write in the same call; such a line holds no prompt it could show.
 * - Operations on one file run one at a time within the process. Across Pi
 *   processes appends interleave safely; a rewrite racing an append from
 *   another process can lose that one prompt.
 */

/** The `v` on every line this version writes, and the only one it reads. */
export const MMR_PROMPT_HISTORY_VERSION = 1;
/** Prompts a file keeps, and the most one read returns per workspace. */
export const MMR_PROMPT_HISTORY_MAX = 1000;
/** Prompts a file may reach before the next prompt rewrites it down to {@link MMR_PROMPT_HISTORY_MAX}. */
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

/** A line of this version's prompt, another version's line (kept as it is), or an unreadable one. */
type Line =
  | { readonly kind: "entry"; readonly raw: string; readonly entry: MmrPromptHistoryEntry }
  | { readonly kind: "other"; readonly raw: string }
  | { readonly kind: "damaged" };

function parseLine(raw: string): Line {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: "damaged" };
  }
  if (!isRecord(value)) return { kind: "damaged" };
  if (value.v !== MMR_PROMPT_HISTORY_VERSION) return { kind: "other", raw };
  if (typeof value.ts !== "string" || Number.isNaN(Date.parse(value.ts))) return { kind: "damaged" };
  if (typeof value.text !== "string" || value.text.trim().length === 0) return { kind: "damaged" };
  return { kind: "entry", raw, entry: { ts: value.ts, text: value.text } };
}

function formatLine(entry: MmrPromptHistoryEntry): string {
  return JSON.stringify({ v: MMR_PROMPT_HISTORY_VERSION, ts: entry.ts, text: entry.text });
}

interface FileContents {
  /** The raw text, or "" for a missing file. */
  readonly raw: string;
  /** The non-empty lines, in file order. */
  readonly lines: readonly Line[];
  /** This version's prompts, oldest first. */
  readonly entries: MmrPromptHistoryEntry[];
}

async function readHistoryFile(filePath: string): Promise<FileContents> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { raw: "", lines: [], entries: [] };
    throw error;
  }
  const lines = raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(parseLine);
  const entries = lines.flatMap((line) => (line.kind === "entry" ? [line.entry] : []));
  return { raw, lines, entries };
}

/**
 * The file after adding `entry` to a full one: the newest
 * {@link MMR_PROMPT_HISTORY_MAX} prompts and every other version's line, in
 * file order; unreadable lines are dropped.
 */
function rewrittenFile(current: FileContents, entry: MmrPromptHistoryEntry): string {
  let toDrop = current.entries.length + 1 - MMR_PROMPT_HISTORY_MAX;
  const kept: string[] = [];
  for (const line of current.lines) {
    if (line.kind === "damaged") continue;
    if (line.kind === "entry" && toDrop > 0) {
      toDrop -= 1;
      continue;
    }
    kept.push(line.raw);
  }
  kept.push(formatLine(entry));
  return `${kept.join("\n")}\n`;
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
        if (current.entries.length + 1 > MMR_PROMPT_HISTORY_REWRITE_AT) {
          writeFileAtomic(filePath, rewrittenFile(current, entry));
          return true;
        }
        await mkdir(dir, { recursive: true });
        // A crash may have left the last line without its newline; start a fresh line.
        const separator = current.raw.length > 0 && !current.raw.endsWith("\n") ? "\n" : "";
        await appendFile(filePath, `${separator}${formatLine(entry)}\n`, { encoding: "utf8", mode: 0o600 });
        return true;
      });
    },
  };
}
