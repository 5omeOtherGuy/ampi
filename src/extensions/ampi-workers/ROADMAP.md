# ampi-workers roadmap

This roadmap covers the `ampi-workers` extension: worker/subagent tools
backed by isolated Pi runs. Cross-cutting concerns live in the top-level
[`../../../ROADMAP.md`](../../../ROADMAP.md). For the current shell-slice
behavior, invariants, and public API see [`README.md`](README.md).

Sibling extension roadmaps:

- [`../ampi-core/ROADMAP.md`](../ampi-core/ROADMAP.md)
- [`../ampi-toolbox/ROADMAP.md`](../ampi-toolbox/ROADMAP.md)
- [`../ampi-web/ROADMAP.md`](../ampi-web/ROADMAP.md)
- [`../ampi-github/README.md`](../ampi-github/README.md)

## Owned logical tools

- `Task` — bounded multi-step worker for implementation or focused
  investigation.
- `finder` — read-only worker for repository search.
- `oracle` — advisory worker that reads files and external context.
- `librarian` — read-only GitHub repository research worker; non-GitHub
  repository-provider variants are deferred.

## Current status

Shell and GitHub-backed worker slices shipped:

- ✅ Extension shell, package metadata, and package/root exports
  implemented.
- ✅ `ampi-workers` registers a tool provider that returns each owned
  logical name (`Task`, `finder`, `oracle`, `librarian`); `finder`,
  `oracle`, and `Task` resolve through `{ kind: "active" }`
  and are reported as **active** in modes that request them (`smart`,
  `fable`, `rush`, `deep`); `librarian` resolves active only
  while the required read-only GitHub tools are registered by `ampi-github`
  and source-owned, otherwise it is provider-attributed `gated` behind the
  `ampi-workers` feature gate with the per-tool `ampi-github` prerequisite reason.
- ✅ `ampi-workers` registers a feature-gate provider that reports the
  `ampi-workers` gate as **enabled** with the active capability list
  (currently `finder, oracle, Task`, plus `librarian` when the required
  `ampi-github` tools are active and source-owned).
- ✅ `/ampi-status` credits `ampi-workers` for those decisions instead of
  falling through to `ampi-core`'s reserved-gate fallback or to the
  default deferred rule.
- ✅ Cache-isolated extension registration is covered by tests so that the
  registration is visible under Pi loaders that give each extension
  entrypoint an isolated module cache.

Finder slice shipped:

- ✅ Internal worker runner primitive (`runMmrSubagentWorker`,
  `buildMmrWorkerArgs`, `resolveMmrWorkerPiInvocation`) spawns an
  isolated `pi --mode json -p --no-session` subprocess, streams
  `message_end` / `tool_result_end` events, aggregates usage,
  propagates abort via SIGTERM → SIGKILL, and bounds visible final
  output by UTF-8 byte length.
- ✅ `finder` Pi tool: parameters `{ query: string }`
  (`additionalProperties: false`), `--tools grep,find,read` allowlist,
  worker model preference `antigravity/gemini-3.5-flash` →
  `openai-codex/gpt-5.4-mini` → `claude-subscription/claude-haiku-4-5`,
  LOW thinking, returns a
  short summary plus file/line evidence, exposes typed `FinderDetails`,
  surfaces partial output and a placeholder status during execution,
  recorded as ampi-owned so Free mode strips it like other ampi tools.
- ✅ Runner activates the `finder` subagent profile via
  `--ampi-subagent finder` so the child Pi process applies the
  profile-resolved model, thinking, and tool allowlist verbatim and
  fails closed on any mismatch before mutation.
- ✅ Runner detects the `ampi: subagent activation failed: <reason>`
  marker on the child's stderr and converts it into an unmissable
  failure (`MmrWorkerResult.subagentActivationError`,
  `errorMessage: "subagent activation failed: <reason>"`,
  `FinderDetails.subagentActivationError`, finder visible content)
  even when Pi itself exits 0.
- ✅ Effective-surface fixture `smart.core+subagents.md` snapshots the
  model-facing prompt and active-tools manifest with `finder`
  registered.
- ✅ Live smoke `tests/smoke/finder-live-smoke.mjs` runs a real Pi
  worker through the finder tool against the current repository;
  production-faithful by default with opt-in dev-loop isolation via
  `FINDER_SMOKE_EXTENSION_PATHS`.

Dependencies satisfied:

- `ampi-core` mode state, worker model resolver (`selectMmrModelRoute`),
  tool registry (`registerMmrToolProvider`), feature gates
  (`registerMmrFeatureGateProvider`).
- `ampi-core` prompt/tool assembly is now stable (see
  [`../ampi-core/ROADMAP.md`](../ampi-core/ROADMAP.md) Milestone 6); worker
  tool metadata can target the active prompt assembly and manifest
  contracts.
- `ampi-core` subagent execution route (`--ampi-subagent <name>`,
  `getMmrSubagentProfile`, `resolveMmrSubagentInvocation`,
  `MMR_SUBAGENT_ACTIVATION_FAILURE_STDERR_PREFIX`,
  `extractMmrSubagentActivationFailure`, `extractExplicitWorkerCliFlags`,
  `getMmrSubagentState`) provides the non-locked profile-driven
  activation lifecycle that every concrete worker uses.

Framework-only surfaces now available:

- `custom-loader.ts` can discover Markdown-defined custom subagents and
  return parsed `sa__*` definitions without auto-registering them.
- `ampi-core/subagent-runner-contract.ts` defines progress/permission
  contracts and a fail-closed in-process runner placeholder for the future
  host nested-run seam.

Concrete worker tools registered: `finder`, `oracle`, `Task`, and
`librarian`.

## Recommended next implementation slice

1. ✅ Wait for the prompt/tool assembly work in `ampi-core` to settle so
   that the runner/tool metadata targets the active contracts rather than
   the older prompt path. **(Satisfied: Milestone 6 complete; Phases G/H
   explicitly deferred.)**
2. ✅ Build a minimal worker runner around Pi subprocess JSON mode with
   isolated context, bounded model-visible output, progress updates,
   usage/error details, and abort propagation. Use the existing Pi
   subagent example as the implementation pattern, but keep the public
   tool names and diagnostics `ampi`-owned. **(Satisfied: shipped as
   `runMmrSubagentWorker`; profile activation is required at the type level.)**
3. ✅ Implement `finder` first as the low-risk read-only worker. Its
   schema is `{ query: string }`; its worker tool set should stay limited
   to search/read capabilities; its result should return compact file/line
   evidence rather than a transcript. **(Satisfied: `finder` shipped and
   executed through the `finder` subagent profile in `ampi-core`.)**
4. ✅ Implement `oracle` as an advisory worker with schema
   `{ task: string; context?: string; files?: string[] }`, worker-model
   resolution, and gated history-backed context until `ampi-history` exists.
   **(Satisfied: `oracle` shipped and routes through the `oracle` profile.)**
5. ✅ Implement `Task` as a bounded mode-derived worker with schema
   `{ prompt: string; description: string }` for implementation,
   verification, or focused investigation. **(Satisfied: `Task` shipped;
   durable task-list coordination remains a separate future decision.)**
6. ✅ Keep `librarian` honest: active only when its read-only GitHub
   repository tools are registered by `ampi-github` and source-owned;
   otherwise gated with a clear diagnostic. **(Satisfied: `librarian`
   uses the `ampi-github` provider; non-GitHub repository providers remain
   deferred.)**

## Acceptance criteria for the next concrete-tool slice

- `finder`, `oracle`, `Task`, and `librarian` have deterministic unit tests
  for schema validation, route-selection failure, subprocess failure,
  cancellation, output truncation, and tool-provider resolution.
- Concrete worker tool metadata participates in the active prompt/tool
  assembly manifests once the tool is active and remains absent while
  gated (verified by the existing negative-injection invariant).
- `Task` remains bounded to explicit worker prompts; parent agents remain
  responsible for reviewing diffs and combined validation.
- `librarian` remains honest: active only with source-owned `ampi-github`
  prerequisites or future repository-provider support; otherwise gated/deferred
  with a clear diagnostic.
- No subagent state is written inside the workspace. Any durable state
  follows [`../../../docs/data-storage-conventions.md`](../../../docs/data-storage-conventions.md).

## Invariants (must not be relaxed without explicit approval)

These hold across every slice of `ampi-workers`:

- The tool provider only ever claims logical names in
  `MMR_SUBAGENTS_OWNED_TOOLS`; it returns `undefined` for everything else
  so unrelated providers (`ampi-core`, `ampi-web`, `ampi-github`, `ampi-toolbox`,
  user aliases) are never shadowed.
- The feature-gate provider only ever claims the `ampi-workers` gate; it
  returns `undefined` for everything else.
- Each entrypoint registers its absolute path through
  `registerMmrOwnedExtensionPath(...)` so `ampi-core` Free mode can match
  Pi's `sourceInfo.path` and drop worker tools without dropping
  same-named tools registered by third-party extensions.
