# ampi-tui

Owns the look of interactive `ampi` sessions in the terminal. Its first step towards an Amp-compatible single-screen layout removes the footer.

Package overview: [`../../../README.md`](../../../README.md). Planning: [`../../../ROADMAP.md`](../../../ROADMAP.md). Public API: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## At a glance

| Default | Provides | Requires | Diagnostics |
| --- | --- | --- | --- |
| On | Footer-free terminal layout | Interactive Pi session | No footer row below the editor; `/ampi-status` |

## When to use it

- You want the transcript and the prompt to fill the terminal, with no status rows below the editor.
- You are building on ampi's terminal layout: later layout work lands here, not in `ampi-core`.

## Status and enablement

Default: on. `ampi-tui` is registered in `package.json` `pi.extensions` and loads without opt-in config. Opt out with `ampiTui.enabled: false` (see [Configuration](#configuration)).

It acts only in interactive terminal sessions. Print, JSON and RPC runs, subagent workers included, are left untouched. It owns no tools, commands, shortcuts or feature gates.

## Tools / commands / surfaces

| Surface | Type | Purpose |
| --- | --- | --- |
| Footer | Pi footer slot | Replaced with an empty component, so no row is drawn below the editor |

## Configuration

One switch turns the extension off. It has no secrets.

```json
{ "ampiTui": { "enabled": false } }
```

The nested form `{ "ampi": { "tui": { "enabled": false } } }` is accepted too. Settings are read from `~/.pi/agent/settings.json` and then `<project>/.pi/settings.json`. The project file wins. An environment variable overrides both:

| Variable | Effect |
| --- | --- |
| `AMPI_TUI_ENABLE` | `false` turns the extension off, `true` turns it on |
| `MMR_TUI_ENABLE` | Legacy name, read when `AMPI_TUI_ENABLE` is unset |

The setting is read once when the extension loads. Restart Pi or run `/reload` after changing it.

## Behavior

### With ampi-core

- At session start, `ampi-tui` claims ampi's terminal chrome through ampi-core's chrome-owner seam and installs an empty footer.
- While it holds the claim, ampi-core stops drawing its two-line footer in locked modes and no longer brings Pi's footer back in `free` mode.
- Mode switching, mode state and `/ampi-status` work as before.
- The claim is released when the session shuts down. If you turn `ampi-tui` off and reload, ampi-core's footer returns.
- Turned off, `ampi-tui` registers nothing at all, and the footer looks as it did before this extension existed.

### What stays on screen

- Pi's header and its list of loaded resources at startup. Pi's `quietStartup` setting hides them: `"header"` keeps the header and hides the list, `true` hides both.
- The working directory, branch, token usage, cost, context use, model and mode that the footer showed are not shown elsewhere yet. `/ampi-status` still reports the mode and model.

### Planned

Later releases move that information into the borders of the prompt box and add Amp-compatible keys, a command palette, a mode picker, compact tool rows and a welcome header. Each lands behind the same `ampiTui.enabled` switch.

## Diagnostics and troubleshooting

- **The footer still shows.** `ampi-tui` is off (`ampiTui.enabled: false` in a settings file, or `AMPI_TUI_ENABLE=false`), or the session is not interactive. Check both settings files and the environment, then restart Pi.
- **You want the footer back.** Set `ampiTui.enabled` to `false` and restart Pi or run `/reload`.

## Public API

Stable re-exports from `ampi`: `createMmrTuiExtension`, `loadMmrTuiSettings` and the `MmrTuiSettings` / `MmrTuiFactoryOverrides` types, each with its `Ampi*` alias. Canonical catalog: [`../../../docs/public-api.md`](../../../docs/public-api.md). The chrome-owner seam lives in `ampi-core`: [`../../../docs/ampi-core-api.md`](../../../docs/ampi-core-api.md#additional-exported-helpers).

## Developer notes

- Manifest: risk class `terminal-ui`, child role `none`. No subagent child keep-set lists it, and child workers never run in the terminal UI.
- Tests: `tests/mmr-tui-extension.test.mjs` (enablement, run modes, settings, load order) and `tests/mmr-core-status.test.mjs` (ampi-core yields the footer to a chrome owner).
