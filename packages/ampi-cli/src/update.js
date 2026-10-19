// `ampi update` (`ampi up`): update the ampi command itself when npm installed
// it globally (`npm install -g @skippermissions/ampi-cli`). The command runs
// npm three ways, each through the host's runNpm: `npm root -g` to find npm's
// global directory, `npm view @skippermissions/ampi-cli[@<version>] version`
// for the version to install, and `npm install -g --ignore-scripts
// @skippermissions/ampi-cli@<version>`. Pi's own update arguments never reach
// this module: argv.js hands them to Pi's `update` unchanged.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import { AMPI_PACKAGE_NAME, readPackageAt } from "./packages.js";
import { compareVersions, parseVersion } from "./versions.js";

/**
 * @typedef {object} NpmResult
 * @property {number | null} status The exit status, null when npm did not start or ended on a signal.
 * @property {string} stdout
 * @property {string} stderr
 * @property {Error} [error] Why npm could not be started.
 *
 * @typedef {object} UpdateHost
 * @property {string} cliRoot Directory of the ampi-cli package that runs.
 * @property {(args: string[]) => NpmResult} runNpm Run npm with these arguments and wait for it.
 * @property {(file: string) => string} realpath The real path of a file; throws when it does not exist.
 * @property {(text: string) => void} out Writes to stdout.
 * @property {(text: string) => void} err Writes to stderr.
 */

export const CLI_PACKAGE_NAME = "@skippermissions/ampi-cli";

const USAGE_HINT = "Run ampi update --help for the options.";

/** The last lines of npm's stderr a failed install shows. */
const STDERR_TAIL_LINES = 10;

const OPTIONS = /** @type {const} */ ({
  "target-version": { type: "string" },
  porcelain: { type: "boolean" },
  help: { type: "boolean", short: "h" },
});

/**
 * The text `ampi update --help` prints.
 *
 * @returns {string}
 */
export function formatUpdateHelp() {
  return `ampi update: update the ampi command, or hand Pi's update arguments to Pi

Usage: ampi update [--target-version <version>] [--porcelain]
       ampi update <Pi's update arguments>

Alias: ampi up

Without Pi's arguments, the command updates @skippermissions/ampi-cli itself, with the Pi and
ampi it brings, when it was installed with npm install -g. It asks npm for the latest published
version (npm view), and installs it with npm install -g --ignore-scripts. Other installations
(a source checkout, npx, pnpm, yarn or bun) are not changed; the command says how to update them.

Options:

  --target-version <version>    Install this version (a SemVer version such as 0.4.0) instead of
                                the latest; an older one too
  --porcelain                   Print exactly one line on stdout, "updated <version>" or
                                "no update needed"; npm's output and every message go to stderr

Pi's update arguments go to Pi's own update command unchanged: --extensions, --extension
<source>, --models, --all, --self, --force, a package source, self or pi. So ampi update
--extensions updates Pi's packages, and ampi update npm:<package> updates one of them.
ampi update without arguments is how the Pi that comes with ampi-cli gets updated: under a
global ampi-cli, Pi's own self-update (--self, --all, --force, self or pi) runs npm install -g
@earendil-works/pi-coding-agent, which installs a second, separate Pi.

Exit status: 0 when ampi-cli was updated or needs no update, 1 when it cannot be updated here or
npm fails, 2 on a usage error.

Examples:

  $ ampi update
  $ ampi update --target-version 0.4.0
  $ ampi update --porcelain
  $ ampi update --extensions
`;
}

/**
 * Run `ampi update`.
 *
 * @param {readonly string[]} argv The command line after `update` or `up`.
 * @param {UpdateHost} host
 * @returns {number} The exit code.
 */
export function runUpdateCommand(argv, host) {
  /** @type {{ "target-version"?: string, porcelain?: boolean, help?: boolean }} */
  let values;
  try {
    ({ values } = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: false, strict: true }));
  } catch (error) {
    host.err(`ampi: update: ${error instanceof Error ? error.message : String(error)}\n${USAGE_HINT}\n`);
    return 2;
  }
  if (values.help) {
    host.out(formatUpdateHelp());
    return 0;
  }
  const target = values["target-version"];
  if (target !== undefined && parseVersion(target) === undefined) {
    host.err(`ampi: update: --target-version needs a version such as 0.4.0, not "${target}".\n${USAGE_HINT}\n`);
    return 2;
  }
  const porcelain = values.porcelain === true;
  /** @param {string} line */
  const report = (line) => host.out(`${line}\n`);

  const installed = readPackageAt(host.cliRoot);
  const current = installed?.version === undefined ? undefined : parseVersion(installed.version);
  if (installed?.version === undefined || current === undefined) {
    host.err(`ampi: cannot read the version of ${CLI_PACKAGE_NAME} in ${host.cliRoot}; reinstall it.\n`);
    return 1;
  }
  const wanted = target ?? "latest";

  const checkout = readPackageAt(path.resolve(host.cliRoot, "..", ".."));
  if (checkout?.name === AMPI_PACKAGE_NAME) {
    host.err(
      `ampi: this ampi runs from a source checkout of the ampi repository (${checkout.root}), so ampi update leaves it alone. ` +
        `Update it with git pull and npm ci in ${checkout.root}.\n`,
    );
    return 1;
  }

  const root = host.runNpm(["root", "-g"]);
  const globalRoot = root.status === 0 ? root.stdout.trim() : "";
  if (globalRoot === "") {
    host.err(`ampi: could not ask npm for its global directory (npm root -g): ${npmFailure(root)}.\n`);
    return 1;
  }
  if (!sameRealPath(host, host.cliRoot, path.join(globalRoot, ...CLI_PACKAGE_NAME.split("/")))) {
    host.err(`ampi: ${otherInstallAdvice(realPathOr(host, host.cliRoot), globalRoot, wanted)}\n`);
    return 1;
  }

  const spec = target === undefined ? CLI_PACKAGE_NAME : `${CLI_PACKAGE_NAME}@${target}`;
  const view = host.runNpm(["view", spec, "version"]);
  if (view.status !== 0) {
    if (/\bE404\b/.test(view.stderr)) {
      const what = target === undefined ? `${CLI_PACKAGE_NAME} is not on the npm registry` : `${CLI_PACKAGE_NAME} ${target} is not on the npm registry`;
      host.err(`ampi: ${what} (npm: ${npmFailure(view)}).\n`);
    } else {
      host.err(`ampi: npm view ${spec} version failed: ${npmFailure(view)}.\n`);
    }
    return 1;
  }
  const published = view.stdout.trim();
  const found = parseVersion(published);
  if (found === undefined || (target !== undefined && published !== target)) {
    const what = target === undefined ? `a version for ${CLI_PACKAGE_NAME}` : `${CLI_PACKAGE_NAME} ${target}`;
    host.err(`ampi: npm view did not report ${what}${published === "" ? "" : ` (it printed "${firstLine(published)}")`}; it is not on the npm registry.\n`);
    return 1;
  }

  const order = compareVersions(current, found);
  if (order === 0 || (target === undefined && order > 0)) {
    if (porcelain) report("no update needed");
    else if (order === 0) report(`ampi-cli ${installed.version} is installed${target === undefined ? ", the latest version" : ""}; no update needed.`);
    else report(`ampi-cli ${installed.version} is installed, newer than the latest published version ${published}; no update needed.`);
    return 0;
  }

  const args = ["install", "-g", "--ignore-scripts", `${CLI_PACKAGE_NAME}@${published}`];
  host.err(`ampi: updating ampi-cli from ${installed.version} to ${published}: npm ${args.join(" ")}\n`);
  const install = host.runNpm(args);
  for (const text of [install.stdout, install.stderr]) {
    if (install.status === 0 && text.trim() !== "") host.err(text.endsWith("\n") ? text : `${text}\n`);
  }
  if (install.status !== 0) {
    const tail = install.stderr.trimEnd().split("\n").slice(-STDERR_TAIL_LINES).join("\n");
    const how = install.error !== undefined ? `could not start: ${install.error.message}` : install.status === null ? "ended on a signal" : `exited with status ${install.status}`;
    host.err(`ampi: npm ${args.join(" ")} ${how}${tail === "" ? "." : `:\n${tail}`}\n`);
    return 1;
  }
  report(porcelain ? `updated ${published}` : `ampi-cli updated from ${installed.version} to ${published}.`);
  return 0;
}

/**
 * Run npm without a shell (on Windows through the shell, which `npm.cmd`
 * needs; every argument is fixed or a checked version) and collect its output.
 *
 * @param {string[]} args
 * @returns {NpmResult}
 */
export function spawnNpm(args) {
  const windows = process.platform === "win32";
  const result = spawnSync(windows ? "npm.cmd" : "npm", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: windows });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", ...(result.error ? { error: result.error } : {}) };
}

/** @param {UpdateHost} host @param {string} a @param {string} b */
function sameRealPath(host, a, b) {
  try {
    return host.realpath(a) === host.realpath(b);
  } catch {
    return false;
  }
}

/** @param {UpdateHost} host @param {string} file */
function realPathOr(host, file) {
  try {
    return host.realpath(file);
  } catch {
    return file;
  }
}

/**
 * How to update an ampi-cli that npm did not install globally, from where it is.
 *
 * @param {string} root The real path of the running ampi-cli.
 * @param {string} globalRoot npm's global directory.
 * @param {string} wanted A version, or `latest`.
 * @returns {string}
 */
export function otherInstallAdvice(root, globalRoot, wanted) {
  const spec = `${CLI_PACKAGE_NAME}@${wanted}`;
  const where = root.replaceAll("\\", "/").toLowerCase();
  if (where.includes("/_npx/")) return `this ampi runs from npx's cache (${root}); run npx ${spec} for that version.`;
  if (where.includes("/pnpm/") || where.includes("/.pnpm/")) return `this ampi was installed with pnpm (${root}); update it with pnpm add -g ${spec}.`;
  if (where.includes("/yarn/") || where.includes("/.yarn/")) return `this ampi was installed with yarn (${root}); update it with yarn global add ${spec}.`;
  if (where.includes("/.bun/") || where.includes("/install/global/node_modules/")) return `this ampi was installed with bun (${root}); update it with bun add -g ${spec}.`;
  return `this ampi (${root}) is not the one npm installs globally (in ${globalRoot}), so ampi update leaves it alone; update it with whatever installed it.`;
}

/**
 * One line from a failed npm call: npm's own reason, without the `npm error`
 * prefix, the error code line or the log file note.
 *
 * @param {NpmResult} result
 * @returns {string}
 */
function npmFailure(result) {
  if (result.error !== undefined) return `npm could not start: ${result.error.message}`;
  const lines = result.stderr
    .split("\n")
    .map((line) => line.replace(/^npm (?:error|ERR!)\s*/, "").trim())
    .filter((line) => line !== "" && !/^code\s/.test(line) && !/^A complete log of this run/.test(line) && !/^\d{3}$/.test(line));
  const reason = lines[0] ?? (result.status === null ? "npm ended on a signal" : `npm exited with status ${result.status}`);
  return reason.replace(/[.\s]+$/, "");
}

/** @param {string} text */
const firstLine = (text) => text.split("\n")[0].slice(0, 80);
