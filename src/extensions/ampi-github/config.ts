import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseBoolEnv, readFirstPresentEnv, readPreferredEnv } from "../ampi-core/internal/env.js";
import { isRecord } from "../ampi-core/internal/json.js";

/**
 * Settings for the `ampi-github` extension.
 *
 * `ampi-github` ships read-only GitHub repository tools used primarily by the
 * `librarian` subagent. Like `ampi-web`, network access is opt-in: the
 * `enabled` master switch defaults to `false` so a fresh install never makes
 * outbound GitHub calls without explicit user opt-in.
 */
export interface MmrGithubSettings {
  /** Network access master switch. Off by default; opt-in per the extension policy. */
  enabled: boolean;
  /**
   * Optional GitHub API token. Loaded from the first present environment
   * variable in precedence order: `AMPI_GITHUB_TOKEN` (preferred), legacy
   * `MMR_GITHUB_TOKEN`, then the ecosystem-standard `GITHUB_TOKEN`,
   * `GH_TOKEN` (gh CLI), and `GITHUB_PERSONAL_ACCESS_TOKEN`. Never read from
   * settings files, which are commonly committed or synced and would leak
   * the secret. Unauthenticated requests are permitted for public endpoints
   * but are subject to GitHub's strict anonymous rate limits, and the code
   * search API requires a token.
   */
  token?: string;
  /**
   * Base URL for the GitHub REST API. Defaults to `https://api.github.com`.
   * Overridable via `MMR_GITHUB_API_URL` (primarily for deterministic tests;
   * GitHub Enterprise Server is not a supported target in this slice).
   */
  apiBaseUrl: string;
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs: number;
  /** Hard cap on bytes read from any single GitHub response body. */
  maxResultBytes: number;
}

export interface LoadedMmrGithubSettings {
  settings: MmrGithubSettings;
  filesRead: string[];
  warnings: string[];
}

export const AMPI_GITHUB_ENABLE_ENV = "AMPI_GITHUB_ENABLE";
/** Legacy env alias accepted while callers migrate. */
export const MMR_GITHUB_ENABLE_ENV = "MMR_GITHUB_ENABLE";
export const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
export const DEFAULT_GITHUB_TIMEOUT_MS = 30_000;
export const DEFAULT_GITHUB_MAX_RESULT_BYTES = 200_000;

function readJsonFile(filePath: string): { value?: unknown; warning?: string } {
  if (!existsSync(filePath)) return {};
  try {
    return { value: JSON.parse(readFileSync(filePath, "utf8")) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { warning: `Could not read MMR GitHub settings from ${filePath}: ${message}` };
  }
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

/** Remove trailing `/` characters without an unanchored-quantifier regex. */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end--;
  return value.slice(0, end);
}

function normalizeApiBaseUrl(value: string): string {
  return stripTrailingSlashes(value.trim());
}

interface ExtractedMmrGithubSettings {
  rootKey: string;
  values: Partial<MmrGithubSettings>;
  hasToken: boolean;
  invalidApiBaseUrl?: string;
}

function selectGithubSettingsBlock(value: Record<string, unknown>): { raw: Record<string, unknown>; rootKey: string } | undefined {
  const ampiDirect = isRecord(value.ampiGithub) ? value.ampiGithub : undefined;
  if (ampiDirect) return { raw: ampiDirect, rootKey: "ampiGithub" };
  const ampiNested = isRecord(value.ampi) && isRecord((value.ampi as Record<string, unknown>).github)
    ? ((value.ampi as Record<string, unknown>).github as Record<string, unknown>)
    : undefined;
  if (ampiNested) return { raw: ampiNested, rootKey: "ampi.github" };
  const legacyDirect = isRecord(value.mmrGithub) ? value.mmrGithub : undefined;
  if (legacyDirect) return { raw: legacyDirect, rootKey: "mmrGithub" };
  const legacyNested = isRecord(value.mmr) && isRecord((value.mmr as Record<string, unknown>).github)
    ? ((value.mmr as Record<string, unknown>).github as Record<string, unknown>)
    : undefined;
  return legacyNested ? { raw: legacyNested, rootKey: "mmr.github" } : undefined;
}

function extractMmrGithubSettings(value: unknown): ExtractedMmrGithubSettings | undefined {
  if (!isRecord(value)) return undefined;
  const selected = selectGithubSettingsBlock(value);
  if (!selected) return undefined;
  const { raw, rootKey } = selected;

  const out: Partial<MmrGithubSettings> = {};
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (typeof raw.requestTimeoutMs === "number" && raw.requestTimeoutMs > 0) {
    out.requestTimeoutMs = Math.floor(raw.requestTimeoutMs);
  }
  if (typeof raw.maxResultBytes === "number" && raw.maxResultBytes > 0) {
    out.maxResultBytes = Math.floor(raw.maxResultBytes);
  }

  let invalidApiBaseUrl: string | undefined;
  if (typeof raw.apiBaseUrl === "string") {
    const trimmed = raw.apiBaseUrl.trim();
    if (trimmed) {
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          out.apiBaseUrl = normalizeApiBaseUrl(trimmed);
        } else {
          invalidApiBaseUrl = trimmed;
        }
      } catch {
        invalidApiBaseUrl = trimmed;
      }
    }
  }

  // Tokens are intentionally NOT read from settings files: settings files are
  // commonly committed to repositories or synced across machines, and the
  // token is a secret. Warn on string values so users can remove a persisted
  // secret and move it to the environment.
  const hasToken = typeof raw.token === "string";

  return {
    rootKey,
    values: out,
    hasToken,
    ...(invalidApiBaseUrl !== undefined ? { invalidApiBaseUrl } : {}),
  };
}

/**
 * Load `ampi-github` settings from the standard MMR settings files (global
 * home + project) and overlay environment variables. Order: home file →
 * project file → environment, latest source wins per field. Default is fully
 * off so a fresh install never makes outbound GitHub calls without explicit
 * user opt-in.
 */
export function loadMmrGithubSettings(
  cwd: string,
  options: { homeDirectory?: string; env?: NodeJS.ProcessEnv } = {},
): LoadedMmrGithubSettings {
  const homeDirectory = options.homeDirectory ?? homedir();
  const env = options.env ?? process.env;

  const files = [
    path.join(homeDirectory, ".pi/agent/settings.json"),
    path.join(cwd, ".pi/settings.json"),
  ];
  const filesRead: string[] = [];
  const warnings: string[] = [];
  let merged: Partial<MmrGithubSettings> = {};

  for (const filePath of files) {
    const { value, warning } = readJsonFile(filePath);
    if (warning) {
      warnings.push(warning);
      continue;
    }
    if (!value) continue;
    filesRead.push(filePath);
    const extracted = extractMmrGithubSettings(value);
    if (!extracted) continue;
    merged = { ...merged, ...extracted.values };
    if (extracted.hasToken) {
      warnings.push(
        `Ignoring ${extracted.rootKey}.token in ${filePath}: the GitHub token must come from an environment variable (AMPI_GITHUB_TOKEN, MMR_GITHUB_TOKEN, GITHUB_TOKEN, GH_TOKEN, or GITHUB_PERSONAL_ACCESS_TOKEN), not from settings files (which are commonly committed or synced).`,
      );
    }
    if (extracted.invalidApiBaseUrl !== undefined) {
      warnings.push(
        `Ignoring ${extracted.rootKey}.apiBaseUrl="${extracted.invalidApiBaseUrl}" in ${filePath}: expected a http(s) URL.`,
      );
    }
  }

  const enableEnv = parseBoolEnv(readPreferredEnv(env, AMPI_GITHUB_ENABLE_ENV, MMR_GITHUB_ENABLE_ENV)?.value);
  if (enableEnv !== undefined) merged.enabled = enableEnv;

  const tokenEnv = readFirstPresentEnv(
    env,
    "AMPI_GITHUB_TOKEN",
    "MMR_GITHUB_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_PERSONAL_ACCESS_TOKEN",
  )?.value;
  if (typeof tokenEnv === "string" && tokenEnv.trim()) {
    merged.token = tokenEnv.trim();
  }

  const apiUrlEnv = readPreferredEnv(env, "AMPI_GITHUB_API_URL", "MMR_GITHUB_API_URL");
  if (apiUrlEnv) {
    const trimmed = apiUrlEnv.value.trim();
    if (trimmed) {
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          merged.apiBaseUrl = normalizeApiBaseUrl(trimmed);
        } else {
          warnings.push(`Ignoring ${apiUrlEnv.name}="${apiUrlEnv.value}": expected a http(s) URL.`);
        }
      } catch {
        warnings.push(`Ignoring ${apiUrlEnv.name}="${apiUrlEnv.value}": expected a http(s) URL.`);
      }
    }
  }

  const timeout = parsePositiveInt(readPreferredEnv(env, "AMPI_GITHUB_TIMEOUT_MS", "MMR_GITHUB_TIMEOUT_MS")?.value);
  if (timeout) merged.requestTimeoutMs = timeout;
  const maxBytes = parsePositiveInt(readPreferredEnv(env, "AMPI_GITHUB_MAX_RESULT_BYTES", "MMR_GITHUB_MAX_RESULT_BYTES")?.value);
  if (maxBytes) merged.maxResultBytes = maxBytes;

  const settings: MmrGithubSettings = {
    enabled: merged.enabled ?? false,
    token: merged.token,
    apiBaseUrl: merged.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL,
    requestTimeoutMs: merged.requestTimeoutMs ?? DEFAULT_GITHUB_TIMEOUT_MS,
    maxResultBytes: merged.maxResultBytes ?? DEFAULT_GITHUB_MAX_RESULT_BYTES,
  };

  return { settings, filesRead, warnings };
}
