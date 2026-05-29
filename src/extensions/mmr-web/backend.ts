import type { MmrWebSettings } from "./config.js";
import { createCustomReader, type CustomReaderOptions } from "./reader/direct.js";
import type { ReaderBackend } from "./reader/types.js";
import { createBraveSearchBackend, type BraveSearchOptions } from "./search/brave.js";
import { createDuckDuckGoSearchBackend, type DuckDuckGoSearchOptions } from "./search/duckduckgo.js";
import { createSearXNGSearchBackend, type SearXNGSearchOptions } from "./search/searxng.js";
import type { SearchBackend } from "./search/types.js";

/**
 * Concrete execution path for a single `web_search` / `read_web_page`
 * invocation.
 *
 * The full union covers every `mmr-web` backend:
 *
 *   - `brave`      — Brave Search via API key.
 *   - `searxng`    — User-configured SearXNG instance.
 *   - `duckduckgo` — Built-in no-key HTML/lite fallback.
 *   - `custom`     — `mmr-web`'s in-process direct page reader.
 */
export type ResolvedBackend = "brave" | "searxng" | "duckduckgo" | "custom";

export type ResolvedTool = "web_search" | "read_web_page";

export interface BackendDecision {
  /** The chosen backend, or `undefined` when network access is disabled. */
  backend?: ResolvedBackend;
  /** Stable code used in `/mmr-status` reasons and provider diagnostics. */
  reason: "ok" | "disabled";
  /** Human-readable explanation suitable for `/mmr-status` rows. */
  message: string;
}

/**
 * Pick the active `web_search` backend from settings.
 *
 * - Explicit `searchBackend` (or the shared `backend` field when it is not
 *   `"auto"`) wins. `"searxng"`, `"brave"`, and `"duckduckgo"` route to the
 *   named backend even when their required configuration is missing;
 *   execution surfaces the specific setup error.
 * - `"auto"` (the default) prefers, in order:
 *     1. `searxng` when `searxngUrl` is set.
 *     2. `brave` when `BRAVE_API_KEY` is set.
 *     3. `duckduckgo` as a built-in no-key fallback (best-effort, may be
 *        rate-limited or bot-blocked).
 */
function pickSearchBackend(settings: MmrWebSettings): { backend: ResolvedBackend; message: string } {
  const explicit = settings.searchBackend ?? settings.backend;
  if (explicit === "searxng") {
    return {
      backend: "searxng",
      message: settings.searxngUrl
        ? `Active backend: SearXNG (${settings.searxngUrl}).`
        : "Active backend: SearXNG (no searxngUrl configured; web_search calls will ask you to set MMR_WEB_SEARXNG_URL).",
    };
  }
  if (explicit === "brave") {
    return {
      backend: "brave",
      message: settings.braveApiKey
        ? "Active backend: Brave Search."
        : "Active backend: Brave Search (BRAVE_API_KEY is not configured; web_search calls will ask you to set BRAVE_API_KEY).",
    };
  }
  if (explicit === "duckduckgo") {
    return {
      backend: "duckduckgo",
      message: "Active backend: DuckDuckGo HTML (no-key fallback; best-effort, may be rate-limited).",
    };
  }
  // explicit === "auto" (or undefined)
  if (settings.searxngUrl) {
    return {
      backend: "searxng",
      message: `Active backend: SearXNG (auto; ${settings.searxngUrl}).`,
    };
  }
  if (settings.braveApiKey) {
    return {
      backend: "brave",
      message: "Active backend: Brave Search (auto; BRAVE_API_KEY is configured).",
    };
  }
  return {
    backend: "duckduckgo",
    message: "Active backend: DuckDuckGo HTML (auto fallback; no key required, best-effort). Configure MMR_WEB_SEARXNG_URL or BRAVE_API_KEY for higher reliability.",
  };
}

/**
 * Resolve which concrete execution path should service a `web_search` or
 * `read_web_page` call given the current settings.
 *
 * - `web_search`: SearXNG when configured, otherwise Brave (see
 *   {@link pickSearchBackend}). A missing key/URL does not hide the tool;
 *   execution reports a direct setup error.
 * - `read_web_page`: mmr-web's custom direct reader only. It requires
 *   network access but no provider API key.
 */
export function resolveBackend(tool: ResolvedTool, settings: MmrWebSettings): BackendDecision {
  if (!settings.enabled) {
    return {
      reason: "disabled",
      message: "mmr-web network access is disabled (set MMR_WEB_ENABLE=true to enable).",
    };
  }

  if (tool === "web_search") {
    const picked = pickSearchBackend(settings);
    return { backend: picked.backend, reason: "ok", message: picked.message };
  }

  return {
    backend: "custom",
    reason: "ok",
    message: "Active backend: custom in-process reader.",
  };
}

/**
 * Combined client overrides accepted by {@link getSearchBackend}. Each
 * field is optional and used only by the backend that needs it.
 */
export interface SearchClientOverrides {
  fetchImpl?: typeof fetch;
  userAgent?: string;
  /** Override the Brave search endpoint (tests). */
  searchBase?: string;
  /**
   * Optional pre-search hook used by the SearXNG backend when the managed
   * sidecar is enabled. Wired in `index.ts` based on settings; tests can
   * stub directly to verify the spawn-before-search ordering.
   */
  searxngEnsureRunning?: () => Promise<void>;
  /** Optional post-search hook used by the managed sidecar to reset the idle timer. */
  searxngNoteUse?: () => void;
}

/**
 * Build the {@link SearchBackend} that should service `web_search` given
 * the current settings. Returns `undefined` when network access is
 * disabled. Throws when SearXNG is selected without a configured instance
 * URL, or when the resolved id is not a valid search backend.
 */
export function getSearchBackend(
  settings: MmrWebSettings,
  overrides: SearchClientOverrides = {},
): SearchBackend | undefined {
  const decision = resolveBackend("web_search", settings);
  if (!decision.backend) return undefined;
  switch (decision.backend) {
    case "brave": {
      const opts: BraveSearchOptions = { apiKey: settings.braveApiKey };
      if (overrides.fetchImpl !== undefined) opts.fetchImpl = overrides.fetchImpl;
      if (overrides.userAgent !== undefined) opts.userAgent = overrides.userAgent;
      if (overrides.searchBase !== undefined) opts.searchBase = overrides.searchBase;
      return createBraveSearchBackend(opts);
    }
    case "searxng": {
      const url = settings.searxngUrl ?? "";
      if (!url) {
        throw new Error(
          "web_search via SearXNG requires a SearXNG instance URL. Set the MMR_WEB_SEARXNG_URL environment variable (or mmrWeb.searxngUrl in your settings file) to the base URL of a running SearXNG instance with JSON output enabled.",
        );
      }
      const opts: SearXNGSearchOptions = { url };
      if (overrides.fetchImpl !== undefined) opts.fetchImpl = overrides.fetchImpl;
      if (overrides.userAgent !== undefined) opts.userAgent = overrides.userAgent;
      if (overrides.searxngEnsureRunning !== undefined) opts.ensureRunning = overrides.searxngEnsureRunning;
      if (overrides.searxngNoteUse !== undefined) opts.noteUse = overrides.searxngNoteUse;
      return createSearXNGSearchBackend(opts);
    }
    case "duckduckgo": {
      const opts: DuckDuckGoSearchOptions = {};
      if (overrides.fetchImpl !== undefined) opts.fetchImpl = overrides.fetchImpl;
      if (overrides.userAgent !== undefined) opts.userAgent = overrides.userAgent;
      return createDuckDuckGoSearchBackend(opts);
    }
    default:
      // `custom` is not a valid search backend; treat as unreachable.
      throw new Error(`mmr-web: invalid search backend "${decision.backend}".`);
  }
}

/**
 * Build the {@link ReaderBackend} that should service `read_web_page`.
 * Returns `undefined` when network access is disabled.
 */
export function getReader(
  settings: MmrWebSettings,
  options: CustomReaderOptions = {},
): ReaderBackend | undefined {
  const decision = resolveBackend("read_web_page", settings);
  if (!decision.backend) return undefined;
  if (decision.backend !== "custom") {
    throw new Error(`mmr-web: invalid reader backend "${decision.backend}".`);
  }
  return createCustomReader(options);
}
