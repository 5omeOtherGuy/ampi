# mmr-toolbox roadmap

This roadmap covers the `mmr-toolbox` extension: local utility tools that
are not subagents, history, web, MCP, or provider payload work. Cross-cutting
concerns live in the top-level [`../../../ROADMAP.md`](../../../ROADMAP.md).
For the extension's API and design pattern see
[`README.md`](README.md).

Sibling extension roadmaps:

- [`../mmr-core/ROADMAP.md`](../mmr-core/ROADMAP.md)
- [`../mmr-web/ROADMAP.md`](../mmr-web/ROADMAP.md)
- [`../mmr-subagents/ROADMAP.md`](../mmr-subagents/ROADMAP.md)

## Current status

Shipped tools:

- ✅ `apply_patch` — real custom Pi tool with a structured `{ patchText }`
  envelope (`*** Begin Patch` / `*** Add|Delete|Update File:` / `*** Move
  to:` / `@@` hunks matched by context). Repeated ops on the same file
  compose against an in-memory virtual state. Absolute paths inside
  `ctx.cwd` *or* inside any sibling worktree of the same git repository
  (discovered via `git worktree list --porcelain`) are accepted; everything
  else is rejected. The entire read-validate-write window is held under
  Pi's per-file mutation queue keyed by canonical realpath. Ambiguous body
  matches are rejected rather than first-match-wins.
- ✅ `task_list` — session-local todo with strict `{ tasks: [{ content,
  activeForm, status, subtasks? }] }` whole-list replacement, persisted as
  `mmr-toolbox.todo-state` `CustomEntry` records on the current Pi session
  log. Active todos survive compaction via a bounded current-state block in
  each turn's system prompt and a refreshed pinned widget after
  `session_compact`. Persisted state writes version 2 while continuing to
  read existing flat version 1 state.
- ✅ MMR tool provider mapping logical `apply_patch` and `task_list` to the
  concrete toolbox tools; `mmr-core` prefers exact concrete tools over
  fallbacks when Pi exposes them.
- ✅ Persistent task-list widget registered via Pi widget API.

Dependencies satisfied:

- `mmr-core` tool registry, feature gates, and local safety/file mutation
  policy.

## Deferred capabilities

Tracked in `mmr-core/tool-registry.ts` as `deferred → reason: "mmr-toolbox"`:

- `chart` — chart rendering. No first-slice plan yet.

IDE/LSP diagnostics are not modeled as a `mmr-toolbox` tool; they belong to
user-configured MCP/IDE integrations under their own tool names.

## Acceptance criteria for any new toolbox tool

- Follows the design pattern documented in [`README.md`](README.md): a
  concrete Pi tool with description, prompt guidelines, parameter schema,
  and prompt snippet (where applicable), plus a logical-name registration
  in the MMR tool provider.
- Carries deterministic tests for schema validation, success path, error
  paths, and the active-manifest entry it produces.
- Participates in the prompt/tool assembly negative-injection invariant
  while deferred and in the active-manifest invariants once active.
- Documents any persistence under
  [`../../../docs/data-storage-conventions.md`](../../../docs/data-storage-conventions.md).

## Archived task-list coordination prototype

The active `mmr-toolbox` `task_list` tool is a session-local todo list
(strict `{ tasks: [{ content, activeForm, status, subtasks? }] }` whole-list
replacement, persisted as `mmr-toolbox.todo-state` `CustomEntry` records on
the current Pi session). It is intentionally not workspace-scoped and does
not coordinate across sessions.

The previous implementation included a richer workspace-scoped coordination
prototype: dependencies, parent/child structure, repo filtering, actor
provenance, claim/release leases, cross-process mutation locking,
`/tasks pick`, `/tasks release`, and cross-session widget refresh.

That functionality is parked, not discarded. A frozen snapshot lives at
`archive/task-list-coordination-prototype-v1` (annotated tag). The on-disk
files written by previous versions remain under
`<getAgentDir()>/data/pi-mmr/task-list/` and are not deleted or migrated by
the new code; recover them by checking out the archive ref if needed.

When `mmr-subagents` implements the `Task` tool, revisit the archive and
selectively reintroduce useful pieces where they fit the Task-agent design:
worker identity, dependency readiness, atomic assignment, abandoned-worker
recovery, repo scoping, or handoff integration.

Any shared coordination state should be explicitly scoped to Task-agent or
team workflows and must not automatically surface in unrelated user
sessions.
