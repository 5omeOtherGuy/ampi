# ampi-debug

Opt-in, developer-only live capture of what `ampi` actually sends to and
receives from the model. Built to diagnose model-behavior issues by recording
the **ground-truth** provider request (the assembled system prompt + tool
surface) alongside the response status and the model's output.

> **Not shipped to users.** This extension is intentionally **not** listed in
> `package.json` `pi.extensions`, so Pi never auto-loads it, and it is excluded
> from the npm package via `.npmignore`. It is a debugging tool for this repo's
> maintainers, loaded explicitly only when needed.

## Why a separate extension (not in `ampi-core`)

The provider payload is self-describing: `before_provider_request` carries the
final serialized `system`/`instructions`/`input`, `tools`, and `messages`, plus
`ctx.model`. So capture needs no `ampi-core` mode state, and keeping it out of the
routing-critical extension means the hot path stays untouched while you debug.

## What it captures

Per turn, appended as JSON Lines to the capture file:

| `kind`     | Source hook                 | Fields                                                  |
| ---------- | --------------------------- | ------------------------------------------------------ |
| `request`  | `before_provider_request`   | `systemPrompt`, `systemPromptSource`, `tools`, `model` |
| `response` | `after_provider_response`   | `status`, `headers` (no body — the hook exposes none)  |
| `message`  | `message_end` (assistant)   | `text`, `stopReason`                                   |

Every record also carries `seq` (monotonic), `turn`, `ts` (ISO), and `sessionId`.

### Ground truth, not `getSystemPrompt()`

Pi rebuilds the final provider payload from its own state, and the docs note
that payload-level system-prompt changes are **not** reflected by
`ctx.getSystemPrompt()`. `before_provider_request` is therefore the only
authoritative view of what the model actually receives — which is exactly what
you need to confirm the system prompt stays clean.

### Limitation: no response body

`after_provider_response` exposes only HTTP `status` + `headers`; the response
body is never available there. The model's output is captured separately from
the finalized `message_end` assistant message (`kind: "message"`).

## Usage

It is inert unless `AMPI_DEBUG_CAPTURE_FILE` (legacy `MMR_DEBUG_CAPTURE_FILE` still accepted) is set (no env → no hooks → no cost).

```sh
# Load explicitly and capture to a gitignored path:
AMPI_DEBUG_CAPTURE_FILE="$PWD/.pi/ampi-debug/capture.jsonl" \
  pi -e "$PWD/src/extensions/ampi-debug/index.ts"

# Also dump the entire raw request payload (all conversation messages):
AMPI_DEBUG_CAPTURE_FULL=1 \
AMPI_DEBUG_CAPTURE_FILE="$PWD/.pi/ampi-debug/capture.jsonl" \
  pi -e "$PWD/src/extensions/ampi-debug/index.ts"
```

Inspect a run (newest system prompt, response statuses, assistant outputs):

```sh
# Just the system prompts, per turn:
jq -r 'select(.kind=="request") | "turn \(.turn): \(.systemPromptSource)\n\(.systemPrompt)"' \
  .pi/ampi-debug/capture.jsonl

# Response statuses:
jq -r 'select(.kind=="response") | "turn \(.turn): \(.status)"' .pi/ampi-debug/capture.jsonl
```

The `AMPI_DEBUG_*` env names are canonical; the legacy `MMR_DEBUG_*` equivalents are still accepted.

| Variable                    | Effect                                                            |
| --------------------------- | ---------------------------------------------------------------- |
| `AMPI_DEBUG_CAPTURE_FILE`   | Path to the JSONL capture file. **Required to activate.**        |
| `AMPI_DEBUG_CAPTURE_FULL`   | `1`/`true`/`yes` → also record the full raw request payload.     |

## Privacy

The capture file contains full prompt/session text and provider response
headers. It is written with mode `0600`. **Never commit or share it.** Point
`AMPI_DEBUG_CAPTURE_FILE` at a gitignored path such as `.pi/ampi-debug/`.

## Public API

`capture.ts` exports pure, Pi-free helpers — `extractSystemPrompt`,
`extractToolNames`, `extractMessageSummary`, `stringifyContent` — covered by
`tests/mmr-debug-capture.test.mjs`. They are intentionally **not** re-exported
from the package root, because this extension is not part of the shipped public
surface.
