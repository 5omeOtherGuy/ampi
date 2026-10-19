// The record of past imports: which Pi session each imported conversation
// became, so `ampi threads import` skips it next time. Kept in Pi's
// configuration directory next to the thread index, and written the same way:
// through a temporary file, so a reader never sees half a file.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * @typedef {object} ImportRecord One imported conversation.
 * @property {string} sessionId The Pi session it became.
 * @property {string} sessionPath The Pi session file.
 * @property {string} importedAt ISO 8601.
 * @property {string} sourceModified When the conversation was last changed in its agent, ISO 8601.
 */

const LEDGER_VERSION = 1;

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `<agentDir>/data/ampi/imports.json`.
 *
 * @param {string} agentDir Pi's configuration directory.
 * @returns {string}
 */
export function importLedgerPath(agentDir) {
  return path.join(agentDir, "data", "ampi", "imports.json");
}

/**
 * The key of a conversation in the ledger.
 *
 * @param {string} agent
 * @param {string} sourceId
 */
export const importKey = (agent, sourceId) => `${agent}:${sourceId}`;

/**
 * Every import record, keyed by `<agent>:<source id>`. A missing file is an
 * empty ledger; a file that is not a version 1 ledger is refused, so imports
 * never overwrite records they cannot read.
 *
 * @param {string} file
 * @returns {Record<string, ImportRecord>}
 */
export function readImportLedger(file) {
  /** @type {string} */
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return Object.create(null);
    throw error;
  }
  /** @type {unknown} */
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    document = undefined;
  }
  if (isObject(document) && typeof document.version === "number" && document.version > LEDGER_VERSION) {
    throw new Error(`${file} has version ${document.version}, written by a newer ampi; update ampi-cli to import.`);
  }
  if (!isObject(document) || document.version !== LEDGER_VERSION || !isObject(document.imports)) {
    throw new Error(`${file} is not an import record ampi can read; move it aside to import again.`);
  }
  /** @type {Record<string, ImportRecord>} No prototype, so a key such as `constructor` finds no inherited value. */
  const imports = Object.create(null);
  for (const [key, record] of Object.entries(document.imports)) {
    if (isObject(record) && typeof record.sessionId === "string" && typeof record.sessionPath === "string") imports[key] = /** @type {ImportRecord} */ (record);
  }
  return imports;
}

/**
 * Write the ledger through a temporary file.
 *
 * @param {string} file
 * @param {Record<string, ImportRecord>} imports
 */
export function writeImportLedger(file, imports) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: LEDGER_VERSION, imports }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temporary, file);
}
