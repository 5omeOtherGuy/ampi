// Argument routing for the `ampi` command. Pure: reads nothing and prints
// nothing, so every translation is testable without starting Pi.
import { parseArgs } from "node:util";

/**
 * @typedef {"help" | "version" | "pi" | "pi-command" | "error"} AmpiCommand
 *
 * @typedef {object} AmpiOptions
 * @property {string} [mode] ampi mode from `-m`/`--mode`, forwarded as `--ampi-mode`.
 * @property {string} [title] `--title`, accepted and not applied yet.
 * @property {string[]} labels `-l`/`--label` values, accepted and not applied yet.
 *
 * @typedef {object} AmpiRoute
 * @property {AmpiCommand} command What the bin does: print help, print versions, start Pi with
 *   ampi, run one of Pi's own commands, or fail.
 * @property {string[]} piArgs Arguments handed to Pi's `main()` when `command` is `"pi"`.
 * @property {AmpiOptions} options ampi options read from the command line.
 * @property {string[]} notices One-line messages for stderr before Pi starts.
 * @property {string} [error] Usage error, set when `command` is `"error"`.
 */

/** Values of Pi's own `--mode` (output format); these keep Pi's meaning. */
const PI_OUTPUT_MODES = new Set(["text", "json", "rpc"]);

/** Pi's own commands. Pi recognises them only as the first argument and rejects options it does not know. */
const PI_COMMANDS = new Set(["install", "remove", "uninstall", "update", "list", "config", "auth", "mcp"]);

const OPTIONS = /** @type {const} */ ({
  mode: { type: "string", short: "m" },
  title: { type: "string" },
  label: { type: "string", short: "l", multiple: true },
  "settings-file": { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
  "pi-help": { type: "boolean" },
});

/**
 * Pi's options that always take the next argument as their value. Declaring
 * them keeps that value away from ampi's own options: in
 * `--append-system-prompt -v`, `-v` is the prompt, not a version request.
 */
const PI_VALUE_OPTIONS = /** @type {const} */ ({
  provider: { type: "string" },
  model: { type: "string" },
  "api-key": { type: "string" },
  "system-prompt": { type: "string" },
  "append-system-prompt": { type: "string" },
  name: { type: "string", short: "n" },
  session: { type: "string" },
  "session-id": { type: "string" },
  fork: { type: "string" },
  "session-dir": { type: "string" },
  models: { type: "string" },
  tools: { type: "string", short: "t" },
  "exclude-tools": { type: "string" },
  thinking: { type: "string" },
  export: { type: "string" },
  extension: { type: "string", short: "e" },
  skill: { type: "string" },
  "prompt-template": { type: "string" },
  theme: { type: "string" },
});

const SETTINGS_FILE_ERROR =
  "--settings-file is not supported: Pi reads settings.json from its configuration directory and the project's .pi/ directory. " +
  "Set PI_CODING_AGENT_DIR to use another configuration directory.";

/**
 * Split the `ampi` command line into ampi's own commands and options and the
 * arguments Pi receives. Unknown options and positionals reach Pi unchanged and
 * in order; everything after `--` reaches Pi verbatim. One of Pi's own commands
 * as the first argument hands the whole command line to Pi untouched.
 *
 * @param {readonly string[]} argv Arguments after the executable and script.
 * @returns {AmpiRoute}
 */
export function routeAmpiArgv(argv) {
  const args = [...argv];
  /** @type {AmpiOptions} */
  const options = { labels: [] };
  if (args[0] === "help") return { command: "help", piArgs: [], options, notices: [] };
  if (args[0] === "version") return { command: "version", piArgs: [], options, notices: [] };
  if (PI_COMMANDS.has(args[0] ?? "")) return { command: "pi-command", piArgs: args, options, notices: [] };

  const { tokens } = parseArgs({
    args,
    options: { ...PI_VALUE_OPTIONS, ...OPTIONS },
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  /** @type {Map<number, number>} */
  const optionsPerArg = new Map();
  for (const token of tokens) {
    if (token.kind === "option") optionsPerArg.set(token.index, (optionsPerArg.get(token.index) ?? 0) + 1);
  }

  /** @type {string[]} */
  const piArgs = [];
  /** @type {Set<number>} */
  const passed = new Set();
  /** @param {number} index */
  const passRaw = (index) => {
    if (passed.has(index) || index >= args.length) return;
    passed.add(index);
    piArgs.push(args[index]);
  };
  /** @type {Set<string>} */
  const ignored = new Set();
  let help = false;
  let version = false;
  /** @type {string | undefined} */
  let error;

  for (const token of tokens) {
    if (token.kind === "option-terminator") {
      for (let index = token.index; index < args.length; index++) passRaw(index);
      break;
    }
    if (token.kind === "positional") {
      passRaw(token.index);
      continue;
    }
    // A group of short flags such as `-ne` is Pi's, not ampi's: pass it as written.
    const ours = (optionsPerArg.get(token.index) ?? 0) === 1 && (token.name in OPTIONS || token.rawName === "-v");
    if (!ours) {
      passRaw(token.index);
      if (token.inlineValue === false) passRaw(token.index + 1);
      continue;
    }
    const value = token.value;
    switch (token.name) {
      case "help":
        help = true;
        break;
      case "version":
      case "v":
        version = true;
        break;
      case "pi-help":
        piArgs.push("--help");
        break;
      case "settings-file":
        error ??= SETTINGS_FILE_ERROR;
        break;
      case "mode":
        if (value === undefined) {
          error ??= `${token.rawName} needs a mode, for example ${token.rawName} high.`;
        } else if (token.rawName === "--mode" && PI_OUTPUT_MODES.has(value)) {
          passRaw(token.index);
          if (token.inlineValue === false) passRaw(token.index + 1);
        } else {
          options.mode = value;
          piArgs.push("--ampi-mode", value);
        }
        break;
      case "title":
        if (value === undefined) error ??= "--title needs a value.";
        else options.title = value;
        ignored.add("--title");
        break;
      case "label":
        if (value === undefined) error ??= `${token.rawName} needs a value.`;
        else options.labels.push(value);
        ignored.add("--label");
        break;
    }
  }

  const notices = [...ignored].map((flag) => `ampi: ${flag} is accepted but not applied yet; it was ignored.`);
  if (error !== undefined) return { command: "error", piArgs: [], options, notices: [], error };
  if (help) return { command: "help", piArgs: [], options, notices: [] };
  if (version) return { command: "version", piArgs: [], options, notices: [] };
  return { command: "pi", piArgs, options, notices };
}

/**
 * The text `ampi --help` prints. Lists only what the command supports today.
 *
 * @returns {string}
 */
export function formatAmpiHelp() {
  return `ampi: Pi with the ampi extensions, started with Amp-compatible options

Usage: ampi [options] [command] [message...]

Commands:

  help                          Print this help and exit
  version                       Print the ampi-cli, ampi and Pi versions and exit

  Pi's own commands (install, remove, uninstall, update, list, config, auth, mcp) run
  unchanged, without ampi's options.

Options:

  -m, --mode <mode>
      Start in an ampi mode: low, medium, high, ultra or free (rush, smart, deep and fable are
      accepted as aliases). --mode text, json and rpc keep Pi's meaning (output format).
  --title <title>
      Accepted for compatibility; not applied yet.
  -l, --label <label>
      Accepted for compatibility; not applied yet. Repeat the flag for several labels.
  -h, --help
      Print this help and exit
  -V, -v, --version
      Print the versions and exit
  --pi-help
      Print Pi's own options, including the flags ampi's extensions add
  --
      Hand everything after it to Pi as the message, without reading ampi options

  Every other option and argument goes to Pi unchanged, for example --model, -c, -r or -p.

Environment variables:

  PI_CODING_AGENT_DIR           Pi's configuration directory (default ~/.pi/agent): settings,
                                sessions and installed packages
  PI_OFFLINE                    Set to 1 to start without network activity such as model
                                catalogue refreshes

Examples:

Open a session:

  $ ampi

Open a session in high mode:

  $ ampi -m high

Open a session and send a first message:

  $ ampi "explain how the build scripts fit together"

Pick up the latest session in this directory:

  $ ampi -c
`;
}
