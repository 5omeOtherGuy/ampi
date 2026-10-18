// `ampi mcp`: Amp-compatible spellings of Pi's MCP commands, and three
// commands of ampi's own. `add`, `remove`, `list`, `oauth login` and
// `oauth logout` are translated onto `pi mcp` and run by Pi; `doctor` and
// `oauth status` read what `pi mcp list --json` reports; `approve` trusts the
// project through Pi's trust store, which is how Pi gates a project's servers.
// Every other subcommand and option goes to `pi mcp` unchanged.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { listPiTrustResources, parsePiMcpList, piMcpUsesOAuth, piProjectMcpPath, readPiProjectTrust, trustPiProject } from "./pi-compat.js";
import { cut } from "./threads.js";

/**
 * @typedef {import("./pi-compat.js").PiMcpServerReport} PiMcpServerReport
 * @typedef {import("./pi-compat.js").PiMcpList} PiMcpList
 *
 * @typedef {{ status: number | null, stdout: string, stderr: string, error?: Error }} PiCapture
 *
 * @typedef {object} McpHost
 * @property {() => Promise<any>} loadPi Loads the `@earendil-works/pi-coding-agent` module.
 * @property {string} cwd
 * @property {(args: string[]) => number | Promise<number>} runPi Runs `pi mcp <args>` in the terminal and
 *   returns its exit code.
 * @property {(args: string[]) => PiCapture} capturePi Runs `pi mcp <args>` and returns what it printed.
 * @property {number} columns Width the doctor table is cut to.
 * @property {boolean} interactive Whether a question can be answered (stdin is a terminal).
 * @property {(question: string) => Promise<boolean>} confirm Asks a yes/no question; true for yes.
 * @property {(text: string) => void} out Writes to stdout.
 * @property {import("./log.js").Logger} log For the command's diagnostics.
 * @property {(text: string) => void} piStderr Passes on what Pi wrote to stderr.
 *
 * @typedef {{ action: "help" }
 *   | { action: "pi", args: string[], projectServer?: string }
 *   | { action: "doctor", name?: string }
 *   | { action: "approve", name: string, yes: boolean }
 *   | { action: "oauth-status", name: string }
 *   | { action: "usage", message: string }} McpPlan
 *
 * @typedef {{ code: number, message?: string }} Outcome
 */

const USAGE_HINT = "Run ampi mcp --help for the options.";

/** Options of `pi mcp add` that take the next argument as their value. */
const ADD_VALUE_OPTIONS = new Set([
  "url",
  "env",
  "cwd",
  "header",
  "bearer-token-env-var",
  "oauth-client-id",
  "oauth-client-secret",
  "oauth-callback-port",
  "oauth-client-name",
  "exposure",
  "description",
]);

/** Options of other clients' `mcp oauth login` that register client credentials on the command line. */
const CLIENT_CREDENTIAL_OPTIONS = new Set(["client-id", "client-secret", "scopes", "auth-url", "token-url", "server-url"]);

const CLIENT_CREDENTIALS_MESSAGE =
  "oauth login takes no client credentials. Pi registers itself with the server's authorization server, or uses the " +
  'client in the server\'s "oauth" block in mcp.json: clientId, clientSecret, scope, callbackPort, callbackUrl and ' +
  "authServerMetadataUrl. ampi mcp add <name> <url> --oauth-client-id <id> --oauth-client-secret <secret> writes one; " +
  "set the others in the file.";

const REMOTE_MESSAGE =
  "mcp remote is not available: ampi keeps MCP servers in Pi's mcp.json files, not on a hosted service. " +
  "Add a server with ampi mcp add <name> <url>.";

/**
 * C0 and C1 control characters and Unicode bidirectional controls: server
 * names, commands and errors are printed to a terminal, and a bidirectional
 * control can reorder how the rest of a line reads.
 */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** @param {string} text */
const clean = (text) => text.replace(CONTROL, "");

/**
 * Text from a project's mcp.json as one line of the approval listing.
 *
 * @param {string} text
 */
const oneLine = (text) => clean(text).replace(/[\t\n]/g, " ");

/** @param {string} text @param {number} width */
const padEnd = (text, width) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));

/** The ERROR column of the doctor table is dropped when fewer columns than this are left for it. */
const ERROR_MIN = 12;

/** @param {unknown} error */
const messageOf = (error) => (error instanceof Error ? error.message : String(error));

/**
 * @param {string} message
 * @returns {McpPlan}
 */
const usage = (message) => ({ action: "usage", message });

/**
 * @param {string} message
 * @returns {Outcome}
 */
const fail = (message) => ({ code: 1, message });

/**
 * The text `ampi mcp --help` prints.
 *
 * @returns {string}
 */
export function formatMcpHelp() {
  return `ampi mcp: add, check and remove MCP servers, and trust a project's servers

Usage: ampi mcp add <name> [--env KEY=VALUE]... [--workspace] -- <command> [args...]
       ampi mcp add <name> <url> [--header KEY=VALUE]... [--workspace]
       ampi mcp remove <name> [--workspace]
       ampi mcp list [--json]
       ampi mcp doctor [name]
       ampi mcp approve <name> [--yes]
       ampi mcp oauth login|logout|status <name>

Commands:

  add <name> -- <command>       Save a server that Pi starts as a local command (stdio)
  add <name> <url>              Save a server that Pi reaches over streamable HTTP
  remove <name>                 Delete a saved server
  list                          Connect every enabled server and print its state, tools and errors
  doctor [name]                 Print a table of the servers, or of one: status, transport, number of
                                tools and the first line of any error
  approve <name>                Trust this project, so Pi starts the servers in its .pi/mcp.json;
                                shows what trust enables and asks first
  oauth login <name>            Sign in to an HTTP server in the browser
  oauth logout <name>           Delete the stored sign-in of a server
  oauth status <name>           Print whether a server is signed in, needs sign-in or does not use OAuth

Options:

  --env KEY=VALUE               add: an environment variable for a command server (repeatable)
  --header KEY=VALUE            add: an HTTP header for a URL server (repeatable)
  --workspace                   add and remove: this project's .pi/mcp.json instead of mcp.json in
                                Pi's configuration directory (Pi's --local)
  --json                        list: print JSON
  -y, --yes                     approve: trust the project without asking
  --timeout <seconds>           oauth login: how long to wait for the browser (default 300)
  --pi-help                     Print Pi's help for pi mcp

  Pi's spellings work too: --url <url> and -l/--local for add, login and logout for oauth login and
  oauth logout. add also takes Pi's --cwd, --bearer-token-env-var, --oauth-client-id,
  --oauth-client-secret, --oauth-callback-port, --oauth-client-name, --exposure and
  --description. Every other subcommand and option goes to pi mcp unchanged.

Project servers: Pi reads .pi/mcp.json only in a project it trusts, and trust covers the whole
project (its settings, extensions, skills, prompts and themes too), not one server. approve
saves that decision in Pi's trust store, as Pi's own trust prompt does.

Exit status: 0 on success, 1 when a server is not connected, unknown or not trusted, or Pi fails,
2 on a usage error.

Examples:

  $ ampi mcp add files -- npx -y @modelcontextprotocol/server-filesystem .
  $ ampi mcp add search --env SEARCH_INDEX=./index -- node ./tools/search-mcp.mjs
  $ ampi mcp add docs https://example.com/mcp --header 'Authorization=Bearer \${DOCS_TOKEN}'
  $ ampi mcp add tools --workspace -- ./scripts/tools-mcp
  $ ampi mcp approve tools
  $ ampi mcp doctor
`;
}

/**
 * Whether `arg` is `-h` or `--help`.
 *
 * @param {string} arg
 */
const isHelp = (arg) => arg === "--help" || arg === "-h";

/**
 * The option name of `--name` or `--name=value`, or undefined for anything else.
 *
 * @param {string} arg
 */
const longName = (arg) => (arg.startsWith("--") && arg.length > 2 ? arg.slice(2).split("=")[0] : undefined);

/**
 * Translate `add` onto `pi mcp add`: a URL in place of the command becomes
 * `--url <url>`, `--workspace` becomes `--local`, and `--name=value` becomes
 * `--name value` for Pi's options. Pi stops reading options at `--` and after
 * the server name and a command, so everything from there on stays as it is.
 *
 * @param {string[]} args The arguments after `add`.
 * @returns {McpPlan}
 */
function planAdd(args) {
  const piArgs = ["add"];
  /** @type {string | undefined} */
  let name;
  let url = false;
  let workspace = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") {
      piArgs.push(...args.slice(index));
      break;
    }
    if (arg === "--workspace" || arg === "--local" || arg === "-l") {
      piArgs.push("--local");
      workspace = true;
      continue;
    }
    const option = longName(arg);
    if (option !== undefined && ADD_VALUE_OPTIONS.has(option)) {
      const inline = arg.indexOf("=");
      const value = inline === -1 ? args[++index] : arg.slice(inline + 1);
      if (option === "url") {
        if (url) return usage("add takes one URL.");
        url = true;
      }
      piArgs.push(`--${option}`);
      if (value !== undefined) piArgs.push(value);
      continue;
    }
    if (option === "workspace") return usage("--workspace takes no value.");
    if (arg.startsWith("-") && arg !== "-") {
      piArgs.push(arg);
      continue;
    }
    if (name === undefined) {
      name = arg;
      piArgs.push(arg);
      continue;
    }
    if (/^https?:\/\//i.test(arg)) {
      if (url) return usage("add takes one URL.");
      url = true;
      piArgs.push("--url", arg);
      continue;
    }
    // A command without `--`: Pi reads it and everything after it as the command line.
    piArgs.push(...args.slice(index));
    break;
  }
  return workspace && name !== undefined ? { action: "pi", args: piArgs, projectServer: name } : { action: "pi", args: piArgs };
}

/**
 * Translate `remove`: `--workspace` becomes `--local`.
 *
 * @param {string[]} args The arguments after `remove`.
 * @returns {McpPlan}
 */
function planRemove(args) {
  const end = args.indexOf("--");
  const options = end === -1 ? args : args.slice(0, end);
  const rest = end === -1 ? [] : args.slice(end);
  return { action: "pi", args: ["remove", ...options.map((arg) => (arg === "--workspace" ? "--local" : arg)), ...rest] };
}

/**
 * Parse an ampi subcommand's arguments strictly.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {import("node:util").ParseArgsConfig["options"]} options
 * @returns {{ values: Record<string, unknown>, positionals: string[] } | { error: string }}
 */
function parseStrict(command, args, options) {
  try {
    return /** @type {any} */ (parseArgs({ args, options, allowPositionals: true, strict: true }));
  } catch (error) {
    return { error: `mcp ${command}: ${messageOf(error)}` };
  }
}

/**
 * Translate `oauth login|logout|status`.
 *
 * @param {string[]} args The arguments after `oauth`.
 * @returns {McpPlan}
 */
function planOauth(args) {
  const [command, ...rest] = args;
  if (command === undefined) return usage("mcp oauth needs a command: login, logout or status.");
  const end = rest.indexOf("--");
  const credential = (end === -1 ? rest : rest.slice(0, end)).find((arg) => CLIENT_CREDENTIAL_OPTIONS.has(longName(arg) ?? ""));
  if (credential !== undefined) return usage(CLIENT_CREDENTIALS_MESSAGE);
  if (command === "login" || command === "logout") {
    // Pi reads only `--timeout <seconds>`.
    const options = (end === -1 ? rest : rest.slice(0, end)).flatMap((arg) => (arg.startsWith("--timeout=") ? ["--timeout", arg.slice("--timeout=".length)] : [arg]));
    return { action: "pi", args: [command, ...options, ...(end === -1 ? [] : rest.slice(end))] };
  }
  if (command !== "status") return usage(`unknown mcp oauth command "${command}".`);
  const parsed = parseStrict("oauth status", rest, {});
  if ("error" in parsed) return usage(parsed.error);
  if (parsed.positionals.length !== 1) return usage("mcp oauth status needs exactly one argument: a server name.");
  return { action: "oauth-status", name: parsed.positionals[0] };
}

/**
 * Decide what `ampi mcp <argv>` does, without running anything: show help,
 * run `pi mcp` with translated arguments, run one of ampi's own commands, or
 * stop with a usage error.
 *
 * @param {readonly string[]} argv The command line after `mcp`.
 * @returns {McpPlan}
 */
export function planMcpCommand(argv) {
  const [command, ...rest] = argv;
  const end = argv.indexOf("--");
  if (command === undefined || command === "help" || (end === -1 ? argv : argv.slice(0, end)).some(isHelp)) return { action: "help" };
  if (command === "--pi-help") return { action: "pi", args: ["--help"] };
  switch (command) {
    case "add":
      return planAdd(rest);
    case "remove":
      return planRemove(rest);
    case "oauth":
      return planOauth(rest);
    case "remote":
      return usage(REMOTE_MESSAGE);
    case "doctor": {
      const parsed = parseStrict("doctor", rest, {});
      if ("error" in parsed) return usage(parsed.error);
      if (parsed.positionals.length > 1) return usage("mcp doctor takes at most one server name.");
      return parsed.positionals.length === 1 ? { action: "doctor", name: parsed.positionals[0] } : { action: "doctor" };
    }
    case "approve": {
      const parsed = parseStrict("approve", rest, { yes: { type: "boolean", short: "y" } });
      if ("error" in parsed) return usage(parsed.error);
      if (parsed.positionals.length !== 1) return usage("mcp approve needs exactly one argument: a server name.");
      return { action: "approve", name: parsed.positionals[0], yes: parsed.values.yes === true };
    }
    default:
      return { action: "pi", args: [...argv] };
  }
}

/**
 * Run `ampi mcp …`.
 *
 * @param {readonly string[]} argv The command line after `mcp`.
 * @param {McpHost} host
 * @returns {Promise<number>} The exit code.
 */
export async function runMcpCommand(argv, host) {
  const outcome = await dispatch(planMcpCommand(argv), host);
  if (outcome.message !== undefined) host.log.error(outcome.code === 2 ? `${clean(outcome.message)}\n${USAGE_HINT}` : clean(outcome.message));
  return outcome.code;
}

/**
 * @param {McpPlan} plan
 * @param {McpHost} host
 * @returns {Promise<Outcome>}
 */
async function dispatch(plan, host) {
  switch (plan.action) {
    case "help":
      host.out(formatMcpHelp());
      return { code: 0 };
    case "usage":
      return { code: 2, message: plan.message };
    case "pi": {
      const code = await host.runPi(plan.args);
      if (code === 0 && plan.projectServer !== undefined && readPiProjectTrust(await host.loadPi(), host.cwd).decision !== true) {
        host.log.info(`run ampi mcp approve ${clean(plan.projectServer)} to trust this project from the shell.`);
      }
      return { code };
    }
    case "doctor":
      return doctor(host, plan.name);
    case "approve":
      return approve(host, plan.name, plan.yes);
    case "oauth-status":
      return oauthStatus(host, plan.name);
  }
}

/**
 * Run `pi mcp list --json` and read it. Pi exits 1 when a server is not
 * connected and still prints the list, so only the output counts.
 *
 * @param {McpHost} host
 * @returns {PiMcpList | Outcome}
 */
function readList(host) {
  const result = host.capturePi(["list", "--json"]);
  if (result.error) return fail(`could not run Pi: ${result.error.message}`);
  try {
    return parsePiMcpList(result.stdout);
  } catch (error) {
    if (result.stderr !== "") host.piStderr(clean(result.stderr));
    return fail(`could not read the server list from pi mcp list --json: ${messageOf(error)}`);
  }
}

/**
 * The servers' names for a message, or "none".
 *
 * @param {PiMcpList} list
 */
const namesOf = (list) => list.servers.map((server) => server.name).join(", ") || "none";

/**
 * A server of the list by name; an outcome naming the configured servers when there is none.
 *
 * @param {PiMcpList} list
 * @param {string} name
 * @returns {PiMcpServerReport | Outcome}
 */
function findServer(list, name) {
  const server = list.servers.find((entry) => entry.name === name);
  if (server !== undefined) return server;
  return fail(`no MCP server named "${name}". Configured: ${namesOf(list)}.${list.note ? ` ${list.note}` : ""}`);
}

/** @param {string} state */
const statusWord = (state) => (state === "needs-auth" ? "needs sign-in" : state);

/**
 * @param {McpHost} host
 * @param {string | undefined} name
 * @returns {Promise<Outcome>}
 */
async function doctor(host, name) {
  const list = readList(host);
  if ("code" in list) return list;
  /** @type {PiMcpServerReport[]} */
  let shown = list.servers;
  if (name !== undefined) {
    const found = findServer(list, name);
    if ("code" in found) return found;
    shown = [found];
  }
  if (shown.length === 0 && list.errors.length === 0) {
    host.out("No MCP servers configured. Add one with ampi mcp add <name> -- <command> or ampi mcp add <name> <url>.\n");
  } else if (shown.length > 0) {
    const rows = [
      ["NAME", "STATUS", "TRANSPORT", "TOOLS", "ERROR"],
      ...shown.map((server) => [
        server.name,
        statusWord(server.state),
        server.kind,
        server.enabled ? String(server.tools.length) : "-",
        (server.error ?? "").split("\n")[0].trim(),
      ]),
    ].map((row) => row.map(clean));
    // On a narrow terminal the error is cut first, and dropped when too little room is left for it.
    const widths = [0, 1, 2, 3].map((column) => Math.max(...rows.map((row) => visibleWidth(row[column]))));
    const room = host.columns - widths.reduce((sum, width) => sum + width + 2, 0);
    const lines = rows.map((row) => {
      const fixed = widths.map((width, column) => padEnd(row[column], width)).join("  ");
      if (room < ERROR_MIN) return fixed.trimEnd();
      return `${fixed}  ${Number.isFinite(room) ? cut(row[4], room) : row[4]}`.trimEnd();
    });
    host.out(`${lines.map((line) => (Number.isFinite(host.columns) ? cut(line, Math.max(host.columns, 20)) : line)).join("\n")}\n`);
    for (const server of shown.filter((entry) => entry.state === "needs-auth")) {
      host.out(`Sign in to ${clean(server.name)} with ampi mcp oauth login ${clean(server.name)}.\n`);
    }
  }
  const errors = name === undefined ? list.errors : [];
  for (const error of errors) host.log.error(`config error: ${clean(error)}`);
  if (list.note) host.log.info(`${clean(list.note)} Or trust it with ampi mcp approve <name>.`);
  const failed = errors.length > 0 || shown.some((server) => server.enabled && server.state !== "connected");
  return { code: failed ? 1 : 0 };
}

/**
 * @param {McpHost} host
 * @param {string} name
 * @returns {Promise<Outcome>}
 */
async function oauthStatus(host, name) {
  const list = readList(host);
  if ("code" in list) return list;
  const server = findServer(list, name);
  if ("code" in server) return server;
  const label = clean(name);
  if (!piMcpUsesOAuth(server)) {
    const why = server.kind === "stdio" ? "Pi starts it as a local command" : "its configuration sets its own Authorization header or auth";
    host.out(`${label}: not an OAuth server (${why})\n`);
    return { code: 0 };
  }
  if (server.state === "needs-auth") {
    host.out(`${label}: needs sign-in (ampi mcp oauth login ${label})\n`);
    return { code: 0 };
  }
  if (server.state === "connected") {
    host.out(`${label}: signed in\n`);
    return { code: 0 };
  }
  const error = server.error ? `: ${server.error.split("\n")[0]}` : "";
  return fail(`cannot tell whether ${name} is signed in: it is ${server.state}${error}.`);
}

/**
 * The servers of the project's `.pi/mcp.json`, in file order, or undefined when the file does not exist.
 *
 * @param {string} file
 * @returns {[string, Record<string, unknown>][] | undefined}
 */
function readProjectServers(file) {
  /** @type {string} */
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return undefined;
    throw error;
  }
  const servers = JSON.parse(text.replace(/^﻿/, "")).mcpServers;
  if (servers === null || typeof servers !== "object") return [];
  return Object.entries(servers).map(([name, config]) => [name, config !== null && typeof config === "object" ? config : {}]);
}

/**
 * How a project server starts, for the approval listing: its URL or command
 * line, then the names (never the values) of the environment variables it
 * sets and its working directory.
 *
 * @param {Record<string, unknown>} config
 * @returns {string[]}
 */
function describeServer(config) {
  const disabled = config.enabled === false ? " (disabled)" : "";
  const lines = [];
  if (typeof config.url === "string") lines.push(`${config.url}${disabled}`);
  else if (typeof config.command === "string") {
    const args = Array.isArray(config.args) ? config.args.map(String) : [];
    lines.push(`${[config.command, ...args].join(" ")}${disabled}`);
  } else lines.push(`changes only the settings of the user server of this name${disabled}`);
  const env = config.env !== null && typeof config.env === "object" ? Object.keys(config.env) : [];
  if (env.length > 0) lines.push(`env: ${env.join(", ")}`);
  if (typeof config.cwd === "string") lines.push(`cwd: ${config.cwd}`);
  return lines.map(oneLine);
}

/**
 * @param {McpHost} host
 * @param {string} name
 * @param {boolean} yes
 * @returns {Promise<Outcome>}
 */
async function approve(host, name, yes) {
  const pi = await host.loadPi();
  const file = piProjectMcpPath(pi, host.cwd);
  /** @type {[string, Record<string, unknown>][] | undefined} */
  let servers;
  try {
    servers = readProjectServers(file);
  } catch (error) {
    return fail(`could not read ${file}: ${messageOf(error)}`);
  }
  if (servers === undefined) return fail(`this project has no ${file}. Add a project server with ampi mcp add ${name} --workspace -- <command>.`);
  if (!servers.some(([server]) => server === name)) {
    return fail(`no server named "${name}" in ${file}. Project servers: ${servers.map(([server]) => server).join(", ") || "none"}.`);
  }
  /** @type {{ decision: boolean | null, path?: string }} */
  let trust;
  try {
    trust = readPiProjectTrust(pi, host.cwd);
  } catch (error) {
    return fail(`could not read Pi's trust store: ${messageOf(error)}`);
  }
  if (trust.decision === true) {
    host.out(`This project is already trusted (saved for ${clean(trust.path ?? host.cwd)}): Pi starts the servers in ${clean(file)}.\n`);
    return { code: 0 };
  }
  const names = servers.map(([server]) => oneLine(server));
  const width = Math.max(...names.map(visibleWidth));
  const others = listPiTrustResources(pi, host.cwd).filter((resource) => resource !== file);
  const lines = [
    "Pi trusts a whole project, not one server. Trusting this directory:",
    `  ${host.cwd}`,
    `lets Pi start every server in ${file}:`,
    ...servers.flatMap(([, config], index) => describeServer(config).map((text, line) => `  ${padEnd(line === 0 ? names[index] : "", width)}  ${text}`)),
  ];
  if (others.length > 0) lines.push("and load these project resources, which can also run code:", ...others.map((resource) => `  ${resource}`));
  if (trust.decision === false) lines.push(`Pi has a saved decision not to trust ${trust.path}; approving replaces it for this directory.`);
  lines.push("Approve only a project whose files you trust: the servers run with your permissions.");
  host.out(`${lines.map(clean).join("\n")}\n`);
  if (!yes) {
    if (!host.interactive) return fail("approve asks before it trusts the project, and there is no terminal to ask in; pass --yes to trust it.");
    if (!(await host.confirm("Trust this project? [y/N] "))) return fail("nothing changed.");
  }
  try {
    trustPiProject(pi, host.cwd);
  } catch (error) {
    return fail(`could not save trust in Pi's trust store: ${messageOf(error)}`);
  }
  host.out(`Trusted ${clean(host.cwd)} in Pi's trust store. Sessions started here now load its project resources, including the server ${clean(name)}.\n`);
  return { code: 0 };
}
