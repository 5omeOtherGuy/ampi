# ampi-gui

A local web GUI for the running Pi session: open the link Pi prints and the browser shows the session's transcript live, with the same activity words for tool calls as the terminal and the agent's status as it works, and a composer that sends, steers, queues and interrupts through the terminal's own session.

Package overview: [`../../../README.md`](../../../README.md). Planning: [`../../../ROADMAP.md`](../../../ROADMAP.md). Public API: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## At a glance

| Default | Provides | Requires | Diagnostics |
| --- | --- | --- | --- |
| Off | A web page on `http://127.0.0.1:<random port>` with a live transcript and a composer, the `thread.openInBrowser` command, a live registry entry | an interactive terminal session; a browser on the same machine; `ampi-tui` for queued-message texts and steering a queued message | the `Web GUI: …` notice at session start; `<agentDir>/data/ampi/live/<pid>.json` |

## When to use it

- You want to read a long session in a browser: wider prose, rendered Markdown, tool output you can expand.
- You want to watch a running turn from another window while the terminal is busy or hidden, and steer, queue or stop it from there.

## Status and enablement

Default: off. `ampi-gui` is registered in `package.json` `pi.extensions` but does nothing until you turn it on with `ampiGui.enabled: true` or `AMPI_GUI_ENABLE=true` (see [Configuration](#configuration)).

Even when on, it starts only in an interactive terminal session (Pi's `tui` mode). Print, JSON and RPC runs, subagent workers included, never open a port. It owns no model-visible tools or feature gates.

## Tools / commands / surfaces

| Surface | Type | Purpose |
| --- | --- | --- |
| `Web GUI: http://127.0.0.1:<port>/?t=<token>` | Notice at session start | The link to open; it carries the access token |
| `thread.openInBrowser` | Command, no key | Opens the link with `xdg-open` (Linux with a desktop) or `open` (macOS); elsewhere it shows the link to copy |
| Live registry | File | `<agentDir>/data/ampi/live/<pid>.json`: `{ version, pid, sessionPath, cwd, port, tokenHash, startedAt }`, removed when the session ends |
| `POST /api/send`, `/api/dequeue`, `/api/steer-next`, `/api/interrupt` | Page endpoints | What the composer sends; see [Commands](#commands) |

The palette lists the command as `thread open in browser`.

## Configuration

One switch; it is not a secret.

```json
{ "ampiGui": { "enabled": true } }
```

The nested form `{ "ampi": { "gui": { "enabled": true } } }` is accepted too. Settings are read from `~/.pi/agent/settings.json` and then `<project>/.pi/settings.json`; the project file wins. An environment variable overrides both:

| Variable | Effect |
| --- | --- |
| `AMPI_GUI_ENABLE` | `true` turns the GUI on, `false` turns it off |

The settings are read once when the extension loads. Restart Pi or run `/reload` after changing them.

## Behavior

### The page

- A 36 px title bar with the session's status disc, its title (its name, or the first line of its first prompt), the working directory and the ampi mode, and a button that cycles the colour scheme (system, light, dark; remembered in this browser).
- The transcript in a centred column up to 672 px wide. Your prompts are bubbles on the right. The assistant's replies are prose with rendered Markdown (headings, lists, tables, code cards, links). Each tool call is one line in the terminal's activity words ("Read src/a.ts", "Ran npm test (exit code: 1)") that expands to its output. Thinking is a collapsed "Thinking" line.
- The composer at the bottom: a text area, a paperclip (attachments are not available yet; it says so), the agent's status (Sending, Thinking, Streaming, Running Tools, Auto-Compacting, Waiting for Approval, Cancelling or Error, with the streamed-token count or the tool name and the number of queued messages) and a round send button that turns into a stop square while a turn runs and nothing is typed. A pulsing dot ends the transcript while the agent works.
- The transcript follows new output while you are at the bottom, also when the composer grows or the window changes size. Scroll up and it stays put; the round button above the composer (or End) jumps back down.
- Below 768 px the layout narrows to one column and the title bar drops its border and the mode.

### The composer

Text typed here goes to the same Pi session as the terminal, the way the terminal's own keys send it, so both show the same transcript and the same queue.

| Key | While idle | While a turn runs |
| --- | --- | --- |
| Enter | Sends the prompt | Steers the turn: Pi hands the message to the model at its next step |
| Ctrl+Enter (⌘+Enter on macOS) | Sends the prompt | Queues the message to run after the turn ends |
| Shift+Enter | New line | New line |
| Esc Esc (within 1.5 seconds) | Nothing | Interrupts the turn; the first Esc says "Press Esc again to interrupt" |

- Prompt templates and skills expand as they do in the terminal. While Pi compacts the conversation it refuses new messages; the composer says so and keeps the text.
- The send button sends (or steers) what is typed; with nothing typed during a turn it is a stop button. The placeholder names the keys while a turn runs.
- **Queued messages** are bubbles above the composer, steering ones first, labelled Steering or Queued. Each has Delete (takes it out of Pi's queue) and Edit (takes it out and puts its text into the composer); the next queued one also has an arrow that sends it now to steer the turn, as Enter on an empty prompt does in the terminal. A message that already started, or that changed in the meantime, is not taken: the page says it is no longer queued.
- **Interrupting** does what the terminal's Esc Esc does: Pi stops the turn and puts the messages still queued back into the terminal's prompt, not the browser's. The page says so when that happened.
- **Approvals stay in the terminal.** While a tool call waits for approval (status Waiting for Approval), a note above the composer says to answer it there.
- Queued-message bubbles and steering a queued message need `ampi-tui`, which reads Pi's queue. Without it, the composer still sends, steers, queues and interrupts, and the status shows how many messages are queued.

### Commands

The composer's endpoints. Each takes a JSON body and answers JSON: 200 with `ok: true` when Pi took it, 400 for a malformed request, 409 with an `error` sentence when it cannot act now (nothing is running, Pi is compacting, the message is no longer queued).

| Endpoint | Body | Effect |
| --- | --- | --- |
| `POST /api/send` | `{ "text": "…", "deliverAs": "steer" \| "followUp" }` | Idle: a new prompt (`delivered: "prompt"`). During a turn: steers it (`"steer"`, the default) or queues it (`"followUp"`). At most 100,000 characters. |
| `POST /api/dequeue` | `{ "kind": "steering" \| "followUp", "index": 0, "text": "…" }` | Takes that queued message out of Pi's queue if it still reads `text`; answers with its text |
| `POST /api/steer-next` | `{}` | Runs `prompt steer queued message`; a 409 carries its reason |
| `POST /api/interrupt` | `{}` | Runs `thread interrupt` (or Pi's abort when `ampi-tui` is off) |

### Live updates

The page loads the transcript once (`GET /api/transcript`, which includes the queued messages), then follows the session's event stream (`GET /api/events`, `text/event-stream`): status changes, new messages, text as it streams, tool calls starting and finishing, the end of each turn, changes of the queue and changes to the session's name, model or mode. If the connection drops, the browser reconnects and the server replays the events it missed; if too many were missed, the page reloads the transcript.

Pi starts each session with a fresh set of extensions, so `/new`, `/resume` and `/fork` stop the old server and start a new one with a new link.

### Security model

- The server listens on `127.0.0.1` only, on a random free port. Nothing on the network can reach it.
- Every request must name the server in `Host` (`127.0.0.1:<port>` or `localhost:<port>`), which stops a web page from reaching it through DNS rebinding. A request whose `Origin` is another site, or another local port, is refused, and a POST must carry the server's own origin.
- Every request needs the per-process access token: 32 random bytes, new for every session. The link carries it once; the server then sets it as an `HttpOnly`, `SameSite=Strict` cookie for that port and redirects to `/`, so the token leaves the address bar and history. The token is never logged, and the live registry holds only its SHA-256 hash.
- Commands are POST requests with a JSON body (`Content-Type: application/json`, at most 512 KiB). A POST without the cookie, without an `Origin` or with another origin is refused with 403 before its body is read, so another page in the browser cannot send a message, even with the cookie the browser holds.
- The page never writes the session file itself: every message, queue change and interrupt goes through the terminal process's Pi session, the same way the terminal's keys go.
- Responses carry no CORS headers, a Content-Security-Policy that allows only the page's own scripts, styles and connections, and `X-Frame-Options: DENY`.
- The server serves only files inside its `client/` directory, by extension with an explicit content type. Model output is HTML-escaped before Markdown formatting is applied, and links keep only `http`, `https` and `mailto` targets.
- It writes nothing outside the live registry directory. Anyone who can run programs as your user can read the token from the terminal or the browser; the GUI does not protect against them.
- `thread open in browser` passes the link, token included, to `xdg-open` or `open` as a command-line argument. On a machine shared with other users, they may be able to read it there (on Linux, from `/proc/<pid>/cmdline`), for as long as that process runs; a browser that the command starts keeps the link in its arguments until it quits. On a shared machine, copy the link from the notice into a browser that is already running instead.

## Diagnostics and troubleshooting

- **No `Web GUI:` notice.** The GUI is off (`ampiGui.enabled` is not `true` and `AMPI_GUI_ENABLE` is unset), or Pi is not running in the interactive terminal.
- **"ampi-gui: could not start the web GUI".** Pi could not listen on `127.0.0.1`, for example in a sandbox without loopback networking.
- **The page says "Open the link Pi printed to use this page".** The browser has no cookie for this port: open the full link from the notice (or run `thread open in browser`). Links from an earlier session stop working when that session ends.
- **The composer says "Disconnected".** Pi quit or switched to another session; the browser keeps retrying, and the send button stays off until it is back. Open the link the new session printed.
- **"This session does not show ampi its queue".** `ampi-tui` is off, or this Pi version changed how ampi reads its queue: the queued messages show only as a count, and Delete, Edit and the steer arrow are not offered.
- **A queued message came back in the terminal after an interrupt.** That is Pi's behaviour on an interrupt from either side; send it again from the terminal or copy it over.
- **`thread open in browser` only shows the link.** No desktop was found (`DISPLAY` and `WAYLAND_DISPLAY` are unset) or the platform has no opener; copy the link into a browser.

## Public API

Stable re-exports from `ampi`: `createMmrGuiExtension`, `loadMmrGuiSettings` and the `MmrGuiSettings` / `MmrGuiFactoryOverrides` types, each with its `Ampi*` alias. Canonical catalog: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## Developer notes

- Manifest: risk class `local-server` (a token-protected HTTP endpoint on `127.0.0.1`, no outbound requests), child role `none`. No subagent child keep-set lists it.
- Layout: `index.ts` (entry point: the gate, the server's lifetime from `session_start` to `session_shutdown`, the live registry entry and the command), `config.ts` (settings), `server.ts` (`node:http`: request policy, routes, static files, the event stream, POST bodies), `commands.ts` (the composer's commands), `bridge.ts` (Pi events to client events through `ampi-core/thread-status.ts`, the queue from `ampi-core/prompt-queue.ts`, the replay buffer and the transcript snapshot), `view-model.ts` (session messages to transcript items, tool calls labelled by `ampi-core/tool-activity.ts`), `registry.ts` (the live registry), `client/` (the page: `index.html`, `app.js`, `composer.js`, `markdown.js`, `tokens.css`, `app.css`).
- Commands reuse the terminal's paths: `pi.sendUserMessage` with `deliverAs` for sending, the registered `prompt.steerQueuedMessage` and `thread.interrupt` commands, and ampi-core's prompt-queue seam, which `ampi-tui` owns and serves through its `pi-compat/queue.ts`, for the queue. The GUI never patches Pi itself.
- The client is plain ES modules and CSS custom properties with no build step and no external assets. Colours are `light-dark()` pairs; `html[data-ampi-color-scheme]` forces a scheme. Fonts are `system-ui` and the platform's monospace font.
- Markdown is rendered in the browser by `client/markdown.js`, a small renderer written for this page, so the package adds no runtime dependency.
- A snapshot joins the saved branch with the messages of the current run that Pi has not written yet (Pi writes a message after the extensions have seen its end). Items are keyed by role and message timestamp, so both sources give the same id.
- Tests: `tests/mmr-gui-server.test.mjs` (Host, Origin and token checks, static file policy, JSON routes, the composer's commands and their CSRF policy, the event stream and its replay, against a real server), `tests/mmr-gui-bridge.test.mjs` (Pi events to client events, the queue, the snapshot, the view model), `tests/mmr-gui-composer.test.mjs` (the composer's keys, Esc Esc chord, requests and button state), `tests/mmr-gui-registry.test.mjs` (the live registry files), `tests/mmr-gui-extension.test.mjs` (settings, the gate, the server's lifetime, the command, load order) and `tests/mmr-gui-markdown.test.mjs` (the renderer and its escaping).
