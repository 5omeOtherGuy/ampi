# ampi-core

Foundation locked-mode extension for `ampi`. Owns locked modes, model resolution, request policy, tool resolution, and the per-turn system-prompt rewrite.

Package overview: [`../../../README.md`](../../../README.md). Planning: [`ROADMAP.md`](ROADMAP.md). Public API: [`../../../docs/ampi-core-api.md`](../../../docs/ampi-core-api.md) (full surface) and [`../../../docs/public-api.md`](../../../docs/public-api.md) (package-root re-exports).

## At a glance

| Default | Provides | Requires | Diagnostics |
| --- | --- | --- | --- |
| On | Locked modes, model resolver, tool registry, prompt rewrite, subagent execution profile | none | `/ampi-status` (`debug` for model/tool resolution detail) |

## When to use it

- Always loaded. Other `ampi` extensions register against this one.
- Read this file for mode semantics, request policy, tool resolution, prompt assembly, the subagent profile contract, and the `/ampi-status` field reference.

## Status and enablement

Active by default. Mode resolution: `--ampi-mode` flag → restored session state → `ampiCore.defaultMode` setting → default `medium`. The selected mode is persisted as an `ampi-core.mode-state` custom session entry on every explicit change. Legacy names normalize at input boundaries: `rush` → `low`, `smart` → `medium`, `deep` → `high`, and `fable` → `ultra`.

Shortcuts: `Ctrl+Shift+S` / `Alt+M` pick any canonical mode; `Ctrl+Space` cycles `low → medium → high → ultra` while excluding `free`. Subagent execution uses a separate profile via `--ampi-subagent <name>` (see [Subagent profiles](#subagent-profiles)).

## Behavior

### Locked modes

`low`, `medium`, `high`, and `ultra` apply a locked-mode profile (model preferences, request policy, context profile, active-tool allowlist, ampi-owned prompt block). `free` releases all enforcement and restores the pre-ampi baseline.

- **Model resolution** is provider-neutral against the live Pi registry. Defaults are Low: GPT-5.6 Terra → GPT-5.5; Medium: GPT-5.6 Sol → Claude Opus 4.8; High: GPT-5.6 Sol → Claude Opus 4.8; Ultra: GPT-5.6 Sol → GPT-5.5. Subscription-backed routes (`claude-subscription`, `openai-codex`, `github-copilot`) sort first; explicit `provider/model` settings force a route.
- **Prompt bodies**: Low, High, and Ultra share the full system-prompt body; Medium uses the compact body with its own fragment ordering.
- **Pi baseline thinking** per mode: Low/Medium `medium`; High/Ultra `xhigh`. Request-level thinking is enforced separately by the per-mode request-policy hook.
- **Thinking-level toggle (`alt+r`)**: Medium cycles `medium ↔ high`; High cycles `xhigh ↔ medium`; Ultra cycles `xhigh → high → medium → xhigh`. Low is intentionally not toggleable. The toggle drives both Pi's thinking level and OpenAI Responses reasoning effort, is session-scoped, and uses a dedicated key because Pi reserves `shift+tab` (`app.thinking.cycle`).
- **Request policy** rewrites only token/reasoning fields on `before_provider_request` (`max_tokens`, `max_output_tokens`, Anthropic `thinking` / `output_config.effort`, OpenAI Responses `reasoning`). Never mutates provider identity, auth, headers, base URLs, messages, system blocks, or tools.
- **Context profiles**: Medium inherits the former Smart 300k total / 172k max-input / 128k max-output safety profile. Low, High, and Ultra use Pi's registered model window. A declared profile caps the active model's `contextWindow` down via a shallow clone at `setModel`; smaller custom windows remain authoritative, `free` is never capped, and the cap is reasserted if provider registration transiently restores the uncapped model object.
- **Fail-closed** before any Pi mutation when a locked mode would resolve zero active tools or no usable model.
- **Auto-switch to `free`** with a warning when native Pi model selection (`/model`, model-cycle) or the native thinking-cycle (`shift+tab`) is used from a locked mode. ampi does not undo the user's native change; it disables request/prompt/tool policy and restores the baseline minus `ampi`-owned tools. Use `alt+r` for the in-mode thinking toggle that does not release.

### Tool resolution

Exact-name resolution against Pi's live tool inventory through the tool-provider registry. No aliases, no candidate fallbacks. Each decision carries owner-extension metadata, a status, and human-readable diagnostic text:

| Status | Meaning |
| --- | --- |
| `active` | Registered and reachable in this mode. |
| `gated` | Owner is loaded but a prerequisite is unmet (`librarian` waits on source-owned `ampi-github` tools). |
| `disabled` | Owner is loaded but turned off or has no active capability. |
| `deferred` | Recognized name reserved in the status catalog; concrete tool not shipped. |
| `missing` | No extension claimed the name; Pi has not registered it. |

The status catalog covers `apply_patch`, `task_list`, `web_search`, `read_web_page`, `Task`, `finder`, `oracle`, `librarian`, `find_session`, `read_session`, `handoff`, `chart`, `read_mcp_resource`, `skill` so `/ampi-status` credits the owning extension when a tool is deferred. Sibling extensions claim exact names via `registerMmrToolProvider(...)`; latest-registered wins. Active-tool allowlist enforcement and `tool_call` blocking apply while locked.

### Locked-mode extra tools

Locked modes ship a fixed allowlist, so a user's own extension tools, third-party tools, or MCP tools are blocked while a locked mode is active. The `ampiCore.lockedModeExtraTools` setting opts specific exact tool names back in without releasing to `free`:

```jsonc
{
  "ampiCore": {
    "lockedModeExtraTools": {
      "all": ["my_tool", "mcp__server__search"], // every locked mode
      "high": ["high_only_tool"]                  // high only
    }
  }
}
```

- Keys: `all` plus any locked mode (`low`, `medium`, `high`, `ultra`). `free` and unknown keys are ignored with a warning; legacy mode names normalize to their canonical tier.
- Exact-name only (no aliases); names trim/dedupe; global and project settings merge additively per key.
- Extras merge into the active set *after* the base allowlist and are credited to a `user-allowlist` owner in `/ampi-status` when they resolve by plain identity.
- Fail-closed is preserved: extras never satisfy the zero-active-tools activation abort (only a mode's own tools can), and a missing extra is a non-fatal no-op surfaced as `missing`.
- Parent session only — extras never apply to subagent workers, which keep their profile allowlists.

Project `.pi/settings.json` is a trust boundary: it can re-enable exact tool names in locked modes. See [`../../../docs/extension-compatibility.md`](../../../docs/extension-compatibility.md) for the full stance on user extensions, tools, providers, and MCP.

### Free mode and source-aware ownership

Free mode disables all ampi enforcement and restores the baseline captured before the locked mode. Source-aware ownership filtering: each ampi extension records its absolute path via `registerMmrOwnedExtensionPath(...)`, and Free mode only drops a tool when the active registration's `ToolInfo.sourceInfo.path` matches one of those paths. Same-named third-party tools are preserved. When Pi does not surface a source path, Free falls back to the name registry.

### Prompt assembly

Per-turn rewrite via `before_agent_start` consumes Pi's already-rendered native prompt as the base prompt. The active base/fragment map lives in [`prompt-registry.ts`](prompt-registry.ts): `pi-native-default-v1` records Pi's identity and section anchors, `MMR_PROMPT_FRAGMENTS` describes Pi-native passthrough fragments and ampi-owned fragments, and each prompted mode has a recipe (`basePromptId` + ordered fragment IDs + mode-specific intro/posture/response style). Adding a prompted mode should be a registry entry plus model/tool policy, not a new ad hoc prompt splice.

The renderer surgically replaces Pi's auto-rendered head (identity line through the `Pi documentation` block) by rendering the recipe fragments in order. The only ampi-owned XML marker is the initial one-line role marker (for example, `<mmr_mode name="medium">…</mmr_mode>`); mode sections use Markdown headings. Pi's auto `Available tools:`, `Guidelines:`, and `Pi documentation` blocks remain Pi-native fragments and embed byte-identically under `## Tool use`.

Content prepended by earlier handlers is preserved byte-for-byte before the rewritten identity line. Pi's `appendSystemPrompt`, `# Project Context`, `<available_skills>`, host/extension blocks after the documentation section, `Current date:` / `Current working directory:`, and tail-appended extension content are preserved byte-for-byte as the `preserved-tail` fragment. Pi prompts pass through unchanged when the auto head cannot be located (e.g. user-supplied `--system-prompt`) and in `free` mode. ampi-owned built-in-tool guidance, shared tool guidance, mode posture, and response style are separate fragments. Low/Medium use the complete Smart-family default recipe; High/Ultra use the Deep ordering and its `engineering-judgment` fragment.

### Subagent profiles

Subagent workers run as a separate execution route from user-facing locked modes. Activated via `--ampi-subagent <name>` on the child Pi process; ignored when absent. The profile is the single source of truth for model/thinking/tools/prompt-assembly policy; explicit `--model` / `--tools` on the worker exist for compatibility and observability and must match the profile route or activation fails closed before any mutation. Mode-derived workers may receive `--ampi-parent-mode` so child activation can apply parent-mode-specific worker routes without inferring from a model id.

Profile fields ([`subagent-profiles.ts`](subagent-profiles.ts)):

- `name`, `displayName` — identifier and human-facing label.
- `modelPreferences` — ordered worker-model preferences resolved against the local Pi registry.
- `modeModelPreferences?` — optional parent-mode-specific overrides (mode-derived only). Task uses this so Low workers follow Low's Terra/GPT-5.5 route.
- `thinkingLevel?` — optional; defaults to Pi's default thinking level when omitted.
- `tools` — profile-intent concrete tool allowlist. `resolveMmrSubagentInvocation(...)` computes effective worker tools as `(profile.tools \ profile.denyTools) ∩ registeredTools` when the host supplies a registered set, otherwise just `profile.tools \ profile.denyTools`.
- `denyTools?` — removed from the effective set. Recursive/advisory tools (`Task`, `oracle`, `librarian`, `handoff`) belong here for broad workers.
- `maxTurns?` — optional turn cap; `history-reader` sets this to `1`.
- `promptRoute` — `standalone` (profile owns the entire prompt) or `mode-derived` (derives from a parent mode and appends a worker-role block). The registry enforces `standalone` profiles must not declare `baseMode`; `mode-derived` profiles must.
- `baseMode?` — parent mode for `mode-derived` profiles.
- `promptBuilder` — identifier registered through the subagent prompt-builder registry. Concrete prompt text is owned by `ampi-workers`, not by `ampi-core`.
- `allowMcp` / `allowToolbox` — explicit MCP / toolbox surface flags. Read-only workers (finder) must keep both `false`.
- `enforceLockedMode: false`, `persistSubagentState: false` — workers never apply locked-mode policy or persist mode/subagent state.

Invariants:

- Activation never captures or restores a Pi baseline, never persists `ampi-core.mode-state`, never emits `MMR_EVENT_STATE_CHANGED`, never applies locked-mode prompt templates / request policy / Free-mode tool restoration.
- `before_agent_start` preserves Pi's base prompt (including `--append-system-prompt`) byte-for-byte; no locked-mode template tags inside a worker.
- Empty effective tool set on a tool-intending profile fails closed. Invalid profile, unresolvable model route, invalid `--ampi-parent-mode`, or explicit `--model` / `--tools` mismatch all fail closed. The canonical marker `ampi: subagent activation failed: <reason>` (`MMR_SUBAGENT_ACTIVATION_FAILURE_STDERR_PREFIX`) is written to stderr; the runner detects it via `extractMmrSubagentActivationFailure(stderr)` and turns it into a hard failure even when Pi exits 0.

Registered profiles:

| Name             | Route                  | Tools                                                                                                                                              | Model preferences                                                                                                                              | Thinking | MCP / Toolbox |
| ---------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------- |
| `finder`         | standalone, `finder`   | `[grep, find, read]`                                                                                                                               | `antigravity/gemini-3.5-flash` → `gpt-5.4-mini` → `claude-haiku-4-5` (Gemini primary is provider-pinned; fallbacks expand with provider hints) | `low` | false / false |
| `history-reader` | standalone             | `[]` (`maxTurns: 1`)                                                                                                                               | `antigravity/gemini-3.5-flash-extra-low` → `gpt-5.4-mini` → `claude-haiku-4-5` (Gemini primary is provider-pinned; fallbacks expand with provider hints) | `minimal` | false / false |
| `oracle`         | standalone, `oracle`   | `[read, grep, find, web_search, read_web_page, read_session, find_session]` (child filters out unregistered sibling-extension tools)                | `gpt-5.5` xhigh → `claude-opus-4-6` high                                                                                                                  | `xhigh`   | false / false |
| `librarian`      | standalone, `librarian`| `[read_github, list_directory_github, glob_github, search_github, commit_search, diff_github, list_repositories]`                                  | `gpt-5.5` off → `claude-opus-4-6` → `gpt-5.4`                                                                                                                  | `off` | false / false |
| `task-subagent`  | mode-derived, `Task`   | `[read, bash, edit, write, read_web_page, web_search, finder, skill, task_list]` minus `denyTools: [Task, oracle, librarian, handoff]` | provider-pinned Claude Opus 4.8 → GPT-5.5 medium → Claude Opus 4.6 medium → Haiku 4.5 low; Low override: GPT-5.6 Terra medium → GPT-5.5 medium | varies   | false / false |

Pure route resolver lives in [`subagent-resolver.ts`](subagent-resolver.ts).

### Subagent prompt assembly

`assembleMmrSubagentSurface` ([`subagent-prompt-assembly.ts`](subagent-prompt-assembly.ts)) returns an `MmrSubagentPromptAssemblyResult` mirroring `MmrPromptAssemblyResult` (`{ profile, blocks, systemPrompt, activeToolManifest }`) so the same renderers and effective-surface fixtures drive both surfaces.

- **Standalone** (`finder`, `oracle`, `history-reader`, `librarian`). The profile owns the entire prompt. Assembly resolves `profile.promptBuilder` against the registry, calls the builder with `{ profile, cwd, baseSystemPrompt, modeState? }`, and returns its output as the system prompt plus a single `standalone-prompt` block.
- **Mode-derived** (`task-subagent`). Derives from `profile.baseMode`, with `from-parent` resolved by the invocation resolver. Assembly preserves the canonical parent tier, calls `assembleActiveSurface` with a minimal mode state stamped for that tier, rewrites the `active-tools` block from the subagent-filtered worker manifest, then appends one `subagent-worker-role` block. Flattened blocks reproduce `systemPrompt` byte-for-byte.

Ownership: `ampi-core` owns the framework, registry, and contract. Concrete prompt text and builder registrations live in `ampi-workers`. Builders are pure synchronous functions and must not perform I/O. The active tool manifest is filtered down to the resolver's effective `workerTools` (or the profile's tool intent for backwards-compatible callers) before being surfaced. Missing/unregistered builders fail closed.

The assembled surface drives [`tests/fixtures/mmr-subagent-surface/`](../../../tests/fixtures/mmr-subagent-surface) so drift is caught at PR time.

## Diagnostics and troubleshooting

`/ampi-status` renders the resolved `MmrModeState`. Pass `debug` or `--debug` to append a `Debug:` section with the selected source, rejected source candidates, and per-candidate resolution detail.

Locked-mode fields (Free uses a strict subset):

| Field | Meaning |
| --- | --- |
| `Mode:` | Display name + key. |
| `Selected source:` | `flag` / `session` / `settings` / `default` / `native`. |
| `Rejected sources:` | Sources considered and discarded with reason, or `none`. |
| `Model preference order:` | Ordered preference list attempted (mode defaults merged with settings). |
| `Resolved model:` | `provider/model thinking:level` actually applied, or `none`. |
| `Resolved model available:` / `Model applied:` | Whether a candidate matched a registered model / whether Pi accepted it. Can diverge when Pi rejects. |
| `Configured fallback:` | `no` or `yes - <reason>`. |
| `Thinking:` | Pi session level plus per-mode request policy. |
| `Context:` / `Context cap:` | Profile after provider clamping; `none` in Free, `model default` when no ampi input profile, otherwise `<tokens> input tokens (mode profile)`. |
| `Baseline captured:` | Whether ampi-core has a pre-ampi restore snapshot (no auth detail, never persisted). |
| `Prompt surface:` | `default` (ampi head replacement) / `passthrough` / `disabled` (Free). |
| `Active tools:` / `Missing tools:` / `Deferred tools:` / `Gated tools:` / `Disabled tools:` | Outcome of tool resolution per requested tool name. |
| `Tool resolution:` | Each requested tool's provider, status, candidate list, and diagnostic. |
| `Feature gates:` | Reserved capability gates and resolution. |
| `Settings files read:` / `Settings warnings:` | Absolute paths that contributed; non-fatal warnings named per file. Runtime-only — not part of `PersistedMmrModeState`. |
| `Policy warnings:` / `Diagnostics by severity:` | From `getMmrPolicyDiagnostics(state)`. Grouped block sorts by severity; legacy single-line `Policy warnings:` kept for compatibility. |
| `State version:` / `Applied at:` | Schema version and last successful `applyMode` timestamp. |
| `Debug:` (with `debug`/`--debug`) | Selected source, rejected sources, and per-`MmrModelCandidateResolution` lines (`registered`, `authenticated`, `subscription`, `attempted`, `applied`/`not-applied`, `thinking=…`, `reason`). |

Common symptoms:

- **`Model applied: no`.** Combine `Resolved model:` / `Resolved model available:` / `Configured fallback:` with Debug `Model preference candidates:`. Common reasons: provider not registered, OAuth/API key missing (`authenticated=no`), Pi rejected the id (`attempted, not-applied`).
- **Auto-switched to Free.** Native `/model` or `/think` from a locked mode is a fail-soft switch with a warning. `Selected source: native` makes it visible. Re-enter `/mode <key>`.
- **Settings file silently ignored.** Check `Settings files read:`. A present file missing here is unreadable JSON — a `Settings warnings:` entry will name it.
- **Settings warning naming a block.** The block was discarded but the rest of the file (and the sibling file) still loaded. Fix the shape against the example in [`../../../README.md`](../../../README.md#settings). A `toolAliases` warning means the deprecated alias setting was found and ignored.
- **Tool stays `missing` / `deferred`.** `Tool resolution:` shows each request's provider and chosen tool. Resolution is identity-only: `missing` means no extension has claimed it and Pi has not registered the name; `deferred` means the catalog credits an owner that has not shipped/registered the concrete tool.
- **Locked mode refused to activate.** The resolver returned zero active tools; the previous state is kept. Inspect `Tool resolution:` on the previous state.
- **Feature gate `missing` / `disabled` / `gated`.** `missing` = no provider claimed it; `disabled` = owner loaded but off or no active capability; `gated` names the prerequisite (e.g. `librarian` waits on source-owned `ampi-github` tools).

All diagnostic codes come from `getMmrPolicyDiagnostics(state)` so `/ampi-status` and mode-change warning notifications stay in sync. Full list: [`docs/ampi-core-api.md`](../../../docs/ampi-core-api.md#policy-diagnostics).

## Public API

Re-exported from `ampi`. Canonical catalog: [`../../../docs/ampi-core-api.md`](../../../docs/ampi-core-api.md). Package-root re-exports: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## Developer notes

Non-goals:

- No `Task` / `finder` / `oracle` / `librarian` implementations; full librarian support also needs repository-provider tools outside ampi-core.
- No handoff, review/check runner, toolbox/MCP bridge.
- No provider replacement; no auth/header/base-URL mutation.
- No rewriting of Pi/extension content outside the auto-rendered head.
- No legacy `<!-- mmr-core:start --> / <!-- mmr-core:end -->` block emission.
- Prompt text is `ampi`-authored; no third-party prompt material is copied. Provenance: [`docs/prompt-provenance.md`](../../../docs/prompt-provenance.md).

Tests: `tests/mmr-core*.test.mjs`, `tests/fixtures/mmr-core-prompts/`, `tests/fixtures/mmr-effective-surface/`, `tests/fixtures/mmr-subagent-surface/`.
