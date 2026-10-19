import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./extensions/ampi-core/internal/json.js";
import { readJsonSettingsFile, rewriteJsonSettingsFile } from "./extensions/ampi-core/internal/settings-file.js";
import { MMR_PERMISSIONS_DEFAULT_RULES } from "./extensions/ampi-core/permission-defaults.js";
import {
  findMmrPermissionRuleTextProblem,
  formatMmrPermissionRule,
  type MmrPermissionPattern,
  type MmrPermissionRule,
  mmrPermissionWordsFromArgs,
  parseMmrPermissionRules,
  parseMmrPermissionRulesText,
  parseMmrPermissionRuleWords,
  readMmrPermissionWords,
  validateMmrPermissionRule,
} from "./extensions/ampi-core/permissions.js";
import { loadMmrPermissionsSettings, loadMmrWorkspacePermissionsSettings } from "./extensions/ampi-permissions/config.js";
import { decideMmrPermissionsCall } from "./extensions/ampi-permissions/decide.js";

/**
 * Everything `ampi permissions` needs from ampi, outside a Pi session. ampi
 * ships TypeScript that only Pi's extension loader imports, so the command
 * loads this file with that loader and receives `MMR_PERMISSIONS_CLI` on Pi's
 * event bus. It is not one of the package's extensions and registers nothing.
 */

/** `ampi.permissions` as one settings file stores it. */
export type MmrPermissionsStoredSetting = { readonly present: false } | { readonly present: true; readonly value: unknown };

/**
 * Read `ampi.permissions` from one settings file. A missing file, or one
 * without an `ampi` object, has none. With `noFollow` the file is read as
 * ampi's settings writer reads it, refusing a symbolic link; otherwise as a
 * session reads it, following one. A file that is not a JSON object throws.
 */
export function readMmrPermissionsSetting(file: string, options: { readonly noFollow?: boolean } = {}): MmrPermissionsStoredSetting {
  let settings: unknown;
  if (options.noFollow === true) {
    settings = readJsonSettingsFile(file);
  } else {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { present: false };
      throw error;
    }
    try {
      settings = JSON.parse(raw.replace(/^\uFEFF/, ""));
    } catch (error) {
      throw new Error(`${file} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (!isRecord(settings)) throw new Error(`${file} does not hold a JSON object`);
  const ampi = settings.ampi;
  if (!isRecord(ampi) || !Object.hasOwn(ampi, "permissions")) return { present: false };
  return { present: true, value: ampi.permissions };
}

/**
 * Set or remove `ampi.permissions` in one settings file, keeping every other
 * key, through ampi's atomic settings writer (which refuses a symbolic link
 * and never overwrites a file that is not valid JSON). `update` receives the
 * stored value and returns the new list, or `undefined` to remove the key;
 * an `ampi` object left empty goes too.
 */
export function writeMmrPermissionsSetting(file: string, update: (current: MmrPermissionsStoredSetting) => readonly unknown[] | undefined): void {
  rewriteJsonSettingsFile(file, (existing) => {
    if (!isRecord(existing)) throw new Error("it does not hold a JSON object");
    if (existing.ampi !== undefined && !isRecord(existing.ampi)) throw new Error("its ampi value is not an object");
    const ampi = isRecord(existing.ampi) ? existing.ampi : {};
    const next = update(Object.hasOwn(ampi, "permissions") ? { present: true, value: ampi.permissions } : { present: false });
    if (next !== undefined) return { ...existing, ampi: { ...ampi, permissions: next } };
    const { permissions: _removed, ...rest } = ampi;
    if (Object.keys(rest).length > 0) return { ...existing, ampi: rest };
    const { ampi: _empty, ...others } = existing;
    return others;
  });
}

/** The words `ampi permissions add` takes after `add`, read into a rule. */
function parseRuleArgs(args: readonly string[], flags: Readonly<Record<string, string>>) {
  return parseMmrPermissionRuleWords(mmrPermissionWordsFromArgs(args), { flags });
}

/**
 * The words `ampi permissions test` takes after `test`: the tool, then its
 * input as `--<field> <value>` options (nested at dots, repeated as lists, a
 * bare `true` or `42` as that value), and `--context`.
 */
function parseCallArgs(args: readonly string[], flags: Readonly<Record<string, string>>) {
  const read = readMmrPermissionWords(mmrPermissionWordsFromArgs(args), { flags });
  const problems = [...read.problems];
  const [tool, ...extra] = read.positionals;
  if (tool === undefined) problems.push("test needs the tool's name, for example ampi permissions test bash --command 'git push'");
  for (const word of extra) problems.push(`unexpected word ${JSON.stringify(word.value)}; give the input as --<field> <value>`);
  if (read.to !== undefined) problems.push("--to is a rule's option; test runs no program");
  if (read.message !== undefined) problems.push("--message is a rule's option; test takes the call's input");
  if (read.context !== undefined && read.context !== "thread" && read.context !== "subagent") problems.push("--context takes thread or subagent");
  const input: { [field: string]: MmrPermissionPattern } = read.fields;
  return {
    ...(tool !== undefined ? { toolName: tool.value } : {}),
    input,
    ...(read.context !== undefined ? { context: read.context as "thread" | "subagent" } : {}),
    flags: read.flags,
    problems,
  };
}

/** What `MMR_PERMISSIONS_CLI_EVENT` hands `ampi permissions`. */
export const MMR_PERMISSIONS_CLI = Object.freeze({
  formatRule: formatMmrPermissionRule,
  ruleTextProblem: findMmrPermissionRuleTextProblem,
  parseRulesText: parseMmrPermissionRulesText,
  parseRuleArgs,
  parseCallArgs,
  validateRule: validateMmrPermissionRule,
  parseRules: parseMmrPermissionRules,
  defaultRules: MMR_PERMISSIONS_DEFAULT_RULES as readonly MmrPermissionRule[],
  loadSettings: loadMmrPermissionsSettings,
  loadWorkspaceSettings: loadMmrWorkspacePermissionsSettings,
  decide: decideMmrPermissionsCall,
  readSetting: readMmrPermissionsSetting,
  writeSetting: writeMmrPermissionsSetting,
});

export type MmrPermissionsCli = typeof MMR_PERMISSIONS_CLI;

/** Event channel on which this module's extension entry hands `ampi permissions` `MMR_PERMISSIONS_CLI`. */
export const MMR_PERMISSIONS_CLI_EVENT = "ampi:permissions-cli";

/** Entry for Pi's extension loader, used by `ampi permissions`; registers nothing. */
export default function ampiPermissionsCliEntry(pi: ExtensionAPI): void {
  pi.events.emit(MMR_PERMISSIONS_CLI_EVENT, MMR_PERMISSIONS_CLI);
}
