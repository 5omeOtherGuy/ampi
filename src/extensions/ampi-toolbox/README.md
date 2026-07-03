# ampi-toolbox (deprecated compatibility shim)

**Deprecated.** `ampi-toolbox` was split into two extensions:

- [`ampi-patch`](../ampi-patch/README.md) owns `apply_patch`.
- [`ampi-tasks`](../ampi-tasks/README.md) owns the session-local `task_list`
  (todo) tool, the `/tasks` slash command, and the pinned task-list widget.

This directory now contains only a compatibility shim
([`index.ts`](index.ts)) that re-exports the former public
`./extensions/ampi-toolbox` surface from the new owners. It is **not
registered** in `package.json` `pi.extensions` and registers no tools itself;
the `ampi-patch` and `ampi-tasks` entrypoints do that.

Package overview: [`../../../README.md`](../../../README.md). Public API:
[`../../../docs/public-api.md`](../../../docs/public-api.md).

## Migration

| Former toolbox surface | New home |
| --- | --- |
| `apply_patch` tool, `APPLY_PATCH_*` exports | `@earendil-works/ampi/extensions/ampi-patch` |
| `task_list` tool, todo-state persistence, `/tasks`, widget | `@earendil-works/ampi/extensions/ampi-tasks` |
| `registerMmrToolboxProviders(...)` | `registerAmpiPatchProviders(...)` + `registerAmpiTasksProviders(...)` |

The legacy import subpath `./extensions/mmr-toolbox` and the canonical
`./extensions/ampi-toolbox` both resolve to this shim so existing callers keep
working; new code should import from `ampi-patch` / `ampi-tasks` (or the
package root barrel) directly.

## Persistence note

The pre-split toolbox persisted todo state as `mmr-toolbox.todo-state`
session-log entries. The active `ampi-tasks` implementation writes
`ampi-tasks.todo-state` and reads the `mmr-tasks.todo-state` legacy type; see
[`../ampi-tasks/README.md`](../ampi-tasks/README.md) for the current
persistence contract.
