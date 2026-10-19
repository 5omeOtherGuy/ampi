// The Activity page (`/feed`): every listed session active in a time
// window, filtered by status, project and a search query, grouped by day
// (GET /api/feed). The filters live in the address, so Back and Forward
// restore them; app.js keeps the history and calls `show`. Right-clicking a
// Time or Status option offers to make it this browser's default (prefs.js).
// The helpers before `mountActivity` are pure, so tests load them in Node.

import { escapeHtml } from "./app-mode.js";
import { paintDisc, relativeTime } from "./sidebar.js";

export const FEED_TIMES = [
  { value: "24h", label: "Last 24h" },
  { value: "72h", label: "Last 72h" },
  { value: "7d", label: "Last 7d" },
  { value: "all", label: "All Time" },
];

export const FEED_STATUSES = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
  { value: "snoozed", label: "Snoozed" },
];

/** The built-in defaults; a browser can choose its own (prefs.js `feedDefaultTime`, `feedDefaultStatus`). */
export const FEED_DEFAULTS = { time: "24h", status: "all" };

const known = (options, value) => options.some((option) => option.value === value);

/**
 * The filters in a `/feed` query string: `time`, `status`, `project` (a
 * working directory, `""` for `none`, `null` for every project) and `q`.
 * A missing or unknown time or status takes the default.
 */
export function parseFeedSearch(search, defaults = FEED_DEFAULTS) {
  const params = new URLSearchParams(search);
  const time = params.get("time");
  const status = params.get("status");
  const project = params.get("project");
  return {
    time: known(FEED_TIMES, time) ? time : defaults.time,
    status: known(FEED_STATUSES, status) ? status : defaults.status,
    project: project === null || project === "" ? null : project === "none" ? "" : project,
    q: params.get("q") ?? "",
  };
}

/** The `/feed` address for `filters`, leaving out the values that are the defaults. */
export function feedPath(filters, defaults = FEED_DEFAULTS) {
  const params = new URLSearchParams();
  if (filters.time !== defaults.time) params.set("time", filters.time);
  if (filters.status !== defaults.status) params.set("status", filters.status);
  if (filters.project !== null) params.set("project", filters.project === "" ? "none" : filters.project);
  if (filters.q) params.set("q", filters.q);
  const search = params.toString();
  return search ? `/feed?${search}` : "/feed";
}

/** The GET /api/feed request for `filters`, with the browser's time zone and language for the day labels. */
export function feedApiPath(filters, { timeZone, locale }) {
  const params = new URLSearchParams({ time: filters.time, status: filters.status });
  if (filters.project !== null) params.set("project", filters.project === "" ? "none" : filters.project);
  if (filters.q) params.set("q", filters.q);
  if (timeZone) params.set("tz", timeZone);
  if (locale) params.set("locale", locale);
  return `/api/feed?${params}`;
}

/** How long ago `iso` was, for a row's meta line: `just now`, `5m ago`, `3h ago`. */
export function ageLabel(iso, now) {
  const short = relativeTime(iso, now);
  return short === "now" ? "just now" : `${short} ago`;
}

/** A project's name for a row: the feed's label for its directory, else the directory's last segment. */
export function projectName(cwd, projects = []) {
  const listed = projects.find((project) => project.cwd === cwd);
  if (listed) return listed.label;
  if (cwd === "") return "No project";
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
}

/** A session disc for HTML: the hashed or named colour goes in `data-color` once `paintDiscs` runs. */
export function discHtml(row) {
  return `<span class="disc" data-id="${escapeHtml(row.id)}" data-thread-color="${escapeHtml(row.color ?? "")}" aria-hidden="true"></span>`;
}

/** Colour every disc that `discHtml` wrote (CSSOM, as the page allows no inline styles). */
export function paintDiscs(root) {
  for (const disc of root.querySelectorAll(".disc[data-id]")) paintDisc(disc, disc.dataset.id, disc.dataset.threadColor || null);
}

/** One result row: the disc, the title, and `age · project`. Every value is escaped. */
export function feedRowHtml(row, { href, project, now }) {
  const unread = row.unread ? ' data-unread="true"' : "";
  const note = row.unread ? '<span class="visually-hidden">Unread: </span>' : "";
  return (
    `<a class="feed-row" role="listitem" href="${escapeHtml(href)}" data-id="${escapeHtml(row.id)}"${unread}>` +
    discHtml(row) +
    `<span class="feed-row-text"><span class="feed-row-title">${note}${escapeHtml(row.title)}</span>` +
    `<span class="feed-row-meta"><time datetime="${escapeHtml(row.modified)}">${escapeHtml(ageLabel(row.modified, now))}</time> · ${escapeHtml(project)}</span></span></a>`
  );
}

/** A filter card's option: a link to the filtered address, filled when chosen. */
function optionHtml({ key, value, label, href, chosen, count, title }) {
  const current = chosen ? ' aria-current="true"' : "";
  const hint = title ? ` title="${escapeHtml(title)}"` : "";
  const tally = count === undefined ? "" : `<span class="feed-count">${escapeHtml(String(count))}</span>`;
  return `<a class="feed-option" href="${escapeHtml(href)}" data-key="${key}" data-value="${escapeHtml(value)}"${current}${hint}><span class="feed-option-label">${escapeHtml(label)}</span>${tally}</a>`;
}

/**
 * The Projects card: All with the sum, then each project with its count. A
 * chosen project with no sessions in the other filters is listed with 0.
 */
export function projectOptionsHtml(projects, filters, defaults = FEED_DEFAULTS) {
  const listed = [...projects];
  if (filters.project !== null && !listed.some((project) => project.cwd === filters.project)) {
    listed.push({ cwd: filters.project, label: projectName(filters.project), count: 0 });
  }
  const all = listed.reduce((sum, project) => sum + project.count, 0);
  const href = (project) => feedPath({ ...filters, project }, defaults);
  return [
    optionHtml({ key: "project", value: "*", label: "All", href: href(null), chosen: filters.project === null, count: all }),
    ...listed.map((project) =>
      optionHtml({ key: "project", value: project.cwd === "" ? "none" : project.cwd, label: project.label, href: href(project.cwd), chosen: filters.project === project.cwd, count: project.count, title: project.cwd || undefined }),
    ),
  ].join("");
}

/** The Time or Status card. */
export function choiceOptionsHtml(key, options, filters, defaults = FEED_DEFAULTS) {
  return options
    .map(({ value, label }) =>
      optionHtml({ key, value, label, href: feedPath({ ...filters, [key]: value }, defaults), chosen: filters[key] === value, title: defaults[key] === value ? "Default" : undefined }),
    )
    .join("");
}

/** A sentence about the query's filters the results ignore, or `""`. */
export function appliedNote(applied) {
  const parts = [];
  if (applied?.unsupported?.length) parts.push(`Not applied here: ${applied.unsupported.join(", ")}. These filters need the transcript or other data the list does not have.`);
  if (applied?.invalid?.length) parts.push(`Could not read: ${applied.invalid.join(", ")}.`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Page wiring

/** How long the search field waits after the last key before it filters. */
const TYPING_MS = 300;

/**
 * Wire the Activity page in `root`. `onFilters(next, { replace })` asks
 * app.js to put new filters in the address (it then calls `show`);
 * `onOpen(id)` shows a session; `sessionHref(id)` is a row's address.
 */
export function mountActivity({ root, prefs, notify, onFilters, onOpen, sessionHref, now = () => Date.now() }) {
  const $ = (id) => document.getElementById(id);
  const query = $("feed-q");
  const cards = { time: $("feed-time"), status: $("feed-status"), project: $("feed-projects") };
  const days = $("feed-days");
  const note = $("feed-note");
  const emptyNote = $("feed-empty");
  const menu = $("feed-menu");
  const { timeZone } = Intl.DateTimeFormat().resolvedOptions();
  const locale = navigator.language;

  let filters = { ...FEED_DEFAULTS, project: null, q: "" };
  let data = null;
  let request = 0;
  let typing = 0;
  /** The option whose menu is open, to give focus back. */
  let menuFor = null;

  const defaults = () => ({ time: prefs.get("feedDefaultTime"), status: prefs.get("feedDefaultStatus") });

  function drawFilters() {
    cards.time.innerHTML = choiceOptionsHtml("time", FEED_TIMES, filters, defaults());
    cards.status.innerHTML = choiceOptionsHtml("status", FEED_STATUSES, filters, defaults());
    cards.project.innerHTML = projectOptionsHtml(data?.projects ?? [], filters, defaults());
    // The field follows the address (Back and Forward); typing reaches here only once the field holds `filters.q`.
    if (query.value !== filters.q) query.value = filters.q;
  }

  function drawResults() {
    if (!data) return;
    const projects = data.projects;
    days.innerHTML = data.days
      .map(
        (day) =>
          `<section class="feed-day" aria-label="${escapeHtml(day.label)}"><h3 class="feed-day-label">${escapeHtml(day.label)}</h3>` +
          `<div class="feed-card feed-rows" role="list">${day.sessions.map((row) => feedRowHtml(row, { href: sessionHref(row.id), project: projectName(row.cwd, projects), now: now() })).join("")}</div></section>`,
      )
      .join("");
    paintDiscs(days);
    const text = appliedNote(data.applied);
    note.textContent = text;
    note.hidden = text === "";
    emptyNote.hidden = data.total > 0;
  }

  async function load() {
    const mine = ++request;
    let answer;
    try {
      const response = await fetch(feedApiPath(filters, { timeZone, locale }), { credentials: "same-origin" });
      answer = await response.json().catch(() => undefined);
      if (!response.ok) {
        if (mine === request) notify(answer?.error ?? "Could not load the activity.");
        return;
      }
    } catch {
      if (mine === request) notify("Could not reach Pi.");
      return;
    }
    // A newer request owns the page.
    if (mine !== request) return;
    data = answer;
    drawFilters();
    drawResults();
  }

  root.addEventListener("click", (event) => {
    const link = event.target.closest?.("a.feed-option, a.feed-row");
    if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (link.classList.contains("feed-row")) return onOpen(link.dataset.id);
    const { key, value } = link.dataset;
    const next = key === "project" ? (value === "*" ? null : value === "none" ? "" : value) : value;
    if (filters[key] !== next) onFilters({ ...filters, [key]: next });
  });

  query.addEventListener("input", () => {
    clearTimeout(typing);
    typing = setTimeout(() => onFilters({ ...filters, q: query.value }, { replace: true }), TYPING_MS);
  });
  query.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      clearTimeout(typing);
      onFilters({ ...filters, q: query.value });
    } else if (event.key === "Escape" && query.value !== "") {
      event.preventDefault();
      event.stopPropagation();
      clearTimeout(typing);
      query.value = "";
      onFilters({ ...filters, q: "" });
    }
  });

  // Use as default / Reset default, for the Time and Status options.
  function closeMenu({ focus = false } = {}) {
    if (menu.hidden) return;
    menu.hidden = true;
    if (focus) menuFor?.focus();
    menuFor = null;
  }

  function setDefault(key, value) {
    const pref = key === "time" ? "feedDefaultTime" : "feedDefaultStatus";
    prefs.set(pref, value);
    const label = (key === "time" ? FEED_TIMES : FEED_STATUSES).find((option) => option.value === value)?.label ?? value;
    notify(`${label} is now the default ${key === "time" ? "time window" : "status"}`);
    // The address leaves out defaults: write it again for the new one.
    onFilters(filters, { replace: true });
  }

  function openMenu(option, x, y) {
    const { key, value } = option.dataset;
    const current = defaults()[key];
    const items = [
      { label: "Use as default", disabled: current === value, run: () => setDefault(key, value) },
      { label: "Reset default", disabled: current === FEED_DEFAULTS[key], run: () => setDefault(key, FEED_DEFAULTS[key]) },
    ];
    menu.replaceChildren(
      ...items.map((item) => {
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("role", "menuitem");
        button.textContent = item.label;
        if (item.disabled) button.setAttribute("aria-disabled", "true");
        button.addEventListener("click", () => {
          if (item.disabled) return;
          closeMenu({ focus: true });
          item.run();
        });
        return button;
      }),
    );
    menuFor = option;
    menu.hidden = false;
    const box = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - box.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - box.height - 8))}px`;
    (menu.querySelector('[role="menuitem"]:not([aria-disabled])') ?? menu.querySelector('[role="menuitem"]'))?.focus();
  }

  root.addEventListener("contextmenu", (event) => {
    const option = event.target.closest?.('a.feed-option[data-key="time"], a.feed-option[data-key="status"]');
    if (!option) return;
    event.preventDefault();
    // From the keyboard (Shift+F10, the menu key) the event has no pointer position.
    const rect = option.getBoundingClientRect();
    const fromKeyboard = event.clientX === 0 && event.clientY === 0;
    openMenu(option, fromKeyboard ? rect.left + 8 : event.clientX, fromKeyboard ? rect.bottom : event.clientY);
  });
  menu.addEventListener("keydown", (event) => {
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    const index = items.indexOf(document.activeElement);
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu({ focus: true });
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!menu.hidden && !menu.contains(event.target)) closeMenu();
  });
  window.addEventListener("blur", () => closeMenu());
  root.addEventListener("scroll", () => closeMenu(), true);

  return {
    /** This browser's default time and status. */
    defaults,
    /** Show the page with `next` filters and load its sessions. */
    show(next) {
      filters = next;
      closeMenu();
      drawFilters();
      load();
    },
    /** Load the sessions again, as the list changes. */
    refresh: () => load(),
    /** Stop a pending search and close the menu, as the page is left. */
    hide() {
      clearTimeout(typing);
      closeMenu();
    },
  };
}
