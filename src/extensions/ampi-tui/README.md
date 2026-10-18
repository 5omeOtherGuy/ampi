# ampi-tui

Owns the look and keys of interactive `ampi` sessions in the terminal: an Amp-compatible prompt box that carries the session's state in its borders, Amp-compatible key chords, a welcome header with ampi's mark and the newest changelog item, Amp-compatible message styling and tool rows, and the `ampi` theme.

Package overview: [`../../../README.md`](../../../README.md). Planning: [`../../../ROADMAP.md`](../../../ROADMAP.md). Public API: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## At a glance

| Default | Provides | Requires | Diagnostics |
| --- | --- | --- | --- |
| On | Prompt box with mode, cost, turn status and path in its borders; queued messages above it; welcome header, message styling, grouped tool rows, `ampi` theme; Ctrl+X leader, Esc Esc, Ctrl+C Ctrl+C, Home/End; command palette on Ctrl+O and `/`; prompt history on Ctrl+R; Switch Thread picker; `@:` commit and `@@` thread mentions; Thread Cost and Analyze Context overlays; mode dial on Ctrl+S; Alt+T details toggle; shortcuts help on `?`; Help & Keymap screen and the keymap as JSONC from the palette; message navigation on Shift+Tab and Tab with `e` to edit; terminal title, notifications, quit summary | Interactive Pi session | Welcome header at startup; rounded prompt box at the bottom, no footer; a "then" popup after Ctrl+X or Ctrl+C; the window title; `/ampi-status` |

## When to use it

- You want the transcript and the prompt to fill the terminal, with the mode, cost, turn status and working directory in the prompt's frame instead of status rows below it.
- You want Amp-compatible transcript styling: barred user messages, quiet thinking, colours from your terminal palette.
- You want Amp-compatible keys: two Escapes to interrupt, Ctrl+C twice to quit, a Ctrl+X leader, Home and End to jump through the transcript, a command palette on Ctrl+O.
- You want to step back through your own messages and edit one, with the thread continuing from that point on a new branch.
- You are building on ampi's terminal layout or keys: later layout and key work lands here, not in `ampi-core`.

## Status and enablement

Default: on. `ampi-tui` is registered in `package.json` `pi.extensions` and loads without opt-in config. Opt out with `ampiTui.enabled: false` (see [Configuration](#configuration)).

It acts only in interactive terminal sessions. Print, JSON and RPC runs, subagent workers included, are left untouched. It owns no tools or feature gates. It registers palette commands in `ampi-core`'s command registry and binds their keys.

## Tools / commands / surfaces

| Surface | Type | Purpose |
| --- | --- | --- |
| Header | Pi header slot | Welcome screen: ampi's animated mark, "Welcome to ampi", key hints and the changelog card |
| Prompt box | Pi editor slot | Replaces Pi's editor: a rounded frame with the mode, cost, turn status, hints and working directory in its borders |
| Footer | Pi footer slot | Replaced with an empty component, so no row is drawn below the prompt box |
| Working row | Pi working indicator | Hidden; the prompt box's bottom border shows the turn status |
| Tool rows | Pi tool renderer | One summary line per run of tool calls, and a row and card per call when tool output is expanded |
| `thread.interrupt` | Command, `esc esc` | Stop the running turn |
| `ampi.quit` | Command, `ctrl+c ctrl+c` | Quit Pi, stopping a running turn first |
| `thread.scrollToTop`, `thread.scrollToBottom` | Commands, `home` / `end` | Jump to the start or end of the transcript while the prompt is empty |
| `prompt.openInEditor` | Command, `ctrl+g` | Edit the prompt in your external editor (Pi's own action) |
| `prompt.history` | Command, `ctrl+r` | Open the prompt history picker (needs `ampi-threads`, which records the prompts) |
| `thread.switch` | Command, no key | Open the Switch Thread picker (needs `ampi-threads`, which makes the switch) |
| `thread.mention` | Command, no key | Open the Mention Thread picker and insert `@<session id>` at the cursor, as `@@` does |
| Mentions | Pi autocomplete provider | `@` keeps Pi's file rows and adds hints; `@:` lists commits; `@@` opens the Mention Thread picker ([Mentions](#mentions)) |
| `thread.showCost` | Command, no key | Open the [Thread Cost](#thread-cost-and-analyze-context) overlay (needs `ampi-threads`, which computes the cost) |
| `thread.analyzeContext` | Command, no key | Open the [Analyze Context](#thread-cost-and-analyze-context) overlay (needs `ampi-threads`) |
| `thread.toggleOutline` | Command, no key | Show or hide the [outline](#outline) of the last response next to the prompt |
| `ampi.showVersion` | Command, no key | Show the ampi and Pi versions |
| `ampi.help` | Command, no key | Open the [Help & Keymap screen](#help--keymap-screen) |
| `ampi.keymapJson` | Command, no key | Show the keymap in effect as JSONC ("ampi show keymap" in the palette) |
| `ampi.palette` | Command, `ctrl+o` | Open the command palette |
| `prompt.openPalette` | Command, `/` | Open the command palette when the prompt is empty |
| `thread.toggleDetails` | Command, `alt+t` | Expand or collapse tool output and thinking together |
| `prompt.toggleHelp` | Command, `?` on an empty prompt | Show or hide the shortcuts help inside the prompt box |
| Queue box | Pi widget above the editor | Lists the messages waiting for the running turn: `steering:` and `queued:` |
| `prompt.queue` | Command, no key | Queue the prompt to run after the current turn instead of steering it |
| `prompt.dequeue` | Command, Backspace on an empty prompt | Take every queued message back into the prompt (Pi's `app.message.dequeue`, also on Alt+Up) |
| `prompt.steerQueuedMessage` | Command, Enter on an empty prompt | Send the next queued message now, to steer the running turn |
| `thread.selectPreviousMessage`, `thread.selectNextMessage` | Commands, `shift+tab` / `tab` on an empty prompt | Select an earlier user message, or the next one; past the newest, clear the selection ([Message navigation](#message-navigation)) |
| `thread.editSelectedMessage` | Command, `e` while a message is selected | Put the selected message into the prompt and continue the thread from before it, on a new branch |
| `/ampi-edit-message <entry id>` | Slash command | What `e` runs: Pi's session tree offers its navigation to commands only. Not listed in the palette |
| `ampi.status`, `ampi.changelog`, `ampi.config` | Commands, no key | Run `/ampi-status`, `/ampi-changelog` and `/ampi-config` (need `ampi-core`) |
| `mode.toggle` | Command, `ctrl+s` | Open the mode dial; while it is open, turn it to the next mode (needs `ampi-core`); once the session's mode is locked it says why instead |
| `mode.use.low` … `mode.use.free` | Commands, no key | Switch to that mode, as `/mode <key>` does (need `ampi-core`); hidden once the session's mode is locked |
| "then" popup | Overlay | Lists the keys that can follow Ctrl+X, Ctrl+C or any other chord prefix |
| `ampi` theme | Pi package theme (`theme/ampi.json`) | Amp-compatible colour roles on ANSI palette indices |
| User messages | Transcript | A bar on every line, raw italic text in the theme's user colour, no background; a heavy frame with `e to edit` while selected |
| Thinking | Transcript | No label when thinking is collapsed |
| Command palette | Overlay | Lists every command with its key; type to filter, Enter to run |
| Prompt history | Overlay | Lists the prompts you sent, newest first; type to filter, Enter puts one into the prompt |
| Switch Thread picker | Overlay | Lists sessions with a preview of the selected one; Enter switches to it |
| Mention Thread picker | Overlay | The same list without the current session; Enter inserts a reference to the session |
| Thread Cost | Overlay | What the session cost so far, per model |
| Analyze Context | Overlay | What fills the context window, section by section |
| Mode dial | Overlay | Shows the mode with its models, turns it, and lists every mode |
| Terminal title | Pi `setTitle` | The session title and working directory, with the turn status in front |
| Notifications | Terminal escape sequence, bell, sound | Tell you when a turn finished or needs you |
| Quit summary | Normal scrollback | ampi's mark, the session title and the working directory after you quit |
| Help & Keymap | Overlay | Lists every key and command with the key in effect |
| Keymap (JSONC) | Overlay | The keymap in effect as JSONC, to copy into `ampi.keymap` |

## Configuration

One switch turns the extension off. It has no secrets.

```json
{ "ampiTui": { "enabled": false } }
```

The nested form `{ "ampi": { "tui": { "enabled": false } } }` is accepted too. Settings are read from `~/.pi/agent/settings.json` and then `<project>/.pi/settings.json`. The project file wins. An environment variable overrides both:

| Variable | Effect |
| --- | --- |
| `AMPI_TUI_ENABLE` | `false` turns the extension off, `true` turns it on |
| `MMR_TUI_ENABLE` | Legacy name, read when `AMPI_TUI_ENABLE` is unset |

`ampi-tui` also reads Pi's own `quietStartup` from the same files: with `"quietStartup": true` it draws no welcome header (see [Welcome header](#welcome-header)).

Notifications have three switches, shown here with their defaults. Each one can be set on its own, and the project file wins per switch:

```json
{ "ampiTui": { "notifications": { "enabled": true, "system": true, "sound": false } } }
```

| Switch | Effect |
| --- | --- |
| `enabled` | `false` turns every notification off; the terminal title stays |
| `system` | The desktop notification through the terminal, or the bell in its place |
| `sound` | A sound through `paplay`, when it and the freedesktop sound theme are installed |

| Variable | Effect |
| --- | --- |
| `AMPI_FORCE_BEL` | `1` rings the terminal bell instead of sending a desktop notification |

The settings are read once when the extension loads. Restart Pi or run `/reload` after changing them.

Animations can be turned off for a still terminal, with the setting or with the environment variable `NO_ANIMATION` set to any non-empty value:

```json
{ "ampiTui": { "animations": false } }
```

Spinners on running tool rows, worker rows and the task list then stay on their first glyph, the prompt box's wave glyph stays on `∼`, and the welcome mark does not play. Unlike the other settings, this one is read each time a row, a widget or a session starts, so it applies to the next one without a restart.

### Keymap

Rebind or unbind any command under `ampi.keymap` in Pi's settings. Each entry maps a command id to a key string, an array of key strings, or `null`; `leader` changes the leader key.

```json
{ "ampi": { "keymap": { "leader": "alt+x", "ampi.showVersion": "<leader>v", "thread.scrollToTop": null } } }
```

Key strings follow `ampi-core`'s keymap grammar ([`docs/ampi-core-api.md`](../../../docs/ampi-core-api.md#keymap)): combos such as `ctrl+c`, chords separated by spaces such as `ctrl+c ctrl+c`, and `<leader>` at the start of a chord. Overrides are read at each session start; run `/reload` after editing them. Unknown command ids, keys that do not parse, two commands on one key, and a key that is also the start of a longer chord are reported once as a warning.

To start from the keys in effect, pick "ampi show keymap" in the command palette: it shows every command id with its key (or `null`) and its description as JSONC, ready to copy under `ampi.keymap`. Outside a session, `ampi config keymap` from the [`ampi` command](../../../packages/ampi-cli/README.md#keymap-and-settings) prints the same list for the current directory.

## Behavior

### With ampi-core

- At session start, `ampi-tui` claims ampi's terminal chrome through ampi-core's chrome-owner seam, installs an empty footer, and replaces Pi's editor with the prompt box.
- While it holds the claim, ampi-core stops drawing its two-line footer in locked modes and no longer brings Pi's footer back in `free` mode.
- ampi-core hands its new-version changelog notice to `ampi-tui`, which shows it as the welcome card instead of a notification. With `quietStartup: true`, or outside the terminal UI, the notification shows as before.
- Mode switching, mode state and `/ampi-status` work as before, except for ampi-core's own cycle keys: Ctrl+S opens the [mode dial](#mode-dial) instead, and the deprecated Ctrl+Space does nothing while `ampi-tui` is on.
- The prompt box reads the active mode from ampi-core and shows the turn status through ampi-core's thread status model.
- Everything is released when the session shuts down, and the commands are unregistered. If you turn `ampi-tui` off and reload, ampi-core's footer and notification return, Pi's header, editor and keys come back and user messages are drawn by Pi again.
- Turned off, `ampi-tui` registers nothing at all, and the session looks and behaves as it did before this extension existed.

### Prompt box

The prompt sits in a rounded box across the full width of the terminal, at the bottom of the screen:

```text
╭───────────────────────────────────────────────── $0.02 ─ medium ─╮
│ Rename the parser module and update its imports                  │
│                                                                  │
│                                                                  │
╰ ≈ Running Tools bash · Enter to steer ─────── /work/repo (main) ─╯
```

- **Top border, right: cost and mode.** The active ampi mode in its colour (`low` yellow, `medium` green, `high` blue, `ultra` violet; `free` in the border colour), and before it the cost of the session so far. A new session shows no cost; during its first turn the cost reads `$····` until the first response arrives. Below one cent it has three decimals (`$0.003`), above it two. It is the total `thread show cost` shows: what Pi recorded for each response, usage entry and summary, or the tokens at the model's price where the provider recorded none. `ampiThreads.showCosts: false` hides it.
- **Bottom border, left: turn status.** While a turn runs, an animated wave glyph, the status (`Sending`, `Thinking`, `Streaming`, `Running Tools`, `Auto-Compacting`, `Waiting for Approval`, `Cancelling`, or `Error` after a failed response), a detail such as the tokens streamed so far in this stage (`23 tok`, estimated at four bytes a token) or the running tool, and a key hint: `Enter to steer`, or `Enter to steer, Backspace to dequeue` while messages are queued. After the first Ctrl+C it shows `ctrl+c again to force quit`.
- **Bottom border, right: where you are.** The working directory, with the git branch in parentheses. When the border gets crowded the path is shortened from the left (`…/repo (main)`) and then left out; the status keeps its room.
- **Text.** One column of padding inside the frame. The box keeps three text rows when empty and grows with its content up to a third of the terminal height (8 rows in a 24-row terminal, 14 in a 44-row one); after that the text scrolls with the cursor. Text wraps as in Pi's editor. In terminals under 15 rows Pi's own minimum of 5 rows applies.
- **Shell commands.** While the prompt starts with `!`, the frame takes Pi's shell-command colour, as Pi's editor border does.
- **Overlays.** While the command palette is open, the frame is drawn dim. Pi's own dialogs and selectors leave it as it is.

### Shortcuts help

Type `?` into an empty prompt to list the main keys inside the prompt box, above the text, with a rule under them (here in a 44-row terminal):

```text
╭───────────────────────────────────────────────────────────────────── medium ─╮
│ Ctrl+S switch modes             Alt+D toggle thinking                        │
│ Alt+Enter newline               @ mention files                              │
│ Ctrl+X leader key               Ctrl+O open command palette                  │
│ / open command palette          Esc Esc interrupt                            │
│ Ctrl+C Ctrl+C quit              Home/End scroll to top/bottom                │
│ Ctrl+G open in editor           Alt+T toggle details                         │
│ Shift+Tab previous message      Tab next message                             │
│ e edit message                  ? toggle shortcuts help                      │
│ ──────────────────────────────────────────────────────────────────────────── │
│                                                                              │
│                                                                              │
│                                                                              │
╰────────────────────────────────────────────────────────── /work/repo (main) ─╯
```

- **What it lists.** The mode keys when ampi-core is loaded (the [mode dial](#mode-dial)'s key, which follows `mode.toggle` under `ampi.keymap`, and Alt+D), the newline key, Pi's `@` file mention, the leader, then every command that has a key, in the order the commands were registered, with the key in effect: a binding moved under `ampi.keymap` shows its new key, an unbound command is left out, and the help's own `?` comes last. A command with several keys lists them joined by `or` (`? or F1`). Two commands of one kind with one key each, whose names differ only in the last word, share a row (`Home/End scroll to top/bottom`).
- **Layout.** Two columns, the second starting 34 columns from the box's left edge, when every entry fits; otherwise one column, with entries cut to the width.
- **Inside tmux.** When tmux's `extended-keys` option is off, a dim line under the rows says that Shift+Enter needs it and that Alt+Enter works without it. ampi asks tmux once, the first time the help opens.
- **Height.** The box grows by the help. When that would pass a third of the terminal height, the text area shrinks to one row, then the tmux line goes, then entries from the end, except the help's own `?` row, which stays as the last one shown so the help always says how to close it; the rule always stays. In an 80x24 terminal the help has room for six rows, so the last four entries before `?` (Alt+T and the three message navigation keys, with the default commands) are left out.
- **Closing.** `?` again or Esc closes it. Any other key closes it and then does what it always does: typing a character closes the help and inserts the character, and a key that runs a command (`/` for the palette, Ctrl+G, Home or End) closes it before the command runs. Text that arrives from elsewhere (the external editor, queued messages taken back) closes it too. While a turn runs, the first Esc of Esc Esc closes it along with clearing the prompt.
- With text in the prompt, `?` is an ordinary character.

The model, token totals and context use that Pi's footer showed are not on screen; `/ampi-status` reports the mode and model.

**Keys in the prompt box.**

| Key | Does |
| --- | --- |
| Enter | Sends the prompt; while a turn runs, Pi delivers it to steer the turn |
| Enter on an empty prompt | Steers with the next queued message, while one is queued (see [Queued messages](#queued-messages)) |
| Alt+Enter, Shift+Enter, Ctrl+J | Insert a newline (Alt+Enter is Pi's follow-up key; the box takes it over) |
| Esc | Closes the shortcuts help when it is open, or clears a [message selection](#message-navigation) (while a turn runs, also as the first Esc of Esc Esc); otherwise clears the prompt when it has text. On an empty prompt with nothing running, Esc does what it does in Pi |
| `?` on an empty prompt | Shows or hides the shortcuts help |
| Backspace on an empty prompt | Takes queued messages back into the prompt (Pi's `app.message.dequeue`) |

Everything else, including Ctrl+A and Ctrl+E for the line start and end, is Pi's editor behaviour.

### Queued messages

While a turn runs, a message can wait for it in two ways: Enter steers the turn (Pi hands the message to the model at its next step), and `prompt queue message` in the palette queues it to run after the turn ends. Waiting messages are listed in a box directly above the prompt box, one per row:

```text
 ╭────────────────────────────────────────────────────────────────────────────╮
 │ steering: also check the tests                                             │
 │ queued:   then update the docs                                             │
 │           and the quick reference too                                      │
 ╰────────────────────────────────────────────────────────────────────────────╯
╭───────────────────────────────────────────────────────────── $0.00 ─ medium ─╮
│                                                                              │
│                                                                              │
│                                                                              │
╰ ≋ Running Tools bash · Enter to steer, Backspace to dequeue ─ …t/cwd (main) ─╯
```

- **Rows.** Messages that steer come first, labelled `steering:` in the accent colour; then the queued ones, the first labelled `queued:`, in a muted colour. Line breaks in a message show as spaces and long messages are cut. The box goes when nothing waits.
- **Queue.** `prompt queue message` needs a running turn and text in the prompt; with an empty prompt the palette says "type a prompt to queue it". Prompt templates and skills expand as they do on Enter, and Up on an empty prompt recalls the message. It has no key by default; bind one under `ampi.keymap`.
- **Steer a queued message.** Enter on an empty prompt, or `prompt steer queued message`, moves the next queued message into the steering ones, so the model sees it at its next step instead of after the turn. The message keeps its images and is not sent again, and messages other extensions queued for the turn stay queued.
- **Take them back.** Backspace on an empty prompt, `prompt dequeue`, or Pi's own Alt+Up puts every waiting message, steering ones included, back into the prompt, above any text already there. This is Pi's own action: it also drops the messages other extensions queued for the turn.
- The prompt box's hint reads `Enter to steer, Backspace to dequeue` while anything waits, and the queue count it uses follows Pi's queue.
- Not while Pi compacts the conversation: Pi refuses new messages then, so queueing and steering a queued message are unavailable until it finishes.
- The web GUI (`ampi-gui`) shows the same queue: `ampi-tui` publishes it through ampi-core's prompt-queue seam, and a message deleted or edited there leaves this box too.
- Pi's own list of queued messages above the editor is not drawn while the box is there. When a Pi release changes how its queue is reached, the box and `prompt steer queued message` are left out and Pi's list returns; queueing, Backspace and `prompt dequeue` keep working.

### Keys

**Chords.** A key binding is one key or a chord of several keys pressed one after the other. After the first key of a chord, ampi waits up to 1.5 seconds for the next one and shows a popup above the prompt, at the right edge, titled with the key pressed so far ("Ctrl+X then"). Each row names a key that can follow and what it does, sorted by key. Pressing a listed key runs its command; Esc closes the popup; any other key closes it and does what it normally does, or starts its own chord. The popup also closes by itself when the wait ends.

**Leader.** Ctrl+X is the leader key: bindings written as `<leader>z` mean Ctrl+X, then Z. The popup appears after Ctrl+X even when nothing is bound after it yet, and says so. `ampi.keymap.leader` moves the leader to another key.

**Esc Esc.** While a turn runs, one Esc clears the prompt (if it has text) and two Escapes within half a second stop the turn. While the prompt's autocomplete list is open, Esc closes the list and counts toward nothing. When nothing is running, Esc is left to Pi.

**Ctrl+C.** The first Ctrl+C keeps the prompt as it is and shows the "Ctrl+C then" popup; a second Ctrl+C quits. A running turn is stopped first, then Pi exits the way its own double Ctrl+C does. In a session with messages, `ampi-threads` adds Ctrl+N (archive and start a new session) and Ctrl+E (archive and quit) to the popup.

**Home and End.** With an empty prompt, Home jumps to the start of the transcript and End jumps back to the end and follows new output. With text in the prompt they move the cursor as before. Scrolling needs Pi's fullscreen mode (`tuiMode: "fullscreen"`, Pi's default); in regular mode Home and End stay with the editor.

**Details.** Alt+T expands the output of every tool row and shows thinking blocks; the next press collapses the tool output and hides thinking. Pi keeps these as two separate switches. Alt+T sets both to the same state, so thinking that is already shown stays shown on the press that expands the tools. Pi saves the thinking switch to your global settings, as its own Ctrl+T does. A project settings file that sets `hideThinkingBlock` wins over that saved value, and then the two can fall out of step; Ctrl+T brings thinking back in line.

**Messages.** With an empty prompt, Shift+Tab selects your previous message and Tab the next one; `e` edits the selected message. See [Message navigation](#message-navigation).

**Dialogs and selectors.** While a Pi dialog, selector or capturing overlay has focus (the model picker, `/tree`, and so on), ampi lets every key through to it.

### Command palette

Ctrl+O, or `/` typed into an empty prompt, opens the palette in the middle of the screen: 80 columns wide, or the terminal width less four on a narrower terminal.

```text
╭─ Command Palette ───────────────────────────────────────╮
│                                                         │
│ > sw                                                    │
│                                                         │
│         thread  switch                        Ctrl+X s  │
│           mode  use low                                █│
│             pi  /resume                                 │
╰─────────────────────────────────────────────────────────╯
```

- Each row shows a command's category (dim, right-aligned), what it does (bold) and its key at the right edge, using your keymap overrides. Long rows are cut, never wrapped. The list shows 15 rows, with a scrollbar when there are more.
- Typing filters the list. Rows are ranked by how well they match, best first. Commands that cannot run right now are listed last, marked "(unavailable)"; selecting one shows why under the list. Availability is judged once, when the palette opens.
- ↑/↓ or Ctrl+P/Ctrl+N move the selection. Enter closes the palette and runs the selected command; Esc closes it without running anything.
- Every registered ampi command is listed, other than the palette itself. Pi's slash commands are listed under the `pi` category: Pi's built-in commands, then commands from extensions, prompt templates and skills. The legacy `/mmr-*` aliases are left out, and so are the slash commands that an ampi row already runs, such as `/ampi-status` and `/mode`. Once the session's mode is locked, the `mode use` rows leave the palette and `pi /mode` takes their place, so the explicit override stays one row away. These rows need an empty prompt.
- Picking a Pi built-in command that takes no arguments, such as `/tree` or `/session`, runs it as if you had typed it and pressed Enter. Every other `pi` row puts `/<name> ` into the prompt, so you can add arguments (`/name review`, `/compact keep the test plan`) and press Enter; Pi's argument completion works there as usual. This covers `/model`, `/thinking`, `/export`, `/import`, `/bug`, `/name`, `/login`, `/compact` and every extension command, prompt template and skill.
- `/` opens the palette only while the prompt is empty and focused, so Pi's slash completion no longer opens from an empty prompt. With text in the prompt, `/` is typed as usual. To type slash commands directly instead, unbind it: `{ "ampi": { "keymap": { "prompt.openPalette": null } } }`.
- Pi draws overlays over the screen as it is, so the transcript behind the palette is not dimmed; the prompt box dims its own frame while the palette is open.

### Help & Keymap screen

Pick "ampi help" in the command palette to list every key in one place. It opens in the middle of the screen, 100 columns wide (or the terminal width less four) and two rows shorter than the terminal (here on an 80-column terminal):

```text
╭─ ampi — Help & Keymap ───────────────────────────────────────────────────╮
│                                                                          │
│  Editor Shortcuts                                                       █│
│     Enter                        Send the prompt; while a turn runs,    █│
│                                  steer it                               █│
│     Alt+Enter, Shift+Enter,      Insert a newline                       █│
│     Ctrl+J                                                              ▄│
│     …                                                                    │
│  Scrolling & Navigation                                                  │
│     Home                         Jump to the start of the transcript     │
│     …                                                                    │
│  Command Palette Commands                                                │
│     ampi help                —              List every key and command   │
│                                             with the key it is bound to  │
│     ampi open command        Ctrl+O         Open the command palette     │
│     palette                                                              │
╰────────────────────────────────────────────── Esc close · ↑↓/j/k scroll ─╯
```

- **Editor Shortcuts.** The prompt box's own keys (Enter, the newline keys, Esc, Backspace on an empty prompt, `@`, the mode picker keys Ctrl+Shift+S and Alt+M and the thinking key Alt+D when ampi-core is loaded, and the leader), then Pi's editing keys: cursor movement, deleting, yank, undo, pasting an image, Tab completion. Pi's keys are read from Pi's keybindings, so a change in Pi's `keybindings.json` shows here. A Pi key that ampi always takes first (the leader, Ctrl+Shift+S, Alt+M and Alt+D with ampi-core, a key bound to an ampi command that always runs) is left out of Pi's rows.
- **Scrolling & Navigation.** The navigation commands that have a key (Home and End), then, in Pi's fullscreen mode, Pi's transcript keys: PgUp/PgDn, prompt jumps, top and bottom, search and the mouse wheel. The section is left out when none of these has a key.
- **Command Palette Commands.** Every registered command, sorted by category and name, with its keys in effect and its description. A command without a key shows `—`. On a terminal narrower than 68 columns the keys go under the command's name.
- ↑/↓ or k/j scroll a row, PgUp/PgDn a page (the last row stays on screen), and Esc closes the screen (Ctrl+C too, as in Pi's selectors). The other keys do nothing while it is open.
- "ampi show keymap" opens the same box with the keymap in effect as JSONC, under a note on where to put overrides. Long comments wrap onto lines of their own that start with `//`, so the lines stay valid JSONC.
- Both have no key by default. Bind one under `ampi.keymap`, for example `"ampi.help": "<leader>h"`.

### Prompt history

Ctrl+R opens the prompts you sent in this working directory, newest first, in a box in the middle of the screen: 110 columns wide, or the terminal width less four on a narrower terminal. `ampi-threads` records the prompts (see [its README](../ampi-threads/README.md#prompt-history)); without it the command is unavailable and Ctrl+R does nothing. Pressing Ctrl+R again while the box is open or still loading does nothing either.

```text
╭─ Prompt History ───────────────────────────────────────────────╮
│                                                                │
│ > parser                                                       │
│                                                                │
│   Rename the parser module and update its imports              │
│   Why does the parser drop trailing comments?                  │
╰────── Alt+W/Ctrl+T toggle filter · Showing: current workspace ─╯
```

- One prompt per row, line breaks shown as spaces; a long prompt is cut with an ellipsis. The list shows 21 rows, fewer on a short terminal, with a scrollbar when there are more. With nothing to show, a dim line says so.
- Typing filters the list to the prompts that contain the text, ignoring case. ↑/↓ or Ctrl+P/Ctrl+N move the selection.
- Enter closes the box and puts the whole prompt into the prompt box, replacing its text, without sending it. Esc closes the box and leaves the prompt as it was.
- Alt+W or Ctrl+T switches between this workspace's prompts and those of every workspace, merged by time; the bottom border names the one shown. The filter stays. When the box is too narrow for the key hint as well, the border keeps the scope.
- Ctrl+P and Ctrl+N in the prompt itself are unchanged.

### Switch Thread picker

`thread switch` in the command palette (no default key; bind one under `ampi.keymap`) opens the sessions of this working directory in a box that fills the screen less two columns and two rows on each side. Picking one switches to it through `ampi-threads` (see [its README](../ampi-threads/README.md#switching-sessions)); without it the command is unavailable.

```text
╭─ Switch Thread ──────────────────────────────────────────────────────────────────────╮
│                                                                                      │
│ > parser                                  ╭────────────────────────────────────────╮ │
│                                           │                                        │ │
│   (current) Rename the parser…   2d ago   │             Thread Preview             │ │
│   Parser cleanup                51m ago   │                                        │ │
│                                           │  ┃ Rename the parser module            │ │
│                                           │                                        │ │
│                                           │  Renamed parser to syntax.             │ │
│                                           ╰────────────────────────────────────────╯ │
│                                                                                      │
╰────────────────────── Alt+W/Ctrl+T all workspaces · Alt+A show archived · Esc close ─╯
```

- Each row shows the session's title (its name, else its first message on one line, else "untitled", cut with an ellipsis) and how long ago it was last active: "now", "51m ago", "3h ago", "2d ago", "4mo ago", "1y ago". Newest first; the session you are in comes first, marked "(current)" in green. The selected row is black on yellow.
- The preview box shows the selected session's last three exchanges: your messages with the transcript's bar, the replies rendered as Markdown with Pi's Markdown theme. Tool calls and thinking are left out. It opens scrolled to the end, with a scrollbar when the exchanges do not fit; PageUp and PageDown scroll it. A session without messages shows "No messages to preview".
- On a terminal 120 columns or wider the preview sits right of the list, each taking half the width; on a narrower one it sits under the list. On a very short terminal only the list is shown.
- Typing filters the list to the titles that contain the text, ignoring case. ↑/↓ or Ctrl+P/Ctrl+N move the selection. Enter switches to the selected session; picking the current one just closes the box. Esc closes it.
- Alt+W or Ctrl+T switches between this workspace's sessions and every session; Alt+A also lists archived sessions, which are hidden otherwise. The bottom border names what each key does next. With nothing to list the box says "No Threads" and, in this workspace's view, points to Alt+W.
- `openMmrThreadPicker(ctx, "mention")` opens the same box titled "Mention Thread", which leaves the current session out and only returns the pick. `@@` and `thread mention` open it (see [Mentions](#mentions)).

### Mentions

Typing `@` in the prompt mentions a file, `@:` a commit and `@@` a session. The references go into your message as plain text.

```text
╭──────────────────────────────────────────────────────────────╮
│ @                                                            │
╰────────────────────────────────────────── /work/demo (main) ─╯
  → src/                            src
    README.md                       README.md
    main.ts                         src/main.ts
    @: mention a commit
    @@ mention a thread
```

- **`@`** opens Pi's file completion, directories included, and adds two dim hint rows under it: `@: mention a commit` and `@@ mention a thread`. The list shows only as many of Pi's rows as leave both hints in view (Pi shows five rows at once unless `autocompleteMaxVisible` says otherwise); typing a name searches Pi's files as before and drops the hints. Picking a hint row types its second character.
- **`@:`** lists the last 30 commits of the repository the working directory is in, newest first: the short sha, the subject and, dim, how long ago it was committed (`5m ago`, `3d ago`). Typing after `@:` filters them by sha prefix or by subject. Enter or Tab inserts `@:<short sha> `. Git runs each time the list opens, so a commit made a moment ago is listed, and gives up after 1.5 seconds; outside a repository, in one without commits, or without git, no list opens.
- **`@@`**, a second `@` straight after an `@` that starts a word, opens the [Mention Thread picker](#switch-thread-picker) over the prompt. Enter inserts `@<session id> `, Esc closes the picker and types the `@` after all. The id is Pi's session id; ampi gives it no `T-` prefix. `thread mention` in the command palette opens the same picker and inserts the reference at the cursor; it has no default key.
- What the model does with them: it sees `@:<sha>` and can run git on it like on any other sha. It sees `@<session id>`, and with `ampi-history` enabled (`AMPI_HISTORY_ENABLE=true`) its `read_session` tool's description tells it that this names a session it can read; without `ampi-history` the reference is text and nothing reads the session.

### Thread Cost and Analyze Context

`thread show cost` and `thread analyze context` in the command palette (no default keys) open read-only boxes, centred, 100 columns wide (or the terminal width less four) and as tall as their content. Esc closes them; on a screen too short for the content, ↑/↓ or k/j scroll and the bottom border says so. `ampi-threads` computes both reports when the box opens (see [its README](../ampi-threads/README.md#cost-and-context)); without it the commands are unavailable, and with `ampiThreads.showCosts: false` so is `thread show cost`.

```text
╭─ Thread Cost ────────────────────────────────────────────────────────────╮
│                                                                          │
│ Total: $0.03, not counting 1 model without a price                       │
│                                                                          │
│ anthropic/claude-sonnet-4-5                                        $0.03 │
│   13k in · 116 out · 26k cache read · 13k cache write                    │
│ local/qwen                                                       unknown │
│   2.1k in · 40 out                                                       │
│ session summaries                                                 $0.002 │
│   9.0k in · 300 out                                                      │
╰────────────────────────────────────────────────────────────── Esc close ─╯
```

- Thread Cost: the total in bold, then one row per model in the order the session first used it, its cost at the right and its tokens under it. A model with no recorded cost and no price reads "unknown" and the total says how many it leaves out; when no model has a price the total reads "unknown". Compaction and branch summaries name no model and share the row "session summaries".

```text
╭─ Analyze Context ────────────────────────────────────────────────────────╮
│                                                                          │
│ anthropic/claude-sonnet-4-5 · 200k context window                        │
│                                                                          │
│ System prompt        3.1k    1.6%                                        │
│ Built-in tools (15)  5.2k    2.6%                                        │
│ AGENTS.md files (2)   820    0.4%                                        │
│ MCP tools (0)           0    0.0%                                        │
│ Loaded skills (3)     210    0.1%                                        │
│ Compaction summary    640    0.3%                                        │
│ Messages              48k   24.1%                                        │
│                                                                          │
│ Total                 58k   29.1%                                        │
│ Free space           142k   70.9%                                        │
│                                                                          │
│ Compactions: 1                                                           │
│ Pi counted 61k tokens at the last response.                              │
│ Estimates at four characters to a token.                                 │
╰────────────────────────────────────────────────────────────── Esc close ─╯
```

- Analyze Context: the model and its context window, the estimated tokens of each section and its share of the window (the count of tools, files or skills in brackets), the total and the free space, the compactions on this branch, and the count Pi measured at its last response when it has one. Without a known window the shares read "—" and the free space is left out.

### Outline

`thread toggle outline` in the command palette (no default key) shows the headings of the last response in a box at the right edge, just above the prompt box; running it again hides the box.

```text
╭─ Outline ────────────────────────────────────────────────╮
│ ↑  Explain how the cache works and where it is configur… │
│ Cache layout                                             │
│   Keys                                                   │
│   Eviction                                               │
│     Least recently used                                  │
╰──────────────────────────────────────────────────────────╯
```

- The box is 60 columns wide (or the terminal width less four), two columns in from the right edge, and as tall as its content, up to a third of the terminal's rows; rows that do not fit are counted in a last row, `… 8 more`.
- The first row is `↑` and the first line of the message the response answers (for a skill call, the words typed with it), dim in the heading colour. Then come the response's Markdown headings, `#` lines and underlined ones, indented two columns per level below the shallowest one present, level 1 in bold; lines in fenced code blocks are not headings. A response without headings shows `No headings`.
- The response is all assistant text after your newest message that has an answer, so it does not follow scrolling. While a turn has written no text yet, the previous response stays. The box updates when a response ends and when the thread moves in the session tree (editing a message, `/tree`); it closes when the session ends or changes.
- The box takes no keys: typing goes on in the prompt. It hides while the mode dial or a key hint popup is open, and on a terminal narrower than 40 columns.

### Mode dial

Ctrl+S opens the mode dial at the right edge, just above the prompt box: 58 columns wide, or the terminal width less four.

```text
╭────────────────────────────────────────────────────────╮
│ •••••••••••••••••••··································· │
│ low             medium           high            ultra │
│                                                        │
│ Agent:  openai-codex/gpt-5.6-sol · medium              │
│ Oracle: openai-codex/gpt-5.6-sol · high                │
│                                                        │
│ Balanced default for everyday coding                   │
╰──── ctrl+s/→ next · ← previous · tab list · esc close ─╯
```

- The bar fills up to the mode, in its colour: one dot for `low`, a third for `medium`, two thirds for `high`, all of it for `ultra`. Under it, the current mode's name is bold in that colour. In `free` the bar shows one dot in the default colour and no name is highlighted.
- `Agent:` names the provider, model and thinking level the mode runs; `Oracle:` the ones the oracle subagent uses. They come from ampi-core's model routing, with your `ampiCore` model overrides, and read "not available" when no registered, signed-in model matches. In `free`, `Agent:` names Pi's current model and `Oracle:` reads "not available", because `free` drops ampi's tools.
- The first Ctrl+S only shows the dial. Each further Ctrl+S, or →, turns it to the next mode: `medium` → `high` → `ultra` → `low` → `medium`. ← turns it back. From `free`, either direction goes to `medium`.
- Each turn switches the mode through `/mode`, so it is saved with the session, the prompt box's label changes with it, and ampi-core reports the switch in the transcript as `/mode` does. Switches run one at a time: turns made while one is still under way are combined, and the dial's latest mode is applied once it has finished, even if the dial has closed by then.
- Tab shows the list of modes instead, `free` last, the current one marked `‣`. ↑/↓ choose a mode and switch to it at once; Tab goes back to the dial.
- Esc closes the dial. It also closes by itself 2 seconds after the last key.
- The dial takes every key while it is open; other keys do nothing.
- Once the session has a message, its mode is locked: Ctrl+S then opens no dial and says why the mode is fixed. `/mode <key>` still switches it.
- Without ampi-core's `/mode` command, Ctrl+S is left to Pi.
- While `ampi-tui` is on, ampi-core's own Ctrl+S and Ctrl+Space cycle keys do nothing, so if you unbind or move `mode.toggle` under `ampi.keymap`, Ctrl+S no longer changes the mode.

### Message navigation

Step back through the messages you sent and pick one to edit. The selected message is drawn in a heavy frame with the edit key in its bottom border:

```text
 ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
 ┃ Rename the parser module, update every import that points at it, and keep  ┃
 ┃ the old name exported for one release                                      ┃
 ┗━e to edit━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

- **Selecting.** Shift+Tab on an empty prompt selects your newest message, and each further press the one before it; at the oldest it stays there. Tab selects the next newer message, and Tab on the newest clears the selection. Esc clears it too, and so does typing into the prompt. While a turn runs, that Esc also counts as the first of Esc Esc, so a second Esc stops the turn. The frame and the text use the theme's user message colour, `e` the accent colour.
- **Scrolling.** In Pi's fullscreen mode the transcript scrolls just enough to show the whole selected message (its top when it is taller than the view). Clearing the selection returns to the end of the transcript. In regular mode (`tuiMode: "regular"`) the frame is drawn but nothing scrolls.
- **Editing.** `e` puts the selected message's text into the prompt and moves the thread back to the point just before that message, through Pi's session tree, as choosing the message in `/tree` does. The transcript then ends before the message; change the text and send it to continue from there. The old branch stays in the session: `/tree` shows both and returns to the old one. Files the agent changed after that message are not restored.
- **When the keys are yours.** Shift+Tab takes the selection only while the prompt is empty and the thread has messages; with text in the prompt it stays Pi's thinking level cycle. Tab and `e` act only while a message is selected, so Tab completion and typing `e` work as before. While a turn runs, `e` is typed into the prompt as usual, which ends the selection; edit once the turn has finished. While a dialog or overlay has focus, the keys go to it.
- **Which messages.** Every message you sent on the current branch that the transcript shows with text. A message with only images, or a skill call without words of your own, has no user message on screen and is skipped; for a skill call with words, the frame goes around the words and editing puts back the whole message.
- Rebind or unbind the keys under `ampi.keymap` (`thread.selectPreviousMessage`, `thread.selectNextMessage`, `thread.editSelectedMessage`); Esc is fixed.

### What changes compared with Pi's defaults

| Key | Pi | With `ampi-tui` |
| --- | --- | --- |
| Esc while a turn runs | Stops the turn | Clears the prompt; a second Esc within 0.5 s stops the turn |
| Esc with text, nothing running | Nothing | Clears the prompt |
| Alt+Enter | Queues a follow-up message | Inserts a newline |
| Backspace on an empty prompt | Nothing | Takes queued messages back into the prompt |
| Enter on an empty prompt while messages are queued | Nothing | Steers with the next queued message |
| Ctrl+C | Clears the prompt; twice within 0.5 s quits | Shows the "Ctrl+C then" popup and keeps the prompt; twice within 1.5 s quits |
| Ctrl+X | Copies the last assistant message | Leader key; the popup lists what can follow |
| Home / End on an empty prompt | Moves the cursor | Jumps to the start or end of the transcript |
| Ctrl+G | Opens the external editor | The same, now the `prompt.openInEditor` command |
| Ctrl+O | Expands or collapses tool output | Opens the command palette |
| `/` on an empty prompt | Types `/` and opens slash-command completion | Opens the command palette |
| Alt+T | Nothing | Expands or collapses tool output and thinking together |
| `?` on an empty prompt | Types `?` | Shows or hides the shortcuts help |
| Shift+Tab on an empty prompt | Cycles the thinking level | Selects your previous message; with text in the prompt it still cycles the thinking level |
| Tab, `e` while a message is selected | Completes, types `e` | Select the next message, edit the selected one |
| Ctrl+S | Nothing in the prompt (ampi-core makes it cycle the mode) | Opens the mode dial |

Everything else keeps Pi's binding, including Ctrl+T (thinking blocks only), Ctrl+D (quit on an empty prompt) and Ctrl+Home / Ctrl+End (transcript scrolling).

- Clearing the prompt: Ctrl+C no longer clears it; Esc does.
- Follow-up messages: Alt+Enter no longer queues one; `prompt queue message` in the palette does (see [Queued messages](#queued-messages)). To keep follow-ups on a key, bind `prompt.queue` under `ampi.keymap`, or Pi's `app.message.followUp` in Pi's `keybindings.json`; Enter while a turn runs still steers it.
- Pi's own key hints still describe Pi's keys: the hint line under the startup header ("escape interrupt", "ctrl+c/ctrl+d clear/exit", "ctrl+o more"), "Press ctrl+o to show full startup help" and the "ctrl+o to expand" note on collapsed tool output. Where they name Ctrl+O, press Alt+T instead: it expands tool output, thinking and the full startup help.
- When nothing is running, Pi's double Esc on an empty prompt opens the session tree. Set Pi's `doubleEscapeAction` to `"none"` to turn that off.
- To keep a Pi key, unbind the ampi command that takes it: `"ampi.quit": null` gives Ctrl+C back to Pi, `"thread.interrupt": null` brings back Pi's Esc interrupt (Esc still clears a non-empty prompt first). Copying with Ctrl+X needs the leader moved elsewhere, or Pi's `app.message.copy` bound to another key in Pi's `keybindings.json`.

### Terminal title, notifications and quit summary

**Terminal title.** The window or tab title names the session and where it runs:

```text
Parser rename - ampi - /work/repo                        idle
≈ Parser rename - ampi - /work/repo                      a turn runs
! Waiting for Approval: Parser rename - ampi - /work/repo
! Error: Parser rename - ampi - /work/repo               the last response failed
```

- The title is the session's name (Pi's `/name`), else its first message cut to 40 columns, else `new session`.
- While a turn runs, the prompt box's wave glyph (`∼ ≈ ≋`) steps in front of it. The title changes at most four times a second, so the glyph steps every 250 ms.
- When the turn status needs you (`Waiting for Approval`, or `Error` until the next turn starts), a `!` and the status replace the glyph.
- Pi writes its own title when a session starts and when it is renamed; ampi writes its title again a moment later. When the session ends, Pi's own title comes back.

**Notifications.** When a turn finishes, or starts waiting for an approval, ampi tells the terminal:

| When | Text |
| --- | --- |
| A run settles | `ampi is ready` |
| A run settles after a failed response | `ampi stopped on an error` |
| The status starts waiting for an approval | `ampi needs your approval` |

- They go out as a desktop notification through the terminal (the OSC 777 escape sequence), which terminals with notification support show. Over SSH (`SSH_CONNECTION` or `SSH_TTY` set), or with `AMPI_FORCE_BEL=1`, the terminal bell rings instead.
- With `sound: true`, ampi also plays `complete` or `dialog-warning` from the freedesktop sound theme through `paplay`. It starts the player in the background and never waits for it; without `paplay` or the sound files, or over SSH, nothing plays.
- At most one notification goes out every two seconds. A run you stop yourself (Esc Esc) sends none.

**Quit summary.** After an interactive quit (Ctrl+C Ctrl+C, Ctrl+D or `/quit`), once Pi has handed the terminal back, ampi prints its mark with the session title and the working directory to the normal scrollback. Pi's own resume line follows it:

```text
   ●  ·  ·
 •         ·   Parser rename
•     ●     ·  /work/repo
 ·         ·
   ·  ·  ·
To resume this session: pi --session 01a14e4d-1980-701c-bda9-60d6a935b635
```

Pi prints the resume line only when the session has been saved, so a session without messages ends with the summary alone. When Pi is stopped by a signal, no summary is printed.

### Welcome header

- Replaces Pi's logo and key hints at the top of the transcript, and scrolls away with it.
- On the left, ampi's mark: two rings of dots turning against each other. It animates for about nine seconds in a new session, and stops when you send the first message. A resumed session shows it still.
- On the right, "Welcome to ampi" and the hints `ctrl+o for commands · ? for shortcuts`. The keys these hints name arrive with the command palette and the shortcuts help.
- Below the hints, after an update (or on first install), a card with the first item of the newest changelog entry and a `dismiss` hint. Any key press or the first message hides it. `/ampi-changelog` lists every change. The card shows once per new version, like the notification it replaces.
- Terminals narrower than 100 columns or shorter than 30 rows get a smaller mark and a one-line card; below 60 columns the mark is left out.
- `quietStartup: true` in Pi's settings draws nothing. `quietStartup: "header"` keeps the welcome header and hides Pi's list of loaded resources, which otherwise appears below it and can push it off a small screen.

### Transcript styling

- User messages: a `┃ ` bar in front of every line, wrapped lines included, then the raw text in italics, with Markdown left as typed. Bar and text use the theme's `userMessageText` colour (green in the `ampi` theme). No background. A [selected](#message-navigation) message gets a heavy frame instead of the bar.
- Assistant messages keep Pi's renderer: a one-column margin and no role label. The theme sets their colours.
- Thinking: when collapsed (Pi's `hideThinkingBlock` setting or `Ctrl+T`), no label is shown. When expanded, Pi draws thinking as italic text in the theme's `thinkingText` colour, with no header. Whether thinking starts collapsed is Pi's `hideThinkingBlock` setting; ampi does not change it.

### The `ampi` theme

- Shipped in the package as `theme/ampi.json` and listed in `/settings` as `ampi`. Every colour is an ANSI palette index or the terminal default, so it follows your terminal's palette on dark and light backgrounds.
- Roles: user messages green (2); headings cyan (6), bold; inline code yellow (3); links blue (4), underlined; diff additions green and removals red; Markdown rules, quote bars and code block borders grey (8); secondary and thinking text, frames and the prompt border without thinking a mid grey (244), which stays readable on both dark and light backgrounds; the selected row in lists a fixed dark grey (240); no backgrounds behind user messages or tool rows.
- While Pi is on its default `system` theme, `ampi-tui` uses `ampi` for the session without writing your settings, and keeps it after `/reload`, `/new`, `/resume` and `/fork`. Pick any other theme in `/settings` and it stays. To use Pi's `system` theme, turn `ampi-tui` off.

### Limits

- Theme files hold colours only, so inline code is not bold, tables keep Pi's square borders in the default text colour, level-three and deeper headings keep their `###` marks, and secondary text is grey rather than faint.
- Links are clickable (OSC 8) only where Pi detects hyperlink support; elsewhere Pi prints the URL after the link text.
- Thinking starts expanded, as in Pi, unless Pi's `hideThinkingBlock` is set: Pi lets extensions change only the collapsed label, and `Ctrl+T` writes the setting.
- Collapsed thinking leaves an empty row where the label used to be, so three blank rows separate your message from the reply.
- Palettes that give slot 8 the background colour (Solarized Dark, for one) hide Markdown rules, quote bars and code block borders.
- Pi offers no API to draw user messages, so `ampi-tui` replaces the drawing method of Pi's user message component. When a Pi release changes that component, `ampi-tui` leaves it alone and Pi's own user message box appears; message navigation then selects and edits without drawing a frame.
- Pi offers no way to scroll to a message either. To bring a selection into view, `ampi-tui` draws the transcript once more and looks for the frame's rows; a tool output that prints a heavy box of its own (`┏━┓` over `┗━┛`) above the selection can draw the view to it instead.
- Pi tells extensions nothing about terminal focus, so notifications go out even while you are looking at the terminal. Many terminals show desktop notifications only for unfocused windows.
- tmux does not forward the OSC 777 notification to the terminal around it. Inside tmux, `AMPI_FORCE_BEL=1` rings the bell instead, which tmux handles as set by its `bell-action` option.
- Nothing feeds approval requests into the turn status yet, so `Waiting for Approval` and its notification appear only once a permission prompt reports them.

### What stays on screen

- Pi's list of loaded resources and extension issues below the header. Pi's `quietStartup` setting hides the list.
- Pi's compaction and retry notices still show above the prompt box while they run.

### Transcript tool rows

A run of consecutive tool calls is folded into one summary line, with a count per kind of work and the diff stat of the edits:

```text
 ✓ Read 1 file, ran 1 command, ran 1 search, edited 1 file (+2 -1) ▸
```

- A run ends where the transcript shows something else between two calls: an assistant message with text, a user message (a steered message too), a summary or a custom message. Thinking, failed calls and a change of kind do not end it, so one run can span several assistant messages.
- Calls of ampi-workers' tools (`oracle`, `librarian`, `finder`, `Task`, `reviewer`, custom `sa__*` subagents, `start_task`, `task_poll`, `task_wait`, `task_cancel`) and questions to the user (`ask_user_choice`) are never grouped: each keeps its own row and splits the run around it. A call whose result shows an image, such as a `read` of a screenshot in a terminal that draws images, does the same once its result arrives, so its row stays above the image.
- Pi always draws an assistant message's thinking. A collapsed run that spans a message with thinking shows the summary line, then that thinking, with the later calls counted in the summary above it.
- The summary is in the present tense with a spinner while any call of the run is still running (`⠋ Read 1 file, running 1 command ▸`). Its glyph stays `✓` when a call failed; only that call's row shows the failure. A cancelled call turns the glyph to `⊘` and adds `(N cancelled)`.
- A run of one call gets a summary line too (`✓ Ran 1 command ▸`).
- `▸` marks a collapsed run. Expanding tool output (Pi's Ctrl+O) turns it into `▾` and draws every call below the summary, indented by two columns, with the rows and cards described below. Pi puts a blank line between two calls' rows there. Clicking a summary line, in terminals where Pi receives mouse clicks, expands or collapses that run alone.
- Runs are rebuilt from the session when it starts, is resumed or reloaded, is compacted or moves to another branch. Pi's HTML export keeps one row per call.

Each call's own row is one line: a status glyph, a verb and what the call acted on.

```text
 ✓ Read src/index.ts L1-120
 ✗ Ran npm test (exit code: 1)
 ⊘ Grep "foo"
 ✓ Edited src/retry.ts +2 -1
```

- Glyphs: `✓` done, `✗` failed, `⊘` cancelled, and a spinner while the call runs. The verb is in the present tense while it runs (`Reading`, `Running`, `Editing`).
- The spinner is a single braille character whose eight dots play a tiny game of life, one generation every 200 ms, and start over from a random pattern whenever they would die out or stop changing. It always starts on `⠋` and keeps the running colour; worker rows and the task list use the same spinner. With animations off (see [Configuration](#configuration)) it stays on `⠋`.
- Shell commands are named for what they do. A command that only reads a file (`cat`, `head`, `tail`, `sed -n`, `less`) shows as `Read <path>` with the line range when the command names one (`sed -n '1,220p' x.ts` is `Read x.ts L1-220`). A search (`rg`, `grep`, `git grep`) shows as `Grep`, a listing (`ls`, `find`, `fd`) as `Listed` with its name pattern, `sed -i` as `Edited`. Anything else, including pipelines into other programs, redirections into files and command substitutions, is `Ran <command>`. A leading `cd <dir> &&` is followed into that directory.
- Edits show the diff stat (`+N -M`), failed commands their exit code, or `(timed out after Ns)` or `(killed)` when they ended without one. A `write` call always shows as `Created`, with every line counted as added, because its result does not say whether the file existed before. Paths are shown relative to the working directory, or with `~` for the home directory.
- MCP tools show as `Ran <server>/<tool>`, other tools as `Ran <tool>`, each with the first argument that says what the call is about.
- A question to the user shows as `Asking <question>` while the list is open and `Asked <question> → <answer>` once it closed, or `→ no answer` when the user closed it without choosing.
- Expanding tool output (Pi's Ctrl+O, which applies to every row) switches to cards:
  - shell commands: `$ <command>` with the program in bold and flags and strings in syntax colours, `(in <dir>)` when it ran elsewhere, `(exit code: N)` when it failed, then the first 15 lines of output and `… N more lines`;
  - `edit`, `write` and `apply_patch`: the underlined path (a clickable `file://` link where the terminal supports links), the diff stat, and the diff with line numbers, removed lines in red and added lines in green, cut after 60 lines;
  - `read`: the linked path and its line range; `grep`, `find` and `ls`: their output;
  - MCP and other tools without renderers of their own: their arguments as `key: value` lines and the result text.
- Tools that bring their own renderers, such as ampi's task list, get the one-line row when collapsed and keep their own card when expanded. ampi-workers' tools draw their own rows, collapsed and expanded (`✓ Consulted oracle · Review the plan`), because only their renderers read a worker's outcome; see [ampi-workers](../ampi-workers/README.md#transcript-rows).
- Rows use theme colours for text only, never a background.
- Pi's HTML export draws the tools it does not render itself (such as `grep`, `find`, `apply_patch` and MCP tools) with these renderers. There the row with its final status sits below the tool name, and expanding it shows the card.

### Planned

Later releases open the dial read-only in a locked session, showing the mode and its models without changing them, instead of only saying why the mode is fixed. Each change lands behind the same `ampiTui.enabled` switch.

## Diagnostics and troubleshooting

- **The footer still shows, the keys behave like stock Pi, or Pi's logo shows instead of the welcome header.** `ampi-tui` is off (`ampiTui.enabled: false` in a settings file, or `AMPI_TUI_ENABLE=false`), or the session is not interactive. Check both settings files and the environment, then restart Pi.
- **The prompt box shows no branch.** The working directory is not a git repository, or Pi has not read the branch yet; it updates when Pi notices a branch change.
- **No welcome header at all.** Pi's `quietStartup` is `true`. Set it to `"header"` to keep the header without the resource list.
- **No changelog card.** The card shows only once after an update; `/ampi-changelog` lists every change.
- **Colours are not the `ampi` theme.** A theme is set in Pi's settings (or with `--use-theme`); `ampi-tui` leaves it in place. Choose `ampi` in `/settings`.
- **You want the footer back.** Set `ampiTui.enabled` to `false` and restart Pi or run `/reload`.
- **A rebinding has no effect.** Check for an `ampi keymap:` warning at session start, then run `/reload`. A binding to a single key that Pi does not reserve is handed to Pi's shortcut list, which Pi reads at session start, so it needs `/reload` even when the warning is absent.
- **Home and End only move the cursor.** The prompt has text, or Pi runs in regular mode (`tuiMode: "regular"`), where the terminal's own scrollback replaces transcript scrolling.
- **Shift+Tab no longer changes the thinking level.** On an empty prompt it selects messages; type something first, or set `"thread.selectPreviousMessage": null` under `ampi.keymap` to give it back to Pi.
- **No notification when a turn finishes.** Check `ampiTui.notifications` (`enabled` and `system`), whether your terminal shows OSC 777 notifications, and whether you run inside tmux (see [Limits](#limits)). Try `AMPI_FORCE_BEL=1` for a bell instead. Notifications closer than two seconds apart are dropped.
- **The window title does not change.** The terminal, or tmux's `allow-set-title` option, ignores title changes.

## Public API

Stable re-exports from `ampi`: `createMmrTuiExtension`, `loadMmrTuiSettings` and the `MmrTuiSettings` / `MmrTuiFactoryOverrides` types, each with its `Ampi*` alias. Canonical catalog: [`../../../docs/public-api.md`](../../../docs/public-api.md). The chrome-owner seam, command registry and keymap live in `ampi-core`: [`../../../docs/ampi-core-api.md`](../../../docs/ampi-core-api.md#additional-exported-helpers).

## Developer notes

- Manifest: risk class `terminal-ui`, child role `none`. No subagent child keep-set lists it, and child workers never run in the terminal UI.
- Layout: `index.ts` (entry point), `config.ts` (settings), `chrome/look.ts` (installs the welcome header, message styling and theme), `chrome/welcome.ts` (header component, mark and card), `chrome/title-notify.ts` (terminal title and notifications), `chrome/quit-summary.ts` (the summary printed after quitting), `editor/` (the prompt box and its mentions), `transcript/messages.ts` (user message drawing, thinking label), `transcript/navigation.ts` (message selection, its commands and the edit slash command), `transcript/tool-renderers.ts` (tool rows, classified by `ampi-core/tool-activity.ts`), `theme/` (`ampi.json` and its session selection), `keys/`, `ui/`, `overlays/`, `pi-compat/`.
- `editor/prompt-box.ts` draws the prompt box (a `CustomEditor` subclass), its border slots and the open shortcuts help; `editor/help.ts` builds the help rows from the effective keymap and the command registry and lays them out; `editor/status-feed.ts` feeds Pi's agent events, mapped by `ampi-core/thread-status-events.ts`, into its own thread status reducer and adds the queue count, the interrupt and the quit hint; `editor/install.ts` installs the box at session start, feeds it the mode, cost, status, wave glyph and branch, toggles the help and runs the one-time tmux check; `editor/queue.ts` draws the queue box as an `aboveEditor` widget (set again on each change, so it stays nearest the prompt box), hands the queue length to the status feed and defines the three queue commands. `editor/mentions.ts` is the autocomplete provider `editor/install.ts` stacks on Pi's with `ctx.ui.addAutocompleteProvider` at each session start (Pi drops the wrappers when a session ends): it adds the hint rows to Pi's `@` rows, lists commits for `@:` from `git log`, and adds `:` to the trigger characters so typing it after `@` asks for rows. Picking a hint row types its second character into the box after Pi has applied the completion. The box holds back the second `@` of `@@` and asks `editor/install.ts` to open the picker; the reference then goes in through `ctx.ui.pasteToEditor`, which inserts at the cursor. All of this uses Pi's extension API and the editor's public methods, so none of it is in `pi-compat/`.
- `keys/decode.ts` turns terminal input into keymap combos; `keys/dispatcher.ts` is the pure chord state machine; `keys/hint-popup.ts` draws the popup; `keys/commands.ts` defines the commands; `keys/install.ts` wires them into Pi, opens the palette and tells the prompt box about the first Esc, the pending quit, the open palette, the help toggle and every other key command (which closes the help).
- `ui/frame.ts` draws the box overlays share (rounded border, title in the top border, key hints in the bottom border, scrollbar column); `overlays/palette.ts` is the command palette; `overlays/mode-dial.ts` is the mode dial with its list view; `overlays/help-keymap.ts` builds the Help & Keymap sections from the registry, the keymap and Pi's keybindings, and draws them and the keymap JSONC in one scrolling box; `overlays/prompt-history.ts` is the prompt history picker, which reads the prompts through `ampi-core/prompt-history.ts`, so `ampi-tui` never imports `ampi-threads`. `overlays/thread-picker.ts` is the Switch Thread picker and its Mention Thread variant: it lists sessions with `ampi-core/session-catalog.ts` (`listMmrSessionsInScope`), reads the archived flags through `ampi-core/thread-index.ts`, opens previews with Pi's `SessionManager`, and switches by sending `/ampi-thread switch <session id>`, since only a command handler gets Pi's `switchSession`. The preview opens the session with `SessionManager.open`, which migrates a session file in an older format and writes it back, as Pi does whenever it loads one; Pi exposes no documented read-only loader. The list order does not change, because Pi dates a session by its message and header timestamps, and file times only count for a session with neither. `overlays/thread-reports.ts` draws the Thread Cost and Analyze Context boxes in `help-keymap.ts`'s scrolling box, fitted to their content; the reports come from `ampi-core/thread-reports.ts`, where `ampi-threads` registers them. The cost gauge reads usage and prices through `ampi-core/session-usage.ts`, as `ampi-threads`' cost report does, so both show the same total.
- Routing: a binding goes through `pi.registerShortcut` only when it is a single key that Pi does not reserve, starts no longer chord, and belongs to a command without an availability check. Everything else goes through Pi's raw terminal input, so a key whose command is unavailable still reaches the editor.
- Tool rows: `ampi-core/tool-activity.ts` classifies a call (pure, no Pi imports, shared with `ampi-gui`) and `summarizeActivities` folds a run of calls into one phrase; `transcript/activity-groups.ts` keeps the runs, with where a run ends decided by `ampi-core/activity-runs.ts` (shared with `ampi-gui`'s work groups, and tested against the same cases in `tests/helpers/activity-run-cases.mjs`), fed by Pi's message and tool events and rebuilt from the session's context entries, because a renderer sees only its own call; `transcript/tool-renderers.ts` draws rows and cards through one `pi.registerToolRenderer` resolver. The first call of a run draws the summary, and the others render no lines, which Pi draws with no height and no spacer. Tests: `tests/mmr-tui-activity.test.mjs`, `tests/mmr-tui-activity-groups.test.mjs`, `tests/mmr-tui-tool-renderers.test.mjs` and `tests/mmr-tui-tool-groups.test.mjs`, whose 80- and 140-column fixtures in `tests/fixtures/mmr-tui-tool-rows/` and `tests/fixtures/mmr-tui-tool-groups/` are refreshed with `PI_MMR_UPDATE_FIXTURES=1`.
- `pi-compat/` is the only place that touches Pi runtime surface outside the extension API: the focused editor with its action handlers, autocomplete state and rendered height, the editor's submit handler (the only path that runs Pi's built-in slash commands) and the list of those commands, the editor's height rule (`editor-height.ts`), transcript scrolling and revealing rows, the reserved shortcut list, raw input, the user message component, and the message queue. `tests/mmr-tui-pi-compat.test.mjs` probes each against the installed Pi and fails when Pi changes shape.
- `pi-compat/queue.ts` replaces `InteractiveMode.prototype.updatePendingMessagesDisplay`, which Pi runs on every queue change, between session start and shutdown: Pi's own list stays empty and ampi receives the queued texts. Steering a queued message moves that one message inside Pi's session, from its agent's follow-up queue to its steering queue, and updates the session's lists of queued texts, so custom messages from other extensions, images and the rest of the queue stay as they are. `probeMmrPiQueue` names any change in the class shape and `probeMmrPiQueueSession` any change in the session; with a changed session, `prompt steer queued message` and Enter on an empty prompt do nothing and the palette says why.
- `pi-compat/messages.ts` patches `UserMessageComponent.prototype.rebuild`. It is installed when the extension loads, because Pi rebuilds the chat on `/reload` before `session_start`, and removed at `session_shutdown`. `probeMmrUserMessageComponent` names any change in the class shape. The patch also numbers the components in the order Pi builds them; Pi builds every user message on screen anew when it redraws the chat, so the newest N numbers are the last N user messages, which is how `transcript/navigation.ts` knows which component to frame.
- `pi-compat/scroll.ts` reveals rows of the transcript through the fullscreen renderer's private `getPrimaryScrollView()` and Pi's exported `ScrollView`; `keys/install.ts` offers a lone Esc to the navigation before Esc Esc sees it.
- The theme is applied as a `Theme` object, never by name: `ctx.ui.setTheme("ampi")` would write the user's settings. An empty widget below the editor re-applies it when Pi returns to `system`, using the component `invalidate()` call Pi makes on every theme change.
- Tests: `tests/mmr-tui-extension.test.mjs` (enablement, run modes, settings, load order, prompt box wiring), `tests/mmr-tui-prompt-box.test.mjs` (render fixtures in `tests/fixtures/mmr-tui-prompt-box/`, geometry, keys, the shortcuts help), `tests/mmr-tui-status-feed.test.mjs`, `tests/mmr-tui-queue.test.mjs` (queue box fixtures in `tests/fixtures/mmr-tui-queue/`, command availability, queue, dequeue and steer against a played Pi queue), `tests/mmr-tui-key-decode.test.mjs`, `tests/mmr-tui-key-dispatcher.test.mjs`, `tests/mmr-tui-keys-install.test.mjs` (also the palette and details commands), `tests/mmr-tui-frame.test.mjs`, `tests/mmr-tui-palette.test.mjs`, `tests/mmr-tui-help-keymap.test.mjs` (sections, keys and the two commands; fixtures in `tests/fixtures/ampi-tui-help-keymap/`), `tests/mmr-tui-prompt-history.test.mjs` (render fixtures in `tests/fixtures/ampi-tui-prompt-history/`, keys, the `prompt.history` command), `tests/mmr-tui-message-navigation.test.mjs` (selection model, selected frame, keys, edit command, reveal), `tests/mmr-tui-thread-picker.test.mjs` (rows, relative times on a fixed clock, render fixtures at 80, 120 and 140 columns in `tests/fixtures/ampi-tui-thread-picker/`, keys, the `thread.switch` command), `tests/mmr-tui-mentions.test.mjs` (the `@`, `@:` and `@@` rows, commits from a scratch git repository, `@@` on Pi's real editor, the `thread.mention` command, the `read_session` hint), `tests/mmr-tui-thread-reports.test.mjs` (Thread Cost and Analyze Context render fixtures at 80 and 140 columns in `tests/fixtures/ampi-tui-thread-reports/`, fitting and scrolling, the two commands), `tests/mmr-tui-pi-compat.test.mjs`, `tests/mmr-tui-welcome.test.mjs` (layout fixtures in `tests/fixtures/ampi-tui-welcome/`, animation on a fake clock, card from fixture changelogs, `quietStartup`), `tests/mmr-tui-messages.test.mjs` (user message drawing), `tests/mmr-tui-theme.test.mjs` (schema, palette, selection), `tests/mmr-tui-title-notify.test.mjs` (title forms, notification policy and throttles on a fake clock), `tests/mmr-tui-quit-summary.test.mjs` and `tests/mmr-core-status.test.mjs` (ampi-core yields the footer to a chrome owner). Refresh the layout fixtures with `PI_MMR_UPDATE_FIXTURES=1`.
