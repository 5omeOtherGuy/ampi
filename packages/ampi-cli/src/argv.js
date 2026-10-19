// Argument routing for the `ampi` command. Pure: reads nothing and prints
// nothing, so every translation is testable without starting Pi.
import { parseArgs } from "node:util";
import { isLogLevel } from "./log.js";

/**
 * @typedef {"help" | "version" | "threads" | "tools" | "skill" | "mcp" | "config" | "doctor" | "review" | "update" | "dev" | "pi" | "pi-command" | "app" | "app-worker" | "top" | "error"} AmpiCommand
 *
 * @typedef {object} AmpiOptions
 * @property {string} [mode] ampi mode from `-m`/`--mode`, forwarded as `--ampi-mode`.
 * @property {boolean} fast `--fast`: start the session at fast speed, forwarded as `--ampi-fast`.
 * @property {string} [title] `--title`, forwarded as Pi's `--name`.
 * @property {string[]} labels `-l`/`--label` values, stored in the thread index once the session starts.
 * @property {boolean} execute `-x`/`--execute`: run one prompt and print the final assistant message.
 * @property {boolean} timings `--timings`: report durations on stderr (execute mode).
 * @property {boolean} archive Archive the session after execute mode; `--no-archive-after-execute` turns it off.
 * @property {boolean} streamJson `--stream-json`: print stream JSON records instead of the final message (execute mode).
 * @property {boolean} streamJsonThinking `--stream-json-thinking`: `--stream-json` with thinking blocks.
 * @property {boolean} streamJsonInput `--stream-json-input`: read the messages from stdin as JSON lines (stream JSON only).
 * @property {boolean} stats `--stats`: print one JSON line with the run's result and usage (execute mode).
 * @property {string} [outputTool] `--output-tool`: print the text of the last finished call to this tool (execute mode).
 * @property {string} [mcpConfig] `--mcp-config`: MCP servers for this run, as JSON or a file path.
 * @property {number} [pluginReadyTimeout] `--plugin-ready-timeout`, in seconds: accepted in execute mode and not used.
 * @property {string} [logLevel] `--log-level`: error, warn, info or debug.
 * @property {string} [logFile] `--log-file`: where diagnostics go instead of stderr.
 * @property {boolean} [color] true for `--color`, false for `--no-color`; the last one wins.
 *
 * @typedef {object} AmpiRoute
 * @property {AmpiCommand} command What the bin does: print help, print versions, start Pi with
 *   ampi, run one of Pi's own commands, serve every session from one page (`app`), run a session
 *   for `ampi app` (`app-worker`, internal and not in the help), list the running sessions (`top`),
 *   or fail.
 * @property {string[]} piArgs Arguments handed to Pi's `main()` when `command` is `"pi"`.
 * @property {string[]} [threadArgs] The command line from `threads`, `last` or `usage` on, when `command` is `"threads"`.
 * @property {string[]} [configArgs] The command line after `config`, when `command` is `"config"`.
 * @property {string[]} [devArgs] The command line after `dev`, when `command` is `"dev"`.
 * @property {string[]} [toolsArgs] The command line after `tools` (or `tool`), when `command` is `"tools"`.
 * @property {boolean} [open] `ampi app --open`: open the page in a browser.
 * @property {string[]} [topArgs] The command line after `top`, when `command` is `"top"`.
 * @property {string[]} [skillArgs] The command line after `skill` (or `skills`), when `command` is `"skill"`.
 * @property {string[]} [mcpArgs] The command line after `mcp`, when `command` is `"mcp"`.
 * @property {string[]} [doctorArgs] The command line after `doctor`, when `command` is `"doctor"`.
 * @property {string[]} [reviewArgs] The command line after `review`, when `command` is `"review"`.
 * @property {string[]} [updateArgs] The command line after `update` (or `up`), when `command` is `"update"`.
 * @property {AmpiOptions} options ampi options read from the command line.
 * @property {string} [error] Usage error, set when `command` is `"error"`.
 * @property {string} [usageHint] The help to point to after `error`, when it is not `ampi --help`.
 */

/** Values of Pi's own `--mode` (output format); these keep Pi's meaning. */
const PI_OUTPUT_MODES = new Set(["text", "json", "rpc"]);

/**
 * Pi's own commands. Pi recognises them only as the first argument and rejects options it does not know.
 * `update` is Pi's only with Pi's update arguments (see routeUpdate).
 */
const PI_COMMANDS = new Set(["install", "remove", "uninstall", "list", "config", "auth"]);

/** The options of ampi's own `update`; `-h` and `--help` belong to whichever update runs. */
const UPDATE_OPTIONS = new Set(["--target-version", "--porcelain"]);
const UPDATE_HELP_FLAGS = new Set(["-h", "--help"]);

/** The `config` subcommands ampi runs itself. */
const CONFIG_COMMANDS = new Set(["keymap", "edit"]);

/** The developer commands, `ampi dev <command>`. */
const DEV_COMMANDS = new Set(["keys"]);

const OPTIONS = /** @type {const} */ ({
  mode: { type: "string", short: "m" },
  fast: { type: "boolean" },
  title: { type: "string" },
  label: { type: "string", short: "l", multiple: true },
  execute: { type: "boolean", short: "x" },
  timings: { type: "boolean" },
  "no-archive-after-execute": { type: "boolean" },
  "stream-json": { type: "boolean" },
  "stream-json-thinking": { type: "boolean" },
  "stream-json-input": { type: "boolean" },
  stats: { type: "boolean" },
  "output-tool": { type: "string" },
  "mcp-config": { type: "string" },
  // Its value is optional, so the router decides whether the next argument is one.
  "plugin-ready-timeout": { type: "boolean" },
  "settings-file": { type: "string" },
  "log-level": { type: "string" },
  "log-file": { type: "string" },
  color: { type: "boolean" },
  "no-color": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
  "pi-help": { type: "boolean" },
});

/** ampi's options that may also come before a command, as in `ampi --log-level debug threads list`. */
const GLOBAL_OPTIONS = new Set(["log-level", "log-file", "color", "no-color"]);

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

/** The most seconds `--plugin-ready-timeout` takes, and the value of its bare form. */
const PLUGIN_READY_TIMEOUT_MAX = 300;
const PLUGIN_READY_TIMEOUT_BARE = 10;

/** @param {string | undefined} text @returns {number | undefined} The seconds, or undefined when `text` is not 0 to 300. */
const pluginReadyTimeoutOf = (text) => {
  if (text === undefined || !/^\d{1,3}$/.test(text)) return undefined;
  const seconds = Number(text);
  return seconds <= PLUGIN_READY_TIMEOUT_MAX ? seconds : undefined;
};

const SETTINGS_FILE_ERROR =
  "--settings-file is not supported: Pi reads settings.json from its configuration directory and the project's .pi/ directory. " +
  "Set PI_CODING_AGENT_DIR to use another configuration directory.";

/**
 * Split the `ampi` command line into ampi's own commands and options and the
 * arguments Pi receives. Unknown options and positionals reach Pi unchanged and
 * in order; everything after `--` reaches Pi verbatim. One of Pi's own commands
 * as the first argument hands the whole command line to Pi untouched. The
 * logging and colour options may also come before a command.
 *
 * @param {readonly string[]} argv Arguments after the executable and script.
 * @returns {AmpiRoute}
 */
export function routeAmpiArgv(argv) {
  const args = [...argv];
  const lead = countLeadingGlobalOptions(args);
  const commandRoute = routeCommand(args.slice(lead));
  const read = readOptions(commandRoute === undefined ? args : args.slice(0, lead));
  const { options } = read;
  if (read.error !== undefined) return { command: "error", piArgs: [], options, error: read.error };
  if (commandRoute !== undefined) return { ...commandRoute, options };
  if (read.help) return { command: "help", piArgs: [], options };
  if (read.version) return { command: "version", piArgs: [], options };
  return { command: "pi", piArgs: read.piArgs, options };
}

/**
 * How many arguments the global options at the start of the command line take.
 *
 * @param {readonly string[]} args
 * @returns {number}
 */
function countLeadingGlobalOptions(args) {
  let index = 0;
  for (;;) {
    const match = /^--([^=]+)(=?)/.exec(args[index] ?? "");
    if (match === null || !GLOBAL_OPTIONS.has(match[1])) return index;
    const takesValue = /** @type {Record<string, { type: string }>} */ (OPTIONS)[match[1]].type === "string";
    index += takesValue && match[2] === "" ? 2 : 1;
  }
}

/**
 * The route for a command line that starts with one of ampi's commands or
 * Pi's, or `undefined` when it starts Pi.
 *
 * @param {string[]} args The command line after the leading global options.
 * @returns {Omit<AmpiRoute, "options"> | undefined}
 */
function routeCommand(args) {
  if (args[0] === "help") return { command: "help", piArgs: [] };
  if (args[0] === "version") return { command: "version", piArgs: [] };
  if (args[0] === "threads" || args[0] === "last" || args[0] === "usage") return { command: "threads", piArgs: [], threadArgs: args };
  if (args[0] === "tools" || args[0] === "tool") return { command: "tools", piArgs: [], toolsArgs: args.slice(1) };
  if (args[0] === "app") {
    // `--worker` is started only by `ampi app`, which talks to it over the IPC channel.
    if (args.length === 2 && args[1] === "--worker") return { command: "app-worker", piArgs: [] };
    if (args.length === 1 || (args.length === 2 && args[1] === "--open")) return { command: "app", piArgs: [], open: args.length === 2 };
    return { command: "error", piArgs: [], error: "ampi app takes only --open." };
  }
  if (args[0] === "top") return { command: "top", piArgs: [], topArgs: args.slice(1) };
  if (args[0] === "skill" || args[0] === "skills") return { command: "skill", piArgs: [], skillArgs: args.slice(1) };
  if (args[0] === "mcp") return { command: "mcp", piArgs: [], mcpArgs: args.slice(1) };
  if (args[0] === "doctor") return { command: "doctor", piArgs: [], doctorArgs: args.slice(1) };
  if (args[0] === "review") return { command: "review", piArgs: [], reviewArgs: args.slice(1) };
  if (args[0] === "update" || args[0] === "up") return routeUpdate(args.slice(1));
  // `config keymap` and `config edit` are ampi's; every other `config` command line is Pi's.
  if (args[0] === "config" && CONFIG_COMMANDS.has(args[1] ?? "")) return { command: "config", piArgs: [], configArgs: args.slice(1) };
  // `dev keys` is ampi's; `ampi dev` followed by anything else is a message for Pi.
  if (args[0] === "dev" && DEV_COMMANDS.has(args[1] ?? "")) return { command: "dev", piArgs: [], devArgs: args.slice(1) };
  if (PI_COMMANDS.has(args[0] ?? "")) return { command: "pi-command", piArgs: args };
  return undefined;
}

/**
 * Read ampi's options and collect the arguments Pi receives.
 *
 * @param {string[]} args
 * @returns {{ options: AmpiOptions, piArgs: string[], help: boolean, version: boolean, error?: string }}
 */
function readOptions(args) {
  /** @type {AmpiOptions} */
  const options = {
    labels: [],
    fast: false,
    execute: false,
    timings: false,
    archive: true,
    streamJson: false,
    streamJsonThinking: false,
    streamJsonInput: false,
    stats: false,
  };
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
  /** @type {string | undefined} The stream JSON flag as given, for the messages about flags it excludes. */
  let streamJsonFlag;

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
      case "fast":
        if (!options.fast) piArgs.push("--ampi-fast");
        options.fast = true;
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
        streamJsonFlag ??= "--stream-json";
        break;
      case "stream-json-thinking":
        options.streamJson = true;
        options.streamJsonThinking = true;
        streamJsonFlag ??= "--stream-json-thinking";
        break;
      case "stream-json-input":
        options.streamJsonInput = true;
        break;
      case "stats":
        options.stats = true;
        break;
      case "output-tool":
        if (value === undefined || value === "") error ??= "--output-tool needs a tool name, for example --output-tool bash.";
        else options.outputTool = value;
        break;
      case "mcp-config":
        if (options.mcpConfig !== undefined) error ??= "--mcp-config can be given only once.";
        else if (value === undefined) error ??= "--mcp-config needs MCP servers as JSON or a file path.";
        else options.mcpConfig = value;
        break;
      case "plugin-ready-timeout":
        if (token.inlineValue) {
          options.pluginReadyTimeout = pluginReadyTimeoutOf(value);
          if (options.pluginReadyTimeout === undefined) error ??= `--plugin-ready-timeout takes whole seconds from 0 to ${PLUGIN_READY_TIMEOUT_MAX}, not "${value}".`;
        } else {
          // The next argument is the value only when it is a number of seconds; otherwise it stays the message.
          const next = pluginReadyTimeoutOf(args[token.index + 1]);
          if (next !== undefined) passed.add(token.index + 1);
          options.pluginReadyTimeout = next ?? PLUGIN_READY_TIMEOUT_BARE;
        }
        break;
      case "log-level":
        if (!value) error ??= "--log-level needs a level: error, warn, info or debug.";
        else if (!isLogLevel(value)) error ??= `--log-level must be error, warn, info or debug, not "${value}".`;
        else options.logLevel = value;
        break;
      case "log-file":
        if (!value) error ??= "--log-file needs a file path.";
        else options.logFile = value;
        break;
      case "color":
        options.color = true;
        break;
      case "no-color":
        options.color = false;
        break;
    }
  }
  if (options.streamJsonInput && !options.streamJson) error ??= "--stream-json-input needs --stream-json or --stream-json-thinking.";
  if (options.stats && streamJsonFlag !== undefined) error ??= `--stats cannot be combined with ${streamJsonFlag}.`;
  if (options.outputTool !== undefined && streamJsonFlag !== undefined) error ??= `--output-tool cannot be combined with ${streamJsonFlag}.`;
  if (options.stats && options.outputTool !== undefined) error ??= "--stats cannot be combined with --output-tool.";
  return { options, piArgs, help, version, error };
}

/**
 * `ampi update` and `ampi up`: ampi's own update when the rest of the command
 * line holds only its options (`--target-version <v>`, `--porcelain`, `-h`,
 * `--help`); Pi's `update` with the command line unchanged when it holds any
 * other argument (`up` becomes `update`, which Pi knows). Both together are a
 * usage error.
 *
 * @param {string[]} rest The arguments after `update` or `up`.
 * @returns {Omit<AmpiRoute, "options">}
 */
function routeUpdate(rest) {
  /** @type {string[]} */
  const ours = [];
  /** @type {string[]} */
  const theirs = [];
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--") {
      theirs.push(...rest.slice(index));
      break;
    }
    const name = arg.startsWith("--") ? arg.split("=")[0] : arg;
    if (UPDATE_HELP_FLAGS.has(arg)) continue;
    if (!UPDATE_OPTIONS.has(name)) {
      theirs.push(arg);
      continue;
    }
    ours.push(name);
    // `--target-version <v>`: the value is the next argument unless that is an option.
    if (arg === "--target-version" && index + 1 < rest.length && !rest[index + 1].startsWith("-")) index++;
  }
  if (theirs.length === 0) return { command: "update", piArgs: [], updateArgs: rest };
  if (ours.length === 0) return { command: "pi-command", piArgs: ["update", ...rest] };
  return {
    command: "error",
    piArgs: [],
    error:
      `${[...new Set(ours)].join(" and ")} ${ours.length === 1 ? "is an option" : "are options"} of ampi's own update, ` +
      `and ${theirs.join(" ")} ${theirs.length === 1 ? "goes" : "go"} to Pi's update; run them as two commands.`,
    usageHint: "Run ampi update --help for both.",
  };
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
  threads [command]             Create, list, open, print, change, delete or import sessions;
                                ampi threads --help lists the commands
  last                          Open the most recent session of this directory that is not archived
  usage                         Print the cost and tokens of every session of the last 30 days;
                                ampi threads --help lists its options
  review [description...]       Review a diff once with the reviewer and the review checks, print
                                the report or a JSON document and record it as a thread;
                                ampi review --help has more
  tools list|show [--mode <m>]  Print the tools a session declares to the model in a mode, or one
                                tool's description and parameters; ampi tools --help has more
  skill list|info|add|remove    List the skills Pi loads, show one, install skills from a directory
                                or git repository, or remove one; ampi skill --help has more
  mcp [command]                 Add, list, check and remove MCP servers, trust a project's servers
                                and sign in to them; ampi mcp --help lists the commands
  config keymap                 Print every command id with its keys as JSONC
  config edit [--workspace]     Open Pi's settings file, or this project's, in your editor
  app [--open]                  Serve every session on this machine from one local web page:
                                read any of them, continue those nothing else has open, and
                                join those a terminal runs with its web GUI on
  top [--json|--stream-jsonl]   Show the ampi sessions running on this machine and follow them;
                                --json prints them once, --stream-jsonl a JSON line per change
  doctor [--json]               Check Node.js, Pi, ampi, Pi's configuration, rg, fd, git, model
                                credentials and ampi's data files, and say how to fix problems;
                                installs nothing
  update, up [--target-version <v>] [--porcelain]
                                Update the ampi command (an npm install -g) to the latest or
                                the given version; ampi update --help has more

  Pi's own commands (install, remove, uninstall, list, config, auth) run unchanged,
  without ampi's options; config keymap and config edit are ampi's. update goes to Pi's
  update unchanged when it has Pi's arguments, such as --extensions or a package source.

Developer commands:

  dev keys [--raw] [--no-keymap]
                                Print what ampi reads for each key press and the command its
                                keymap would run, one JSON line per key; ampi dev keys --help
                                has more

Options:

  -m, --mode <mode>
      Start in an ampi mode: low, medium, high, ultra or free (rush, smart, deep and fable are
      accepted as aliases). --mode text, json and rpc keep Pi's meaning (output format).
  --fast
      Start the session at fast speed: the provider serves requests with priority, at a higher
      price (OpenAI and OpenAI Codex models only). Alt+R turns it on or off in a session.
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
  --stats
      In execute mode, print one JSON line at the end instead of the final message: the
      result, the number of turns, the token usage and, when the model reports it, the cost
  --output-tool <name>
      In execute mode, print the text of the last finished call to that tool instead of the
      final message; exit 1 when that call failed or no call finished
  --plugin-ready-timeout [seconds]
      Accepted in execute mode and has no effect: Pi loads every extension before the run
      starts, so there is nothing to wait for
  --timings
      In execute mode, print the startup, turn and total durations to stderr
  --no-archive-after-execute
      Keep the session out of the archive after execute mode (it is archived by default)
  --title <title>
      Name the session (Pi's --name)
  -l, --label <label>
      Add a label to the session in ampi's thread index. Repeat the flag for several labels.
  --mcp-config <json|path>
      Connect these MCP servers for this run, given as JSON or a JSON file in the mcpServers
      format of Pi's mcp.json; a server of the same name in an mcp.json file is used instead
  --log-level <level>
      Write ampi's own diagnostics at this level and above: error, warn, info (the default)
      or debug
  --log-file <file>
      Append ampi's diagnostics to this file, one line each, instead of stderr; errors also
      go to stderr. Pi's own output is not affected.
  --color, --no-color
      Set FORCE_COLOR=1 or NO_COLOR=1 for Pi and the tools it runs. Pi's own commands and
      the terminal UI theme keep their colours; the CLI README has the details.
  -h, --help
      Print this help and exit
  -V, -v, --version
      Print the versions and exit
  --pi-help
      Print Pi's own options, including the flags ampi's extensions add
  --
      Hand everything after it to Pi as the message, without reading ampi options

  Every other option and argument goes to Pi unchanged, for example --model, -c, -r or -p.
  The logging and colour options also work before a command: ampi --log-level debug threads.

Exit status in execute mode: 0 on success, 1 when the agent or Pi fails, 2 on a usage
error such as a missing message.

Environment variables:

  PI_CODING_AGENT_DIR           Pi's configuration directory (default ~/.pi/agent): settings,
                                sessions and installed packages
  PI_OFFLINE                    Set to 1 to start without network activity such as model
                                catalogue refreshes
  AMPI_LOG_LEVEL                The level when --log-level is not given
  AMPI_LOG_FILE                 The log file when --log-file is not given
  NO_COLOR                      A non-empty value turns colour off in tools that follow it;
                                Pi's own text keeps its colour unless --no-color is given

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

Review the uncommitted changes and keep the findings as JSON:

  $ ampi review --json > review.json

Run one message and keep only the final result record of the stream JSON:

  $ ampi -x "list files" --stream-json | jq -c 'select(.type == "result")'

Pick up the latest session in this directory:

  $ ampi last

Serve every session from one web page and open it in a browser:

  $ ampi app --open

List this directory's sessions, then open one by the start of its id:

  $ ampi threads
  $ ampi threads continue 019a3c

Check what ampi needs when something does not work:

  $ ampi doctor
`;
}
