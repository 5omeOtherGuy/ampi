# Tests

Deterministic test suite for `ampi`. Hermetic; no live provider/API calls from `npm test`.

Package overview: [`../README.md`](../README.md). Documentation conventions: [`../docs/documentation-style-guide.md`](../docs/documentation-style-guide.md).

## At a glance

| Default | Runner | Helpers | Fixtures |
| --- | --- | --- | --- |
| Hermetic, on every PR | `node --test tests/*.test.mjs` | `tests/helpers/` | `tests/fixtures/` |

## Running

```bash
npm test          # node --test tests/*.test.mjs
npm run test:cov  # with V8 coverage to stdout
```

## How tests load source

Tests do not import from `src/`. They go through [`helpers/load-src.mjs`](helpers/load-src.mjs):

1. Disposable copy of `src/` under `.test-src/` (or `PI_MMR_TESTS_TMP` when set). Coverage runs (`PI_MMR_KEEP_PREPARED_SRC=1`) share a deterministic prepared root for V8 aggregation; normal runs use per-run directories cleaned up in `after(...)`.
2. Rewrite `.js` import suffixes to `.ts` so Node's experimental type-stripping runs the TypeScript sources without a build step.
3. Symlink `node_modules` so peer deps (`typebox`, `pi-coding-agent`) resolve identically to the published shape.

Two import patterns coexist intentionally — see the helper header for details:

- **`importSource(relativePath)`** — cache-busts via a unique `?ts-rand` query, returning a fresh module per call. Default. Also simulates Pi's multi-loader behavior where two extensions get distinct module caches (`mmr-web-runtime.test.mjs`, `mmr-core-tools.test.mjs`).
- **`importRuntime()`** (defined locally where needed) — stable URL so the runtime singleton survives across imports. Tests using this MUST reset module-level state in `beforeEach`:
  ```js
  runtime.setMmrModeState(undefined);
  // and for identity-aware suites:
  runtime.setMmrSessionIdentity(undefined);
  ```

## Fixtures

- [`fixtures/mmr-core-prompts/`](fixtures/mmr-core-prompts) — prompt assembly baselines.
- [`fixtures/mmr-effective-surface/`](fixtures/mmr-effective-surface) — one fixture per user-facing mode × extension combination (e.g. `medium.core-only.md`, `medium.core+subagents.md`).
- [`fixtures/mmr-subagent-surface/`](fixtures/mmr-subagent-surface) — one fixture per shipped subagent surface (`finder.md`, `oracle.md`, `task.md`, `librarian-local-mvp.md`), capturing the assembled subagent system prompt + profile-filtered active tool manifest.

Update workflow: rerun the relevant fixture test with `PI_MMR_UPDATE_FIXTURES=1` to regenerate snapshots, review the diff before committing. Without that env var, fixture drift fails the test with the offending file path.

## Shared helpers

- [`helpers/load-src.mjs`](helpers/load-src.mjs) — source loader (above).
- [`helpers/pi-stub.mjs`](helpers/pi-stub.mjs) — `createMockPi()` and `createMockExtensionContext()` with recorders for every observable side effect (tools, commands, shortcuts, flag definitions, event handlers, emits, ui notify/setStatus/etc.). `createMockPi` is the single source of truth for Pi-host fakes; pass `flags`, `shortcutsThrowOn`, `activeTools`, `allTools`, `onModelSet`, etc. as options rather than re-rolling a per-file stub. Recorders are exposed both on the returned tuple (`{ pi, tools, commands, shortcuts, flagDefs, handlers, ... }`) and as own properties of `pi` (`pi.tools.get(name)`, `pi.flagDefs.get(name)`, ...).
- [`helpers/apply-patch.mjs`](helpers/apply-patch.mjs) — `makeCtx()` (minimal ExtensionContext slice apply-patch reads from) and `patch()` (Codex-format patch-text builder). The Pi-host fake formerly here (`makeMockPi`) was removed; use `createMockPi()`.
- [`helpers/footer.mjs`](helpers/footer.mjs) — `expectFooterLine()` matcher for status-bar/footer assertions.

## Coverage map

Coverage spans every shipped extension and the public package surface. Locate tests by `tests/<extension>-<topic>.test.mjs`:

- **[`ampi-core`](../src/extensions/ampi-core/README.md)** — activation, auto-compact, builtin tool guidance, changelog, config writer, contracts (public surface, frozen-state semantics, negative exports), feature gates, free-mode (locked → free, source-aware ownership), internal JSON guard, lifecycle, model resolver, modes, phase-F effective-surface matrix, opt-in Pi smoke (`PI_MMR_REAL_PI=1`), planned catalog, prompt (assembly, baselines, debug renderer, templates, fixtures, Pi-authored passthrough), provider-managed context, public-safety lint, `before_provider_request` integration, request policy (Anthropic adaptive, OpenAI Responses, Codex variant), routing, runtime singleton + shape guard, session identity, settings (project-over-global override, warnings), shortcuts, state schema, status / debug, subagent (CLI flags, profiles, resolver, activation, activation-failure marker, prompt assembly, runner contract), tool-params helper, tool registry / resolver decisions.
- **[`ampi-session-fallback`](../src/extensions/ampi-session-fallback/README.md)** — classifier, extension trigger/apply/persist/retry/lifecycle, package export surface, persisted-state schema, per-model thinking-level options.
- **[`ampi-toolbox`](../src/extensions/ampi-toolbox/README.md)** (deprecated shim; the covered tools now live in `ampi-patch` / `ampi-tasks`) — scaffold (package.json, factory loadable), apply-patch (registration + description/guideline cues, parser, behavior + error paths + multi-file atomicity, worktree boundary defenses, result shape + diff payload), todo-list (tool schema/validation/prompt/widget/whole-list replacement/CustomEntry persistence, session isolation, no legacy workspace-store hydration/watcher).
- **[`ampi-web`](../src/extensions/ampi-web/README.md)** — backend resolver + active-backend details, Brave search + custom reader with injected `fetchImpl`, config parsing + env/file merge precedence, `/mmr-config web` writer allowlist + validation, DuckDuckGo (parsing, cache, backoff, URL decoding), excerpt selection + final cap, package wiring, feature-gate + tool-provider behavior, Readability + Turndown Markdown pipeline + fallback, mode-aware enable/disable + cache-isolated module pairs, SearXNG (normalization + JSON-output diagnostics; managed sidecar spawn/health/idle/shutdown), tools (`web_search` / `read_web_page` definitions + execute paths), URL/SSRF policy (loopback, private IPv4/IPv6, NAT64, IPv4-mapped, multicast, non-default ports).
- **[`ampi-workers`](../src/extensions/ampi-workers/README.md)** — subagent effective-surface fixtures, shared worker outcome classifier, custom-loader (Markdown discovery/parser framework), extension wiring + factory shape + concrete-tool registration + fixture coverage, finder (tool behavior + extension + fixture), librarian (gating, invocation, prompt, statuses, export surface), oracle (params, attachment handling, routing, output), progress rendering (call/result/trail), prompts (concrete builders), provider (exact-name + feature-gate), runner (child CLI, interface adapter, subagent-activation integration), Task (params, resolver, prompt assembly, statuses, worker invocation).
- **[`ampi-history`](../src/extensions/ampi-history/README.md)** — global catalog + query DSL + per-session `file:` / `repo:` + projectRef + redaction; catalog/index/read-session internal edge cases; history tool TUI rendering; deterministic sanitizer pattern coverage; history-reader worker-first path + lexical fallback.
- **Package / root / release** — package metadata + extension registration shape; package-root todo export guard; changelog-sync helper.

When adding a new subagent, order coverage so the profile stays the source of truth and a concrete tool cannot invent its own policy outside the framework:

1. Profile contract — `mmr-core-subagent-profiles.test.mjs` (registry shape, frozen invariants, allowlist).
2. Route resolution — `mmr-core-subagent-resolve.test.mjs` (pure resolver, fail-closed diagnostics).
3. Prompt assembly — `mmr-core-subagent-prompt-assembly.test.mjs` + a new `fixtures/mmr-subagent-surface/<name>.md` covering the assembled prompt + profile-filtered manifest.
4. Runner/tool behavior — `mmr-subagents-<name>*.test.mjs` for wiring, `execute()` output shaping, runner integration through `runMmrSubagentWorker({ profileName: "<name>", ... })`.

## Conventions

- Behavior-focused: assert through public module/extension surfaces, not private internals.
- Deterministic: filesystem fixtures under `mkdtempSync` / `.test-src`; env vars saved/restored via `try/finally`; network replaced with injected `fetchImpl`.
- No live network and no `pi` binary requirement from `npm test`. Explicit opt-ins: `mmr-core-pi-integration.test.mjs` requires `PI_MMR_REAL_PI=1`; scripts under `tests/smoke/` spawn real Pi workers and may make live provider/network calls when run manually.
- New tests using the runtime singleton must reset state in `beforeEach`.
