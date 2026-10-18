// Execute mode (`ampi -x`): one prompt through Pi's print mode, the final
// assistant message on stdout and everything else on stderr. Also the inline
// extension that applies --title, -l and the execute-mode archive to the
// session through ampi's thread index.

export const EXECUTE_NO_MESSAGE_ERROR =
  "execute mode needs a message: pass it as an argument, on stdin, or both (for example: git diff | ampi -x \"review this\").";

/**
 * The global ampi-core registers the thread index under (see
 * `src/extensions/ampi-core/thread-index.ts`). ampi ships TypeScript that only
 * Pi's loader can import, so the command reads the registration directly.
 */
const THREAD_INDEX_GLOBAL_KEY = "__pi_ampi_thread_index_v1__";

/** Stands in for an argument while finding which one Pi reads as the first message. */
const PROBE = "\u0000ampi-message-probe";

/**
 * @typedef {object} PiParsedArgs The parts of Pi's `parseArgs()` result this module reads.
 * @property {string[]} messages
 * @property {string[]} fileArgs
 * @property {boolean} [print]
 * @property {string} [mode]
 * @property {string} [export]
 * @property {string | boolean} [listModels]
 * @property {boolean} [help]
 * @property {boolean} [version]
 *
 * @typedef {(args: string[]) => PiParsedArgs} PiParseArgs
 */

/**
 * Whether the run is execute mode: `-x`, or a run in which Pi would choose its
 * print mode on its own (stdin or stdout is not a terminal and no Pi output
 * mode, export, model listing or help was asked for).
 *
 * @param {{ explicit: boolean, parsed: PiParsedArgs, stdinIsTTY: boolean, stdoutIsTTY: boolean }} input
 * @returns {boolean}
 */
export function isExecuteRun({ explicit, parsed, stdinIsTTY, stdoutIsTTY }) {
  if (explicit) return true;
  if (parsed.print || parsed.mode !== undefined || parsed.export !== undefined) return false;
  if (parsed.listModels !== undefined || parsed.help || parsed.version) return false;
  return !stdinIsTTY || !stdoutIsTTY;
}

/**
 * Index of the argument Pi reads as the first message, or -1. Found by
 * replacing each candidate with a probe and asking Pi's own parser, so option
 * values that happen to equal the message are never taken for it.
 *
 * @param {PiParseArgs} parseArgs
 * @param {string[]} args
 * @returns {number}
 */
function firstMessageIndex(parseArgs, args) {
  const first = parseArgs(args).messages[0];
  if (first === undefined) return -1;
  return args.findIndex((arg, index) => {
    if (arg !== first) return false;
    const probe = [...args];
    probe[index] = PROBE;
    return parseArgs(probe).messages[0] === PROBE;
  });
}

/**
 * Pi's arguments for an execute run. The message is the first message
 * argument, then a newline, then stdin; either part may be missing, but not
 * both (an `@file` argument also counts as a message).
 *
 * @param {PiParseArgs} parseArgs Pi's argument parser.
 * @param {string[]} piArgs Arguments routed to Pi.
 * @param {string | undefined} stdinText Everything read from stdin, or `undefined` when stdin is a terminal.
 * @returns {{ args: string[] } | { error: string }}
 */
export function buildExecuteArgs(parseArgs, piArgs, stdinText) {
  // Trimmed, as Pi trims piped stdin.
  const stdin = stdinText?.trim() || undefined;
  const args = [...piArgs];
  const index = firstMessageIndex(parseArgs, args);
  if (index === -1 && stdin === undefined && parseArgs(args).fileArgs.length === 0) {
    return { error: EXECUTE_NO_MESSAGE_ERROR };
  }
  if (stdin !== undefined) {
    if (index !== -1) {
      // Same first character, so Pi still reads it as the same message.
      args[index] = `${args[index]}\n${stdin}`;
    } else {
      if (!args.includes("--")) args.push("--");
      // Pi reads an argument starting with @ as a file to attach, even after --.
      args.push(stdin.startsWith("@") ? ` ${stdin}` : stdin);
    }
  }
  return { args: ["--print", ...args] };
}

/**
 * Read a stream to its end as UTF-8 text.
 *
 * @param {NodeJS.ReadableStream} stream
 * @returns {Promise<string>}
 */
export async function readAll(stream) {
  stream.setEncoding("utf8");
  let text = "";
  for await (const chunk of stream) text += chunk;
  return text;
}

/**
 * @typedef {object} RunExtensionOptions
 * @property {string[]} labels `-l` values, added to the session's labels in the thread index.
 * @property {boolean} titled Whether `--title` named the session; the index then records the title as the user's.
 * @property {boolean} archive Archive the session in the thread index when the run ends.
 * @property {boolean} timings Write the startup, turn and total durations to stderr when the run ends.
 *
 * @typedef {object} RunExtensionHost
 * @property {() => number} now Milliseconds since the command started.
 * @property {() => string} timestamp The archive date (ISO 8601).
 * @property {(text: string) => void} warn Writes a line to stderr.
 */

/** @type {RunExtensionHost} */
const DEFAULT_HOST = {
  now: () => performance.now(),
  timestamp: () => new Date().toISOString(),
  warn: (text) => process.stderr.write(`${text}\n`),
};

/** @param {unknown} error */
const messageOf = (error) => (error instanceof Error ? error.message : String(error));

/**
 * The inline Pi extension that applies the command's thread options. Labels
 * and the title source go to the first session at its start; the archive and
 * the timings happen when the run ends. Without ampi-threads (the thread index
 * is not registered) labels are reported as not stored and nothing is archived.
 *
 * @param {RunExtensionOptions} options
 * @param {RunExtensionHost} [host]
 * @returns {(pi: any) => void}
 */
export function createRunExtension(options, host = DEFAULT_HOST) {
  return (pi) => {
    /** @type {{ get(id: string): Promise<any>, update(id: string, patch: object): Promise<any> } | undefined} */
    let index;
    let started = false;
    /** @type {number | undefined} */
    let turnStart;
    /** @type {number | undefined} */
    let turnEnd;

    pi.on("session_start", async (/** @type {unknown} */ _event, /** @type {any} */ ctx) => {
      if (started) return;
      started = true;
      // Kept for the end of the run: ampi-threads unregisters it at shutdown.
      index = /** @type {any} */ (globalThis)[THREAD_INDEX_GLOBAL_KEY]?.at(-1);
      if (options.labels.length === 0 && !options.titled) return;
      if (index === undefined) {
        if (options.labels.length > 0) host.warn("ampi: the thread index is off (ampi-threads is not loaded); the labels were not stored.");
        return;
      }
      const sessionId = ctx.sessionManager.getSessionId();
      try {
        const record = await index.get(sessionId);
        /** @type {Record<string, unknown>} */
        const patch = {};
        if (options.labels.length > 0) patch.labels = [...new Set([...(record?.labels ?? []), ...options.labels])];
        if (options.titled) patch.titleSource = "user";
        await index.update(sessionId, patch);
      } catch (error) {
        host.warn(`ampi: could not store the labels and title in the thread index: ${messageOf(error)}`);
      }
    });

    if (options.timings) {
      pi.on("agent_start", () => {
        turnStart ??= host.now();
      });
      pi.on("agent_end", () => {
        turnEnd = host.now();
      });
    }

    pi.on("session_shutdown", async (/** @type {unknown} */ _event, /** @type {any} */ ctx) => {
      if (options.archive && index !== undefined) {
        const sessionId = ctx.sessionManager.getSessionId();
        const hasMessages = ctx.sessionManager.getEntries().some((/** @type {any} */ entry) => entry.type === "message");
        try {
          if (hasMessages && (await index.get(sessionId))?.archived === undefined) {
            await index.update(sessionId, { archived: host.timestamp() });
          }
        } catch (error) {
          host.warn(`ampi: could not archive the session: ${messageOf(error)}`);
        }
      }
      if (options.timings) {
        const parts = [];
        if (turnStart !== undefined) parts.push(`startup ${Math.round(turnStart)} ms`);
        if (turnStart !== undefined && turnEnd !== undefined) parts.push(`turn ${Math.round(turnEnd - turnStart)} ms`);
        parts.push(`total ${Math.round(host.now())} ms`);
        host.warn(`ampi: timings: ${parts.join(", ")}`);
      }
    });
  };
}
