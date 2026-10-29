// `ampi app --worker`: one session for `ampi app`, in a process of its own.
// ampi keeps per-process state on globalThis (mode state, the command
// registry, the prompt queue), so one process never runs two ampi sessions;
// `ampi app` starts one worker per session it serves. The worker runs the
// session through Pi's SDK in RPC mode, and ampi-gui serves its web GUI on a
// loopback port with the token `ampi app` chose.
//
// The protocol uses only the Node IPC channel, never arguments or
// environment variables, which other processes and the session's own child
// processes can read.
//
// parent → worker
//   { type: "start", token, session: { path } | { cwd }, mode? }
//                                                           open a saved session, or start one in cwd; a
//                                                           mode key starts it in that mode, as `ampi -m`
//   { type: "stop" }                                        dispose the session and exit 0
// worker → parent
//   { type: "ready", pid, port, sessionId, sessionPath }    the GUI listens on 127.0.0.1:<port>
//   { type: "activity", state: "busy" | "idle" }            the agent started, or settled
//   { type: "error", code, message, holder? }              then the worker exits
//
// Error codes: `held` (another live process has the file open; `holder` names its kind and pid; exit
// 3, the file is not opened), `bad-start`, `missing`, `no-ampi`, `ampi-too-old`, `no-gui` and `failed`
// (exit 1; also for any error while opening the file or locating ampi). The worker also stops when
// the channel closes, before it is ready too: a cancelled start never builds a session.
//
// Extensions that ask the user (`ctx.ui.confirm`, `select`, `input`,
// `editor`) are answered on the page: see createAmpiAppUIContext.
//
// The worker binds no command actions, so its session's runtime is never
// replaced. A worker that binds them (for /new or /resume) has to rebind its
// activity subscription to the new runtime.session, as Pi's session runtime
// example does, and report the new GUI port.
import { existsSync } from "node:fs";
import path from "node:path";
import { findLiveOwner, liveRegistryDir } from "./live-registry.js";
import { listSessionExtensionPaths, piAgentDir, piTheme } from "./pi-compat.js";
import { createAmpiSdkSession, locateSessionAmpi } from "./sdk-session.js";

/**
 * The global ampi-core reads the GUI host from (see
 * `src/extensions/ampi-core/gui-host.ts`). ampi ships TypeScript that only
 * Pi's loader can import, so the command writes the record directly.
 */
export const AMPI_GUI_HOST_GLOBAL_KEY = "__pi_ampi_gui_host_v1__";

/** The first ampi release with the GUI host seam. */
export const HOSTED_SESSIONS_MIN_AMPI_VERSION = "0.4.0";

/** The seam's file inside the ampi package; an older ampi lacks it. */
const GUI_HOST_SEAM = path.join("src", "extensions", "ampi-core", "gui-host.ts");
/** ampi-gui's entry, which serves the sessions; ampi setup can leave it out. */
const GUI_ENTRY = path.join("src", "extensions", "ampi-gui", "index.ts");

/**
 * Tell ampi's extensions in this process that it hosts the session for
 * `ampi app`. Must run before the session is created.
 *
 * @param {{ token: string, ownerPid: number, ready: (info: { port: number }) => void }} host
 */
export function registerAmpiGuiHost({ token, ownerPid, ready }) {
  /** @type {Record<string, unknown>} */ (globalThis)[AMPI_GUI_HOST_GLOBAL_KEY] = { role: "session", token, ownerPid, ready };
}

/** A dialog nobody answered. */
const CANCELLED = Object.freeze({ cancelled: true });

/**
 * The session's `ctx.ui`. A worker has no terminal, so the dialogs (select,
 * confirm, input, editor) go to the `dialog` handler ampi-gui sets on the
 * host record at session start, which asks the page, and notify goes to its
 * `notice`. A dialog asked before ampi-gui set the handler, or whose handler
 * fails, resolves as cancelled: `undefined`, or `false` for confirm. The
 * other members do what Pi's RPC mode does for them without a client:
 * nothing, or an empty answer; `theme` is Pi's theme, which
 * createAmpiSdkSession loads from Pi's settings. Because a UI context is bound, Pi tells
 * extensions `ctx.hasUI === true` (and `ctx.mode === "rpc"`), as in RPC mode.
 *
 * @returns {Record<string, any>} Pi's `ExtensionUIContext`.
 */
export function createAmpiAppUIContext() {
  const host = () => /** @type {Record<string, any> | undefined} */ (/** @type {Record<string, unknown>} */ (globalThis)[AMPI_GUI_HOST_GLOBAL_KEY]);
  /** @param {Record<string, unknown>} request @param {unknown} options @returns {Promise<Record<string, unknown>>} */
  const ask = async (request, options) => {
    const handler = host()?.dialog;
    if (typeof handler !== "function") return CANCELLED;
    try {
      const answer = await handler(request, isObject(options) ? options : {});
      return isObject(answer) ? answer : CANCELLED;
    } catch {
      return CANCELLED;
    }
  };
  /** @param {Record<string, unknown>} answer */
  const text = (answer) => (typeof answer.value === "string" ? answer.value : undefined);
  const nothing = () => {};
  return {
    select: async (/** @type {string} */ title, /** @type {string[]} */ options, /** @type {unknown} */ opts) =>
      text(await ask({ kind: "select", title, options: [...options] }, opts)),
    confirm: async (/** @type {string} */ title, /** @type {string} */ message, /** @type {unknown} */ opts) =>
      (await ask({ kind: "confirm", title, message }, opts)).value === true,
    input: async (/** @type {string} */ title, /** @type {string | undefined} */ placeholder, /** @type {unknown} */ opts) =>
      text(await ask({ kind: "input", title, placeholder }, opts)),
    editor: async (/** @type {string} */ title, /** @type {string | undefined} */ prefill) => text(await ask({ kind: "editor", title, initial: prefill }, {})),
    notify(/** @type {string} */ message, /** @type {string | undefined} */ type) {
      try {
        host()?.notice?.(String(message), type ?? "info");
      } catch {}
    },
    onTerminalInput: () => nothing,
    setStatus: nothing,
    setWorkingMessage: nothing,
    setWorkingVisible: nothing,
    setWorkingIndicator: nothing,
    setHiddenThinkingLabel: nothing,
    setWidget: nothing,
    setFooter: nothing,
    setHeader: nothing,
    setTitle: nothing,
    custom: async () => undefined,
    pasteToEditor: nothing,
    setEditorText: nothing,
    getEditorText: () => "",
    addAutocompleteProvider: nothing,
    setEditorComponent: nothing,
    getEditorComponent: () => undefined,
    get theme() {
      return piTheme();
    },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "A session in ampi app has no terminal theme to switch." }),
    getToolsExpanded: () => false,
    setToolsExpanded: nothing,
  };
}

/**
 * @typedef {object} WorkerChannel The IPC channel; `process` in a forked worker.
 * @property {boolean} connected
 * @property {(message: unknown, callback: (error: Error | null) => void) => unknown} send
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} on
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} off
 *
 * @typedef {object} AppWorkerOptions
 * @property {WorkerChannel} channel
 * @property {any} pi The `@earendil-works/pi-coding-agent` module.
 * @property {typeof createAmpiSdkSession} [createSession]
 * @property {typeof locateSessionAmpi} [locateAmpi]
 * @property {string} [registryDir] The live registry; defaults to Pi's agent directory's.
 * @property {number} [pid]
 * @property {number} [ownerPid] The `ampi app` process; defaults to the parent.
 * @property {(dir: string) => void} [chdir]
 */

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The target of a start message, or undefined when it is malformed.
 *
 * @param {Record<string, any>} message
 * @returns {{ token: string, path?: string, cwd?: string, mode?: string } | undefined}
 */
function parseStart(message) {
  const { token, session, mode } = message;
  if (typeof token !== "string" || token === "" || !isObject(session)) return undefined;
  if (mode !== undefined && (typeof mode !== "string" || mode === "")) return undefined;
  const hasPath = typeof session.path === "string" && session.path !== "";
  const hasCwd = typeof session.cwd === "string" && session.cwd !== "";
  if (hasPath === hasCwd) return undefined;
  const target = hasPath ? { token, path: path.resolve(session.path) } : { token, cwd: path.resolve(session.cwd) };
  return mode === undefined ? target : { ...target, mode };
}

/**
 * Run the worker protocol until the session stops.
 *
 * @param {AppWorkerOptions} options
 * @returns {Promise<number>} The exit code.
 */
export async function runAppWorker(options) {
  const { channel, pi } = options;
  const createSession = options.createSession ?? createAmpiSdkSession;
  const locateAmpi = options.locateAmpi ?? locateSessionAmpi;
  const registryDir = options.registryDir ?? liveRegistryDir(piAgentDir(pi));
  const pid = options.pid ?? process.pid;
  const ownerPid = options.ownerPid ?? process.ppid;
  const chdir = options.chdir ?? ((/** @type {string} */ dir) => process.chdir(dir));

  /** @type {(message: Record<string, any> | undefined) => void} */
  let resolveStart = () => {};
  /** @type {Promise<Record<string, any> | undefined>} */
  const started = new Promise((resolve) => {
    resolveStart = resolve;
  });
  let stopRequested = false;
  /** @type {() => void} */
  let resolveStop = () => {};
  /** @type {Promise<void>} */
  const stopped = new Promise((resolve) => {
    resolveStop = resolve;
  });
  const stop = () => {
    stopRequested = true;
    resolveStart(undefined);
    resolveStop();
  };
  /** @param {unknown} message */
  const onMessage = (message) => {
    if (!isObject(message)) return;
    if (message.type === "start") resolveStart(message);
    else if (message.type === "stop") stop();
  };
  channel.on("message", onMessage);
  channel.on("disconnect", stop);

  /** @param {Record<string, unknown>} message @returns {Promise<void>} */
  const post = (message) =>
    new Promise((resolve) => {
      if (!channel.connected) return resolve();
      try {
        channel.send(message, () => resolve());
      } catch {
        resolve();
      }
    });
  /** @param {string} code @param {string} message @param {Record<string, unknown>} [extra] */
  const fail = async (code, message, extra = {}) => {
    await post({ type: "error", code, message, ...extra });
    return code === "held" ? 3 : 1;
  };

  /** @type {any} */
  let runtime;
  try {
    const message = await started;
    if (message === undefined) return 0;
    return await serve(message);
  } catch (error) {
    return await fail("failed", `Could not start the session: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    channel.off("message", onMessage);
    channel.off("disconnect", stop);
    if (runtime !== undefined) await runtime.dispose();
  }

  /** @param {Record<string, any>} message @returns {Promise<number>} */
  async function serve(message) {
    const start = parseStart(message);
    if (start === undefined) {
      return await fail("bad-start", "The start message needs a token and either session.path or session.cwd, and a mode, if any, as a key.");
    }

    /** @type {any} */
    let sessionManager;
    if (start.path !== undefined) {
      // Pi does not lock session files: never open one another live process writes.
      const holder = findLiveOwner(start.path, { dir: registryDir, exceptPid: pid });
      if (holder) {
        return await fail("held", `Process ${holder.pid} (${holder.kind}) has this session open; continue it there.`, {
          holder: { kind: holder.kind, pid: holder.pid },
        });
      }
      if (!existsSync(start.path)) return await fail("missing", `No session file at ${start.path}.`);
      sessionManager = pi.SessionManager.open(start.path);
    } else {
      sessionManager = pi.SessionManager.create(start.cwd);
    }
    /** @type {string} */
    const cwd = sessionManager.getCwd();

    const located = await locateAmpi(pi, cwd);
    if (stopRequested) return 0;
    if (located.ampi === undefined) return await fail("no-ampi", "Cannot find the ampi package this session would load.");
    if (!existsSync(path.join(located.ampi.root, GUI_HOST_SEAM))) {
      return await fail(
        "ampi-too-old",
        `ampi app needs @skippermissions/ampi ${HOSTED_SESSIONS_MIN_AMPI_VERSION} or later; ${located.ampi.root} has ${located.ampi.version ?? "an unknown version"}.`,
      );
    }

    /** @type {number | undefined} */
    let port;
    registerAmpiGuiHost({
      token: start.token,
      ownerPid,
      ready: (info) => {
        port = info.port;
      },
    });
    // ampi's extensions read settings relative to the working directory.
    chdir(cwd);
    // A mode is applied as the `--ampi-mode` flag, so the session starts in it before its first message.
    const ampiMode = start.mode === undefined ? {} : { ampiMode: start.mode };
    runtime = await createSession({ cwd, sessionManager, mode: "rpc", uiContext: createAmpiAppUIContext(), connectMcp: true, pi, ...ampiMode });
    if (port === undefined) {
      /** @type {string[]} */
      const errors = (runtime.diagnostics ?? []).filter((/** @type {any} */ d) => d.type === "error").map((/** @type {any} */ d) => d.message);
      const loaded = listSessionExtensionPaths(runtime);
      const off = loaded !== undefined && !loaded.includes(path.join(located.ampi.root, GUI_ENTRY));
      const hint = off ? ["The gui part of ampi is off in Pi's settings; switch it on with ampi setup --add gui."] : [];
      return await fail("no-gui", ["ampi-gui did not start a server for this session.", ...hint, ...errors].join(" "));
    }
    if (stopRequested) return 0;

    const session = runtime.session;
    const unsubscribe = session.subscribe((/** @type {any} */ event) => {
      if (event.type === "agent_start") void post({ type: "activity", state: "busy" });
      else if (event.type === "agent_settled") void post({ type: "activity", state: "idle" });
    });
    await post({ type: "ready", pid, port, sessionId: session.sessionId, sessionPath: session.sessionFile ?? null });
    await stopped;
    unsubscribe();
    return 0;
  }
}
