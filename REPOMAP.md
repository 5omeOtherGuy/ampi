# pi-mmr repository map

`pi-mmr` is a Pi package containing modular multi-model-routing extensions. The package currently registers six extensions: `mmr-core`, `mmr-session-fallback`, `mmr-toolbox`, `mmr-web`, `mmr-subagents`, and `mmr-history`.

## Top-level files

| Path | Purpose |
| --- | --- |
| [`README.md`](README.md) | User-facing overview, install/use instructions, mode table, settings, troubleshooting, and development commands. |
| [`INDEX.md`](INDEX.md) | Quick navigation index for docs, source entry points, and tests. |
| [`CHANGELOG.md`](CHANGELOG.md) | Notable changes and release notes. |
| [`ROADMAP.md`](ROADMAP.md) | Top-level roadmap: shipped-extension index, planned-but-not-yet-implemented extensions, capability boundaries, release plan, and pre-publication safety check. Per-extension milestone plans live next to each extension's source. |
| [`REPOMAP.md`](REPOMAP.md) | This repository structure and ownership map. |
| [`package.json`](package.json) | Package metadata, Pi extension registration, export map, and npm scripts. |
| [`package-lock.json`](package-lock.json) | Locked development dependency graph. |
| [`tsconfig.json`](tsconfig.json) | TypeScript strict-mode configuration. |
| [`AGENTS.md`](AGENTS.md) | Repository-specific coding-agent instructions. |

## Package registration

`package.json` declares Pi extensions under `pi.extensions`:

```json
[
  "./src/extensions/mmr-core/index.ts",
  "./src/extensions/mmr-session-fallback/index.ts",
  "./src/extensions/mmr-toolbox/index.ts",
  "./src/extensions/mmr-web/index.ts",
  "./src/extensions/mmr-subagents/index.ts",
  "./src/extensions/mmr-history/index.ts"
]
```

Public consumers should import from the package root (`pi-mmr`) unless they are wiring a specific extension subpath declared in `exports`.

## Source tree

```text
src/
  index.ts
  extensions/
    mmr-core/
    mmr-session-fallback/
    mmr-toolbox/
    mmr-web/
    mmr-subagents/
    mmr-history/
```

### `src/index.ts`

Package-level public API. It re-exports stable types and helpers from `mmr-core` (mode metadata, model resolution, routing selection, settings loading, prompt-layer construction, persisted-state helpers, runtime snapshot/event helpers, tool/feature-gate provider APIs, policy diagnostics, session-identity primitive), from `mmr-session-fallback` (`createMmrSessionFallbackExtension`, the quota-error classifier, persisted-override helpers, and the runtime snapshot helper), from `mmr-toolbox` (`createTodoListTool`, todo-state persistence helpers, `TASK_LIST_WIDGET_ID`), from `mmr-subagents` (`createMmrSubagentsExtension`, the worker tool factories, the tool- and feature-gate-provider factories, and the `MMR_SUBAGENTS_*` constants/owned-tool list), and from `mmr-history` (`createMmrHistoryExtension`, session lookup tools, query helpers, and worker-analysis helpers).

### `src/extensions/mmr-core/`

Foundation routing extension. It owns mode consistency across model choice, thinking level, tool allowlist, prompt route, diagnostics, and persisted state.

| File | Responsibility |
| --- | --- |
| `index.ts` | Pi extension entry point; registers flags, commands, lifecycle hooks, shortcuts, status updates, mode application, native-control fallback, and request-policy hook. |
| `modes.ts` | Mode table, default mode, ordered mode keys, mode lookup, and human-readable mode list formatting. |
| `model-resolver.ts` | Provider-neutral model preference expansion, subscription-first route selection, candidate diagnostics, and model/thinking application helper. |
| `routing.ts` | Mode-source precedence and invalid source rejection for flag/session/settings/default selection. |
| `settings.ts` | Global/project settings loading, validation, warning collection, and merge behavior. |
| `tool-registry.ts` | Exact-name tool provider registry plus owner-credit catalog; identity-only active resolution against Pi's live tool inventory; deferred/gated/disabled status decisions. |
| `feature-gates.ts` | Feature-gate provider registry with reserved/unknown built-in providers for future modules. |
| `runtime.ts` | Runtime singleton, mode-state snapshots, session-identity snapshots, state-change event helper, and registry-backed public functions. |
| `state.ts` | Runtime/persisted mode-state creation, serialization, schema versioning, and latest persisted-state lookup. |
| `prompt.ts` | MMR prompt-head rewrite that preserves Pi-owned prompt content outside the auto-rendered head. |
| `prompt-templates.ts` | MMR-authored per-mode prompt templates for `smart`, `smartGPT`, `rush`, `large`, and `deep`. |
| `request-policy.ts` | Per-mode `before_provider_request` payload rewrites for token/reasoning fields. |
| `diagnostics.ts` | Structured routing-policy diagnostics used by status output and activation warnings. |
| `status.ts` | Status-bar text and `/mmr-status` formatting, including optional debug output. |
| `owned-tools.ts` | Registry of MMR-owned concrete tool names used by Free-mode ownership filtering. |
| `types.ts` | Shared TypeScript contracts for modes, tools, model resolution, feature gates, state, settings, diagnostics, and session identity. |
| `README.md` | Extension-specific responsibilities, non-goals, diagnostics field reference, and troubleshooting. |
| `ROADMAP.md` | `mmr-core` milestones (M0–M6) plus deferred built-in-tool wrappers (Phase G) and on-demand capability discovery (Phase H). |

### `src/extensions/mmr-session-fallback/`

Session-scoped quota-fallback extension. When the active locked-mode
route reports a quota or rate-limit error from a subscription-backed
provider, interactively prompts the user for a fallback model and
thinking level, applies the selection through `mmr-core`'s
managed-model-update guard, persists a session-scoped override, and
rewrites Pi's error message so the current turn is retried through the
normal Pi retry loop. Strict no-op outside interactive sessions, inside
subagent workers, in `free` mode, and for non-quota error kinds.

| File | Responsibility |
| --- | --- |
| `index.ts` | Pi extension entry point; wires `session_start`, `message_end`, `model_select`, `thinking_level_select`. |
| `classifier.ts` | Provider/error-message classifier for subscription-backed quota and rate-limit errors. |
| `candidates.ts` | Authenticated-candidate enumeration and mode-preference ranking. |
| `thinking.ts` | Per-model thinking-level enumeration derived from `reasoning` and `thinkingLevelMap`. |
| `ui.ts` | Two-step interactive model/thinking picker. |
| `retry-message.ts` | `message_end` replacement payload that triggers Pi's native retry. |
| `state.ts` | Persisted-entry schema (`mmr-session-fallback.override`), parse, serialize, and lookup helpers. |
| `runtime.ts` | Process-global session→override map and prompt-in-flight guard. |
| `README.md` | Extension behavior, lifecycle, public API, and invariants. |
| `ROADMAP.md` | Shipped surface, future considerations, and acceptance criteria for new fallback behavior. |

### `src/extensions/mmr-toolbox/`

Local utility tools. Ships a real `apply_patch` and a session-local `task_list`. Chart rendering remains deferred.

| File | Responsibility |
| --- | --- |
| `index.ts` | Pi extension entry point; registers `apply_patch` and `task_list` tools, the MMR tool provider, and the persistent task-list widget. |
| `README.md` | Tool behavior, schemas, design pattern for new toolbox tools, non-goals, and invariants. |
| `ROADMAP.md` | Shipped tools, the deferred chart capability, acceptance criteria for new toolbox tools, and the archived task-list coordination prototype. |

### `src/extensions/mmr-web/`

Network-backed extension. Off by default; registers `web_search` and `read_web_page` Pi tools when opted in via `MMR_WEB_ENABLE`. `web_search` resolves pluggable SearXNG / Brave / DuckDuckGo backends (`auto` prefers that order); `read_web_page` uses the custom in-process reader with Readability + Turndown and a zero-dep fallback.

| File | Responsibility |
| --- | --- |
| `index.ts` | Pi extension entry point; registers tools, MMR tool provider, and feature-gate provider. |
| `README.md` | Tool behavior, configuration, environment variables, safety policy, and `read_web_page` objective handling. |
| `ROADMAP.md` | Shipped surface, configuration reload constraint, and future considerations. |

### `src/extensions/mmr-subagents/`

Worker/subagent extension. Owns the `Task`, `finder`, `oracle`, and `librarian` logical tool names plus the `mmr-subagents` feature gate. `finder`, `oracle`, `Task`, and the public-web MVP of `librarian` ship as concrete worker tools through the shared subagent runner; `librarian` remains gated until both mmr-web tools are registered and active.

| File | Responsibility |
| --- | --- |
| `index.ts` | Pi extension entry point; registers concrete worker tools, the owned-extension path, the tool provider, and the feature-gate provider. |
| `provider.ts` | Tool-provider and feature-gate-provider factories plus the immutable `MMR_SUBAGENTS_OWNED_TOOLS` list and constant names. |
| `finder.ts`, `oracle.ts`, `task.ts`, `librarian.ts` | Concrete worker tool definitions, runner dispatch, result mapping, and renderers. |
| `runner.ts` | Child-CLI subagent runner, progress parsing, abort handling, and output truncation. |
| `README.md` | Extension responsibilities, invariants, public API, and milestone plan link. |
| `ROADMAP.md` | Shipped worker slices, deferred repository-provider variants, acceptance criteria, and invariants. |

### `src/extensions/mmr-history/`

Opt-in global local Pi session lookup extension. Registers `find_session`
and `read_session` behind the single `MMR_HISTORY_ENABLE=true` env gate;
`read_session` runs the in-process history-reader subagent first and falls
back to deterministic lexical extraction. Every leaving string is passed
through a shared deterministic sanitizer, and each match carries an opaque
`projectRef` instead of any raw session path or project root.

| File | Responsibility |
| --- | --- |
| `index.ts` | Pi extension entry point; loads settings, registers history tools, and wires providers. |
| `tools.ts` | Pi tool definitions and default dependency wiring. |
| `session-catalog.ts`, `session-index.ts`, `query.ts` | Session listing/search, structured file/repo filter support, and query diagnostics. |
| `read-session.ts`, `analysis-worker.ts` | Lexical read extraction and optional subagent-backed analysis. |
| `README.md`, `ROADMAP.md` | Extension behavior, privacy boundaries, configuration, and next milestones. |

## Documentation tree

| Path | Purpose |
| --- | --- |
| [`docs/reference-architecture.md`](docs/reference-architecture.md) | Current implementation state, extension ownership, dependency direction, core contracts, and implementation order. |
| [`docs/mmr-core-api.md`](docs/mmr-core-api.md) | Stable core public API contract and import guidance. |
| [`docs/public-api.md`](docs/public-api.md) | Stable non-core extension public API contract and import guidance. |
| [`docs/data-storage-conventions.md`](docs/data-storage-conventions.md) | Repo-wide convention for any extension that persists per-user data on disk under `<getAgentDir()>/data/pi-mmr/<feature>/...`. |
| [`docs/prompt-provenance.md`](docs/prompt-provenance.md) | Prompt provenance boundaries and source notes. |

## Test tree

```text
tests/
  *.test.mjs
  fixtures/mmr-core-prompts/
  helpers/
  README.md
```

Tests use Node's built-in `node:test` runner and deterministic fixtures. They do not make live provider/API calls.

Major coverage areas include activation, routing precedence, model resolution, settings, runtime contracts, prompt rewriting, persisted state, feature gates, lifecycle behavior, shortcuts, Pi integration boundaries, `apply_patch` parser/behavior/path-safety, `task_list` schema and session scope, `mmr-web` URL policy/provider/runtime, `mmr-subagents` worker behavior, `mmr-history` session lookup, and `mmr-session-fallback` classifier/candidate/state/lifecycle behavior.

## Runtime ownership summary

```diagram
   ╭──────────╮     ╭──────────────╮     ╭──────────────╮
   │ /mode or │────▶│ mmr-core     │────▶│ Pi runtime   │
   │ settings │     │ resolution   │     │ model/tools  │
   ╰──────────╯     ╰──────┬───────╯     ╰──────┬───────╯
                            │                    │
                            ▼                    ▼
                    ╭──────────────╮     ╭──────────────╮
                    │ mode state & │────▶│ prompt/status│
                    │ diagnostics  │     │ integration  │
                    ╰──────────────╯     ╰──────────────╯
```

`mmr-core` is the source of truth for routing state. `mmr-toolbox` and `mmr-web` plug in through exported provider APIs rather than mutating core state directly.
