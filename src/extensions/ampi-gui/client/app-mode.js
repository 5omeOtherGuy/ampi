// App mode: the page `ampi app` serves for every session. These helpers are
// pure, so tests load them in Node without a DOM; app.js and sidebar.js wire
// them to the page. A session server (a terminal's own GUI) never uses them.

/** How often the session list is read again while the page is visible. */
export const APP_LIST_REFRESH_MS = 5_000;

/** Pi's session ids, as the server accepts them. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Where per-session requests go: `/api/` on a session server, which runs one
 * session, and `/s/<id>/api/` in app mode. Requests about every session
 * (the list, More Actions) always go to `/api/`.
 */
export function sessionBase(app, id) {
  return app && id ? `/s/${encodeURIComponent(id)}/api/` : "/api/";
}

/**
 * The page's address to copy: as shown, but never with the access token,
 * which only the link Pi prints carries (`?t=`).
 */
export function shareableUrl(href) {
  const url = new URL(href);
  url.searchParams.delete("t");
  // An empty fragment (`/#`, left by the live session's row) is dropped.
  if (!url.hash) url.hash = "";
  return url.href;
}

/**
 * The address of session `id`'s page on the server at `href`, never with
 * the access token: `/s/<id>` in app mode; on a terminal's own page `/` for
 * the session it runs (`liveId`) and `/#/s/<id>` for the others.
 */
export function sessionPageUrl(href, { app, id, liveId }) {
  const url = new URL(href);
  url.search = "";
  url.hash = "";
  url.pathname = app ? appPath(id) : "/";
  if (!app && id && id !== liveId) url.hash = `#/s/${encodeURIComponent(id)}`;
  return url.href;
}

/** The page's address for a session, or `/` for the home page. */
export function appPath(id) {
  return id ? `/s/${encodeURIComponent(id)}` : "/";
}

/** The session a page address names: `{ id }`, `{ id: null }` for `/`, or `null` for any other path. */
export function parseAppPath(pathname) {
  if (pathname === "/") return { id: null };
  const match = /^\/s\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  let id;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return SESSION_ID.test(id) ? { id } : null;
}

/** The history entry the page stores with each address. */
export function historyState(id) {
  return { ampiSession: id ?? null };
}

/** The session to show after Back or Forward: the entry's state, else the address. */
export function routeFromHistory(state, pathname) {
  const stored = state?.ampiSession;
  if (stored === null) return null;
  if (typeof stored === "string" && SESSION_ID.test(stored)) return stored;
  return parseAppPath(pathname)?.id ?? null;
}

/** Where a session runs, by the kind of the live process that has it open. */
export const HOST_LABELS = {
  tui: "Running in a terminal",
  execute: "Running in ampi -x",
  "app-session": "Running in ampi app",
};
export const NOT_RUNNING = "Not running";

/** Whether the process that has the session open is working on it: its row's disc spins. */
export function hostWorking(host) {
  return Boolean(host) && typeof host.phase === "string" && host.phase !== "idle" && host.phase !== "error";
}

/**
 * A sidebar row's status icon label: where the session runs, then its flags,
 * comma-separated. `Live` means the process serves a live web view of it,
 * `Working` that its agent is busy, `Error` that its last turn failed.
 */
export function statusIconLabel(host) {
  if (!host) return NOT_RUNNING;
  const parts = [HOST_LABELS[host.kind] ?? `Running in process ${host.pid}`];
  if (host.gui) parts.push("Live");
  if (hostWorking(host)) parts.push("Working");
  if (host.phase === "error") parts.push("Error");
  return parts.join(", ");
}

/** Text as HTML: the five characters that can end an element or attribute are escaped. */
export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Where a holder runs, in the banner's words; any other kind is named as it is. */
function holderWords(kind, pid) {
  const where = { tui: "a terminal", execute: "an ampi -x run", "app-session": "another ampi app" }[kind];
  return where ? `${where} (pid ${pid})` : `process ${pid} (${escapeHtml(kind)})`;
}

/**
 * How the page offers a session that is not live here, by the state the hub
 * answered (a transcript read from the file, or a 409 or 502 body):
 *
 * | `access` | When | The page |
 * | --- | --- | --- |
 * | `held` | another live process has the file open | read-only, `html` names where it runs; for a terminal without the web GUI (`gui: false`), how to continue here |
 * | `dormant` | nothing runs it | the transcript with the composer on; a send starts it |
 * | `imported` | it was imported and cannot be continued | the composer off, with `reason` |
 * | `gone` | the process that ran it here stopped | read-only, `html` says to open it again |
 */
export function bannerFor(state, title) {
  const name = `<strong>${escapeHtml(title || "This session")}</strong>`;
  switch (state?.state) {
    case "elsewhere":
      if (state.kind === "tui" && state.gui === false) {
        return {
          access: "held",
          html: `${name} is open in ${holderWords(state.kind, state.pid)}, which does not run the web GUI. To continue it here, turn on ampiGui in that terminal; until then it is read-only here.`,
        };
      }
      return {
        access: "held",
        html: `${name} is open in ${holderWords(state.kind, state.pid)}. Continue it there; here it is read-only, so the two never write the same file.`,
      };
    case "not-running":
      return { access: "dormant" };
    case "imported":
      return { access: "imported", reason: "This session was imported, so it can be read here but not continued." };
    default:
      return { access: "gone", html: `The process that ran ${name} here has stopped. Pick the session again to continue it.` };
  }
}

/**
 * Whether the session list says the shown session changed hands since the
 * page showed it with `access` and the hub's `state`, so the page shows it
 * again: a process started a session shown dormant, a holder let go of one
 * shown held, or the holder's pid or web GUI is not the one shown (a
 * terminal's entry can name its GUI only after the page read it).
 */
export function hostChanged(access, state, host) {
  if (access === "dormant") return Boolean(host);
  if (access !== "held") return false;
  return !host || host.pid !== state?.pid || host.gui !== Boolean(state?.gui);
}

/**
 * Reload the session list every `everyMs` while `visible()` holds. A hidden
 * page stops; shown again it reloads at once and resumes. Timers are
 * injected so tests can run them.
 */
export function createRefresher({ run, everyMs, visible, setTimer, clearTimer }) {
  let timer = null;
  const schedule = () => {
    if (timer === null && visible()) timer = setTimer(tick, everyMs);
  };
  function tick() {
    timer = null;
    if (!visible()) return;
    run();
    schedule();
  }
  return {
    start: schedule,
    /** Call on `visibilitychange`. */
    visibilityChanged() {
      if (!visible()) {
        if (timer !== null) clearTimer(timer);
        timer = null;
      } else if (timer === null) {
        run();
        schedule();
      }
    },
  };
}
