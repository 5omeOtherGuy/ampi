# ADR-0001: Canonical ampi-* rebrand with layered backward compatibility

**Date**: 2026-07-03
**Status**: accepted
**Deciders**: 5omeOtherGuy + agent session (shipped in PR #210)

## Context

The package renamed from `pi-mmr` to `ampi`, but users and tooling depend on
`mmr`-era surfaces: `/mmr-*` commands, `--mmr-*` flags, `MMR_*` env vars,
`mmr*` settings blocks, `Mmr*`/`MMR_*` exports, `mmr-*` feature gates, and
`mmr-*` persisted session entries. A rename that breaks any of these strands
would break existing configs and resumed sessions.

## Decision

Adopt canonical `ampi` / `ampi-*` / `AMPI_*` / `ampi*` names everywhere new,
while keeping every legacy `mmr` surface as a working alias. Canonical wins
when both are set (env, settings); writers emit canonical; readers accept both
(persisted keys, gates, flags, commands). Stable mode keys, subagent/tool
names, test filenames, `PI_MMR_*` test switches, and the `<mmr_mode>` prompt
marker are intentionally not renamed.

## Alternatives Considered

### Alternative 1: Hard rename, no aliases

- **Pros**: Simplest codebase, no dual-name maintenance.
- **Cons**: Breaks existing env/settings/configs, resumed sessions, and downstream imports.
- **Why not**: Unacceptable breakage for zero user benefit.

### Alternative 2: Alias-only (keep mmr canonical, add ampi as alias)

- **Pros**: Minimal churn.
- **Cons**: New brand never becomes the real name; docs/UX stay inconsistent.
- **Why not**: Defeats the point of the rebrand.

## Consequences

### Positive

- Existing users upgrade with zero config changes; resumed sessions load legacy persisted state.
- All new docs, config writes, and model-visible text are consistently `ampi`.

### Negative

- Dual-name surface must be maintained (precedence readers, dual gate answers, compat exports).
- Legacy `Mmr*` exports without canonical twins remain in the public API indefinitely.

### Risks

- Alias drift (a new knob added only under one name) — mitigated by shared
  `readPreferredEnv`-style helpers and deterministic tests covering both names.
