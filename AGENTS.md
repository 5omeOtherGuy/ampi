# AGENTS.md

Guidance for coding agents working on `ampi`. Human contributors: see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Profile

- Purpose: Pi Agent extension package (`@skippermissions/ampi` on npm) with locked modes, model routing, tools and workers.
- Stage: released (repository standard 2026-10-17)
- Gate: `npm run gate` (CI job `gate`)
- Landing: PR, squash-merged on a green gate; agents land: yes
- Release: release PR prepared by hand (release-please not adopted yet); agents release: no
- Outside issues and PRs: agents triage; outside PRs merge: owner approves
- Deliberate deviations from the standard:
  - No live tests at all, not even opt-in: the suite is deterministic and never calls a provider or network API.
  - Public text (docs, comments, test names, fixtures, prompts, tool descriptions) is written in `ampi` terms and names no local-only paths, private notes or non-public provenance.
  - `.githooks/pre-commit` refuses commits on the primary checkout's `main` while it is behind `origin/main`: the primary checkout is control-only (see "Landing a change").
  - The gate has no format check: Biome's formatter is off, and turning it on would rewrite most of the tree. That is the owner's call.
  - CI keeps the `Test (Node 24.x)` check because branch protection requires it; it can go once a ruleset requires `gate`.

## Where things live

| Path | What |
| --- | --- |
| `src/extensions/<name>/` | One Pi extension per directory; `package.json` `pi.extensions` lists the registered ones in load order. `ampi-debug` is developer-only and never packed; `ampi-toolbox` is a deprecated shim. |
| `src/index.ts`, `package.json` `exports` | Public API, including the legacy `mmr-*` subpaths. |
| `tests/*.test.mjs` | `node:test` suites. They load source through `tests/helpers/load-src.mjs`, never from `src/` directly; fixtures are in `tests/fixtures/`. |
| `docs/` | User and contributor docs (shipped in the package, except `docs/private/`); decisions in `docs/adr/`. |
| `scripts/gate.sh` | The gate: secret scan, lint, tests, type check, `npm pack --dry-run`. |
| `scripts/*worktree*`, `scripts/sync-primary.sh`, `scripts/link-node-modules.sh` | Worktree workflow helpers (below). |
| `.agents/setup` | Orb setup: Node.js check, `npm ci`, hooks, credential presence report. Idempotent. |
| `REPOMAP.md`, `INDEX.md` | Detailed source map and navigation. |

## Landing a change

`main` changes only through squash-merged PRs, one concern per PR.

1. Work in a worktree branched from `origin/main`, never on the primary checkout's `main`, which only fast-forwards:
   ```bash
   git fetch origin
   git worktree add ../ampi-<slug> -b <type>/<slug> origin/main
   cd ../ampi-<slug> && npm run link:node-modules   # share the primary checkout's install
   ```
   `npm run preflight` reports whether the primary checkout is behind `origin/main`.
2. Branch `<type>/<slug>` (`<type>/<issue>-<slug>` with an issue). Commit subjects and the PR title follow Conventional Commits 1.0.
3. Run `npm run gate` before pushing. The PR body says what changed, why, how it was verified, and `Fixes #n` when it resolves an issue.
4. Changes to public interfaces, security-sensitive code, CI or release configuration get an independent review (another agent or the owner) before merge; record the verdict in the PR.
5. Merge once the latest `gate` run on the head commit concluded `success` (skipped, cancelled or missing is not green): `gh pr merge <number> --squash --delete-branch --match-head-commit <sha>`. There is no ruleset yet, so do not use `--auto`.
6. Afterwards: `npm run sync:primary` in the primary checkout, then `npm run cleanup:worktree -- ../ampi-<slug>`.

Record user-visible changes in `CHANGELOG.md` under `## Unreleased`. Never merge a release PR or publish to npm.

## Rules for this repository

- Tests are hermetic: no provider or network calls, no real user directories, no sleep-based timing. Credential-shaped test values are built from parts (`["AKIA", "..."].join("")`) so the secret scan never sees them.
- Keep the canonical mode keys (`low`, `medium`, `high`, `ultra`, `free`), subagent names and the legacy `mmr-*` exports and mode aliases (`rush`, `smart`, `deep`, `fable`) working.
- `typebox` is pinned to the exact version `@earendil-works/pi-coding-agent` uses; move it only together with the Pi packages.
- Never commit secrets, Pi session data, raw provider payloads or `ampi-debug` captures (`.pi/ampi-debug/`).
- Do not add status or handoff files; work state lives in issues and PRs.

## Focused tests

```bash
npm run test:one -- tests/<file>.test.mjs     # one file
npm run test:watch -- tests/<file>.test.mjs   # rerun on change
npm run gate -- --verbose                     # the whole gate with live output
```
