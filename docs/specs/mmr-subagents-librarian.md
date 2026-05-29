# mmr-subagents librarian — behavioral specification

Status: implemented for the initial public-web MVP. Remote repository-provider
variants and approval/disable UX are tracked as deferred follow-ups (see
[§13 Open follow-ups](#13-open-follow-ups)).

## 1. Purpose and scope

`librarian` is a standalone `mmr-subagents` worker for researching repositories
and repository history. The initial slice researches **public** repository
content reachable through `mmr-web` (`web_search` + `read_web_page`). Hosted
Git provider support (e.g. GitHub) is deferred; self-hosted Git provider
support is out of scope for the initial spec.

`librarian` complements the other workers:

- `finder` — local workspace search only.
- `oracle` — advisory planning, review, and debugging across supplied context.
- `Task` — bounded implementation or investigation worker.
- `librarian` — repository research, architecture tracing, file reading, and
  commit-history explanation against repositories outside the local workspace.

### Non-relaxable invariants

- No MCP: `allowMcp: false`.
- No toolbox: `allowToolbox: false`. The worker must never expose
  `apply_patch`, `task_list`, local edit, or shell tools.
- No local workspace mutation; no local workspace search.
- No parent-prompt inheritance. The worker is **standalone**: it receives only
  its own assembled system prompt and its composed first user message.
- The `mmr-core` profile is the single source of truth for prompt route,
  safety flags, and tool allowlist policy. Its model preferences are the
  defaults; the only allowed model/thinking override path is
  `mmrCore.subagentModelPreferences.librarian` (or the matching
  resolver-test seam) flowing through `resolveMmrSubagentInvocation` so the
  parent and child routes stay aligned.
- Activation failures fail closed before any worker mutation
  (reuses `extractMmrSubagentActivationFailure`).

## 2. Subagent profile

Adds one entry to the deep-frozen registry in
[`src/extensions/mmr-core/subagent-profiles.ts`](../../src/extensions/mmr-core/subagent-profiles.ts).
The initial slice uses a **static** tool list — the per-call provider-switched
tool policy is deferred (see [§13](#13-open-follow-ups)).

```ts
{
  name: "librarian",
  displayName: "Librarian",
  modelPreferences: [
    { model: "claude-opus-4-6" },
    { model: "gpt-5.4" },
  ],
  thinkingLevel: "medium",
  tools: ["web_search", "read_web_page"],
  promptRoute: "standalone",
  promptBuilder: "librarian",
  allowMcp: false,
  allowToolbox: false,
  enforceLockedMode: false,
  persistSubagentState: false,
}
```

Model preference rationale:

- `claude-opus-4-6` is the preferred research model; long context window and
  strong tool-use behavior suit multi-page web research.
- `gpt-5.4` is the fallback when no Anthropic route is authenticated.
- Both run at `thinkingLevel: "medium"`. The worker must reason across
  repository structure and page content, but it is not the high-effort
  advisory lane owned by `oracle`.

Resolution uses the existing provider-neutral
`selectMmrSubagentModelRoute` helper. If no route resolves, the worker fails
closed with a `model.no-route` activation error before spawning.

## 3. Tool surface and JSON schema

Pi tool name: `librarian`.

Schema (registered through `mmr-subagents`):

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "minLength": 1,
      "description": "Specific remote-repository research question. Name the repository when you know it; include the feature, API, file, commit, branch, or architecture area you want explained; and state what a complete answer should prove."
    },
    "context": {
      "type": "string",
      "description": "Optional background that helps scope the research: why the answer is needed, relevant branch/revision, known files, related repositories, constraints, or prior findings. Do not put secrets or credentials here."
    }
  },
  "required": ["query"],
  "additionalProperties": false
}
```

Input composition (performed before forwarding to the worker conversation):

- Validate `query` as a non-empty string after trimming.
- Validate `context`, when present, as a string.
- If both are present and `context.trim()` is non-empty, the worker's first
  user message is:

  ```text
  Context: <context>

  Query: <query>
  ```

- Otherwise, the first user message is `Query: <query>`.

Rendered result shape:

```ts
interface LibrarianDetails {
  worker: "mmr-subagents.librarian";
  status:
    | "success"
    | "validation-error"
    | "provider-gated"
    | "activation-error"
    | "context-window-exhausted"
    | "aborted"
    | "spawn-error"
    | "worker-error"
    | "empty-output";
  query: string;
  context?: string;
  model?: string;
  reportedModel?: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  aborted: boolean;
  outputTruncated: boolean;
  ignoredJsonLines: number;
  usage: MmrWorkerResult["usage"];
  stopReason?: string;
  errorMessage?: string;
  subagentActivationError?: string;
  stderr: string;
  command: string;
  args: string[];
  cwd: string;
  workerTools: readonly string[];
  trail: readonly MmrWorkerTrailItem[];
}
```

## 4. Activation, gating, and feature surface

`librarian` resolves to one of three states; no interactive approval flow
ships in the initial slice.

| State | Condition | `/mmr-status` |
|---|---|---|
| `active` | `mmr-web` exposes both `web_search` and `read_web_page` as **active** tools | active via `mmr-subagents`; candidates: `librarian` |
| `gated` | `mmr-web` not enabled, or either web tool not active under the selected web backend | gated via `mmr-subagents` with reason |
| `deferred` | Future repository-provider variants whose tools are not shipped yet | deferred through their owning follow-up provider |

Gating reason string (registered through the feature-gate/tool provider):

- `librarian: requires mmr-web with web_search and read_web_page active.`

Capabilities (added to `MmrSubagentsCapabilities`):

```ts
type MmrSubagentsCapability = boolean | (() => boolean);

export interface MmrSubagentsCapabilities {
  finder?: MmrSubagentsCapability;
  oracle?: MmrSubagentsCapability;
  Task?: MmrSubagentsCapability;
  librarian?: MmrSubagentsCapability;
}
```

`librarian: true` is reported only when the active web-tool prerequisites are
met. The feature-gate provider continues to credit `mmr-subagents` with the
attribution string already used for the other workers.

## 5. System prompt assembly

The worker uses `assembleMmrSubagentSurface` with:

- `profile: getMmrSubagentProfile("librarian")`
- `baseSystemPrompt: ""` (no parent inheritance)
- `activeToolManifest`: only `web_search` and `read_web_page`
- `systemPromptDelivery: "replace"`

The concrete prompt builder lives in
[`src/extensions/mmr-subagents/prompts.ts`](../../src/extensions/mmr-subagents/prompts.ts)
and is registered against `mmr-core`'s prompt-assembly registry via
`registerMmrSubagentsPromptBuilders()`.

The rendered surface is a single document (the initial slice has one provider
variant, so no extension concatenation is needed). The full text is pinned in
[`tests/fixtures/mmr-subagent-surface/librarian-local-mvp.md`](../../tests/fixtures/mmr-subagent-surface/librarian-local-mvp.md).

### Rendered system prompt

```text
You are Librarian, a specialized repository research worker.

You are invoked by a parent agent when it needs deep understanding of remote
repositories, multiple related repositories, or repository history. The parent
agent will only receive your final message, so your final answer must contain
every important finding, link, caveat, and conclusion needed to use the result.

## Responsibilities

- Explore remote repository code and directory structure to answer the user's
  specific question.
- Explain architecture, ownership boundaries, APIs, data flow, and important
  dependencies.
- Find implementations, call paths, configuration, tests, and feature entry
  points.
- Explain features end-to-end from user-facing behavior through backend or
  storage behavior when the repository evidence supports it.
- Use commit history, diffs, and file revisions to explain how behavior
  evolved when the question asks about history, regressions, migrations, or
  why code changed.

## Research guidelines

- Use the available tools extensively. Do not answer from memory when
  repository evidence can be checked.
- If the relevant repository pages, files, commits, or diffs cannot be
  fetched and read, stop and say plainly that access failed. Do not answer
  from memory, prior knowledge, or generic familiarity with a project.
- Run independent searches and page reads in parallel whenever the next steps
  do not depend on each other.
- Read enough surrounding context to understand complete logical units. Do
  not rely only on filenames, snippets, or search-result summaries.
- Search across every repository that is relevant to the question. Do not
  stop at the first plausible match if the question asks for a complete
  explanation.
- For evolution questions (regressions, migrations, removals, "why did this
  change"), inspect commit pages or diff pages that show the old and new
  behavior, not only the current file.
- Prefer a thorough, evidence-backed explanation over a short guess. Be
  comprehensive but stay focused on the user's request.
- Use plain-text diagrams only when they clarify structure or flow. Put
  diagrams in fenced code blocks with the language identifier `diagram`.
  Prefer box-drawing diagrams with rounded corners. Use Mermaid only when the
  user explicitly asks for Mermaid.

## Available tools and coverage

You have two tools:

- `web_search` — find public repository pages, source files, documentation,
  commit pages, release notes, or issue threads.
- `read_web_page` — read a specific public URL and return its content.

This worker can research public repository content reachable on the web.
It cannot access connected private repositories, authenticated repository
APIs, non-indexed code search, or private commit history.

If the user asks about a private repository, an authenticated repository, or
content that is not publicly reachable, say plainly that you cannot access it
and stop. This includes public URLs that the tools fail to fetch or parse.
Do not invent findings or provide a memory-based summary.

## Tool usage guidelines

- Start broad enough to identify candidate repositories, directories, files,
  symbols, and commits, then narrow quickly.
- Verify search hits by reading the relevant pages before citing them.
- Track branch, tag, or revision context. When you cite a file line, use the
  correct revision in the link.
- For history questions, compare the old and new behavior with the relevant
  commit or diff page, not just the current file.
- Do not modify repositories, open pull requests, change settings, run local
  shell commands, or inspect the local workspace.

## Communication

- Use Markdown.
- Every code block must include a language identifier such as `ts`, `go`,
  `json`, `text`, or `diagram`.
- Never name tools in the user-facing answer.
  - Bad: "I used web_search and read_web_page to inspect the repository."
  - Good: "I reviewed the repository pages and commit history."
- Answer only the user's specific query. Include related context only when it
  is necessary to understand the answer.
- Do not add preambles or postambles.
  - Do not start with: "I'll look into this", "Here is what I found after
    researching", or "I can help with that."
  - Do not end with: "Let me know if you need anything else", "Hope this
    helps", or "I can investigate further."
- Your final message is the only message returned to the parent agent. Make
  it complete, focused, and ready for the parent to use.
- Use fluent links. Do not show raw URLs as visible text. Link repository,
  directory, file, commit, or symbol names when you mention them by name. Do
  not produce a separate list of bare URLs.
```

Concatenation rules:

- No user-provided value (`query`, `context`) is interpolated into the system
  prompt.
- No instance URLs or credentials appear in the system prompt.
- Provider-variant extensions are not concatenated in the initial slice.

## 6. Parent-visible tool metadata

Registered on the `librarian` Pi tool through `mmr-subagents`:

`description`:

```text
Research remote repositories with the librarian, a read-only repository-understanding worker for code outside the local workspace.

Coverage (initial slice):
- Public repository content reachable through web search and web page reads.

Use the librarian when:
- You need an architecture explanation for a remote repository.
- You need to find where a feature is implemented outside the local workspace.
- You need to compare patterns across remote repositories.
- You need to understand behavior evolution through commits or diffs.
- You need to read, link, or summarize remote files, directories, READMEs, or
  diffs.

Do not use the librarian when:
- The answer is in the local workspace; use read, grep, find, or finder.
- You need to modify files, run code, create branches, or open pull requests.
- You already know the exact local file or local symbol to inspect.
- The question is unrelated to repository code, repository documentation, or
  repository history.

Usage guidelines:
- Name the repository whenever possible (e.g. owner/repo or a full repository URL).
- Ask a specific question with clear success criteria.
- Include context about why you need the answer, relevant branches, commits,
  files, or related repositories.
- Expect a thorough answer suitable for sharing with the user, including
  links and caveats.
- Preserve the librarian's full answer in your response; do not summarize
  away important evidence.

Examples:

Research authentication in a public repository:
{"query":"In kubernetes/kubernetes, explain how service account token authentication is implemented end-to-end.","context":"Focus on the API server request path and cite the main files."}

Trace rendering behavior in a public UI repository:
{"query":"In facebook/react, trace how a function component update reaches the commit phase.","context":"Need the main scheduler and reconciler files with links."}

Understand routing in a public framework:
{"query":"In vercel/next.js, explain how app-route handlers are discovered and invoked.","context":"Focus on current default-branch behavior."}

Compare patterns across two public repositories:
{"query":"Compare request-cancellation handling in axios/axios and node-fetch/node-fetch.","context":"Focus on AbortSignal integration."}

Explain a public commit:
{"query":"In rust-lang/rust, explain what commit 1.75.0 changed about async fn in traits.","context":"Cite the main RFCs and the implementation PR."}
```

`promptSnippet`:

```text
Research remote repositories and repository history with a read-only librarian worker.
```

`promptGuidelines` (one bullet per item; order preserved):

```text
- Use librarian for remote repository research: architecture, external feature implementations, cross-repository pattern comparisons, commit/diff history, and remote file or README inspection.
- Do not use librarian for local workspace reads/searches, code modifications, simple local lookups, or questions unrelated to repository content.
- When calling librarian, name the repository as owner/repo or a full repository URL when possible.
- Ask a precise librarian research question and include intent, branch/revision, known files, commit IDs, or related repositories in `context` when those details matter.
- Return the librarian's full answer to the user-facing response; do not compress away evidence links, caveats, or conclusions.
```

## 7. Runner integration

`createLibrarianTool` follows the existing `finder` / `oracle` standalone
pattern in [`src/extensions/mmr-subagents/finder.ts`](../../src/extensions/mmr-subagents/finder.ts)
and [`src/extensions/mmr-subagents/oracle.ts`](../../src/extensions/mmr-subagents/oracle.ts).

Execution flow:

1. Validate params; on failure return `validation-error`.
2. Resolve `cwd` from `ctx.cwd ?? process.cwd()`.
3. Check activation: `mmr-web` must be enabled and `web_search` +
   `read_web_page` must be active. On failure return `provider-gated` with
   the gating reason — no spawn.
4. Resolve the effective `mmrCore.subagentModelPreferences.librarian`
   override (explicit programmatic override wins) and pass it to
   `resolveMmrSubagentInvocation` with the `librarian` profile and exact
   web-tool allowlist.
5. Assemble the system prompt via `assembleMmrSubagentSurface`.
6. Invoke `runMmrSubagentWorker` (or the injected `runner` for tests):

   ```ts
   runner.run({
     profileName: "librarian",
     prompt: composedFirstUserMessage,
     cwd,
     model: invocation.modelArg,
     tools: ["web_search", "read_web_page"],
     systemPrompt: assembled.systemPrompt,
     systemPromptDelivery: "replace",
     signal,
     outputByteLimit,
     onProgress,
   });
   ```

7. Surface progress in the parent row:
   - placeholder while empty: `librarian: researching repositories…`
   - partial worker output forwarded through `onUpdate`
   - details include query, model, usage, and child trail.

8. On completion, return the worker's final assistant text (truncated by the
   shared runner if it exceeds `outputByteLimit`).
9. Detect activation marker via `extractMmrSubagentActivationFailure`. When
   present, final content is `librarian: subagent activation failed: <reason>`
   and `subagentActivationError` is populated on the details.

## 8. Approval and disable UX — deferred

The initial slice does **not** ship an interactive approval dialog or a
global disable setting. The deferred design is captured in the follow-up
issue (see [§13](#13-open-follow-ups)).

Until then:

- If the worker cannot run (web tools unavailable), it returns
  `provider-gated` with a clear text reason. The parent agent receives that
  reason and can choose how to proceed.
- Users who want to suppress `librarian` entirely should disable `mmr-web`;
  the worker will report gated through `/mmr-status`.

## 9. Error and limit handling

Typed context-exhaustion error (used by the runner adapter):

```ts
export class MmrLibrarianContextWindowError extends Error {
  name = "MmrLibrarianContextWindowError";
}
```

Failure mapping:

| Condition | Status | Parent content |
|---|---|---|
| Invalid params | `validation-error` | `librarian: invalid parameters: <message>` |
| Web tools unavailable | `provider-gated` | `<gating reason>` |
| Activation marker | `activation-error` | `librarian: subagent activation failed: <reason>` |
| Context window limit | `context-window-exhausted` | `librarian: context window limit reached before the worker could return a result.` |
| Abort signal | `aborted` | `librarian: research was cancelled before producing a result.` |
| Spawn throw | `spawn-error` | `librarian: worker failed to spawn: <message>` |
| Nonzero exit, no usable text | `worker-error` | `librarian: worker exited with code <code>.` plus stderr tail |
| Zero exit, empty text | `empty-output` | `librarian: no repository findings were produced. Re-run with a narrower repository and question.` |

`/mmr-status` reports configuration and activation readiness only; per-run
transient failures surface in the tool result details and the TUI row.

## 10. TUI rendering and progress

Reuses the existing `renderMmrSubagentResult` pattern with librarian-specific
labels:

- Active label: `Librarian researching`
- Complete label: `Librarian researched`
- Detail line: the `query` string

Progress placeholder constant:

```ts
export const LIBRARIAN_PROGRESS_PLACEHOLDER =
  "librarian: researching repositories…";
```

Expanded rows show child trail entries exactly like `finder`, `oracle`,
and `Task`.

## 11. Public API additions

Implemented in `src/extensions/mmr-subagents/librarian.ts` and re-exported
from `src/index.ts`:

- `LIBRARIAN_TOOL_NAME`
- `LIBRARIAN_SUBAGENT_PROFILE_NAME`
- `LIBRARIAN_WORKER_TOOLS` (the static allowlist for the initial slice)
- `LIBRARIAN_DESCRIPTION`
- `LIBRARIAN_PROMPT_SNIPPET`
- `LIBRARIAN_PROMPT_GUIDELINES`
- `LIBRARIAN_PARAMETERS_SCHEMA`
- `LIBRARIAN_PROGRESS_PLACEHOLDER`
- `LIBRARIAN_GATING_REASON`
- `buildLibrarianWorkerSystemPrompt`
- `createLibrarianTool`
- `isLibrarianWebToolPrerequisiteActive`
- `registerLibrarianTool`
- `MmrLibrarianContextWindowError`
- Types: `LibrarianParams`, `LibrarianDetails`, `LibrarianStatus`,
  `LibrarianToolDeps`, `ResolveLibrarianInvocationInput`

`getMmrSubagentProfile("librarian")` and
`resolveMmrSubagentInvocation(...)` work out-of-the-box from `mmr-core` once
the profile is registered.

## 12. Testing strategy

Required deterministic tests before merging the initial slice:

- **Profile resolver**
  - `librarian` exists and is deep-frozen.
  - Model preferences resolve in order; `model.no-route` when none resolves.
  - `thinkingLevel === "medium"`.
  - Tools list is exactly `["web_search", "read_web_page"]`.
  - `allowMcp === false`, `allowToolbox === false`.
- **Schema validation**
  - Valid `query`.
  - Valid `query + context`.
  - Missing or blank `query` → `validation-error`.
  - Non-string `context` → `validation-error`.
  - Extra properties rejected.
  - Composed first user message matches the contract (both forms).
- **Activation gating**
  - `mmr-web` disabled → `provider-gated` with reason.
  - `web_search` inactive → `provider-gated`.
  - `read_web_page` inactive → `provider-gated`.
  - Both active → resolves and proceeds to spawn.
- **Prompt fixture**
  - `tests/fixtures/mmr-subagent-surface/librarian-local-mvp.md` pinned and
    byte-for-byte matched by the assembled surface.
- **Feature-gate provider**
  - `librarian: true` in capabilities when active; `librarian: false` (or
    absent) when gated, with a gating-reason string credited to
    `mmr-subagents`.
- **`/mmr-status` output**
  - active, gated, and gated-with-missing-tool cases produce expected lines.
- **Runner fail-closed**
  - settings-driven `subagentModelPreferences.librarian` overrides are read on
    every execute so parent and child model routing cannot drift.
  - shipped modes no longer carry stale availability notes that call
    `librarian` future-only or reserved.
  - activation stderr marker → `activation-error`, final content carries
    the failure reason.
  - explicit model mismatch → fail-closed before any progress event.
  - explicit tools mismatch → fail-closed before any progress event.
- **Cancellation**
  - abort signal → `aborted`.
- **Context-window error**
  - mapped to `MmrLibrarianContextWindowError` with the documented final
    content and details status.
- **Public-safety lint**
  - Rendered prompt fixture contains no internal references, no
    third-party product names, and no non-approved provider names.
  - Examples are public repositories or fictional placeholders.

## 13. Open follow-ups

Tracked as separate GitHub issues; not part of the initial slice.

1. **Hosted Git repository-provider variant for `librarian`** — tracked in
   [#62](https://github.com/5omeOtherGuy/pi-mmr/issues/62). Add a
   GitHub-backed tool set and a provider-switched per-call tool policy on
   the profile. Includes provider selection contract, GitHub-specific prompt
   extension, fixture coverage, and integration with whatever repository-tool
   surface ships in `pi-mmr`.
2. **Bitbucket repository-provider variant for `librarian`** — tracked in
   [#66](https://github.com/5omeOtherGuy/pi-mmr/issues/66). Evaluate the
   read-only Bitbucket tool surface, provider selection contract, fallback
   behavior, and prompt/status/test coverage separately from the GitHub
   variant.
3. **Approval and disable UX for `librarian`** — tracked in
   [#63](https://github.com/5omeOtherGuy/pi-mmr/issues/63). Interactive prompt when a
   required repository provider needs a credential, a global disable setting
   in pi-mmr-owned namespace, and `/mmr-status` reporting for both. Depends
   on Pi exposing an extension-visible approval/select UI primitive; if Pi
   does not expose one, this issue must specify the degraded text-only path
   the worker uses instead.

## 14. Public-safety review checklist

Before opening a PR for the initial slice or for either follow-up:

- All prompt, tool-description, schema, test, fixture, docs, commit, and PR
  text is `pi-mmr`-authored and uses repo-owned vocabulary.
- No internal references or non-public source references appear.
- No private local paths, session data, provider payloads, or credentials
  appear.
- Only approved public provider names and tool identifiers appear in public
  text.
- Examples use public repositories or `example.com` / `acme` placeholders.
- Prompt fixtures are pinned and reviewed.
- Wording describes `pi-mmr` behavior, not external implementation
  provenance.
