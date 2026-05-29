# mmr-session-fallback

Session-scoped quota-fallback extension. When the active locked-mode route reports a quota or rate-limit error from a subscription-backed provider, it prompts the user to pick a fallback model + thinking level, applies the selection through `mmr-core`'s managed-model-update guard, persists a session-scoped override, and rewrites Pi's error so the current turn retries through Pi's normal retry loop.

Package overview: [`../../../README.md`](../../../README.md). Planning: [`ROADMAP.md`](ROADMAP.md). Public API: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## At a glance

| Default | Provides | Requires | Diagnostics |
| --- | --- | --- | --- |
| On | Interactive quota fallback prompt + session-scoped override | none | `/mmr-status` (`Model fallback:`), session-log custom entries |

## When to use it

- The active subscription-backed route hit a usage limit / hard quota / hard rate-limit and you want to keep the turn alive on a different registered model.
- You want fallback selections to stick for the current session and clear automatically on new or forked sessions.
- You do not want pure overload errors to silently switch your model.

## Status and enablement

Always loaded. No-op unless **all** of: locked MMR mode active (not `free`), no subagent worker running, no fallback prompt already in flight, and no override already applied for the current session. Otherwise Pi's native error handling runs unchanged.

## Behavior

### Trigger

Listens on `message_end`. Activates when the assistant turn stops with `stopReason: "error"` and the error is classified as quota/hard rate-limit by [`classifier.ts`](classifier.ts):

| Provider                     | Detected kind          | Pattern                                                                |
| ---------------------------- | ---------------------- | ---------------------------------------------------------------------- |
| `openai-codex`               | `openai-usage-limit`   | ChatGPT usage-limit text, generic rate-limit text, or hard-quota text  |
| `claude-subscription`        | `anthropic-rate-limit` | rate-limit or hard-quota text                                          |
| `github-copilot`             | `copilot-quota`        | rate-limit or hard-quota text                                          |
| any provider                 | `generic-hard-quota`   | explicit hard-quota text (`usage limit reached`, `quota exceeded`, …)  |
| subscription-backed provider | `generic-hard-quota`   | rate-limit text on a subscription-backed route                         |
| anything else                | `not-quota`            | no-op                                                                  |

Pure overload errors without a rate-limit/quota signature are treated as `not-quota` and flow through Pi's normal retry/backoff.

### Candidates

From Pi's registered model registry ([`candidates.ts`](candidates.ts)):

- drop the failing `provider/model`;
- drop any model without configured auth (`hasConfiguredAuth`);
- dedup by `provider/model`;
- rank by active mode's `modelPreferences` order, then provider, then model id;
- mark the highest-ranked preference match as `Suggested`.

Per-candidate thinking levels come from each model's `reasoning` flag ([`thinking.ts`](thinking.ts)): non-reasoning models surface `off` only; reasoning models surface `off, minimal, low, medium, high`, plus `xhigh` when the model declares it. When no authenticated candidate remains the user is notified and the turn fails closed.

### Apply, persist, retry

After the user picks ([`ui.ts`](ui.ts)):

- `pi.setModel(...)` and `pi.setThinkingLevel(...)` are called inside `runMmrManagedModelUpdate(...)` so `mmr-core`'s native-control Free-mode opt-out is not triggered.
- `setMmrManagedModelOverride({ kind: "session-fallback", ... })` records the override on the `mmr-core` runtime.
- `mmr-core`'s mode-state snapshot is republished with `modelFallbackApplied: true`, `modelFallbackReason`, new `provider`/`model`/`thinkingLevel`, and refreshed `effectiveContextWindow`, so `/mmr-status` reflects the fallback.
- A `mmr-session-fallback.override` custom session entry is appended ([`state.ts`](state.ts)) keyed to `sessionId`: `{ version, sessionId, mode, failingProvider, failingModel, selectedProvider, selectedModel, thinkingLevel, reasonKind, appliedAt }`. A `cleared: true` variant records explicit clears.
- Pi's `message_end` payload is rewritten ([`retry-message.ts`](retry-message.ts)) to keep `stopReason: "error"` but replace `errorMessage` with `rate limit: pi-mmr applied a session fallback to <provider>/<model> with thinking:<level>. Retrying this turn with the selected model. Original error: <original>`. Pi's retry loop reacts and replays the turn.

### Session lifecycle

| Event                                          | Behavior                                                                                                                                                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_start` (`new` / `fork`)               | Clear in-process override and any `mmr-core` managed-model override.                                                                                                                                                  |
| `session_start` (`resume`)                     | Look up the latest persisted override for this `sessionId` and re-apply through `runMmrManagedModelUpdate(...)` **only when** Pi's current state still matches the failing `provider/model`. Non-matching state is ignored. |
| `model_select` outside managed guard           | Clear the override. Pi restore events (`event.source === "restore"`) are ignored. A `cleared` entry is appended only when there was actually something to clear.                                                       |
| `thinking_level_select` outside managed guard  | Same as manual `model_select`; Pi does not emit a restore source for thinking, so the managed guard is the only signal.                                                                                                |
| Inside subagent workers                        | `session_start` and `message_end` exit early when `getMmrSubagentState()` is set; subagent runs never trigger or inherit fallback overrides.                                                                          |

## Diagnostics and troubleshooting

- **Fallback did not trigger.** Error was not classified as quota/rate-limit, the run is inside a subagent worker, the mode is `free`, or a prompt/override is already active for this session. Check `/mmr-status` for `Model fallback:` and inspect the original error against the classifier table above.
- **Override did not survive resume.** Persisted entries re-apply only when Pi's reported provider/model still matches the failing route. A different active model on resume is treated as a deliberate user choice and ignored.
- **`/model` or `/think` did not stick.** Manual model/thinking selections outside the managed guard clear any active fallback. Re-pick the fallback after manual changes.

## Public API

Re-exported from `pi-mmr`. The `pi-mmr/extensions/mmr-session-fallback` subpath exposes the extension factory entrypoint only.

- `createMmrSessionFallbackExtension()` — Pi extension factory.
- `classifyMmrSessionFallbackError(input)` — pure classifier.
- `MMR_SESSION_FALLBACK_ENTRY`, `MMR_SESSION_FALLBACK_STATE_VERSION` — persisted-entry constants.
- `parsePersistedMmrSessionFallbackOverride`, `toPersistedMmrSessionFallbackOverride`, `findLatestPersistedMmrSessionFallbackOverride` — persisted-state helpers.
- `getMmrSessionFallbackOverrideSnapshot(sessionId?)` — in-process snapshot.
- Types: `MmrSessionFallbackErrorClassification`, `MmrSessionFallbackQuotaKind`, `PersistedMmrSessionFallbackOverride`.

Canonical catalog: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## Developer notes

- Strict no-op outside interactive sessions (`ctx.hasUI === false`), inside subagent workers, in `free` mode, and for non-quota classifications.
- Every model/thinking mutation goes through `runMmrManagedModelUpdate(...)` so the native-control Free-mode opt-out is not triggered.
- Persisted entries use the dedicated entry type and a versioned schema; malformed/older entries return `undefined` from parse helpers.
- Overrides are session-scoped: re-applied only when the resuming session id matches and Pi reports the same failing route. New/forked sessions never inherit.
- Manual `model_select` / `thinking_level_select` outside the guard clears any active override; clear-entry persistence is best-effort and skipped when there is nothing to clear. Pi restore events are ignored.
- The retry message preserves the original error via `Original error:` so debug surfaces still see it.
- Tests: `tests/mmr-session-fallback*.test.mjs`.
