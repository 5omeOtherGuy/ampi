// `ampi top`: the ampi sessions running on this machine, read from ampi-core's
// live registry (live-registry.js). In a terminal it is a full-screen list
// that follows the registry until q, Esc or Ctrl+C; redirected it prints the
// list once; `--json` prints one snapshot and `--stream-jsonl` one JSON line
// each time the list changes. Everything the command touches outside its
// arguments comes through a `TopHost`, so tests run it in-process with a fake
// clock, terminal, watcher and timer.
import { existsSync, watch as watchPath } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { readLiveEntries } from "./live-registry.js";
import { cut, padEnd } from "./threads.js";

/**
 * @typedef {import("./live-registry.js").LiveEntry} LiveEntry
 *
 * @typedef {(() => void) & { refresh?: () => void }} WatchCloser Stops watching; `refresh`, when
 *   present, looks again for the directory to watch (the poll calls it).
 *
 * @typedef {object} TopHost
 * @property {string} dir The live registry directory (liveRegistryDir of Pi's agent directory).
 * @property {() => number} now Milliseconds since the epoch.
 * @property {(pid: number) => boolean} [isAlive] Whether a process runs; defaults to a signal-0 probe.
 * @property {(pid: number) => number | null} [procStart] A process's start time; defaults to /proc/<pid>/stat.
 * @property {number} columns The terminal's width, read on every draw.
 * @property {number} rows The terminal's height, read on every draw.
 * @property {boolean} isTTY Whether stdout is a terminal.
 * @property {string} home The home directory, shown as `~`.
 * @property {(text: string) => void} out Writes to stdout.
 * @property {import("./log.js").Logger} log For the command's diagnostics.
 * @property {(dir: string, onChange: () => void) => WatchCloser} watch Calls `onChange` when the directory may have changed.
 * @property {(callback: () => void, ms: number) => () => void} interval Calls `callback` every `ms`; returns its stop.
 * @property {(onKey: (chunk: string) => void) => () => void} keys Reads stdin in raw mode when it is a
 *   terminal; the returned function leaves raw mode. Does nothing otherwise.
 * @property {(onResize: () => void) => () => void} onResize
 * @property {(onSignal: (signal: string) => void) => () => void} onSignal SIGINT, SIGTERM and SIGHUP, with
 *   the signal's name.
 * @property {(onExit: () => void) => () => void} onExit Runs synchronously when the process exits.
 *
 * @typedef {object} TopSession One session as `--json` and `--stream-jsonl` print it.
 * @property {number} pid
 * @property {LiveEntry["kind"]} kind
 * @property {number | null} ownerPid
 * @property {string | null} sessionId
 * @property {string | null} sessionPath
 * @property {string} cwd
 * @property {string | null} title
 * @property {string | null} mode
 * @property {{ phase: string, label: string } | null} status
 * @property {string} startedAt
 * @property {string} updatedAt
 * @property {boolean} gui
 */

const USAGE_HINT = "Run ampi top --help for its options.";
export const OPTIONS = /** @type {const} */ ({
  json: { type: "boolean" },
  "stream-jsonl": { type: "boolean" },
  help: { type: "boolean", short: "h" },
});

/** How often the list is read again, whatever the watcher reports. */
export const TOP_POLL_MS = 1_000;
/** Columns between table columns. */
const GAP = "  ";
/** The narrowest the Title column gets while the terminal has room for it. */
const TITLE_MIN = 10;
/** The widest the Directory column gets in a terminal; longer paths are cut in the middle. */
export const TOP_DIRECTORY_MAX = 32;
/** Before the label of a session whose agent works. */
export const TOP_BUSY_MARKER = "●";
/** The Status of an idle session, whose label is empty. */
export const TOP_IDLE_WORD = "Idle";
/** Phases in which the agent does not work; every other phase does. */
const RESTING_PHASES = new Set(["idle", "error"]);
const KIND_WORDS = /** @type {const} */ ({ tui: "tui", execute: "-x", app: "app", "app-session": "hosted" });
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const ESC = "\x1b";
const ENTER_SCREEN = `${ESC}[?1049h${ESC}[?25l`;
const LEAVE_SCREEN = `${ESC}[?25h${ESC}[?1049l`;

/** @returns {string} */
export function formatTopHelp() {
  return `Usage: ampi top [--json | --stream-jsonl]

Shows the ampi sessions running on this machine, in every directory: their status,
title, mode, directory, kind, time since they started and pid. In a terminal the list
fills the screen and follows changes until you press q, Esc or Ctrl+C; redirected, it
is printed once.

Options:

  --json            Print the list once as one JSON object and exit
  --stream-jsonl    Print the list as one JSON line now and another each time it changes,
                    until Ctrl+C, SIGTERM, SIGHUP or the reader closes the pipe (experimental
                    format)
  -h, --help        Print this help and exit

Kinds: tui (a terminal session), -x (an execute, JSON or RPC run), app (ampi app itself),
hosted (a session ampi app runs).
`;
}

/** @param {{ status: LiveEntry["status"] }} entry */
const isBusy = (entry) => entry.status !== null && !RESTING_PHASES.has(entry.status.phase);

/** @param {string} iso */
const timeOf = (iso) => {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
};

/**
 * The entries in the order every output lists them: sessions whose agent
 * works first, then the rest; the latest update first within each; pid
 * breaks ties.
 *
 * @param {readonly LiveEntry[]} entries
 * @returns {LiveEntry[]}
 */
export function sortTopEntries(entries) {
  return [...entries].sort(
    (a, b) => Number(isBusy(b)) - Number(isBusy(a)) || timeOf(b.updatedAt) - timeOf(a.updatedAt) || a.pid - b.pid,
  );
}

/**
 * The entry as the JSON outputs print it: no GUI port and no token hash.
 *
 * @param {LiveEntry} entry
 * @returns {TopSession}
 */
function describeEntry(entry) {
  return {
    pid: entry.pid,
    kind: entry.kind,
    ownerPid: entry.kind === "app-session" ? (entry.ownerPid ?? null) : null,
    sessionId: entry.sessionId,
    sessionPath: entry.sessionPath,
    cwd: entry.cwd,
    title: entry.title,
    mode: entry.mode,
    status: entry.status === null ? null : { phase: entry.status.phase, label: entry.status.label },
    startedAt: entry.startedAt,
    updatedAt: entry.updatedAt,
    gui: entry.gui !== null,
  };
}

/**
 * The record `--json` prints and `--stream-jsonl` prints a line of.
 *
 * @param {readonly LiveEntry[]} entries
 * @param {number} now
 */
export function formatTopRecord(entries, now) {
  return { type: "sessions", time: new Date(now).toISOString(), sessions: sortTopEntries(entries).map(describeEntry) };
}

/**
 * Whole seconds, minutes, hours or days since `startedAt`; 0s for a time
 * in the future.
 *
 * @param {string} startedAt
 * @param {number} now
 */
export function formatUptime(startedAt, now) {
  const seconds = Math.max(0, Math.floor((now - timeOf(startedAt)) / 1000));
  if (!Number.isFinite(seconds)) return "-";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/** @param {string} text */
const oneLine = (text) => text.replace(CONTROL, " ");

/**
 * `cwd` with the home directory shown as `~`.
 *
 * @param {string} cwd
 * @param {string} home
 */
function shortenHome(cwd, home) {
  if (!home || home === path.sep) return cwd;
  if (cwd === home) return "~";
  const prefix = home.endsWith(path.sep) ? home : `${home}${path.sep}`;
  return cwd.startsWith(prefix) ? `~${path.sep}${cwd.slice(prefix.length)}` : cwd;
}

/**
 * `text` cut to `width` terminal columns by taking whole characters out of
 * its middle, with an ellipsis where they were.
 *
 * @param {string} text
 * @param {number} width
 */
export function cutMiddle(text, width) {
  if (visibleWidth(text) <= width) return text;
  if (width <= 1) return width === 1 ? "…" : "";
  const segments = [...GRAPHEMES.segment(text)].map(({ segment }) => segment);
  const room = width - 1;
  let headWidth = Math.ceil(room / 2);
  let tailWidth = room - headWidth;
  let head = "";
  for (const segment of segments) {
    const next = visibleWidth(segment);
    if (next > headWidth) break;
    head += segment;
    headWidth -= next;
  }
  // Columns the head could not use (a wide character at the cut) go to the tail.
  tailWidth += headWidth;
  let tail = "";
  for (let index = segments.length - 1; index >= 0; index--) {
    const next = visibleWidth(segments[index]);
    if (next > tailWidth) break;
    tail = segments[index] + tail;
    tailWidth -= next;
  }
  return `${head}…${tail}`;
}

/** @param {number} count */
const countLine = (count) => `${count} ${count === 1 ? "session" : "sessions"} running`;

/** The line shown instead of the table when nothing runs. */
export const TOP_EMPTY = "No ampi session is running on this machine.";

/**
 * The list as text: a line with the number of sessions (the `ampi app` row
 * does not count), then the table, or the empty-state line. With finite
 * `columns` titles and directories are cut to fit, and with finite `rows`
 * rows that do not fit end in a line counting them.
 *
 * @param {readonly LiveEntry[]} entries
 * @param {{ now: number, columns: number, rows?: number, home: string, hint?: string }} options `hint`
 *   follows the first line.
 * @returns {string[]}
 */
export function formatTopLines(entries, { now, columns, rows = Number.POSITIVE_INFINITY, home, hint = "" }) {
  if (entries.length === 0) return [TOP_EMPTY + hint];
  const sorted = sortTopEntries(entries);
  const cells = sorted.map((entry) => [
    entry.status === null ? "-" : isBusy(entry) ? `${TOP_BUSY_MARKER} ${oneLine(entry.status.label)}` : oneLine(entry.status.label) || TOP_IDLE_WORD,
    entry.kind === "app" ? "app" : entry.title === null ? "-" : oneLine(entry.title).trim() || "-",
    oneLine(entry.mode ?? "").trim() || "-",
    shortenHome(oneLine(entry.cwd), home),
    KIND_WORDS[entry.kind],
    formatUptime(entry.startedAt, now),
    String(entry.pid),
  ]);
  const header = ["Status", "Title", "Mode", "Directory", "Kind", "Up", "PID"];
  const widths = header.map((name, column) => Math.max(visibleWidth(name), ...cells.map((row) => visibleWidth(row[column]))));
  if (Number.isFinite(columns)) {
    const fixed = widths.reduce((sum, width, column) => (column === 1 || column === 3 ? sum : sum + width), 0) + GAP.length * (header.length - 1);
    const room = Math.max(0, columns - fixed);
    widths[3] = Math.min(widths[3], TOP_DIRECTORY_MAX, Math.max(visibleWidth(header[3]), room - Math.min(widths[1], TITLE_MIN)));
    widths[1] = Math.min(widths[1], Math.max(TITLE_MIN, room - widths[3]));
  }
  /** @param {string[]} row */
  const line = (row) =>
    row
      .map((cell, column) => {
        const fitted = column === 3 ? cutMiddle(cell, widths[column]) : cut(cell, widths[column]);
        return column === 6 ? fitted.padStart(widths[column]) : padEnd(fitted, widths[column]);
      })
      .join(GAP)
      .trimEnd();
  const lines = [countLine(sorted.filter((entry) => entry.kind !== "app").length) + hint, "", line(header), widths.map((width) => "─".repeat(width)).join(GAP)];
  const room = rows - lines.length;
  const shown = cells.length <= room ? cells.length : Math.max(0, room - 1);
  for (const row of cells.slice(0, shown)) lines.push(line(row));
  if (shown < cells.length) lines.push(`… ${cells.length - shown} more`);
  return lines;
}

/**
 * One screen of the live view: every line from the top-left, each cleared
 * to its end, then the rest of the screen cleared.
 *
 * @param {string[]} lines
 * @param {number} columns
 */
function frameOf(lines, columns) {
  return `${ESC}[H${lines.map((line) => `${cut(line, Math.max(1, columns))}${ESC}[K`).join("\r\n")}${ESC}[J`;
}

/**
 * Watch the registry directory for changes. While it does not exist, its
 * parent is watched instead (and when that is missing too, nothing, and the
 * poll's `refresh` looks again), switching to the directory once it appears.
 *
 * @param {string} dir
 * @param {() => void} onChange
 * @param {{ watch?: typeof watchPath, exists?: (file: string) => boolean }} [deps]
 * @returns {WatchCloser}
 */
export function watchLiveRegistry(dir, onChange, { watch = watchPath, exists = existsSync } = {}) {
  /** @type {import("node:fs").FSWatcher | undefined} */
  let watcher;
  /** @type {string | undefined} */
  let watched;
  let closed = false;
  const stop = () => {
    watcher?.close();
    watcher = undefined;
    watched = undefined;
  };
  const refresh = () => {
    if (closed) return;
    const parent = path.dirname(dir);
    const target = exists(dir) ? dir : exists(parent) ? parent : undefined;
    if (target === watched) return;
    stop();
    if (target === undefined) return;
    try {
      const current = watch(target, () => {
        refresh();
        onChange();
      });
      // A watched directory that goes away ends the watcher; the poll finds the next one.
      current.on("error", () => {
        if (watcher === current) stop();
      });
      watcher = current;
      watched = target;
    } catch {
      // The poll still reads the registry every second.
    }
  };
  refresh();
  /** @type {WatchCloser} */
  const close = () => {
    closed = true;
    stop();
  };
  close.refresh = refresh;
  return close;
}

/** @param {unknown} error */
const messageOf = (error) => (error instanceof Error ? error.message : String(error));

/**
 * Run `ampi top`.
 *
 * @param {readonly string[]} argv The arguments after `top`.
 * @param {TopHost} host
 * @returns {Promise<number>} The exit code.
 */
export async function runTopCommand(argv, host) {
  /** @type {{ values: { json?: boolean, "stream-jsonl"?: boolean, help?: boolean }, positionals: string[] }} */
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    const unknown = /** @type {NodeJS.ErrnoException} */ (error).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" && /'([^']+)'/.exec(messageOf(error));
    return usageError(host, unknown ? `top has no option ${unknown[1]}.` : `top: ${messageOf(error)}`);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    host.out(formatTopHelp());
    return 0;
  }
  if (positionals.length > 0) return usageError(host, `top takes no arguments, not ${positionals[0]}.`);
  if (values.json && values["stream-jsonl"]) return usageError(host, "--json and --stream-jsonl cannot be combined.");

  const read = () => readLiveEntries({ dir: host.dir, isAlive: host.isAlive, procStart: host.procStart });
  try {
    if (values.json) {
      host.out(`${JSON.stringify(formatTopRecord(read(), host.now()))}\n`);
      return 0;
    }
    if (!values["stream-jsonl"] && !host.isTTY) {
      host.out(`${formatTopLines(read(), { now: host.now(), columns: Number.POSITIVE_INFINITY, home: host.home }).join("\n")}\n`);
      return 0;
    }
  } catch (error) {
    host.log.error(`cannot read the live registry: ${messageOf(error)}`);
    return 1;
  }
  return values["stream-jsonl"] ? follow(host, read, streamView(host)) : follow(host, read, screenView(host));
}

/**
 * @param {TopHost} host
 * @param {string} message
 */
function usageError(host, message) {
  host.log.error(`${message}\n${USAGE_HINT}`);
  return 2;
}

/**
 * @typedef {object} TopView
 * @property {() => void} [open] Runs before the first draw.
 * @property {(entries: LiveEntry[], force: boolean) => void} draw Shows the list; `force` after a resize.
 * @property {() => void} [close] Runs once on every way out.
 * @property {boolean} [keys] Whether q, Esc and Ctrl+C quit.
 */

/**
 * `--stream-jsonl`: one line now, then one each time the sessions differ
 * from the last line's.
 *
 * @param {TopHost} host
 * @returns {TopView}
 */
function streamView(host) {
  /** @type {string | undefined} */
  let last;
  return {
    draw(entries) {
      const record = formatTopRecord(entries, host.now());
      const sessions = JSON.stringify(record.sessions);
      if (sessions === last) return;
      last = sessions;
      host.out(`${JSON.stringify(record)}\n`);
    },
  };
}

/**
 * The full-screen list, on the alternate screen with the cursor hidden.
 *
 * @param {TopHost} host
 * @returns {TopView}
 */
function screenView(host) {
  /** @type {string | undefined} */
  let last;
  return {
    keys: true,
    open: () => host.out(ENTER_SCREEN),
    draw(entries, force) {
      const { columns, rows } = host;
      const lines = formatTopLines(entries, { now: host.now(), columns, rows, home: host.home, hint: "  (q to quit)" });
      const frame = frameOf(lines, columns);
      if (frame === last && !force) return;
      last = frame;
      host.out(frame);
    },
    close: () => host.out(LEAVE_SCREEN),
  };
}

/**
 * Show the list in `view`, and again on every registry change, poll tick and
 * resize, until a quit key, a signal, the process's exit or an error.
 *
 * @param {TopHost} host
 * @param {() => LiveEntry[]} read
 * @param {TopView} view
 * @returns {Promise<number>}
 */
function follow(host, read, view) {
  return new Promise((resolve) => {
    /** @type {(() => void)[]} */
    const closers = [];
    let done = false;
    /** @param {number} code @param {string} [message] */
    const finish = (code, message) => {
      if (done) return;
      done = true;
      for (const close of closers.reverse()) {
        try {
          close();
        } catch {
          // Every other closer still runs.
        }
      }
      if (message !== undefined) host.log.error(message);
      resolve(code);
    };
    /** @param {boolean} force */
    const update = (force) => {
      if (done) return;
      try {
        view.draw(read(), force);
      } catch (error) {
        finish(1, `cannot read the live registry: ${messageOf(error)}`);
      }
    };
    try {
      if (view.open) {
        view.open();
        if (view.close) closers.push(view.close);
      }
      closers.push(host.onExit(() => finish(0)));
      // A hangup (the terminal closed) exits as a shell reports it, 128 + 1, once the terminal is restored.
      closers.push(host.onSignal((signal) => finish(signal === "SIGHUP" ? 129 : 0)));
      if (view.keys) {
        closers.push(
          host.keys((chunk) => {
            // A lone Esc quits; longer escape sequences (arrow keys and the like) do not.
            if (chunk === ESC || (!chunk.startsWith(ESC) && /[q\x03]/.test(chunk))) finish(0);
          }),
        );
        closers.push(host.onResize(() => update(true)));
      }
      const unwatch = host.watch(host.dir, () => update(false));
      closers.push(unwatch);
      closers.push(
        host.interval(() => {
          unwatch.refresh?.();
          update(false);
        }, TOP_POLL_MS),
      );
      update(false);
    } catch (error) {
      finish(1, messageOf(error));
    }
  });
}
