// The right pane: a resizable column beside the chat with tabs (Changes;
// later slices add Files and Terminal), a Focus Pane button that widens it
// over the chat, and below 768 px a full-screen tab with a Chat tab to go
// back. Its width, whether it is open on a wide page, and its tab are page
// preferences (prefs.js). The tabs are plain buttons with `aria-pressed`;
// each names its panel with `data-pane-tab` and `data-pane-panel`.
// `clampRightPaneWidth` is pure, so tests check it in Node.

/** The pane's width in px: its default, its narrowest and widest, and an arrow key's step. */
export const RIGHT_PANE_WIDTH = { default: 520, min: 320, max: 1200, step: 16 };

export function clampRightPaneWidth(width) {
  if (!Number.isFinite(width)) return RIGHT_PANE_WIDTH.default;
  return Math.round(Math.min(RIGHT_PANE_WIDTH.max, Math.max(RIGHT_PANE_WIDTH.min, width)));
}

/**
 * Mount the pane. `app` carries `data-right-pane="open|closed"` and
 * `data-focus-pane` while the pane is widened. `onShow(tab)` runs each time
 * a tab comes into view: the pane opens on it, or it is picked.
 */
export function mountRightPane({ app, prefs, onShow = () => {} }) {
  const $ = (id) => document.getElementById(id);
  const pane = $("right-pane");
  const handle = $("right-pane-resize");
  const toggleButton = $("right-pane-toggle");
  const focusButton = $("focus-pane");
  const narrow = window.matchMedia("(max-width: 767px)");
  const tabs = () => [...pane.querySelectorAll("[data-pane-tab]")].filter((button) => button.dataset.paneTab !== "chat");
  const known = (tab) => tabs().some((button) => button.dataset.paneTab === tab);

  // Open on wide screens when the user left it open; the full-screen tab always starts on the chat.
  let open = !narrow.matches && prefs.get("rightPaneOpen");
  let tab = known(prefs.get("rightPaneTab")) ? prefs.get("rightPaneTab") : tabs()[0].dataset.paneTab;
  let focused = false;
  /** Whether the page shows a session: on ampi app's home page and on Activity there is nothing to show. */
  let available = false;

  const shown = () => open && available;

  function setWidth(width) {
    const value = clampRightPaneWidth(width);
    app.style.setProperty("--ampi-right-pane-width", `${value}px`);
    handle.setAttribute("aria-valuenow", String(value));
    return value;
  }
  handle.setAttribute("aria-valuemin", String(RIGHT_PANE_WIDTH.min));
  handle.setAttribute("aria-valuemax", String(RIGHT_PANE_WIDTH.max));
  setWidth(prefs.get("rightPaneWidth"));
  const storeWidth = (width) => prefs.set("rightPaneWidth", width);

  function draw() {
    const visible = shown();
    app.dataset.rightPane = visible ? "open" : "closed";
    if (visible && focused) app.dataset.focusPane = "true";
    else delete app.dataset.focusPane;
    pane.hidden = !visible;
    toggleButton.setAttribute("aria-expanded", String(visible));
    toggleButton.hidden = !available;
    for (const button of tabs()) {
      const current = button.dataset.paneTab === tab;
      button.setAttribute("aria-pressed", String(current));
      const panel = pane.querySelector(`[data-pane-panel="${button.dataset.paneTab}"]`);
      if (panel) panel.hidden = !current;
    }
    focusButton.setAttribute("aria-pressed", String(visible && focused));
    const label = focused ? "Show the chat beside the pane" : "Focus pane";
    focusButton.setAttribute("aria-label", label);
    focusButton.title = label;
  }

  /** Open or close the pane, run `onShow` when a tab came into view, and keep focus out of a pane that closed. */
  function update(change, { focusTab = false } = {}) {
    const before = shown() ? tab : null;
    const hadFocus = pane.contains(document.activeElement);
    change();
    if (!shown()) focused = false;
    if (!narrow.matches && open !== prefs.get("rightPaneOpen")) prefs.set("rightPaneOpen", open);
    if (tab !== prefs.get("rightPaneTab")) prefs.set("rightPaneTab", tab);
    draw();
    if (shown() && before !== tab) onShow(tab);
    if (shown() && focusTab) pane.querySelector(`[data-pane-tab="${tab}"]`)?.focus();
    else if (!shown() && hadFocus) toggleButton.focus();
  }

  // Below 768 px the open pane hides the title bar with this button, so focus moves into the pane.
  toggleButton.addEventListener("click", () => update(() => (open = !open), { focusTab: narrow.matches }));
  pane.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-pane-tab]");
    if (!button) return;
    // The full-screen tab's Chat tab goes back to the chat; the pane stays open on wide pages.
    if (button.dataset.paneTab === "chat") update(() => (open = false));
    else update(() => (tab = button.dataset.paneTab));
  });
  focusButton.addEventListener("click", () => update(() => (focused = !focused)));
  narrow.addEventListener("change", () => update(() => (open = narrow.matches ? false : prefs.get("rightPaneOpen"))));

  // Dragging the handle, or its arrow keys, resizes the pane; a double click resets it.
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    app.dataset.resizing = "true";
    const right = pane.getBoundingClientRect().right;
    const move = (moveEvent) => setWidth(right - moveEvent.clientX);
    const up = () => {
      handle.removeEventListener("pointermove", move);
      delete app.dataset.resizing;
      storeWidth(Number(handle.getAttribute("aria-valuenow")));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
    handle.addEventListener("pointercancel", up, { once: true });
  });
  handle.addEventListener("keydown", (event) => {
    // The pane grows to the left.
    const delta = { ArrowLeft: RIGHT_PANE_WIDTH.step, ArrowRight: -RIGHT_PANE_WIDTH.step }[event.key];
    if (!delta) return;
    event.preventDefault();
    storeWidth(setWidth(Number(handle.getAttribute("aria-valuenow")) + delta));
  });
  handle.addEventListener("dblclick", () => storeWidth(setWidth(RIGHT_PANE_WIDTH.default)));

  draw();

  return {
    /** Show or hide the pane (the title bar button, `mod+alt+b`). */
    toggle: () => update(() => (open = !open), { focusTab: true }),
    /** Open the pane on `tab` and focus its button (`ctrl+shift+g`). */
    show: (name) =>
      update(
        () => {
          open = true;
          if (known(name)) tab = name;
        },
        { focusTab: true },
      ),
    /** Widen the pane over the chat, opening it first, or give the chat its place back (`mod+alt+f`). */
    toggleFocus: () =>
      update(
        () => {
          focused = !(shown() && focused);
          open = open || focused;
        },
        { focusTab: true },
      ),
    /** Bring the chat back into view: leave Focus Pane, and close the full-screen tab on a narrow page. */
    showChat: () =>
      update(() => {
        focused = false;
        if (narrow.matches) open = false;
      }),
    /** Whether the page shows a session, which the pane belongs to. */
    setAvailable(next) {
      if (next !== available) update(() => (available = next));
    },
    /** Whether `name` is the tab in view. */
    showing: (name) => shown() && tab === name,
  };
}
