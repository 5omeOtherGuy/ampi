// The floating controls at the bottom right of the chat column, above the
// composer: the conversation outline, which lists the messages you wrote and
// scrolls to one, and the jump button's unread dot. The row model and the
// unread rule are pure, so tests run them without a browser; `mountOutline`
// wires the popover to the page.

import { ageLabel } from "./activity.js";
import { messageAnchorId } from "./transcript.js";

/** Longest first line an outline row shows, in characters, before its ellipsis. */
export const OUTLINE_TEXT_MAX = 80;

/** A message's first line with an ellipsis when more of it follows, cut to OUTLINE_TEXT_MAX. */
function firstLine(item) {
  const lines = String(item.text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return item.images > 0 ? (item.images === 1 ? "1 image" : `${item.images} images`) : "";
  const chars = [...lines[0]];
  if (chars.length > OUTLINE_TEXT_MAX) return `${chars.slice(0, OUTLINE_TEXT_MAX - 1).join("").trimEnd()}…`;
  return lines.length > 1 ? `${lines[0]}…` : lines[0];
}

/**
 * The outline's rows for a transcript's items, oldest first: one per user
 * message, `{ id, anchor, text, age }`, with `age` relative to `now`.
 */
export function outlineRows(items, now) {
  const rows = [];
  for (const item of items) {
    if (item.type !== "user") continue;
    rows.push({ id: item.id, anchor: messageAnchorId(item.id), text: firstLine(item), age: ageLabel(new Date(item.timestamp).toISOString(), now) });
  }
  return rows;
}

/**
 * Whether the jump button shows its dot: an item added or changed while the
 * reader is away from the bottom (`changed`) sets it, being at the bottom
 * clears it, anything else keeps it.
 */
export function nextUnread(unread, { atBottom, changed = false }) {
  if (atBottom) return false;
  return unread || changed;
}

/**
 * Wire the outline. `rows()` answers `outlineRows(...)` for the session
 * shown; `scroller` is the chat, whose viewport decides which rows are in
 * view.
 */
export function mountOutline({ button, menu, scroller, rows }) {
  const options = () => [...menu.querySelectorAll('[role="menuitem"]')];

  /** Rows whose message is in the chat's viewport read at full strength. */
  function markInView() {
    const view = scroller.getBoundingClientRect();
    for (const option of options()) {
      const box = document.getElementById(option.dataset.anchor)?.getBoundingClientRect();
      option.dataset.inView = String(Boolean(box) && box.height > 0 && box.bottom > view.top && box.top < view.bottom);
    }
  }

  function open() {
    menu.replaceChildren(
      ...rows().map((row) => {
        const option = document.createElement("button");
        option.type = "button";
        option.tabIndex = -1;
        option.setAttribute("role", "menuitem");
        option.dataset.anchor = row.anchor;
        const text = document.createElement("span");
        text.className = "outline-text";
        text.textContent = row.text;
        const age = document.createElement("span");
        age.className = "outline-age";
        age.textContent = row.age;
        option.append(text, age);
        return option;
      }),
    );
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    markInView();
    const list = options();
    (list.find((option) => option.dataset.inView === "true") ?? list.at(-1))?.focus();
  }

  function close(returnFocus) {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (returnFocus) button.focus();
  }

  function choose(option) {
    const target = document.getElementById(option.dataset.anchor);
    close(!target);
    if (!target) return;
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.tabIndex = -1;
    target.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
    target.focus({ preventScroll: true });
  }

  button.addEventListener("click", () => (menu.hidden ? open() : close(true)));
  menu.addEventListener("click", (event) => {
    const option = event.target.closest?.('[role="menuitem"]');
    if (option) choose(option);
  });
  menu.addEventListener("keydown", (event) => {
    const list = options();
    const index = list.indexOf(document.activeElement);
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (step) list[(index + step + list.length) % list.length]?.focus();
    else if (event.key === "Home") list[0]?.focus();
    else if (event.key === "End") list.at(-1)?.focus();
    else if (event.key === "Escape") close(true);
    else if (event.key === "Tab") {
      // Tab goes on from the button, as if the menu had not been open.
      close(true);
      return;
    } else return;
    event.preventDefault();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target)) close(menu.contains(document.activeElement));
  });
  scroller.addEventListener("scroll", () => menu.hidden || markInView(), { passive: true });

  return {
    /** Show the button only for two or more of your messages. */
    setCount(count) {
      button.hidden = count < 2;
      if (button.hidden) close(false);
    },
    toggle() {
      if (button.hidden) return;
      if (menu.hidden) open();
      else close(true);
    },
  };
}
