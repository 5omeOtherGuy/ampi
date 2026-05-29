# Agent instructions for pi-mmr

## Project overview

You are working in the `pi-mmr` repository, a Pi package that provides modular
multi-model-routing extensions. Each extension lives under `src/extensions/<name>/` and is registered through `package.json` `pi.extensions`.

Do not copy local-only analysis artifacts, confidential notes, provider payloads,
credential material, externally sourced prompt material, or exact local paths into this repo.

Treat all repository text as potentially public: commit messages, branch names,
PR titles, PR bodies, issues, changelog entries, release notes, README/docs,
code comments, test names, snapshots, fixtures, package metadata, and generated
artifacts.

Public text must describe only `pi-mmr` behavior, using repo-owned concepts:

Allowed public vocabulary:
- `pi-mmr`
- `mmr-core`, `mmr-toolbox`, `mmr-web`, `mmr-<extension-name>`
- Pi package / Pi extension behavior
- mode routing
- provider-neutral model preferences
- thinking policy
- tool allowlists
- feature gates
- diagnostics
- prompt-head rewrite
- session-scoped state
- public API exports
- settings, tests, docs, and package behavior
- tools such as `apply_patch`, `task_list`, `web_search`, `read_web_page`

Mode keys are the public, shipped names. `smart`, `smartGPT`, `rush`, `large`, `deep`, and `free` are the user-facing locked mode keys. Subagent names are the public, shipped names: `finder`, `oracle`, `librarian`, `history-reader`, `task-subagent` (tool name `Task`). These are stable identifiers — do not rename them in code, CLI flags, settings keys, persisted state, fixtures, or model-visible prompt text without a coordinated migration plan.

Before committing, opening a PR, updating docs, or adding tests/fixtures:

1. Review all new public-facing text.
2. Remove non-public provenance, confidential product details, externally
   sourced prompt material, raw provider request/response data, exact local
   paths, credentials, and local-only evidence from public text.
3. Rephrase the change as a `pi-mmr` behavior, API, test, or documentation
   update.
4. If the only available explanation depends on local-only context, do not
   include that explanation publicly; ask for safe wording instead.

## Prompt and tool-surface work

Treat model-visible prompt text, tool descriptions, prompt snippets,
prompt guidelines, and JSON-schema descriptions as behavior. Preserve their
observable `pi-mmr` semantics when editing, but keep wording repo-owned and
limited to capabilities actually exposed by the implementation.

Keep prompt work aligned with `pi-mmr`'s prompt architecture: `mmr-core` mode
prompts surgically replace only Pi's auto-rendered head and must preserve Pi's
`Available tools:`, `Guidelines:`, `Pi documentation`, appended system prompt,
project context, skills, date/cwd, and other extension tail content according to
the prompt-assembly contract. Tool `description`, `promptSnippet`,
`promptGuidelines`, and schema descriptions are registered tool metadata; Pi may
surface them in the active tool inventory and provider tool schema, and the
debug fixture renders them for review even when they are not literally injected
as one contiguous system-prompt block. Subagent/worker prompts are separate
system prompts passed to worker invocations and should preserve target behavior
while using Pi-native tool names and the worker's actual allowlist/capabilities.
Do not add prompt instructions that assume unavailable tools, extra workers, MCP,
network access, mutation rights, or provider behavior the implementation does
not expose.

## Repository layout

- `src/extensions/<name>/` — one directory per extension.
- `src/index.ts` — package-level exports.
- `docs/` — implementation-relevant docs and research links.
- `tests/` — tests.

## Commands

- Test: `npm test`
- Package dry run: `npm run pack:dry-run`
- Typecheck after dependencies are installed: `npm run check`
- Pi smoke test from the checkout under test: `pi -e "$PWD" --list-models`

Dependency note:

- If `node_modules/.bin/tsc` is missing in the checkout, do not report
  `tsc: not found` as a product/test failure; install dependencies (with
  approval) or make them available locally first.
- `npm test` uses `tests/helpers/load-src.mjs`, which symlinks the checkout's
  `node_modules` into temporary source copies so peer imports such as
  `@earendil-works/pi-coding-agent` resolve. An `ERR_MODULE_NOT_FOUND` for a
  peer package usually means the checkout lacks `node_modules`, not a code
  failure.

Do not install dependencies, publish, push, configure remotes, or perform destructive git operations without explicit approval.

## Workflow

- Branch from `main`, implement narrowly, and add or update deterministic tests
  for behavior changes first (no live provider/API calls). For docs-only or
  mechanical changes, use the lightest useful verification (for example
  `git diff --check`).
- Before opening a PR or merging, run `npm test && npm run check && npm run pack:dry-run`;
  add the Pi smoke test when extension loading changed: `pi -e "$PWD" --list-models`.
- Update `CHANGELOG.md` under `Unreleased` (see `docs/changelog-template.md`) for
  user-visible or operator-visible changes. `npm test` runs
  `scripts/check-changelog.mjs`, which enforces the heading template, validates
  `.github/release.yml` categories for GitHub-generated release notes, and
  requires a changelog entry for monitored source/docs/package changes unless
  `PI_MMR_CHANGELOG_NOT_NEEDED=1` is deliberately set for a non-user-visible
  change.
- Keep repository automation aligned with `.github/dependabot.yml`,
  `.github/workflows/codeql.yml`, and `.github/workflows/dependency-review.yml`;
  Dependabot and CodeQL run on GitHub, not as local preflight gates.
- For approved releases, draft notes with
  `npm run release:notes -- vX.Y.Z --previous-tag vA.B.C --output <draft.md>`,
  review them for public-safe wording, update the versioned `CHANGELOG.md`
  section, then align `package.json`, the changelog, the Git tag `vX.Y.Z`, and
  the GitHub Release.

## Coding guidelines

- TypeScript strict mode only.
- Keep modules small and focused.
- Prefer explicit types over `any`; use `unknown` for truly unknown values.
- Avoid type assertions unless localized and justified.
- Each extension must preserve its own routing invariants; document them in the extension's own README.
- Do not scaffold or extend additional extensions without explicit approval.

## Prompt and tool metadata guidelines

- Treat model-visible prompt text, tool descriptions, and JSON-schema field descriptions as behavior, not comments.
- Tool metadata should give enough prompt reach for the model to choose the right tool without guessing: include when to use it, when not to use it, what inputs should contain, and what output or success criteria matter.
- Prefer concrete, high-signal guidance over short generic descriptions. Name relevant artifacts such as file types, APIs, expected code patterns, scoped directories, freshness requirements, or safety constraints when those details affect tool choice.
- Include positive and negative examples for non-obvious tools, especially when a vague query would produce poor results or a direct built-in tool would be better.
- Keep prompt/schema wording public-safe and repo-owned. Do not copy third-party prompt text or explain changes through local-only material; express the behavior in `pi-mmr` terms.
- Update deterministic tests and effective-surface fixtures when model-visible prompt, tool description, prompt guideline, or schema text changes.

## Testing guidelines

- Test observable behavior through public module/extension surfaces.
- Add tests before changing behavior when practical.
- Prefer fixtures/snapshots for routing state, tool resolution, persisted state parsing, and generated prompts.

## Security and privacy

- Never commit secrets, API keys, local session data, logs, or local-only source bundles.
- Do not copy private runtime data into this repo.
- Keep history-reading, toolbox/MCP, provider-payload, and subagent behavior in dedicated extensions, not in shared/core code.
