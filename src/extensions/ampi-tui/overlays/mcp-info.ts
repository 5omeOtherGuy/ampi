import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { isRecord } from "../../ampi-core/internal/json.js";
import type { MmrFrameTheme } from "../ui/frame.js";
import { openMmrScrollOverlay } from "./help-keymap.js";
import { tildeMmrPath } from "./info.js";

/**
 * The MCP Servers dialog: two tabs in the shared frame, Servers and Tools,
 * with Tab moving between them.
 *
 * ```
 * ╭─ MCP Servers ────────────────────────────────────────────────────────╮
 * │                                                                      │
 * │ Servers  ·  Tools                                                    │
 * │                                                                      │
 * │ docs        connected      3 tools  codemode  ~/.pi/agent/mcp.json   │
 * │ tracker     not connected  0 tools  deferred  .pi/mcp.json           │
 * │ old-search  disabled       0 tools  codemode  ~/.pi/agent/mcp.json   │
 * │                                                                      │
 * │ Run /mcp to sign in, reconnect, change a server's exposure or turn … │
 * ╰─────────────────────────────────────── Tab switch tab · Esc close ─╯
 * ```
 *
 * The servers come from the same places Pi reads them: the user's `mcp.json`
 * in Pi's agent directory, the project's `.pi/mcp.json` when the project is
 * trusted, and the servers extensions register. Pi does not tell extensions
 * how a connection is doing, so a server with tools counts as connected.
 */

export const MMR_MCP_TITLE = "MCP Servers";
export const MMR_MCP_TABS: readonly string[] = ["Servers", "Tools"];
/** Box width before Pi narrows it to the terminal width less four. */
export const MMR_MCP_WIDTH = 80;
/** Pi's slash command that manages MCP connections; missing when MCP support is off. */
export const MMR_MCP_SLASH_COMMAND = "mcp";

const MCP_FILE = "mcp.json";
const TOOL_PREFIX = "mcp__";
const NAMESPACE_SEPARATOR = "__";
const DEFAULT_EXPOSURE = "codemode";
/** Older exposure names Pi still accepts. */
const EXPOSURE_ALIASES: Readonly<Record<string, string>> = { "codemode-deferred": "codemode" };
/** Keys a project entry without `command`, `url` or `type` may set over a user server of the same name. */
const OVERRIDE_KEYS: ReadonlySet<string> = new Set(["enabled", "exposure", "toolExposure"]);
const ROW_INDENT = 2;
const COLUMN_GAP = 2;
/** Widest the server and tool name columns get. */
const NAME_COLUMN_MAX = 28;

export const MMR_MCP_MANAGE_NOTE = "Run /mcp to sign in, reconnect, change a server's exposure or turn a server on or off.";
export const MMR_MCP_OFF_NOTE = "MCP support is off in this session (/mcp is not registered, as with --no-mcp), so Pi connects none of these servers.";
export const MMR_MCP_NO_SERVERS =
  "No MCP servers are set up. Add one with pi mcp add, or list it under mcpServers in mcp.json in Pi's agent directory, or in .pi/mcp.json for one project.";
export const MMR_MCP_NO_TOOLS = "No MCP tools. A server's tools show here once it connects.";

/** One `mcp.json` as read from disk. */
export interface MmrMcpConfigFile {
  readonly path: string;
  readonly scope: "user" | "project";
  /** The file's text; undefined when the file does not exist. */
  readonly text?: string;
  /** Set when the file exists but could not be read. */
  readonly error?: string;
}

/** A server an extension registered, as `pi.getMcpServers()` lists it. */
export interface MmrMcpRegisteredServer {
  readonly name: string;
  readonly config: unknown;
  readonly extensionPath: string;
}

/** A tool as `pi.getAllTools()` lists it. */
export interface MmrMcpToolInfo {
  readonly name: string;
  readonly description?: string;
  readonly namespace?: { readonly name: string };
}

export interface MmrMcpSource {
  readonly kind: "user" | "project" | "extension";
  /** The file or extension that defines the server. */
  readonly path: string;
  /** A project entry that changes only the state or exposure of the user server of the same name. */
  readonly override?: boolean;
}

export interface MmrMcpTool {
  /** The name without the `mcp__<server>__` prefix. */
  readonly name: string;
  readonly description: string;
}

export interface MmrMcpServer {
  readonly name: string;
  readonly enabled: boolean;
  readonly exposure: string;
  readonly source?: MmrMcpSource;
  readonly tools: readonly MmrMcpTool[];
}

export interface MmrMcpInfo {
  /** Configured servers in the order Pi reads them, then groups of tools whose server is not configured. */
  readonly servers: readonly MmrMcpServer[];
  /** Files that could not be read or are not an `mcpServers` object. */
  readonly errors: readonly { readonly path: string; readonly message: string }[];
  /** Pi's `/mcp` is registered, so MCP support is on. */
  readonly manageable: boolean;
}

export interface MmrMcpInputs {
  /** The user file first, then the project file (only when the project is trusted). */
  readonly files: readonly MmrMcpConfigFile[];
  readonly registered: readonly MmrMcpRegisteredServer[];
  readonly tools: readonly MmrMcpToolInfo[];
  readonly manageable: boolean;
}

/** A name as Pi writes it in tool names: anything but letters, digits and `_` becomes `_`. */
export function normalizeMmrMcpName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

function exposureOf(config: Record<string, unknown>): string {
  const exposure = typeof config.exposure === "string" ? config.exposure : DEFAULT_EXPOSURE;
  return EXPOSURE_ALIASES[exposure] ?? exposure;
}

const definesServer = (config: Record<string, unknown>) => config.command !== undefined || config.url !== undefined || config.type !== undefined;

interface Entry {
  readonly name: string;
  readonly config: Record<string, unknown>;
  readonly source: MmrMcpSource;
}

/**
 * Merge the `mcp.json` files the way Pi does: a project entry replaces the
 * user entry of the same name, and one without `command`, `url` or `type`
 * changes only its `enabled`, `exposure` and `toolExposure`. Entries that are
 * not objects are left out, as Pi skips them.
 */
function readFiles(files: readonly MmrMcpConfigFile[], errors: { path: string; message: string }[]): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  for (const file of files) {
    if (file.error !== undefined) {
      errors.push({ path: file.path, message: "could not be read" });
      continue;
    }
    if (file.text === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.text);
    } catch {
      errors.push({ path: file.path, message: "is not valid JSON" });
      continue;
    }
    if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
      errors.push({ path: file.path, message: "has no mcpServers object" });
      continue;
    }
    for (const [name, config] of Object.entries(parsed.mcpServers ?? {})) {
      if (!isRecord(config)) continue;
      const base = entries.get(name);
      if (file.scope === "project" && !definesServer(config)) {
        if (base && Object.keys(config).every((key) => OVERRIDE_KEYS.has(key))) {
          entries.set(name, { name, config: { ...base.config, ...config }, source: { kind: "project", path: file.path, override: true } });
        }
        continue;
      }
      entries.set(name, { name, config, source: { kind: file.scope, path: file.path } });
    }
  }
  return entries;
}

/** The server a tool belongs to, by its namespace or its name, and the tool's own name. */
function matchTool(tool: MmrMcpToolInfo, byNamespace: ReadonlyMap<string, string>): { server: string; name: string } | undefined {
  const namespace = tool.namespace?.name;
  const stripped = (prefix: string) => (tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name);
  if (namespace?.startsWith(TOOL_PREFIX)) {
    return { server: byNamespace.get(namespace) ?? namespace.slice(TOOL_PREFIX.length), name: stripped(`${namespace}${NAMESPACE_SEPARATOR}`) };
  }
  if (!tool.name.startsWith(TOOL_PREFIX)) return undefined;
  // Server names may hold `__` themselves: the longest configured one that fits wins.
  let best: string | undefined;
  for (const candidate of byNamespace.keys()) {
    if (tool.name.startsWith(`${candidate}${NAMESPACE_SEPARATOR}`) && candidate.length > (best?.length ?? 0)) best = candidate;
  }
  if (best) return { server: byNamespace.get(best) as string, name: stripped(`${best}${NAMESPACE_SEPARATOR}`) };
  const rest = tool.name.slice(TOOL_PREFIX.length);
  const split = rest.indexOf(NAMESPACE_SEPARATOR);
  return split > 0 ? { server: rest.slice(0, split), name: rest.slice(split + NAMESPACE_SEPARATOR.length) } : undefined;
}

const firstLine = (text: string | undefined) => (text ?? "").trim().split("\n")[0].trim();

/**
 * The servers and their tools. Configured servers come from the files, then
 * from the extensions' registrations; a file entry wins over a registration
 * whose name differs only in `-` and `_`. Tools named `mcp__<server>__<tool>`
 * (or in the namespace `mcp__<server>`) go to the server whose name, written
 * the way Pi writes tool names, matches.
 */
export function buildMmrMcpInfo(inputs: MmrMcpInputs): MmrMcpInfo {
  const errors: { path: string; message: string }[] = [];
  const entries = [...readFiles(inputs.files, errors).values()];
  const taken = new Set(entries.map((entry) => normalizeMmrMcpName(entry.name)));
  for (const server of inputs.registered) {
    const key = normalizeMmrMcpName(server.name);
    if (taken.has(key) || !isRecord(server.config)) continue;
    taken.add(key);
    entries.push({ name: server.name, config: server.config, source: { kind: "extension", path: server.extensionPath } });
  }

  const byNamespace = new Map(entries.map((entry) => [`${TOOL_PREFIX}${normalizeMmrMcpName(entry.name)}`, entry.name]));
  const tools = new Map<string, MmrMcpTool[]>();
  for (const tool of inputs.tools) {
    const match = matchTool(tool, byNamespace);
    if (!match) continue;
    const list = tools.get(match.server) ?? [];
    list.push({ name: match.name, description: firstLine(tool.description) });
    tools.set(match.server, list);
  }

  const servers: MmrMcpServer[] = entries.map((entry) => ({
    name: entry.name,
    enabled: entry.config.enabled !== false,
    exposure: exposureOf(entry.config),
    source: entry.source,
    tools: tools.get(entry.name) ?? [],
  }));
  // Tools whose server no file or extension names, such as one another MCP extension connects.
  for (const [name, list] of tools) {
    if (!entries.some((entry) => entry.name === name)) servers.push({ name, enabled: true, exposure: DEFAULT_EXPOSURE, tools: list });
  }
  return { servers, errors, manageable: inputs.manageable };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function stateOf(server: MmrMcpServer, theme: MmrFrameTheme): string {
  if (!server.enabled) return theme.fg("dim", "disabled");
  return server.tools.length > 0 ? theme.fg("success", "connected") : theme.fg("warning", "not connected");
}

function sourceLabel(source: MmrMcpSource, cwd: string, home: string): string {
  if (source.kind !== "project") return tildeMmrPath(source.path, home);
  const path = relative(cwd, source.path) || source.path;
  return source.override ? `${path} override` : path;
}

/** Pad styled text with spaces to `width` columns. */
const pad = (text: string, width: number) => `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;

/**
 * The Servers tab for an inner width: one row per server (the name bold, its
 * state, its tool count, its exposure and, dim, where it is defined), dim
 * rows for files that could not be used, then a note on /mcp.
 */
export function renderMmrMcpServerLines(info: MmrMcpInfo, width: number, theme: MmrFrameTheme, cwd: string, home = homedir()): string[] {
  const configured = info.servers.filter((server) => server.source);
  const lines: string[] = [];
  if (configured.length > 0) {
    const nameWidth = Math.min(NAME_COLUMN_MAX, Math.max(...configured.map((server) => visibleWidth(server.name))));
    const states = configured.map((server) => stateOf(server, theme));
    const stateWidth = Math.max(...states.map(visibleWidth));
    const counts = configured.map((server) => plural(server.tools.length, "tool", "tools"));
    const countWidth = Math.max(...counts.map(visibleWidth));
    const exposureWidth = Math.max(...configured.map((server) => visibleWidth(server.exposure)));
    const gap = " ".repeat(COLUMN_GAP);
    for (const [index, server] of configured.entries()) {
      const name = pad(theme.bold(truncateToWidth(server.name, nameWidth, "…")), nameWidth);
      const source = server.source ? theme.fg("dim", sourceLabel(server.source, cwd, home)) : "";
      const row = [name, pad(states[index], stateWidth), pad(counts[index], countWidth), pad(server.exposure, exposureWidth), source].join(gap);
      lines.push(truncateToWidth(row.trimEnd(), width, "…"));
    }
  }
  for (const error of info.errors) lines.push(truncateToWidth(theme.fg("dim", `${tildeMmrPath(error.path, home)} ${error.message}`), width, "…"));
  if (configured.length === 0) lines.push(...(lines.length > 0 ? [""] : []), ...wrapTextWithAnsi(MMR_MCP_NO_SERVERS, width));
  const note = info.manageable ? MMR_MCP_MANAGE_NOTE : MMR_MCP_OFF_NOTE;
  return [...lines, "", ...wrapTextWithAnsi(note, width).map((line) => theme.fg("dim", line))];
}

/**
 * The Tools tab for an inner width: the tools under each server's name in
 * bold, each its own name in the accent color and the first line of its
 * description dim, cut to the line.
 */
export function renderMmrMcpToolLines(info: MmrMcpInfo, width: number, theme: MmrFrameTheme): string[] {
  const servers = info.servers.filter((server) => server.tools.length > 0);
  if (servers.length === 0) return wrapTextWithAnsi(MMR_MCP_NO_TOOLS, width);
  const names = servers.flatMap((server) => server.tools.map((tool) => visibleWidth(tool.name)));
  const nameWidth = Math.min(NAME_COLUMN_MAX, Math.max(1, width - ROW_INDENT - COLUMN_GAP - 1), Math.max(...names));
  const lines: string[] = [];
  for (const [index, server] of servers.entries()) {
    if (index > 0) lines.push("");
    lines.push(truncateToWidth(theme.bold(server.name), width, "…"));
    for (const tool of server.tools) {
      const name = truncateToWidth(theme.fg("accent", tool.name), nameWidth, "…", true);
      const room = width - ROW_INDENT - nameWidth - COLUMN_GAP;
      const description = tool.description && room > 0 ? theme.fg("dim", truncateToWidth(tool.description, room, "…")) : "";
      lines.push(`${" ".repeat(ROW_INDENT)}${name}${description ? `${" ".repeat(COLUMN_GAP)}${description}` : ""}`.trimEnd());
    }
  }
  return lines;
}

function readConfigFile(path: string, scope: MmrMcpConfigFile["scope"]): MmrMcpConfigFile {
  try {
    return { path, scope, text: readFileSync(path, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, scope };
    return { path, scope, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Gather the dialog's data when it opens: the `mcp.json` files, the registered servers and the tools. */
export function readMmrMcpInfo(
  pi: Pick<ExtensionAPI, "getMcpServers" | "getAllTools" | "getCommands">,
  ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
  agentDir = getAgentDir(),
): MmrMcpInfo {
  const files = [readConfigFile(join(agentDir, MCP_FILE), "user")];
  if (ctx.isProjectTrusted()) files.push(readConfigFile(join(ctx.cwd, CONFIG_DIR_NAME, MCP_FILE), "project"));
  return buildMmrMcpInfo({
    files,
    registered: pi.getMcpServers(),
    tools: pi.getAllTools(),
    manageable: pi.getCommands().some((command) => command.name === MMR_MCP_SLASH_COMMAND),
  });
}

/** Open the MCP Servers dialog; resolves when it closes. */
export function openMmrMcpInfo(ctx: ExtensionContext, info: MmrMcpInfo): Promise<void> {
  return openMmrScrollOverlay(
    ctx,
    MMR_MCP_TITLE,
    (width, theme, tab) => (tab === 0 ? renderMmrMcpServerLines(info, width, theme, ctx.cwd) : renderMmrMcpToolLines(info, width, theme)),
    { fit: true, width: MMR_MCP_WIDTH, tabs: MMR_MCP_TABS },
  );
}
