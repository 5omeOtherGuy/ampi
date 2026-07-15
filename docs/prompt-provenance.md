# Prompt provenance

**Audience.** Anyone reviewing `ampi-core` mode prompts, subagent prompts, or tool descriptions. Confirms what is `ampi`-authored and what is preserved from Pi or other sources.

**Related.** Prompt assembly contract: [`ampi-core-api.md`](./ampi-core-api.md). Documentation conventions: [`documentation-style-guide.md`](./documentation-style-guide.md).

`ampi-core` per-mode prompt text in this package is `ampi`-authored. No raw third-party prompt material is copied into the repository; prompt content is restated as `ampi`-owned guidance.

## What `ampi-core` writes to the system prompt

- `low`, `medium`, `high`, and `ultra` each use an ampi-authored mode template in `src/extensions/ampi-core/prompt-content.ts` (re-exported by the `prompt-templates.ts` compatibility shim).
- Medium, High, and Ultra share the full prompt body: the same autonomous-agent intro, body fragments, and closing guidance with tier-specific mode markers.
- Low uses the compact prompt body: task framing, planning, and codebase-discovery sections up front, with implementation, verification, and communication guidance after the tool surface.
- Mode/tool/policy state (active/missing/deferred tools, configured fallback details, feature gates, availability notes) is **not** written into the model-visible prompt. It is exposed through `MmrModeState`, `/ampi-status`, activation warnings, and the status bar.

## How the rewrite is scoped

- For each prompted locked-mode turn, `ampi-core` surgically replaces only Pi's auto-rendered head (identity line through the `Pi documentation` block) with the active mode prompt.
- The only ampi-owned XML-style marker is the initial one-line role marker (for example, `<mmr_mode name="medium">...</mmr_mode>`); mode sections use Markdown headings.
- Pi's auto-rendered `Available tools:` block is embedded verbatim under `## Tool use`.
- Pi's auto-rendered `Guidelines:` block is embedded under `## Tool use` with the two unconditional Pi bullets (`Be concise in your responses`, `Show file paths clearly when working with files`) stripped because the mode prompt covers them.
- Everything outside the auto-rendered head is preserved byte-for-byte: content prepended by earlier `before_agent_start` handlers, Pi's `appendSystemPrompt` (`--append-system-prompt` / `APPEND_SYSTEM.md`), `# Project Context` / AGENTS.md, `<available_skills>`, the future subagents block, `Current date:`, `Current working directory:`, and any extension content appended after the tail.
- When the auto head cannot be located (user-supplied `--system-prompt` / `SYSTEM.md`, or unexpected layout), `ampi-core` passes Pi's prompt through unchanged. The same applies in `free` mode.

## Non-goals

- Copying or restating third-party system-prompt text inside this repository.
- Provider-specific request shaping (handled separately by the `before_provider_request` policy hook).
- Dynamic context assembly for tools, skills, settings, AGENTS files, or server/runtime data outside Pi's existing prompt pipeline.

Snapshot tests anchor the rendered prompt for every locked mode under `tests/fixtures/mmr-core-prompts/`; behavioral tests verify that out-of-head Pi/extension content is preserved.
