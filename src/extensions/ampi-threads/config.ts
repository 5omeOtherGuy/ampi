import { homedir } from "node:os";
import path from "node:path";
import { parseBoolEnv, readPreferredEnv } from "../ampi-core/internal/env.js";
import { isRecord } from "../ampi-core/internal/json.js";
import { readJsonSettingsFile } from "../ampi-core/internal/settings-file.js";

export interface MmrThreadsSettings {
  /** Whether `ampi-threads` loads. On by default. */
  enabled: boolean;
  /** Archive the session when you quit Pi from the terminal. Off by default. */
  autoArchiveOnQuit: boolean;
}

function readBlock(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.ampiThreads)) return value.ampiThreads;
  return isRecord(value.ampi) && isRecord(value.ampi.threads) ? value.ampi.threads : undefined;
}

function readBoolean(block: Record<string, unknown> | undefined, key: string): boolean | undefined {
  return typeof block?.[key] === "boolean" ? block[key] : undefined;
}

/**
 * Load `ampi-threads` settings: `ampiThreads.enabled` and
 * `ampiThreads.autoArchiveOnQuit` (or the nested `ampi.threads.*` form) from
 * the global `~/.pi/agent/settings.json`, then the project
 * `<cwd>/.pi/settings.json`, then `AMPI_THREADS_ENABLE` (legacy
 * `MMR_THREADS_ENABLE`) for `enabled`. The latest source wins. A settings
 * file that cannot be read is skipped; `ampi-core` already reports it in
 * `/ampi-status`.
 */
export function loadMmrThreadsSettings(
  cwd: string,
  options: { homeDirectory?: string; env?: NodeJS.ProcessEnv } = {},
): MmrThreadsSettings {
  const homeDirectory = options.homeDirectory ?? homedir();
  const env = options.env ?? process.env;
  let enabled = true;
  let autoArchiveOnQuit = false;

  for (const filePath of [path.join(homeDirectory, ".pi/agent/settings.json"), path.join(cwd, ".pi/settings.json")]) {
    let block: Record<string, unknown> | undefined;
    try {
      block = readBlock(readJsonSettingsFile(filePath));
    } catch {
      continue;
    }
    enabled = readBoolean(block, "enabled") ?? enabled;
    autoArchiveOnQuit = readBoolean(block, "autoArchiveOnQuit") ?? autoArchiveOnQuit;
  }

  enabled = parseBoolEnv(readPreferredEnv(env, "AMPI_THREADS_ENABLE", "MMR_THREADS_ENABLE")?.value) ?? enabled;
  return { enabled, autoArchiveOnQuit };
}
