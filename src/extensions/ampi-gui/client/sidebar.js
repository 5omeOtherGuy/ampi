// The session sidebar: groups from GET /api/sessions, a search filter, a
// drag handle that resizes it, and the moves its keys make (commands.js
// binds them). The pure helpers at the top are exported for tests;
// mountSidebar wires them to the page.

import { appPath, hostWorking, statusIconLabel } from "./app-mode.js";

/** Thread colours the thread index accepts, in the order ids hash onto them (gray is never hashed). */
export const THREAD_COLORS = ["blue", "purple", "pink", "red", "orange", "yellow", "green", "cyan", "gray"];
const HASHED_COLORS = THREAD_COLORS.slice(0, -1);

export const SIDEBAR_WIDTH = { default: 256, min: 200, max: 480, step: 16 };

/** Groups that start collapsed, and show how many sessions they hold: old, snoozed and archived sessions. */
const COLLAPSED_KINDS = new Set(["inactive", "snoozed", "archived"]);

/**
 * A session's disc colour: the colour set in the thread index (a name or
 * `#rrggbb`), else one hashed from its id, so a session keeps its colour.
 */
export function threadColor(id, color) {
  if (typeof color === "string" && (THREAD_COLORS.includes(color) || /^#[0-9a-f]{6}$/i.test(color))) return color;
  // FNV-1a over the id's UTF-16 code units.
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return HASHED_COLORS[hash % HASHED_COLORS.length];
}

/** How long ago `iso` was, in the sidebar's short form: now, 5m, 3h, 2d, 3w, 4mo, 1y. */
export function relativeTime(iso, now) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/**
 * The groups with only the sessions that match `query`: every
 * space-separated word must appear in the title, the project name or the
 * working directory, ignoring case. Groups left empty are dropped.
 */
export function filterGroups(groups, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return groups;
  return groups
    .map((group) => ({
      ...group,
      sessions: group.sessions.filter((session) => {
        const text = `${session.title}\n${group.kind === "project" ? group.label : ""}\n${session.cwd}`.toLowerCase();
        return words.every((word) => text.includes(word));
      }),
    }))
    .filter((group) => group.sessions.length > 0);
}

export function clampSidebarWidth(width) {
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH.default;
  return Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, width)));
}

// ---------------------------------------------------------------------------
// Page wiring

/** The group headers' icons; the session menu reuses the pin and archive ones. */
export const ICONS = {
  pinned: '<path d="M9.5 2.25 13.75 6.5M10.75 3.5 7 7.25 4.25 7.5l4.25 4.25.25-2.75 3.75-3.75M6.4 9.6 2.75 13.25"/>',
  project: '<path d="M1.75 3.5h4l1.5 1.5h7v7.5a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1z"/>',
  inactive: '<circle cx="8" cy="8" r="5.75"/><path d="M8 4.75V8l2 1.5"/>',
  snoozed: '<path d="M13.25 9.6A5.5 5.5 0 1 1 6.4 2.75a4.4 4.4 0 0 0 6.85 6.85z"/>',
  archived: '<rect x="1.75" y="2.75" width="12.5" height="3.25" rx="1"/><path d="M3 6v6.25a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6M6.5 8.75h3"/>',
};
export const CHEVRON = '<path d="M6 3.5 10.5 8 6 12.5"/>';

/** A 16-unit stroke icon from SVG path markup (constants in the client, never data). */
export function icon(paths, className = "icon") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = paths;
  return svg;
}

/** Colour a disc: a named colour through CSS, a hex one through CSSOM (the page allows no inline styles). */
export function paintDisc(disc, id, color) {
  const value = threadColor(id, color);
  if (value.startsWith("#")) {
    disc.removeAttribute("data-color");
    disc.style.setProperty("--ampi-disc", value);
  } else {
    disc.style.removeProperty("--ampi-disc");
    disc.dataset.color = value;
  }
}

/**
 * A row's disc and title. An unread session's row is marked for CSS (a dot
 * on the disc, a bolder title) and its title starts with "Unread" for
 * screen readers.
 */
function rowBody(row, session, disc) {
  const title = document.createElement("span");
  title.className = "session-title";
  title.textContent = session.title;
  if (session.unread) {
    row.dataset.unread = "true";
    const note = document.createElement("span");
    note.className = "visually-hidden";
    note.textContent = "Unread: ";
    title.prepend(note);
  }
  row.append(disc, title);
}

/**
 * Mount the sidebar. `app` carries `data-sidebar="open|closed"`; below
 * 768 px the open sidebar is an overlay sheet over the page. Its width and
 * whether it is open are page preferences (`prefs.js`).
 */
export function mountSidebar({ app, prefs, now = () => Date.now() }) {
  const $ = (id) => document.getElementById(id);
  const sidebar = $("sidebar");
  const list = $("session-list");
  const search = $("session-search");
  const empty = $("sidebar-empty");
  const handle = $("sidebar-resize");
  const scrim = $("scrim");
  const pane = document.querySelector(".pane");
  const toggles = [$("sidebar-close"), $("sidebar-open")];
  const narrow = window.matchMedia("(max-width: 767px)");

  let data = { currentId: null, groups: [] };
  let selectedId = null;
  let busy = false;
  /** In app mode rows link to `/s/<id>` and show where each session runs. */
  let appMode = false;
  /** Groups the user opened or closed, against their default. */
  const flipped = new Set();

  // Open on wide screens unless the user closed it; a sheet always starts closed.
  let open = !narrow.matches && prefs.get("sidebarOpen");

  function setWidth(width) {
    const value = clampSidebarWidth(width);
    app.style.setProperty("--ampi-sidebar-width", `${value}px`);
    handle.setAttribute("aria-valuenow", String(value));
    return value;
  }
  handle.setAttribute("aria-valuemin", String(SIDEBAR_WIDTH.min));
  handle.setAttribute("aria-valuemax", String(SIDEBAR_WIDTH.max));
  setWidth(prefs.get("sidebarWidth"));
  const storeWidth = (width) => prefs.set("sidebarWidth", width);

  function setOpen(next, { focus = false } = {}) {
    open = next;
    app.dataset.sidebar = open ? "open" : "closed";
    const sheet = narrow.matches;
    scrim.hidden = !(open && sheet);
    // A sheet takes the page's place for keyboard and screen reader users.
    pane.inert = open && sheet;
    for (const toggle of toggles) toggle.setAttribute("aria-expanded", String(open));
    if (!sheet && prefs.get("sidebarOpen") !== open) prefs.set("sidebarOpen", open);
    if (focus && open) search.focus();
    // Closing hides the sidebar: focus inside it moves to the button that opens it again.
    if (!open && (focus || sidebar.contains(document.activeElement))) $("sidebar-open").focus();
  }

  function toggle(options) {
    setOpen(!open, options);
  }

  for (const button of toggles) button.addEventListener("click", () => toggle({ focus: narrow.matches }));
  scrim.addEventListener("click", () => setOpen(false, { focus: true }));
  narrow.addEventListener("change", () => setOpen(narrow.matches ? false : prefs.get("sidebarOpen")));
  // On the document, so Escape closes the sheet even when focus fell to the page body.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.defaultPrevented && narrow.matches && open) {
      event.preventDefault();
      setOpen(false, { focus: true });
    }
  });
  // Choosing a session closes the sheet.
  list.addEventListener("click", (event) => {
    if (narrow.matches && event.target.closest?.("a.session-row")) setOpen(false);
  });

  // Dragging the handle, or its arrow keys, resizes the sidebar; a double click resets it.
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    app.dataset.resizing = "true";
    const left = sidebar.getBoundingClientRect().left;
    const move = (moveEvent) => setWidth(moveEvent.clientX - left);
    const up = () => {
      handle.removeEventListener("pointermove", move);
      delete app.dataset.resizing;
      storeWidth(Number(handle.getAttribute("aria-valuenow")));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
    handle.addEventListener("pointercancel", up, { once: true });
  });
  handle.addEventListener("keydown", (event) => {
    const delta = { ArrowLeft: -SIDEBAR_WIDTH.step, ArrowRight: SIDEBAR_WIDTH.step }[event.key];
    if (!delta) return;
    event.preventDefault();
    storeWidth(setWidth(Number(handle.getAttribute("aria-valuenow")) + delta));
  });
  handle.addEventListener("dblclick", () => storeWidth(setWidth(SIDEBAR_WIDTH.default)));

  search.addEventListener("input", draw);
  search.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || search.value === "") return;
    event.preventDefault();
    event.stopPropagation();
    search.value = "";
    draw();
  });

  /** An app-mode row: its disc is the status icon, labelled with where the session runs, and spins while it works. */
  function appRowNode(session) {
    const row = document.createElement("a");
    row.className = "session-row";
    row.href = appPath(session.id);
    row.dataset.id = session.id;
    row.title = session.title;
    if (session.id === selectedId) row.setAttribute("aria-current", "page");
    const host = session.host ?? null;
    const label = statusIconLabel(host);
    const disc = document.createElement("span");
    disc.className = "disc";
    paintDisc(disc, session.id, session.color);
    disc.setAttribute("role", "img");
    disc.setAttribute("aria-label", label);
    disc.title = label;
    if (hostWorking(host)) disc.dataset.busy = "true";
    rowBody(row, session, disc);
    if (host) {
      const dot = document.createElement("span");
      dot.className = "running-dot";
      dot.dataset.kind = host.kind;
      dot.setAttribute("aria-hidden", "true");
      dot.title = label;
      row.append(dot);
    }
    const time = document.createElement("time");
    time.className = "session-time";
    time.dateTime = session.modified;
    time.textContent = relativeTime(session.modified, now());
    row.append(time);
    return row;
  }

  function rowNode(session) {
    if (appMode) return appRowNode(session);
    const row = document.createElement("a");
    row.className = "session-row";
    row.href = session.live ? "#" : `#/s/${encodeURIComponent(session.id)}`;
    row.dataset.id = session.id;
    if (session.id === selectedId) row.setAttribute("aria-current", "page");
    const disc = document.createElement("span");
    disc.className = "disc";
    paintDisc(disc, session.id, session.color);
    if (session.live && busy) {
      disc.dataset.busy = "true";
      disc.setAttribute("role", "img");
      disc.setAttribute("aria-label", "Working");
    } else disc.setAttribute("aria-hidden", "true");
    row.title = session.title;
    rowBody(row, session, disc);
    if (session.elsewhere) {
      const dot = document.createElement("span");
      dot.className = "running-dot";
      dot.setAttribute("role", "img");
      dot.setAttribute("aria-label", "Running in another terminal");
      dot.title = "Running in another terminal";
      row.append(dot);
    }
    const time = document.createElement("time");
    time.className = "session-time";
    time.dateTime = session.modified;
    time.textContent = relativeTime(session.modified, now());
    row.append(time);
    if (session.live) row.title = `${session.title} (this terminal)`;
    return row;
  }

  function groupNode(group, filtering) {
    const collapsed = !filtering && COLLAPSED_KINDS.has(group.kind) !== flipped.has(group.id);
    const section = document.createElement("section");
    section.className = "session-group";
    section.dataset.kind = group.kind;
    const header = document.createElement("button");
    header.type = "button";
    header.className = "group-header";
    header.setAttribute("aria-expanded", String(!collapsed));
    if (group.cwd) header.title = group.cwd;
    const label = document.createElement("span");
    label.className = "group-label";
    label.textContent = group.label;
    header.append(icon(ICONS[group.kind] ?? ICONS.project), label);
    if (COLLAPSED_KINDS.has(group.kind)) {
      const count = document.createElement("span");
      count.className = "group-count";
      count.textContent = String(group.sessions.length);
      header.append(count);
    }
    const rule = document.createElement("span");
    rule.className = "group-rule";
    header.append(rule, icon(CHEVRON, "icon chevron"));
    header.addEventListener("click", () => {
      if (flipped.has(group.id)) flipped.delete(group.id);
      else flipped.add(group.id);
      draw();
      list.querySelector(`.group-header[data-group="${CSS.escape(group.id)}"]`)?.focus();
    });
    header.dataset.group = group.id;
    section.append(header);
    if (!collapsed) {
      const rows = document.createElement("div");
      rows.className = "group-rows";
      rows.setAttribute("role", "list");
      for (const session of group.sessions) {
        const item = document.createElement("div");
        item.setAttribute("role", "listitem");
        item.append(rowNode(session));
        rows.append(item);
      }
      section.append(rows);
    }
    return section;
  }

  function draw() {
    const query = search.value.trim();
    const groups = filterGroups(data.groups, query);
    // The list is redrawn while it is used (app mode reloads it every few seconds): keep focus on the same row or header.
    const focused = list.contains(document.activeElement) ? document.activeElement : null;
    list.replaceChildren(...groups.map((group) => groupNode(group, query !== "")));
    if (focused?.dataset.id) list.querySelector(`a.session-row[data-id="${CSS.escape(focused.dataset.id)}"]`)?.focus();
    else if (focused?.dataset.group) list.querySelector(`.group-header[data-group="${CSS.escape(focused.dataset.group)}"]`)?.focus();
    empty.textContent = query ? "No sessions match." : "No saved sessions yet.";
    empty.hidden = groups.length > 0;
  }

  /** The rows and group headers the sidebar's focus mode steps through, top to bottom. */
  const items = () => [...list.querySelectorAll("a.session-row, .group-header")];

  setOpen(open);
  return {
    /** Show or hide the sidebar; a sheet takes focus. */
    toggle() {
      toggle({ focus: narrow.matches });
    },
    /** Open the sidebar and select its search text. */
    focusSearch() {
      if (!open) setOpen(true);
      search.focus();
      search.select();
    },
    /** Focus the row or group header `step` places from the focused one; the list ends where it ends. */
    move(step) {
      const all = items();
      const index = all.indexOf(document.activeElement);
      const next = all[index < 0 ? 0 : Math.min(all.length - 1, Math.max(0, index + step))];
      next?.focus();
      next?.scrollIntoView({ block: "nearest" });
    },
    /** The row `step` places from the shown session's row, in the list's order; the first or last when none is shown. */
    adjacentRow(step) {
      const rows = [...list.querySelectorAll("a.session-row")];
      const index = rows.findIndex((row) => row.getAttribute("aria-current") === "page");
      return rows[index < 0 ? (step > 0 ? 0 : rows.length - 1) : index + step] ?? null;
    },
    /** The row of session `id`, or `null` when it is not drawn. */
    row: (id) => list.querySelector(`a.session-row[data-id="${CSS.escape(id)}"]`),
    /** The listed session `id`, as GET /api/sessions has it. */
    session: (id) => data.groups.flatMap((group) => group.sessions).find((session) => session.id === id) ?? null,
    /** Whether focus is in the list: the sidebar's keys apply. */
    hasFocus: () => list.contains(document.activeElement),
    /** Close the sheet (narrow screens only). */
    closeSheet() {
      if (narrow.matches && open) setOpen(false);
    },
    /** Replace the listed sessions with a GET /api/sessions answer. */
    setData(next) {
      data = next;
      draw();
    },
    /** Mark the row of the session the page shows. */
    select(id) {
      selectedId = id;
      for (const row of list.querySelectorAll("a.session-row")) {
        if (row.dataset.id === id) row.setAttribute("aria-current", "page");
        else row.removeAttribute("aria-current");
      }
    },
    /** Whether the session this process runs is working: its row spins. */
    setBusy(next) {
      if (busy === next) return;
      busy = next;
      draw();
    },
    redraw: draw,
    /** Switch to `ampi app`'s rows. */
    useAppMode() {
      appMode = true;
      draw();
    },
  };
}
