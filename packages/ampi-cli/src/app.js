// `ampi app`: one page for every Pi session on this machine. The command
// runs an in-memory Pi session (never saved) whose ampi-gui serves the page
// (the hub, src/extensions/ampi-gui/hub.ts), and starts one `ampi app
// --worker` process per session the page runs, because ampi keeps
// per-process state and one process never runs two ampi sessions.
//
// The command tells ampi-gui it is the app through ampi-core's GUI host
// record (src/extensions/ampi-core/gui-host.ts) with role "hub": the page's
// token, its own pid, `ready({ port })` and `startSession(request)`, which
// forks a worker and resolves once its GUI listens. Ctrl+C (SIGINT) or
// SIGTERM stops every worker, ends the in-memory session and exits 0.
import { fork, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AMPI_GUI_HOST_GLOBAL_KEY } from "./app-worker.js";
import { liveRegistryDir, readLiveEntries } from "./live-registry.js";
import { piAgentDir } from "./pi-compat.js";
import { createAmpiSdkSession } from "./sdk-session.js";

const BIN = fileURLToPath(new URL("../bin/ampi.js", import.meta.url));

/** How long a worker may take to stop before it is killed. */
export const WORKER_STOP_TIMEOUT_MS = 5_000;

/**
 * @typedef {{ path: string } | { cwd: string }} StartRequest
 *
 * @typedef {object} WorkerProcess What `forkWorker` returns; a `ChildProcess` in the command.
 * @property {number | undefined} pid
 * @property {boolean} connected
 * @property {(message: unknown) => unknown} send
 * @property {(signal?: NodeJS.Signals) => unknown} kill
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} on
 *
 * @typedef {object} HubSession A worker that runs one session; see `MmrGuiHubSession` in gui-host.ts.
 * @property {number} pid
 * @property {number} port
 * @property {string} token
 * @property {string} sessionId
 * @property {string | null} sessionPath
 * @property {() => Promise<void>} stop
 * @property {(listener: () => void) => void} onExit
 * @property {(listener: (state: "busy" | "idle") => void) => void} onActivity
 *
 * @typedef {object} AppOptions
 * @property {any} pi The `@earendil-works/pi-coding-agent` module.
 * @property {boolean} open Open the page in a browser.
 * @property {string} cwd The in-memory session's working directory.
 * @property {(text: string) => void} out
 * @property {(text: string) => void} err
 * @property {Promise<unknown>} stopped Settles on SIGINT or SIGTERM.
 * @property {string} [registryDir] The live registry; defaults to Pi's agent directory's.
 * @property {number} [pid]
 * @property {() => WorkerProcess} [forkWorker] Starts `ampi app --worker` with an IPC channel.
 * @property {typeof createAmpiSdkSession} [createSession]
 * @property {(url: string) => Promise<boolean>} [openUrl]
 * @property {() => string} [createToken]
 * @property {(callback: () => void, ms: number) => unknown} [setTimer]
 * @property {(handle: unknown) => void} [clearTimer]
 */

/**
 * Tell ampi's extensions in this process that it is `ampi app`. Must run
 * before the session is created.
 *
 * @param {{ token: string, ownerPid: number, ready: (info: { port: number }) => void, startSession: (request: StartRequest) => Promise<HubSession> }} hub
 */
export function registerAmpiGuiHub({ token, ownerPid, ready, startSession }) {
  /** @type {Record<string, unknown>} */ (globalThis)[AMPI_GUI_HOST_GLOBAL_KEY] = { role: "hub", token, ownerPid, ready, startSession };
}

/**
 * Open a URL with the platform's opener, by the rules ampi-gui's
 * `thread.openInBrowser` uses (`openMmrGuiUrl`): `open` on macOS, `xdg-open`
 * elsewhere when a desktop is there to show it, nothing on Windows.
 *
 * @param {string} url
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @returns {Promise<boolean>}
 */
export function openAppUrl(url, env = process.env, platform = process.platform) {
  const command = platform === "darwin" ? "open" : platform === "win32" ? undefined : "xdg-open";
  if (!command || (platform !== "darwin" && !env.DISPLAY && !env.WAYLAND_DISPLAY)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn(command, [url], { detached: true, stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Run `ampi app` until it is stopped.
 *
 * @param {AppOptions} options
 * @returns {Promise<number>} The exit code.
 */
export async function runApp(options) {
  const { pi, out, err } = options;
  const pid = options.pid ?? process.pid;
  const registryDir = options.registryDir ?? liveRegistryDir(piAgentDir(pi));
  const createSession = options.createSession ?? createAmpiSdkSession;
  const createToken = options.createToken ?? (() => randomBytes(32).toString("base64url"));
  const openUrl = options.openUrl ?? openAppUrl;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(/** @type {any} */ (handle)));
  const forkWorker =
    options.forkWorker ??
    // Its own process group, so Ctrl+C reaches only the app, which stops each worker in turn; a
    // worker also stops when the app's IPC channel closes, so none outlives the app.
    (() => fork(BIN, ["app", "--worker"], { stdio: ["ignore", "ignore", "inherit", "ipc"], detached: true }));

  const running = readLiveEntries({ dir: registryDir }).find((entry) => entry.kind === "app" && entry.pid !== pid);
  if (running) {
    err(`ampi: ampi app already runs in process ${running.pid}. Use that one, or stop it first.\n`);
    return 1;
  }

  /** @type {Set<HubSession>} The workers that have not exited. */
  const workers = new Set();

  /**
   * Fork a worker for a session and resolve once its GUI listens.
   *
   * @param {StartRequest} request
   * @returns {Promise<HubSession>}
   */
  const startSession = (request) =>
    new Promise((resolve, reject) => {
      const child = forkWorker();
      const token = createToken();
      let exited = false;
      /** @type {(() => void)[]} */
      const exitListeners = [];
      /** @type {((state: "busy" | "idle") => void)[]} */
      const activityListeners = [];
      /** @type {Promise<void>} */
      const exit = new Promise((resolveExit) => {
        child.on("exit", () => {
          exited = true;
          workers.delete(session);
          for (const listener of exitListeners.splice(0)) listener();
          reject(new Error("The session's worker stopped before it was ready."));
          resolveExit();
        });
      });
      /** @type {HubSession} */
      const session = {
        pid: child.pid ?? 0,
        port: 0,
        token,
        sessionId: "",
        sessionPath: null,
        async stop() {
          if (exited) return;
          try {
            if (child.connected) child.send({ type: "stop" });
          } catch {
            // The channel closed: the worker is stopping on its own.
          }
          const timer = setTimer(() => {
            // Only this app's own child, and only when it did not stop in time.
            if (!exited) child.kill("SIGKILL");
          }, WORKER_STOP_TIMEOUT_MS);
          await exit;
          clearTimer(timer);
        },
        onExit(listener) {
          if (exited) listener();
          else exitListeners.push(listener);
        },
        onActivity(listener) {
          activityListeners.push(listener);
        },
      };
      workers.add(session);
      child.on("error", reject);
      child.on("message", (/** @type {unknown} */ message) => {
        if (!isObject(message)) return;
        if (message.type === "ready") {
          Object.assign(session, { pid: message.pid, port: message.port, sessionId: message.sessionId, sessionPath: message.sessionPath });
          resolve(session);
        } else if (message.type === "activity" && (message.state === "busy" || message.state === "idle")) {
          for (const listener of activityListeners) listener(message.state);
        } else if (message.type === "error") {
          reject(Object.assign(new Error(String(message.message)), { code: message.code, holder: message.holder }));
        }
      });
      child.send({ type: "start", token, session: request });
    });

  const token = createToken();
  /** @type {number | undefined} */
  let port;
  registerAmpiGuiHub({
    token,
    ownerPid: pid,
    ready: (info) => {
      port = info.port;
    },
    startSession,
  });

  /** @type {any} */
  let runtime;
  try {
    runtime = await createSession({
      cwd: options.cwd,
      // Never saved: the app has no session of its own, only a process for ampi's extensions.
      sessionManager: pi.SessionManager.inMemory(options.cwd),
      mode: "rpc",
      uiContext: undefined,
      connectMcp: false,
      pi,
    });
  } catch (error) {
    err(`ampi: ampi app could not start: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  /** Stop every worker, end the in-memory session and remove the app's entry. */
  const shutdown = async () => {
    await Promise.all([...workers].map((worker) => worker.stop()));
    await runtime.dispose();
    rmSync(path.join(registryDir, `${pid}.json`), { force: true });
  };

  if (port === undefined) {
    /** @type {string[]} */
    const errors = (runtime.diagnostics ?? []).filter((/** @type {any} */ d) => d.type === "error").map((/** @type {any} */ d) => d.message);
    err(`${["ampi: ampi app needs an ampi whose web GUI serves the app; update @skippermissions/ampi.", ...errors].join(" ")}\n`);
    await shutdown();
    return 1;
  }

  const url = `http://127.0.0.1:${port}/?t=${token}`;
  out(`ampi app: ${url}\n`);
  out("Ctrl+C stops ampi app and every session it runs.\n");
  if (options.open && !(await openUrl(url).catch(() => false))) out("No browser could be started; open the link above.\n");

  await options.stopped;
  await shutdown();
  return 0;
}
