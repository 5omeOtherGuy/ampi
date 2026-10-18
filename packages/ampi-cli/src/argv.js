// Argument routing for the `ampi` command. Pure: reads nothing and prints
// nothing, so every translation is testable without starting Pi.
import { parseArgs } from "node:util";

/**
 * @typedef {"help" | "version" | "threads" | "config" | "pi" | "pi-command" | "error"} AmpiCommand
 *
 * @typedef {object} AmpiOptions
 * @property {string} [mode] ampi mode from `-m`/`--mode`, forwarded as `--ampi-mode`.
 * @property {string} [title] `--title`, forwarded as Pi's `--name`.
 * @property {string[]} labels `-l`/`--label` values, stored in the thread index once the session starts.
 * @property {boolean} execute `-x`/`--execute`: run one prompt and print the final assistant message.
 * @property {boolean} timings `--timings`: report durations on stderr (execute mode).
 * @property {boolean} archive Archive the session after execute mode; `--no-archive-after-execute` turns it off.
 * @property {boolean} streamJson `--stream-json`: print stream JSON records instead of the final message (execute mode).
 * @property {boolean} streamJsonThinking `--stream-json-thinking`: `--stream-json` with thinking blocks.
 * @property {boolean} streamJsonInput `--stream-json-input`: read the messages from stdin as JSON lines (stream JSON only).
 *
 * @typedef {object} AmpiRoute
 * @property {AmpiCommand} command What the bin does: print help, print versions, start Pi with
 *   ampi, run one of Pi's own commands, or fail.
 * @property {string[]} piArgs Arguments handed to Pi's `main()` when `command` is `"pi"`.
 * @property {string[]} [threadArgs] The command line from `threads` or `last` on, when `command` is `"threads"`.
 * @property {string[]} [configArgs] The command line after `config`, when `command` is `"config"`.
 * @property {AmpiOptions} options ampi options read from the command line.
 * @property {string} [error] Usage error, set when `command` is `"error"`.
 */

/** Values of Pi's own `--mode` (output format); these keep Pi's meaning. */
const PI_OUTPUT_MODES = new Set(["text", "json", "rpc"]);

/** Pi's own commands. Pi recognises them only as the first argument and rejects options it does not know. */
const PI_COMMANDS = new Set(["install", "remove", "uninstall", "update", "list", "config", "auth", "mcp"]);

/** The `config` subcommands ampi runs itself. */
const CONFIG_COMMANDS = new Set(["keymap", "edit"]);

const OPTIONS = /** @type {const} */ ({
  mode: { type: "string", short: "m" },
  title: { type: "string" },
  label: { type: "string", short: "l", multiple: true },
  execute: { type: "boolean", short: "x" },
  timings: { type: "boolean" },
  "no-archive-after-execute": { type: "boolean" },
  "stream-json": { type: "boolean" },
  "stream-json-thinking": { type: "boolean" },
  "stream-json-input": { type: "boolean" },
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
  const options = {
    labels: [],
    execute: false,
    timings: false,
    archive: true,
    streamJson: false,
    streamJsonThinking: false,
    streamJsonInput: false,
  };
  if (args[0] === "help") return { command: "help", piArgs: [], options };
  if (args[0] === "version") return { command: "version", piArgs: [], options };
  if (args[0] === "threads" || args[0] === "last") return { command: "threads", piArgs: [], options, threadArgs: args };
  // `config keymap` and `config edit` are ampi's; every other `config` command line is Pi's.
  if (args[0] === "config" && CONFIG_COMMANDS.has(args[1] ?? "")) {
    return { command: "config", piArgs: [], options, configArgs: args.slice(1) };
  }
  if (PI_COMMANDS.has(args[0] ?? "")) return { command: "pi-command", piArgs: args, options };

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
        if (value === undefined) {
          error ??= "--title needs a value.";
        } else {
          options.title = value;
          piArgs.push("--name", value);
        }
        break;
      case "label":
        if (value === undefined) error ??= `${token.rawName} needs a value.`;
        else options.labels.push(value);
        break;
      case "execute":
        options.execute = true;
        break;
      case "timings":
        options.timings = true;
        break;
      case "no-archive-after-execute":
        options.archive = false;
        break;
      case "stream-json":
        options.streamJson = true;
        break;
      case "stream-json-thinking":
        options.streamJson = true;
        options.streamJsonThinking = true;
        break;
      case "stream-json-input":
        options.streamJsonInput = true;
        break;
    }
  }
  if (options.streamJsonInput && !options.streamJson) error ??= "--stream-json-input needs --stream-json or --stream-json-thinking.";

  if (error !== undefined) return { command: "error", piArgs: [], options, error };
  if (help) return { command: "help", piArgs: [], options };
  if (version) return { command: "version", piArgs: [], options };
  return { command: "pi", piArgs, options };
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
  threads [command]             Create, list, open, print, change or delete sessions;
                                ampi threads --help lists the commands
  last                          Open the most recent session of this directory that is not archived
  config keymap                 Print every command id with its keys as JSONC
  config edit [--workspace]     Open Pi's settings file, or this project's, in your editor

  Pi's own commands (install, remove, uninstall, update, list, config, auth, mcp) run
  unchanged, without ampi's options; config keymap and config edit are ampi's.

Options:

  -m, --mode <mode>
      Start in an ampi mode: low, medium, high, ultra or free (rush, smart, deep and fable are
      accepted as aliases). --mode text, json and rpc keep Pi's meaning (output format).
  -x, --execute
      Run the message once without the terminal UI, print only the final assistant message
      and exit. The message is the argument, stdin, or the argument, a newline and stdin.
      Implied when stdin or stdout is not a terminal.
  --stream-json
      In execute mode, print stream JSON (one JSON record per line, compatible with Claude
      Code's stream-json output) instead of the final message
  --stream-json-thinking
      --stream-json with the model's thinking blocks included
  --stream-json-input
      With --stream-json, read the messages from stdin, one JSON user message per line, and
      print a result record after each run; no message argument
  --timings
      In execute mode, print the startup, turn and total durations to stderr
  --no-archive-after-execute
      Keep the session out of the archive after execute mode (it is archived by default)
  --title <title>
      Name the session (Pi's --name)
  -l, --label <label>
      Add a label to the session in ampi's thread index. Repeat the flag for several labels.
  -h, --help
      Print this help and exit
  -V, -v, --version
      Print the versions and exit
  --pi-help
      Print Pi's own options, including the flags ampi's extensions add
  --
      Hand everything after it to Pi as the message, without reading ampi options

  Every other option and argument goes to Pi unchanged, for example --model, -c, -r or -p.

Exit status in execute mode: 0 on success, 1 when the agent or Pi fails, 2 on a usage
error such as a missing message.

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

Run one message and print the answer:

  $ ampi -x "list the npm scripts and what they do"

Send a diff with a request, and save the answer:

  $ git diff | ampi -x "review this change" > review.md

Run one message and keep only the final result record of the stream JSON:

  $ ampi -x "list files" --stream-json | jq -c 'select(.type == "result")'

Pick up the latest session in this directory:

  $ ampi last

List this directory's sessions, then open one by the start of its id:

  $ ampi threads
  $ ampi threads continue 019a3c
`;
}
