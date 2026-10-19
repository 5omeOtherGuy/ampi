// The keymap overlay: a modal titled Keymap that lists the keys the page
// answers, in columns. `keymapGroups` is pure, so tests check the columns in
// Node; `mountKeymap` draws them into the dialog.

import { chordId, chordLabels, isBrowserReserved, keysOf } from "./keys.js";

/** The overlay's columns and the registry sections each one shows. */
const COLUMNS = [
  { label: "Global", sections: ["Global", "Navigation"] },
  { label: "Sidebar", sections: ["Sidebar"] },
  { label: "Thread", sections: ["Thread", "Thread Panes"] },
];

/**
 * The overlay's columns for `commands`: Global, Sidebar and Thread while a
 * session is shown (`threadPage`), only Global elsewhere. Each row is a
 * command with keys: `{ id, title, chords: [{ chips, reserved }] }`, where
 * `chips` are the platform's key names, one per step of a sequence, and
 * `reserved` marks a key a browser tab keeps for itself.
 */
export function keymapGroups(commands, { threadPage = false, mac = false, overrides = {} } = {}) {
  const columns = threadPage ? COLUMNS : COLUMNS.slice(0, 1);
  return columns
    .map(({ label, sections }) => ({
      label,
      rows: commands
        .filter((command) => sections.includes(command.section) && keysOf(command, overrides).length > 0)
        .map((command) => ({
          id: command.id,
          title: command.title,
          chords: keysOf(command, overrides).map((text) => ({
            chips: chordLabels(text, { mac }),
            reserved: isBrowserReserved(chordId(text, { mac }), { mac }),
          })),
        })),
    }))
    .filter((group) => group.rows.length > 0);
}

/**
 * Wire the overlay. `groups()` answers `keymapGroups(...)` for the page as
 * it is when the overlay opens.
 */
export function mountKeymap({ dialog, groups }) {
  /** Where focus goes when the overlay closes. */
  let returnFocus = null;
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function draw() {
    const header = element("div", "keymap-header");
    const title = element("h2", "", "Keymap");
    title.id = "keymap-title";
    const edit = element("button", "button keymap-edit", "Edit keyboard shortcuts");
    edit.type = "button";
    edit.disabled = true;
    edit.title = "Changing the keys is not available yet";
    const close = element("button", "icon-button keymap-close");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.title = "Close (Esc)";
    close.innerHTML = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>';
    close.addEventListener("click", () => dialog.close());
    header.append(title, edit, close);

    const columns = element("div", "keymap-columns");
    let reservedShown = false;
    for (const group of groups()) {
      const section = element("section", "keymap-group");
      const label = element("h3", "keymap-label", group.label);
      label.id = `keymap-${group.label.toLowerCase()}`;
      section.setAttribute("aria-labelledby", label.id);
      const list = element("dl", "keymap-rows");
      for (const row of group.rows) {
        const item = element("div", "keymap-row");
        const keys = element("dd", "keymap-keys");
        for (const [index, chord] of row.chords.entries()) {
          if (index > 0) keys.append(element("span", "keymap-or", "or"));
          const chips = element("span", "keymap-chord");
          for (const chip of chord.chips) chips.append(element("kbd", "", chip));
          if (chord.reserved) {
            reservedShown = true;
            chips.dataset.reserved = "true";
            chips.title = "The browser keeps this key in a tab";
            chips.append(element("span", "keymap-mark", "*"));
          }
          keys.append(chips);
        }
        item.append(element("dt", "", row.title), keys);
        list.append(item);
      }
      section.append(label, list);
      columns.append(section);
    }
    const parts = [header, columns];
    if (reservedShown) parts.push(element("p", "keymap-note", "* Browsers keep this key for themselves in a tab, so the page never receives it."));
    dialog.replaceChildren(...parts);
  }

  dialog.addEventListener("close", () => {
    returnFocus?.focus?.({ preventScroll: true });
    returnFocus = null;
  });
  // A click on the scrim outside the card closes it.
  dialog.addEventListener("click", (event) => {
    const box = dialog.getBoundingClientRect();
    const outside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
    if (event.target === dialog && outside) dialog.close();
  });

  return {
    open() {
      if (dialog.open) return;
      returnFocus = document.activeElement;
      draw();
      dialog.showModal();
    },
  };
}
