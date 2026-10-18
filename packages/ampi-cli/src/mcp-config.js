// `--mcp-config`: MCP servers for one run, given as JSON or as a JSON file,
// registered through Pi's extension API (`pi.registerMcpServer`) every time
// Pi loads extensions, so they connect at session start and again after
// /reload, /new and the other runtime replacements. Pi validates each entry
// when it is registered; its validator is not exported, so an invalid entry is
// found while extensions load, before the session starts.
import { readFileSync } from "node:fs";
import path from "node:path";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** @param {unknown} error */
const messageOf = (error) => (error instanceof Error ? error.message : String(error));

/**
 * The servers a `--mcp-config` value names. A value that starts with `{` after
 * trimming is JSON; anything else is a file path relative to `cwd`. Both Pi's
 * `mcp.json` shape (`{"mcpServers": {...}}`) and a bare map of servers by name
 * are accepted.
 *
 * @param {string} value
 * @param {string} cwd
 * @param {(file: string) => string} [readFile]
 * @returns {{ servers: Record<string, unknown> } | { error: string }}
 */
export function readMcpConfigFlag(value, cwd, readFile = (file) => readFileSync(file, "utf8")) {
  let text = value;
  let source = "the --mcp-config value";
  if (!value.trim().startsWith("{")) {
    const file = path.resolve(cwd, value);
    try {
      text = readFile(file);
    } catch (error) {
      return { error: `--mcp-config: cannot read ${file}: ${messageOf(error)}` };
    }
    source = file;
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { error: `--mcp-config: ${source} is not valid JSON: ${messageOf(error)}` };
  }
  if (!isRecord(parsed)) return { error: `--mcp-config: ${source} must be a JSON object of MCP servers by name.` };
  const servers = "mcpServers" in parsed ? parsed.mcpServers : parsed;
  if (!isRecord(servers)) return { error: `--mcp-config: "mcpServers" in ${source} must be an object of MCP servers by name.` };
  return { servers };
}

/** Pi treats server names that differ only in `-` and `_` as the same server. */
const sameServerKey = (/** @type {string} */ name) => name.replaceAll("-", "_");

/**
 * Names of the servers an `mcp.json` file defines. A project entry without
 * `command`, `url` or `type` only overrides a user server of that name, so it
 * defines nothing of its own. A file that is missing or unreadable defines
 * none; Pi reports a broken one itself.
 *
 * @param {string} file
 * @param {boolean} project
 * @returns {string[]}
 */
function definedServers(file, project) {
  try {
    const servers = JSON.parse(readFileSync(file, "utf8"))?.mcpServers;
    if (!isRecord(servers)) return [];
    return Object.keys(servers).filter((name) => {
      const entry = servers[name];
      return !project || (isRecord(entry) && ("command" in entry || "url" in entry || "type" in entry));
    });
  } catch {
    return [];
  }
}

/**
 * @typedef {object} McpConfigPaths Where Pi reads `mcp.json`.
 * @property {string} agentDir Pi's configuration directory, with the user's `mcp.json`.
 * @property {string} configDirName The project directory with the project's `mcp.json` (`.pi`).
 *
 * @typedef {object} McpConfigHost
 * @property {(text: string) => void} warn Writes a line to stderr.
 * @property {(text: string) => void} fail Writes a line to stderr and exits with status 2.
 */

/** @type {McpConfigHost} */
const DEFAULT_HOST = {
  warn: (text) => process.stderr.write(`${text}\n`),
  fail: (text) => {
    process.stderr.write(`${text}\n`);
    process.exit(2);
  },
};

/**
 * The inline Pi extension that registers the `--mcp-config` servers. Pi keeps
 * a server of the same name from the user's or the project's `mcp.json`
 * instead; the first session start says so once for each such server, on
 * stderr, or as a notification in the terminal UI.
 *
 * @param {Record<string, unknown>} servers
 * @param {McpConfigPaths} paths
 * @param {McpConfigHost} [host]
 * @returns {(pi: any) => void}
 */
export function createMcpConfigExtension(servers, paths, host = DEFAULT_HOST) {
  let checked = false;
  return (pi) => {
    for (const [name, config] of Object.entries(servers)) {
      try {
        pi.registerMcpServer(name, config);
      } catch (error) {
        host.fail(`ampi: --mcp-config: ${messageOf(error)}`);
        return;
      }
    }
    pi.on("session_start", (/** @type {unknown} */ _event, /** @type {any} */ ctx) => {
      if (checked) return;
      checked = true;
      // The project's file first: its entry replaces the user's.
      const files = [{ file: path.join(paths.agentDir, "mcp.json"), project: false }];
      if (ctx.isProjectTrusted()) files.unshift({ file: path.join(ctx.cwd, paths.configDirName, "mcp.json"), project: true });
      for (const name of Object.keys(servers)) {
        const found = files.find(({ file, project }) => definedServers(file, project).some((defined) => sameServerKey(defined) === sameServerKey(name)));
        if (found === undefined) continue;
        const text = `ampi: the MCP server "${name}" from --mcp-config is not used: ${found.file} defines a server of that name, which Pi uses instead.`;
        if (ctx.hasUI) ctx.ui.notify(text, "warning");
        else host.warn(text);
      }
    });
  };
}
