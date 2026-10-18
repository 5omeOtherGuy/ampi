# ampi-permissions

Asks before risky tool calls: rules in your settings allow, reject or ask about each call, and an approval dialog lets you decide the ones that ask.

Package overview: [`../../../README.md`](../../../README.md). Planning: [`../../../ROADMAP.md`](../../../ROADMAP.md). Public API: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## At a glance

| Default | Provides | Requires | Diagnostics |
| --- | --- | --- | --- |
| Off (inert until configured) | A `tool_call` gate, the approval dialog, ampi's default rules | `ampi.permissions` or `ampi.dangerouslyAllowAll: false` in settings | `/ampi-status` (`Permissions:` line), warnings at session start |

## When to use it

- You want shell commands that change things (`rm`, `git push`, installs, deploys) to wait for your yes, while reads, tests and builds run on their own.
- You want hard rules: never run a command, never touch a path, with a reason the agent sees.
- A project should be able to add restrictions for everyone who trusts it, but never remove yours.

## Status and enablement

Default: off. The extension loads with the package but does nothing until a settings file turns it on:

- `ampi.permissions` is present, with any value (an invalid one included), or
- `ampi.dangerouslyAllowAll` is exactly `false`,

in the user settings (`<agentDir>/settings.json`, normally `~/.pi/agent/settings.json`) or in a project's `.pi/settings.json` that Pi trusts. A project may turn it on, because that only tightens.

The gate applies in every mode, Free included: it is your safety setting, not a mode policy. It also applies to calls another tool makes (codemode scripts, nested calls). Subagent workers are not gated yet; they run as before.

`/ampi-status` shows `Permissions: enabled` with the number of project, user and default rules, or `disabled` with how to turn it on. The feature gate ids are `ampi-permissions` and `mmr-permissions`.

## Tools / commands / surfaces

| Surface | What it does |
| --- | --- |
| `tool_call` gate | Allows, blocks or asks about each tool call |
| Approval dialog | `Approval Required` with the tool and its command, path or fields; options `Allow Once`, `Reject with feedback`, `Allow All for This Session`, `Allow All for Every Session` |
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

### Rules

A rule is an object:

| Field | Required | Meaning |
| --- | --- | --- |
| `tool` | yes | Glob over the tool name (`bash`, `mcp__*`) |
| `matches` | no | Input field name to pattern; every named field must match |
| `action` | yes | `allow`, `reject`, `ask` or `delegate` |
| `context` | no | `thread` (the main session) or `subagent`; without it the rule applies everywhere |
| `to` | `delegate` only | The program a `delegate` rule hands the decision to |
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

1. `ampi.dangerouslyAllowAll: true` in the user settings, or "Allow All for This Session", allows every call.
2. Otherwise the first matching rule decides, in this order: the trusted project's rules, the user's rules, ampi's defaults.
3. No matching rule allows the call.

`allow` lets the call run. `reject` blocks it with the rule's `message`, or a reason that quotes the rule. `ask` opens the dialog. `delegate` asks for now; delegate programs come in a later change.

### Shell commands

For `bash` and `shell_command`, the `command` is split into simple commands at `;`, `&&`, `||`, `|`, `&` and newlines, and each part is checked on its own, with `command` replaced by that part's text:

- Any rejected part rejects the whole line, with that rule's reason.
- The line runs without asking only when every part is allowed; otherwise it asks.
- A part with a subshell, `$(...)` or backticks asks unless a rule rejects it, because ampi does not look inside them.
- A line ampi cannot split (heredocs, comments, unbalanced quotes) asks unless a rule rejects the whole line.

`powershell` commands are never split; rules match the whole command.

### ampi's defaults

The defaults only cover shell commands. A part is allowed when it starts with:

- a command that reads or inspects: `cd`, `ls`, `pwd`, `echo`, `cat`, `head`, `tail`, `wc`, `file`, `stat`, `which`, `date`, `uname`, `whoami`, `tree`, `du`, `df`, `sort`, `uniq` (with at most one file), `cut`, `rg`, `grep`, and `find`;
- read-only git: `status`, `diff`, `log`, `show`, `rev-parse`, `ls-files`, `grep`, `blame`, `branch` with listing flags only, `remote` and `remote -v`; read-only jj: `status`, `diff`, `log`, `show`, `root`, `file list`;
- tests, linters, type checks and builds: `npm test` and `npm run test*`, `lint*`, `check*`, `typecheck*` or `build*` (also with `pnpm`, `yarn` and `bun`), `node --test`, `tsc`, `biome check`/`lint`, `eslint`, `prettier --check`, `pytest`, `go test`/`vet`/`build`, `cargo test`/`build`/`check`/`clippy` and `cargo fmt --check`, `make -n`, `mvn test`/`verify`, `gradle test`, `dotnet test`/`build`.

These still ask: a part that writes output into a file (`>`, `>>`, `&>`, `2>` aimed anywhere but `/dev/null`; `2>&1` is fine), `find` with `-exec`, `-execdir`, `-ok`, `-delete` or `-fprint`, git options that write files or start other programs (`--output`, `-O`), `sort -o` and `sort --compress-program`, `tree -o`, `rg --pre`, `file -C`, `date -s`, and linters told to `--fix` or `--write`. Any other package script, `env`, `xargs`, `time`, `nice` and `timeout` wrappers, and leading `VAR=value` assignments ask too. Every other `bash`, `shell_command` and `powershell` call asks. Other tools have no default rule, so they run.

### Project settings only tighten

A trusted project's `reject` and `ask` rules apply ahead of yours. Its `allow` and `delegate` rules and an `ampi.dangerouslyAllowAll: true` are ignored, with a warning. An untrusted project's settings are not read at all.

### The dialog

- One dialog at a time; calls that need approval meanwhile wait their turn, and an "Allow All" answer lets them through.
- **Allow Once** runs this call.
- **Reject with feedback** asks what the agent should do instead and blocks the call with your words; empty feedback is a plain rejection.
- **Allow All for This Session** runs every call until you start, resume or fork another session. `/reload` keeps it.
- **Allow All for Every Session** saves `ampi.dangerouslyAllowAll: true` in the user settings, keeping every other key, and allows this session. If the file cannot be written (a symbolic link, invalid JSON, no permission), ampi says so, names the file and allows this session only.
- Closing the dialog, or interrupting the turn, blocks the call.

### Runs without a UI

In print and JSON runs nothing can ask, so a call that needs approval is blocked with a reason that says so and names the rule. Add an `allow` rule for calls such runs should make.

## Diagnostics and troubleshooting

- **Nothing ever asks.** `/ampi-status` shows `Permissions: disabled`: set `ampi.permissions`. A project setting counts only when Pi trusts the project.
- **Every call asks.** `ampi.permissions` is not a list; the session-start warning names the file.
- **A rule has no effect.** An invalid rule is skipped with a warning at session start that says what is wrong. An earlier rule may match first: project rules, then yours, then the defaults.
- **A harmless command asks.** It writes to a file, runs a subshell, or is not on the default list. Add an `allow` rule for it.

## Public API

Stable re-exports from `ampi`, each with its `Ampi*` alias:

- Extension: `createMmrPermissionsExtension`, `loadMmrPermissionsSettings`, `formatMmrPermissionsNoUiReason`, and the `MmrPermissionsSettings` / `MmrPermissionsFactoryOverrides` / `LoadMmrPermissionsSettingsOptions` types.
- Rule engine (ampi-core): `evaluateMmrPermission`, `matchesMmrPermissionRule`, `validateMmrPermissionRule`, `parseMmrPermissionRules`, `formatMmrPermissionRule`, `splitMmrShellCommand`, `MMR_PERMISSIONS_DEFAULT_RULES`, `MMR_PERMISSIONS_SHELL_TOOLS`, the session override `setMmrPermissionsSessionAllowAll` / `isMmrPermissionsSessionAllowAll`, and the approval event `MMR_EVENT_APPROVAL` with `onMmrApproval`.

Canonical catalog: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## Developer notes

- `index.ts` loads settings at `session_start`, registers the feature-gate provider and the `tool_call` gate, and runs the dialog queue; `config.ts` reads the settings files; `gate.ts` holds the dialog words and block reasons (a public-safety lint surface).
- The rule engine and the defaults live in ampi-core (`permissions.ts`, `permission-defaults.ts`) so workers can evaluate rules without importing this extension. The session override is on a process global for the same reason.
- The gate emits `mmr-core:approval` (`phase: "request"` when a call starts waiting, `"answer"` when it is decided); `ampi-tui`'s status feed and `ampi-gui`'s bridge turn them into the `waitingApproval` phase.
- Settings files are read following symbolic links, as Pi does; the write refuses a symbolic link, as every ampi settings writer does.
- Not covered yet: delegate programs and subagent workers, and guarded files. Shell commands that write files are matched only by rules, so a command ampi does not know can still write anywhere once allowed.
- Tests: `tests/mmr-permissions-rules.test.mjs` (matching, validation, evaluation, shell splitting, defaults) and `tests/mmr-permissions-gate.test.mjs` (settings, trust, the dialog, no-UI runs, approval status).
