import { type ClientRequest, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir, hostname } from "node:os";
import type { MmrGuiHubSession, MmrGuiHubStartRequest } from "../ampi-core/gui-host.js";
import { isMmrImportedSession, MMR_IMPORTED_SESSION_NOTICE } from "../ampi-core/imported-session.js";
import {
  findMmrLiveOwner,
  type MmrLiveEntry,
  type MmrLiveKind,
  type MmrLiveRegistryOptions,
  readMmrLiveEntries,
  readMmrLiveToken,
} from "../ampi-core/live-registry.js";
import { getMmrThreadIndex, type MmrThreadIndex } from "../ampi-core/thread-index.js";
import { MMR_GUI_SESSION_ACTIONS, type MmrGuiCommands, type MmrGuiExporter, postToMmrGui } from "./commands.js";
import type { MmrGuiModes } from "./modes.js";
import {
  createMmrGuiWorktree,
  listMmrGuiDirectories,
  type MmrGuiExecFile,
  type MmrGuiPathKind,
  mmrGuiPathKind,
  parseMmrGuiNewThread,
} from "./new-thread.js";
import {
  formatMmrGuiEvent,
  isMmrGuiSessionId,
  MMR_GUI_LOOPBACK,
  MMR_GUI_SECURITY_HEADERS,
  type MmrGuiRequest,
  type MmrGuiServer,
  mmrGuiCookieName,
  parseMmrGuiJson,
  readMmrGuiBody,
  send,
  sendJson,
  sendMmrGuiActivity,
  sendMmrGuiExport,
  startMmrGuiHttpServer,
  viewMmrGuiSession,
} from "./server.js";
import type { MmrGuiRowHost, MmrGuiSessions } from "./sessions.js";

/**
 * `ampi app`'s server, the hub: one page for every Pi session on the
 * machine. It runs in `ampi app`'s own in-memory session and shares the
 * session server's request policy (`startMmrGuiHttpServer`): loopback only,
 * the Host and Origin checks, the token cookie, no CORS, its client files.
 *
 * | Route | Answer |
 * | --- | --- |
 * | `GET /`, `GET /new`, `GET /feed`, `GET /s/<id>` | the page; `/` and `/new` show the new-thread composer |
 * | `GET /api/app` | `{ app: true, hostname }`; a session server answers 404, which is how the page tells the two apart |
 * | `GET /api/events` | an event stream with `sessions` (no `id`, data `{}`) each time a worker starts or stops, so the page reads the list again |
 * | `GET /api/sessions`, `/api/sessions/<id>` | the session list, each row with `host`, and the read-only view |
 * | `GET /api/export` | as on a session server, for any session |
 * | `GET /api/feed`, `GET /api/search` | Activity and Search Threads, as on a session server, over the hub's rows |
 * | `GET /api/modes` | the mode picker's modes and models for a thread not started yet, with no lock or speed (`modes.ts`) |
 * | `GET /api/directories?q=` | the new-thread composer's directories (`new-thread.ts`) |
 * | `POST /api/threads` | `{ prompt, cwd, mode?, labels?, worktree? }`: with `worktree: true`, first creates a Git worktree of `cwd`'s checkout and uses it as `cwd` (`createMmrGuiWorktree`); starts a worker for a new session in `cwd` (in `mode`), records the labels in the thread index, sends the prompt as the first message and answers `{ ok, sessionId, worktree? }` |
 * | `POST /api/<action>` | the More Actions (`MMR_GUI_SESSION_ACTIONS`) as on a session server, for any session, except: |
 * | `POST /api/rename` | forwarded to the server that runs the session live (a worker or a terminal's GUI); 409 for another holder; a session nothing runs is renamed in its file |
 * | `POST /api/delete` | 409 for a session a worker runs or is starting; otherwise as on a session server |
 * | `/s/<id>/api/<rest>` | the session's own routes; see below |
 *
 * A session is in one of four states:
 * - **hosted**: a worker this hub started runs it (`MmrGuiHubSession`).
 *   Every request is forwarded to the worker's own GUI server, event
 *   streams included, with the worker's Host, token cookie and, for a POST,
 *   Origin; only `Content-Type`, `Accept` and `Last-Event-ID` are passed on,
 *   and only `Content-Type` comes back, under the hub's security headers.
 *   When the worker has gone, 502.
 * - **terminal**: a terminal session whose GUI serves it has the file open.
 *   Its live entry names the GUI's port, and its token is in the token file
 *   next to the entry (read only when it matches the entry's hash). Every
 *   request is forwarded to that server as to a worker. When it no longer
 *   answers, 502, and the hub reads the registry again and tells the pages.
 * - **elsewhere**: another live process has its file open (a terminal
 *   without the GUI or without a usable token file, a print or RPC run,
 *   another app's worker). `transcript` and `session` come from the file;
 *   `events`, `modes` and every POST answer 409 with the holder and, when
 *   known, whether it serves a GUI (`gui`).
 * - **not running**: the same from the file, `events` and `modes` answer 409, and
 *   `POST send` starts a worker (one per session however many sends race),
 *   waits for it and forwards the message. Other POSTs answer 409. A send
 *   waits at most {@link MMR_GUI_HUB_START_TIMEOUT_MS} and then answers 504
 *   without sending; the start goes on, and once the worker is ready the
 *   session is hosted, so sending again reaches it.
 * - **imported**: `ampi threads import` wrote it (`isMmrImportedSession`),
 *   so it is read-only wherever it is open: as elsewhere, from the file,
 *   with 409 for `events`, `modes` and every POST, and no worker is started.
 *
 * A new thread (`POST /api/threads`) is hosted from the start: its worker
 * creates the session file and is its only writer, so its routes are
 * forwarded before the catalogue lists it. Pi saves the file only with the
 * first message, so the pages are told to read the list again when its first
 * turn starts and when it settles. The hub writes only the labels,
 * to the thread index, and, for New Worktree, runs `git worktree add` before
 * the start: no worker starts when it fails, and the worktree stays when
 * the start fails after it. When the worker does not take the first message, the
 * hub stops it and answers that refusal; a start that outlasts
 * {@link MMR_GUI_HUB_START_TIMEOUT_MS} answers 504 and its worker is
 * stopped once it is ready.
 *
 * One writer per session file: the hub never starts a worker for a file
 * another live process names in the live registry (it checks just before
 * starting one, and the worker checks again). Every
 * {@link MMR_GUI_HUB_CHECK_MS} it reads the registry again: when another
 * process opens a file one of its workers runs, it stops an idle worker and
 * tells the page (`session` event) or, while the agent works, warns
 * (`warning` event), on the session's event streams. A worker idle for
 * {@link MMR_GUI_HUB_IDLE_MS} with no event stream open is stopped too.
 */

/** How often the hub reads the live registry again. */
export const MMR_GUI_HUB_CHECK_MS = 2_000;
/** A worker idle this long, with no event stream open, is stopped. */
export const MMR_GUI_HUB_IDLE_MS = 15 * 60_000;
/** How long a send waits for a worker to start before it answers 504. */
export const MMR_GUI_HUB_START_TIMEOUT_MS = 30_000;
/** Interval of the keep-alive comments on the pages' event streams. */
const MMR_GUI_HUB_HEARTBEAT_MS = 25_000;

/** Request headers the hub passes to a worker; everything else is set by the hub or dropped. */
const FORWARDED_HEADERS = ["content-type", "accept", "last-event-id"] as const;

export interface MmrGuiHubOptions {
  token: string;
  clientDir: string;
  /** Starts a worker for a saved session (the hub host's `startSession`). */
  startSession(request: MmrGuiHubStartRequest): Promise<MmrGuiHubSession>;
  /** The session list (rows with `host`), its read-only views, the catalogue, the saved entries and the rows Activity, search and the directory list read. */
  sessions: Pick<MmrGuiSessions, "list" | "view" | "find" | "read" | "searchable" | "invalidate">;
  /** The session server's commands; the hub serves the More Actions (`MMR_GUI_SESSION_ACTIONS`) from them. */
  commands: MmrGuiCommands;
  /** `GET /api/export`, as on a session server. */
  exportSession: MmrGuiExporter;
  /** `GET /api/modes`: the modes and models for a new thread (`describeMmrGuiModes` with `live: false`); `current` is the mode it starts in by default. */
  modes(): MmrGuiModes;
  /** Where a new thread's labels go; defaults to ampi-core's seam. */
  threadIndex?: () => MmrThreadIndex | undefined;
  /** `GET /api/app`'s `hostname`, the executor the composer names; defaults to `os.hostname()`. */
  hostname?: string;
  /** The home directory `~` names in a typed path; defaults to `os.homedir()`. */
  home?: string;
  /** Whether a path is a directory; defaults to `fs.stat`. */
  pathKind?: (file: string) => Promise<MmrGuiPathKind>;
  /** Runs `git` for New Worktree; defaults to `child_process.execFile`. */
  execFile?: MmrGuiExecFile;
  /** A new worktree's four hex characters; defaults to random ones. */
  worktreeSuffix?: () => string;
  /** Where the live registry is and how to probe its processes. */
  registry?: MmrLiveRegistryOptions;
  /** The hub's own process; its entry names no file. Defaults to this process. */
  pid?: number;
  /** Epoch milliseconds; defaults to `Date.now`. */
  now?: () => number;
  setTimer?: (callback: () => unknown, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Port to listen on; 0 (the default) picks a free one. */
  port?: number;
}

/**
 * The rows' `host` field, by session file, from the live registry. Of two
 * processes with the same file open, the first entry names the host, as
 * `findMmrLiveOwner` picks the holder, so a page that follows the row's
 * host sees the process the hub answers with.
 */
export function mmrGuiRowHosts(entries: readonly MmrLiveEntry[]): Map<string, MmrGuiRowHost> {
  const hosts = new Map<string, MmrGuiRowHost>();
  for (const entry of entries) {
    if (entry.sessionPath === null || hosts.has(entry.sessionPath)) continue;
    hosts.set(entry.sessionPath, { kind: entry.kind, pid: entry.pid, gui: entry.gui !== null, phase: entry.status?.phase ?? null });
  }
  return hosts;
}

interface ProxiedStream {
  end(): void;
  write(text: string): void;
}

/** Where a live session's requests go: a GUI server on loopback with its token, and the hub's worker when it is one. */
interface Upstream {
  port: number;
  token: string;
  worker?: HubWorker;
}

interface HubWorker {
  id: string;
  session: MmrGuiHubSession;
  busy: boolean;
  lastUse: number;
  streams: Set<ProxiedStream>;
  /** Holders already warned about, so a busy worker warns once per process. */
  warned: Set<number>;
}

type SessionState =
  | { state: "hosted"; worker: HubWorker }
  | { state: "terminal"; upstream: Upstream }
  | { state: "elsewhere"; kind: MmrLiveKind; pid: number; gui?: boolean }
  | { state: "not-running" }
  | { state: "imported" };

/** A failed start, answered with this status and body. */
class StartError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.error));
    this.status = status;
    this.body = body;
  }
}

type Unhosted = Exclude<SessionState, { state: "hosted" | "terminal" }>;

function workerUpstream(worker: HubWorker): Upstream {
  return { port: worker.session.port, token: worker.session.token, worker };
}

/** `gui` is set only when the holder's live entry was read. */
function elsewhere(kind: MmrLiveKind, pid: number, gui?: boolean) {
  return { state: "elsewhere", kind, pid, ...(gui === undefined ? {} : { gui }), error: `Process ${pid} (${kind}) has this session open; continue it there.` };
}

/** What a request that cannot act now answers, by state. */
function describe(state: Unhosted): Record<string, unknown> {
  if (state.state === "elsewhere") return elsewhere(state.kind, state.pid, state.gui);
  if (state.state === "imported") return { state: "imported", error: MMR_IMPORTED_SESSION_NOTICE };
  return { state: "not-running", error: "Nothing runs this session now. Sending a message starts it." };
}

function isHolder(value: unknown): value is { kind: MmrLiveKind; pid: number } {
  if (typeof value !== "object" || value === null) return false;
  const { kind, pid } = value as Record<string, unknown>;
  return typeof kind === "string" && Number.isSafeInteger(pid);
}

function record(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export async function startMmrGuiHub(options: MmrGuiHubOptions): Promise<MmrGuiServer> {
  const { sessions } = options;
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now;
  const setTimer =
    options.setTimer ??
    ((callback: () => unknown, ms: number) => {
      const handle = setTimeout(callback, ms);
      handle.unref();
      return handle;
    });
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const registry = options.registry ?? {};
  const workers = new Map<string, HubWorker>();
  const starting = new Map<string, Promise<HubWorker>>();
  /** The pages' `GET /api/events` streams. */
  const pages = new Set<ServerResponse>();

  /** Tell every page that a session started or stopped here, so it reads the list again. */
  function announce(): void {
    for (const res of pages) res.write(formatMmrGuiEvent({ event: "sessions", data: {} }));
  }

  function serveHubEvents({ req, res, track }: MmrGuiRequest): void {
    res.writeHead(200, { ...MMR_GUI_SECURITY_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive" });
    res.write("retry: 2000\n\n");
    pages.add(res);
    track(res);
    const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), MMR_GUI_HUB_HEARTBEAT_MS);
    heartbeat.unref();
    const done = () => {
      clearInterval(heartbeat);
      pages.delete(res);
    };
    req.on("close", done);
    res.on("close", done);
  }

  /** The live entry of another process that has `file` open; this hub's own workers are found by `workers`. */
  const ownerOf = (file: string, exceptPid: number) => findMmrLiveOwner(file, { ...registry, exceptPid });

  /** Stop routing to a worker and end its event streams; the caller decides whether to stop the process. */
  function retire(worker: HubWorker): void {
    const routed = workers.get(worker.id) === worker;
    if (routed) workers.delete(worker.id);
    for (const stream of worker.streams) stream.end();
    worker.streams.clear();
    if (routed) announce();
  }

  function inject(worker: HubWorker, event: string, data: Record<string, unknown>): void {
    for (const stream of worker.streams) stream.write(formatMmrGuiEvent({ event, data }));
  }

  async function startWorker(file: string, id: string): Promise<HubWorker> {
    // One writer per session file: never start a worker for a file another live process has open.
    const owner = await ownerOf(file, pid);
    if (owner) throw new StartError(409, elsewhere(owner.kind, owner.pid, owner.gui !== null));
    let session: MmrGuiHubSession;
    try {
      session = await options.startSession({ path: file });
    } catch (error) {
      const holder = (error as { holder?: unknown }).holder;
      if (isHolder(holder)) throw new StartError(409, elsewhere(holder.kind, holder.pid));
      throw new StartError(502, { error: `Could not start the session: ${error instanceof Error ? error.message : String(error)}` });
    }
    return adopt(session, id);
  }

  /** Route session `id` to a worker that is ready, and follow its activity and exit. */
  function adopt(session: MmrGuiHubSession, id: string): HubWorker {
    const worker: HubWorker = { id, session, busy: false, lastUse: now(), streams: new Set(), warned: new Set() };
    session.onActivity((state) => {
      worker.busy = state === "busy";
      worker.lastUse = now();
    });
    session.onExit(() => retire(worker));
    workers.set(id, worker);
    announce();
    return worker;
  }

  /** The worker for a session, started once however many requests ask at the same time. */
  function ensureWorker(file: string, id: string): Promise<HubWorker> {
    const running = workers.get(id);
    if (running) return Promise.resolve(running);
    let pending = starting.get(id);
    if (!pending) {
      pending = startWorker(file, id).finally(() => starting.delete(id));
      starting.set(id, pending);
    }
    return pending;
  }

  /** The session's worker, once it is ready or {@link MMR_GUI_HUB_START_TIMEOUT_MS} have passed (504). */
  async function waitForWorker(file: string, id: string): Promise<HubWorker> {
    let timer: unknown;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimer(
        () => reject(new StartError(504, { error: "The session is still starting. Send the message again in a moment." })),
        MMR_GUI_HUB_START_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([ensureWorker(file, id), timeout]);
    } finally {
      clearTimer(timer);
    }
  }

  async function stateOf(file: string, id: string): Promise<SessionState> {
    const worker = workers.get(id);
    if (worker) return { state: "hosted", worker };
    // A worker that is starting may have its entry already; it is this hub's, not another process's.
    if (starting.has(id)) return { state: "not-running" };
    const owner = await ownerOf(file, pid);
    if (!owner) return { state: "not-running" };
    // A terminal's GUI is reached with the token it left next to its entry; execute runs and other apps' workers stay read-only.
    const token = owner.kind === "tui" && owner.gui ? await readMmrLiveToken(owner, registry) : undefined;
    if (owner.gui && token !== undefined) return { state: "terminal", upstream: { port: owner.gui.port, token } };
    return { state: "elsewhere", kind: owner.kind, pid: owner.pid, gui: owner.gui !== null };
  }

  /** Where a live session's requests go: the worker's server, or the terminal's. */
  function upstreamOf(state: Extract<SessionState, { state: "hosted" | "terminal" }>): Upstream {
    return state.state === "hosted" ? workerUpstream(state.worker) : state.upstream;
  }

  /** A terminal's GUI stopped answering: read the registry again (removing a dead process's files) and let the pages reload the list. */
  function terminalGone(): void {
    void readMmrLiveEntries(registry)
      .catch(() => [])
      .then(() => announce());
  }

  /** Forward a request to a GUI server as `/api/<rest>`, with that server's Host, cookie and Origin. */
  function proxy(upstreamTarget: Upstream, request: MmrGuiRequest, rest: string, body?: Buffer): Promise<void> {
    const { req, res, method, url } = request;
    const { port, token, worker } = upstreamTarget;
    const headers: Record<string, string> = {
      Host: `${MMR_GUI_LOOPBACK}:${port}`,
      Cookie: `${mmrGuiCookieName(port)}=${token}`,
    };
    for (const name of FORWARDED_HEADERS) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    if (body !== undefined) {
      // The browser's Origin was checked against the hub's own; the worker checks its own.
      headers.Origin = `http://${MMR_GUI_LOOPBACK}:${port}`;
      headers["Content-Length"] = String(body.length);
    }
    if (worker) worker.lastUse = now();
    return new Promise((resolve) => {
      const upstream = httpRequest(
        { host: MMR_GUI_LOOPBACK, port, method, path: `/api/${rest}${url.search}`, headers, setHost: false, agent: false },
        (answer) => {
          const type = answer.headers["content-type"];
          // Only the content type comes back: no Set-Cookie or other header of the worker's.
          res.writeHead(answer.statusCode ?? 502, { ...MMR_GUI_SECURITY_HEADERS, ...(type ? { "Content-Type": type } : {}) });
          if (type?.startsWith("text/event-stream")) pipeEvents(worker, request, upstream, answer);
          else {
            answer.pipe(res);
            answer.on("end", () => {
              if (worker) worker.lastUse = now();
            });
          }
          answer.on("close", () => resolve());
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent) sendJson(res, 502, { state: "gone", error: "The process that ran this session has stopped. Reload to continue." });
        else res.end();
        if (!worker) terminalGone();
        resolve();
      });
      upstream.end(body);
    });
  }

  /** Pass an event stream on whole events at a time, so the hub can add its own between them (a worker's only). */
  function pipeEvents(worker: HubWorker | undefined, request: MmrGuiRequest, upstream: ClientRequest, answer: IncomingMessage): void {
    const { res } = request;
    let pending = "";
    const stream: ProxiedStream = {
      write: (text) => res.write(text),
      end: () => {
        res.end();
        upstream.destroy();
      },
    };
    worker?.streams.add(stream);
    request.track(res);
    answer.setEncoding("utf8");
    answer.on("data", (chunk: string) => {
      pending += chunk;
      const end = pending.lastIndexOf("\n\n");
      if (end < 0) return;
      res.write(pending.slice(0, end + 2));
      pending = pending.slice(end + 2);
    });
    answer.on("end", () => res.end());
    res.on("close", () => {
      if (worker?.streams.delete(stream)) worker.lastUse = now();
      upstream.destroy();
    });
  }

  /** Read a POST's JSON body, answering 415 or 400 itself; `undefined` when it did. */
  async function readPost(request: MmrGuiRequest): Promise<{ raw: Buffer; json: unknown } | undefined> {
    const { req, res } = request;
    if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) {
      req.resume();
      send(res, 415, "Send JSON");
      return undefined;
    }
    const raw = await readMmrGuiBody(req);
    const json = parseMmrGuiJson(raw);
    if (raw === undefined || json === undefined) {
      sendJson(res, 400, { error: "The request body is not JSON or is too large." });
      return undefined;
    }
    return { raw, json };
  }

  async function sessionRoute(request: MmrGuiRequest, id: string, rest: string): Promise<void> {
    const { req, res, method } = request;
    // A worker runs it: a new thread is hosted before the catalogue lists it.
    const hosted = workers.get(id);
    if (hosted) {
      const post = method === "POST" ? await readPost(request) : undefined;
      if (method === "POST" && !post) return;
      return proxy(workerUpstream(hosted), request, rest, post?.raw);
    }
    const info = await sessions.find(id);
    if (!info) {
      req.resume();
      return sendJson(res, 404, { error: "No such session." });
    }
    const post = method === "POST" ? await readPost(request) : undefined;
    if (method === "POST" && !post) return;

    let state = await stateOf(info.path, id);
    if (state.state === "hosted" || state.state === "terminal") return proxy(upstreamOf(state), request, rest, post?.raw);
    // ampi-core refuses every prompt in an imported session, so it never gets a worker.
    if (isMmrImportedSession((await sessions.read(info)).branch)) state = { state: "imported" };
    if (post) {
      if (state.state !== "not-running" || rest !== "send") return sendJson(res, 409, describe(state));
      const { text } = record(post.json);
      if (typeof text !== "string" || text.trim() === "") return sendJson(res, 400, { error: "Type a message to send." });
      let worker: HubWorker;
      try {
        worker = await waitForWorker(info.path, id);
      } catch (error) {
        if (error instanceof StartError) return sendJson(res, error.status, error.body);
        throw error;
      }
      return proxy(workerUpstream(worker), request, rest, post.raw);
    }
    // Only a live session has a mode to change.
    if (rest === "events" || rest === "modes") return sendJson(res, 409, describe(state));
    if (rest !== "transcript" && rest !== "session") return send(res, 404, "Not found");
    const view = await viewMmrGuiSession(sessions, id);
    if (!view) return sendJson(res, 404, { error: "No such session." });
    if (state.state !== "imported") {
      // Read again: a worker may have started while the file was read.
      state = await stateOf(info.path, id);
      if (state.state === "hosted" || state.state === "terminal") return proxy(upstreamOf(state), request, rest);
    }
    return sendJson(res, 200, rest === "session" ? { ...view.session, state } : { ...view, state });
  }

  /** `GET /api/directories?q=`: the composer's directory picker. */
  async function directories({ res, url }: MmrGuiRequest): Promise<void> {
    const [{ rows }, live] = await Promise.all([sessions.searchable(), readMmrLiveEntries(registry).catch(() => [])]);
    const answer = await listMmrGuiDirectories({
      rows: rows.map((entry) => entry.row),
      live,
      query: url.searchParams.get("q") ?? "",
      home: options.home ?? homedir(),
      pathKind: options.pathKind,
    });
    sendJson(res, 200, answer);
  }

  /** `POST /api/threads`: start a worker for a new session, label it, and send its first message. */
  async function createThread(request: MmrGuiRequest): Promise<void> {
    const { res } = request;
    const post = await readPost(request);
    if (!post) return;
    const checked = await parseMmrGuiNewThread(post.json, { modes: options.modes(), pathKind: options.pathKind ?? mmrGuiPathKind });
    if (!checked.ok) return sendJson(res, checked.status, checked.body);
    const { prompt, mode, labels } = checked.value;
    const index = (options.threadIndex ?? getMmrThreadIndex)();
    if (labels.length > 0 && !index) return sendJson(res, 409, { error: "Labels need the ampi-threads extension." });
    let cwd = checked.value.cwd;
    let worktree: { path: string; branch: string } | undefined;
    if (checked.value.worktree) {
      const made = await createMmrGuiWorktree(cwd, prompt, { run: options.execFile, suffix: options.worktreeSuffix?.() });
      if (!made.ok) return sendJson(res, made.status, made.body);
      worktree = { path: made.path, branch: made.branch };
      cwd = made.path;
    }

    let timer: unknown;
    let timedOut = false;
    const start = options.startSession(mode === null ? { cwd } : { cwd, mode });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimer(() => {
        timedOut = true;
        reject(new StartError(504, { error: "The new thread did not start in time. Try again in a moment." }));
      }, MMR_GUI_HUB_START_TIMEOUT_MS);
    });
    let session: MmrGuiHubSession;
    try {
      session = await Promise.race([start, timeout]);
    } catch (error) {
      // A start that comes too late is stopped: nobody knows its id.
      if (timedOut) void start.then((late) => late.stop()).catch(() => {});
      if (error instanceof StartError) return sendJson(res, error.status, error.body);
      return sendJson(res, 502, { error: `Could not start the thread: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      clearTimer(timer);
    }
    const worker = adopt(session, session.sessionId);
    // Pi saves the file with the first message, after adopt() told the pages: tell them again
    // when the first turn starts and when it settles, so a thread nobody opened shows in the list.
    let relisted = 0;
    session.onActivity(() => {
      if (relisted >= 2 || workers.get(worker.id) !== worker) return;
      relisted++;
      sessions.invalidate();
      announce();
    });
    const sent = await postToMmrGui(session.port, session.token, "send", { text: prompt });
    if (sent.status !== 200) {
      // Nothing was saved without a message: the empty session goes with its worker.
      retire(worker);
      void session.stop().catch(() => {});
      return sendJson(res, sent.status, { error: String(sent.body.error ?? "The new thread did not take its first message.") });
    }
    sessions.invalidate();
    let warning: string | undefined;
    if (labels.length > 0) {
      try {
        await index?.update(session.sessionId, { labels });
      } catch (error) {
        warning = `The thread started, but its labels were not saved: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    sendJson(res, 200, { ok: true, sessionId: session.sessionId, ...(worktree ? { worktree } : {}), ...(warning ? { warning } : {}) });
  }

  async function hubCommand(request: MmrGuiRequest): Promise<void> {
    const { req, res, rawPath } = request;
    if (rawPath === "/api/threads") return createThread(request);
    const name = rawPath.startsWith("/api/") ? rawPath.slice("/api/".length) : "";
    if (!MMR_GUI_SESSION_ACTIONS.includes(name)) {
      req.resume();
      return send(res, 404, "Not found");
    }
    const post = await readPost(request);
    if (!post) return;
    const run = async () => {
      const command = Object.hasOwn(options.commands, name) ? options.commands[name] : undefined;
      if (!command) return send(res, 404, "Not found");
      const result = await command(post.json);
      sendJson(res, result.status, result.body);
    };
    if (name !== "rename" && name !== "delete") return run();
    const { sessionId } = record(post.json);
    if (typeof sessionId !== "string" || sessionId === "") return sendJson(res, 400, { error: "Name the session by its id." });
    const info = await sessions.find(sessionId);
    if (!info) return sendJson(res, 404, { error: "No such session." });
    // A worker that is starting has no live entry yet: it already counts as the session's writer.
    if (starting.has(sessionId)) return sendJson(res, 409, { error: "The session is starting here; try again in a moment." });
    const state = await stateOf(info.path, sessionId);
    if (name === "delete") {
      if (state.state === "hosted") return sendJson(res, 409, { error: "ampi app runs this session; it cannot delete it while it runs." });
      // Every other holder has a live entry, which the command checks.
      return run();
    }
    // The process that runs the session renames it; one nobody runs is renamed in its file.
    if (state.state === "hosted" || state.state === "terminal") return proxy(upstreamOf(state), request, "rename", post.raw);
    if (state.state === "elsewhere" && !state.gui) return sendJson(res, 409, { ...describe(state), error: `Process ${state.pid} (${state.kind}) has this session open; rename it there.` });
    // Another app's worker has a web GUI: the command forwards the rename to it.
    return run();
  }

  async function route(request: MmrGuiRequest): Promise<void> {
    const { req, res, method, rawPath } = request;
    const scoped = /^\/s\/([^/]+)(\/.*)?$/.exec(rawPath);
    if (scoped) {
      const id = scoped[1] as string;
      const rest = scoped[2] ?? "";
      if (!isMmrGuiSessionId(id)) {
        req.resume();
        return sendJson(res, 404, { error: "No such session." });
      }
      if (rest === "" && method !== "POST") return request.servePage();
      if (rest.startsWith("/api/") && rest.length > "/api/".length) return sessionRoute(request, id, rest.slice("/api/".length));
      req.resume();
      return send(res, 404, "Not found");
    }
    if (method === "POST") return hubCommand(request);
    if (rawPath === "/new") return request.servePage();
    if (rawPath === "/api/app") return sendJson(res, 200, { app: true, hostname: options.hostname ?? hostname() });
    if (rawPath === "/api/directories") return directories(request);
    if (rawPath === "/api/events") return serveHubEvents(request);
    if (rawPath === "/api/sessions") return sendJson(res, 200, await sessions.list());
    if (rawPath.startsWith("/api/sessions/")) {
      const view = await viewMmrGuiSession(sessions, rawPath.slice("/api/sessions/".length));
      return view ? sendJson(res, 200, view) : sendJson(res, 404, { error: "No such session." });
    }
    if (rawPath === "/api/export") return sendMmrGuiExport(res, request.url, options.exportSession);
    if (rawPath === "/api/feed" || rawPath === "/api/search") return sendMmrGuiActivity(res, rawPath, request.url, sessions);
    if (rawPath === "/api/modes") return sendJson(res, 200, options.modes());
    return send(res, 404, "Not found");
  }

  /** Read the registry again: give way to another process that opened a worker's file, and stop idle workers. */
  async function check(): Promise<void> {
    for (const worker of [...workers.values()]) {
      const file = worker.session.sessionPath;
      const owner = file === null ? undefined : await ownerOf(file, worker.session.pid).catch(() => undefined);
      if (workers.get(worker.id) !== worker) continue;
      if (owner) {
        if (!worker.busy) {
          inject(worker, "session", { state: "elsewhere", kind: owner.kind, pid: owner.pid });
          retire(worker);
          void worker.session.stop().catch(() => {});
        } else if (!worker.warned.has(owner.pid)) {
          worker.warned.add(owner.pid);
          inject(worker, "warning", {
            state: "elsewhere",
            kind: owner.kind,
            pid: owner.pid,
            message: `Process ${owner.pid} (${owner.kind}) opened this session too. Two writers can lose messages; close one of them.`,
          });
        }
        continue;
      }
      if (!worker.busy && worker.streams.size === 0 && now() - worker.lastUse >= MMR_GUI_HUB_IDLE_MS) {
        retire(worker);
        void worker.session.stop().catch(() => {});
      }
    }
  }

  let closed = false;
  let timer: unknown;
  const schedule = () => {
    timer = setTimer(
      () =>
        check()
          .catch(() => {})
          .finally(() => {
            if (!closed) schedule();
          }),
      MMR_GUI_HUB_CHECK_MS,
    );
  };

  const server = await startMmrGuiHttpServer({ token: options.token, clientDir: options.clientDir, port: options.port, route });
  schedule();
  return {
    port: server.port,
    url: server.url,
    async close() {
      closed = true;
      clearTimer(timer);
      await server.close();
    },
  };
}
