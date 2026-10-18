// The ampi web GUI client: loads the transcript, follows the live event
// stream and draws both. Plain ES module, no framework.

import { escapeHtml, renderMarkdown } from "./markdown.js";

const $ = (id) => document.getElementById(id);
const app = document.querySelector(".app");
const chat = $("chat");
const transcript = $("transcript");
const liveDot = $("live-dot");
const empty = $("empty");
const jump = $("jump");

/** Items by id, in transcript order. */
const items = new Map();
/** Rows the user opened, by key, so redraws keep them open. */
const openRows = new Set();
let lastEventId = 0;
let source;
let busy = false;
let lastStatus;
/** Parts whose text grew since the last frame, as `itemId:index`. */
const dirty = new Set();
let frame = 0;

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

chat.addEventListener("scroll", () => {
  jump.hidden = atBottom();
});
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

const CHEVRON = '<svg class="icon chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';

function titleHtml(parts) {
  return parts.map((part) => `<span class="part-${escapeHtml(part.role)}">${escapeHtml(part.text)}</span>`).join("");
}

function rowHtml(key, status, line, body) {
  if (!body) return `<div class="row" data-status="${status}"><div class="row-line">${CHEVRON}<span class="row-text">${line}</span></div></div>`;
  const open = openRows.has(key) ? " open" : "";
  return `<details class="row" data-status="${status}" data-key="${escapeHtml(key)}"${open}><summary>${CHEVRON}<span class="row-text">${line}</span></summary><div class="row-body">${body}</div></details>`;
}

function toolHtml(part) {
  const output = part.output ? `<pre class="tool-output">${escapeHtml(part.output)}${part.outputTruncated ? "\n…" : ""}</pre>` : "";
  return rowHtml(`tool:${part.toolCallId}`, part.status, titleHtml(part.title), output);
}

function partHtml(item, part, index) {
  if (part.type === "text") return part.text.trim() ? `<div class="prose">${renderMarkdown(part.text)}</div>` : "";
  if (part.type === "thinking") {
    if (part.redacted) return rowHtml("", "done", '<span class="part-muted">Thinking (hidden by the provider)</span>', "");
    const body = part.text.trim() ? `<div class="thinking-text">${escapeHtml(part.text.trim())}</div>` : "";
    return rowHtml(`thinking:${item.id}:${index}`, "done", '<span class="part-muted">Thinking</span>', body);
  }
  if (part.type === "tool") return toolHtml(part);
  return "";
}

function itemHtml(item) {
  if (item.type === "user") {
    const images = item.images > 0 ? `<div class="attachments">${item.images === 1 ? "1 image" : `${item.images} images`}</div>` : "";
    return `<div class="bubble">${escapeHtml(item.text)}</div>${images}`;
  }
  const parts = item.parts.map((part, index) => `<div class="part" data-part="${index}">${partHtml(item, part, index)}</div>`).join("");
  const stopped = item.stopReason === "aborted" ? '<p class="msg-error">Interrupted</p>' : "";
  const error = item.error && item.stopReason !== "aborted" ? `<p class="msg-error">${escapeHtml(item.error)}</p>` : "";
  return parts + stopped + error;
}

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
  itemNode(item).innerHTML = itemHtml(item);
}

function drawPart(item, index) {
  const node = itemNode(item).querySelector(`[data-part="${index}"]`);
  if (node) node.innerHTML = partHtml(item, item.parts[index], index);
  else drawItem(item);
}

function drawChrome() {
  empty.hidden = items.size > 0;
  liveDot.hidden = !busy;
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

function setSession(session) {
  $("title").textContent = session.title || "New thread";
  document.title = `${session.title || "New thread"} · ampi`;
  const cwd = session.cwd || "";
  $("cwd").textContent = cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
  $("cwd-chip").title = cwd;
  $("cwd-chip").hidden = cwd === "";
  $("mode").textContent = session.mode ?? "";
  $("mode").hidden = !session.mode;
  $("mode").setAttribute("aria-label", session.mode ? `Mode ${session.mode}` : "Mode");
}

function setStatus(status) {
  lastStatus = status;
  busy = status.busy;
  app.dataset.busy = String(status.busy);
  app.dataset.phase = status.phase;
  const label = status.label || (status.phase === "idle" ? "Idle" : status.phase);
  $("status-label").textContent = label;
  const details = [];
  if (status.detail) details.push(status.detail);
  if (status.queued > 0) details.push(`${status.queued} queued`);
  $("status-detail").textContent = details.join(" · ");
  drawChrome();
}

function upsertItem(item) {
  items.set(item.id, item);
  drawItem(item);
}

function load(snapshot) {
  items.clear();
  transcript.replaceChildren();
  lastEventId = snapshot.lastEventId;
  setSession(snapshot.session);
  for (const item of snapshot.items) upsertItem(item);
  setStatus(snapshot.status);
}

const handlers = {
  status: (data) => setStatus(data),
  session: (data) => setSession(data),
  item: (data) => upsertItem(data),
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
    drawPart(item, index);
  },
  turn_end: () => {},
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
  source = new EventSource(`/api/events?after=${lastEventId}`);
  for (const [name, handle] of Object.entries(handlers)) {
    source.addEventListener(name, (event) => {
      lastEventId = Number(event.lastEventId) || lastEventId;
      withFollow(() => {
        handle(JSON.parse(event.data));
        drawChrome();
      });
    });
  }
  // The server no longer has the events we missed: start over from a snapshot.
  source.addEventListener("reset", () => {
    source.close();
    start();
  });
  source.addEventListener("open", () => {
    if (lastStatus) setStatus(lastStatus);
  });
  source.addEventListener("error", () => {
    // The browser retries on its own; Pi may have quit or switched sessions.
    $("status-label").textContent = "Disconnected";
    $("status-detail").textContent = "Waiting for Pi";
    app.dataset.busy = "false";
    liveDot.hidden = true;
  });
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
  } catch {
    $("status-label").textContent = "Disconnected";
    $("status-detail").textContent = "Could not reach Pi";
  }
}

start();
