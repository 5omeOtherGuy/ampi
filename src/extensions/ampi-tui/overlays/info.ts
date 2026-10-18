import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type ExtensionContext, VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { findMmrChangelogReleaseDate, resolveMmrPackageRoot } from "../../ampi-core/changelog.js";
import {
  classifyMmrSkillSource,
  MMR_SKILL_GROUPS,
  type MmrSkillGroup,
  type MmrSkillSource,
  type MmrSkillSourceInfo,
} from "../../ampi-core/skill-sources.js";
import { MMR_EXTENSION_MANIFEST } from "../../manifest.js";
import type { MmrFrameTheme } from "../ui/frame.js";
import { openMmrScrollOverlay } from "./help-keymap.js";

/**
 * The Skills, Extensions and Version dialogs: read-only boxes in the shared
 * frame, centred and as tall as their content (scrolling when the screen is
 * shorter). Esc closes them.
 *
 * ```
 * ╭─ Skills (3) ─────────────────────────────────────────────────────────╮
 * │                                                                      │
 * │ User                                                                 │
 * │   pdf-tools         Extract text and tables from PDF files. Use wh… │
 * │   review agents     Review a diff for correctness and regressions    │
 * │                                                                      │
 * │ Project                                                              │
 * │   release-notes     Draft release notes from the merged pull reques… │
 * │                                                                      │
 * │ Pi looks for skills in …                                             │
 * ╰──────────────────────────────────────────────────────────── Esc close ─╯
 * ```
 *
 * ```
 * ╭─ Extensions ─────────────────────────────────────────────────────────╮
 * │                                                                      │
 * │ 2 extensions (3 commands, 1 tool)                                    │
 * │                                                                      │
 * │ ampi-core  ~/ampi/src/extensions/ampi-core/index.ts                  │
 * │   Commands: /ampi-status, /ampi-changelog, /mode                     │
 * │                                                                      │
 * │ Pi built-in                                                          │
 * │   Tools: read                                                        │
 * ╰──────────────────────────────────────────────────────────── Esc close ─╯
 * ```
 */

export const MMR_EXTENSIONS_TITLE = "Extensions";
export const MMR_VERSION_TITLE = "Version";
/** Box widths before Pi narrows them to the terminal width less four. */
export const MMR_SKILLS_WIDTH = 120;
export const MMR_EXTENSIONS_WIDTH = 100;
export const MMR_VERSION_WIDTH = 80;

export function mmrSkillsTitle(count: number): string {
  return `Skills (${count})`;
}

const ROW_INDENT = 2;
const COLUMN_GAP = 2;
/** Widest the skill name column gets. */
const NAME_COLUMN_MAX = 32;
const SKILL_COMMAND_PREFIX = "skill:";
const BUILTIN_PATH_PREFIX = "builtin:";
const PI_BUILTIN_LABEL = "Pi built-in";
const LEGACY_COMMAND_PREFIX = "mmr-";

const GROUP_TITLES: Record<MmrSkillGroup, string> = {
  user: "User",
  project: "Project",
  package: "Packages",
  settings: "Settings",
  temporary: "Temporary",
};

/** A slash command as Pi's `getCommands()` lists it. */
export interface MmrInfoCommand {
  readonly name: string;
  readonly description?: string;
  readonly source: string;
  readonly sourceInfo?: MmrSkillSourceInfo;
}

/** A tool as Pi's `getAllTools()` lists it. */
export interface MmrInfoTool {
  readonly name: string;
  readonly sourceInfo?: MmrSkillSourceInfo;
}

/** A skill as the `before_agent_start` event's `systemPromptOptions.skills` carries it. */
export interface MmrInfoSkill {
  readonly name: string;
  readonly description: string;
  readonly filePath?: string;
  readonly sourceInfo: MmrSkillSourceInfo;
  readonly disableModelInvocation?: boolean;
}

export interface MmrSkillRow extends MmrSkillSource {
  readonly name: string;
  readonly description: string;
  /** The model never sees it; only `/skill:<name>` runs it. */
  readonly commandOnly: boolean;
}

export interface MmrSkillSection {
  readonly group: MmrSkillGroup;
  readonly title: string;
  readonly rows: readonly MmrSkillRow[];
}

/**
 * The skills Pi loaded, grouped by where it found them: the union, by name,
 * of Pi's `skill:` commands and the skill list of the last
 * `before_agent_start` event (which also covers skills while
 * `enableSkillCommands` is off). For a skill in both, the command's
 * description and source win, since Pi lists commands from its current
 * resources; only the event's list says whether a skill is hidden from the
 * model. Groups come in {@link MMR_SKILL_GROUPS} order, rows by name.
 */
export function buildMmrSkillSections(commands: readonly MmrInfoCommand[], skills: readonly MmrInfoSkill[] = []): MmrSkillSection[] {
  const rows = new Map<string, MmrSkillRow>();
  for (const skill of skills) {
    rows.set(skill.name, {
      name: skill.name,
      description: skill.description,
      commandOnly: skill.disableModelInvocation === true,
      ...classifyMmrSkillSource(skill.sourceInfo, skill.filePath),
    });
  }
  for (const command of commands) {
    if (command.source !== "skill" || !command.sourceInfo) continue;
    const name = command.name.startsWith(SKILL_COMMAND_PREFIX) ? command.name.slice(SKILL_COMMAND_PREFIX.length) : command.name;
    const known = rows.get(name);
    rows.set(name, {
      name,
      description: command.description ?? known?.description ?? "",
      commandOnly: known?.commandOnly ?? false,
      ...classifyMmrSkillSource(command.sourceInfo),
    });
  }
  const sorted = [...rows.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return MMR_SKILL_GROUPS.map((group) => ({ group, title: GROUP_TITLES[group], rows: sorted.filter((row) => row.group === group) })).filter(
    (section) => section.rows.length > 0,
  );
}

/** Says where Pi finds skills; closes the list and fills the empty one. */
export const MMR_SKILLS_NOTE =
  "Pi looks for skills (a directory with a SKILL.md) in ~/.pi/agent/skills and ~/.agents/skills, in the project's .pi/skills, in .agents/skills from the working directory up to the repository root, in the paths of the skills setting and in Pi packages. Run /reload to pick up a skill you added.";
export const MMR_SKILLS_EMPTY = "Pi has loaded no skills.";

/** The name column of one row: the name, then its tags, dim. */
function skillNameCell(row: MmrSkillRow, theme: MmrFrameTheme): string {
  const tags = [
    ...(row.commandOnly ? ["command only"] : []),
    // Where the skill sits besides Pi's own directories: `agents` or `claude`.
    ...(row.origin !== "pi" ? [row.origin] : []),
    ...(row.packageName ? [row.packageName] : []),
  ];
  return `${theme.fg("warning", row.name)}${tags.length > 0 ? ` ${theme.fg("dim", tags.join(" "))}` : ""}`;
}

/**
 * The Skills dialog's lines for an inner width: a bold title per group, then
 * one row per skill, the name in a column as wide as the longest (at most
 * 32 columns) and the description dim, cut to the line. Then the note on
 * where Pi looks.
 */
export function renderMmrSkillLines(sections: readonly MmrSkillSection[], width: number, theme: MmrFrameTheme): string[] {
  const note = wrapTextWithAnsi(MMR_SKILLS_NOTE, width).map((line) => theme.fg("dim", line));
  if (sections.length === 0) return [MMR_SKILLS_EMPTY, "", ...note];
  const cells = sections.flatMap((section) => section.rows.map((row) => skillNameCell(row, theme)));
  const nameWidth = Math.min(NAME_COLUMN_MAX, Math.max(1, width - ROW_INDENT - COLUMN_GAP - 1), Math.max(...cells.map(visibleWidth)));
  const lines: string[] = [];
  for (const section of sections) {
    lines.push(theme.bold(section.title));
    for (const row of section.rows) {
      const name = truncateToWidth(skillNameCell(row, theme), nameWidth, "…", true);
      const room = width - ROW_INDENT - nameWidth - COLUMN_GAP;
      const description = row.description && room > 0 ? theme.fg("dim", truncateToWidth(row.description.replace(/\s+/g, " "), room, "…")) : "";
      lines.push(`${" ".repeat(ROW_INDENT)}${name}${description ? `${" ".repeat(COLUMN_GAP)}${description}` : ""}`.trimEnd());
    }
    lines.push("");
  }
  return [...lines, ...note];
}

export interface MmrExtensionGroup {
  /** The ampi extension name, the package source, the file name, or "Pi built-in". */
  readonly label: string;
  /** Where Pi loaded it from; undefined for Pi's built-in group. */
  readonly path?: string;
  readonly commands: readonly string[];
  readonly tools: readonly string[];
}

export interface MmrExtensionList {
  readonly groups: readonly MmrExtensionGroup[];
  readonly commandCount: number;
  readonly toolCount: number;
}

/** Entry points of ampi's own extensions, without the leading `./`, by extension name. */
const AMPI_ENTRYPOINTS = MMR_EXTENSION_MANIFEST.map((entry) => ({
  name: entry.name,
  suffix: entry.entrypoint.replace(/^\.\//, ""),
}));

/** The ampi extension whose entry point `path` is, if any. */
function ampiExtensionName(path: string): string | undefined {
  const normalized = path.replaceAll("\\", "/");
  return AMPI_ENTRYPOINTS.find((entry) => normalized.endsWith(`/${entry.suffix}`) || normalized === entry.suffix)?.name;
}

function extensionLabel(sourceInfo: MmrSkillSourceInfo): string {
  const path = sourceInfo.path.replaceAll("\\", "/");
  const ampi = ampiExtensionName(path);
  if (ampi) return ampi;
  if (sourceInfo.origin === "package") return sourceInfo.source;
  if (path.startsWith("<")) return path;
  // An extension in a directory of its own is named after the directory.
  const file = basename(path);
  return /^index\.[cm]?[jt]s$/.test(file) ? `${basename(dirname(path))}/${file}` : file;
}

/**
 * The extensions Pi loaded, from its extension commands and its tools,
 * grouped by the file that registered them, in the order Pi lists them. Pi's
 * built-in tools and built-in extensions (`builtin:` paths) share one group,
 * listed last. An extension that registers neither commands nor tools does
 * not show: Pi lists no loaded extensions. ampi's legacy `/mmr-*` command
 * aliases are left out, as in the command palette.
 */
export function buildMmrExtensionList(commands: readonly MmrInfoCommand[], tools: readonly MmrInfoTool[]): MmrExtensionList {
  const groups = new Map<string, { label: string; path?: string; commands: string[]; tools: string[] }>();
  const builtin = { label: PI_BUILTIN_LABEL, commands: [] as string[], tools: [] as string[] };
  const groupOf = (sourceInfo: MmrSkillSourceInfo | undefined) => {
    if (!sourceInfo || sourceInfo.path.startsWith(BUILTIN_PATH_PREFIX)) return builtin;
    let group = groups.get(sourceInfo.path);
    if (!group) {
      group = { label: extensionLabel(sourceInfo), path: sourceInfo.path, commands: [], tools: [] };
      groups.set(sourceInfo.path, group);
    }
    return group;
  };
  const extensionCommands = commands.filter(
    (command) =>
      command.source === "extension" &&
      !(command.name.startsWith(LEGACY_COMMAND_PREFIX) && command.sourceInfo && ampiExtensionName(command.sourceInfo.path)),
  );
  for (const command of extensionCommands) groupOf(command.sourceInfo).commands.push(`/${command.name}`);
  for (const tool of tools) groupOf(tool.sourceInfo).tools.push(tool.name);
  const all = [...groups.values()];
  if (builtin.commands.length + builtin.tools.length > 0) all.push(builtin);
  return { groups: all, commandCount: extensionCommands.length, toolCount: tools.length };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** A path with the home directory written as `~`. */
export function tildeMmrPath(path: string, home = homedir()): string {
  if (!home) return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) || path.startsWith(`${home}\\`) ? `~${path.slice(home.length)}` : path;
}

/** `label` and a comma-separated list after it, wrapped under the list's first item. */
function listLines(label: string, items: readonly string[], width: number, paint: (text: string) => string): string[] {
  const prefix = `${" ".repeat(ROW_INDENT)}${label} `;
  const indent = visibleWidth(prefix);
  const wrapped = wrapTextWithAnsi(items.join(", "), Math.max(1, width - indent));
  return wrapped.map((line, index) => `${index === 0 ? prefix : " ".repeat(indent)}${paint(line)}`);
}

/**
 * The Extensions dialog's lines for an inner width: the counts in bold, then
 * per group its name in bold and its path dim, its commands in the accent
 * colour and its tools, each list wrapped.
 */
export function renderMmrExtensionLines(list: MmrExtensionList, width: number, theme: MmrFrameTheme, home = homedir()): string[] {
  const counts = `${plural(list.groups.length, "extension", "extensions")} (${plural(list.commandCount, "command", "commands")}, ${plural(list.toolCount, "tool", "tools")})`;
  const lines = [theme.bold(counts)];
  for (const group of list.groups) {
    lines.push("");
    const path = group.path ? `${" ".repeat(COLUMN_GAP)}${theme.fg("dim", tildeMmrPath(group.path, home))}` : "";
    lines.push(truncateToWidth(`${theme.bold(group.label)}${path}`, width, "…"));
    if (group.commands.length > 0) lines.push(...listLines("Commands:", group.commands, width, (text) => theme.fg("accent", text)));
    if (group.tools.length > 0) lines.push(...listLines("Tools:", group.tools, width, (text) => text));
  }
  return lines;
}

export interface MmrVersionInfo {
  /** ampi's version, when its package.json could be read. */
  readonly ampi?: string;
  /** The release date from ampi's changelog heading for that version. */
  readonly released?: string;
  readonly pi: string;
  readonly node: string;
  /** ampi's package root. */
  readonly root?: string;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Read ampi's version and release date from its package root, with Pi's and Node's versions. */
export function readMmrVersionInfo(root = resolveMmrPackageRoot()): MmrVersionInfo {
  let ampi: string | undefined;
  const pkg = root ? readText(join(root, "package.json")) : undefined;
  try {
    const version = pkg ? (JSON.parse(pkg) as { version?: unknown }).version : undefined;
    ampi = typeof version === "string" ? version : undefined;
  } catch {}
  const changelog = root && ampi ? readText(join(root, "CHANGELOG.md")) : undefined;
  const released = changelog && ampi ? findMmrChangelogReleaseDate(changelog, ampi) : undefined;
  return { ampi, released, pi: PI_VERSION, node: process.version, root };
}

/** The version as one notification line, for runs without the terminal UI. */
export function formatMmrVersionNotice(info: MmrVersionInfo): string {
  return `ampi ${info.ampi ?? "(unknown version)"} on Pi ${info.pi}`;
}

/** The Version dialog's lines: ampi with its release date, Pi, Node and, dim, the package root. */
export function renderMmrVersionLines(info: MmrVersionInfo, width: number, theme: MmrFrameTheme, home = homedir()): string[] {
  const ampi = `ampi ${info.ampi ?? "(unknown version)"}${info.released ? theme.fg("dim", `, released ${info.released}`) : ""}`;
  const lines = [ampi, `Pi ${info.pi}`, `Node ${info.node}`];
  if (info.root) lines.push("", theme.fg("dim", tildeMmrPath(info.root, home)));
  return lines.map((line) => truncateToWidth(line, width, "…"));
}

/** Open the Skills dialog; resolves when it closes. */
export function openMmrSkills(ctx: ExtensionContext, sections: readonly MmrSkillSection[]): Promise<void> {
  const count = sections.reduce((sum, section) => sum + section.rows.length, 0);
  return openMmrScrollOverlay(ctx, mmrSkillsTitle(count), (width, theme) => renderMmrSkillLines(sections, width, theme), {
    fit: true,
    width: MMR_SKILLS_WIDTH,
  });
}

/** Open the Extensions dialog; resolves when it closes. */
export function openMmrExtensions(ctx: ExtensionContext, list: MmrExtensionList): Promise<void> {
  return openMmrScrollOverlay(ctx, MMR_EXTENSIONS_TITLE, (width, theme) => renderMmrExtensionLines(list, width, theme), {
    fit: true,
    width: MMR_EXTENSIONS_WIDTH,
  });
}

/** Open the Version dialog; resolves when it closes. */
export function openMmrVersion(ctx: ExtensionContext, info: MmrVersionInfo): Promise<void> {
  return openMmrScrollOverlay(ctx, MMR_VERSION_TITLE, (width, theme) => renderMmrVersionLines(info, width, theme), {
    fit: true,
    width: MMR_VERSION_WIDTH,
  });
}
