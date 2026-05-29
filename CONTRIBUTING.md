# Contributing

Thanks for improving `pi-mmr`.

## Quick start

1. Fork or branch from `main`.
2. Run `npm ci`.
3. Make the smallest focused change.
4. Add or update deterministic tests for behavior changes.
5. Run the relevant checks:
   - `npm test`
   - `npm run check`
   - `npm run pack:dry-run` when package contents or exports change
6. Open a pull request into `main`.

## Pull request workflow

- Use GitHub issues for planned work when the scope is more than a small fix.
- Name branches after the work, for example `fix/redaction-edge-case` or `docs/update-readme`.
- Keep the PR focused on one behavior or documentation change.
- Use the PR body to list summary bullets, verification commands, and follow-up work.
- Link related issues with `Closes #123` when the PR should close an issue on merge.
- Use labels to make release notes and triage easier: `bug`, `enhancement`, `documentation`, `security`, `dependencies`, `chore`, `tooling`, or `good first issue`.
- After checks finish, review failures with `gh pr checks` or `gh run view --log-failed`.

## Commit messages

Prefer Conventional Commits for new commits:

- `feat(scope): add new behavior`
- `fix(scope): correct broken behavior`
- `docs(scope): update documentation`
- `test(scope): add or update tests`
- `ci(scope): change GitHub Actions or automation`
- `chore(scope): maintain repo metadata or tooling`

Keep the summary imperative and under 72 characters. Add a body when it helps explain why the change exists or what trade-off it makes.

## Pull request checklist

- Update `CHANGELOG.md` under `## Unreleased` for user-visible or operator-visible changes.
- Do not commit secrets, local session data, raw provider payloads, credentials, private notes, or exact local-only paths.
- Keep public text framed in `pi-mmr` terms.
- Prefer existing helpers and dependencies over new one-off utilities.

## Tests

Use deterministic local tests only. Do not require live provider/API calls for the default test suite.

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
