// `ampi tools list` and `ampi tools show`: the tools a session declares to
// the model in an ampi mode. The command starts a session in memory (no
// session file, no model call, no MCP connection), lets ampi apply the mode as
// it does when a session starts, and reads Pi's active tool set.
import path from "node:path";
import { parseArgs } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AMPI_PACKAGE_NAME, readPackageAt } from "./packages.js";
import { listPiMcpServers, piToolOrigin } from "./pi-compat.js";
import { createAmpiSdkSession } from "./sdk-session.js";
import { AMPI_CORE_RUNTIME_GLOBAL_KEY } from "./stream-json.js";
import { cut } from "./threads.js";

/**
 * @typedef {object} PiToolInfo The parts of Pi's `ToolInfo` the command reads.
 * @property {string} name
 * @property {string} description
 * @property {any} parameters JSON Schema of the tool's input.
 * @property {{ path: string, source: string, origin: string, baseDir?: string }} [sourceInfo]
 * @property {{ name: string }} [namespace]
 *
 * @typedef {object} SessionTools What a new session in a mode declares to the model.
 * @property {string | undefined} mode The ampi mode the session runs in; undefined when ampi could not
 *   apply one.
 * @property {PiToolInfo[]} tools The active tools.
 * @property {string[]} problems Errors from loading extensions or reading flags.
 * @property {string[]} mcpServers Configured MCP servers, whose tools the session does not connect to.
 *
 * @typedef {object} ToolsHost
 * @property {(ampiMode: string | undefined) => Promise<SessionTools>} readTools Start a session in
 *   the mode (undefined: the mode a new session starts in) and read its tools.
 * @property {number} columns Width the text listing fits its rows into.
 * @property {(text: string) => void} out Writes to stdout.
 * @property {import("./log.js").Logger} log For the command's diagnostics.
 */

const USAGE_HINT = "Run ampi tools --help for the options.";

/** The canonical ampi modes and the legacy names they accept, as ampi-core's modes.ts defines them. */
const MODE_KEYS = ["low", "medium", "high", "ultra", "free"];
/** @type {Record<string, string>} */
const MODE_ALIASES = { rush: "low", smart: "medium", deep: "high", fable: "ultra" };

/** Group order of the text listing; `extension:<name>` groups sit between ampi and mcp. */
const SOURCE_ORDER = ["built-in", "ampi", "extension", "mcp"];

/** @type {Record<string, string>} */
export const ALIASES = { ls: "list" };

export const OPTIONS = /** @type {const} */ ({
  json: { type: "boolean" },
  mode: { type: "string", short: "m" },
  help: { type: "boolean", short: "h" },
});

/** C0 and C1 control characters: descriptions are printed to a terminal, so none may start an escape sequence. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * The text `ampi tools --help` prints.
 *
 * @returns {string}
 */
export function formatToolsHelp() {
  return `ampi tools: show the tools a session declares to the model in an ampi mode

Usage: ampi tools list [--json] [--mode <mode>]
       ampi tools show <tool> [--json] [--mode <mode>]

Commands:

  list, ls                      Print the active tools, grouped by where they come from:
                                built-in (Pi), ampi, extension:<name> (other packages and
                                extension files) and mcp
  show <tool>                   Print one active tool's full description and parameters

Options:

  -m, --mode <mode>             low, medium, high, ultra or free (rush, smart, deep and fable are
                                accepted as aliases). Default: the mode a new session starts in,
                                from ampi's defaultMode setting, else medium.
  --json                        list: an array of { name, source, description }, sorted by name;
                                show: an object { name, description, source, inputSchema }

The command loads what ampi loads in this directory and starts a session in memory: it writes no
session file, calls no model, installs no packages and connects no MCP servers, so MCP tools are
not listed (ampi mcp list shows the servers). A mode starts only with a model that has
credentials, as in a session.

Exit status: 0 on success, 1 when the mode does not start or the tool is not active, 2 on a usage
error.

Examples:

  $ ampi tools list
  $ ampi tools list --mode high --json | jq -r '.[].name'
  $ ampi tools show read
`;
}

/**
 * The canonical mode for a --mode value, or undefined when there is none.
 *
 * @param {string} value
 * @returns {string | undefined}
 */
export function resolveModeArgument(value) {
  const key = value.trim().toLowerCase();
  return MODE_KEYS.includes(key) ? key : MODE_ALIASES[key];
}

/**
 * Where a tool comes from: `built-in` for Pi's own tools, `ampi` for ampi's,
 * `mcp` for MCP server and resource tools, and `extension:<name>` for any
 * other package (by its package name) or extension file (by its file name, or
 * its directory's for an index file).
 *
 * @param {PiToolInfo} info
 * @returns {string}
 */
export function toolSource(info) {
  const origin = piToolOrigin(info);
  if (info.name.startsWith("mcp__") || info.namespace?.name.startsWith("mcp__")) return "mcp";
  if ("builtin" in origin) return origin.builtin === "mcp" ? "mcp" : "built-in";
  const owner = origin.file === "" ? undefined : readPackageAt(origin.file);
  if (owner?.name === AMPI_PACKAGE_NAME) return "ampi";
  if (origin.packageRoot !== undefined || origin.packageSource !== undefined) {
    const name = (origin.packageRoot && readPackageAt(origin.packageRoot)?.name) || origin.packageSource;
    if (name) return `extension:${name}`;
  }
  const base = path.basename(origin.file, path.extname(origin.file));
  return `extension:${base === "index" ? path.basename(path.dirname(origin.file)) : base || "unknown"}`;
}

/**
 * Run `ampi tools list` or `ampi tools show`.
 *
 * @param {readonly string[]} argv The command line after `tools`.
 * @param {ToolsHost} host
 * @returns {Promise<number>} The exit code.
 */
export async function runToolsCommand(argv, host) {
  /** @type {{ values: { json?: boolean, mode?: string, help?: boolean }, positionals: string[] }} */
  let parsed;
  try {
    parsed = /** @type {any} */ (parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true }));
  } catch (error) {
    host.log.error(`tools: ${error instanceof Error ? error.message : String(error)}\n${USAGE_HINT}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [given, ...rest] = positionals;
  if (values.help || given === "help") {
    host.out(formatToolsHelp());
    return 0;
  }
  if (given === undefined) {
    host.log.error(`tools needs a command: list or show.\n${USAGE_HINT}`);
    return 2;
  }
  const command = ALIASES[given] ?? given;
  if (command !== "list" && command !== "show") {
    host.log.error(`unknown tools command "${given}".\n${USAGE_HINT}`);
    return 2;
  }
  if (command === "list" && rest.length > 0) {
    host.log.error(`tools list takes no arguments.\n${USAGE_HINT}`);
    return 2;
  }
  if (command === "show" && rest.length !== 1) {
    host.log.error(`tools show needs exactly one tool name.\n${USAGE_HINT}`);
    return 2;
  }
  /** @type {string | undefined} */
  let mode;
  if (values.mode !== undefined) {
    mode = resolveModeArgument(values.mode);
    if (mode === undefined) {
      const aliases = Object.keys(MODE_ALIASES).join(", ");
      host.log.error(`unknown mode "${values.mode}". Valid modes: ${MODE_KEYS.join(", ")} (aliases: ${aliases}).`);
      return 2;
    }
  }

  const found = await host.readTools(mode);
  for (const problem of found.problems) host.log.warn(problem);
  if (found.mode === undefined || (mode !== undefined && found.mode !== mode)) {
    const which = mode === undefined ? "The default mode" : `${mode[0].toUpperCase()}${mode.slice(1)} mode`;
    host.log.error(
      `${which} does not start in this directory, so its tools are unknown: none of its models has ` +
        "credentials, or none of its tools is available. Sign in with /login in ampi, or pick another mode with --mode.",
    );
    return 1;
  }
  const tools = found.tools.map((info) => ({ info, source: toolSource(info) }));
  if (command === "list") {
    host.out(values.json ? formatListJson(tools) : formatListText(tools, found.mode, host.columns, found.mcpServers));
    return 0;
  }
  const wanted = rest[0];
  const match = tools.find((tool) => tool.info.name === wanted);
  if (match === undefined) {
    const near = closeNames(wanted, tools.map((tool) => tool.info.name));
    const hint = near.length > 0 ? ` Did you mean ${near.join(", ")}?` : " ampi tools list shows the active tools.";
    host.log.error(`no tool named "${wanted}" is active in ${found.mode} mode.${hint}`);
    return 1;
  }
  host.out(values.json ? formatShowJson(match) : formatShowText(match));
  return 0;
}

/**
 * Start a session in memory in `cwd` and read the tools it declares to the
 * model once ampi has applied the mode. The session ends before this returns.
 *
 * @param {any} pi The `@earendil-works/pi-coding-agent` module.
 * @param {string} cwd
 * @param {string | undefined} ampiMode
 * @returns {Promise<SessionTools>}
 */
export async function readSessionTools(pi, cwd, ampiMode) {
  const runtime = await createAmpiSdkSession({
    cwd,
    sessionManager: pi.SessionManager.inMemory(cwd),
    mode: "print",
    connectMcp: false,
    ampiMode,
    pi,
  });
  try {
    const { session } = runtime;
    /** @type {Map<string, PiToolInfo>} */
    const all = new Map(session.getAllTools().map((/** @type {PiToolInfo} */ info) => [info.name, info]));
    /** @type {string[]} */
    const active = session.getActiveToolNames();
    const state = /** @type {any} */ (globalThis)[AMPI_CORE_RUNTIME_GLOBAL_KEY]?.getMmrModeState?.();
    /** @type {{ type: string, message: string }[]} */
    const diagnostics = runtime.diagnostics ?? [];
    return {
      mode: typeof state?.mode === "string" ? state.mode : undefined,
      tools: active.flatMap((name) => all.get(name) ?? []),
      problems: diagnostics.filter((entry) => entry.type === "error").map((entry) => entry.message),
      mcpServers: listPiMcpServers(pi, cwd),
    };
  } finally {
    await runtime.dispose();
  }
}

/**
 * @typedef {{ info: PiToolInfo, source: string }} SourcedTool
 */

/** @param {string} text */
const clean = (text) => text.replace(CONTROL, "");

/**
 * The first paragraph of a description, on one line.
 *
 * @param {string} description
 */
function firstParagraph(description) {
  const paragraph = clean(description ?? "").trim().split(/\n\s*\n/)[0] ?? "";
  return paragraph.replace(/\s+/g, " ").trim();
}

/**
 * The first sentence of a description, without its closing full stop.
 *
 * @param {string} description
 */
function firstSentence(description) {
  const paragraph = firstParagraph(description);
  const sentence = /^.*?[.!?](?=\s|$)/.exec(paragraph)?.[0] ?? paragraph;
  return sentence.replace(/\.$/, "");
}

/**
 * Names in alphabetical order, ignoring case.
 *
 * @param {string} a
 * @param {string} b
 */
const compareNames = (a, b) => {
  const [lowerA, lowerB] = [a.toLowerCase(), b.toLowerCase()];
  if (lowerA !== lowerB) return lowerA < lowerB ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * @param {SourcedTool[]} tools
 * @returns {SourcedTool[]}
 */
const byName = (tools) => [...tools].sort((a, b) => compareNames(a.info.name, b.info.name));

/**
 * @param {SourcedTool[]} tools
 * @returns {string}
 */
function formatListJson(tools) {
  const rows = byName(tools).map(({ info, source }) => ({ name: info.name, source, description: firstParagraph(info.description) }));
  return `${JSON.stringify(rows, null, 2)}\n`;
}

/** @param {string} source */
const sourceRank = (source) => SOURCE_ORDER.indexOf(source.startsWith("extension:") ? "extension" : source);

/**
 * The text listing: a count line naming the mode, then one group per source
 * (built-in, ampi, each extension, mcp) with a row per tool: its name padded
 * to the longest name, then the first sentence of its description cut to the
 * terminal width.
 *
 * @param {SourcedTool[]} tools
 * @param {string} mode
 * @param {number} columns
 * @param {string[]} mcpServers
 * @returns {string}
 */
function formatListText(tools, mode, columns, mcpServers) {
  const lines = [`${tools.length} ${tools.length === 1 ? "tool" : "tools"} active in ${mode} mode`];
  const sources = [...new Set(tools.map((tool) => tool.source))].sort((a, b) => sourceRank(a) - sourceRank(b) || (a < b ? -1 : 1));
  const nameWidth = Math.max(0, ...tools.map((tool) => visibleWidth(tool.info.name)));
  for (const source of sources) {
    lines.push("", source);
    for (const { info } of byName(tools.filter((tool) => tool.source === source))) {
      const name = info.name + " ".repeat(nameWidth - visibleWidth(info.name));
      const row = `  ${name}  ${firstSentence(info.description)}`.trimEnd();
      lines.push(Number.isFinite(columns) ? cut(row, Math.max(columns, nameWidth + 4)) : row);
    }
  }
  if (mcpServers.length > 0) {
    lines.push(
      "",
      mcpServers.length === 1
        ? "1 MCP server is configured; its tools are not listed. ampi mcp list shows it."
        : `${mcpServers.length} MCP servers are configured; their tools are not listed. ampi mcp list shows them.`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * @param {SourcedTool} tool
 * @returns {string}
 */
function formatShowJson({ info, source }) {
  return `${JSON.stringify({ name: info.name, description: info.description ?? "", source, inputSchema: info.parameters ?? {} }, null, 2)}\n`;
}

/**
 * The type of a JSON Schema property in a few words: its type or types, or
 * those of its alternatives.
 *
 * @param {any} schema
 * @returns {string}
 */
function schemaType(schema) {
  if (schema === null || typeof schema !== "object") return "any";
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives)) return [...new Set(alternatives.map(schemaType))].join(" | ");
  if ("const" in schema) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.map((/** @type {unknown} */ value) => JSON.stringify(value)).join(" | ");
  return "any";
}

/**
 * A heading with the name and source, the full description, then one line
 * per top-level parameter: its name, type, whether it is required, and its
 * description.
 *
 * @param {SourcedTool} tool
 * @returns {string}
 */
function formatShowText({ info, source }) {
  const schema = info.parameters ?? {};
  /** @type {Record<string, any>} */
  const properties = schema.properties ?? {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const lines = [`${info.name} (${source})`, "", clean(info.description ?? "").trim(), "", "Parameters:"];
  const names = Object.keys(properties);
  if (names.length === 0) lines.push("  none");
  for (const name of names) {
    const property = properties[name];
    const kind = `${schemaType(property)}${required.has(name) ? ", required" : ""}`;
    const description = clean(typeof property?.description === "string" ? property.description : "").replace(/\s+/g, " ").trim();
    lines.push(`  ${clean(name)} (${kind})${description ? `: ${description}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Up to three names close to `wanted`: those that contain it or differ from it
 * by a few edits, closest first.
 *
 * @param {string} wanted
 * @param {string[]} names
 * @returns {string[]}
 */
function closeNames(wanted, names) {
  const target = wanted.toLowerCase();
  const limit = Math.max(2, Math.floor(target.length / 3));
  return names
    .map((name) => {
      const lower = name.toLowerCase();
      return { name, distance: lower.includes(target) || target.includes(lower) ? 0 : editDistance(target, lower) };
    })
    .filter((candidate) => candidate.distance <= limit)
    .sort((a, b) => a.distance - b.distance || compareNames(a.name, b.name))
    .slice(0, 3)
    .map((candidate) => candidate.name);
}

/**
 * Levenshtein distance between two strings.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}
