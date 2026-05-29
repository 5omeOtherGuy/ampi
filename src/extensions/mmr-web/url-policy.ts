import { isIP } from "node:net";

export interface UrlValidationOk {
  ok: true;
  url: URL;
}
export interface UrlValidationFail {
  ok: false;
  reason: string;
}
export type UrlValidationResult = UrlValidationOk | UrlValidationFail;

const DENIED_HOSTNAMES = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  "broadcasthost",
]);

export function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) return false;
  // Reserved/private blocks: 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16,
  // 198.18/15 (benchmarking), 224/4 (multicast), 240/4 (reserved).
  return (
    parts[0] === 0 ||
    parts[0] === 10 ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) ||
    parts[0] >= 224
  );
}

/**
 * Parse an IPv6 literal (without brackets, lowercase) into 16 bytes, or return
 * null if the input is not a syntactically valid IPv6 address. Accepts both
 * pure-hex forms and the IPv4-mapped tail (`::ffff:a.b.c.d`); the WHATWG URL
 * parser normalizes the latter to hex before we see it, but we accept both.
 */
function parseIPv6(host: string): Uint8Array | null {
  // Split off an optional zone identifier (`%eth0`); we don't need it for range checks.
  const noZone = host.split("%", 1)[0]!;
  const doubleColonCount = (noZone.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return null;

  // Extract a possible trailing IPv4 dotted-quad (`...:a.b.c.d`).
  let head = noZone;
  let trailingV4: number[] | null = null;
  const lastColon = noZone.lastIndexOf(":");
  if (lastColon >= 0 && noZone.includes(".", lastColon)) {
    const tail = noZone.slice(lastColon + 1);
    const parts = tail.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    trailingV4 = parts;
    head = noZone.slice(0, lastColon);
    // The IPv4 tail occupies the last two 16-bit groups, so `head` must end with `:` or be `::`-style.
    if (!head.endsWith(":")) return null;
    // Trim the trailing `:` so the split below treats `head` as a normal group list.
    head = head.slice(0, -1);
    if (head === "") head = ":"; // becomes `[":"]` after split; handled below
  }

  let leftPart: string;
  let rightPart: string;
  const dcIdx = head.indexOf("::");
  if (dcIdx === -1) {
    leftPart = head;
    rightPart = "";
  } else {
    leftPart = head.slice(0, dcIdx);
    rightPart = head.slice(dcIdx + 2);
  }

  const splitGroups = (segment: string): string[] | null => {
    if (segment === "") return [];
    const groups = segment.split(":");
    for (const g of groups) {
      if (g.length === 0 || g.length > 4 || !/^[0-9a-f]+$/.test(g)) return null;
    }
    return groups;
  };

  const left = splitGroups(leftPart);
  const right = splitGroups(rightPart);
  if (left === null || right === null) return null;

  const v4Groups = trailingV4 ? 2 : 0;
  const explicit = left.length + right.length + v4Groups;
  if (dcIdx === -1) {
    if (explicit !== 8) return null;
  } else {
    if (explicit > 7) return null; // `::` must elide at least one zero group
  }
  const zeros = dcIdx === -1 ? 0 : 8 - explicit;

  const groups: string[] = [...left, ...new Array<string>(zeros).fill("0"), ...right];
  if (groups.length + v4Groups !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < groups.length; i++) {
    const value = parseInt(groups[i]!, 16);
    bytes[i * 2] = (value >> 8) & 0xff;
    bytes[i * 2 + 1] = value & 0xff;
  }
  if (trailingV4) {
    const offset = groups.length * 2;
    bytes[offset] = trailingV4[0]!;
    bytes[offset + 1] = trailingV4[1]!;
    bytes[offset + 2] = trailingV4[2]!;
    bytes[offset + 3] = trailingV4[3]!;
  }
  return bytes;
}

/**
 * Range-check an IPv6 address against blocks that should never be reachable
 * from the open internet. Operates on the 16-byte representation so behavior
 * is independent of any text normalization the URL parser may have applied.
 */
export function isPrivateIPv6(host: string): boolean {
  const bytes = parseIPv6(host);
  if (!bytes) return false;

  const allZero = bytes.every((b) => b === 0);
  if (allZero) return true; // ::
  // ::1 (loopback)
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true;
  // ff00::/8 (multicast)
  if (bytes[0] === 0xff) return true;
  // fc00::/7 (unique local)
  if ((bytes[0]! & 0xfe) === 0xfc) return true;
  // fe80::/10 (link-local)
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true;

  // ::ffff:0:0/96 — IPv4-mapped IPv6. Recurse into the embedded IPv4.
  const isV4Mapped =
    bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (isV4Mapped) {
    const v4 = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    if (isPrivateIPv4(v4)) return true;
  }

  // 64:ff9b::/96 — well-known NAT64. Recurse into the embedded IPv4.
  const isNat64 =
    bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((b) => b === 0);
  if (isNat64) {
    const v4 = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    if (isPrivateIPv4(v4)) return true;
  }

  // 2002::/16 — 6to4. The embedded IPv4 lives in bytes[2..5].
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    const v4 = `${bytes[2]}.${bytes[3]}.${bytes[4]}.${bytes[5]}`;
    if (isPrivateIPv4(v4)) return true;
  }

  return false;
}

/** Strip a single trailing `.` (FQDN root label) from a hostname so denylist
 * checks aren't bypassed by `localhost.`, `service.local.`, etc. */
function normalizeHost(host: string): string {
  return host.endsWith(".") ? host.slice(0, -1) : host;
}

/**
 * Range-check a literal IP address (v4 or v6) against the same
 * private/reserved/link-local denylist used by {@link validateExternalHttpUrl}.
 * Returns `true` if the address must not be reached from the open internet.
 *
 * Use this when post-resolution DNS lookups have produced raw IP strings
 * (e.g. `dns.lookup(host, { all: true })`); URL-text validation lives in
 * {@link validateExternalHttpUrl} and operates on hostnames, not addresses.
 */
export function isPrivateIpLiteral(address: string): boolean {
  if (typeof address !== "string" || address.length === 0) return false;
  const kind = isIP(address);
  if (kind === 4) return isPrivateIPv4(address);
  if (kind === 6) return isPrivateIPv6(address);
  return false;
}

/**
 * Validate a user-configured SearXNG instance URL.
 *
 * Unlike {@link validateExternalHttpUrl}, this permits loopback, private,
 * link-local, and other reserved addresses because the SearXNG URL comes
 * from user settings (settings file or env), not from model input. A
 * self-hosted SearXNG typically lives at `http://127.0.0.1:8080` or
 * `http://searxng.local`. We still enforce scheme allow-list, reject
 * userinfo credentials, and require a hostname so a malformed or
 * file:/javascript: URL cannot slip through.
 *
 * Non-default ports are allowed (SearXNG defaults to `:8080`).
 */
export function validateSearXNGUrl(rawUrl: string): UrlValidationResult {
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
    return { ok: false, reason: "SearXNG URL is empty." };
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "SearXNG URL is not a valid absolute URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `SearXNG URL scheme "${parsed.protocol}" is not allowed; only http and https are supported.` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "SearXNG URL must not include credentials in the userinfo component." };
  }
  const rawHost = parsed.hostname.toLowerCase();
  if (!rawHost) return { ok: false, reason: "SearXNG URL has no hostname." };
  return { ok: true, url: parsed };
}

/**
 * Reject obvious local/private/SSRF-prone targets before the custom reader
 * fetches a page, so the model never gets direct network access.
 */
export function validateExternalHttpUrl(rawUrl: string): UrlValidationResult {
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
    return { ok: false, reason: "URL is empty." };
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "URL is not a valid absolute URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `URL scheme "${parsed.protocol}" is not allowed; only http and https are supported.` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "URL must not include credentials in the userinfo component." };
  }
  // Port allow-list: only the canonical http/https ports. WHATWG URL drops a
  // scheme-default port from `parsed.port` (so `http://x:80/` has port "");
  // any non-empty value here is a deliberate, non-default port.
  if (parsed.port !== "" && parsed.port !== "80" && parsed.port !== "443") {
    return { ok: false, reason: `URL port "${parsed.port}" is not allowed; only the default http/https ports (80, 443) are permitted.` };
  }
  const rawHost = parsed.hostname.toLowerCase();
  if (!rawHost) return { ok: false, reason: "URL has no hostname." };
  // IPv6 literals are bracketed; strip brackets *before* trailing-dot
  // normalization so we never trim a hex digit by accident.
  const bareHost = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
  const host = isIP(bareHost) ? bareHost : normalizeHost(bareHost);
  if (DENIED_HOSTNAMES.has(host)) return { ok: false, reason: `Hostname "${host}" is not allowed.` };
  if (host.endsWith(".local") || host.endsWith(".localhost") || host.endsWith(".internal")) {
    return { ok: false, reason: `Hostname "${host}" looks like a local/internal name.` };
  }

  const ipKind = isIP(host);
  if (ipKind === 4 && isPrivateIPv4(host)) {
    return { ok: false, reason: `IP "${host}" is in a reserved or private range.` };
  }
  if (ipKind === 6 && isPrivateIPv6(host)) {
    return { ok: false, reason: `IPv6 "${host}" is in a reserved or private range.` };
  }

  return { ok: true, url: parsed };
}
