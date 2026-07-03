import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getProjectMmrSettingsPath } from "../ampi-core/config-writer.js";
import {
  DEFAULT_MAX_RESULT_BYTES,
  DEFAULT_SEARXNG_IDLE_TIMEOUT_MS,
  DEFAULT_SEARXNG_START_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  loadMmrWebSettings,
  type MmrWebBackend,
  type MmrWebSettings,
} from "./config.js";
import { type MmrWebConfigUpdate, writeMmrWebConfigFile } from "./config-writer.js";

const CLEAR_LABEL = "— clear (use default) —";
const CANCEL_LABEL = "— cancel —";
const BACKEND_OPTIONS: readonly string[] = ["auto", "brave", "searxng", "duckduckgo", CLEAR_LABEL, CANCEL_LABEL];
const BOOLEAN_OPTIONS: readonly string[] = ["true (enable)", "false (disable)", CLEAR_LABEL, CANCEL_LABEL];

function describeKey(name: string, present: boolean): string {
  return present ? `${name}: set` : `${name}: not set`;
}

function describeBackend(value: MmrWebBackend | undefined, fallback?: MmrWebBackend): string {
  if (value === undefined) return fallback ? `(unset; uses ${fallback})` : "(unset)";
  return value;
}

function formatCurrentConfig(settings: MmrWebSettings, filePath: string): string {
  const startCmdShape = settings.searxngStartCommand
    ? `set (${settings.searxngStartCommand.length} args)`
    : "(unset)";
  const stopCmdShape = settings.searxngStopCommand
    ? `set (${settings.searxngStopCommand.length} args)`
    : "(unset; SIGTERM fallback only if the start process is still alive)";
  return [
    `Current ampi-web configuration (persists to ${filePath}):`,
    `  enabled:                  ${settings.enabled}`,
    `  backend:                  ${settings.backend}`,
    `  searchBackend:            ${describeBackend(settings.searchBackend, settings.backend)}`,
    `  readerBackend (legacy/no-op): ${describeBackend(settings.readerBackend, settings.backend)}; read_web_page always uses the custom reader`,
    `  searxngUrl:               ${settings.searxngUrl ?? "(unset)"}`,
    `  searchTimeoutMs:          ${settings.searchTimeoutMs}`,
    `  readTimeoutMs:            ${settings.readTimeoutMs}`,
    `  maxResultBytes:           ${settings.maxResultBytes}`,
    "",
    "Managed SearXNG sidecar (opt-in):",
    `  searxngManaged:           ${settings.searxngManaged}`,
    `  searxngStartCommand:      ${startCmdShape}`,
    `  searxngStopCommand:       ${stopCmdShape}`,
    `  searxngHealthUrl:         ${settings.searxngHealthUrl ?? "(derived from searxngUrl)"}`,
    `  searxngIdleTimeoutMs:     ${settings.searxngIdleTimeoutMs}`,
    `  searxngStartTimeoutMs:    ${settings.searxngStartTimeoutMs}`,
    "",
    "API keys (loaded from environment only; never read from settings files):",
    `  ${describeKey("BRAVE_API_KEY", Boolean(settings.braveApiKey))}`,
  ].join("\n");
}

async function pickBackendValue(
  ctx: ExtensionContext,
  title: string,
): Promise<MmrWebBackend | "clear" | undefined> {
  const choice = await ctx.ui.select(title, [...BACKEND_OPTIONS]);
  if (!choice || choice === CANCEL_LABEL) return undefined;
  if (choice === CLEAR_LABEL) return "clear";
  if (choice === "auto" || choice === "brave" || choice === "searxng" || choice === "duckduckgo") return choice;
  return undefined;
}

async function pickHttpUrlValue(
  ctx: ExtensionContext,
  title: string,
  placeholder: string,
): Promise<string | "clear" | undefined> {
  const raw = await ctx.ui.input(title, placeholder);
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (trimmed.toLowerCase() === "clear") return "clear";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    ctx.ui.notify(`Expected a http(s) URL or "clear", got ${JSON.stringify(raw)}.`, "error");
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    ctx.ui.notify(`Expected a http(s) URL, got scheme ${parsed.protocol}.`, "error");
    return undefined;
  }
  return trimmed;
}

async function pickBooleanValue(
  ctx: ExtensionContext,
  title: string,
): Promise<boolean | "clear" | undefined> {
  const choice = await ctx.ui.select(title, [...BOOLEAN_OPTIONS]);
  if (!choice || choice === CANCEL_LABEL) return undefined;
  if (choice === CLEAR_LABEL) return "clear";
  if (choice.startsWith("true")) return true;
  if (choice.startsWith("false")) return false;
  return undefined;
}

async function pickIntegerValue(
  ctx: ExtensionContext,
  title: string,
  placeholder: string,
  opts: { allowZero?: boolean } = {},
): Promise<number | "clear" | undefined> {
  const raw = await ctx.ui.input(title, placeholder);
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (trimmed.toLowerCase() === "clear") return "clear";
  const n = Number(trimmed);
  const min = opts.allowZero ? 0 : 1;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
    const label = opts.allowZero ? "a non-negative integer" : "a positive integer";
    ctx.ui.notify(`Expected ${label} or "clear", got ${JSON.stringify(raw)}.`, "error");
    return undefined;
  }
  return n;
}

/**
 * Interactive editor for `ampi-web` settings. Surfaced through the
 * `/ampi-config` slash command's "web" branch: pick a field, pick the new
 * value, and persist the change to project `<cwd>/.pi/settings.json` under
 * `mmrWeb` (or `mmr.web` if that layout is already in use).
 *
 * Settings are re-read from disk + env on entry so the menu reflects the
 * current state rather than the snapshot captured at extension load. API
 * keys (`BRAVE_API_KEY`) are not part of this editor: they remain env-only
 * and are surfaced only as a presence indicator in the "show current config"
 * view.
 *
 * Settings are sampled once at extension load, so every saved change takes
 * effect after restarting Pi. This includes fields that do not affect tool
 * registration, because runtime dependencies close over the startup snapshot.
 */
export async function runMmrWebConfigFlow(ctx: ExtensionContext): Promise<void> {
  if (ctx.hasUI === false) {
    ctx.ui.notify("ampi-web configuration requires an interactive UI.", "warning");
    return;
  }

  const settings = loadMmrWebSettings(ctx.cwd).settings;
  const filePath = getProjectMmrSettingsPath(ctx.cwd);

  const choice = await ctx.ui.select("ampi-web config: what do you want to set?", [
    "show current config",
    "enabled (network master switch)",
    "backend (shared)",
    "searchBackend (web_search only)",
    "searxngUrl (SearXNG instance URL)",
    "searxngManaged (opt-in sidecar)",
    "searxngHealthUrl (override sidecar health probe)",
    "searxngIdleTimeoutMs",
    "searxngStartTimeoutMs",
    "searchTimeoutMs",
    "readTimeoutMs",
    "maxResultBytes",
    CANCEL_LABEL,
  ]);
  if (!choice || choice === CANCEL_LABEL) return;

  if (choice === "show current config") {
    ctx.ui.notify(formatCurrentConfig(settings, filePath), "info");
    return;
  }

  let update: MmrWebConfigUpdate | undefined;
  if (choice.startsWith("enabled")) {
    const value = await pickBooleanValue(
      ctx,
      `enabled (currently ${settings.enabled}). Network is off by default; you must opt in.`,
    );
    if (value === undefined) return;
    update = { enabled: value };
  } else if (choice.startsWith("backend ")) {
    const value = await pickBackendValue(ctx, `backend (currently ${settings.backend})`);
    if (value === undefined) return;
    update = { backend: value };
  } else if (choice.startsWith("searchBackend")) {
    const value = await pickBackendValue(
      ctx,
      `searchBackend (currently ${describeBackend(settings.searchBackend, settings.backend)})`,
    );
    if (value === undefined) return;
    update = { searchBackend: value };
  } else if (choice.startsWith("searxngUrl")) {
    const value = await pickHttpUrlValue(
      ctx,
      `searxngUrl (currently ${settings.searxngUrl ?? "(unset)"}). Enter a http(s) URL (e.g. http://127.0.0.1:8080) or "clear".`,
      "http://127.0.0.1:8080",
    );
    if (value === undefined) return;
    update = { searxngUrl: value };
  } else if (choice.startsWith("searxngManaged")) {
    const value = await pickBooleanValue(
      ctx,
      `searxngManaged (currently ${settings.searxngManaged}). Setting this to true also requires mmrWeb.searxngStartCommand (and optionally searxngStopCommand) in the settings file — those fields are intentionally editor-excluded because they spawn arbitrary processes and must come from on-disk configuration only.`,
    );
    if (value === undefined) return;
    update = { searxngManaged: value };
  } else if (choice.startsWith("searxngHealthUrl")) {
    const value = await pickHttpUrlValue(
      ctx,
      `searxngHealthUrl (currently ${settings.searxngHealthUrl ?? "(derived from searxngUrl)"}). Enter a http(s) URL or "clear".`,
      "http://127.0.0.1:8080/search?q=ping&format=json",
    );
    if (value === undefined) return;
    update = { searxngHealthUrl: value };
  } else if (choice === "searxngIdleTimeoutMs") {
    const value = await pickIntegerValue(
      ctx,
      `searxngIdleTimeoutMs (currently ${settings.searxngIdleTimeoutMs}). Enter a non-negative integer (0 disables idle stop) or "clear" to restore the default.`,
      `default ${DEFAULT_SEARXNG_IDLE_TIMEOUT_MS}; 0 disables idle stop`,
      { allowZero: true },
    );
    if (value === undefined) return;
    update = { searxngIdleTimeoutMs: value };
  } else if (choice === "searxngStartTimeoutMs") {
    const value = await pickIntegerValue(
      ctx,
      `searxngStartTimeoutMs (currently ${settings.searxngStartTimeoutMs}). Enter a positive integer or "clear".`,
      `default ${DEFAULT_SEARXNG_START_TIMEOUT_MS}`,
    );
    if (value === undefined) return;
    update = { searxngStartTimeoutMs: value };
  } else if (choice === "searchTimeoutMs") {
    const value = await pickIntegerValue(
      ctx,
      `searchTimeoutMs (currently ${settings.searchTimeoutMs}). Enter a positive integer or "clear".`,
      `default ${DEFAULT_TIMEOUT_MS}`,
    );
    if (value === undefined) return;
    update = { searchTimeoutMs: value };
  } else if (choice === "readTimeoutMs") {
    const value = await pickIntegerValue(
      ctx,
      `readTimeoutMs (currently ${settings.readTimeoutMs}). Enter a positive integer or "clear".`,
      `default ${DEFAULT_TIMEOUT_MS}`,
    );
    if (value === undefined) return;
    update = { readTimeoutMs: value };
  } else if (choice === "maxResultBytes") {
    const value = await pickIntegerValue(
      ctx,
      `maxResultBytes (currently ${settings.maxResultBytes}). Enter a positive integer or "clear".`,
      `default ${DEFAULT_MAX_RESULT_BYTES}`,
    );
    if (value === undefined) return;
    update = { maxResultBytes: value };
  }

  if (!update) return;

  try {
    writeMmrWebConfigFile(filePath, update);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to write ampi-web config to ${filePath}: ${message}`, "error");
    return;
  }

  ctx.ui.notify(
    `Saved ampi-web config to ${filePath}.\nRestart Pi for the change to take effect; ampi-web samples settings once at extension load.`,
    "info",
  );
}
