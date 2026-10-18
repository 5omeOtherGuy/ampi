## Intent

<!-- Why this change: the problem it solves or the goal it serves. -->

<!--
The PR title is the changelog entry: use Conventional Commits in user-facing
words (`feat: ...`, `fix(ampi-core): ...`). release-please builds CHANGELOG.md
from it; do not edit CHANGELOG.md by hand.
-->

## Changed behavior

<!-- What users, callers or contributors will see differently. "None" for a pure refactor. -->

-

## Constraints touched

<!--
Which repository rules this change touches (AGENTS.md "Rules for this
repository", docs/adr/), for example the canonical mode keys, the legacy
`mmr-*` exports and aliases, hermetic tests or the pinned `typebox`. "None"
if it touches none.
-->

-

## Evidence

<!-- How you verified it: commands and their decisive output, tests added, manual checks. -->

- [ ] `npm run gate`

## Sensitive paths

<!--
Does this PR change a path listed under "Sensitive paths" in the AGENTS.md
profile, a public interface, security-sensitive code, auth or credential
handling, install or setup, deployment, CI or release configuration, or
agent policy files (`AGENTS.md`, `.agents/`, `.githooks/`)? These need review
whether the path is listed or not, and docs changes that alter rules or
executable instructions count too. If yes, an independent review (another
agent or the owner) reads the diff and records its verdict on this PR
against the reviewed head commit before merge; a later push needs a new
review.
-->

- [ ] No sensitive path or category changed.
- [ ] A sensitive path or category changed: independent review recorded on this PR for head commit `<sha>`.

## Linked issues

Fixes #

## Checklist

- [ ] The PR title is a user-facing Conventional Commit, and breaking changes carry `!` and a `BREAKING CHANGE:` footer.
- [ ] I did not include secrets, private session data, provider payloads, credentials, or local-only notes.
- [ ] Public-facing text uses `ampi` project terms and is safe to publish.
