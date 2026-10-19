// The command palette (Ctrl+O or Mod+K): a view of the page's command
// registry (commands.js), never a list of its own. Typing filters the
// commands with fuzzy.js; Up and Down move, Enter runs, Esc closes and focus
// goes back where it was. A command that cannot run now is listed dimmed
// with its reason. Text that matches no command well is offered as a
// message to the session shown, and as the prompt of a new thread. Switch Thread (Mod+P) uses the same card to
// pick another session. The helpers before `mountPalette` are pure, so
// tests load them in Node.

import { listedSessions, NEEDS_APP, PALETTE_SECTIONS } from "./commands.js";
import { fuzzyRank, GOOD_MATCH } from "./fuzzy.js";
import { availabilityOf, chordId, chordLabels, eventChord, keysOf } from "./keys.js";
import { relativeTime } from "./sidebar.js";

/** The fallback rows' titles. */
export const SEND_TITLE = "Send as a message to this thread";
export const NEW_THREAD_TITLE = "Start a new thread with this text";

/** How the palette lists `command`: `{ title, section }`, or `null` when it leaves it out. */
export function paletteEntry(command) {
  if (command.palette === false || command.context) return null;
  const section = command.palette?.section ?? command.section;
  if (!PALETTE_SECTIONS.includes(section)) return null;
  return { title: command.palette?.title ?? command.title, section };
}

/** Why the fallback row cannot send now, or `null` when it can. */
function sendBlocked(state) {
  if (!state.threadPage) return "Open a session to send it a message";
  return state.writable ? null : "This session is read-only here";
}

/**
 * The palette's sections for `query`: `[{ section, rows }]`. A row is
 * `{ kind: "command", id, title, description, chips, state, reason? }`,
 * where `state` is `available` or `unavailable` (a hidden command is left
 * out) and `chips` are its first key's chips in the platform's names.
 *
 * With no query, the sections come in PALETTE_SECTIONS order and each lists
 * its commands in registration order. With a query, the matching commands
 * form one Commands section ranked across every section: the ones that can
 * run first, each part best match first. When no command matches well (see
 * GOOD_MATCH), a Message section comes before it with two rows: `{ kind:
 * "message", title, text, state, reason? }`, which sends the text to the
 * session shown, and `{ kind: "new-thread", … }`, which opens the
 * new-thread composer with it (`ampi app` only).
 */
export function paletteSections(commands, state, query = "", { mac = false } = {}) {
  const rows = [];
  for (const command of commands) {
    const entry = paletteEntry(command);
    if (!entry) continue;
    const availability = availabilityOf(command, state);
    if (availability.state === "hidden") continue;
    const first = keysOf(command)[0];
    rows.push({
      kind: "command",
      id: command.id,
      title: entry.title,
      section: entry.section,
      description: command.description ?? "",
      chips: first ? chordLabels(first, { mac }) : [],
      state: availability.state,
      ...(availability.state === "unavailable" && availability.reason ? { reason: availability.reason } : {}),
    });
  }

  const text = query.trim();
  if (text === "") {
    return PALETTE_SECTIONS.map((section) => ({ section, rows: rows.filter((row) => row.section === section) })).filter(
      (group) => group.rows.length > 0,
    );
  }

  const ranked = fuzzyRank(rows, text, (row) => row.title);
  const ordered = [...ranked.filter(({ item }) => item.state === "available"), ...ranked.filter(({ item }) => item.state !== "available")];
  const sections = ordered.length > 0 ? [{ section: "Commands", rows: ordered.map(({ item }) => item) }] : [];
  if (!ranked.some((match) => match.quality >= GOOD_MATCH)) {
    const reason = sendBlocked(state);
    const row = { kind: "message", id: "send-message", title: SEND_TITLE, text, state: reason ? "unavailable" : "available", ...(reason ? { reason } : {}) };
    const start = { kind: "new-thread", id: "new-thread-message", title: NEW_THREAD_TITLE, text, state: state.app ? "available" : "unavailable", ...(state.app ? {} : { reason: NEEDS_APP }) };
    sections.unshift({ section: "Message", rows: [row, start] });
  }
  return sections;
}

/**
 * Switch Thread's rows for `query`: every listed session except the one
 * shown (`currentId`), the most recently active first, filtered and ranked
 * by title as the commands are. A row is `{ kind: "session", id, title,
 * description, time, state }`, where `description` is the last part of the
 * working directory and `time` how long ago the session was active.
 */
export function switchRows(list, currentId, query = "", now = Date.now()) {
  const sessions = listedSessions(list)
    .filter((session) => session.id !== currentId)
    .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
  const rows = sessions.map((session) => ({
    kind: "session",
    id: session.id,
    title: session.title,
    description: session.cwd.split(/[\\/]/).filter(Boolean).pop() ?? "",
    time: relativeTime(session.modified, now),
    state: "available",
  }));
  return fuzzyRank(rows, query, (row) => row.title).map(({ item }) => item);
}

// ---------------------------------------------------------------------------
// Page wiring

const MODES = {
  commands: { dialog: "Command palette", placeholder: "Find a command, or type a message…", label: "Command or message", list: "Commands", empty: "No commands match." },
  switch: { dialog: "Switch thread", placeholder: "Find a session to switch to…", label: "Session to switch to", list: "Sessions", empty: "No other session matches." },
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Wire the palette. `commands()` lists the registry; `state()` is what the
 * commands' `when` and `run` read, taken when the palette opens;
 * `openSession(id)` shows a session; `send(text)` sends a message to the
 * session shown; `startThread(text)` opens the new-thread composer with it.
 */
export function mountPalette({ dialog, commands, state, openSession, send, startThread, mac = false, now = () => Date.now() }) {
  const input = dialog.querySelector(".palette-input");
  const list = dialog.querySelector(".palette-list");
  const empty = dialog.querySelector(".palette-empty");

  let mode = "commands";
  /** What the commands read, as it was when the palette opened. */
  let opened = {};
  /** The rows drawn, in order, and the index of the active one. */
  let rows = [];
  let active = -1;
  let returnFocus = null;
  /** Where the pointer last was over the list, as `screenX,screenY`; `null` until it moves after the palette opens. */
  let pointer = null;

  function setActive(index) {
    active = index;
    for (const node of list.querySelectorAll('[role="option"]')) node.setAttribute("aria-selected", String(node.id === `palette-option-${index}`));
    const node = index >= 0 ? dialog.querySelector(`#palette-option-${index}`) : null;
    if (node) {
      input.setAttribute("aria-activedescendant", node.id);
      node.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }

  function optionNode(row, index) {
    const option = element("div", "palette-option");
    option.id = `palette-option-${index}`;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");
    option.dataset.index = String(index);
    if (row.state !== "available") option.setAttribute("aria-disabled", "true");
    const label = element("span", "palette-label");
    label.append(element("span", "palette-title", row.title));
    const note = row.reason ?? (row.kind === "message" || row.kind === "new-thread" ? row.text : row.description);
    if (note) label.append(element("span", "palette-description", note));
    option.append(label);
    if (row.chips?.length) {
      const keys = element("span", "palette-keys");
      keys.setAttribute("aria-hidden", "true");
      for (const chip of row.chips) keys.append(element("kbd", "", chip));
      option.append(keys);
    } else if (row.time) option.append(element("span", "palette-time", row.time));
    return option;
  }

  function draw() {
    const sections =
      mode === "switch"
        ? [{ section: "Threads", rows: switchRows(opened.sessionList, opened.shownId, input.value, now()) }]
        : paletteSections(commands(), opened, input.value, { mac });
    rows = [];
    const nodes = [];
    for (const [number, { section, rows: sectionRows }] of sections.entries()) {
      if (sectionRows.length === 0) continue;
      const group = element("div", "palette-group");
      group.setAttribute("role", "group");
      const heading = element("div", "palette-section", section);
      heading.id = `palette-section-${number}`;
      group.setAttribute("aria-labelledby", heading.id);
      group.append(heading);
      for (const row of sectionRows) {
        group.append(optionNode(row, rows.length));
        rows.push(row);
      }
      nodes.push(group);
    }
    list.replaceChildren(...nodes);
    // New rows start at the top, with the first section's label in view.
    list.parentElement.scrollTop = 0;
    empty.textContent = MODES[mode].empty;
    empty.hidden = rows.length > 0;
    setActive(rows.length > 0 ? 0 : -1);
  }

  /** Close, with focus back where it was before the palette opened. */
  function close() {
    const back = returnFocus;
    returnFocus = null;
    if (dialog.open) dialog.close();
    back?.focus?.({ preventScroll: true });
  }

  function choose(index) {
    const row = rows[index];
    if (row?.state !== "available") return;
    const at = opened;
    // Focus goes back first, so a dialog the command opens returns there too.
    close();
    if (row.kind === "session") openSession(row.id);
    else if (row.kind === "message") send(row.text);
    else if (row.kind === "new-thread") startThread(row.text);
    else commands().find((command) => command.id === row.id)?.run(at, { chord: null });
  }

  /** Whether `event` is one of the keys of the command `id`. */
  function isKeyOf(event, id) {
    const chord = eventChord(event, { mac });
    const command = commands().find((candidate) => candidate.id === id);
    return Boolean(chord && command) && keysOf(command).some((text) => chordId(text, { mac }) === chord);
  }

  /** Open the palette on the commands (`commands`) or on Switch Thread (`switch`); a second open of the same mode closes it. */
  function toggle(next = "commands") {
    if (dialog.open && mode === next) return close();
    if (!dialog.open) returnFocus = document.activeElement;
    pointer = null;
    opened = state();
    mode = next;
    dialog.dataset.mode = next;
    dialog.setAttribute("aria-label", MODES[next].dialog);
    input.placeholder = MODES[next].placeholder;
    input.setAttribute("aria-label", MODES[next].label);
    list.setAttribute("aria-label", MODES[next].list);
    input.value = "";
    draw();
    if (!dialog.open) dialog.showModal();
    input.focus();
  }

  input.addEventListener("input", draw);
  dialog.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    // The keys that open either mode switch to it or, in that mode already, close it; the page's own handler skips open dialogs.
    const next = isKeyOf(event, "command-palette") ? "commands" : isKeyOf(event, "switch-thread") ? "switch" : null;
    if (next) {
      event.preventDefault();
      toggle(next);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (rows.length > 0) setActive(Math.max(0, Math.min(rows.length - 1, active + (event.key === "ArrowDown" ? 1 : -1))));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(active);
    }
  });
  list.addEventListener("pointermove", (event) => {
    // The browser also sends a move when the rows shift under a resting pointer (opening, typing): only a real move picks a row.
    const at = `${event.screenX},${event.screenY}`;
    const moved = pointer !== null && pointer !== at;
    pointer = at;
    if (!moved) return;
    const option = event.target.closest?.('[role="option"]');
    const index = option ? Number(option.dataset.index) : -1;
    if (option && index !== active) setActive(index);
  });
  list.addEventListener("click", (event) => {
    const option = event.target.closest?.('[role="option"]');
    if (option) choose(Number(option.dataset.index));
  });
  // A click on the backdrop closes it.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  // Esc closes the dialog itself. The event arrives after close() too, and
  // by then a command (Switch Thread) may have opened the dialog again.
  dialog.addEventListener("close", () => {
    if (!dialog.open && returnFocus) close();
  });

  return { toggle };
}
