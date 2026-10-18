# ampi-shell

Background shell commands for the model: `shell_command` runs a command that may take long or never ends, leaves it running once a short wait is over, and `shell_command_status` and `shell_command_kill` follow and stop it.

Package overview: [`../../../README.md`](../../../README.md). Planning: [`../../../ROADMAP.md`](../../../ROADMAP.md). Public API: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## At a glance

| Default | Provides | Requires | Diagnostics |
| --- | --- | --- | --- |
| On | `shell_command`, `shell_command_status`, `shell_command_kill` | Linux or macOS | `/ampi-status`, tool result `details` |

## When to use it

- A dev server, file watcher or log tail has to keep running while the agent works.
- A build or test suite may run longer than the agent should block on one tool call.
- Pi's `bash` stays the tool for quick commands; the guidelines tell the model which to pick.

## Status and enablement

Default: on. `ampi-shell` loads from `package.json` `pi.extensions` and registers its three tools as ampi-owned: the `low`, `medium`, `high` and `ultra` modes allow them, and Free mode drops them like every ampi-owned tool. `ampiShell.enabled: false` or `AMPI_SHELL_ENABLE=0` turns it off; `/ampi-status` then lists the tools as `disabled`. It owns no feature gate.

The tool names are Amp-compatible, so prompts and skills written for those names keep working. Linux and macOS are the supported platforms: on Windows a command has no process group of its own, so stopping it reaches only its shell, not the processes the shell started.

## Tools / commands / surfaces

| Tool | Parameters | Purpose |
| --- | --- | --- |
| `shell_command` | `command`, `workdir?`, `timeout_ms?` | Run a command; return its result, or leave it running and return its pid |
| `shell_command_status` | `pid`, `timeout_ms?` (0 to 60000, default 10000) | Wait for a command and read its new output |
| `shell_command_kill` | `pid` | Stop a command and read its last output |

With `ampi-tui`, each call is one transcript row in the style of a `bash` row ("Ran npm run dev (still running as pid 4242)", "Checked pid 4242, still running", "Stopped pid 4242 (SIGTERM)"); expanding tool output shows what the command printed. A group summary counts the three tools as commands.

## Configuration

Two settings tune the waiting and the limit; neither is a secret.

```json
{ "ampiShell": { "backgroundAfterMs": 30000, "maxBackground": 8 } }
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `ampiShell.enabled` | `true` | Load the extension |
| `ampiShell.backgroundAfterMs` | `30000` | How long `shell_command` waits before leaving a command in the background; `0` backgrounds at once |
| `ampiShell.maxBackground` | `8` | Commands that may run at once per session |

The nested form `ampi.shell.*` works too. Settings come from `~/.pi/agent/settings.json`, then `<cwd>/.pi/settings.json`; `AMPI_SHELL_ENABLE` (legacy `MMR_SHELL_ENABLE`) overrides `enabled`. Values of the wrong type are ignored. Pi's own `shellPath` and `shellCommandPrefix` settings apply as they do for `bash`, read when each command starts.

Settings are sampled once at extension load. Restart Pi after changing them.

## Behavior

### Running a command

- The command runs in Pi's shell (`shellPath` when set), with `shellCommandPrefix` on the line before it, in a new process group.
- `workdir` is resolved against the session's working directory and must be an existing directory; otherwise the call fails and names the path.
- The environment is Pi's process environment plus `PI_SESSION_ID`, `PI_SESSION_FILE` (only when the session has a file), `PI_PROVIDER`, `PI_MODEL` and `PI_REASONING_LEVEL`, as for `bash`.
- `shell_command` waits up to `backgroundAfterMs`, streaming output as it arrives. A command that ended in time returns the tail of its output; a non-zero exit, a timeout or a signal makes the result an error that names it, as `bash` does.
- A command still running keeps running in the background. The result says so and gives its pid and the output so far; `details` holds `{ pid, running: true, startedAt }`.
- Aborting the turn while `shell_command` waits kills the command's process group. A command already in the background is not touched by later aborts.

### Following and stopping

- `shell_command_status` waits up to `timeout_ms` for the command to end, streaming new output while it waits, then returns the output since the last read of that pid (by `shell_command` or `shell_command_status`), whether it still runs, and its exit code once it ended. `timeout_ms: 0` answers at once.
- `shell_command_kill` sends SIGTERM to the process group, SIGKILL one second later if it still runs, waits up to two seconds for the end, and returns the unread output and final state.
- `timeout_ms` on `shell_command` is a wall-clock limit for the whole command, enforced in the background too: the process group is stopped the same way, and the next status read reports the timeout.

### Output and limits

- Results show the last 2000 lines or 50 KB of output. When that cuts output, the full text goes to a temp file (`<tmpdir>/ampi-shell-<pid>-<random>.log`) and the result names it.
- Each command keeps at most 1 MiB of unread output. Older output is dropped, and the next read starts with one line that says how many bytes were dropped.
- At most `maxBackground` commands run at once; another start fails and lists the running pids.
- An ended command stays listed until its last output was read once; after that its pid is unknown.
- Only pids this session started can be followed or stopped. An unknown pid is an error that lists the known ones.

### Session end

On quit, reload, a new, resumed or forked session, every running command's process group gets SIGTERM, then SIGKILL after one second, so nothing it started outlives the session. If Pi exits without that shutdown, a last-resort exit hook sends SIGKILL to the groups still running.

## Diagnostics and troubleshooting

- **The model never uses `shell_command`.** The extension is off, or the mode does not allow it. `/ampi-status` shows the tools as `active`, `disabled` or `deferred`.
- **"commands are already running (the limit is N)".** Stop or wait for one of the listed pids, or raise `ampiShell.maxBackground`.
- **"Unknown pid".** The command's last output was already read after it ended, or another session started it.
- **A stopped command left processes behind.** A process that moved itself to another process group (for example a daemon that calls `setsid`) is out of reach; on Windows only the shell is stopped.

## Public API

Stable re-exports from `ampi`: `createMmrShellExtension`, `loadMmrShellSettings` and the `MmrShellSettings` / `MmrShellFactoryOverrides` types, each with its `Ampi*` alias. Canonical catalog: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## Developer notes

- `index.ts` registers the tools, the `ampi-shell` tool provider and the `session_shutdown` hook; `config.ts` loads settings; `tools.ts` holds the tool definitions and their descriptions (a public-safety lint surface); `processes.ts` holds the per-session process registry.
- Tests: `tests/mmr-shell-tools.test.mjs` runs real commands that block on FIFOs the test writes to, so no test waits on a clock; `registryOptions.killGraceMs` shortens the SIGTERM grace. Transcript rows: `tests/mmr-tui-activity.test.mjs` and the `mmr-tui-tool-rows` fixtures.
- `ampi-core/tool-activity.ts` and `ampi-tui/transcript/tool-renderers.ts` treat `shell_command` like `bash`; status and kill rows read their state from the result `details`.
