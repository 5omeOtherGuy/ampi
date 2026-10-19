/**
 * The GUI host seam: how a process that runs ampi without a terminal tells
 * ampi's extensions that it hosts the session for a web GUI.
 *
 * `ampi app` runs every session it serves in a worker process of its own
 * (`ampi app --worker`), because ampi keeps per-process state on
 * `globalThis` and one process must never run two ampi sessions. Before the
 * worker creates its Pi session, it puts a host record on `globalThis`
 * under {@link MMR_GUI_HOST_GLOBAL_KEY}. The `ampi` command is plain
 * JavaScript and cannot import this module, so it writes the record itself
 * (`packages/ampi-cli/src/app-worker.js`); a test checks that both sides use
 * the same key and shape.
 *
 * With a session host registered:
 * - ampi-gui serves the session in Pi's `rpc` mode too, with the host's
 *   token, whatever `ampiGui.enabled` says, and calls `ready` with its port
 *   once instead of printing a link, and sets the record's `dialog` and
 *   `notice`, through which the worker's `ctx.ui` asks the page;
 * - ampi-core's live registry records the session as `app-session` with the
 *   host's pid as `ownerPid`.
 *
 * `ampi app` itself runs an in-memory session (never saved) with a `hub`
 * record, which adds `startSession`: with it, ampi-gui serves the app's page
 * (every session on the machine) instead of one session's, and the live
 * registry records the process as `app` although it has no session file.
 */

// globalThis-anchored so every cache-isolated copy of ampi's modules in the
// process reads the record the host wrote.
export const MMR_GUI_HOST_GLOBAL_KEY = "__pi_ampi_gui_host_v1__";

/** A question an extension asks through `ctx.ui` in a hosted session. */
export interface MmrGuiDialogRequest {
  kind: "select" | "confirm" | "input" | "editor";
  title: string;
  /** confirm's message. */
  message?: string;
  /** select's choices. */
  options?: string[];
  /** input's placeholder. */
  placeholder?: string;
  /** editor's prefilled text. */
  initial?: string;
}

/** Pi's dialog options, passed on as the extension gave them. */
export interface MmrGuiDialogOptions {
  timeout?: number;
  signal?: AbortSignal;
}

/** The page's answer: a choice or text (`true`/`false` for confirm), or a cancel. */
export type MmrGuiDialogAnswer = { value: string | boolean } | { cancelled: true };

/** A process that runs one session for `ampi app`. */
export interface MmrGuiSessionHost {
  role: "session";
  /** The web GUI's access token, chosen by `ampi app`. */
  token: string;
  /** The pid of the `ampi app` process that started this one. */
  ownerPid: number;
  /** Called once, when the GUI server listens. */
  ready(info: { port: number }): void;
  /**
   * Set by ampi-gui at `session_start`: the session's `ctx.ui` dialogs
   * (select, confirm, input, editor) are asked on the page through it.
   * Until it is set, the worker answers every dialog as cancelled.
   */
  dialog?: (request: MmrGuiDialogRequest, options: MmrGuiDialogOptions) => Promise<MmrGuiDialogAnswer>;
  /** Set by ampi-gui at `session_start`: `ctx.ui.notify` shows a toast on the page through it. */
  notice?: (message: string, level: "info" | "warning" | "error") => void;
}

/**
 * What `startSession` opens: a saved session file, or a new session in a
 * directory, optionally in an ampi mode (a key `--ampi-mode` takes), which
 * the worker applies before the first message as `ampi -m` does.
 */
export type MmrGuiHubStartRequest = { path: string } | { cwd: string; mode?: string };

/** A session the app started in a worker process; its GUI listens on `127.0.0.1:<port>` with `token`. */
export interface MmrGuiHubSession {
  pid: number;
  port: number;
  token: string;
  sessionId: string;
  sessionPath: string | null;
  /** Ask the worker to end the session; resolves once the process has exited. */
  stop(): Promise<void>;
  /** Called once when the worker process exits, for whatever reason. */
  onExit(listener: () => void): void;
  /** Called when the agent starts working (`busy`) or settles (`idle`). */
  onActivity(listener: (state: "busy" | "idle") => void): void;
}

/** The `ampi app` process: it serves every session from one page and starts workers for them. */
export interface MmrGuiHubHost {
  role: "hub";
  /** The app page's access token. */
  token: string;
  /** The `ampi app` process itself. */
  ownerPid: number;
  /** Called once, when the app's server listens. */
  ready(info: { port: number }): void;
  /**
   * Start a worker for a session. Rejects when it cannot; an error whose
   * `holder` is `{ kind, pid }` means another live process has the file open.
   */
  startSession(request: MmrGuiHubStartRequest): Promise<MmrGuiHubSession>;
}

export type MmrGuiHost = MmrGuiSessionHost | MmrGuiHubHost;

const globalStore = globalThis as typeof globalThis & { [MMR_GUI_HOST_GLOBAL_KEY]?: unknown };

/** The registered host, or `undefined` when there is none or the record is malformed. */
export function getMmrGuiHost(): MmrGuiHost | undefined {
  const host = globalStore[MMR_GUI_HOST_GLOBAL_KEY];
  if (typeof host !== "object" || host === null) return undefined;
  const { role, token, ownerPid, ready } = host as Record<string, unknown>;
  if (role !== "session" && role !== "hub") return undefined;
  if (typeof token !== "string" || token === "" || typeof ready !== "function") return undefined;
  if (!Number.isSafeInteger(ownerPid) || (ownerPid as number) <= 0) return undefined;
  if (role === "hub" && typeof (host as Record<string, unknown>).startSession !== "function") return undefined;
  return host as MmrGuiHost;
}
