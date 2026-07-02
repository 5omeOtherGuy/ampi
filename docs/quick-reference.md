# ampi quick reference

Fast lookup for AMP Code-style modes, tools, optional gates, and common troubleshooting in Pi Agent.

## Modes

| I want to... | Use | Notes |
| --- | --- | --- |
| Default balanced coding | `/mode smart` | Default when no flag/session/settings override exists |
| Balanced coding on a Claude Code subscription | `/mode fable` | Smart posture pinned to Claude Fable 5 via `claude-subscription`, toggleable low/medium/high thinking |
| Fast, low-token turns | `/mode rush` | Smaller posture for quick edits and short loops |
| Deep reasoning, planning, review | `/mode deep` | Use for hard debugging, architecture, migrations, and reviews |
| Stock Pi behavior | `/mode free` | Releases ampi locks and removes ampi-owned tools |

```text
/mode              # show current mode
/mode deep         # switch mode
/mmr-status        # concise locked-mode status
/mmr-status debug  # model preference candidates, tool resolution, policy details
```

Mode source precedence: `--mmr-mode` flag → persisted session → `mmrCore.defaultMode` → `smart`.

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

## Optional reach

| Capability | Enable | Provides |
| --- | --- | --- |
| Web search/page reads | `MMR_WEB_ENABLE=true` or `mmrWeb.enabled=true` | `web_search`, `read_web_page` |
| GitHub repository reads | `MMR_GITHUB_ENABLE=true` | `read_github`, `list_directory_github`, `glob_github`, `search_github`, `commit_search`, `diff_github`, `list_repositories` |
| Prior local Pi sessions | `MMR_HISTORY_ENABLE=true` | `find_session`, `read_session` |

Optional secrets stay in the environment:

```bash
export BRAVE_API_KEY="brv_xxx"
export MMR_GITHUB_TOKEN="ghp_xxx"
```

Restart Pi after changing gates that register tools.

## Settings

Minimal settings example:

```json
{
  "mmrCore": {
    "defaultMode": "rush",
    "subagentModelPreferences": {
      "finder": [{ "model": "gpt-5.4-mini", "thinkingLevel": "low" }]
    }
  },
  "mmrWeb": { "enabled": true }
}
```

Settings are read from `~/.pi/agent/settings.json` and `<project>/.pi/settings.json`. Flat (`mmrCore`) and nested (`mmr.core`) forms are accepted where supported by the owning extension.

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
| `Model applied: no` | Run `/mmr-status debug`; check provider registration/authentication |
| Tool is `gated` | Enable its extension and restart Pi |
| `librarian` is `gated` | Enable `MMR_GITHUB_ENABLE`; add `MMR_GITHUB_TOKEN` for private repos/search |
| Web search is unreliable | Configure `MMR_WEB_SEARXNG_URL` or `BRAVE_API_KEY` |
| Mode unexpectedly became `free` | Re-enter `/mode <key>` after native `/model` or `/think` changes |
| Locked mode refuses to activate | Check model preference candidates and active tool resolution in `/mmr-status debug` |

Full troubleshooting: [`troubleshooting.md`](troubleshooting.md).
