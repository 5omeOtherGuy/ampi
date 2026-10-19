# ampi-cli

The `ampi` command: Pi with the ampi extensions loaded, plus Amp-compatible short flags and subcommands.

Status: released. Versioned on its own, next to [`@skippermissions/ampi`](../../README.md) in the same repository; while it is 0.x, a minor release may contain breaking changes.

`ampi` starts the same interactive Pi session as `pi -e npm:@skippermissions/ampi`, with ampi's modes, tools, workers and terminal layout, and runs single prompts from scripts with `ampi -x`. It exists because a Pi package can only add long `--flags`: options such as `-m high` and `-x`, and commands such as `ampi threads`, need a command of their own. Everything the command does not handle itself goes to Pi unchanged, so Pi's options (`--model`, `-c`, `-r`, `-p`, `-e`) and its own commands (`install`, `list`, `config`, …) keep working; `ampi mcp` adds Amp-compatible spellings on top of Pi's `pi mcp`.

## Install

```bash
npm i -g @skippermissions/ampi-cli
```

The package brings its own Pi (`@earendil-works/pi-coding-agent`) and ampi (`@skippermissions/ampi`) as dependencies. Sign in to a provider the way you do for Pi; the command uses Pi's configuration directory (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`). `ampi doctor` checks the setup, and `ampi update` updates an `npm i -g` install, Pi and ampi included (see [Update](#update)).

## Usage

```bash
ampi                     # interactive session in your default mode
ampi -m high             # start in high mode (same as --ampi-mode high)
ampi --fast              # start at fast speed (same as --ampi-fast)
ampi "fix the failing test in parser.test.ts"   # start with a first message
ampi -x "list the npm scripts"                  # run one message and print the answer
ampi last                # continue the most recent session that is not archived
ampi threads             # list this directory's sessions
ampi usage               # cost and tokens of the last 30 days
ampi config keymap       # every command id with its keys, as JSONC
ampi config edit         # open Pi's settings file in your editor
ampi tools list -m high  # the tools a high mode session declares to the model
ampi app --open          # every session on this machine in one web page
ampi skill list          # the skills Pi loads in this directory
ampi skill add ./skills  # install skills into this project's .agents/skills
ampi --model openai/gpt-5.6-sol -m ultra        # Pi options and ampi options together
ampi doctor              # check Node.js, Pi, ampi, rg, fd, git, credentials and data files
ampi update              # update ampi-cli, with its Pi and ampi, to the latest version
ampi version             # ampi-cli, ampi and Pi versions
ampi --help              # all options
ampi --pi-help           # Pi's own options, including the flags ampi's extensions add
```

| ampi option | What it does |
| --- | --- |
| `-m`, `--mode <mode>` | Start in an ampi mode: `low`, `medium`, `high`, `ultra` or `free`, or a legacy alias. `--mode text`, `json` and `rpc` keep Pi's meaning (output format). |
| `--fast` | Start the session at fast speed: priority serving from the provider at a higher price, for OpenAI and OpenAI Codex models. Works in execute mode too; Alt+R turns it on or off in a session. The same as Pi's `--ampi-fast`. |
| `-x`, `--execute` | Run one message without the terminal UI and print only the final assistant message. See [Execute mode](#execute-mode). |
| `--stream-json` | In execute mode, print the run as JSON records, one per line, instead of the final message. See [Stream JSON](#stream-json). |
| `--stream-json-thinking` | `--stream-json` with the model's thinking blocks. |
| `--stream-json-input` | With `--stream-json`, read the messages from stdin as JSON lines and keep the session open until stdin ends. See [Messages on stdin](#messages-on-stdin). |
| `--stats` | In execute mode, print one JSON line with the run's result, turns, token usage and cost instead of the final message. See [One summary line](#one-summary-line). |
| `--output-tool <name>` | In execute mode, print the text of the last finished call to that tool instead of the final message. See [One tool's output](#one-tools-output). |
| `--plugin-ready-timeout [seconds]` | Accepted in execute mode and has no effect: Pi loads every extension before the run starts. |
| `--timings` | In execute mode, print the startup, turn and total durations to stderr. |
| `--no-archive-after-execute` | Keep an execute-mode session out of the archive. |
| `--title <title>` | Name the session; the same as Pi's `--name`. |
| `-l`, `--label <label>` | Add a label to the session in ampi's thread index. Repeat it for several labels. |
| `--mcp-config <json\|path>` | Connect MCP servers for this run only. See [MCP servers for one run](#mcp-servers-for-one-run). |
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

Exit status: `0` when the final message was printed, `1` when the agent or Pi failed (the error is on stderr; an answer cut off at the model's output limit also counts), `2` for a usage error, such as no message in the argument or on stdin. `--timings`, `--no-archive-after-execute`, `--stats`, `--output-tool` and `--plugin-ready-timeout` outside execute mode are usage errors too.

`--plugin-ready-timeout` is accepted for scripts written for other tools and does nothing: Pi has loaded every extension before the run starts. Its value is optional: `--plugin-ready-timeout=N`, or the next argument when that is a whole number from 0 to 300; anything else after it, such as the message, stays an argument. An `=` value outside 0 to 300 is a usage error.

### One summary line

`ampi -x --stats` prints nothing while the run is in progress and one JSON line when it ends, instead of the final message: the fields of the [stream JSON](#stream-json) `result` record (`type`, `subtype`, `is_error`, `duration_ms`, `num_turns`, `result` or `error`, `session_id`, `usage`), plus `total_cost_usd`, the cost of the run's model responses in US dollars as Pi computes it from the model's price. When no response has a cost, for example with a model whose price Pi does not know, `total_cost_usd` is left out rather than written as 0.

```bash
ampi -x --stats "list the npm scripts" | jq '{num_turns, total_cost_usd}'
```

The exit status is the same as with `--stream-json`. `--stats` cannot be combined with `--stream-json`, `--stream-json-thinking`, `--output-tool` or Pi's `--mode`.

### One tool's output

`ampi -x --output-tool <name>` prints the result of the last call to the tool with exactly that name that finished during the run, instead of the final message: its text, ending with a newline. Images in the result are left out, with a note on stderr.

```bash
ampi -x --output-tool bash "run the test suite once" > test-output.txt
```

Exit status: `0` when that call succeeded; `1` when it failed (its text is still printed), when no call to the tool finished (stdout stays empty and stderr says so), or when the run failed; `2` for a usage error. `--output-tool` cannot be combined with `--stream-json`, `--stream-json-thinking`, `--stats` or Pi's `--mode`.

### MCP servers for one run

`--mcp-config` connects MCP servers for one run, in execute mode or in an interactive session, without changing Pi's `mcp.json` files. The value is JSON when it starts with `{`, and otherwise the path of a JSON file, relative to the working directory. Both Pi's `mcp.json` format (`{"mcpServers": {...}}`) and a bare object of servers by name are accepted; each entry has the fields of an entry in Pi's `mcp.json` (`command`, `args`, `env`, `url`, `headers`, `exposure` and the others).

```bash
ampi -x --mcp-config '{"docs": {"url": "https://example.com/mcp", "exposure": "direct"}}' "find the setup guide"
ampi --mcp-config ./ci-servers.json
```

- **Connection.** The servers are registered with Pi while its extensions load and connect when the session starts, next to the servers from `mcp.json`; they are registered again after `/reload`, `/new` and the other commands that replace the session.
- **Same name.** A server of the same name in the user's `mcp.json` or the project's `.pi/mcp.json` is the one Pi uses. ampi then says on stderr, or as a notification in the terminal UI, that the flag's entry is not used.
- **Usage errors.** Exit status `2`, before the run starts, for a file that cannot be read, a value that is not valid JSON or not an object of servers, an entry Pi rejects (it names the problem), a second `--mcp-config`, and `--mcp-config` together with Pi's `--no-mcp`.

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
| `{"type": "result"}` | Last (with `--stream-json-input`, after each run) | `subtype` `success` with `result`, the final answer's text, or `error_during_execution` with `error`; `is_error`; `duration_ms`; `num_turns`; `session_id`; `usage`, summed over the run. |

- **Exit status.** As in execute mode: `0` with a `success` result, `1` with an error result (a failed or aborted request, or an answer cut off at the model's output limit), `2` for a usage error, which prints no records. When Pi's automatic retry recovers from a failed request, the run succeeds.
- **Usage errors.** `--stream-json` needs execute mode: `-x`, or redirected input or output. It replaces Pi's output format, so it cannot be combined with `--mode text`, `json` or `rpc`. `--stream-json-thinking` implies `--stream-json`.
- **Not included.** Subagent output is not streamed, so `parent_tool_use_id` is always `null`. `mcp_servers` is always empty, because Pi does not tell extensions the connection state of its MCP servers. Images in messages and tool results are left out, and Pi has no turn limit, so there is no `error_max_turns` result. Pi's own diagnostics stay on stderr; an error that stops Pi before the session starts is reported there, without records.
- **Pi's own format.** `ampi -x --mode json` prints Pi's JSON event stream instead, with every streaming update.

### Messages on stdin

`ampi -x --stream-json --stream-json-input` reads the messages from stdin instead of taking one message, so a program can hold one session open and send it message after message. Each line of stdin is one JSON object:

```json
{"type": "user", "message": {"role": "user", "content": "list the npm scripts"}}
{"type": "user", "steer": true, "message": {"role": "user", "content": [{"type": "text", "text": "only the test scripts"}]}}
{"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "what does this show?"}, {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo..."}}]}}
```

```bash
printf '%s\n' '{"type":"user","message":{"role":"user","content":"list files"}}' | ampi -x --stream-json --stream-json-input
```

- **Content.** `message.content` is a string or a list of blocks: `{"type": "text", "text"}`, and `{"type": "image", "source": {"type": "base64", "media_type", "data"}}` with an optional `source_path`. `media_type` is `image/png`, `image/jpeg`, `image/gif` or `image/webp`, and it must match the image data. A line carries at most 10 images. Text blocks are joined with newlines. Other fields on the line are ignored; blank lines are skipped.
- **When messages run.** A message that arrives while no run is in progress starts one. A message that arrives while a run is in progress joins it: with `"steer": true` the agent reads it before its next request to the model, and without it the agent takes it up once it has finished its current work.
- **Records.** One `init` record first, then the records of each run as with `--stream-json`, with a `result` record each time a run has finished; its `num_turns`, `duration_ms`, `usage` and `result` cover that run only, except that the first run's `duration_ms` also counts Pi's startup, as with `--stream-json`. Messages that joined a run share its result. A run the agent starts on its own, for example when a background task finishes, gets its own `result` record. Images are not echoed in `user` records.
- **The end.** ampi exits once stdin has ended and the last run has finished, including a run the agent started on its own. `--title`, `-l`, `--timings` and the archive after execute mode work as with one message.
- **Invalid lines.** A line that is not such a message stops reading: the run in progress finishes, then an `error_during_execution` result names the line and the problem (for example `stdin line 2: not valid JSON`).
- **Exit status.** `0` when every run succeeded; `1` when a run failed, a line was invalid or Pi stopped before it had handled every message; `2` for a usage error, which prints no records: `--stream-json-input` without `--stream-json` or `--stream-json-thinking`, together with a message argument, with stdin as a terminal, or stdin ending before the first message.
- **Extension dialogs.** Nobody can answer a dialog during such a run, so ampi cancels every dialog an extension opens: a confirmation counts as "no".

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
ampi threads context 019a3c                    # what fills the context window, as JSON
ampi threads usage 019a3c --details            # what the session cost, per model, and its tool calls
ampi usage --details                           # cost and tokens of every session of the last 30 days
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
| `threads context <id>` (`analyze-context`) | Prints what fills the session's context window as JSON, section by section, as the `thread analyze context` overlay shows it. The fields are below. |
| `threads usage <id>` | Prints the session's title and its total cost, in the format of the prompt box's cost gauge, with a note when some models have no price. `--details` adds a table of input, output, cache read and cache write tokens and the cost per model ("unknown" without a price), and the number of tool calls per tool. `--start <time>` and `--end <time>` count only the entries from `--start` on and before `--end`. `--json` prints the fields below. |
| `usage` | Prints the cost and tokens of every session on this machine, in every directory, from `--start` up to, not including, `--end`: by default the 30 days up to now (without `--start`, the 30 days before `--end`). The text gives the range, the total cost, the number of sessions with usage in the range and the token totals; `--details` adds the per-model table and the ten most expensive sessions with their id, title, cost and directory. `--json` prints the fields below. |
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
- **Context.** `threads context` reads the branch Pi would open, ending at the session's last entry, and estimates tokens at four characters to a token from the system prompt and tool declarations Pi recorded in the session and the messages it would send now. Its JSON fields:

  | Field | Value |
  | --- | --- |
  | `threadID` | The session id. |
  | `scope` | Always `"current-context"`. |
  | `model` | `provider/model` that answers next, as Pi resumes the session: from the last response or model change on the branch; `null` when there is none. |
  | `modelDisplayName`, `maxContextTokens` | The model's name and context window from Pi's model catalogue and `models.json`; `null` for a model they do not list, such as one only an extension registers. |
  | `sections` | `{id, name, tokens, percentage}` in this order: `system-prompt`, `builtin-tools`, `agents-files` (the AGENTS.md files in the prompt), `mcp-tools` (tools named `mcp__…`), `loaded-skills`, `compaction-summary`, `messages`. `percentage` is the share of the window with one decimal, `null` when the window is unknown. |
  | `totalTokens` | The sum of the sections. |
  | `freeSpace` | The window less the total, never below 0; `null` when the window is unknown. |
  | `compactionCount` | Compactions on the branch. |
  | `toolCounts` | `{builtin, mcp, total}`: the tools declared to the model. |
  | `measuredTokens` | Present when a response after the latest compaction or context edit recorded its usage: the tokens the provider counted then, plus estimates for the messages after it, as Pi counts the context it shows. After a context edit Pi shows an estimate of the whole context instead, which this field leaves out. |
  | `systemPromptRecorded` | `false` when the branch holds no recorded system prompt yet (Pi records it with the first request); the prompt and tool sections are then 0, and a note goes to stderr. |
- **Costs.** An entry costs what the provider reported and Pi recorded, else its tokens at the model's list price from Pi's model catalogue or `models.json`, as the prompt box's gauge counts them. A model with neither is "unknown" and left out of the totals, and a total is unknown only when every model is. ampi keeps no account and no credits, so there are no balances or plan limits to show. The catalogue is read offline: prices that only a refreshed catalogue has are not used, and nothing authenticates or calls a model. Sessions labelled `imported` in the thread index count as unknown, never as free. `threads usage --json` prints `threadID`, `title`, `start` and `end` (ISO 8601, or `null` without the option), `cost` (dollars, `null` when unknown), `unknownCostModels`, `models` (`{model, cost, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens}`, `cost` `null` when unknown; compaction and branch summaries appear as `session summaries`) and `toolCalls` (`{name: count}`). `usage --json` prints `start`, `end`, `cost`, `unknownCostModels`, `sessionCount`, the four token totals, `models` in the same form and `sessions`: every session with usage in the range, the most expensive first, as `{threadID, title, cwd, cost}`. Like search, the context and cost reports come from the ampi that Pi loads; an ampi too old to have them is reported with status `1`. Times are ISO 8601 dates or times, such as `2026-10-01` (midnight UTC) or `2026-10-01T09:30:00Z`; a time without `Z` or an offset, such as `2026-10-01T09:30`, is local time. A malformed time, a date the calendar does not have (`2026-02-30`) or a `--start` after `--end` is a usage error.
- **Ids.** `<id>` is a session id, or its first characters as the list prints them; a leading `@` is ignored. An exact id wins. A prefix that several sessions share is refused, and the matching ids are listed. Ids are looked up in every directory.
- **Exit status.** `0` on success, `1` when no session or several match the id, when a delete is declined or a change fails, or when the ampi in use is too old for a command, `2` on a usage error, including a search query it cannot use and a malformed time. `ampi threads --help` lists the commands and options.
- **The thread index.** Archive dates, labels, colors and the title source are stored in `<agent dir>/data/ampi/threads/index.json`, the file ampi-threads keeps. If it cannot be read, listings go on without it and say so on stderr; `archive`, `unarchive`, `label` and `color` stop with status `1`, and `rename` and `delete` change the session and report on stderr that the index was left as it was. ampi-threads sets a damaged file aside the next time Pi starts with ampi.

## Import

`ampi threads import` copies other coding agents' conversations on this machine into Pi sessions, which you can then list, read, search and mention like your own. Imported sessions are read-only. Claude Code is supported; Codex and OpenCode are not yet.

```bash
ampi threads import detect                            # where each agent keeps its conversations
ampi threads import claude --all --dry-run            # what would be imported, and nothing written
ampi threads import claude --all --max-age 7          # sessions updated in the last 7 days
ampi threads import claude 3f2c9a7e-1b4d-4e8a-9c3f-5d6e7f8a9b0c
ampi threads search label:imported                    # the imported sessions
```

```text
Imported 3f2c9a7e-1b4d-4e8a-9c3f-5d6e7f8a9b0c as 019a3c71-5e0b-7c2a-9d41-0b6f2c8e1a10 (24 messages)
Skipped 8d1e0f2a-6b7c-4d8e-9f0a-1b2c3d4e5f6a: already imported as 019a3a02-77d4-7f19-8b3e-5c1d9e2f4a07; --reimport imports it again
Claude Code: 1 imported, 1 skipped, 0 failed.
```

| Command | What it does |
| --- | --- |
| `threads import detect` | Prints each agent's data location and whether it exists, without reading a conversation: Claude Code's `projects` folder in `$CLAUDE_CONFIG_DIR` (default `~/.claude`), Codex's `sessions` folder in `$CODEX_HOME` (default `~/.codex`) and OpenCode's `opencode` folder in `$XDG_DATA_HOME` (default `~/.local/share`). `--json` prints `{"agents": [{"agent", "path", "found"}]}`. |
| `threads import claude [ids...]` (`claude-code`) | Imports the Claude Code sessions with these ids, the names of their files in `projects/<folder>/<id>.jsonl`. `--all` imports instead every session whose file changed within `--max-age` days (30 by default, `0` for no limit), newest first, and `--limit <n>` stops after n sessions. Giving neither ids nor `--all`, or both, is a usage error. `--claude-dir <path>` reads another configuration directory. |
| `threads import codex`, `threads import opencode` | Not supported yet: a usage error. |

- **What a session keeps.** Each conversation becomes one Pi session in the session directory Pi uses for the directory it ran in. User text and images (base64 images as images, others as "(image)"), assistant text and thinking, tool calls and their results, and errors are kept, each message with its original time. The lines Claude Code writes for one assistant message become one message. A helper agent's side conversation, notes Claude Code added for the model, and bookkeeping lines are left out. Assistant messages keep Claude Code's model id under the provider `claude-code-import`, which Pi has no provider for, and their token counts; their cost is unknown, never zero. The session is named with the title Claude Code recorded (one you set, else its generated title or summary), else Pi shows its first prompt.
- **Labels and provenance.** The session gets the labels `imported` and `claude-code` in the thread index, and a first entry of type `ampi-import` holding `agent`, `sourceId`, `sourcePath`, `sourceModified`, `sourceStarted`, `importedAt` and `formatVersion`. ampi-core reads that entry and refuses every new prompt, `!` command and compaction in the session, from any host; see the ampi-core README. `ampi -x --session-id <imported id>` writes the refusal to stderr and exits `1`, but Pi's print mode still prints the session's last stored reply on stdout, so a script must check the exit status.
- **Imported once.** `<agent dir>/data/ampi/imports.json` records, per `claude-code:<id>`, the Pi session the conversation became and when. A recorded conversation is skipped unless you pass `--reimport`, which writes it again under the same session id and removes the old session file once the new one is complete. A record whose session file was deleted is ignored, so the conversation is imported again.
- **Output.** One line per conversation (imported, skipped with the reason, or failed with the reason) and a summary line. `--json` prints one object per line instead: `{"type": "imported" | "skipped" | "failed", "agent", "sourceId", "sessionId", "messages", "reason"}` with the fields that apply, then `{"type": "summary", "agent", "imported", "skipped", "failed"}`. `--dry-run` reads and converts every conversation and prints the message counts, without `sessionId`, and writes nothing.
- **Exit status.** `0` when every conversation was imported or skipped, `1` when one failed or an id has no session, `2` on a usage error. `ampi threads import --help` lists the options.

## ampi app

`ampi app` serves every Pi session on this machine from one local web page: read any of them, carry on those that no other process has open without a terminal, and join those a terminal runs with its web GUI on.

```bash
ampi app          # prints the link to open
ampi app --open   # prints it and opens it in your browser
```

It prints `ampi app: http://127.0.0.1:<port>/?t=<token>` and runs until Ctrl+C (or SIGTERM), which stops every session it runs and exits 0. Only one runs per user: a second `ampi app` prints the running one's link (with `--open` it also opens it) and exits 0. When it cannot read that link, for example because the running app comes from an older ampi, it names the process that runs it and exits 1.

**The page.** The sidebar lists the sessions in Pi's default session directory (`PI_CODING_AGENT_DIR` applies), grouped by project as in a terminal's web GUI ([ampi-gui](../../src/extensions/ampi-gui/README.md#sessions)). Each row's disc says where the session runs, for screen readers too: "Running in a terminal", "Running in ampi -x", "Running in ampi app" or "Not running", followed by "Live" when that process serves a live web view, "Working" while its agent works (the disc spins) and "Error" when its last turn failed. The list follows changes every 5 seconds while the page is in view, and at once when the app starts or stops a session. Every session has its own address, `/s/<session id>`, so Back and Forward move between them and a link opens one directly. `/` asks you to pick a session.

**Opening a session** shows it in one of these ways:

| The session | The page |
| --- | --- |
| runs in this app | live, as on a terminal's own GUI: streaming replies, tool calls, the queue, steering, Esc Esc |
| runs in a terminal whose web GUI is on | live, through that terminal (see [Terminal sessions](#terminal-sessions)) |
| is open in another process (a terminal without the web GUI, an `ampi -x` run, another app) | read-only, with a banner naming where it runs and its pid; for a terminal without the web GUI, the banner says to turn on ampiGui there to continue here |
| runs nowhere | its transcript with the composer on: the first message shows Starting, starts the session in this app and then follows it live |
| was imported (`ampi threads import`, below) | read-only, with the composer turned off and the reason under it, wherever it is open |

If another process opens a session while the page shows it live, the page turns read-only in place, keeping your scroll position.

**How sessions run.** The app runs each session in a worker process of its own (`ampi app --worker`, below), started by the first message you send it, with the extensions an interactive `ampi` loads, Pi's MCP servers included. A worker that has been idle for 15 minutes while no page follows it stops; sending again starts a new one. If starting takes longer than 30 seconds, the send answers that the session is still starting and the message is not sent; the page goes live once it has started, and you send again.

**One writer per session file.** Pi does not lock session files, so two processes writing one file can lose messages. The app never starts a worker for a file another live process has open (it checks the live registry just before, and the worker checks again), and it checks the registry every 2 seconds: when a terminal opens a file one of its workers runs, it stops that worker if its agent is idle and the page turns read-only, or warns on the page while the agent works.

**Security.** The page is served on `127.0.0.1` only, on a random port, with the protections of the web GUI ([ampi-gui's security model](../../src/extensions/ampi-gui/README.md#security-model)): the `Host` and `Origin` checks, a per-process token that the link carries once and the server then keeps in an `HttpOnly`, `SameSite=Strict` cookie, no CORS headers, and no files outside its client directory. Each worker has a token of its own, which it receives over its IPC channel; the page reaches workers, and the GUIs of terminal sessions, only through the app, which never passes their tokens or cookies to the browser. The app's token therefore reaches, through the app, every session a terminal runs with the web GUI on, not only the app's own workers: whoever holds the app's link or cookie can read, send to and interrupt all of them. `ampi app --open`, and a second `ampi app --open` that opens the running app's link, pass the link, token included, to `xdg-open` or `open` as a command-line argument, where other users of a shared machine may be able to read it, as with `thread open in browser`; on a shared machine, copy the printed link into a browser that is already running instead. The app's own session is in memory and never saved.

**Limits.** Sessions in a custom session directory (`--session-dir`, `sessionDir`) are not listed. A session a terminal without the web GUI has open stays read-only until that terminal exits. Rename works only for sessions the page shows live. Workers have no terminal: an extension that asks a question, such as a tool approval, gets no answer from the page and behaves as in a run without a UI (`ampi -x`). Attachments are not available.

### Terminal sessions

A session that runs in a terminal with ampi's web GUI on (`ampiGui.enabled: true` or `AMPI_GUI_ENABLE=true` when that terminal started) opens live in `ampi app` too. The app does not start a second writer for it: every request goes on to that terminal's own web GUI, so a message you send from the page goes into the terminal's session, shows in the terminal as if typed there, and the terminal's replies stream to the page. Queueing, steering, interrupting and renaming work the same way.

- A terminal without the web GUI keeps its sessions read-only in the app; the banner says to turn on ampiGui in that terminal to continue the session here. Pi loads the setting when it starts, so restart that terminal's Pi with the setting on and resume the session.
- `ampi -x` runs stay read-only: they serve no web GUI.
- When the terminal quits or switches to another session, the page shows the session as it then is: read-only from its file, or not running, ready to start in the app. If the terminal's server stops answering while its entry is still there, the page says the session stopped and offers to open it again.
- To reach a terminal's GUI, the app reads its access token from the token file next to the terminal's live registry entry, readable only by your user (see [ampi-gui's security model](../../src/extensions/ampi-gui/README.md#security-model)). A token file that is missing or does not match the entry leaves the session read-only.

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

## Tools

`ampi tools list` prints the tools a new session in the current directory declares to the model, grouped by where they come from: `built-in` (Pi's own tools), `ampi`, `extension:<name>` (another package by its package name, or an extension file by its file name) and `mcp`. Each row holds the tool's name and the first sentence of its description, cut to the terminal width. `ampi tools show <tool>` prints one tool's full description, then a line per top-level parameter with its type and whether it is required. `ampi tool` is the same command group, and `ls` is short for `list`.

```bash
ampi tools list                       # in the mode a new session starts in
ampi tools list --mode low --json     # [{ name, source, description }], sorted by name
ampi tools show shell_command --json  # { name, description, source, inputSchema }
```

`--mode` (`-m`) takes `low`, `medium`, `high`, `ultra`, `free` or a legacy alias. Without it the command uses the mode a new session starts in: `ampiCore.defaultMode`, else `medium`.

The command loads what `ampi` loads in the directory (Pi's configured packages and extensions, ampi unless Pi already loads it, and Pi's built-in codemode, tool_search and MCP extensions) and starts a session in memory, where ampi applies the mode as it does when a session starts. It writes no session file, calls no model, installs no missing packages (it runs as if `PI_OFFLINE=1` were set) and does not connect MCP servers: when servers are configured, a closing note says their tools are not listed, and `ampi mcp list` shows the servers. A locked mode starts only when one of its models has credentials, as in a session; otherwise the command says so.

Exit status: `0` on success, `1` when the mode does not start or the tool is not active in it (the message suggests up to three close names), `2` on a usage error such as an unknown mode.

## Skills

`ampi skill list` prints the skills a session in the current directory loads: a count line, then each skill's name with its source, its description cut to the terminal width, and its directory. Problems Pi reports while loading skills, such as two skills with one name (Pi keeps the first it finds) or a `SKILL.md` without a description, go to stderr. `ampi skill info <name>` prints one skill's source, directory, `SKILL.md` path, whether the model may load it on its own (`disable-model-invocation`), its other frontmatter fields, and its files (the first 50, then a count of the rest). `ampi skills` is the same command group; `ls` is short for `list` and `rm` for `remove`.

```bash
ampi skill list --json        # { skills: [{ name, description, baseDir, path, source }], errors: [{ path, message }] }
ampi skill info pdf-tools --json
```

The source is where the skill comes from:

| Source | Where |
| --- | --- |
| `user`, `project` | Pi's skills directories: `skills` in Pi's configuration directory, and the project's `.pi/skills` |
| `agents-user`, `agents-project` | `~/.agents/skills`, and `.agents/skills` in the project and its parents up to the repository root |
| `claude-user`, `claude-project` | Claude Code's `~/.claude/skills` and the project's `.claude/skills`, which ampi adds |
| `package:<source>` | A Pi package, named by its source in Pi's settings (`npm:…`, `git:…` or a path) |
| `settings` | A path in Pi's `skills` setting or in `ampi.skills.path` |
| `temporary` | A `--skill` argument, or a package given with `-e` |

The listing comes from a session started in memory with what `ampi` loads, so it follows Pi's settings and its project trust: a project's skills are listed only once Pi trusts the project. The session writes no file and calls no model.

`ampi skill add <source>` copies skills into a skills directory. The source is a local directory, a git URL (`https://`, `ssh://`, `file://` or `user@host:path`, with `//<path>` after the repository to take only that directory), or `owner/repo[/path]` for a GitHub repository. A directory with a `SKILL.md` is one skill; otherwise every directory directly in the source, or in its `skills/` directory, that holds a `SKILL.md` is one.

```bash
ampi skill add ./pdf-tools                         # into ./.agents/skills
ampi skill add acme/skills --global                # every skill of github.com/acme/skills, into Pi's skills directory
ampi skill add acme/skills/review --target ~/team-skills
ampi skill add https://example.com/team/skills.git//lint --name team-lint
```

- The default target is the project's `.agents/skills`; `--global` uses `skills` in Pi's configuration directory, and `--target <dir>` any directory (Pi loads it only when it is one of its skill locations or in the `skills` setting).
- Every skill must have a `name` and a `description` in its frontmatter, within Pi's rules (lowercase letters, digits and single hyphens, at most 64 characters), and no link to a file outside it. If one skill fails, nothing is installed and each reason is printed.
- A skill already installed under the same name is kept unless `--overwrite` is given, and a directory without a `SKILL.md` is never replaced. `--name` installs a source's only skill under another name and changes the `name` in its `SKILL.md`; it takes a skill name, never a path. A target inside a skill being copied, such as the default target when the current directory is itself a skill, is refused before anything is created.
- Git sources are cloned with `--depth 1` into a temporary directory, which is removed whether the command succeeds or fails. `.git` is not copied, and nothing from a source is run.
- Each installed skill gets a line; running sessions load new skills after `/reload`. When the project's skills are installed in a project Pi does not trust yet, a note says that Pi loads them once you trust it.

`ampi skill remove <name>` deletes `<target>/<name>` when it is a directory with a `SKILL.md`, after asking (`--yes` skips the question; without a terminal to ask in, the command refuses unless `--yes` is given). Without `--target` or `--global` it looks in the project's `.agents/skills`, then in Pi's skills directory. A skill that loads from anywhere else is not removed: the message names where it comes from and how to remove it there, such as `ampi remove <package>` for a Pi package, the settings entry for a settings path, or the `--target` to pass for `~/.agents/skills`. A skill whose directory is named differently is removed by its directory name; a skill that is a single `.md` file in a skills directory is removed by deleting that file.

Exit status: `0` on success, `1` when a skill is unknown, a source is invalid, a change is refused or a removal is declined, `2` on a usage error. Skill repositories hosted by a service are not offered.

## MCP servers

`ampi mcp` manages the MCP servers Pi connects to. It keeps them where Pi does: `mcp.json` in Pi's configuration directory for your own servers, and `.pi/mcp.json` in a project for the project's. `add`, `remove`, `list`, `oauth login` and `oauth logout` run Pi's `pi mcp` with the arguments translated; `doctor`, `approve` and `oauth status` are ampi's. Any other subcommand or option goes to `pi mcp` as it is, so every `pi mcp` command line also works as `ampi mcp`.

```bash
ampi mcp add files -- npx -y @modelcontextprotocol/server-filesystem .   # a local command (stdio)
ampi mcp add search --env SEARCH_INDEX=./index -- node ./tools/search-mcp.mjs
ampi mcp add docs https://example.com/mcp --header 'Authorization=Bearer ${DOCS_TOKEN}'
ampi mcp add tools --workspace -- ./scripts/tools-mcp            # into this project's .pi/mcp.json
ampi mcp remove search
ampi mcp list --json
```

- `add <name> <url>` becomes `pi mcp add <name> --url <url>`; `--header KEY=VALUE` and `--env KEY=VALUE` can be repeated. After `--`, or after a command given without it, everything is the server's command line and is passed on untouched.
- `--workspace` is Pi's `--local`: `add` and `remove` use the project's `.pi/mcp.json`. Pi's own spellings (`--url`, `-l`, `--local`) and its other `add` options (`--cwd`, `--bearer-token-env-var`, `--oauth-client-id`, `--oauth-client-secret`, `--oauth-callback-port`, `--oauth-client-name`, `--exposure`, `--description`) are accepted as well.
- `ampi mcp --pi-help` prints Pi's own help for `pi mcp`.

`ampi mcp doctor [name]` runs `pi mcp list --json`, in which Pi connects every enabled server, and prints a table: name, status (`connected`, `needs sign-in`, `failed`, `disabled`, …), transport (`stdio` or `http`), number of tools, and the first line of the error of a server that did not connect; on a narrow terminal the error is shortened first, and left out when too little room is left. With a name it shows that server only; a name Pi does not know exits `1` and lists the configured ones. The command exits `1` when a server it shows is enabled but not connected, or when Pi skipped an invalid entry. When the project has a `.pi/mcp.json` that Pi ignores because the project is not trusted, it repeats Pi's note.

`ampi mcp approve <name>` trusts the project. Pi does not approve project servers one by one: it reads `.pi/mcp.json` only in a project you trust, and that trust also covers the project's settings, extensions, skills, prompt templates, themes and system-prompt files. So `approve` first checks that `<name>` is defined in this project's `.pi/mcp.json`, then lists every server in that file with its command or URL, the names of the environment variables it sets (never their values) and its working directory, and every other project resource that trust enables, and asks before it saves "trusted" for the current directory in Pi's trust store (`trust.json` in Pi's configuration directory), the same record Pi's own trust prompt writes. `--yes` (`-y`) skips the question; without a terminal to ask in, the command refuses unless `--yes` is given. A project that is already trusted (the directory or a parent) is reported and left as it is. Change the decision later with `/trust` in a session. Text from the project's file is shown without control characters, line breaks or Unicode bidirectional controls, so the file cannot change how the listing reads. Approve only a project whose files you trust: its servers run with your permissions.

`ampi mcp oauth login <name>` and `oauth logout <name>` are Pi's `pi mcp login` and `logout`: sign in through the browser (`--timeout <seconds>` or `--timeout=<seconds>`, default 300) or delete the stored sign-in. `oauth status <name>` prints `signed in`, `needs sign-in` or `not an OAuth server` (a local command, or an HTTP server that sends its own `Authorization` header), read from `pi mcp list`; it exits `1` when the server could not be reached. Client credentials are not given on the command line: `--client-id`, `--client-secret`, `--scopes`, `--auth-url`, `--token-url` and `--server-url` exit `2`, because Pi takes a registered client from the server's `oauth` block in `mcp.json` (`clientId`, `clientSecret`, `scope`, `callbackPort`, `callbackUrl`, `authServerMetadataUrl`). `ampi mcp add <name> <url> --oauth-client-id <id> --oauth-client-secret <secret>` writes the first two.

Servers stored on a hosted service are not available: `ampi mcp remote …` exits `2`.

Exit status: `0` on success; `1` when a server is not connected or unknown, a change is refused or declined, or Pi fails (Pi's own commands exit with Pi's status); `2` on a usage error.

## Doctor

`ampi doctor` checks what ampi needs and says how to fix what is wrong. It prints one line per check, a status word (`ok`, `warn` or `fail`), the check's id and a summary, then a hint for each check that is not `ok`; the status words are colored only on a terminal (and not when `NO_COLOR` is set). MCP servers have their own check, `ampi mcp doctor` (see [MCP servers](#mcp-servers)).

| Check | Looks at | Not `ok` when |
| --- | --- | --- |
| `node` | Node.js against ampi-cli's `engines` range | `fail`: older than the range |
| `pi` | The installed Pi against the loading ampi's Pi range | `fail`: missing or outside the range |
| `ampi` | Which ampi loads: Pi's own copy (with its source) or ampi-cli's | `fail`: no ampi is installed |
| `agent-dir` | Pi's configuration directory and both `settings.json` files | `warn`: not created yet; `fail`: not writable, or a settings file does not parse |
| `tools` | `rg` and `fd` (or `fdfind`) in Pi's bin directory or on PATH | `warn`: one or both missing |
| `git` | `git` on PATH | `warn`: missing |
| `models` | Models whose provider has credentials | `fail`: none |
| `ampi-data` | ampi's thread index and live session registry | `warn`: either cannot be read |
| `terminal` | `TERM`, `COLORTERM` and the color depth, only when stdout is a terminal | always `ok` |

```bash
ampi doctor --json   # {"checks":[{"id","status","summary","hint"}]}, the hint only when not ok
```

- **It only reads.** It installs nothing, writes no file (Pi's settings are read without Pi's lock files), makes no network request and starts no program of its own: programs are found by looking for executable files in the PATH directories. Pi itself asks npm for its global directory (`npm root -g`) when an npm package in its settings is not installed yet.
- **Credentials.** A model counts when its provider has a key or token in Pi's `auth.json` or a provider environment variable. An OAuth token counts as stored and is not refreshed; a key given as a `!command` counts without the command being run. Keys and tokens are never printed. Models that only an extension registers are not counted.
- **Search tools.** Pi looks for `rg` and `fd` in `bin` in its configuration directory first, then on PATH (`fd` also as `fdfind`, its Debian name), and downloads the missing ones into that `bin` directory on first use when it is online. Without network access, install them with the system package manager (`ripgrep` and `fd-find` on Debian and Ubuntu).
- **ampi.** The check makes the decision ampi-cli makes when it starts (see [If ampi is also installed as a Pi package](#if-ampi-is-also-installed-as-a-pi-package)); an ampi that Pi's settings list but Pi has not installed yet counts, since Pi installs it on its next start.

Exit status: `0` when no check fails, `1` when one does, `2` on a usage error.

## Update

`ampi update` (or `ampi up`) updates ampi-cli itself, with the Pi and ampi it brings, when it was installed with `npm i -g @skippermissions/ampi-cli`:

```bash
ampi update                            # the latest published version
ampi update --target-version 0.4.0     # this version, newer or older
ampi update --porcelain                # one line on stdout: "updated <version>" or "no update needed"
```

1. `npm root -g` gives npm's global directory. The command goes on only when the ampi-cli that runs is `@skippermissions/ampi-cli` in that directory (compared by real path).
2. `npm view @skippermissions/ampi-cli version` gives the latest version; with `--target-version`, `npm view @skippermissions/ampi-cli@<version> version` checks that the version exists. A version that is the one installed, or (without `--target-version`) older than it, needs no update.
3. `npm install -g --ignore-scripts @skippermissions/ampi-cli@<version>` installs it. Install scripts are skipped, as in Pi's own self-update: neither ampi-cli nor its dependencies need them.

The command runs `npm` from PATH (Pi's `npmCommand` setting is not used) and ignores `PI_OFFLINE`, since an update needs the registry. With `--porcelain`, stdout holds only the result line; npm's output and every message go to stderr. A package or version the registry does not know, an `npm` that fails or cannot start, and an installation npm did not make exit `1` with a one-line reason. Other installations are left alone, with how to update them: a source checkout (also when linked with `npm link`) with `git pull` and `npm ci`, `npx` with `npx @skippermissions/ampi-cli@latest`, a pnpm, yarn or bun global install with that tool's global add, and anything else with whatever installed it.

Pi's update arguments still go to Pi's own `update` command unchanged: `ampi update --extensions` updates Pi's packages, `ampi update npm:<package>` one of them, and `--models`, `--all`, `--self`, `--force`, `self` and `pi` keep Pi's meaning (`ampi up` with them is passed on as `update`). Mixing them with `--target-version` or `--porcelain` is a usage error. `ampi update` without arguments is how the Pi that comes with ampi-cli gets updated: Pi's own self-update (`--self`, `--all`, `--force`, `self`, `pi`) under a global ampi-cli runs `npm install -g @earendil-works/pi-coding-agent`, which installs a second, separate Pi.

Exit status: `0` when ampi-cli was updated or needs no update, `1` when it cannot be updated here or npm fails, `2` on a usage error.

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

When the first argument is one of Pi's commands (`install`, `remove`, `uninstall`, `list`, `config`, `auth`), the command runs Pi's own executable with the command line untouched, and ampi is not added. `config keymap` and `config edit` are the exception: they are ampi's (see [Keymap and settings](#keymap-and-settings)). `update` (and `up`) is Pi's only when Pi's update arguments follow, such as `--extensions` or a package source; on its own, or with `--target-version` or `--porcelain`, it updates ampi-cli (see [Update](#update)).

## Compatibility

- **Pi:** 1.3 or later within 1.x, installed as a dependency.
- **Node.js:** 22.19 or later.
- **Last verified:** 2026-10-18, with Pi 1.3.0 and Node.js 24.22.0 (interactive session in a terminal, with and without ampi installed as a Pi package; execute mode with piped and terminal input and output; stream JSON with and without thinking; stream JSON input with a steering message, a follow-up and an image; `threads list`, `markdown` and `continue` in a terminal; `threads new`, then `continue` and `-x --session-id` on its id, `threads color`, and `threads search` with filters, JSON and its usage errors, and `threads context`, `threads usage` and `usage` against the Analyze Context and Thread Cost overlays of the same session; `tools list` in every mode against `/ampi-status` in the terminal UI, and `tools show read --json`; `skill add`, `list`, `info` and `remove` against the skills Pi lists at startup and offers as `/skill:` commands; `mcp add` of a local server at user and project level, `mcp doctor` before and after `mcp approve --yes`, against `/mcp` in the terminal UI). On 2026-10-19, with the same versions: `doctor` and `doctor --json` piped and in a terminal, with `rg` missing and then in Pi's bin directory; `update`, `update --porcelain` and `update --target-version` against a stand-in npm, from a copy installed in a stand-in global directory and from a source checkout; `update --extensions`, `update --all` and `update --all --force` reaching Pi's update.

## Development

From a checkout of the repository, after `npm ci` at its root:

```bash
node packages/ampi-cli/bin/ampi.js -m low
npm run test:one -- tests/mmr-cli-argv.test.mjs
```

The package is plain JavaScript with JSDoc types and no build step. It is not an npm workspace and has no lockfile of its own: in a checkout it runs on the root install, which provides Pi, and loads ampi from the checkout itself. The root `npm run gate` lints, tests, type-checks and packs it. See the repository's [`CONTRIBUTING.md`](../../CONTRIBUTING.md).

`src/live-registry.js` reads the live registry ampi-core keeps of running sessions (one `<agentDir>/data/ampi/live/<pid>.json` per process; the format is in the [ampi-core README](../../src/extensions/ampi-core/README.md#live-registry)), because this package cannot import ampi's TypeScript. `readLiveEntries({ dir, isAlive?, procStart? })` returns the entries of running processes and removes stale ones; `findLiveOwner(sessionPath, { dir, exceptPid? })` returns the process that has a session file open; `liveRegistryDir(agentDir)` names the directory. It follows the same rules as ampi-core's reader, and `tests/mmr-cli-live-registry.test.mjs` fails when the two disagree on the shared fixtures, so change both together.

`src/sdk-session.js` is the one place the command builds a Pi session through Pi's SDK instead of Pi's `main()`. `createAmpiSdkSession({ cwd, sessionManager, mode, uiContext, connectMcp, ampiMode })` loads what an interactive `ampi` loads (Pi's configured packages and extensions; ampi itself unless Pi already loads it, decided as for `main()`; and Pi's built-in codemode, tool_search and MCP extensions, which SDK sessions otherwise leave out), passes `ampiMode` as `--ampi-mode`, binds the extensions with the given mode and UI, and returns Pi's session runtime. With `connectMcp` the MCP extension connects the configured servers, as in Pi's command (the `ampi app` worker); without it the extension still reads its configuration, so codemode and tool_search behave as in a real session, but its transport refuses every server, so no server process starts and no server tools register (`ampi tools`). Pi's command also has a llama.cpp provider built in; Pi's SDK does not export it, so these sessions lack it. Every command that needs a session in its own process uses it rather than building its own. Calls that Pi's SDK documentation does not cover stay in `src/pi-compat.js`, with a probe in `tests/mmr-cli-pi-compat.test.mjs`; `tests/mmr-cli-sdk-session.test.mjs` builds a hosted session against the installed Pi.

`ampi app --worker` is internal: `ampi app` forks it, one process per session it serves, because ampi keeps per-process state and one process never runs two ampi sessions. It is not in the help and exits 2 without an IPC channel. `src/app-worker.js` holds its protocol, over the IPC channel only (never arguments or environment variables, which other processes can read): the parent sends `{ type: "start", token, session: { path } | { cwd } }`; the worker writes ampi-core's GUI host record, opens the session through `createAmpiSdkSession` in Pi's RPC mode, and answers `{ type: "ready", pid, port, sessionId, sessionPath }` once `ampi-gui` listens, then `{ type: "activity", state: "busy" | "idle" }` as the agent works. `{ type: "stop" }`, or the channel closing, ends the session and the process; before `ready`, it ends the start without building a session. A session file another live process has open is never opened: the worker answers `{ type: "error", code: "held", holder: { kind, pid } }` and exits 3. Other failures answer `{ type: "error", code, message }` and exit 1, among them `ampi-too-old` for an ampi without the GUI host seam and `failed` for any error while opening the file or building the session. The live registry entry carries the GUI's port by the time `ready` arrives. Tests: `tests/mmr-cli-app-worker.test.mjs`.

## License

[MIT](LICENSE).
