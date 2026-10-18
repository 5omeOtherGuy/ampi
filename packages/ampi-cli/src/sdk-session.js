// The one way the `ampi` command builds a Pi session through Pi's SDK
// (docs/sdk.md) instead of Pi's main(). Every command that needs a session
// in its own process (the `ampi app` worker today; a tools listing and any
// other SDK user later) calls createAmpiSdkSession, so they all load what an
// interactive `ampi` loads: Pi's configured packages and extensions, ampi
// itself unless Pi already loads it, and Pi's built-in codemode, tool_search
// and MCP extensions, which SDK sessions otherwise leave out. Calls Pi does
// not document stay in pi-compat.js.
import { fileURLToPath } from "node:url";
import { AMPI_PACKAGE_NAME, decideAmpiLoad, locateAmpiPackage, readPackageAt } from "./packages.js";
import { listPiExtensionSources, piSettingsManager } from "./pi-compat.js";

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * @typedef {object} SessionAmpi The ampi a session in a directory runs.
 * @property {boolean} load Whether the session loads it itself; false when Pi's settings already load it.
 * @property {{ name?: string, version?: string, root: string } | undefined} ampi The package, when it is installed.
 */

/**
 * Which ampi a session in `cwd` runs: the one Pi's settings or extension
 * directories load, else the command's own (as `ampi` decides for Pi's
 * main(), so ampi never loads twice).
 *
 * @param {any} pi The `@earendil-works/pi-coding-agent` module.
 * @param {string} cwd
 * @returns {Promise<SessionAmpi>}
 */
export async function locateSessionAmpi(pi, cwd) {
  const sources = await listPiExtensionSources(pi, cwd);
  /** @param {string} start */
  const packageNameAt = (start) => readPackageAt(start)?.name;
  const decision = decideAmpiLoad({ piArgs: [], pi: sources, cwd, packageNameAt });
  if (decision.load) return { load: true, ampi: locateAmpiPackage(CLI_ROOT) };
  const entry = sources.enabled.find((candidate) => packageNameAt(candidate.path) === AMPI_PACKAGE_NAME);
  return { load: false, ampi: entry ? readPackageAt(entry.path) : undefined };
}

/**
 * @typedef {object} AmpiSdkSessionOptions
 * @property {string} cwd The session's working directory.
 * @property {any} sessionManager Pi's `SessionManager` for the session (open, create or in memory).
 * @property {"tui" | "rpc" | "json" | "print"} mode What extensions see as `ctx.mode`.
 * @property {any} [uiContext] Pi's `ExtensionUIContext`; without one, extensions get Pi's no-op UI.
 * @property {boolean} connectMcp Add Pi's built-in codemode, tool_search and MCP extensions, as Pi's
 *   command does; MCP connects its servers when the session starts.
 * @property {any} [pi] The `@earendil-works/pi-coding-agent` module; defaults to the installed one.
 */

/**
 * Create a session runtime with what interactive ampi loads, and bind its
 * extensions (which emits `session_start`). Use `runtime.session` for the
 * session and `runtime.dispose()` to end it, so extensions see
 * `session_shutdown`. Extensions that failed to load are in
 * `runtime.diagnostics`.
 *
 * @param {AmpiSdkSessionOptions} options
 * @returns {Promise<any>} Pi's `AgentSessionRuntime`.
 */
export async function createAmpiSdkSession({ cwd, sessionManager, mode, uiContext, connectMcp, pi }) {
  const sdk = pi ?? (await import(PI_PACKAGE_NAME));
  const located = await locateSessionAmpi(sdk, cwd);
  if (located.load && located.ampi === undefined) {
    throw new Error(`cannot find ${AMPI_PACKAGE_NAME}; reinstall @skippermissions/ampi-cli.`);
  }
  const additionalExtensionPaths = located.load && located.ampi ? [located.ampi.root] : [];
  // Named like Pi's own built-ins, so `-builtin:<name>` in the extensions setting turns them off here too.
  const extensionFactories = connectMcp
    ? [
        { name: "codemode", factory: sdk.createCodemodeExtension(), replaceable: true, builtin: true },
        { name: "tool-search", factory: sdk.createToolSearchExtension(), replaceable: true, builtin: true },
        { name: "mcp", factory: sdk.createMcpExtension(), replaceable: true, builtin: true },
      ]
    : [];

  /** @param {{ cwd: string, agentDir: string, sessionManager: any, sessionStartEvent?: any }} target */
  const createRuntime = async (target) => {
    const services = await sdk.createAgentSessionServices({
      cwd: target.cwd,
      agentDir: target.agentDir,
      settingsManager: piSettingsManager(sdk, target.cwd),
      resourceLoaderOptions: { additionalExtensionPaths, extensionFactories },
    });
    const created = await sdk.createAgentSessionFromServices({
      services,
      sessionManager: target.sessionManager,
      sessionStartEvent: target.sessionStartEvent,
    });
    /** @type {{ path: string, error: string }[]} */
    const errors = services.resourceLoader.getExtensions().errors;
    const diagnostics = [
      ...services.diagnostics,
      ...errors.map(({ path, error }) => ({ type: "error", message: `Failed to load extension "${path}": ${error}` })),
    ];
    return { ...created, services, diagnostics };
  };

  const runtime = await sdk.createAgentSessionRuntime(createRuntime, { cwd, agentDir: sdk.getAgentDir(), sessionManager });
  await runtime.session.bindExtensions({ mode, uiContext });
  return runtime;
}
