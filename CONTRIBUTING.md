# Contributing

Thanks for improving `ampi`. Small fixes are welcome directly as a pull request; larger changes start with an issue so we can agree on the approach first. Every change must pass the gate (`npm run gate`). Contributions are licensed under the repository's [MIT licence](LICENSE); there is no CLA.

## Quick start

1. Fork or branch from `main`.
2. Run `npm ci`.
3. Make the smallest focused change.
4. Add or update deterministic tests for behavior changes.
5. Run the relevant checks:
   - `npm run lint` (Biome linter; `npm run lint:fix` applies safe fixes)
   - `npm test` (use `npm run test:one -- tests/<file>.test.mjs` to focus a
     single file, or `npm run test:watch -- tests/<file>.test.mjs` while iterating)
   - `npm run check`
   - `npm run pack:dry-run` when package contents or exports change
   - `npm run gate` runs everything a change must pass: secret scan, lint,
     tests, type check, and package dry run. CI runs the same command (job
     `gate`), and the pre-push hook runs it before every branch push
     (`npm ci` enables the hooks with `git config core.hooksPath .githooks`).
6. Open a pull request into `main`. It is squash-merged once `gate` is green.

## Pull request workflow

- Use GitHub issues for planned work when the scope is more than a small fix.
- Name branches after the work, for example `fix/redaction-edge-case` or `docs/update-readme`.
- Keep the PR focused on one behavior or documentation change.
- Use the PR body to list summary bullets, verification commands, and follow-up work.
- Link related issues with `Closes #123` when the PR should close an issue on merge.
- Labels are the same in every repository: `bug`, `enhancement`, `docs`, `question`, `needs-info`, `needs-owner`, `accepted`, `P0`, `P1`, `P2`, `good first issue`, `duplicate`, `wontfix`, `dependencies`, `security`.
- After checks finish, review failures with `gh pr checks` or `gh run view --log-failed`.

## Commit messages

Commit subjects and PR titles follow Conventional Commits 1.0 (`type(scope)!: summary`; types `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`; a breaking change takes `!` and a `BREAKING CHANGE:` footer):

- `feat(scope): add new behavior`
- `fix(scope): correct broken behavior`
- `docs(scope): update documentation`
- `test(scope): add or update tests`
- `ci(scope): change GitHub Actions or automation`
- `chore(scope): maintain repo metadata or tooling`

Keep the summary imperative and under 72 characters. Add a body when it helps explain why the change exists or what trade-off it makes.

## Pull request checklist

- Write the PR title in user-facing Conventional Commits form; release-please builds `CHANGELOG.md` from it.
- Do not commit secrets, local session data, raw provider payloads, credentials, private notes, or exact local-only paths.
- Keep public text framed in `ampi` terms.
- Prefer existing helpers and dependencies over new one-off utilities.

## Issues and reviews

New issues are triaged and pull requests reviewed within 7 days. An issue waiting on a reply for 30 days is closed with a note; replying reopens it.

## Tests

Use deterministic local tests only. Do not require live provider/API calls for the default test suite.

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
