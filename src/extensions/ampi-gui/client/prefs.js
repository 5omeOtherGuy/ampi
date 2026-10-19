// The page's preferences: the sidebar's width and whether it is open, Full
// Width, and the Activity page's default time window and status. They live in one cookie, not in localStorage, because every
// ampi web GUI on this machine runs on its own 127.0.0.1 port: a browser
// keeps localStorage per port but sends a cookie to every port of the same
// host, so each terminal's page and ampi app share them. The cookie holds
// nothing secret (the access token has its own HttpOnly cookie per port),
// is SameSite=Strict and lasts a year. `encodePrefs` and `decodePrefs` are
// pure, so tests check them in Node.

export const PREFS_COOKIE = "ampi_gui_prefs";

const ONE_YEAR_S = 365 * 24 * 60 * 60;

/** Each preference's default and the check a stored value must pass. */
const SCHEMA = {
  sidebarWidth: { fallback: 256, valid: (value) => Number.isFinite(value) },
  sidebarOpen: { fallback: true, valid: (value) => typeof value === "boolean" },
  fullWidth: { fallback: false, valid: (value) => typeof value === "boolean" },
  feedDefaultTime: { fallback: "24h", valid: (value) => ["24h", "72h", "7d", "all"].includes(value) },
  feedDefaultStatus: { fallback: "all", valid: (value) => ["all", "active", "archived", "snoozed"].includes(value) },
};

/** The defaults. */
export function defaultPrefs() {
  return Object.fromEntries(Object.entries(SCHEMA).map(([key, { fallback }]) => [key, fallback]));
}

/**
 * The preferences in a `Cookie` header (`document.cookie`): each known key
 * whose stored value passes its check, the default for the rest. A cookie
 * that is missing or not ours reads as the defaults.
 */
export function decodePrefs(cookieHeader) {
  const prefs = defaultPrefs();
  for (const pair of String(cookieHeader ?? "").split(";")) {
    const index = pair.indexOf("=");
    if (index < 0 || pair.slice(0, index).trim() !== PREFS_COOKIE) continue;
    let stored;
    try {
      stored = JSON.parse(decodeURIComponent(pair.slice(index + 1).trim()));
    } catch {
      continue;
    }
    if (stored === null || typeof stored !== "object" || Array.isArray(stored)) continue;
    for (const [key, { valid }] of Object.entries(SCHEMA)) {
      if (Object.hasOwn(stored, key) && valid(stored[key])) prefs[key] = stored[key];
    }
  }
  return prefs;
}

/** The `document.cookie` assignment that stores `prefs`: known keys only, valid values only. */
export function encodePrefs(prefs) {
  const kept = {};
  for (const [key, { valid }] of Object.entries(SCHEMA)) if (valid(prefs?.[key])) kept[key] = prefs[key];
  return `${PREFS_COOKIE}=${encodeURIComponent(JSON.stringify(kept))}; Path=/; Max-Age=${ONE_YEAR_S}; SameSite=Strict`;
}

/** The preferences of this page's document: read once, written back on every change. */
export function createPrefs(doc = document) {
  let prefs = decodePrefs(doc.cookie);
  return {
    get: (key) => prefs[key],
    set(key, value) {
      prefs = { ...prefs, [key]: value };
      doc.cookie = encodePrefs(prefs);
    },
  };
}
