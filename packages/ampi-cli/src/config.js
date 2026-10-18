// `ampi config keymap` and `ampi config edit`: the keymap in effect as JSONC,
// and Pi's settings file in the external editor. Every other `ampi config`
// command line is Pi's own `config` command (see argv.js).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadThroughPi, piExternalEditorCommand, piSettingsPath, readPiSettings } from "./pi-compat.js";

/**
 * @typedef {object} ConfigHost
 * @property {any} pi The `@earendil-works/pi-coding-agent` module.
 * @property {string} cwd
 * @property {{ root: string, version?: string } | undefined} ampi The ampi package the command loads.
 * @property {(text: string) => void} out Writes to stdout.
 * @property {(text: string) => void} err Writes to stderr.
 *
 * @typedef {(settings: unknown) => { jsonc: string, problems: readonly string[] }} KeymapFormatter
 */

/**
 * The file in the ampi package whose extension factory hands over the keymap
 * formatter, and the event it uses (`MMR_CONFIG_KEYMAP_EVENT` there).
 */
const KEYMAP_ENTRY = path.join("src", "config-keymap.ts");
const KEYMAP_EVENT = "ampi:config-keymap";

const OPTIONS = /** @type {const} */ ({
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
                                setting, else $VISUAL, else $EDITOR
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
    host.err(`ampi: config ${command}: ${error instanceof Error ? error.message : String(error)}\nRun ampi config ${command} --help for the options.\n`);
    return 2;
  }
  if (command === "keymap") return printKeymap(host);
  if (values.global && values.workspace) {
    host.err("ampi: config edit takes --global or --workspace, not both.\n");
    return 2;
  }
  return edit(host, values.workspace ? "project" : "user");
}

/**
 * @param {ConfigHost} host
 * @returns {Promise<number>}
 */
async function printKeymap(host) {
  const entry = host.ampi === undefined ? undefined : path.join(host.ampi.root, KEYMAP_ENTRY);
  if (host.ampi === undefined || entry === undefined || !existsSync(entry)) {
    const which = host.ampi?.version === undefined ? "The ampi package" : `ampi ${host.ampi.version}`;
    host.err(`ampi: ${which} cannot print its keymap; update @skippermissions/ampi-cli.\n`);
    return 1;
  }
  /** @type {KeymapFormatter | undefined} */
  let format;
  try {
    const received = /** @type {{ formatKeymapJsonc?: KeymapFormatter } | undefined} */ (await loadThroughPi(host.pi, entry, KEYMAP_EVENT));
    format = received?.formatKeymapJsonc;
  } catch (error) {
    host.err(`ampi: could not load ampi's keymap: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (typeof format !== "function") {
    host.err("ampi: could not load ampi's keymap: the ampi package did not provide it.\n");
    return 1;
  }
  const { jsonc, problems } = format(readPiSettings(host.pi, host.cwd));
  for (const problem of problems) host.err(`ampi: keymap: ${problem}\n`);
  host.out(`${jsonc}\n`);
  return 0;
}

/**
 * Open a settings file in Pi's external editor, as Pi starts it for the
 * prompt: the command split at spaces, with the file as its last argument.
 * The file's directory is created when it is missing, so the editor can save.
 *
 * @param {ConfigHost} host
 * @param {"user" | "project"} scope
 * @returns {Promise<number>}
 */
async function edit(host, scope) {
  const file = piSettingsPath(host.pi, host.cwd, scope);
  const [editor, ...args] = piExternalEditorCommand(host.pi, host.cwd).split(" ");
  mkdirSync(path.dirname(file), { recursive: true });
  /** @type {number | null | Error} */
  const outcome = await new Promise((resolve) => {
    const child = spawn(editor, [...args, file], { stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", resolve);
    child.on("close", resolve);
  });
  if (outcome instanceof Error) {
    host.err(`ampi: could not start the editor ${editor}: ${outcome.message}\n`);
    return 1;
  }
  if (outcome !== 0) {
    host.err(`ampi: the editor ${editor} exited with ${outcome === null ? "a signal" : `status ${outcome}`}.\n`);
    return 1;
  }
  return 0;
}
