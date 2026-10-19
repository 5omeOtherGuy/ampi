// `ampi doctor`: check Node.js, Pi, ampi, Pi's configuration directory, the
// search tools and git Pi uses, model credentials and ampi's data files, and
// explain what to do about each problem. The command only reads: it installs
// nothing, writes no file and starts no program of its own. buildDoctorChecks turns
// gathered facts into results without touching the system;
// gatherDoctorFacts reads the system through the host, so every check can
// be tested with an injected one.
import { accessSync, constants, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { liveRegistryDir } from "./live-registry.js";
import { AMPI_PACKAGE_NAME, decideAmpiLoad, locateAmpiPackage, readPackageAt } from "./packages.js";
import { countPiCredentialedModels, listPiExtensionSources, piAgentDir, piBinDir, readPiSettingsErrors } from "./pi-compat.js";
import { readThreadIndex, threadIndexPath } from "./thread-index.js";
import { satisfiesRange } from "./versions.js";

/**
 * @typedef {"ok" | "warn" | "fail"} DoctorStatus
 *
 * @typedef {object} DoctorCheck
 * @property {string} id
 * @property {DoctorStatus} status
 * @property {string} summary One line.
 * @property {string} [hint] One line on what to do; only when the status is not `ok`.
 *
 * @typedef {object} DoctorPi What the doctor reads through Pi (see createDoctorPi).
 * @property {string} version Pi's version.
 * @property {string} agentDir Pi's configuration directory.
 * @property {string} binDir Where Pi keeps the `fd` and `rg` it downloads.
 * @property {() => { scope: "user" | "project", path: string, message: string }[]} settingsErrors
 * @property {() => Promise<{ models: number, providers: number }>} credentialedModels
 * @property {() => Promise<import("./pi-compat.js").PiExtensionSources>} extensionSources
 *
 * @typedef {object} DoctorFileSystem
 * @property {(file: string) => "file" | "directory" | "other" | "missing"} kind What is at a path,
 *   following symbolic links.
 * @property {(file: string) => boolean} executable Whether the current user may run a file.
 * @property {(dir: string) => boolean} writable Whether the current user may create files in a directory.
 * @property {(dir: string) => string[]} readDir A directory's entries; throws when it cannot be read.
 * @property {(file: string) => Record<string, unknown>} readThreadIndex ampi's thread index; throws
 *   ThreadIndexError for a file it cannot use.
 *
 * @typedef {object} DoctorHost
 * @property {NodeJS.ProcessEnv} env
 * @property {string} cwd
 * @property {NodeJS.Platform} platform
 * @property {string} nodeVersion `process.versions.node`.
 * @property {string} cliRoot Directory of the ampi-cli package.
 * @property {() => Promise<DoctorPi | undefined>} loadPi Pi, or undefined when it cannot be loaded.
 * @property {DoctorFileSystem} fs
 * @property {boolean} isTTY Whether stdout is a terminal.
 * @property {number | undefined} colorDepth Bits per color of stdout, when it is a terminal.
 * @property {(text: string) => void} out Writes to stdout.
 * @property {import("./log.js").Logger} log For the command's diagnostics.
 *
 * @typedef {{ name: string, path: string, where: "bin" | "path" }} ToolLocation
 *
 * @typedef {object} DoctorFacts
 * @property {{ version: string, range: string | undefined }} node
 * @property {{ version: string, range: string | undefined, rangeOwner: string } | undefined} pi Undefined
 *   when Pi cannot be loaded.
 * @property {AmpiFacts} ampi
 * @property {AgentDirFacts | undefined} agentDir
 * @property {{ binDir: string | undefined, rg: ToolLocation | undefined, fd: ToolLocation | undefined }} tools
 * @property {string | undefined} git Where git is on PATH.
 * @property {{ models: number, providers: number } | { error: string } | undefined} models
 * @property {{ index: DataRead, live: DataRead } | undefined} ampiData
 * @property {{ term: string | undefined, colorterm: string | undefined, colorDepth: number | undefined } | undefined} terminal
 *   Only when stdout is a terminal.
 *
 * @typedef {object} AmpiFacts
 * @property {{ version?: string, root: string } | undefined} own The ampi that comes with ampi-cli.
 * @property {{ source: string, version?: string, root?: string } | undefined} pi The ampi Pi loads from its
 *   settings or extension directories; no root when it is not installed yet.
 * @property {string | undefined} error Why Pi's sources could not be read.
 *
 * @typedef {object} AgentDirFacts
 * @property {string} path
 * @property {"directory" | "missing" | "other"} kind
 * @property {boolean} writable
 * @property {{ path: string, message: string }[]} settingsErrors
 *
 * @typedef {{ state: "ok", count: number } | { state: "absent" } | { state: "error", message: string }} DataRead
 */

const USAGE_HINT = "Run ampi doctor --help for the options.";

export const OPTIONS = /** @type {const} */ ({
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
});

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/**
 * The text `ampi doctor --help` prints.
 *
 * @returns {string}
 */
export function formatDoctorHelp() {
  return `ampi doctor: check that ampi and what it needs are in order

Usage: ampi doctor [--json]

Checks, in this order:

  node        Node.js against the version ampi-cli needs
  pi          the installed Pi against the Pi versions the loading ampi supports
  ampi        which ampi loads: the one in Pi's settings or extension directories,
              or the one that comes with ampi-cli
  agent-dir   Pi's configuration directory exists and is writable, and its
              settings.json and the project's .pi/settings.json parse
  tools       rg and fd (or fdfind), in Pi's bin directory or on PATH
  git         git on PATH
  models      models with credentials, from Pi's auth.json or a provider's
              environment variable
  ampi-data   ampi's thread index and live session registry can be read
  terminal    TERM, COLORTERM and the color depth, when stdout is a terminal

Each line reads ok, warn or fail; a hint for each warn and fail follows the list.

Options:

  --json                        Print {"checks":[{"id","status","summary","hint"}]}

The command only reads, and makes no network request. It installs nothing (Pi downloads
rg and fd itself on first use when it is online), writes no file, runs no credential
command and refreshes no sign-in. It starts no program, except that Pi runs its configured
npm command (npm unless your settings, or those of a project Pi trusts, name another) for
its global directory (root -g) when an npm package in Pi's settings is not installed yet.
An untrusted project's settings are not read for this check.

Exit status: 0 when no check fails, 1 when one does, 2 on a usage error.

Examples:

  $ ampi doctor
  $ ampi doctor --json | jq -r '.checks[] | select(.status != "ok") | .id'
`;
}

/**
 * Run `ampi doctor`.
 *
 * @param {readonly string[]} argv The command line after `doctor`.
 * @param {DoctorHost} host
 * @returns {Promise<number>} The exit code.
 */
export async function runDoctorCommand(argv, host) {
  /** @type {{ json?: boolean, help?: boolean }} */
  let values;
  try {
    ({ values } = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: false, strict: true }));
  } catch (error) {
    host.log.error(`doctor: ${error instanceof Error ? error.message : String(error)}\n${USAGE_HINT}`);
    return 2;
  }
  if (values.help) {
    host.out(formatDoctorHelp());
    return 0;
  }
  const checks = buildDoctorChecks(await gatherDoctorFacts(host));
  host.out(values.json ? formatDoctorJson(checks) : formatDoctorText(checks, { color: host.isTTY && !host.env.NO_COLOR }));
  return checks.some((check) => check.status === "fail") ? 1 : 0;
}

/**
 * What the doctor reads through Pi, from the `@earendil-works/pi-coding-agent`
 * module. Every call goes through pi-compat.js and reads without writing.
 *
 * @param {any} pi
 * @param {string} cwd
 * @returns {DoctorPi}
 */
export function createDoctorPi(pi, cwd) {
  return {
    version: pi.VERSION,
    agentDir: piAgentDir(pi),
    binDir: piBinDir(pi),
    settingsErrors: () => readPiSettingsErrors(pi, cwd),
    credentialedModels: () => countPiCredentialedModels(pi),
    extensionSources: () => listPiExtensionSources(pi, cwd, { readOnly: true }),
  };
}

/** The file system as the doctor reads it. */
export const DOCTOR_FILE_SYSTEM = /** @type {DoctorFileSystem} */ ({
  kind: (file) => {
    try {
      const stat = statSync(file);
      return stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other";
    } catch {
      return "missing";
    }
  },
  executable: (file) => canAccess(file, constants.X_OK),
  writable: (dir) => canAccess(dir, constants.W_OK),
  readDir: (dir) => readdirSync(dir),
  readThreadIndex: (file) => readThreadIndex(file),
});

/** @param {string} file @param {number} mode */
function canAccess(file, mode) {
  try {
    accessSync(file, mode);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where `name` is on PATH: the first PATH directory holding an executable file
 * of that name, found without running anything. On Windows each extension of
 * PATHEXT is tried, as the shell does.
 *
 * @param {string} name
 * @param {Pick<DoctorHost, "env" | "platform" | "fs">} host
 * @returns {string | undefined}
 */
export function findOnPath(name, { env, platform, fs }) {
  const windows = platform === "win32";
  const paths = windows ? path.win32 : path.posix;
  const value = (windows ? (env.Path ?? env.PATH) : env.PATH) ?? "";
  const extensions = windows ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((extension) => extension !== "") : [""];
  for (const dir of value.split(windows ? ";" : ":")) {
    if (dir === "") continue;
    for (const extension of extensions) {
      const file = paths.join(dir, name + extension);
      if (fs.kind(file) === "file" && (windows || fs.executable(file))) return file;
    }
  }
  return undefined;
}

/**
 * Read everything the checks need. Nothing is written, and only Pi's own
 * package lookup may start a program (see listPiExtensionSources).
 *
 * @param {DoctorHost} host
 * @returns {Promise<DoctorFacts>}
 */
export async function gatherDoctorFacts(host) {
  const { fs } = host;
  const cli = readManifest(host.cliRoot);
  const pi = await host.loadPi();

  const own = locateAmpiPackage(host.cliRoot);
  /** @type {AmpiFacts} */
  const ampi = { own: own === undefined ? undefined : { version: own.version, root: own.root }, pi: undefined, error: undefined };
  if (pi !== undefined) {
    try {
      const sources = await pi.extensionSources();
      const decision = decideAmpiLoad({ piArgs: [], pi: sources, cwd: host.cwd, packageNameAt: (start) => readPackageAt(start)?.name });
      if (!decision.load) {
        const entry = sources.enabled.find((candidate) => candidate.source === decision.source && path.isAbsolute(candidate.path));
        const found = entry === undefined ? undefined : readPackageAt(entry.path);
        ampi.pi = found?.name === AMPI_PACKAGE_NAME ? { source: decision.source, version: found.version, root: found.root } : { source: decision.source };
      }
    } catch (error) {
      ampi.error = messageOf(error);
    }
  }
  const loaded = ampi.pi?.root ?? ampi.own?.root;
  const peers = loaded === undefined ? undefined : readManifest(loaded)?.peerDependencies;
  const loadedVersion = ampi.pi?.root !== undefined ? ampi.pi.version : ampi.own?.version;

  /** @type {AgentDirFacts | undefined} */
  let agentDir;
  /** @type {DoctorFacts["models"]} */
  let models;
  /** @type {DoctorFacts["ampiData"]} */
  let ampiData;
  if (pi !== undefined) {
    const kind = fs.kind(pi.agentDir);
    agentDir = {
      path: pi.agentDir,
      kind: kind === "file" ? "other" : kind,
      writable: kind === "directory" && fs.writable(pi.agentDir),
      settingsErrors: pi.settingsErrors(),
    };
    try {
      models = await pi.credentialedModels();
    } catch (error) {
      models = { error: messageOf(error) };
    }
    ampiData = { index: readIndex(fs, threadIndexPath(pi.agentDir)), live: readLive(fs, liveRegistryDir(pi.agentDir)) };
  }

  const binDir = pi?.binDir;
  const exe = host.platform === "win32" ? ".exe" : "";
  /** @param {string} name @param {string[]} pathNames @returns {ToolLocation | undefined} */
  const findTool = (name, pathNames) => {
    // Pi looks in its bin directory first, then on PATH (fd also as fdfind).
    const inBin = binDir === undefined ? undefined : path.join(binDir, name + exe);
    if (inBin !== undefined && fs.kind(inBin) === "file") return { name, path: inBin, where: "bin" };
    for (const pathName of pathNames) {
      const found = findOnPath(pathName, host);
      if (found !== undefined) return { name: pathName, path: found, where: "path" };
    }
    return undefined;
  };

  return {
    node: { version: host.nodeVersion, range: stringOr(cli?.engines?.node) },
    pi:
      pi === undefined
        ? undefined
        : {
            version: pi.version,
            range: stringOr(peers?.[PI_PACKAGE_NAME]),
            rangeOwner: loadedVersion === undefined ? "ampi" : `ampi ${loadedVersion}`,
          },
    ampi,
    agentDir,
    tools: { binDir, rg: findTool("rg", ["rg"]), fd: findTool("fd", ["fd", "fdfind"]) },
    git: findOnPath("git", host),
    models,
    ampiData,
    terminal: host.isTTY ? { term: host.env.TERM, colorterm: host.env.COLORTERM, colorDepth: host.colorDepth } : undefined,
  };
}

/** @param {unknown} value @returns {string | undefined} */
const stringOr = (value) => (typeof value === "string" ? value : undefined);

/** @param {unknown} error @returns {string} */
const messageOf = (error) => (error instanceof Error ? error.message : String(error));

/**
 * @param {string} root
 * @returns {Record<string, any> | undefined}
 */
function readManifest(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

/** @param {DoctorFileSystem} fs @param {string} file @returns {DataRead} */
function readIndex(fs, file) {
  if (fs.kind(file) === "missing") return { state: "absent" };
  try {
    return { state: "ok", count: Object.keys(fs.readThreadIndex(file)).length };
  } catch (error) {
    return { state: "error", message: messageOf(error) };
  }
}

/** @param {DoctorFileSystem} fs @param {string} dir @returns {DataRead} */
function readLive(fs, dir) {
  try {
    return { state: "ok", count: fs.readDir(dir).filter((name) => name.endsWith(".json")).length };
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return { state: "absent" };
    return { state: "error", message: messageOf(error) };
  }
}

/**
 * Turn gathered facts into the check results, in their fixed order.
 *
 * @param {DoctorFacts} facts
 * @returns {DoctorCheck[]}
 */
export function buildDoctorChecks(facts) {
  const checks = [checkNode(facts.node), checkPi(facts.pi), checkAmpi(facts.ampi), checkAgentDir(facts.agentDir), checkTools(facts.tools), checkGit(facts.git), checkModels(facts.models), checkAmpiData(facts.ampiData)];
  if (facts.terminal !== undefined) checks.push(checkTerminal(facts.terminal));
  return checks;
}

/**
 * @param {string} id
 * @param {DoctorStatus} status
 * @param {string} summary
 * @param {string} [hint]
 * @returns {DoctorCheck}
 */
const result = (id, status, summary, hint) => (status === "ok" || hint === undefined ? { id, status, summary } : { id, status, summary, hint });

/** @param {DoctorFacts["node"]} node */
function checkNode({ version, range }) {
  const summary = `Node.js ${version}`;
  if (range === undefined) return result("node", "warn", `${summary}; ampi-cli's package.json names no Node.js version`, "Reinstall @skippermissions/ampi-cli.");
  const fits = satisfiesRange(version, range);
  if (fits === undefined) return result("node", "warn", `${summary}; ampi-cli's Node.js range ${range} could not be checked`, `Check by hand that Node.js ${version} is in ${range}.`);
  if (!fits) return result("node", "fail", `${summary} is older than ampi-cli needs (${range})`, `Install Node.js ${range.replace(/^>=\s*/, "")} or later.`);
  return result("node", "ok", `${summary} (ampi-cli needs ${range})`);
}

/** @param {DoctorFacts["pi"]} pi */
function checkPi(pi) {
  if (pi === undefined) return result("pi", "fail", `Pi (${PI_PACKAGE_NAME}) cannot be loaded`, "Reinstall @skippermissions/ampi-cli, which brings its own Pi.");
  const summary = `Pi ${pi.version}`;
  if (pi.range === undefined) return result("pi", "warn", `${summary}; ${pi.rangeOwner} names no Pi version it supports`, "Check that ampi is installed completely.");
  const fits = satisfiesRange(pi.version, pi.range);
  if (fits === undefined) return result("pi", "warn", `${summary}; ${pi.rangeOwner}'s Pi range ${pi.range} could not be checked`, `Check by hand that Pi ${pi.version} is in ${pi.range}.`);
  if (!fits) {
    return result("pi", "fail", `${summary} is outside the Pi versions ${pi.rangeOwner} supports (${pi.range})`, "Update both with ampi update; when ampi comes from Pi's settings, ampi update --extensions updates it.");
  }
  return result("pi", "ok", `${summary} (${pi.rangeOwner} supports ${pi.range})`);
}

/** @param {AmpiFacts} ampi */
function checkAmpi({ own, pi, error }) {
  if (pi !== undefined) {
    if (pi.root === undefined) return result("ampi", "ok", `Pi's settings list ampi (${pi.source}), not installed yet: Pi installs it on its next start, and ampi-cli adds no copy of its own`);
    return result("ampi", "ok", `ampi ${pi.version ?? "(no version)"} that Pi loads (${pi.source}); ampi-cli adds no copy of its own`);
  }
  if (own === undefined) {
    return result("ampi", "fail", `${AMPI_PACKAGE_NAME} is not installed${error === undefined ? "" : `, and Pi's packages could not be read: ${error}`}`, "Reinstall @skippermissions/ampi-cli, which brings its own ampi.");
  }
  const summary = `ampi ${own.version ?? "(no version)"} that comes with ampi-cli loads (${own.root})`;
  if (error !== undefined) return result("ampi", "warn", `${summary}; Pi's packages could not be read: ${error}`, "Check the packages and extensions entries of Pi's settings.");
  return result("ampi", "ok", summary);
}

/** @param {AgentDirFacts | undefined} dir */
function checkAgentDir(dir) {
  if (dir === undefined) return result("agent-dir", "fail", "Pi's configuration directory is unknown: Pi cannot be loaded", "Reinstall @skippermissions/ampi-cli.");
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const hints = [];
  if (dir.kind === "other") {
    problems.push(`${dir.path} is not a directory`);
    hints.push(`move ${dir.path} aside or set PI_CODING_AGENT_DIR to a directory`);
  } else if (dir.kind === "directory" && !dir.writable) {
    problems.push(`${dir.path} is not writable`);
    hints.push(`make ${dir.path} writable for your user, or set PI_CODING_AGENT_DIR to a directory you can write`);
  }
  for (const { path: file, message } of dir.settingsErrors) {
    problems.push(`${file} does not parse (${message})`);
    hints.push(`fix ${file} or move it aside`);
  }
  if (problems.length > 0) return result("agent-dir", "fail", problems.join("; "), sentence(hints.join("; ")));
  if (dir.kind === "missing") return result("agent-dir", "warn", `${dir.path} does not exist yet`, "Pi creates it on its first start.");
  return result("agent-dir", "ok", `${dir.path} is writable and its settings parse`);
}

/** @param {DoctorFacts["tools"]} tools */
function checkTools({ binDir, rg, fd }) {
  /** @param {string} name @param {ToolLocation | undefined} found */
  const describe = (name, found) => {
    if (found === undefined) return `${name} not found`;
    const as = found.name === name ? name : `${name} (as ${found.name})`;
    return found.where === "bin" ? `${as} in Pi's bin directory (${found.path})` : `${as} on PATH (${found.path})`;
  };
  const summary = `${describe("rg", rg)}, ${describe("fd", fd)}`;
  if (rg !== undefined && fd !== undefined) return result("tools", "ok", summary);
  const where = binDir === undefined ? "its bin directory" : binDir;
  const missing = [rg === undefined ? "rg" : undefined, fd === undefined ? "fd" : undefined].filter((name) => name !== undefined);
  const packages = [rg === undefined ? "ripgrep" : undefined, fd === undefined ? "fd-find" : undefined].filter((name) => name !== undefined);
  const them = missing.length === 1 ? "it" : "them";
  return result(
    "tools",
    "warn",
    summary,
    `Pi downloads ${missing.join(" and ")} into ${where} on first use when it is online; or install ${them} with the system package manager (${packages.join(" and ")} on Debian and Ubuntu).`,
  );
}

/** @param {string | undefined} git */
function checkGit(git) {
  if (git === undefined) return result("git", "warn", "git not found on PATH", "Install git: repo: search filters, adding skills from git and commit mentions need it.");
  return result("git", "ok", `git on PATH (${git})`);
}

/** @param {DoctorFacts["models"]} models */
function checkModels(models) {
  const login = "Run /login in a session, or set a provider's API key variable (Pi's docs/providers.md lists them).";
  if (models === undefined) return result("models", "fail", "credentials are unknown: Pi cannot be loaded", "Reinstall @skippermissions/ampi-cli.");
  if ("error" in models) return result("models", "fail", `Pi's credentials cannot be read: ${models.error}`, "Fix Pi's auth.json or move it aside, then sign in again with /login.");
  if (models.models === 0) return result("models", "fail", "no model has credentials", login);
  const count = (/** @type {number} */ n, /** @type {string} */ word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return result("models", "ok", `credentials for ${count(models.models, "model")} from ${count(models.providers, "provider")}`);
}

/** @param {DoctorFacts["ampiData"]} data */
function checkAmpiData(data) {
  if (data === undefined) return result("ampi-data", "warn", "ampi's data files are unknown: Pi cannot be loaded", "Reinstall @skippermissions/ampi-cli.");
  const index =
    data.index.state === "absent" ? "no thread index yet" : data.index.state === "ok" ? `thread index readable (${plural(data.index.count, "session")})` : "thread index unreadable";
  const live =
    data.live.state === "absent" ? "no live registry yet" : data.live.state === "ok" ? `live registry readable (${plural(data.live.count, "entry", "entries")})` : "live registry unreadable";
  /** @type {string[]} */
  const hints = [];
  if (data.index.state === "error") hints.push(data.index.message);
  if (data.live.state === "error") hints.push(`${data.live.message}; check the directory's permissions`);
  if (hints.length === 0) return result("ampi-data", "ok", `${index}, ${live}`);
  return result("ampi-data", "warn", `${index}, ${live}`, sentence(hints.map((hint) => hint.replace(/\.$/, "")).join("; ")));
}

/** @param {NonNullable<DoctorFacts["terminal"]>} terminal */
function checkTerminal({ term, colorterm, colorDepth }) {
  const depth = colorDepth === undefined ? "color depth unknown" : `${colorDepth}-bit color`;
  return result("terminal", "ok", `TERM=${term ?? "(unset)"}, COLORTERM=${colorterm ?? "(unset)"}, ${depth}`);
}

/** @param {number} n @param {string} one @param {string} [many] */
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** @param {string} text Starts lowercase or uppercase; returns it capitalized with a final period. */
const sentence = (text) => `${text[0].toUpperCase()}${text.slice(1)}${text.endsWith(".") ? "" : "."}`;

const STATUS_COLORS = { ok: "\u001b[32m", warn: "\u001b[33m", fail: "\u001b[31m" };
const ID_WIDTH = 11;

/**
 * The text report: one line per check (status, id, summary), then the hints
 * of the checks that are not ok, each after its id.
 *
 * @param {readonly DoctorCheck[]} checks
 * @param {{ color: boolean }} options Color the status words (for a terminal).
 * @returns {string}
 */
export function formatDoctorText(checks, { color }) {
  const lines = checks.map((check) => {
    const word = check.status.padEnd(4);
    const status = color ? `${STATUS_COLORS[check.status]}${word}\u001b[0m` : word;
    return `${status}  ${check.id.padEnd(ID_WIDTH)}${check.summary}`;
  });
  const hints = checks.filter((check) => check.hint !== undefined).map((check) => `${check.id}: ${check.hint}`);
  return `${[...lines, ...(hints.length > 0 ? ["", ...hints] : [])].join("\n")}\n`;
}

/**
 * The `--json` report.
 *
 * @param {readonly DoctorCheck[]} checks
 * @returns {string}
 */
export function formatDoctorJson(checks) {
  return `${JSON.stringify({ checks: checks.map(({ id, status, summary, hint }) => (hint === undefined ? { id, status, summary } : { id, status, summary, hint })) }, null, 2)}\n`;
}
