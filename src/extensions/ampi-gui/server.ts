import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { buildMmrGuiFeed, parseMmrGuiFeedRequest, parseMmrGuiSearchRequest, searchMmrGuiSessions } from "./activity.js";
import type { MmrGuiBridge } from "./bridge.js";
import { isMmrGuiChangesRange, type MmrGuiChangesOptions, readMmrGuiChanges } from "./changes.js";
import type { MmrGuiCommands, MmrGuiExporter } from "./commands.js";
import { describeMmrGuiModes } from "./modes.js";
import type { MmrGuiSessions } from "./sessions.js";

/**
 * The local web GUI's HTTP server.
 *
 * Security model:
 * - It listens on 127.0.0.1 only, on a random free port.
 * - A request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>`
 *   is refused (403; 400 without a `Host`), which stops DNS rebinding. A
 *   request with an `Origin` other than the server's own is refused (403),
 *   and a POST must carry one.
 * - Every request needs the per-process token. The URL Pi prints carries it
 *   once (`/?t=<token>`); the server answers with an HttpOnly,
 *   SameSite=Strict cookie scoped to this port and redirects to `/`, so the
 *   token leaves the address bar. The token is never logged. A GET without
 *   it answers 401; a POST without it, or without the server's own
 *   `Origin`, answers 403.
 * - It sends events as `text/event-stream` and takes commands as POST JSON
 *   (`Content-Type: application/json`, at most {@link MAX_BODY_BYTES}) on
 *   `/api/<command>`; `commands.ts` handles them. It sets no CORS headers,
 *   and a strict Content-Security-Policy allows only its own scripts, styles
 *   and connections.
 * - It serves only files inside the client directory, by extension with an
 *   explicit content type.
 * - `GET /api/sessions` lists the sessions for the sidebar and
 *   `GET /api/sessions/<id>` reads one read-only; neither writes anything.
 *   `GET /api/export?sessionId=<id>&format=markdown|json` answers a
 *   session as a file to download (`Content-Disposition: attachment`).
 * - `GET /feed` is the page too, showing the Activity page;
 *   `GET /api/feed` and `GET /api/search` answer it and the Search Threads
 *   dialog (`activity.ts`), read-only.
 * - `GET /api/modes` answers the mode picker: the modes, the models and the
 *   session's mode (`modes.ts`).
 * - `GET /api/changes?sessionId=<id>&range=` answers the right pane's
 *   Changes list for the working directory of this session or a listed one
 *   (`changes.ts`), read-only.
 */

export interface MmrGuiServerOptions {
  bridge: MmrGuiBridge;
  /** Handlers of the POST routes, by the name after `/api/`. */
  commands: MmrGuiCommands;
  /** `GET /api/export`: a session as a Markdown or JSON file. */
  exportSession: MmrGuiExporter;
  /** The sidebar's session list, the read-only views of other sessions, the rows Activity and search filter, and the directories of listed sessions for the Changes list. */
  sessions: Pick<MmrGuiSessions, "list" | "view" | "searchable" | "find">;
  token: string;
  /** Directory of the static client files. */
  clientDir: string;
  /** Port to listen on; 0 (the default) picks a free one. */
  port?: number;
  /** Interval of the keep-alive comments on event streams. */
  heartbeatMs?: number;
}

export interface MmrGuiServer {
  readonly port: number;
  /** The URL to open, with the token. */
  readonly url: string;
  close(): Promise<void>;
}

export const MMR_GUI_LOOPBACK = "127.0.0.1";

/** Largest command body the server reads. */
const MAX_BODY_BYTES = 512 * 1024;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

export const MMR_GUI_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

/** Name of the token cookie: per port, because cookies ignore ports and several sessions may run. */
export function mmrGuiCookieName(port: number): string {
  return `ampi_gui_${port}`;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function sameToken(candidate: string | undefined | null, token: string): boolean {
  if (typeof candidate !== "string" || candidate === "") return false;
  return timingSafeEqual(digest(candidate), digest(token));
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const pair of header.split(";")) {
    const index = pair.indexOf("=");
    if (index < 0) continue;
    if (pair.slice(0, index).trim() === name) return pair.slice(index + 1).trim();
  }
  return undefined;
}

export function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...MMR_GUI_SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
}

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value), { "Content-Type": "application/json; charset=utf-8" });
}

/** Answer `GET /api/export?sessionId=&format=`: the file as an attachment, or the exporter's JSON error. */
export async function sendMmrGuiExport(res: ServerResponse, url: URL, exportSession: MmrGuiExporter): Promise<void> {
  const result = await exportSession(url.searchParams.get("sessionId") ?? "", url.searchParams.get("format") ?? "");
  if (!("text" in result)) return sendJson(res, result.status, result.body);
  send(res, 200, result.text, {
    "Content-Type": result.contentType,
    "Content-Disposition": `attachment; filename="${result.filename}"`,
  });
}

/**
 * Answer `GET /api/feed` (the Activity page) and `GET /api/search` (Search
 * Threads) from the listed rows: 400 with an `error` for a parameter that
 * does not parse.
 */
export async function sendMmrGuiActivity(res: ServerResponse, rawPath: "/api/feed" | "/api/search", url: URL, sessions: Pick<MmrGuiSessions, "searchable">): Promise<void> {
  if (rawPath === "/api/feed") {
    const request = parseMmrGuiFeedRequest(url.searchParams);
    if (!request.ok) return sendJson(res, 400, { error: request.error });
    const { now, home, rows } = await sessions.searchable();
    return sendJson(res, 200, buildMmrGuiFeed(rows, request.value, { now, home }));
  }
  const request = parseMmrGuiSearchRequest(url.searchParams);
  if (!request.ok) return sendJson(res, 400, { error: request.error });
  const { now, home, rows } = await sessions.searchable();
  return sendJson(res, 200, searchMmrGuiSessions(rows, request.value, { now, home }));
}

/**
 * Answer `GET /api/changes?sessionId=&range=`: the Changes list for the
 * working directory `cwdOf` names for the session (`undefined`: 404); 400
 * for a session id or range that does not parse.
 */
export async function sendMmrGuiChanges(
  res: ServerResponse,
  url: URL,
  cwdOf: (sessionId: string) => Promise<string | undefined>,
  options?: MmrGuiChangesOptions,
): Promise<void> {
  const id = url.searchParams.get("sessionId") ?? "";
  if (!isMmrGuiSessionId(id)) return sendJson(res, 400, { error: "Name the session by its id." });
  const range = url.searchParams.get("range") ?? "uncommitted";
  if (!isMmrGuiChangesRange(range)) return sendJson(res, 400, { error: 'range must be "uncommitted", "last-commit" or "branch".' });
  const cwd = await cwdOf(id);
  if (cwd === undefined) return sendJson(res, 404, { error: "No such session." });
  const result = await readMmrGuiChanges(cwd, range, options);
  sendJson(res, result.status, result.body);
}

/** One event-stream event; the hub's own events have no `id`, so they leave the replay position alone. */
export function formatMmrGuiEvent(event: { id?: number; event: string; data: unknown }): string {
  if (event.id === undefined) return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
  return `id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/** The request body, or `undefined` when it is larger than {@link MAX_BODY_BYTES} or the request fails. */
export function readMmrGuiBody(req: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // Past the limit the rest is drained, not kept, so the answer still arrives.
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on("end", () => resolve(size > MAX_BODY_BYTES ? undefined : Buffer.concat(chunks)));
    req.on("error", () => resolve(undefined));
  });
}

/** A request body as JSON (`{}` when empty), or `undefined` when it is not JSON. */
export function parseMmrGuiJson(body: Buffer | undefined): unknown {
  if (body === undefined) return undefined;
  const text = body.toString("utf8");
  try {
    return text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The file under `clientDir` for a `/client/...` path, or `undefined` when the path tries to leave it. */
function clientFile(clientDir: string, rest: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return undefined;
  }
  if (decoded === "" || decoded.includes("\0") || decoded.includes("\\") || path.isAbsolute(decoded)) return undefined;
  if (decoded.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) return undefined;
  const file = path.resolve(clientDir, decoded);
  return file.startsWith(clientDir + path.sep) ? file : undefined;
}

/** A request that passed the policy, for the routes of one kind of server. */
export interface MmrGuiRequest {
  req: IncomingMessage;
  res: ServerResponse;
  /** `GET`, `HEAD` or `POST`. */
  method: string;
  /** The path without the query string, as sent. */
  rawPath: string;
  url: URL;
  /** The server's own port. */
  port: number;
  /** Serve `index.html` from the client directory. */
  servePage(): Promise<void>;
  /** Keep an event stream open until it closes or the server closes. */
  track(res: ServerResponse): void;
}

export interface MmrGuiHttpServerOptions {
  token: string;
  /** Directory of the static client files. */
  clientDir: string;
  /** Port to listen on; 0 (the default) picks a free one. */
  port?: number;
  /**
   * Answer a request the policy let through: a POST with the server's own
   * `Origin` and the token cookie, or a GET or HEAD with the cookie that is
   * not `/`, `/feed` or a client file.
   */
  route(request: MmrGuiRequest): Promise<void>;
}

/**
 * A server with the request policy described at the top of this module, the
 * token link, `GET /` and the client files; everything else goes to `route`.
 * The session server and `ampi app`'s hub (`hub.ts`) share it.
 */
export async function startMmrGuiHttpServer(options: MmrGuiHttpServerOptions): Promise<MmrGuiServer> {
  const { token } = options;
  const clientDir = await realpath(options.clientDir);
  const streams = new Set<ServerResponse>();
  let port = 0;

  async function serveFile(res: ServerResponse, file: string | undefined): Promise<void> {
    const type = file && CONTENT_TYPES[path.extname(file)];
    if (!file || !type) return send(res, 404, "Not found");
    try {
      const real = await realpath(file);
      if (!real.startsWith(clientDir + path.sep) || !(await stat(real)).isFile()) return send(res, 404, "Not found");
      const body = await readFile(real);
      res.writeHead(200, { ...MMR_GUI_SECURITY_HEADERS, "Content-Type": type, "Content-Length": String(body.length) });
      res.end(body);
    } catch {
      send(res, 404, "Not found");
    }
  }

  function track(res: ServerResponse): void {
    streams.add(res);
    res.on("close", () => streams.delete(res));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host;
    if (!host) return send(res, 400, "Missing Host header");
    if (host !== `${MMR_GUI_LOOPBACK}:${port}` && host !== `localhost:${port}`) return send(res, 403, "Unexpected Host header");
    const origin = req.headers.origin;
    const origins = [`http://${MMR_GUI_LOOPBACK}:${port}`, `http://localhost:${port}`];
    if (origin !== undefined && !origins.includes(origin)) return send(res, 403, "Unexpected Origin header");

    const rawPath = (req.url ?? "/").split("?")[0] ?? "/";
    const url = new URL(req.url ?? "/", `http://${MMR_GUI_LOOPBACK}:${port}`);
    const method = req.method ?? "GET";

    if (method === "GET" && rawPath === "/" && url.searchParams.has("t")) {
      if (!sameToken(url.searchParams.get("t"), token)) return send(res, 401, "This link is not valid. Use the one Pi printed.");
      return send(res, 303, "", {
        Location: "/",
        "Set-Cookie": `${mmrGuiCookieName(port)}=${token}; HttpOnly; SameSite=Strict; Path=/`,
      });
    }
    if (method === "POST" && !origin) {
      req.resume();
      return send(res, 403, "Missing Origin header");
    }
    if (!sameToken(readCookie(req.headers.cookie, mmrGuiCookieName(port)), token)) {
      req.resume();
      // A command without the cookie is a cross-site attempt, not a reader who needs the link.
      return send(res, method === "POST" ? 403 : 401, "Open the link Pi printed to use this page.");
    }
    if (method !== "GET" && method !== "HEAD" && method !== "POST") {
      req.resume();
      return send(res, 405, "Method not allowed", { Allow: "GET, POST" });
    }

    const servePage = () => serveFile(res, path.join(clientDir, "index.html"));
    if (method !== "POST") {
      if (rawPath === "/" || rawPath === "/feed") return servePage();
      if (rawPath.startsWith("/client/")) {
        const file = clientFile(clientDir, rawPath.slice("/client/".length));
        if (!file) return send(res, 400, "Bad path");
        return serveFile(res, file);
      }
    }
    return options.route({ req, res, method, rawPath, url, port, servePage, track });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, "Internal error");
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, MMR_GUI_LOOPBACK, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;

  return {
    port,
    url: `http://${MMR_GUI_LOOPBACK}:${port}/?t=${token}`,
    async close() {
      for (const res of streams) res.end();
      streams.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

/** One session's server: its transcript, events and commands, and the sidebar's session list. */
export function startMmrGuiServer(options: MmrGuiServerOptions): Promise<MmrGuiServer> {
  const { bridge } = options;
  const heartbeatMs = options.heartbeatMs ?? 25_000;

  function serveEvents({ req, res, url, track }: MmrGuiRequest): void {
    res.writeHead(200, {
      ...MMR_GUI_SECURITY_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
    });
    res.write("retry: 2000\n\n");
    const raw = req.headers["last-event-id"] ?? url.searchParams.get("after");
    const after = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : bridge.lastEventId;
    const missed = bridge.eventsAfter(after);
    // Too far behind (or another server's id): the client reloads the snapshot.
    if (missed === undefined) res.write("event: reset\ndata: {}\n\n");
    else for (const event of missed) res.write(formatMmrGuiEvent(event));
    const unsubscribe = bridge.subscribe((event) => res.write(formatMmrGuiEvent(event)));
    // A page that follows the session can answer its questions (`dialogs.ts`).
    const unwatch = bridge.watch();
    const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), heartbeatMs);
    heartbeat.unref();
    track(res);
    const done = () => {
      clearInterval(heartbeat);
      unsubscribe();
      unwatch();
    };
    req.on("close", done);
    res.on("close", done);
  }

  async function route(request: MmrGuiRequest): Promise<void> {
    const { req, res, method, rawPath } = request;
    if (method === "POST") {
      const name = rawPath.startsWith("/api/") ? rawPath.slice("/api/".length) : "";
      const command = Object.hasOwn(options.commands, name) ? options.commands[name] : undefined;
      if (!command) {
        req.resume();
        return send(res, 404, "Not found");
      }
      if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) {
        req.resume();
        return send(res, 415, "Send JSON");
      }
      const body = parseMmrGuiJson(await readMmrGuiBody(req));
      if (body === undefined) return sendJson(res, 400, { error: "The request body is not JSON or is too large." });
      const result = await command(body);
      return sendJson(res, result.status, result.body);
    }
    if (rawPath === "/api/session") return sendJson(res, 200, { ...bridge.session(), status: bridge.status() });
    if (rawPath === "/api/transcript") return sendJson(res, 200, bridge.snapshot());
    if (rawPath === "/api/modes") {
      const ctx = bridge.context();
      return ctx ? sendJson(res, 200, describeMmrGuiModes(ctx)) : sendJson(res, 409, { error: "The session has ended." });
    }
    if (rawPath === "/api/events") return serveEvents(request);
    if (rawPath === "/api/sessions") return sendJson(res, 200, await options.sessions.list());
    if (rawPath.startsWith("/api/sessions/")) {
      const view = await viewMmrGuiSession(options.sessions, rawPath.slice("/api/sessions/".length));
      return view ? sendJson(res, 200, view) : sendJson(res, 404, { error: "No such session." });
    }
    if (rawPath === "/api/export") return sendMmrGuiExport(res, request.url, options.exportSession);
    if (rawPath === "/api/feed" || rawPath === "/api/search") return sendMmrGuiActivity(res, rawPath, request.url, options.sessions);
    if (rawPath === "/api/changes") return sendMmrGuiChanges(res, request.url, cwdOf);
    return send(res, 404, "Not found");
  }

  /** The working directory of this session, or of a listed one. */
  async function cwdOf(id: string): Promise<string | undefined> {
    const ctx = bridge.context();
    if (ctx && ctx.sessionManager.getSessionId() === id) return ctx.cwd;
    return (await options.sessions.find(id))?.cwd;
  }

  return startMmrGuiHttpServer({ token: options.token, clientDir: options.clientDir, port: options.port, route });
}

/** Pi's session ids are UUIDs; anything else names no session. */
export function isMmrGuiSessionId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

/** The read-only view of a session by id, or `undefined` for an id that names none. */
export async function viewMmrGuiSession(sessions: Pick<MmrGuiSessions, "view">, id: string) {
  return isMmrGuiSessionId(id) ? await sessions.view(id) : undefined;
}
