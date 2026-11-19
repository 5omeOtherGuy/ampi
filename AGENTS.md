# AGENTS.md

Guidance for coding agents working on `ampi`. Human contributors: see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Profile

- Purpose: Pi Agent extension package (`@skippermissions/ampi` on npm) with locked modes, model routing, tools and workers.
- Stage: released (repository standard)
- Gate: `npm run gate` (CI job `gate`)
- Landing: PR, squash-merged on a green gate; agents land: yes
- Release: release-please PR; agents release: no
- Outside issues and PRs: agents triage; outside PRs merge: owner approves
- Sensitive paths: `src/extensions/ampi-github/config.ts`, `src/extensions/ampi-github/client.ts`, `src/extensions/ampi-web/config.ts`, `src/extensions/ampi-web/config-writer.ts`, `src/extensions/ampi-web/search/brave.ts`, `src/extensions/ampi-core/internal/http-utils.ts` (credential handling); `src/extensions/ampi-web/url-policy.ts`, `src/extensions/ampi-web/reader/direct.ts`, `src/extensions/ampi-history/redaction.ts`, `src/extensions/ampi-history/git-identity.ts` (outbound request policy, redaction); `src/index.ts`, `package.json` (public API, `exports`, `pi.extensions`, `files`, install scripts); `.agents/`, `.githooks/`, `scripts/` (setup, hooks, gate); `.github/`, `release-please-config.json`, `.release-please-manifest.json`, `.npmignore` (CI, release, packaging); `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md` (agent, contributor and security policy)
- Deliberate deviations from the standard:
  - No live tests at all, not even opt-in: the suite is deterministic and never calls a provider or network API.
  - Public text (docs, comments, test names, fixtures, prompts, tool descriptions) is written in `ampi` terms and names no local-only paths, private notes or non-public provenance.
  - `.githooks/pre-commit` refuses commits on the primary checkout's `main` while it is behind `origin/main`: the primary checkout is control-only (see "Landing a change").
  - The gate has no format check: Biome's formatter is off, and turning it on would rewrite most of the tree. That is the owner's call.
  - CI keeps the `Test (Node 24.x)` check because branch protection requires it; it can go once a ruleset requires `gate`.

## Landing a change

`main` changes only through squash-merged PRs, one concern per PR.

1. Work in a worktree branched from `origin/main`, never on the primary checkout's `main`, which only fast-forwards:
   ```bash
   git fetch origin
   git worktree add ~/Work/.worktrees/ampi/<slug> -b <type>/<slug> origin/main
   cd ~/Work/.worktrees/ampi/<slug> && npm run link:node-modules   # share the primary checkout's install
   ```
   `npm run preflight` reports whether the primary checkout is behind `origin/main`.
2. Branch `<type>/<slug>` (`<type>/<issue>-<slug>` with an issue). Commit subjects and the PR title follow Conventional Commits 1.0.
3. Run `npm run gate` before pushing. The PR body follows `.github/pull_request_template.md`: the intent, the changed behavior, the repository constraints it touches, the evidence it works, whether a sensitive path changed, and `Fixes #n` when it resolves an issue.
4. Changes that need an independent review under the `repository-standard` skill get it before merge, recorded on the PR.
5. Merge with `--squash --delete-branch` once `gate` on the head commit is green.
6. Afterwards: `npm run sync:primary` in the primary checkout, then `npm run cleanup:worktree -- ~/Work/.worktrees/ampi/<slug>`.

Do not edit `CHANGELOG.md`: release-please writes it from the squash-merged PR titles, so write the title in user-facing words (`feat`, `fix` and `perf` appear in the changelog; a PR body can replace its entries with a `BEGIN_COMMIT_OVERRIDE` … `END_COMMIT_OVERRIDE` block). Never merge the release PR or publish to npm.

## Rules for this repository

- Tests are hermetic: no provider or network calls, no real user directories, no sleep-based timing. They load source through `tests/helpers/load-src.mjs`, never from `src/` directly. Credential-shaped test values are built from parts (`["AKIA", "..."].join("")`) so the secret scan never sees them.
- Keep the canonical mode keys (`low`, `medium`, `high`, `ultra`, `free`), subagent names and the legacy `mmr-*` exports and mode aliases (`rush`, `smart`, `deep`, `fable`) working.
- `typebox` is pinned to the exact version `@earendil-works/pi-coding-agent` uses; move it only together with the Pi packages.
- Never commit Pi session data, raw provider payloads or `ampi-debug` captures (`.pi/ampi-debug/`).

## Focused tests

```bash
npm run test:one -- tests/<file>.test.mjs     # one file
npm run test:watch -- tests/<file>.test.mjs   # rerun on change
npm run gate -- --verbose                     # the whole gate with live output
```
