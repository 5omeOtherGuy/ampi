# ampi quick reference

Fast lookup for AMP Code-style modes, tools, optional gates, and common troubleshooting in Pi Agent.

## Modes

| I want to... | Use | Notes |
| --- | --- | --- |
| Quick, focused work | `/mode low` | GPT-5.6 Terra, medium reasoning, compact prompt body |
| Default balanced coding | `/mode medium` | GPT-5.6 Sol, medium reasoning, full prompt body, 300k safety profile |
| Demanding implementation/debugging | `/mode high` | GPT-5.6 Sol, extra-high reasoning, full prompt body |
| Maximum-effort work | `/mode ultra` | GPT-5.6 Sol, Pi `xhigh` reasoning, full prompt body |
| Stock Pi behavior | `/mode free` | Releases ampi locks and removes ampi-owned tools |

```text
/mode              # show current mode
/mode high         # switch mode; after the first message, an explicit override of the lock
/ampi-status        # concise locked-mode status, including the mode lock
/ampi-status debug  # model preference candidates, tool resolution, policy details
Ctrl+S              # mode dial, until the first message: further presses or ←/→ turn low → medium → high → ultra;
                    # Tab lists all modes (without ampi-tui: cycles directly; Ctrl+Space is a deprecated alias that only works then)
Ctrl+Shift+S        # mode picker (Alt+M fallback), until the first message
Alt+D               # toggle the active mode's thinking preset (medium, high, ultra)
```

In the interactive TUI, locked modes compact the conversation automatically once a finished run leaves it at 90% of the context window (Medium: 270k of 300k); `free`, subagent workers and `print`, `json` and `rpc` runs never do. Set `ampiCore.autoCompact` to `{ "threshold": 0.8 }` to compact earlier or to `false` to leave compaction to Pi; `/ampi-status debug` shows the threshold and the last auto-compaction.

Mode source precedence: `--ampi-mode` flag → persisted session → `ampiCore.defaultMode` → `medium`. Legacy `rush`, `smart`, `deep`, and `fable` inputs normalize to `low`, `medium`, `high`, and `ultra`.

File editing follows the route, not the mode: `openai`, `openai-codex`, and `azure` routes get `apply_patch` + `write`; every other provider gets `edit` + `write`. `ampiCore.editTools` (`"auto"`, `"patch"`, `"edit"`) forces one family; `/ampi-status` names the active one on its `Edit tools:` line.

The mode is fixed once a session has a message: the dial or cycle, the picker and the palette's `mode use` rows stop changing it, and only `/mode <key>` or a native Pi model change still does. Start a new session for another mode, or set `ampiCore.modeLock` to `false` to switch at any time.

## Workers and subagents

| I need to... | Ask for... | Tool |
| --- | --- | --- |
| Locate code by concept or behavior | “Use finder to locate…” | `finder` |
| Get deep architecture/review/debug advice | “Ask oracle to review…” | `oracle` |
| Run bounded child work | “Use Task to…” | `Task` |
| Review a completed diff/change | “Use reviewer to review…” | `reviewer` |
| Research a GitHub repository | “Use librarian to explain owner/repo…” | `librarian` |
| Run independent jobs | “Run finder/Task/librarian with background: true…” | `background: true`, `task_poll`, `task_wait`, `task_cancel` |
| Use custom workers | “Use sa__name to…” | imported Markdown `sa__*` tools |

Examples:

```text
Use finder to find where mode activation applies tool allowlists.
Ask oracle to review the fallback design and list risks.
Use Task to update the focused docs file and run git diff --check.
Use reviewer to review all uncommitted changes.
Use librarian to explain how owner/repo implements request cancellation.
```

Each worker call shows as one line in the transcript; expand tool output (Ctrl+O, or Alt+T with `ampi-tui`) to see its latest steps, its answer and its token use:

```text
 ⠋ Searching codebase · where mode activation applies tool allowlists
 ✓ Consulted oracle · Review the fallback design and list risks
 ✗ Subagent finished · Update the focused docs file
 ⊘ Researched with librarian · how owner/repo implements request cancellation
```

## Patch

Owned by `ampi-patch` (`mmr-patch` runtime id).

| I need to... | Use | Notes |
| --- | --- | --- |
| Apply a focused patch | `apply_patch` | Local workspace edits only; rejects ambiguous/path-unsafe patches |

## Tasks

Owned by `ampi-tasks` (`mmr-tasks` runtime id).

| I need to... | Use | Notes |
| --- | --- | --- |
| Track multi-step work | `task_list` | Session-local; rendered in the Pi UI |
| Show or hide the pinned list | `/tasks show`, `/tasks hide` | No toggle key by default; `--task-widget-toggle-key <key>` binds one |

## Optional reach

| Capability | Enable | Provides |
| --- | --- | --- |
| Web search/page reads | `AMPI_WEB_ENABLE=true` (legacy `MMR_WEB_ENABLE` still accepted) or `ampiWeb.enabled=true` | `web_search`, `read_web_page` |
| GitHub repository reads | `AMPI_GITHUB_ENABLE=true` (legacy `MMR_GITHUB_ENABLE` still accepted) | `read_github`, `list_directory_github`, `glob_github`, `search_github`, `commit_search`, `diff_github`, `list_repositories` |
| Prior local Pi sessions | `AMPI_HISTORY_ENABLE=true` (legacy `MMR_HISTORY_ENABLE` still accepted) | `find_session`, `read_session` |

Optional secrets stay in the environment:

```bash
export BRAVE_API_KEY="brv_xxx"
export AMPI_GITHUB_TOKEN="ghp_xxx"
```

Restart Pi after changing gates that register tools.

## Keys

Amp-compatible keys from `ampi-tui` in interactive sessions. After the first key of a chord, a popup above the prompt lists the keys that can follow; it closes after 1.5 seconds or on Esc.

| Key | Does | Notes |
| --- | --- | --- |
| `Esc` | Clear the prompt | While a turn runs, the first Esc of `Esc Esc` also clears it; on an empty prompt with nothing running, Esc is Pi's |
| `Esc Esc` | Stop the running turn | Two presses within 0.5 s |
| `Enter` | Send the prompt | While a turn runs, the message steers it |
| `Alt+Enter`, `Shift+Enter`, `Ctrl+J` | New line | Alt+Enter no longer queues a follow-up |
| `Enter` on an empty prompt | Steer with the next queued message | Only while a message is queued |
| `Backspace` on an empty prompt | Take queued messages back into the prompt | Only while messages are queued; Pi's `Alt+Up` does the same |
| `Ctrl+C Ctrl+C` | Quit | The first press shows the popup and keeps the prompt |
| `Ctrl+C Ctrl+N` | Archive this session and start a new one | From `ampi-threads`; only in a session with messages |
| `Ctrl+C Ctrl+E` | Archive this session and quit | From `ampi-threads`; only in a session with messages |
| `Ctrl+X` | Leader | Bindings written `<leader>z` mean Ctrl+X, then Z |
| `Home` / `End` | Jump to the start / end of the transcript | Only with an empty prompt, in Pi's fullscreen mode |
| `Ctrl+G` | Edit the prompt in your external editor | Pi's action, now a command |
| `Ctrl+R` | Open the prompt history | Prompts you sent in this workspace, newest first; type to filter, Enter puts one in the prompt without sending it, Alt+W or Ctrl+T shows every workspace's; needs `ampi-threads` |
| `Ctrl+O` | Open the command palette | Type to filter, ↑/↓ to move, Enter to run, Esc to close; Pi's slash commands are listed under `pi` |
| `/` | Open the command palette | Only on an empty prompt; with text, `/` is typed as usual |
| `Alt+T` | Expand or collapse tool output and thinking together | Replaces Pi's Ctrl+O for tool output |
| `?` | Show or hide the shortcuts help | Only on an empty prompt; Esc or any other key closes it |

In the command palette, "ampi help" opens the Help & Keymap screen: every editor key, scrolling key and command with the key in effect (`—` when it has none). "ampi show keymap" shows the keymap in effect as JSONC to copy under `ampi.keymap`. Both scroll with ↑/↓, j/k and PgUp/PgDn; Esc closes them.

The shortcuts help lists the keys in effect, including any you rebound, in the prompt box above the text. Inside tmux with `extended-keys` off it adds a line saying Shift+Enter needs that option; Alt+Enter works either way.

The prompt box shows the session's state in its borders: the mode and the session cost at the top right, the turn status and key hints at the bottom left, the working directory and git branch at the bottom right.

While a turn runs, `prompt queue message` in the palette queues the prompt to run after the turn instead of steering it. Waiting messages are listed above the prompt box, `steering:` first, then `queued:`. `prompt steer queued message` and `prompt dequeue` do what Enter and Backspace on an empty prompt do.

The terminal title reads `<title> - ampi - <cwd>`, with the wave glyph in front while a turn runs and `! <status>:` when the turn needs you. When a turn finishes or waits for an approval, ampi sends a desktop notification through the terminal (a bell over SSH or with `AMPI_FORCE_BEL=1`). After Ctrl+C Ctrl+C, ampi's mark, the session title and the working directory stay in the scrollback above Pi's resume line.

Rebind under `ampi.keymap` (a key string, an array, or `null` to unbind; `leader` moves the leader), then `/reload`:

```json
{ "ampi": { "keymap": { "leader": "alt+x", "ampi.quit": null } } }
```

## Command line

The optional `ampi` command (`npm i -g @skippermissions/ampi-cli`) starts Pi with ampi loaded. Other options and Pi's own commands go to Pi unchanged.

| I want to... | Run | Notes |
| --- | --- | --- |
| Start a session | `ampi` | Same as `pi -e npm:@skippermissions/ampi` |
| Start in a mode | `ampi -m high` | `-m`/`--mode` become `--ampi-mode`; `--mode text`, `json`, `rpc` stay Pi's output format |
| Pass a message that looks like an option | `ampi -- -m is a flag` | Everything after `--` goes to Pi as the message |
| See versions | `ampi version` | ampi-cli, ampi and Pi |
| See Pi's options | `ampi --pi-help` | Includes the `--ampi-*` flags |

If Pi's settings already list `@skippermissions/ampi`, the command uses that copy and says so on stderr instead of loading ampi twice.

## Settings

Minimal settings example:

```json
{
  "ampiCore": {
    "defaultMode": "low",
    "subagentModelPreferences": {
      "finder": [{ "model": "gpt-5.4-mini", "thinkingLevel": "low" }]
    }
  },
  "ampiWeb": { "enabled": true },
  "ampiTui": { "notifications": { "enabled": true, "system": true, "sound": false } }
}
```

`ampiTui.notifications`: `enabled` turns notifications off entirely, `system` the desktop notification (or bell), `sound` a `paplay` sound from the freedesktop theme.

Settings are read from `~/.pi/agent/settings.json` and `<project>/.pi/settings.json`. Flat (`ampiCore`) and nested (`ampi.core`) forms are accepted where supported by the owning extension.

## Tool status words

| Status | Meaning |
| --- | --- |
| `active` | Registered and available to the current mode |
| `gated` | Known but waiting on config or a prerequisite |
| `disabled` | Explicitly turned off |
| `deferred` | Reserved for planned capability |
| `missing` | No extension registered that tool name |

## Common fixes

| Symptom | Do this |
| --- | --- |
| `Model applied: no` | Run `/ampi-status debug`; check provider registration/authentication |
| Tool is `gated` | Enable its extension and restart Pi |
| `librarian` is `gated` | Enable `AMPI_GITHUB_ENABLE`; add `AMPI_GITHUB_TOKEN` for private repos/search |
| Web search is unreliable | Configure `AMPI_WEB_SEARXNG_URL` or `BRAVE_API_KEY` |
| Mode unexpectedly became `free` | Re-enter `/mode <key>` after native `/model` or `/think` changes |
| Ctrl+S says the mode stays | The session has messages; use `/mode <key>`, start a new session, or set `ampiCore.modeLock: false` |
| Locked mode refuses to activate | Check model preference candidates and active tool resolution in `/ampi-status debug` |
| No footer below the editor | `ampi-tui` removes it by default; set `ampiTui.enabled: false` (or `AMPI_TUI_ENABLE=false`) and restart Pi to restore it |
| Ctrl+C no longer clears the prompt | `ampi-tui` uses Ctrl+C Ctrl+C to quit; clear with Ctrl+U, or set `"ampi.quit": null` under `ampi.keymap` to give Ctrl+C back to Pi |
| One Esc no longer stops a turn | Press Esc twice; or set `"thread.interrupt": null` under `ampi.keymap` |
| Ctrl+O no longer expands tool output | `ampi-tui` puts the command palette there; Alt+T expands tool output and thinking together |
| `/` on an empty prompt opens the palette instead of slash completion | Pick the command under `pi` in the palette; a command that takes arguments is put into the prompt for you to finish and send. Or set `"prompt.openPalette": null` under `ampi.keymap` to type slash commands directly |
| No notification when a turn finishes | Check `ampiTui.notifications`; inside tmux, or in a terminal without OSC 777 notifications, set `AMPI_FORCE_BEL=1` for a bell |
| Alt+Enter no longer queues a follow-up | It inserts a newline in the prompt box; use `prompt queue message` in the palette, or bind `prompt.queue` under `ampi.keymap` |

Full troubleshooting: [`troubleshooting.md`](troubleshooting.md).
