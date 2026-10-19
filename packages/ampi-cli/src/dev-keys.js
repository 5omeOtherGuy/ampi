// `ampi dev keys`: read key presses and print, one JSON line per input chunk,
// the keys ampi's key parser reads and what ampi's keymap would do with them.
// It never runs a command and needs no model, session or credentials.
import { existsSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { parseArgs } from "node:util";
import * as tui from "@earendil-works/pi-tui";
import { createPiInputSplitter, loadThroughPi, readPiSettings } from "./pi-compat.js";

/**
 * @typedef {object} DevKeysTerminal The terminal in Pi's input mode (see `createPiInputTerminal`).
 * @property {(onInput: (chunk: string) => void) => void} start
 * @property {(maxMs: number) => Promise<void>} drain
 * @property {() => void} stop
 *
 * @typedef {object} DevKeysHost
 * @property {any} pi The `@earendil-works/pi-coding-agent` module.
 * @property {string} cwd
 * @property {() => Promise<{ root: string, version?: string } | undefined>} locateAmpi The ampi package
 *   the key reader comes from: the one Pi loads from its settings, else the CLI's own.
 * @property {NodeJS.ReadableStream} stdin Read when it is not a terminal; watched for its end when it is.
 * @property {boolean} stdinIsTTY
 * @property {boolean} stdoutIsTTY
 * @property {() => number} now Milliseconds, for the double Ctrl+C and the keymap's chord deadlines.
 * @property {() => DevKeysTerminal} createTerminal
 * @property {(stop: (signal: "SIGTERM" | "SIGHUP") => void) => () => void} [onSignal] Call `stop` on
 *   SIGTERM or SIGHUP while the terminal is in Pi's input mode; returns the function that stops listening.
 * @property {(text: string) => void} out Writes to stdout.
 * @property {import("./log.js").Logger} log For the command's diagnostics.
 * @property {(text: string) => void} progress Writes the start line to stderr: progress shown at every log level.
 *
 * @typedef {{ keys: string[], event?: string, command?: string | null, pending?: string | null, paste?: true, unknown?: true }} DevKeyRecord
 *   One line, as the key reader of `src/cli-dev-keys.ts` reports it.
 *
 * @typedef {{ problems: readonly string[], feed: (chunk: string) => DevKeyRecord }} DevKeyReader
 * @typedef {(options: { settings?: unknown, cwd?: string, keymap: boolean, now: () => number }) => DevKeyReader} DevKeyReaderFactory
 */

/**
 * The file in the ampi package whose extension factory hands over the key
 * reader, and the event it uses (`MMR_CLI_DEV_KEYS_EVENT` there).
 */
const DEV_KEYS_ENTRY = path.join("src", "cli-dev-keys.ts");
const DEV_KEYS_EVENT = "ampi:cli-dev-keys";

export const OPTIONS = /** @type {const} */ ({
  raw: { type: "boolean" },
  "no-keymap": { type: "boolean" },
  help: { type: "boolean", short: "h" },
});

/** The second Ctrl+C quits when it comes less than this many milliseconds after the first. */
const DOUBLE_CTRL_C_MS = 1000;
/** How long the terminal swallows late input after the exit keys, as Pi waits before it stops. */
const DRAIN_MS = 1000;
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGTERM: 143 };

/**
 * The text `ampi dev keys --help` prints.
 *
 * @returns {string}
 */
export function formatDevKeysHelp() {
  return `ampi dev keys: show how ampi reads each key press

Usage: ampi dev keys [--raw] [--no-keymap]

Puts the terminal into the input mode of ampi's terminal UI and prints one JSON line for each
key sequence the terminal sends: the keys ampi reads, the event the terminal reported, the
command id ampi's keymap would run and the leader or chord prefix it would wait on. Nothing
runs. Press Ctrl+C twice within a second, or Ctrl+D, to quit.

Options:

  --raw                         Add "raw": the input as received, as a JSON string
  --no-keymap                   Print only the keys and the event; the keymap is not read
  -h, --help                    Print this help and exit

Lines:

  {"keys":["ctrl+x"],"event":"press","command":null,"pending":"ctrl+x"}
  {"keys":["ctrl+s"],"event":"press","command":"mode.toggle","pending":null}
  {"keys":[],"paste":true}       a bracketed paste; its text is printed only with --raw
  {"keys":[],"unknown":true}     input that is not a key ampi knows

"event" is press, repeat or release; repeats and releases come only from terminals that
speak the kitty keyboard protocol, and a release never runs a command. The keymap is the
one ampi config keymap prints, with every command treated as available and the prompt as
focused: a lone Esc waits for a second Esc, as while a turn runs.

When stdin is not a terminal, the input is read from it instead, split into key sequences
the same way, and the command exits at its end; the exit keys work there too. stdout must
be a terminal when stdin is one; to keep the lines, copy them or replay recorded input.

Exit status: 0 on the exit keys or at the end of the input, 1 when ampi's key reader cannot
be loaded, 2 on a usage error, and 128 plus the signal number (143 on SIGTERM, 129 on
SIGHUP) after restoring the terminal.

Examples:

  $ ampi dev keys --raw
  $ printf '\\x18t' | ampi dev keys
  $ jq -j .raw keys.jsonl | ampi dev keys
`;
}

/**
 * Run `ampi dev keys`.
 *
 * @param {readonly string[]} argv The command line after `dev keys`.
 * @param {DevKeysHost} host
 * @returns {Promise<number>} The exit code.
 */
export async function runDevKeysCommand(argv, host) {
  /** @type {{ raw?: boolean, "no-keymap"?: boolean, help?: boolean }} */
  let values;
  try {
    ({ values } = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: false, strict: true }));
  } catch (error) {
    host.log.error(`dev keys: ${error instanceof Error ? error.message : String(error)}\nRun ampi dev keys --help for the options.`);
    return 2;
  }
  if (values.help) {
    host.out(formatDevKeysHelp());
    return 0;
  }
  if (host.stdinIsTTY && !host.stdoutIsTTY) {
    host.log.error(
      "dev keys: stdout must be the terminal too, since the terminal's input mode is set through it; " +
        "copy the lines from the terminal, or pipe recorded input into ampi dev keys.",
    );
    return 2;
  }

  const createKeyReader = await loadKeyReaderFactory(host);
  if (createKeyReader === undefined) return 1;
  const keymap = values["no-keymap"] !== true;
  const reader = keymap
    ? createKeyReader({ settings: readPiSettings(host.pi, host.cwd), cwd: host.cwd, keymap: true, now: host.now })
    : createKeyReader({ keymap: false, now: host.now });
  for (const problem of reader.problems) host.log.warn(`keymap: ${problem}`);

  /** @type {number | undefined} When the last Ctrl+C was pressed, while no other key came after it. */
  let ctrlCAt;
  /**
   * Print the line for one chunk.
   *
   * @param {string} chunk
   * @returns {boolean} Whether the chunk is an exit key.
   */
  const read = (chunk) => {
    const record = reader.feed(chunk);
    host.out(`${JSON.stringify(values.raw ? { ...record, raw: chunk } : record)}\n`);
    if (record.event === "release") return false;
    const key = record.keys.length === 1 ? record.keys[0] : undefined;
    if (key === "ctrl+d") return true;
    if (key !== "ctrl+c") {
      ctrlCAt = undefined;
      return false;
    }
    const now = host.now();
    if (ctrlCAt !== undefined && now - ctrlCAt < DOUBLE_CTRL_C_MS) return true;
    ctrlCAt = now;
    return false;
  };
  return host.stdinIsTTY ? readTerminal(host, read) : readStream(host, read);
}

/**
 * Load the key reader from the ampi in use, or say why it cannot be loaded.
 *
 * @param {DevKeysHost} host
 * @returns {Promise<DevKeyReaderFactory | undefined>}
 */
async function loadKeyReaderFactory(host) {
  const ampi = await host.locateAmpi();
  const tooOld = () => {
    const which = ampi?.version === undefined ? "the ampi package" : `ampi ${ampi.version}`;
    host.log.error(`${which} is too old for dev keys; update @skippermissions/ampi (or ampi-cli).`);
  };
  const entry = ampi === undefined ? undefined : path.join(ampi.root, DEV_KEYS_ENTRY);
  if (entry === undefined || !existsSync(entry)) {
    tooOld();
    return undefined;
  }
  /** @type {DevKeyReaderFactory | undefined} */
  let factory;
  try {
    const received = /** @type {{ createKeyReader?: DevKeyReaderFactory } | undefined} */ (await loadThroughPi(host.pi, entry, DEV_KEYS_EVENT));
    factory = received?.createKeyReader;
  } catch (error) {
    host.log.error(`could not load ampi's dev keys: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  if (typeof factory !== "function") {
    tooOld();
    return undefined;
  }
  return factory;
}

/**
 * Read key presses from the terminal in Pi's input mode until the exit keys,
 * the end of stdin, a signal or an error, and restore the terminal on each.
 *
 * @param {DevKeysHost} host
 * @param {(chunk: string) => boolean} read
 * @returns {Promise<number>}
 */
function readTerminal(host, read) {
  const terminal = host.createTerminal();
  return new Promise((resolve) => {
    let done = false;
    /** @type {() => void} */
    let unwatch = () => {};
    /**
     * @param {number} code
     * @param {boolean} drain Swallow late input first, as Pi does when it quits.
     */
    const finish = async (code, drain) => {
      if (done) return;
      done = true;
      host.stdin.removeListener("end", onEnd);
      try {
        if (drain) await terminal.drain(DRAIN_MS);
      } finally {
        terminal.stop();
        // Watched until here, so a signal during the drain cannot kill the
        // process with the terminal still in raw mode.
        unwatch();
        resolve(code);
      }
    };
    const onEnd = () => void finish(0, false);
    host.stdin.once("end", onEnd);
    unwatch = host.onSignal?.((signal) => void finish(SIGNAL_EXIT_CODES[signal], false)) ?? unwatch;
    host.progress("ampi dev keys: press keys to see how ampi reads them; Ctrl+C twice or Ctrl+D quits.\n");
    try {
      terminal.start((chunk) => {
        if (done) return;
        try {
          if (read(chunk)) void finish(0, true);
        } catch (error) {
          host.log.error(`dev keys: ${error instanceof Error ? error.message : String(error)}`);
          void finish(1, false);
        }
      });
    } catch (error) {
      host.log.error(`dev keys: could not set up the terminal: ${error instanceof Error ? error.message : String(error)}`);
      void finish(1, false);
    }
  });
}

/**
 * Read recorded input from stdin, split into key sequences as Pi's terminal
 * splits them, until its end or the exit keys.
 *
 * @param {DevKeysHost} host
 * @param {(chunk: string) => boolean} read
 * @returns {Promise<number>}
 */
function readStream(host, read) {
  const { stdin } = host;
  const decoder = new StringDecoder("utf8");
  return new Promise((resolve) => {
    let done = false;
    /** @param {number} code */
    const finish = (code) => {
      if (done) return;
      done = true;
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("error", onError);
      splitter.end();
      stdin.pause();
      resolve(code);
    };
    const splitter = createPiInputSplitter(tui, (chunk) => {
      if (done) return;
      try {
        if (read(chunk)) finish(0);
      } catch (error) {
        host.log.error(`dev keys: ${error instanceof Error ? error.message : String(error)}`);
        finish(1);
      }
    });
    /** @param {string | Buffer} data */
    const onData = (data) => splitter.write(typeof data === "string" ? data : decoder.write(data));
    const onEnd = () => {
      const rest = decoder.end();
      if (rest !== "") splitter.write(rest);
      // What the buffer still holds (a lone Esc, say) is read before the end.
      splitter.end();
      finish(0);
    };
    /** @param {Error} error */
    const onError = (error) => {
      host.log.error(`dev keys: could not read stdin: ${error.message}`);
      finish(1);
    };
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", onError);
  });
}
