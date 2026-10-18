import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { MmrGuiBridge, MmrGuiEvent } from "./bridge.js";
import type { MmrGuiCommands } from "./commands.js";

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
 */

export interface MmrGuiServerOptions {
  bridge: MmrGuiBridge;
  /** Handlers of the POST routes, by the name after `/api/`. */
  commands: MmrGuiCommands;
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

const LOOPBACK = "127.0.0.1";

/** Largest command body the server reads. */
const MAX_BODY_BYTES = 512 * 1024;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
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

/** SHA-256 of the token, hex, as the live registry stores it. */
export function hashMmrGuiToken(token: string): string {
  return digest(token).toString("hex");
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

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value), { "Content-Type": "application/json; charset=utf-8" });
}

function formatEvent(event: MmrGuiEvent): string {
  return `id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/** The request body as JSON, or `undefined` when it is too large or not JSON. */
function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // Past the limit the rest is drained, not kept, so the answer still arrives.
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > MAX_BODY_BYTES) return resolve(undefined);
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(text.trim() === "" ? {} : JSON.parse(text));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", () => resolve(undefined));
  });
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

export async function startMmrGuiServer(options: MmrGuiServerOptions): Promise<MmrGuiServer> {
  const { bridge, token } = options;
  const clientDir = await realpath(options.clientDir);
  const heartbeatMs = options.heartbeatMs ?? 25_000;
  const streams = new Set<ServerResponse>();
  let port = 0;

  async function serveFile(res: ServerResponse, file: string | undefined): Promise<void> {
    const type = file && CONTENT_TYPES[path.extname(file)];
    if (!file || !type) return send(res, 404, "Not found");
    try {
      const real = await realpath(file);
      if (!real.startsWith(clientDir + path.sep) || !(await stat(real)).isFile()) return send(res, 404, "Not found");
      const body = await readFile(real);
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": type, "Content-Length": String(body.length) });
      res.end(body);
    } catch {
      send(res, 404, "Not found");
    }
  }

  function serveEvents(req: IncomingMessage, res: ServerResponse, url: URL): void {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
    });
    res.write("retry: 2000\n\n");
    const raw = req.headers["last-event-id"] ?? url.searchParams.get("after");
    const after = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : bridge.lastEventId;
    const missed = bridge.eventsAfter(after);
    // Too far behind (or another server's id): the client reloads the snapshot.
    if (missed === undefined) res.write("event: reset\ndata: {}\n\n");
    else for (const event of missed) res.write(formatEvent(event));
    const unsubscribe = bridge.subscribe((event) => res.write(formatEvent(event)));
    const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), heartbeatMs);
    heartbeat.unref();
    streams.add(res);
    const done = () => {
      clearInterval(heartbeat);
      unsubscribe();
      streams.delete(res);
    };
    req.on("close", done);
    res.on("close", done);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host;
    if (!host) return send(res, 400, "Missing Host header");
    if (host !== `${LOOPBACK}:${port}` && host !== `localhost:${port}`) return send(res, 403, "Unexpected Host header");
    const origin = req.headers.origin;
    const origins = [`http://${LOOPBACK}:${port}`, `http://localhost:${port}`];
    if (origin !== undefined && !origins.includes(origin)) return send(res, 403, "Unexpected Origin header");

    const rawPath = (req.url ?? "/").split("?")[0] ?? "/";
    const url = new URL(req.url ?? "/", `http://${LOOPBACK}:${port}`);
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
      const body = await readJson(req);
      if (body === undefined) return sendJson(res, 400, { error: "The request body is not JSON or is too large." });
      const result = await command(body);
      return sendJson(res, result.status, result.body);
    }
    if (method !== "GET" && method !== "HEAD") return send(res, 405, "Method not allowed", { Allow: "GET, POST" });

    if (rawPath === "/") return serveFile(res, path.join(clientDir, "index.html"));
    if (rawPath.startsWith("/client/")) {
      const file = clientFile(clientDir, rawPath.slice("/client/".length));
      if (!file) return send(res, 400, "Bad path");
      return serveFile(res, file);
    }
    if (rawPath === "/api/session") return sendJson(res, 200, { ...bridge.session(), status: bridge.status() });
    if (rawPath === "/api/transcript") return sendJson(res, 200, bridge.snapshot());
    if (rawPath === "/api/events") return serveEvents(req, res, url);
    return send(res, 404, "Not found");
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, "Internal error");
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, LOOPBACK, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;

  return {
    port,
    url: `http://${LOOPBACK}:${port}/?t=${token}`,
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
