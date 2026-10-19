// The web GUI's command registry: every action the page's keys, the keymap
// overlay and later the palette and settings name. An entry is
// `{ id, title, section, keys, description, when(state), run(state, how) }`:
//
// - `id`: the terminal command's id where one means the same
//   (`thread.archive`, `thread.interrupt`), else a kebab-case web id
//   (`toggle-sidebar`).
// - `section`: one of SECTIONS.
// - `keys`: the default chords, in the grammar of keys.js.
// - `context`: where focus must be for the keys to fire; `sidebar` for the
//   sidebar's focus mode, else everywhere on the page.
// - `when(state)`: `{ state: "available" | "unavailable" | "hidden", reason? }`.
// - `run(state, { chord })`: does it through `state.ui`.
// - `hint`: what the page says while it waits for a sequence's second key.
//
// `state` is what app.js knows when a key is pressed: `threadPage` (a
// session is shown, not ampi app's home page), `session` (the shown
// session's More Actions target), `focusedSession` (the one focused in the
// sidebar), `interruptible`, `writable`, `promptEmpty`, `promptFocused` and
// `ui`, the page's actions. The registry is pure: tests load it in Node.

import { parseChord } from "./keys.js";

export const SECTIONS = ["Global", "Sidebar", "Thread", "Thread Panes", "Navigation"];

const AVAILABLE = { state: "available" };
const HIDDEN = { state: "hidden" };
const unavailable = (reason) => ({ state: "unavailable", reason });

/** Terminal ids (`thread.archive`) or web ids (`toggle-sidebar`). */
const COMMAND_ID = /^([a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+|[a-z][a-z0-9]*(-[a-z0-9]+)*)$/;

/** The registry, in registration order; registering an id again replaces the entry in place. */
export function createCommandRegistry(entries = []) {
  const commands = new Map();
  const registry = {
    /** Add or replace an entry; throws on one that does not fit the shape above. */
    register(entry) {
      if (!COMMAND_ID.test(entry?.id ?? "")) throw new Error(`Invalid command id "${entry?.id}"`);
      if (!SECTIONS.includes(entry.section)) throw new Error(`Command "${entry.id}" has an unknown section "${entry.section}"`);
      if (typeof entry.title !== "string" || entry.title === "") throw new Error(`Command "${entry.id}" has no title`);
      if (typeof entry.run !== "function") throw new Error(`Command "${entry.id}" has no run()`);
      for (const text of entry.keys ?? []) {
        const parsed = parseChord(text);
        if (parsed.error) throw new Error(`Command "${entry.id}" has a key that does not parse: "${text}" (${parsed.error})`);
      }
      commands.set(entry.id, entry);
      return registry;
    },
    get: (id) => commands.get(id),
    list: () => [...commands.values()],
  };
  for (const entry of entries) registry.register(entry);
  return registry;
}

/** The session a session command acts on: the one focused in the sidebar, else the one shown. */
const targetOf = (state) => state.focusedSession ?? state.session ?? null;

function archiveAvailability(state, archived) {
  const target = targetOf(state);
  if (!target) return unavailable("No session is shown");
  if (!target.actions?.archive) return unavailable("Archiving needs ampi-threads");
  return target.archived === archived ? unavailable(archived ? "This session is archived already" : "This session is not archived") : AVAILABLE;
}

/** Available for a target session, unless `need` (a key of the list's `actions`) is missing; `what` says what needs it. */
function sessionAvailability(state, need, what) {
  const target = targetOf(state);
  if (!target) return unavailable("No session is shown");
  if (need && !target.actions?.[need]) return unavailable(`${what} needs ampi-threads`);
  return AVAILABLE;
}

/** A More Actions entry as a command on the focused or shown session: `action` is the menu's (titlebar.js `run`). */
function sessionCommand(id, title, action, description, { keys = [], need, what = title, section = "Thread", when } = {}) {
  return {
    id,
    title,
    section,
    keys,
    description,
    when: when ?? ((state) => sessionAvailability(state, need, what)),
    run: (state) => state.ui.sessionAction(action, targetOf(state)),
  };
}

/** The commands the page has now. */
export const DEFAULT_COMMANDS = [
  // Global
  {
    id: "go-home",
    title: "Go to home screen",
    section: "Navigation",
    keys: ["g g"],
    description: "In ampi app, the page that lists every session; on a terminal's own page, the session that terminal runs",
    run: (state) => state.ui.goHome(),
  },
  {
    id: "go-back",
    title: "Go back",
    section: "Navigation",
    keys: ["ctrl+["],
    description: "The page shown before, as the browser's Back button",
    run: (state) => state.ui.back(),
  },
  {
    id: "go-forward",
    title: "Go forward",
    section: "Navigation",
    keys: ["ctrl+]"],
    description: "The page left with Go back",
    run: (state) => state.ui.forward(),
  },
  {
    id: "focus-title-bar",
    title: "Focus title bar",
    section: "Global",
    keys: ["ctrl+shift+m"],
    description: "Move focus to the title bar's first button",
    run: (state) => state.ui.focusTitleBar(),
  },
  {
    id: "copy-url",
    title: "Copy current URL",
    section: "Global",
    keys: ["mod+shift+c"],
    description: "Copy this page's address; it never carries the access token",
    run: (state) => state.ui.copyUrl(),
  },
  {
    id: "show-keymap",
    title: "Show keymap",
    section: "Global",
    keys: ["?", "alt+shift+/"],
    description: "List the keys this page answers",
    run: (state) => state.ui.showKeymap(),
  },

  // Sidebar
  {
    id: "toggle-sidebar",
    title: "Toggle sidebar",
    section: "Sidebar",
    keys: ["mod+b"],
    description: "Show or hide the session sidebar",
    run: (state) => state.ui.toggleSidebar(),
  },
  {
    id: "focus-sidebar-filter",
    title: "Search sessions",
    section: "Sidebar",
    keys: ["/"],
    description: "Open the sidebar and focus its search field",
    run: (state) => state.ui.focusSidebarFilter(),
  },
  {
    id: "sidebar-down",
    title: "Move sidebar selection down",
    section: "Sidebar",
    context: "sidebar",
    keys: ["down", "j", "ctrl+n"],
    description: "Focus the next session or group in the sidebar",
    run: (state) => state.ui.moveSidebar(1),
  },
  {
    id: "sidebar-up",
    title: "Move sidebar selection up",
    section: "Sidebar",
    context: "sidebar",
    keys: ["up", "k", "ctrl+p"],
    description: "Focus the previous session or group in the sidebar",
    run: (state) => state.ui.moveSidebar(-1),
  },
  {
    id: "sidebar-open",
    title: "Open focused sidebar item",
    section: "Sidebar",
    context: "sidebar",
    keys: ["enter"],
    description: "Show the focused session, or open or close the focused group",
    run: (state) => state.ui.openSidebarItem(),
  },
  {
    id: "sidebar-menu",
    title: "Open focused session menu",
    section: "Sidebar",
    context: "sidebar",
    keys: ["m"],
    description: "The focused session's More Actions",
    when: (state) => (state.focusedSession ? AVAILABLE : unavailable("Focus a session first")),
    run: (state) => state.ui.openSessionMenu(state.focusedSession),
  },
  {
    id: "sidebar-previous-thread",
    title: "Switch to previous session in sidebar",
    section: "Sidebar",
    keys: ["ctrl+alt+up"],
    description: "Show the session above the current one in the sidebar's order",
    run: (state) => state.ui.adjacentSession(-1),
  },
  {
    id: "sidebar-next-thread",
    title: "Switch to next session in sidebar",
    section: "Sidebar",
    keys: ["ctrl+alt+down"],
    description: "Show the session below the current one in the sidebar's order",
    run: (state) => state.ui.adjacentSession(1),
  },
  {
    id: "thread.archive",
    title: "Archive focused session",
    section: "Sidebar",
    keys: ["mod+shift+e"],
    description: "Archive the session focused in the sidebar, else the one shown",
    when: (state) => archiveAvailability(state, true),
    run: (state) => state.ui.sessionAction("archive", targetOf(state)),
  },

  // Thread
  {
    id: "thread.interrupt",
    title: "Interrupt",
    section: "Thread",
    keys: ["esc esc"],
    hint: "Press Esc again to interrupt",
    description: "Stop the running turn, as Esc Esc does in the terminal",
    when: (state) => (state.interruptible ? AVAILABLE : unavailable("Nothing is running here")),
    run: (state) => state.ui.interrupt(),
  },
  {
    id: "navigate-user-messages",
    title: "Move between user messages",
    section: "Thread",
    keys: ["up", "down"],
    description: "With the prompt empty and not focused, focus the previous or next message you wrote",
    when: (state) => (state.threadPage && state.promptEmpty && !state.promptFocused ? AVAILABLE : HIDDEN),
    run: (state, { chord }) => state.ui.moveMessage(chord.endsWith("up") ? -1 : 1, true),
  },
  {
    id: "navigate-all-messages",
    title: "Move between all messages",
    section: "Thread",
    keys: ["shift+up", "shift+down"],
    description: "With the prompt empty and not focused, focus the previous or next message",
    when: (state) => (state.threadPage && state.promptEmpty && !state.promptFocused ? AVAILABLE : HIDDEN),
    run: (state, { chord }) => state.ui.moveMessage(chord.endsWith("up") ? -1 : 1, false),
  },
  // More Actions, for the session focused in the sidebar, else the one shown.
  sessionCommand("thread.copyMarkdown", "Copy as Markdown", "markdown", "Copy the session to the clipboard as Markdown", {
    need: "markdown",
    what: "Copying",
  }),
  sessionCommand("copy-session-id", "Copy session ID", "copy-id", "Copy the session's id"),
  sessionCommand("copy-resume-command", "Copy resume command", "copy-resume", "Copy the ampi threads continue command that resumes the session in a terminal"),
  sessionCommand("export-markdown", "Export as Markdown file", "export-markdown", "Download the session's current branch as a Markdown file", {
    need: "markdown",
    what: "Exporting as Markdown",
  }),
  sessionCommand("export-json", "Export as JSON file", "export-json", "Download the session and every entry of its file as JSON, as ampi threads export prints it"),
  sessionCommand("show-running-in", "Show where the session runs", "running", "The process that runs the session, its phase, directory and Git branch"),
  sessionCommand("thread.showCost", "Show cost & usage", "cost", "What the session cost so far, per model", {
    when: (state) => {
      const target = targetOf(state);
      if (!target) return unavailable("No session is shown");
      return target.actions?.cost ? AVAILABLE : unavailable("Costs need ampi-threads with ampiThreads.showCosts on");
    },
  }),
  sessionCommand("toggle-pin", "Pin or unpin session", "pin", "Keep the session at the top of the sidebar, or stop", {
    keys: ["ctrl+g i"],
    need: "archive",
    what: "Pinning",
  }),
  {
    id: "thread.rename",
    title: "Rename session",
    section: "Thread",
    keys: [],
    description: "Give the session a new title; a session another process runs is renamed there",
    when: (state) => (targetOf(state) ? AVAILABLE : HIDDEN),
    run: (state) => state.ui.sessionAction("rename", targetOf(state)),
  },
  sessionCommand("edit-labels", "Edit labels", "labels", "Add or remove the session's labels", { need: "archive", what: "Labels" }),
  sessionCommand("set-color", "Set session color", "color-menu", "Pick the colour of the session's disc", { need: "archive", what: "Colours" }),
  sessionCommand("toggle-unread", "Mark as unread or read", "unread", "Mark the session unread, or read again", {
    need: "archive",
    what: "Unread marks",
  }),
  sessionCommand("toggle-snooze", "Snooze or unsnooze session", "snooze", "Move the session to Snoozed until its next message, or back", {
    keys: ["ctrl+g z"],
    need: "archive",
    what: "Snoozing",
  }),
  {
    id: "thread.unarchive",
    title: "Unarchive session",
    section: "Thread",
    keys: [],
    description: "Take the session focused in the sidebar, else the one shown, out of the archive",
    when: (state) => archiveAvailability(state, false),
    run: (state) => state.ui.sessionAction("archive", targetOf(state)),
  },
  sessionCommand("delete-session", "Delete session", "delete", "Delete the session's file and thread metadata, after asking", {
    when: (state) => {
      const target = targetOf(state);
      if (!target) return unavailable("No session is shown");
      return target.held ? unavailable("Close the session where it runs before deleting it") : AVAILABLE;
    },
  }),
  sessionCommand("report-bug", "Report a bug", "report-bug", "Open ampi's issue forms on GitHub in a new tab", {
    section: "Global",
    when: () => AVAILABLE,
  }),

  // Thread Panes
  {
    id: "focus-prompt",
    title: "Show chat and focus prompt",
    section: "Thread Panes",
    keys: ["ctrl+shift+a"],
    description: "Close the sidebar sheet and put the cursor in the composer",
    when: (state) => (!state.threadPage ? HIDDEN : state.writable ? AVAILABLE : unavailable("This session is read-only here")),
    run: (state) => state.ui.focusPrompt(),
  },
  {
    id: "toggle-full-width",
    title: "Toggle full width",
    section: "Thread Panes",
    keys: [],
    description: "Let the transcript and the composer use the whole width of the page; remembered on this machine",
    run: (state) => state.ui.sessionAction("full-width", null),
  },
];
