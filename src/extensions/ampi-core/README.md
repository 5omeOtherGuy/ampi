# ampi-core

Foundation locked-mode extension for `ampi`. Owns locked modes, model resolution, request policy, tool resolution, and the per-turn system-prompt rewrite.

Package overview: [`../../../README.md`](../../../README.md). Planning: [`ROADMAP.md`](ROADMAP.md). Public API: [`../../../docs/ampi-core-api.md`](../../../docs/ampi-core-api.md) (full surface) and [`../../../docs/public-api.md`](../../../docs/public-api.md) (package-root re-exports).

## At a glance

| Default | Provides | Requires | Diagnostics |
| --- | --- | --- | --- |
| On | Locked modes, model resolver, tool registry, prompt rewrite, subagent execution profile, live registry of running sessions | none | `/ampi-status` (`debug` for model/tool resolution detail); `<agentDir>/data/ampi/live/<pid>.json` |

## When to use it

- Always loaded. Other `ampi` extensions register against this one.
- Read this file for mode semantics, request policy, tool resolution, prompt assembly, the subagent profile contract, and the `/ampi-status` field reference.

## Status and enablement

Active by default. Mode resolution: `--ampi-mode` flag → restored session state → `ampiCore.defaultMode` setting → default `medium`. The selected mode is persisted as an `ampi-core.mode-state` custom session entry on every explicit change. Legacy names normalize at input boundaries: `rush` → `low`, `smart` → `medium`, `deep` → `high`, and `fable` → `ultra`.

Mode lock: once the session has a user message (counted from the session entries at session start, and on the first `input` event), the mode is fixed. The cycle and picker shortcuts, and `ampi-tui`'s mode dial, then refuse with "the mode is fixed once a session has messages; start a new session to change it", `ampi-tui` hides the palette's `mode.use.*` rows, and `MmrModeState.modeLock` reads `{ enabled: true, locked: true, reason }` (`isMmrModeLocked()` for short). `/mode <key>` is the explicit override and says so when it changes a locked session's mode; native Pi model or thinking changes still release to `free`; the `Alt+D` thinking toggle and a session-fallback route keep the mode and are unaffected. `ampiCore.modeLock: false` turns the lock off.

Shortcuts: `Ctrl+Shift+S` / `Alt+M` pick any canonical mode; `Ctrl+S` cycles `low → medium → high → ultra` while excluding `free` (`Ctrl+Space` still cycles but is deprecated and will be removed in a later minor release); `Alt+D` toggles the thinking level; `Alt+R` toggles [fast speed](#fast-speed). While an extension owns ampi's terminal chrome, as `ampi-tui` does by default, both cycle keys do nothing in ampi-core and its `Alt+R` only says why fast speed is unavailable: `ampi-tui` takes `Ctrl+S` for its mode dial and binds `Alt+R` through the command registry. These are Amp-compatible keys: Pi binds `Ctrl+S` and `Alt+D` to actions an extension may override (picker save actions and delete-word-forward, which stays on `Alt+Delete`), so Pi lists both overrides under extension issues at startup. Subagent execution uses a separate profile via `--ampi-subagent <name>` (see [Subagent profiles](#subagent-profiles)).

## Behavior

### Locked modes

`low`, `medium`, `high`, and `ultra` apply a locked-mode profile (model preferences, request policy, context profile, active-tool allowlist, ampi-owned prompt block). `free` releases all enforcement and restores the pre-ampi baseline.

- **Model resolution** is provider-neutral against the live Pi registry. Defaults are Low: GPT-5.6 Terra → GPT-5.5; Medium: GPT-5.6 Sol → Claude Opus 4.8; High: GPT-5.6 Sol → Claude Opus 4.8; Ultra: GPT-5.6 Sol → GPT-5.5. Subscription-backed routes (`claude-subscription`, `openai-codex`, `github-copilot`) sort first; explicit `provider/model` settings force a route.
- **Prompt bodies**: Medium, High, and Ultra share the full system-prompt body; Low uses the compact body with its own fragment ordering.
- **Pi baseline thinking** per mode: Low/Medium `medium`; High/Ultra `xhigh`. Request-level thinking is enforced separately by the per-mode request-policy hook.
- **Thinking-level toggle (`alt+d`)**: Medium cycles `medium ↔ high`; High cycles `xhigh ↔ medium`; Ultra cycles `xhigh → high → medium → xhigh`. Low is intentionally not toggleable. The toggle drives both Pi's thinking level and OpenAI Responses reasoning effort, is session-scoped, and uses a dedicated key because Pi reserves `shift+tab` (`app.thinking.cycle`).
- **Request policy** rewrites only token/reasoning fields on `before_provider_request` (`max_tokens`, `max_output_tokens`, Anthropic `thinking` / `output_config.effort`, OpenAI Responses `reasoning`), plus `service_tier` at [fast speed](#fast-speed). Never mutates provider identity, auth, headers, base URLs, messages, system blocks, or tools.
- **Context profiles**: Medium inherits the former Smart 300k total / 172k max-input / 128k max-output safety profile. Low, High, and Ultra use Pi's registered model window. A declared profile caps the active model's `contextWindow` down via a shallow clone at `setModel`; smaller custom windows remain authoritative, `free` is never capped, and the cap is reasserted if provider registration transiently restores the uncapped model object.
- **Fail-closed** before any Pi mutation when a locked mode would resolve zero active tools or no usable model.
- **Footer**: locked modes draw a two-line footer (cwd, branch, session name; token usage, cost, context use, model and mode); `free` restores Pi's footer. While another extension owns ampi's terminal chrome (`registerMmrChromeOwner`, used by [`ampi-tui`](../ampi-tui/README.md)), core leaves the footer slot to it.
- **Auto-switch to `free`** with a warning when native Pi model selection (`/model`, model-cycle) or the native thinking-cycle (`shift+tab`) is used from a locked mode. ampi does not undo the user's native change; it disables request/prompt/tool policy and restores the baseline minus `ampi`-owned tools. Use `alt+d` for the in-mode thinking toggle that does not release.

### Fast speed

Fast speed asks the provider for priority serving: replies come sooner and cost more. `Alt+R`, or `speed use fast` in `ampi-tui`'s command palette (`speed.toggleFast`), turns it on; the same key, or `speed disable fast`, turns it off. A notice names the new speed, the mode and the price.

- **Providers.** `openai` and `openai-codex`: ampi adds `service_tier: "priority"` to OpenAI Responses requests (the Codex variant included), after the mode's request policy, in every mode including `free` and under a session fallback route. The price is about 2x the standard rate, 2.5x for `gpt-5.5`, as Pi prices that tier in its cost reports. Every other provider has no priority tier ampi can request: there the command and key say so and change nothing. Standard speed never writes `service_tier`, so a tier configured for the provider stays as it is.
- **Per session.** Each change is stored as an `ampi-speed` custom session entry (not sent to the model), so resuming or forking a session restores the speed of its branch. A session without such an entry starts at the `ampi.speed` setting (`"standard"`, the default, or `"fast"`; the project's `.pi/settings.json` wins over `~/.pi/agent/settings.json`), or at fast speed when Pi starts with `--ampi-fast` (`ampi --fast`). A project's `ampi.speed` counts only once Pi trusts the project, because fast speed raises the price; until then only the user's settings file applies.
- **Turning it off** always works while fast is on, also after a switch to a provider without a priority tier, where fast speed has no effect meanwhile.
- **Subagent workers** run at standard speed; the parent session's speed does not carry over.
- **Where it shows.** `ampi-tui`'s prompt box puts `↯` before the mode name while fast speed is in effect for the current model; `/ampi-status` has a `Speed:` line: `standard`, `fast (priority tier, about 2x the price)` or `fast (not available for <provider>)`.

```jsonc
{
  "ampi": {
    "speed": "fast" // start new sessions at fast speed
  }
}
```

### Tool resolution

Exact-name resolution against Pi's live tool inventory through the tool-provider registry. No aliases, no candidate fallbacks. Each decision carries owner-extension metadata, a status, and human-readable diagnostic text:

| Status | Meaning |
| --- | --- |
| `active` | Registered and reachable in this mode. |
| `gated` | Owner is loaded but a prerequisite is unmet (`librarian` waits on source-owned `ampi-github` tools). |
| `disabled` | Owner is loaded but turned off or has no active capability, or `ampi.tools.disable` turns the tool off. |
| `deferred` | Recognized name reserved in the status catalog; concrete tool not shipped. |
| `missing` | No extension claimed the name; Pi has not registered it. |

The status catalog covers `apply_patch`, `task_list`, `ask_user_choice`, `web_search`, `read_web_page`, `Task`, `finder`, `oracle`, `librarian`, `reviewer`, `view_media`, `start_task`, `task_poll`, `task_wait`, `task_cancel`, `find_session`, `read_session`, `read_mcp_resource` so `/ampi-status` credits the owning extension when a tool is deferred. Sibling extensions claim exact names via `registerMmrToolProvider(...)`; latest-registered wins. Active-tool allowlist enforcement and `tool_call` blocking apply while locked.

### File-editing tools

Every locked mode activates `write` plus one file-editing tool, chosen from the provider of the route the mode resolved:

| Route provider | Editing tools |
| --- | --- |
| `openai`, `openai-codex`, `azure` | `apply_patch`, `write` |
| `anthropic`, `claude-subscription`, and every other provider | `edit`, `write` |

The choice is made again whenever the route changes: on every mode switch, and when a session fallback moves the session to a provider of the other family. `/ampi-status` shows the active pair and the reason on its `Edit tools:` line. To use one family for every route, set `ampiCore.editTools`:

```jsonc
{
  "ampiCore": {
    "editTools": "edit" // "auto" (default) | "patch" | "edit"
  }
}
```

An unknown value is ignored with a settings warning; a project value overrides the global one.

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

### Turning tools off

`ampi.tools.disable`, in the top-level `ampi` block of Pi's settings files, lists tools to turn off:

```jsonc
{
  "ampi": {
    "tools": {
      "disable": ["web_search", "task_*", "mcp__github__*", "builtin:grep"]
    }
  }
}
```

- An entry is an exact tool name, a glob where `*` matches any run of characters, or `builtin:<name or glob>`.
- A `builtin:` entry matches only Pi's own built-in tools (`read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`), recognized by the source Pi records for them. An extension tool that replaces a built-in under the same name stays on, and so do the tools of Pi's built-in extensions: MCP tools, `codemode` and `tool_search`. Use a plain name or glob for those.
- The user and project lists are combined. An entry that is not a non-empty string, or a glob the matcher does not support, is skipped with a settings warning.
- ampi-core leaves disabled tools out of every tool set it applies: locked modes (including the settings and provider extras), `free`, and subagent workers. A mode whose every tool is disabled still activates.
- A `tool_call` gate blocks calls to disabled tools in every mode, including calls another tool makes (a `codemode` script, a tool `tool_search` loaded), which removing a tool from the active set does not stop. The model is told which setting entry turned the tool off.
- `/ampi-status` lists each registered tool the setting turns off with the entry that matched, and a mode tool it turns off shows as `disabled`, never as `missing` or `deferred`.

### Imported sessions are read-only

`ampi threads import` (the `ampi` command) writes other coding agents' conversations as Pi sessions whose first entry is a custom entry of type `ampi-import`. ampi-core's `input` handler refuses every prompt in such a session, whichever host sent it: the terminal UI, an RPC client, an SDK host or another extension (Pi runs every input handler before it sends anything). Its `user_bash` handler blocks `!` and `!!` commands and the RPC `bash` command (Pi runs no command whose handler failed, and shows the notice as that handler's error), and its `session_before_compact` handler cancels compaction, from `/compact` or the RPC `compact` command. Nothing reaches the model and no message is appended to the session; opening it still records the model and thinking level Pi starts with, as Pi does for every session it opens. With a UI (the terminal UI or an RPC client) a warning says the session is read-only and suggests starting a new session that mentions this one with `@@`, or asking the agent to read it with `find_session` and `read_session`; without one (print and JSON runs, such as `ampi -x --session-id <imported id>`) the same notice goes to stderr and the exit code becomes `1`. Pi's print mode then still prints the session's last stored reply on stdout, as it does after any prompt, so a script must check the exit status rather than read stdout alone. The guard lives in ampi-core so that turning other extensions off cannot lift it. Reading the session (opening it, `/tree`, the Markdown export, search and mentions) keeps working. `isMmrImportedSession(entries)` in `imported-session.ts` is the predicate other extensions use; ampi-threads uses it to skip generated titles.

### Skills from Claude Code folders

Pi reads skills from its own locations (`.pi/skills`, `~/.agents/skills`, project `.agents/skills`, and the `skills` setting). ampi-core adds, through Pi's `resources_discover` event:

1. `.claude/skills` in the working directory and in each parent up to the repository root (the nearest directory with `.git`), nearest first. Outside a repository only the working directory counts. These are project files, so they load only when Pi trusts the project, as Pi does for project `.agents/skills`.
2. `~/.claude/skills`.
3. The directories in `ampi.skills.path`, in order.

```jsonc
{
  "ampi": {
    "skills": {
      "path": "~/my-skills:/shared/team-skills:tools/skills", // ";" separates entries on Windows
      "disableClaudeCodeSkills": false                         // true leaves out both .claude/skills folders
    }
  }
}
```

- `ampi.skills.path` is one string of directories separated by `:` (`;` on Windows). `~` is the home directory; a relative entry resolves against the repository root, or the working directory outside a repository. A project value replaces the user value, and is used only when Pi trusts the project; otherwise the user value applies.
- Only directories that exist are added, each once. Pi finds `SKILL.md` files in them recursively.
- Precedence: Pi loads the folders ampi adds after its own locations and keeps the first skill of each name, with a collision warning. So Pi's own locations win over all of these, a project `.claude/skills` skill wins over a `~/.claude/skills` skill of the same name, and both win over `ampi.skills.path`.
- Pi asks about project trust only when it finds resources it protects itself (such as `.pi/settings.json` or `.agents/skills`). In a folder that has a `.claude/skills` directory and none of those, Pi treats the project as trusted, so its `.claude/skills` loads without a prompt.
- When Pi runs with `--no-skills`, ampi adds nothing either; subagent workers that bring their own prompt run that way.

### Where a skill comes from

`skill-sources.ts` (`classifyMmrSkillSource`) reads the `sourceInfo` Pi attaches to each skill and its path, and gives every surface that lists skills the same answer: a group (`user`, `project`, `package` with the package's source, `settings`, or `temporary` for `--skill` and `-e`) and an origin (`pi`, `agents` for `~/.agents/skills` and project `.agents/skills`, `claude` for `.claude/skills`). The folders above reach Pi as temporary extension paths, so they are grouped by their path: `~/.claude/skills` is `user`, another `.claude/skills` is `project`, and `ampi.skills.path` entries are `settings`. ampi-tui's Skills dialog shows the groups as headings; the `ampi skill` command prints them as labels (`agents-user`, `package:npm:…`), from a plain-JS copy, with a test that runs both over one fixture set.

### Guidance from subfolders

Pi loads its context files (`AGENTS.md` and the like) once, at startup: the agent directory's, the working directory's and those of its parents. A rule file in a subfolder, such as `src/feature/AGENTS.md`, never reaches the model unless the model reads it. ampi-core closes that gap on reads: when the model reads a file below the working directory with Pi's `read` tool, ampi-core appends the guidance files of the subfolders on the way to that file to the tool result.

```text
Instructions from src/feature/AGENTS.md (they apply to files under src/feature/):

<the file's text>
```

- Each subfolder from the working directory's child down to the read file's own directory contributes the one file Pi would take there: the first regular file of `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`. Outermost folders come first, each in its own text block after the file's content. Image reads get them too; failed reads do not.
- A file in the working directory itself, or outside it, gets nothing: Pi has already loaded those files. Reading a guidance file itself adds no copy of it.
- Each folder's guidance is added once per session branch. ampi-core records the folders in an `ampi-core.subtree-guidance` custom session entry and rebuilds the set from the current branch when a session starts, resumes or forks and after `/tree` moves to another point. After a compaction it writes a reset entry, so the next read in a folder adds its guidance again: the results that carried it may have been summarised.
- A guidance file longer than 32 KiB is cut after its last whole line within that size, with a note that the rest was left out.
- Worker children that load ampi-core get the guidance on their own reads, in the child's session: workers that append to Pi's prompt (finder, oracle, custom subagents without an isolated context) do; workers that replace the prompt run with `--no-context-files` and get none. finder's line numbers leave the guidance unnumbered.
- It applies in every mode, `free` included: it adds context and enforces nothing.
- `ampiCore.subtreeGuidance: false` (or `ampi.core.subtreeGuidance`) turns it off; a value that is not `true` or `false` is ignored with a settings warning. It is also off when Pi runs without context files: with `--no-context-files` / `-nc` on the command line (`pi`, `ampi`, and worker children), or when the first prompt after Pi loads its resources (at startup and on `/reload`) comes without context files although Pi's own discovery found some at that load. A session hosted through Pi's SDK, as `ampi app` does, has only the second signal, so there it stays on in a project with no context file of its own.
- The guidance lands in the conversation, not the system prompt, so `ampi-threads`' context analysis counts it under messages, not under AGENTS.md files.
- Limits: only Pi's `read` tool triggers it (not `grep`, the shell, or reads a `codemode` script makes), the guidance arrives with the first read in a folder rather than before the model works there, and `@file` includes and glob front matter in guidance files are not supported.

### Auto-compaction

Locked modes compact the conversation once it fills 90% of the context window. After a run has fully settled (Pi's `agent_settled`, with no retry or queued message left), ampi reads `getContextUsage()` and, at or above the threshold, calls `ctx.compact()` once. The window is the active model's, after the mode's context profile cap, so Medium compacts at 270k of its 300k profile. While it runs, the prompt box status reads `Auto-Compacting`.

```jsonc
{
  "ampiCore": {
    "autoCompact": { "threshold": 0.85 } // fraction of the window, above 0 and at most 1; false turns it off
  }
}
```

- Runs only between runs, never mid-run: `ctx.compact()` aborts an active run first. Pi's own compaction (at `contextWindow - compaction.reserveTokens`) still covers a long run between its turns.
- One compaction at a time. After a failed or cancelled attempt, ampi waits until the context grows past that attempt's size before trying again.
- Runs only in the interactive TUI, which holds messages sent during a compaction and sends them once it ends. Skipped in `rpc` sessions, where a client may send its next prompt as soon as `agent_settled` arrives and Pi would reject it while compacting.
- Skipped in `free`, in subagent workers, in one-shot `print` and `json` runs, after an interrupted run, while the token count is unknown (right after a compaction), and when Pi's `compaction.enabled` is `false`.
- `/ampi-status debug` shows the threshold (or why it is off), the last auto-compaction (time, tokens before and after, window), and any backoff in effect.

### Free mode and source-aware ownership

Free mode disables all ampi enforcement and restores the baseline captured before the locked mode. Source-aware ownership filtering: each ampi extension records its absolute path via `registerMmrOwnedExtensionPath(...)`, and Free mode only drops a tool when the active registration's `ToolInfo.sourceInfo.path` matches one of those paths. Same-named third-party tools are preserved. When Pi does not surface a source path, Free falls back to the name registry.

### Prompt assembly

Per-turn rewrite via `before_agent_start` consumes Pi's already-rendered native prompt as the base prompt. The active base/fragment map lives in [`prompt-registry.ts`](prompt-registry.ts): `pi-native-sections-v1` records Pi's identity line and the anchors of Pi 1.x's sectioned prompt, `MMR_PROMPT_FRAGMENTS` describes Pi-native passthrough fragments and ampi-owned fragments, and each prompted mode has a recipe (`basePromptId` + ordered fragment IDs + mode-specific intro/posture/response style). Adding a prompted mode should be a registry entry plus model/tool policy, not a new ad hoc prompt splice.

The renderer surgically replaces Pi's auto-rendered head (identity line through the `<docs>` section) by rendering the recipe fragments in order. The only ampi-owned XML marker is the initial one-line role marker (for example, `<mmr_mode name="medium">…</mmr_mode>`); mode sections use Markdown headings. Pi's auto `<tools>`, `<rules>`, and `<docs>` sections remain Pi-native fragments and embed byte-identically under `## Tool use`.

Content prepended by earlier handlers is preserved byte-for-byte before the rewritten identity line. Pi's sections after `<docs>` (`<addendum>`, `<project_context>`, `<skills>`, `<cwd>`, extension sections) and tail-appended extension content are preserved byte-for-byte as the `preserved-tail` fragment. Pi prompts pass through unchanged when the auto head cannot be located (e.g. user-supplied `--system-prompt`) and in `free` mode. ampi-owned built-in-tool guidance, shared tool guidance, mode posture, and response style are separate fragments. Low uses the compact recipe; Medium, High, and Ultra use the full default recipe.

### Subagent profiles

Subagent workers run as a separate execution route from user-facing locked modes. Activated via `--ampi-subagent <name>` on the child Pi process; ignored when absent. The profile is the single source of truth for model/thinking/tools/prompt-assembly policy; explicit `--model` / `--tools` on the worker exist for compatibility and observability and must match the profile route or activation fails closed before any mutation. Mode-derived workers may receive `--ampi-parent-mode` so child activation can apply parent-mode-specific worker routes without inferring from a model id.

Profile fields ([`subagent-profiles.ts`](subagent-profiles.ts)):

- `name`, `displayName` — identifier and human-facing label.
- `modelPreferences` — ordered worker-model preferences resolved against the local Pi registry.
- `modeModelPreferences?` — optional parent-mode-specific overrides (mode-derived only). Task uses this so Low workers follow Low's Terra/GPT-5.5 route.
- `thinkingLevel?` — optional; defaults to Pi's default thinking level when omitted.
- `tools` — profile-intent concrete tool allowlist. `resolveMmrSubagentInvocation(...)` computes effective worker tools as `(profile.tools \ profile.denyTools) ∩ registeredTools` when the host supplies a registered set, otherwise just `profile.tools \ profile.denyTools`.
- `denyTools?` — removed from the effective set. Recursive/advisory tools (`Task`, `oracle`, `librarian`, `handoff`) belong here for broad workers.
- `maxTurns?` — optional turn cap; `history-reader` and `title` set this to `1`.
- `requiredInput?` — input kinds the worker's model must accept, named after Pi's `ModelInputModality` (only `"image"` for now). The resolver skips every route whose registered model does not list each kind in its `input` array (a model without the array counts as text only) and records a `model.skipped` warning such as `Skipped openai/gpt-5.4-mini: no image input`; with no route left it fails with `model.no-route`. It applies on parent spawn, child activation and a settings override alike, and the fallback offer after repeated worker errors lists only models that meet it. Only `media` (behind `view_media`) declares `["image"]`; every other profile omits it and resolves as before.
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
| `title`          | standalone, `title`    | `[]` (`maxTurns: 1`; run by `ampi-threads` to name a new session)                                                                                 | the `low` mode's routes: `gpt-5.6-terra` → `gpt-5.5`                                                                                           | `off` | false / false |
| `oracle`         | standalone, `oracle`   | `[read, grep, find, web_search, read_web_page, read_session, find_session]` (child filters out unregistered sibling-extension tools)                | `gpt-5.5` xhigh → `claude-opus-4-6` high                                                                                                                  | `xhigh`   | false / false |
| `media`          | standalone, `media`    | `[read]` (`maxTurns: 3`; `requiredInput: ["image"]`; behind `view_media`)                                                                         | finder's routes, kept where the model accepts images: `antigravity/gemini-3.5-flash` → `gpt-5.4-mini` → `claude-haiku-4-5`                    | `low` | false / false |
| `librarian`      | standalone, `librarian`| `[read_github, list_directory_github, glob_github, search_github, commit_search, diff_github, list_repositories]`                                  | `gpt-5.5` off → `claude-opus-4-6` → `gpt-5.4`                                                                                                                  | `off` | false / false |
| `task-subagent`  | mode-derived, `Task`   | `[read, bash, edit, write, read_web_page, web_search, finder, skill, task_list]` minus `denyTools: [Task, oracle, librarian, handoff]` | provider-pinned Claude Opus 4.8 → GPT-5.5 medium → Claude Opus 4.6 medium → Haiku 4.5 low; Low override: GPT-5.6 Terra medium → GPT-5.5 medium | varies   | false / false |

Pure route resolver lives in [`subagent-resolver.ts`](subagent-resolver.ts).

### Subagent prompt assembly

`assembleMmrSubagentSurface` ([`subagent-prompt-assembly.ts`](subagent-prompt-assembly.ts)) returns an `MmrSubagentPromptAssemblyResult` mirroring `MmrPromptAssemblyResult` (`{ profile, blocks, systemPrompt, activeToolManifest }`) so the same renderers and effective-surface fixtures drive both surfaces.

- **Standalone** (`finder`, `oracle`, `history-reader`, `title`, `reviewer`, `media`, `librarian`). The profile owns the entire prompt. Assembly resolves `profile.promptBuilder` against the registry, calls the builder with `{ profile, cwd, baseSystemPrompt, modeState? }`, and returns its output as the system prompt plus a single `standalone-prompt` block.
- **Mode-derived** (`task-subagent`). Derives from `profile.baseMode`, with `from-parent` resolved by the invocation resolver. Assembly preserves the canonical parent tier, calls `assembleActiveSurface` with a minimal mode state stamped for that tier, rewrites the `active-tools` block from the subagent-filtered worker manifest, then appends one `subagent-worker-role` block. Flattened blocks reproduce `systemPrompt` byte-for-byte.

Ownership: `ampi-core` owns the framework, registry, and contract. Concrete prompt text and builder registrations live in `ampi-workers`. Builders are pure synchronous functions and must not perform I/O. The active tool manifest is filtered down to the resolver's effective `workerTools` (or the profile's tool intent for backwards-compatible callers) before being surfaced. Missing/unregistered builders fail closed.

The assembled surface drives [`tests/fixtures/mmr-subagent-surface/`](../../../tests/fixtures/mmr-subagent-surface) so drift is caught at PR time.

### Spinner and animations

[`spinner.ts`](spinner.ts) is the running glyph every ampi extension draws: one braille character whose eight dots run a tiny cellular automaton. `createMmrSpinner()` returns `glyph()` and `step()`; callers own the timer and step every `MMR_SPINNER_INTERVAL_MS` (200 ms). A fresh spinner shows `⠋`, and the pattern starts over from a random one whenever it would die out, stop changing or loop, so the glyph changes on every step and is never blank.

[`animation.ts`](animation.ts) holds `isMmrAnimationDisabled()`: true when the environment variable `NO_ANIMATION` is set to a non-empty value, or `ampiTui.animations` is `false` in `~/.pi/agent/settings.json` or, overriding it, `<project>/.pi/settings.json`. `ampi-tui`, `ampi-workers` and `ampi-tasks` ask it when a running row, a widget or a session starts; when it is true, spinners stay on `⠋` and start no timer, and other animations rest on their first frame.
### Live registry

Pi does not lock session files: two processes that write one session file can each overwrite the other's messages. So ampi-core records every running session that has a file in a live registry, where other processes on the machine (`ampi-gui`'s sidebar, and the `ampi` command through its own reader) find which sessions run and which process writes a given session file.

- **Where.** One file per process, `<agentDir>/data/ampi/live/<pid>.json` (`<agentDir>` is `~/.pi/agent` unless `PI_CODING_AGENT_DIR` says otherwise). The directory is created owner-only (`0700`), each file is owner-only (`0600`) and written to a temporary file that is then renamed over it, so a reader never sees half an entry.
- **Who writes.** ampi-core, and only for its own process, from `session_start` to `session_shutdown`: an interactive terminal session (`kind` `tui`), a print, JSON or RPC run (`execute`), with or without `ampi-gui`, `ampi-threads` or `ampi-tui`, a session `ampi app` hosts in a worker process (`app-session`, with the app's pid as `ownerPid`; the worker says so through the GUI host record, [`gui-host.ts`](gui-host.ts)), and `ampi app` itself (`app`, with `sessionPath` `null`: its own session is in memory, and the entry is how a second `ampi app` finds it; it says so through a GUI host record with role `hub`). Any other session without a file writes nothing: `--no-session`, which every subagent worker runs with, and in-memory sessions. `/new`, `/resume` and `/fork` end one session and start the next, so the entry is rewritten for the new session file.
- **What it holds.** Paths, pids, a title and a hash of the GUI's access token, never the token. While the GUI serves, the token itself is in `<pid>.token` next to the entry, owner-only (`0600`) like the entry; [ampi-gui's security model](../ampi-gui/README.md#security-model) says why and who reads it. Readers use a token file only when its SHA-256 matches `gui.tokenHash` (`readMmrLiveToken`; `readLiveToken` in the `ampi` command's reader). The entry's fields:

  | Field | Value |
  | --- | --- |
  | `version` | `2` |
  | `pid` | The process |
  | `procStart` | The process start time from `/proc/<pid>/stat` (clock ticks after boot); `null` off Linux |
  | `kind` | `tui`, `execute`, `app` (a multi-session host) or `app-session` (a session such a host serves) |
  | `sessionId`, `sessionPath` | Pi's session id and session file; `sessionPath` is `null` only for `app` |
  | `cwd` | The session's working directory |
  | `title` | Pi's session name, else a title `ampi-threads` generated; `null` without either |
  | `mode` | The ampi mode key (`low`, `medium`, `high`, `ultra`, `free`); `null` when none applies |
  | `status` | `{ phase, label }` from the [thread status](../../../docs/ampi-core-api.md#thread-status) of the running turn, such as `{ "phase": "runningTools", "label": "Running Tools" }` |
  | `startedAt`, `updatedAt` | ISO timestamps: when the session started in this process, and the last write |
  | `gui` | `{ port, tokenHash }` while `ampi-gui` serves the session (`tokenHash` is the SHA-256 of the access token, hex); otherwise `null` |
  | `ownerPid` | Only for `app-session`: the host process |

- **When it changes.** At session start, then whenever the mode, the status phase or a contributed field changes: at most one write per 250 ms, and a change inside that window is written when it ends. Other extensions contribute fields through `setMmrLiveFields({ title?, gui? })` (`ampi-gui` its port and token as `gui: { port, token }`, `ampi-threads` a generated title) instead of writing a file, so each entry has one writer. `flushMmrLiveEntry()` writes the entry at once, inside the throttle window, and resolves once it is on disk; `ampi-gui` calls it before it tells `ampi app` its port.
- **When it goes.** At `session_shutdown`, and, best effort, when the process exits, together with the token file; the token file also goes as soon as the GUI stops (`gui: null`), and is written before the entry names the GUI. A process that is killed leaves its files behind; every reader removes the entries (and token files) of processes that no longer run, and of a pid whose start time no longer matches (the pid now names a later process). Files that are not valid entries are skipped and left alone. Readers also accept the version 1 files older `ampi-gui` releases wrote, as terminal sessions with only `gui` known.
- **Two writers.** When another live entry names the same session file at session start (compared after resolving symbolic links), ampi-core warns, naming the other process's pid and kind: a warning notice in the terminal, one line on stderr starting `ampi:` in other modes. It does not stop the session, because Pi has opened the file before extensions run; close one of the two.

Code: [`live-registry.ts`](live-registry.ts); Pi's events reach the status through [`thread-status-events.ts`](thread-status-events.ts). The `ampi` command reads the same files with `packages/ampi-cli/src/live-registry.js`.

## Diagnostics and troubleshooting

`/ampi-status` renders the resolved `MmrModeState`. Pass `debug` or `--debug` to append a `Debug:` section with the selected source, rejected source candidates, and per-candidate resolution detail.

Locked-mode fields (Free uses a strict subset):

| Field | Meaning |
| --- | --- |
| `Mode:` | Display name + key. |
| `Selected source:` | `flag` / `session` / `settings` / `default` / `native`. |
| `Rejected sources:` | Sources considered and discarded with reason, or `none`. |
| `Mode lock:` | `open until the first message`, `locked - <reason>; /mode overrides it`, or `off (ampiCore.modeLock is false)`. Runtime-only. |
| `Model preference order:` | Ordered preference list attempted (mode defaults merged with settings). |
| `Resolved model:` | `provider/model thinking:level` actually applied, or `none`. |
| `Resolved model available:` / `Model applied:` | Whether a candidate matched a registered model / whether Pi accepted it. Can diverge when Pi rejects. |
| `Configured fallback:` | `no` or `yes - <reason>`. |
| `Thinking:` | Pi session level plus per-mode request policy. |
| `Context:` / `Context cap:` | Profile after provider clamping; `none` in Free, `model default` when no ampi input profile, otherwise `<tokens> input tokens (mode profile)`. |
| `Baseline captured:` | Whether ampi-core has a pre-ampi restore snapshot (no auth detail, never persisted). |
| `Prompt surface:` | `default` (ampi head replacement) / `passthrough` / `disabled` (Free). |
| `Active tools:` / `Missing tools:` / `Deferred tools:` / `Gated tools:` / `Disabled tools:` | Outcome of tool resolution per requested tool name. |
| `Edit tools:` | The file-editing pair in use and why: the route's provider (`auto`) or `ampiCore.editTools`. Runtime-only. |
| `Tool resolution:` | Each requested tool's provider, status, candidate list, and diagnostic. |
| `Feature gates:` | Reserved capability gates and resolution. |
| `Settings files read:` / `Settings warnings:` | Absolute paths that contributed; non-fatal warnings named per file. Runtime-only — not part of `PersistedMmrModeState`. |
| `Policy warnings:` / `Diagnostics by severity:` | From `getMmrPolicyDiagnostics(state)`. Grouped block sorts by severity; legacy single-line `Policy warnings:` kept for compatibility. |
| `State version:` / `Applied at:` | Schema version and last successful `applyMode` timestamp. |
| `Debug:` (with `debug`/`--debug`) | Selected source, rejected sources, and per-`MmrModelCandidateResolution` lines (`registered`, `authenticated`, `subscription`, `attempted`, `applied`/`not-applied`, `thinking=…`, `reason`), then `Auto-compaction:` (threshold or why it is off), `Last auto-compaction:`, and any `Auto-compaction backoff:`. |

Common symptoms:

- **`Model applied: no`.** Combine `Resolved model:` / `Resolved model available:` / `Configured fallback:` with Debug `Model preference candidates:`. Common reasons: provider not registered, OAuth/API key missing (`authenticated=no`), Pi rejected the id (`attempted, not-applied`).
- **Auto-switched to Free.** Native `/model` or `/think` from a locked mode is a fail-soft switch with a warning. `Selected source: native` makes it visible. Re-enter `/mode <key>`.
- **Settings file silently ignored.** Check `Settings files read:`. A present file missing here is unreadable JSON — a `Settings warnings:` entry will name it.
- **Settings warning naming a block.** The block was discarded but the rest of the file (and the sibling file) still loaded. Fix the shape against the example in [`../../../README.md`](../../../README.md#settings). A `toolAliases` warning means the deprecated alias setting was found and ignored.
- **Tool stays `missing` / `deferred`.** `Tool resolution:` shows each request's provider and chosen tool. Resolution is identity-only: `missing` means no extension has claimed it and Pi has not registered the name; `deferred` means the catalog credits an owner that has not shipped/registered the concrete tool.
- **Locked mode refused to activate.** The resolver returned zero active tools; the previous state is kept. Inspect `Tool resolution:` on the previous state.
- **A subfolder's `AGENTS.md` never shows up.** It arrives only with a `read` of a file in that folder or below it, once per session branch. Check that `ampiCore.subtreeGuidance` is not `false`, that Pi does not run with `-nc`, and that the file is below the working directory, not in it.
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

Tests: `tests/mmr-core*.test.mjs`, `tests/fixtures/mmr-core-prompts/`, `tests/fixtures/mmr-effective-surface/`, `tests/fixtures/mmr-subagent-surface/`. The live registry: `tests/mmr-core-live-registry.test.mjs`, and `tests/mmr-cli-live-registry.test.mjs`, which reads `tests/fixtures/live-registry/` with both readers and fails when they disagree.
