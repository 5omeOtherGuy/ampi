/**
 * Guidance from subfolders: the AGENTS.md (or CLAUDE.md) files of the
 * directories between the working directory and a file the model reads.
 *
 * Pi loads its context files once, at startup, from the agent directory, the
 * working directory and the working directory's parents. A file such as
 * `src/feature/AGENTS.md` only reaches the model if the model reads it. When
 * the model reads a file below the working directory with Pi's `read` tool,
 * ampi-core appends the guidance files of the directories on the way to that
 * file to the tool result, once per directory per session branch.
 *
 * Everything here is decided without Pi: which files to add, how long they may
 * be, how they are headed, and how the covered directories are stored in and
 * rebuilt from custom session entries. `subtree-guidance-hooks.ts` wires it to
 * Pi's events.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./internal/json.js";

/** Custom session entry type that records covered directories and resets. */
export const AMPI_SUBTREE_GUIDANCE_ENTRY = "ampi-core.subtree-guidance";
export const MMR_SUBTREE_GUIDANCE_ENTRY_VERSION = 1;

/**
 * The names Pi looks for in a directory, in the order it tries them; it takes
 * the first that exists and is a regular file. Copied from
 * `loadContextFileFromDir` in Pi's resource loader
 * (`dist/core/resource-loader.js`).
 */
export const MMR_CONTEXT_FILE_NAMES: readonly string[] = Object.freeze([
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
]);

/** Longest guidance text added per file, in UTF-8 bytes. */
export const MMR_SUBTREE_GUIDANCE_MAX_BYTES = 32 * 1024;

const SHORTENED_NOTE =
  "[ampi: this file is longer than 32 KiB, so only its first part is shown here. Read the file itself for the rest.]";

/**
 * Returns the text of `filePath` when it is a regular file, or `undefined`
 * when it is missing, is not a regular file, or cannot be read.
 */
export type MmrGuidanceFileReader = (filePath: string) => string | undefined;

/** The default reader: follows symlinks and reads UTF-8, like Pi does. */
export const readMmrRegularTextFile: MmrGuidanceFileReader = (filePath) => {
  try {
    if (!statSync(filePath).isFile()) return undefined;
    return readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
};

export interface MmrSubtreeGuidanceFile {
  /** Absolute path of the guidance file. */
  path: string;
  /** Absolute path of the directory it applies to. */
  directory: string;
  /** The file's text, without a leading BOM and capped at {@link MMR_SUBTREE_GUIDANCE_MAX_BYTES}. */
  text: string;
  /** True when the text was cut at the cap. */
  shortened: boolean;
}

export interface MmrSubtreeGuidanceSelection {
  /** Guidance files to add, outermost directory first. */
  files: MmrSubtreeGuidanceFile[];
  /**
   * Directories this read covers from now on: the directory of each file in
   * `files`, and the read file's own directory when the read file is the
   * guidance file Pi would take there.
   */
  covered: string[];
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Resolve the `path` input of Pi's `read` tool the way Pi does
 * (`resolveToCwd` in `dist/core/tools/path-utils.js`, which Pi does not
 * export): unusual Unicode spaces become plain spaces, a leading `@` is
 * dropped, `~` and `~/` expand to the home directory, a `file://` URL becomes
 * its path, and a relative path resolves against the working directory. Pi's
 * extra handling of Windows shell paths is not mirrored.
 */
export function resolveMmrReadToolPath(input: string, cwd: string, homeDirectory: string = homedir()): string {
  let normalized = input.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") normalized = homeDirectory;
  else if (normalized.startsWith("~/")) normalized = path.join(homeDirectory, normalized.slice(2));
  else if (/^file:\/\//.test(normalized)) normalized = fileURLToPath(normalized);
  return path.resolve(cwd, normalized);
}

/**
 * Directories from the working directory's child on the way to `filePath`
 * down to the file's own directory, outermost first. Empty when the file is
 * in the working directory itself or outside it.
 */
function directoriesBelowCwd(filePath: string, cwd: string): string[] {
  const root = path.resolve(cwd);
  const relative = path.relative(root, path.resolve(filePath));
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return [];
  }
  const segments = relative.split(path.sep);
  const directories: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    directories.push(path.join(root, ...segments.slice(0, index)));
  }
  return directories;
}

/**
 * Cap `text` at {@link MMR_SUBTREE_GUIDANCE_MAX_BYTES} UTF-8 bytes. A longer
 * text is cut after the last line break within the cap (or, for a single
 * longer line, at the last whole character) and ends with a note that it was
 * shortened.
 */
export function capMmrGuidanceText(text: string): { text: string; shortened: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= MMR_SUBTREE_GUIDANCE_MAX_BYTES) return { text, shortened: false };
  const head = bytes.subarray(0, MMR_SUBTREE_GUIDANCE_MAX_BYTES);
  const lastLineBreak = head.lastIndexOf(0x0a);
  let end = lastLineBreak >= 0 ? lastLineBreak + 1 : MMR_SUBTREE_GUIDANCE_MAX_BYTES;
  // Without a line break, step back from a UTF-8 continuation byte to the
  // start of the character it belongs to.
  if (lastLineBreak < 0) while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  const kept = bytes.subarray(0, end).toString("utf8");
  return { text: `${kept}${kept.endsWith("\n") ? "" : "\n"}${SHORTENED_NOTE}`, shortened: true };
}

/**
 * Pick the guidance files to add for a read of `filePath` (absolute). Each
 * directory below `cwd` on the way to the file that is not in `covered`
 * contributes the one file Pi would take there ({@link MMR_CONTEXT_FILE_NAMES}).
 * A file in `cwd` itself or outside it gets nothing: Pi has already loaded the
 * working directory's file and its parents'. When the read file is itself the
 * guidance file of its directory, no copy is added, but the directory counts
 * as covered.
 */
export function selectMmrSubtreeGuidance(options: {
  filePath: string;
  cwd: string;
  covered: ReadonlySet<string>;
  readFile?: MmrGuidanceFileReader;
}): MmrSubtreeGuidanceSelection {
  const readFile = options.readFile ?? readMmrRegularTextFile;
  const target = path.resolve(options.filePath);
  const files: MmrSubtreeGuidanceFile[] = [];
  const covered: string[] = [];
  for (const directory of directoriesBelowCwd(target, options.cwd)) {
    if (options.covered.has(directory)) continue;
    for (const name of MMR_CONTEXT_FILE_NAMES) {
      const guidancePath = path.join(directory, name);
      const raw = readFile(guidancePath);
      if (raw === undefined) continue;
      covered.push(directory);
      if (guidancePath !== target) {
        const capped = capMmrGuidanceText(raw.startsWith("\uFEFF") ? raw.slice(1) : raw);
        files.push({ path: guidancePath, directory, text: capped.text, shortened: capped.shortened });
      }
      break;
    }
  }
  return { files, covered };
}

function toSlashPath(relative: string): string {
  return relative.split(path.sep).join("/");
}

const GUIDANCE_HEADING = /^Instructions from .+ \(they apply to files under .+\/\):\n/;

/** The text block appended to a read result for one guidance file. */
export function formatMmrSubtreeGuidanceBlock(file: MmrSubtreeGuidanceFile, cwd: string): string {
  const root = path.resolve(cwd);
  const filePath = toSlashPath(path.relative(root, file.path));
  const directory = toSlashPath(path.relative(root, file.directory));
  return `Instructions from ${filePath} (they apply to files under ${directory}/):\n\n${file.text}`;
}

/**
 * True for a text block {@link formatMmrSubtreeGuidanceBlock} made. Other
 * extensions that rewrite read results (finder's line numbers) use it to leave
 * the guidance alone.
 */
export function isMmrSubtreeGuidanceText(text: string): boolean {
  return GUIDANCE_HEADING.test(text);
}

export type MmrSubtreeGuidanceEntryData =
  | { version: typeof MMR_SUBTREE_GUIDANCE_ENTRY_VERSION; directories: string[] }
  | { version: typeof MMR_SUBTREE_GUIDANCE_ENTRY_VERSION; reset: true };

/** Entry data recording directories whose guidance was added. */
export function coveredMmrSubtreeGuidanceEntry(directories: readonly string[]): MmrSubtreeGuidanceEntryData {
  return { version: MMR_SUBTREE_GUIDANCE_ENTRY_VERSION, directories: [...directories] };
}

/** Entry data that clears every directory recorded before it on the branch. */
export function resetMmrSubtreeGuidanceEntry(): MmrSubtreeGuidanceEntryData {
  return { version: MMR_SUBTREE_GUIDANCE_ENTRY_VERSION, reset: true };
}

function parseEntryData(data: unknown): MmrSubtreeGuidanceEntryData | undefined {
  if (!isRecord(data) || data.version !== MMR_SUBTREE_GUIDANCE_ENTRY_VERSION) return undefined;
  if (data.reset === true) return resetMmrSubtreeGuidanceEntry();
  const { directories } = data;
  if (!Array.isArray(directories) || directories.length === 0) return undefined;
  if (!directories.every((entry) => typeof entry === "string" && path.isAbsolute(entry))) return undefined;
  return coveredMmrSubtreeGuidanceEntry(directories as string[]);
}

/**
 * Rebuild the covered directories from a session branch, root first. A reset
 * entry clears everything before it; malformed entries are ignored.
 */
export function rebuildMmrSubtreeGuidanceCoverage(branch: readonly unknown[]): Set<string> {
  const covered = new Set<string>();
  for (const entry of branch) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== AMPI_SUBTREE_GUIDANCE_ENTRY) continue;
    const data = parseEntryData(entry.data);
    if (data === undefined) continue;
    if ("reset" in data) covered.clear();
    else for (const directory of data.directories) covered.add(directory);
  }
  return covered;
}
