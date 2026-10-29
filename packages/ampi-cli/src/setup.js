// `ampi setup`: choose which of ampi's parts Pi loads. The choice is the
// extension filter of the ampi entry in Pi's settings (parts.js), so Pi
// itself leaves the other parts out, in sessions, in `pi` without this
// command and in subagent processes, and `pi config` shows the same choice.
// When the settings have no ampi entry yet, the command installs ampi first,
// as `pi install` does.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { AMPI_PACKAGE_NAME, isAmpiPackageSource, readPackageAt } from "./packages.js";
import { applySelection, CORE_PART, completeSelection, listAmpiParts, parsePartNames } from "./parts.js";

/**
 * @typedef {import("./parts.js").AmpiPart} AmpiPart
 * @typedef {import("./parts.js").PiPackageEntry} PiPackageEntry
 *
 * @typedef {object} SetupHost
 * @property {string} cwd
 * @property {(scope: "user" | "project") => import("./pi-compat.js").PiPackageSettings} openSettings Throws
 *   when the settings file cannot be used.
 * @property {() => Promise<{ enabled: { path: string }[], disabled: { path: string }[] }>} extensionSources
 *   What Pi loads in `cwd` now, from every settings file.
 * @property {() => boolean} projectTrusted Whether Pi reads the project's settings in `cwd`.
 * @property {{ root: string, version?: string } | undefined} ownAmpi The ampi that comes with ampi-cli: its
 *   parts are offered while the settings have no ampi installed.
 * @property {boolean} isTTY Whether stdin and stdout are a terminal, so the command may ask.
 * @property {(question: string) => Promise<string | undefined>} ask One line from the user; undefined at the
 *   end of input.
 * @property {(text: string) => void} out Writes to stdout.
 * @property {import("./log.js").Logger} log
 */

const USAGE_HINT = "Run ampi setup --help for the options.";
const DEFAULT_SOURCE = "npm:@skippermissions/ampi";

export const OPTIONS = /** @type {const} */ ({
  parts: { type: "string", multiple: true },
  add: { type: "string", multiple: true },
  remove: { type: "string", multiple: true },
  all: { type: "boolean" },
  list: { type: "boolean" },
  local: { type: "boolean", short: "l" },
  source: { type: "string" },
  help: { type: "boolean", short: "h" },
});

/**
 * The text `ampi setup --help` prints.
 *
 * @returns {string}
 */
export function formatSetupHelp() {
  return `ampi setup: choose which parts of ampi Pi loads

Usage: ampi setup [--local] [--source <source>]
       ampi setup --parts <parts> | --add <parts> | --remove <parts> | --all [--local] [--source <source>]
       ampi setup --list [--local]

Without options, in a terminal, the command lists ampi's parts and asks which to switch on or off.
The choice is saved as the extension filter of the ampi entry in Pi's settings, the same entries
pi config edits, so Pi loads only the chosen parts, with or without the ampi command. core is
always on: every other part needs it. A part another one needs is switched on with it
(custom-subagents needs workers). When Pi's settings have no ampi entry yet, ampi is installed
first, as pi install does.

Options:

  --parts <parts>               Load exactly these parts (and core), comma separated, such as
                                --parts workers,web,tui
  --add <parts>                 Switch these parts on, keeping the others as they are
  --remove <parts>              Switch these parts off, keeping the others as they are
  --all                         Load every part, as a plain install does
  --list                        Print the parts and which are on, and change nothing
  -l, --local                   This project's .pi/settings.json instead of Pi's user settings;
                                a project entry replaces the user one in this project
  --source <source>             What to install when the settings have no ampi entry, in any
                                form pi install takes (default: with --local the ampi of the
                                user settings, else ${DEFAULT_SOURCE})

Parts can be named with or without the ampi- prefix. Pi applies the choice when it starts; in a
running session, /reload applies it. ampi doctor shows the parts that load.

Exit status: 0 on success, 1 when the settings cannot be read or written, ampi cannot be installed
or the choice was cancelled, 2 on a usage error.

Examples:

  $ ampi setup
  $ ampi setup --parts workers,web,tui,threads
  $ ampi setup --remove gui,painter
  $ npx @skippermissions/ampi-cli setup --parts workers,tui
`;
}

/**
 * Run `ampi setup`.
 *
 * @param {readonly string[]} argv The command line after `setup`.
 * @param {SetupHost} host
 * @returns {Promise<number>} The exit code.
 */
export async function runSetupCommand(argv, host) {
  /** @type {{ parts?: string[], add?: string[], remove?: string[], all?: boolean, list?: boolean, local?: boolean, source?: string, help?: boolean }} */
  let values;
  try {
    ({ values } = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: false, strict: true }));
  } catch (error) {
    return usage(host, error instanceof Error ? error.message : String(error));
  }
  if (values.help) {
    host.out(formatSetupHelp());
    return 0;
  }
  const replaces = [values.parts !== undefined, values.all === true].filter(Boolean).length;
  const changes = values.add !== undefined || values.remove !== undefined;
  if (replaces > 1) return usage(host, "--parts and --all cannot be combined.");
  if (replaces > 0 && changes) return usage(host, "--add and --remove change the current choice; leave them out with --parts or --all.");
  if (values.list && (replaces > 0 || changes)) return usage(host, "--list changes nothing; leave out --parts, --add, --remove and --all.");
  const flagged = replaces > 0 || changes;
  if (!values.list && !flagged && !host.isTTY) {
    return usage(host, "ampi setup asks which parts to load only in a terminal; pass --parts, --add, --remove or --all.");
  }

  const scope = values.local ? "project" : "user";
  /** @type {import("./pi-compat.js").PiPackageSettings} */
  let settings;
  try {
    settings = host.openSettings(scope);
  } catch (error) {
    host.log.error(`setup: cannot read Pi's settings: ${messageOf(error)}`);
    return 1;
  }
  let found = findAmpiEntry(settings);
  const installed = found?.root === undefined ? undefined : readPackageAt(found.root);
  const offered = installed?.name === AMPI_PACKAGE_NAME ? installed : host.ownAmpi;
  if (offered === undefined) {
    host.log.error(`setup: cannot find ${AMPI_PACKAGE_NAME} to read its parts; reinstall @skippermissions/ampi-cli.`);
    return 1;
  }
  let parts = listAmpiParts(readManifestAt(offered.root));
  if (parts.length === 0) {
    host.log.error(`setup: ${offered.root} lists no extensions in its package.json.`);
    return 1;
  }
  const current = found === undefined ? new Set(parts.map((part) => part.name)) : selectionOfEntry(found.entry, parts);

  if (values.list) {
    const where = found === undefined ? `${settings.file} has no ampi entry yet; every part loads once ampi is installed` : `from ${settings.file}`;
    host.out(`ampi ${offered.version ?? ""} parts, ${where}:\n\n${formatPartTable(parts, current)}`);
    return 0;
  }

  /** @type {Set<string>} */
  let chosen;
  if (values.all) chosen = new Set(parts.map((part) => part.name));
  else if (values.parts !== undefined) {
    const parsed = parsePartNames(values.parts, parts);
    if ("error" in parsed) return usage(host, parsed.error);
    chosen = new Set(parsed.names);
  } else if (changes) {
    const add = parsePartNames(values.add ?? [], parts);
    if ("error" in add) return usage(host, add.error);
    const remove = parsePartNames(values.remove ?? [], parts);
    if ("error" in remove) return usage(host, remove.error);
    const both = add.names.find((name) => remove.names.includes(name));
    if (both !== undefined) return usage(host, `${both} cannot be added and removed at once.`);
    chosen = new Set([...current, ...add.names].filter((name) => !remove.names.includes(name)));
    if (remove.names.includes(CORE_PART)) host.log.warn("core is required and stays on.");
    else if (!current.has(CORE_PART)) host.log.warn("core is required, so it is on again.");
  } else {
    const answer = await askForParts(host, parts, current, settings.file);
    if (answer === undefined) {
      host.log.error("setup cancelled; nothing was saved.");
      return 1;
    }
    chosen = answer;
  }

  const { selected, added } = completeSelection(chosen, parts);
  for (const { name, by } of added) host.log.warn(`${by} needs ${name}, so ${name} is on too.`);

  if (found === undefined) {
    const source = values.source ?? (scope === "project" ? userAmpiSource(host) : undefined) ?? DEFAULT_SOURCE;
    host.out(`Installing ${source} into Pi's ${scope === "project" ? "project" : "user"} settings...\n`);
    try {
      await settings.install(source);
    } catch (error) {
      host.log.error(`setup: could not install ${source}: ${messageOf(error)}`);
      return 1;
    }
    found = findAmpiEntry(settings);
    const root = found?.root === undefined ? undefined : readPackageAt(found.root);
    if (found === undefined || root?.name !== AMPI_PACKAGE_NAME) {
      host.log.error(`setup: ${source} is not ${AMPI_PACKAGE_NAME}; nothing else was changed.`);
      return 1;
    }
    // The installed package decides the entry paths; the choice carries over by name.
    parts = listAmpiParts(readManifestAt(root.root));
  }

  const packages = settings.packages();
  packages[found.index] = applySelection(found.entry, parts, selected);
  try {
    await settings.save(packages);
  } catch (error) {
    host.log.error(`setup: could not save the choice: ${messageOf(error)}`);
    return 1;
  }
  const on = parts.filter((part) => selected.has(part.name)).map((part) => part.name);
  const off = parts.filter((part) => !selected.has(part.name)).map((part) => part.name);
  host.out(
    `Saved to ${settings.file}: ${on.length} of ${parts.length} parts on (${on.join(", ")})${off.length > 0 ? `; off: ${off.join(", ")}` : ""}.\nPi loads them from its next start; in a running session, /reload applies them.\n`,
  );
  if (scope === "project" && !host.projectTrusted()) {
    host.out("Pi reads this project's settings once you trust the project; it asks when it starts here.\n");
  } else await warnWhenOverridden(host, found.root, parts, selected);
  return 0;
}

/**
 * The ampi the user settings install, as a source for this project's: the same
 * npm or git source, or the same directory, so the project entry replaces the
 * user one instead of adding a second ampi.
 *
 * @param {SetupHost} host
 * @returns {string | undefined}
 */
function userAmpiSource(host) {
  try {
    const found = findAmpiEntry(host.openSettings("user"));
    if (found === undefined) return undefined;
    const source = typeof found.entry === "string" ? found.entry : found.entry.source;
    return isAmpiPackageSource(source) ? source : found.root;
  } catch {
    return undefined;
  }
}

/**
 * @param {SetupHost} host
 * @param {string} message
 */
function usage(host, message) {
  host.log.error(`setup: ${message}\n${USAGE_HINT}`);
  return 2;
}

/** @param {unknown} error */
const messageOf = (error) => (error instanceof Error ? error.message : String(error));

/** @param {string} root @returns {unknown} */
function readManifestAt(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * The ampi entry of a settings file's package list: a source that names ampi,
 * or one whose installed package is ampi.
 *
 * @param {import("./pi-compat.js").PiPackageSettings} settings
 * @returns {{ index: number, entry: PiPackageEntry, root: string | undefined } | undefined}
 */
function findAmpiEntry(settings) {
  const packages = settings.packages();
  for (let index = 0; index < packages.length; index++) {
    const entry = packages[index];
    const source = typeof entry === "string" ? entry : entry?.source;
    if (typeof source !== "string") continue;
    const root = settings.installedPathOf(source);
    if (isAmpiPackageSource(source) || (root !== undefined && readPackageAt(root)?.name === AMPI_PACKAGE_NAME)) return { index, entry, root };
  }
  return undefined;
}

/**
 * The parts an ampi entry loads, by Pi's filter rules for exact paths
 * (docs/packages.md): no filter loads every part, `[]` none; otherwise plain
 * entries pick parts, `!` and `-` drop them and `+` brings them back, `-`
 * winning. A glob pattern counts as naming no part.
 *
 * @param {PiPackageEntry} entry
 * @param {readonly AmpiPart[]} parts
 * @returns {Set<string>}
 */
export function selectionOfEntry(entry, parts) {
  const patterns = typeof entry === "string" ? undefined : entry.extensions;
  if (patterns === undefined) return new Set(parts.map((part) => part.name));
  /** @param {string} prefix */
  const named = (prefix) => new Set(patterns.filter((pattern) => (prefix === "" ? !/^[!+-]/.test(pattern) : pattern.startsWith(prefix))).map((pattern) => pattern.replace(/^[!+-]/, "").replace(/^\.\//, "")));
  const [plain, excluded, forced, dropped] = ["", "!", "+", "-"].map(named);
  return new Set(
    parts
      .filter((part) => {
        let on = patterns.length > 0 && (plain.size === 0 || plain.has(part.entry)) && !excluded.has(part.entry);
        if (forced.has(part.entry)) on = true;
        if (dropped.has(part.entry)) on = false;
        return on;
      })
      .map((part) => part.name),
  );
}

/**
 * The numbered list of parts with a box that is checked for the parts in
 * `selected`.
 *
 * @param {readonly AmpiPart[]} parts
 * @param {ReadonlySet<string>} selected
 * @returns {string}
 */
export function formatPartTable(parts, selected) {
  const width = Math.max(...parts.map((part) => part.name.length));
  return `${parts
    .map((part, index) => `${String(index + 1).padStart(3)}  [${selected.has(part.name) ? "x" : " "}] ${part.name.padEnd(width)}  ${part.summary}`)
    .join("\n")}\n`;
}

/**
 * Ask until the user saves (an empty line) or cancels (`q` or the end of
 * input, which return undefined).
 *
 * @param {SetupHost} host
 * @param {readonly AmpiPart[]} parts
 * @param {ReadonlySet<string>} current
 * @param {string} file
 * @returns {Promise<Set<string> | undefined>}
 */
async function askForParts(host, parts, current, file) {
  const selected = new Set(current);
  selected.add(CORE_PART);
  host.out(`Choose the parts of ampi that Pi loads (saved to ${file}).\n\n`);
  for (;;) {
    host.out(formatPartTable(parts, selected));
    const answer = await host.ask("\nSwitch parts on or off by number or name (all; none for core only), Enter to save, q to cancel: ");
    if (answer === undefined) return undefined;
    const words = answer.trim().toLowerCase().split(/[\s,]+/).filter((word) => word !== "");
    if (words.length === 0) return selected;
    if (words.length === 1 && (words[0] === "q" || words[0] === "quit")) return undefined;
    if (words.length === 1 && words[0] === "all") for (const part of parts) selected.add(part.name);
    else if (words.length === 1 && words[0] === "none") {
      selected.clear();
      selected.add(CORE_PART);
    } else {
      /** @type {string[]} */
      const names = [];
      const unknown = words.filter((word) => {
        const index = /^\d+$/.test(word) ? Number(word) - 1 : -1;
        const part = parts[index] ?? parts.find((candidate) => candidate.name === word || candidate.extension === word);
        if (part !== undefined) names.push(part.name);
        return part === undefined;
      });
      if (unknown.length > 0) {
        host.out(`\nNo part ${unknown.join(", ")}: use a number from 1 to ${parts.length} or a name.\n\n`);
        continue;
      }
      for (const name of names) {
        if (name === CORE_PART) host.out("\ncore is required and stays on.\n");
        else if (selected.has(name)) selected.delete(name);
        else selected.add(name);
      }
      // A part stays on while one that needs it is on.
      for (const { name, by } of completeSelection(selected, parts).added) {
        selected.add(name);
        host.out(`\n${by} needs ${name}, so ${name} is on.\n`);
      }
    }
    host.out("\n");
  }
}

/**
 * Say so when Pi, reading every settings file in this directory, still loads
 * other parts of the package than the ones just saved: another ampi entry,
 * such as a project's, replaces this one here.
 *
 * @param {SetupHost} host
 * @param {string | undefined} root
 * @param {readonly AmpiPart[]} parts
 * @param {ReadonlySet<string>} selected
 */
async function warnWhenOverridden(host, root, parts, selected) {
  if (root === undefined) return;
  /** @type {Awaited<ReturnType<SetupHost["extensionSources"]>>} */
  let sources;
  try {
    sources = await host.extensionSources();
  } catch {
    return;
  }
  const enabled = new Set(sources.enabled.map((entry) => entry.path));
  const loads = new Set(parts.filter((part) => enabled.has(path.join(root, part.entry))).map((part) => part.name));
  if (loads.size === selected.size && [...selected].every((name) => loads.has(name))) return;
  host.log.warn(
    `in ${host.cwd} Pi loads other parts (${[...loads].join(", ") || "none"}): another ampi entry, such as one in this project's .pi/settings.json, takes precedence here. ampi doctor shows what loads.`,
  );
}
