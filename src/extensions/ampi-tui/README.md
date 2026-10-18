# ampi-tui

Owns the look and keys of interactive `ampi` sessions in the terminal: an Amp-compatible prompt box that carries the session's state in its borders, Amp-compatible key chords, a welcome header with ampi's mark and the newest changelog item, Amp-compatible message styling and tool rows, and the `ampi` theme.

Package overview: [`../../../README.md`](../../../README.md). Planning: [`../../../ROADMAP.md`](../../../ROADMAP.md). Public API: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## At a glance

| Default | Provides | Requires | Diagnostics |
| --- | --- | --- | --- |
| On | Prompt box with mode, cost, turn status and path in its borders; welcome header, message styling, grouped tool rows, `ampi` theme; Ctrl+X leader, Esc Esc, Ctrl+C Ctrl+C, Home/End; command palette on Ctrl+O and `/`; mode dial on Ctrl+S; Alt+T details toggle; shortcuts help on `?`; Help & Keymap screen and the keymap as JSONC from the palette; terminal title, notifications, quit summary | Interactive Pi session | Welcome header at startup; rounded prompt box at the bottom, no footer; a "then" popup after Ctrl+X or Ctrl+C; the window title; `/ampi-status` |

## When to use it

- You want the transcript and the prompt to fill the terminal, with the mode, cost, turn status and working directory in the prompt's frame instead of status rows below it.
- You want Amp-compatible transcript styling: barred user messages, quiet thinking, colours from your terminal palette.
- You want Amp-compatible keys: two Escapes to interrupt, Ctrl+C twice to quit, a Ctrl+X leader, Home and End to jump through the transcript, a command palette on Ctrl+O.
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
| `ampi.showVersion` | Command, no key | Show the ampi and Pi versions |
| `ampi.help` | Command, no key | Open the [Help & Keymap screen](#help--keymap-screen) |
| `ampi.keymapJson` | Command, no key | Show the keymap in effect as JSONC ("ampi show keymap" in the palette) |
| `ampi.palette` | Command, `ctrl+o` | Open the command palette |
| `prompt.openPalette` | Command, `/` | Open the command palette when the prompt is empty |
| `thread.toggleDetails` | Command, `alt+t` | Expand or collapse tool output and thinking together |
| `prompt.toggleHelp` | Command, `?` on an empty prompt | Show or hide the shortcuts help inside the prompt box |
| `ampi.status`, `ampi.changelog`, `ampi.config` | Commands, no key | Run `/ampi-status`, `/ampi-changelog` and `/ampi-config` (need `ampi-core`) |
| `mode.toggle` | Command, `ctrl+s` | Open the mode dial; while it is open, turn it to the next mode (needs `ampi-core`) |
| `mode.use.low` … `mode.use.free` | Commands, no key | Switch to that mode, as `/mode <key>` does (need `ampi-core`) |
| "then" popup | Overlay | Lists the keys that can follow Ctrl+X, Ctrl+C or any other chord prefix |
| `ampi` theme | Pi package theme (`theme/ampi.json`) | Amp-compatible colour roles on ANSI palette indices |
| User messages | Transcript | A bar on every line, raw italic text in the theme's user colour, no background |
| Thinking | Transcript | No label when thinking is collapsed |
| Command palette | Overlay | Lists every command with its key; type to filter, Enter to run |
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

### Keymap

Rebind or unbind any command under `ampi.keymap` in Pi's settings. Each entry maps a command id to a key string, an array of key strings, or `null`; `leader` changes the leader key.

```json
{ "ampi": { "keymap": { "leader": "alt+x", "ampi.showVersion": "<leader>v", "thread.scrollToTop": null } } }
```

Key strings follow `ampi-core`'s keymap grammar ([`docs/ampi-core-api.md`](../../../docs/ampi-core-api.md#keymap)): combos such as `ctrl+c`, chords separated by spaces such as `ctrl+c ctrl+c`, and `<leader>` at the start of a chord. Overrides are read at each session start; run `/reload` after editing them. Unknown command ids, keys that do not parse, two commands on one key, and a key that is also the start of a longer chord are reported once as a warning.

To start from the keys in effect, pick "ampi show keymap" in the command palette: it shows every command id with its key (or `null`) and its description as JSONC, ready to copy under `ampi.keymap`.

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

- **Top border, right: cost and mode.** The active ampi mode in its colour (`low` yellow, `medium` green, `high` blue, `ultra` violet; `free` in the border colour), and before it the cost of the session so far. A new session shows no cost; during its first turn the cost reads `$····` until the first response arrives. Below one cent it has three decimals (`$0.003`), above it two.
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
│ ? toggle shortcuts help                                                      │
│ ──────────────────────────────────────────────────────────────────────────── │
│                                                                              │
│                                                                              │
│                                                                              │
╰────────────────────────────────────────────────────────── /work/repo (main) ─╯
```

- **What it lists.** The mode keys when ampi-core is loaded (the [mode dial](#mode-dial)'s key, which follows `mode.toggle` under `ampi.keymap`, and Alt+D), the newline key, Pi's `@` file mention, the leader, then every command that has a key, in the order the commands were registered, with the key in effect: a binding moved under `ampi.keymap` shows its new key, an unbound command is left out, and the help's own `?` comes last. A command with several keys lists them joined by `or` (`? or F1`). Two commands of one kind with one key each, whose names differ only in the last word, share a row (`Home/End scroll to top/bottom`).
- **Layout.** Two columns, the second starting 34 columns from the box's left edge, when every entry fits; otherwise one column, with entries cut to the width.
- **Inside tmux.** When tmux's `extended-keys` option is off, a dim line under the rows says that Shift+Enter needs it and that Alt+Enter works without it. ampi asks tmux once, the first time the help opens.
- **Height.** The box grows by the help. When that would pass a third of the terminal height, the text area shrinks to one row, then the tmux line goes, then entries from the end, except the help's own `?` row, which stays as the last one shown so the help always says how to close it; the rule always stays. In an 80x24 terminal the help has room for six rows, so the last entry before `?` (Alt+T with the default commands) is left out.
- **Closing.** `?` again or Esc closes it. Any other key closes it and then does what it always does: typing a character closes the help and inserts the character, and a key that runs a command (`/` for the palette, Ctrl+G, Home or End) closes it before the command runs. Text that arrives from elsewhere (the external editor, queued messages taken back) closes it too. While a turn runs, the first Esc of Esc Esc closes it along with clearing the prompt.
- With text in the prompt, `?` is an ordinary character.

The model, token totals and context use that Pi's footer showed are not on screen; `/ampi-status` reports the mode and model.

**Keys in the prompt box.**

| Key | Does |
| --- | --- |
| Enter | Sends the prompt; while a turn runs, Pi delivers it to steer the turn |
| Alt+Enter, Shift+Enter, Ctrl+J | Insert a newline (Alt+Enter is Pi's follow-up key; the box takes it over) |
| Esc | Closes the shortcuts help when it is open; otherwise clears the prompt when it has text. On an empty prompt with nothing running, Esc does what it does in Pi |
| `?` on an empty prompt | Shows or hides the shortcuts help |
| Backspace on an empty prompt | Takes queued messages back into the prompt (Pi's `app.message.dequeue`) |

Everything else, including Ctrl+A and Ctrl+E for the line start and end, is Pi's editor behaviour.

### Keys

**Chords.** A key binding is one key or a chord of several keys pressed one after the other. After the first key of a chord, ampi waits up to 1.5 seconds for the next one and shows a popup above the prompt, at the right edge, titled with the key pressed so far ("Ctrl+X then"). Each row names a key that can follow and what it does, sorted by key. Pressing a listed key runs its command; Esc closes the popup; any other key closes it and does what it normally does, or starts its own chord. The popup also closes by itself when the wait ends.

**Leader.** Ctrl+X is the leader key: bindings written as `<leader>z` mean Ctrl+X, then Z. The popup appears after Ctrl+X even when nothing is bound after it yet, and says so. `ampi.keymap.leader` moves the leader to another key.

**Esc Esc.** While a turn runs, one Esc clears the prompt (if it has text) and two Escapes within half a second stop the turn. While the prompt's autocomplete list is open, Esc closes the list and counts toward nothing. When nothing is running, Esc is left to Pi.

**Ctrl+C.** The first Ctrl+C keeps the prompt as it is and shows the "Ctrl+C then" popup; a second Ctrl+C quits. A running turn is stopped first, then Pi exits the way its own double Ctrl+C does.

**Home and End.** With an empty prompt, Home jumps to the start of the transcript and End jumps back to the end and follows new output. With text in the prompt they move the cursor as before. Scrolling needs Pi's fullscreen mode (`tuiMode: "fullscreen"`, Pi's default); in regular mode Home and End stay with the editor.

**Details.** Alt+T expands the output of every tool row and shows thinking blocks; the next press collapses the tool output and hides thinking. Pi keeps these as two separate switches. Alt+T sets both to the same state, so thinking that is already shown stays shown on the press that expands the tools. Pi saves the thinking switch to your global settings, as its own Ctrl+T does. A project settings file that sets `hideThinkingBlock` wins over that saved value, and then the two can fall out of step; Ctrl+T brings thinking back in line.

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
- Every registered ampi command is listed, other than the palette itself. Pi's slash commands are listed under the `pi` category: Pi's built-in commands, then commands from extensions, prompt templates and skills. The legacy `/mmr-*` aliases are left out, and so are the slash commands that an ampi row already runs, such as `/ampi-status` and `/mode`. These rows need an empty prompt.
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
- Without ampi-core's `/mode` command, Ctrl+S is left to Pi.
- While `ampi-tui` is on, ampi-core's own Ctrl+S and Ctrl+Space cycle keys do nothing, so if you unbind or move `mode.toggle` under `ampi.keymap`, Ctrl+S no longer changes the mode.
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

### What changes compared with Pi's defaults

| Key | Pi | With `ampi-tui` |
| --- | --- | --- |
| Esc while a turn runs | Stops the turn | Clears the prompt; a second Esc within 0.5 s stops the turn |
| Esc with text, nothing running | Nothing | Clears the prompt |
| Alt+Enter | Queues a follow-up message | Inserts a newline |
| Backspace on an empty prompt | Nothing | Takes queued messages back into the prompt |
| Ctrl+C | Clears the prompt; twice within 0.5 s quits | Shows the "Ctrl+C then" popup and keeps the prompt; twice within 1.5 s quits |
| Ctrl+X | Copies the last assistant message | Leader key; the popup lists what can follow |
| Home / End on an empty prompt | Moves the cursor | Jumps to the start or end of the transcript |
| Ctrl+G | Opens the external editor | The same, now the `prompt.openInEditor` command |
| Ctrl+O | Expands or collapses tool output | Opens the command palette |
| `/` on an empty prompt | Types `/` and opens slash-command completion | Opens the command palette |
| Alt+T | Nothing | Expands or collapses tool output and thinking together |
| `?` on an empty prompt | Types `?` | Shows or hides the shortcuts help |
| Ctrl+S | Nothing in the prompt (ampi-core makes it cycle the mode) | Opens the mode dial |

Everything else keeps Pi's binding, including Ctrl+T (thinking blocks only), Ctrl+D (quit on an empty prompt) and Ctrl+Home / Ctrl+End (transcript scrolling).

- Clearing the prompt: Ctrl+C no longer clears it; Esc does.
- Follow-up messages: Alt+Enter no longer queues one. Bind Pi's `app.message.followUp` to another key in Pi's `keybindings.json` to keep follow-ups on a key; Enter while a turn runs still steers it.
- Pi's own key hints still describe Pi's keys: the hint line under the startup header ("escape interrupt", "ctrl+c/ctrl+d clear/exit", "ctrl+o more"), "Press ctrl+o to show full startup help" and the "ctrl+o to expand" note on collapsed tool output. Where they name Ctrl+O, press Alt+T instead: it expands tool output, thinking and the full startup help.
- When nothing is running, Pi's double Esc on an empty prompt opens the session tree. Set Pi's `doubleEscapeAction` to `"none"` to turn that off.
- To keep a Pi key, unbind the ampi command that takes it: `"ampi.quit": null` gives Ctrl+C back to Pi, `"thread.interrupt": null` brings back Pi's Esc interrupt (Esc still clears a non-empty prompt first). Copying with Ctrl+X needs the leader moved elsewhere, or Pi's `app.message.copy` bound to another key in Pi's `keybindings.json`.

### Welcome header

- Replaces Pi's logo and key hints at the top of the transcript, and scrolls away with it.
- On the left, ampi's mark: two rings of dots turning against each other. It animates for about nine seconds in a new session, and stops when you send the first message. A resumed session shows it still.
- On the right, "Welcome to ampi" and the hints `ctrl+o for commands · ? for shortcuts`. The keys these hints name arrive with the command palette and the shortcuts help.
- Below the hints, after an update (or on first install), a card with the first item of the newest changelog entry and a `dismiss` hint. Any key press or the first message hides it. `/ampi-changelog` lists every change. The card shows once per new version, like the notification it replaces.
- Terminals narrower than 100 columns or shorter than 30 rows get a smaller mark and a one-line card; below 60 columns the mark is left out.
- `quietStartup: true` in Pi's settings draws nothing. `quietStartup: "header"` keeps the welcome header and hides Pi's list of loaded resources, which otherwise appears below it and can push it off a small screen.

### Transcript styling

- User messages: a `┃ ` bar in front of every line, wrapped lines included, then the raw text in italics, with Markdown left as typed. Bar and text use the theme's `userMessageText` colour (green in the `ampi` theme). No background.
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
- Pi offers no API to draw user messages, so `ampi-tui` replaces the drawing method of Pi's user message component. When a Pi release changes that component, `ampi-tui` leaves it alone and Pi's own user message box appears.
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
- Calls of ampi-workers' tools (`oracle`, `librarian`, `finder`, `Task`, `reviewer`, custom `sa__*` subagents, `start_task`, `task_poll`, `task_wait`, `task_cancel`) are never grouped: each keeps its own row and splits the run around it. A call whose result shows an image, such as a `read` of a screenshot in a terminal that draws images, does the same once its result arrives, so its row stays above the image.
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
- Shell commands are named for what they do. A command that only reads a file (`cat`, `head`, `tail`, `sed -n`, `less`) shows as `Read <path>` with the line range when the command names one (`sed -n '1,220p' x.ts` is `Read x.ts L1-220`). A search (`rg`, `grep`, `git grep`) shows as `Grep`, a listing (`ls`, `find`, `fd`) as `Listed` with its name pattern, `sed -i` as `Edited`. Anything else, including pipelines into other programs, redirections into files and command substitutions, is `Ran <command>`. A leading `cd <dir> &&` is followed into that directory.
- Edits show the diff stat (`+N -M`), failed commands their exit code, or `(timed out after Ns)` or `(killed)` when they ended without one. A `write` call always shows as `Created`, with every line counted as added, because its result does not say whether the file existed before. Paths are shown relative to the working directory, or with `~` for the home directory.
- MCP tools show as `Ran <server>/<tool>`, other tools as `Ran <tool>`, each with the first argument that says what the call is about.
- Expanding tool output (Pi's Ctrl+O, which applies to every row) switches to cards:
  - shell commands: `$ <command>` with the program in bold and flags and strings in syntax colours, `(in <dir>)` when it ran elsewhere, `(exit code: N)` when it failed, then the first 15 lines of output and `… N more lines`;
  - `edit`, `write` and `apply_patch`: the underlined path (a clickable `file://` link where the terminal supports links), the diff stat, and the diff with line numbers, removed lines in red and added lines in green, cut after 60 lines;
  - `read`: the linked path and its line range; `grep`, `find` and `ls`: their output;
  - MCP and other tools without renderers of their own: their arguments as `key: value` lines and the result text.
- Tools that bring their own renderers, such as ampi's task list, get the one-line row when collapsed and keep their own card when expanded. ampi-workers' tools draw their own rows, collapsed and expanded (`✓ Consulted oracle · Review the plan`), because only their renderers read a worker's outcome; see [ampi-workers](../ampi-workers/README.md#transcript-rows).
- Rows use theme colours for text only, never a background.
- Pi's HTML export draws the tools it does not render itself (such as `grep`, `find`, `apply_patch` and MCP tools) with these renderers. There the row with its final status sits below the tool name, and expanding it shows the card.

### Planned

Later releases lock the mode once a thread has messages; the dial then shows the mode without changing it. Each change lands behind the same `ampiTui.enabled` switch.

## Diagnostics and troubleshooting

- **The footer still shows, the keys behave like stock Pi, or Pi's logo shows instead of the welcome header.** `ampi-tui` is off (`ampiTui.enabled: false` in a settings file, or `AMPI_TUI_ENABLE=false`), or the session is not interactive. Check both settings files and the environment, then restart Pi.
- **The prompt box shows no branch.** The working directory is not a git repository, or Pi has not read the branch yet; it updates when Pi notices a branch change.
- **No welcome header at all.** Pi's `quietStartup` is `true`. Set it to `"header"` to keep the header without the resource list.
- **No changelog card.** The card shows only once after an update; `/ampi-changelog` lists every change.
- **Colours are not the `ampi` theme.** A theme is set in Pi's settings (or with `--use-theme`); `ampi-tui` leaves it in place. Choose `ampi` in `/settings`.
- **You want the footer back.** Set `ampiTui.enabled` to `false` and restart Pi or run `/reload`.
- **A rebinding has no effect.** Check for an `ampi keymap:` warning at session start, then run `/reload`. A binding to a single key that Pi does not reserve is handed to Pi's shortcut list, which Pi reads at session start, so it needs `/reload` even when the warning is absent.
- **Home and End only move the cursor.** The prompt has text, or Pi runs in regular mode (`tuiMode: "regular"`), where the terminal's own scrollback replaces transcript scrolling.
- **No notification when a turn finishes.** Check `ampiTui.notifications` (`enabled` and `system`), whether your terminal shows OSC 777 notifications, and whether you run inside tmux (see [Limits](#limits)). Try `AMPI_FORCE_BEL=1` for a bell instead. Notifications closer than two seconds apart are dropped.
- **The window title does not change.** The terminal, or tmux's `allow-set-title` option, ignores title changes.

## Public API

Stable re-exports from `ampi`: `createMmrTuiExtension`, `loadMmrTuiSettings` and the `MmrTuiSettings` / `MmrTuiFactoryOverrides` types, each with its `Ampi*` alias. Canonical catalog: [`../../../docs/public-api.md`](../../../docs/public-api.md). The chrome-owner seam, command registry and keymap live in `ampi-core`: [`../../../docs/ampi-core-api.md`](../../../docs/ampi-core-api.md#additional-exported-helpers).

## Developer notes

- Manifest: risk class `terminal-ui`, child role `none`. No subagent child keep-set lists it, and child workers never run in the terminal UI.
- Layout: `index.ts` (entry point), `config.ts` (settings), `chrome/look.ts` (installs the welcome header, message styling and theme), `chrome/welcome.ts` (header component, mark and card), `chrome/title-notify.ts` (terminal title and notifications), `chrome/quit-summary.ts` (the summary printed after quitting), `editor/` (the prompt box), `transcript/messages.ts` (user message drawing, thinking label), `transcript/activity.ts` and `transcript/tool-renderers.ts` (tool rows), `theme/` (`ampi.json` and its session selection), `keys/`, `ui/`, `overlays/`, `pi-compat/`.
- `editor/prompt-box.ts` draws the prompt box (a `CustomEditor` subclass), its border slots and the open shortcuts help; `editor/help.ts` builds the help rows from the effective keymap and the command registry and lays them out; `editor/status-feed.ts` maps Pi's agent events onto ampi-core's thread status reducer; `editor/install.ts` installs the box at session start, feeds it the mode, cost, status, wave glyph and branch, toggles the help and runs the one-time tmux check.
- `keys/decode.ts` turns terminal input into keymap combos; `keys/dispatcher.ts` is the pure chord state machine; `keys/hint-popup.ts` draws the popup; `keys/commands.ts` defines the commands; `keys/install.ts` wires them into Pi, opens the palette and tells the prompt box about the first Esc, the pending quit, the open palette, the help toggle and every other key command (which closes the help).
- `ui/frame.ts` draws the box overlays share (rounded border, title in the top border, key hints in the bottom border, scrollbar column); `overlays/palette.ts` is the command palette; `overlays/mode-dial.ts` is the mode dial with its list view; `overlays/help-keymap.ts` builds the Help & Keymap sections from the registry, the keymap and Pi's keybindings, and draws them and the keymap JSONC in one scrolling box.
- Routing: a binding goes through `pi.registerShortcut` only when it is a single key that Pi does not reserve, starts no longer chord, and belongs to a command without an availability check. Everything else goes through Pi's raw terminal input, so a key whose command is unavailable still reaches the editor.
- Tool rows: `transcript/activity.ts` classifies a call (pure, no Pi imports) and `summarizeActivities` folds a run of calls into one phrase; `transcript/activity-groups.ts` keeps the runs, fed by Pi's message and tool events and rebuilt from the session's context entries, because a renderer sees only its own call; `transcript/tool-renderers.ts` draws rows and cards through one `pi.registerToolRenderer` resolver. The first call of a run draws the summary, and the others render no lines, which Pi draws with no height and no spacer. Tests: `tests/mmr-tui-activity.test.mjs`, `tests/mmr-tui-activity-groups.test.mjs`, `tests/mmr-tui-tool-renderers.test.mjs` and `tests/mmr-tui-tool-groups.test.mjs`, whose 80- and 140-column fixtures in `tests/fixtures/mmr-tui-tool-rows/` and `tests/fixtures/mmr-tui-tool-groups/` are refreshed with `PI_MMR_UPDATE_FIXTURES=1`.
- `pi-compat/` is the only place that touches Pi runtime surface outside the extension API: the focused editor with its action handlers, autocomplete state and rendered height, the editor's submit handler (the only path that runs Pi's built-in slash commands) and the list of those commands, the editor's height rule (`editor-height.ts`), transcript scrolling, the reserved shortcut list, raw input, and the user message component. `tests/mmr-tui-pi-compat.test.mjs` probes each against the installed Pi and fails when Pi changes shape.
- `pi-compat/messages.ts` patches `UserMessageComponent.prototype.rebuild`. It is installed when the extension loads, because Pi rebuilds the chat on `/reload` before `session_start`, and removed at `session_shutdown`. `probeMmrUserMessageComponent` names any change in the class shape.
- The theme is applied as a `Theme` object, never by name: `ctx.ui.setTheme("ampi")` would write the user's settings. An empty widget below the editor re-applies it when Pi returns to `system`, using the component `invalidate()` call Pi makes on every theme change.
- Tests: `tests/mmr-tui-extension.test.mjs` (enablement, run modes, settings, load order, prompt box wiring), `tests/mmr-tui-prompt-box.test.mjs` (render fixtures in `tests/fixtures/mmr-tui-prompt-box/`, geometry, keys, the shortcuts help), `tests/mmr-tui-status-feed.test.mjs`, `tests/mmr-tui-key-decode.test.mjs`, `tests/mmr-tui-key-dispatcher.test.mjs`, `tests/mmr-tui-keys-install.test.mjs` (also the palette and details commands), `tests/mmr-tui-frame.test.mjs`, `tests/mmr-tui-palette.test.mjs`, `tests/mmr-tui-help-keymap.test.mjs` (sections, keys and the two commands; fixtures in `tests/fixtures/ampi-tui-help-keymap/`), `tests/mmr-tui-pi-compat.test.mjs`, `tests/mmr-tui-welcome.test.mjs` (layout fixtures in `tests/fixtures/ampi-tui-welcome/`, animation on a fake clock, card from fixture changelogs, `quietStartup`), `tests/mmr-tui-messages.test.mjs` (user message drawing), `tests/mmr-tui-theme.test.mjs` (schema, palette, selection), `tests/mmr-tui-title-notify.test.mjs` (title forms, notification policy and throttles on a fake clock), `tests/mmr-tui-quit-summary.test.mjs` and `tests/mmr-core-status.test.mjs` (ampi-core yields the footer to a chrome owner). Refresh the layout fixtures with `PI_MMR_UPDATE_FIXTURES=1`.
