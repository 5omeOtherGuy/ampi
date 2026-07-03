# ampi index

Quick links for navigating the repository.

## Start here

- [`README.md`](README.md) — user-facing overview, quick start, mode chooser, tool chooser, safety summary, and troubleshooting.
- [`docs/README.md`](docs/README.md) — documentation homepage for users and contributors.
- [`docs/quick-reference.md`](docs/quick-reference.md) — compact mode/tool/gate lookup.
- [`docs/whats-new.md`](docs/whats-new.md) — recent user- and developer-visible changes.
- [`CHANGELOG.md`](CHANGELOG.md) — notable changes and release notes.
- [`ROADMAP.md`](ROADMAP.md) — package-level roadmap and release plan.
- [`REPOMAP.md`](REPOMAP.md) — repository structure and source ownership map.

## Extension docs

- [`src/extensions/ampi-core/README.md`](src/extensions/ampi-core/README.md) — locked modes, routing, prompt assembly, diagnostics, and public API.
- [`src/extensions/ampi-session-fallback/README.md`](src/extensions/ampi-session-fallback/README.md) — quota/rate-limit fallback trigger, picker flow, persisted override, and lifecycle.
- [`src/extensions/ampi-web/README.md`](src/extensions/ampi-web/README.md) — `web_search`, `read_web_page`, backend configuration, and safety policy.
- [`src/extensions/ampi-github/README.md`](src/extensions/ampi-github/README.md) — opt-in read-only GitHub repository tools and librarian gating.
- [`src/extensions/ampi-workers/README.md`](src/extensions/ampi-workers/README.md) — `finder`, `oracle`, `Task`, `librarian`, the background task surface, worker behavior, and public API.
- [`src/extensions/ampi-history/README.md`](src/extensions/ampi-history/README.md) — opt-in local session lookup, query DSL, redaction, and worker-backed reading.

The following extensions were split out of `ampi-toolbox` / `ampi-workers`; their dedicated READMEs are pending, so use the source entry point for now:

- [`src/extensions/ampi-patch/index.ts`](src/extensions/ampi-patch/index.ts) — owns `apply_patch` (context-matched multi-file workspace edits). README pending.
- [`src/extensions/ampi-tasks/index.ts`](src/extensions/ampi-tasks/index.ts) — owns the session-local `task_list` and pinned widget. README pending.
- [`src/extensions/ampi-custom-subagents/index.ts`](src/extensions/ampi-custom-subagents/index.ts) — discovers and registers custom Markdown subagents. README pending.

Deprecated / unregistered:

- [`src/extensions/ampi-toolbox/README.md`](src/extensions/ampi-toolbox/README.md) — **deprecated** compatibility shim that re-exports `ampi-patch` and `ampi-tasks`; not registered in `pi.extensions`.
- [`src/extensions/ampi-debug/README.md`](src/extensions/ampi-debug/README.md) — developer-only prompt/tool/response capture extension; loaded with Pi's `-e` flag and excluded from the published package.

## Per-extension roadmaps

- [`src/extensions/ampi-core/ROADMAP.md`](src/extensions/ampi-core/ROADMAP.md)
- [`src/extensions/ampi-session-fallback/ROADMAP.md`](src/extensions/ampi-session-fallback/ROADMAP.md)
- [`src/extensions/ampi-web/ROADMAP.md`](src/extensions/ampi-web/ROADMAP.md)
- [`src/extensions/ampi-workers/ROADMAP.md`](src/extensions/ampi-workers/ROADMAP.md)
- [`src/extensions/ampi-history/ROADMAP.md`](src/extensions/ampi-history/ROADMAP.md)
- [`src/extensions/ampi-toolbox/ROADMAP.md`](src/extensions/ampi-toolbox/ROADMAP.md) — deprecated shim.

## Architecture and contracts

- [`docs/reference-architecture.md`](docs/reference-architecture.md) — implementation-facing module boundaries and dependency direction.
- [`docs/ampi-core-api.md`](docs/ampi-core-api.md) — stable public API exported by `ampi-core` / package root.
- [`docs/public-api.md`](docs/public-api.md) — stable package-root API exported by non-core extensions.
- [`docs/public-api-surface.md`](docs/public-api-surface.md) — generated package-root export surface reference.
- [`docs/extension-compatibility.md`](docs/extension-compatibility.md) — how `ampi` composes with other Pi extensions.
- [`docs/subagent-framework.md`](docs/subagent-framework.md) — subagent framework and worker prompt contracts.
- [`docs/data-storage-conventions.md`](docs/data-storage-conventions.md) — per-user data storage convention.
- [`docs/prompt-provenance.md`](docs/prompt-provenance.md) — prompt-source notes and provenance boundaries.
- [`docs/documentation-style-guide.md`](docs/documentation-style-guide.md) — documentation structure and wording rules.
- [`docs/troubleshooting.md`](docs/troubleshooting.md) — symptom-first troubleshooting and procedures.

## Source entry points

- [`package.json`](package.json) — package metadata, Pi extension registration, exports, and scripts.
- [`src/index.ts`](src/index.ts) — package-level public exports.
- [`src/extensions/manifest.ts`](src/extensions/manifest.ts) — single source of truth for the registered extension list.
- [`src/extensions/ampi-core/index.ts`](src/extensions/ampi-core/index.ts) — `ampi-core` Pi extension entry point.
- [`src/extensions/ampi-session-fallback/index.ts`](src/extensions/ampi-session-fallback/index.ts) — `ampi-session-fallback` Pi extension entry point.
- [`src/extensions/ampi-patch/index.ts`](src/extensions/ampi-patch/index.ts) — `ampi-patch` Pi extension entry point.
- [`src/extensions/ampi-tasks/index.ts`](src/extensions/ampi-tasks/index.ts) — `ampi-tasks` Pi extension entry point.
- [`src/extensions/ampi-web/index.ts`](src/extensions/ampi-web/index.ts) — `ampi-web` Pi extension entry point.
- [`src/extensions/ampi-github/index.ts`](src/extensions/ampi-github/index.ts) — `ampi-github` Pi extension entry point.
- [`src/extensions/ampi-workers/index.ts`](src/extensions/ampi-workers/index.ts) — `ampi-workers` Pi extension entry point (blocking workers + background task surface).
- [`src/extensions/ampi-custom-subagents/index.ts`](src/extensions/ampi-custom-subagents/index.ts) — `ampi-custom-subagents` Pi extension entry point.
- [`src/extensions/ampi-history/index.ts`](src/extensions/ampi-history/index.ts) — `ampi-history` Pi extension entry point.
- [`src/extensions/ampi-toolbox/index.ts`](src/extensions/ampi-toolbox/index.ts) — deprecated re-export shim (unregistered).
- [`src/extensions/ampi-debug/index.ts`](src/extensions/ampi-debug/index.ts) — developer-only capture extension (unregistered).

## Tests and contributor guidance

- [`tests/README.md`](tests/README.md) — test-suite overview.
- [`tests/`](tests/) — deterministic `node:test` suites and fixtures.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — human contributor workflow.
