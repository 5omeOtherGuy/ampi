# mmr-session-fallback roadmap

This roadmap covers the `mmr-session-fallback` extension: session-scoped
interactive model fallback for subscription-backed quota and
rate-limit errors. Cross-cutting concerns live in the top-level
[`../../../ROADMAP.md`](../../../ROADMAP.md). For behavior, lifecycle,
public API, and invariants see [`README.md`](README.md).

Sibling extension roadmaps:

- [`../mmr-core/ROADMAP.md`](../mmr-core/ROADMAP.md)
- [`../mmr-toolbox/ROADMAP.md`](../mmr-toolbox/ROADMAP.md)
- [`../mmr-web/ROADMAP.md`](../mmr-web/ROADMAP.md)
- [`../mmr-subagents/ROADMAP.md`](../mmr-subagents/ROADMAP.md)
- [`../mmr-history/ROADMAP.md`](../mmr-history/ROADMAP.md)

## Current status

Shipped. Always loaded; effective only in interactive sessions while a
locked MMR mode is active.

- ✅ Quota/rate-limit classifier covering `openai-codex`,
  `claude-subscription`, `github-copilot`, and generic hard-quota /
  subscription-backed rate-limit text. Pure overload signals are
  intentionally treated as `not-quota`.
- ✅ Authenticated-candidate enumeration that ranks by the active mode's
  `modelPreferences`, drops the failing route, and surfaces a
  `Preference match:` candidate when a configured preference match exists.
- ✅ Per-candidate thinking-level enumeration derived from each model's
  `reasoning` flag and `thinkingLevelMap`.
- ✅ Two-step interactive picker (model, then thinking level) through
  Pi's `ctx.ui.select`.
- ✅ Model/thinking application under `mmr-core`'s
  `runMmrManagedModelUpdate(...)` guard so fallback selection does not
  trigger the native-control Free-mode opt-out.
- ✅ Mode-state republish with `modelFallbackApplied: true`,
  `modelFallbackReason`, and refreshed effective context window so
  `/mmr-status` reflects the fallback.
- ✅ Versioned persisted custom entry
  (`mmr-session-fallback.override`) plus a `cleared: true` variant for
  manual model/thinking overrides.
- ✅ Session-scoped lifecycle: new / forked sessions clear runtime and
  managed overrides; resumed sessions re-apply the override only when
  Pi's current state still matches the failing route; manual
  `model_select` / `thinking_level_select` outside the managed guard
  clears the override.
- ✅ Retry-message rewrite that flips Pi's assistant error into a
  `pi-mmr applied a session fallback ...` message so the current turn
  is retried through Pi's normal retry loop, preserving the original
  provider error message via the `Original error:` suffix.
- ✅ Package-root public exports from `pi-mmr`:
  `createMmrSessionFallbackExtension`, `classifyMmrSessionFallbackError`,
  `MMR_SESSION_FALLBACK_ENTRY`, `MMR_SESSION_FALLBACK_STATE_VERSION`,
  `parsePersistedMmrSessionFallbackOverride`,
  `toPersistedMmrSessionFallbackOverride`,
  `findLatestPersistedMmrSessionFallbackOverride`,
  `getMmrSessionFallbackOverrideSnapshot`, and the related types. The
  `pi-mmr/extensions/mmr-session-fallback` subpath remains the Pi extension
  entrypoint and is not a named-helper API.

Dependencies satisfied:

- `mmr-core` mode state, managed-model-update guard, status update, and
  thinking-level validation.

## Future considerations

These are candidate follow-ups, not committed work. Each would need its
own first-slice plan, deterministic tests, and an updated entry under
the top-level pre-publication safety check.

- Non-interactive fallback policy: a fail-soft or settings-driven
  default that picks the first preference-ranked authenticated
  candidate when `ctx.hasUI` is false (currently the extension is a
  strict no-op without a UI).
- Provider-specific classifier extensions for additional
  subscription-backed providers beyond the current `openai-codex`,
  `claude-subscription`, and `github-copilot` set.
- Optional retry-budget cap so a single session cannot chain through an
  unbounded sequence of fallback selections.
- Surfacing the active session-fallback override in `/mmr-status` as a
  first-class diagnostics row (today it is reflected only through
  `mmr-core`'s `modelFallbackApplied` / `modelFallbackReason`).
- `/mmr-session-fallback clear` command for explicit user-initiated
  clears that does not require a native `model_select` /
  `thinking_level_select`.

## Acceptance criteria for new fallback behavior

Anything that extends classification, candidate selection, application,
or persistence must:

- preserve the strict-no-op rules for non-interactive sessions,
  subagent workers, `free` mode, and non-quota error kinds;
- route every model/thinking mutation through
  `runMmrManagedModelUpdate(...)`;
- keep the persisted entry shape forward-compatible (bump
  `MMR_SESSION_FALLBACK_STATE_VERSION` when the wire shape changes and
  treat older entries as fail-closed-ignored on read);
- never re-apply a persisted override across a different `sessionId`
  or against a mode/route Pi is no longer reporting;
- keep the retry-message rewrite shape so Pi's normal retry loop still
  triggers; and
- ship deterministic tests under `tests/mmr-session-fallback-*.test.mjs`
  covering classifier inputs, candidate ranking, thinking enumeration,
  persisted-state parse/serialize, and the extension's
  `session_start` / `message_end` / `model_select` /
  `thinking_level_select` paths.
