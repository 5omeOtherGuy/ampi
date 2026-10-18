# ampi-cli

The `ampi` command: Pi with the ampi extensions loaded, plus Amp-compatible short flags and subcommands.

Status: released. Versioned on its own, next to [`@skippermissions/ampi`](../../README.md) in the same repository; while it is 0.x, a minor release may contain breaking changes.

`ampi` starts the same interactive Pi session as `pi -e npm:@skippermissions/ampi`, with ampi's modes, tools, workers and terminal layout, and runs single prompts from scripts with `ampi -x`. It exists because a Pi package can only add long `--flags`: options such as `-m high` and `-x`, and commands such as `ampi threads`, need a command of their own. Everything the command does not handle itself goes to Pi unchanged, so Pi's options (`--model`, `-c`, `-r`, `-p`, `-e`) and its own commands (`install`, `list`, `config`, `mcp`, …) keep working.

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
ampi last                # continue the most recent session that is not archived
ampi threads             # list this directory's sessions
ampi config keymap       # every command id with its keys, as JSONC
ampi config edit         # open Pi's settings file in your editor
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

## Threads

`ampi threads` works with the sessions Pi keeps on disk, together with the metadata ampi's thread index adds to them (archive date, labels, color). It reads the same session directory as Pi: `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR` and the `sessionDir` setting apply.

```bash
id=$(ampi threads new)                         # the id of a new, empty session
ampi -x --session-id "$id" "summarize the README"
ampi threads                                   # this directory's sessions, newest first
ampi threads list --all --archived --limit 10  # every directory, archived sessions included
ampi threads list --json | jq -r 'select(.messageCount > 10) | .id'
ampi threads search parser label:docs after:7d # every directory, latest update first
ampi threads continue 019a3c                   # open a session in the terminal UI
ampi last                                      # open the most recent session that is not archived
ampi threads markdown 019a3c > session.md      # the session as Markdown
ampi threads export 019a3c | jq '.entries | length'
ampi threads rename 019a3c "Parser cleanup"
ampi threads archive 019a3c                    # unarchive, or archive --unarchive, undoes it
ampi threads label 019a3c parser release
ampi threads color 019a3c green                # or #3f2d1d; none removes it
ampi threads delete 019a3c                     # asks first; --yes skips the question
```

```text
ID                                    Title                    Updated  Messages
────────────────────────────────────  ───────────────────────  ───────  ────────
019a3c71-5e0b-7c2a-9d41-0b6f2c8e1a10  Parser cleanup           51m ago        12
019a3a02-77d4-7f19-8b3e-5c1d9e2f4a07  Fix the flaky test in…   2d ago          3
```

| Command | What it does |
| --- | --- |
| `threads new` (`n`) | Prints the id of a new session in the current directory, a UUID version 7 as Pi makes them, and writes nothing: Pi creates the session file with its first message. Open it with `threads continue <id>`, or send that message with `ampi -x --session-id <id> "message"`. `--json` prints `{"id", "cwd"}`. Sessions stay on this machine, so there is no `--visibility`; passing it is a usage error. |
| `threads list` (`ls`; also plain `threads`) | The sessions of the current directory, newest activity first: id, title (the session's name, else its first message), time since the last activity and message count. Archived sessions are left out. `--all` lists every directory, `--archived` (or `--include-archived`) adds archived sessions with an `archived` marker, `--limit <n>` stops after n sessions. Titles are cut to the terminal width; redirected output keeps them whole. |
| `threads list --json` | One JSON object per line: `id`, `title`, `name` (when the session has one), `created` and `updated` (ISO 8601), `messageCount`, `cwd`, `path` (the session file), `parentSessionPath` for a fork, and from the thread index `archived`, `labels`, `color` and `pinned` when set. |
| `threads search <query...>` (`find`) | Searches the sessions of every directory, archived ones included, and prints the matches in the list's table with the `Archived` column, latest update first, or "No sessions match.". The words after `search` form the query, so quoting it whole is optional. `-n`/`--limit <n>` prints at most n sessions (20 by default); when more match, a note on stderr gives both counts. `--json` prints one object per line: the fields of `list --json` plus `matchedTerms`. The query keys are below. |
| `threads continue <id>` (`c`) | Opens the session in the terminal UI through Pi's `--session`, with ampi loaded. Without an id it opens Pi's session picker; `--last` does what `ampi last` does. A session from another directory opens in that directory. A complete id that no session has, such as one `threads new` printed, starts a new session under that id in the current directory through Pi's `--session-id`, with a note on stderr. |
| `last` | Opens the most recent session of the current directory that is not archived. Pi's `-c` also counts archived sessions, such as the ones execute mode archives. |
| `threads markdown <id>` (`md`) | Prints the session as Markdown: front matter (`title`, `sessionId`, `created`, `mode`), then a `## User` or `## Assistant` section per turn, with tool calls and results as fenced blocks. The same layout as ampi-threads' Markdown export. |
| `threads export <id>` | Prints the session as one JSON object: the fields of `list --json` plus `entries`, every entry of the session file as Pi wrote it (Pi's session format, described in its `docs/session-format.md`), header first. |
| `threads rename <id> <title>` (`r`) | Sets Pi's session name, as `/name` does, and records the title as typed by you. |
| `threads archive <id>`, `threads unarchive <id>` | Archives the session in the thread index, or takes it out of the archive. |
| `threads label <id> <label...>` | Adds labels to the ones the session has: 1 to 32 lowercase letters, digits or hyphens each, at most 20 per session. |
| `threads color <id> <color>` | Sets the session's color in the thread index: `blue`, `purple`, `pink`, `red`, `orange`, `yellow`, `green`, `cyan`, `gray` or an RGB hex color such as `#3f2d1d`, stored in lowercase. `none` removes it. Any other value is a usage error. |
| `threads delete <id>` | Asks `[y/N]` on stderr and reads the answer from stdin, then deletes the session file and its thread index record. `-y`/`--yes` skips the question. Run from the agent's own shell, it refuses to delete the session it runs in. |

- **Search queries.** A query is words and `"quoted phrases"` plus `key:value` filters. A session matches when it contains every word and phrase (in its name, first message or any message text) and passes every filter. Matching ignores case. A quoted phrase is always text, even when it contains a colon: in a shell, `ampi threads search '"Error: ENOENT"'`. A word ending in a colon, such as `TypeError:`, is text too, unless the word is a key. A key that search does not know, a key without a value (`archived:`), a key such as `commit:`, `pr:` or `author:` whose data only a hosted service has, a value it cannot read (`after:soon`) and an empty query are usage errors that name the problem. When the thread index cannot be read, `pinned:` and `archived:` are ignored with a note on stderr. `offset:`, `sort:` and `projectRef:` belong to `find_session` and are ignored the same way. The search comes from the ampi that Pi loads, as for `config keymap`; an ampi too old to have it is reported with status `1`.

  | Key | A session matches when |
  | --- | --- |
  | `id:<id>` | its id is this id or starts with it |
  | `parent:<id>` | it was forked from the session with this id or id start |
  | `name:<text>` | its name contains the text |
  | `label:<label>` | one of its labels in the thread index, or one set on an entry in Pi, contains the text |
  | `pinned:true`, `pinned:false` | it is pinned in the thread index, or not |
  | `archived:true`, `archived:false` | it is archived, or not; without the key both are found |
  | `after:<date>`, `before:<date>`, `updated_before:<date>` | its latest update falls after or before the date |
  | `created_after:<date>`, `created_before:<date>` | it was started after or before the date |
  | `cwd:<text>`, `project:<text>` | its directory contains the text |
  | `repo:<owner/repo>` | its directory's git remote is that repository (`host/owner/repo` and a remote URL work too) |
  | `file:<path>` | a read, edit, write or patch in it named a file whose path contains the text |
  | `model:<text>`, `provider:<text>`, `tool:<name>` | a model, provider or tool it used contains the text |
  | `has:tools`, `has:errors` | it called a tool, or something in it failed |

  Dates are `YYYY-MM-DD` or relative: `today` and `yesterday` (from midnight UTC), `week`, `month` (30 days), or a number of days or weeks such as `7d` or `2w`.
- **Ids.** `<id>` is a session id, or its first characters as the list prints them; a leading `@` is ignored. An exact id wins. A prefix that several sessions share is refused, and the matching ids are listed. Ids are looked up in every directory.
- **Exit status.** `0` on success, `1` when no session or several match the id, when a delete is declined or a change fails, `2` on a usage error, including a search query it cannot use. `ampi threads --help` lists the commands and options.
- **The thread index.** Archive dates, labels, colors and the title source are stored in `<agent dir>/data/ampi/threads/index.json`, the file ampi-threads keeps. If it cannot be read, listings go on without it and say so on stderr; `archive`, `unarchive`, `label` and `color` stop with status `1`, and `rename` and `delete` change the session and report on stderr that the index was left as it was. ampi-threads sets a damaged file aside the next time Pi starts with ampi.

## Keymap and settings

`ampi config keymap` prints the keymap of the terminal UI as JSONC: the leader key first, then every command id in alphabetical order with its key, an array of keys or `null`, and what the command does as a comment. It is the keymap in effect in the current directory: ampi's default keys with the overrides under `ampi.keymap` in Pi's user settings and, once Pi trusts the project, the project's `.pi/settings.json`. Overrides that do not apply (an unknown id, a key that does not parse, two commands on one key) are reported on stderr, as the terminal UI warns about them.

```bash
ampi config keymap
```

```text
{
  "leader": "ctrl+x",
  "ampi.changelog": null, // Show what changed in recent ampi releases
  …
  "thread.archive": "ctrl+c ctrl+n", // Archive and start a new session
  …
}
```

The output is valid JSON once the `//` comments are removed. Copy the entries you want to change under `ampi.keymap` in Pi's settings, with a key string, an array of key strings, or `null` to unbind, and run `/reload` in a running session; the key syntax is described in [ampi-tui's keymap section](../../src/extensions/ampi-tui/README.md#keymap). The list holds the commands of ampi's own extensions, taken from the ampi that Pi loads from its settings when there is one, else from the ampi installed with the command; ampi-threads' commands are left out when it is turned off, and a note on stderr says so when ampi-tui is off. Commands that other packages register at run time appear only in the terminal UI's Help & Keymap screen.

`ampi config edit` opens Pi's user settings file (`settings.json` in Pi's configuration directory) in your editor; `--workspace` opens the project's `.pi/settings.json` instead (`--global` names the default). The editor is the one Pi opens the prompt in: the `externalEditor` setting, else `$VISUAL`, else `$EDITOR`, else `nano` (`notepad` on Windows). A missing settings directory is created, so the editor can save the file.

Exit status: `0` on success, `1` when the keymap cannot be loaded or the editor exits with an error, `2` on a usage error. Every other `ampi config` command line, such as `ampi config` alone, runs Pi's own `config` command.

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

When the first argument is one of Pi's commands (`install`, `remove`, `uninstall`, `update`, `list`, `config`, `auth`, `mcp`), the command runs Pi's own executable with the command line untouched, and ampi is not added. `config keymap` and `config edit` are the exception: they are ampi's (see [Keymap and settings](#keymap-and-settings)).

## Compatibility

- **Pi:** 1.3 or later within 1.x, installed as a dependency.
- **Node.js:** 22.19 or later.
- **Last verified:** 2026-10-18, with Pi 1.3.0 and Node.js 24.22.0 (interactive session in a terminal, with and without ampi installed as a Pi package; execute mode with piped and terminal input and output; stream JSON with and without thinking; `threads list`, `markdown` and `continue` in a terminal; `threads new`, then `continue` and `-x --session-id` on its id, `threads color`, and `threads search` with filters, JSON and its usage errors).

## Development

From a checkout of the repository, after `npm ci` at its root:

```bash
node packages/ampi-cli/bin/ampi.js -m low
npm run test:one -- tests/mmr-cli-argv.test.mjs
```

The package is plain JavaScript with JSDoc types and no build step. It is not an npm workspace and has no lockfile of its own: in a checkout it runs on the root install, which provides Pi, and loads ampi from the checkout itself. The root `npm run gate` lints, tests, type-checks and packs it. See the repository's [`CONTRIBUTING.md`](../../CONTRIBUTING.md).

## License

[MIT](LICENSE).
