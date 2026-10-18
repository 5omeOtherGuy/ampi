# ampi-tui

Owns the look and keys of interactive `ampi` sessions in the terminal: it removes the footer and adds Amp-compatible key chords.

Package overview: [`../../../README.md`](../../../README.md). Planning: [`../../../ROADMAP.md`](../../../ROADMAP.md). Public API: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## At a glance

| Default | Provides | Requires | Diagnostics |
| --- | --- | --- | --- |
| On | Footer-free terminal layout; one-line tool rows; Ctrl+X leader, Esc Esc, Ctrl+C Ctrl+C, Home/End | Interactive Pi session | No footer row below the editor; a "then" popup after Ctrl+X or Ctrl+C; `/ampi-status` |

## When to use it

- You want the transcript and the prompt to fill the terminal, with no status rows below the editor.
- You want Amp-compatible keys: two Escapes to interrupt, Ctrl+C twice to quit, a Ctrl+X leader, Home and End to jump through the transcript.
- You are building on ampi's terminal layout or keys: later layout and key work lands here, not in `ampi-core`.

## Status and enablement

Default: on. `ampi-tui` is registered in `package.json` `pi.extensions` and loads without opt-in config. Opt out with `ampiTui.enabled: false` (see [Configuration](#configuration)).

It acts only in interactive terminal sessions. Print, JSON and RPC runs, subagent workers included, are left untouched. It owns no tools or feature gates. It registers palette commands in `ampi-core`'s command registry and binds their keys.

## Tools / commands / surfaces

| Surface | Type | Purpose |
| --- | --- | --- |
| Footer | Pi footer slot | Replaced with an empty component, so no row is drawn below the editor |
| Tool rows | Pi tool renderer | One line per tool call, and a card per call when tool output is expanded |
| `thread.interrupt` | Command, `esc esc` | Stop the running turn |
| `ampi.quit` | Command, `ctrl+c ctrl+c` | Quit Pi, stopping a running turn first |
| `thread.scrollToTop`, `thread.scrollToBottom` | Commands, `home` / `end` | Jump to the start or end of the transcript while the prompt is empty |
| `prompt.openInEditor` | Command, `ctrl+g` | Edit the prompt in your external editor (Pi's own action) |
| `ampi.showVersion` | Command, no key | Show the ampi and Pi versions |
| "then" popup | Overlay | Lists the keys that can follow Ctrl+X, Ctrl+C or any other chord prefix |

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

The setting is read once when the extension loads. Restart Pi or run `/reload` after changing it.

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
- Mode switching, mode state and `/ampi-status` work as before.
- The claim is released when the session shuts down, and the commands are unregistered. If you turn `ampi-tui` off and reload, ampi-core's footer and Pi's own keys return.
- Turned off, `ampi-tui` registers nothing at all, and the session looks and behaves as it did before this extension existed.

### Keys

**Chords.** A key binding is one key or a chord of several keys pressed one after the other. After the first key of a chord, ampi waits up to 1.5 seconds for the next one and shows a popup above the prompt, at the right edge, titled with the key pressed so far ("Ctrl+X then"). Each row names a key that can follow and what it does, sorted by key. Pressing a listed key runs its command; Esc closes the popup; any other key closes it and does what it normally does, or starts its own chord. The popup also closes by itself when the wait ends.

**Leader.** Ctrl+X is the leader key: bindings written as `<leader>z` mean Ctrl+X, then Z. The popup appears after Ctrl+X even when nothing is bound after it yet, and says so. `ampi.keymap.leader` moves the leader to another key.

**Esc Esc.** While a turn runs, one Esc does nothing visible and two Escapes within half a second stop the turn. While the prompt's autocomplete list is open, Esc closes the list and counts toward nothing. When nothing is running, Esc is left to Pi.

**Ctrl+C.** The first Ctrl+C keeps the prompt as it is and shows the "Ctrl+C then" popup; a second Ctrl+C quits. A running turn is stopped first, then Pi exits the way its own double Ctrl+C does.

**Home and End.** With an empty prompt, Home jumps to the start of the transcript and End jumps back to the end and follows new output. With text in the prompt they move the cursor as before. Scrolling needs Pi's fullscreen mode (`tuiMode: "fullscreen"`, Pi's default); in regular mode Home and End stay with the editor.

**Dialogs and selectors.** While a Pi dialog, selector or capturing overlay has focus (the model picker, `/tree`, and so on), ampi lets every key through to it.

### What changes compared with Pi's defaults

| Key | Pi | With `ampi-tui` |
| --- | --- | --- |
| Esc while a turn runs | Stops the turn | Needs a second Esc within 0.5 s |
| Ctrl+C | Clears the prompt; twice within 0.5 s quits | Shows the "Ctrl+C then" popup and keeps the prompt; twice within 1.5 s quits |
| Ctrl+X | Copies the last assistant message | Leader key; the popup lists what can follow |
| Home / End on an empty prompt | Moves the cursor | Jumps to the start or end of the transcript |
| Ctrl+G | Opens the external editor | The same, now the `prompt.openInEditor` command |

Everything else keeps Pi's binding, including Ctrl+O (tool output), Ctrl+D (quit on an empty prompt) and Ctrl+Home / Ctrl+End (transcript scrolling).

- Clearing the prompt: Ctrl+C no longer clears it, and Esc does not clear it yet. Use Ctrl+U (delete to the line start) or select and delete.
- Pi's own key hints still describe Pi's keys: the hint line under the startup header ("escape interrupt", "ctrl+c/ctrl+d clear/exit") and the "escape to interrupt" note while a turn runs.
- When nothing is running, Pi's double Esc on an empty prompt opens the session tree. Set Pi's `doubleEscapeAction` to `"none"` to turn that off.
- To keep a Pi key, unbind the ampi command that takes it: `"ampi.quit": null` gives Ctrl+C back to Pi, `"thread.interrupt": null` brings back the single-Esc interrupt. Copying with Ctrl+X needs the leader moved elsewhere, or Pi's `app.message.copy` bound to another key in Pi's `keybindings.json`.

### What stays on screen

- Pi's header and its list of loaded resources at startup. Pi's `quietStartup` setting hides them: `"header"` keeps the header and hides the list, `true` hides both.
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
- Shell commands are named for what they do. A command that only reads a file (`cat`, `head`, `tail`, `sed -n`, `less`) shows as `Read <path>` with the line range when the command names one (`sed -n '1,220p' x.ts` is `Read x.ts L1-220`). A search (`rg`, `grep`, `git grep`) shows as `Grep`, a listing (`ls`, `find`, `fd`) as `Listed`, `sed -i` as `Edited`. Anything else, including pipelines into other programs, redirections into files and command substitutions, is `Ran <command>`. A leading `cd <dir> &&` is followed into that directory.
- Edits show the diff stat (`+N -M`), failed commands their exit code. Paths are shown relative to the working directory, or with `~` for the home directory.
- MCP tools show as `Ran <server>/<tool>`, other tools as `Ran <tool>`, each with the first argument that says what the call is about.
- Expanding tool output (Pi's Ctrl+O, which applies to every row) switches to cards:
  - shell commands: `$ <command>` with the program in bold and flags and strings in syntax colours, `(in <dir>)` when it ran elsewhere, `(exit code: N)` when it failed, then the first 15 lines of output and `… N more lines`;
  - `edit`, `write` and `apply_patch`: the underlined path (a clickable `file://` link where the terminal supports links), the diff stat, and the diff with line numbers, removed lines in red and added lines in green, cut after 60 lines;
  - `read`: the linked path and its line range; `grep`, `find` and `ls`: their output;
  - MCP and other tools without renderers of their own: their arguments as `key: value` lines and the result text.
- Tools that bring their own renderers, such as ampi's subagents and task list, get the one-line row when collapsed and keep their own card when expanded.
- Rows use theme colours for text only, never a background. The same renderers draw tool calls in Pi's HTML export.

### Planned

Later releases move that information into the borders of the prompt box, let Esc clear the prompt, and add a command palette on Ctrl+O, a mode picker, grouped tool rows and a welcome header. Each lands behind the same `ampiTui.enabled` switch.

## Diagnostics and troubleshooting

- **The footer still shows, or the keys behave like stock Pi.** `ampi-tui` is off (`ampiTui.enabled: false` in a settings file, or `AMPI_TUI_ENABLE=false`), or the session is not interactive. Check both settings files and the environment, then restart Pi.
- **You want the footer back.** Set `ampiTui.enabled` to `false` and restart Pi or run `/reload`.
- **A rebinding has no effect.** Check for an `ampi keymap:` warning at session start, then run `/reload`. A binding to a single key that Pi does not reserve is handed to Pi's shortcut list, which Pi reads at session start, so it needs `/reload` even when the warning is absent.
- **Home and End only move the cursor.** The prompt has text, or Pi runs in regular mode (`tuiMode: "regular"`), where the terminal's own scrollback replaces transcript scrolling.

## Public API

Stable re-exports from `ampi`: `createMmrTuiExtension`, `loadMmrTuiSettings` and the `MmrTuiSettings` / `MmrTuiFactoryOverrides` types, each with its `Ampi*` alias. Canonical catalog: [`../../../docs/public-api.md`](../../../docs/public-api.md). The chrome-owner seam, command registry and keymap live in `ampi-core`: [`../../../docs/ampi-core-api.md`](../../../docs/ampi-core-api.md#additional-exported-helpers).

## Developer notes

- Manifest: risk class `terminal-ui`, child role `none`. No subagent child keep-set lists it, and child workers never run in the terminal UI.
- `keys/decode.ts` turns terminal input into keymap combos; `keys/dispatcher.ts` is the pure chord state machine; `keys/hint-popup.ts` draws the popup; `keys/commands.ts` defines the commands; `keys/install.ts` wires them into Pi.
- Routing: a binding goes through `pi.registerShortcut` only when it is a single key that Pi does not reserve, starts no longer chord, and belongs to a command without an availability check. Everything else goes through Pi's raw terminal input, so a key whose command is unavailable still reaches the editor.
- `pi-compat/` is the only place that touches Pi runtime surface outside the extension API: the focused editor with its action handlers, autocomplete state and rendered height, transcript scrolling, the reserved shortcut list. `tests/mmr-tui-pi-compat.test.mjs` probes each against the installed Pi and fails when Pi changes shape.
- Tests: `tests/mmr-tui-extension.test.mjs` (enablement, run modes, settings, load order), `tests/mmr-tui-key-decode.test.mjs`, `tests/mmr-tui-key-dispatcher.test.mjs`, `tests/mmr-tui-keys-install.test.mjs`, `tests/mmr-tui-pi-compat.test.mjs`, and `tests/mmr-core-status.test.mjs` (ampi-core yields the footer to a chrome owner).
- Tool rows: `transcript/activity.ts` classifies a call (pure, no Pi imports) and `summarizeActivities` folds a run of calls into one phrase for grouped rows; `transcript/tool-renderers.ts` draws rows and cards through one `pi.registerToolRenderer` resolver. Tests: `tests/mmr-tui-activity.test.mjs` and `tests/mmr-tui-tool-renderers.test.mjs`, whose 80- and 140-column fixtures in `tests/fixtures/mmr-tui-tool-rows/` are refreshed with `PI_MMR_UPDATE_FIXTURES=1`.
