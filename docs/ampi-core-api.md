# `ampi-core` public API

**Audience.** Developers writing extensions against `ampi-core`, or packages depending on `ampi`'s core runtime.

**Scope.** The stable programmatic surface that `ampi-core` exposes: runtime singletons, mode/state types, prompt-assembly contract, tool/feature-gate registry, subagent contracts. Non-core extension exports live in [`public-api.md`](./public-api.md).

**Related.** Extension overview: [`../src/extensions/ampi-core/README.md`](../src/extensions/ampi-core/README.md). Documentation conventions: [`documentation-style-guide.md`](./documentation-style-guide.md).

Anything not listed here is internal and may change without warning. The contract has two import paths:

- **Package root** — `import { ... } from "@skippermissions/ampi"` (resolves to
  `src/index.ts`). Use this in production code.
- **Preferred extension subpath** — `import { ... } from "@skippermissions/ampi/extensions/ampi-core"`
  (resolves to the extension entry point). Use this only when wiring
  the extension into a Pi package manifest.
- **Compatibility subpath** — `import { ... } from "@skippermissions/ampi/extensions/mmr-core"`.
  The `mmr-*` subpaths remain supported for existing consumers.

Internal modules under `ampi/src/extensions/ampi-core/<file>` are not
part of the public contract; only the names re-exported from the
package root are stable.

## Public principles

1. **No mutable singleton in the surface.** The runtime keeps a single
   piece of state for the active ampi mode and one tool/feature-gate
   registry chain. Callers can read snapshots and register providers
   through stable functions, but the singleton object itself is not
   exported.
2. **Snapshot read APIs return deep-cloned snapshots.** Functions
   suffixed with `Snapshot` (and the `onMmrStateChanged` event helper)
   hand callers their own deep clone, safe to keep or mutate.
   `getMmrModeState` returns the runtime's own object and must be
   treated as read-only. Raw `MMR_EVENT_STATE_CHANGED` payloads are
   shared snapshots reused across subscribers for one emission, also
   read-only.
3. **Provider chains, latest wins.** Tool and feature-gate providers
   register into ordered chains; later registrations override earlier
   ones. Tool resolution is identity-only: a requested name activates
   when Pi has registered a tool with exactly that name and either a
   provider claims it `active` or no provider claims it and the live
   inventory match wins; the exact-name status catalog credits the
   owning extension when a tool is deferred.
4. **Diagnostics, not opaque strings.** Policy issues are returned as
   structured `MmrPolicyDiagnostic[]` records with stable `code` values.
   The human-readable `message` field is what `/ampi-status` and the
   activation notification's "Warnings:" block render verbatim.
5. **Native-control opt-out is explicit.** `free` is the pure opt-out:
   ampi-core does not enforce model/thinking/request/prompt/tool resolution,
   removes ampi-owned tools, and emits no policy diagnostics.

## Modes

```ts
import { DEFAULT_MMR_MODE, MMR_MODE_KEYS, MMR_MODES, getMmrMode, isMmrModeKey } from "@skippermissions/ampi";
import type { MmrModeDefinition, MmrModeKey } from "@skippermissions/ampi";
```

- `MMR_MODE_KEYS`: ordered tuple `("low", "medium", "high", "ultra", "free")`.
- `MMR_MODES`: read-only mode table.
- `getMmrMode(key)`: returns the `MmrModeDefinition` for a canonical key.
- `isMmrModeKey(value)`: type guard for canonical mode strings.
- `DEFAULT_MMR_MODE`: `"medium"`.

Runtime/configuration boundaries also accept the migration aliases `rush` → `low`, `smart` → `medium`, `deep` → `high`, and `fable` → `ultra`; persisted state is normalized to canonical names.

## Mode state

```ts
import { getMmrModeState, getMmrModeStateSnapshot } from "@skippermissions/ampi";
import type { MmrModeState } from "@skippermissions/ampi";
```

- `getMmrModeStateSnapshot()` — **preferred for new code.** Returns a
  deep-cloned copy that callers may keep, mutate, or pass to other code
  paths.
- `getMmrModeState()` — legacy live read. Returns the runtime's own
  state object; **must not be mutated**. Kept exported for backward
  compatibility with callers that only read scalar fields like
  `state.mode`. New consumers should use the snapshot variant instead.

`MmrModeState.effectiveContextWindow`, `effectiveMaxOutputTokens`, and
`effectiveMaxInputTokens` are runtime-only hints for the active mode's
context profile after provider-size clamping. `undefined` means no ampi
override for that dimension (use the selected provider's registered
behavior). These values are not persisted and are never written to provider
payloads. Medium inherits the former Smart profile: 300k total, 172k max input,
and a 128k output reservation. The selected registry model is cloned and capped
down to 300k before `pi.setModel(...)`, so Pi-native compaction follows that
window. Low, High, and Ultra carry no ampi context override and run at the
selected provider's registered window. `free` carries no ampi context profile
because Pi-native model/context controls stay in charge.

`MmrModeState.baselineCaptured` / `baselineModel` are runtime-only
status diagnostics. They show whether ampi-core has a pre-ampi restore
snapshot and the provider/model id when known. They are not persisted
and never include auth material.

`MmrModeState.modeLock` is runtime-only as well: `{ enabled, locked, reason? }`.
`locked` turns true once the session has a user message (unless the
`ampiCore.modeLock` setting is `false`); a mode control should then show
the mode read-only instead of changing it. It is never persisted, because
ampi-core derives it from the session entries at session start.

`setMmrModeState` is intentionally **not** exported from the package
root. Only the `ampi-core` extension itself updates the runtime state.

## Tool resolution

```ts
import {
  registerMmrToolProvider,
  resolveMmrTools,
  isToolAllowed,
} from "@skippermissions/ampi";
import type { MmrToolProvider, MmrToolResolution, MmrToolRule } from "@skippermissions/ampi";
```

- `registerMmrToolProvider(provider)` — register an extension-owned
  status provider. Provider order is latest-wins. A provider claims
  ownership for the exact tool names it owns and reports `active`,
  `gated`, `disabled`, or `deferred`.
- `resolveMmrTools(modeKey, availableTools, editToolFamily?)` — synchronously resolve
  the active/missing/deferred/gated/disabled tool lists for a mode
  against a Pi-tool inventory. `editToolFamily` (`"patch"` or `"edit"`)
  adds `apply_patch` or `edit` after `write`; without it the list has no
  file-editing tool, because locked modes pick it from the route's provider.
- `isToolAllowed(toolName)` — quick check against the current state's
  `activeTools`.

Resolution is **identity-only**. A requested tool name activates iff a
provider claims it as `active` AND a Pi tool with that exact name is
registered, OR no provider claims it AND a Pi tool with that exact
name is registered. There are no aliases or candidate fallbacks: modes,
profiles, subagents, and user tool allowlists must use the exact Pi
tool name they want activated.

`MmrToolRule` kinds: `active`, `deferred`, `gated`, `disabled` (see
`src/extensions/ampi-core/types.ts`). A provider returns `undefined`
for names it does not own; the registry then walks lower-priority
providers and finally falls back to the exact-name status catalog
(`DEFAULT_TOOL_CATALOG`) plus identity match against the live Pi
inventory.

The acceptance contract: a future module can call
`registerMmrToolProvider(...)` once at extension load and have the
next mode resolution include its rules without ordering constraints.

## Worker-tool model resolution

```ts
import { selectMmrModelRoute, resolveAndApplyMmrModel } from "@skippermissions/ampi";
import type {
  MmrModelPreference,
  MmrModelRouteSelection,
  MmrRegisteredModelLike,
  MmrModelRegistryLike,
  ResolveAndApplyMmrModelArgs,
  SelectMmrModelRouteArgs,
} from "@skippermissions/ampi";
```

- `selectMmrModelRoute({ modelPreferences, modeThinkingLevel?, registry })`
  — synchronous, **non-mutating**. Picks the highest-priority
  registered + authenticated provider/model from a preference list.
  Use this from worker tools (subagents, oracle, librarian, etc.) that
  need their own route without changing Pi's currently active model.
  Returns `{ selected?, candidates }` where `selected` carries the
  chosen `provider`, `model`, `thinkingLevel`, and the underlying
  registered model object; `candidates` is the full list of considered
  routes with skip reasons.
- `resolveAndApplyMmrModel(args)` — async, **mutating**. Used by the
  `ampi-core` extension itself to apply the selected route via Pi's
  `setModel`. It enumerates the same candidate list as
  `selectMmrModelRoute` and iterates until Pi accepts a route.

Worker tools should never call `resolveAndApplyMmrModel`.

## Feature gates

```ts
import {
  createMmrFeatureGateRegistry,
  registerMmrFeatureGateProvider,
  resolveMmrFeatureGates,
} from "@skippermissions/ampi";
import type {
  MmrFeatureGateDecision,
  MmrFeatureGateProvider,
  MmrFeatureGateProviderDecision,
  MmrFeatureGateRegistry,
} from "@skippermissions/ampi";
```

- `registerMmrFeatureGateProvider(provider)` — push a provider onto
  the runtime registry. Later registrations take precedence.
- `resolveMmrFeatureGates(gates)` — runtime-bound resolver. Always
  reflects providers added through
  `registerMmrFeatureGateProvider`. Built-in providers
  `ampi-core.reserved` (named-reason missing for known names) and
  `ampi-core.unknown` (terminal catch-all) always sit below registered
  providers.
- `createMmrFeatureGateRegistry()` — build a fresh, isolated registry
  with only the two built-ins. Useful for tests and ad-hoc
  decisions; this registry does not see runtime registrations.

A provider returns `MmrFeatureGateProviderDecision` (no `source`); the
runtime tags decisions with the producing provider name.

## Subagent profiles

```ts
import {
  MMR_SUBAGENT_ACTIVATION_FAILURE_STDERR_PREFIX,
  extractExplicitWorkerCliFlags,
  extractMmrSubagentActivationFailure,
  getMmrSubagentProfile,
  getMmrSubagentState,
  listMmrSubagentProfiles,
  resolveMmrSubagentInvocation,
} from "@skippermissions/ampi";
import type {
  ExplicitWorkerCliFlags,
  MmrSubagentBaseMode,
  MmrSubagentInvocation,
  MmrSubagentInvocationFail,
  MmrSubagentInvocationOk,
  MmrSubagentProfile,
  MmrSubagentPromptRoute,
  MmrSubagentResolveCode,
  MmrSubagentResolveDiagnostic,
  MmrSubagentState,
  MmrSubagentToolResolution,
  ResolveMmrSubagentInvocationArgs,
} from "@skippermissions/ampi";
```

Subagent workers run as a dedicated, non-locked execution route in a
child Pi process, activated through the `--ampi-subagent <name>` CLI
flag. A subagent profile is the single source of truth for that
worker's model preferences, thinking level, tool allowlist, and prompt
route. Activation never captures or restores a Pi baseline, never
emits `MMR_EVENT_STATE_CHANGED`, never persists `ampi-core.mode-state`,
never applies locked-mode prompt templates / request policy / Free-mode
tool restoration, and never injects ampi-owned tools beyond the profile
allowlist.

- `getMmrSubagentProfile(name)` — look up a registered
  `MmrSubagentProfile` by name. Returns `undefined` for unknown or
  empty names. Profiles are deep-frozen at module load.
- `listMmrSubagentProfiles()` — enumerate registered profile names in
  stable order.
- `resolveMmrSubagentInvocation({ profile, registry, parentMode?, registeredTools?, parentActiveTools?, explicitModel?, explicitTools?, modelPreferencesOverride?, invocationContext? })`
  — single public resolver for parent spawn and child activation. Picks
  the first registered + authenticated provider/model from the profile's
  preferences via `selectMmrModelRoute`, then layers on subagent-specific
  policy:
  - resolves `promptBaseMode` from `profile.baseMode` (a concrete canonical mode
    key, or `from-parent` using the canonical parent tier);
  - computes the effective `workerTools` as
    `(profile.tools \ profile.denyTools) ∩ registeredTools`;
  - fails closed when `profile.tools.length > 0` collapses to an empty
    `workerTools` (intentional `tools: []` profiles pass through);
  - applies `profile.modeModelPreferences[promptBaseMode ?? parentMode]`
    when present so mode-derived workers can use parent-tier-specific routes;
  - validates any caller-supplied `explicitModel` against the resolved
    route and `explicitTools` against `workerTools` order-independent;
  - forwards `modelPreferencesOverride` for settings-driven Task model preferences
    overrides without mutating `profile.modelPreferences`.

  Returns `MmrSubagentInvocationOk` on success (with `modelArg`,
  `workerTools`, `toolResolution`, and `promptBaseMode`) or
  `MmrSubagentInvocationFail` with a stable failure code on rejection.
  Never mutates caller state.

  `invocationContext` identifies which side of the parent/child boundary
  is calling. It is a caller-identity marker, not a safety toggle, and
  does not loosen deny-list, tool intersection, model route, or
  explicit-tools validation:

  - `"parent-spawn"` (default) — the parent (Task tool, or any future
    parent that spawns a worker through this resolver) is computing the
    invocation. A missing or `"free"` `parentMode` on a `from-parent`
    profile fails closed with `prompt-base.unresolved` because the
    parent owns prompt assembly and cannot build a worker system prompt
    for an unresolved mode.
  - `"child-activation"` — the child Pi process (`applySubagentProfile`)
    is validating its CLI flags. The parent already delivered the
    worker system prompt via `--system-prompt` before spawning. When the
    runner supplied `--ampi-parent-mode`, the child uses that mode for
    parent-mode-specific worker routes; when it is absent, the resolver
    returns `promptBaseMode: undefined` for missing parent modes instead
    of failing closed and uses the profile's default preferences. All
    other validation (model route, deny set, registered-tool
    intersection, explicit-tools equality) still runs.

  The `toolResolution` field carries the deny-aware, registered-tool

  observability detail (`intendedTools`, `deniedTools`, `registeredTools`,
  `parentActiveTools`, `omittedTools`) so consumers can render
  `/ampi-status`-style breakdowns of what the worker actually got.
- `extractExplicitWorkerCliFlags(argv)` — pure helper that pulls
  explicit `--model`, `--tools`, and `--ampi-parent-mode` values out of a
  Pi-style argv slice (`process.argv.slice(2)`) so activation can
  distinguish runner-supplied flags from Pi's own default/restored model
  and validate parent-mode-specific model preferences. Supports `--flag <value>`,
  `--flag=<value>`, and the `--tools` short alias `-t`.
- `getMmrSubagentState()` — returns the current process-singleton
  `MmrSubagentState | undefined`. Non-empty inside a subagent worker
  after `session_start`; `undefined` in every normal session.
  `before_provider_request`, `before_agent_start`, `tool_call`,
  `model_select`, and `thinking_level_select` consumers can use this
  to early-return so they do not apply locked-mode policy to worker
  turns.

Stable resolver failure codes:

| Code                     | When                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `model.no-route`         | None of the profile's `modelPreferences` resolved to a registered + authenticated provider route. |
| `model.mismatch`         | An explicit `--model` value on the worker argv does not match the profile-resolved route.         |
| `tools.mismatch`         | An explicit `--tools` value on the worker argv does not match the resolved `workerTools` set.     |
| `tools.empty`            | `profile.tools` is non-empty but the deny-aware, registered-tool intersection collapses to empty. |
| `prompt-base.unresolved` | A `from-parent` profile was resolved with `invocationContext: "parent-spawn"` and no `parentMode`. |

Fail-closed startup signaling (ampi-core writes; runner reads):

- `MMR_SUBAGENT_ACTIVATION_FAILURE_STDERR_PREFIX` — stable marker that
  the child Pi process writes to its own stderr (`ampi: subagent
  activation failed: <reason>`) when subagent activation rejects.
- `extractMmrSubagentActivationFailure(stderr)` — pure parser that
  returns the trimmed reason from the last marker occurrence, or
  `undefined` when no marker is present. The runner in `ampi-workers`
  uses this to convert the marker into an unmissable hard failure
  even when Pi itself exits 0 (Pi currently does not propagate
  extension `session_start` throws into a nonzero exit code).

Subagent profiles are an `ampi-core` concept; concrete subagent worker
tools live in `ampi-workers` and use these APIs to drive the child
worker. New profiles are registered by editing
`extensions/ampi-core/subagent-profiles.ts`; the table is intentionally
not user-extensible at runtime.

## Prompt route

```ts
import { getMmrPromptRoute } from "@skippermissions/ampi";
import type { MmrPromptRoute } from "@skippermissions/ampi";
```

- `getMmrPromptRoute(modeKey)` — returns `"default" | "deep"`.
  Low/Medium resolve to `default`; High/Ultra resolve to `deep`.

## Policy diagnostics

```ts
import { getMmrPolicyDiagnostics } from "@skippermissions/ampi";
import type {
  MmrPolicyDiagnostic,
  MmrPolicyDiagnosticCode,
  MmrPolicyDiagnosticSeverity,
} from "@skippermissions/ampi";
```

- `getMmrPolicyDiagnostics(state)` — returns a list of structured
  policy diagnostics for an `MmrModeState`. Free mode always returns
  `[]`. The set of stable codes is:

| Code                       | When                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `model.not-applied`        | Locked mode resolved with no usable model (no auth or no candidates).                |
| `model.fallback-applied`   | Active model is not the first preference in the mode's preference list.              |
| `tools.none-active`        | Active tool set is empty.                                                            |
| `tools.missing`            | Some logical tools could not be resolved to an active Pi tool.                       |
| `tools.gated`              | Logical tools are gated behind an off feature gate.                                  |
| `tools.disabled`           | Logical tools were administratively disabled.                                        |
| `availability`             | One per `mode.availabilityNotes` entry (e.g. "subagents not yet shipped").           |

Each diagnostic has `code`, `severity`, `source: "mmr-core"`, and a
human-readable `message`. Some carry a small `data` payload (for
example `tools.missing` includes `{ tools: [...] }`). `/ampi-status`
renders `message` verbatim, joined by `; `. The activation notification
renders the same messages as warning bullets, then appends per-decision
diagnostics for any deferred tools.

## Event bus

```ts
import { MMR_EVENT_STATE_CHANGED, onMmrStateChanged } from "@skippermissions/ampi";
import type { MmrEventBusHost, MmrStateChangedHandler } from "@skippermissions/ampi";
```

The `ampi-core` extension emits `MMR_EVENT_STATE_CHANGED`
(`"mmr-core:state-changed"`) on `pi.events` whenever the active ampi
mode state is replaced (mode switch, free-mode opt-out, native control
fallback), and again with the unchanged mode state when the session's fast
speed is turned on or off. The payload is a deep-cloned `MmrModeState`
snapshot, or `undefined` when state was cleared.

Pi's event bus fans the **same** payload object out to every subscriber
for a given emission. That means raw `pi.events.on(...)` handlers share
the payload and must treat it as read-only:

```ts
// Read-only: payload is shared across all listeners for this emission.
pi.events.on(MMR_EVENT_STATE_CHANGED, (state) => {
  console.log("mode is now", (state as MmrModeState | undefined)?.mode);
});
```

For handlers that need a payload they can keep or mutate, use the
`onMmrStateChanged` helper, which deep-clones the snapshot per
invocation:

```ts
// Per-invocation deep clone: each handler call gets its own payload.
onMmrStateChanged(pi, (state) => {
  if (state) state.activeTools.push("local-only"); // safe; isolated copy
});
```

The event bus is a notification channel only; it does not support
request/response. For queries, use the read APIs above.

## Mode registry

```ts
import { listAmpiModes, onAmpiModesChanged, registerAmpiMode, resolveAmpiRegisteredMode } from "@skippermissions/ampi";
import type { AmpiRegisteredMode, AmpiRegisteredModeDefinition } from "@skippermissions/ampi";
```

Modes other extensions add, each running as one of the four locked modes
with its own key, label, description, colour and optional overrides. The
registry is process-global, so every copy of ampi-core in the process sees
the same modes. Behaviour, limits and the reload rule:
[`ampi-core` README, Registered modes](../src/extensions/ampi-core/README.md#registered-modes).
Every name is also exported in its `Mmr*` / `MMR_*` form.

- `registerAmpiMode(definition)` — validate and add a mode; returns a
  function that removes it again (a no-op once the registration was
  replaced or removed). `definition` is `{ key, color, label?,
  description?, source?, baseMode?, modelPreferences?, thinkingLevel?,
  tools?, promptAppend? }`. Throws on an invalid field, a reserved key or
  label, or a key or label another registration holds. An identical
  definition changes nothing; a different one for a held key replaces it in
  place only when both name the same `source` (a definition without one
  never replaces another). Replacing the active mode applies the new
  definition at once.
- `unregisterAmpiMode(key)` — remove a mode by key, however it was
  registered (through the API or over the event bus); returns `false` when
  none had it. The bus message `ampi-core:unregister-mode` removes only
  modes registered over the bus.
- `listAmpiModes()` — registered modes in registration order, as frozen
  `AmpiRegisteredMode` records (`label` filled in, `color` lowercase,
  `source` defaulting to `extension`, `baseMode` defaulting to `medium`).
- `getAmpiRegisteredMode(key)` — one mode by key, case-insensitively.
- `resolveAmpiRegisteredMode(name)` — the mode a typed name means, by key
  or label, case-insensitively. Built-in names never match here; resolve
  them first with `resolveMmrModeKey`.
- `onAmpiModesChanged(listener)` — called with `{ change, key }`, where
  `change` is `"registered"` or `"unregistered"`. Returns an unsubscribe
  function. An in-process callback, not a Pi event-bus topic. A listener
  that throws does not stop the change or the other listeners.
- Event-bus protocol, for extensions that do not import ampi:
  `AMPI_EVENT_REGISTER_MODE` (`ampi-core:register-mode`, payload: a
  definition), `AMPI_EVENT_UNREGISTER_MODE` (`ampi-core:unregister-mode`,
  payload `{ key }`, removes only modes registered over the bus) and
  `AMPI_EVENT_MODES_READY` (`ampi-core:modes-ready`, payload
  `{ version: 1 }`, emitted by ampi-core from its factory and at the start
  of each session; answer it by emitting the definitions again,
  synchronously).
- `MmrModeState.registeredMode` (`AmpiRegisteredModeInfo`: `{ key, label,
  color, source }`) names the active registered mode; `mode` then holds its
  base key. The persisted `ampi-core.mode-state` entry carries the key as
  `registeredModeKey`.

## Command registry

```ts
import { getMmrCommands, onMmrCommandsChanged, rankMmrCommands, registerMmrCommand } from "@skippermissions/ampi";
import type { MmrCommandDefinition, MmrRankedCommand } from "@skippermissions/ampi";
```

Palette commands are named actions, separate from Pi slash commands. The
registry is process-global, so every extension sees the same list. This
API and the keymap below are in the Internal tier (see
[`public-api-surface.md`](./public-api-surface.md)) until the command
palette consumes them.

- `registerMmrCommand({ id, noun, verb, description, defaultKey?, keywords?, availability?, run })`
  — add a command, or replace the one with the same `id` (it keeps its
  position). `id` is dotted lowerCamel (`thread.new`,
  `prompt.openInEditor`); the palette label is `noun verb`. `defaultKey`
  is a chord or an array of chords in the keymap grammar below.
  `availability(ctx)` returns `{ state: "available" | "unavailable" | "hidden", reason? }`
  and defaults to available. Throws on an invalid id, an empty noun,
  verb or description, or an unparsable `defaultKey`.
- `unregisterMmrCommand(id)` — remove a command; returns `false` when
  the id was not registered.
- `getMmrCommands()` / `getMmrCommand(id)` — read commands in
  registration order.
- `onMmrCommandsChanged(listener)` — called with `{ change, id }`, where
  `change` is `"registered"`, `"replaced"` or `"unregistered"`. Returns an
  unsubscribe function. This is an in-process callback, not a Pi event-bus
  topic. A listener that throws does not stop the change or the other
  listeners.
- `rankMmrCommands(commands, query, { ctx }?)` — pure palette ranking.
  Every query word must fuzzy-match the label, id, description or a
  keyword. Available rows come first (best match, then registration
  order), unavailable rows follow with their `reason`, and hidden rows are
  dropped. An empty query keeps registration order. `availability` runs
  only when `ctx` is given; without it every command counts as available.
  An `availability` check that throws counts as unavailable.

## Keymap

```ts
import { formatMmrKeyChord, parseMmrKeyChord, readMmrKeymapSettings, resolveMmrKeymap } from "@skippermissions/ampi";
import type { MmrKeyChord, MmrResolvedKeymap } from "@skippermissions/ampi";
```

Key strings: a chord is one or more combos separated by spaces
(`ctrl+c ctrl+n`, `esc esc`); a combo is modifiers plus one key joined by
`+`, case-insensitive. Modifiers are `ctrl`, `alt`, `shift`, `meta`, with
the aliases `option` (alt), `cmd` / `command` (meta) and `mod`, which
always means `ctrl`. Keys are `esc`, `enter`, `space`, `tab`,
`backspace`, `delete`, the arrows, `home`, `end`, `pageup`, `pagedown`,
`f1`–`f12` (plus the aliases `escape`, `return`, `pgup`, `pgdn`) or a
single character. A lone uppercase letter means shift plus that letter;
next to a modifier, case is ignored, so `alt+Z` means `alt+z`, not
`alt+shift+z`. `<leader>` (default `ctrl+x`) may start a chord:
`<leader>z`.

- `parseMmrKeyChord(text)` — returns `{ leader, combos }` or `{ error }`;
  never throws.
- `formatMmrKeyChord(chord, { style?, leader? })` — canonical form
  (`ctrl+c ctrl+n`, `<leader>z`) or `style: "display"` (`Ctrl+C Ctrl+N`).
  Passing `leader` expands `<leader>`.
- `areMmrKeyChordsEqual(a, b, leader?)` — compare chords, after leader
  expansion when `leader` is given.
- `readMmrKeymapSettings(settings, filePath?)` — read `ampi.keymap` from
  a parsed Pi settings object; returns `{ leader?, overrides, problems }`.
  Problems name `filePath` when it is given.
- `resolveMmrKeymap({ defaults, overrides?, leader? })` — merge defaults
  (every known command id, `null` when unbound) with overrides. A string
  replaces the defaults, an array replaces them with every listed chord,
  `null` or `[]` unbinds. Unknown ids and unparsable chords land in
  `problems`. An override whose chords all fail to parse keeps the
  default, so `"thread.new": ""` does not unbind; use `null`. Returns `bindings` (id → chords), `byChord` (expanded chord
  → first id), and `conflicts`: `duplicate` when several ids share a
  chord, `prefix` when one chord starts another (`ctrl+c` and
  `ctrl+c ctrl+n`).
- `formatMmrKeymapJsonc(commands, keymap)` — JSONC listing with `leader`
  first, then one line per command id in sorted order with its chord,
  array or `null` and the description as a `//` comment.
- `MMR_DEFAULT_KEYMAP_LEADER` — `"ctrl+x"`.

Settings shape:

```json
{ "ampi": { "keymap": { "leader": "ctrl+x", "thread.new": "ctrl+t", "mode.toggle": ["ctrl+s", "alt+m"], "thread.interrupt": null } } }
```

## Persisted state

```ts
import { AMPI_MODE_STATE_ENTRY, findLatestPersistedModeState } from "@skippermissions/ampi";
import type { MmrModeState } from "@skippermissions/ampi";
```

- `AMPI_MODE_STATE_ENTRY` — the `customType` string used for persisted
  session entries (`"ampi-core.mode-state"`). The legacy
  `MMR_MODE_STATE_ENTRY` export (`"mmr-core.mode-state"`) is still
  exported and still read for backward compatibility.
- `findLatestPersistedModeState(entries)` — locate the most recent
  valid persisted mode state; rejects malformed/future-version
  records. Currently versioned at `1`.

Other extensions should treat persisted state as **read-only**: do not
write `ampi-core.mode-state` entries from outside `ampi-core`.

## Thread status

`createMmrThreadStatusReducer()` (alias `createAmpiThreadStatusReducer`)
returns a reducer that turns the events of an agent run into the
Amp-compatible status a terminal or browser UI shows next to the prompt.
It is pure and synchronous and starts no timers. Each holder keeps its own
instance: `ampi-core` keeps one for its live registry of running sessions,
and a UI that shows the status keeps another, maps Pi events onto
`MmrThreadStatusEvent` and calls `apply(event)`.

```ts
import { createMmrThreadStatusReducer } from "@skippermissions/ampi";

const threadStatus = createMmrThreadStatusReducer();
pi.on("turn_start", () => threadStatus.apply({ type: "turnStart" }));
pi.on("tool_execution_start", (event) =>
  threadStatus.apply({ type: "toolStart", toolCallId: event.toolCallId, toolName: event.toolName }),
);
```

`apply` returns a frozen `MmrThreadStatus`, and returns the previous
object when nothing visible changed, so callers can skip redraws by
identity:

| Field | Meaning |
| --- | --- |
| `phase`, `label` | Current phase and its status words (table below) |
| `detail` | `23 tok` while thinking or streaming, or the running tool's name |
| `hint` | Steer, dequeue, or force-quit key hint; empty otherwise |
| `busy`, `queued`, `attention` | Run in progress; queued messages; the user is needed |

| `phase` | `label` | `phase` | `label` |
| --- | --- | --- | --- |
| `idle` | (empty) | `runningTools` | `Running Tools` |
| `sending` | `Sending` | `compacting` | `Auto-Compacting` |
| `thinking` | `Thinking` | `waitingApproval` | `Waiting for Approval` |
| `streaming` | `Streaming` | `cancelling` | `Cancelling` |
| `error` | `Error` | | |

- The hint is `Enter to steer`, or `Enter to steer, Backspace to dequeue`
  while messages are queued, and `ctrl+c again to force quit` during the
  quit grace period. Steering hints show only while the agent runs or
  compacts, not while it waits for approval, cancels, or after an error.
- The token count appears only when the provider reports output usage
  while streaming. With several tools running, `detail` names the one that
  started first.
- `attention` is true while waiting for approval and after an error.

Transitions:

- Compaction shows over the current phase and the interrupted phase
  returns when it finishes or fails.
- An abort shows `Cancelling` until the turn ends, then the thread stays
  idle until `settled`, even if Pi starts one more aborted turn first. An
  abort during a compaction outside a turn ends when the compaction does.
- A failed tool does not change the phase; an `error` event does, and it
  stays until the next `turnStart`.
- The force-quit hint expires once an event's `now` (or a `tick`) reaches
  the `expiresAt` given with `quitPressed`.

Approval requests reach status displays over the event bus:
`MMR_EVENT_APPROVAL` (`"mmr-core:approval"`) carries
`{ phase: "request" | "answer", requestId }`, and `onMmrApproval(pi, handler)`
subscribes with a checked copy. Map `request` to `approvalRequest` and
`answer` to `approvalAnswer`.

## Tool permissions

```ts
import { evaluateMmrPermission, formatMmrPermissionRule } from "@skippermissions/ampi";

const decision = evaluateMmrPermission(
  { toolName: "bash", input: { command: "git status && npm test" } },
  { user: [{ tool: "bash", matches: { command: "git push*" }, action: "ask" }] },
);
// decision.action === "allow"
```

The pure rule engine behind `ampi-permissions`. A rule is
`{ tool, matches?, action, context?, to?, message? }` (`MmrPermissionRule`);
`validateMmrPermissionRule` lists what is wrong with one and
`parseMmrPermissionRules` splits a settings list into valid rules and
per-index problems. `evaluateMmrPermission(call, { project, user, defaults })`
returns the first matching rule's decision in that order, `defaults`
standing for `MMR_PERMISSIONS_DEFAULT_RULES` unless given, and `allow` when
nothing matches; `{ context: "subagent" }` applies the rules for subagent
children instead of the main session (`thread`). For `bash` and
`shell_command` (`MMR_PERMISSIONS_SHELL_TOOLS`) it judges each simple command
of the line, split by `splitMmrShellCommand`: a rejected part rejects the line,
else a delegated part makes it `delegate`, else an asking part makes it ask.
A line of several parts carries every part's decision in `parts`, so a caller
can run each delegated part's program. The engine never runs one itself.
`formatMmrPermissionRule` writes a rule as one line
(`ask bash --command 'git push*'`). `setMmrPermissionsSessionAllowAll` and
`isMmrPermissionsSessionAllowAll` hold the session-wide "allow all" answer
on a process global. Matching rules and the defaults are described in the
[`ampi-permissions` README](../src/extensions/ampi-permissions/README.md).

## Session catalogue

```ts
import { createMmrPiSessionSource, createMmrSessionIndex, resolveMmrSessionById } from "@skippermissions/ampi";
import type { MmrSessionIndex, MmrSessionSource } from "@skippermissions/ampi";
```

A read-only view of the local Pi sessions on disk, for any extension that
lists, resolves or inspects sessions. It reads through Pi's own
`SessionManager` and never writes a session file. `ampi-history` reads
sessions through it. This API is in the Internal tier (see
[`public-api-surface.md`](./public-api-surface.md)) until the thread
switcher consumes it. Every name also has an `Ampi*` alias.

- `createMmrPiSessionSource()` returns an `MmrSessionSource`:
  `listSessions()` calls `SessionManager.listAll()`, which reads every
  project's session directory under `~/.pi/agent/sessions/` and returns
  Pi's `SessionInfo` records (id, path, cwd, name, created and modified
  dates, message count, first message, all message text).
  `openSession(path)` calls `SessionManager.open(path)`. Tests pass their
  own `{ listSessions, openSession }` instead.
- `createMmrSessionIndex(source, { listTtlMs?, now? }?)` caches the listing
  for `listTtlMs` (10 s by default) and adds two lazy lookups that open a
  session only when asked, cached per `id|modified|messageCount|path|cwd`:
  - `getTouchedFiles(info)`: the files named by `read`, `edit`, `write`
    and `apply_patch` tool calls, lowercased and relative to the session's
    cwd. Paths outside that cwd, shell output and prose are ignored.
  - `getMetadata(info)`: providers, models, tool names, labels, and
    whether the session used tools or hit errors.

  Once the TTL has passed, the next call lists again and keeps the
  per-session cache only when the listing is unchanged. The index has no
  filesystem watcher and no state on disk.
- `dedupeMmrSessionsById(sessions)` keeps one record per session id when a
  moved file or renamed project directory lists the same session twice:
  the newest `modified` wins, then the newest `created`, then the lower
  `path`.
- `resolveMmrSessionById(source, id, index?)` accepts an exact id, `@id`
  or an id prefix, and returns `{ info, ambiguous, candidateIds }` or
  `undefined`. An exact id always wins; a prefix that several sessions
  share resolves to the first and sets `ambiguous`. With `index`, the
  cached listing is used.

## Thread index

```ts
import { filterMmrSessionsByArchived, getMmrThreadIndex } from "@skippermissions/ampi";
import type { MmrThreadIndex, MmrThreadRecord } from "@skippermissions/ampi";
```

Per-session metadata that Pi's session files do not carry, keyed by Pi's
session id. `ampi-threads` owns the store (see its
[README](../src/extensions/ampi-threads/README.md#the-thread-index)) and
registers it here at load, so other extensions use it without importing
`ampi-threads`. This API is in the Internal tier until the thread switcher
consumes it. Every name also has an `Ampi*` alias.

- `MmrThreadRecord`: optional `archived` (ISO 8601 date), `labels`,
  `color` (a colour name or `#rrggbb`), `pinned` and `titleSource`
  (`"model"` or `"user"`).
- `getMmrThreadIndex()` returns the registered `MmrThreadIndex`, or
  `undefined` when `ampi-threads` is not loaded; treat every session as
  unarchived then. Its methods:
  - `list()`: every record, keyed by session id.
  - `get(sessionId)`: one record, or `undefined`.
  - `update(sessionId, patch)`: a patch value sets a field, `null` removes
    it, an absent key leaves it. Returns the new record, or `undefined`
    when no field is left (the entry is then removed). Invalid values are
    rejected before anything is written.
- `registerMmrThreadIndex(index)` registers an index; the most recent
  registration wins. It returns an idempotent function that removes this
  registration.
- `filterMmrSessionsByArchived(sessions, threads, archived)` keeps the
  catalogue sessions (anything with an `id`) whose archived state matches,
  in their original order. Pass a `list()` result as `threads`.
- `MMR_THREAD_SLASH_COMMAND` (`"ampi-thread"`) names the slash command the
  session-replacing thread commands run through. Command palettes leave it
  out of their slash-command rows.

## Additional exported helpers

The package root re-exports a few lower-level helpers used by tests,
the `ampi-core` extension's own setup, and adjacent tooling. They are
exposed for completeness; new extensions should prefer the stable APIs
above unless they have a specific reason to use these.

- `createMmrCoreRuntime(toolRegistry?, featureGateRegistry?)` — build
  an isolated runtime instance with its own state and registries.
  Useful for tests. Not the singleton used by the running extension.
- `createMmrFeatureGateRegistry()` / `createMmrToolRegistry(initialAliases?)`
  — build standalone registries. Registrations on these instances do
  not affect the runtime singleton.
- `loadMmrCoreSettings(cwd)` — read ampi settings from Pi's normal
  settings files (`~/.pi/agent/settings.json`, `.pi/settings.json`).
- `resolveMmrModeSelection({ flagValue, persistedMode, settingsMode, defaultMode })`
  — pick a mode from the documented precedence chain (flag → persisted
  session → settings → default).
- `resolveMmrModel(modeKey)` — build an empty `MmrModelResolution`
  scaffold for a mode's preferences. Used by `createMmrCoreRuntime`
  consumers; most callers should use `selectMmrModelRoute` or
  `resolveAndApplyMmrModel`.
- `resolveMmrToolNames(requestedTools, availableTools, extraAliases?)`
  — module-level tool resolution against a fresh registry; bypasses
  the runtime singleton's registered providers.
- `isMmrToolAllowed(toolName, resolution)` — stateless check against a
  pre-resolved `MmrToolResolution`. Use `isToolAllowed` for the
  current runtime state.
- `registerMmrChromeOwner(name)` / `getMmrChromeOwner()` — seam for an
  extension that draws its own terminal chrome. While any owner is
  registered, `ampi-core` leaves Pi's footer slot alone: it neither
  installs its locked-mode footer nor restores Pi's footer in `free` mode.
  The most recent registration wins; `registerMmrChromeOwner` returns an
  idempotent function that removes that registration. `ampi-tui` is the
  built-in owner.
- `buildMmrPromptLayer(context)`, `MMR_PROMPT_LAYER_START`,
  `MMR_PROMPT_LAYER_END` — the prompt assembly helper used by the
  `ampi-core` extension's `before_agent_start` hook, plus legacy
  delimiter constants. Not currently emitted around the rendered
  prompt; kept exported for downstream tooling that searched on them.

## What is intentionally not exported

- The runtime singleton object itself (`mmrCoreRuntime` / equivalent).
- `setMmrModeState` (only `ampi-core` updates the runtime).
- `setMmrSubagentState` (only `ampi-core` updates subagent activation
  state; readers use the exported `getMmrSubagentState`).
- Raw mutable registries (`getMmrToolRegistry`,
  `getMmrFeatureGateRegistry`).
- The live registry of running sessions (`setMmrLiveFields`,
  `readMmrLiveEntries`, `findMmrLiveOwner` and the writer) and the mapping
  of Pi events onto thread status events: ampi's own extensions import them
  from their modules. The registry's file format is described in the
  [`ampi-core` README](../src/extensions/ampi-core/README.md#live-registry).
- Any helper not re-exported from `src/index.ts`.

If you find yourself reaching past the public surface, open an issue
proposing a new stable API rather than depending on internals.
