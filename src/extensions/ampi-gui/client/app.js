// The ampi web GUI client: loads the transcript, follows the live event
// stream and draws both, and sends what the composer writes. The sidebar
// lists the other sessions; opening one shows it read-only. Plain ES
// module, no framework.
//
// The same page serves `ampi app` (app mode, when GET /api/app answers):
// every session has its own address, `/s/<id>`, and its own routes under
// `/s/<id>/api/`; a session the app runs is live, the others are read from
// their files (see app-mode.js).

import {
  APP_LIST_REFRESH_MS,
  appPath,
  bannerFor,
  createRefresher,
  historyState,
  parseAppPath,
  routeFromHistory,
  sessionBase,
} from "./app-mode.js";
import { mountComposer } from "./composer.js";
import { mountSidebar, paintDisc } from "./sidebar.js";
import { mountTitlebar } from "./titlebar.js";
import {
  CHEVRON,
  createTranscript,
  groupItemIds,
  groupOf,
  itemHtml,
  partNodeHtml,
  planWorkFolds,
  setGroups,
  setItem,
} from "./transcript.js";

const $ = (id) => document.getElementById(id);
const app = document.querySelector(".app");
const chat = $("chat");
const transcript = $("transcript");
const liveDot = $("live-dot");
const empty = $("empty");
const jump = $("jump");

/** The live session's items, in transcript order, and its work groups. */
const live = createTranscript();
const items = live.items;
/** Rows, groups and work folds the user opened, by key, so redraws keep them open. */
const openRows = new Set();
let lastEventId = 0;
let source;
let busy = false;
let lastStatus;
/** Parts whose text grew since the last frame, as `itemId:index`. */
const dirty = new Set();
let frame = 0;
/** The session this process runs, as the snapshot and `session` events name it. */
let liveSession = { id: "", title: "", cwd: "", mode: null };
/** The saved session shown read-only (GET /api/sessions/<id>), or `null` while the page shows the live one. */
let viewing = null;
/** The last GET /api/sessions answer. */
let sessionList = { currentId: null, groups: [], actions: { archive: false, markdown: false } };
/** Whether `ampi app` serves the page. */
let appMode = false;
/** Where the shown session's own requests go (`sessionBase`). */
let base = "/api/";
/** App mode: the session in the address, or `null` on the home page. */
let shownId = null;
/** App mode: how the shown session is offered, `live` or a `bannerFor` access. */
let access = "live";

/** POST a command as JSON; resolves `{ ok, body }` and never throws. */
async function postTo(url, body) {
  try {
    const response = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, body: data };
  } catch {
    return { ok: false, body: { error: "Could not reach Pi." } };
  }
}

/** A command about any session (More Actions): always `/api/<route>`. */
const post = (route, body) => postTo(`/api/${route}`, body);

/**
 * The composer's commands go to the shown session. In app mode the first
 * send to a session nothing runs starts it: the status says Starting until
 * the hub answers, then the page follows the session live.
 */
async function composerPost(route, body) {
  if (!appMode) return postTo(`${base}${route}`, body);
  const id = shownId;
  const starting = access === "dormant" && route === "send";
  if (starting) {
    setPhaseLabel("Starting");
    $("status-detail").textContent = "";
    app.dataset.busy = "true";
    app.dataset.phase = "sending";
  }
  const result = await postTo(`${base}${route}`, body);
  if (id !== shownId) return result;
  if (result.ok) {
    if (starting) openSession(id);
  } else if (access === "live" && result.body?.state === "elsewhere") handOver(result.body);
  // The hub's answers carry a state when the session changed hands meanwhile: show it as it is now.
  else if (result.body?.state) openSession(id, { keepScroll: true });
  else if (starting) showDormant();
  return result;
}

const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const composer = mountComposer({ root: $("composer-area"), post: composerPost, mac });
const sidebar = mountSidebar({ app, mac });

let toastTimer = 0;
function notify(text) {
  const toast = $("toast");
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 4000);
}

const titlebar = mountTitlebar({ post, notify, onChanged: () => refreshSessions() });

// ---------------------------------------------------------------------------
// Colour scheme: system, light or dark, remembered per browser.

const SCHEMES = ["system", "light", "dark"];

function readScheme() {
  try {
    const stored = localStorage.getItem("ampi-gui-color-scheme");
    return SCHEMES.includes(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

function applyScheme(scheme) {
  if (scheme === "system") document.documentElement.removeAttribute("data-ampi-color-scheme");
  else document.documentElement.setAttribute("data-ampi-color-scheme", scheme);
  const label = `Color scheme: ${scheme}`;
  $("scheme").setAttribute("aria-label", label);
  $("scheme").title = label;
}

$("scheme").addEventListener("click", () => {
  const next = SCHEMES[(SCHEMES.indexOf(readScheme()) + 1) % SCHEMES.length];
  try {
    localStorage.setItem("ampi-gui-color-scheme", next);
  } catch {}
  applyScheme(next);
});
applyScheme(readScheme());

// ---------------------------------------------------------------------------
// Following the bottom: stay pinned while the reader is at the bottom.

function atBottom() {
  return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 48;
}

function withFollow(update) {
  const follow = atBottom();
  update();
  if (follow) chat.scrollTop = chat.scrollHeight;
  jump.hidden = atBottom();
}

/** Whether the reader was at the bottom when the chat last scrolled. */
let pinned = true;
chat.addEventListener("scroll", () => {
  pinned = atBottom();
  jump.hidden = pinned;
});
// The chat shrinks when queued messages or a longer prompt grow the composer,
// and when the window changes size: keep a reader at the bottom there.
new ResizeObserver(() => {
  if (pinned) chat.scrollTop = chat.scrollHeight;
  jump.hidden = atBottom();
}).observe(chat);
jump.addEventListener("click", () => {
  chat.scrollTop = chat.scrollHeight;
  chat.focus({ preventScroll: true });
});
document.addEventListener("keydown", (event) => {
  // End jumps to the newest output when focus is not in a text field.
  if (event.key === "End" && !event.target.closest?.("input, textarea, [contenteditable]")) {
    chat.scrollTop = chat.scrollHeight;
  }
});

// ---------------------------------------------------------------------------
// Drawing

function itemNode(item) {
  let node = transcript.querySelector(`[data-id="${CSS.escape(item.id)}"]`);
  if (!node) {
    node = document.createElement("article");
    node.className = `msg ${item.type}`;
    node.dataset.id = item.id;
    node.setAttribute("aria-label", item.type === "user" ? "You" : "Assistant");
    transcript.append(node);
  }
  return node;
}

function drawItem(item) {
  // Live items keep arriving while another session is shown; they are drawn on the way back.
  if (viewing) return;
  itemNode(item).innerHTML = itemHtml(live, item, openRows);
}

function drawPart(item, index) {
  if (viewing) return;
  const node = itemNode(item).querySelector(`[data-part="${index}"]`);
  if (node) node.outerHTML = partNodeHtml(live, item, index, openRows);
  else drawItem(item);
}

/** Redraw the items with these ids. */
function drawItems(ids) {
  for (const id of ids) {
    const item = items.get(id);
    if (item) drawItem(item);
  }
}

/** The transcript the page shows: the live one, or a saved session's. */
function shownTranscript() {
  return viewing ? viewing.transcript : live;
}

/**
 * Fold each finished turn's work behind its "Worked for …" line: a divider
 * before the turn's first message, and every message of the work hidden
 * except the last, which keeps its final answer and any error note.
 */
function drawFolds() {
  const folds = planWorkFolds(shownTranscript(), busy && !viewing);
  const byItem = new Map();
  for (const fold of folds) for (const id of fold.itemIds) byItem.set(id, fold);
  const wanted = new Set(folds.map((fold) => fold.key));
  for (const node of transcript.querySelectorAll(".work-fold")) if (!wanted.has(node.dataset.key)) node.remove();
  for (const fold of folds) {
    const first = transcript.querySelector(`.msg[data-id="${CSS.escape(fold.firstId)}"]`);
    if (!first) continue;
    let divider = transcript.querySelector(`.work-fold[data-key="${CSS.escape(fold.key)}"]`);
    if (!divider) {
      divider = document.createElement("div");
      divider.className = "work-fold";
      divider.dataset.key = fold.key;
      divider.innerHTML = `<button type="button" class="work-toggle"><span class="work-toggle-label"></span>${CHEVRON}</button>`;
    }
    if (divider.nextElementSibling !== first) first.before(divider);
    const open = openRows.has(fold.key);
    const button = divider.querySelector("button");
    button.setAttribute("aria-expanded", String(open));
    divider.querySelector(".work-toggle-label").textContent = fold.label;
  }
  for (const article of transcript.querySelectorAll(".msg.assistant")) {
    const fold = byItem.get(article.dataset.id);
    const folded = Boolean(fold) && !openRows.has(fold.key);
    const whole = folded && article.dataset.id !== fold.lastId;
    article.hidden = whole;
    for (const part of article.querySelectorAll(":scope > .part")) {
      part.hidden = folded && !whole && !(fold.answer && part.dataset.kind === "text");
    }
  }
}

transcript.addEventListener("click", (event) => {
  const button = event.target.closest?.(".work-toggle");
  if (!button) return;
  const key = button.parentElement.dataset.key;
  if (openRows.has(key)) openRows.delete(key);
  else openRows.add(key);
  drawFolds();
});

function drawChrome() {
  empty.hidden = (viewing ? viewing.items.length : items.size) > 0;
  liveDot.hidden = !busy || Boolean(viewing);
}

transcript.addEventListener(
  "toggle",
  (event) => {
    const key = event.target.dataset?.key;
    if (!key) return;
    if (event.target.open) openRows.add(key);
    else openRows.delete(key);
  },
  true,
);

// ---------------------------------------------------------------------------
// State

/** The status label is a live region: write it only when the phase changes. */
function setPhaseLabel(text) {
  if ($("status-label").textContent !== text) $("status-label").textContent = text;
}

/** Draw the title bar for the session the page shows. */
function drawTitle() {
  const session = viewing ? viewing.session : liveSession;
  const row = sessionList.groups.flatMap((group) => group.sessions).find((candidate) => candidate.id === session.id);
  const title = appMode && !shownId ? "ampi app" : session.title || "New thread";
  $("title").textContent = title;
  document.title = appMode && !shownId ? title : `${title} · ampi`;
  const cwd = session.cwd || "";
  $("cwd").textContent = cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
  $("cwd-chip").title = cwd;
  $("cwd-chip").setAttribute("aria-label", `Working directory ${cwd}`);
  $("cwd-chip").hidden = cwd === "";
  $("mode").textContent = session.mode ?? "";
  $("mode").hidden = !session.mode;
  $("mode").setAttribute("aria-label", session.mode ? `Mode ${session.mode}` : "Mode");
  const disc = $("title-disc");
  paintDisc(disc, session.id, row?.color ?? null);
  disc.dataset.busy = String(busy && !viewing);
  titlebar.setTarget(
    session.id ? { id: session.id, title, archived: row?.archived ?? false, live: !viewing, actions: sessionList.actions } : null,
  );
  sidebar.select(session.id);
}

function setSession(session) {
  liveSession = session;
  drawTitle();
}

function setStatus(status) {
  lastStatus = status;
  const settled = busy && !status.busy;
  busy = status.busy;
  app.dataset.busy = String(status.busy);
  app.dataset.phase = status.phase;
  const label = status.label || (status.phase === "idle" ? "Idle" : status.phase);
  setPhaseLabel(label);
  const details = [];
  if (status.detail) details.push(status.detail);
  if (status.queued > 0) details.push(`${status.queued} queued`);
  $("status-detail").textContent = details.join(" · ");
  composer.setStatus(status);
  sidebar.setBusy(status.busy);
  $("title-disc").dataset.busy = String(status.busy && !viewing);
  drawChrome();
  // A turn that ends folds its work.
  if (settled && !viewing) drawFolds();
}

function upsertItem(item) {
  // A message Pi ended early has a new id: it takes the streamed copy's place.
  if (item.replaces) {
    items.delete(item.replaces);
    const replaced = !viewing && transcript.querySelector(`[data-id="${CSS.escape(item.replaces)}"]`);
    if (replaced) replaced.dataset.id = item.id;
  }
  setItem(live, item);
  drawItem(item);
  // Calls that join a group begun in an earlier item are drawn by that item's group.
  const leaders = new Set();
  for (const part of item.parts ?? []) {
    const group = part.type === "tool" ? groupOf(live, part.toolCallId) : undefined;
    const leader = group && live.callItem.get(group.id);
    if (leader && leader !== item.id) leaders.add(leader);
  }
  drawItems(leaders);
}

function load(snapshot) {
  for (const map of Object.values(live)) map.clear();
  if (!viewing) transcript.replaceChildren();
  lastEventId = snapshot.lastEventId;
  setSession(snapshot.session);
  setGroups(live, snapshot.groups ?? []);
  for (const item of snapshot.items) upsertItem(item);
  setStatus(snapshot.status);
  if (!viewing) drawFolds();
  composer.setQueue(snapshot.queue);
}

const handlers = {
  status: (data) => setStatus(data),
  session: (data) => {
    // `ampi app` hands the session over to another process that opened its file.
    if (appMode && data.state) return handOver(data);
    setSession(data);
    refreshSessions();
  },
  item: (data) => {
    upsertItem(data);
    if (!viewing) drawFolds();
  },
  // `ampi app` warns when another process opened the session while its agent works.
  warning: (data) => notify(data.message),
  delta: (data) => {
    const item = items.get(data.itemId);
    const part = item?.parts?.[data.part];
    if (!part || (part.type !== "text" && part.type !== "thinking")) return;
    part.text += data.text;
    // Text streams in many small pieces; redraw each part once per frame.
    dirty.add(`${data.itemId}:${data.part}`);
    if (!frame) frame = requestAnimationFrame(flush);
  },
  tool: (data) => {
    const item = items.get(data.itemId);
    if (item?.type !== "assistant") return;
    const index = item.parts.findIndex((part) => part.type === "tool" && part.toolCallId === data.part.toolCallId);
    if (index < 0) return;
    item.parts[index] = data.part;
    // A call inside a group is drawn by the group, in the item of its first call.
    const group = groupOf(live, data.part.toolCallId);
    if (group) drawItems([live.callItem.get(group.id)]);
    else drawPart(item, index);
  },
  groups: (data) => {
    // Redraw the items that held or now hold a changed group's calls.
    const touched = new Set();
    const note = (group) => {
      if (group) for (const id of groupItemIds(live, group)) touched.add(id);
    };
    for (const id of data.removed) note(live.groups.get(id));
    for (const group of data.groups) note(live.groups.get(group.id));
    setGroups(live, data.groups, data.removed);
    for (const group of data.groups) note(group);
    drawItems(touched);
    if (!viewing) drawFolds();
  },
  turn_end: () => refreshSessions(),
  queue: (data) => composer.setQueue(data),
};

function flush() {
  frame = 0;
  withFollow(() => {
    for (const key of dirty) {
      const split = key.lastIndexOf(":");
      const item = items.get(key.slice(0, split));
      if (item) drawPart(item, Number(key.slice(split + 1)));
    }
    dirty.clear();
  });
}

function connect() {
  source?.close();
  const stream = new EventSource(`${base}events?after=${lastEventId}`);
  source = stream;
  for (const [name, handle] of Object.entries(handlers)) {
    stream.addEventListener(name, (event) => {
      lastEventId = Number(event.lastEventId) || lastEventId;
      withFollow(() => {
        handle(JSON.parse(event.data));
        drawChrome();
      });
    });
  }
  // The server no longer has the events we missed: start over from a snapshot.
  stream.addEventListener("reset", () => {
    stream.close();
    if (appMode) openSession(shownId, { keepScroll: true });
    else start();
  });
  stream.addEventListener("open", () => {
    if (lastStatus) setStatus(lastStatus);
    composer.setConnected(true);
  });
  stream.addEventListener("error", () => {
    // In app mode a stream the hub refused (409, 502) is closed for good: the
    // session is no longer the app's, so show it as it is now.
    if (appMode && stream.readyState === EventSource.CLOSED) {
      if (source === stream) openSession(shownId, { keepScroll: true });
      return;
    }
    // The browser retries on its own; Pi may have quit or switched sessions.
    setPhaseLabel("Disconnected");
    $("status-detail").textContent = "Waiting for Pi";
    app.dataset.busy = "false";
    app.dataset.phase = "disconnected";
    liveDot.hidden = true;
    composer.setConnected(false);
  });
}

// ---------------------------------------------------------------------------
// Sessions: the sidebar's list, and other sessions shown read-only

let listing;
let listAgain = false;

/** Reload the sidebar; calls while a request runs fold into one more. */
async function refreshSessions() {
  if (listing) {
    listAgain = true;
    return listing;
  }
  listing = (async () => {
    try {
      const response = await fetch("/api/sessions", { credentials: "same-origin" });
      if (!response.ok) return;
      sessionList = await response.json();
      sidebar.setData(sessionList);
      drawTitle();
      if (appMode) followHost();
    } catch {
      // The live view keeps working; the next refresh tries again.
    } finally {
      listing = undefined;
      if (listAgain) {
        listAgain = false;
        refreshSessions();
      }
    }
  })();
  return listing;
}

/** The session id in the address (`#/s/<id>`), or `null` for the live session. */
function routeId() {
  const match = /^#\/s\/([^/]+)$/.exec(location.hash);
  if (!match) return null;
  const id = decodeURIComponent(match[1]);
  return id === liveSession.id ? null : id;
}

function showLive() {
  if (!viewing) return;
  viewing = null;
  app.dataset.view = "live";
  composer.setEnabled(true);
  $("readonly-banner").hidden = true;
  transcript.replaceChildren();
  for (const item of items.values()) drawItem(item);
  drawFolds();
  drawTitle();
  drawChrome();
  chat.scrollTop = chat.scrollHeight;
  composer.focus();
}

async function showSession(id) {
  let view;
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { credentials: "same-origin" });
    view = response.ok ? await response.json() : undefined;
  } catch {}
  // The address may have moved on while the session loaded.
  if (routeId() !== id) return;
  if (!view) {
    notify("That session is not listed any more.");
    location.hash = "";
    return;
  }
  app.dataset.view = "readonly";
  composer.setEnabled(false);
  $("readonly-text").textContent = view.row.elsewhere
    ? "Another terminal runs this session: continue it there."
    : "This session is read-only here: open it in the terminal to continue.";
  $("readonly-banner").hidden = false;
  drawView(view);
  chat.scrollTop = 0;
  jump.hidden = atBottom();
  chat.focus({ preventScroll: true });
}

/** Draw a session read from its file (`{ session, items, groups }`) in place of the live transcript. */
function drawView(view) {
  viewing = view;
  viewing.transcript = createTranscript();
  setGroups(viewing.transcript, view.groups ?? []);
  for (const item of view.items) setItem(viewing.transcript, item);
  transcript.replaceChildren();
  for (const item of view.items) {
    const node = document.createElement("article");
    node.className = `msg ${item.type}`;
    node.dataset.id = item.id;
    node.setAttribute("aria-label", item.type === "user" ? "You" : "Assistant");
    node.innerHTML = itemHtml(viewing.transcript, item, openRows);
    transcript.append(node);
  }
  drawFolds();
  drawTitle();
  drawChrome();
}

function route() {
  const id = routeId();
  if (id) showSession(id);
  else showLive();
}

window.addEventListener("hashchange", () => {
  if (!appMode) route();
});
window.addEventListener("focus", () => refreshSessions());
// Relative times and other terminals' sessions change while the page is open.
const listTimer = setInterval(() => refreshSessions(), 60_000);

// ---------------------------------------------------------------------------
// App mode: every session at its own address, live when the app runs it

const EMPTY_TEXT = empty.textContent;
const HOME_TEXT = "Pick a session in the sidebar to read it or carry it on. A session nothing runs starts when you send it a message.";

function closeStream() {
  source?.close();
  source = undefined;
}

/** Offer the shown session as `next` (`live`, `home` or a `bannerFor` access), with that banner. */
function setAccess(next, banner = {}) {
  access = next;
  app.dataset.view = next === "held" || next === "gone" ? "readonly" : next;
  $("readonly-text").innerHTML = banner.html ?? "";
  $("readonly-banner").hidden = !banner.html;
  empty.textContent = next === "home" ? HOME_TEXT : EMPTY_TEXT;
  composer.setEnabled(next === "live" || next === "dormant");
  composer.setLocked(banner.reason ?? null);
  if (next !== "live") {
    busy = false;
    composer.setQueue(null);
    composer.setStatus({ busy: false, phase: "idle" });
    app.dataset.busy = "false";
    app.dataset.phase = "idle";
    $("status-detail").textContent = "";
  }
}

/** A session nothing runs: its transcript with the composer on, which starts it. */
function showDormant() {
  app.dataset.busy = "false";
  app.dataset.phase = "idle";
  setPhaseLabel("Not running");
  $("status-detail").textContent = "Sending a message starts it";
  composer.setConnected(true);
}

/** Show session `id` as the app has it now: live when the app runs it, else from its file. */
async function openSession(id, { keepScroll = false } = {}) {
  closeStream();
  const scroll = chat.scrollTop;
  shownId = id;
  base = sessionBase(true, id);
  let response;
  let body;
  try {
    response = await fetch(`${base}transcript`, { credentials: "same-origin" });
    body = await response.json().catch(() => undefined);
  } catch {}
  // The address may have moved on while the session loaded.
  if (shownId !== id) return;
  if (response?.status === 404) {
    notify("That session is not listed any more.");
    navigate(null, { replace: true });
    return;
  }
  if (!response) {
    setPhaseLabel("Disconnected");
    $("status-detail").textContent = "Could not reach ampi app";
    return;
  }
  const row = sessionList.groups.flatMap((group) => group.sessions).find((candidate) => candidate.id === id);
  if (!response.ok || !body) {
    // The worker that ran it stopped while the page asked (502).
    drawView({ session: { id, title: row?.title ?? "", cwd: row?.cwd ?? "", mode: null }, items: [], groups: [] });
    setAccess("gone", bannerFor(body, row?.title));
  } else if ("state" in body) {
    const banner = bannerFor(body.state, body.session.title);
    setAccess(banner.access, banner);
    drawView(body);
    if (banner.access === "dormant") showDormant();
    else setPhaseLabel(banner.access === "imported" ? "Imported" : "Read-only");
  } else {
    viewing = null;
    setAccess("live");
    withFollow(() => load(body));
    connect();
  }
  chat.scrollTop = keepScroll ? scroll : chat.scrollHeight;
  jump.hidden = atBottom();
  if (keepScroll) return;
  if (access === "live" || access === "dormant") composer.focus();
  else chat.focus({ preventScroll: true });
}

/**
 * The list says the shown session started or stopped running elsewhere
 * (a start that outlasted the send's wait, a terminal that quit): show it
 * as it is now.
 */
function followHost() {
  const row = sessionList.groups.flatMap((group) => group.sessions).find((candidate) => candidate.id === shownId);
  if (!row) return;
  if ((access === "dormant" && row.host) || (access === "held" && !row.host)) openSession(shownId, { keepScroll: true });
}

/** Another process opened the live session: keep what is drawn, where it is, read-only. */
function handOver(state) {
  closeStream();
  viewing = { session: liveSession, items: [...items.values()], groups: [], transcript: live };
  const banner = bannerFor(state, liveSession.title);
  setAccess(banner.access, banner);
  setPhaseLabel("Read-only");
  drawFolds();
  drawTitle();
  drawChrome();
  refreshSessions();
}

function showHome() {
  closeStream();
  shownId = null;
  base = sessionBase(true, null);
  viewing = null;
  for (const map of Object.values(live)) map.clear();
  liveSession = { id: "", title: "", cwd: "", mode: null };
  transcript.replaceChildren();
  setAccess("home");
  drawTitle();
  drawChrome();
}

function showRoute(id) {
  if (id) openSession(id);
  else showHome();
}

/** Go to a session's address (or the home page) and show it; Back and Forward return. */
function navigate(id, { replace = false } = {}) {
  if (replace) history.replaceState(historyState(id), "", appPath(id));
  else history.pushState(historyState(id), "", appPath(id));
  showRoute(id);
}

window.addEventListener("popstate", (event) => {
  if (appMode) showRoute(routeFromHistory(event.state, location.pathname));
});

$("session-list").addEventListener("click", (event) => {
  const row = appMode && event.target.closest?.("a.session-row");
  // A click with a modifier opens the row's address in a new tab, as for any link.
  if (!row || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (row.dataset.id !== shownId) navigate(row.dataset.id);
  else if (access === "gone") openSession(shownId);
});

async function startApp() {
  appMode = true;
  clearInterval(listTimer);
  sidebar.useAppMode();
  app.querySelector(".banner-link").hidden = true;
  history.scrollRestoration = "manual";
  // The list follows the hosts every few seconds while the page is in view, and at once when the hub announces a change.
  const refresher = createRefresher({
    run: () => refreshSessions(),
    everyMs: APP_LIST_REFRESH_MS,
    visible: () => document.visibilityState === "visible",
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle),
  });
  document.addEventListener("visibilitychange", () => refresher.visibilityChanged());
  refresher.start();
  new EventSource("/api/events").addEventListener("sessions", () => refreshSessions());
  refreshSessions();
  navigate(parseAppPath(location.pathname)?.id ?? null, { replace: true });
}

/** Whether `ampi app` serves this page: a session server answers 404. */
async function isApp() {
  try {
    const response = await fetch("/api/app", { credentials: "same-origin" });
    return response.ok && (await response.json()).app === true;
  } catch {
    return false;
  }
}

async function start() {
  try {
    const response = await fetch("/api/transcript", { credentials: "same-origin" });
    if (!response.ok) throw new Error(String(response.status));
    const snapshot = await response.json();
    withFollow(() => load(snapshot));
    chat.scrollTop = chat.scrollHeight;
    jump.hidden = true;
    connect();
    composer.focus();
    refreshSessions();
    if (routeId()) route();
  } catch {
    setPhaseLabel("Disconnected");
    $("status-detail").textContent = "Could not reach Pi";
  }
}

if (await isApp()) startApp();
else start();
