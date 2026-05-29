# pi-mmr index

Quick links for navigating the repository.

## Start here

- [`README.md`](README.md) — user-facing overview, install options, modes, settings, troubleshooting, and development commands.
- [`ROADMAP.md`](ROADMAP.md) — top-level roadmap: shipped-extension index, planned-but-not-yet-implemented extensions, capability boundaries, release plan, and pre-publication safety check.
- [`CHANGELOG.md`](CHANGELOG.md) — notable changes and release notes.
- [`REPOMAP.md`](REPOMAP.md) — repository structure and source ownership map.

## Per-extension roadmaps

- [`src/extensions/mmr-core/ROADMAP.md`](src/extensions/mmr-core/ROADMAP.md) — `mmr-core` milestones (M0–M6) plus deferred built-in-tool wrappers (Phase G) and on-demand capability discovery (Phase H).
- [`src/extensions/mmr-session-fallback/ROADMAP.md`](src/extensions/mmr-session-fallback/ROADMAP.md) — `mmr-session-fallback` shipped surface, future considerations, and acceptance criteria for new fallback behavior.
- [`src/extensions/mmr-toolbox/ROADMAP.md`](src/extensions/mmr-toolbox/ROADMAP.md) — `mmr-toolbox` shipped tools, deferred capabilities, and the archived task-list coordination prototype.
- [`src/extensions/mmr-web/ROADMAP.md`](src/extensions/mmr-web/ROADMAP.md) — `mmr-web` shipped surface, configuration reload constraint, and future considerations.
- [`src/extensions/mmr-subagents/ROADMAP.md`](src/extensions/mmr-subagents/ROADMAP.md) — `mmr-subagents` next implementation slice (`finder` → `oracle` → `Task` → `librarian`) and acceptance criteria.
- [`src/extensions/mmr-history/ROADMAP.md`](src/extensions/mmr-history/ROADMAP.md) — `mmr-history` shipped session lookup slice, privacy gates, and future handoff/indexing work.

## Architecture and contracts

- [`docs/reference-architecture.md`](docs/reference-architecture.md) — implementation-facing module boundaries and dependency direction.
- [`docs/mmr-core-api.md`](docs/mmr-core-api.md) — stable public API exported by `mmr-core` / package root.
- [`docs/public-api.md`](docs/public-api.md) — stable package-root API exported by non-core extensions.
- [`docs/data-storage-conventions.md`](docs/data-storage-conventions.md) — repo-wide convention for any extension that persists per-user data on disk (`<getAgentDir()>/data/pi-mmr/<feature>/...`).
- [`docs/prompt-provenance.md`](docs/prompt-provenance.md) — prompt-source notes and provenance boundaries.

## Extension docs

- [`src/extensions/mmr-core/README.md`](src/extensions/mmr-core/README.md) — `mmr-core` responsibilities, non-goals, diagnostics, and troubleshooting.
- [`src/extensions/mmr-session-fallback/README.md`](src/extensions/mmr-session-fallback/README.md) — `mmr-session-fallback` quota-fallback trigger, candidate selection, retry-message rewrite, and session-scoped lifecycle.
- [`src/extensions/mmr-toolbox/README.md`](src/extensions/mmr-toolbox/README.md) — `mmr-toolbox` tools, design pattern, and invariants.
- [`src/extensions/mmr-web/README.md`](src/extensions/mmr-web/README.md) — `mmr-web` tools, configuration, and safety policy.
- [`src/extensions/mmr-subagents/README.md`](src/extensions/mmr-subagents/README.md) — `mmr-subagents` shell slice, owned logical tools, feature gate, and invariants.
- [`src/extensions/mmr-history/README.md`](src/extensions/mmr-history/README.md) — `mmr-history` opt-in local session lookup, privacy gates, and worker-backed reading path.

## Source entry points

- [`package.json`](package.json) — package metadata, Pi extension registration, exports, and scripts.
- [`src/index.ts`](src/index.ts) — package-level public exports.
- [`src/extensions/mmr-core/index.ts`](src/extensions/mmr-core/index.ts) — `mmr-core` Pi extension entry point.
- [`src/extensions/mmr-session-fallback/index.ts`](src/extensions/mmr-session-fallback/index.ts) — `mmr-session-fallback` Pi extension entry point.
- [`src/extensions/mmr-toolbox/index.ts`](src/extensions/mmr-toolbox/index.ts) — `mmr-toolbox` Pi extension entry point.
- [`src/extensions/mmr-web/index.ts`](src/extensions/mmr-web/index.ts) — `mmr-web` Pi extension entry point.
- [`src/extensions/mmr-subagents/index.ts`](src/extensions/mmr-subagents/index.ts) — `mmr-subagents` Pi extension entry point.
- [`src/extensions/mmr-history/index.ts`](src/extensions/mmr-history/index.ts) — `mmr-history` Pi extension entry point.

## Tests

- [`tests/README.md`](tests/README.md) — test-suite overview.
- [`tests/`](tests/) — deterministic `node:test` suites and prompt fixtures.

## Contributor guidance

- [`AGENTS.md`](AGENTS.md) — repository-specific operating instructions for coding agents.
