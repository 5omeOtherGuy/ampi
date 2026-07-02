# ampi documentation

Use this page as the user-facing map for `ampi`: AMP Code but in Pi Agent. The root [`README.md`](../README.md) explains the product posture, implemented parity, first-run flow, and roadmap; this page points to the right reference after that.

## Start here

| Need | Read |
| --- | --- |
| Understand the AMP Code parity posture | [`../README.md`](../README.md) |
| Learn the core commands and tools | [`quick-reference.md`](quick-reference.md) |
| Install and verify the package | [`../README.md#quick-start`](../README.md#quick-start) |
| Pick the right mode | [`../README.md#modes`](../README.md#modes) |
| Pick the right tool or subagent | [`../README.md#tools-and-subagents`](../README.md#tools-and-subagents) |
| Diagnose model/tool resolution | [`troubleshooting.md`](troubleshooting.md) |

## User guides by job

| I want to... | Start with | Then read |
| --- | --- | --- |
| Switch the whole AMP-style harness for a task | [`quick-reference.md#modes`](quick-reference.md#modes) | [`../src/extensions/mmr-core/README.md`](../src/extensions/mmr-core/README.md) |
| Patch files safely | [`quick-reference.md#patch`](quick-reference.md#patch) | [`../src/extensions/mmr-patch/README.md`](../src/extensions/mmr-patch/README.md) |
| Track session todos | [`quick-reference.md#tasks`](quick-reference.md#tasks) | [`../src/extensions/mmr-tasks/README.md`](../src/extensions/mmr-tasks/README.md) |
| Delegate bounded work, searches, or reviews | [`quick-reference.md#workers`](quick-reference.md#workers) | [`../src/extensions/mmr-workers/README.md`](../src/extensions/mmr-workers/README.md) |
| Import custom Markdown subagents | [`../README.md#tools-and-subagents`](../README.md#tools-and-subagents) | [`../src/extensions/mmr-custom-subagents/README.md`](../src/extensions/mmr-custom-subagents/README.md) |
| Search the web or read a public page | [`quick-reference.md#optional-reach`](quick-reference.md#optional-reach) | [`../src/extensions/mmr-web/README.md`](../src/extensions/mmr-web/README.md) |
| Research a GitHub repository | [`quick-reference.md#optional-reach`](quick-reference.md#optional-reach) | [`../src/extensions/mmr-github/README.md`](../src/extensions/mmr-github/README.md) |
| Reuse a prior Pi session | [`quick-reference.md#optional-reach`](quick-reference.md#optional-reach) | [`../src/extensions/mmr-history/README.md`](../src/extensions/mmr-history/README.md) |
| Understand quota/capacity fallback | [`../README.md#feature-map`](../README.md#feature-map) | [`../src/extensions/mmr-session-fallback/README.md`](../src/extensions/mmr-session-fallback/README.md) |

## Extension reference

The public product name is `ampi`. Preferred package subpaths use `ampi/extensions/ampi-*`; the older `ampi/extensions/mmr-*` subpaths, `/mmr-*` commands, `MMR_*` environment variables, and `mmr*` settings keys remain supported compatibility identifiers.

| ampi family | Runtime id | Purpose | Default |
| --- | --- | --- | --- |
| `ampi-core` | `mmr-core` | Locked modes, model resolution, prompt rewrite, diagnostics, config flow | On |
| `ampi-patch` | `mmr-patch` | `apply_patch` | On |
| `ampi-tasks` | `mmr-tasks` | `task_list` | On |
| `ampi-workers` | `mmr-workers` | `finder`, `oracle`, `Task`, `reviewer`, gated `librarian`, background fleets | On (`librarian` gated) |
| `ampi-custom-subagents` | `mmr-custom-subagents` | Markdown `sa__*` workers | On |
| `ampi-session-fallback` | `mmr-session-fallback` | Subscription quota/rate-limit/capacity fallback | On |
| `ampi-web` | `mmr-web` | `web_search`, `read_web_page` | Off |
| `ampi-history` | `mmr-history` | `find_session`, `read_session` | Off |
| `ampi-github` | `mmr-github` | Read-only GitHub repository tools | Off |

## Reference docs

| Topic | Read |
| --- | --- |
| Public package API | [`public-api.md`](public-api.md) |
| Core public API | [`mmr-core-api.md`](mmr-core-api.md) |
| Reference architecture | [`reference-architecture.md`](reference-architecture.md) |
| Extension compatibility | [`extension-compatibility.md`](extension-compatibility.md) |
| Subagent framework | [`subagent-framework.md`](subagent-framework.md) |
| Data storage conventions | [`data-storage-conventions.md`](data-storage-conventions.md) |
| Prompt provenance | [`prompt-provenance.md`](prompt-provenance.md) |
| Documentation style | [`documentation-style-guide.md`](documentation-style-guide.md) |

## Contributor navigation

- [`../INDEX.md`](../INDEX.md) — quick repository index.
- [`../REPOMAP.md`](../REPOMAP.md) — source ownership map.
- [`../ROADMAP.md`](../ROADMAP.md) — release and extension roadmap.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — contribution workflow.
- [`../tests/README.md`](../tests/README.md) — test-suite overview.
