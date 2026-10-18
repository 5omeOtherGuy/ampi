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
 *   once instead of printing a link;
 * - ampi-core's live registry records the session as `app-session` with the
 *   host's pid as `ownerPid`.
 */

// globalThis-anchored so every cache-isolated copy of ampi's modules in the
// process reads the record the host wrote.
export const MMR_GUI_HOST_GLOBAL_KEY = "__pi_ampi_gui_host_v1__";

/** A process that runs one session for `ampi app`. */
export interface MmrGuiSessionHost {
  role: "session";
  /** The web GUI's access token, chosen by `ampi app`. */
  token: string;
  /** The pid of the `ampi app` process that started this one. */
  ownerPid: number;
  /** Called once, when the GUI server listens. */
  ready(info: { port: number }): void;
}

export type MmrGuiHost = MmrGuiSessionHost;

const globalStore = globalThis as typeof globalThis & { [MMR_GUI_HOST_GLOBAL_KEY]?: unknown };

/** The registered host, or `undefined` when there is none or the record is malformed. */
export function getMmrGuiHost(): MmrGuiHost | undefined {
  const host = globalStore[MMR_GUI_HOST_GLOBAL_KEY];
  if (typeof host !== "object" || host === null) return undefined;
  const { role, token, ownerPid, ready } = host as Record<string, unknown>;
  if (role !== "session" || typeof token !== "string" || token === "" || typeof ready !== "function") return undefined;
  if (!Number.isSafeInteger(ownerPid) || (ownerPid as number) <= 0) return undefined;
  return host as MmrGuiHost;
}
