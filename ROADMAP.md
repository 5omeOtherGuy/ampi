# ampi roadmap

ampi is AMP Code but in Pi Agent. The package goal is a faithful, production-ready, self-contained AMP Code-style harness for the implemented Pi workflows, running on the user's own subscriptions, API keys, models, settings, and optional network/history gates. ampi is independent, not an official AMP Code package, and remaining parity gaps are tracked below.

This roadmap tracks package-level direction. Each shipped extension family owns detailed milestones in its own `ROADMAP.md` file.

## Current baseline

ampi ships as one installable Pi package with strong defaults and opt-in optional reach:

| ampi family | Runtime id | Status | Surface |
| --- | --- | --- | --- |
| `ampi-core` | `mmr-core` | Shipped, default on | Locked modes, model resolution, request/thinking policy, active tools, feature gates, prompt assembly, diagnostics |
| `ampi-patch` | `mmr-patch` | Shipped, default on | Safe `apply_patch` |
| `ampi-tasks` | `mmr-tasks` | Shipped, default on | Session-local `task_list` |
| `ampi-workers` | `mmr-workers` | Shipped, default on | `finder`, `oracle`, `Task`, `reviewer`, gated `librarian`, background fleets |
| `ampi-custom-subagents` | `mmr-custom-subagents` | Shipped, default on | Markdown `sa__*` subagents with scoped tools/models/thinking |
| `ampi-session-fallback` | `mmr-session-fallback` | Shipped, default on | Explicit subscription quota/rate-limit/overload fallback |
| `ampi-web` | `mmr-web` | Shipped, default off | `web_search`, `read_web_page` via SearXNG / Brave / DuckDuckGo |
| `ampi-history` | `mmr-history` | Shipped, default off | `find_session`, `read_session` over local Pi sessions with redaction |
| `ampi-github` | `mmr-github` | Shipped, default off | Read-only GitHub files, listings, search, commits, diffs, repository discovery |

Runtime ids remain `mmr-*` while compatibility aliases and docs move to the `ampi` product name.

Routing spine owned by `ampi-core`:

```text
mode → model/thinking → active tools → prompt route → diagnostics
```

## Parity already achieved

- Whole-harness locked modes: `low`, `medium`, `high`, `ultra`, `free`.
- Provider-neutral model preference order that works with subscription and API-key providers.
- Per-mode thinking/context/tool/prompt policy.
- Status/config/debug surfaces for deterministic mode resolution.
- Safe patching, task planning, web search, web reading, GitHub repository research, prior-session recall, and quota/capacity fallback.
- Built-in subagents and background workers: `finder`, `oracle`, `Task`, `reviewer`, `librarian`, internal `history-reader`, and custom Markdown `sa__*` agents.
- Self-contained defaults: a fresh install works as a complete AMP-style Pi harness; advanced configuration is optional.

## Near-term priorities

1. **Finish the visible rebrand.** The runtime already ships `/ampi-status`, `/ampi-changelog`, and `/ampi-config` commands (legacy `/mmr-*` aliases preserved), `AMPI_*` env gates with `MMR_*` fallback (e.g. `AMPI_HISTORY_ENABLE`, `AMPI_WEB_ENABLE`), and both `./extensions/ampi-*` and `./extensions/mmr-*` API subpaths. Remaining work is documentation coverage for both old and new identifiers and first-class `./extensions/ampi-*` API docs; runtime ids stay `mmr-*`.
2. **Keep AMP parity explicit.** Keep the root README, [`docs/README.md`](docs/README.md), and [`docs/quick-reference.md`](docs/quick-reference.md) aligned with the shipped tool/subagent surface and parity gaps.
3. **Mode/fallback explainability.** Expand `/ampi-status debug` with deterministic mode/fallback event history, not prompt classification or hidden routing.
4. **Background-worker polish.** Add richer metadata to the live task board and grouped completion notifications.
5. **History and web ergonomics.** Add a session browser, smarter large-session windowing, and stored content/result IDs without weakening redaction or SSRF protections.
6. **Custom subagent hardening.** Continue tightening setup/import diagnostics, safe defaults, and fixtures for `sa__*` tools.

## Planned or deferred capabilities

### `ampi-skills`

Potential callable skill-loading extension.

Would provide:

- `skill` tool registration and routing.
- Pi skill discovery integration.
- Feature-gate and tool-provider ownership through `ampi-core`.

Status: deferred until the Pi skill surface and least-privilege behavior are stable enough for a public contract.

### `ampi-mcp`

Potential proxy-first MCP discovery and routing extension.

Would provide:

- A single controlled MCP tool surface for search/describe/connect/call/status.
- MCP resource discovery, read-only resource access, and diagnostics.
- Feature-gate and tool-provider ownership through `ampi-core`.

Status: deferred. Local tools remain in the local tool families; network/provider surfaces stay in their owning extensions.

### `ampi-provider-parity`

Potential provider-specific request behavior beyond the narrow per-mode request policy already in `ampi-core`.

Would provide:

- Broader provider-specific payload shaping.
- Provider-specific headers or retry policies when they become part of a public contract.

Status: deferred. Current mode-owned token/reasoning behavior stays minimal and deterministic.

### Worker worktree isolation

Potential child-worker isolation mode.

Would provide:

- Optional per-worker worktrees for mutating child tasks.
- Explicit parent review/apply semantics.
- No auto-commit or hidden workspace mutation.

Status: deferred until safety semantics are pinned.

## Release checklist

Before a release, run:

```bash
npm test
npm run lint
npm run check
npm run pack:dry-run
```

Add the Pi smoke test when extension loading or package metadata changes:

```bash
pi -e "$PWD" --list-models
```

Release work should also:

- Update `CHANGELOG.md` under `Unreleased` and cut a versioned section when tagging.
- Review all public text for repo-owned wording and no secrets/local-only provenance.
- Confirm `npm run pack:dry-run` contains only intended files.
- Keep package metadata, changelog, tag, and GitHub Release notes aligned.

## Public-safety checklist

Public text includes docs, code comments, test names, fixtures, snapshots, package metadata, prompt text, tool descriptions, and schema descriptions. Before publishing or broadening visibility:

- Describe behavior in `ampi` terms, with `mmr-*` only when naming existing compatibility identifiers.
- Do not include credentials, raw provider payloads, local session data, private analysis, exact local paths, or non-public provenance.
- Public AMP Code terminology and parity positioning are allowed when written in repo-owned words and grounded in implemented behavior.
- Keep model-visible prompt/tool metadata aligned with the implementation and the active tool surface.
- Keep canonical mode keys (`low`, `medium`, `high`, `ultra`, `free`) and subagent names (`finder`, `oracle`, `librarian`, `history-reader`, `task-subagent`, `Task`, `reviewer`) stable. The coordinated tier migration keeps `rush`, `smart`, `deep`, and `fable` as accepted input aliases.
