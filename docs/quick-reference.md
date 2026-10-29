# ampi quick reference

Fast lookup for AMP Code-style modes, tools, optional gates, and common troubleshooting in Pi Agent.

## Modes

| I want to... | Use | Notes |
| --- | --- | --- |
| Quick, focused work | `/mode low` | GPT-5.6 Terra, medium reasoning, compact prompt body |
| Default balanced coding | `/mode medium` | GPT-5.6 Sol, medium reasoning, full prompt body, 300k safety profile |
| Demanding implementation/debugging | `/mode high` | GPT-5.6 Sol, extra-high reasoning, full prompt body |
| Maximum-effort work | `/mode ultra` | GPT-5.6 Sol, Pi `xhigh` reasoning, full prompt body |
| Stock Pi behavior | `/mode free` | Releases ampi locks and removes ampi-owned tools |
| A mode another extension added | `/mode review` or `/mode Review` | Key or label, any case; runs as its base mode with its own overrides ([registered modes](../src/extensions/ampi-core/README.md#registered-modes)) |

```text
/mode              # show current mode
/mode high         # switch mode; after the first message, an explicit override of the lock
/mode Review       # a registered mode, by key or label in any case; /mode lists registered modes after the built-in ones
/ampi-status        # concise locked-mode status, including the mode lock
/ampi-status debug  # model preference candidates, tool resolution, policy details
Ctrl+S              # mode dial, until the first message: further presses or ←/→ turn low → medium → high → ultra;
                    # Tab lists all modes, registered ones between ultra and free; from a registered mode Ctrl+S opens that list
                    # (without ampi-tui: cycles directly, skipping registered modes; Ctrl+Space is a deprecated alias that only works then)
Ctrl+Shift+S        # mode picker (Alt+M fallback), until the first message; lists registered modes after ultra
Alt+D               # toggle the active mode's thinking preset (medium, high, ultra); Alt+R before 0.4.0
Alt+R               # toggle fast speed (OpenAI and OpenAI Codex models; about 2x the price, 2.5x for gpt-5.5)
```

Fast speed asks the provider for priority serving. It applies in every mode, is remembered per session, and never reaches subagent workers; `↯` before the mode name in the prompt box and the `Speed:` line of `/ampi-status` show it. New sessions start at `ampi.speed` (`"standard"` or `"fast"`), or fast with `--ampi-fast=true`.

In the interactive TUI, locked modes compact the conversation automatically once a finished run leaves it at 90% of the context window (Medium: 270k of 300k); `free`, subagent workers and `print`, `json` and `rpc` runs never do. Set `ampiCore.autoCompact` to `{ "threshold": 0.8 }` to compact earlier or to `false` to leave compaction to Pi; `/ampi-status debug` shows the threshold and the last auto-compaction.

Mode source precedence: `--ampi-mode` flag → persisted session → `ampiCore.defaultMode` → `medium`. Legacy `rush`, `smart`, `deep`, and `fable` inputs normalize to `low`, `medium`, `high`, and `ultra`.

File editing follows the route, not the mode: `openai`, `openai-codex`, and `azure` routes get `apply_patch` + `write`; every other provider gets `edit` + `write`. `ampiCore.editTools` (`"auto"`, `"patch"`, `"edit"`) forces one family; `/ampi-status` names the active one on its `Edit tools:` line.

The mode is fixed once a session has a message: the dial or cycle, the picker and the palette's `mode use` rows stop changing it, and only `/mode <key>` or a native Pi model change still does. Start a new session for another mode, or set `ampiCore.modeLock` to `false` to switch at any time.

## Workers and subagents

| I need to... | Ask for... | Tool |
| --- | --- | --- |
| Locate code by concept or behavior | “Use finder to locate…” | `finder` |
| Get deep architecture/review/debug advice | “Ask oracle to review…” | `oracle` |
| Run bounded child work | “Use Task to…” | `Task` |
| Review a completed diff/change | “Use reviewer to review…” | `reviewer` |
| Check a change against the repository's review rules | “Use reviewer to run the review checks on…” | `reviewer` with `checks_only`, `check_filter`, `check_scope`; rules in `.agents/checks/*.md` |
| Review a diff from a shell or CI job, without a session | `ampi review` (see [Command line](#command-line)) | the same `reviewer` pipeline; report or `--json` findings, exit 0 or 1 |
| Research a GitHub repository | “Use librarian to explain owner/repo…” | `librarian` |
| Look at an image or screenshot | “Use view_media to read the error in screenshot.png” | `view_media` |
| Run independent jobs | “Run finder/Task/librarian with background: true…” | `background: true`, `task_poll`, `task_wait`, `task_cancel` |
| Use custom workers | “Use sa__name to…” | imported Markdown `sa__*` tools |

Examples:

```text
Use finder to find where mode activation applies tool allowlists.
Ask oracle to review the fallback design and list risks.
Use Task to update the focused docs file and run git diff --check.
Use reviewer to review all uncommitted changes.
Use view_media to read the error in screenshot.png.
Use reviewer with checks_only to run only the .agents/checks rules on the uncommitted changes.
Use librarian to explain how owner/repo implements request cancellation.
```

Each worker call shows as one line in the transcript; expand tool output (Ctrl+O, or Alt+T with `ampi-tui`) to see its latest steps, its answer and its token use:

```text
 ⠋ Searching codebase · where mode activation applies tool allowlists
 ✓ Consulted oracle · Review the fallback design and list risks
 ✗ Subagent finished · Update the focused docs file
 ⊘ Researched with librarian · how owner/repo implements request cancellation
```

## Patch

Owned by `ampi-patch` (`mmr-patch` runtime id).

| I need to... | Use | Notes |
| --- | --- | --- |
| Apply a focused patch | `apply_patch` | Local workspace edits only; rejects ambiguous/path-unsafe patches |

## Background shell

Owned by `ampi-shell` (`mmr-shell` runtime id). Pi's `bash` stays the tool for quick commands. Linux and macOS.

| I need to... | Use | Notes |
| --- | --- | --- |
| Run a server, watcher, long build or test suite | `shell_command` | `command`, `workdir?`, `timeout_ms?`; left running in the background after `ampiShell.backgroundAfterMs`, with its pid |
| Wait for it and read new output | `shell_command_status` | `pid`, `timeout_ms?` (0 to 60000, default 10000) |
| Stop it | `shell_command_kill` | `pid`; SIGTERM, then SIGKILL after one second |

Every running command is stopped when the session ends.

## Images

Owned by `ampi-painter` (`mmr-painter` runtime id). Off by default; `gated` until an image model of the user's providers is usable.

| I need to... | Use | Notes |
| --- | --- | --- |
| Make or edit one image | `painter` | `prompt`, `reference_images?` (up to 3), `background?` (`transparent`, `opaque`, `auto`), `output_path?`; saved under the agent directory unless `output_path` names a new file inside the working directory |

## Tasks

Owned by `ampi-tasks` (`mmr-tasks` runtime id).

| I need to... | Use | Notes |
| --- | --- | --- |
| Track multi-step work | `task_list` | Session-local; rendered in the Pi UI |
| Let the model ask you to pick an answer | `ask_user_choice` | `question`, `options` (2 to 8), `allow_other?`; fails at once without a UI |
| Show or hide the pinned list | `/tasks show`, `/tasks hide` | No toggle key by default; `--task-widget-toggle-key <key>` binds one |

## Optional reach

| Capability | Enable | Provides |
| --- | --- | --- |
| Web search/page reads | `AMPI_WEB_ENABLE=true` (legacy `MMR_WEB_ENABLE` still accepted) or `ampiWeb.enabled=true` | `web_search`, `read_web_page` |
| Image generation and edits | `AMPI_PAINTER_ENABLE=1` (legacy `MMR_PAINTER_ENABLE` still accepted) or `ampiPainter.enabled=true`, plus a usable image model | `painter` |
| GitHub repository reads | `AMPI_GITHUB_ENABLE=true` (legacy `MMR_GITHUB_ENABLE` still accepted) | `read_github`, `list_directory_github`, `glob_github`, `search_github`, `commit_search`, `diff_github`, `list_repositories` |
| Prior local Pi sessions | `AMPI_HISTORY_ENABLE=true` (legacy `MMR_HISTORY_ENABLE` still accepted) | `find_session`, `read_session` |
| Web GUI for the running session | `AMPI_GUI_ENABLE=true` or `ampiGui.enabled=true` | A `Web GUI: http://127.0.0.1:<port>/?t=<token>` link at session start and the `thread open in browser` command; a live transcript and a composer (Enter steers, Ctrl+Enter queues, Esc Esc interrupts); page keys such as Ctrl+B (sidebar), `/` (search), Ctrl+Alt+Up/Down (previous or next session), Ctrl+G then I (pin), Ctrl+G then Z (snooze), Mod+Shift+K (Search Threads), Ctrl+O or Mod+K (the command palette, which runs any page command by name or sends what you type as a message), Mod+P (Switch Thread), `o` (an outline of your messages) and `?`, which lists them all; with text selected in the transcript, `r` replies quoting it and `c`, `s` and `l` copy it as Markdown, with styling or as a link to the message; a dot on the jump-to-bottom button marks output that arrived below; the title bar's mode button, Change Mode… in the palette or Ctrl+S in the prompt before the mode is locked opens the mode picker (ampi's modes with their models, Free last, or Pi's models by provider; once the mode is locked, Change anyway overrides it as `/mode` does, and choosing a model switches to Free); the sidebar's Activity tile opens `/feed`, every session by day with Time, Status, Projects and search filters kept in the address; the title bar's `…` (More Actions) copies, exports, shows the cost and where a session runs, pins, renames, labels, colours, marks unread, snoozes, archives and deletes any listed session; local only |
| Every session in one web page | `ampi app` (`--open` opens the link) | One page at `http://127.0.0.1:<port>/` listing every session with where it runs; sessions nothing else has open continue there, and so do those a terminal runs with its web GUI on; the others are read-only. Its home page (also `/new`; the sidebar's New Thread button, Alt+Enter or New Thread… in the palette) starts a thread: a prompt, then where it runs (Ctrl+M, this machine), its directory (Ctrl+J, from the ones your sessions used or a typed path; on a Git checkout, Tab switches to New Worktree, which runs the thread in a new `git worktree` on branch `ampi/<slug>` in `<repo>-worktrees/` beside the checkout, never removed by ampi), its mode (Ctrl+S) and labels (Ctrl+L); Enter creates and opens it, Mod+Shift+Enter creates it in the background, Ctrl+Alt+Enter (⌃⌘Enter on macOS) creates it and starts a fresh composer, and Ctrl+I inserts the thread you came from as `@<id>`; local only |

Optional secrets stay in the environment:

```bash
export BRAVE_API_KEY="brv_xxx"
export AMPI_GITHUB_TOKEN="ghp_xxx"
```

Restart Pi after changing gates that register tools.

## Keys

Amp-compatible keys from `ampi-tui` in interactive sessions. After the first key of a chord, a popup above the prompt lists the keys that can follow; it closes after 1.5 seconds or on Esc.

| Key | Does | Notes |
| --- | --- | --- |
| `Esc` | Clear the prompt | While a turn runs, the first Esc of `Esc Esc` also clears it; on an empty prompt with nothing running, Esc is Pi's |
| `Esc Esc` | Stop the running turn | Two presses within 0.5 s |
| `Enter` | Send the prompt | While a turn runs, the message steers it |
| `Alt+Enter`, `Shift+Enter`, `Ctrl+J` | New line | Alt+Enter no longer queues a follow-up |
| `Enter` on an empty prompt | Steer with the next queued message | Only while a message is queued |
| `Backspace` on an empty prompt | Take queued messages back into the prompt | Only while messages are queued; Pi's `Alt+Up` does the same |
| `Ctrl+C Ctrl+C` | Quit | The first press shows the popup and keeps the prompt |
| `Ctrl+C Ctrl+N` | Archive this session and start a new one | From `ampi-threads`; only in a session with messages |
| `Ctrl+C Ctrl+E` | Archive this session and quit | From `ampi-threads`; only in a session with messages |
| `Ctrl+X` | Leader | Bindings written `<leader>z` mean Ctrl+X, then Z |
| `Home` / `End` | Jump to the start / end of the transcript | Only with an empty prompt, in Pi's fullscreen mode |
| `Ctrl+G` | Edit the prompt in your external editor | Pi's action, now a command |
| `Ctrl+R` | Open the prompt history | Prompts you sent in this workspace, newest first; type to filter, Enter puts one in the prompt without sending it, Alt+W or Ctrl+T shows every workspace's; needs `ampi-threads` |
| `Ctrl+O` | Open the command palette | Type to filter, ↑/↓ to move, Enter to run, Esc to close; Pi's slash commands are listed under `pi` |
| `/` | Open the command palette | Only on an empty prompt; with text, `/` is typed as usual |
| `Alt+T` | Expand or collapse tool output and thinking together | Replaces Pi's Ctrl+O for tool output |
| `Alt+R` | Turn fast speed on or off | From ampi-core; only for OpenAI and OpenAI Codex models, otherwise it says why. In the palette as `speed use fast (2x cost)` or `speed disable fast` |
| `?` | Show or hide the shortcuts help | Only on an empty prompt; Esc or any other key closes it |
| `Shift+Tab` / `Tab` | Select your previous / next message | Shift+Tab only on an empty prompt (with text it cycles Pi's thinking level); Tab past the newest, Esc or typing clears the selection |
| `e` | Edit the selected message | Puts it into the prompt and continues the thread from before it on a new branch; the old branch stays in `/tree` |
| `@` | Mention a file or directory | Pi's completion, with two hint rows under it for `@:` and `@@` |
| `@:` | Mention a commit | The repository's last 30 commits with how long ago each was made; type to filter by sha or subject, Enter inserts `@:<short sha>` |
| `@@` | Mention a session | Opens the Mention Thread picker; Enter inserts `@<session id>`, Esc types the `@` |

In the command palette, "ampi help" opens the Help & Keymap screen: every editor key, scrolling key and command with the key in effect (`—` when it has none). "ampi show keymap" shows the keymap in effect as JSONC to copy under `ampi.keymap`. Both scroll with ↑/↓, j/k and PgUp/PgDn; Esc closes them.

To change sessions, run `thread switch` from the palette: it lists this workspace's sessions, newest first, with a preview of the selected one; Enter switches, Alt+W or Ctrl+T shows every workspace's, Alt+A adds archived ones. `thread switch to previous` and `thread switch to next` go back and forth through the sessions you switched between. These need `ampi-threads` and have no default key.

A new session gets a title of a few words from a small model once its first reply completes; `thread rename` sets your own, which is never replaced. `ampiThreads.titles: false` turns generated titles off.

Mentions are plain text in your message. The model sees `@:<sha>` and can run git on it; it sees `@<session id>` (Pi's session id, with no `T-` prefix) and can read that session with `read_session` when `ampi-history` is enabled (`AMPI_HISTORY_ENABLE=true`). `thread mention` in the palette opens the same picker as `@@` and inserts the reference at the cursor.

`thread copy markdown` copies the session as Markdown; `thread copy resume command` copies `ampi threads continue <session id>` to open it again from a shell (it is unavailable before the first message and with `--no-session`); `thread show cost` shows what it cost so far, per model; `thread analyze context` shows what fills the context window: system prompt, tools, AGENTS.md files, skills, compaction summary and messages, with their share of the window. These need `ampi-threads` and have no default key. `ampiThreads.showCosts: false` hides the cost gauge and `thread show cost`.

`prompt clear` empties the prompt; `prompt move to line start` and `prompt move to line end` move the cursor within its line; `prompt copy selection` copies the transcript text selected with the mouse (Pi's fullscreen mode only; the prompt itself has no selection). They have no default key.

`thread toggle outline` shows the headings of the last response in a small box above the prompt, under the message it answers; it takes no keys and updates as responses end. Run it again to hide it. It has no default key.

`skills list` shows the skills Pi loaded, grouped by where it found them; `extensions list` shows each extension with the slash commands and tools it registered (one that registers neither is not listed); `extensions reload` runs Pi's `/reload`; `ampi show version` shows the ampi, Pi and Node versions. They have no default keys.

`ampi show welcome` replays the intro that opens once on your first start: seven short stages on modes, sessions, steering, subagents and keys. Space or → moves on, ← or Backspace goes back, Esc closes it, Enter closes the last stage. It has no default key; `ampiTui.intro: false` keeps it from opening by itself.

`mcp info` shows the MCP servers from your and the project's `mcp.json` and from extensions, with their state, tool count, exposure and source, and on a second tab (Tab switches) the tools of each server; `mcp authenticate` runs Pi's `/mcp`, where you sign in to a server. They have no default keys.

The shortcuts help lists the keys in effect, including any you rebound, in the prompt box above the text. Inside tmux with `extended-keys` off it adds a line saying Shift+Enter needs that option; Alt+Enter works either way.

The prompt box shows the session's state in its borders: the mode (with `↯` in front at fast speed) and the session cost at the top right, the turn status and key hints at the bottom left, the working directory and git branch at the bottom right.

While a turn runs, `prompt queue message` in the palette queues the prompt to run after the turn instead of steering it. Waiting messages are listed above the prompt box, `steering:` first, then `queued:`. `prompt steer queued message` and `prompt dequeue` do what Enter and Backspace on an empty prompt do.

The terminal title reads `<title> - ampi - <cwd>`, with the wave glyph in front while a turn runs and `! <status>:` when the turn needs you. When a turn finishes or waits for an approval, ampi sends a desktop notification through the terminal (a bell over SSH or with `AMPI_FORCE_BEL=1`). After Ctrl+C Ctrl+C, ampi's mark, the session title and the working directory stay in the scrollback above Pi's resume line.

Rebind under `ampi.keymap` (a key string, an array, or `null` to unbind; `leader` moves the leader), then `/reload`. With the `ampi` command, `ampi config keymap` prints the keymap in effect from the shell and `ampi config edit` opens Pi's settings file:

```json
{ "ampi": { "keymap": { "leader": "alt+x", "ampi.quit": null } } }
```

## Command line

The optional `ampi` command (`npm i -g @skippermissions/ampi-cli`) starts Pi with ampi loaded. Other options and Pi's own commands go to Pi unchanged. An `npm i -g` install updates itself, with its Pi and ampi, through `ampi update`.

| I want to... | Run | Notes |
| --- | --- | --- |
| Start a session | `ampi` | Same as `pi -e npm:@skippermissions/ampi` |
| Start in a mode | `ampi -m high` | `-m`/`--mode` become `--ampi-mode`, which also takes a registered mode's key or label; `--mode text`, `json`, `rpc` stay Pi's output format |
| Start at fast speed | `ampi --fast` | Becomes `--ampi-fast=true`; also with `-x` |
| Let every tool call run without asking | `ampi -x --dangerously-allow-all "..."` | Becomes `--ampi-dangerously-allow-all=true`; also in a session and its subagents. Without it, `ampi-permissions` refuses calls that need approval in execute mode and reports them on stderr or as `permission_denials` |
| Run one message and print the answer | `ampi -x "list the npm scripts"` | Only the final assistant message goes to stdout; exit status 0, 1 (failure) or 2 (usage error) |
| Get the run as JSON records | `ampi -x "list files" --stream-json` | One JSON record per line, compatible with Claude Code's stream-json; a subagent's records name the tool call that started it in `parent_tool_use_id`; `--stream-json-thinking` adds thinking blocks |
| Send several messages to one session | `producer \| ampi -x --stream-json --stream-json-input` | One JSON user message per stdin line, `"steer": true` to redirect the run in progress; a result record after each run |
| Review a diff without a session | `ampi review [description]` | The reviewer and the review checks once, on the uncommitted changes by default; the report, or `--json` with parsed findings; `-f`, `-i`, `-c`, `-s`, `--checks-only`, `--thinking low\|high` (default `low`); recorded as an archived thread; exit 0 when it ran, 1 when it failed, 2 on a usage error |
| Send piped input with a request | `git diff \| ampi -x "review this"` | The message is the argument, a newline, then stdin; redirected input or output implies `-x` |
| Get one JSON summary of the run | `ampi -x --stats "..."` | The result, turns, token usage and, when the model reports it, `total_cost_usd` on one line |
| Print one tool's output | `ampi -x --output-tool bash "run the tests"` | The text of the last finished call to that tool; exit 1 when it failed or never finished |
| Add MCP servers for one run | `ampi --mcp-config servers.json` | JSON or a file in the `mcpServers` format; a server of the same name in `mcp.json` wins |
| Keep a script's session unarchived | `ampi -x --no-archive-after-execute "..."` | Sessions created in execute mode are archived in the thread index by default |
| Name or label the session | `ampi --title "Release check" -l release` | `--title` is Pi's `--name`; labels go to the thread index |
| Pass a message that looks like an option | `ampi -- -m is a flag` | Everything after `--` goes to Pi as the message |
| Create an empty session | `ampi threads new` | Prints a new session id and writes nothing; open it with `ampi threads continue <id>` or `ampi -x --session-id <id> "..."`; `--json` adds the directory |
| List sessions | `ampi threads` | This directory, archived ones left out; `--all`, `--archived`, `--json`, `--limit <n>` |
| Search sessions | `ampi threads search parser label:docs after:7d` | Every directory, latest update first; words, `"phrases"` and keys such as `id:`, `parent:`, `label:`, `pinned:`, `archived:`, `is:unread`, `repo:`, `cwd:`, `model:`; `-n <n>` (default 20), `--json` |
| Reopen a session | `ampi threads continue 019a3c` | An id or its first characters; `ampi last` opens the latest session that is not archived |
| Print a session | `ampi threads markdown 019a3c` | `threads export` prints JSON with every session entry |
| See what fills a session's context | `ampi threads context 019a3c` | JSON: tokens and share of the window per section, total, free space, compactions, tool counts |
| See what a session cost | `ampi threads usage 019a3c` | Total in the gauge's format; `--details` adds tokens and cost per model and tool calls; `--start`, `--end` (ISO 8601), `--json` |
| See which agents have conversations here | `ampi threads import detect` | Claude Code, Codex and OpenCode: each data location and whether it exists; reads no conversation; `--json` |
| Import Claude Code, Codex or OpenCode sessions | `ampi threads import claude --all` | `codex` and `opencode` work the same way. Sessions updated in the last 30 days (`--max-age <days>`, `0` for all), newest first, `--limit <n>`; or give session ids; read-only sessions labelled `imported` and the agent; already imported ones are skipped (`--reimport` replaces them); `--dry-run`, `--json`, `--claude-dir`, `--codex-dir`, `--opencode-dir <path>`. OpenCode's database needs Node.js 22.19 or later |
| See what all sessions cost | `ampi usage` | Every directory, the last 30 days by default; `--details` adds the per-model table and the ten most expensive sessions; `--start`, `--end`, `--json`. Local totals only: no account or credits |
| List the tools a mode declares to the model | `ampi tools list -m high` | Grouped by source: built-in, ampi, `extension:<name>`, mcp; `tools show <tool>` prints its description and parameters; `--json`; MCP servers are not connected, so their tools are not listed |
| List the skills Pi loads here | `ampi skill list` | Name, source (`user`, `project`, `agents-user`, `agents-project`, `claude-user`, `claude-project`, `package:<source>`, `settings`, `temporary`), description and directory; Pi's loading problems on stderr; `--json`; `skill info <name>` shows one with its frontmatter and files |
| Install skills | `ampi skill add ./my-skills` | A directory, a git URL (`//<path>` takes one directory of it) or `owner/repo[/path]` on GitHub; into `./.agents/skills`, or `--global` (Pi's skills directory) or `--target <dir>`; `--overwrite`, `--name <name>`; invalid skills are refused and nothing from the source runs |
| Remove an installed skill | `ampi skill remove pdf-tools` | The project's `.agents/skills`, then Pi's; asks first (`--yes` skips); a skill from a package or the settings is refused with where to remove it |
| Add an MCP server | `ampi mcp add docs https://example.com/mcp` | Or `ampi mcp add <name> -- <command> [args]` for a local command; `--env KEY=VALUE`, `--header KEY=VALUE` (repeatable); `--workspace` writes the project's `.pi/mcp.json`; Pi's `pi mcp add` options also work |
| Check MCP servers | `ampi mcp doctor` | Name, status, transport, tools and the first error line per server, or one server with `doctor <name>`; exits 1 when a server is not connected; `ampi mcp list` is Pi's full listing |
| Trust a project's MCP servers | `ampi mcp approve tools` | Trusts the whole project as Pi's trust prompt does, after listing its servers and other project resources; asks first (`--yes` skips) |
| Sign in to an MCP server | `ampi mcp oauth login docs` | `oauth logout`, `oauth status` (signed in, needs sign-in, not an OAuth server); client credentials go in the server's `oauth` block in `mcp.json` |
| Rename, archive, label, color or delete a session | `ampi threads rename 019a3c "New title"` | Also `archive`, `unarchive`, `label <id> <label...>`, `color <id> <color>` (a name, `#rrggbb` or `none`), `delete` (asks first; `--yes` skips); rename and delete refuse a session another running process has open |
| List the permission rules | `ampi permissions list` | The user's rules in the text form, one per line (`ask bash --command 'git push*'`); `--workspace` the project's, `--builtin` ampi's defaults, `--json` the stored list |
| See what a session decides about a tool call | `ampi permissions test bash --command 'git push'` | Runs nothing; exit 0 allow, 1 reject, 3 ask or delegate; `--json`, `-q`, `--context subagent`, `--workspace` |
| Edit or add permission rules | `ampi permissions edit` | The rules as text in your editor, or from stdin; written back only when every line is valid. `ampi permissions add ask bash --command 'git push*'` puts one rule first |
| See which sessions run on this machine | `ampi top` | Live full-screen list: status, title, mode, directory, kind, time up, pid; q, Esc or Ctrl+C quits; `--json` prints it once, `--stream-jsonl` one JSON line per change |
| See what ampi reads for each key | `ampi dev keys` | One JSON line per key: the keys, the event, the command id the keymap runs and the prefix it waits on; `--raw` adds the bytes, `--no-keymap` leaves out the keymap; Ctrl+C twice or Ctrl+D quits; piped input is replayed |
| See why the command did something | `ampi --log-level debug --log-file ampi.log -x "..."` | Levels `error`, `warn`, `info` (default), `debug`, also from `AMPI_LOG_LEVEL`; the file (also `AMPI_LOG_FILE`) gets one line per diagnostic and errors still reach stderr; Pi's own output is not logged |
| Turn colour off or on | `ampi --no-color -x "..."` | Sets `NO_COLOR=1` (`--color`: `FORCE_COLOR=1`) for Pi and the tools it runs; Pi's text outside the terminal UI follows the flag |
| See versions | `ampi version` | ampi-cli, ampi and Pi |
| Complete ampi's commands on Tab | `source <(ampi completions bash)` | Also `zsh`, `fish` and `pwsh`; `ampi completions --help` shows where each goes. Completes commands, options, modes, colours, this directory's session ids, skill and MCP server names |
| Choose which parts of ampi load | `ampi setup` | Lists the parts and asks in a terminal; `--parts <list>` (core plus these), `--add`, `--remove`, `--all`, `--list`, `--local` for the project; writes Pi's package filter on the ampi entry and installs ampi first when the settings have none |
| Check the setup | `ampi doctor` | Node.js, Pi, ampi, the parts that load, Pi's configuration directory and settings, `rg`, `fd`, `git`, credentials, ampi's data files; `ok`/`warn`/`fail` with hints, `--json`; exit 1 on a `fail`; installs and writes nothing |
| Update the `ampi` command | `ampi update` | `npm i -g` installs only, with the Pi and ampi it brings; `--target-version <v>`, `--porcelain`; `ampi update --extensions` and other Pi update arguments still go to Pi |
| See Pi's options | `ampi --pi-help` | Includes the `--ampi-*` flags |

If Pi already loads ampi (from its settings, an extension directory or a `-e` argument), the command uses that copy and says so on stderr instead of loading ampi twice.

## Settings

Minimal settings example:

```json
{
  "ampiCore": {
    "defaultMode": "low",
    "subagentModelPreferences": {
      "finder": [{ "model": "gpt-5.4-mini", "thinkingLevel": "low" }]
    }
  },
  "ampiWeb": { "enabled": true },
  "ampiTui": { "notifications": { "enabled": true, "system": true, "sound": false } }
}
```

`ampiTui.notifications`: `enabled` turns notifications off entirely, `system` the desktop notification (or bell), `sound` a `paplay` sound from the freedesktop theme.

`ampiTui.animations: false` keeps the terminal still: spinners stay on their first glyph, the prompt box's wave glyph stays put and the welcome mark does not play. The environment variable `NO_ANIMATION`, set to any non-empty value, does the same.

| Setting | Default | Meaning |
| --- | --- | --- |
| `ampiShell.enabled` | `true` | Load `ampi-shell` (`AMPI_SHELL_ENABLE=0` also turns it off) |
| `ampiShell.backgroundAfterMs` | `30000` | How long `shell_command` waits before leaving a command in the background |
| `ampiShell.maxBackground` | `8` | Background commands that may run at once per session |
| `ampiPainter.enabled` | `false` | Offer `painter` (`AMPI_PAINTER_ENABLE=1` also turns it on) |
| `ampiPainter.model` | unset | Image model as `provider/id`, split at the first `/`; unset uses the first usable one by provider, then id |

Settings are read from `~/.pi/agent/settings.json` and `<project>/.pi/settings.json`. Flat (`ampiCore`) and nested (`ampi.core`) forms are accepted where supported by the owning extension.

| Setting | Does | Example |
| --- | --- | --- |
| `ampi.tools.disable` | Turns tools off in every mode and in workers, and blocks calls to them, nested calls included. Exact names, `*` globs, or `builtin:<name>` for Pi's own built-in tools only; user and project lists combine | `["web_search", "task_*", "builtin:grep"]` |
| `ampi.skills.path` | Extra skill directories, `:`-separated (`;` on Windows); `~` is home, relative entries resolve against the repository root. A project value counts only when Pi trusts the project | `"~/my-skills:/shared/team-skills"` |
| `ampi.speed` | The speed a new session starts at: `"standard"` (default) or `"fast"`, priority serving at a higher price for OpenAI and OpenAI Codex models. A session keeps the speed you last chose in it. A project file's value applies only once Pi trusts the project | `"fast"` |
| `ampi.skills.disableClaudeCodeSkills` | `true` stops loading skills from `.claude/skills` (project, up to the repository root, with project trust) and `~/.claude/skills`, which are read by default | `true` |
| `ampiCore.subtreeGuidance` | `false` stops adding the `AGENTS.md` (or `CLAUDE.md`) of subfolders to `read` results; on by default, once per folder per session branch, and off with `-nc` | `false` |
| `ampi.terminal.detailsExpandedByDefault` | `true` starts sessions with tool output expanded and thinking shown; Alt+T still toggles them. Showing thinking saves `hideThinkingBlock: false` to your user settings | `true` |
| `ampi.fuzzy.alwaysIncludePaths` | Globs relative to the working directory whose paths `@` file mentions offer even when git ignores them | `["dist/**"]` |
| `fullscreenCopyOnSelect` | Pi's own setting (default `true`): copy transcript text as soon as you select it with the mouse, in fullscreen mode only. Set it to `false` to stop copying on select | `false` |
| `ampi.permissions` | Turns on [`ampi-permissions`](../src/extensions/ampi-permissions/README.md): rules that allow, reject, ask or delegate to a program before tool calls, ahead of ampi's defaults (reads, tests and builds run; other shell commands ask), optionally only in the main session or in subagents (`context`). `[]` uses the defaults only. A trusted project adds only `reject` and `ask` rules. Applies in Free mode too | `[{ "tool": "bash", "matches": { "command": "git push*" }, "action": "ask" }]` |
| `ampi.dangerouslyAllowAll` | `true` in the user settings lets every tool call run without asking (the dialog's "Allow All for Every Session" sets it); `false` turns `ampi-permissions` on. A project's `true` is ignored. For one run: `--ampi-dangerously-allow-all`, or `ampi --dangerously-allow-all` | `false` |
| `ampi.guardedFiles.allowlist` | User settings only: absolute globs and exact `{ "path": ... }` entries (`~/` allowed) that `edit`, `write`, `apply_patch` and `painter` may change without the guarded file dialog (keys, `.env`, `.git`, `.pi`, system directories, ...); "Always Allow This Path" adds to it. Present turns `ampi-permissions` on, with its default rules. A project's value is ignored | `["~/work/app/.pi/**", { "path": "~/work/app/.env" }]` |

## Tool status words

| Status | Meaning |
| --- | --- |
| `active` | Registered and available to the current mode |
| `gated` | Known but waiting on config or a prerequisite |
| `disabled` | Explicitly turned off, for example by `ampi.tools.disable` |
| `deferred` | Reserved for planned capability |
| `missing` | No extension registered that tool name |

## Common fixes

| Symptom | Do this |
| --- | --- |
| A session will not start, or a search tool is missing | Run `ampi doctor`; it names the check that fails and what to do |
| `Model applied: no` | Run `/ampi-status debug`; check provider registration/authentication |
| Tool is `gated` | Enable its extension and restart Pi |
| `librarian` is `gated` | Enable `AMPI_GITHUB_ENABLE`; add `AMPI_GITHUB_TOKEN` for private repos/search |
| Web search is unreliable | Configure `AMPI_WEB_SEARXNG_URL` or `BRAVE_API_KEY` |
| Mode unexpectedly became `free` | Re-enter `/mode <key>` after native `/model` or `/think` changes |
| Ctrl+S says the mode stays | The session has messages; use `/mode <key>`, start a new session, or set `ampiCore.modeLock: false` |
| Locked mode refuses to activate | Check model preference candidates and active tool resolution in `/ampi-status debug` |
| No footer below the editor | `ampi-tui` removes it by default; set `ampiTui.enabled: false` (or `AMPI_TUI_ENABLE=false`) and restart Pi to restore it |
| Ctrl+C no longer clears the prompt | `ampi-tui` uses Ctrl+C Ctrl+C to quit; clear with Ctrl+U, or set `"ampi.quit": null` under `ampi.keymap` to give Ctrl+C back to Pi |
| One Esc no longer stops a turn | Press Esc twice; or set `"thread.interrupt": null` under `ampi.keymap` |
| Ctrl+O no longer expands tool output | `ampi-tui` puts the command palette there; Alt+T expands tool output and thinking together |
| `/` on an empty prompt opens the palette instead of slash completion | Pick the command under `pi` in the palette; a command that takes arguments is put into the prompt for you to finish and send. Or set `"prompt.openPalette": null` under `ampi.keymap` to type slash commands directly |
| No notification when a turn finishes | Check `ampiTui.notifications`; inside tmux, or in a terminal without OSC 777 notifications, set `AMPI_FORCE_BEL=1` for a bell |
| You want no moving glyphs | Set `NO_ANIMATION=1` in the environment, or `ampiTui.animations: false` in a settings file |
| Alt+Enter no longer queues a follow-up | It inserts a newline in the prompt box; use `prompt queue message` in the palette, or bind `prompt.queue` under `ampi.keymap` |
| Alt+R no longer toggles the thinking level | Since 0.4.0 Alt+D toggles the thinking preset; Alt+R turns fast speed on or off |
| Shift+Tab no longer cycles the thinking level | On an empty prompt it selects your previous message; type something first, or set `"thread.selectPreviousMessage": null` under `ampi.keymap` |
| A key does nothing | Run `ampi dev keys` and press it: the line shows what ampi receives and which command the keymap maps it to; no line means the terminal or tmux holds the key back |

Full troubleshooting: [`troubleshooting.md`](troubleshooting.md).
