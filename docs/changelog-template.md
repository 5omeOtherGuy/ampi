# ampi changelog template

**Audience.** Contributors editing `CHANGELOG.md`. Use this template for every substantial user-visible or operator-visible change.

**Related.** Documentation conventions: [`documentation-style-guide.md`](./documentation-style-guide.md).

Keep text public-safe and describe only `ampi` behavior.

## Section order

Add each new bullet under `## Unreleased` using one of these headings:

1. `### Added`
2. `### Changed`
3. `### Fixed`
4. `### Removed`
5. `### Security`
6. `### Documentation`

Omit empty headings. A heading that is present must contain at least one top-level `- ` bullet.

## Bullet template

```md
### Added

- `ampi-core`: concise behavior summary. Include the user-visible effect, any new public API/settings/commands, and the deterministic tests or fixtures that cover it.
```

Prefer extension-prefixed bullets such as `ampi-core`, `ampi-toolbox`, `ampi-web`, `ampi-workers`, or `ampi-history`.
For cross-extension changes, use `` `ampi-core` / `ampi-workers`: ...``.

## GitHub-generated release notes

GitHub release notes are configured in `.github/release.yml`. PR labels determine the generated categories, and the category titles intentionally match the `CHANGELOG.md` headings above.

Before cutting a release, generate notes from merged PRs:

```sh
npm run release:notes -- v0.1.0 --previous-tag v0.0.0 --output ./release-notes/ampi-v0.1.0.md
```

Review the generated notes for public-safe wording, then copy/adapt the relevant bullets into the versioned `CHANGELOG.md` section. `CHANGELOG.md` remains the packaged offline source that Pi displays after `pi update`; GitHub-generated notes are the release-time input and GitHub Release body.

## Release template

When cutting a release, use the reviewed GitHub-generated release notes plus the accumulated `Unreleased` bullets to create a versioned section, then reset `Unreleased` for future work:

```md
## Unreleased

### Added

- Next change goes here.

## [0.1.0] - YYYY-MM-DD

### Added

- Released change goes here.
```

The startup changelog reader displays the current notes the first time it observes an install, then every versioned section newer than the user's last seen `ampi` version on later updates. It also tracks `Unreleased` bullets by fingerprint so repeated updates between releases show only the bullets added since the previous update.

## Automated PR-body sync

The `changelog-sync` GitHub Actions workflow can append `Unreleased` bullets for you when the PR body contains a marker block. The workflow runs on `pull_request` events targeting `main` and commits the resulting `CHANGELOG.md` diff back to the PR's head branch as `github-actions[bot]`.

### Marker syntax

Wrap the bullets you want appended in HTML comments inside the PR body:

```md
<!-- ampi changelog:start -->
### Fixed

- `ampi-core`: short, public-safe bullet describing the user-visible effect.

### Added

- `ampi-web`: another bullet under a different canonical heading.
<!-- ampi changelog:end -->
```

Headings must match the canonical list (`Added`, `Changed`, `Fixed`, `Removed`, `Security`, `Documentation`). At least one bullet is required. The whole PR body is scanned for public-unsafe wording before any write.

### Two contributor paths

Either path is accepted:

1. **Manual edit.** Add bullets directly under `## Unreleased` in `CHANGELOG.md` in your branch, the same as before. The workflow becomes a no-op because the bullets are already present.
2. **PR-body block.** Add the marker block to the PR body. On the next `pull_request` event, the workflow appends new bullets at the canonical position under `## Unreleased` and commits the diff back to your branch.

### Caveats

- **Reworded bullets become duplicates.** Bullets are deduplicated by `sha256("<heading>\n<bulletContent>")`. Editing a bullet's wording after the bot has committed it will produce a second bullet rather than updating the first. Edit `CHANGELOG.md` directly when you want to revise an already-appended bullet.
- **Removals don't propagate.** Removing a bullet from the PR-body block does not remove it from `CHANGELOG.md`. To remove a bullet, edit `CHANGELOG.md` directly.
- **Pull the bot's commit.** After the workflow runs, `git pull` (or `git fetch && git rebase`) before re-running local tests so your working tree includes the bot's CHANGELOG commit. Re-running `npm test` without pulling will see the old CHANGELOG and may disagree with CI.

### Fallback paths

- **Fork PRs.** `GITHUB_TOKEN` is read-only on fork-originated `pull_request` events, so the workflow skips itself; fork contributors edit `CHANGELOG.md` manually.
- **`skip-changelog` label.** Apply this label to suppress the workflow for deliberately non-user-visible PRs (the same label is already honored by `scripts/check-changelog.mjs` and `.github/release.yml`).
