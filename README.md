# ampi

[![CI](https://github.com/5omeOtherGuy/ampi/actions/workflows/ci.yml/badge.svg)](https://github.com/5omeOtherGuy/ampi/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Pi package](https://img.shields.io/badge/Pi-package-7c3aed)

> AMP Code but in Pi Agent.

`ampi` is a faithful, self-contained AMP Code-style harness for Pi Agent. It brings the AMP-style coding workflow into Pi as a production-ready extension package for the implemented workflows: opinionated locked modes, curated tools, subagents, background workers, web/repository/session context, fallback behavior, and strong defaults that aim for AMP Code parity while still running on **your** Pi install, subscriptions, API keys, models, and settings.

ampi is not an official AMP Code package. It is an independent Pi extension that implements the listed AMP-style behavior in repo-owned code and tracks remaining parity gaps below.

Use `ampi` as-is for the intended experience. Advanced users can override models, subagent routes, optional gates, and custom Markdown subagents, but the package ships with a complete default posture so a fresh install already feels like AMP Code inside Pi.

## What ampi already gives you

### AMP-style harness modes

- **`low`** — GPT-5.6 Terra at medium reasoning for quick, focused work, with the Smart prompt posture.
- **`medium`** — default balanced mode using GPT-5.6 Sol at medium reasoning, the Smart prompt posture, and the inherited 300k context safety profile.
- **`high`** — GPT-5.6 Sol at extra-high reasoning with the Deep prompt posture for demanding implementation and debugging.
- **`ultra`** — GPT-5.6 Sol at Pi's maximum supported `xhigh` effort with the Deep prompt posture.
- **`free`** — exit hatch back to stock Pi behavior with ampi-owned tools removed.

Each locked mode swaps the whole harness together: model preference order, thinking policy, context profile, active-tool allowlist, subagent defaults, and model-visible prompt posture. Mode resolution is deterministic and inspectable; there is no hidden prompt classifier or silent automatic model switching.

### AMP Code-style parity features already implemented

- **Whole-harness mode switching** via `--ampi-mode`, `/mode`, hotkeys, and persisted session/settings state.
- **Provider-neutral model preferences** that prefer subscription/OAuth providers first, then API-key providers, then other registered providers.
- **Your subscriptions and keys**: Claude subscription, OpenAI/Codex, API-key providers, Brave Search, GitHub tokens, and SearXNG all stay under your control.
- **Managed thinking and context policy** per mode, including mode-local thinking toggles and context display/capping where the mode owns it.
- **Prompt posture replacement** that preserves Pi's own tool list, docs, project context, skills, date/cwd, and tail content while replacing the coding harness head.
- **Exact active-tool allowlists** with `/ampi-status debug` diagnostics for active, gated, disabled, deferred, and missing tools.
- **Safe local patching** through `apply_patch`, including path-safety checks across the workspace and sibling worktrees.
- **Session-local planning** through `task_list`, rendered as a pinned Pi widget.
- **Subagents**: `finder`, `oracle`, `librarian`, `Task`, `reviewer`, the internal `history-reader`, and custom Markdown `sa__*` subagents.
- **Background work fleets**: `background: true`, grouped launches, live TUI task board, automatic completion delivery, and `task_poll` / `task_wait` / `task_cancel` controls.
- **Repository research** with `librarian` plus read-only GitHub tools (`read_github`, `list_directory_github`, `glob_github`, `search_github`, `commit_search`, `diff_github`, `list_repositories`).
- **Web research** with `web_search` and `read_web_page`, including SearXNG, Brave Search, DuckDuckGo fallback, domain filters, recency filters where supported, SSRF protections, and readable-page extraction.
- **Prior-session recall** with `find_session` and `read_session`, opaque project refs instead of raw paths, opt-in content redaction, and a read-only history-reader worker.
- **Subscription quota/capacity fallback** for provider failures, with explicit retry messaging instead of silent route mutation.
- **Custom subagent import/setup** for Markdown agent definitions with safe tool mapping, per-mode scope, model/thinking config, and project/global enablement.
- **Production guardrails**: deterministic tests, no live API calls in the committed suite, fail-closed activation, exact-name tool ownership, source-owned Free-mode cleanup, and public-safe prompt provenance.

## Quick start

Pi must already be installed and authenticated. `@skippermissions/ampi` is the npm
package name; `ampi` is the product and runtime brand you see in commands, modes,
and settings.

Install for your user (recommended):

```bash
pi install npm:@skippermissions/ampi
```

Install for one project only (writes to `.pi/settings.json`, shareable with your
team):

```bash
pi install -l npm:@skippermissions/ampi
```

Try it for a single run without installing:

```bash
pi -e npm:@skippermissions/ampi --ampi-mode medium
```

Keep it up to date:

```bash
pi update --extensions            # update all Pi packages
pi update npm:@skippermissions/ampi  # update just ampi
```

Prefer installing from git, or want an unreleased commit? Use the git source as
a fallback (pin a tag or commit with `@<ref>`):

```bash
pi install git:github.com/5omeOtherGuy/ampi
pi install -l git:github.com/5omeOtherGuy/ampi
```

Inside Pi:

```text
/ampi-status
/ampi-status debug
/mode low
/mode high
/mode ultra
/mode free
```

The control surface is canonical `ampi`: `/ampi-*` commands, `--ampi-*` flags, `AMPI_*` env vars, and `ampi*` settings. The legacy `/mmr-*`, `--mmr-*`, `MMR_*`, and `mmr*` identifiers remain accepted as aliases for existing setups.

## First two minutes

1. Start in the default AMP-style mode:

   ```bash
   pi -e npm:@skippermissions/ampi --ampi-mode medium
   ```

2. Inspect the resolved harness:

   ```text
   /ampi-status
   /ampi-status debug
   ```

3. Switch modes by intent:

   ```text
   /mode low        # quick, focused turns with GPT-5.6 Terra
   /mode medium     # balanced default on GPT-5.6 Sol with the Smart prompt posture
   /mode high       # demanding GPT-5.6 Sol work with the Deep prompt posture
   /mode ultra      # GPT-5.6 Sol at maximum supported effort
   /mode free       # stock Pi behavior; ampi-owned tools removed
   ```

4. Delegate bounded work:

   ```text
   Use finder to locate where provider model preferences are resolved.
   Ask oracle to review the mode activation design.
   Use Task to update the focused docs file and run the narrow check.
   Use reviewer to review all uncommitted changes.
   ```

5. Enable optional reach only when needed:

   ```bash
   export AMPI_WEB_ENABLE=true
   export AMPI_GITHUB_ENABLE=true
   export AMPI_HISTORY_ENABLE=true
   ```

## Modes

| Intent | Mode | What ampi controls |
| --- | --- | --- |
| Quick, focused work | `low` | GPT-5.6 Terra then GPT-5.5, medium reasoning, Smart prompt posture, focused tools |
| Balanced coding | `medium` | GPT-5.6 Sol then Claude Opus 4.8, medium reasoning, Smart prompt posture, broad tools, 300k context safety profile |
| Demanding work | `high` | GPT-5.6 Sol then Claude Opus 4.8, extra-high reasoning, Deep prompt posture and broad research/subagent tools |
| Maximum effort | `ultra` | GPT-5.6 Sol then GPT-5.5, Pi `xhigh` reasoning, Deep prompt posture and broad research/subagent tools |
| Native Pi | `free` | Releases ampi model/thinking/prompt/tool enforcement |

Mode selection precedence: `--ampi-mode` flag → restored session state → `ampiCore.defaultMode` → `medium`. Legacy `rush`, `smart`, `deep`, and `fable` values are accepted and migrate to `low`, `medium`, `high`, and `ultra`, respectively.

Useful controls:

```text
/mode              # show current mode
/mode high         # switch mode
/ampi-status       # current harness status
/ampi-status debug # model/tool/source diagnostics
Ctrl+Shift+S       # mode picker  (Alt+M fallback)
Ctrl+Space         # cycle low → medium → high → ultra
Alt+R              # toggle the active mode's thinking preset where supported
```

## Tools and subagents

| Need | Use |
| --- | --- |
| Safe file patches | `apply_patch` |
| Session todo plan | `task_list` |
| Behavior-level codebase search | `finder` |
| Expert planning/review/debugging advice | `oracle` |
| Scoped implementation/investigation/repair | `Task` |
| Independent background work | `background: true`, `task_poll`, `task_wait`, `task_cancel` |
| Independent diff/code review | `reviewer` |
| Remote GitHub research | `librarian` |
| Direct read-only GitHub operations | `read_github`, `list_directory_github`, `glob_github`, `search_github`, `commit_search`, `diff_github`, `list_repositories` |
| Public web search/read | `web_search`, `read_web_page` |
| Prior Pi session recall | `find_session`, `read_session` |
| Custom workers | Markdown `sa__*` subagents imported through `/ampi-config` |

## Feature map

| Extension family | Default | User value |
| --- | --- | --- |
| `ampi-core` (`mmr-core` runtime id) | On | Locked modes, model resolution, request/thinking policy, active tools, prompt rewrite, diagnostics, config flow |
| `ampi-patch` | On | Safe `apply_patch` editing |
| `ampi-tasks` | On | Session-local `task_list` planning widget |
| `ampi-workers` | On | `finder`, `oracle`, `Task`, `reviewer`, gated `librarian`, background fleets, worker trails |
| `ampi-custom-subagents` | On | Markdown-defined `sa__*` workers with scoped tools/models/thinking |
| `ampi-session-fallback` | On | Explicit fallback on subscription quota, rate limits, overloads, and capacity stalls |
| `ampi-web` | Off | Opt-in web search/page reading through your chosen backend |
| `ampi-github` | Off | Opt-in read-only GitHub tools and librarian prerequisite |
| `ampi-history` | Off | Opt-in local Pi session search and reuse |

The package also exposes `./extensions/ampi-*` export aliases while keeping legacy `./extensions/mmr-*` subpaths for existing consumers.

## Configure your own defaults

Non-secret settings live in Pi settings files. Secrets belong in environment variables.

```json
{
  "ampiCore": {
    "defaultMode": "low",
    "modelPreferences": {
      "high": [{ "model": "gpt-5.5", "thinkingLevel": "xhigh" }]
    },
    "subagentModelPreferences": {
      "finder": [{ "model": "gpt-5.4-mini", "thinkingLevel": "low" }]
    }
  },
  "ampiWeb": { "enabled": true }
}
```

```bash
export AMPI_WEB_ENABLE=true
export AMPI_GITHUB_ENABLE=true
export AMPI_HISTORY_ENABLE=true
export BRAVE_API_KEY="..."
export AMPI_GITHUB_TOKEN="ghp_xxx"
```

The `AMPI_*` env vars take precedence; the legacy `MMR_*` names (for example `MMR_WEB_ENABLE`) are still accepted.

Settings are read from `~/.pi/agent/settings.json` and `<project>/.pi/settings.json`. Restart Pi after changing settings or env vars that gate tool registration.

## Production safety

- Locked modes are **fail-closed**: no usable model or zero active tools aborts activation before mutation.
- Free mode removes only ampi-owned tools; third-party tools keep working.
- Network and history features are opt-in and gated.
- GitHub tokens and web/search keys are read from env, not settings files.
- `read_web_page` rejects localhost/private/link-local targets.
- History always hides raw session file paths/project roots behind opaque refs; content redaction is opt-in with `AMPI_HISTORY_REDACT=true`.
- Worker runs are bounded, surfaced in the TUI, and report non-normal outcomes explicitly.

## What is still missing

ampi is production-ready for the implemented AMP Code-style workflow, but parity work continues:

- Continued `/mmr-*`, `--mmr-*`, `MMR_*`, and `mmr*` legacy-alias compatibility alongside the canonical `ampi` surface.
- A richer `/ampi-status debug` history of deterministic mode/fallback events.
- More background-widget metadata and grouped completion polish.
- A TUI browser for prior sessions and stored web/research result IDs.
- A proxy-first MCP tool surface with the same gated/self-contained posture.
- Optional worktree isolation for child workers after safety semantics are pinned.

## Documentation

- **Docs index:** [`docs/README.md`](docs/README.md)
- **Quick lookup:** [`docs/quick-reference.md`](docs/quick-reference.md)
- **Public API:** [`docs/public-api.md`](docs/public-api.md), [`docs/ampi-core-api.md`](docs/ampi-core-api.md)
- **Architecture:** [`docs/reference-architecture.md`](docs/reference-architecture.md)
- **Subagents:** [`docs/subagent-framework.md`](docs/subagent-framework.md)
- **Compatibility:** [`docs/extension-compatibility.md`](docs/extension-compatibility.md)
- **Contributor map:** [`INDEX.md`](INDEX.md), [`REPOMAP.md`](REPOMAP.md), [`ROADMAP.md`](ROADMAP.md)

## Development

Work on ampi from a local clone and load the working tree directly:

```bash
git clone https://github.com/5omeOtherGuy/ampi
cd ampi
npm install
pi -e "$PWD" --ampi-mode medium  # run the local checkout
```

Checks:

```bash
npm test
npm run lint
npm run check
npm run pack:dry-run
pi -e "$PWD" --list-models
```

Tests are deterministic and must not make live provider/API calls. Documentation conventions: [`docs/documentation-style-guide.md`](docs/documentation-style-guide.md).

## License

[MIT](LICENSE).
