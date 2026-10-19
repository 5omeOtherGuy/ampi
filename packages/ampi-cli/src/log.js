// The command's own diagnostics and colour. Every `ampi: …` line the command
// writes about itself goes through a logger from this module, which filters
// it by level and sends it to stderr or a log file. Output the user asked for
// (help, command results, --timings, questions) and Pi's own lines do not.
import { appendFileSync } from "node:fs";
import path from "node:path";

/** The log levels, most severe first. A logger writes the lines at its level and above. */
export const LOG_LEVELS = /** @type {const} */ (["error", "warn", "info", "debug"]);

/**
 * @typedef {typeof LOG_LEVELS[number]} LogLevel
 *
 * @typedef {object} LogSettings
 * @property {LogLevel} level
 * @property {string} [file] Absolute path of the log file, or none for stderr.
 *
 * @typedef {object} Logger
 * @property {LogLevel} level
 * @property {(message: string) => void} error A failure or usage error.
 * @property {(message: string) => void} warn Something did not happen as asked, and the command goes on.
 * @property {(message: string) => void} info A note about what the command chose to do.
 * @property {(message: string) => void} debug Details for finding out why the command behaved as it did.
 */

/**
 * @param {unknown} value
 * @returns {value is LogLevel}
 */
export function isLogLevel(value) {
  return LOG_LEVELS.includes(/** @type {LogLevel} */ (value));
}

/**
 * The level and log file for a run: `--log-level` and `--log-file` win over
 * `AMPI_LOG_LEVEL` and `AMPI_LOG_FILE`; an empty variable counts as unset.
 * A relative file is resolved against `cwd`. An unknown level in
 * `AMPI_LOG_LEVEL` comes back as `error`, with the level `info` and the file,
 * so the usage error reaches the log file too.
 *
 * @param {{ logLevel?: string, logFile?: string }} options Read from the command line (argv.js checks the level).
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 * @returns {LogSettings & { error?: string }}
 */
export function readLogSettings({ logLevel, logFile }, env, cwd) {
  const wanted = logLevel ?? (env.AMPI_LOG_LEVEL || "info");
  const level = isLogLevel(wanted) ? wanted : "info";
  const file = logFile ?? (env.AMPI_LOG_FILE || undefined);
  const settings = file === undefined ? { level } : { level, file: path.resolve(cwd, file) };
  return level === wanted ? settings : { ...settings, error: `AMPI_LOG_LEVEL must be error, warn, info or debug, not "${wanted}".` };
}

/**
 * A logger. Without a file, each message goes to stderr as `ampi: <message>`.
 * With a file, each message is appended to it as one line, `<ISO time>
 * <level> <message>` with line breaks written as `\n`, in a file created with
 * mode 0600; errors also go to stderr, so a failing command is never silent.
 * If the file cannot be written, the logger says so once on stderr and writes
 * the rest of the run there.
 *
 * @param {Partial<LogSettings> & { stderr?: (text: string) => void, now?: () => Date }} [settings]
 * @returns {Logger}
 */
export function createLogger({ level = "info", file, stderr = (text) => process.stderr.write(text), now = () => new Date() } = {}) {
  const limit = LOG_LEVELS.indexOf(level);
  let target = file;
  /**
   * @param {LogLevel} lineLevel
   * @param {string} message
   */
  const write = (lineLevel, message) => {
    if (LOG_LEVELS.indexOf(lineLevel) > limit) return;
    if (target !== undefined) {
      try {
        appendFileSync(target, `${now().toISOString()} ${lineLevel} ${message.replaceAll("\n", "\\n")}\n`, { mode: 0o600 });
        if (lineLevel === "error") stderr(`ampi: ${message}\n`);
        return;
      } catch (error) {
        stderr(`ampi: could not write the log file ${target}, so diagnostics go to stderr: ${error instanceof Error ? error.message : String(error)}\n`);
        target = undefined;
      }
    }
    stderr(`ampi: ${message}\n`);
  };
  return {
    level,
    error: (message) => write("error", message),
    warn: (message) => write("warn", message),
    info: (message) => write("info", message),
    debug: (message) => write("debug", message),
  };
}

/**
 * Whether the command's own output uses colour: not with `--no-color`, always
 * with `--color`, otherwise not when `NO_COLOR` is set to a non-empty value,
 * and else only when stdout and stderr are both terminals.
 *
 * @param {{ color?: boolean, env: NodeJS.ProcessEnv, stdoutIsTTY: boolean, stderrIsTTY: boolean }} input
 *   `color` is true for `--color`, false for `--no-color`, undefined for neither.
 * @returns {boolean}
 */
export function useColor({ color, env, stdoutIsTTY, stderrIsTTY }) {
  if (color !== undefined) return color;
  if (env.NO_COLOR) return false;
  return stdoutIsTTY && stderrIsTTY;
}

/**
 * Hand `--color` or `--no-color` on to Pi and the tools it runs through the
 * environment they inherit: `--no-color` sets `NO_COLOR=1` and removes
 * `FORCE_COLOR`, `--color` sets `FORCE_COLOR=1` and removes `NO_COLOR`.
 * Without either flag the environment stays as it is.
 *
 * @param {boolean | undefined} color
 * @param {NodeJS.ProcessEnv} env Changed in place.
 */
export function applyColorToEnv(color, env) {
  if (color === false) {
    env.NO_COLOR = "1";
    delete env.FORCE_COLOR;
  } else if (color === true) {
    env.FORCE_COLOR = "1";
    delete env.NO_COLOR;
  }
}
