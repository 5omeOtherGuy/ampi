// `ampi threads …` and `ampi last`: Amp-compatible thread commands on Pi's
// session files. Sessions are listed and renamed through Pi (pi-compat.js);
// archive dates, labels, colors and the title source live in ampi's thread
// index (thread-index.js). Opening a session in the terminal UI is left to Pi:
// the commands that do it return the Pi arguments to start with.
import { randomBytes } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { parseArgs } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { listPiSessions, piAgentDir, setPiSessionName } from "./pi-compat.js";
import { formatThreadMarkdown } from "./thread-markdown.js";
import {
  isThreadColor,
  readThreadIndex,
  THREAD_COLORS,
  ThreadIndexError,
  threadIndexPath,
  updateThreadRecord,
  validateThreadLabels,
} from "./thread-index.js";

/**
 * @typedef {import("./thread-index.js").ThreadRecord} ThreadRecord
 * @typedef {import("./pi-compat.js").PiSessionInfo} PiSessionInfo
 *
 * @typedef {object} ThreadsHost
 * @property {any} pi The `@earendil-works/pi-coding-agent` module.
 * @property {string} cwd
 * @property {NodeJS.ProcessEnv} env
 * @property {() => number} now Milliseconds since the epoch.
 * @property {number} columns Width the text listing fits its titles into.
 * @property {(text: string) => void} out Writes to stdout.
 * @property {(text: string) => void} err Writes to stderr.
 * @property {(question: string) => Promise<boolean>} confirm Asks a yes/no question; true for yes.
 *
 * @typedef {{ code: number } | { piArgs: string[] }} ThreadsResult Exit with `code`, or start Pi with `piArgs`.
 * @typedef {{ code: number, message?: string } | { piArgs: string[] }} Outcome A result, with an error to print.
 */

const USAGE_HINT = "Run ampi threads --help for the thread commands.";
const UNTITLED = "untitled";
/** Columns between table columns. */
const GAP = "  ";
/** Narrowest title column the listing cuts titles to. */
const TITLE_MIN = 10;
/** C0 and C1 control characters: a title is printed to a terminal, so none may start an escape sequence. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** A complete session id as `threads new` prints it: a UUID in lowercase hex, which Pi's id rules also accept. */
const COMPLETE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The largest time a UUID version 7 holds: 48 bits of milliseconds. */
const UUID_TIME_MAX = 2 ** 48 - 1;

/** @type {Record<string, string>} */
const ALIASES = { ls: "list", l: "list", n: "new", c: "continue", md: "markdown", r: "rename" };

/** Options of each thread command; an id and other arguments are positionals. */
const OPTIONS = /** @type {const} */ ({
  // --visibility is accepted only to refuse it with a reason.
  new: { json: { type: "boolean" }, visibility: { type: "string" } },
  list: {
    all: { type: "boolean" },
    archived: { type: "boolean" },
    "include-archived": { type: "boolean" },
    json: { type: "boolean" },
    limit: { type: "string" },
  },
  continue: { last: { type: "boolean" } },
  markdown: {},
  export: {},
  rename: {},
  archive: { unarchive: { type: "boolean" } },
  unarchive: {},
  label: {},
  color: {},
  delete: { yes: { type: "boolean", short: "y" } },
});

/**
 * The text `ampi threads --help` prints.
 *
 * @returns {string}
 */
export function formatThreadsHelp() {
  return `ampi threads: create, list, read and change the sessions Pi keeps, with ampi's thread metadata

Usage: ampi threads [command] [options]
       ampi last

Commands:

  new, n                        Print the id of a new, empty session in this directory
      --json                    Print {"id", "cwd"} as JSON instead
  list, ls                      List this directory's sessions, newest first (the default command)
      --all                     List the sessions of every directory
      --archived                Include archived sessions (--include-archived works too)
      --json                    Print one JSON object per line instead of the table
      --limit <n>               Print at most n sessions
  continue, c [<id>]            Open the session in the terminal UI; without an id, pick one
      --last                    Open the most recent session, as ampi last does
  markdown, md <id>             Print the session as Markdown
  export <id>                   Print the session and its entries as JSON
  rename, r <id> <title>        Rename the session (Pi's session name)
  archive <id>                  Archive the session
      --unarchive               Take it out of the archive instead
  unarchive <id>                Take the session out of the archive
  label <id> <label...>         Add labels: lowercase letters, digits and hyphens
  color <id> <color>            Set the color: blue, purple, pink, red, orange, yellow, green,
                                cyan, gray or #rrggbb; none removes it
  delete <id>                   Delete the session file after asking for confirmation
      -y, --yes                 Delete without asking

  ampi last                     Open the most recent session of this directory that is not archived

<id> is a session id or its first characters, as the list prints it. A prefix that more
than one session shares is refused, with the matching ids.

A new session has no file until its first message. Open it with ampi threads continue <id>,
or send that message with ampi -x --session-id <id> "message". threads continue also starts a
session in this directory under any complete id no session has yet. Sessions stay on this
machine, so threads new has no --visibility: sharing one needs a hosted service.

Exit status: 0 on success, 1 when no session or several match the id or a change fails,
2 on a usage error.

Examples:

  $ ampi threads list --all --limit 5
  $ ampi threads list --json | jq -r 'select(.messageCount > 10) | .id'
  $ ampi threads continue 019a3c
  $ ampi threads markdown 019a3c > session.md
  $ ampi threads label 019a3c release docs
  $ ampi threads color 019a3c green
  $ id=$(ampi threads new) && ampi -x --session-id "$id" "summarize the README"
`;
}

/** @param {string} message @returns {{ code: number, message: string }} */
function usage(message) {
  return { code: 2, message };
}

/**
 * A session's title on one line without control characters: its name, else
 * its first message, else "untitled".
 *
 * @param {PiSessionInfo} session
 */
export function threadTitle(session) {
  /** @param {string} text */
  const clean = (text) => text.replace(/\s+/g, " ").replace(CONTROL, "").trim();
  return clean(session.name ?? "") || clean(session.firstMessage) || UNTITLED;
}

/**
 * How long ago `then` was, as "now", "51m ago", "3h ago", "2d ago", "4mo ago"
 * or "1y ago" (the Switch Thread picker's words).
 *
 * @param {Date} then
 * @param {number} now
 */
export function formatRelativeTime(then, now) {
  const minutes = Math.floor(Math.max(0, now - then.getTime()) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/**
 * A new session id in the form Pi gives its sessions, a UUID version 7: the
 * time in milliseconds in the first 48 bits, so ids sort by creation time,
 * then the version and variant bits, and random bits for the rest.
 *
 * @param {number} time Milliseconds since the epoch.
 * @param {Uint8Array} [random] 10 random bytes; the version and variant bits overwrite part of them.
 * @returns {string}
 */
export function createSessionId(time, random = randomBytes(10)) {
  if (!Number.isInteger(time) || time < 0 || time > UUID_TIME_MAX) throw new RangeError(`a session id cannot hold the time ${time}.`);
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(time, 0, 6);
  bytes.set(random.subarray(0, 10), 6);
  bytes[6] = 0x70 | (bytes[6] & 0x0f);
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** @param {ThreadsHost} host */
const indexFileOf = (host) => threadIndexPath(piAgentDir(host.pi));

/**
 * One record per session id (the most recently active one), newest first.
 *
 * @param {ThreadsHost} host
 * @param {"workspace" | "all"} scope
 * @returns {Promise<PiSessionInfo[]>}
 */
async function listSessions(host, scope) {
  const sessions = await listPiSessions(host.pi, { cwd: host.cwd, env: host.env, scope });
  /** @type {Map<string, PiSessionInfo>} */
  const byId = new Map();
  for (const session of sessions) {
    const known = byId.get(session.id);
    if (!known || session.modified.getTime() > known.modified.getTime()) byId.set(session.id, session);
  }
  return [...byId.values()].sort((a, b) => b.modified.getTime() - a.modified.getTime() || a.id.localeCompare(b.id));
}

/**
 * Find a session by exact id or id prefix (a leading `@` is ignored), across
 * every directory. An exact id wins; a prefix several sessions share is
 * refused with their ids.
 *
 * @param {ThreadsHost} host
 * @param {string} query
 * @returns {Promise<{ session: PiSessionInfo } | { code: number, message: string, missing?: string }>} `missing`
 *   is the id when no session matches it.
 */
async function resolveSession(host, query) {
  const id = query.trim().replace(/^@/, "");
  if (!id) return usage("a session id is empty.");
  const sessions = await listSessions(host, "all");
  const exact = sessions.find((session) => session.id === id);
  if (exact) return { session: exact };
  const matches = sessions.filter((session) => session.id.startsWith(id));
  if (matches.length === 1) return { session: matches[0] };
  if (matches.length === 0) return { code: 1, message: `no session has an id starting with ${id}.`, missing: id };
  const candidates = matches.map((session) => `  ${session.id}  ${threadTitle(session)}`).join("\n");
  return { code: 1, message: `${id} matches ${matches.length} sessions; give more of the id:\n${candidates}` };
}

/**
 * The thread index, or an empty one with a warning when it cannot be read:
 * listings still work.
 *
 * @param {ThreadsHost} host
 * @returns {Record<string, ThreadRecord>}
 */
function readIndexForListing(host) {
  try {
    return readThreadIndex(indexFileOf(host));
  } catch (error) {
    host.err(`ampi: ${error instanceof Error ? error.message : String(error)} Archive dates and labels are left out.\n`);
    return {};
  }
}

/** @param {Record<string, ThreadRecord>} threads @param {string} id */
const recordOf = (threads, id) => (Object.hasOwn(threads, id) ? threads[id] : undefined);

/**
 * A session's metadata, as `threads list --json` and `threads export` print it.
 *
 * @param {PiSessionInfo} session
 * @param {ThreadRecord | undefined} record
 */
export function describeSession(session, record) {
  return {
    id: session.id,
    title: threadTitle(session),
    ...(session.name?.trim() ? { name: session.name.trim() } : {}),
    created: session.created.toISOString(),
    updated: session.modified.toISOString(),
    messageCount: session.messageCount,
    cwd: session.cwd,
    path: session.path,
    ...(session.parentSessionPath ? { parentSessionPath: session.parentSessionPath } : {}),
    ...(record?.archived !== undefined ? { archived: record.archived } : {}),
    ...(record?.labels?.length ? { labels: record.labels } : {}),
    ...(record?.color !== undefined ? { color: record.color } : {}),
    ...(record?.pinned !== undefined ? { pinned: record.pinned } : {}),
  };
}

/**
 * `text` cut to `width` terminal columns, whole characters only, with an
 * ellipsis when anything was cut.
 *
 * @param {string} text
 * @param {number} width
 */
function cut(text, width) {
  if (visibleWidth(text) <= width) return text;
  let kept = "";
  let used = 0;
  for (const { segment } of GRAPHEMES.segment(text)) {
    used += visibleWidth(segment);
    if (used > width - 1) break;
    kept += segment;
  }
  return `${kept.trimEnd()}…`;
}

/** @param {string} text @param {number} width */
const padEnd = (text, width) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));

/**
 * The listing as a table: id, title, time since the last activity, message
 * count and, with archived sessions included, an archived marker. Titles are
 * cut to fit `columns`.
 *
 * @param {PiSessionInfo[]} sessions
 * @param {Record<string, ThreadRecord>} threads
 * @param {{ now: number, columns: number, archivedColumn: boolean }} options
 * @returns {string}
 */
export function formatThreadTable(sessions, threads, { now, columns, archivedColumn }) {
  const rows = sessions.map((session) => [
    session.id,
    threadTitle(session),
    formatRelativeTime(session.modified, now),
    String(session.messageCount),
    recordOf(threads, session.id)?.archived !== undefined ? "archived" : "",
  ]);
  const header = ["ID", "Title", "Updated", "Messages", "Archived"];
  const count = archivedColumn ? 5 : 4;
  const widths = header.slice(0, count).map((name, column) => Math.max(visibleWidth(name), ...rows.map((row) => visibleWidth(row[column]))));
  const others = widths.reduce((sum, width, column) => (column === 1 ? sum : sum + width), 0) + GAP.length * (count - 1);
  widths[1] = Math.min(widths[1], Math.max(TITLE_MIN, columns - others));
  /** @param {string[]} cells */
  const line = (cells) =>
    cells
      .slice(0, count)
      .map((cell, column) => (column === 3 ? cell.padStart(widths[column]) : padEnd(cut(cell, widths[column]), widths[column])))
      .join(GAP)
      .trimEnd();
  return `${[line(header), widths.map((width) => "─".repeat(width)).join(GAP), ...rows.map(line)].join("\n")}\n`;
}

/** @param {unknown} error */
const messageOf = (error) => (error instanceof Error ? error.message : String(error));

/**
 * The entries of a session file in file order, its header first. Lines that
 * are not JSON are skipped, as Pi skips them.
 *
 * @param {string} file
 * @returns {unknown[]}
 */
function readEntries(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

/**
 * Run `ampi threads …` or `ampi last`.
 *
 * @param {readonly string[]} argv The command line from `threads` or `last` on.
 * @param {ThreadsHost} host
 * @returns {Promise<ThreadsResult>}
 */
export async function runThreadsCommand(argv, host) {
  const result = await dispatch(argv, host);
  if ("code" in result && result.message !== undefined) {
    host.err(`ampi: ${result.message}\n${result.code === 2 ? `${USAGE_HINT}\n` : ""}`);
    return { code: result.code };
  }
  return result;
}

/**
 * @param {readonly string[]} argv
 * @param {ThreadsHost} host
 * @returns {Promise<Outcome>}
 */
async function dispatch(argv, host) {
  const [command, ...rest] = argv;
  if (rest.includes("--help") || rest.includes("-h") || rest[0] === "help") {
    host.out(formatThreadsHelp());
    return { code: 0 };
  }
  if (command === "last") {
    if (rest.length > 0) return usage(`last takes no arguments, not ${rest[0]}.`);
    return continueLast(host);
  }
  // `ampi threads` and `ampi threads --json` list, as `ampi threads list` does.
  const implicitList = rest.length === 0 || rest[0].startsWith("-");
  const named = implicitList ? "list" : rest[0];
  const args = implicitList ? rest : rest.slice(1);
  const sub = ALIASES[named] ?? named;
  if (!Object.hasOwn(OPTIONS, sub)) return usage(`unknown thread command ${named}.`);
  /** @type {{ values: Record<string, string | boolean | undefined>, positionals: string[] }} */
  let parsed;
  try {
    /** @type {import("node:util").ParseArgsOptionsConfig} */
    const options = OPTIONS[/** @type {keyof typeof OPTIONS} */ (sub)];
    parsed = /** @type {any} */ (parseArgs({ args: [...args], options, allowPositionals: true, strict: true }));
  } catch (error) {
    return usage(`threads ${sub}: ${messageOf(error)}`);
  }
  const { values, positionals } = parsed;
  switch (sub) {
    case "new":
      return create(host, values, positionals);
    case "list":
      return list(host, values, positionals);
    case "continue":
      if (values.last) return positionals.length === 0 ? continueLast(host) : usage("threads continue --last takes no id.");
      if (positionals.length === 0) return { piArgs: ["--resume"] };
      if (positionals.length > 1) return usage("threads continue takes one session id.");
      return continueSession(host, positionals[0]);
    case "markdown":
    case "export":
      if (positionals.length !== 1) return usage(`threads ${sub} takes one session id.`);
      return withSession(host, positionals[0], (session) => {
        const entries = readEntries(session.path);
        if (sub === "markdown") host.out(formatThreadMarkdown(entries));
        else {
          const record = recordOf(readIndexForListing(host), session.id);
          host.out(`${JSON.stringify({ ...describeSession(session, record), entries }, null, 2)}\n`);
        }
        return { code: 0 };
      });
    case "rename":
      return rename(host, positionals);
    case "archive":
    case "unarchive":
      if (positionals.length !== 1) return usage(`threads ${sub} takes one session id.`);
      return archive(host, positionals[0], sub === "archive" && !values.unarchive);
    case "label":
      return label(host, positionals);
    case "color":
      return color(host, positionals);
    default: // delete
      if (positionals.length !== 1) return usage("threads delete takes one session id.");
      return remove(host, positionals[0], values.yes === true);
  }
}

/**
 * @param {ThreadsHost} host
 * @param {string} query
 * @param {(session: PiSessionInfo) => ThreadsResult | Promise<Outcome>} action
 * @returns {Promise<Outcome>}
 */
async function withSession(host, query, action) {
  const resolved = await resolveSession(host, query);
  if (!("session" in resolved)) return resolved;
  try {
    return await action(resolved.session);
  } catch (error) {
    return { code: 1, message: messageOf(error) };
  }
}

/**
 * Print the id of a new session. Nothing is written: Pi creates the session
 * file with the first message sent under the id.
 *
 * @param {ThreadsHost} host
 * @param {Record<string, string | boolean | undefined>} values
 * @param {string[]} positionals
 * @returns {Outcome}
 */
function create(host, values, positionals) {
  if (values.visibility !== undefined) {
    return usage("threads new has no --visibility: sessions stay on this machine, and sharing one needs a hosted service.");
  }
  if (positionals.length > 0) return usage(`threads new takes no arguments, not ${positionals[0]}.`);
  const id = createSessionId(host.now());
  host.out(values.json ? `${JSON.stringify({ id, cwd: host.cwd })}\n` : `${id}\n`);
  return { code: 0 };
}

/**
 * Open the session an id or prefix names. A complete id that no session has
 * starts a new session under it in this directory, through Pi's
 * `--session-id`.
 *
 * @param {ThreadsHost} host
 * @param {string} query
 * @returns {Promise<Outcome>}
 */
async function continueSession(host, query) {
  const resolved = await resolveSession(host, query);
  if ("session" in resolved) return { piArgs: ["--session", resolved.session.path] };
  if (resolved.missing === undefined || !COMPLETE_ID.test(resolved.missing)) return resolved;
  host.err(`ampi: no session has the id ${resolved.missing}; a new session starts under it in this directory.\n`);
  return { piArgs: ["--session-id", resolved.missing] };
}

/**
 * @param {ThreadsHost} host
 * @param {Record<string, string | boolean | undefined>} values
 * @param {string[]} positionals
 * @returns {Promise<Outcome>}
 */
async function list(host, values, positionals) {
  if (positionals.length > 0) return usage(`threads list takes no arguments, not ${positionals[0]}.`);
  /** @type {number | undefined} */
  let limit;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!/^\d+$/.test(String(values.limit)) || limit < 1) return usage(`--limit needs a whole number above 0, not ${values.limit}.`);
  }
  const includeArchived = values.archived === true || values["include-archived"] === true;
  const threads = readIndexForListing(host);
  const sessions = (await listSessions(host, values.all ? "all" : "workspace"))
    .filter((session) => includeArchived || recordOf(threads, session.id)?.archived === undefined)
    .slice(0, limit);
  if (values.json) {
    for (const session of sessions) host.out(`${JSON.stringify(describeSession(session, recordOf(threads, session.id)))}\n`);
  } else if (sessions.length === 0) {
    host.out(values.all ? "No sessions.\n" : "No sessions in this directory. ampi threads list --all lists every directory.\n");
  } else {
    host.out(formatThreadTable(sessions, threads, { now: host.now(), columns: host.columns, archivedColumn: includeArchived }));
  }
  return { code: 0 };
}

/**
 * The most recent session of this directory that is not archived.
 *
 * @param {ThreadsHost} host
 * @returns {Promise<Outcome>}
 */
async function continueLast(host) {
  const threads = readIndexForListing(host);
  const session = (await listSessions(host, "workspace")).find((info) => recordOf(threads, info.id)?.archived === undefined);
  if (!session) return { code: 1, message: "no session to continue in this directory (archived sessions are skipped)." };
  return { piArgs: ["--session", session.path] };
}

/**
 * @param {ThreadsHost} host
 * @param {string[]} positionals
 * @returns {Promise<Outcome>}
 */
async function rename(host, [query, ...words]) {
  const title = words.join(" ").replace(/\s+/g, " ").trim();
  if (query === undefined || !title) return usage("threads rename takes a session id and a title.");
  return withSession(host, query, (session) => {
    setPiSessionName(host.pi, session.path, title);
    try {
      // As --title does: the title is the user's, not one to generate.
      updateThreadRecord(indexFileOf(host), session.id, { titleSource: "user" });
    } catch (error) {
      host.err(`ampi: the session was renamed, but the thread index was not updated: ${messageOf(error)}\n`);
    }
    host.out(`Renamed ${session.id} to "${title}".\n`);
    return { code: 0 };
  });
}

/**
 * @param {ThreadsHost} host
 * @param {string} query
 * @param {boolean} archived Archive, or take out of the archive.
 * @returns {Promise<Outcome>}
 */
async function archive(host, query, archived) {
  return withSession(host, query, (session) => {
    const file = indexFileOf(host);
    const isArchived = recordOf(readThreadIndex(file), session.id)?.archived !== undefined;
    if (isArchived === archived) {
      host.out(`${session.id} is ${archived ? "already" : "not"} archived.\n`);
      return { code: 0 };
    }
    updateThreadRecord(file, session.id, { archived: archived ? new Date(host.now()).toISOString() : null });
    host.out(`${archived ? "Archived" : "Unarchived"} ${session.id} (${threadTitle(session)}).\n`);
    return { code: 0 };
  });
}

/**
 * @param {ThreadsHost} host
 * @param {string[]} positionals
 * @returns {Promise<Outcome>}
 */
async function label(host, [query, ...labels]) {
  if (query === undefined || labels.length === 0) return usage("threads label takes a session id and at least one label.");
  try {
    validateThreadLabels(labels);
  } catch (error) {
    if (error instanceof ThreadIndexError) return usage(error.message);
    throw error;
  }
  return withSession(host, query, (session) => {
    const file = indexFileOf(host);
    const merged = validateThreadLabels([...(recordOf(readThreadIndex(file), session.id)?.labels ?? []), ...labels]);
    updateThreadRecord(file, session.id, { labels: merged });
    host.out(`Labels of ${session.id}: ${merged.join(", ")}.\n`);
    return { code: 0 };
  });
}

/**
 * Set or, with `none`, remove a session's color. Names and hex colors are
 * stored in lowercase.
 *
 * @param {ThreadsHost} host
 * @param {string[]} positionals
 * @returns {Promise<Outcome>}
 */
async function color(host, positionals) {
  if (positionals.length !== 2) return usage("threads color takes a session id and a color.");
  const [query, given] = positionals;
  const value = given.trim().toLowerCase();
  if (value !== "none" && !isThreadColor(value)) {
    return usage(`${JSON.stringify(given)} is not a thread color: use ${THREAD_COLORS.join(", ")}, #rrggbb, or none to remove it.`);
  }
  return withSession(host, query, (session) => {
    updateThreadRecord(indexFileOf(host), session.id, { color: value === "none" ? null : value });
    host.out(`Color of ${session.id}: ${value}.\n`);
    return { code: 0 };
  });
}

/**
 * @param {ThreadsHost} host
 * @param {string} query
 * @param {boolean} yes Delete without asking.
 * @returns {Promise<Outcome>}
 */
async function remove(host, query, yes) {
  return withSession(host, query, async (session) => {
    // Pi tells the commands its shell tools run which session they run in.
    if (session.id === host.env.PI_SESSION_ID) {
      return { code: 1, message: `${session.id} is the session this command runs in; it cannot delete itself.` };
    }
    if (!yes && !(await host.confirm(`Delete session ${session.id} (${threadTitle(session)})? [y/N] `))) {
      return { code: 1, message: "nothing was deleted." };
    }
    unlinkSync(session.path);
    const file = indexFileOf(host);
    try {
      if (recordOf(readThreadIndex(file), session.id) !== undefined) updateThreadRecord(file, session.id, null);
    } catch (error) {
      host.err(`ampi: the session was deleted, but its thread metadata was not: ${messageOf(error)}\n`);
    }
    host.out(`Deleted ${session.id} (${threadTitle(session)}).\n`);
    return { code: 0 };
  });
}
