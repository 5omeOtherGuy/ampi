// The one way the `ampi` command builds a Pi session through Pi's SDK
// (docs/sdk.md) instead of Pi's main(). Every command that needs a session
// in its own process (the `ampi app` worker, `ampi tools` and any later SDK
// user) calls createAmpiSdkSession instead of building its own, so they all
// load what an interactive `ampi` loads: Pi's configured
// packages and extensions, ampi itself unless Pi already loads it, and Pi's
// built-in codemode, tool_search and MCP extensions, which SDK sessions
// otherwise leave out. Pi's CLI also has a llama.cpp provider built in; Pi's
// SDK does not export it, so these sessions lack it. Calls Pi does not
// document stay in pi-compat.js.
import { fileURLToPath } from "node:url";
import { AMPI_PACKAGE_NAME, decideAmpiLoad, locateAmpiPackage, readPackageAt } from "./packages.js";
import { createPiSessionServices, listPiExtensionSources } from "./pi-compat.js";

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Stands in for MCP's transports when a session must not connect: every
 * server fails at once, without starting a process or opening a connection.
 */
function refuseMcpConnection() {
  throw new Error("this ampi command does not connect MCP servers");
}

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
 * @property {boolean} connectMcp Whether the MCP extension connects the configured servers when the
 *   session starts, as Pi's command does. Without it, the MCP extension gets a transport that refuses
 *   every server: it still reads its configuration (which can activate codemode or tool_search), but
 *   starts no server process, opens no connection and registers no server tools.
 * @property {string} [ampiMode] The value of `--ampi-mode`; without it ampi starts in the mode a new
 *   session starts in.
 * @property {any} [pi] The `@earendil-works/pi-coding-agent` module; defaults to the installed one.
 */

/**
 * Create a session runtime with what interactive ampi loads, and bind its
 * extensions (which emits `session_start`, where ampi-core applies the mode).
 * Use `runtime.session` for the session and `runtime.dispose()` to end it, so
 * extensions see `session_shutdown`. Extensions that failed to load are in
 * `runtime.diagnostics`.
 *
 * @param {AmpiSdkSessionOptions} options
 * @returns {Promise<any>} Pi's `AgentSessionRuntime`.
 */
export async function createAmpiSdkSession({ cwd, sessionManager, mode, uiContext, connectMcp, ampiMode, pi }) {
  const sdk = pi ?? (await import(PI_PACKAGE_NAME));
  const located = await locateSessionAmpi(sdk, cwd);
  if (located.load && located.ampi === undefined) {
    throw new Error(`cannot find ${AMPI_PACKAGE_NAME}; reinstall @skippermissions/ampi-cli.`);
  }
  const additionalExtensionPaths = located.load && located.ampi ? [located.ampi.root] : [];
  // Named like Pi's own built-ins, so `-builtin:<name>` in the extensions setting turns them off here too.
  const extensionFactories = [
    { name: "codemode", factory: sdk.createCodemodeExtension(), replaceable: true, builtin: true },
    { name: "tool-search", factory: sdk.createToolSearchExtension(), replaceable: true, builtin: true },
    {
      name: "mcp",
      factory: sdk.createMcpExtension(connectMcp ? {} : { createTransport: refuseMcpConnection }),
      replaceable: true,
      builtin: true,
    },
  ];
  const flagValues = ampiMode === undefined ? undefined : new Map([["ampi-mode", ampiMode]]);

  /** @param {{ cwd: string, agentDir: string, sessionManager: any, sessionStartEvent?: any }} target */
  const createRuntime = async (target) => {
    const { services, diagnostics } = await createPiSessionServices(sdk, {
      cwd: target.cwd,
      agentDir: target.agentDir,
      extensionPaths: additionalExtensionPaths,
      extensionFactories,
      flagValues,
    });
    const created = await sdk.createAgentSessionFromServices({
      services,
      sessionManager: target.sessionManager,
      sessionStartEvent: target.sessionStartEvent,
    });
    return { ...created, services, diagnostics };
  };

  const runtime = await sdk.createAgentSessionRuntime(createRuntime, { cwd, agentDir: sdk.getAgentDir(), sessionManager });
  await runtime.session.bindExtensions({ mode, uiContext });
  return runtime;
}
