# ampi-history roadmap

## Shipped

- Feature-gated local session lookup tools (`find_session`, `read_session`) behind the single `AMPI_HISTORY_ENABLE` env gate (legacy `MMR_HISTORY_ENABLE` still accepted).
- Global enumeration of every encoded-cwd directory under `~/.pi/agent/sessions/`, with dedup by session id (newest mtime wins) and per-session lazy enrichment for the `file:` filter.
- Worker-first `read_session` through the in-process `history-reader` subagent (`tools: []`), with deterministic lexical fallback on worker failure, missing route, cancellation, empty output, runner exception, or packet over the cap.
- Deterministic redaction sanitizer applied to every string field that leaves the catalog: Pi-session paths, home dirs, other absolute paths, PEM private-key blocks, Authorization headers, JWT triples, provider-prefixed tokens, env-style key=value pairs, URL userinfo, and the local OS username. Idempotent.
- Opaque per-project `projectRef` (8-character sha256 hex of the canonical cwd) on every result instead of raw cwd or session file path.
- `file:<partial-path>` filter evaluated per session against its own cwd-relative structured tool-call evidence.
- `repo:<value>` filter evaluated per session against its own git remote identity (alias set: `host/owner/repo`, `owner/repo`, credential-stripped URL).
- `queryDiagnostics` surface on `find_session` results (`applied` / `unsupported` / `non_applicable`). `non_applicable` for `repo:` only fires when no candidate session has a resolvable remote; for `file:` only when no candidate carries structured tool-call evidence.

## Deferred

- Persistent on-disk session index across the global catalog (tracked in [#64](https://github.com/5omeOtherGuy/ampi/issues/64)).
- `handoff` session creation.
- Cross-machine session sharing or remote session stores.
- Allowlisting `custom_message` / `extension` entries in the worker packet for power users.

## Unsupported

- `ref:<name>` — no Pi-native authoritative source for historical git refs; reported via `queryDiagnostics`.
- `author:<name>` / `author:me` — Pi sessions carry no author field; OS-username inference is not honest and is privacy-sensitive; reported via `queryDiagnostics`.
- `task:<id>` (incl. `+`, `^`, `+^`) — current `task_list` state has no stable IDs or dependency graph; reported via `queryDiagnostics`.
