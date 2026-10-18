# ampi-tui

Owns the look and keys of interactive `ampi` sessions in the terminal: a footer-free layout, Amp-compatible key chords, a welcome header with ampi's mark and the newest changelog item, Amp-compatible message styling and the `ampi` theme.

Package overview: [`../../../README.md`](../../../README.md). Planning: [`../../../ROADMAP.md`](../../../ROADMAP.md). Public API: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## At a glance

| Default | Provides | Requires | Diagnostics |
| --- | --- | --- | --- |
| On | Footer-free terminal layout; one-line tool rows; Ctrl+X leader, Esc Esc, Ctrl+C Ctrl+C, Home/End | Interactive Pi session | No footer row below the editor; a "then" popup after Ctrl+X or Ctrl+C; `/ampi-status` |
| On | Footer-free terminal layout; welcome header, message styling, `ampi` theme; Ctrl+X leader, Esc Esc, Ctrl+C Ctrl+C, Home/End | Interactive Pi session | Welcome header at startup; no footer row below the editor; a "then" popup after Ctrl+X or Ctrl+C; `/ampi-status` |
| On | Footer-free terminal layout; Ctrl+X leader, Esc Esc, Ctrl+C Ctrl+C, Home/End; command palette on Ctrl+O and `/`; Alt+T details toggle | Interactive Pi session | No footer row below the editor; a "then" popup after Ctrl+X or Ctrl+C; `/ampi-status` |

## When to use it

- You want the transcript and the prompt to fill the terminal, with no status rows below the editor.
- You want Amp-compatible keys: two Escapes to interrupt, Ctrl+C twice to quit, a Ctrl+X leader, Home and End to jump through the transcript.
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
| Footer | Pi footer slot | Replaced with an empty component, so no row is drawn below the editor |
| Tool rows | Pi tool renderer | One line per tool call, and a card per call when tool output is expanded |
| `thread.interrupt` | Command, `esc esc` | Stop the running turn |
| `ampi.quit` | Command, `ctrl+c ctrl+c` | Quit Pi, stopping a running turn first |
| `thread.scrollToTop`, `thread.scrollToBottom` | Commands, `home` / `end` | Jump to the start or end of the transcript while the prompt is empty |
| `prompt.openInEditor` | Command, `ctrl+g` | Edit the prompt in your external editor (Pi's own action) |
| `ampi.showVersion` | Command, no key | Show the ampi and Pi versions |
| `ampi.palette` | Command, `ctrl+o` | Open the command palette |
| `prompt.openPalette` | Command, `/` | Open the command palette when the prompt is empty |
| `thread.toggleDetails` | Command, `alt+t` | Expand or collapse tool output and thinking together |
| `ampi.status`, `ampi.changelog`, `ampi.config` | Commands, no key | Run `/ampi-status`, `/ampi-changelog` and `/ampi-config` (need `ampi-core`) |
| `mode.use.low` … `mode.use.free` | Commands, no key | Switch to that mode, as `/mode <key>` does (need `ampi-core`) |
| "then" popup | Overlay | Lists the keys that can follow Ctrl+X, Ctrl+C or any other chord prefix |
| `ampi` theme | Pi package theme (`theme/ampi.json`) | Amp-compatible colour roles on ANSI palette indices |
| User messages | Transcript | A bar on every line, raw italic text in the theme's user colour, no background |
| Thinking | Transcript | No label when thinking is collapsed |
| Command palette | Overlay | Lists every command with its key; type to filter, Enter to run |

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

The settings are read once when the extension loads. Restart Pi or run `/reload` after changing them.

### Keymap

Rebind or unbind any command under `ampi.keymap` in Pi's settings. Each entry maps a command id to a key string, an array of key strings, or `null`; `leader` changes the leader key.

```json
{ "ampi": { "keymap": { "leader": "alt+x", "ampi.showVersion": "<leader>v", "thread.scrollToTop": null } } }
```

Key strings follow `ampi-core`'s keymap grammar ([`docs/ampi-core-api.md`](../../../docs/ampi-core-api.md#keymap)): combos such as `ctrl+c`, chords separated by spaces such as `ctrl+c ctrl+c`, and `<leader>` at the start of a chord. Overrides are read at each session start; run `/reload` after editing them. Unknown command ids, keys that do not parse, two commands on one key, and a key that is also the start of a longer chord are reported once as a warning.

## Behavior

### With ampi-core

- At session start, `ampi-tui` claims ampi's terminal chrome through ampi-core's chrome-owner seam and installs an empty footer.
- While it holds the claim, ampi-core stops drawing its two-line footer in locked modes and no longer brings Pi's footer back in `free` mode.
- ampi-core hands its new-version changelog notice to `ampi-tui`, which shows it as the welcome card instead of a notification. With `quietStartup: true`, or outside the terminal UI, the notification shows as before.
- Mode switching, mode state and `/ampi-status` work as before.
- Everything is released when the session shuts down, and the commands are unregistered. If you turn `ampi-tui` off and reload, ampi-core's footer and notification return, Pi's header and keys come back and user messages are drawn by Pi again.
- Turned off, `ampi-tui` registers nothing at all, and the session looks and behaves as it did before this extension existed.

### Keys

**Chords.** A key binding is one key or a chord of several keys pressed one after the other. After the first key of a chord, ampi waits up to 1.5 seconds for the next one and shows a popup above the prompt, at the right edge, titled with the key pressed so far ("Ctrl+X then"). Each row names a key that can follow and what it does, sorted by key. Pressing a listed key runs its command; Esc closes the popup; any other key closes it and does what it normally does, or starts its own chord. The popup also closes by itself when the wait ends.

**Leader.** Ctrl+X is the leader key: bindings written as `<leader>z` mean Ctrl+X, then Z. The popup appears after Ctrl+X even when nothing is bound after it yet, and says so. `ampi.keymap.leader` moves the leader to another key.

**Esc Esc.** While a turn runs, one Esc does nothing visible and two Escapes within half a second stop the turn. While the prompt's autocomplete list is open, Esc closes the list and counts toward nothing. When nothing is running, Esc is left to Pi.

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
- Every registered ampi command is listed, other than the palette itself. Pi's slash commands are listed under the `pi` category: Pi's built-in commands, then commands from extensions, prompt templates and skills. Picking one runs it as if you had typed it into the prompt and pressed Enter, so these rows need an empty prompt. The legacy `/mmr-*` aliases are left out.
- `/` opens the palette only while the prompt is empty and focused, so Pi's slash completion no longer opens from an empty prompt. With text in the prompt, `/` is typed as usual. To type slash commands directly instead, unbind it: `{ "ampi": { "keymap": { "prompt.openPalette": null } } }`.
- Pi draws overlays over the screen as it is, so the transcript and prompt behind the palette are not dimmed.

### What changes compared with Pi's defaults

| Key | Pi | With `ampi-tui` |
| --- | --- | --- |
| Esc while a turn runs | Stops the turn | Needs a second Esc within 0.5 s |
| Ctrl+C | Clears the prompt; twice within 0.5 s quits | Shows the "Ctrl+C then" popup and keeps the prompt; twice within 1.5 s quits |
| Ctrl+X | Copies the last assistant message | Leader key; the popup lists what can follow |
| Home / End on an empty prompt | Moves the cursor | Jumps to the start or end of the transcript |
| Ctrl+G | Opens the external editor | The same, now the `prompt.openInEditor` command |
| Ctrl+O | Expands or collapses tool output | Opens the command palette |
| `/` on an empty prompt | Types `/` and opens slash-command completion | Opens the command palette |
| Alt+T | Nothing | Expands or collapses tool output and thinking together |

Everything else keeps Pi's binding, including Ctrl+T (thinking blocks only), Ctrl+D (quit on an empty prompt) and Ctrl+Home / Ctrl+End (transcript scrolling).

- Clearing the prompt: Ctrl+C no longer clears it, and Esc does not clear it yet. Use Ctrl+U (delete to the line start) or select and delete.
- Pi's own key hints still describe Pi's keys: the hint line under the startup header ("escape interrupt", "ctrl+c/ctrl+d clear/exit") and the "escape to interrupt" note while a turn runs.
- When nothing is running, Pi's double Esc on an empty prompt opens the session tree. Set Pi's `doubleEscapeAction` to `"none"` to turn that off.
- To keep a Pi key, unbind the ampi command that takes it: `"ampi.quit": null` gives Ctrl+C back to Pi, `"thread.interrupt": null` brings back the single-Esc interrupt. Copying with Ctrl+X needs the leader moved elsewhere, or Pi's `app.message.copy` bound to another key in Pi's `keybindings.json`.

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

### What stays on screen

- Pi's list of loaded resources and extension issues below the header. Pi's `quietStartup` setting hides the list.
- The working directory, branch, token usage, cost, context use, model and mode that the footer showed are not shown elsewhere yet. `/ampi-status` still reports the mode and model.

### Transcript tool rows

Every tool call in the transcript is drawn as one line: a status glyph, a verb and what the call acted on.

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
- Tools that bring their own renderers, such as ampi's subagents and task list, get the one-line row when collapsed and keep their own card when expanded.
- Rows use theme colours for text only, never a background.
- Pi's HTML export draws the tools it does not render itself (such as `grep`, `find`, `apply_patch` and MCP tools) with these renderers. There the row with its final status sits below the tool name, and expanding it shows the card.

### Planned

Later releases move that information into the borders of the prompt box, let Esc clear the prompt, and add a command palette on Ctrl+O, a mode picker, grouped tool rows and a welcome header. Each lands behind the same `ampiTui.enabled` switch.
Later releases move that information into the borders of the prompt box, let Esc clear the prompt, and add a command palette on Ctrl+O and a mode picker. Each lands behind the same `ampiTui.enabled` switch.
Later releases move that information into the borders of the prompt box, let Esc clear the prompt, and add a mode picker, compact tool rows and a welcome header. Each lands behind the same `ampiTui.enabled` switch.

## Diagnostics and troubleshooting

- **The footer still shows, the keys behave like stock Pi, or Pi's logo shows instead of the welcome header.** `ampi-tui` is off (`ampiTui.enabled: false` in a settings file, or `AMPI_TUI_ENABLE=false`), or the session is not interactive. Check both settings files and the environment, then restart Pi.
- **No welcome header at all.** Pi's `quietStartup` is `true`. Set it to `"header"` to keep the header without the resource list.
- **No changelog card.** The card shows only once after an update; `/ampi-changelog` lists every change.
- **Colours are not the `ampi` theme.** A theme is set in Pi's settings (or with `--use-theme`); `ampi-tui` leaves it in place. Choose `ampi` in `/settings`.
- **You want the footer back.** Set `ampiTui.enabled` to `false` and restart Pi or run `/reload`.
- **A rebinding has no effect.** Check for an `ampi keymap:` warning at session start, then run `/reload`. A binding to a single key that Pi does not reserve is handed to Pi's shortcut list, which Pi reads at session start, so it needs `/reload` even when the warning is absent.
- **Home and End only move the cursor.** The prompt has text, or Pi runs in regular mode (`tuiMode: "regular"`), where the terminal's own scrollback replaces transcript scrolling.

## Public API

Stable re-exports from `ampi`: `createMmrTuiExtension`, `loadMmrTuiSettings` and the `MmrTuiSettings` / `MmrTuiFactoryOverrides` types, each with its `Ampi*` alias. Canonical catalog: [`../../../docs/public-api.md`](../../../docs/public-api.md). The chrome-owner seam, command registry and keymap live in `ampi-core`: [`../../../docs/ampi-core-api.md`](../../../docs/ampi-core-api.md#additional-exported-helpers).

## Developer notes

- Manifest: risk class `terminal-ui`, child role `none`. No subagent child keep-set lists it, and child workers never run in the terminal UI.
- Layout: `index.ts` (entry point), `config.ts` (settings), `chrome/look.ts` (installs the welcome header, message styling and theme), `chrome/welcome.ts` (header component, mark and card), `transcript/messages.ts` (user message drawing, thinking label), `theme/` (`ampi.json` and its session selection), `keys/`, `pi-compat/`.
- `keys/decode.ts` turns terminal input into keymap combos; `keys/dispatcher.ts` is the pure chord state machine; `keys/hint-popup.ts` draws the popup; `keys/commands.ts` defines the commands; `keys/install.ts` wires them into Pi.
- Routing: a binding goes through `pi.registerShortcut` only when it is a single key that Pi does not reserve, starts no longer chord, and belongs to a command without an availability check. Everything else goes through Pi's raw terminal input, so a key whose command is unavailable still reaches the editor.
- `pi-compat/` is the only place that touches Pi runtime surface outside the extension API: the focused editor with its action handlers, autocomplete state and rendered height, transcript scrolling, the reserved shortcut list. `tests/mmr-tui-pi-compat.test.mjs` probes each against the installed Pi and fails when Pi changes shape.
- Tests: `tests/mmr-tui-extension.test.mjs` (enablement, run modes, settings, load order), `tests/mmr-tui-key-decode.test.mjs`, `tests/mmr-tui-key-dispatcher.test.mjs`, `tests/mmr-tui-keys-install.test.mjs`, `tests/mmr-tui-pi-compat.test.mjs`, and `tests/mmr-core-status.test.mjs` (ampi-core yields the footer to a chrome owner).
- Tool rows: `transcript/activity.ts` classifies a call (pure, no Pi imports) and `summarizeActivities` folds a run of calls into one phrase for grouped rows; `transcript/tool-renderers.ts` draws rows and cards through one `pi.registerToolRenderer` resolver. Tests: `tests/mmr-tui-activity.test.mjs` and `tests/mmr-tui-tool-renderers.test.mjs`, whose 80- and 140-column fixtures in `tests/fixtures/mmr-tui-tool-rows/` are refreshed with `PI_MMR_UPDATE_FIXTURES=1`.
- `pi-compat/` is the only place that touches Pi runtime surface outside the extension API: the focused editor with its action handlers, autocomplete state and rendered height, transcript scrolling, the reserved shortcut list, raw input, and the user message component. `tests/mmr-tui-pi-compat.test.mjs` probes each against the installed Pi and fails when Pi changes shape.
- `pi-compat/messages.ts` patches `UserMessageComponent.prototype.rebuild`. It is installed when the extension loads, because Pi rebuilds the chat on `/reload` before `session_start`, and removed at `session_shutdown`. `probeMmrUserMessageComponent` names any change in the class shape.
- The theme is applied as a `Theme` object, never by name: `ctx.ui.setTheme("ampi")` would write the user's settings. An empty widget below the editor re-applies it when Pi returns to `system`, using the component `invalidate()` call Pi makes on every theme change.
- Tests: `tests/mmr-tui-extension.test.mjs` (enablement, run modes, settings, load order), `tests/mmr-tui-key-decode.test.mjs`, `tests/mmr-tui-key-dispatcher.test.mjs`, `tests/mmr-tui-keys-install.test.mjs`, `tests/mmr-tui-pi-compat.test.mjs`, `tests/mmr-tui-welcome.test.mjs` (layout fixtures in `tests/fixtures/ampi-tui-welcome/`, animation on a fake clock, card from fixture changelogs, `quietStartup`), `tests/mmr-tui-messages.test.mjs` (user message drawing), `tests/mmr-tui-theme.test.mjs` (schema, palette, selection) and `tests/mmr-core-status.test.mjs` (ampi-core yields the footer to a chrome owner). Refresh the layout fixtures with `PI_MMR_UPDATE_FIXTURES=1`.
- `keys/decode.ts` turns terminal input into keymap combos; `keys/dispatcher.ts` is the pure chord state machine; `keys/hint-popup.ts` draws the popup; `keys/commands.ts` defines the commands; `keys/install.ts` wires them into Pi and opens the palette.
- `ui/frame.ts` draws the box overlays share (rounded border, title in the top border, key hints in the bottom border, scrollbar column); `overlays/palette.ts` is the command palette.
- Routing: a binding goes through `pi.registerShortcut` only when it is a single key that Pi does not reserve, starts no longer chord, and belongs to a command without an availability check. Everything else goes through Pi's raw terminal input, so a key whose command is unavailable still reaches the editor.
- `pi-compat/` is the only place that touches Pi runtime surface outside the extension API: the focused editor with its action handlers, autocomplete state and rendered height, transcript scrolling, the reserved shortcut list, the editor's submit handler (the only path that runs Pi's built-in slash commands) and the list of those commands. `tests/mmr-tui-pi-compat.test.mjs` probes each against the installed Pi and fails when Pi changes shape.
- Tests: `tests/mmr-tui-extension.test.mjs` (enablement, run modes, settings, load order), `tests/mmr-tui-key-decode.test.mjs`, `tests/mmr-tui-key-dispatcher.test.mjs`, `tests/mmr-tui-keys-install.test.mjs` (also the palette and details commands), `tests/mmr-tui-frame.test.mjs`, `tests/mmr-tui-palette.test.mjs`, `tests/mmr-tui-pi-compat.test.mjs`, and `tests/mmr-core-status.test.mjs` (ampi-core yields the footer to a chrome owner).
