# ampi-cli

The `ampi` command: Pi with the ampi extensions loaded, plus Amp-compatible short flags and subcommands.

Status: released together with [`@skippermissions/ampi`](../../README.md) from the same repository; while it is `0.x`, a minor release may contain breaking changes.

`ampi` starts the same interactive Pi session as `pi -e npm:@skippermissions/ampi`, with ampi's modes, tools, workers and terminal layout. It exists because a Pi package can only add long `--flags`: options such as `-m high`, and later commands such as execute mode and thread listings, need a command of their own. Everything the command does not handle itself goes to Pi unchanged, so Pi's options (`--model`, `-c`, `-r`, `-p`, `-e`) and its own commands (`install`, `list`, `config`, `mcp`, …) keep working.

## Install

```bash
npm i -g @skippermissions/ampi-cli
```

The package brings its own Pi (`@earendil-works/pi-coding-agent`) and ampi (`@skippermissions/ampi`) as dependencies. Sign in to a provider the way you do for Pi; the command uses Pi's configuration directory (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`).

## Usage

```bash
ampi                     # interactive session in your default mode
ampi -m high             # start in high mode (same as --ampi-mode high)
ampi "fix the failing test in parser.test.ts"   # start with a first message
ampi -c                  # continue the most recent session (Pi's -c)
ampi --model openai/gpt-5.6-sol -m ultra        # Pi options and ampi options together
ampi version             # ampi-cli, ampi and Pi versions
ampi --help              # all options
ampi --pi-help           # Pi's own options, including the flags ampi's extensions add
```

| ampi option | What it does |
| --- | --- |
| `-m`, `--mode <mode>` | Start in an ampi mode: `low`, `medium`, `high`, `ultra` or `free`, or a legacy alias. `--mode text`, `json` and `rpc` keep Pi's meaning (output format). |
| `--title <title>`, `-l`, `--label <label>` | Accepted and ignored for now, with a notice on stderr. |
| `--settings-file <path>` | Rejected: Pi reads its settings from its configuration directory; set `PI_CODING_AGENT_DIR` to use another one. |
| `-h`, `--help`, `help` | Print ampi's help. |
| `-V`, `-v`, `--version`, `version` | Print the versions. |
| `--` | Hand everything after it to Pi as the message, without reading ampi options. |

## Behavior

### If ampi is also installed as a Pi package

The command loads ampi only when Pi would not load it anyway. When Pi's user or project settings list `@skippermissions/ampi` (from npm, git or a local path), or a `-e` argument names it, Pi loads that copy and the command adds nothing; it prints `ampi: using ampi from Pi's settings (<source>)` on stderr. Loading ampi twice would register every ampi tool, command and flag twice, and Pi refuses to start in that case. With `--no-extensions` (`-ne`), Pi skips its settings packages, so the command adds its own ampi.

Project settings count even before you trust the project: once you grant trust, Pi loads the project's ampi.

### Pi's own commands

When the first argument is one of Pi's commands (`install`, `remove`, `uninstall`, `update`, `list`, `config`, `auth`, `mcp`), the command line goes to Pi untouched and ampi is not added.

## Compatibility

- **Pi:** 1.3 or later within 1.x, installed as a dependency.
- **Node.js:** 22.19 or later.
- **Last verified:** 2026-10-18, with Pi 1.3.0 and Node.js 24.22.0 (interactive session in a terminal, with and without ampi installed as a Pi package).

## Development

From a checkout of the repository, after `npm ci` at its root:

```bash
node packages/ampi-cli/bin/ampi.js -m low
npm run test:one -- tests/mmr-cli-argv.test.mjs
```

The package is plain JavaScript with JSDoc types and no build step; the root `npm run gate` lints, type-checks and packs it. See the repository's [`CONTRIBUTING.md`](../../CONTRIBUTING.md).

## License

[MIT](LICENSE).
