# ampi-toolbox roadmap (deprecated shim)

`ampi-toolbox` is a deprecated compatibility shim; it registers no tools and
has no roadmap of its own. Its former responsibilities were split out:

- `apply_patch` → [`../ampi-patch/ROADMAP.md`](../ampi-patch/ROADMAP.md)
- `task_list` (session-local todo) → [`../ampi-tasks/ROADMAP.md`](../ampi-tasks/ROADMAP.md)

Cross-cutting concerns live in the top-level
[`../../../ROADMAP.md`](../../../ROADMAP.md). For the shim's remaining
compatibility surface see [`README.md`](README.md).

The shim is removed once external callers no longer import
`./extensions/ampi-toolbox` / legacy `./extensions/mmr-toolbox`; that removal
is tracked in the top-level roadmap, not here.

## Archived task-list coordination prototype

The pre-split toolbox `task_list` was a session-local todo list persisted as
`mmr-toolbox.todo-state` `CustomEntry` records. An earlier implementation also
included a richer workspace-scoped coordination prototype: dependencies,
parent/child structure, repo filtering, actor provenance, claim/release
leases, cross-process mutation locking, `/tasks pick`, `/tasks release`, and
cross-session widget refresh.

That functionality is parked, not discarded. A frozen snapshot lives at
`archive/task-list-coordination-prototype-v1` (annotated tag). The on-disk
files written by previous versions remain under
`<getAgentDir()>/data/ampi/task-list/` and are not deleted or migrated by the
current code; recover them by checking out the archive ref if needed.

When revisiting richer coordination for the `ampi-workers` Task agent,
selectively reintroduce useful pieces where they fit the Task-agent design:
worker identity, dependency readiness, atomic assignment, abandoned-worker
recovery, repo scoping, or handoff integration. Any shared coordination state
should be explicitly scoped to Task-agent or team workflows and must not
automatically surface in unrelated user sessions.
