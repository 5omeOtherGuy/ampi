// The session actions menu: copy the session as Markdown, rename it,
// archive or unarchive it. The title bar's More Actions opens it for the
// session the page shows, and a sidebar row's `m` key for that row's
// session. `menuItems` is pure and exported for tests.

/**
 * The menu's entries for a session. `live` is whether this process runs it
 * (only then can it be renamed here); `actions` says which actions the
 * server can do (`archive` needs the thread index, `markdown` its
 * formatter). An entry the session cannot use is disabled with a reason.
 */
export function menuItems({ live, archived, actions }) {
  const items = [];
  if (actions.markdown) items.push({ action: "markdown", label: "Copy as Markdown" });
  items.push(
    live
      ? { action: "rename", label: "Rename…" }
      : { action: "rename", label: "Rename…", disabled: true, hint: "Rename it in the terminal that runs it" },
  );
  if (actions.archive) items.push({ separator: true }, { action: "archive", label: archived ? "Unarchive" : "Archive" });
  return items;
}

/** Answers that can use a sentence from the server; otherwise a fallback. */
function errorText(result, fallback) {
  return typeof result.body?.error === "string" ? result.body.error : fallback;
}

export function mountTitlebar({ post, notify, onChanged }) {
  const $ = (id) => document.getElementById(id);
  const button = $("more");
  const dialog = $("rename-dialog");
  const input = $("rename-input");
  /** The session the page shows: More Actions acts on it. */
  let target = null;
  /** The session the rename dialog renames, and where focus returns after it. */
  let renaming = null;
  let renameReturn = null;

  /**
   * A menu element: `open(session, opener)` fills it for `session`; closing
   * returns focus to `opener`, or to `refocus()` when a redraw replaced it.
   */
  function actionMenu(menu, { onToggle = () => {}, place = () => {} } = {}) {
    let session = null;
    let opener = null;
    let refocus = () => null;
    const entries = () => [...menu.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])')];
    const returnTo = () => (opener?.isConnected ? opener : refocus());

    function close({ focus = true } = {}) {
      if (menu.hidden) return;
      menu.hidden = true;
      onToggle(false);
      if (focus) returnTo()?.focus();
    }

    function open(next, from, { focusLast = false, findOpener = () => null } = {}) {
      session = next;
      opener = from;
      refocus = findOpener;
      menu.replaceChildren(
        ...menuItems(session).map((item) => {
          if (item.separator) {
            const rule = document.createElement("div");
            rule.setAttribute("role", "separator");
            return rule;
          }
          const entry = document.createElement("button");
          entry.type = "button";
          entry.setAttribute("role", "menuitem");
          entry.tabIndex = -1;
          entry.dataset.action = item.action;
          entry.textContent = item.label;
          if (item.disabled) {
            entry.setAttribute("aria-disabled", "true");
            entry.title = item.hint;
          }
          return entry;
        }),
      );
      menu.hidden = false;
      place(from);
      onToggle(true);
      const list = entries();
      (focusLast ? list.at(-1) : list[0])?.focus();
    }

    menu.addEventListener("keydown", (event) => {
      const list = entries();
      const index = list.indexOf(document.activeElement);
      const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
      if (step) {
        event.preventDefault();
        list[(index + step + list.length) % list.length]?.focus();
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        (event.key === "Home" ? list[0] : list.at(-1))?.focus();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === "Tab") close({ focus: false });
    });
    document.addEventListener("pointerdown", (event) => {
      if (!menu.hidden && !menu.contains(event.target) && !opener?.contains(event.target)) close({ focus: false });
    });
    menu.addEventListener("click", (event) => {
      const entry = event.target.closest('[role="menuitem"]');
      if (!entry || entry.getAttribute("aria-disabled") === "true") return;
      const action = entry.dataset.action;
      const from = returnTo();
      close({ focus: action !== "rename" });
      run(action, session, from);
    });
    return { open, close, isOpen: () => !menu.hidden };
  }

  const more = actionMenu($("more-menu"), { onToggle: (open) => button.setAttribute("aria-expanded", String(open)) });
  // The row menu sits in the sidebar, so it stays usable while the sidebar is a sheet over an inert page.
  const rowMenu = actionMenu($("row-menu"), {
    place(row) {
      const menu = $("row-menu");
      const box = row.getBoundingClientRect();
      const height = menu.offsetHeight;
      const top = box.bottom + 4 + height > window.innerHeight ? Math.max(4, box.top - 4 - height) : box.bottom + 4;
      menu.style.setProperty("--ampi-menu-top", `${Math.round(top)}px`);
      menu.style.setProperty("--ampi-menu-left", `${Math.round(box.left + 8)}px`);
    },
  });

  button.addEventListener("click", () => (more.isOpen() ? more.close() : target && more.open(target, button)));
  button.addEventListener("keydown", (event) => {
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && target) {
      event.preventDefault();
      more.open(target, button, { focusLast: event.key === "ArrowUp" });
    }
  });

  /** Do `action` (`markdown`, `rename` or `archive`, which flips the archive) for `session`; focus returns to `from` after a rename. */
  async function run(action, session, from = button) {
    if (!session) return;
    if (action === "markdown") {
      const result = await post("markdown", { sessionId: session.id });
      if (!result.ok) return notify(errorText(result, "Could not copy the session."));
      try {
        await navigator.clipboard.writeText(result.body.markdown);
        notify("Copied the session as Markdown");
      } catch {
        notify("The browser did not allow copying to the clipboard.");
      }
    } else if (action === "archive") {
      const archived = !session.archived;
      const result = await post("archive", { sessionId: session.id, archived });
      if (!result.ok) return notify(errorText(result, "Could not change the archive."));
      notify(archived ? "Archived the session" : "Unarchived the session");
      onChanged();
    } else if (action === "rename") {
      renaming = session;
      renameReturn = from;
      input.value = session.title;
      dialog.returnValue = "";
      dialog.showModal();
      input.select();
    }
  }

  dialog.addEventListener("close", async () => {
    const session = renaming;
    const back = renameReturn?.isConnected ? renameReturn : button;
    renaming = null;
    renameReturn = null;
    back.focus();
    if (dialog.returnValue !== "save" || !session) return;
    const result = await post("rename", { sessionId: session.id, name: input.value });
    if (!result.ok) return notify(errorText(result, "Could not rename the session."));
    onChanged();
  });

  return {
    /** The session the menu acts on: `{ id, title, archived, live, actions }`, or `null` for none. */
    setTarget(next) {
      target = next;
      button.disabled = !next;
      if (!next) more.close({ focus: false });
    },
    /** The shown session's target, as `setTarget` last set it. */
    target: () => target,
    run,
    /** Open the actions menu for a sidebar row's session; `findRow()` finds the row again after a redraw. */
    openForRow(session, row, findRow) {
      more.close({ focus: false });
      rowMenu.open(session, row, { findOpener: findRow });
    },
  };
}
