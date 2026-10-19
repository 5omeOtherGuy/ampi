// `ampi threads …`, `ampi last` and `ampi usage`: Amp-compatible thread commands on Pi's
// session files. Sessions are listed and renamed through Pi (pi-compat.js);
// archive dates, labels, colors and the title source live in ampi's thread
// index (thread-index.js). Opening a session in the terminal UI is left to Pi:
// the commands that do it return the Pi arguments to start with.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { runImportCommand } from "./import/index.js";
import { findLiveOwner, liveRegistryDir } from "./live-registry.js";
import { createPiModelLookup, listPiSessions, loadThroughPi, piAgentDir, readPiSessionEntries, setPiSessionName } from "./pi-compat.js";
import {
  isThreadColor,
  readThreadIndex,
  THREAD_COLORS,
  ThreadIndexError,
  threadIndexPath,
  updateThreadRecord,
  validateThreadLabels,
} from "./thread-index.js";
import { formatThreadMarkdown } from "./thread-markdown.js";

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
 * @property {import("./log.js").Logger} log For the command's diagnostics.
 * @property {(question: string) => Promise<boolean>} confirm Asks a yes/no question; true for yes.
 * @property {() => Promise<{ root: string, version?: string } | undefined>} locateAmpi The ampi package
 *   whose search `threads search` runs: the one Pi loads from its settings, else the CLI's own.
 * @property {string} [registryDir] The live registry, which says what other processes have a session
 *   open; defaults to the one in Pi's agent directory.
 * @property {(pid: number) => boolean} [isAlive] Whether a process runs; defaults to a signal-0 probe.
 * @property {(pid: number) => number | null} [procStart] A process's start time; defaults to /proc/<pid>/stat.
 * @property {() => Promise<any>} [loadSqlite] Imports `node:sqlite` for `threads import opencode`; tests replace it.
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
const ALIASES = { ls: "list", l: "list", n: "new", c: "continue", md: "markdown", r: "rename", find: "search", "analyze-context": "context" };

/**
 * The file in the ampi package whose extension factory hands over the session
 * search and the reports, and the event it uses (`MMR_CLI_THREADS_EVENT` there).
 */
const CLI_THREADS_ENTRY = path.join("src", "cli-threads.ts");
const CLI_THREADS_EVENT = "ampi:cli-threads";
const SEARCH_LIMIT = 20;
/** Days `ampi usage` covers without --start. */
const USAGE_DAYS = 30;
/** Sessions `ampi usage --details` lists. */
const USAGE_TOP_SESSIONS = 10;
/** The thread index label of sessions imported from elsewhere, whose costs are unknown. */
const IMPORTED_LABEL = "imported";
/** An ISO 8601 date, or a date and time with an optional offset. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * Whether the `YYYY-MM-DD` that starts `text` is a day of the calendar:
 * `Date.parse` takes 2026-02-30 for 2 March.
 *
 * @param {string} text
 */
function isCalendarDate(text) {
  const [year, month, day] = text.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

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
  search: { json: { type: "boolean" }, limit: { type: "string", short: "n" } },
  context: {},
  usage: { details: { type: "boolean" }, start: { type: "string" }, end: { type: "string" }, json: { type: "boolean" } },
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
  search, find <query...>       Search the sessions of every directory, latest update first
      -n, --limit <n>           Print at most n sessions (default 20)
      --json                    Print one JSON object per line instead of the table
  continue, c [<id>]            Open the session in the terminal UI; without an id, pick one
      --last                    Open the most recent session, as ampi last does
  markdown, md <id>             Print the session as Markdown
  export <id>                   Print the session and its entries as JSON
  context, analyze-context <id> Print what fills the session's context window, as JSON
  usage <id>                    Print the session's cost
      --details                 Add tokens and cost per model, and tool calls per tool
      --start <time>            Count only what happened at or after this ISO 8601 time
      --end <time>              Count only what happened before this ISO 8601 time
      --json                    Print JSON instead
  rename, r <id> <title>        Rename the session (Pi's session name)
  archive <id>                  Archive the session
      --unarchive               Take it out of the archive instead
  unarchive <id>                Take the session out of the archive
  label <id> <label...>         Add labels: lowercase letters, digits and hyphens
  color <id> <color>            Set the color: blue, purple, pink, red, orange, yellow, green,
                                cyan, gray or #rrggbb; none removes it
  delete <id>                   Delete the session file after asking for confirmation
      -y, --yes                 Delete without asking
  import [command]              Copy Claude Code, Codex and OpenCode conversations on this machine
                                into read-only sessions; ampi threads import --help has the options

  ampi last                     Open the most recent session of this directory that is not archived
  ampi usage                    Print the cost and tokens of every session of the last 30 days
      --details                 Add tokens and cost per model, and the ten most expensive sessions
      --start <time>            Count from this time on (default: 30 days before --end)
      --end <time>              Count up to, not including, this time (default: now)
      --json                    Print JSON instead

A search query is words and "quoted phrases", all of which a session must contain, and
key:value filters, all of which it must pass: id:, parent:, name:, label:, pinned:true|false,
archived:true|false, after:, before:, updated_before:, created_after:, created_before:, cwd:,
project:, repo:, file:, model:, provider:, tool: and has:tools|errors. Dates are YYYY-MM-DD,
today, yesterday, week, month, or a number of days or weeks such as 7d or 2w. Matching ignores
case, and archived sessions are included unless archived:false says otherwise.

<id> is a session id or its first characters, as the list prints it. A prefix that more
than one session shares is refused, with the matching ids.

A new session has no file until its first message. Open it with ampi threads continue <id>,
or send that message with ampi -x --session-id <id> "message". threads continue also starts a
session in this directory under any complete id no session has yet. Sessions stay on this
machine, so threads new has no --visibility: sharing one needs a hosted service.

context counts tokens at four characters to a token, from the system prompt and tools Pi
recorded in the session and the messages it would send now. Costs are what the provider
reported, or the tokens at the model's list price in Pi's model catalogue; a model with
neither is unknown and left out of the totals. Times are ISO 8601, such as 2026-10-01
(midnight UTC) or 2026-10-01T09:30:00Z; a time without Z or an offset is local time.

Exit status: 0 on success, 1 when no session or several match the id or a change fails,
2 on a usage error, including a search key or value search cannot use, a malformed time or
a --start after --end.

Examples:

  $ ampi threads list --all --limit 5
  $ ampi threads list --json | jq -r 'select(.messageCount > 10) | .id'
  $ ampi threads search parser label:docs after:7d
  $ ampi threads continue 019a3c
  $ ampi threads markdown 019a3c > session.md
  $ ampi threads context 019a3c | jq '.sections[] | {name, tokens}'
  $ ampi threads usage 019a3c --details --start 2026-10-01
  $ ampi usage --details
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
    host.log.warn(`${error instanceof Error ? error.message : String(error)} Archive dates and labels are left out.`);
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
export function cut(text, width) {
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

/**
 * `text` padded with spaces to `width` terminal columns.
 *
 * @param {string} text
 * @param {number} width
 */
export const padEnd = (text, width) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));

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
    host.log.error(result.code === 2 ? `${result.message}\n${USAGE_HINT}` : result.message);
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
  // `threads import` has subcommands, options and help of its own.
  if (command === "threads" && rest[0] === "import") return runImportCommand(rest.slice(1), host);
  if (rest.includes("--help") || rest.includes("-h") || rest[0] === "help") {
    host.out(formatThreadsHelp());
    return { code: 0 };
  }
  if (command === "last") {
    if (rest.length > 0) return usage(`last takes no arguments, not ${rest[0]}.`);
    return continueLast(host);
  }
  if (command === "usage") {
    /** @type {{ values: Record<string, string | boolean | undefined>, positionals: string[] }} */
    let parsed;
    try {
      parsed = /** @type {any} */ (parseArgs({ args: [...rest], options: OPTIONS.usage, allowPositionals: true, strict: true }));
    } catch (error) {
      return usage(`usage: ${messageOf(error)}`);
    }
    if (parsed.positionals.length > 0) return usage(`usage takes no arguments, not ${parsed.positionals[0]}; ampi threads usage <id> reports one session.`);
    return usageOfAll(host, parsed.values);
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
    case "search":
      return search(host, values, positionals);
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
    case "context":
      if (positionals.length !== 1) return usage("threads context takes one session id.");
      return context(host, positionals[0]);
    case "usage":
      if (positionals.length !== 1) return usage("threads usage takes one session id.");
      return usageOfThread(host, positionals[0], values);
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
 * The live entry of another process that has `session` open, from ampi-core's
 * live registry, or undefined.
 *
 * @param {ThreadsHost} host
 * @param {PiSessionInfo} session
 */
function liveHolder(host, session) {
  return findLiveOwner(session.path, {
    dir: host.registryDir ?? liveRegistryDir(piAgentDir(host.pi)),
    isAlive: host.isAlive,
    procStart: host.procStart,
    exceptPid: process.pid,
  });
}

/**
 * The process that holds a session, as the messages name it. A session
 * `ampi app` hosts runs in a worker the app started, so the app is named: it
 * is the process the user started and can quit.
 *
 * @param {import("./live-registry.js").LiveEntry} holder
 */
const describeHolder = (holder) =>
  holder.kind === "app-session" && holder.ownerPid !== undefined ? `ampi app (process ${holder.ownerPid})` : `process ${holder.pid} (${holder.kind})`;

/**
 * Open `session` through Pi's `--session`, warning first when another live
 * process has it open: Pi does not lock session files.
 *
 * @param {ThreadsHost} host
 * @param {PiSessionInfo} session
 * @returns {Outcome}
 */
function openSession(host, session) {
  /** @type {import("./live-registry.js").LiveEntry | undefined} */
  let holder;
  try {
    holder = liveHolder(host, session);
  } catch {
    // An unreadable registry only costs the warning.
  }
  if (holder) {
    host.log.warn(`${describeHolder(holder)} also has ${session.id} open; two processes writing one session file can lose messages.`);
  }
  return { piArgs: ["--session", session.path] };
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
  if ("session" in resolved) return openSession(host, resolved.session);
  if (resolved.missing === undefined || !COMPLETE_ID.test(resolved.missing)) return resolved;
  host.log.info(`no session has the id ${resolved.missing}; a new session starts under it in this directory.`);
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
 * @typedef {{ filter: string, kind: "unknown" | "hosted" | "invalid" | "unavailable" }} SearchProblem
 * @typedef {(input: {
 *   query: string,
 *   sessions: PiSessionInfo[],
 *   threads: Record<string, ThreadRecord> | undefined,
 *   now: Date,
 *   limit: number,
 * }) => Promise<{ matches: { session: PiSessionInfo, matchedTerms: string[] }[], total: number, problems: SearchProblem[] }>} ThreadSearch
 */

/**
 * Why search cannot use a filter, for the error or the note it prints.
 *
 * @param {SearchProblem} problem
 */
function describeSearchProblem({ filter, kind }) {
  const key = filter.slice(0, filter.indexOf(":") + 1);
  if (kind === "unknown") return `${key} is not a search key (in ${filter}); to search for that text, quote it: '"${filter}"'.`;
  if (kind === "hosted") return `${key} needs data that a hosted service keeps; it is not available for local sessions (in ${filter}).`;
  if (kind === "invalid") {
    const expected = /^(?:pinned|archived):/i.test(key)
      ? "true or false"
      : /^has:/i.test(key)
        ? "tools or errors"
        : /^(?:after|since|before|until|(?:modified|updated|created)_(?:after|before)):/i.test(key)
          ? "a date: YYYY-MM-DD, today, yesterday, week, month, or a count of days or weeks such as 7d or 2w"
          : undefined;
    return `${filter} ${filter.endsWith(":") ? "has no value" : "has a value search cannot read"}${expected === undefined ? "" : `; ${key} takes ${expected}`}.`;
  }
  if (/^(?:pinned|archived):/i.test(key)) return `${filter} is ignored: the thread index cannot be read.`;
  if (/^projectRef:/i.test(key)) return `${filter} is ignored: projectRef: refers to find_session results; use cwd: or project:.`;
  return `${filter} is ignored: it applies to find_session only; search sorts by the latest update and takes --limit.`;
}

/**
 * @typedef {import("./pi-compat.js").PiModelInfo} PiModelInfo
 * @typedef {(provider: string, model: string) => PiModelInfo | undefined} ModelLookup
 * @typedef {{ start?: Date, end?: Date }} UsageRange `start` included, `end` excluded.
 * @typedef {{ model: string, cost: number | null, inputTokens: number, outputTokens: number,
 *   cacheReadInputTokens: number, cacheCreationInputTokens: number }} UsageModel
 * @typedef {{ threadID: string, title: string, start: string | null, end: string | null, cost: number | null,
 *   unknownCostModels: number, models: UsageModel[], toolCalls: Record<string, number> }} ThreadUsage
 * @typedef {{ threadID: string, title: string, cwd: string, cost: number | null }} UsageSession
 * @typedef {{ start: string, end: string, cost: number | null, unknownCostModels: number, sessionCount: number,
 *   inputTokens: number, outputTokens: number, cacheReadInputTokens: number, cacheCreationInputTokens: number,
 *   models: UsageModel[], sessions: UsageSession[] }} Usage
 *
 * @typedef {object} CliThreads What src/cli-threads.ts in the ampi package hands over.
 * @property {ThreadSearch} searchThreads
 * @property {(id: string, entries: unknown[], models: ModelLookup) => Record<string, unknown> & { systemPromptRecorded?: false }} reportThreadContext
 * @property {(session: { id: string, title: string, entries: unknown[] }, range: UsageRange, models: ModelLookup) => ThreadUsage} reportThreadUsage
 * @property {(sessions: { id: string, title: string, cwd: string, entries: unknown[], imported: boolean }[],
 *   range: Required<UsageRange>, models: ModelLookup) => Usage} reportUsage
 * @property {(cost: number) => string} formatCost The prompt box gauge's cost format.
 */

/**
 * Load the functions `names` of the ampi package in use (`host.locateAmpi`)
 * through Pi. A package without them is too old for `command`.
 *
 * @template {keyof CliThreads} K
 * @param {ThreadsHost} host
 * @param {K[]} names
 * @param {string} command
 * @returns {Promise<{ functions: Pick<CliThreads, K> } | { code: number, message: string }>}
 */
async function loadCliThreads(host, names, command) {
  const ampi = await host.locateAmpi();
  const which = ampi?.version === undefined ? "the ampi package" : `ampi ${ampi.version}`;
  const tooOld = { code: 1, message: `${which} is too old for ${command}; update @skippermissions/ampi (or ampi-cli).` };
  const entry = ampi === undefined ? undefined : path.join(ampi.root, CLI_THREADS_ENTRY);
  if (entry === undefined || !existsSync(entry)) return tooOld;
  /** @type {Partial<CliThreads> | undefined} */
  let received;
  try {
    received = /** @type {Partial<CliThreads> | undefined} */ (await loadThroughPi(host.pi, entry, CLI_THREADS_EVENT));
  } catch (error) {
    return { code: 1, message: `could not load ampi's ${command}: ${messageOf(error)}` };
  }
  if (names.some((name) => typeof received?.[name] !== "function")) return tooOld;
  return { functions: /** @type {Pick<CliThreads, K>} */ (received) };
}

/**
 * Search the sessions of every directory with the search of the ampi package
 * in use, loaded through Pi.
 *
 * @param {ThreadsHost} host
 * @param {Record<string, string | boolean | undefined>} values
 * @param {string[]} positionals
 * @returns {Promise<Outcome>}
 */
async function search(host, values, positionals) {
  const query = positionals.join(" ").trim();
  if (!query) return usage("threads search needs a query.");
  let limit = SEARCH_LIMIT;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!/^\d+$/.test(String(values.limit)) || limit < 1) return usage(`--limit needs a whole number above 0, not ${values.limit}.`);
  }
  const loaded = await loadCliThreads(host, ["searchThreads"], "threads search");
  if (!("functions" in loaded)) return loaded;
  const { searchThreads } = loaded.functions;

  /** @type {Record<string, ThreadRecord> | undefined} */
  let threads;
  try {
    threads = readThreadIndex(indexFileOf(host));
  } catch (error) {
    host.log.warn(messageOf(error));
  }
  const sessions = await listSessions(host, "all");
  const result = await searchThreads({ query, sessions, threads, now: new Date(host.now()), limit });
  const errors = result.problems.filter((problem) => problem.kind !== "unavailable");
  if (errors.length > 0) return usage(errors.map(describeSearchProblem).join("\n"));
  for (const problem of result.problems) host.log.warn(describeSearchProblem(problem));

  const index = threads ?? {};
  if (values.json) {
    for (const { session, matchedTerms } of result.matches) {
      host.out(`${JSON.stringify({ ...describeSession(session, recordOf(index, session.id)), matchedTerms })}\n`);
    }
  } else if (result.matches.length === 0) {
    host.out("No sessions match.\n");
  } else {
    const shown = result.matches.map((match) => match.session);
    host.out(formatThreadTable(shown, index, { now: host.now(), columns: host.columns, archivedColumn: true }));
  }
  if (result.total > result.matches.length) {
    host.log.info(`showing ${result.matches.length} of ${result.total} matching sessions; --limit shows more.`);
  }
  return { code: 0 };
}

/**
 * Pi's model registry for the reports; a registry that cannot be built is reported, and every model is then unknown.
 *
 * @param {ThreadsHost} host
 * @returns {Promise<ModelLookup>}
 */
async function modelLookup(host) {
  try {
    return await createPiModelLookup(host.pi);
  } catch (error) {
    host.log.warn(`could not read Pi's model catalogue, so no model has a price or context window: ${messageOf(error)}`);
    return () => undefined;
  }
}

/**
 * Print what fills the session's context window, as JSON.
 *
 * @param {ThreadsHost} host
 * @param {string} query
 * @returns {Promise<Outcome>}
 */
async function context(host, query) {
  const loaded = await loadCliThreads(host, ["reportThreadContext"], "threads context");
  if (!("functions" in loaded)) return loaded;
  return withSession(host, query, async (session) => {
    const report = loaded.functions.reportThreadContext(session.id, readPiSessionEntries(host.pi, session.path), await modelLookup(host));
    if (report.systemPromptRecorded === false) {
      host.log.info("the session records no system prompt yet (Pi records it with the first request), so the prompt and tool sections are 0.");
    }
    host.out(`${JSON.stringify(report, null, 2)}\n`);
    return { code: 0 };
  });
}

/**
 * Read `--start` and `--end`.
 *
 * @param {Record<string, string | boolean | undefined>} values
 * @returns {{ start?: Date, end?: Date } | { code: number, message: string }}
 */
function readRange(values) {
  /** @type {{ start?: Date, end?: Date }} */
  const range = {};
  for (const name of /** @type {const} */ (["start", "end"])) {
    const given = values[name];
    if (given === undefined) continue;
    const text = String(given);
    const time = ISO_TIME.test(text) && isCalendarDate(text) ? Date.parse(text) : Number.NaN;
    if (!Number.isFinite(time)) return usage(`--${name} needs an ISO 8601 time such as 2026-10-01 or 2026-10-01T09:30:00Z, not ${given}.`);
    range[name] = new Date(time);
  }
  if (range.start && range.end && range.start > range.end) return usage("--start is after --end.");
  return range;
}

/** @param {number} count */
const models = (count) => `${count} ${count === 1 ? "model" : "models"}`;

/**
 * The total as the Thread Cost overlay shows it: unknown when no model has a
 * cost, else the known cost and how many models it leaves out.
 *
 * @param {number | null} cost
 * @param {number} unknown
 * @param {(cost: number) => string} formatCost
 */
function formatTotal(cost, unknown, formatCost) {
  if (cost === null) return "Total: unknown (no model has a price)";
  return `Total: ${formatCost(cost)}${unknown > 0 ? `, not counting ${models(unknown)} without a price` : ""}`;
}

/**
 * Lines of a table: a header, a rule, and the rows, with the columns in
 * `right` aligned to the right.
 *
 * @param {string[]} header
 * @param {string[][]} rows
 * @param {Set<number>} right
 */
function formatColumns(header, rows, right) {
  const widths = header.map((name, column) => Math.max(visibleWidth(name), ...rows.map((row) => visibleWidth(row[column]))));
  /** @param {string[]} cells */
  const line = (cells) =>
    cells
      .map((cell, column) => (right.has(column) ? " ".repeat(widths[column] - visibleWidth(cell)) + cell : padEnd(cell, widths[column])))
      .join(GAP)
      .trimEnd();
  return [line(header), widths.map((width) => "─".repeat(width)).join(GAP), ...rows.map(line)];
}

/**
 * The per-model table of `--details`.
 *
 * @param {UsageModel[]} rows
 * @param {(cost: number) => string} formatCost
 */
function formatModelTable(rows, formatCost) {
  const cells = rows.map((row) => [
    row.model,
    String(row.inputTokens),
    String(row.outputTokens),
    String(row.cacheReadInputTokens),
    String(row.cacheCreationInputTokens),
    row.cost === null ? "unknown" : formatCost(row.cost),
  ]);
  return formatColumns(["Model", "Input", "Output", "Cache read", "Cache write", "Cost"], cells, new Set([1, 2, 3, 4, 5]));
}

/**
 * Print a session's cost, counting what happened in the range.
 *
 * @param {ThreadsHost} host
 * @param {string} query
 * @param {Record<string, string | boolean | undefined>} values
 * @returns {Promise<Outcome>}
 */
async function usageOfThread(host, query, values) {
  const range = readRange(values);
  if ("code" in range) return range;
  const loaded = await loadCliThreads(host, ["reportThreadUsage", "formatCost"], "threads usage");
  if (!("functions" in loaded)) return loaded;
  const { reportThreadUsage, formatCost } = loaded.functions;
  return withSession(host, query, async (session) => {
    const entries = readPiSessionEntries(host.pi, session.path);
    const report = reportThreadUsage({ id: session.id, title: threadTitle(session), entries }, range, await modelLookup(host));
    if (values.json) {
      host.out(`${JSON.stringify(report, null, 2)}\n`);
      return { code: 0 };
    }
    const lines = [report.title];
    if (report.start !== null || report.end !== null) lines.push(`From ${report.start ?? "the start"} until ${report.end ?? "now"}`);
    lines.push(formatTotal(report.cost, report.unknownCostModels, formatCost));
    if (values.details) {
      lines.push("", ...(report.models.length > 0 ? formatModelTable(report.models, formatCost) : ["No model usage."]));
      const tools = Object.entries(report.toolCalls).sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
      lines.push("", tools.length > 0 ? "Tool calls:" : "Tool calls: none");
      if (tools.length > 0) lines.push(...formatColumns(["Tool", "Calls"], tools.map(([name, count]) => [name, String(count)]), new Set([1])));
    }
    host.out(`${lines.join("\n")}\n`);
    return { code: 0 };
  });
}

/**
 * Print the cost and tokens of every session on this machine in the range:
 * the 30 days up to `--end` (default now) unless `--start` says otherwise.
 *
 * @param {ThreadsHost} host
 * @param {Record<string, string | boolean | undefined>} values
 * @returns {Promise<Outcome>}
 */
async function usageOfAll(host, values) {
  const given = readRange(values);
  if ("code" in given) return given;
  const end = given.end ?? new Date(host.now());
  const start = given.start ?? new Date(end.getTime() - USAGE_DAYS * 24 * 60 * 60 * 1000);
  if (start > end) return usage("--start is after --end.");
  const loaded = await loadCliThreads(host, ["reportUsage", "formatCost"], "usage");
  if (!("functions" in loaded)) return loaded;
  const { reportUsage, formatCost } = loaded.functions;
  const threads = readIndexForListing(host);
  const sessions = (await listSessions(host, "all")).map((session) => ({
    id: session.id,
    title: threadTitle(session),
    cwd: session.cwd,
    entries: readPiSessionEntries(host.pi, session.path),
    imported: recordOf(threads, session.id)?.labels?.includes(IMPORTED_LABEL) === true,
  }));
  const report = reportUsage(sessions, { start, end }, await modelLookup(host));
  if (values.json) {
    host.out(`${JSON.stringify(report, null, 2)}\n`);
    return { code: 0 };
  }
  const lines = [
    `Usage from ${report.start} until ${report.end}`,
    formatTotal(report.cost, report.unknownCostModels, formatCost),
    `Sessions: ${report.sessionCount}`,
    `Tokens: ${report.inputTokens} input, ${report.outputTokens} output, ${report.cacheReadInputTokens} cache read, ${report.cacheCreationInputTokens} cache write`,
    "ampi keeps no account and no credits: these costs are what the providers reported, or the tokens at the models' list prices where they reported none.",
  ];
  if (values.details && report.sessions.length > 0) {
    const top = report.sessions.slice(0, USAGE_TOP_SESSIONS).map((session) => [
      session.threadID,
      cut(session.title, 40),
      session.cost === null ? "unknown" : formatCost(session.cost),
      session.cwd,
    ]);
    lines.push("", ...formatModelTable(report.models, formatCost));
    lines.push("", "Most expensive sessions:", ...formatColumns(["ID", "Title", "Cost", "Directory"], top, new Set([2])));
  }
  host.out(`${lines.join("\n")}\n`);
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
  return openSession(host, session);
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
    const holder = liveHolder(host, session);
    if (holder) {
      return {
        code: 1,
        message: `${describeHolder(holder)} has ${session.id} open; quit it first, or rename the session there (with /name in a terminal).`,
      };
    }
    setPiSessionName(host.pi, session.path, title);
    try {
      // As --title does: the title is the user's, not one to generate.
      updateThreadRecord(indexFileOf(host), session.id, { titleSource: "user" });
    } catch (error) {
      host.log.warn(`the session was renamed, but the thread index was not updated: ${messageOf(error)}`);
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
    // Checked before the question, so --yes cannot delete a file another process writes.
    const holder = liveHolder(host, session);
    if (holder) return { code: 1, message: `${describeHolder(holder)} has ${session.id} open; quit it first. Nothing was deleted.` };
    if (!yes && !(await host.confirm(`Delete session ${session.id} (${threadTitle(session)})? [y/N] `))) {
      return { code: 1, message: "nothing was deleted." };
    }
    unlinkSync(session.path);
    const file = indexFileOf(host);
    try {
      if (recordOf(readThreadIndex(file), session.id) !== undefined) updateThreadRecord(file, session.id, null);
    } catch (error) {
      host.log.warn(`the session was deleted, but its thread metadata was not: ${messageOf(error)}`);
    }
    host.out(`Deleted ${session.id} (${threadTitle(session)}).\n`);
    return { code: 0 };
  });
}
