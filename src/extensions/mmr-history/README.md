# mmr-history

Opt-in extension that lets the agent search and read prior local Pi sessions across every project on disk, with deterministic redaction and a model-backed reader.

Package overview: [`../../../README.md`](../../../README.md). Public API: [`../../../docs/public-api.md`](../../../docs/public-api.md). Documentation conventions: [`../../../docs/documentation-style-guide.md`](../../../docs/documentation-style-guide.md).

## At a glance

| Default | Provides | Requires | Diagnostics |
| --- | --- | --- | --- |
| Off | `find_session`, `read_session` | `MMR_HISTORY_ENABLE=true` | `/mmr-status`, tool result `details` |

## When to use it

- The agent needs to recall a previous Pi session's plan, decision, or implementation across any project.
- You want to point the agent at a session by id or short prefix and have it extract goal-relevant content.
- You explicitly want global, deterministic, redacted lookup of local Pi history — not a live network search.

## Status and enablement

Set `MMR_HISTORY_ENABLE=true` to register both tools. Optional caps:

- `MMR_HISTORY_MAX_RESULTS` — default 10, capped at 20.
- `MMR_HISTORY_MAX_EXCERPT_BYTES` — default 24,000, capped at 100,000.

When enabled, the catalog enumerates every encoded-cwd directory under `~/.pi/agent/sessions/`. Results never surface raw session paths or cwds; matches use the Pi session id and an opaque 8-character `projectRef` hash.

## Tools

### `find_session(query, limit?)`

Newest-first matches across every local Pi session.

`details`: `{ query, resultCount, scope: "all_sessions", matches: [{ sessionId, projectRef, name?, createdAt, modifiedAt, messageCount, firstMessage, preview, matchedTerms, unsupportedFilters }], queryDiagnostics: [{ filter, status, reason? }] }`.

### `read_session(sessionId, goal, model?)`

Opens one session by exact id, `@id`, or unique id prefix and asks the in-process `history-reader` subagent to extract content for `goal`. Falls back to deterministic lexical extraction if the worker cannot run. Ambiguous prefixes fail closed and list candidate ids. The optional `model` is validated against authenticated registered routes; an unusable route falls back to lexical rather than silently routing.

`details`: `{ scope, projectRef, sessionId, name?, messageCount, excerptCount, truncated, matchedTerms, excerpts, analysisUsed, analysisFallbackReason?, worker?, warnings? }`.

## Behavior

### Query DSL

`find_session` accepts:

- bare keywords / quoted phrases;
- `id:<prefix>`, `name:<text>`;
- date filters: `after:` / `since:` / `before:` / `until:` (modified time), plus `modified_after:`, `modified_before:`, `created_after:`, `created_before:`. Values accept `YYYY-MM-DD`, `7d`, `2w`, `today`, `yesterday`, `week`, and `month`;
- `file:<partial-path>` — per-session match against that session's own cwd-relative structured tool-call evidence (`read`, `edit`, `write`, `apply_patch`). Bash output, prose, and `grep`/`find` search-directory args are never inspected;
- `repo:<host/owner/repo | owner/repo | stripped remote URL>` — each session's own canonicalized git remote;
- `project:<cwd-substring-or-projectRef>`, `cwd:<cwd-substring>`, `projectRef:<opaque-ref>` — matched internally, while raw project roots stay hidden from results;
- structured metadata filters: `provider:<value>`, `model:<value>`, `tool:<name>`, `label:<value>`, `has:tools`, `has:errors`;
- pagination/sorting: `offset:<n>`, `sort:modified`, `sort:created`.

Case-insensitive; repeated filters combine with implicit AND. Each result carries per-filter `queryDiagnostics`:

| Status | Meaning |
| --- | --- |
| `applied` | Evaluated against session data. |
| `unsupported` | Syntax recognized but not implemented (`ref:`, `author:`, `task:`, …). |
| `non_applicable` | Implemented but no candidate session can be evaluated (e.g. `repo:` with no resolvable remotes). Returns zero matches plus the diagnostic; never silently broadens. |
| `invalid` | A date/offset/sort/has filter value did not parse. The filter is ignored and the token is surfaced as `Invalid filters ignored: …` instead of being dropped silently. |

### Worker-first read with lexical fallback

`read_session` always tries the `history-reader` subagent first. It runs in-process with `tools: []` and receives a sanitized session packet. Model selection: per-call `model` → `mmrCore.subagentModelPreferences["history-reader"]` → profile defaults (`antigravity/gemini-3.5-flash-extra-low` → `gpt-5.4-mini` → `claude-haiku-4-5`, minimal thinking). Packet entry-type allowlist: `message`, `compaction`, `branch_summary`, `session_info`; `custom`, `custom_message`, and `extension` entries are dropped.

Lexical extraction takes over when the worker route is unauthenticated, missing, cancelled, returns empty, never starts the agent loop, exits nonzero, hits the packet cap, or the runner throws. Fallback runs every excerpt through the same sanitizer and sets `analysisUsed: "lexical"` plus a redacted `analysisFallbackReason`.

## Safety and privacy

When content redaction is opted in (`MMR_HISTORY_REDACT=true`), string fields that leave the catalog (worker packet, lexical output, `find_session` previews / names / first-messages, diagnostics) pass through a shared deterministic and idempotent sanitizer. Raw project roots are always protected: result matches expose only `projectRef`, and `project:` / `cwd:` query echoes are redacted even when content redaction is off.

- **Paths.** Pi-session JSONL → `[pi-session]`; other `~/.pi/...` → `[pi-data]`; `/home/<user>`, `/Users/<user>`, `C:\Users\<user>` → `[home]`; other absolute paths → `[abs-path]/<basename>`.
- **Secrets.** PEM blocks → `[pem]`; Authorization headers and `authorization=` → `[redacted]`; JWT triples → `[jwt]`; provider tokens (`sk-…`, `sk-ant-…`, `ghp_…`, `gho_…`, `AIza…`, `jina_…`, `xoxb-…`, `xoxa-…`, AWS keys, Slack webhooks) → `[token]`; env-style `KEY=value` where key matches `token|secret|password|api_key|cookie` → `KEY=[redacted]`; URL userinfo → `scheme://[redacted]@host`.
- **Identity.** Emails → `[email]`; IPv4/IPv6 → `[ip]`; OS username (via `os.userInfo()`) outside already-handled `/home/<user>` paths → `[user]`.
- **Repo / project.** Raw cwds never leave; each match carries an opaque 8-character `projectRef` hash instead.

There is no per-project consent prompt. Content redaction is off by default for local same-user recovery; set `MMR_HISTORY_REDACT=true` when packet/result content should be sanitized before leaving the local catalog.

## Diagnostics and troubleshooting

- **Tools are `missing` in `/mmr-status`.** `MMR_HISTORY_ENABLE` is unset; nothing is registered.
- **`read_session` returned a lexical excerpt with `analysisFallbackReason`.** The worker route was unauthenticated, missing, cancelled, exited nonzero, or hit the packet cap; the lexical path ran instead. The reason is redacted by the same sanitizer.
- **`find_session` returned zero matches with `non_applicable` diagnostics.** The filter was applicable in syntax but no candidate session carried the underlying data (e.g. `repo:` without resolvable remotes). Reformulate the query.
- **Ambiguous prefix for `read_session`.** Multiple sessions share the same `id:` prefix; the tool fails closed and lists candidate ids. Pass the full id.

## Public API

Re-exported from `ampi`: `createMmrHistoryExtension`, `MMR_HISTORY_TOOL_NAMES`, history tool/details types. Canonical catalog: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## Developer notes

- `MMR_HISTORY_MODEL_ANALYSIS_ENABLE` is gone. The legacy `threadID` request alias and `analysis` parameter are accepted with a soft deprecation warning in `details.warnings`. `currentProjectOnly: true` is replaced by `scope: "all_sessions"`.
- Global enumeration walks `~/.pi/agent/sessions/` behind a 10 s in-process TTL cache; per-session touched-file and metadata enrichment is cached by `id|modified|messageCount|path|cwd`. No persistent on-disk index, no filesystem watchers, no cross-process cache, no workspace state, no network sync. Persistent-index follow-up: [#64](https://github.com/5omeOtherGuy/ampi/issues/64).
- Tests: `tests/mmr-history*.test.mjs`.
