# Documentation style guide

How `ampi` writes user-facing docs. The goal is predictable information architecture: readers learn one shape and can find the same thing in the same place across every README. Apply this to root `README.md`, per-extension READMEs, `tests/README.md`, and the user-facing files in `docs/`.

## Audience and tone

- Public-safe and repo-owned. Use `ampi` vocabulary; do not reference local-only analysis, confidential product details, or exact local paths.
- Reader-first. Lead with what the thing is for and when to use it; push invariants and developer notes lower.
- Concise but complete. Every factual claim should be verifiable from the code or tests; do not delete claims to shorten — restructure instead.
- Avoid ceremony. No "Overview", "Introduction", "Note that…" preambles when a heading already says what follows.

## Canonical extension README skeleton

Every `src/extensions/<name>/README.md` follows this top-level order. Sections may be empty when an extension legitimately has nothing to say, but the order does not change.

```md
# ampi-<name>

One-sentence purpose.

Cross-links: package overview, planning, API.

## At a glance
## When to use it
## Status and enablement
## Tools / commands / surfaces
## Configuration
## Behavior
## Diagnostics and troubleshooting
## Public API
## Developer notes
```

Notes per section:

- **At a glance.** Four-column table summarizing the extension at a single look. Always present.
- **When to use it.** 2–5 bullets answering "should I reach for this?". Omit if the purpose line already covers it.
- **Status and enablement.** Default on/off, opt-in flags, prerequisites, feature gates.
- **Tools / commands / surfaces.** Table of model-visible tools, slash commands, shortcuts, widgets. One row per surface.
- **Configuration.** Minimal example first, then env vars, then security note, then reload behavior.
- **Behavior.** Deeper user-visible behavior (lifecycle, model/tool resolution, persistence, retries, safety rules). Use subsections for large extensions.
- **Diagnostics and troubleshooting.** Symptom-first bullets.
- **Public API.** Stable re-exported surfaces only. Link to `docs/public-api.md` for the canonical catalog.
- **Developer notes.** Tests, fixtures, invariants, ownership, non-goals. Lives at the bottom so casual readers can stop earlier.

For long-form docs (`ampi-core`, `ampi-subagents`, `ampi-toolbox`), split **Behavior** into named subsections (e.g. *Subagent profiles*, *Free mode*, *Prompt assembly*) but keep the top-level order intact.

## At a glance table

Every extension README starts its body with this table. Four columns, one row, ≤ ~12 words per cell.

```md
## At a glance

| Default | Provides | Requires | Diagnostics |
| --- | --- | --- | --- |
| Off | `web_search`, `read_web_page` | `AMPI_WEB_ENABLE=true` or `ampiWeb.enabled=true` | `/ampi-status`, tool result details |
```

Column meaning:

- **Default** — `On` / `Off` / `Opt-in`.
- **Provides** — model-visible tools, commands, or capabilities; identifiers in backticks.
- **Requires** — env vars, settings keys, peer extensions. `none` if no prerequisites.
- **Diagnostics** — where the user looks to verify it works.

## Status vocabulary

Use exactly these words. They appear in `/ampi-status`, schemas, and prose; do not introduce synonyms.

| Term | Meaning |
| --- | --- |
| **Default: on / off / opt-in** | Whether the extension loads without opt-in config. |
| **Active** | Registered and available to the current mode. |
| **Gated** | Known capability, waiting on config or a peer prerequisite. |
| **Deferred** | Recognized name reserved by the catalog; not implemented yet. |
| **Disabled** | Explicitly turned off. |
| **Missing** | No extension has claimed the name; Pi has not registered it. |
| **Fail-closed** | Refuses to proceed rather than degrade silently. |

When describing a tool's resolution, use the same five-state vocabulary as the code: `active`, `gated`, `disabled`, `deferred`, `missing`. Format identifiers as inline code.

## Tables and lists

- **Tables summarize; bullets explain.** Use a table to compare ≥ 2 things on the same shape. Long behavior belongs in bullets under the table.
- **Max 4 columns** when possible. Wider tables wrap badly on narrow terminals and GitHub mobile.
- **Avoid paragraph cells.** If a cell would exceed ~12 words, replace the column with a bullet list below the table.
- **Code-format identifiers.** Settings keys (`ampiCore.defaultMode`), env vars (`BRAVE_API_KEY`), tool names (`web_search`), modes (`medium`), and file paths (`src/extensions/...`).
- **Lists are unordered unless order matters.** Use ordered lists for procedures, precedence chains, and lifecycle steps; otherwise `-`.
- **Sentence case headings.** `## Diagnostics and troubleshooting`, not `## Diagnostics And Troubleshooting`.

## Configuration section

Order, every time:

1. One-sentence summary of what is configurable here.
2. Minimal example (settings JSON or env), shortest useful form.
3. Env-var table when there is more than one variable.
4. Security note: which fields are secrets, and where they belong (env, not settings files).
5. Reload behavior (restart required? hot-reload? settings sampled once at load?).

```md
## Configuration

Non-secret settings live in Pi settings files. Secrets live in environment variables.

```json
{ "ampiWeb": { "enabled": true } }
```

```bash
export BRAVE_API_KEY="brv_xxx"   # env-only; never put in settings.json
```

Settings are sampled once at extension load. Restart Pi after changing fields that gate registration.
```

## Diagnostics and troubleshooting section

Symptom-first. Each bullet starts with the user-visible symptom, then likely cause, then the fix. Always link to the canonical diagnostic surface (`/ampi-status`, tool result `details`, or the relevant config writer flow).

```md
## Diagnostics and troubleshooting

- **Tool stays `gated`.** Owning extension is loaded but a prerequisite is unmet. Inspect `/ampi-status` → `Gated tools:`.
- **`Model applied: no`.** Provider not registered, OAuth/API key missing, or Pi rejected the id. `/ampi-status debug` shows per-candidate flags.
- **Fallback did not trigger.** Error was not classified as quota/rate-limit, or an override is already pinned for the session.
```

## Safety and privacy section

Required for any extension that touches the filesystem outside the workspace, the network, persisted history, or workspace shell. Use this fixed sub-shape:

```md
## Safety and privacy

- What data leaves the process.
- What is redacted before it leaves.
- What URLs, paths, or operations are rejected.
- What state is persisted and where.
- What is intentionally not supported.
```

## Public API section

Re-exports stable from the package root only. Link out, don't recreate:

```md
## Public API

Stable re-exports from `ampi`: `createMmrSubagentsExtension`, `runMmrSubagentWorker`, ... Canonical catalog: [`docs/public-api.md`](../../../docs/public-api.md).
```

Do not list internal symbols, do not duplicate type definitions, do not document the deep-path imports unless they are part of the documented stable surface.

## Cross-linking rules

- **Every extension README links back to the root in the opening lines.** Use a single line of relative links to package overview, planning, and the relevant API doc.
- **Use relative paths from the file itself.** Not absolute repo paths, not `file://` URLs.
- **Link identifiers to their source of truth.** Tool names link to the owning extension README, settings keys link to that extension's Configuration section, public API names link to `docs/public-api.md`.
- **Anchor links use the rendered heading slug.** `[diagnostics](#diagnostics-and-troubleshooting)`. Keep headings stable; if you rename, update inbound links in the same PR.

```md
Package overview: [`../../../README.md`](../../../README.md).
Planning: [`ROADMAP.md`](ROADMAP.md).
Public API: [`../../../docs/public-api.md`](../../../docs/public-api.md).
```

## Public-safety wording rules

Public docs describe only `ampi` behavior in repo-owned terms.

Use:

- "Prompt text is authored for `ampi` and assembled through the extension prompt pipeline."
- "Locked modes", "prompt assembly", "feature gate", "provider-neutral model preferences", "tool allowlist", "fail-closed".

Do not use:

- Wording that explains a change through non-public provenance, confidential product internals, externally sourced prompt material, raw provider request/response data, or local-only evidence.
- User-specific provider routes such as private registry shortnames, internal product names, or local analysis paths.

When in doubt, restate the behavior in terms a public reader of this repo can verify from the code in this repo alone.

## Code blocks

- Fence every code block with a language hint: `bash`, `json`, `ts`, `md`, `text`. Never bare `\`\`\``.
- Inline shell prompts: omit `$ ` prefixes — readers copy/paste raw commands.
- One concept per block. Long sequences split with prose between them.
- Use `text` for example output, signatures, or non-runnable snippets.

## Headings and anchors

- One `# Title` per file, matching the canonical name (`# ampi-<name>`).
- `##` for top-level sections from the skeleton.
- `###` for Behavior subsections; avoid deeper levels in user-facing docs.
- Avoid emojis and decorative characters in headings; they break anchor slugs and screen readers.

## Length budgets (soft)

These are not enforced; they describe the target reading time for first-time readers.

| File | Target |
| --- | --- |
| Root `README.md` | ≤ 150 lines |
| Per-extension README | ≤ 250 lines for small extensions, ≤ 400 lines for the framework-heavy ones (`ampi-core`, `ampi-subagents`, `ampi-toolbox`) |
| `tests/README.md` | ≤ 100 lines |
| `docs/*.md` reference docs | unbounded; structure with H2/H3 so the table of contents is usable |

When a README grows past its budget, split into Behavior subsections or move developer-only content into `docs/`.

## Worked examples in this repo

- Status vocabulary in action: [`src/extensions/ampi-core/README.md`](../src/extensions/ampi-core/README.md#diagnostics-and-troubleshooting).
- Safety / privacy section in action: [`src/extensions/ampi-web/README.md`](../src/extensions/ampi-web/README.md#safety-policy), [`src/extensions/ampi-history/README.md`](../src/extensions/ampi-history/README.md#redaction).
- Tools/commands surface table in action: [`src/extensions/ampi-web/README.md`](../src/extensions/ampi-web/README.md#tools).

## Applying the guide

When a doc change touches user-facing wording, run through this checklist:

1. Does the file follow the skeleton above? If not, restructure to the skeleton in the same PR.
2. Does every claim survive the public-safety rules?
3. Are status words consistent with the vocabulary?
4. Does the At a glance table exist and fit in four columns?
5. Are tables short and bullets used for detail?
6. Do cross-links use relative paths and point at the source of truth?
7. Is the length within the soft budget? If not, move detail to subsections or `docs/`.

This guide itself follows the same rules: skeleton structure, short tables, code-formatted identifiers, public-safe wording.
