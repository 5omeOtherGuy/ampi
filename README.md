# ampi

A locked, mode-based coding harness for Pi Agent with deterministic multi-model routing across your providers.

Status: released. Published on npm as `@skippermissions/ampi` with SemVer versions; while ampi is `0.x`, a minor release may contain breaking changes, listed in [`CHANGELOG.md`](CHANGELOG.md).

[![CI](https://github.com/5omeOtherGuy/ampi/actions/workflows/ci.yml/badge.svg)](https://github.com/5omeOtherGuy/ampi/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@skippermissions/ampi)](https://www.npmjs.com/package/@skippermissions/ampi)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

`ampi` is a Pi Agent extension package. It replaces Pi's default coding posture with a small set of **locked modes** — each a complete bundle of model preferences, thinking policy, tool allowlist, and prompt — and picks which provider and model actually serves each mode by walking an ordered preference list against the models your Pi install has registered. Routing is **rule-based and inspectable**: there is no prompt classifier and no silent model switching. It runs entirely on your own Pi install, subscriptions, API keys, and settings.

The npm package name is `@skippermissions/ampi`; `ampi` is the name you see in commands, modes, flags, and settings. (The project's internal id is `mmr`, the "multi-model router", which still appears as an accepted alias.)

## Highlights

- **Deterministic, mode-based routing.** You pick an intent (a mode); ampi resolves a concrete provider/model route from that mode's ordered preference list. Mode selection and route resolution are pure rules — same inputs, same route — and every decision is visible in `/ampi-status debug`.
- **Auth-probing route resolution.** For each preferred model, ampi enumerates the provider routes that could serve it, probes each for registration and configured auth (`hasConfiguredAuth` / OAuth checks), and applies the first route that is registered, authenticated, and accepted by Pi. Skipped routes keep a recorded reason ("not registered", "registered but not authenticated", and so on).
- **Subscription-first ordering.** Routes are grouped subscription/OAuth providers first, then API-key providers, then everything else, and ordered within each group by a fixed provider priority — so a Claude or Codex subscription is preferred over a metered API key for the same model, without you wiring it up per mode.
- **Quota-aware session fallback.** When the active route fails at the end of a turn, ampi classifies the error per provider — usage limit, rate limit, overload, silent capacity stall, or hard quota — and distinguishes transient conditions (retryable, may self-heal) from hard ones. When it warrants, it surfaces an explicit fallback prompt instead of quietly changing your model.
- **Subagents and background fleets.** Built-in workers (`finder`, `oracle`, `librarian`, `Task`, `reviewer`) run as separate Pi subprocesses with their own resolved routes; work can be launched in the background with a live TUI task board and `task_poll` / `task_wait` / `task_cancel` controls. Custom Markdown subagents (`sa__*`) can be imported with scoped tools and models.
- **Opt-in reach.** Web search/page reading, read-only GitHub tools, and prior-session recall are separate extensions, off by default, and gated behind explicit environment flags.

## Install

ampi is a Pi extension, not a standalone CLI. It needs Pi 1.3 or later, installed and signed in to at least one provider (see [Compatibility](#compatibility)).

```bash
pi install npm:@skippermissions/ampi          # install for your user (recommended)
pi install -l npm:@skippermissions/ampi       # install for one project (.pi/settings.json)
pi -e npm:@skippermissions/ampi --ampi-mode medium  # try once without installing
```

Keep it current:

```bash
pi update --extensions                # update all Pi packages
pi update npm:@skippermissions/ampi   # update just ampi
```

Prefer git, or want an unreleased commit? Use the git source (pin with `@<ref>`):

```bash
pi install git:github.com/5omeOtherGuy/ampi
```

## First minutes

```bash
pi -e npm:@skippermissions/ampi --ampi-mode medium
```

Then, inside Pi:

```text
/ampi-status         # the resolved harness: mode, model, active tools
/ampi-status debug   # per-route diagnostics — which routes were tried, chosen, or skipped and why
/mode low            # quick, focused turns
/mode high           # demanding implementation, debugging, and review
/mode ultra          # maximum supported reasoning effort
/mode free           # stock Pi behavior; ampi-owned tools removed
```

Delegate bounded work to subagents:

```text
Use finder to locate where provider model preferences are resolved.
Ask oracle to review the mode activation design.
Use Task to update the focused docs file and run the narrow check.
Use reviewer to review all uncommitted changes.
```

Enable optional reach only when you want it:

```bash
export AMPI_WEB_ENABLE=true
export AMPI_GITHUB_ENABLE=true
export AMPI_HISTORY_ENABLE=true
```

Control surface: `/ampi-*` commands, `--ampi-*` flags, `AMPI_*` env vars, and `ampi*` settings. The legacy `mmr` spellings (`/mmr-*`, `--mmr-*`, `MMR_*`, `mmr*`) remain accepted as aliases.

## Modes

Each mode is a complete, locked harness. Switching modes swaps the model preference order, thinking policy, context profile, tool allowlist, and prompt together.

| Mode | Model preference order | Optimized for |
| --- | --- | --- |
| `low` | `gpt-5.6-terra` → `gpt-5.5` | Quick, focused work with medium reasoning and the Smart prompt posture |
| `medium` | `gpt-5.6-sol` → `claude-opus-4-8` | Balanced default coding with medium reasoning and a 300k context safety profile |
| `high` | `gpt-5.6-sol` → `claude-opus-4-8` | Demanding work with extra-high reasoning and the Deep prompt posture |
| `ultra` | `gpt-5.6-sol` → `gpt-5.5` | Maximum effort with Pi's `xhigh` reasoning and the Deep prompt posture |
| `free` | native Pi controls | Releases ampi model/thinking/prompt/tool enforcement |

Mode selection precedence: `--ampi-mode` flag → restored session state → `ampiCore.defaultMode` setting → `medium`. Legacy `rush`, `smart`, `deep`, and `fable` values are accepted and migrate to `low`, `medium`, `high`, and `ultra`, respectively.

Model IDs above are the shipped defaults; you can override the preference list per mode and per subagent in settings.

Interactive controls:

```text
/mode                # show current mode
/mode high           # switch mode
Ctrl+Shift+S         # mode picker (Alt+M fallback)
Ctrl+S               # cycle low → medium → high → ultra (Ctrl+Space: deprecated alias)
Alt+D                # toggle the active mode's thinking preset where supported
```

## Providers

ampi routes against whatever providers your Pi install registers. The built-in priority order groups them so subscriptions win first:

- **Subscription / OAuth:** `claude-subscription`, `openai-codex`, `github-copilot`
- **API key:** `anthropic`, `openai`, `azure`
- **Other registered providers:** `google`, `google-vertex`, `openrouter`, `vercel-ai-gateway`

A registered provider outside this list still routes; it just sorts into the last group. Model-ID aliases (for example a bare ID and its date-suffixed publication ID) are resolved so a preference written either way still matches.

## How routing and fallback work

**Resolving a route.** For the active mode, ampi reads the ordered model preference list. For each preferred model it builds the candidate provider routes (the model's default providers plus any registered provider that offers it), sorts them subscription-first then by provider priority, and probes each for registration and configured auth. The first route that is registered, authenticated, and accepted by Pi becomes the active model. If earlier routes were skipped, the reason is recorded and shown in `/ampi-status debug`; worker tools use the same resolver to pick a route without disturbing the session's active model.

**Falling back mid-session.** The `ampi-session-fallback` extension watches for provider errors at the end of a turn and classifies them by provider and message: hard usage/quota limits, rate limits, overloads, and Anthropic silent-capacity stalls, separating transient conditions (which may self-heal, so the prompt is deferred) from hard ones (which escalate immediately). When a condition warrants it, ampi offers an explicit fallback rather than mutating your route silently.

## Extensions

The package ships as a set of Pi extensions; the network and history ones are off until you enable them.

| Extension | Default | What it adds |
| --- | --- | --- |
| `ampi-core` | On | Locked modes, route resolution, thinking/context policy, prompt rewrite, diagnostics, config flow |
| `ampi-session-fallback` | On | Quota/rate-limit/overload classification and explicit fallback |
| `ampi-patch` | On | Path-safe `apply_patch` editing |
| `ampi-tasks` | On | Session-local `task_list` planning widget |
| `ampi-workers` | On | `finder`, `oracle`, `Task`, `reviewer`, gated `librarian`, background fleets |
| `ampi-custom-subagents` | On | Markdown `sa__*` workers with scoped tools/models/thinking |
| `ampi-tui` | On | Terminal look for interactive sessions; removes the footer (`ampiTui.enabled: false` restores it) |
| `ampi-web` | Off | Opt-in web search/page reading (SearXNG, Brave, DuckDuckGo fallback) with SSRF protection |
| `ampi-github` | Off | Opt-in read-only GitHub tools and the `librarian` prerequisite |
| `ampi-history` | Off | Opt-in local Pi session search and reuse behind opaque refs |

## Configuration

Non-secret settings live in Pi settings files (`~/.pi/agent/settings.json`, `<project>/.pi/settings.json`); secrets go in environment variables. Restart Pi after changing settings or gating env vars.

```json
{
  "ampiCore": {
    "defaultMode": "low",
    "modelPreferences": {
      "high": [{ "model": "gpt-5.5", "thinkingLevel": "medium" }]
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

Some safety defaults worth knowing: locked modes are fail-closed (no usable model or an empty tool set aborts activation before any change); `free` mode removes only ampi-owned tools; GitHub and search keys are read from the environment, not settings files; `read_web_page` rejects localhost and private/link-local targets; and history hides raw session paths behind opaque refs, with content redaction available via `AMPI_HISTORY_REDACT=true`.

## Compatibility

- **Pi:** 1.3 or later within 1.x. The Pi packages (`@earendil-works/pi-coding-agent`, `pi-agent-core`, `pi-tui`) are `^1.3.0` peer dependencies. Pi 0.x is not supported; stay on ampi 0.3.x for it.
- **Node.js:** 22.19 or later (`engines.node`). CI runs the gate on Node.js 22.x and 24.x.
- **Platforms:** CI runs on Linux. macOS and Windows are not tested.
- **Last verified:** 2026-10-17, with Pi 1.3.0 and Node.js 24.22.0 (`npm run gate` and loading the package with `pi -e`).

Tests are deterministic and make no live provider calls, so the suite does not exercise real network behavior. Default model IDs track current releases and change between versions.

## Documentation

- **Docs index:** [`docs/README.md`](docs/README.md)
- **Quick lookup:** [`docs/quick-reference.md`](docs/quick-reference.md)
- **Public API:** [`docs/public-api.md`](docs/public-api.md), [`docs/ampi-core-api.md`](docs/ampi-core-api.md)
- **Architecture:** [`docs/reference-architecture.md`](docs/reference-architecture.md)
- **Subagents:** [`docs/subagent-framework.md`](docs/subagent-framework.md)
- **Contributor map:** [`INDEX.md`](INDEX.md), [`REPOMAP.md`](REPOMAP.md), [`ROADMAP.md`](ROADMAP.md)

## Development

```bash
git clone https://github.com/5omeOtherGuy/ampi
cd ampi
npm ci
pi -e "$PWD" --ampi-mode medium  # run the local checkout
```

`npm run gate` runs everything a change must pass (lint, tests, type check, package dry run); CI runs the same command. Run one test file with `npm run test:one -- tests/<file>.test.mjs`. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the workflow.

## Contributing, support, and security

- Contributions: [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
- Bugs and feature requests: [GitHub issues](https://github.com/5omeOtherGuy/ampi/issues).
- Vulnerabilities: report privately as described in [`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE).
