// The session actions menu, More Actions: copy, export, where the session
// runs and what it cost, pin, rename, labels, colour, unread, snooze,
// archive, delete, Full Width and Report Bug. The title bar's `…` opens it
// for the session the page shows, a sidebar row's `m` key for that row's
// session, and the page's commands (commands.js) run its actions directly.
// Copy, Export, Color and Running in open a submenu beside it. The pure
// helpers at the top (the entries, the label rules, the dialogs' markup)
// are exported for tests; mountTitlebar wires them to the page.

import { escapeHtml } from "./app-mode.js";
import { chordLabels } from "./keys.js";
import { CHEVRON, ICONS as GROUP_ICONS, icon, THREAD_COLORS } from "./sidebar.js";

/** Where Report Bug… goes: the repository's issue chooser. */
export const REPORT_BUG_URL = "https://github.com/5omeOtherGuy/ampi/issues/new/choose";

/** The thread index's label rules, as `ampi threads label` applies them. */
export const LABEL_RULES = { pattern: /^[a-z0-9-]+$/, maxLength: 32, max: 20 };

/** The menu's icons, 16-unit strokes like the rest of the page. */
const ICONS = {
  copy: '<rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.5"/><path d="M10.75 5.25V3.75a1.5 1.5 0 0 0-1.5-1.5h-5a1.5 1.5 0 0 0-1.5 1.5v5a1.5 1.5 0 0 0 1.5 1.5h1.5"/>',
  export: '<path d="M8 2.25v7.5M4.75 6.5 8 9.75l3.25-3.25M2.75 11.5v1.25a1 1 0 0 0 1 1h8.5a1 1 0 0 0 1-1V11.5"/>',
  running: '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5"/><path d="m4.5 6.25 2 1.75-2 1.75M8.5 10h3"/>',
  cost: '<circle cx="8" cy="8" r="5.75"/><path d="M9.75 5.75H7.4a1.15 1.15 0 0 0 0 2.3h1.2a1.15 1.15 0 0 1 0 2.3H6.25M8 4.5v1.25M8 10.35v1.15"/>',
  pin: GROUP_ICONS.pinned,
  rename: '<path d="M10.25 2.75 13.25 5.75 5.75 13.25H2.75v-3z"/>',
  labels: '<path d="M2.25 3.25v4l6.5 6.5 5-5-6.5-6.5h-4a1 1 0 0 0-1 1z"/><circle cx="5.25" cy="5.25" r="0.9"/>',
  color: '<path d="M8 2.25c2.5 2.6 4 4.75 4 6.75a4 4 0 0 1-8 0c0-2 1.5-4.15 4-6.75z"/>',
  unread: '<rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5"/><path d="m2.25 4.25 5.75 4.5 5.75-4.5"/>',
  snooze: '<path d="M13.25 9.6A5.5 5.5 0 1 1 6.4 2.75a4.4 4.4 0 0 0 6.85 6.85z"/>',
  archive: GROUP_ICONS.archived,
  delete: '<path d="M2.75 4.25h10.5M6.25 4.25v-1.5h3.5v1.5M4 4.25l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6M6.75 6.75v4.25M9.25 6.75v4.25"/>',
  width: '<path d="M1.75 8h12.5M4.25 5.5 1.75 8l2.5 2.5M11.75 5.5l2.5 2.5-2.5 2.5"/>',
  bug: '<rect x="4.75" y="5.25" width="6.5" height="8.5" rx="3.25"/><path d="M8 7.75v6M6.25 5.5a1.75 1.75 0 0 1 3.5 0M2.25 9.25h2.5M11.25 9.25h2.5M3 5.75l1.9 1.1M13 5.75l-1.9 1.1M3 12.75l1.9-1.1M13 12.75l-1.9-1.1"/>',
  check: '<path d="m3.5 8.25 3 3 6-6.5"/>',
};

/** Where a session runs, as GET /api/running's `where` names it. */
export const RUNNING_WORDS = {
  "this-terminal": "This terminal",
  terminal: "Another terminal",
  execute: "An ampi -x run",
  app: "ampi app",
  none: "Not running",
};

/** The short word beside Running in: where the session list says it runs. */
export function runningHint(target) {
  if (target.host !== undefined) {
    if (!target.host) return "Not running";
    return { tui: "A terminal", execute: "ampi -x", "app-session": "ampi app" }[target.host.kind] ?? "Running";
  }
  if (target.live) return "This terminal";
  return target.elsewhere ? "Elsewhere" : "Not running";
}

/** The command `ampi` resumes the session with. */
export function resumeCommand(id) {
  return `ampi threads continue ${id}`;
}

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The menu's entries for a session, in groups split by separators. `target`
 * is the session as the page knows it (`id`, `title`, `archived`, `pinned`,
 * `snoozed`, `unread`, `color`, `live` when this process runs it, `held`
 * when any live process does, `host` in ampi app, and `actions` from the
 * session list: `archive` for the thread index, `markdown`, `cost`).
 * Actions the index backs are left out without it; an entry the session
 * cannot use now is disabled with a reason.
 */
export function menuItems(target, { fullWidth = false } = {}) {
  const { actions = {} } = target;
  const index = actions.archive === true;
  const groups = [
    [
      { action: "submenu", submenu: "copy", label: "Copy", icon: "copy" },
      { action: "submenu", submenu: "export", label: "Export", icon: "export" },
    ],
    [
      { action: "submenu", submenu: "running", label: "Running in", icon: "running", detail: runningHint(target) },
      actions.cost
        ? { action: "cost", label: "Cost & Usage", icon: "cost" }
        : { action: "cost", label: "Cost & Usage", icon: "cost", disabled: true, hint: "Costs need ampi-threads with ampiThreads.showCosts on" },
    ],
    [
      index && { action: "pin", label: target.pinned ? "Unpin" : "Pin", icon: "pin", keys: "ctrl+g i" },
      { action: "rename", label: "Rename…", icon: "rename" },
      index && { action: "labels", label: "Labels…", icon: "labels" },
      index && { action: "submenu", submenu: "color", label: "Color", icon: "color" },
    ],
    [
      index && { action: "unread", label: target.unread ? "Mark as Read" : "Mark as Unread", icon: "unread" },
      index && { action: "snooze", label: target.snoozed ? "Unsnooze" : "Snooze", icon: "snooze", keys: "ctrl+g z" },
    ],
    [
      index && { action: "archive", label: target.archived ? "Unarchive" : "Archive", icon: "archive", keys: "mod+shift+e" },
      target.held
        ? { action: "delete", label: "Delete", icon: "delete", destructive: true, disabled: true, hint: "Close the session where it runs before deleting it" }
        : { action: "delete", label: "Delete", icon: "delete", destructive: true },
    ],
    [
      { action: "full-width", label: "Full Width", icon: "width", checked: fullWidth },
      { action: "report-bug", label: "Report Bug…", icon: "bug", href: REPORT_BUG_URL },
    ],
  ];
  const items = [];
  for (const group of groups.map((entries) => entries.filter(Boolean)).filter((entries) => entries.length > 0)) {
    if (items.length > 0) items.push({ separator: true });
    items.push(...group);
  }
  return items;
}

/** A submenu's entries: `copy`, `export` or `color` (the Running in card is drawn from GET /api/running instead). */
export function submenuItems(kind, target) {
  const markdown = target.actions?.markdown === true;
  if (kind === "copy") {
    return [
      markdown && { action: "copy-markdown", label: "Markdown" },
      { action: "copy-id", label: "Session ID" },
      { action: "copy-resume", label: "Resume Command" },
      { action: "copy-url", label: "Page URL", keys: "mod+shift+c" },
    ].filter(Boolean);
  }
  if (kind === "export") {
    return [markdown && { action: "export-markdown", label: "Markdown File" }, { action: "export-json", label: "JSON File" }].filter(Boolean);
  }
  return [
    ...THREAD_COLORS.map((name) => ({ action: "color", value: name, label: capitalize(name), swatch: name, checked: target.color === name })),
    { separator: true },
    { action: "color", value: null, label: "Reset", checked: !target.color },
  ];
}

/**
 * Add a typed label to `labels` with the thread index's rules: trimmed and
 * lowercased, then 1 to 32 lowercase letters, digits or hyphens, at most 20
 * labels, no duplicates. Answers `{ labels }`, with `error` when it was
 * refused.
 */
export function addLabel(labels, text) {
  const label = String(text).trim().toLowerCase();
  if (label === "" || labels.includes(label)) return { labels };
  if (!LABEL_RULES.pattern.test(label)) return { labels, error: `"${label}" is not a label: use lowercase letters, digits and hyphens.` };
  if (label.length > LABEL_RULES.maxLength) return { labels, error: `A label has at most ${LABEL_RULES.maxLength} characters.` };
  if (labels.length >= LABEL_RULES.max) return { labels, error: `A session takes at most ${LABEL_RULES.max} labels.` };
  return { labels: [...labels, label] };
}

/** Dollars as the terminal's cost gauge writes them: three decimals below a cent, two above. */
export function formatCost(cost) {
  if (typeof cost !== "number" || !Number.isFinite(cost)) return "unknown";
  return cost > 0 && cost < 0.01 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(2)}`;
}

const tokens = (count) => count.toLocaleString("en-US");

/** The Cost & Usage dialog for a GET /api/cost report: the total, then each model's cost and tokens. Every name is escaped. */
export function costDialogHtml(title, report) {
  const heading = `<h2 id="action-dialog-title">Cost &amp; Usage</h2><p class="dialog-subtitle">${escapeHtml(title || "This session")}</p>`;
  const close = '<div class="dialog-actions"><button class="button" type="submit" value="close" autofocus>Close</button></div>';
  if (report.models.length === 0) return `<form method="dialog">${heading}<p class="dialog-text">No model has answered in this session yet.</p>${close}</form>`;
  const allUnknown = report.unknown === report.models.length;
  const note =
    report.unknown > 0 && !allUnknown
      ? `<p class="dialog-note">Not counting ${report.unknown} ${report.unknown === 1 ? "model" : "models"} without a price.</p>`
      : "";
  const rows = report.models
    .map((model) => {
      const parts = [`${tokens(model.input)} in`, `${tokens(model.output)} out`];
      if (model.cacheRead > 0) parts.push(`${tokens(model.cacheRead)} cache read`);
      if (model.cacheWrite > 0) parts.push(`${tokens(model.cacheWrite)} cache write`);
      return `<tr><th scope="row">${escapeHtml(model.label)}<span class="cost-tokens">${parts.join(" · ")}</span></th><td>${formatCost(model.cost)}</td></tr>`;
    })
    .join("");
  return `<form method="dialog">${heading}<p class="cost-total"><span>Total</span><strong>${allUnknown ? "unknown" : formatCost(report.total)}</strong></p>${note}<table class="cost-table"><thead><tr><th scope="col">Model</th><th scope="col">Cost</th></tr></thead><tbody>${rows}</tbody></table>${close}</form>`;
}

/** The delete confirmation, naming the session by its title, escaped. */
export function deleteDialogHtml(title) {
  return `<form method="dialog"><h2 id="action-dialog-title">Delete session?</h2><p class="dialog-text"><strong>${escapeHtml(title || "This session")}</strong> is deleted: its session file and its labels, colour and other thread metadata. This cannot be undone.</p><div class="dialog-actions"><button class="button" type="submit" value="cancel" autofocus>Cancel</button><button class="button destructive" type="submit" value="delete">Delete</button></div></form>`;
}

/** The confirmation before archiving the sidebar's Inactive group, with how many sessions it holds. */
export function archiveInactiveDialogHtml(count) {
  const sessions = count === 1 ? "1 session" : `${count} sessions`;
  return `<form method="dialog"><h2 id="action-dialog-title">Archive inactive threads?</h2><p class="dialog-text">${sessions} with no activity in the last 72 hours move to Archived. Unarchive any of them from its actions menu.</p><div class="dialog-actions"><button class="button" type="submit" value="cancel" autofocus>Cancel</button><button class="button primary" type="submit" value="archive">Archive ${sessions}</button></div></form>`;
}

/** Archive the sessions `ids`, one request each, in order; answers `{ archived, failed }` as counts. */
export async function archiveSessions(ids, post) {
  let archived = 0;
  for (const sessionId of ids) {
    const result = await post("archive", { sessionId, archived: true });
    if (result.ok) archived++;
  }
  return { archived, failed: ids.length - archived };
}

/** Answers that can use a sentence from the server; otherwise a fallback. */
function errorText(result, fallback) {
  return typeof result.body?.error === "string" ? result.body.error : fallback;
}

// ---------------------------------------------------------------------------
// Page wiring

// The window's size without the overflow of a menu being placed: on a phone
// an element past the edge widens the layout viewport (`innerWidth`) itself.
const viewWidth = () => document.documentElement.clientWidth;
const viewHeight = () => document.documentElement.clientHeight;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** One menu entry: a button, or a link for Report Bug…; `menuitemcheckbox` and `menuitemradio` for Full Width and the colours. */
function entryNode(item, mac) {
  if (item.separator) {
    const rule = element("div");
    rule.setAttribute("role", "separator");
    return rule;
  }
  const entry = element(item.href ? "a" : "button", "menu-entry");
  if (item.href) {
    entry.href = item.href;
    entry.target = "_blank";
    entry.rel = "noopener noreferrer";
  } else entry.type = "button";
  const role = item.action === "color" ? "menuitemradio" : item.checked !== undefined ? "menuitemcheckbox" : "menuitem";
  entry.setAttribute("role", role);
  if (role !== "menuitem") entry.setAttribute("aria-checked", String(item.checked === true));
  entry.tabIndex = -1;
  entry.dataset.action = item.action;
  if (item.action === "color") entry.dataset.value = item.value ?? "";
  if (item.destructive) entry.dataset.destructive = "true";
  if (item.submenu) {
    entry.dataset.submenu = item.submenu;
    entry.setAttribute("aria-haspopup", "menu");
    entry.setAttribute("aria-expanded", "false");
  }
  if (item.swatch) {
    const swatch = element("span", "disc");
    swatch.dataset.color = item.swatch;
    swatch.setAttribute("aria-hidden", "true");
    entry.append(swatch);
  } else if (item.icon) entry.append(icon(ICONS[item.icon]));
  else if (item.action === "color") entry.append(element("span", "menu-icon-space"));
  entry.append(element("span", "menu-label", item.label));
  if (item.detail) entry.append(element("span", "menu-detail", item.detail));
  if (item.keys) {
    const keys = element("span", "menu-keys");
    for (const chip of chordLabels(item.keys, { mac })) keys.append(element("kbd", "", chip));
    entry.append(keys);
  }
  if (item.submenu) entry.append(icon(CHEVRON, "icon menu-chevron"));
  if (role === "menuitemcheckbox") entry.append(element("span", "menu-switch"));
  if (role === "menuitemradio" && item.checked) entry.append(icon(ICONS.check, "icon menu-check"));
  if (item.disabled) {
    entry.setAttribute("aria-disabled", "true");
    entry.title = item.hint;
  }
  return entry;
}

/**
 * Wire More Actions. `post(route, body)` sends a command, `pageUrl(id)` is
 * a session's address without the token, `prefs` holds Full Width,
 * `onChanged()` reloads the session list, `onDeleted(id)` leaves a deleted
 * session's page.
 */
export function mountTitlebar({ post, notify, onChanged, onDeleted, pageUrl, prefs, setFullWidth, mac = false }) {
  const $ = (id) => document.getElementById(id);
  const button = $("more");
  const renameDialog = $("rename-dialog");
  const renameInput = $("rename-input");
  const dialog = $("action-dialog");
  const sub = $("submenu");
  const more = $("more-menu");
  const row = $("row-menu");
  /** The session the page shows: More Actions acts on it. */
  let target = null;
  /** The session the rename dialog renames, and where focus returns after it. */
  let renaming = null;
  let renameReturn = null;

  /** The open menu: its element, session, opener, how to find the opener after a redraw, and the entry whose submenu is open. */
  const open = { menu: null, session: null, opener: null, refocus: () => null, parent: null };
  const entries = (menu) => [...menu.querySelectorAll('[role^="menuitem"]:not([aria-disabled="true"])')];
  const returnTo = () => (open.opener?.isConnected ? open.opener : open.refocus()) ?? button;

  function closeSub({ focus = false } = {}) {
    if (!open.parent) return;
    const parent = open.parent;
    open.parent = null;
    sub.hidden = true;
    sub.replaceChildren();
    parent.setAttribute("aria-expanded", "false");
    if (focus) parent.focus();
  }

  function close({ focus = true } = {}) {
    if (!open.menu) return;
    closeSub();
    const menu = open.menu;
    open.menu = null;
    menu.hidden = true;
    if (menu === more) button.setAttribute("aria-expanded", "false");
    if (focus) returnTo()?.focus();
  }

  /** Put the submenu beside its entry: to the right of the menu, else to its left, else under the entry, inside the window. */
  function placeSub(parent) {
    const item = parent.getBoundingClientRect();
    const menu = open.menu.getBoundingClientRect();
    const width = sub.offsetWidth;
    const height = sub.offsetHeight;
    let left = menu.right - 4;
    let top = item.top - 5;
    if (left + width > viewWidth() - 8) left = menu.left - width + 4;
    if (left < 8) {
      left = Math.max(8, Math.min(viewWidth() - width - 8, item.left + 24));
      top = item.bottom + 2;
    }
    top = Math.max(8, Math.min(top, viewHeight() - height - 8));
    sub.style.setProperty("--ampi-menu-top", `${Math.round(top)}px`);
    sub.style.setProperty("--ampi-menu-left", `${Math.round(left)}px`);
  }

  /** The Running in card: where the session runs, its process and phase, its directory and branch, each value copyable. */
  async function fillRunning(parent, session) {
    sub.replaceChildren(element("p", "menu-card-note", "Looking where it runs…"));
    const result = await post("running", { sessionId: session.id });
    if (open.parent !== parent) return;
    if (!result.ok) {
      sub.replaceChildren(element("p", "menu-card-note", errorText(result, "Could not tell where it runs.")));
      return placeSub(parent);
    }
    const info = result.body;
    const header = element("div", "menu-card-header");
    header.append(element("strong", "", RUNNING_WORDS[info.where] ?? info.where));
    if (info.phase) header.append(element("span", "menu-detail", info.phase));
    const rows = [
      ["Process", info.pid === null ? null : String(info.pid)],
      ["Directory", info.cwd || null],
      ["Branch", info.branch],
    ].filter(([, value]) => value);
    sub.replaceChildren(
      header,
      ...rows.map(([label, value]) => {
        const entry = element("button", "menu-entry menu-card-row");
        entry.type = "button";
        entry.setAttribute("role", "menuitem");
        entry.tabIndex = -1;
        entry.dataset.action = "copy-text";
        entry.dataset.value = value;
        entry.title = value;
        entry.setAttribute("aria-label", `${label}: ${value}. Copy`);
        const text = element("span", "menu-card-text");
        // A long directory is cut at its start, so its last segments stay in view.
        const shown = element("span", "menu-card-value");
        shown.append(element("bdi", "", value));
        text.append(element("span", "menu-card-label", label), shown);
        entry.append(text, icon(ICONS.copy));
        return entry;
      }),
    );
    placeSub(parent);
  }

  function openSub(parent, { focus = true } = {}) {
    if (open.parent === parent) {
      if (focus) entries(sub)[0]?.focus();
      return;
    }
    closeSub();
    open.parent = parent;
    parent.setAttribute("aria-expanded", "true");
    const kind = parent.dataset.submenu;
    sub.dataset.kind = kind;
    sub.setAttribute("aria-label", parent.querySelector(".menu-label").textContent);
    if (kind === "running") void fillRunning(parent, open.session).then(() => focus && open.parent === parent && entries(sub)[0]?.focus());
    else sub.replaceChildren(...submenuItems(kind, open.session).map((item) => entryNode(item, mac)));
    sub.hidden = false;
    placeSub(parent);
    if (focus && kind !== "running") entries(sub)[0]?.focus();
  }

  /** The title bar's menu hangs under `…`; on a narrow page it moves left to stay in the window. */
  function placeMore() {
    more.style.removeProperty("--ampi-menu-shift");
    const overflow = more.getBoundingClientRect().right - (viewWidth() - 8);
    if (overflow > 0) more.style.setProperty("--ampi-menu-shift", `${-Math.ceil(overflow)}px`);
  }

  /** Open `menu` for `session` from `opener`; `submenu` opens one of its submenus at once (the palette's Color and Running in). */
  function openMenu(menu, session, opener, { focusLast = false, findOpener = () => null, place = placeMore, submenu } = {}) {
    close({ focus: false });
    open.menu = menu;
    open.session = session;
    open.opener = opener;
    open.refocus = findOpener;
    menu.replaceChildren(...menuItems(session, { fullWidth: prefs.get("fullWidth") }).map((item) => entryNode(item, mac)));
    menu.hidden = false;
    place(opener);
    if (menu === more) button.setAttribute("aria-expanded", "true");
    const list = entries(menu);
    const parent = submenu && menu.querySelector(`[data-submenu="${submenu}"]`);
    if (parent) {
      parent.focus();
      openSub(parent);
    } else (focusLast ? list.at(-1) : list[0])?.focus();
  }

  function step(list, event) {
    const index = list.indexOf(document.activeElement);
    const delta = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (delta) list[(index + delta + list.length) % list.length]?.focus();
    else if (event.key === "Home") list[0]?.focus();
    else if (event.key === "End") list.at(-1)?.focus();
    else return false;
    event.preventDefault();
    return true;
  }

  for (const menu of [more, row]) {
    menu.addEventListener("keydown", (event) => {
      if (open.menu !== menu) return;
      if (step(entries(menu), event)) return;
      const entry = document.activeElement?.closest?.("[data-submenu]");
      if (event.key === "ArrowRight" && entry && menu.contains(entry)) {
        event.preventDefault();
        openSub(entry);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === "Tab") close({ focus: false });
    });
    menu.addEventListener("pointerover", (event) => {
      if (open.menu !== menu) return;
      const entry = event.target.closest?.('[role^="menuitem"]');
      if (!entry || entry === open.parent) return;
      if (entry.dataset.submenu && entry.getAttribute("aria-disabled") !== "true") openSub(entry, { focus: false });
      else closeSub();
    });
    menu.addEventListener("click", (event) => {
      const entry = event.target.closest('[role^="menuitem"]');
      if (!entry || open.menu !== menu) return;
      if (entry.getAttribute("aria-disabled") === "true") return event.preventDefault();
      if (entry.dataset.submenu) return openSub(entry);
      choose(entry);
    });
  }
  sub.addEventListener("keydown", (event) => {
    if (step(entries(sub), event)) return;
    if (event.key === "ArrowLeft" || event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeSub({ focus: true });
    } else if (event.key === "Tab") close({ focus: false });
  });
  sub.addEventListener("click", (event) => {
    const entry = event.target.closest('[role^="menuitem"]');
    if (entry && open.menu) choose(entry);
  });
  document.addEventListener("pointerdown", (event) => {
    if (!open.menu || open.menu.contains(event.target) || sub.contains(event.target) || open.opener?.contains(event.target)) return;
    close({ focus: false });
  });

  /** Run a chosen entry for the open menu's session; a link (Report Bug…) opens itself. */
  function choose(entry) {
    const { action } = entry.dataset;
    const session = open.session;
    const from = returnTo();
    const value = action === "color" ? entry.dataset.value || null : entry.dataset.value;
    // The dialogs return focus themselves.
    close({ focus: !["rename", "labels", "cost", "delete"].includes(action) });
    if (action !== "report-bug") run(action, session, from, value);
  }

  async function copyText(text, done) {
    try {
      await navigator.clipboard.writeText(text);
      notify(done);
    } catch {
      notify("The browser did not allow copying to the clipboard.");
    }
  }

  /** Fetch GET /api/export, then save it through a link, so the page stays where it is and a refusal shows its reason. */
  async function download(session, format) {
    let res;
    try {
      res = await fetch(`/api/export?sessionId=${encodeURIComponent(session.id)}&format=${format}`);
    } catch {
      return notify("Could not reach the session's server.");
    }
    if (!res.ok) {
      const body = await res.json().catch(() => undefined);
      return notify(errorText({ body }, "Could not export the session."));
    }
    const url = URL.createObjectURL(await res.blob());
    const link = element("a");
    link.href = url;
    link.download = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "";
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    // Freed later: revoking at once can cancel a download the browser has not started yet.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  /** Show the shared action dialog with `html`, or with `build(dialog)`; `onClose(returnValue)` runs after, then focus returns to `from`. */
  function showDialog(from, { html, build, onClose = () => {} }) {
    if (html !== undefined) dialog.innerHTML = html;
    else build(dialog);
    dialog.returnValue = "";
    dialog.addEventListener(
      "close",
      () => {
        (from?.isConnected ? from : button).focus();
        onClose(dialog.returnValue);
      },
      { once: true },
    );
    dialog.showModal();
  }

  /**
   * The labels editor: chips that a click or Backspace removes, a field that
   * Enter or a comma adds from. Save writes them to the thread index, or
   * hands them to `save(labels)` (the new-thread composer, before the thread exists).
   */
  function editLabels(session, from, save) {
    let labels = [...(session.labels ?? [])];
    showDialog(from, {
      build(node) {
        node.innerHTML =
          '<form method="dialog"><h2 id="action-dialog-title">Labels</h2><p class="dialog-subtitle"></p><div class="label-editor"><ul class="label-chips" aria-label="Labels"></ul><label class="visually-hidden" for="label-input">Add a label</label><input id="label-input" type="text" autocomplete="off" spellcheck="false" placeholder="Add a label" maxlength="64"></div><p class="dialog-note">Lowercase letters, digits and hyphens; at most 20 labels.</p><p class="dialog-error" role="alert" hidden></p><div class="dialog-actions"><button class="button" type="submit" value="cancel" formnovalidate>Cancel</button><button class="button primary" type="submit" value="save">Save</button></div></form>';
        node.querySelector(".dialog-subtitle").textContent = session.title;
        const chips = node.querySelector(".label-chips");
        const input = node.querySelector("#label-input");
        const problem = node.querySelector(".dialog-error");
        const say = (text) => {
          problem.textContent = text ?? "";
          problem.hidden = !text;
        };
        const draw = () => {
          chips.replaceChildren(
            ...labels.map((label) => {
              const chip = element("li", "label-chip");
              const remove = element("button", "label-remove");
              remove.type = "button";
              remove.setAttribute("aria-label", `Remove label ${label}`);
              remove.innerHTML = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="m5 5 6 6M11 5l-6 6"/></svg>';
              remove.addEventListener("click", () => {
                labels = labels.filter((other) => other !== label);
                draw();
                input.focus();
              });
              chip.append(element("span", "", label), remove);
              return chip;
            }),
          );
        };
        const commit = () => {
          const result = addLabel(labels, input.value);
          labels = result.labels;
          say(result.error);
          if (!result.error) input.value = "";
          draw();
          return !result.error;
        };
        input.addEventListener("keydown", (event) => {
          if ((event.key === "Enter" || event.key === ",") && input.value.trim() !== "") {
            event.preventDefault();
            commit();
          } else if (event.key === "Backspace" && input.value === "" && labels.length > 0) {
            labels = labels.slice(0, -1);
            draw();
          }
        });
        // Typed text not yet added is added on Save, or Save is refused with the reason.
        node.querySelector('[value="save"]').addEventListener("click", (event) => {
          if (input.value.trim() !== "" && !commit()) event.preventDefault();
        });
        draw();
        queueMicrotask(() => input.focus());
      },
      async onClose(answer) {
        if (answer !== "save") return;
        if (save) return save(labels);
        const result = await post("labels", { sessionId: session.id, labels });
        if (!result.ok) return notify(errorText(result, "Could not change the labels."));
        notify(labels.length === 0 ? "Removed the labels" : `Labels: ${labels.join(", ")}`);
        onChanged();
      },
    });
  }

  /** Change one thread index field and reload the list; `done` is the toast. */
  async function setField(route, body, done, failed) {
    const result = await post(route, body);
    if (!result.ok) return notify(errorText(result, failed));
    notify(done);
    onChanged();
  }

  /**
   * Do `action` for `session`; `from` is where focus returns after a dialog,
   * `value` a colour (or `null` to reset), the text to copy, or the ids
   * Archive Inactive archives.
   */
  async function run(action, session, from = button, value) {
    // Full Width, Report Bug… and Archive Inactive need no session.
    if (!session && !["full-width", "report-bug", "archive-inactive"].includes(action)) return;
    const id = session?.id;
    switch (action) {
      case "markdown":
      case "copy-markdown": {
        const result = await post("markdown", { sessionId: id });
        if (!result.ok) return notify(errorText(result, "Could not copy the session."));
        return copyText(result.body.markdown, "Copied the session as Markdown");
      }
      case "copy-id":
        return copyText(id, "Copied the session ID");
      case "copy-resume":
        return copyText(resumeCommand(id), "Copied the resume command");
      case "copy-url":
        return copyText(pageUrl(id), "Copied the page address");
      case "copy-text":
        return copyText(value, "Copied");
      case "export-markdown":
        return download(session, "markdown");
      case "export-json":
        return download(session, "json");
      case "cost": {
        const result = await post("cost", { sessionId: id });
        if (!result.ok) return notify(errorText(result, "Could not read the cost."));
        return showDialog(from, { html: costDialogHtml(session.title, result.body.cost) });
      }
      case "running":
      case "color-menu":
        return openMenu(more, session, button, { submenu: action === "running" ? "running" : "color" });
      case "pin":
        return setField("pin", { sessionId: id, pinned: !session.pinned }, session.pinned ? "Unpinned the session" : "Pinned the session", "Could not pin the session.");
      case "color":
        return setField("color", { sessionId: id, color: value ?? null }, value ? `Color: ${value}` : "Reset the color", "Could not change the color.");
      case "unread":
        return setField("unread", { sessionId: id, unread: !session.unread }, session.unread ? "Marked as read" : "Marked as unread", "Could not mark the session.");
      case "snooze":
        return setField(
          "snooze",
          { sessionId: id, snoozed: !session.snoozed },
          session.snoozed ? "Unsnoozed the session" : "Snoozed until the next message",
          "Could not snooze the session.",
        );
      case "archive": {
        const archived = !session.archived;
        return setField("archive", { sessionId: id, archived }, archived ? "Archived the session" : "Unarchived the session", "Could not change the archive.");
      }
      case "archive-inactive":
        return showDialog(from, {
          html: archiveInactiveDialogHtml(value.length),
          async onClose(answer) {
            if (answer !== "archive") return;
            const { archived, failed } = await archiveSessions(value, post);
            notify(
              failed > 0
                ? `Archived ${archived} of ${value.length} sessions; the others could not be archived.`
                : `Archived ${archived === 1 ? "1 inactive session" : `${archived} inactive sessions`}`,
            );
            onChanged();
          },
        });
      case "labels":
        return editLabels(session, from);
      case "delete":
        return showDialog(from, {
          html: deleteDialogHtml(session.title),
          async onClose(answer) {
            if (answer !== "delete") return;
            const result = await post("delete", { sessionId: id });
            if (!result.ok) return notify(errorText(result, "Could not delete the session."));
            notify(result.body.warning ?? "Deleted the session");
            onDeleted(id);
          },
        });
      case "rename":
        renaming = session;
        renameReturn = from;
        renameInput.value = session.title;
        renameDialog.returnValue = "";
        renameDialog.showModal();
        renameInput.select();
        return;
      case "full-width": {
        const next = !prefs.get("fullWidth");
        prefs.set("fullWidth", next);
        return setFullWidth(next);
      }
      case "report-bug":
        window.open(REPORT_BUG_URL, "_blank", "noopener,noreferrer");
        return;
    }
  }

  button.addEventListener("click", () => (open.menu === more ? close() : target && openMenu(more, target, button)));
  button.addEventListener("keydown", (event) => {
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && target) {
      event.preventDefault();
      openMenu(more, target, button, { focusLast: event.key === "ArrowUp" });
    }
  });

  renameDialog.addEventListener("close", async () => {
    const session = renaming;
    const back = renameReturn?.isConnected ? renameReturn : button;
    renaming = null;
    renameReturn = null;
    back.focus();
    if (renameDialog.returnValue !== "save" || !session) return;
    const result = await post("rename", { sessionId: session.id, name: renameInput.value });
    if (!result.ok) return notify(errorText(result, "Could not rename the session."));
    onChanged();
  });
  // A click on the scrim outside the card closes the action dialog.
  dialog.addEventListener("click", (event) => {
    const box = dialog.getBoundingClientRect();
    const outside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
    if (event.target === dialog && outside) dialog.close();
  });

  return {
    /** The session the menu acts on (see `menuItems`), or `null` for none. */
    setTarget(next) {
      target = next;
      button.disabled = !next;
      if (!next && open.menu === more) close({ focus: false });
    },
    /** The shown session's target, as `setTarget` last set it. */
    target: () => target,
    run,
    editLabels,
    /** Open the actions menu for a sidebar row's session; `findRow()` finds the row again after a redraw. */
    openForRow(session, rowNode, findRow) {
      openMenu(row, session, rowNode, {
        findOpener: findRow,
        // The row menu sits in the sidebar, so it stays usable while the sidebar is a sheet over an inert page.
        place(opener) {
          const box = opener.getBoundingClientRect();
          const height = row.offsetHeight;
          const top = box.bottom + 4 + height > viewHeight() ? Math.max(4, box.top - 4 - height) : box.bottom + 4;
          row.style.setProperty("--ampi-menu-top", `${Math.round(top)}px`);
          row.style.setProperty("--ampi-menu-left", `${Math.round(Math.min(box.left + 8, viewWidth() - row.offsetWidth - 8))}px`);
        },
      });
    },
  };
}
