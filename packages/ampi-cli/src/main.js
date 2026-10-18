// The `ampi` command: route the arguments, then print help or versions, or
// start Pi with ampi loaded.
import { fileURLToPath } from "node:url";
import { formatAmpiHelp, routeAmpiArgv } from "./argv.js";
import { AMPI_PACKAGE_NAME, decideAmpiLoad, locateAmpiPackage, readPackageAt, resolveInstalledPackage } from "./packages.js";

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
 * Hand the arguments to Pi's `main()`. With `withAmpi`, ampi's package is added
 * with `-e`, the way Pi loads any package for one run, unless Pi already loads
 * it from a `-e` argument or from its settings.
 *
 * @param {string[]} piArgs
 * @param {boolean} withAmpi
 * @returns {Promise<number | undefined>}
 */
async function startPi(piArgs, withAmpi) {
  const pi = await import(PI_PACKAGE_NAME);
  const args = [...piArgs];
  if (withAmpi) {
    const cwd = process.cwd();
    const agentDir = pi.getAgentDir();
    // Project settings are read as if trusted: a project that lists ampi gets it
    // from Pi once trust is granted, so the bin must not add a second copy.
    const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const configured = new pi.DefaultPackageManager({ cwd, agentDir, settingsManager }).listConfiguredPackages();
    const decision = decideAmpiLoad({
      piArgs: args,
      configured,
      cwd,
      packageNameAt: (start) => readPackageAt(start)?.name,
    });
    if (decision.load) {
      const ampi = locateAmpiPackage(CLI_ROOT);
      if (ampi === undefined) {
        process.stderr.write(`ampi: cannot find ${AMPI_PACKAGE_NAME}; reinstall @skippermissions/ampi-cli.\n`);
        return 1;
      }
      args.unshift("-e", ampi.root);
    } else if (decision.reason === "settings") {
      process.stderr.write(`ampi: using ampi from Pi's settings (${decision.source}).\n`);
    }
  }
  process.title = "ampi";
  process.env.PI_CODING_AGENT = "true";
  process.env.AI_AGENT = "pi";
  await pi.main(args);
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
      return startPi(route.piArgs, false);
  }
  for (const notice of route.notices) process.stderr.write(`${notice}\n`);
  return startPi(route.piArgs, true);
}
