// Locating installed packages and deciding whether the bin loads ampi itself.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const AMPI_PACKAGE_NAME = "@skippermissions/ampi";

/** `npm:@skippermissions/ampi` with or without a version, as Pi settings and `-e` write it. */
const AMPI_NPM_SOURCE = /^npm:@skippermissions\/ampi(?:@.*)?$/;
/** ampi's GitHub repository in any form Pi accepts (`git:`, `https:`, `ssh:`, `git@`), with or without a ref. */
const AMPI_GIT_SOURCE = /github\.com[/:]5omeOtherGuy\/ampi(?:\.git)?(?:@[^/]*)?\/?$/i;
/**
 * Whether a package source names ampi on npm or GitHub, with or without a
 * version or ref; a local path is ampi only if its package is.
 *
 * @param {string} source
 * @returns {boolean}
 */
export function isAmpiPackageSource(source) {
  return AMPI_NPM_SOURCE.test(source) || AMPI_GIT_SOURCE.test(source);
}

/** Sources Pi resolves itself instead of reading a local path. */
const REMOTE_SOURCE = /^(?:npm:|git:|git@|https?:|ssh:)/;

/**
 * Directory of the nearest `package.json` at or above `start`.
 *
 * @param {string} start A file or directory path.
 * @returns {string | undefined}
 */
export function findPackageRoot(start) {
  let dir = path.resolve(start);
  if (existsSync(dir) && !statSync(dir).isDirectory()) dir = path.dirname(dir);
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * `name` and `version` of the package that contains `start`.
 *
 * @param {string} start
 * @returns {{ name?: string, version?: string, root: string } | undefined}
 */
export function readPackageAt(start) {
  const root = findPackageRoot(start);
  if (root === undefined) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    return { name: manifest.name, version: manifest.version, root };
  } catch {
    return undefined;
  }
}

/**
 * The installed package that a bare specifier resolves to from this module,
 * without loading it.
 *
 * @param {string} specifier For example `@skippermissions/ampi`.
 * @returns {{ name?: string, version?: string, root: string } | undefined}
 */
export function resolveInstalledPackage(specifier) {
  try {
    return readPackageAt(fileURLToPath(import.meta.resolve(specifier)));
  } catch {
    return undefined;
  }
}

/**
 * The ampi package the command loads: in a source checkout (`packages/ampi-cli`
 * inside the ampi repository) the checkout itself, so a worktree runs its own
 * code whatever `node_modules` points at; otherwise the installed dependency.
 *
 * @param {string} cliRoot Directory of the ampi-cli package.
 * @returns {{ name?: string, version?: string, root: string } | undefined}
 */
export function locateAmpiPackage(cliRoot) {
  const checkout = readPackageAt(path.resolve(cliRoot, "..", ".."));
  if (checkout?.name === AMPI_PACKAGE_NAME) return checkout;
  const installed = resolveInstalledPackage(AMPI_PACKAGE_NAME);
  return installed?.name === AMPI_PACKAGE_NAME ? installed : undefined;
}

/**
 * @typedef {object} AmpiLoadInput
 * @property {readonly string[]} piArgs Arguments Pi will receive.
 * @property {import("./pi-compat.js").PiExtensionSources} pi What Pi loads from its settings and
 *   extension directories, the sources it will install first, and its cached `-e` packages.
 * @property {string} cwd Directory relative `-e` paths resolve against.
 * @property {(start: string) => string | undefined} packageNameAt Name of the package containing a path.
 *
 * @typedef {{ load: true } | { load: false, reason: "extension-flag" | "pi", source: string }} AmpiLoadDecision
 */

/**
 * Whether the bin should hand ampi to Pi itself. Pi already loads ampi when a
 * `-e` argument names it, or, unless `--no-extensions` is given, when its
 * settings or extension directories provide it; loading it a second time would
 * register every ampi tool, command and flag twice. Settings whose filter
 * leaves out some or all of ampi's parts (`ampi setup`) count too, so the
 * parts the user turned off stay off.
 *
 * @param {AmpiLoadInput} input
 * @returns {AmpiLoadDecision}
 */
export function decideAmpiLoad({ piArgs, pi, cwd, packageNameAt }) {
  const end = piArgs.indexOf("--");
  const options = end === -1 ? piArgs : piArgs.slice(0, end);
  /** @param {string} source */
  const isAmpiSource = (source) => {
    if (isAmpiPackageSource(source)) return true;
    const location = REMOTE_SOURCE.test(source) ? pi.cachedPathOf(source) : path.resolve(cwd, source);
    return location !== undefined && packageNameAt(location) === AMPI_PACKAGE_NAME;
  };

  for (let index = 0; index < options.length - 1; index++) {
    const flag = options[index];
    if ((flag === "-e" || flag === "--extension") && isAmpiSource(options[index + 1])) {
      return { load: false, reason: "extension-flag", source: options[index + 1] };
    }
  }
  if (options.includes("--no-extensions") || options.includes("-ne")) return { load: true };
  // A part the settings filter out still means Pi has ampi: the command must not bring those parts back.
  for (const entry of [...pi.enabled, ...(pi.disabled ?? [])]) {
    if (path.isAbsolute(entry.path) && packageNameAt(entry.path) === AMPI_PACKAGE_NAME) {
      return { load: false, reason: "pi", source: entry.source };
    }
  }
  const missing = pi.missing.find(isAmpiPackageSource);
  if (missing !== undefined) return { load: false, reason: "pi", source: missing };
  return { load: true };
}
