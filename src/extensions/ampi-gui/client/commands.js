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
//   sidebar's focus mode, `new-thread` while the new-thread composer is
//   shown, else everywhere on the page.
// - `when(state)`: `{ state: "available" | "unavailable" | "hidden", reason? }`.
// - `run(state, { chord })`: does it through `state.ui`.
// - `hint`: what the page says while it waits for a sequence's second key.
// - `palette`: how the command palette lists it, `{ title?, section? }`
//   when that differs from the keymap's sentence-case title and section, or
//   `false` to leave it out. The palette lists the PALETTE_SECTIONS only,
//   and never a command that has a `context`.
//
// `state` is what app.js knows when a key is pressed or the palette opens:
// `threadPage` (a session is shown, not ampi app's home page), `session`
// (the shown session's More Actions target), `focusedSession` (the one
// focused in the sidebar), `sessionList` (the last GET /api/sessions
// answer), `shownId` (the shown session's id), `interruptible`, `writable`,
// `promptEmpty`, `promptFocused`, `modes` (`{ locked }` while the shown
// session is live with an ampi mode, else `null`), `userMessages` (how many
// messages you wrote in the session shown), `selection` (text is selected in
// the transcript), `linkBlocked` (why a link to it cannot be made here, or
// `null`), `app` (`ampi app` serves the page), `fromThread` (the thread the
// new-thread composer was opened from, or `null`) and `ui`, the page's
// actions. The registry
// is pure: tests load it in Node.

import { parseChord } from "./keys.js";

export const SECTIONS = ["Global", "Sidebar", "Thread", "Thread Panes", "New Thread", "Navigation"];

/** The command palette's sections, in its order. */
export const PALETTE_SECTIONS = ["Global", "Thread", "Thread Panes", "Navigation"];

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
      if (entry.palette?.section && !SECTIONS.includes(entry.palette.section)) {
        throw new Error(`Command "${entry.id}" has an unknown palette section "${entry.palette.section}"`);
      }
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

/** Every session a GET /api/sessions answer lists, once each. */
export const listedSessions = (list) => (list?.groups ?? []).flatMap((group) => group.sessions);

/** The ids in the sidebar's Inactive group (no activity for 72 hours, not running, pinned, snoozed or archived), in its order. */
export function inactiveSessionIds(list) {
  return (list?.groups ?? []).filter((group) => group.kind === "inactive").flatMap((group) => group.sessions.map((session) => session.id));
}

/** A More Actions entry as a command on the focused or shown session: `action` is the menu's (titlebar.js `run`). */
function sessionCommand(id, title, action, description, { keys = [], need, what = title, section = "Thread", when, palette } = {}) {
  return {
    id,
    title,
    section,
    keys,
    ...(palette ? { palette } : {}),
    description,
    when: when ?? ((state) => sessionAvailability(state, need, what)),
    run: (state) => state.ui.sessionAction(action, targetOf(state)),
  };
}

/** Why New Thread cannot run on a terminal's own page. */
export const NEEDS_APP = "Needs ampi app";

/** A key of the new-thread composer: it opens one of its pickers or menus (`kind`). */
function composerCommand(id, title, key, kind, description) {
  return {
    id,
    title,
    section: "New Thread",
    context: "new-thread",
    keys: [key],
    description,
    run: (state) => state.ui.newThreadControl(kind),
  };
}

/** The commands the page has now. */
export const DEFAULT_COMMANDS = [
  {
    id: "new-thread",
    title: "New thread",
    section: "Global",
    keys: ["alt+enter"],
    palette: { title: "New Thread…" },
    description: "Write a prompt and start a thread in a directory and mode you choose",
    when: (state) => (state.app ? AVAILABLE : unavailable(NEEDS_APP)),
    run: (state) => state.ui.newThread(),
  },
  // Global
  {
    id: "go-home",
    title: "Go to home screen",
    section: "Navigation",
    keys: ["g g"],
    palette: { title: "Go Home" },
    description: "In ampi app, the page that lists every session; on a terminal's own page, the session that terminal runs",
    run: (state) => state.ui.goHome(),
  },
  {
    id: "go-back",
    title: "Go back",
    section: "Navigation",
    keys: ["ctrl+["],
    palette: { title: "Go Back" },
    description: "The page shown before, as the browser's Back button",
    run: (state) => state.ui.back(),
  },
  {
    id: "go-forward",
    title: "Go forward",
    section: "Navigation",
    keys: ["ctrl+]"],
    palette: { title: "Go Forward" },
    description: "The page left with Go back",
    run: (state) => state.ui.forward(),
  },
  {
    id: "command-palette",
    title: "Toggle command palette",
    section: "Global",
    keys: ["ctrl+o", "mod+k"],
    palette: false,
    description: "Find a command by name and run it, or send what you typed as a message",
    run: (state) => state.ui.openPalette(),
  },
  {
    id: "search-threads",
    title: "Search threads",
    section: "Global",
    keys: ["mod+shift+k"],
    palette: { title: "Search Threads…" },
    description: "Find a session by words, labels, project or state, and open it",
    run: (state) => state.ui.searchThreads(),
  },
  {
    id: "switch-thread",
    title: "Switch thread",
    section: "Global",
    keys: ["mod+p"],
    palette: { title: "Switch Thread…" },
    description: "Pick another session by name, the most recently active first",
    when: (state) => (listedSessions(state.sessionList).some((session) => session.id !== state.shownId) ? AVAILABLE : unavailable("No other session is listed")),
    run: (state) => state.ui.switchThread(),
  },
  {
    id: "open-activity",
    title: "Open Activity",
    section: "Global",
    keys: [],
    description: "Every session active in a time window, by day, with filters for status, project and a search",
    run: (state) => state.ui.openActivity(),
  },
  {
    id: "change-theme",
    title: "Change theme",
    section: "Global",
    keys: [],
    palette: { title: "Change Theme…" },
    description: "Step the colour scheme from system to light to dark, as the title bar's button does",
    run: (state) => state.ui.cycleScheme(),
  },
  {
    id: "archive-inactive",
    title: "Archive Inactive Threads Older than 72h",
    section: "Global",
    keys: [],
    description: "Archive every session in the sidebar's Inactive group, after asking",
    when: (state) => {
      if (!state.sessionList?.actions?.archive) return unavailable("Archiving needs ampi-threads");
      return inactiveSessionIds(state.sessionList).length > 0 ? AVAILABLE : unavailable("No session has been inactive for 72 hours");
    },
    run: (state) => state.ui.archiveInactive(inactiveSessionIds(state.sessionList)),
  },
  {
    id: "sidebar-collapse-projects",
    title: "Sidebar: Collapse All Projects",
    section: "Global",
    keys: [],
    description: "Close every project group in the sidebar",
    run: (state) => state.ui.collapseProjects(true),
  },
  {
    id: "sidebar-expand-projects",
    title: "Sidebar: Expand All Projects",
    section: "Global",
    keys: [],
    description: "Open every project group in the sidebar",
    run: (state) => state.ui.collapseProjects(false),
  },
  {
    id: "focus-title-bar",
    title: "Focus title bar",
    section: "Global",
    keys: ["ctrl+shift+m"],
    palette: { title: "Focus Title Bar" },
    description: "Move focus to the title bar's first button",
    run: (state) => state.ui.focusTitleBar(),
  },
  {
    id: "copy-url",
    title: "Copy current URL",
    section: "Global",
    keys: ["mod+shift+c"],
    palette: { title: "Copy Current URL" },
    description: "Copy this page's address; it never carries the access token",
    run: (state) => state.ui.copyUrl(),
  },
  {
    id: "show-keymap",
    title: "Show keymap",
    section: "Global",
    keys: ["?", "alt+shift+/"],
    palette: { title: "Show Keymap" },
    description: "List the keys this page answers",
    run: (state) => state.ui.showKeymap(),
  },
  {
    id: "reload-page",
    title: "Reload Page",
    section: "Global",
    keys: [],
    description: "Load this page again from the server",
    run: (state) => state.ui.reload(),
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
    palette: { title: "Archive Thread", section: "Thread" },
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
    palette: false,
    description: "With the prompt empty and not focused, focus the previous or next message you wrote",
    when: (state) => (state.threadPage && state.promptEmpty && !state.promptFocused ? AVAILABLE : HIDDEN),
    run: (state, { chord }) => state.ui.moveMessage(chord.endsWith("up") ? -1 : 1, true),
  },
  {
    id: "navigate-all-messages",
    title: "Move between all messages",
    section: "Thread",
    keys: ["shift+up", "shift+down"],
    palette: false,
    description: "With the prompt empty and not focused, focus the previous or next message",
    when: (state) => (state.threadPage && state.promptEmpty && !state.promptFocused ? AVAILABLE : HIDDEN),
    run: (state, { chord }) => state.ui.moveMessage(chord.endsWith("up") ? -1 : 1, false),
  },
  {
    id: "change-mode",
    title: "Change mode",
    section: "Thread",
    keys: [],
    palette: { title: "Change Mode…" },
    description: "Choose the session's mode or model; once the mode is locked, Change anyway overrides the lock",
    when: (state) => (!state.threadPage ? HIDDEN : state.modes ? AVAILABLE : unavailable("This session's mode cannot change here")),
    run: (state) => state.ui.openModePicker(),
  },
  {
    id: "choose-mode",
    title: "Choose mode",
    section: "Thread",
    keys: ["ctrl+s"],
    palette: false,
    description: "With the prompt focused and the mode not locked yet, open the mode picker",
    when: (state) => {
      if (!state.threadPage || !state.promptFocused || !state.modes) return HIDDEN;
      return state.modes.locked ? unavailable("The mode is locked once the session has a message. Change Mode… in the palette overrides it.") : AVAILABLE;
    },
    run: (state) => state.ui.openModePicker(),
  },
  {
    id: "toggle-outline",
    title: "Toggle conversation outline",
    section: "Thread",
    keys: ["o"],
    palette: { title: "Toggle Conversation Outline" },
    description: "List the messages you wrote in this session, and scroll to the one you pick",
    when: (state) => (!state.threadPage ? HIDDEN : state.userMessages >= 2 ? AVAILABLE : unavailable("The outline needs two or more of your messages")),
    run: (state) => state.ui.toggleOutline(),
  },
  // With text selected in the transcript (`selection`) and focus outside the prompt and other fields.
  {
    id: "reply-to-selection",
    title: "Reply quoting the selection",
    section: "Thread",
    keys: ["r"],
    palette: false,
    description: "Quote the selected text in the prompt as a Markdown block quote, after what the prompt holds",
    when: (state) => (!state.selection ? HIDDEN : state.writable ? AVAILABLE : unavailable("This session is read-only here")),
    run: (state) => state.ui.replyToSelection(),
  },
  {
    id: "copy-selection-markdown",
    title: "Copy selection as Markdown",
    section: "Thread",
    keys: ["c"],
    palette: false,
    description: "Copy the selected text as Markdown: the messages' own source when whole parts are selected",
    when: (state) => (state.selection ? AVAILABLE : HIDDEN),
    run: (state) => state.ui.copySelectionMarkdown(),
  },
  {
    id: "copy-selection-styled",
    title: "Copy selection with styling",
    section: "Thread",
    keys: ["s"],
    palette: false,
    description: "Copy the selected text as rich text, with plain text beside it",
    when: (state) => (state.selection ? AVAILABLE : HIDDEN),
    run: (state) => state.ui.copySelectionStyled(),
  },
  {
    id: "copy-selection-link",
    title: "Copy link to selection",
    section: "Thread",
    keys: ["l"],
    palette: false,
    description: "Copy a link to the message the selection starts in that highlights the selected text",
    when: (state) => (!state.selection ? HIDDEN : state.linkBlocked ? unavailable(state.linkBlocked) : AVAILABLE),
    run: (state) => state.ui.copySelectionLink(),
  },
  // More Actions, for the session focused in the sidebar, else the one shown.
  sessionCommand("thread.copyMarkdown", "Copy as Markdown", "markdown", "Copy the session to the clipboard as Markdown", {
    need: "markdown",
    what: "Copying",
  }),
  sessionCommand("copy-session-id", "Copy session ID", "copy-id", "Copy the session's id", { palette: { title: "Copy Session ID" } }),
  sessionCommand("copy-resume-command", "Copy resume command", "copy-resume", "Copy the ampi threads continue command that resumes the session in a terminal", {
    palette: { title: "Copy Resume Command" },
  }),
  sessionCommand("export-markdown", "Export as Markdown file", "export-markdown", "Download the session's current branch as a Markdown file", {
    need: "markdown",
    what: "Exporting as Markdown",
    palette: { title: "Export to Markdown" },
  }),
  sessionCommand("export-json", "Export as JSON file", "export-json", "Download the session and every entry of its file as JSON, as ampi threads export prints it", {
    palette: { title: "Export to JSON" },
  }),
  sessionCommand("show-running-in", "Show where the session runs", "running", "The process that runs the session, its phase, directory and Git branch", {
    palette: { title: "Show Where the Thread Runs" },
  }),
  sessionCommand("thread.showCost", "Show cost & usage", "cost", "What the session cost so far, per model", {
    palette: { title: "View Costs" },
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
    palette: { title: "Pin or Unpin Thread" },
  }),
  {
    id: "thread.rename",
    title: "Rename session",
    section: "Thread",
    keys: [],
    palette: { title: "Rename Thread" },
    description: "Give the session a new title; a session another process runs is renamed there",
    when: (state) => (targetOf(state) ? AVAILABLE : HIDDEN),
    run: (state) => state.ui.sessionAction("rename", targetOf(state)),
  },
  sessionCommand("edit-labels", "Edit labels", "labels", "Add or remove the session's labels", {
    need: "archive",
    what: "Labels",
    palette: { title: "Edit Labels" },
  }),
  sessionCommand("set-color", "Set session color", "color-menu", "Pick the colour of the session's disc", {
    need: "archive",
    what: "Colours",
    palette: { title: "Change Thread Color" },
  }),
  sessionCommand("toggle-unread", "Mark as unread or read", "unread", "Mark the session unread, or read again", {
    need: "archive",
    what: "Unread marks",
    palette: { title: "Mark as Unread or Read" },
  }),
  sessionCommand("toggle-snooze", "Snooze or unsnooze session", "snooze", "Move the session to Snoozed until its next message, or back", {
    keys: ["ctrl+g z"],
    need: "archive",
    what: "Snoozing",
    palette: { title: "Snooze or Unsnooze Thread" },
  }),
  {
    id: "thread.unarchive",
    title: "Unarchive session",
    section: "Thread",
    keys: [],
    palette: { title: "Unarchive Thread" },
    description: "Take the session focused in the sidebar, else the one shown, out of the archive",
    when: (state) => archiveAvailability(state, false),
    run: (state) => state.ui.sessionAction("archive", targetOf(state)),
  },
  sessionCommand("delete-session", "Delete session", "delete", "Delete the session's file and thread metadata, after asking", {
    palette: { title: "Delete Thread" },
    when: (state) => {
      const target = targetOf(state);
      if (!target) return unavailable("No session is shown");
      return target.held ? unavailable("Close the session where it runs before deleting it") : AVAILABLE;
    },
  }),
  sessionCommand("report-bug", "Report a bug", "report-bug", "Open ampi's issue forms on GitHub in a new tab", {
    section: "Global",
    palette: { title: "Report a Bug" },
    when: () => AVAILABLE,
  }),

  // New Thread: the composer's keys, while it is shown.
  composerCommand("new-thread-executor", "Choose where it runs", "ctrl+m", "executor", "The machine the new thread runs on"),
  composerCommand("new-thread-directory", "Choose a directory", "ctrl+j", "directory", "The working directory, from the ones sessions used or a typed path"),
  composerCommand("new-thread-mode", "Choose a mode", "ctrl+s", "mode", "The mode the new thread starts in"),
  composerCommand("new-thread-labels", "Edit labels", "ctrl+l", "labels", "The labels the new thread gets in the thread index"),
  {
    ...composerCommand("new-thread-insert", "Insert current thread", "ctrl+i", "insert", "Mention the thread you came from, as @ and its id"),
    when: (state) => (state.fromThread ? AVAILABLE : unavailable("Open New Thread from a thread to mention it")),
  },

  // Thread Panes
  {
    id: "focus-prompt",
    title: "Show chat and focus prompt",
    section: "Thread Panes",
    keys: ["ctrl+shift+a"],
    palette: { title: "Show Chat Pane" },
    description: "Close the sidebar sheet and put the cursor in the composer",
    when: (state) => (!state.threadPage ? HIDDEN : state.writable ? AVAILABLE : unavailable("This session is read-only here")),
    run: (state) => state.ui.focusPrompt(),
  },
  {
    id: "toggle-full-width",
    title: "Toggle full width",
    section: "Thread Panes",
    keys: [],
    palette: { title: "Toggle Full Width" },
    description: "Let the transcript and the composer use the whole width of the page; remembered on this machine",
    run: (state) => state.ui.sessionAction("full-width", null),
  },
];
