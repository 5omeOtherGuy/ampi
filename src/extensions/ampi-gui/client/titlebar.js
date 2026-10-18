// The title bar's More Actions menu: copy the session as Markdown, rename
// it, archive or unarchive it. The menu is built for the session the page
// shows; `menuItems` is pure and exported for tests.

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
  const menu = $("more-menu");
  const dialog = $("rename-dialog");
  const input = $("rename-input");
  let target = null;

  function entries() {
    return [...menu.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])')];
  }

  function close({ focus = true } = {}) {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (focus) button.focus();
  }

  function openMenu(focusLast = false) {
    if (!target) return;
    menu.replaceChildren(
      ...menuItems(target).map((item) => {
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
    button.setAttribute("aria-expanded", "true");
    const list = entries();
    (focusLast ? list.at(-1) : list[0])?.focus();
  }

  button.addEventListener("click", () => (menu.hidden ? openMenu() : close()));
  button.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openMenu(event.key === "ArrowUp");
    }
  });
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
    if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target)) close({ focus: false });
  });
  menu.addEventListener("click", (event) => {
    const entry = event.target.closest('[role="menuitem"]');
    if (!entry || entry.getAttribute("aria-disabled") === "true") return;
    close({ focus: entry.dataset.action !== "rename" });
    run(entry.dataset.action);
  });

  async function run(action) {
    const session = target;
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
      input.value = session.title;
      dialog.returnValue = "";
      dialog.showModal();
      input.select();
    }
  }

  dialog.addEventListener("close", async () => {
    if (dialog.returnValue !== "save" || !target) return button.focus();
    const result = await post("rename", { sessionId: target.id, name: input.value });
    button.focus();
    if (!result.ok) return notify(errorText(result, "Could not rename the session."));
    onChanged();
  });

  return {
    /** The session the menu acts on: `{ id, title, archived, live, actions }`, or `null` for none. */
    setTarget(next) {
      target = next;
      button.disabled = !next;
      if (!next) close({ focus: false });
    },
  };
}
