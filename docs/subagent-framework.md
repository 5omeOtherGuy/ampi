# Subagent framework

**Audience.** Maintainers adding or changing subagents in `mmr-subagents`, or extension authors implementing the subagent contracts owned by `mmr-core`.

**Related.** Concrete subagents: [`../src/extensions/mmr-subagents/README.md`](../src/extensions/mmr-subagents/README.md). Profile/registry surface: [`mmr-core-api.md`](./mmr-core-api.md). Documentation conventions: [`documentation-style-guide.md`](./documentation-style-guide.md).

`pi-mmr` separates the subagent framework from concrete subagents.

The framework owns reusable contracts:

- subagent profile metadata (`MmrSubagentProfile`);
- prompt-surface assembly for standalone and mode-derived workers;
- custom file-defined subagent discovery (`sa__*` names);
- progress, tool-use, and permission-context types;
- a fail-closed placeholder for future in-process nested execution.

Concrete subagents own their own Pi tool registration, worker prompt text,
model policy, result mapping, and capability flags.

## Shipped concrete subagents

- `finder` researches the local workspace with read-only local tools.
- `oracle` provides advisory review with a broader read-only research surface.
- `Task` delegates bounded implementation or investigation work through a
  mode-derived worker prompt.
- `librarian` researches remote repositories with the read-only GitHub
  repository tools owned by `mmr-github` (`read_github`,
  `list_directory_github`, `glob_github`, `search_github`, `commit_search`,
  `diff_github`, `list_repositories`). It stays provider-gated until those
  tools are registered and source-owned by `mmr-github`, and reports the gate
  as `librarian: requires mmr-github read-only GitHub tools (set
  MMR_GITHUB_ENABLE=true).` The GitHub tools are registered globally but are
  not part of any user-facing mode's active set; the librarian worker
  activates them by name through its profile allowlist, so the parent gate
  checks registration + source ownership rather than parent-active state.

Additional repository-provider integrations should extend the librarian
profile/tool surface behind their own explicit capability gates rather than
broadening an existing provider's allowlist.

## Profile contract

`MmrSubagentProfile` is the framework source of truth for a worker's model
preferences, tool allowlist, prompt route, and policy flags.

Important framework fields:

- `promptRoute: "standalone" | "mode-derived"`
- `baseMode?: MmrModeKey | "from-parent"`
- `maxTurns?: number`
- `allowMcp: boolean`
- `allowToolbox: boolean`

`maxTurns` is metadata in this package today. Runtime enforcement depends on
an in-process runner seam in the host runtime, so callers must not assume the
current child-process runner enforces it.

## Prompt assembly

Standalone profiles resolve a registered prompt builder and use that builder's
output as the entire worker system prompt.

Mode-derived profiles reuse an MMR mode prompt surface, replace the inherited
`Available tools:` block with one rendered from the filtered worker manifest,
and append a worker-role block from the registered prompt builder. Profiles can
pin a concrete base mode or set `baseMode: "from-parent"`. The latter requires
callers to pass `parentMode` to `assembleMmrSubagentSurface`; missing
`parentMode` fails closed.

The active tool manifest is always filtered to the profile's tool allowlist
before it is surfaced to the worker prompt renderer.

## Custom file-defined subagents

`mmr-subagents/custom-loader.ts` provides discovery and parsing for Markdown
subagent definitions without auto-registering them at extension startup.

The loader:

- scans configured roots recursively up to depth 5 by default;
- refuses a symlinked discovery root and skips symlink entries below it;
- ignores `.git` and `node_modules`;
- caps individual Markdown files at 256 KiB and contains per-file read or
  parse failures so one bad file does not reject the entire discovery;
- reads Markdown frontmatter, including inline comma lists and simple YAML
  block lists for `tools:` / `skills:`;
- accepts files with `type: subagent` or `isolatedContext: true`;
- optionally accepts Markdown files **without** frontmatter when explicitly
  asked (the option does not override the subagent/isolatedContext gate for
  files that already declare frontmatter);
- drops prototype-polluting frontmatter keys (`__proto__`, `prototype`,
  `constructor`) and uses a null-prototype attribute bag;
- derives stable tool names as `sa__<slug>` capped at 120 characters;
- preserves `tools:` tokens verbatim after trim/dedupe. Custom subagent
  definitions must use the exact Pi tool name they want activated
  (`read`, `bash`, `edit`, `write`, `grep`, `find`, `web_search`,
  `read_web_page`, `Task`, ...). Non-canonical names simply fail to
  activate at runtime because no Pi tool with that name is registered;
- preserves `model: inherit` as a sentinel for future invocation-time routing.

The loader is framework-only in this slice: it returns parsed definitions for a
future registrar to consume, but it does not make any user-defined subagent
model-visible by itself.

## In-process runner seam

`MMR_IN_PROCESS_SUBAGENT_RUNNER_AVAILABLE` is `false` in this release.
`runMmrSubagentInProcess(...)` intentionally fails closed with
`MmrInProcessRunnerUnavailableError` until the host runtime exposes the needed
nested-run API.

The future host seam must provide:

- nested in-process runs from a fresh delegated conversation;
- filtered shared tool access enforced before inference and before execution;
- subagent metadata on tool and permission events;
- parent tool-use association for progress rendering;
- explicit user-rejection status mapping.

Until then, concrete subagents that need to run today must use the existing
child-process worker path and document that limitation.
