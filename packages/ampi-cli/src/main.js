// The `ampi` command: route the arguments, then print help or versions, or
// start Pi with ampi loaded.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatAmpiHelp, routeAmpiArgv } from "./argv.js";
import { buildExecuteArgs, createRunExtension, isExecuteRun, readAll } from "./execute.js";
import { AMPI_PACKAGE_NAME, decideAmpiLoad, locateAmpiPackage, readPackageAt, resolveInstalledPackage } from "./packages.js";
import { capturePiJsonOutput, hidePipedStdinFromPi, listPiExtensionSources } from "./pi-compat.js";
import { createStreamJsonEncoder, readStreamJsonContext } from "./stream-json.js";

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
  if (options.streamJson && !execute) {
    process.stderr.write("ampi: --stream-json needs execute mode (-x).\n");
    return 2;
  }
  if (options.streamJson && parsed.mode !== undefined) {
    process.stderr.write(`ampi: --stream-json replaces Pi's output mode; leave out --mode ${parsed.mode}.\n`);
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
  const extensionFactories = [{ name: "ampi-cli", factory: runExtension, hidden: true }];
  if (!options.streamJson) {
    await pi.main(args, { extensionFactories });
    return undefined;
  }
  return runStreamJson(pi, args, extensionFactories, options.streamJsonThinking);
}

/**
 * Run Pi's JSON mode and print stream JSON records in place of its events.
 *
 * @param {any} pi The `@earendil-works/pi-coding-agent` module.
 * @param {string[]} args Pi's arguments for an execute run.
 * @param {{ name: string, factory: (pi: any) => void, hidden: boolean }[]} extensionFactories
 * @param {boolean} thinking
 * @returns {Promise<number>}
 */
async function runStreamJson(pi, args, extensionFactories, thinking) {
  /** @type {any} The extension API of the current runtime, for the tools and mode in the init record. */
  let runtime;
  const encoder = createStreamJsonEncoder({ thinking, now: () => performance.now(), context: () => readStreamJsonContext(runtime) });
  /** @param {import("./stream-json.js").StreamJsonRecord[]} records */
  const lines = (records) => records.map((record) => `${JSON.stringify(record)}\n`).join("");
  const output = capturePiJsonOutput((event) => lines(encoder.push(event)));
  try {
    const factory = (/** @type {any} */ api) => {
      runtime = api;
    };
    await pi.main(["--mode", "json", ...args], { extensionFactories: [...extensionFactories, { name: "ampi-cli-stream-json", factory, hidden: true }] });
  } finally {
    output.restore();
  }
  // Pi's JSON mode sets a failing exit code only when the run threw; the error is then on stderr.
  const failed = process.exitCode !== undefined && process.exitCode !== 0;
  const { records, exitCode } = encoder.finish(failed ? "Pi stopped with an error; see stderr." : undefined);
  await output.write(lines(records));
  return failed ? Number(process.exitCode) : exitCode;
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
