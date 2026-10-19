// `ampi threads import`: copy other coding agents' conversations on this
// machine into Pi sessions, which ampi-core then keeps read-only. Each
// conversation becomes one Pi session in the session directory Pi uses for
// the conversation's working directory, with an `ampi-import` entry naming
// its source, the labels `imported` and the agent's name in the thread index,
// and a record in the import ledger so the next run skips it.
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createPiSessionWriter, piAgentDir } from "../pi-compat.js";
import { readThreadIndex, threadIndexPath, updateThreadRecord, validateThreadLabels } from "../thread-index.js";
import { CLAUDE_CODE_AGENT, CLAUDE_SESSION_ID, claudeCodeDir, convertClaudeCodeSession, listClaudeCodeSessions } from "./claude-code.js";
import { CODEX_AGENT, CODEX_SESSION_ID, codexSessionsDir, convertCodexSession, listCodexSessions } from "./codex.js";
import { importKey, importLedgerPath, readImportLedger, writeImportLedger } from "./ledger.js";
import { OPENCODE_AGENT, OPENCODE_SESSION_ID, openCodeDir, openOpenCode } from "./opencode.js";

/**
 * @typedef {import("../threads.js").ThreadsHost} ThreadsHost
 * @typedef {import("./messages.js").SourceSession} SourceSession
 * @typedef {import("./messages.js").Conversion} Conversion
 * @typedef {import("./ledger.js").ImportRecord} ImportRecord
 *
 * @typedef {{ type: "imported" | "skipped" | "failed", agent: string, sourceId: string, sessionId?: string,
 *   messages?: number, reason?: string }} ImportEvent One line of `--json` output.
 *
 * @typedef {object} ImportAgent An agent whose conversations `ampi threads import` reads.
 * @property {string} agent Its name in the import records, the labels and the output.
 * @property {string} name Its name in sentences.
 * @property {string} dirOption The option naming its directory.
 * @property {(env: NodeJS.ProcessEnv) => string} defaultDir Its directory without that option.
 * @property {(dir: string) => string} where Where its conversations are in that directory; detect prints it.
 * @property {RegExp} idPattern
 * @property {string} idHint What an id is, for the usage error.
 * @property {(dir: string, host: ThreadsHost) => Promise<{ sessions: SourceSession[], convert: (source: SourceSession) => Conversion, close?: () => void }>} open
 *   Lists its conversations and converts one.
 */

const USAGE_HINT = "Run ampi threads import --help for the agents and options.";

/** Other spellings of the agents' import commands. */
export const AGENT_ALIASES = Object.freeze({ "claude-code": "claude" });

/** The version of the `ampi-import` entry's fields. */
const IMPORT_FORMAT_VERSION = 1;
/** Days `--all` looks back without `--max-age`. */
const MAX_AGE_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
/** The custom entry type ampi-core recognizes imported sessions by (`MMR_IMPORT_ENTRY_TYPE` there). */
const IMPORT_ENTRY_TYPE = "ampi-import";
const IMPORTED_LABEL = "imported";
/** C0 and C1 control characters: ids and reasons are printed to a terminal. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** @param {NodeJS.ProcessEnv} env */
const homeOf = (env) => env.HOME || homedir();

/**
 * The agents, by their import command; `detect` reports them in this order.
 *
 * @type {Record<string, ImportAgent>}
 */
export const AGENTS = {
  claude: {
    agent: CLAUDE_CODE_AGENT,
    name: "Claude Code",
    dirOption: "claude-dir",
    defaultDir: (env) => claudeCodeDir(env, homeOf(env)),
    where: (dir) => path.join(dir, "projects"),
    idPattern: CLAUDE_SESSION_ID,
    idHint: "a Claude Code session id: give the session file's name without .jsonl",
    open: async (dir) => ({ sessions: listClaudeCodeSessions(dir), convert: (source) => convertClaudeCodeSession(readFileSync(source.file, "utf8")) }),
  },
  codex: {
    agent: CODEX_AGENT,
    name: "Codex",
    dirOption: "codex-dir",
    defaultDir: (env) => codexSessionsDir(env, homeOf(env)),
    where: (dir) => dir,
    idPattern: CODEX_SESSION_ID,
    idHint: "a Codex session id: give the id that ends the rollout file's name",
    open: async (dir) => ({ sessions: listCodexSessions(dir), convert: (source) => convertCodexSession(readFileSync(source.file, "utf8")) }),
  },
  opencode: {
    agent: OPENCODE_AGENT,
    name: "OpenCode",
    dirOption: "opencode-dir",
    defaultDir: (env) => openCodeDir(env, homeOf(env)),
    where: (dir) => dir,
    idPattern: OPENCODE_SESSION_ID,
    idHint: "an OpenCode session id: give an id that starts with ses_",
    open: (dir, host) => openOpenCode(dir, host.loadSqlite),
  },
};

export const DETECT_OPTIONS = /** @type {const} */ ({ json: { type: "boolean" } });
export const IMPORT_OPTIONS = /** @type {const} */ ({
  all: { type: "boolean" },
  "max-age": { type: "string" },
  limit: { type: "string" },
  "dry-run": { type: "boolean" },
  reimport: { type: "boolean" },
  json: { type: "boolean" },
});

/**
 * The text `ampi threads import --help` prints.
 *
 * @returns {string}
 */
export function formatImportHelp() {
  return `ampi threads import: copy other coding agents' conversations on this machine into read-only sessions

Usage: ampi threads import detect [--json]
       ampi threads import claude|codex|opencode [ids...] [--all] [options]

Commands:

  detect                        Print where each agent keeps its conversations and whether that
                                exists; reads no conversation
      --json                    Print {"agents": [{"agent", "path", "found"}]} instead
  claude, claude-code [ids...]  Import Claude Code sessions: the ids are their file names
      --claude-dir <path>       Claude Code's configuration directory (default $CLAUDE_CONFIG_DIR,
                                else ~/.claude)
  codex [ids...]                Import Codex sessions: the ids end their rollout file names
      --codex-dir <path>        Codex's sessions directory (default $CODEX_HOME/sessions, else
                                ~/.codex/sessions)
  opencode [ids...]             Import OpenCode sessions: the ids start with ses_. Its database
                                needs Node.js 22.19 or later; older JSON storage is read too
      --opencode-dir <path>     OpenCode's data directory (default $XDG_DATA_HOME/opencode, else
                                ~/.local/share/opencode)

Options of claude, codex and opencode:

      --all                     Import every session updated within --max-age days, newest first;
                                helper agents' sessions are left out
      --max-age <days>          With --all: how many days back to look (default 30; 0 for no limit)
      --limit <n>               With --all: import at most n sessions
      --dry-run                 Read and convert the sessions, print what would be imported, and
                                write nothing
      --reimport                Import sessions again that were imported before, replacing their
                                sessions under the same ids
      --json                    Print one JSON object per line instead

Each conversation becomes a session in the directory it ran in, named with the title the
agent recorded, else after its first prompt. Messages keep their times, tool calls and
results; assistant messages keep the agent's model and token counts, and their cost is
unknown. Imported sessions are labelled imported and the agent (claude-code, codex or
opencode), and they are read-only: read them with ampi threads markdown, or mention one with
@@ in a new session. ampi keeps a record of what it imported in Pi's configuration directory
(data/ampi/imports.json) and skips those conversations unless --reimport is given.

Exit status: 0 when every conversation was imported or skipped, 1 when one failed or an id
was not found, 2 on a usage error.

Examples:

  $ ampi threads import detect
  $ ampi threads import claude --all --max-age 7 --dry-run
  $ ampi threads import claude 3f2c9a7e-1b4d-4e8a-9c3f-5d6e7f8a9b0c
  $ ampi threads import codex --all --limit 10
  $ ampi threads import opencode ses_4f1a2b3c4d5eAbCdEfGhIjKlMn
  $ ampi threads import claude --all --json | jq -c 'select(.type == "failed")'
`;
}

/** @param {unknown} error */
const messageOf = (error) => (error instanceof Error ? error.message : String(error));

/**
 * Run `ampi threads import …`. Errors are printed here.
 *
 * @param {readonly string[]} argv The command line after `import`.
 * @param {ThreadsHost} host
 * @returns {Promise<{ code: number }>}
 */
export async function runImportCommand(argv, host) {
  const [command, ...args] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h" || args.includes("--help") || args.includes("-h")) {
    host.out(formatImportHelp());
    return { code: 0 };
  }
  /** @param {string} message */
  const usage = (message) => {
    host.log.error(`${message}\n${USAGE_HINT}`);
    return { code: 2 };
  };
  const sub = Object.hasOwn(AGENT_ALIASES, command) ? AGENT_ALIASES[/** @type {keyof typeof AGENT_ALIASES} */ (command)] : command;
  const agent = Object.hasOwn(AGENTS, sub) ? AGENTS[sub] : undefined;
  if (sub !== "detect" && agent === undefined) return usage(`unknown import command ${command}.`);
  const options = agent === undefined ? DETECT_OPTIONS : { ...IMPORT_OPTIONS, [agent.dirOption]: { type: "string" } };
  /** @type {{ values: Record<string, string | boolean | undefined>, positionals: string[] }} */
  let parsed;
  try {
    parsed = /** @type {any} */ (parseArgs({ args: [...args], options: /** @type {any} */ (options), allowPositionals: true, strict: true }));
  } catch (error) {
    return usage(`threads import ${sub}: ${messageOf(error)}`);
  }
  if (agent === undefined) {
    if (parsed.positionals.length > 0) return usage(`threads import detect takes no arguments, not ${parsed.positionals[0]}.`);
    detect(host, parsed.values.json === true);
    return { code: 0 };
  }
  const plan = planImport(sub, agent, parsed.values, parsed.positionals);
  if ("message" in plan) return usage(plan.message);
  try {
    return await importSessions(host, agent, plan);
  } catch (error) {
    host.log.error(messageOf(error));
    return { code: 1 };
  }
}

/**
 * Print each agent's data location and whether it exists.
 *
 * @param {ThreadsHost} host
 * @param {boolean} json
 */
function detect(host, json) {
  const agents = Object.values(AGENTS).map(({ agent, defaultDir, where }) => {
    const found = where(defaultDir(host.env));
    return { agent, path: found, found: existsSync(found) };
  });
  if (json) {
    host.out(`${JSON.stringify({ agents })}\n`);
    return;
  }
  const rows = [["Agent", "Found", "Path"], ...agents.map((row) => [row.agent, row.found ? "found" : "missing", row.path])];
  const widths = [0, 1].map((column) => Math.max(...rows.map((row) => row[column].length)));
  host.out(`${rows.map((row) => `${row[0].padEnd(widths[0])}  ${row[1].padEnd(widths[1])}  ${row[2]}`).join("\n")}\n`);
}

/**
 * @typedef {object} ImportPlan
 * @property {string[]} ids
 * @property {boolean} all
 * @property {number} maxAge Days; 0 for no limit.
 * @property {number} limit
 * @property {boolean} dryRun
 * @property {boolean} reimport
 * @property {boolean} json
 * @property {string | undefined} dir
 */

/**
 * @param {string} command
 * @param {ImportAgent} agent
 * @param {Record<string, string | boolean | undefined>} values
 * @param {string[]} ids
 * @returns {ImportPlan | { message: string }}
 */
function planImport(command, agent, values, ids) {
  const all = values.all === true;
  if (!all && ids.length === 0) return { message: `threads import ${command} needs session ids or --all.` };
  if (all && ids.length > 0) return { message: `threads import ${command} takes session ids or --all, not both.` };
  const bad = ids.find((id) => !agent.idPattern.test(id));
  if (bad !== undefined) return { message: `${JSON.stringify(bad)} is not ${agent.idHint}.` };
  for (const name of ["max-age", "limit"]) {
    if (values[name] !== undefined && !all) return { message: `--${name} works only with --all.` };
  }
  const maxAge = String(values["max-age"] ?? MAX_AGE_DAYS);
  if (!/^\d+$/.test(maxAge)) return { message: `--max-age needs a whole number of days, not ${maxAge}.` };
  const limit = String(values.limit ?? "");
  if (values.limit !== undefined && (!/^\d+$/.test(limit) || Number(limit) < 1)) return { message: `--limit needs a whole number above 0, not ${limit}.` };
  return {
    ids: [...new Set(ids)],
    all,
    maxAge: Number(maxAge),
    limit: values.limit === undefined ? Number.POSITIVE_INFINITY : Number(limit),
    dryRun: values["dry-run"] === true,
    reimport: values.reimport === true,
    json: values.json === true,
    dir: typeof values[agent.dirOption] === "string" ? String(values[agent.dirOption]) : undefined,
  };
}

/**
 * Import an agent's conversations, one at a time; each written session is
 * recorded in the ledger before the next is read.
 *
 * @param {ThreadsHost} host
 * @param {ImportAgent} source
 * @param {ImportPlan} plan
 * @returns {Promise<{ code: number }>}
 */
async function importSessions(host, source, plan) {
  const dir = path.resolve(host.cwd, plan.dir ?? source.defaultDir(host.env));
  const reader = await source.open(dir, host);
  try {
    return importFrom(host, source, plan, dir, reader);
  } finally {
    reader.close?.();
  }
}

/**
 * @param {ThreadsHost} host
 * @param {ImportAgent} source
 * @param {ImportPlan} plan
 * @param {string} dir
 * @param {Awaited<ReturnType<ImportAgent["open"]>>} reader
 * @returns {{ code: number }}
 */
function importFrom(host, { agent, name, where }, plan, dir, reader) {
  const agentDir = piAgentDir(host.pi);
  const ledgerFile = importLedgerPath(agentDir);
  const ledger = readImportLedger(ledgerFile);
  const counts = { imported: 0, skipped: 0, failed: 0 };

  /** @param {ImportEvent} event */
  const report = (event) => {
    counts[event.type] += 1;
    if (plan.json) {
      host.out(`${JSON.stringify(event)}\n`);
      return;
    }
    const id = event.sourceId.replace(CONTROL, "");
    const reason = (event.reason ?? "").replace(CONTROL, " ");
    if (event.type === "imported") {
      const count = `${event.messages} ${event.messages === 1 ? "message" : "messages"}`;
      host.out(event.sessionId === undefined ? `Would import ${id} (${count})\n` : `Imported ${id} as ${event.sessionId} (${count})\n`);
    } else {
      host.out(`${event.type === "skipped" ? "Skipped" : "Failed"} ${id}: ${reason}\n`);
    }
  };

  const available = reader.sessions;
  /** @type {SourceSession[]} */
  let sources;
  if (plan.all) {
    const since = plan.maxAge === 0 ? Number.NEGATIVE_INFINITY : host.now() - plan.maxAge * DAY;
    sources = available
      .filter((source) => source.subagent !== true && source.modified.getTime() >= since)
      .sort((a, b) => b.modified.getTime() - a.modified.getTime() || a.id.localeCompare(b.id));
    if (sources.length === 0 && !plan.json) {
      const within = plan.maxAge === 0 ? "" : ` updated in the last ${plan.maxAge} ${plan.maxAge === 1 ? "day" : "days"}`;
      host.out(`No ${name} sessions${within} in ${where(dir)}.\n`);
    }
  } else {
    sources = [];
    for (const id of plan.ids) {
      const found = available.filter((source) => source.id === id);
      if (found.length === 1) sources.push(found[0]);
      else if (found.length === 0) report({ type: "failed", agent, sourceId: id, reason: `no ${name} session has this id in ${where(dir)}` });
      else report({ type: "failed", agent, sourceId: id, reason: `${found.length} ${name} sessions have this id: ${found.map((source) => source.file).join(", ")}` });
    }
  }

  let attempted = 0;
  for (const source of sources) {
    const key = importKey(agent, source.id);
    const record = Object.hasOwn(ledger, key) ? ledger[key] : undefined;
    // A record whose session file is gone (deleted since) no longer counts.
    const previous = record !== undefined && existsSync(record.sessionPath) ? record : undefined;
    if (previous !== undefined && !plan.reimport) {
      report({ type: "skipped", agent, sourceId: source.id, sessionId: previous.sessionId, reason: `already imported as ${previous.sessionId}; --reimport imports it again` });
      continue;
    }
    if (attempted >= plan.limit) break;
    attempted += 1;
    try {
      const conversion = reader.convert(source);
      if (!conversion.messages.some((message) => message.role === "user" || message.role === "assistant")) {
        report({ type: "skipped", agent, sourceId: source.id, reason: "it holds no messages to import" });
        continue;
      }
      if (conversion.cwd === undefined) throw new Error("it records no working directory");
      if (plan.dryRun) {
        report({ type: "imported", agent, sourceId: source.id, messages: conversion.messages.length });
        continue;
      }
      const importedAt = new Date(host.now()).toISOString();
      const written = writeSession(host, conversion, {
        agent,
        sourceId: source.id,
        sourcePath: source.file,
        sourceModified: source.modified.toISOString(),
        sourceStarted: conversion.started === undefined ? null : new Date(conversion.started).toISOString(),
        importedAt,
        formatVersion: IMPORT_FORMAT_VERSION,
      }, previous);
      ledger[key] = { sessionId: written.id, sessionPath: written.file, importedAt, sourceModified: source.modified.toISOString() };
      writeImportLedger(ledgerFile, ledger);
      try {
        const index = threadIndexPath(agentDir);
        const labels = validateThreadLabels([...(readThreadIndex(index)[written.id]?.labels ?? []), IMPORTED_LABEL, agent]);
        updateThreadRecord(index, written.id, { labels });
      } catch (error) {
        host.log.warn(`${source.id} was imported, but its labels were not stored in the thread index: ${messageOf(error)}`);
      }
      report({ type: "imported", agent, sourceId: source.id, sessionId: written.id, messages: conversion.messages.length });
    } catch (error) {
      report({ type: "failed", agent, sourceId: source.id, reason: messageOf(error) });
    }
  }

  if (plan.json) {
    host.out(`${JSON.stringify({ type: "summary", agent, ...counts, ...(plan.dryRun ? { dryRun: true } : {}) })}\n`);
  } else {
    const summary = `${name}: ${counts.imported} ${plan.dryRun ? "to import" : "imported"}, ${counts.skipped} skipped, ${counts.failed} failed.`;
    host.out(`${summary}${plan.dryRun ? " Nothing was written (--dry-run)." : ""}\n`);
  }
  return { code: counts.failed > 0 ? 1 : 0 };
}

/**
 * Write one converted conversation as a Pi session: the `ampi-import` entry
 * first, so the session is read-only from its first line, then the title,
 * then the messages. A session imported before is replaced under its id: the
 * old file is removed once the new one is complete, and a new file left
 * incomplete by an error is removed.
 *
 * @param {ThreadsHost} host
 * @param {import("./claude-code.js").Conversion} conversion
 * @param {Record<string, unknown>} provenance
 * @param {ImportRecord | undefined} previous
 * @returns {{ id: string, file: string }}
 */
function writeSession(host, conversion, provenance, previous) {
  const writer = createPiSessionWriter(host.pi, { cwd: /** @type {string} */ (conversion.cwd), env: host.env, id: previous?.sessionId });
  const file = writer.getSessionFile();
  try {
    writer.appendCustomEntry(IMPORT_ENTRY_TYPE, provenance);
    if (conversion.title !== undefined) writer.appendSessionInfo(conversion.title);
    for (const message of conversion.messages) writer.appendMessage(message);
  } catch (error) {
    if (file !== previous?.sessionPath && existsSync(file)) unlinkSync(file);
    throw error;
  }
  if (previous !== undefined && previous.sessionPath !== file) unlinkSync(previous.sessionPath);
  return { id: writer.getSessionId(), file };
}
