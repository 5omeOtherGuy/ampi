// The `ampi` command line as data: every command, subcommand, positional
// argument and option the command accepts, with a one-line description and
// what kind of value each takes. Shell completion (completions.js) resolves
// the words typed so far against this tree. It is plain JSON-serialisable
// data and loads nothing but Node built-ins, so a completion that needs no
// session never loads Pi. Whether the tree still matches the router and the
// command modules is checked by tests/mmr-cli-completions.test.mjs: a new
// command or option goes here too.
import { LOG_LEVELS } from "./log.js";
import { THREAD_COLORS } from "./thread-index.js";

/**
 * @typedef {{ value: string, description: string }} Choice
 *
 * @typedef {"file" | "directory" | "thread-id" | "mode" | "shell" | "color" | "skill" | "mcp-server" | { choices: Choice[] }} ValueKind
 *   What a value is: a path (completed by the shell), a value ampi looks up
 *   (thread ids, skill and MCP server names), or a fixed list.
 *
 * @typedef {object} TreeOption
 * @property {string} name The long spelling, such as `--mode`.
 * @property {string[]} short The short spellings, such as `-m`, or Pi's `-nbt`.
 * @property {boolean} value Whether it takes the next argument (or `=value`) as its value.
 * @property {ValueKind} [kind] What the value is; none for free text.
 * @property {ValueKind} [shortKind] The kind when a short spelling is used, where it differs (`-m` takes only ampi modes).
 * @property {boolean} repeat Whether it may be given more than once.
 * @property {boolean} global Whether it may also come before a command (`ampi --log-level debug threads`).
 * @property {boolean} [hidden] Accepted but never offered.
 * @property {string} description
 *
 * @typedef {object} TreeArg
 * @property {string} name
 * @property {ValueKind} [kind] What the value is; none for free text.
 * @property {boolean} [variadic] Takes every remaining positional.
 *
 * @typedef {object} TreeCommand
 * @property {string} name
 * @property {string[]} aliases
 * @property {string} description
 * @property {TreeArg[]} args Positional arguments, in order.
 * @property {TreeCommand[]} commands
 * @property {TreeOption[]} options
 * @property {boolean} [hidden] Routed but never offered.
 * @property {boolean} [pi] One of Pi's own commands: completed by name, and nothing after it.
 * @property {string} [implicit] The subcommand an option right after this command belongs to (`ampi threads --json` lists).
 * @property {boolean} [optionsBeforeCommand] Its options may come before the subcommand (`ampi tools --json list`);
 *   elsewhere an option there means no subcommand follows.
 * @property {boolean} [message] The root: a word that is neither a command nor an option starts the message.
 */

/** The ampi modes `-m` offers; the aliases rush, smart, deep and fable are accepted but not offered. */
export const MODE_CHOICES = Object.freeze([
  { value: "low", description: "Quick, focused turns" },
  { value: "medium", description: "Balanced default for coding" },
  { value: "high", description: "Deeper reasoning" },
  { value: "ultra", description: "The most reasoning effort" },
  { value: "free", description: "Plain Pi: ampi enforces no model, prompt or tools" },
]);

/** The shells `ampi completions` writes a script for. */
export const SHELL_CHOICES = Object.freeze([
  { value: "bash", description: "Bash" },
  { value: "zsh", description: "Zsh" },
  { value: "fish", description: "Fish" },
  { value: "pwsh", description: "PowerShell" },
]);

/** The thread colours, and `none` to remove one; `#rrggbb` is accepted too. */
export const COLOR_CHOICES = Object.freeze([
  ...THREAD_COLORS.map((color) => ({ value: color, description: "Thread colour" })),
  { value: "none", description: "Remove the colour" },
]);

/** The values `--mode` offers: ampi's modes, then Pi's output formats. */
const MODE_OR_OUTPUT = {
  choices: [
    ...MODE_CHOICES,
    { value: "text", description: "Pi's text output" },
    { value: "json", description: "Pi's JSON event stream" },
    { value: "rpc", description: "Pi's RPC protocol over stdin and stdout" },
  ],
};

/** @type {Record<string, string>} */
const LOG_LEVEL_DESCRIPTIONS = { error: "Errors only", warn: "Errors and warnings", info: "Also notes on what ampi chose (default)", debug: "Everything" };

/** Pi's `--thinking` levels, from Pi's docs/cli.md. */
const THINKING = {
  choices: ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => ({ value: level, description: "Thinking level" })),
};

/** The thinking levels `ampi review --thinking` takes. */
const REVIEW_THINKING = {
  choices: [
    { value: "low", description: "The review's default" },
    { value: "high", description: "Deeper reasoning" },
  ],
};

/** Pi's `--tui-mode` values, from Pi's docs/cli.md. */
const TUI_MODE = {
  choices: [
    { value: "fullscreen", description: "Use the whole terminal (Pi's default)" },
    { value: "regular", description: "Write into the scrollback" },
  ],
};

/**
 * @typedef {{ short?: string[], value?: boolean, kind?: ValueKind, shortKind?: ValueKind, repeat?: boolean, global?: boolean, hidden?: boolean }} OptionMore
 * @typedef {{ aliases?: string[], args?: TreeArg[], commands?: TreeCommand[], options?: TreeOption[], hidden?: boolean, implicit?: string,
 *   optionsBeforeCommand?: boolean }} CommandMore
 */

/**
 * @param {string} name
 * @param {string} description
 * @param {OptionMore} [more]
 * @returns {TreeOption}
 */
function option(name, description, more = {}) {
  const { short = [], value = false, repeat = false, global = false, ...rest } = more;
  return { name, short, value, ...rest, repeat, global, description };
}

/**
 * An option with a value.
 *
 * @param {string} name
 * @param {string} description
 * @param {OptionMore} [more]
 * @returns {TreeOption}
 */
const valued = (name, description, more = {}) => option(name, description, { ...more, value: true });

const help = () => option("--help", "Print this command's help", { short: ["-h"] });
const json = (/** @type {string} */ description = "Print JSON instead") => option("--json", description);

/**
 * One of ampi's commands; every one takes `-h`/`--help`.
 *
 * @param {string} name
 * @param {string} description
 * @param {CommandMore} [more]
 * @returns {TreeCommand}
 */
function command(name, description, more = {}) {
  const { aliases = [], args = [], commands = [], options = [], ...rest } = more;
  return { name, aliases, description, args, commands, options: [...options, help()], ...rest };
}

/**
 * One of Pi's own commands, completed by its name only.
 *
 * @param {string} name
 * @param {string} description
 * @returns {TreeCommand}
 */
const piCommand = (name, description) => ({ name, aliases: [], description, args: [], commands: [], options: [], pi: true });

/** @param {string} name @param {boolean} [variadic] @returns {TreeArg} */
const threadId = (name = "id", variadic = false) => (variadic ? { name, kind: "thread-id", variadic } : { name, kind: "thread-id" });
/** @param {string} name @param {ValueKind} [kind] @returns {TreeArg} */
const arg = (name, kind) => (kind === undefined ? { name } : { name, kind });
/** @param {string} name @returns {TreeArg} */
const rest = (name) => ({ name, variadic: true });

const USAGE_OPTIONS = [
  option("--details", "Add tokens and cost per model, and tool calls"),
  valued("--start", "Count from this ISO 8601 time on"),
  valued("--end", "Count up to this ISO 8601 time"),
  json(),
];

const IMPORT_OPTIONS = [
  option("--all", "Import every session within --max-age days"),
  valued("--max-age", "With --all: how many days back to look"),
  valued("--limit", "With --all: import at most this many"),
  option("--dry-run", "Print what would be imported and write nothing"),
  option("--reimport", "Import sessions imported before again"),
  json("Print one JSON object per line"),
];

/**
 * @param {string} name
 * @param {string} description
 * @param {string} dirOption
 * @param {string} dirDescription
 * @param {string[]} [aliases]
 */
const importAgent = (name, description, dirOption, dirDescription, aliases = []) =>
  command(name, description, { aliases, args: [rest("ids")], options: [...IMPORT_OPTIONS, valued(dirOption, dirDescription, { kind: "directory" })] });

const THREADS = command("threads", "Create, list, open, print, change, delete or import sessions", {
  implicit: "list",
  commands: [
    command("new", "Print the id of a new, empty session", {
      aliases: ["n"],
      options: [json('Print {"id", "cwd"} as JSON'), valued("--visibility", "Refused: sessions stay on this machine", { hidden: true })],
    }),
    command("list", "List this directory's sessions, newest first", {
      aliases: ["ls", "l"],
      options: [
        option("--all", "List the sessions of every directory"),
        option("--archived", "Include archived sessions"),
        option("--include-archived", "Include archived sessions"),
        json("Print one JSON object per line"),
        valued("--limit", "Print at most this many sessions"),
      ],
    }),
    command("search", "Search the sessions of every directory", {
      aliases: ["find"],
      args: [rest("query")],
      options: [valued("--limit", "Print at most this many sessions", { short: ["-n"] }), json("Print one JSON object per line")],
    }),
    command("continue", "Open a session in the terminal UI", { aliases: ["c"], args: [threadId()], options: [option("--last", "Open the most recent session")] }),
    command("markdown", "Print a session as Markdown", { aliases: ["md"], args: [threadId()] }),
    command("export", "Print a session and its entries as JSON", { args: [threadId()] }),
    command("context", "Print what fills a session's context window", { aliases: ["analyze-context"], args: [threadId()] }),
    command("usage", "Print a session's cost", { args: [threadId()], options: USAGE_OPTIONS }),
    command("rename", "Rename a session", { aliases: ["r"], args: [threadId(), arg("title")] }),
    command("archive", "Archive a session", { args: [threadId()], options: [option("--unarchive", "Take it out of the archive instead")] }),
    command("unarchive", "Take a session out of the archive", { args: [threadId()] }),
    command("label", "Add labels to a session", { args: [threadId(), rest("labels")] }),
    command("color", "Set a session's colour", { args: [threadId(), arg("color", "color")] }),
    command("delete", "Delete a session file", { args: [threadId()], options: [option("--yes", "Delete without asking", { short: ["-y"] })] }),
    command("import", "Copy other coding agents' conversations into read-only sessions", {
      commands: [
        command("detect", "Print where each agent keeps its conversations", { options: [json()] }),
        importAgent("claude", "Import Claude Code sessions", "--claude-dir", "Claude Code's configuration directory", ["claude-code"]),
        importAgent("codex", "Import Codex sessions", "--codex-dir", "Codex's sessions directory"),
        importAgent("opencode", "Import OpenCode sessions", "--opencode-dir", "OpenCode's data directory"),
      ],
    }),
  ],
});

/** `tools` reads its options anywhere on its command line, before the subcommand too; they are listed on it and on each subcommand. */
const TOOLS_OPTIONS = () => [json(), valued("--mode", "The ampi mode to start", { short: ["-m"], kind: "mode" })];

const SKILL = command("skill", "List, show, install or remove the skills Pi loads", {
  aliases: ["skills"],
  optionsBeforeCommand: true,
  // `skill` reads every option of its table before the subcommand too; the subcommand decides which it accepts.
  options: [
    json(),
    option("--global", "Pi's user skills directory (add, remove)"),
    valued("--target", "This skills directory (add, remove)", { kind: "directory" }),
    option("--overwrite", "Replace an installed skill of the same name (add)"),
    valued("--name", "Install the only skill under this name (add)"),
    option("--yes", "Delete without asking (remove)", { short: ["-y"] }),
  ],
  commands: [
    command("list", "Print the skills a session here loads", { aliases: ["ls"], options: [json()] }),
    command("info", "Print one skill's source, frontmatter and files", { args: [arg("name", "skill")], options: [json()] }),
    command("add", "Install the skills of a directory or git repository", {
      args: [arg("source")],
      options: [
        option("--global", "Into Pi's user skills directory"),
        valued("--target", "Into this skills directory", { kind: "directory" }),
        option("--overwrite", "Replace an installed skill of the same name"),
        valued("--name", "Install the only skill under this name"),
      ],
    }),
    command("remove", "Delete an installed skill", {
      aliases: ["rm"],
      args: [arg("name", "skill")],
      options: [
        option("--global", "From Pi's user skills directory"),
        valued("--target", "From this skills directory", { kind: "directory" }),
        option("--yes", "Delete without asking", { short: ["-y"] }),
      ],
    }),
  ],
});

/** `--workspace` and Pi's spellings of it, for `mcp add` and `mcp remove`. */
const MCP_SCOPE = () => [option("--workspace", "This project's .pi/mcp.json"), option("--local", "This project's .pi/mcp.json (Pi's spelling)", { short: ["-l"] })];
const MCP_SERVER = arg("name", "mcp-server");

const MCP = command("mcp", "Add, list, check and remove MCP servers", {
  options: [option("--pi-help", "Print Pi's help for pi mcp")],
  commands: [
    command("add", "Save a server Pi starts or reaches over HTTP", {
      args: [arg("name"), arg("url")],
      options: [
        valued("--env", "An environment variable for a command server", { repeat: true }),
        valued("--header", "An HTTP header for a URL server", { repeat: true }),
        ...MCP_SCOPE(),
        valued("--url", "The server's URL"),
        valued("--cwd", "The working directory of a command server", { kind: "directory" }),
        valued("--bearer-token-env-var", "Send this variable as a bearer token"),
        valued("--oauth-client-id", "The OAuth client id"),
        valued("--oauth-client-secret", "The OAuth client secret"),
        valued("--oauth-callback-port", "The port of the OAuth callback"),
        valued("--oauth-client-name", "The client name to register"),
        valued("--exposure", "How the server's tools reach the model"),
        valued("--description", "What the server offers, in a sentence"),
      ],
    }),
    command("remove", "Delete a saved server", { args: [MCP_SERVER], options: MCP_SCOPE() }),
    command("list", "Connect every enabled server and print its state", { options: [json()] }),
    command("doctor", "Print a table of the servers, or of one", { args: [MCP_SERVER] }),
    command("approve", "Trust this project's servers", { args: [MCP_SERVER], options: [option("--yes", "Trust without asking", { short: ["-y"] })] }),
    command("oauth", "Sign in to a server, sign out or show the state", {
      commands: [
        command("login", "Sign in to an HTTP server in the browser", { args: [MCP_SERVER], options: [valued("--timeout", "Seconds to wait for the browser")] }),
        command("logout", "Delete a server's stored sign-in", { args: [MCP_SERVER] }),
        command("status", "Print whether a server is signed in", { args: [MCP_SERVER] }),
      ],
    }),
    // Pi's own spellings of oauth login and logout, and a command refused with a reason.
    command("login", "Sign in to an HTTP server (Pi's spelling)", { args: [MCP_SERVER], options: [valued("--timeout", "Seconds to wait for the browser")], hidden: true }),
    command("logout", "Delete a server's stored sign-in (Pi's spelling)", { args: [MCP_SERVER], hidden: true }),
    command("remote", "Refused: servers live in mcp.json files", { hidden: true }),
  ],
});

/** ampi's own options of the root command, in the order of `ampi --help`. */
const AMPI_OPTIONS = [
  valued("--mode", "Start in an ampi mode, or set Pi's output mode", { short: ["-m"], kind: MODE_OR_OUTPUT, shortKind: "mode" }),
  option("--fast", "Start at fast speed (priority serving)"),
  option("--execute", "Run the message once and print the answer", { short: ["-x"] }),
  option("--stream-json", "Print stream JSON records (execute mode)"),
  option("--stream-json-thinking", "Stream JSON with thinking blocks"),
  option("--stream-json-input", "Read the messages from stdin as JSON lines"),
  option("--stats", "Print one JSON line with the result and usage"),
  valued("--output-tool", "Print the last call to this tool instead"),
  option("--plugin-ready-timeout", "Accepted in execute mode; has no effect"),
  option("--timings", "Print the durations to stderr (execute mode)"),
  option("--no-archive-after-execute", "Keep the session out of the archive"),
  valued("--title", "Name the session"),
  valued("--label", "Add a label to the session", { short: ["-l"], repeat: true }),
  valued("--mcp-config", "MCP servers for this run, as JSON or a file", { kind: "file" }),
  valued("--settings-file", "Refused: Pi reads its own settings files", { hidden: true }),
  valued("--log-level", "Write ampi's diagnostics at this level and above", {
    kind: { choices: LOG_LEVELS.map((level) => ({ value: level, description: LOG_LEVEL_DESCRIPTIONS[level] ?? "Log level" })) },
    global: true,
  }),
  valued("--log-file", "Append ampi's diagnostics to this file", { kind: "file", global: true }),
  option("--color", "Turn colour on for Pi and its tools", { global: true }),
  option("--no-color", "Turn colour off for Pi and its tools", { global: true }),
  option("--help", "Print the help", { short: ["-h"] }),
  option("--version", "Print the versions", { short: ["-V", "-v"] }),
  option("--pi-help", "Print Pi's own options"),
];

/** Pi's top-level options (PI_VALUE_OPTIONS and PI_OTHER_OPTIONS in argv.js), which reach Pi unchanged. */
const PI_OPTIONS = [
  valued("--provider", "Pi: look up --model at this provider"),
  valued("--model", "Pi: the model to use"),
  valued("--api-key", "Pi: an API key for this run"),
  valued("--system-prompt", "Pi: replace the system prompt (text or file)"),
  valued("--append-system-prompt", "Pi: add to the system prompt (text or file)", { repeat: true }),
  valued("--name", "Pi: the session's name", { short: ["-n"] }),
  valued("--session", "Pi: open this session", { kind: "thread-id" }),
  valued("--session-id", "Pi: open or create the session with this id"),
  valued("--fork", "Pi: fork this session", { kind: "thread-id" }),
  valued("--session-dir", "Pi: keep sessions in this directory", { kind: "directory" }),
  valued("--models", "Pi: the models to cycle through"),
  valued("--tools", "Pi: the tools to enable", { short: ["-t"] }),
  valued("--exclude-tools", "Pi: the tools to disable", { short: ["-xt"] }),
  valued("--thinking", "Pi: the thinking level", { kind: THINKING }),
  valued("--export", "Pi: export a session file to HTML", { kind: "file" }),
  valued("--extension", "Pi: load an extension", { short: ["-e"], kind: "file", repeat: true }),
  valued("--skill", "Pi: load a skill", { kind: "file", repeat: true }),
  valued("--prompt-template", "Pi: load a prompt template", { kind: "file", repeat: true }),
  valued("--theme", "Pi: load a theme", { kind: "file", repeat: true }),
  valued("--use-theme", "Pi: the theme to start with"),
  valued("--tui-mode", "Pi: the terminal mode", { kind: TUI_MODE }),
  option("--list-models", "Pi: list the models, optionally matching a search"),
  option("--continue", "Pi: continue the latest session here", { short: ["-c"] }),
  option("--resume", "Pi: pick a session to resume", { short: ["-r"] }),
  option("--print", "Pi: print the answer and exit", { short: ["-p"] }),
  option("--no-session", "Pi: keep the session in memory only"),
  option("--no-builtin-tools", "Pi: turn off the built-in tools", { short: ["-nbt"] }),
  option("--no-tools", "Pi: turn off every tool", { short: ["-nt"] }),
  option("--no-extensions", "Pi: load only the -e extensions", { short: ["-ne"] }),
  option("--no-mcp", "Pi: turn off MCP support"),
  option("--no-skills", "Pi: load only the --skill skills", { short: ["-ns"] }),
  option("--no-prompt-templates", "Pi: load only the --prompt-template templates", { short: ["-np"] }),
  option("--no-themes", "Pi: load only the --theme themes"),
  option("--no-context-files", "Pi: skip AGENTS.md and CLAUDE.md", { short: ["-nc"] }),
  option("--verbose", "Pi: verbose startup information"),
  option("--approve", "Pi: trust this project for this run", { short: ["-a"] }),
  option("--no-approve", "Pi: ignore this project's trust-gated files", { short: ["-na"] }),
  option("--offline", "Pi: no automatic network activity"),
];

/** @template T @param {T} value @returns {T} */
function deepFreeze(value) {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** The whole `ampi` command line. */
export const COMMAND_TREE = deepFreeze(
  /** @type {TreeCommand} */ ({
    name: "ampi",
    aliases: [],
    description: "Pi with the ampi extensions",
    args: [],
    message: true,
    options: [...AMPI_OPTIONS, ...PI_OPTIONS],
    commands: [
      command("help", "Print the help"),
      command("version", "Print the ampi-cli, ampi and Pi versions"),
      THREADS,
      command("last", "Open the latest session here that is not archived"),
      command("usage", "Print the cost of every session of the last 30 days", { options: USAGE_OPTIONS }),
      command("review", "Review a diff once with the reviewer and the review checks", {
        args: [rest("description")],
        options: [
          valued("--files", "Focus the review on this file", { short: ["-f"], kind: "file", repeat: true }),
          valued("--instructions", "More instructions for the reviewer", { short: ["-i"] }),
          valued("--check-scope", "Run only the checks in this directory or below", { short: ["-s"], kind: "directory" }),
          valued("--check-filter", "Run only the check of this name", { short: ["-c"], repeat: true }),
          option("--checks-only", "Run only the checks, without the main review"),
          json("Print the JSON document instead of the report"),
          valued("--thinking", "The reviewer's thinking level", { kind: REVIEW_THINKING }),
          valued("--title", "Name the review's thread"),
          valued("--label", "Add a label to the thread", { short: ["-l"], repeat: true }),
          option("--no-archive-after-execute", "Keep the thread out of the archive"),
        ],
      }),
      command("tools", "Print the tools a session declares in a mode", {
        aliases: ["tool"],
        optionsBeforeCommand: true,
        options: TOOLS_OPTIONS(),
        commands: [
          command("list", "Print the active tools", { aliases: ["ls"], options: TOOLS_OPTIONS() }),
          command("show", "Print one tool's description and parameters", { args: [arg("tool")], options: TOOLS_OPTIONS() }),
        ],
      }),
      SKILL,
      MCP,
      command("config", "Print the keymap or edit Pi's settings; other config lines are Pi's", {
        commands: [
          command("keymap", "Print every command id with its keys as JSONC"),
          command("edit", "Open Pi's settings file in your editor", {
            options: [option("--global", "Pi's settings file (the default)"), option("--workspace", "This project's settings file")],
          }),
        ],
      }),
      command("app", "Serve every session from one local web page", {
        options: [option("--open", "Open the page in a browser"), option("--worker", "Started by ampi app only", { hidden: true })],
      }),
      command("top", "Show the ampi sessions running on this machine", {
        options: [json("Print the list once as JSON"), option("--stream-jsonl", "Print a JSON line now and on every change")],
      }),
      command("doctor", "Check what ampi needs and say how to fix it", { options: [json()] }),
      command("update", "Update the ampi command", {
        aliases: ["up"],
        options: [valued("--target-version", "Install this version"), option("--porcelain", "Print one machine-readable line")],
      }),
      command("dev", "Developer commands; other dev lines are a message for Pi", {
        commands: [
          command("keys", "Print what ampi reads for each key press", {
            options: [option("--raw", "Add the bytes of each key sequence"), option("--no-keymap", "Leave out the keymap's command")],
          }),
        ],
      }),
      command("completions", "Print a shell completion script", { args: [arg("shell", "shell")] }),
      command("__complete", "Answer a completion script", { hidden: true }),
      piCommand("install", "Pi: install a package"),
      piCommand("remove", "Pi: remove a package"),
      piCommand("uninstall", "Pi: remove a package"),
      piCommand("list", "Pi: list the installed packages"),
      piCommand("auth", "Pi: check or print credentials"),
    ],
  }),
);
