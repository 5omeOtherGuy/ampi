# ampi-threads

Manages threads on top of Pi sessions: an index of per-session metadata (archived, labels, colour, pinned, title source), Amp-compatible commands to start, archive and unarchive sessions, and the prompt history behind Ctrl+R.

Package overview: [`../../../README.md`](../../../README.md). Planning: [`../../../ROADMAP.md`](../../../ROADMAP.md). Public API: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## At a glance

| Default | Provides | Requires | Diagnostics |
| --- | --- | --- | --- |
| On | `thread.new`, `thread.archive`, `thread.unarchive`, `thread.archiveAndQuit`; Ctrl+C Ctrl+N and Ctrl+C Ctrl+E; the thread index; the prompt history | none (`ampi-tui` for the keys, palette and prompt history picker) | `<agentDir>/data/ampi/threads/index.json` and `history/`; the Ctrl+C popup; Ctrl+R |

## When to use it

- You want to put a finished session away: Ctrl+C Ctrl+N archives it and starts a new one, Ctrl+C Ctrl+E archives it and quits.
- You want Pi to archive every session you quit (`ampiThreads.autoArchiveOnQuit`).
- You want a prompt you sent before, in this workspace or another: Ctrl+R lists them and puts the one you pick back into the prompt.
- You are building on per-session metadata (thread pickers, labels, colours): read and update it through `getMmrThreadIndex()` in `ampi-core`.

## Status and enablement

Default: on. `ampi-threads` is registered in `package.json` `pi.extensions` and loads without opt-in config. Opt out with `ampiThreads.enabled: false` (see [Configuration](#configuration)).

It owns no model-visible tools or feature gates. The index store works in every run mode. The commands go into `ampi-core`'s command registry, where `ampi-tui` shows them in the command palette and binds their keys; without `ampi-tui` they are registered but nothing displays them.

## Tools / commands / surfaces

| Surface | Type | Purpose |
| --- | --- | --- |
| `thread.new` | Command, no key | Start a new session, as Pi's `/new` does |
| `thread.archive` | Command, `ctrl+c ctrl+n` | Archive this session and start a new one |
| `thread.unarchive` | Command, no key | Take this session out of the archive |
| `thread.archiveAndQuit` | Command, `ctrl+c ctrl+e` | Archive this session and quit |
| `/ampi-thread new`, `/ampi-thread archive` | Slash command | The route the session-replacing commands take; you can type it too |
| Thread index | File | `<agentDir>/data/ampi/threads/index.json` |
| Prompt history | Files | `<agentDir>/data/ampi/threads/history/<workspace key>.jsonl`, read by `ampi-tui`'s `prompt.history` (Ctrl+R) |

The palette lists the commands as `thread new`, `thread archive and new`, `thread unarchive` and `thread archive and quit`.

## Configuration

Two switches; neither is a secret.

```json
{ "ampiThreads": { "enabled": true, "autoArchiveOnQuit": true } }
```

- `enabled` (default `true`): `false` registers nothing.
- `autoArchiveOnQuit` (default `false`): archive the session whenever you quit Pi from the terminal, whichever way you quit (Ctrl+C Ctrl+C, `/quit`, Ctrl+D).

The nested form `{ "ampi": { "threads": { … } } }` is accepted too. Settings are read from `~/.pi/agent/settings.json` and then `<project>/.pi/settings.json`; the project file wins for each key it sets. An environment variable overrides `enabled`:

| Variable | Effect |
| --- | --- |
| `AMPI_THREADS_ENABLE` | `false` turns the extension off, `true` turns it on |
| `MMR_THREADS_ENABLE` | Legacy name, read when `AMPI_THREADS_ENABLE` is unset |

The settings are read once when the extension loads. Restart Pi or run `/reload` after changing them. Rebind the keys under `ampi.keymap` (see [`ampi-tui`](../ampi-tui/README.md#keymap)).

## Behavior

### Archiving

- Archiving records the date in the thread index. The session file is not touched, and `/resume` still lists the session.
- Only a session with messages can be archived: in a new, empty session the archive commands are hidden, and the Ctrl+C popup shows only Quit.
- In an archived session (one you resumed), `thread archive and new` and `thread archive and quit` are unavailable with the reason "this session is already archived"; `thread unarchive` is available. Elsewhere `thread unarchive` is unavailable: "this session is not archived".
- `thread archive and new` starts the new session through Pi's own `newSession`, which first stops a running turn. A notice in the new session confirms the archive.
- `thread archive and quit` archives the session, then quits the way `ampi.quit` (Ctrl+C Ctrl+C) does. Without `ampi-tui` it stops a running turn and shuts Pi down itself.
- With `autoArchiveOnQuit`, quitting an interactive session archives it. Switching sessions, `/reload`, and print, JSON or RPC runs (subagent workers included) never archive. An archive date that is already set is kept.

### The thread index

One file per Pi agent directory, `<agentDir>/data/ampi/threads/index.json` (`~/.pi/agent` by default, or `PI_CODING_AGENT_DIR`), following [`docs/data-storage-conventions.md`](../../../docs/data-storage-conventions.md):

```json
{ "version": 1, "threads": { "<session id>": { "archived": "2026-10-18T10:00:00.000Z", "labels": ["bug-fix"], "color": "blue", "pinned": true, "titleSource": "user" } } }
```

- Every field is optional; a session without any has no entry.
- Labels: at most 20 per session, each 1 to 32 lowercase letters, digits or hyphens. Repeated labels are stored once.
- Colours: `blue`, `purple`, `pink`, `red`, `orange`, `yellow`, `green`, `cyan`, `gray`, or `#rrggbb`.
- `titleSource` is `model` or `user`.
- Writes go to a temp file that is renamed over the index, so a crash never leaves half a file.
- A file that is not a valid index is moved aside to `index.json.<random>.corrupt` and never overwritten. ampi warns once and starts with an empty index.
- A file with a newer `version` is left alone; every change fails until ampi is updated.
- Within one Pi process, operations on the index run one at a time. Across processes the last writer wins: each change reads the file afresh, so only two changes landing at the same moment can lose one.

### Prompt history

Every prompt you type into the terminal prompt and send is recorded for its working directory; `ampi-tui` shows them on Ctrl+R (see [its README](../ampi-tui/README.md#prompt-history)).

- Recorded: what you type and send in the interactive terminal, also while a turn runs. Not recorded: slash commands and prompt templates (text starting with `/`), prompts sent by extensions or RPC clients, and print or JSON runs.
- A prompt identical to the one before it in the same workspace is recorded once.
- One file per working directory, `<agentDir>/data/ampi/threads/history/<workspace key>.jsonl`, where the key is the first 32 hex digits of the SHA-256 of the absolute path, so file names carry no paths. Each line is one prompt, oldest first: `{ "v": 1, "ts": "2026-10-18T10:00:00.000Z", "text": "Rename the parser module" }`, where `v` is the line's format version. The files are readable only by you.
- A workspace keeps its newest 1000 prompts. The file grows by appending until it holds 1200 prompts; the next prompt rewrites it with the newest 1000, through a temp file renamed over it.
- Only lines of version 1 are read. A line of another version, written by a different ampi version using the same agent directory, is skipped when reading and kept as it is when the file is rewritten. A line that cannot be read at all, such as one cut off by a crash, is skipped and dropped at the next rewrite.
- "All workspaces" reads every history file and merges the prompts by time.
- Within one Pi process, operations on a file run one at a time. Several Pi processes can append to one file safely; a rewrite racing an append from another process can lose that one prompt.
- Recording does not hold up the prompt. If a file cannot be written, a warning says so and the prompt is sent as usual.
- To forget the history, delete the files; turning `ampi-threads` off stops recording and makes Ctrl+R unavailable.

## Diagnostics and troubleshooting

- **Ctrl+C shows only Quit.** The session has no messages yet, `ampi-threads` is off (`ampiThreads.enabled: false` or `AMPI_THREADS_ENABLE=false`), or the keys were rebound under `ampi.keymap`.
- **"thread archive and new is not available: this session is already archived".** The session was archived before; run `thread unarchive` from the palette to take it out.
- **A warning says the thread index could not be read.** The file was not a valid index. It was moved to the `.corrupt` name in the warning; inspect it by hand and copy back any entries you need.
- **Archiving fails with "written by a newer ampi".** Another ampi version on this machine uses a newer index format. Update ampi.
- **Ctrl+R does nothing.** `ampi-threads` is off, and the picker needs it. The palette lists the command as "history (unavailable)" and, when you select it, gives the reason "ampi-threads is not loaded".
- **A prompt is missing from Ctrl+R.** It started with `/`, was sent by an extension, repeated the prompt before it, or was sent in another working directory: press Alt+W to show every workspace.

## Public API

Stable re-exports from `ampi`: `createMmrThreadsExtension`, `loadMmrThreadsSettings` and the `MmrThreadsSettings` / `MmrThreadsFactoryOverrides` types. The store (`createMmrThreadIndexStore`, `validateMmrThreadLabels`, `resolveDefaultMmrThreadIndexDir`, `MmrThreadIndexError`) is exported in the Internal tier. Each name has its `Ampi*` alias. Canonical catalog: [`../../../docs/public-api.md`](../../../docs/public-api.md). The read API other extensions use (`getMmrThreadIndex`, `filterMmrSessionsByArchived`) lives in `ampi-core`: [`../../../docs/ampi-core-api.md`](../../../docs/ampi-core-api.md#thread-index).

## Developer notes

- Manifest: risk class `local-mutation` (it writes the thread index under the agent directory), child role `none`. No subagent child keep-set lists it.
- Layout: `index.ts` (entry point: registers the index, prompt history, commands and slash route at load, records prompts from Pi's `input` event, releases everything at `session_shutdown`), `config.ts` (settings), `index-store.ts` (the store), `history-store.ts` (the prompt history files), `commands.ts` (palette commands and the `/ampi-thread` handler).
- The prompt history picker lives in `ampi-tui`, which may not import this extension. `ampi-threads` registers its history store in `ampi-core/prompt-history.ts` (`registerMmrPromptHistory`), and the picker reads it from there (`getMmrPromptHistory`). The store queues on the same per-path lock as the index store.
- Only a command handler gets Pi's `newSession`. The palette commands that replace the session therefore send `/ampi-thread …` with `pi.sendUserMessage(…, { expandPromptTemplates: true })`, which Pi runs as an extension command at once, even during a turn.
- Command availability is checked synchronously, so it reads the store's last known record (`peek`); `session_start` loads the current session's record.
- Tests: `tests/mmr-threads-index-store.test.mjs` (store, labels, seam), `tests/mmr-threads-history-store.test.mjs` (prompt history files, trimming, workspaces, seam) and `tests/mmr-threads-extension.test.mjs` (commands through the Pi stub, prompt recording, the Ctrl+C popup and Ctrl+R through `ampi-tui`'s dispatcher, settings, load order).
