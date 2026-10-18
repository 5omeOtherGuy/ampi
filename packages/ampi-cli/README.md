# ampi-cli

The `ampi` command: Pi with the ampi extensions loaded, plus Amp-compatible short flags and subcommands.

Status: released. Versioned on its own, next to [`@skippermissions/ampi`](../../README.md) in the same repository; while it is 0.x, a minor release may contain breaking changes.

`ampi` starts the same interactive Pi session as `pi -e npm:@skippermissions/ampi`, with ampi's modes, tools, workers and terminal layout, and runs single prompts from scripts with `ampi -x`. It exists because a Pi package can only add long `--flags`: options such as `-m high` and `-x`, and later commands such as thread listings, need a command of their own. Everything the command does not handle itself goes to Pi unchanged, so Pi's options (`--model`, `-c`, `-r`, `-p`, `-e`) and its own commands (`install`, `list`, `config`, `mcp`, …) keep working.

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
ampi -x "list the npm scripts"                  # run one message and print the answer
ampi -c                  # continue the most recent session (Pi's -c)
ampi --model openai/gpt-5.6-sol -m ultra        # Pi options and ampi options together
ampi version             # ampi-cli, ampi and Pi versions
ampi --help              # all options
ampi --pi-help           # Pi's own options, including the flags ampi's extensions add
```

| ampi option | What it does |
| --- | --- |
| `-m`, `--mode <mode>` | Start in an ampi mode: `low`, `medium`, `high`, `ultra` or `free`, or a legacy alias. `--mode text`, `json` and `rpc` keep Pi's meaning (output format). |
| `-x`, `--execute` | Run one message without the terminal UI and print only the final assistant message. See [Execute mode](#execute-mode). |
| `--stream-json` | In execute mode, print the run as JSON records, one per line, instead of the final message. See [Stream JSON](#stream-json). |
| `--stream-json-thinking` | `--stream-json` with the model's thinking blocks. |
| `--timings` | In execute mode, print the startup, turn and total durations to stderr. |
| `--no-archive-after-execute` | Keep an execute-mode session out of the archive. |
| `--title <title>` | Name the session; the same as Pi's `--name`. |
| `-l`, `--label <label>` | Add a label to the session in ampi's thread index. Repeat it for several labels. |
| `--settings-file <path>` | Rejected: Pi reads its settings from its configuration directory; set `PI_CODING_AGENT_DIR` to use another one. |
| `-h`, `--help`, `help` | Print ampi's help. |
| `-V`, `-v`, `--version`, `version` | Print the versions. |
| `--` | Hand everything after it to Pi as the message, without reading ampi options. |

## Execute mode

`ampi -x` runs one message through Pi's print mode with ampi loaded, writes only the final assistant message to stdout, followed by a newline, and exits. Everything else, such as warnings, errors and `--timings`, goes to stderr, so the output can be piped or saved as it is.

```bash
ampi -x "list the npm scripts and what they do"
git diff | ampi -x "review this change" > review.md
ampi -x -m high --title "Release check" -l release "check the changelog against the tags"
ampi < prompt.txt > answer.md        # execute mode without -x: input and output are redirected
```

- **The message.** The argument, stdin, or both. With both, the message is the argument, a newline, then stdin. Stdin is read to its end when it is not a terminal; leading and trailing whitespace is dropped, as Pi does. `@file` arguments are attached as in Pi.
- **Without `-x`.** When stdin or stdout is not a terminal, `ampi` runs execute mode on its own, where plain Pi would switch to its print mode. Pi's own output options keep their meaning: with `-p`, `--mode json` or `--mode rpc`, Pi handles the run as it would without ampi. `--mode json` together with `-x` prints Pi's JSON event stream instead of the final message; `--mode rpc` together with `-x` is a usage error.
- **The mode.** `-m` picks the ampi mode. Without it the session starts in your `defaultMode` setting, or `medium`.
- **Threads.** A session the run creates is archived in ampi's thread index when the run ends, so it stays out of the way of interactive work; `--no-archive-after-execute` keeps it unarchived. A session continued with `-c`, `-r` or `--session` that already had messages is left as it was. `--title` names the session, and `-l` adds labels to it. Archive and labels need the `ampi-threads` extension, which is on by default; when it is off, labels are reported on stderr as not stored and nothing is archived.
- **Tools.** Pi does not ask before tool calls, so the agent uses its tools as in an interactive session. Execute mode has no terminal to ask in: an extension that asks you to confirm something gets "no", as in Pi's print mode.

Exit status: `0` when the final message was printed, `1` when the agent or Pi failed (the error is on stderr; an answer cut off at the model's output limit also counts), `2` for a usage error, such as no message in the argument or on stdin. `--timings` and `--no-archive-after-execute` outside execute mode are usage errors too.

## Stream JSON

`ampi -x --stream-json` prints the run as it happens, one JSON record per line (JSONL), in the record format of Claude Code's `stream-json` output, so tools that read that format can drive ampi. Each record is written as soon as Pi reports the message it describes. `--stream-json-thinking` does the same and also includes the model's thinking.

```bash
# The assistant's text, message by message
ampi -x "list files" --stream-json | jq -r 'select(.type == "assistant") | .message.content[] | select(.type == "text") | .text'

# Every tool call with its input
ampi -x "list files" --stream-json | jq -c 'select(.type == "assistant") | .message.content[] | select(.type == "tool_use") | {name, input}'

# The outcome, the number of turns and the token usage
ampi -x "list files" --stream-json | jq -c 'select(.type == "result") | {subtype, num_turns, usage}'
```

The records, in order:

| Record | When | Fields |
| --- | --- | --- |
| `{"type": "system", "subtype": "init"}` | First | `cwd`; `session_id`, the session's id (the same as in ampi's thread index); `tools`, the names of the tools the model can call; `mcp_servers`; `agent_mode`, the ampi mode, left out when no ampi mode is active. |
| `{"type": "user"}` | For the message and each tool result | `message.content`: `text` blocks, or one `tool_result` block (`tool_use_id`, `content` as text, `is_error`); `parent_tool_use_id`; `session_id`. |
| `{"type": "assistant"}` | For each answer of the model | `message.content`: `text`, `tool_use` (`id`, `name`, `input`), and with `--stream-json-thinking` `thinking` (`thinking`) and `redacted_thinking` (`data`); `message.stop_reason`: `end_turn`, `tool_use`, `max_tokens` or `null`; `message.usage`: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`; `parent_tool_use_id`; `session_id`. |
| `{"type": "result"}` | Last | `subtype` `success` with `result`, the final answer's text, or `error_during_execution` with `error`; `is_error`; `duration_ms`; `num_turns`; `session_id`; `usage`, summed over the run. |

- **Exit status.** As in execute mode: `0` with a `success` result, `1` with an error result (a failed or aborted request, or an answer cut off at the model's output limit), `2` for a usage error, which prints no records. When Pi's automatic retry recovers from a failed request, the run succeeds.
- **Usage errors.** `--stream-json` needs execute mode: `-x`, or redirected input or output. It replaces Pi's output format, so it cannot be combined with `--mode text`, `json` or `rpc`. `--stream-json-thinking` implies `--stream-json`.
- **Not included.** Subagent output is not streamed, so `parent_tool_use_id` is always `null`. `mcp_servers` is always empty, because Pi does not tell extensions the connection state of its MCP servers. Images in messages and tool results are left out, and Pi has no turn limit, so there is no `error_max_turns` result. Pi's own diagnostics stay on stderr; an error that stops Pi before the session starts is reported there, without records.
- **Pi's own format.** `ampi -x --mode json` prints Pi's JSON event stream instead, with every streaming update.

## Behavior

### If ampi is also installed as a Pi package

The command loads ampi only when Pi would not load it anyway, and otherwise prints `ampi: using the ampi that Pi already loads (<source>)` on stderr. Pi already loads ampi when:

- a `-e` argument names it: `npm:@skippermissions/ampi`, ampi's git repository, or a path inside an ampi checkout;
- Pi's user or project settings list it under `packages` (from npm, git or a local path) or `extensions`;
- one of Pi's extension directories (`~/.pi/agent/extensions/`, `.pi/extensions/`) contains it;
- the settings list `npm:@skippermissions/ampi` or ampi's git repository and Pi has not installed it yet: Pi installs it when it starts.

Loading ampi twice would register every ampi tool, command and flag twice, and Pi refuses to start in that case. With `--no-extensions` (`-ne`), Pi skips everything but `-e` arguments, so the command adds its own ampi.

Project settings count even before you trust the project: once you grant trust, Pi loads the project's ampi.

### Pi's own commands

When the first argument is one of Pi's commands (`install`, `remove`, `uninstall`, `update`, `list`, `config`, `auth`, `mcp`), the command runs Pi's own executable with the command line untouched, and ampi is not added.

## Compatibility

- **Pi:** 1.3 or later within 1.x, installed as a dependency.
- **Node.js:** 22.19 or later.
- **Last verified:** 2026-10-18, with Pi 1.3.0 and Node.js 24.22.0 (interactive session in a terminal, with and without ampi installed as a Pi package; execute mode with piped and terminal input and output; stream JSON with and without thinking).

## Development

From a checkout of the repository, after `npm ci` at its root:

```bash
node packages/ampi-cli/bin/ampi.js -m low
npm run test:one -- tests/mmr-cli-argv.test.mjs
```

The package is plain JavaScript with JSDoc types and no build step. It is not an npm workspace and has no lockfile of its own: in a checkout it runs on the root install, which provides Pi, and loads ampi from the checkout itself. The root `npm run gate` lints, tests, type-checks and packs it. See the repository's [`CONTRIBUTING.md`](../../CONTRIBUTING.md).

## License

[MIT](LICENSE).
