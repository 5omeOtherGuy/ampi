// The Search Threads dialog (Mod+Shift+K, or the sidebar's search button):
// a query in ampi's session search language, answered by GET /api/search,
// with the sessions that match as a list to pick from. Up and Down move,
// Enter opens, Esc closes. The helpers before `mountThreadSearch` are pure,
// so tests load them in Node.

import { escapeHtml } from "./app-mode.js";
import { ageLabel, appliedNote, discHtml, paintDiscs } from "./activity.js";

/** Where the query syntax is described. */
export const SEARCH_SYNTAX_URL = "https://github.com/5omeOtherGuy/ampi/blob/main/src/extensions/ampi-gui/README.md#search-syntax";

/** The badges after a result's age: Archived, Snoozed (when not archived) and Live (a running Pi has it open). */
export function resultBadges(result) {
  const badges = [];
  if (result.archived) badges.push("Archived");
  else if (result.snoozed) badges.push("Snoozed");
  if (result.live || result.elsewhere || result.host) badges.push("Live");
  return badges;
}

/** The selection after an arrow key: it stops at either end; `-1` with nothing to select. */
export function stepSelection(index, step, count) {
  if (count === 0) return -1;
  return Math.max(0, Math.min(count - 1, index + step));
}

/** One result: the title with the project on the right, the age and badges, and a two-line preview. Every value is escaped. */
export function searchResultHtml(result, { index, selected, href, now }) {
  const badges = resultBadges(result)
    .map((badge) => `<span class="badge" data-badge="${badge.toLowerCase()}">${badge}</span>`)
    .join("");
  const preview = result.preview ? `<span class="search-preview">${escapeHtml(result.preview)}</span>` : "";
  return (
    `<a class="search-result" role="option" id="search-option-${index}" href="${escapeHtml(href)}" data-id="${escapeHtml(result.id)}" aria-selected="${selected}" tabindex="-1">` +
    `<span class="search-result-head">${discHtml(result)}<span class="search-title">${escapeHtml(result.title)}</span><span class="search-project">${escapeHtml(result.project)}</span></span>` +
    `<span class="search-meta"><time datetime="${escapeHtml(result.modified)}">${escapeHtml(ageLabel(result.modified, now))}</time>${badges}</span>` +
    `${preview}</a>`
  );
}

// ---------------------------------------------------------------------------
// Page wiring

/** How long the field waits after the last key before it searches. */
const TYPING_MS = 150;

/** Wire the dialog. `onOpen(id)` shows a session; `sessionHref(id)` is a result's address. */
export function mountThreadSearch({ dialog, onOpen, sessionHref, now = () => Date.now() }) {
  const $ = (id) => document.getElementById(id);
  const input = $("search-input");
  const list = $("search-results");
  const note = $("search-note");
  const empty = $("search-empty");
  $("search-syntax").href = SEARCH_SYNTAX_URL;

  let results = [];
  let selected = -1;
  let request = 0;
  /** The request whose answer the list shows. */
  let shown = 0;
  let typing = 0;
  /** Enter came before the answer to the current text: open its top result when it arrives. */
  let openOnAnswer = false;
  let returnFocus = null;

  function select(index) {
    selected = index;
    for (const node of list.querySelectorAll('[role="option"]')) node.setAttribute("aria-selected", String(node.id === `search-option-${index}`));
    const node = index >= 0 ? $(`search-option-${index}`) : null;
    if (node) {
      input.setAttribute("aria-activedescendant", node.id);
      node.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }

  function draw(answer) {
    results = answer.results;
    list.innerHTML = results.map((result, index) => searchResultHtml(result, { index, selected: index === 0, href: sessionHref(result.id), now: now() })).join("");
    paintDiscs(list);
    const text = appliedNote(answer.applied);
    note.textContent = text;
    note.hidden = text === "";
    empty.hidden = results.length > 0;
    select(results.length > 0 ? 0 : -1);
  }

  async function search() {
    const mine = ++request;
    let answer;
    try {
      const params = new URLSearchParams({ q: input.value, limit: "50" });
      const response = await fetch(`/api/search?${params}`, { credentials: "same-origin" });
      answer = await response.json().catch(() => undefined);
      if (!response.ok || !answer) answer = { applied: null, results: [], error: answer?.error ?? "Could not search." };
    } catch {
      answer = { applied: null, results: [], error: "Could not reach Pi." };
    }
    if (mine !== request || !dialog.open) return;
    shown = mine;
    draw(answer);
    if (answer.error) {
      note.textContent = answer.error;
      note.hidden = false;
    }
    if (openOnAnswer) {
      openOnAnswer = false;
      if (results[0]) open(results[0].id);
    }
  }

  function open(id) {
    // The session's page takes focus, not what had it before the dialog.
    returnFocus = null;
    dialog.close();
    onOpen(id);
  }

  input.addEventListener("input", () => {
    openOnAnswer = false;
    clearTimeout(typing);
    typing = setTimeout(() => {
      typing = 0;
      search();
    }, TYPING_MS);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      select(stepSelection(selected, event.key === "ArrowDown" ? 1 : -1, results.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (typing || shown !== request) {
        // The list is for earlier text: search now and open the top result of the answer.
        openOnAnswer = true;
        if (typing) {
          clearTimeout(typing);
          typing = 0;
          search();
        }
        return;
      }
      const result = results[selected];
      if (result) open(result.id);
    }
  });
  list.addEventListener("click", (event) => {
    const row = event.target.closest?.("a.search-result");
    if (!row || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    open(row.dataset.id);
  });
  list.addEventListener("pointermove", (event) => {
    const row = event.target.closest?.("a.search-result");
    const index = row ? Number(row.id.slice("search-option-".length)) : -1;
    if (row && index !== selected) select(index);
  });
  $("search-close").addEventListener("click", () => dialog.close());
  // A click on the backdrop closes it.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => {
    clearTimeout(typing);
    typing = 0;
    openOnAnswer = false;
    request++;
    returnFocus?.focus?.();
    returnFocus = null;
  });

  return {
    /** Open the dialog with the field empty and the latest sessions listed. */
    open() {
      if (dialog.open) return input.select();
      returnFocus = document.activeElement;
      input.value = "";
      list.replaceChildren();
      note.hidden = true;
      empty.hidden = true;
      dialog.showModal();
      input.focus();
      search();
    },
  };
}
