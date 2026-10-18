// The `ampi` command: route the arguments, then print help or versions, or
// start Pi with ampi loaded.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatAmpiHelp, routeAmpiArgv } from "./argv.js";
import { buildExecuteArgs, createRunExtension, isExecuteRun, readAll } from "./execute.js";
import { AMPI_PACKAGE_NAME, decideAmpiLoad, locateAmpiPackage, readPackageAt, resolveInstalledPackage } from "./packages.js";
import { hidePipedStdinFromPi, listPiExtensionSources } from "./pi-compat.js";

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** @returns {string} */
function formatVersions() {
  const cli = readPackageAt(CLI_ROOT);
  const ampi = locateAmpiPackage(CLI_ROOT);
  const pi = resolveInstalledPackage(PI_PACKAGE_NAME);
  return [
    `ampi-cli ${cli?.version ?? "unknown"}`,
    `ampi ${ampi?.version ?? "not installed"}`,
    `pi ${pi?.version ?? "not installed"}`,
    "",
  ].join("\n");
}

/**
 * Run one of Pi's own commands through Pi's own executable, so it gets the
 * same process setup (proxy settings, warnings) as `pi <command>`.
 *
 * @param {string[]} args
 * @returns {number}
 */
function runPiCommand(args) {
  const pi = resolveInstalledPackage(PI_PACKAGE_NAME);
  /** @type {string | undefined} */
  let bin;
  if (pi !== undefined) {
    const manifest = JSON.parse(readFileSync(path.join(pi.root, "package.json"), "utf8"));
    const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
    if (typeof entry === "string") bin = path.join(pi.root, entry);
  }
  if (bin === undefined) {
    process.stderr.write(`ampi: cannot find Pi's executable in ${PI_PACKAGE_NAME}; reinstall @skippermissions/ampi-cli.\n`);
    return 1;
  }
  const result = spawnSync(process.execPath, [bin, ...args], { stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`ampi: could not run Pi: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

/**
 * Hand the arguments to Pi's `main()`, adding ampi's package with `-e`, the way
 * Pi loads any package for one run, unless Pi already loads ampi. Execute mode
 * reads stdin itself and runs Pi's print mode with the combined message.
 *
 * @param {import("./argv.js").AmpiRoute} route
 * @returns {Promise<number | undefined>}
 */
async function startPi({ piArgs, options }) {
  const pi = await import(PI_PACKAGE_NAME);
  let args = [...piArgs];
  const parsed = pi.parseArgs(args);
  // RPC mode talks JSON over stdin, which execute mode reads for the message.
  if (options.execute && parsed.mode === "rpc") {
    process.stderr.write("ampi: -x cannot be combined with --mode rpc.\n");
    return 2;
  }
  const execute = isExecuteRun({
    explicit: options.execute,
    parsed,
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
  });
  if (!execute && (options.timings || !options.archive)) {
    process.stderr.write("ampi: --timings and --no-archive-after-execute need execute mode (-x).\n");
    return 2;
  }
  const cwd = process.cwd();
  const decision = decideAmpiLoad({
    piArgs: args,
    pi: await listPiExtensionSources(pi, cwd),
    cwd,
    packageNameAt: (start) => readPackageAt(start)?.name,
  });
  if (execute) {
    const stdin = process.stdin.isTTY === true ? undefined : await readAll(process.stdin);
    hidePipedStdinFromPi();
    const built = buildExecuteArgs(pi.parseArgs, args, stdin);
    if ("error" in built) {
      process.stderr.write(`ampi: ${built.error}\n`);
      return 2;
    }
    args = built.args;
  }
  if (decision.load) {
    const ampi = locateAmpiPackage(CLI_ROOT);
    if (ampi === undefined) {
      process.stderr.write(`ampi: cannot find ${AMPI_PACKAGE_NAME}; reinstall @skippermissions/ampi-cli.\n`);
      return 1;
    }
    args.unshift("-e", ampi.root);
  } else if (decision.reason === "pi") {
    process.stderr.write(`ampi: using the ampi that Pi already loads (${decision.source}).\n`);
  }
  // The process setup Pi's own executable does before calling main().
  process.title = "ampi";
  process.env.PI_CODING_AGENT = "true";
  process.env.AI_AGENT = "pi";
  process.emitWarning = () => {};
  const runExtension = createRunExtension({
    labels: options.labels,
    titled: options.title !== undefined,
    archive: execute && options.archive,
    timings: execute && options.timings,
  });
  await pi.main(args, { extensionFactories: [{ name: "ampi-cli", factory: runExtension, hidden: true }] });
  return undefined;
}

/**
 * Run the `ampi` command line.
 *
 * @param {string[]} argv Arguments after the executable and script.
 * @returns {Promise<number | undefined>} An exit code, or `undefined` when Pi set its own.
 */
export async function runAmpi(argv) {
  const route = routeAmpiArgv(argv);
  switch (route.command) {
    case "help":
      process.stdout.write(formatAmpiHelp());
      return 0;
    case "version":
      process.stdout.write(formatVersions());
      return 0;
    case "error":
      process.stderr.write(`ampi: ${route.error}\nRun ampi --help for the supported options.\n`);
      return 2;
    case "pi-command":
      return runPiCommand(route.piArgs);
  }
  return startPi(route);
}
