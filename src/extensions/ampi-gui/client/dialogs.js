// Questions extensions ask in a session `ampi app` runs (a tool approval, a
// choice, a line of text): the server sends each as a `dialog` event and
// lists the open ones in the snapshot; the page shows one at a time as a
// modal and posts the answer to `dialog`. `dialogHtml` and `moveActive` are
// pure, so tests load them in Node without a DOM.

import { escapeHtml } from "./app-mode.js";

/** The modal's inside for a question, every string escaped. */
export function dialogHtml(dialog) {
  const parts = [`<h2 id="ask-title">${escapeHtml(dialog.title || "Question")}</h2>`];
  if (dialog.kind === "confirm" && dialog.message) parts.push(`<p class="ask-message">${escapeHtml(dialog.message)}</p>`);
  if (dialog.kind === "select") {
    const options = dialog.options.map(
      (option, index) =>
        `<li role="option" id="ask-option-${index}" data-index="${index}" aria-selected="${index === 0}">${escapeHtml(option)}</li>`,
    );
    parts.push(
      `<ul class="ask-options" id="ask-field" role="listbox" tabindex="0" aria-labelledby="ask-title"${dialog.options.length > 0 ? ' aria-activedescendant="ask-option-0"' : ""}>${options.join("")}</ul>`,
    );
  } else if (dialog.kind === "input") {
    const placeholder = dialog.placeholder ? ` placeholder="${escapeHtml(dialog.placeholder)}"` : "";
    parts.push(`<input id="ask-field" type="text" aria-labelledby="ask-title" autocomplete="off" spellcheck="false"${placeholder}>`);
  } else if (dialog.kind === "editor") {
    parts.push(`<textarea id="ask-field" rows="8" aria-labelledby="ask-title" spellcheck="false">${escapeHtml(dialog.initial ?? "")}</textarea>`);
  }
  parts.push('<p class="ask-error" role="alert" hidden></p>');
  const [cancel, submit] = dialog.kind === "confirm" ? ["No", "Yes"] : ["Cancel", dialog.kind === "select" ? "Choose" : "OK"];
  parts.push(
    `<div class="dialog-actions"><button class="button" type="button" data-answer="cancel">${cancel}</button><button class="button primary" type="button" data-answer="submit">${submit}</button></div>`,
  );
  return parts.join("");
}

/** The option a list key moves to from `index` among `count`, or `index` for other keys. */
export function moveActive(key, index, count) {
  if (count === 0) return index;
  if (key === "ArrowDown") return Math.min(index + 1, count - 1);
  if (key === "ArrowUp") return Math.max(index - 1, 0);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return index;
}

/** Words for a question that closed while it was shown, by who closed it; the page's own answer needs none. */
const CLOSED = {
  timeout: "The question timed out and was cancelled.",
  abort: "The extension withdrew its question.",
  shutdown: "The session ended; the question was cancelled.",
};

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex='0']";

/**
 * Wire the modal. `post(route, body)` resolves `{ ok, status, body }`;
 * `notify(text)` shows a toast. The returned object takes the snapshot's
 * list (`load`) and the `dialog` and `dialog_closed` events.
 */
export function mountDialogs({ dialog, post, notify }) {
  /** The open questions, oldest first; the first one is shown. */
  let queue = [];
  /** The id of the question in the modal. */
  let shown = null;
  let sending = false;
  let active = 0;
  /** Where focus was before the modal opened. */
  let returnFocus = null;

  const field = () => dialog.querySelector("#ask-field");
  const current = () => queue.find((entry) => entry.id === shown);

  function setActive(index) {
    const list = field();
    const options = [...list.querySelectorAll('[role="option"]')];
    if (options.length === 0) return;
    active = index;
    for (const [i, option] of options.entries()) option.setAttribute("aria-selected", String(i === index));
    list.setAttribute("aria-activedescendant", options[index].id);
    options[index].scrollIntoView({ block: "nearest" });
  }

  function hide() {
    shown = null;
    if (dialog.open) dialog.close();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  }

  /** Show the oldest open question, or close the modal when there is none. */
  function render() {
    const next = queue[0];
    if (!next) return hide();
    if (shown === next.id) return;
    shown = next.id;
    sending = false;
    active = 0;
    dialog.innerHTML = dialogHtml(next);
    if (!dialog.open) {
      returnFocus = document.activeElement;
      dialog.showModal();
    }
    const input = field();
    const target = input ?? dialog.querySelector('[data-answer="submit"]');
    target.focus();
    if (input?.tagName === "TEXTAREA") input.setSelectionRange(input.value.length, input.value.length);
  }

  function drop(id) {
    queue = queue.filter((entry) => entry.id !== id);
    if (shown === id) shown = null;
    render();
  }

  async function answer(body) {
    const entry = current();
    if (!entry || sending) return;
    sending = true;
    for (const button of dialog.querySelectorAll("button")) button.disabled = true;
    const result = await post("dialog", { id: entry.id, ...body });
    // 409: closed meanwhile (another page answered, or it timed out); its dialog_closed event follows.
    if (result.ok || result.status === 409) return drop(entry.id);
    if (shown !== entry.id) return;
    sending = false;
    for (const button of dialog.querySelectorAll("button")) button.disabled = false;
    const error = dialog.querySelector(".ask-error");
    error.textContent = result.body?.error ?? "Pi did not take that answer.";
    error.hidden = false;
  }

  function submit() {
    const entry = current();
    if (!entry) return;
    if (entry.kind === "confirm") return answer({ value: true });
    if (entry.kind === "select") {
      if (entry.options.length === 0) return answer({ cancelled: true });
      return answer({ value: entry.options[active] });
    }
    return answer({ value: field().value });
  }

  dialog.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-answer]");
    if (button) {
      if (button.dataset.answer === "submit") submit();
      else if (current()?.kind === "confirm") answer({ value: false });
      else answer({ cancelled: true });
      return;
    }
    const option = event.target.closest?.('[role="option"]');
    if (option) setActive(Number(option.dataset.index));
  });
  dialog.addEventListener("dblclick", (event) => {
    if (event.target.closest?.('[role="option"]')) submit();
  });

  dialog.addEventListener("keydown", (event) => {
    // The page's own shortcuts (Esc Esc, the sidebar's keys) stay out while a question is open.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      answer({ cancelled: true });
    } else if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      // A focused button answers with its own word.
      if (event.target.tagName === "BUTTON") return;
      event.preventDefault();
      submit();
    } else if (event.key === "Tab") {
      // Focus stays in the modal: Tab past the last control comes back to the first.
      const controls = [...dialog.querySelectorAll(FOCUSABLE)];
      if (controls.length === 0) return;
      const index = controls.indexOf(document.activeElement);
      const next = event.shiftKey ? (index <= 0 ? controls.length - 1 : index - 1) : index === controls.length - 1 ? 0 : index + 1;
      event.preventDefault();
      controls[next].focus();
    } else if (event.target.getAttribute?.("role") === "listbox") {
      const count = event.target.querySelectorAll('[role="option"]').length;
      const next = moveActive(event.key, active, count);
      if (next !== active || ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        setActive(next);
      }
    }
  });
  // The browser's own close request (Esc on some platforms) is a cancel too.
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    answer({ cancelled: true });
  });

  return {
    /** The snapshot's open questions; `null` or an empty list closes the modal. */
    load(list) {
      queue = Array.isArray(list) ? [...list] : [];
      if (shown !== null && !queue.some((entry) => entry.id === shown)) shown = null;
      render();
    },
    add(entry) {
      if (!queue.some((open) => open.id === entry.id)) queue.push(entry);
      render();
    },
    closed({ id, answeredBy }) {
      if (shown === id && CLOSED[answeredBy]) notify(CLOSED[answeredBy]);
      drop(id);
    },
  };
}
