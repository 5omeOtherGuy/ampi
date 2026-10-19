# ampi-permissions

Asks before risky tool calls: rules in your settings allow, reject or ask about each call, or hand it to a program you name, and an approval dialog lets you decide the ones that ask. Changes to guarded files (keys, credentials, `.env`, `.git`, agent configuration, system directories) always ask.

Package overview: [`../../../README.md`](../../../README.md). Planning: [`../../../ROADMAP.md`](../../../ROADMAP.md). Public API: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## At a glance

| Default | Provides | Requires | Diagnostics |
| --- | --- | --- | --- |
| Off (inert until configured) | A `tool_call` gate in sessions and subagents, the approval and guarded file dialogs, delegate programs, ampi's default rules | `ampi.permissions`, `ampi.dangerouslyAllowAll: false` or `ampi.guardedFiles.allowlist` in settings | `/ampi-status` (`Permissions:` line), warnings at session start |

## When to use it

- You want shell commands that change things (`rm`, `git push`, installs, deploys) to wait for your yes, while reads, tests and builds run on their own.
- You want hard rules: never run a command, never touch a path, with a reason the agent sees.
- A project should be able to add restrictions for everyone who trusts it, but never remove yours.
- You have your own checker (a script, a policy tool) that should decide some calls.
- You want the agent to stop and ask before it edits `~/.ssh/config`, a `.env`, a Git hook or `.pi/settings.json`, even with edits otherwise allowed.

## Status and enablement

Default: off. The extension loads with the package but does nothing until a settings file turns it on:

- `ampi.permissions` is present, with any value (an invalid one included), or
- `ampi.dangerouslyAllowAll` is exactly `false`,

in the user settings (`<agentDir>/settings.json`, normally `~/.pi/agent/settings.json`) or in a project's `.pi/settings.json` that Pi trusts. A project may turn it on, because that only tightens. A third way is the user settings' `ampi.guardedFiles.allowlist` (see [Guarded files](#guarded-files)), with any value; a project's does not count.

Once on, the gate applies the rules, ampi's defaults included, and the guarded files, whichever way it was turned on.

The gate applies in every mode, Free included: it is your safety setting, not a mode policy. It also applies to calls another tool makes (codemode scripts, nested calls), and to subagent children, which refuse what would ask instead of opening a dialog (see [Subagents](#subagents)).

`/ampi-status` shows `Permissions: enabled` with the number of project, user and default rules and of guarded file allowlist entries, or `disabled` with how to turn it on. The feature gate ids are `ampi-permissions` and `mmr-permissions`.

## Tools / commands / surfaces

| Surface | What it does |
| --- | --- |
| `tool_call` gate | Allows, blocks or asks about each tool call |
| Approval dialog | `Approval Required` with the tool, the part of a shell line that asked, and the command, path or fields (long lines are cut in the middle); options `Allow Once`, `Reject with feedback`, `Allow All for This Session`, `Allow All for Every Session` |
| Guarded file dialog | `Guarded File Modification` with the tool and each guarded path with its category; options `Allow Once`, `Always Allow This Path`, `Reject` |
| Prompt box | Reads `Waiting for Approval` while a dialog is open; the terminal title and notification fire as for any approval (`ampi-tui`) |
| Web GUI | Shows its approval note while a dialog is open; you answer in the terminal (`ampi-gui`) |

## Configuration

Turn it on with ampi's defaults only:

```json
{ "ampi": { "permissions": [] } }
```

Add your own rules; they come before the defaults:

```json
{
  "ampi": {
    "permissions": [
      { "tool": "bash", "matches": { "command": "git push*" }, "action": "ask" },
      { "tool": "bash", "matches": { "command": "rm -rf *" }, "action": "reject", "message": "Use the clean script instead." },
      { "tool": "bash", "matches": { "command": "/^docker (ps|images)\\b/" }, "action": "allow" },
      { "tool": "mcp__*", "action": "allow" }
    ]
  }
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `ampi.permissions` | unset | List of rules; present turns the gate on |
| `ampi.dangerouslyAllowAll` | unset | `true` (user settings only) lets every call run without asking; `false` turns the gate on |
| `ampi.guardedFiles.allowlist` | unset | User settings only: globs and exact `{ "path": ... }` entries guarded files may change without asking; present turns the gate on |

### Rules

A rule is an object:

| Field | Required | Meaning |
| --- | --- | --- |
| `tool` | yes | Glob over the tool name (`bash`, `mcp__*`) |
| `matches` | no | Input field name to pattern; every named field must match |
| `action` | yes | `allow`, `reject`, `ask` or `delegate` |
| `context` | no | `thread` (the main session) or `subagent`; without it the rule applies everywhere |
| `to` | `delegate` only | The program and its arguments that decide the call (see [Delegate programs](#delegate-programs)); user rules only |
| `message` | `reject` only | The reason the agent sees when the rule rejects a call |

Patterns:

- A string is a glob over the whole value: `*` matches any run of characters, slashes and spaces included; `?` matches one character; everything else is literal.
- A string written `/source/flags` is a JavaScript regular expression. It is searched, so it is anchored only where it says `^` or `$`. A pattern that starts with `/` and ends with `/` and optional flags is always read as a regular expression, so write a path ending in `/` as a glob with `*`.
- A list matches when any entry matches.
- An object matches an object field whose named fields all match, recursively.
- `true`, `false`, numbers and `null` compare strictly.
- A field the input does not have never matches.

Rules are shown in one line, as in warnings and block reasons: `<action> <tool> --<field> <pattern>...`, for example `ask bash --command 'git push*'`.

Settings are read when a session starts and again after the dialog writes them.

## Behavior

### Evaluation order

1. `ampi.dangerouslyAllowAll: true` in the user settings, or "Allow All for This Session", allows every call, guarded files included.
2. A `reject` from the rules blocks the call, before any delegate program runs and without asking about guarded files.
3. A call that changes a guarded file the allowlist does not cover opens the guarded file dialog, even when a rule allows it (see [Guarded files](#guarded-files)).
4. Otherwise the first matching rule decides, in this order: the trusted project's rules, the user's rules, ampi's defaults. A yes in the guarded file dialog stands in for an `ask`, so a call shows one dialog at most; a delegate program that rejects still blocks.
5. No matching rule allows the call.

`allow` lets the call run. `reject` blocks it with the rule's `message`, or a reason that quotes the rule. `ask` opens the dialog. `delegate` runs the rule's program, whose exit code allows, rejects or asks.

### Shell commands

For `bash` and `shell_command`, the `command` is split into simple commands at `;`, `&&`, `||`, `|`, `&` and newlines, and each part is checked on its own, with `command` replaced by that part's text:

- Any rejected part rejects the whole line, with that rule's reason, and no delegate program runs.
- Otherwise each part a `delegate` rule decides runs that rule's program once, with `command` set to the part's text, in line order. The first program that rejects rejects the line, and the later ones do not run.
- The line runs without asking only when every part is allowed, by a rule or by its program; otherwise it asks.
- A part with a subshell, `$(...)` or backticks asks unless a rule rejects it, because ampi does not look inside them.
- A line ampi cannot split (heredocs, comments, unbalanced quotes) asks unless a rule rejects the whole line.

`powershell` commands are never split; rules match the whole command.

### ampi's defaults

The defaults only cover shell commands. A part is allowed when it starts with:

- a command that reads or inspects: `cd`, `ls`, `pwd`, `echo`, `cat`, `head`, `tail`, `wc`, `file`, `stat`, `which`, `date`, `uname`, `whoami`, `tree`, `du`, `df`, `sort`, `uniq` (with at most one file), `cut`, `rg`, `grep`, and `find`;
- read-only git: `status`, `diff`, `log`, `show`, `rev-parse`, `ls-files`, `grep`, `blame`, `branch` with listing flags only, `remote` and `remote -v`; read-only jj: `status`, `diff`, `log`, `show`, `root`, `file list`;
- tests, linters, type checks and builds: `npm test` and `npm run test*`, `lint*`, `check*`, `typecheck*` or `build*` (also with `pnpm`, `yarn` and `bun`), `node --test`, `tsc`, `biome check`/`lint`, `eslint`, `prettier --check`, `pytest`, `go test`/`vet`/`build`, `cargo test`/`build`/`check`/`clippy` and `cargo fmt --check`, `make -n`, `mvn test`/`verify`, `gradle test`, `dotnet test`/`build`.

These still ask: a part that writes output into a file (`>`, `>>`, `&>`, `2>` aimed anywhere but `/dev/null`; `2>&1` is fine), `find` with `-exec`, `-execdir`, `-ok`, `-delete` or `-fprint`, git options that write files or start other programs (`--output`, `-O`), `sort -o` and `sort --compress-program`, `tree -o`, `rg --pre`, `file -C`, `date -s`, linters and formatters told to `--fix` or `--write` (`prettier -w` too), and `eslint -o` or `--output-file`. Any other package script, `env`, `xargs`, `time`, `nice` and `timeout` wrappers, and leading `VAR=value` assignments ask too. Every other `bash`, `shell_command` and `powershell` call asks. Other tools have no default rule, so they run, unless they change a guarded file.

The defaults read each part twice: as written, and with its quotes and escapes removed, so `find . '-delete'` and `find . -de\lete` ask like `find . -delete`. A part whose words a variable (`$X`, `${X:-y}`), `$'...'` quoting or a brace expansion such as `{a,b}` could change when the shell runs it asks too, because ampi cannot read what it will run. Your own rules match the part as written.

### Project settings only tighten

A trusted project's `reject` and `ask` rules apply ahead of yours. Its `allow` and `delegate` rules and an `ampi.dangerouslyAllowAll: true` are ignored, with a warning. An untrusted project's settings are not read at all.

### The dialog

- One dialog at a time; calls that need approval meanwhile wait their turn, and an "Allow All" answer lets them through.
- **Allow Once** runs this call.
- **Reject with feedback** asks what the agent should do instead and blocks the call with your words; empty feedback is a plain rejection.
- **Allow All for This Session** runs every call until you start, resume or fork another session. `/reload` keeps it.
- **Allow All for Every Session** saves `ampi.dangerouslyAllowAll: true` in the user settings, keeping every other key, and allows this session. If the file cannot be written (a symbolic link, invalid JSON, no permission), ampi says so, names the file and allows this session only.
- Closing the dialog, or interrupting the turn, blocks the call.

### Guarded files

Some places hold keys, credentials or settings that later sessions load as code or instructions. A change there always asks, through its own dialog, even when a rule allows the tool.

What is checked:

| Tool | Field | Resolved as |
| --- | --- | --- |
| `edit`, `write` | `path` | Pi does: a leading `@` dropped, `~` expanded, `file://` URLs, Unicode spaces |
| `apply_patch` | `patchText` | Every added, updated and deleted path, a move's source and target both |
| `painter` | `output_path`, when given | Relative to the working directory |

Paths are relative to the session's working directory. Other tools, MCP tools included, and an input whose field is missing or not a string are not checked.

The categories, checked in this order (the first match names the path):

| Category | Paths |
| --- | --- |
| SSH keys and settings | `~/.ssh` and everything under it |
| GnuPG keys | `~/.gnupg` and everything under it |
| Environment file | Any `.env` or `.env.<name>`; not `.env.example`, `.env.sample` or `.envrc` |
| Cloud or cluster credentials | `~/.aws/**`, `~/.kube/**`, `~/.docker/config.json`, `~/.netrc` |
| Git internals | Anything in a `.git` directory, and a `.git` file |
| Agent configuration | Pi's agent directory, any `.pi/**`, `~/.claude/**`, `~/.codex/**` |
| Database file | Names ending in `.db`, `.sqlite` or `.sqlite3` |
| Configuration in the home directory | `~/.<name>` (`~/.bashrc`, `~/.npmrc`), `~/.config/**`, `~/Library/**` on macOS |
| System directory | See below |
| Link that cannot be followed | A symbolic link in a loop, more than 40 links to follow for one path, or a link whose folder cannot be resolved |

System directories are `/etc`, `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/boot`, `/var` and `/opt`; on macOS also `/private/etc`, `/private/var`, `/System`, `/Library` and `/Applications`; on Windows the Windows directory, both Program Files directories and AppData (`APPDATA`, `LOCALAPPDATA`, `~\AppData`). Two places inside them do not ask, for that category only:

- The temp directory, so temporary files (under `/var/folders` on macOS, `AppData\Local\Temp` on Windows) do not ask on every write.
- The session's working directory, so a project in `/var/www/site` or `/opt/app` is edited as usual. Its `.env`, `.git` and `.pi` still ask through their own categories. A working directory that is a filesystem root or a system directory itself, or that holds one, exempts nothing.

Each path is checked as written (made absolute) and with its symbolic links followed; either one being guarded makes it guarded, so a link into `~/.ssh` asks, and so does `/etc` reached as `/private/etc`. A link whose target does not exist yet is followed too, because a write through it creates that target: a `notes.txt` that links to `.git/hooks/pre-commit` asks as Git internals. Its target is followed one name at a time, as the system does, so a `..` after a link leaves the folder that link leads to: with `d` linking to `.git/hooks`, a link to `d/../hooks/pre-commit` asks as Git internals too. On macOS and Windows names compare case-insensitively, and on Windows a `\\?\`, `\\.\` or `\\?\UNC\` prefix names the same path as one without it.

The dialog lists the tool and each guarded path with its category; a patch that touches several guarded paths asks once for all of them:

- **Allow Once** runs this call (a delegate program still has its say).
- **Always Allow This Path** adds each listed path to `ampi.guardedFiles.allowlist` in the user settings as an exact `{ "path": ... }` entry, keeping every other key and entry, and runs the call. For a path reached through a link it saves the link's target as well. If the file cannot be written, ampi says so and allows this call only.
- **Reject**, closing the dialog, and interrupting the turn block the call with a reason that names each path and its category.

`ampi.guardedFiles.allowlist` is read from the user settings only and takes two kinds of entry, both absolute, with `~/` at the start standing for the home directory:

- A string is a glob: `*` within one folder name, `**` across folders, `?`, `{a,b}`, `[a-z]`. A literal `?`, `*`, `[` or `{` cannot be escaped in it.
- `{ "path": "..." }` is one exact path, compared only for equality, so those characters in it are plain characters. "Always Allow This Path" saves this kind.

A path passes when every guarded form of it (as written, and with links followed) matches an entry. On Windows entries may use `/` or `\`, and on macOS and Windows they compare case-insensitively. An entry of neither kind, not absolute, or not a valid glob is skipped with a warning. A broad glob turns the guard off for everything under it: `~/**` lets every guarded file in the home directory, keys and `.env` files included, change without asking. A project's `ampi.guardedFiles` is ignored with a warning.

```json
{ "ampi": { "guardedFiles": { "allowlist": ["~/work/app/.pi/**", { "path": "~/work/app/.env" }] } } }
```

Shell commands are not checked: the files a `bash`, `shell_command` or `powershell` command writes are not known before it runs. ampi's defaults ask about commands that write to a file, and your own rules can go further, for example `{ "tool": "bash", "matches": { "command": "*.env*" }, "action": "reject" }`.

Hard links are not detected either. A second name made with `ln` (without `-s`) is an ordinary file, and nothing on disk says which other names it has, so a guarded file reached through a hard link outside the guarded places does not ask. Git cannot check one out, so such a link has to be made on the machine, for example by a shell command, which the rules decide on. Guarding every file with more than one name would ask on routine edits wherever a package manager links files from its store.

### Runs without a UI

In print and JSON runs nothing can ask, so a call that needs approval is blocked with a reason that says so and names the rule. Add an `allow` rule for calls such runs should make. A change to a guarded file is blocked the same way, with a reason that names the path and its category; add the path to `ampi.guardedFiles.allowlist` for such runs. Delegate programs run as in any session; one that asks ends in the same reason.

### Delegate programs

A `delegate` rule's `to` names a program and its arguments, split into words as a shell would split a simple command:

```json
{ "tool": "bash", "matches": { "command": "git *" }, "action": "delegate", "to": "node ~/bin/approve.mjs --strict" }
```

- `to` is one program, never a shell line: operators (`|`, `&&`, `;`), redirections, subshells, `$(...)`, backticks, variables and brace expansions make the rule invalid, and it is skipped with a warning at session start. Quotes work as in a shell.
- A leading `~` or `~/` in any word expands to your home directory. A first word with a `/` is a path, relative to the session's working directory; a bare name is the first executable file of that name in an absolute `PATH` directory (relative entries are skipped).
- Keep the program and any script it runs outside the project, for example under `~/bin`, and name them by an absolute or `~` path: the agent may be able to change files in the working directory.
- The program starts without a shell, in the session's working directory, with the environment Pi runs with. It reads one line of JSON on stdin, then end of input: `{ "tool": ..., "input": ..., "context": "thread" | "subagent", "cwd": ... }`. For a shell line, `input.command` is the one part the rule matched.
- Exit `0` allows the call. Exit `1` rejects it: the first non-empty line of stdout, or of stderr when stdout has none, is the reason the agent sees (control and format characters, bidi controls among them, removed; at most 500 characters). Exit `2` asks, as an `ask` rule does.
- Any other exit code, a crash, a program that cannot be found or started, and one that takes longer than 10 seconds also ask, and the session shows one warning per program that says what went wrong.
- On a timeout, or when you interrupt the turn, ampi kills the program and the processes it started (its process group, where the platform has one). An interrupted turn blocks the call. ampi keeps the first 64 KiB of stdout and of stderr and reads and drops the rest, so a talkative program never stalls.
- Only your user rules delegate: a project's `delegate` rules are ignored with a warning, so a project cannot run a program of its choosing. A program's answer opens no dialog and sets no approval status; only a dialog that opens does.

An example program, `~/bin/echo-only.mjs`, that lets `echo ok` run and rejects every other command:

```js
let text = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (text += chunk));
process.stdin.on("end", () => {
  const call = JSON.parse(text);
  if (call.input.command === "echo ok") process.exit(0);
  console.log(`Only echo ok may run here, not: ${call.input.command}`);
  process.exit(1);
});
```

### Subagents

Subagent children evaluate the same settings as the main session, with `context: "subagent"`: a rule with `context: "subagent"` applies only there, one with `context: "thread"` only in the main session, and one without `context` in both.

- A child never opens a dialog. A call that would ask, by a rule, ampi's defaults or a delegate program, is blocked with a reason that says the user has to approve it, that a subagent cannot ask, and that the call has to run in the main session or be allowed by a rule in `ampi.permissions`. A change to a guarded file is blocked likewise, pointing at `ampi.guardedFiles.allowlist`. The child reports that to the agent that started it.
- `Task` children load the gate through their extension list; `reviewer` and custom subagents load every extension, so they have it too. `finder`, `oracle` and `librarian` have no shell or edit tools and run without it.
`finder`, `oracle`, `librarian` and `view_media` have no shell or edit tools and run without it.
- A child takes two answers from the session that starts it. When you allowed all for that session, every call in the child runs too. When that session reads the project's rules, so does the child, even if the child, in print or JSON mode, decides project trust differently; project rules only tighten, so that is safe. A child passes both answers on to the subagents it starts.
- A child takes these answers when it starts: allowing all in the main session later does not reach a child that is already running.

## Diagnostics and troubleshooting

- **Nothing ever asks.** `/ampi-status` shows `Permissions: disabled`: set `ampi.permissions`. A project setting counts only when Pi trusts the project.
- **Every call asks.** `ampi.permissions` is not a list; the session-start warning names the file.
- **A rule has no effect.** An invalid rule is skipped with a warning at session start that says what is wrong. An earlier rule may match first: project rules, then yours, then the defaults.
- **A harmless command asks.** It writes to a file, runs a subshell, uses a variable or brace expansion, or is not on the default list. Add an `allow` rule for it.
- **A delegate rule asks every time.** The program failed; the warning at its first call says how (`exited with code 3`, `timed out after 10 s`, `was not found on PATH`). Run it by hand with a JSON line on stdin to check it.
- **An edit asks with `Guarded File Modification` although a rule allows it.** The path is in a guarded place; the dialog names its category. Answer "Always Allow This Path", or add the path or a glob to `ampi.guardedFiles.allowlist` in the user settings.
- **A subagent says a call needs approval.** Children cannot ask. Run the call in the main session, add an `allow` rule (with `context: "subagent"` to limit it to children), or allow all for the session before starting the subagent.

## Public API

Stable re-exports from `ampi`, each with its `Ampi*` alias:

- Extension: `createMmrPermissionsExtension`, `loadMmrPermissionsSettings`, `formatMmrPermissionsNoUiReason`, and the `MmrPermissionsSettings` / `MmrPermissionsFactoryOverrides` / `LoadMmrPermissionsSettingsOptions` types.
- Rule engine (ampi-core): `evaluateMmrPermission`, `matchesMmrPermissionRule`, `validateMmrPermissionRule`, `parseMmrPermissionRules`, `formatMmrPermissionRule`, `splitMmrShellCommand`, `MMR_PERMISSIONS_DEFAULT_RULES`, `MMR_PERMISSIONS_SHELL_TOOLS`, the session override `setMmrPermissionsSessionAllowAll` / `isMmrPermissionsSessionAllowAll`, and the approval event `MMR_EVENT_APPROVAL` with `onMmrApproval`.

Canonical catalog: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## Developer notes

- `index.ts` loads settings at `session_start`, registers the feature-gate provider and the `tool_call` gate, and runs the dialog queue; `config.ts` reads the settings files; `gate.ts` holds the dialog words and block reasons (a public-safety lint surface).
- `delegate.ts` resolves and runs delegate programs (timeout, output limits, process-group kill); the gate passes it an injectable timer and spawn for tests (`delegateTimer`, `delegateSpawn`, `delegateTimeoutMs`).
- The rule engine and the defaults live in ampi-core (`permissions.ts`, `permission-defaults.ts`) so workers can evaluate rules without importing this extension. The engine never starts a process: for a shell line it reports each part's decision in `parts`, and the gate runs the programs. The session override and the project-trust answer are on process globals for the same reason; the worker runner writes them into a child's environment as `AMPI_PERMISSIONS_ALLOW_ALL=1` and `AMPI_PERMISSIONS_PROJECT_RULES=1` and removes each when its answer does not hold. Only a child reads them.
- The gate emits `mmr-core:approval` (`phase: "request"` when a call starts waiting, `"answer"` when it is decided); `ampi-tui`'s status feed and `ampi-gui`'s bridge turn them into the `waitingApproval` phase.
- Settings files are read following symbolic links, as Pi does; the write refuses a symbolic link, as every ampi settings writer does.
- Guarded files are classified in ampi-core (`guarded-files.ts`): which paths a call changes, how each tool resolves them, the categories, the realpath and case checks, the exemptions and the allowlist. Unlike the rule engine it reads the filesystem (`realpath`); everything it reads from the machine can be injected, so the macOS and Windows rules are tested on Linux. `tool-activity.ts`'s `patchTextPaths` reads the patch paths. Shell commands that write files are matched only by rules, so a command ampi does not know can still write anywhere once allowed.
- Tests: `tests/mmr-permissions-rules.test.mjs` (matching, validation, evaluation, shell splitting, defaults), `tests/mmr-permissions-gate.test.mjs` (settings, trust, the dialog, no-UI runs, approval status), `tests/mmr-permissions-delegate.test.mjs` (delegate programs: exit codes, input, lookup, limits, shell lines, project rules), `tests/mmr-permissions-subagents.test.mjs` (contexts, child refusals, the environment signals, the runner, which children load the gate) and `tests/mmr-permissions-guarded.test.mjs` (the categories on Linux, macOS and Windows, symlinks, the patch paths, the guarded file dialog, the allowlist, and how guarded files combine with rules, runs without UI and subagents).
