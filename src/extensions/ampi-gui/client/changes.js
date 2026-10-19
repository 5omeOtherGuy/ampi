// The right pane's Changes tab: the files that differ in the shown session's
// Git checkout (GET /api/changes, see changes.ts), by section, with a
// toolbar to review them, pick the range, read the totals, change the order
// and refresh. The list loads while the tab is in view, again when an edit,
// write or shell tool call of the session ends (once per burst, after
// REFETCH_MS) and when the window gets focus back. The helpers above
// `mountChanges` are pure, so tests load them in Node.

import { escapeHtml } from "./app-mode.js";

/** How long the list waits after a tool call that may have changed files, so a burst refetches once. */
export const REFETCH_MS = 500;

/** Tools whose end may change files in the checkout. */
const CHANGING_TOOLS = new Set(["edit", "write", "bash", "apply_patch"]);

/** The status badges' words. */
export const STATUS_WORDS = { A: "Added", M: "Modified", D: "Deleted", R: "Renamed" };

/** The orders the toolbar's toggle steps between: by path, or the most changed lines first. */
export const ORDERS = ["path", "churn"];

/** Whether a `tool` event's part is a call that may have changed files and has ended. */
export function changesRefetchFor(part) {
  return part?.type === "tool" && CHANGING_TOOLS.has(part.name) && part.status !== "running";
}

/** The request for session `sessionId`'s changes in `range`. */
export function changesUrl(sessionId, range) {
  return `/api/changes?${new URLSearchParams({ sessionId, range })}`;
}

/** A path as the row shows it: the file's name, then its directory (empty at the root). */
export function splitChangePath(file) {
  const slash = file.lastIndexOf("/");
  return slash < 0 ? { name: file, dir: "" } : { name: file.slice(slash + 1), dir: file.slice(0, slash) };
}

/** A section's files in `order`: by path, or by changed lines (added plus removed), most first, then by path. */
export function orderChangedFiles(files, order) {
  const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const churn = (file) => file.added + file.removed;
  return [...files].sort(order === "churn" ? (a, b) => churn(b) - churn(a) || byPath(a, b) : byPath);
}

/** `+N` and `-M`, each only when not zero, or `binary`. */
function statHtml(file) {
  if (file.binary) return '<span class="change-binary">binary</span>';
  const parts = [];
  if (file.added > 0) parts.push(`<span class="change-added">+${file.added}</span>`);
  if (file.removed > 0) parts.push(`<span class="change-removed">-${file.removed}</span>`);
  return parts.join(" ");
}

const CHEVRON = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>';
const MORE =
  '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle class="fill" cx="3.5" cy="8" r="1.1"/><circle class="fill" cx="8" cy="8" r="1.1"/><circle class="fill" cx="12.5" cy="8" r="1.1"/></svg>';

/**
 * One file's row: a chevron, the name in bold and the directory muted, the
 * changed lines, the status badge and a ⋯ button. Every part of the path is
 * escaped; `section` and `index` find the file again.
 */
export function changeFileHtml(file, { section, index }) {
  const { name, dir } = splitChangePath(file.path);
  const word = STATUS_WORDS[file.status] ?? file.status;
  const title = file.oldPath ? `${file.path}\n${word} from ${file.oldPath}` : file.path;
  return (
    `<li class="change-row" data-section="${escapeHtml(section)}" data-index="${index}">` +
    `<span class="change-chevron" aria-hidden="true">${CHEVRON}</span>` +
    `<span class="change-name" title="${escapeHtml(title)}"><span class="change-file">${escapeHtml(name)}</span>${dir ? ` <span class="change-dir">${escapeHtml(dir)}</span>` : ""}</span>` +
    `<span class="change-stat">${statHtml(file)}</span>` +
    `<span class="change-badge" data-status="${escapeHtml(file.status)}" title="${escapeHtml(word)}">${escapeHtml(file.status)}</span>` +
    `<button class="icon-button change-more" type="button" aria-haspopup="menu" aria-label="${escapeHtml(`Actions for ${file.path}`)}" title="More">${MORE}</button>` +
    "</li>"
  );
}

/** The sections, each a small uppercase heading over its list of rows, files in `order`. */
export function changesSectionsHtml(sections, order) {
  return sections
    .map((section) => {
      const id = `changes-section-${section.id}`;
      const rows = orderChangedFiles(section.files, order).map((file) => changeFileHtml(file, { section: section.id, index: section.files.indexOf(file) }));
      return (
        `<section class="changes-section" aria-labelledby="${id}"><h3 class="changes-section-label" id="${id}">${escapeHtml(section.label)}</h3>` +
        `<ul class="changes-files">${rows.join("")}</ul></section>`
      );
    })
    .join("");
}

/** The totals as `+N`, `-M` and `~K` (K files), with a sentence that says so. */
export function changesTotals(totals) {
  const files = totals.files === 1 ? "1 file" : `${totals.files} files`;
  const lines = (count) => (count === 1 ? "1 line" : `${count} lines`);
  return {
    html: `<span class="change-added">+${totals.added}</span> <span class="change-removed">-${totals.removed}</span> <span class="change-files">~${totals.files}</span>`,
    title: `${lines(totals.added)} added and ${lines(totals.removed)} removed, in ${files}`,
  };
}

/** What the list says instead of rows, or `null` when it has rows: loading, an error, outside a checkout, nothing changed. */
export function changesEmptyText(state) {
  if (state.error) return state.error;
  if (!state.data) return "Loading…";
  if (!state.data.repo) return "Not a Git checkout";
  return state.data.sections.length === 0 ? "No changes" : null;
}

/** Run the latest call once `ms` have passed without another; timers are injected so tests can run them. */
export function createDebouncer({ ms, setTimer, clearTimer }) {
  let timer = null;
  return {
    call(callback) {
      if (timer !== null) clearTimer(timer);
      timer = setTimer(() => {
        timer = null;
        callback();
      }, ms);
    },
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Page wiring

/**
 * Mount the Changes tab in `root`. `review()` runs Review; `visible()` says
 * whether the tab is in view, and `shown()` is called when it comes into view.
 */
export function mountChanges({ root, notify, review, visible, setTimer = (callback, ms) => setTimeout(callback, ms), clearTimer = (handle) => clearTimeout(handle) }) {
  const $ = (id) => document.getElementById(id);
  const list = $("changes-list");
  const empty = $("changes-empty");
  const emptyText = $("changes-empty-text");
  const note = $("changes-note");
  const totals = $("changes-totals");
  const rangeSelect = $("changes-range");
  const orderButton = $("changes-order");
  const reviewButton = $("changes-review");
  const menu = $("changes-menu");

  let sessionId = null;
  let range = "uncommitted";
  let order = "path";
  let data = null;
  let error = null;
  let request = 0;
  /** The row whose menu is open, to give focus back. */
  let menuFor = null;
  const debounce = createDebouncer({ ms: REFETCH_MS, setTimer, clearTimer });

  function drawRanges() {
    const ranges = data?.repo ? data.ranges : [{ id: "uncommitted", label: "Uncommitted" }];
    rangeSelect.replaceChildren(
      ...ranges.map((entry) => {
        const option = document.createElement("option");
        option.value = entry.id;
        option.textContent = entry.label;
        return option;
      }),
    );
    rangeSelect.value = range;
    rangeSelect.disabled = !data?.repo;
  }

  function draw() {
    closeMenu();
    const text = changesEmptyText({ data, error });
    empty.hidden = text === null;
    emptyText.textContent = text ?? "";
    empty.dataset.kind = error ? "error" : !data ? "loading" : !data.repo ? "outside" : "clean";
    list.innerHTML = text === null ? changesSectionsHtml(data.sections, order) : "";
    const shownTotals = changesTotals(data?.totals ?? { added: 0, removed: 0, files: 0 });
    totals.innerHTML = shownTotals.html;
    totals.title = shownTotals.title;
    totals.hidden = !data?.repo || text !== null;
    note.hidden = !data?.truncated;
    note.textContent = data?.truncated ? `Showing the first ${data.totals.files} files.` : "";
    const churn = order === "churn";
    orderButton.setAttribute("aria-pressed", String(churn));
    orderButton.title = churn ? "Order: most changed first" : "Order: by path";
    drawRanges();
  }

  async function load() {
    if (!sessionId) return;
    debounce.cancel();
    const mine = ++request;
    const id = sessionId;
    root.setAttribute("aria-busy", "true");
    let answer;
    let failure = null;
    try {
      const response = await fetch(changesUrl(id, range), { credentials: "same-origin" });
      answer = await response.json().catch(() => undefined);
      if (!response.ok) failure = answer?.error ?? "Could not read the changes.";
    } catch {
      failure = "Could not reach Pi.";
    }
    // A newer request, or another session, owns the list.
    if (mine !== request || id !== sessionId) return;
    root.removeAttribute("aria-busy");
    error = failure;
    if (!failure) {
      data = answer;
      // A range the checkout does not have answers as Uncommitted.
      range = data.range;
    }
    draw();
  }

  /** Load now when the tab is in view; otherwise it loads when it comes into view. */
  function refresh() {
    if (visible()) load();
  }

  function closeMenu({ focus = false } = {}) {
    if (menu.hidden) return;
    menu.hidden = true;
    menuFor?.removeAttribute("aria-expanded");
    if (focus) menuFor?.focus();
    menuFor = null;
  }

  function fileOf(row) {
    const section = data?.sections.find((candidate) => candidate.id === row.dataset.section);
    return section?.files[Number(row.dataset.index)];
  }

  async function copyPath(file) {
    try {
      await navigator.clipboard.writeText(file.path);
      notify("Copied the path");
    } catch {
      notify("The browser did not allow copying to the clipboard.");
    }
  }

  function openMenu(button) {
    const file = fileOf(button.closest(".change-row"));
    if (!file) return;
    const item = document.createElement("button");
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.textContent = "Copy Path";
    item.addEventListener("click", () => {
      closeMenu({ focus: true });
      copyPath(file);
    });
    menu.replaceChildren(item);
    menuFor = button;
    button.setAttribute("aria-expanded", "true");
    menu.hidden = false;
    const rect = button.getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.right - box.width, window.innerWidth - box.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - box.height - 8))}px`;
    item.focus();
  }

  list.addEventListener("click", (event) => {
    const button = event.target.closest?.(".change-more");
    if (!button) return;
    if (menuFor === button) closeMenu({ focus: true });
    else openMenu(button);
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu({ focus: true });
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!menu.hidden && !menu.contains(event.target) && event.target !== menuFor && !menuFor?.contains(event.target)) closeMenu();
  });
  list.addEventListener("scroll", () => closeMenu(), true);

  rangeSelect.addEventListener("change", () => {
    range = rangeSelect.value;
    load();
  });
  orderButton.addEventListener("click", () => {
    order = ORDERS[(ORDERS.indexOf(order) + 1) % ORDERS.length];
    draw();
  });
  $("changes-refresh").addEventListener("click", () => load());
  reviewButton.addEventListener("click", () => review());
  window.addEventListener("focus", () => refresh());

  draw();

  return {
    /** The shown session's id, or `null`: a new one starts over from Uncommitted. */
    setSession(id) {
      if (id === sessionId) return;
      sessionId = id;
      range = "uncommitted";
      data = null;
      error = null;
      request++;
      debounce.cancel();
      draw();
      refresh();
    },
    /** The tab came into view: load the list. */
    shown: () => load(),
    /** A `tool` event of the shown session: a call that may have changed files and ended refetches, once per burst. */
    toolEvent(part) {
      if (changesRefetchFor(part)) debounce.call(refresh);
    },
    /** Whether the shown session takes a review; `reason` is why not. */
    setReviewable(reviewable, reason = "") {
      reviewButton.disabled = !reviewable;
      reviewButton.title = reviewable ? "Review the uncommitted changes" : reason;
    },
  };
}
