import { readFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../../ampi-core/internal/json.js";
import { writeFileAtomic } from "../../ampi-core/internal/settings-file.js";

/**
 * Whether this user has seen the onboarding intro: one JSON file under Pi's
 * agent directory, `<agentDir>/data/ampi/tui/intro.json`, shaped
 * `{ "version": 1, "seenAt": "<ISO date>" }`.
 *
 * - The file is written once, when the intro closes for the first time,
 *   through a temp file renamed into place.
 * - A file that cannot be read, is not valid JSON or has another version
 *   counts as seen and is never overwritten, so a damaged file stops the
 *   intro from opening by itself rather than being replaced.
 * - Reads and writes are synchronous, so they never interleave within a Pi
 *   process. Across processes the last writer wins; every writer writes the
 *   same fact.
 */

export const MMR_INTRO_RECORD_VERSION = 1;

/** `<agentDir>/data/ampi/tui/intro.json`. */
export function resolveDefaultMmrIntroRecordPath(agentDir = getAgentDir()): string {
  return path.join(agentDir, "data", "ampi", "tui", "intro.json");
}

/** `missing`: no file yet. `seen`: a valid record. `unreadable`: anything else, left alone. */
export type MmrIntroRecordState = "missing" | "seen" | "unreadable";

export function readMmrIntroRecord(filePath: string): MmrIntroRecordState {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) && value.version === MMR_INTRO_RECORD_VERSION ? "seen" : "unreadable";
  } catch {
    return "unreadable";
  }
}

/**
 * Record that the intro was seen, unless a file is already there. Returns
 * whether it wrote one. A failed write is left unreported: the intro then
 * opens again next time, which is the safe side.
 */
export function markMmrIntroSeen(filePath: string, now: () => Date = () => new Date()): boolean {
  if (readMmrIntroRecord(filePath) !== "missing") return false;
  try {
    writeFileAtomic(filePath, `${JSON.stringify({ version: MMR_INTRO_RECORD_VERSION, seenAt: now().toISOString() }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}
