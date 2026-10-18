# ampi-threads

Manages threads on top of Pi sessions: an index of per-session metadata (archived, labels, colour, pinned, title source), Amp-compatible commands to start, rename, archive, unarchive and switch sessions, generated session titles, the prompt history behind Ctrl+R, a session's Markdown export, and the reports on what it cost and what fills its context.

Package overview: [`../../../README.md`](../../../README.md). Planning: [`../../../ROADMAP.md`](../../../ROADMAP.md). Public API: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## At a glance

| Default | Provides | Requires | Diagnostics |
| --- | --- | --- | --- |
| On | `thread.new`, `thread.rename`, `thread.archive`, `thread.unarchive`, `thread.archiveAndQuit`, `thread.switchToPrevious`, `thread.switchToNext`, `thread.copyMarkdown`; Ctrl+C Ctrl+N and Ctrl+C Ctrl+E; generated titles; the thread index; the prompt history; the switch route; the cost and context reports | none (`ampi-tui` for the keys, palette, prompt history, thread pickers and report overlays; `ampi-workers` for generated titles) | `<agentDir>/data/ampi/threads/index.json` and `history/`; the Ctrl+C popup; Ctrl+R; `thread switch`; `thread show cost`; `thread analyze context` |

## When to use it

- You want to put a finished session away: Ctrl+C Ctrl+N archives it and starts a new one, Ctrl+C Ctrl+E archives it and quits.
- You want Pi to archive every session you quit (`ampiThreads.autoArchiveOnQuit`).
- You want a prompt you sent before, in this workspace or another: Ctrl+R lists them and puts the one you pick back into the prompt.
- You want to move between sessions without leaving Pi: `thread switch` in the palette picks one with a preview, and `thread switch to previous` / `to next` go back and forth.
- You want to paste a session somewhere: `thread copy markdown` copies it as Markdown.
- You want to know what a session cost, or what fills its context window: `thread show cost` and `thread analyze context`.
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
| `thread.switchToPrevious` | Command, no key | Go back to the session you last switched away from |
| `thread.switchToNext` | Command, no key | Go forward again after going back |
| `thread.copyMarkdown` | Command, no key | Copy this session to the clipboard as [Markdown](#markdown-export) |
| `thread.rename` | Command, no key | Give this session a new [title](#titles) |
| Generated titles | Event handlers | Name a new session after its first exchange through `ampi-core`'s `title` subagent profile ([Titles](#titles)) |
| Cost and context reports, Markdown export | Seam | `ampi-core/thread-reports.ts`: the numbers behind `ampi-tui`'s `thread show cost` and `thread analyze context`, `showCosts` for its cost gauge, and the Markdown export `ampi-gui`'s Copy as Markdown uses |
| `/ampi-thread new`, `archive`, `switch <session id>`, `previous`, `next` | Slash command | The route the session-replacing commands and `ampi-tui`'s Switch Thread picker take; you can type it too |
| Thread index | File | `<agentDir>/data/ampi/threads/index.json` |
| Prompt history | Files | `<agentDir>/data/ampi/threads/history/<workspace key>.jsonl`, read by `ampi-tui`'s `prompt.history` (Ctrl+R) |

The palette lists the commands as `thread new`, `thread archive and new`, `thread unarchive`, `thread archive and quit`, `thread switch to previous`, `thread switch to next`, `thread copy markdown` and `thread rename`. `thread switch`, which opens the picker, and `thread show cost` and `thread analyze context`, which show the reports, come from `ampi-tui` (see [its README](../ampi-tui/README.md#switch-thread-picker)).

## Configuration

Four switches; none is a secret.

```json
{ "ampiThreads": { "enabled": true, "autoArchiveOnQuit": true, "showCosts": false, "titles": false } }
```

- `enabled` (default `true`): `false` registers nothing.
- `autoArchiveOnQuit` (default `false`): archive the session whenever you quit Pi from the terminal, whichever way you quit (Ctrl+C Ctrl+C, `/quit`, Ctrl+D).
- `showCosts` (default `true`): `false` hides the cost gauge in `ampi-tui`'s prompt box and makes `thread show cost` unavailable.
- `titles` (default `true`): `false` stops [generated titles](#titles); `thread rename` still works.

The nested form `{ "ampi": { "threads": { … } } }` is accepted too. Settings are read from `~/.pi/agent/settings.json` and then `<project>/.pi/settings.json`; the project file wins for each key it sets. An environment variable overrides `enabled`:

| Variable | Effect |
| --- | --- |
| `AMPI_THREADS_ENABLE` | `false` turns the extension off, `true` turns it on |
| `MMR_THREADS_ENABLE` | Legacy name, read when `AMPI_THREADS_ENABLE` is unset |

The settings are read once when the extension loads. Restart Pi or run `/reload` after changing them. Rebind the keys under `ampi.keymap` (see [`ampi-tui`](../ampi-tui/README.md#keymap)).

## Behavior

### Titles

A session's title is its Pi session name: the terminal title, the Switch Thread picker, `/resume` and the [Markdown export](#markdown-export) show it.

- After the first reply of a new interactive session completes, ampi asks a small model for a title of at most six words. The model reads the first prompt and the start of the first reply, each cut to 400 characters, and nothing else: no tools, no thinking, no project files.
- The answer is cut to its first line, six words and 60 characters, without quotes, Markdown or trailing periods, and becomes the session name. The thread index records `titleSource: "model"`.
- No title is generated when the session already has a name, when its title was ever set by you (`titleSource: "user"`), when the first prompt has fewer than three words, or when the first run was aborted before it replied. A session resumed from disk is left alone.
- One attempt per session. When there is no model route, no worker host (`ampi-workers` is off) or the call fails, nothing is shown and the session keeps no name. A name you give while the model answers wins.
- Print, JSON and RPC runs, subagent workers among them, are never titled.
- The call runs on the `title` subagent profile: the routes of the `low` mode, thinking off. Point it at another model with `ampiCore.subagentModelPreferences.title` (see [`ampi-core`](../ampi-core/README.md#subagent-profiles)). Each title costs one small request to that model.

`thread rename` opens an empty input. It passes the placeholder "Thread title", which RPC clients can show; Pi's terminal dialog leaves it out. Enter sets the new title and records `titleSource: "user"`, so generated titles never replace it; Escape or an empty answer keeps the current title. The terminal title follows at once, through Pi's `session_info_changed` event, and the Switch Thread picker shows the new title the next time it opens.

### Archiving

- Archiving records the date in the thread index. The session file is not touched, and `/resume` still lists the session.
- Only a session with messages can be archived: in a new, empty session the archive commands are hidden, and the Ctrl+C popup shows only Quit.
- In an archived session (one you resumed), `thread archive and new` and `thread archive and quit` are unavailable with the reason "this session is already archived"; `thread unarchive` is available. Elsewhere `thread unarchive` is unavailable: "this session is not archived".
- `thread archive and new` starts the new session through Pi's own `newSession`, which first stops a running turn. A notice in the new session confirms the archive.
- `thread archive and quit` archives the session, then quits the way `ampi.quit` (Ctrl+C Ctrl+C) does. Without `ampi-tui` it stops a running turn and shuts Pi down itself.
- With `autoArchiveOnQuit`, quitting an interactive session archives it. Switching sessions, `/reload`, and print, JSON or RPC runs (subagent workers included) never archive. An archive date that is already set is kept.

### Switching sessions

`ampi-tui`'s Switch Thread picker lists the sessions and hands the one you pick to `/ampi-thread switch <session id>`, which switches through Pi's own `switchSession`, as `/resume` does.

- The id is looked up among every session Pi lists (all workspaces, or your custom session directory). An unknown id, or the id of the session you are in, gets a notice and changes nothing.
- Switching to a session started in another working directory moves Pi there, as `/resume` does. Pi refuses when that directory no longer exists; the error is shown as a notice.
- ampi keeps a switch history for as long as Pi runs, like a browser's back and forward lists. Each switch through `/ampi-thread switch` puts the session you left at the front of the previous list and empties the next list. `thread switch to previous` goes back and puts the session you leave at the front of the next list; `thread switch to next` does the reverse.
- With nothing to go back to, `thread switch to previous` is unavailable with the reason "no session to go back to"; `thread switch to next` says "no session to go forward to". A session without messages is never added, since Pi has not saved it.
- A session whose file was deleted is dropped from the history when you try to go to it, with a notice.
- Switches made with Pi's `/resume` or a new session do not change the history. Quitting Pi forgets it.

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

### Markdown export

`thread copy markdown` copies the session's current branch to the clipboard as Markdown and says "Copied the thread as Markdown". It is unavailable until the session has a message.

````markdown
---
title: "Rename the parser module"
sessionId: "0199a0de-5c1e-7a00-8000-000000000001"
created: "2026-10-18T10:00:00.000Z"
mode: "medium"
---

# Rename the parser module

## User

Rename the parser module to `reader`.

## Assistant

Let me look at the sources first.

**Tool Use:** `bash`

```json
{
  "command": "ls src"
}
```

**Tool Result:** `call_1`

```
parser.ts
```
````

- Front matter: the title (the session's name, else its first prompt on one line, cut to 80 characters, else "Untitled"), the session id, when the session started and the ampi mode. Values are JSON strings, which YAML reads as quoted strings; an unknown value is left out.
- A `## User` or `## Assistant` heading starts each change of speaker. A tool call shows its name and arguments as JSON; its result follows in a plain fence, marked "(error)" when the tool failed. Tool results count as the assistant's part, a `!` shell command and its output as yours.
- Text is copied as it is. Thinking, system prompts, extension messages and compaction summaries are left out; an image reads `(image)`.
- Only the branch you are on is copied, from the first message to the last.
- The copy goes through Pi's clipboard helper: the system clipboard where Pi finds a tool for it, and OSC 52 through the terminal over SSH or without a display. When neither works, a notice gives Pi's reason.

`formatMmrThreadMarkdown(entries, options)` makes the same Markdown from a session's entries, header included or not, and is exported from the package root.

### Cost and context

`ampi-tui`'s `thread show cost` and `thread analyze context` show the reports `ampi-threads` computes when the overlay opens. They do not follow the session while open.

Cost:

- Every entry that records model usage counts, as in Pi's own session totals: responses, tool results with usage, `usage` entries such as cache warming, and compaction and branch summaries. Abandoned branches count too, since they were paid for.
- An entry costs what Pi recorded for it. When the provider recorded no cost, its tokens are priced at the model's prices from Pi's model registry (base rates per million tokens, without long-context tiers). A model with neither is "unknown"; the total counts the rest.
- `ampi-tui`'s cost gauge sums the same entries the same way, so it shows the same total.

Context:

- The sections are estimates, four characters to a token, as Pi estimates for compaction. They follow what Pi recorded as sent: the system prompt and tool declarations from the session's system messages, and the conversation after the latest compaction. Before the first request the prompt and tools Pi would send now stand in.
- AGENTS.md files are the `<project_instructions>` blocks Pi writes into the prompt, and loaded skills the entries of its `<available_skills>` list; a mode whose prompt leaves them out counts them under the system prompt. MCP tools are those Pi's MCP adapter registers; every other tool counts as built-in.
- The share of the window uses the window Pi reports for the model. The count Pi measured at the last response is shown beside the estimates; right after a compaction Pi has none until the next response.

## Diagnostics and troubleshooting

- **Ctrl+C shows only Quit.** The session has no messages yet, `ampi-threads` is off (`ampiThreads.enabled: false` or `AMPI_THREADS_ENABLE=false`), or the keys were rebound under `ampi.keymap`.
- **"thread archive and new is not available: this session is already archived".** The session was archived before; run `thread unarchive` from the palette to take it out.
- **A warning says the thread index could not be read.** The file was not a valid index. It was moved to the `.corrupt` name in the warning; inspect it by hand and copy back any entries you need.
- **Archiving fails with "written by a newer ampi".** Another ampi version on this machine uses a newer index format. Update ampi.
- **Ctrl+R does nothing.** `ampi-threads` is off, and the picker needs it. The palette lists the command as "history (unavailable)" and, when you select it, gives the reason "ampi-threads is not loaded".
- **`thread switch to previous` is unavailable after a switch.** You switched with Pi's `/resume`, or from a session without messages: neither is recorded. Switch with `thread switch`.
- **"Could not copy the thread: Clipboard unavailable…".** Pi found no clipboard tool. Install the one the notice names (`xclip`, `xsel` or `wl-copy` on Linux), or run Pi over SSH, where the copy goes through the terminal.
- **`thread show cost` reads "unknown".** Neither the provider nor Pi's model registry gives the model a price. Add one to the model's `cost` in Pi's `models.json`.
- **`thread show cost` is unavailable.** `ampiThreads.showCosts` is `false`, or `ampi-threads` is off.
- **A prompt is missing from Ctrl+R.** It started with `/`, was sent by an extension, repeated the prompt before it, or was sent in another working directory: press Alt+W to show every workspace.

## Public API

Stable re-exports from `ampi`: `createMmrThreadsExtension`, `loadMmrThreadsSettings`, `formatMmrThreadMarkdown` and the `MmrThreadsSettings` / `MmrThreadsFactoryOverrides` / `MmrThreadMarkdownOptions` types. The store (`createMmrThreadIndexStore`, `validateMmrThreadLabels`, `resolveDefaultMmrThreadIndexDir`, `MmrThreadIndexError`) is exported in the Internal tier. Each name has its `Ampi*` alias. Canonical catalog: [`../../../docs/public-api.md`](../../../docs/public-api.md). The read API other extensions use (`getMmrThreadIndex`, `filterMmrSessionsByArchived`) lives in `ampi-core`: [`../../../docs/ampi-core-api.md`](../../../docs/ampi-core-api.md#thread-index).

## Developer notes

- Manifest: risk class `local-mutation` (it writes the thread index under the agent directory), child role `none`. No subagent child keep-set lists it.
- Layout: `index.ts` (entry point: registers the index, prompt history, commands and slash route at load, records prompts from Pi's `input` event, releases everything at `session_shutdown`), `config.ts` (settings), `index-store.ts` (the store), `history-store.ts` (the prompt history files), `commands.ts` (palette commands and the `/ampi-thread` handler), `title.ts` (generated titles: the `title` prompt, the answer's clean-up and the event handlers), `switch-history.ts` (the per-process switch history behind previous and next), `markdown.ts` (the Markdown export), `cost.ts` (the cost report) and `context-analysis.ts` (the context report). The last three are pure: no files, no clock.
- The report overlays live in `ampi-tui`, which may not import this extension: `index.ts` registers the reports in `ampi-core/thread-reports.ts`, and the overlays read them from there. Usage and prices are read through `ampi-core/session-usage.ts`, which `ampi-tui`'s gauge uses too.
- The prompt history picker lives in `ampi-tui`, which may not import this extension. `ampi-threads` registers its history store in `ampi-core/prompt-history.ts` (`registerMmrPromptHistory`), and the picker reads it from there (`getMmrPromptHistory`). The store queues on the same per-path lock as the index store.
- Only a command handler gets Pi's `newSession` and `switchSession`. The palette commands that replace the session, and the Switch Thread picker in `ampi-tui`, therefore send `/ampi-thread …` with `pi.sendUserMessage(…, { expandPromptTemplates: true })`, which Pi runs as an extension command at once, even during a turn.
- Pi loads the extension afresh for every session it switches to, so the switch history lives on `globalThis` rather than in the extension instance. It records only what the route switched, after Pi reports the switch was made.
- Command availability is checked synchronously, so it reads the store's last known record (`peek`); `session_start` loads the current session's record.
- Tests: `tests/mmr-threads-index-store.test.mjs` (store, labels, seam), `tests/mmr-threads-history-store.test.mjs` (prompt history files, trimming, workspaces, seam), `tests/mmr-threads-markdown.test.mjs` (the export against the hand-written `tests/fixtures/ampi-threads-markdown/session.md`), `tests/mmr-threads-cost.test.mjs` (cost arithmetic with a fixture price table), `tests/mmr-threads-context-analysis.test.mjs` (sections, system prompt replay, compactions), `tests/mmr-threads-title.test.mjs` (the title prompt and clean-up, and the title rules against a scripted worker host; rename through the Pi stub) and `tests/mmr-threads-extension.test.mjs` (commands through the Pi stub, the switch route and history against session files written with Pi's `SessionManager`, prompt recording, the Ctrl+C popup, Ctrl+R, the Switch Thread picker and the report overlays through `ampi-tui`, settings, load order).
