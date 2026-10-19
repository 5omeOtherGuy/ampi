# ampi-gui

A local web GUI for the running Pi session: open the link Pi prints and the browser shows the session's transcript live, with the same activity words for tool calls as the terminal and the agent's status as it works, a composer that sends, steers, queues and interrupts through the terminal's own session, and a sidebar of your other sessions that opens them read-only.

Package overview: [`../../../README.md`](../../../README.md). Planning: [`../../../ROADMAP.md`](../../../ROADMAP.md). Public API: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## At a glance

| Default | Provides | Requires | Diagnostics |
| --- | --- | --- | --- |
| Off | A web page on `http://127.0.0.1:<random port>` with a session sidebar, a live transcript and a composer, the `thread.openInBrowser` command, its port in the live registry | an interactive terminal session, or a session `ampi app` hosts; a browser on the same machine; `ampi-tui` for queued-message texts and steering a queued message; `ampi-threads` for the More Actions that use the thread index, the Markdown export and the cost | the `Web GUI: …` notice at session start; `<agentDir>/data/ampi/live/<pid>.json` and `<pid>.token` |

## When to use it

- You want to read a long session in a browser: wider prose, rendered Markdown, tool output you can expand.
- You want to watch a running turn from another window while the terminal is busy or hidden, and steer, queue or stop it from there.
- You want to look through earlier sessions, or the ones other terminals run, without leaving the one you are in.

## Status and enablement

Default: off. `ampi-gui` is registered in `package.json` `pi.extensions` but does nothing until you turn it on with `ampiGui.enabled: true` or `AMPI_GUI_ENABLE=true` (see [Configuration](#configuration)).

Even when on, it starts only in an interactive terminal session (Pi's `tui` mode). Print, JSON and RPC runs, subagent workers included, never open a port. The exceptions are a session `ampi app` hosts and `ampi app` itself: they always get a GUI, whatever the setting says (see [Hosted sessions](#hosted-sessions)). It owns no model-visible tools or feature gates.

## Hosted sessions

`ampi app` serves sessions without a terminal. It runs each one in a worker process of its own (`ampi app --worker`, see the [ampi-cli README](../../../packages/ampi-cli/README.md#development)), because ampi keeps per-process state and one process never runs two ampi sessions. The page is the same client in app mode (see [App mode](#app-mode)); using it is described in the [ampi-cli README](../../../packages/ampi-cli/README.md#ampi-app).

- **What runs where.** The worker opens the session through Pi's SDK, in Pi's RPC mode, with the extensions an interactive `ampi` loads. `ampi-gui` runs inside the worker exactly as it runs inside a terminal session: its server, bridge and commands are the same code, and every message, queue change and interrupt goes through that worker's Pi session. `ampi app` only starts and stops workers and hands out their links.
- **The seam.** Before it creates the session, the worker puts a host record on `globalThis`, which ampi-core reads through `getMmrGuiHost()` ([`gui-host.ts`](../ampi-core/gui-host.ts)): `{ role: "session", token, ownerPid, ready({ port }) }`. With it, `ampi-gui` starts its server in RPC mode as well as in the terminal, uses the host's token instead of making one, ignores `ampiGui.enabled` (the user started `ampi app` for this), calls `ready` with its port once, after its live registry entry carries the port, and prints no `Web GUI:` notice. It also sets the record's `dialog` and `notice` handlers, through which the worker's `ctx.ui` asks the page (see [Dialogs](#dialogs)). ampi-core's live registry records the session as `app-session`, with the app's pid as `ownerPid`. Without a host record nothing changes.
- **Security model: the same.** The server still listens on `127.0.0.1` only, checks `Host` and `Origin`, needs the token and sets it as an `HttpOnly`, `SameSite=Strict` cookie, sets no CORS headers and serves only its client files. The token reaches the worker over the IPC channel `ampi app` forked it with, never as an argument or environment variable. The live registry entry holds only its hash, and the token file next to it the token, as for every running GUI (see [Security model](#security-model)).
- **One writer per file.** The worker never opens a session file another live process has open: it reports which process holds it and exits without reading it.

## Tools / commands / surfaces

| Surface | Type | Purpose |
| --- | --- | --- |
| `Web GUI: http://127.0.0.1:<port>/?t=<token>` | Notice at session start | The link to open; it carries the access token |
| `thread.openInBrowser` | Command, no key | Opens the link with `xdg-open` (Linux with a desktop) or `open` (macOS); elsewhere it shows the link to copy |
| Live registry | File | `<agentDir>/data/ampi/live/<pid>.json`, written by ampi-core for every running session that has a file (see its [Live registry](../ampi-core/README.md#live-registry)); the GUI adds `gui: { port, tokenHash }` while it serves the session and sets it back to `null` when it stops |
| Token file | File | `<agentDir>/data/ampi/live/<pid>.token`: the access token, while the GUI serves; see [Security model](#security-model) |
| `POST /api/send`, `/api/dequeue`, `/api/steer-next`, `/api/interrupt` | Page endpoints | What the composer sends; see [Commands](#commands) |
| `GET /api/sessions`, `GET /api/sessions/<id>` | Page endpoints | The sidebar's sessions and the read-only view of one; see [Sessions](#sessions) |
| `POST /api/markdown`, `/api/archive`, `/api/pin`, `/api/color`, `/api/labels`, `/api/snooze`, `/api/unread`, `/api/cost`, `/api/running`, `/api/rename`, `/api/delete`; `GET /api/export` | Page endpoints | The title bar's [More Actions](#more-actions); see [Commands](#commands) |
| `ampi_gui_prefs` | Cookie | The page's preferences (sidebar width, sidebar open, Full Width), shared by every ampi page on this machine; see [More Actions](#more-actions) |
| Ctrl+B (⌘B on macOS), `/`, `?` and the rest of [Keyboard](#keyboard) | Page keys | Show or hide the sidebar, search the sessions, list every key in the Keymap overlay |

The palette lists the command as `thread open in browser`.

## Configuration

One switch; it is not a secret.

```json
{ "ampiGui": { "enabled": true } }
```

The nested form `{ "ampi": { "gui": { "enabled": true } } }` is accepted too. Settings are read from `~/.pi/agent/settings.json` and then `<project>/.pi/settings.json`; the project file wins. An environment variable overrides both:

| Variable | Effect |
| --- | --- |
| `AMPI_GUI_ENABLE` | `true` turns the GUI on, `false` turns it off |

The settings are read once when the extension loads. Restart Pi or run `/reload` after changing them.

## Behavior

### The page

- A sidebar of sessions on the left, 256 px wide by default. Drag its edge to resize it (or focus the edge and use the arrow keys; a double click resets it); the width and whether it is open are remembered for every ampi page in this browser (the `ampi_gui_prefs` cookie). Ctrl+B (⌘B on macOS) shows or hides it from anywhere on the page, and the button at the top of the sidebar or in the title bar does the same. See [Sessions](#sessions).
- A 36 px title bar with the session's disc, its title (its name, or the first line of its first prompt), [More Actions](#more-actions) (`…`), the working directory and the ampi mode (a [registered mode](../ampi-core/README.md#registered-modes) by its label; a session read from its file by its key), and a button that cycles the colour scheme (system, light, dark; remembered in this browser).
- The transcript in a centred column up to 672 px wide, or the whole pane with Full Width. Your prompts are bubbles on the right. The assistant's replies are prose with rendered Markdown (headings, lists, tables, code cards, links). Thinking is a collapsed "Thinking" line. See [Work groups](#work-groups) for tool calls.
- The composer at the bottom: a text area, a paperclip (attachments are not available yet; it says so), the agent's status (Sending, Thinking, Streaming, Running Tools, Auto-Compacting, Waiting for Approval, Cancelling or Error, with the streamed-token count or the tool name and the number of queued messages) and a round send button that turns into a stop square while a turn runs and nothing is typed. A pulsing dot ends the transcript while the agent works.
- The transcript follows new output while you are at the bottom, also when the composer grows or the window changes size. Scroll up and it stays put; the round button above the composer (or End) jumps back down.
- Below 768 px the layout narrows to one column: the sidebar becomes a sheet over the page (opened from the title bar, closed with Esc, a tap outside it or by choosing a session), and the title bar keeps only the sidebar button, the session's disc and title, More Actions and the colour scheme.

### More Actions

The title bar's `…` opens the menu for the session the page shows; `m` on a focused sidebar row opens it for that row's session. It opens with a click or with the arrow keys on its button; Up and Down move, Right opens a submenu and Left closes it, Esc closes the menu. Every entry is also a command in the page's registry (`client/commands.js`), so the palette lists it, and each works for any session the sidebar lists, in `ampi app` too.

| Entry | Does | Writes |
| --- | --- | --- |
| Copy › Markdown, Session ID, Resume Command, Page URL | Copies the session as Markdown (the same text as `thread copy markdown`), its id, `ampi threads continue <id>`, or the address of its page (Mod+Shift+C for the page shown), which never carries the access token | nothing |
| Export › Markdown File, JSON File | Downloads the Markdown, or the JSON `ampi threads export` prints (the session's listing fields and every entry of its file); a refusal, such as a session Pi has not saved yet, shows its reason | nothing |
| Running in › | A card: this terminal, another terminal, an `ampi -x` run, `ampi app`, or not running, with the process id and its phase, and the working directory and Git branch (read without Git's optional locks); click a row to copy its value | nothing |
| Cost & Usage | The session's cost per model, as the terminal's Thread Cost overlay counts it; off with `ampiThreads.showCosts: false` | nothing |
| Pin / Unpin (Ctrl+G then I) | Moves the session to Pinned, or back | thread index |
| Rename… | Gives the session a title of yours (see below) | the session file |
| Labels… | Adds and removes labels with the rules of `ampi threads label`: 1 to 32 lowercase letters, digits or hyphens each, at most 20 | thread index |
| Color › | One of the thread colours for the session's disc, or Reset for the colour picked from its id | thread index |
| Mark as Unread / Mark as Read | Marks the session unread, or read now | thread index |
| Snooze / Unsnooze (Ctrl+G then Z) | Moves the session to Snoozed until its next message, or back | thread index |
| Archive / Unarchive (Mod+Shift+E) | Sets or clears its archive date | thread index |
| Delete | After a confirmation that names the session, deletes it (see below) | the session file and thread index |
| Full Width | Lets the transcript and the composer use the whole pane; remembered for every ampi page in this browser | the `ampi_gui_prefs` cookie |
| Report Bug… | Opens ampi's issue forms on GitHub in a new tab | nothing |

Pin, Labels, Color, the unread mark, Snooze and Archive need `ampi-threads` and are left out without it; Copy Markdown and Export Markdown need its Markdown export, Cost & Usage its cost report.

- **Rename** changes the session's file through Pi, but only from the process that has it open, so a session never gets a second writer. The session this terminal runs is renamed through its own Pi session. One that another process runs with the web GUI (a terminal, or a session `ampi app` hosts) is renamed by that process's server, which the page's server asks with the token from that process's token file. One that another process holds without the GUI, or an `ampi -x` run, answers that you should rename it there. One that no process holds (the live registry has no entry for its file, checked just before) gets Pi's `session_info` entry appended to its file, as `ampi threads rename` does. Every rename records the title as yours, so a generated title never replaces it.
- **Delete** removes the session file and its thread index record, as `ampi threads delete` does, and cannot be undone. It is refused, and changes nothing, while any live process has the session open, the one serving the page included: close the session there first. The menu greys Delete out for a session the sidebar shows as running.
- **Snoozed and unread.** A snoozed session stays in the Snoozed group while its last message is not newer than the snooze, so its next message brings it back. A session is unread when you marked it so, or when it has a message newer than the last time a page showed it: showing a session, or finishing a turn while it is in view, marks it read, once Pi has saved it, so a page you open and leave unused records nothing.

### Work groups

Tool calls fold the way the terminal folds them, by the same rules (ampi-core's `activity-runs.ts`) and in the same words.

- **Groups.** Consecutive tool calls are one line with the terminal's summary of the run: "Ran 3 commands, read 4 files", "Changed 2 files (+3 -1), ran 1 command". A run ends at an assistant message with text, a message cut off at the length limit, an interrupted message without calls, your messages, compaction and branch summaries, and custom messages that are shown. Thinking, failed calls and a change of tool kind do not end it. A subagent call, and a call whose result holds an image, keep a line of their own.
- **Opening a group** (a click, or Enter on its line) shows its calls below it, indented with a rule on the left, one line each in the terminal's activity words ("Read src/a.ts L1-3", "Ran npm test (exit code: 1)"). Only one call of a group is open at a time: opening another closes it. An open call shows a card with the full shell command and its output, an edit's or a new file's lines with additions and removals coloured, the arguments of other tools, or the output.
- **While a group runs**, its line says what it is doing ("Read 1 file, running 1 command") and pulses; it takes its final words when the last call ends. Hovering a finished group's line says how long it took.
- **The work fold.** Once a turn has finished, the work before its final answer (groups, notes between them, thinking) folds behind a centred "Worked for 2 minutes" line, timed from your message to the start of the answer, or to the last call's end when the turn ended without one. A click or Enter opens it. A turn whose work is a single line (one group, one call, one note) keeps that line instead of a fold. The turn that is still running is never folded.
- As in the terminal, an assistant message's text is drawn above its tool calls.

### Sessions

The sidebar lists Pi's saved sessions from every project in the session directory this Pi uses, plus the session this terminal runs even before Pi has saved it.

| Group | Holds |
| --- | --- |
| Pinned | pinned sessions that are not archived or snoozed |
| One per project | the other sessions active in the last 72 hours, and those a terminal runs now, grouped by working directory and named after its last folder (`~` for your home directory); the project with the newest session comes first |
| Inactive Last 72h | the remaining sessions that are not archived or snoozed; collapsed at first, with a count |
| Snoozed | snoozed sessions that are not archived; collapsed at first, with a count |
| Archived | archived sessions; collapsed at first, with a count |

- Each group can be collapsed. Within a group, sessions are sorted by their last activity, newest first. Pinned, snoozed, unread, archived, the labels and the colour come from `ampi-threads`' thread index; without `ampi-threads` nothing is pinned, snoozed, unread or archived.
- Each row shows the session's disc, its title and how long ago it was active (`now`, `5m`, `3h`, `2d`, `3w`, `4mo`, `1y`). The disc has the colour set in the thread index, or one picked from the session id, so a session keeps its colour. It spins while the session this terminal runs is working. An unread session has a dot on its disc and a bolder title. A small dot after the title marks a session another running process has open (from the live registry): a terminal session, with or without its own GUI, or a print, JSON or RPC run.
- The search field (`/` focuses it) keeps the sessions whose title, project name or working directory contain every word typed, in all groups; Esc clears it.
- The list reloads after each turn, when the session changes, when the window gets focus and once a minute.
- **Opening another session shows it read-only.** Its transcript is read from its file without changing it, the title bar shows its title, project and mode, and in place of the composer a banner says to open it in the terminal to continue (or, if another terminal runs it, to continue there). Only the Pi process that runs a session writes to it, so the page never becomes a second writer. The banner's link, or the session's own row, goes back to this terminal's session. The address names the session shown (`#/s/<session id>`), so the browser's Back button returns to the previous one.

### The composer

Text typed here goes to the same Pi session as the terminal, the way the terminal's own keys send it, so both show the same transcript and the same queue.

| Key | While idle | While a turn runs |
| --- | --- | --- |
| Enter | Sends the prompt | Steers the turn: Pi hands the message to the model at its next step |
| Ctrl+Enter (⌘+Enter on macOS) | Sends the prompt | Queues the message to run after the turn ends |
| Shift+Enter | New line | New line |
| Esc Esc (within 1.5 seconds) | Nothing | Interrupts the turn; the first Esc says "Press Esc again to interrupt" |

- Prompt templates and skills expand as they do in the terminal. While Pi compacts the conversation it refuses new messages; the composer says so and keeps the text.
- The send button sends (or steers) what is typed; with nothing typed during a turn it is a stop button. The placeholder names the keys while a turn runs.
- **Queued messages** are bubbles above the composer, steering ones first, labelled Steering or Queued. Each has Delete (takes it out of Pi's queue) and Edit (takes it out and puts its text into the composer); the next queued one also has an arrow that sends it now to steer the turn, as Enter on an empty prompt does in the terminal. A message that already started, or that changed in the meantime, is not taken: the page says it is no longer queued.
- **Interrupting** does what the terminal's Esc Esc does: Pi stops the turn and puts the messages still queued back into the terminal's prompt, not the browser's. The page says so when that happened. Esc Esc interrupts only while the composer is in view: not while another session is open read-only, the sidebar sheet is open or an Escape closes a dialog.
- **Approvals in a terminal session stay in the terminal.** While a tool call waits for approval (status Waiting for Approval), a note above the composer says to answer it there. In a session `ampi app` runs, the page asks instead (see [Dialogs](#dialogs)).
- **Imported sessions are read-only.** A session `ampi threads import` wrote from another agent's conversation refuses every prompt in `ampi-core`, the composer's included: nothing is sent, and the terminal shows why. The host of `ampi app` checks the same predicate (`isMmrImportedSession` in `ampi-core/imported-session.ts`): it answers 409 to a send instead of starting a worker, and the page turns the composer off with the reason (see [App mode](#app-mode) below).

- Queued-message bubbles and steering a queued message need `ampi-tui`, which reads Pi's queue. Without it, the composer still sends, steers, queues and interrupts, and the status shows how many messages are queued.

### Keyboard

The page's keys, listed in the Keymap overlay (`?`). Mod is ⌘ on macOS and Ctrl elsewhere; the overlay names the keys as your platform does. Plain keys (letters, `/`, `?`, arrows) do nothing while you type in a field; keys with Ctrl, Alt or ⌘ work there too, and so does Esc Esc. A modal (a question, Rename, the Keymap overlay) keeps every key to itself. Two-key sequences (`g g`, Esc Esc) take the second key within 1.5 seconds.

| Key | Where | Does |
| --- | --- | --- |
| `g g` | Anywhere | In `ampi app`, the home page; on a terminal's own page, the session that terminal runs |
| Ctrl+[ / Ctrl+] | Anywhere | Back / forward, as the browser's buttons |
| Ctrl+Shift+M | Anywhere | Focus the title bar's first button |
| Mod+Shift+C | Anywhere | Copy the page's address (never with the access token) |
| `?` or Alt+Shift+/ | Anywhere | Show the Keymap overlay |
| Mod+B | Anywhere | Show or hide the sidebar |
| `/` | Anywhere | Open the sidebar and focus its search |
| Down, `j`, Ctrl+N / Up, `k`, Ctrl+P | A focused sidebar row or group | Move to the next / previous row or group |
| Enter | A focused sidebar row or group | Show the session, or open or close the group |
| `m` | A focused sidebar row | Open the row's actions menu |
| Ctrl+Alt+Up / Ctrl+Alt+Down | Anywhere | Show the previous / next session in the sidebar's order |
| Mod+Shift+E | Anywhere | Archive the session focused in the sidebar, else the one shown |
| Ctrl+G then I | Anywhere | Pin or unpin the session focused in the sidebar, else the one shown |
| Ctrl+G then Z | Anywhere | Snooze or unsnooze the session focused in the sidebar, else the one shown |
| Esc Esc | While a turn runs and the composer is in view | Interrupt (see [The composer](#the-composer)) |
| Up / Down | A session page, the prompt empty and not focused | Focus the previous / next message you wrote; Down past the newest returns to the prompt |
| Shift+Up / Shift+Down | As above | The same over every message |
| Ctrl+Shift+A | A session page you can write to | Close the sidebar sheet and focus the prompt |

A key whose command cannot run now (archiving an archived session, focusing the prompt of a read-only one) says why in a toast when it holds Ctrl, Alt or ⌘; a plain key is left to the browser.

**Keys the browser keeps.** In a Chromium tab, Ctrl+N, Ctrl+T, Ctrl+W, Ctrl+Tab and Ctrl+Shift+T (⌘N, ⌘T, ⌘W and ⇧⌘T on macOS) never reach the page. A binding on one of them is still listed, marked with `*`; on Linux and Windows that is Ctrl+N in the sidebar, where Down and `j` do the same. The **Edit keyboard shortcuts** button is not active yet.

Every key and every More Actions entry is a command in the page's registry (`client/commands.js`), which names the terminal's command id where one means the same (`thread.archive`, `thread.interrupt`, `thread.rename`, `thread.copyMarkdown`, `thread.unarchive`, `thread.showCost`).

### Commands

The composer's endpoints. Each takes a JSON body and answers JSON: 200 with `ok: true` when Pi took it, 400 for a malformed request, 409 with an `error` sentence when it cannot act now (nothing is running, Pi is compacting, the message is no longer queued).

| Endpoint | Body | Effect |
| --- | --- | --- |
| `POST /api/send` | `{ "text": "…", "deliverAs": "steer" \| "followUp" }` | Idle: a new prompt (`delivered: "prompt"`). During a turn: steers it (`"steer"`, the default) or queues it (`"followUp"`). At most 100,000 characters. |
| `POST /api/dequeue` | `{ "kind": "steering" \| "followUp", "index": 0, "text": "…" }` | Takes that queued message out of Pi's queue if it still reads `text`; answers with its text |
| `POST /api/steer-next` | `{}` | Runs `prompt steer queued message`; a 409 carries its reason |
| `POST /api/interrupt` | `{}` | Cancels the open [dialogs](#dialogs), then runs `thread interrupt` (or Pi's abort when `ampi-tui` is off); while idle it succeeds only when there was a dialog to cancel |
| `POST /api/dialog` | `{ "id": "…", "value": … }` or `{ "id": "…", "cancelled": true }` | Answers an open [dialog](#dialogs): `true` or `false` for a confirm, one of the options for a select, text (at most 100,000 characters) for an input or editor; 400 for a value that does not fit, 409 for an id that is not open (never asked, or already answered: the first answer wins) |

[More Actions](#more-actions) take any session the sidebar lists, named by `"sessionId"` in every body, and answer 400 without it and 404 for one the sidebar does not list. The ones that change the thread index answer `{ ok, record }` with the session's record after the change, 400 for a value the index refuses (with its reason) and 409 without `ampi-threads`.

| Endpoint | Body besides `sessionId` | Effect |
| --- | --- | --- |
| `POST /api/markdown` | none | Answers `{ "markdown": "…" }`: the session's current branch through `ampi-threads`' Markdown export |
| `GET /api/export?sessionId=…&format=markdown\|json` | (query) | The same Markdown, or the JSON `ampi threads export` prints, as a download (`Content-Disposition: attachment`, `<id>.md` or `<id>.json`); JSON answers 409 for a session Pi has not saved yet |
| `POST /api/archive` | `{ "archived": true \| false }` | Sets or clears the archive date |
| `POST /api/pin` | `{ "pinned": true \| false }` | Pins or unpins |
| `POST /api/color` | `{ "color": "blue" \| "#rrggbb" \| null }` | Sets the colour, or `null` for the one picked from the id |
| `POST /api/labels` | `{ "labels": ["…"] }` | Replaces the labels; an empty list removes them |
| `POST /api/snooze` | `{ "snoozed": true \| false }` | Snoozes until the next message (the record's `snoozed` is now), or ends the snooze |
| `POST /api/unread` | `{ "unread": true \| false }` | `true` marks it unread; `false` removes the mark and sets `readAt` to now (the page sends it when it shows a session) |
| `POST /api/cost` | none | Answers `{ "cost": { total, unknown, models } }`, ampi-threads' cost report over every entry of the session; 409 with `ampiThreads.showCosts: false` |
| `POST /api/running` | none | Answers `{ where, pid, phase, cwd, branch }`: `where` is `this-terminal`, `terminal`, `execute`, `app` or `none` |
| `POST /api/rename` | `{ "name": "…" }` | Renames the session (spaces collapsed, at most 200 characters) as in [More Actions](#more-actions); 409 `{ state: "elsewhere", kind, pid, gui, error }` for a holder that cannot take it, or the holder's own answer when its GUI server renamed it |
| `POST /api/delete` | none | Deletes the session file and its thread index record; 409 while any live process has it open (`{ state: "elsewhere", kind, pid, gui, error }`, or the session this process runs) |

`GET /api/sessions` answers `{ currentId, groups, actions }`: the id of this terminal's session, the groups above with their rows (`id`, `title`, `cwd`, `modified`, `messageCount`, `color`, `labels`, `pinned`, `archived`, `snoozed`, `unread`, `live`, `elsewhere`), and which More Actions this session can do (`archive` when the thread index is there, `markdown`, `cost`). `GET /api/sessions/<id>` answers `{ session, row, items, groups }` for a listed session, the same transcript items and work groups as the snapshot, or 404.

### Live updates

The page loads the transcript once (`GET /api/transcript`, which includes the work groups and the queued messages), then follows the session's event stream (`GET /api/events`, `text/event-stream`): status changes, new messages, text as it streams, tool calls starting and finishing, work groups that changed (`groups`: `{ groups, removed }`, each group `{ id, callIds, label, status, startedAt, endedAt }`, sent before the message or call event that changed it), the end of each turn, changes of the queue and changes to the session's name, model or mode, and in a session `ampi app` runs the [dialogs](#dialogs) that open and close and extensions' notifications. If the connection drops, the browser reconnects and the server replays the events it missed; if too many were missed, the page reloads the transcript.

Pi starts each session with a fresh set of extensions, so `/new`, `/resume` and `/fork` stop the old server and start a new one with a new link.

### Dialogs

Extensions ask the user through Pi's `ctx.ui`: a confirm before a risky tool call, a choice from a list, a line of text or a longer text to edit. Where the question appears depends on what runs the session.

- **A terminal session** asks in the terminal, as without the web GUI. Its page, and `ampi app` showing it live, never shows the question; while a tool call waits for approval, the note above the composer says to answer it in the terminal.
- **A session `ampi app` runs** has no terminal, so its page asks. One question shows at a time, as a modal over the page, oldest first: a confirm has No and Yes, a select a list (arrow keys, Home and End move, a click picks, a double click or Enter chooses), an input a field and an editor a text area. Enter answers (Shift+Enter is a new line in the text area), Esc cancels, and Tab stays inside the modal. Every page that shows the session sees the question; the first answer wins and closes it everywhere.
- **Cancels.** An extension gets a cancel (`undefined`, or `false` for a confirm) when you press Esc, when its own timeout passes or its abort signal fires, when you interrupt the turn, when the session ends, and when nobody is there to answer: once no page has had the session open for 15 minutes, every open question is cancelled. For a tool approval a cancel means the tool does not run, so the agent carries on and settles instead of waiting for good, and `ampi app` can then stop the worker by its idle rule (idle for 15 minutes with no page open). A question asked while no page has had the session open for 15 minutes or more is cancelled at once. In `ampi app` only the session the page shows has its event stream open, so open the session to answer its questions.
- **Notifications** (`ctx.ui.notify`) show as a toast at the top centre of the page, coloured for warnings and errors. A toast reaches only the pages that follow the session when it is sent, so ampi's own What's New notice is left for the next terminal session. Status lines, widgets, the title, the editor text and custom terminal components have no place on the page and are ignored, as in Pi's RPC mode.
- **How.** The worker binds a `ctx.ui` of its own (`packages/ampi-cli/src/app-worker.js`), so extensions see `ctx.hasUI === true`, `ctx.mode === "rpc"` and Pi's theme from Pi's settings as `ctx.ui.theme`. Its dialogs call the host record's `dialog` handler, which ampi-gui sets at `session_start` and takes back at `session_shutdown`; before it is set, a dialog is cancelled. The bridge (`dialogs.ts`) keeps the open questions under random ids, so an answer can never reach another session's question, sends `event: dialog` `{ id, kind, title, message, options, placeholder, initial }` and `event: dialog_closed` `{ id, answeredBy }` (`page`, `timeout`, `abort`, `interrupt`, `unattended` or `shutdown`), lists them in the transcript's `dialogs` (`null` for a terminal session) so a page that reconnects shows them again, and sends notifications as `event: notice` `{ message, level }`. `POST /api/dialog` answers (see [Commands](#commands)).

### Security model

- The server listens on `127.0.0.1` only, on a random free port. Nothing on the network can reach it.
- Every request must name the server in `Host` (`127.0.0.1:<port>` or `localhost:<port>`), which stops a web page from reaching it through DNS rebinding. A request whose `Origin` is another site, or another local port, is refused, and a POST must carry the server's own origin.
- Every request needs the per-process access token: 32 random bytes, new for every session. The link carries it once; the server then sets it as an `HttpOnly`, `SameSite=Strict` cookie for that port and redirects to `/`, so the token leaves the address bar and history. The token is never logged, and the live registry entry holds only its SHA-256 hash.
- **Token files.** While a GUI server runs (a terminal's GUI, a session `ampi app` runs in a worker, and `ampi app`'s own page), its process also writes the token to `<agentDir>/data/ampi/live/<pid>.token`, next to its live registry entry. It is there so that `ampi app` can reach a terminal's GUI on your behalf, and so that a second `ampi app` can print the running one's link. The file is owner-only (`0600`) in the owner-only (`0700`) registry directory, is written before the entry names the GUI and removed when the GUI stops: at `session_shutdown`, when the entry's `gui` goes back to `null`, and, best effort, when the process exits. Readers use a token file only when its SHA-256 matches the entry's `tokenHash`, ignore one that is missing, unreadable or different, and remove it together with the entry of a process that no longer runs. The files add no new reader: a process that runs as your user can already read the token from the terminal's output, from the browser's profile (the cookie) or from the Pi process's memory, and other users cannot read the directory.
- **`ampi app`'s token reaches every live session.** Through the app, its page reaches not only the sessions it runs in its own workers but every session a terminal runs with the web GUI on: whoever holds the app's link or its cookie can read, send to and interrupt all of them. The app forwards each request with that GUI's own token and never passes those tokens or cookies to the browser.
- Commands are POST requests with a JSON body (`Content-Type: application/json`, at most 512 KiB). A POST without the cookie, without an `Origin` or with another origin is refused with 403 before its body is read, so another page in the browser cannot send a message, even with the cookie the browser holds.
- Every message, queue change and interrupt goes through the terminal process's Pi session, the same way the terminal's keys go, and so does renaming that session. Other sessions are read, parsed in memory without opening them in a session manager, which might rewrite an old file. Two More Actions are the exceptions, and only when you choose them: **Rename** of a session no live process has open appends Pi's `session_info` entry to its file through Pi's session manager, and **Delete**, after you confirm it, removes a session file no live process has open. Both check the live registry just before; a session another process has open is renamed by that process or not at all, and never deleted.
- Responses carry no CORS headers, a Content-Security-Policy that allows only the page's own scripts, styles and connections, and `X-Frame-Options: DENY`.
- The server serves only files inside its `client/` directory, by extension with an explicit content type. Model output is HTML-escaped before Markdown formatting is applied, and links keep only `http`, `https` and `mailto` targets.
- Apart from those two, it writes nothing outside ampi's data directory: its port in ampi-core's live registry entry, its token file, and the thread index through `ampi-threads` for More Actions and when a page shows a session (its read date). The page itself stores its preferences in a cookie and the colour scheme in `localStorage`. Anyone who can run programs as your user can read the token from the terminal, the browser or the token file; the GUI does not protect against them.
- `thread open in browser` and `ampi app --open` (also when a second `ampi app --open` opens the running app's link) pass the link, token included, to `xdg-open` or `open` as a command-line argument. On a machine shared with other users, they may be able to read it there (on Linux, from `/proc/<pid>/cmdline`), for as long as that process runs; a browser that the command starts keeps the link in its arguments until it quits. On a shared machine, copy the link from the notice, or the one `ampi app` prints, into a browser that is already running instead.

## Diagnostics and troubleshooting

- **No `Web GUI:` notice.** The GUI is off (`ampiGui.enabled` is not `true` and `AMPI_GUI_ENABLE` is unset), or Pi is not running in the interactive terminal. A session `ampi app` hosts never prints one: the app opens its link.
- **"ampi-gui: could not start the web GUI".** Pi could not listen on `127.0.0.1`, for example in a sandbox without loopback networking.
- **The page says "Open the link Pi printed to use this page".** The browser has no cookie for this port: open the full link from the notice (or run `thread open in browser`). Links from an earlier session stop working when that session ends.
- **The composer says "Disconnected".** Pi quit or switched to another session; the browser keeps retrying, and the send button stays off until it is back. Open the link the new session printed.
- **"This session does not show ampi its queue".** `ampi-tui` is off, or this Pi version changed how ampi reads its queue: the queued messages show only as a count, and Delete, Edit and the steer arrow are not offered.
- **A queued message came back in the terminal after an interrupt.** That is Pi's behaviour on an interrupt from either side; send it again from the terminal or copy it over.
- **More Actions has no Pin, Labels, Color, Snooze or Archive, or Cost & Usage is greyed out.** `ampi-threads` is off, or `ampiThreads.showCosts` is `false`; those actions need its thread index and reports.
- **Rename or Delete says another process has the session open.** Rename it in that process (a terminal without the web GUI, or an `ampi -x` run); delete it once that process has closed it. Delete is also greyed out for a session the sidebar shows as running.
- **A session is missing from the sidebar.** The list comes from Pi's session directory and is cached for a few seconds; a session Pi has not saved yet (no message sent) appears only in the terminal that runs it.
- **`ampi app` shows a terminal's session read-only.** That terminal runs without the web GUI (the banner says so): start its Pi with `ampiGui.enabled: true` or `AMPI_GUI_ENABLE=true` and resume the session. If the GUI is on, its token file (`<agentDir>/data/ampi/live/<pid>.token`) is missing or does not match the entry, for example because it was deleted; restarting that terminal's Pi writes it again.
- **`thread open in browser` only shows the link.** No desktop was found (`DISPLAY` and `WAYLAND_DISPLAY` are unset) or the platform has no opener; copy the link into a browser.

## Public API

Stable re-exports from `ampi`: `createMmrGuiExtension`, `loadMmrGuiSettings` and the `MmrGuiSettings` / `MmrGuiFactoryOverrides` types, each with its `Ampi*` alias. Canonical catalog: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## Developer notes

- Manifest: risk class `local-server` (a token-protected HTTP endpoint on `127.0.0.1`; its only outbound requests are `ampi app`'s, to its own workers on `127.0.0.1`), child role `none`. No subagent child keep-set lists it.
- Layout: `index.ts` (entry point: the gate, the server's lifetime from `session_start` to `session_shutdown`, the GUI's fields in ampi-core's live registry entry, the command, and the hosted and app cases through ampi-core's `gui-host.ts`), `config.ts` (settings), `server.ts` (`node:http`: the request policy every server shares, `startMmrGuiHttpServer`, then a session's routes, static files, the event stream, POST bodies), `hub.ts` (`ampi app`'s server: the session list with hosts, forwarding to workers, the single-writer checks), `commands.ts` (the composer's commands, More Actions and the export), `sessions.ts` (the sidebar's groups from ampi-core's session catalogue, the thread index and ampi-core's live registry; read-only views of saved sessions), `bridge.ts` (Pi events to client events through `ampi-core/thread-status.ts`, the queue from `ampi-core/prompt-queue.ts`, the replay buffer and the transcript snapshot), `view-model.ts` (session messages to transcript items, tool calls labelled by `ampi-core/tool-activity.ts`, work groups by `ampi-core/activity-runs.ts`), `client/` (the page: `index.html`, `app.js`, `app-mode.js` (app mode's pure helpers: session base, addresses, row labels, banners, the list timer), `transcript.js` (drawing items, work groups, call details and the work fold), `composer.js`, `sidebar.js` (the session list, search, resizing and the moves its keys make), `titlebar.js` (More Actions, from the title bar or a sidebar row: its entries and submenus, the Running in card, and the Rename, Labels, Cost & Usage and Delete dialogs), `prefs.js` (the page's preferences in the `ampi_gui_prefs` cookie), `commands.js` (the command registry: every keyed action, its section, default keys and availability), `keys.js` (the key dispatcher: the chord grammar, key presses as chords, sequences, the field rule, conflicts, key labels), `keymap.js` (the Keymap overlay), `markdown.js`, `tokens.css`, `app.css`).
- The live registry moved to ampi-core. Earlier releases kept it here and wrote version 1 files (`{ version, pid, sessionPath, cwd, port, tokenHash, startedAt }`) only while the GUI ran; ampi-core now writes version 2 entries for every running session that has a file, with the GUI's port and token hash under `gui`, and its readers still accept version 1 files. The GUI calls `setMmrLiveFields` and never writes a registry file itself. `MmrGuiFactoryOverrides.registryDir` now only sets where the sidebar reads the registry.
- Commands reuse the terminal's paths: `pi.sendUserMessage` with `deliverAs` for sending, the registered `prompt.steerQueuedMessage` and `thread.interrupt` commands, and ampi-core's prompt-queue seam, which `ampi-tui` owns and serves through its `pi-compat/queue.ts`, for the queue. The GUI never patches Pi itself.
- More Actions reach `ampi-threads` through ampi-core's seams, never by importing it: `ampi-core/thread-index.ts` for the index fields, the user's title and the snooze and unread rules (`isMmrThreadSnoozed`, `isMmrThreadUnread`), `ampi-core/thread-reports.ts` for the Markdown export and the cost (`costOfEntries`, which is `summarizeMmrThreadCost` with ampi-threads' prices). The JSON export repeats `ampi threads export`'s object; `tests/mmr-gui-actions.test.mjs` compares the two on one session.
- The client is plain ES modules and CSS custom properties with no build step and no external assets. The Content-Security-Policy allows no inline styles, so the client sets a custom disc colour through the CSS object model. Colours are `light-dark()` pairs; `html[data-ampi-color-scheme]` forces a scheme. Fonts are `system-ui` and the platform's monospace font.
- Markdown is rendered in the browser by `client/markdown.js`, a small renderer written for this page, so the package adds no runtime dependency.
- A snapshot joins the saved branch with the messages of the current run that Pi has not written yet (Pi writes a message after the extensions have seen its end). Items are keyed by role and message timestamp, so both sources give the same id.
- Tests: `tests/mmr-gui-server.test.mjs` (Host, Origin and token checks, static file policy, JSON routes, the session list and view, More Actions, the composer's commands and their CSRF policy, the event stream and its replay, against a real server), `tests/mmr-gui-sessions.test.mjs` (the sidebar's groups and their order, reading a saved session without writing it), `tests/mmr-gui-shell.test.mjs` (disc colours, relative times, the search filter, the sidebar width and the More Actions entries and submenus), `tests/mmr-gui-actions.test.mjs` (every More Actions route on sessions Pi wrote, with the real ampi-threads: validation and 404s, the live-holder 409 for rename and delete with the file unchanged, a rename forwarded to a holding terminal or app session, rename and delete of a session nobody holds, the exports against `ampi threads export`, the cost through `costOfEntries`, Running in, the snooze and unread rules and the Snoozed group, the new index fields through the store and the CLI's copy, and the preferences cookie, label rules, dialog escaping and page addresses), `tests/mmr-gui-keys.test.mjs` (key presses as chords on both platforms, sequences on a fake clock, the field rule, conflicts, `when()` gating, the default commands and the overlay's columns), `tests/mmr-gui-bridge.test.mjs` (Pi events to client events, the queue, the snapshot, the view model), `tests/mmr-gui-work-groups.test.mjs` (work groups from the cases the terminal's tests share in `tests/helpers/activity-run-cases.mjs`, their status and duration, the `groups` events, call details, and the client's drawing, diff escaping, durations and work folds), `tests/mmr-gui-composer.test.mjs` (the composer's keys, requests and button state), `tests/mmr-gui-extension.test.mjs` (settings, the gate, the server's lifetime, its port in the live registry entry, the command, load order), `tests/mmr-gui-hosted.test.mjs` (a hosted session: RPC mode, the host's token, `ready` once, the `app-session` entry, the setting ignored, the Host, Origin and token checks, the dialog and notice handlers, nothing without a host), `tests/mmr-gui-dialogs.test.mjs` (dialogs: the queue and its events, the snapshot, the first answer winning, 400 and 409, the timeout, abort, interrupt, shutdown and unattended cancels on a fake clock, the modal's escaping, `POST /api/dialog` against a real server), `tests/mmr-gui-hub.test.mjs` (app mode against real session servers and a recording worker: the list with hosts, forwarding with the exact upstream headers, the checks before forwarding, starting one worker per session, 409, 502 and 504, giving way to another process, the idle stop, the `app` entry and its token file; a terminal session's GUI reached through its token file, read-only without a matching one, 502 when it has gone), `tests/mmr-gui-token-files.test.mjs` (the token files' modes, written and removed with the GUI, on exit, the hash check and the removal with a dead process's entry, for both registry readers), `tests/mmr-gui-app-client.test.mjs` (app mode's client helpers: the session base, addresses and history entries, row labels for every host and flag, the banner for each state, escaping, the list timer) and `tests/mmr-gui-markdown.test.mjs` (the renderer and its escaping).

### App mode

The command runs an in-memory Pi session (never saved) in RPC mode, without MCP, with a GUI host record of role `hub`: `{ role: "hub", token, ownerPid, ready({ port }), startSession(request) }` ([`gui-host.ts`](../ampi-core/gui-host.ts)). With it, `index.ts` starts `hub.ts`'s server instead of a session's, whatever `ampiGui.enabled` says, and ampi-core records the process as `app` with `sessionPath` `null`; a second `ampi app` finds that entry, reads the page's token from the app's token file (checked against the entry's hash), prints the link (opening it with `--open`) and exits 0, or exits 1 when it cannot read the link. The app's session writes no session file; worker processes (`ampi app --worker`) write theirs, each the only writer of its file. `startSession({ path })` forks a worker with a token of its own and resolves `{ pid, port, token, sessionId, sessionPath, stop(), onExit(fn), onActivity(fn) }` once its GUI listens. Ctrl+C or SIGTERM stops every worker (each is killed if it has not exited 5 seconds after `stop`), ends the app's session and exits 0.

- The hub shares `server.ts`'s request policy (`startMmrGuiHttpServer`): loopback only, the Host and Origin checks, the token link and cookie, no CORS, its client files. Its routes:

  | Route | Answer |
  | --- | --- |
  | `GET /`, `GET /s/<id>` | `index.html` |
  | `GET /api/app` | `{ app: true }`; a session server answers 404, which is how the page knows its mode |
  | `GET /api/events` | an event stream with `event: sessions` (no `id`, data `{}`) each time one of the app's workers starts or stops |
  | `GET /api/sessions` | every session in Pi's default session directory, grouped as in [Sessions](#sessions); each row also has `host`: `null`, or `{ kind, pid, gui, phase }` from the live entry of the process that has it open |
  | `GET /api/sessions/<id>` | the read-only view |
  | `GET /api/export`, `POST /api/markdown`, `/api/archive`, `/api/pin`, `/api/color`, `/api/labels`, `/api/snooze`, `/api/unread`, `/api/cost`, `/api/running` | as in [Commands](#commands), for any session |
  | `POST /api/rename` | forwarded to the worker or the terminal's GUI that runs the session, or to another app's worker; 409 for a holder without a GUI and for a session a worker is starting; a session nothing runs is renamed in its file, as on a session server |
  | `POST /api/delete` | 409 for a session one of the app's workers runs or is starting; otherwise as on a session server |
  | `/s/<id>/api/<rest>` | that session's own routes, by state (below) |

- **Hosted** by one of the app's workers: the request goes to the worker's server as `/api/<rest>` with the query string, event streams included. The hub sets `Host` to the worker's `127.0.0.1:<port>`, sends the worker's token cookie and, for a POST (whose `Origin` the policy already checked against the hub's own), the worker's origin; of the browser's headers only `Content-Type`, `Accept` and `Last-Event-ID` go on. Only `Content-Type` comes back, under the hub's security headers, so a worker's `Set-Cookie` never reaches the browser. A worker that no longer answers gives 502 `{ state: "gone" }`.
- **Terminal**, held by a terminal session (`kind` `tui`) whose GUI serves it: the hub reads the terminal's token from its token file, uses it only when it matches the entry's `tokenHash`, and forwards every request to the terminal's server exactly as to a worker (the same headers in and out, event streams included). The message, queue change or interrupt goes through the terminal's own Pi session, so the hub never writes the file. When the terminal's server does not answer, 502 `{ state: "gone" }`; the hub then reads the registry again, which removes a dead process's entry and token file, and sends the pages `event: sessions`.
- **Elsewhere**, held by another live process (a terminal without the GUI or without a matching token file, a print or RPC run, another app's worker): `GET transcript` and `session` read the file (`{ …, state: { state: "elsewhere", kind, pid, gui } }`, `gui` saying whether the holder serves a GUI), `events` and every POST answer 409 `{ state: "elsewhere", kind, pid, gui, error }`. `gui` is left out when the holder was reported by a worker rather than read from the registry.
- **Not running**: the same from the file with `{ state: "not-running" }`; `events` and every POST but `send` answer 409. `POST send` starts a worker (`startSession({ path })`; concurrent sends share one start), waits for it and forwards the message. A send that waits 30 seconds answers 504 without sending; the start goes on, and once the worker is ready the session is hosted, so the next send reaches it.
- **Imported** by `ampi threads import` (its file holds the `ampi-import` entry, whether or not another process has it open): the same from the file with `{ state: "imported" }`; `events` and every POST answer 409 `{ state: "imported", error }`, and no worker is started.
- **One writer per file.** The hub reads the live registry immediately before `startSession` and refuses a file another live process names (409); the worker checks again and refuses too. Every 2 seconds the hub reads the registry again: when another process opens a file one of its workers runs, it stops the worker if the agent is idle and sends the page `event: session` `{ state: "elsewhere", kind, pid }` on that session's event streams, or, while the agent works, `event: warning` once per holder. These events have no `id`, so the replay position stays the worker's. A worker idle for 15 minutes with no event stream open is stopped. All of these timers and the clock are injected.

#### The page in app mode

The page asks `GET /api/app` first; a session server answers 404 and the page behaves exactly as on a terminal's own GUI (`#/s/<id>` addresses, the banner that points back to the terminal). With `{ app: true }` it runs in app mode (`client/app-mode.js` holds its pure parts):

- **Two bases.** Requests about one session (`transcript`, `events`, `send`, `dequeue`, `steer-next`, `interrupt`) go to `/s/<id>/api/`; requests about every session (`sessions`, every More Actions route, `events` for the list) go to `/api/`.
- **Addresses.** Each session is at `/s/<id>` with a history entry `{ ampiSession: id }`, so Back and Forward show the session again (live or read-only, as it is then). `/` shows a prompt to pick a session.
- **Rows.** Each row's disc is an image whose `aria-label` is `<host>, <flags>`: the host is "Running in a terminal" (`tui`), "Running in ampi -x" (`execute`), "Running in ampi app" (`app-session`) or "Not running"; the flags, in this order, are "Live" (the process serves a GUI), "Working" (its status phase is neither idle nor error; the disc spins) and "Error". The list reloads on `event: sessions`, every 5 seconds while the page is visible (and at once when it becomes visible again), on focus and after each turn; a redraw keeps keyboard focus on the same row.
- **Opening a session.** `GET transcript` decides: a snapshot (hosted) shows the session live and follows its events; an answer with `state` is drawn from the file. `elsewhere` shows a banner naming the holder and its pid and hides the composer (for a terminal with `gui: false`, the banner says to turn on ampiGui in that terminal to continue the session here); `not-running` keeps the composer, whose first send shows Starting and, once the hub answers, loads the worker's snapshot; `imported` turns the composer off with the reason; a 502 (`gone`) says to pick the session again. Titles and holder names are HTML-escaped in banners. When the list shows that a read-only session's holder went away, or that a session shown as not running now runs, the page opens it again.
- **Hand-over.** `event: session` with `state: "elsewhere"` on a live session's stream, or a 409 `elsewhere` on a command, turns the view read-only in place: the drawn transcript and its scroll position stay. A stream the hub refuses, or another answer with `state`, opens the session again at the same scroll position. `event: warning` shows its message as a notice.
