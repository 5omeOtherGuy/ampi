// OpenCode's sessions, read for `ampi threads import opencode` and converted
// into Pi messages. OpenCode keeps them in its data directory: current
// versions in the SQLite database `opencode.db` (the tables `session`,
// `message` and `part`, the last two holding each row's fields as JSON in
// `data`), older ones as JSON files in `storage/session/<project>/<id>.json`,
// `storage/message/<session>/<id>.json` and `storage/part/<message>/<id>.json`.
// A session has a directory and a title; its messages have a role, and an
// assistant message its model and tokens; a message's parts are its text,
// reasoning, tool calls with their state, files and bookkeeping.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { IMPORT_API, importedUsage, isObject, tokenCount, userContent } from "./messages.js";

/**
 * @typedef {import("./messages.js").SourceSession} SourceSession
 * @typedef {import("./messages.js").Conversion} Conversion
 * @typedef {{ directory?: unknown, title?: unknown }} OpenCodeSession
 * @typedef {{ info: Record<string, any>, parts: Record<string, any>[] }} OpenCodeMessage A message with its parts, in order.
 * @typedef {object} OpenCodeSource The sessions in one data directory.
 * @property {SourceSession[]} sessions
 * @property {(source: SourceSession) => Conversion} convert
 * @property {() => void} close
 */

export const OPENCODE_AGENT = "opencode";
const IMPORT_PROVIDER = "opencode-import";
const DATABASE = "opencode.db";
/** The Node.js release from which ampi-cli runs, which includes `node:sqlite`. */
const SQLITE_NODE = "22.19";

/** OpenCode's session ids: `ses_` and letters or digits. */
export const OPENCODE_SESSION_ID = /^ses_[A-Za-z0-9]+$/;
/** The titles OpenCode gives a session before it has one of its own. */
const PLACEHOLDER_TITLE = /^(?:New|Child) session - \d{4}-\d\d-\d\dT/;

/**
 * OpenCode's data directory: `$XDG_DATA_HOME/opencode`, else
 * `~/.local/share/opencode`.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 */
export function openCodeDir(env, home) {
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "opencode");
}

/**
 * Load `node:sqlite` without letting its experimental warning reach the
 * terminal, or explain which Node.js version has it.
 *
 * @param {() => Promise<any>} [load] Imports the module; tests replace it.
 * @returns {Promise<any>}
 */
export async function loadNodeSqlite(load = () => import("node:sqlite")) {
  const emitWarning = process.emitWarning;
  /** @type {any} */
  const quiet = (/** @type {any} */ warning, /** @type {any[]} */ ...rest) => {
    const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
    if (type === "ExperimentalWarning" && String(warning).startsWith("SQLite")) return;
    return emitWarning.call(process, warning, ...rest);
  };
  process.emitWarning = quiet;
  try {
    return await load();
  } catch (error) {
    const [major, minor] = process.versions.node.split(".").map(Number);
    const [needMajor, needMinor] = SQLITE_NODE.split(".").map(Number);
    const tooOld = major < needMajor || (major === needMajor && minor < needMinor);
    if (tooOld || /** @type {any} */ (error)?.code === "ERR_UNKNOWN_BUILTIN_MODULE") {
      throw new Error(`reading OpenCode's database needs Node.js ${SQLITE_NODE} or later, which includes node:sqlite; this is Node.js ${process.version}.`);
    }
    throw new Error(`cannot load node:sqlite to read OpenCode's database: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    process.emitWarning = emitWarning;
  }
}

/** @param {string} text @param {string} file */
function parseJson(text, file) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
}

/** @param {string} dir @returns {string[]} The names in `dir`, sorted; none when it is missing. */
function namesIn(dir) {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/**
 * The sessions of OpenCode's database, read-only.
 *
 * @param {any} sqlite The `node:sqlite` module.
 * @param {string} file
 */
function openDatabase(sqlite, file) {
  /** @type {any} */
  let db;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true });
    // The tables of OpenCode's released versions. Its development branch
    // renames `session` to `session_v2` and keeps messages in
    // `session_message`; once a release ships that, these queries fail with
    // "no such table" and need to read the new tables too.
    const rows = db.prepare("SELECT id, directory, title, parent_id, time_updated FROM session").all();
    const sessions = new Map();
    for (const row of rows) {
      if (typeof row.id !== "string" || !OPENCODE_SESSION_ID.test(row.id)) continue;
      sessions.set(row.id, { id: row.id, file, modified: new Date(Number(row.time_updated)), ...(row.parent_id ? { subagent: true } : {}), session: row });
    }
    const messageRows = db.prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id");
    const partRows = db.prepare("SELECT message_id, data FROM part WHERE session_id = ? ORDER BY message_id, id");
    /** @param {string} id @returns {OpenCodeMessage[]} */
    const messages = (id) => {
      /** @type {Map<string, Record<string, any>[]>} */
      const parts = new Map();
      for (const row of partRows.all(id)) {
        const list = parts.get(row.message_id) ?? [];
        list.push(parseJson(row.data, `${file} (part of message ${row.message_id})`));
        parts.set(row.message_id, list);
      }
      return messageRows.all(id).map((/** @type {any} */ row) => ({ info: parseJson(row.data, `${file} (message ${row.id})`), parts: parts.get(row.id) ?? [] }));
    };
    return { sessions, messages, close: () => db.close() };
  } catch (error) {
    db?.close();
    throw new Error(`cannot read OpenCode's database ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The sessions of OpenCode's older JSON storage.
 *
 * @param {string} storage
 */
function readStorage(storage) {
  const sessions = new Map();
  for (const project of namesIn(path.join(storage, "session"))) {
    for (const name of namesIn(path.join(storage, "session", project))) {
      const id = name.slice(0, -".json".length);
      if (!name.endsWith(".json") || !OPENCODE_SESSION_ID.test(id)) continue;
      const file = path.join(storage, "session", project, name);
      const stats = statSync(file, { throwIfNoEntry: false });
      if (!stats?.isFile()) continue;
      /** @type {unknown} */
      let session;
      try {
        session = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      if (!isObject(session)) continue;
      const updated = isObject(session.time) && typeof session.time.updated === "number" ? new Date(session.time.updated) : stats.mtime;
      sessions.set(id, { id, file, modified: updated, ...(session.parentID ? { subagent: true } : {}), session });
    }
  }
  /** @param {string} folder @returns {Record<string, any>[]} */
  const objectsIn = (folder) =>
    namesIn(folder)
      .filter((name) => name.endsWith(".json"))
      .map((name) => parseJson(readFileSync(path.join(folder, name), "utf8"), path.join(folder, name)))
      .filter(isObject);
  /** @param {string} id @returns {OpenCodeMessage[]} */
  const messages = (id) =>
    objectsIn(path.join(storage, "message", id))
      .filter((info) => typeof info.id === "string" && /^[A-Za-z0-9_]+$/.test(info.id))
      .sort((a, b) => (Number(a.time?.created) || 0) - (Number(b.time?.created) || 0) || String(a.id).localeCompare(String(b.id)))
      .map((info) => ({ info, parts: objectsIn(path.join(storage, "part", info.id)).sort((a, b) => String(a.id).localeCompare(String(b.id))) }));
  return { sessions, messages };
}

/**
 * Open OpenCode's data directory: its database when there is one, and its
 * older JSON storage, where a session the database also has is left out.
 *
 * @param {string} dir OpenCode's data directory.
 * @param {() => Promise<any>} [loadSqlite] Imports `node:sqlite`; tests replace it.
 * @returns {Promise<OpenCodeSource>}
 */
export async function openOpenCode(dir, loadSqlite) {
  const storage = readStorage(path.join(dir, "storage"));
  const databaseFile = path.join(dir, DATABASE);
  const database = statSync(databaseFile, { throwIfNoEntry: false })?.isFile() ? openDatabase(await loadNodeSqlite(loadSqlite), databaseFile) : undefined;
  const all = new Map([...storage.sessions, ...(database?.sessions ?? [])]);
  return {
    sessions: [...all.values()].map(({ session, ...source }) => source),
    convert: (source) => {
      const fromDatabase = database?.sessions.has(source.id) === true;
      const reader = fromDatabase ? /** @type {NonNullable<typeof database>} */ (database) : storage;
      return convertOpenCodeSession(all.get(source.id).session, reader.messages(source.id));
    },
    close: () => database?.close(),
  };
}

/**
 * The text a file part becomes.
 *
 * @param {Record<string, any>} part
 */
function fileText(part) {
  const where = isObject(part.source) && typeof part.source.path === "string" ? part.source.path : typeof part.filename === "string" ? part.filename : "";
  return { type: "text", text: where ? `(file ${where})` : "(file)" };
}

/**
 * Pi's usage from an OpenCode assistant message's tokens. OpenCode counts
 * reasoning apart from the output; Pi's output includes it.
 *
 * @param {unknown} tokens
 */
function convertUsage(tokens) {
  const source = isObject(tokens) ? tokens : {};
  const cache = isObject(source.cache) ? source.cache : {};
  return importedUsage({ input: tokenCount(source.input), output: tokenCount(source.output) + tokenCount(source.reasoning), cacheRead: tokenCount(cache.read), cacheWrite: tokenCount(cache.write) });
}

/**
 * Convert an OpenCode session's messages into Pi messages, in order. Text
 * parts become text and reasoning parts thinking; text OpenCode added itself
 * (synthetic or ignored parts) is left out. A file part becomes the text
 * "(file <path>)". A tool part becomes a tool call in the assistant message
 * and a tool result after it, an error when the tool failed, and the error
 * "(interrupted)" when the session stopped before the tool finished; text
 * after a tool part starts a new assistant message, so each result follows
 * its call.
 * The message's tokens go to its last part. Other parts are bookkeeping.
 *
 * @param {OpenCodeSession} session
 * @param {OpenCodeMessage[]} messages
 * @returns {Conversion}
 */
export function convertOpenCodeSession(session, messages) {
  /** @type {any[]} */
  const converted = [];
  let time = 0;
  for (const { info, parts } of messages) {
    if (typeof info.time?.created === "number") time = info.time.created;
    const said = (/** @type {any} */ part) => part.type === "text" && typeof part.text === "string" && part.synthetic !== true && part.ignored !== true;
    if (info.role === "user") {
      const content = parts.flatMap((part) => (said(part) ? [{ type: "text", text: part.text }] : part.type === "file" ? [fileText(part)] : []));
      if (content.length > 0) converted.push({ role: "user", content: userContent(content), timestamp: time });
      continue;
    }
    if (info.role !== "assistant") continue;
    const model = typeof info.modelID === "string" ? info.modelID : "unknown";
    /** @type {any} */
    let open;
    /** @type {object[]} */
    let results = [];
    const flush = () => {
      if (open !== undefined) converted.push(open, ...results);
      open = undefined;
      results = [];
    };
    /** @param {object} block A tool call joins the calls before it; anything else after a call starts a new message. */
    const add = (block) => {
      const call = /** @type {any} */ (block).type === "toolCall";
      if (!call && results.length > 0) flush();
      open ??= { role: "assistant", content: [], api: IMPORT_API, provider: IMPORT_PROVIDER, model, timestamp: time, usage: importedUsage(), stopReason: "stop" };
      open.content.push(block);
      if (call) open.stopReason = "toolUse";
    };
    for (const part of parts) {
      if (said(part)) add({ type: "text", text: part.text });
      else if (part.type === "reasoning" && typeof part.text === "string" && part.text) add({ type: "thinking", thinking: part.text });
      else if (part.type === "file") add(fileText(part));
      else if (part.type === "tool" && typeof part.callID === "string" && typeof part.tool === "string") {
        const state = isObject(part.state) ? part.state : {};
        const failed = state.status !== "completed";
        const output = state.status === "error" ? state.error : state.status === "completed" ? state.output : "(interrupted)";
        add({ type: "toolCall", id: part.callID, name: part.tool, arguments: isObject(state.input) ? state.input : {} });
        results.push({
          role: "toolResult",
          toolCallId: part.callID,
          toolName: part.tool,
          content: typeof output === "string" && output ? [{ type: "text", text: output }] : [],
          isError: failed,
          timestamp: time,
        });
      }
    }
    const last = open;
    flush();
    if (last !== undefined) last.usage = convertUsage(info.tokens);
  }
  const title = typeof session.title === "string" && !PLACEHOLDER_TITLE.test(session.title) ? session.title.trim() || undefined : undefined;
  return { cwd: typeof session.directory === "string" && session.directory ? session.directory : undefined, title, started: converted[0]?.timestamp, messages: converted };
}
