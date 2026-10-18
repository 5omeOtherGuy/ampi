# ampi repository map

`ampi` is a Pi package containing modular multi-model-routing extensions. The package registers fourteen extensions: `ampi-core`, `ampi-session-fallback`, `ampi-patch`, `ampi-shell`, `ampi-tasks`, `ampi-web`, `ampi-github`, `ampi-workers`, `ampi-custom-subagents`, `ampi-permissions`, `ampi-tui`, `ampi-threads`, `ampi-gui`, and `ampi-history`. Two further directories ship in source but are not registered in `pi.extensions`: `ampi-toolbox` (a deprecated compatibility shim) and `ampi-debug` (a developer-only capture extension excluded from the published package).

## Top-level files

| Path | Purpose |
| --- | --- |
| [`README.md`](README.md) | User-facing landing page, quick start, mode/tool chooser, safety, troubleshooting, docs links. |
| [`docs/README.md`](docs/README.md) | User-facing documentation homepage. |
| [`docs/quick-reference.md`](docs/quick-reference.md) | Compact mode, tool, gate, and troubleshooting reference. |
| [`INDEX.md`](INDEX.md) | Quick navigation index for docs, source entry points, tests, and contributor guidance. |
| [`CHANGELOG.md`](CHANGELOG.md) | Notable changes and release notes. |
| [`ROADMAP.md`](ROADMAP.md) | Package-level roadmap and release checklist. |
| [`REPOMAP.md`](REPOMAP.md) | This repository structure and ownership map. |
| [`package.json`](package.json) | Package metadata, Pi extension registration, export map, and npm scripts. |
| [`package-lock.json`](package-lock.json) | Locked dependency graph. |
| [`packages/ampi-cli/`](packages/ampi-cli/README.md) | The `@skippermissions/ampi-cli` package: the `ampi` command. |
| [`tsconfig.json`](tsconfig.json) | TypeScript strict-mode configuration. |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Human contributor workflow. |
| [`AGENTS.md`](AGENTS.md) | Coding-agent profile, landing workflow, and repository rules. |

## Package registration

`package.json` declares Pi extensions under `pi.extensions`, in load order:

```json
[
  "./src/extensions/ampi-core/index.ts",
  "./src/extensions/ampi-session-fallback/index.ts",
  "./src/extensions/ampi-patch/index.ts",
  "./src/extensions/ampi-shell/index.ts",
  "./src/extensions/ampi-tasks/index.ts",
  "./src/extensions/ampi-web/index.ts",
  "./src/extensions/ampi-github/index.ts",
  "./src/extensions/ampi-workers/index.ts",
  "./src/extensions/ampi-custom-subagents/index.ts",
  "./src/extensions/ampi-permissions/index.ts",
  "./src/extensions/ampi-tui/index.ts",
  "./src/extensions/ampi-threads/index.ts",
  "./src/extensions/ampi-gui/index.ts",
  "./src/extensions/ampi-history/index.ts"
]
```

`ampi-toolbox` and `ampi-debug` are intentionally absent from this list. `ampi-toolbox` remains importable through the `exports` map as a deprecated re-export of `ampi-patch` and `ampi-tasks`; `ampi-debug` is loaded explicitly with Pi's `-e` flag and is excluded from the published package via `.npmignore`.

Public consumers should import from the package root (`ampi`) unless they are wiring a specific extension subpath declared in `exports`.

## Source tree

```text
src/
  index.ts
  extensions/
    manifest.ts
    ampi-core/
    ampi-session-fallback/
    ampi-patch/
    ampi-shell/
    ampi-tasks/
    ampi-web/
    ampi-github/
    ampi-workers/
    ampi-custom-subagents/
    ampi-permissions/
    ampi-tui/
    ampi-threads/
    ampi-gui/
    ampi-history/
    ampi-toolbox/     # deprecated shim, unregistered
    ampi-debug/       # developer-only capture, unregistered
```

### `src/index.ts`

Package-level public API. It re-exports stable helpers, types, extension factories, tool factories, settings loaders, and constants from shipped extensions. Canonical API catalogs live in [`docs/ampi-core-api.md`](docs/ampi-core-api.md) and [`docs/public-api.md`](docs/public-api.md).

### `src/config-keymap.ts`

ampi's palette commands built without a Pi session (`collectMmrDefaultCommands`) and the keymap in effect for given Pi settings as JSONC. Not one of the package's extensions: its default export is the entry `ampi config keymap` loads through Pi's extension loader, and `tests/mmr-cli-config.test.mjs` checks the list against what `ampi-tui` and `ampi-threads` register in a terminal session.

### `src/cli-threads.ts`

The session search behind `ampi threads search` (`searchMmrThreads`): it evaluates a query from `ampi-core/session-query.ts` on Pi's session list and the thread index records the command reads, without redaction. Also the reports behind `ampi threads context` (`reportMmrThreadContext`, on `ampi-threads/context-analysis.ts`), `ampi threads usage` (`reportMmrThreadUsage`) and `ampi usage` (`reportMmrUsage`), on `summarizeMmrThreadCost` from `ampi-core/thread-reports.ts`, with prices and windows from a model lookup the command builds. Not one of the package's extensions: its default export is the entry the command loads through Pi's extension loader, on the event channel `ampi:cli-threads`.

### `src/extensions/manifest.ts`

Single source of truth for the registered extension list consumed by `package.json` generation and tests.

### `src/extensions/ampi-core/`

Foundation routing extension. It owns mode consistency across model choice, thinking level, tool allowlist, prompt route, diagnostics, persisted state, feature gates, and subagent profiles. Sibling extensions plug into its runtime registries rather than mutating core state.

Important files:

- `index.ts` — Pi extension entry point.
- `modes.ts` — mode table (`low`, `medium`, `high`, `ultra`, `free`), migration aliases, and metadata.
- `mode-controller.ts` — shared state manager for mode transitions and UI updates.
- `model-resolver.ts` — provider-neutral preference expansion and route selection.
- `routing.ts` — resolves the active mode from settings and flags.
- `tool-registry.ts` — exact-name tool provider registry, allowlists, and deferred registrations.
- `glob.ts` — the shared glob matcher (`*`, `**`, `?`, braces, a safe character-class subset), used for repository paths and tool names.
- `tool-disable.ts` — the `ampi.tools.disable` matcher (exact names, globs, `builtin:<name>` for Pi's own built-in tools) and how it applies to resolved tool sets.
- `subtree-guidance.ts`, `subtree-guidance-hooks.ts` — guidance from subfolders: which `AGENTS.md` files a `read` below the working directory adds, the once-per-folder record in session entries, and the `tool_result` wiring.
- `skill-paths.ts` — the skill folders ampi adds through `resources_discover`: `.claude/skills` up to the repository root (with project trust), `~/.claude/skills`, and `ampi.skills.path`.
- `feature-gates.ts` — feature-gate provider registry for opt-in siblings.
- `request-policy.ts` — per-mode provider-request and thinking-level policy.
- `speed.ts` — fast speed: the providers with a priority tier and its cost multiple, the `service_tier` payload change, the per-session speed (`ampi-speed` entries, `--ampi-fast`, `ampi.speed`) and the `speed.toggleFast` command.
- `prompt-assembly.ts` — prompt-head rewrite and ampi-authored mode prompts.
- `subagent-profiles.ts`, `subagent-resolver.ts`, `subagent-prompt-assembly.ts` — worker model/tool/prompt policy for subagents.
- `status.ts`, `diagnostics.ts` — `/ampi-status` formatting, the locked-mode footer, and structured diagnostics.
- `chrome-owner.ts` — seam that makes the footer yield to an extension drawing its own terminal chrome (`ampi-tui`).
- `prompt-queue.ts` — seam for Pi's queued messages: `ampi-tui` publishes their texts and takes one back through its `pi-compat` layer; `ampi-gui` reads them.
- `command-registration.ts` — slash commands, shortcuts, and thinking toggles.
- `command-registry.ts`, `keymap.ts` — palette command registry with ranking, and the key-string grammar, `ampi.keymap` overrides, and conflict report.
- `session-catalog.ts` — read-only catalogue of local Pi sessions: listing and opening through Pi's `SessionManager`, one workspace's or every session as Pi's session picker lists them, the cached per-session evidence index, dedupe and id/prefix resolution.
- `session-query.ts` — the session search language shared by `find_session` and `ampi threads search`: tokenizing, `key:value` filters with relative dates, keys that need hosted data, and `matchesMmrThreadIndexFilters` for `label:`, `pinned:` and `archived:` on a thread index record.
- `live-registry.ts` — the live registry of running sessions, `<agentDir>/data/ampi/live/<pid>.json`: ampi-core writes this process's entry for every session with a file (terminal or print, JSON and RPC runs), throttled, and removes it at shutdown; `setMmrLiveFields` takes `ampi-gui`'s port and `ampi-threads`' generated title, and `flushMmrLiveEntry` writes them at once; the readers drop dead and reused pids and accept version 1 files; `findMmrLiveOwner` names the other process that has a session file open; a session `ampi app` hosts is recorded as `app-session` with its host's pid, and `ampi app`'s own in-memory session as `app` without a session file.
- `gui-host.ts` — the GUI host seam: the record `ampi app --worker` puts on `globalThis` before it creates its session (`role: "session"`, `token`, `ownerPid`, `ready`), read through `getMmrGuiHost`; with it `ampi-gui` serves RPC mode with the host's token and the live registry records an `app-session`. `ampi app` itself writes `role: "hub"` with `startSession`: `ampi-gui` serves the app's page and the registry records an `app` entry without a session file.
- `thread-status-events.ts` — Pi's agent events mapped onto `thread-status.ts` reducer events, with the streamed-token estimate; shared by `ampi-tui`'s status feed and the live registry.
- `thread-index.ts` — seam for the thread index (per-session archived, labels, colour, pinned, title source): `ampi-threads` registers its store, other extensions read it through `getMmrThreadIndex`; `filterMmrSessionsByArchived` filters catalogue sessions.
- `prompt-history.ts` — seam for prompt history: `ampi-threads` registers its store, `ampi-tui`'s picker reads it through `getMmrPromptHistory`, per workspace or across all of them.
- `thread-reports.ts` — seam for the cost and context reports and the Markdown export: `ampi-threads` registers them with `ampiThreads.showCosts`, `ampi-tui`'s overlays and cost gauge and `ampi-gui`'s Copy as Markdown read them through `getMmrThreadReports`. It also holds `summarizeMmrThreadCost` (cost per model from a session's usage and the model prices), which `ampi-threads` and the `ampi` command share.
- `tool-activity.ts` — pure classification of tool calls into activities (verb, object, diff stat, exit code) and the one-phrase summary of a run of them, shared by `ampi-tui`'s tool rows and `ampi-gui`'s transcript.
- `permissions.ts`, `permission-defaults.ts` — the pure permission rule engine (validation, glob and `/regex/` matching, shell lines split into simple commands, project-user-default order, the rule text form), ampi's default rules, the session-wide "allow all" override, used by `ampi-permissions`.
- `activity-runs.ts` — pure rules for where a run of consecutive tool calls ends (text, user and summary messages, subagent and image calls), shared by `ampi-tui`'s activity groups and `ampi-gui`'s work groups.
- `spinner.ts`, `animation.ts` — the running glyph every running row draws (a braille cellular automaton stepped every 200 ms), and `isMmrAnimationDisabled` (`NO_ANIMATION`, `ampiTui.animations: false`), which stills it and the other animations.
- `skill-sources.ts` — pure classification of where Pi found a skill (user, project, package, settings, temporary; Pi's or an `.agents` directory) from its `sourceInfo`, for every surface that lists skills.
- `session-usage.ts` — the usage each session entry records and what it cost (recorded, or priced from the model), shared by `ampi-tui`'s cost gauge and `ampi-threads`' cost report.
- `above-editor-dashboard.ts` — split-pane dashboard widget coordination.
- `lifecycle-hooks.ts`, `runtime.ts` — session/request lifecycle wiring and the live registry singleton; `runtime.ts` also holds the `mmr-core:*` event names, the tool-approval event among them.
- `auto-compact.ts` — locked-mode auto-compaction at a fraction of the context window (`ampiCore.autoCompact`), with its run guard and failure backoff.
- `internal/` — low-level env, JSON, and settings-file utilities.
- `README.md`, `ROADMAP.md` — extension docs and milestones.

Registered surface: slash commands (`/mode`, `/ampi-status`, `/ampi-changelog`, `/ampi-config`), mode shortcuts, the `ampi-above-editor-dashboard` widget, and the feature gates for `ampi-workers` (with the pre-merge `mmr-subagents`/`mmr-async-tasks` ids as accepted aliases), `ampi-history`, `ampi-web`, `ampi-patch`, and `ampi-tasks`.

### `src/extensions/ampi-session-fallback/`

Session-scoped quota/rate-limit fallback. When a subscription-backed route fails with a classified quota or rate-limit error, it prompts for a fallback model/thinking level, applies the override through `ampi-core`, persists it for the session, and lets Pi retry the turn. It registers no model-invokable tools and is driven by message-lifecycle events.

Important files:

- `index.ts` — Pi extension entry point; coordinates session-start restore and message-end handling.
- `classifier.ts` — quota/rate-limit/overload error classifier.
- `candidates.ts`, `thinking.ts`, `ui.ts` — fallback candidate ranking, thinking-level resolution, and the picker UI.
- `retry-message.ts` — retry payload rewrite.
- `state.ts`, `runtime.ts` — persisted override schema and in-process guards.
- `README.md`, `ROADMAP.md` — behavior and milestones.

### `src/extensions/ampi-patch/`

Owns `apply_patch`. Provides context-matched, multi-file workspace edits using a Codex-format patch parser with path safety and atomic application. Split out of the former `ampi-toolbox`.

Important files:

- `index.ts` — Pi extension entry point and provider registration.
- `apply-patch-tool.ts` — `apply_patch` tool definition, schema, and prompt guidance.
- `apply-patch.ts` — Codex patch parser and hunk-matching engine.
- `apply-patch-plan.ts` — path safety, per-file mutation locking, and flush phase.

### `src/extensions/ampi-shell/`

Owns `shell_command`, `shell_command_status` and `shell_command_kill`: shell commands that keep running in the background once a short wait is over, followed and stopped by pid. On by default (`ampiShell.enabled: false` turns it off); every running command is stopped when the session ends.

Important files:

- `index.ts` — Pi extension entry point, tool provider and `session_shutdown` hook.
- `tools.ts` — the three tool definitions, schemas and prompt guidance.
- `processes.ts` — per-session registry: process groups, unread output with a 1 MiB cap, waiting and stopping.
- `config.ts` — `ampiShell.*` settings and `AMPI_SHELL_ENABLE`.

### `src/extensions/ampi-tasks/`

Owns the session-local `task_list` and `ask_user_choice`. Persists a todo list in the current Pi session log and renders it as a pinned TUI widget, and lets the model ask the user to pick one of a few answers. Split out of the former `ampi-toolbox`.

Important files:

- `index.ts` — Pi extension entry point and provider registration.
- `todo-list-tool.ts` — `task_list` tool definition, whole-list validation, and verification nudges.
- `todo-list-widget.ts` — pinned `aboveEditor` widget (`ampi-task-list`) with ampi's spinner on in-progress rows.
- `task-list-wiring.ts` — `/tasks` slash command, shortcuts, and compaction hooks.
- `ask-user-choice-tool.ts` — `ask_user_choice` tool definition, argument checks, and the select dialog (fails at once without a UI).

### `src/extensions/ampi-web/`

Network-backed web extension. Disabled by default; registers `web_search` and `read_web_page` when enabled (`AMPI_WEB_ENABLE` or settings; legacy `MMR_WEB_ENABLE` still accepted). Search supports SearXNG (managed sidecar or remote), Brave, and DuckDuckGo; page reads use an in-process Readability/Turndown reader with a fallback extractor.

Important files:

- `index.ts` — Pi extension entry point, provider, and `/ampi-config` flow registration.
- `config.ts`, `backend.ts` — settings/env parsing and backend selection.
- `tools.ts` — `web_search` and `read_web_page` tool definitions.
- `url-policy.ts` — SSRF protection and external-URL validation.
- `reader/`, `search/` — page-reader and pluggable search-backend implementations (including the SearXNG sidecar).
- `README.md`, `ROADMAP.md` — configuration, safety, diagnostics, and roadmap.

### `src/extensions/ampi-github/`

Opt-in read-only GitHub provider (`AMPI_GITHUB_ENABLE`, legacy `MMR_GITHUB_ENABLE` still accepted). Registers repository tools used directly by callers and gates the `librarian` worker until the GitHub tool surface is owned by this extension.

Important files:

- `index.ts` — Pi extension entry point.
- `config.ts` — settings/env parsing; tokens are env-only.
- `client.ts` — read-only GitHub REST client and response bounds.
- `tools.ts`, `tool-schemas.ts`, `tool-format.ts` — read-only tool implementations, schemas, and response formatting.
- `provider.ts`, `tool-ownership.ts` — feature-gate/tool-provider ownership checks and `librarian` gating.
- `README.md` — tool reference, configuration, safety, and public API.

### `src/extensions/ampi-workers/`

Merged worker extension. Owns the blocking `finder`, `oracle`, `Task`, and `librarian` workers, the background task surface (`background: true` on the named worker tools, the deprecated `start_task` alias, `task_poll`/`task_wait`/`task_cancel`), the child-CLI runner, the session-scoped background registry, the live TUI fleet dashboard, and the `ampi-workers` feature gate (the pre-merge `mmr-subagents`/`mmr-async-tasks` gate ids remain accepted aliases). Worker model/tool/prompt policy is resolved through `ampi-core` profiles. Custom Markdown subagents live in `ampi-custom-subagents`.

Layout (top level holds the extension entry, ownership, and compatibility surfaces; implementation lives in themed subdirectories):

- `index.ts` — Pi extension entry point and provider registration.
- `provider.ts` — unified tool-provider and feature-gate-provider factories.
- `child-extension-scope.ts` — per-profile child-process extension keep-sets.
- `worker-model-metadata.ts`, `worker-result-shaping.ts`, `worker-usage-format.ts` — compatibility re-exports of helpers that moved to `ampi-core` (kept for one release).
- `framework/` — the worker execution framework: `runner.ts` (child-CLI subagent runner and worker lifecycle), `worker-tool-factory.ts` (the declarative factory the worker tools are generated from), `worker-host-impl.ts` (the `ampi-core` worker-host seam implementation), `worker-binding-registry.ts`, run invocation/outcome helpers, and the session-scoped worker-model fallback.
- `profiles/` — `prompts.ts`, the built-in worker prompt builders.
- `review/` — `checks.ts`, review checks for the `reviewer` worker: repository detection (git or Jujutsu), discovery of `.agents/checks/*.md`, front-matter parsing, changed-file resolution for a diff description, check selection and findings counting. Plain functions over an injected file and command environment, with no Pi tool context.
- `builtin-workers/` — the concrete `finder`, `oracle`, `librarian`, `reviewer`, and `Task` worker tools (finder/librarian/reviewer/Task accept `background`/`group`/`notify`).
- `background/` — the background task surface: `async-task-tools.ts` (background start path plus `task_poll`, `task_wait`, `task_cancel`), `async-task-registry.ts` (in-memory, session-scoped registry of worker lifecycles and concurrency caps), `async-task-delivery.ts` (at-most-once completion notices and idle-wake pushes), schemas, formatting, projection, and dispatch.
- `rendering/` — one-line worker rows (`worker-row.ts` holds their phrases and glyphs, `worker-row-lines.ts` draws a row with its trail, answer and usage), the inline background cards and the pinned `aboveEditor` fleet dashboard (`ampi-background-tasks`) in `progress-rendering.ts` over the `background-task-view.ts` row vocabulary, plus worker run views and envelopes.
- `README.md`, `ROADMAP.md` — behavior, public API, and milestones.

### `src/extensions/ampi-custom-subagents/`

Custom Markdown subagent extension extracted from `ampi-workers`. Discovers project-local Markdown subagent definitions, manages enable/import config flows, and registers `subagent-<name>` worker tools behind a feature gate.

Important files:

- `index.ts` — Pi extension entry point.
- `custom-loader.ts` — scans project directories and parses Markdown subagent definitions.
- `custom-runtime.ts` — tool registration and worker execution wiring.
- `custom-config.ts`, `custom-import.ts` — enabled-subagent persistence and legacy-definition import.
- `config-flow.ts` — interactive `/ampi-config` discovery/enable UI.
- `provider.ts` — tool-provider and feature-gate-provider factories.

### `src/extensions/ampi-tui/`

Terminal look and keys for interactive sessions, on by default (`ampiTui.enabled: false` opts out). Claims ampi's chrome through `ampi-core/chrome-owner.ts`, removes the footer, replaces Pi's editor with the prompt box, draws the welcome header with the changelog card (handed over through `registerMmrChangelogPresenter` in `ampi-core/changelog.ts`), styles user messages and ships the `ampi` theme; print, JSON, RPC and worker runs are untouched. Owns no tools; registers the first palette commands and binds Amp-compatible chords. Files:

- `index.ts` (entry point; applies `ampi.terminal.detailsExpandedByDefault` once the prompt editor can be reached), `config.ts` (the `ampiTui.enabled` switch, `ampiTui.intro`, `ampiTui.notifications`, `ampi.terminal.detailsExpandedByDefault`, `ampi.fuzzy.alwaysIncludePaths` and Pi's `quietStartup`), `README.md`.
- `editor/prompt-box.ts` (the prompt box: a `CustomEditor` subclass with the rounded frame, the mode and cost on the top border, the turn status and the working directory on the bottom border, Alt+Enter, Esc, Backspace and Enter-on-empty handling, and the shortcuts help above the text), `editor/queue.ts` (the box of queued messages above the prompt, the `prompt.queue`, `prompt.dequeue` and `prompt.steerQueuedMessage` commands, and the owner of `ampi-core/prompt-queue.ts`), `editor/help.ts` (the shortcuts help rows, built from the effective keymap and the command registry, and their one- or two-column layout), `editor/status-feed.ts` (Pi agent events to `ampi-core/thread-status.ts` through `ampi-core/thread-status-events.ts`, plus the queue count, interrupt and quit hint), `editor/install.ts` (installs the box, feeds it the mode, fast speed, cost, status, wave glyph and branch, toggles the help and checks tmux's `extended-keys` for its note), `editor/mentions.ts` (the autocomplete provider for `@` hints, the git-ignored paths `ampi.fuzzy.alwaysIncludePaths` adds to `@`, `@:` commits from `git log` and `@@` session mentions through the Mention Thread picker).
- `keys/decode.ts` (terminal input to keymap combos), `keys/dispatcher.ts` (pure chord state machine: leader, prefixes, Esc Esc, deadlines), `keys/hint-popup.ts` (the "then" popup), `keys/commands.ts` (`ampi.palette`, `prompt.openPalette`, `thread.interrupt`, `ampi.quit`, `thread.scrollToTop`/`Bottom`, `prompt.openInEditor`, `prompt.clear`, `prompt.moveToLineStart`/`End`, `prompt.copySelection`, `prompt.history`, `thread.switch`, `thread.mention`, `thread.toggleOutline`, `ampi.showVersion`, `skills.list`, `plugins.list`, `plugins.reload`, `mcp.info`, `mcp.authenticate`, `thread.toggleDetails`, `prompt.toggleHelp`, `ampi.status`/`changelog`/`config`, `mode.toggle`, `mode.use.<key>`, and the `pi` palette rows for Pi's slash commands), `keys/install.ts` (keymap resolution from the command registry and `ampi.keymap`, shortcut versus raw-input routing, popup overlay, opening the palette, the mode dial, the prompt history picker, the Switch Thread picker, the Mention Thread picker and the outline, and the prompt box cues: first Esc, quit hint, palette open, help toggle and close).
- `ui/frame.ts` (the box overlays share: title, key hints, scrollbar), `overlays/palette.ts` (the command palette), `overlays/mode-dial.ts` (the mode dial and mode list), `overlays/help-keymap.ts` (the Help & Keymap screen and the keymap as JSONC), `overlays/prompt-history.ts` (the prompt history picker on Ctrl+R, fed through `ampi-core/prompt-history.ts`), `overlays/thread-picker.ts` (the Switch Thread picker with its session preview, and the Mention Thread variant that `@@` and `thread.mention` open; switches through `/ampi-thread switch`), `overlays/thread-reports.ts` (the Thread Cost and Analyze Context overlays, fed through `ampi-core/thread-reports.ts`), `overlays/outline.ts` (the outline of the last response: its headings read from the session, the box above the prompt and the controller `keys/install.ts` keeps current), `overlays/info.ts` (the Skills, Extensions and Version dialogs, built from Pi's commands, tools and last skill list, with skills grouped through `ampi-core/skill-sources.ts`), `overlays/mcp-info.ts` (the MCP Servers dialog with its Servers and Tools tabs, built from the `mcp.json` files, the servers extensions register and Pi's tools), `overlays/intro.ts` (the full-screen onboarding intro and the launcher that opens it once per user and for `ampi.showWelcome`).
- `chrome/look.ts` (installs the pieces below), `chrome/welcome.ts` (welcome header and ampi's mark in three sizes), `chrome/intro-record.ts` (the intro's seen record under `<agentDir>/data/ampi/tui/`), `chrome/title-notify.ts` (terminal title, OSC 777 notifications, bell and sound), `chrome/quit-summary.ts` (mark, title and working directory printed after an interactive quit), `transcript/messages.ts` (user message drawing, thinking label), `theme/ampi.json` and `theme/select.ts` (the theme and its session selection).
- `pi-compat/` — the only code that uses Pi runtime surface outside the extension API (focused editor with its actions, cursor line moves, submit handler, autocomplete state and rendered height, the editor's height rule, transcript scrolling, the fullscreen mouse selection in `selection.ts`, the reserved shortcut list, Pi's built-in slash command names, raw input, the user message component, the message queue, overlay placement read on every frame); probed by `tests/mmr-tui-pi-compat.test.mjs`.

### `src/extensions/ampi-permissions/`

Approval for risky tool calls, off until `ampi.permissions` (or `ampi.dangerouslyAllowAll: false`) is set in the user's or a trusted project's settings. A `tool_call` gate evaluates the rules with `ampi-core/permissions.ts` in every mode and asks through Pi's select dialog; owns no tools.

- `index.ts` (entry point: settings at `session_start`, the feature-gate provider, the gate, the one-at-a-time dialog queue, the `mmr-core:approval` events, the "every session" settings write), `config.ts` (reads the user and trusted project settings; projects only tighten), `gate.ts` (dialog words and block reasons), `README.md`.

### `src/extensions/ampi-threads/`

Thread management on top of Pi sessions, on by default (`ampiThreads.enabled: false` opts out). Keeps the thread index at `<agentDir>/data/ampi/threads/index.json` and the prompt history under `<agentDir>/data/ampi/threads/history/`, and registers the thread commands; owns no tools. Files:

- `index.ts` (entry point: registers the index in `ampi-core/thread-index.ts`, the prompt history in `ampi-core/prompt-history.ts`, the cost and context reports in `ampi-core/thread-reports.ts`, the commands and the `/ampi-thread` route; records typed prompts; auto-archive on quit), `config.ts` (`ampiThreads.enabled`, `ampiThreads.autoArchiveOnQuit`, `ampiThreads.showCosts`, `ampiThreads.titles`), `README.md`.
- `title.ts` (generated session titles: after the first completed reply of an interactive session, one call on `ampi-core`'s `title` subagent profile through the worker host; the answer cleaned to one short line and set with `pi.setSessionName`).
- `markdown.ts` (a session as Markdown, exported from the package root) and `context-analysis.ts` (estimated tokens per context section from the recorded system messages and the conversation); both pure.
- `index-store.ts` (the versioned index file: atomic writes, corrupt files moved aside, a per-path in-process queue, label and colour validation).
- `history-store.ts` (one JSON Lines file of prompts per workspace, each line versioned: consecutive repeats skipped, trimmed to the newest 1000 by an atomic rewrite past 1200 prompts that keeps other versions' lines, all workspaces merged by time).
- `commands.ts` (`thread.new`, `thread.rename`, `thread.archive`, `thread.unarchive`, `thread.archiveAndQuit`, `thread.switchToPrevious`, `thread.switchToNext`, `thread.copyMarkdown`, `thread.copyURL` (copies `ampi threads continue <id>`), and the `/ampi-thread new|archive|switch <id>|previous|next` handler that calls Pi's `newSession` and `switchSession`).
- `switch-history.ts` (the per-process back and forward lists of switched sessions, anchored on `globalThis`).

### `src/extensions/ampi-gui/`

Local web GUI, off by default (`ampiGui.enabled: true` or `AMPI_GUI_ENABLE=true` opts in), only in interactive terminal sessions, and always in a session `ampi app` hosts and in `ampi app` itself (ampi-core's `gui-host.ts`). Serves a live view of the running session with a composer and a session sidebar on `127.0.0.1` and records it in `<agentDir>/data/ampi/live/<pid>.json`; owns no tools.

- `index.ts` (entry point: the gate, the server from `session_start` to `session_shutdown`, the live registry entry, the `Web GUI:` notice and `thread.openInBrowser`), `config.ts` (the `ampiGui.enabled` switch).
- `server.ts` (`node:http` on a random loopback port: `startMmrGuiHttpServer` with the Host, Origin and token checks, the token cookie, `GET /` and `/client/*`, shared with the hub; then a session's `/api/session`, `/api/transcript`, `/api/events`, `/api/sessions[/<id>]` and the POST command routes), `hub.ts` (`ampi app`'s server: `/api/app`, `/api/events` announcing workers that start or stop, the session list with each session's live host, `/s/<id>/api/*` forwarded to the app's workers or read from the file, starting one worker per session, and the single-writer checks), `commands.ts` (send, dequeue, steer-next, interrupt through `pi.sendUserMessage`, ampi-core's prompt-queue seam and the `prompt.steerQueuedMessage` / `thread.interrupt` commands; More Actions: Markdown, archive and rename through ampi-core's thread-reports and thread-index seams), `sessions.ts` (the sidebar's groups from ampi-core's session catalogue, the thread index and ampi-core's live registry; saved sessions parsed read-only).
- `bridge.ts` (Pi events to numbered client events through `ampi-core/thread-status.ts`, the replay buffer, the transcript snapshot), `view-model.ts` (session messages to transcript items; tool calls labelled with `ampi-core/tool-activity.ts` and folded into work groups by `ampi-core/activity-runs.ts`). `index.ts` adds the server's port to ampi-core's live registry entry through `setMmrLiveFields`.
- `client/` (`index.html`, `app.js` (the page in both modes: a terminal's session, or `ampi app`'s every session at `/s/<id>`), `app-mode.js` (app mode's pure helpers: the per-session request base, addresses and history entries, the rows' host labels, the banner for each state, the list timer), `transcript.js` (items, work groups, call details and the "Worked for" fold), `composer.js` (the composer: keys, queued-message bubbles, send and stop), `sidebar.js` (the session list, search, resizing, Ctrl+B and `/`), `titlebar.js` (More Actions and the rename dialog), `markdown.js` (the escaping Markdown renderer), `tokens.css` (design tokens), `app.css`): plain ES modules and CSS, no build step.

### `src/extensions/ampi-history/`

Opt-in global local Pi session lookup (`AMPI_HISTORY_ENABLE=true`, legacy `MMR_HISTORY_ENABLE` still accepted). Registers `find_session` and `read_session`; `read_session` uses the in-process `history-reader` worker first and falls back to deterministic lexical extraction. Redaction and opaque project references prevent raw session paths from surfacing.

Important files:

- `index.ts`, `tools.ts` — extension entry point and Pi tool definitions.
- `session-catalog.ts`, `query.ts` — session search with redaction, `repo:`/`file:`/metadata/thread index filters and diagnostics; `query.ts` re-exports the parser from `ampi-core/session-query.ts`. Listing, the evidence index and id resolution come from `ampi-core/session-catalog.ts`.
- `session-index.ts` — the history names (`createSessionIndex`, `SessionIndex`, …) for the core session index.
- `read-session.ts`, `analysis-worker.ts` — lexical extraction and optional `history-reader` worker analysis.
- `prompts.ts` — `history-reader` worker prompts.
- `redaction.ts` — deterministic sanitizer.
- `config.ts` — settings and the `AMPI_HISTORY_ENABLE` gate.
- `README.md`, `ROADMAP.md` — behavior, privacy boundaries, and next milestones.

### `src/extensions/ampi-toolbox/` (deprecated shim)

Not registered in `pi.extensions` and registers no tools. `index.ts` re-exports the former `ampi-toolbox` public surface from `ampi-patch` and `ampi-tasks` (including `registerAmpiToolboxProviders`, with `registerMmrToolboxProviders` retained as a legacy alias) so existing imports keep working. New code should import from `ampi-patch` and `ampi-tasks` directly. `README.md` and `ROADMAP.md` are retained for historical context.

### `src/extensions/ampi-debug/` (developer-only)

Not registered in `pi.extensions` and excluded from the published package via `.npmignore`. Loaded explicitly with `pi -e "$PWD/src/extensions/ampi-debug/index.ts"` and inert unless `AMPI_DEBUG_CAPTURE_FILE` (legacy `MMR_DEBUG_CAPTURE_FILE` still accepted) is set. A pure hook-based observer (`index.ts`, `capture.ts`) that records system-prompt source/text, advertised tool names, response status/headers, and message end metadata for ground-truth review. See its `README.md` for usage.

## Packages under `packages/`

Each package is published and versioned on its own (`release-please-config.json`). They are not npm workspaces: Pi installs a git source of ampi with `npm install` at the repository root, and a workspace would pull each package's dependencies, a second Pi among them, into that install. In a checkout the packages run on the root install, which already provides Pi as a peer dependency.

```text
packages/
  ampi-cli/
    bin/ampi.js      # the `ampi` executable
    src/argv.js      # argument router and help text (pure)
    src/packages.js  # package lookup and the guard against loading ampi twice
    src/execute.js   # execute mode (-x): message from argument and stdin, thread options extension
    src/stream-json.js # --stream-json: Pi's JSON events to stream JSON records (pure encoder)
    src/stream-json-input.js # --stream-json-input: stdin JSON lines to prompts for Pi's RPC mode (pure)
    src/run-output.js # what Pi's JSON mode prints with --stream-json, --stats or --output-tool (pure)
    src/mcp-config.js # --mcp-config: read the servers and register them with Pi on every extension load
    src/threads.js   # `ampi threads …`, `ampi last` and `ampi usage` on Pi's session files
    src/config.js    # `ampi config keymap` and `ampi config edit`
    src/tools.js     # `ampi tools list` and `ampi tools show` on a session started in memory
    src/skill.js     # `ampi skill list|info|add|remove`: loaded skills, installs from directories and git
    src/skill-sources.js # where a skill comes from, the rules of ampi-core's skill-sources.ts in plain JS
    src/mcp.js       # `ampi mcp`: add/remove/list/oauth translated onto `pi mcp`, doctor, approve, oauth status
    src/sdk-session.js # a Pi SDK session with what `ampi` loads, for commands that need one in-process
    src/thread-index.js    # the thread index file, read and written outside Pi
    src/thread-markdown.js # a session as Markdown, the layout of ampi-threads' export
    src/pi-compat.js # the undocumented Pi behaviour the command relies on, in one place
    src/sdk-session.js # the one SDK session builder: what interactive ampi loads, then bindExtensions
    src/app.js         # `ampi app`: the hub's in-memory session, forked workers, shutdown
    src/app-worker.js  # `ampi app --worker`: one hosted session per process, IPC protocol
    src/main.js      # prints help or versions, or starts Pi through its exported main()
```

### `packages/ampi-cli/`

`@skippermissions/ampi-cli`, the `ampi` command. Plain JavaScript with JSDoc types, no build step. It depends on `@earendil-works/pi-coding-agent` and `@skippermissions/ampi`, handles its own options (`-m`, `-x`, `--title`, `-l`, `version`, `--help`) and hands everything else to Pi's `main()`, adding ampi's package with `-e` unless Pi already loads it from its settings or a `-e` argument. Execute mode runs Pi's print mode with an inline extension that writes labels and the archive date to the thread index through `ampi-core`'s seam; with `--stream-json`, `--stats` or `--output-tool` it runs Pi's JSON mode and prints stream JSON records made from its events, one summary line or one tool's result instead, and with `--stream-json-input` it runs Pi's RPC mode in the same process, sending it the JSON user messages read from stdin as prompts. `ampi threads` and `ampi last` list, print and change sessions through Pi's `SessionManager` and the thread index file, and open one by starting Pi with `--session`; `threads new` prints a new UUID version 7 session id, which `threads continue` opens through Pi's `--session-id`; `threads search`, `threads context`, `threads usage` and `ampi usage` load `src/cli-threads.ts` through Pi's extension loader, which searches every directory's sessions and reports a session's context and cost or every session's cost, with prices and context windows from Pi's model registry built offline. `ampi config keymap` loads `src/config-keymap.ts` through Pi's extension loader, which builds ampi's palette commands without a session and prints the keymap for Pi's settings; `ampi config edit` opens Pi's settings file in Pi's external editor. `ampi tools list` and `ampi tools show` build a session in memory through `src/sdk-session.js` (Pi's SDK with Pi's configured extensions, ampi unless Pi already loads it, and Pi's built-in codemode, tool_search and MCP extensions, without connecting MCP servers), pass the mode as `--ampi-mode`, and print the tools the session declares to the model once ampi has applied the mode. `ampi skill list` and `ampi skill info` read the skills such a session loads, labelled through `src/skill-sources.js` (a plain-JS copy of `ampi-core/skill-sources.ts`, with a test that runs both over one fixture set); `ampi skill add` copies skills from a directory or a shallow git clone after checking them with Pi's skill loader, and `ampi skill remove` deletes an installed skill directory. `ampi mcp` translates `add`, `remove`, `list` and `oauth login|logout` onto Pi's `pi mcp` (a URL becomes `--url`, `--workspace` becomes `--local`) and passes everything else to it unchanged; `doctor` and `oauth status` read `pi mcp list --json`, and `approve` saves trust for the project in Pi's trust store after listing the servers and other project resources that trust enables. Tests: `tests/mmr-cli-*.test.mjs`. See its [`README.md`](packages/ampi-cli/README.md). `src/live-registry.js` reads ampi-core's live registry of running sessions by the same rules as `src/extensions/ampi-core/live-registry.ts`. `src/sdk-session.js` builds every session the command runs through Pi's SDK instead of `main()` (Pi's configured packages and extensions, ampi unless Pi loads it, Pi's codemode, tool_search and MCP extensions; tested against the installed Pi in `tests/mmr-cli-sdk-session.test.mjs`); `src/app-worker.js` is the internal `ampi app --worker`, which runs one session for `ampi app` over an IPC channel and writes ampi-core's GUI host record first. `src/app.js` is `ampi app`: it refuses to run beside another app's live entry, writes the `hub` GUI host record, runs an in-memory session in RPC mode whose `ampi-gui` serves every session from one page (`src/extensions/ampi-gui/hub.ts`), forks a worker per session the page runs, and stops them all on Ctrl+C.

## Documentation tree

| Path | Purpose |
| --- | --- |
| [`docs/README.md`](docs/README.md) | User-facing docs homepage. |
| [`docs/quick-reference.md`](docs/quick-reference.md) | Quick mode/tool/gate lookup. |
| [`docs/whats-new.md`](docs/whats-new.md) | Recent user- and developer-visible changes. |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | Symptom-first troubleshooting and provider/tool-call procedures. |
| [`docs/reference-architecture.md`](docs/reference-architecture.md) | Extension ownership, dependency direction, core contracts, and implementation state. |
| [`docs/ampi-core-api.md`](docs/ampi-core-api.md) | Stable core public API contract and import guidance. |
| [`docs/public-api.md`](docs/public-api.md) | Stable non-core extension public API contract and import guidance. |
| [`docs/public-api-surface.md`](docs/public-api-surface.md) | Generated package-root export surface reference. |
| [`docs/extension-compatibility.md`](docs/extension-compatibility.md) | Composition with other Pi extensions. |
| [`docs/subagent-framework.md`](docs/subagent-framework.md) | Subagent framework contracts and worker behavior. |
| [`docs/data-storage-conventions.md`](docs/data-storage-conventions.md) | Per-user data storage convention. |
| [`docs/prompt-provenance.md`](docs/prompt-provenance.md) | Prompt provenance boundaries and source notes. |
| [`docs/documentation-style-guide.md`](docs/documentation-style-guide.md) | User-facing documentation structure and wording rules. |

## Test tree

```text
tests/
  *.test.mjs
  fixtures/
  helpers/
  README.md
```

Tests use Node's built-in `node:test` runner and deterministic fixtures. They do not make live provider/API calls.

## Runtime ownership summary

```diagram
   ╭──────────╮     ╭──────────────╮     ╭──────────────╮
   │ /mode or │────▶│ ampi-core     │────▶│ Pi runtime   │
   │ settings │     │ resolution   │     │ model/tools  │
   ╰──────────╯     ╰──────┬───────╯     ╰──────┬───────╯
                            │                    │
                            ▼                    ▼
                    ╭──────────────╮     ╭──────────────╮
                    │ mode state & │────▶│ prompt/status│
                    │ diagnostics  │     │ integration  │
                    ╰──────────────╯     ╰──────────────╯
```

`ampi-core` is the source of truth for locked routing state. Sibling extensions plug in through provider APIs, feature gates, and ampi-owned tool registrations rather than mutating core state directly.
