# pi-mmr

Pi Multi-Model Routing extensions.

`pi-mmr` is a [Pi](https://github.com/earendil-works/pi-coding-agent) package that coordinates model selection, thinking level, active tools, and a per-mode system-prompt rewrite behind a small set of named modes. It routes across whichever providers and subscriptions are already registered in the host Pi installation.

## Extensions

| Extension | Purpose | Default |
| --- | --- | --- |
| [`mmr-core`](src/extensions/mmr-core/README.md) | Locked modes, model resolution, tool allowlists, prompt rewrite | on |
| [`mmr-toolbox`](src/extensions/mmr-toolbox/README.md) | `apply_patch` and session-local `task_list` | on |
| [`mmr-subagents`](src/extensions/mmr-subagents/README.md) | `finder`, `oracle`, `Task`, `librarian` workers | on |
| [`mmr-session-fallback`](src/extensions/mmr-session-fallback/README.md) | Interactive fallback on subscription-route quota/rate-limit errors | on |
| [`mmr-web`](src/extensions/mmr-web/README.md) | `web_search` and `read_web_page` (SearXNG / Brave / DuckDuckGo) | off |
| [`mmr-history`](src/extensions/mmr-history/README.md) | `find_session` / `read_session` over local Pi sessions | off |

## Where to go next

| Need                              | Read                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------- |
| Pick or debug a mode              | [`src/extensions/mmr-core/README.md`](src/extensions/mmr-core/README.md)      |
| Use patch and todo tools          | [`src/extensions/mmr-toolbox/README.md`](src/extensions/mmr-toolbox/README.md) |
| Use workers and subagents         | [`src/extensions/mmr-subagents/README.md`](src/extensions/mmr-subagents/README.md) |
| Enable web search and page reads  | [`src/extensions/mmr-web/README.md`](src/extensions/mmr-web/README.md)        |
| Search and read prior sessions    | [`src/extensions/mmr-history/README.md`](src/extensions/mmr-history/README.md) |
| Understand exports                | [`docs/public-api.md`](docs/public-api.md)                                    |
| Understand the architecture       | [`docs/reference-architecture.md`](docs/reference-architecture.md)            |
| Plan changes / roadmap            | [`ROADMAP.md`](ROADMAP.md)                                                    |
| Write or review docs              | [`docs/documentation-style-guide.md`](docs/documentation-style-guide.md)      |

## Install

`pi-mmr` is a Pi package, not an npm app. Pi must already be installed and authenticated.

```bash
pi -e git:github.com/5omeOtherGuy/pi-mmr --mmr-mode smart   # one-shot, no install
pi install git:github.com/5omeOtherGuy/pi-mmr               # global install
pi install -l git:github.com/5omeOtherGuy/pi-mmr            # project install
```

Pi (`@earendil-works/pi-coding-agent`) and `@earendil-works/pi-agent-core` are declared as `peerDependencies` and are not bundled.

To enable network tools, see [Enabling `mmr-web`](src/extensions/mmr-web/README.md#configuration). To enable local session lookup, set `MMR_HISTORY_ENABLE=true`.

## Modes

A mode is a locked routing profile: model preference list, request thinking / max-output policy, context profile, active-tool allowlist, and an MMR-owned prompt block.

| Mode       | Intent                              | Model-family fallback                                              | Tool intent              |
| ---------- | ----------------------------------- | ------------------------------------------------------------------ | ------------------------ |
| `smart`    | Default balanced coding             | `claude-opus-4-8` → `gpt-5.5`                                      | standard locked-mode set |
| `smartGPT` | Smart routed through GPT            | `gpt-5.5`                                                          | standard locked-mode set |
| `rush`     | Fast, low-token turns               | `gpt-5.5` → `claude-haiku-4-5-20251001` → `claude-haiku-4-5`       | rush-specific set        |
| `large`    | Long-context work                   | `claude-opus-4-6` → `gpt-5.4`                                      | standard locked-mode set |
| `deep`     | Hard reasoning, planning, review    | `gpt-5.5` → `claude-opus-4-8`                                      | deep-specific set        |
| `free`     | Pi as if `pi-mmr` were not installed | baseline Pi model restored                                        | baseline minus pi-mmr-owned tools |

Per-mode request policy, context profiles, and tool-set details: [`src/extensions/mmr-core/README.md`](src/extensions/mmr-core/README.md).

- *Provider expansion.* `claude-*` → `claude-subscription`, `anthropic`; `gpt-*` → `openai-codex`, `github-copilot`, `openai`, `azure-openai-responses`; `gemini-*` / `gemma-*` → `google`, `google-vertex`. Subscription/OAuth-backed routes sort first, then API-key, then other.
- *Tool resolution is exact-name only.* No alias or tool fallback. Tools resolve as `active`, `gated`, `disabled`, `deferred`, or `missing`; only `active` reaches Pi.
- *Free mode* drops only `pi-mmr`-owned tool registrations; third-party tools with the same name keep working.
- *Fail-closed.* Zero active tools or no usable model in a locked mode aborts activation before mutating Pi state.

### Selecting a mode

Precedence: `--mmr-mode` flag → persisted session → `mmrCore.defaultMode` → `smart`.

```text
pi --mmr-mode rush

/mode              # show current
/mode deep         # switch
/mode free         # release locks
/mmr-status        # routing state (add `debug` for the full dump)
Ctrl+Shift+S       # mode picker  (Alt+M fallback)
Ctrl+Space         # cycle smart → smartGPT → rush → large → deep
```

## Settings

Read from `~/.pi/agent/settings.json` (global) and `<project>/.pi/settings.json` (project). Both flat (`mmrCore`, `mmrWeb`) and nested (`mmr.core`, `mmr.web`) forms are accepted.

```json
{
  "mmrCore": {
    "defaultMode": "rush",
    "modelPreferences": {
      "deep": [{ "model": "gpt-5.5", "thinkingLevel": "medium" }]
    },
    "subagentModelPreferences": {
      "finder": [{ "model": "gpt-5.4-mini", "thinkingLevel": "low" }]
    }
  },
  "mmrWeb": { "enabled": true, "searxngUrl": "http://127.0.0.1:8080" }
}
```

```bash
export BRAVE_API_KEY="brv_xxx"   # env-only; never put in settings.json
```

`subagentModelPreferences` keys: `finder`, `oracle`, `librarian`, `history-reader`, `task-subagent`. Legacy `mmrCore.toolAliases` is deprecated and ignored. Full `mmrWeb.*` reference: [`src/extensions/mmr-web/README.md`](src/extensions/mmr-web/README.md#configuration).

## Troubleshooting

Run `/mmr-status` (or `/mmr-status debug`). Common cases:

- `Model applied: no` → see Debug `Model candidates:` for per-candidate `registered/authenticated/applied` flags. Usually unregistered/unauthenticated provider, or Pi-side `setModel` rejection.
- Mode flipped to Free → native `/model` or `/think` while locked auto-switches with a warning. Re-enter `/mode <key>`.
- Tool `gated` / `deferred` → owning extension is not loaded or enabled (`librarian` needs active `mmr-web` tools).
- Locked mode refused to activate → resolved zero active tools; inspect `Tool decisions:`.

Full field reference: [`src/extensions/mmr-core/README.md`](src/extensions/mmr-core/README.md#diagnostics--mmr-status).

## Development

```bash
npm test               # node --test tests/*.test.mjs
npm run check          # tsc --noEmit
npm run pack:dry-run
```

Tests are deterministic and must not make live provider/API calls. Entry points: [`INDEX.md`](INDEX.md), [`REPOMAP.md`](REPOMAP.md), [`AGENTS.md`](AGENTS.md). Documentation conventions: [`docs/documentation-style-guide.md`](docs/documentation-style-guide.md).

## License

[MIT](LICENSE).
