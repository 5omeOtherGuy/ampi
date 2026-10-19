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

The `ampi` command in `packages/ampi-cli/` is plain JavaScript, so `tests/mmr-cli-*.test.mjs` import its modules directly and spawn `packages/ampi-cli/bin/ampi.js` for help, version and usage errors, which never start Pi. `mmr-cli-execute.test.mjs` also spawns it in execute mode against the installed Pi, offline, in a temporary home and agent directory, with the scripted model in `fixtures/ampi-cli/faux-model/` (its own package, so the command still loads ampi itself). `mmr-cli-stream-json.test.mjs` checks the `--stream-json` records made from hand-written Pi event sequences and from spawned runs with the same scripted model, each against the schema in `fixtures/ampi-cli/stream-json.schema.json`. `mmr-cli-stream-json-input.test.mjs` checks how `--stream-json-input` reads stdin lines and drives Pi's RPC mode, and spawns runs that write stdin line by line; a steering message releases a `bash` call of the scripted model that waits on a FIFO, so no test sleeps. `mmr-cli-threads.test.mjs` runs the thread commands against a temporary agent directory whose sessions it writes through Pi's `SessionManager` on a mocked clock, checks the thread index file against ampi-threads' own store, and renders `fixtures/ampi-threads-markdown/` like ampi-threads does. `mmr-cli-config.test.mjs` checks the commands `src/config-keymap.ts` builds against those ampi-tui and ampi-threads register in a mocked terminal session, and spawns `ampi config keymap` against the hand-written `fixtures/ampi-cli/keymap-settings.json`, comparing the output with `fixtures/ampi-cli/config-keymap.jsonc` (`PI_MMR_UPDATE_FIXTURES=1` rewrites it); `ampi config edit` runs a fake editor that records its arguments. `mmr-cli-tools.test.mjs` checks the `ampi tools` listing and detail formats against hand-written tool infos, and spawns `ampi tools` in every mode with the scripted model, comparing the tools with ampi-core's mode tables; `fixtures/ampi-cli/offline-guard.mjs`, preloaded with `node --import`, refuses network access and records the child processes. `mmr-cli-skill.test.mjs` runs `ampi skill` in-process against the installed Pi, with a stand-in ampi package, temporary home, agent and project directories and, for git sources, bare repositories in a temporary directory cloned through `file://` URLs (skipped when git is missing); it also checks that `src/skill-sources.js` classifies a fixture set of skills as ampi-core's `skill-sources.ts` does. `mmr-cli-mcp.test.mjs` checks how `ampi mcp` translates each command line onto `pi mcp`, and runs `add`, `list`, `doctor`, `approve` and `oauth status` against the installed Pi as a child process, offline, in temporary home, agent and project directories, with `fixtures/ampi-cli/mcp-echo-server.mjs` as a local stdio MCP server. `mmr-cli-pi-compat.test.mjs` calls the real Pi package against a temporary agent directory, to catch changes in the undocumented Pi calls the command relies on, and builds a session through `sdk-session.js` with a stand-in ampi package.

## Fixtures

- [`fixtures/mmr-core-prompts/`](fixtures/mmr-core-prompts) — prompt assembly baselines.
- [`fixtures/mmr-effective-surface/`](fixtures/mmr-effective-surface) — one fixture per user-facing mode × extension combination (e.g. `medium.core-only.md`, `medium.core+subagents.md`).
- [`fixtures/mmr-subagent-surface/`](fixtures/mmr-subagent-surface) — one fixture per shipped subagent surface (`finder.md`, `oracle.md`, `task.md`, `librarian-local-mvp.md`), capturing the assembled subagent system prompt + profile-filtered active tool manifest.
- [`fixtures/mmr-tui-tool-rows/`](fixtures/mmr-tui-tool-rows) — transcript tool rows at 80 and 140 columns, collapsed and expanded, as plain text.
- [`fixtures/mmr-tui-tool-groups/`](fixtures/mmr-tui-tool-groups) — runs of tool calls folded into one summary row at 80 and 140 columns, collapsed and expanded, running and finished, as plain text.
- [`fixtures/mmr-tui-queue/`](fixtures/mmr-tui-queue) — the box of queued messages above the prompt at 80 and 140 columns, as plain text and with ANSI kept.
- [`fixtures/ampi-threads-markdown/`](fixtures/ampi-threads-markdown) — a Pi session file with branches, tool calls, a shell command and an image, and its hand-written Markdown export.
- [`fixtures/ampi-cli/`](fixtures/ampi-cli) — `ampi --help` output, the JSON Schema of a `--stream-json` record, `faux-model/`, a test-only Pi extension with a scripted offline model (`faux/faux-1`), `offline-guard.mjs`, a preload that refuses network access and records child processes, and `mcp-echo-server.mjs`, a stdio MCP server with one `echo` tool.

Update workflow: rerun the relevant fixture test with `PI_MMR_UPDATE_FIXTURES=1` to regenerate snapshots, review the diff before committing. Without that env var, fixture drift fails the test with the offending file path.

## Shared helpers

- [`helpers/load-src.mjs`](helpers/load-src.mjs) — source loader (above).
- [`helpers/pi-stub.mjs`](helpers/pi-stub.mjs) — `createMockPi()` and `createMockExtensionContext()` with recorders for every observable side effect (tools, commands, shortcuts, flag definitions, event handlers, emits, ui notify/setStatus/etc.). `createMockPi` is the single source of truth for Pi-host fakes; pass `flags`, `shortcutsThrowOn`, `activeTools`, `allTools`, `onModelSet`, etc. as options rather than re-rolling a per-file stub. Recorders are exposed both on the returned tuple (`{ pi, tools, commands, shortcuts, flagDefs, handlers, ... }`) and as own properties of `pi` (`pi.tools.get(name)`, `pi.flagDefs.get(name)`, ...).
- [`helpers/apply-patch.mjs`](helpers/apply-patch.mjs) — `makeCtx()` (minimal ExtensionContext slice apply-patch reads from) and `patch()` (Codex-format patch-text builder). The Pi-host fake formerly here (`makeMockPi`) was removed; use `createMockPi()`.
- [`helpers/footer.mjs`](helpers/footer.mjs) — `expectFooterLine()` matcher for status-bar/footer assertions.
- [`helpers/animation-env.mjs`](helpers/animation-env.mjs) — `isolateAnimationEnv()` runs a suite that asserts spinners or other animations without `NO_ANIMATION` and with an empty home directory, so a developer's own settings cannot still them; `setNoAnimation(t)` sets `NO_ANIMATION` for one test and restores the earlier value.

## Coverage map

Coverage spans every shipped extension and the public package surface. Locate tests by `tests/<extension>-<topic>.test.mjs`:

- **[`ampi-core`](../src/extensions/ampi-core/README.md)** — activation, auto-compact, builtin tool guidance, changelog, config writer, contracts (public surface, frozen-state semantics, negative exports), feature gates, free-mode (locked → free, source-aware ownership), internal JSON guard, lifecycle, model resolver, modes, phase-F effective-surface matrix, opt-in Pi smoke (`PI_MMR_REAL_PI=1`), planned catalog, prompt (assembly, baselines, debug renderer, templates, fixtures, Pi-authored passthrough), provider-managed context, public-safety lint, `before_provider_request` integration, request policy (Anthropic adaptive, OpenAI Responses, Codex variant), routing, runtime singleton + shape guard, session catalogue (Pi session source), session identity, settings (project-over-global override, warnings), turning tools off (`ampi.tools.disable`, with a probe of the tool sources the installed Pi reports), skill folders (`.claude/skills`, `ampi.skills.path`, checked against the installed Pi's skill loader), guidance from subfolders (the `AGENTS.md` files a `read` below the working directory adds, once per folder per session branch, checked against the installed Pi's context-file loader), shortcuts, state schema, status / debug, subagent (CLI flags, profiles, resolver, activation, activation-failure marker, prompt assembly, runner contract), tool-params helper, tool registry / resolver decisions.
- **[`ampi-session-fallback`](../src/extensions/ampi-session-fallback/README.md)** — classifier, extension trigger/apply/persist/retry/lifecycle, package export surface, persisted-state schema, per-model thinking-level options.
- **[`ampi-toolbox`](../src/extensions/ampi-toolbox/README.md)** (deprecated shim; the covered tools now live in `ampi-patch` / `ampi-tasks`) — scaffold (package.json, factory loadable), apply-patch (registration + description/guideline cues, parser, behavior + error paths + multi-file atomicity, worktree boundary defenses, result shape + diff payload), todo-list (tool schema/validation/prompt/widget/whole-list replacement/CustomEntry persistence, session isolation, no legacy workspace-store hydration/watcher).
- **[`ampi-web`](../src/extensions/ampi-web/README.md)** — backend resolver + active-backend details, Brave search + custom reader with injected `fetchImpl`, config parsing + env/file merge precedence, `/mmr-config web` writer allowlist + validation, DuckDuckGo (parsing, cache, backoff, URL decoding), excerpt selection + final cap, package wiring, feature-gate + tool-provider behavior, Readability + Turndown Markdown pipeline + fallback, mode-aware enable/disable + cache-isolated module pairs, SearXNG (normalization + JSON-output diagnostics; managed sidecar spawn/health/idle/shutdown), tools (`web_search` / `read_web_page` definitions + execute paths), URL/SSRF policy (loopback, private IPv4/IPv6, NAT64, IPv4-mapped, multicast, non-default ports).
- **[`ampi-workers`](../src/extensions/ampi-workers/README.md)** — subagent effective-surface fixtures, shared worker outcome classifier, custom-loader (Markdown discovery/parser framework), extension wiring + factory shape + concrete-tool registration + fixture coverage, finder (tool behavior + extension + fixture), librarian (gating, invocation, prompt, statuses, export surface), oracle (params, attachment handling, routing, output), progress rendering (call/result/trail), prompts (concrete builders), provider (exact-name + feature-gate), review checks (discovery, changed files, check runs, Jujutsu), runner (child CLI, interface adapter, subagent-activation integration), Task (params, resolver, prompt assembly, statuses, worker invocation).
- **[`ampi-history`](../src/extensions/ampi-history/README.md)** — global catalog + query DSL + per-session `file:` / `repo:` + projectRef + redaction; catalog/index/read-session internal edge cases; history tool TUI rendering; deterministic sanitizer pattern coverage; history-reader worker-first path + lexical fallback.
- **Package / root / release** — package metadata + extension registration shape; package-root todo export guard.

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
