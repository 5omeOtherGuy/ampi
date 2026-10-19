# ampi-painter

Image generation for the model: `painter` makes or edits one image per call with an image model from the user's providers, saves it and shows it in the result.

Package overview: [`../../../README.md`](../../../README.md). Planning: [`../../../ROADMAP.md`](../../../ROADMAP.md). Public API: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## At a glance

| Default | Provides | Requires | Diagnostics |
| --- | --- | --- | --- |
| Off | `painter` | `ampiPainter.enabled=true` or `AMPI_PAINTER_ENABLE=1`, a usable image model | `/ampi-status`, tool result `details` |

## When to use it

- The user asks for a picture, an illustration, an icon, a logo or a UI mock-up.
- The user points to an image and asks for a change to it, or for a new image in its style.
- Diagrams that read well as text stay text; `painter` is for real images.

## Status and enablement

Default: off. `ampi-painter` loads from `package.json` `pi.extensions`. While it is off it registers no tool, only its tool provider and its feature gate: `/ampi-status` lists `painter` as `gated` behind `ampi-painter` and the gate as `disabled`, with how to turn it on. Turn it on with `ampiPainter.enabled: true` or `AMPI_PAINTER_ENABLE=1`, then restart Pi.

Once on, `painter` is `active` in the `low`, `medium`, `high` and `ultra` modes while an image model is usable, and `gated` with the reason otherwise. Free mode drops it like every ampi-owned tool. The feature gate `ampi-painter` (legacy `mmr-painter`) reports `enabled` with the model in use, or with why there is none.

## Tools / commands / surfaces

| Tool | Parameters | Purpose |
| --- | --- | --- |
| `painter` | `prompt`, `reference_images?`, `background?`, `output_path?` | Make or edit one image, save it, return it |

- `prompt`: what to draw, or for an edit what to change and what to keep. Must not be empty.
- `reference_images`: up to three image files, relative to the working directory or absolute. The model edits them or takes their style, layout or content, as the prompt says.
- `background`: `transparent`, `opaque` or `auto` (the default). `transparent` and `opaque` add one sentence asking for that background to the prompt; `auto` adds nothing.
- `output_path`: where to save the image (see [Where images go](#where-images-go)).

With `ampi-tui`, a call is one transcript row of its own, never folded into a group: "Painting <the prompt's first line>" while it runs, "Painted <file name>" once saved. Expanding tool output shows the prompt, the reference images and the saved path, or the error. The terminal row does not draw the image; the result carries it for the model and for hosts that show images.

## Configuration

Two settings; neither is a secret. Credentials for image models are the providers' own (for example OpenRouter's `OPENROUTER_API_KEY` or `/login`); `ampi-painter` reads none.

```json
{ "ampiPainter": { "enabled": true, "model": "openrouter/google/gemini-2.5-flash-image" } }
```

```bash
export AMPI_PAINTER_ENABLE=1
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `ampiPainter.enabled` | `false` | Offer `painter` |
| `ampiPainter.model` | unset | The image model as `provider/id`; unset picks one (below) |

The nested form `ampi.painter.*` works too. Settings come from `~/.pi/agent/settings.json`, then `<cwd>/.pi/settings.json`; `AMPI_PAINTER_ENABLE` (legacy `MMR_PAINTER_ENABLE`) overrides `enabled`. Values of the wrong type are ignored. `ampiPainter.model` is split at its first `/`: the provider comes before it, and the id, which may hold slashes of its own, after it.

Settings are sampled once at extension load. Restart Pi after changing them.

## Behavior

### How the model is chosen

- With `ampiPainter.model` set, `painter` uses that model when Pi knows it and lists it among the image models whose provider has working credentials. Otherwise the tool is `gated` with a reason that names the setting's value; it never falls back to another model.
- Without the setting, it uses the first usable image model, sorted by provider, then id, so the choice does not depend on the order providers registered in.
- With no usable image model, the tool is `gated` with a reason that names `ampiPainter.model`.
- The check runs when a session starts and when the model changes, and again at every call. Pi has no event for a provider an extension adds later or a login that finishes, so a newly usable image model shows up in `/ampi-status` after a restart, a new session or a model switch. A call made after credentials went away fails with the same reason the gate gives.
- ampi-core applies the mode's tools before `ampi-painter` has checked for a model. When the answer is in, `ampi-painter` asks ampi-core to resolve the mode's tools again, so `painter` is already active, or still gated, in the first turn.

### The call

1. The prompt, the background choice, every reference image and `output_path` are checked first. A refused call does not reach the model and costs nothing.
2. The image model gets one text block (the prompt and the background sentence) and then one image block per reference, in order.
3. A provider error becomes a tool error with the provider's message; a cancelled call becomes a tool error that says so; an answer without an image becomes a tool error with any text the model returned. Nothing is saved in these cases.
4. Only the first image of an answer is used. It is saved, and the result holds a text block that names the saved file and the model (`provider/id`), the image, then any text the model returned. `details` holds `{ path, model, usage }`; `usage` comes from the provider when it reports it.

The saved path is in the text block on purpose: `ampi -x --output-tool painter` and `--stream-json` leave images out and keep the text.

### Where images go

- With `output_path`: the path resolved against the working directory.
- Without it: `<agent dir>/data/ampi/painter/<session id>/<timestamp>-<n>.<ext>`, where the agent directory is Pi's (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`), `n` counts the session's images from 1 and the extension follows the image's format (`png`, `jpg`, `webp`, `gif`). The file is written to a temporary name in the same folder and renamed into place.

### The `output_path` rule

- It must stay inside the working directory, also through symlinks: the nearest folder of the path that exists, with symlinks resolved, must be the working directory or below it. `../x.png` and a path through a symlinked folder that leads outside are refused.
- Its folder must already exist; `painter` creates no folders.
- Nothing may exist at the path yet, not even a symlink. The file is created exclusively, so a file that appears between the check and the write is not overwritten either.
- When the file name's extension does not fit the format the model returned, the image is still saved under the given name and the result says which format it is.

Every refusal is a tool error that names the path and the rule.

### Limits

- One image per call; for several images the model calls `painter` once for each.
- At most three reference images, each at most 10 MiB by size on disk, and each PNG, JPEG, WebP or GIF by its content. The file name's extension does not count; a BMP or an animated PNG is refused.
- How well the image follows the prompt, the references and the background request depends on the model; not every model returns transparency.
- No size, quality or count settings.

## Safety and privacy

- The prompt and the reference images go to the chosen image model's provider.
- Nothing is redacted from the prompt or the images.
- `output_path` outside the working directory, into a missing folder or onto an existing entry is refused.
- Images saved without `output_path` stay under Pi's agent directory, one folder per session; `ampi-painter` deletes none of them.
- Rules of [`ampi-permissions`](../ampi-permissions/README.md) apply to `painter` calls like to any tool, and can match its fields. This rule asks before every call that saves into the project:

  ```json
  { "ampi": { "permissions": [{ "tool": "painter", "matches": { "output_path": "*" }, "action": "ask" }] } }
  ```

  `ampi-painter` has no check of its own for guarded files.

## Diagnostics and troubleshooting

- **`painter` stays `gated`.** `/ampi-status` shows the reason under the tool and the `ampi-painter` gate: the extension is off, no image model has credentials, or `ampiPainter.model` names a model that is unknown or has no credentials.
- **A login or a new provider made no difference.** Start a new session, switch the model or restart Pi; `ampi-painter` checks again then.
- **"already exists; painter never overwrites a file".** Pick a new `output_path`, or leave it out to save under the agent directory.
- **The background is not transparent.** The model ignored the request; try another image model with `ampiPainter.model`.

## Public API

Stable re-exports from `ampi`: `createMmrPainterExtension`, `loadMmrPainterSettings` and the `MmrPainterSettings` / `MmrPainterFactoryOverrides` types, each with its `Ampi*` alias. Canonical catalog: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## Developer notes

- `index.ts` registers the tool, the tool provider, the feature-gate provider and the model checks; `config.ts` loads settings; `model.ts` chooses the model; `files.ts` checks reference images and `output_path` and saves images; `tool.ts` holds the tool definition and its descriptions (a public-safety lint surface).
- `MMR_EVENT_TOOL_RULES_CHANGED` (`notifyMmrToolRulesChanged` in `ampi-core/runtime.ts`) is how a tool provider tells ampi-core its answer changed; ampi-core resolves the locked mode's tools again, after a mode apply in progress ends.
- Tests: `tests/mmr-painter-tool.test.mjs` uses a fake model registry, temporary folders, an injected clock and data folder, and `tests/fixtures/ampi-painter/pixel.png`. Transcript rows: `tests/mmr-tui-activity.test.mjs` and the `mmr-tui-tool-rows` fixtures.
