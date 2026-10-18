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
/mode high         # switch mode
/ampi-status        # concise locked-mode status
/ampi-status debug  # model preference candidates, tool resolution, policy details
Ctrl+S              # cycle low → medium → high → ultra (Ctrl+Space: deprecated alias)
Ctrl+Shift+S        # mode picker (Alt+M fallback)
Alt+D               # toggle the active mode's thinking preset (medium, high, ultra)
```

Mode source precedence: `--ampi-mode` flag → persisted session → `ampiCore.defaultMode` → `medium`. Legacy `rush`, `smart`, `deep`, and `fable` inputs normalize to `low`, `medium`, `high`, and `ultra`.

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
| `Esc Esc` | Stop the running turn | Two presses within 0.5 s; when nothing runs, Esc is Pi's |
| `Ctrl+C Ctrl+C` | Quit | The first press shows the popup and keeps the prompt |
| `Ctrl+X` | Leader | Bindings written `<leader>z` mean Ctrl+X, then Z |
| `Home` / `End` | Jump to the start / end of the transcript | Only with an empty prompt, in Pi's fullscreen mode |
| `Ctrl+G` | Edit the prompt in your external editor | Pi's action, now a command |
| `Ctrl+O` | Open the command palette | Type to filter, ↑/↓ to move, Enter to run, Esc to close; Pi's slash commands are listed under `pi` |
| `/` | Open the command palette | Only on an empty prompt; with text, `/` is typed as usual |
| `Alt+T` | Expand or collapse tool output and thinking together | Replaces Pi's Ctrl+O for tool output |

Rebind under `ampi.keymap` (a key string, an array, or `null` to unbind; `leader` moves the leader), then `/reload`:

```json
{ "ampi": { "keymap": { "leader": "alt+x", "ampi.quit": null } } }
```

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
  "ampiWeb": { "enabled": true }
}
```

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
| Locked mode refuses to activate | Check model preference candidates and active tool resolution in `/ampi-status debug` |
| No footer below the editor | `ampi-tui` removes it by default; set `ampiTui.enabled: false` (or `AMPI_TUI_ENABLE=false`) and restart Pi to restore it |
| Ctrl+C no longer clears the prompt | `ampi-tui` uses Ctrl+C Ctrl+C to quit; clear with Ctrl+U, or set `"ampi.quit": null` under `ampi.keymap` to give Ctrl+C back to Pi |
| One Esc no longer stops a turn | Press Esc twice; or set `"thread.interrupt": null` under `ampi.keymap` |
| Ctrl+O no longer expands tool output | `ampi-tui` puts the command palette there; Alt+T expands tool output and thinking together |
| `/` on an empty prompt opens the palette instead of slash completion | Pick the command under `pi` in the palette, or set `"prompt.openPalette": null` under `ampi.keymap` to type slash commands directly |

Full troubleshooting: [`troubleshooting.md`](troubleshooting.md).
