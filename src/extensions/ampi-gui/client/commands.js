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
    description: "The focused session's actions: copy, rename, archive",
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
  {
    id: "thread.rename",
    title: "Rename session",
    section: "Thread",
    keys: [],
    description: "Give the session this page runs a new title",
    when: (state) => (state.session?.live ? AVAILABLE : state.session ? unavailable("Rename it in the terminal that runs it") : HIDDEN),
    run: (state) => state.ui.sessionAction("rename", state.session),
  },
  {
    id: "thread.copyMarkdown",
    title: "Copy as Markdown",
    section: "Thread",
    keys: [],
    description: "Copy the shown session to the clipboard as Markdown",
    when: (state) => (state.session?.actions?.markdown ? AVAILABLE : state.session ? unavailable("Copying needs ampi-threads") : HIDDEN),
    run: (state) => state.ui.sessionAction("markdown", state.session),
  },
  {
    id: "thread.unarchive",
    title: "Unarchive session",
    section: "Thread",
    keys: [],
    description: "Take the session focused in the sidebar, else the one shown, out of the archive",
    when: (state) => archiveAvailability(state, false),
    run: (state) => state.ui.sessionAction("archive", targetOf(state)),
  },

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
];
