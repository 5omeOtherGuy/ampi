// `ampi config keymap` and `ampi config edit`: the keymap in effect as JSONC,
// and Pi's settings file in the external editor. Every other `ampi config`
// command line is Pi's own `config` command (see argv.js).
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { openInPiEditor } from "./editor.js";
import { loadThroughPi, piSettingsPath, readPiSettings } from "./pi-compat.js";

/**
 * @typedef {object} ConfigHost
 * @property {any} pi The `@earendil-works/pi-coding-agent` module.
 * @property {string} cwd
 * @property {() => Promise<{ root: string, version?: string } | undefined>} locateAmpi The ampi package the
 *   keymap comes from: the one Pi loads from its settings, else the CLI's own.
 * @property {(text: string) => void} out Writes to stdout.
 * @property {import("./log.js").Logger} log For the command's diagnostics.
 *
 * @typedef {(settings: unknown, cwd: string) => { jsonc: string, problems: readonly string[] }} KeymapFormatter
 */

/**
 * The file in the ampi package whose extension factory hands over the keymap
 * formatter, and the event it uses (`MMR_CONFIG_KEYMAP_EVENT` there).
 */
const KEYMAP_ENTRY = path.join("src", "config-keymap.ts");
const KEYMAP_EVENT = "ampi:config-keymap";

export const OPTIONS = /** @type {const} */ ({
  keymap: {},
  edit: { global: { type: "boolean" }, workspace: { type: "boolean" } },
});

/**
 * The text `ampi config keymap --help` and `ampi config edit --help` print.
 *
 * @returns {string}
 */
export function formatConfigHelp() {
  return `ampi config: show ampi's keymap and edit Pi's settings

Usage: ampi config keymap
       ampi config edit [--global | --workspace]

Commands:

  keymap                        Print the keymap in effect as JSONC: the leader key, then every
                                command id with its key, keys or null, and what it does
  edit                          Open Pi's settings file in your editor: Pi's externalEditor
                                setting, else $VISUAL, else $EDITOR, else nano (notepad on
                                Windows)
      --global                  The user settings in Pi's configuration directory (the default)
      --workspace               This project's .pi/settings.json

Keys are changed under "ampi": { "keymap": { ... } } in either settings file, with entries in the
format ampi config keymap prints. Every other ampi config command line runs Pi's own config
command.

Exit status: 0 on success, 1 when the keymap cannot be read or the editor fails, 2 on a usage
error.

Examples:

  $ ampi config keymap
  $ ampi config keymap | grep thread.
  $ ampi config edit --workspace
`;
}

/**
 * Run `ampi config keymap` or `ampi config edit`.
 *
 * @param {readonly string[]} argv The command line after `config`.
 * @param {ConfigHost} host
 * @returns {Promise<number>} The exit code.
 */
export async function runConfigCommand(argv, host) {
  const [command, ...rest] = argv;
  if (rest.includes("--help") || rest.includes("-h")) {
    host.out(formatConfigHelp());
    return 0;
  }
  /** @type {Record<string, boolean | undefined>} */
  let values;
  try {
    const options = OPTIONS[/** @type {keyof typeof OPTIONS} */ (command)];
    ({ values } = /** @type {any} */ (parseArgs({ args: rest, options, allowPositionals: false, strict: true })));
  } catch (error) {
    host.log.error(`config ${command}: ${error instanceof Error ? error.message : String(error)}\nRun ampi config ${command} --help for the options.`);
    return 2;
  }
  if (command === "keymap") return printKeymap(host);
  if (values.global && values.workspace) {
    host.log.error("config edit takes --global or --workspace, not both.");
    return 2;
  }
  return edit(host, values.workspace ? "project" : "user");
}

/**
 * @param {ConfigHost} host
 * @returns {Promise<number>}
 */
async function printKeymap(host) {
  const ampi = await host.locateAmpi();
  const entry = ampi === undefined ? undefined : path.join(ampi.root, KEYMAP_ENTRY);
  if (entry === undefined || !existsSync(entry)) {
    const which = ampi?.version === undefined ? "the ampi package" : `ampi ${ampi.version}`;
    host.log.error(`${which} is too old for config keymap; update @skippermissions/ampi (or ampi-cli).`);
    return 1;
  }
  /** @type {KeymapFormatter | undefined} */
  let format;
  try {
    const received = /** @type {{ formatKeymapJsonc?: KeymapFormatter } | undefined} */ (await loadThroughPi(host.pi, entry, KEYMAP_EVENT));
    format = received?.formatKeymapJsonc;
  } catch (error) {
    host.log.error(`could not load ampi's keymap: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (typeof format !== "function") {
    host.log.error("could not load ampi's keymap: the ampi package did not provide it.");
    return 1;
  }
  const { jsonc, problems } = format(readPiSettings(host.pi, host.cwd), host.cwd);
  for (const problem of problems) host.log.warn(`keymap: ${problem}`);
  host.out(`${jsonc}\n`);
  return 0;
}

/**
 * Open a settings file in Pi's external editor (see editor.js).
 *
 * @param {ConfigHost} host
 * @param {"user" | "project"} scope
 * @returns {Promise<number>}
 */
async function edit(host, scope) {
  const problem = await openInPiEditor(host.pi, host.cwd, piSettingsPath(host.pi, host.cwd, scope));
  if (problem === undefined) return 0;
  host.log.error(problem);
  return 1;
}
