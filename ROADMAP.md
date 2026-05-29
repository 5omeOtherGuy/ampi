# pi-mmr roadmap

This is the top-level roadmap for the `pi-mmr` package. It tracks
cross-cutting concerns only:

- the shipped-extension index (with links to per-extension roadmaps),
- planned-but-not-yet-implemented extensions,
- capabilities tracked outside `mmr-core`,
- the release plan,
- the pre-publication safety check.

Each shipped extension owns the detailed plan for its own milestones,
deferred work, and acceptance criteria:

- [`src/extensions/mmr-core/ROADMAP.md`](src/extensions/mmr-core/ROADMAP.md)
- [`src/extensions/mmr-session-fallback/ROADMAP.md`](src/extensions/mmr-session-fallback/ROADMAP.md)
- [`src/extensions/mmr-toolbox/ROADMAP.md`](src/extensions/mmr-toolbox/ROADMAP.md)
- [`src/extensions/mmr-web/ROADMAP.md`](src/extensions/mmr-web/ROADMAP.md)
- [`src/extensions/mmr-subagents/ROADMAP.md`](src/extensions/mmr-subagents/ROADMAP.md)
- [`src/extensions/mmr-history/ROADMAP.md`](src/extensions/mmr-history/ROADMAP.md)

## Current baseline

`pi-mmr` ships as one installable Pi package containing six extensions:

| Extension | Status | Surface |
| --- | --- | --- |
| `mmr-core` | Implemented (M0–M6 complete) | Locked modes, model resolution, tool registry, feature gates, prompt assembly, diagnostics |
| `mmr-session-fallback` | Implemented | Interactive session-scoped fallback model + thinking-level picker on subscription-backed quota/rate-limit errors, applied through `mmr-core`'s managed-model-update guard and persisted as `mmr-session-fallback.override` entries |
| `mmr-toolbox` | Implemented | `apply_patch`, session-local `task_list`; `chart` deferred |
| `mmr-web` | Implemented (off by default) | `web_search` via pluggable SearXNG/Brave/DuckDuckGo backends, `read_web_page` via the custom reader; opt-in via `MMR_WEB_ENABLE`; no key required by default |
| `mmr-subagents` | `finder`, `oracle`, `Task`, `librarian` shipped | Shared worker runner plus read-only search, advisory, mode-derived bounded-task, and public-web repository-research workers routed through `mmr-core`'s subagent execution profiles; `librarian` remains gated until mmr-web prerequisites are active |
| `mmr-history` | Initial opt-in slice shipped | `find_session` and `read_session` gated by `MMR_HISTORY_ENABLE=true`; worker-backed read analysis gated separately |

Routing spine owned by `mmr-core`:

```text
mode → model/thinking → active tools → system prompt note
```

For mode tables, per-mode tool sets, prompt-assembly invariants, and
diagnostic contracts, see
[`src/extensions/mmr-core/ROADMAP.md`](src/extensions/mmr-core/ROADMAP.md).

## Planned-but-not-yet-implemented extensions

These extensions are scoped in the public surface (referenced by deferred
tool decisions, reserved feature gates, or capability boundaries). Planned
entries should grow their own README and ROADMAP next to their source when
work begins.

### `mmr-history`

Initial source exists under `src/extensions/mmr-history/` and ships an
opt-in global local Pi session lookup slice:

- `read_session`
- `find_session`

Still planned:

- handoff support
- richer local or remote session index design

Depends on:

- `mmr-core` mode state
- `mmr-core` allowed-tool policy
- local or remote session index design

Tracked in `mmr-core/tool-registry.ts` as `deferred → reason: "mmr-history"`
for `handoff`.

### `mmr-skills`

Implements callable skill loading:

- `skill`

Depends on:

- Pi skill discovery
- `mmr-core` tool registry
- `mmr-core` feature gates

Tracked in `mmr-core/tool-registry.ts` as `deferred → reason: "mmr-skills"`
for `skill`.

### `mmr-toolbox-mcp`

Implements MCP discovery and routing separately from local `mmr-toolbox`
utilities.

Depends on:

- `mmr-core` tool registry metadata
- `mmr-core` feature gates
- `mmr-core` diagnostics surface

Tracked in `mmr-core/tool-registry.ts` as `deferred → reason: "mmr-toolbox-mcp"`
for `read_mcp_resource`.

### `mmr-provider-parity`

Implements broader provider-specific request behavior. The narrow per-mode
token/reasoning-field rewrite already shipped in `mmr-core/request-policy.ts`
covers the minimum needed for the current modes; this extension would
absorb anything beyond that (provider-specific headers, retry policies,
broader payload shape rewrites).

Depends on:

- `mmr-core` model resolver
- `mmr-core` provider-hook design
- clear safety/privacy boundaries

### `mmr-review`

Status: deferred / out of scope for now.

`pi-mmr` does not include a `code_review` tool in mode definitions and
does not plan a core-owned review runner. Users who want review
orchestration can define their own workflow/command, or not use one at
all.

Potential user-owned review behavior (if ever revisited):

- `/review`
- check discovery
- code-review worker routing

Would depend on:

- `mmr-core` tool registry
- `mmr-core` worker model resolver
- `mmr-core` feature gates

## Capabilities tracked outside `mmr-core`

Several capabilities are intentionally not in core and live in (or will
live in) sibling extensions:

1. richer thread/message/settings mode selection
2. dynamic feature gates beyond `mmr-core.reserved` / `mmr-core.unknown`
   (shipped: `mmr-web`, `mmr-subagents`)
3. richer model fallback/downgrade behavior across modes
4. model-backed tools/subagents (`mmr-subagents`)
5. history and thread search (`mmr-history`)
6. toolbox/custom-agent/MCP discovery (`mmr-toolbox`, `mmr-toolbox-mcp`)
7. provider-specific request transformations and headers
   (`mmr-provider-parity`) beyond the narrow token/reasoning rewrite
   already in `mmr-core/request-policy.ts`
8. user-owned review/check workflow, if a user chooses to build one

`mmr-core` should prepare interfaces for these, but not absorb their
implementations.

## Release plan

The first tagged release (`0.1.0`) is gated on:

- ✅ four shipped extensions (`mmr-core`, `mmr-toolbox`, `mmr-web`,
  `mmr-subagents` with `finder` worker);
- ✅ green `npm test`, `npm run check`, `npm run pack:dry-run`;
- [ ] public-text safety check below;
- [ ] coordinated locked-mode rename (see safety check);
- [ ] release metadata decision: package version, license, and registry
  visibility;
- [ ] cut `CHANGELOG.md` `Unreleased` → `0.1.0` with the release date;
- [ ] tag `v0.1.0` and align `package.json`.

Until the rename, safety check, and release metadata decision land, do not
publish to a public registry.

## Public-release safety check

Before publishing or opening the repository broadly, complete a safety pass
against the public-text rules in `AGENTS.md`. All public text should describe
`pi-mmr` behavior only: docs, code comments, test names, fixtures,
snapshots, generated artifacts, package metadata, and model-visible prompt or
tool metadata.

### Model-visible strings

These strings are sent to the model on tool calls or system-prompt renders.
They must describe `pi-mmr` behavior only.

- [ ] `src/extensions/mmr-web/tools.ts` — `web_search` and
  `read_web_page` descriptions, parameter descriptions, and safety notes.
- [ ] `src/extensions/mmr-toolbox/index.ts` — `apply_patch`
  `promptGuidelines` and other model-visible strings.
- [ ] `src/extensions/mmr-toolbox/apply-patch.ts` — error messages and
  `ApplyPatchError` text exposed to the model.
- [ ] Prompt fixtures under `tests/fixtures/` that anchor these surfaces.

### Runtime UI labels

User-visible runtime labels must match the public-safe docs.

- [ ] `/mmr-status` field labels and debug output in
  `src/extensions/mmr-core/status.ts`.
- [ ] Activation notifications, footer text, and terminal-visible strings
  in `src/extensions/mmr-core/` and peer extensions.

### Code comments and JSDoc

Public-text rules cover code comments. Sweep comments and exported JSDoc in:

- [ ] `src/extensions/mmr-core/request-policy.ts`
- [ ] `src/extensions/mmr-core/types.ts`
- [ ] `src/extensions/mmr-toolbox/apply-patch.ts`
- [ ] `src/extensions/mmr-toolbox/index.ts`
- [ ] Any other `src/` file flagged by the final public-safety sweep.

### Tests and fixtures

Test names, `describe`/`it` strings, comments, and fixture content must use
repo-owned wording.

- [ ] `tests/mmr-core-*.test.mjs` files that assert mode, prompt, status,
  request-policy, or tool behavior.
- [ ] `tests/mmr-toolbox-*.test.mjs` files that assert apply-patch or
  task-list behavior.
- [ ] `tests/mmr-web-*.test.mjs` files and web fixtures.
- [ ] Any `tests/fixtures/` content the snapshot tests anchor against.

### Locked-mode naming

Development mode names (`smart`, `smartGPT`, `rush`, `large`, `deep`,
`free`) must be renamed before public release. Plan and execute the rename as
a single coordinated pass touching:

- [ ] `src/extensions/mmr-core/modes.ts` and `prompt-templates.ts`.
- [ ] `src/extensions/mmr-core/runtime.ts`, `state.ts`, persisted-state
  migrators.
- [ ] Package flags and the `--mmr-mode` CLI surface.
- [ ] Public API exports (`MMR_MODE_KEYS`, `DEFAULT_MMR_MODE`,
  `MmrModeKey`).
- [ ] All docs, README mode tables, per-extension ROADMAPs, top-level
  ROADMAP, CHANGELOG (`Unreleased` rename entry), and tests/snapshots.
- [ ] A persisted-state migration so existing `mmr-core.mode-state`
  entries with old keys still load or fail softly with a clear message.

### Repository hygiene

- [ ] Final public-safety sweep against tracked files returns only reviewed
  false positives.
- [ ] `npm run pack:dry-run` shows only files intended for publication.
- [ ] Confirm no commits, branch names, or tag annotations in `git log` carry
  local-only wording before pushing to a public remote.

When the checklist above is complete and
`npm test && npm run check && npm run pack:dry-run` are all green, the
repository is ready for the public-visibility flip and the `0.1.0` tag.
