import { homedir } from "node:os";
import path from "node:path";
import { parseBoolEnv, readPreferredEnv } from "../ampi-core/internal/env.js";
import { isRecord } from "../ampi-core/internal/json.js";
import { readJsonSettingsFile } from "../ampi-core/internal/settings-file.js";

export interface MmrShellSettings {
  /** Whether `ampi-shell` loads. On by default. */
  enabled: boolean;
  /** How long `shell_command` waits for a command to end before leaving it in the background. */
  backgroundAfterMs: number;
  /** How many commands may run in the background at once, per session. */
  maxBackground: number;
}

export const MMR_SHELL_DEFAULTS: Readonly<MmrShellSettings> = Object.freeze({
  enabled: true,
  backgroundAfterMs: 30_000,
  maxBackground: 8,
});

function readBlock(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.ampiShell)) return value.ampiShell;
  return isRecord(value.ampi) && isRecord(value.ampi.shell) ? value.ampi.shell : undefined;
}

/** A whole number at least `min`, or undefined for anything else. */
function readCount(block: Record<string, unknown> | undefined, key: string, min: number): number | undefined {
  const value = block?.[key];
  return typeof value === "number" && Number.isInteger(value) && value >= min ? value : undefined;
}

/**
 * Load `ampi-shell` settings: `ampiShell.enabled`,
 * `ampiShell.backgroundAfterMs` and `ampiShell.maxBackground` (or the nested
 * `ampi.shell.*` form) from the global `~/.pi/agent/settings.json`, then the
 * project `<cwd>/.pi/settings.json`, then `AMPI_SHELL_ENABLE` (legacy
 * `MMR_SHELL_ENABLE`) for `enabled`. The latest source wins. Values of the
 * wrong type are ignored. A settings file that cannot be read is skipped;
 * `ampi-core` already reports it in `/ampi-status`.
 */
export function loadMmrShellSettings(
  cwd: string,
  options: { homeDirectory?: string; env?: NodeJS.ProcessEnv } = {},
): MmrShellSettings {
  const homeDirectory = options.homeDirectory ?? homedir();
  const env = options.env ?? process.env;
  const settings: MmrShellSettings = { ...MMR_SHELL_DEFAULTS };

  for (const filePath of [path.join(homeDirectory, ".pi/agent/settings.json"), path.join(cwd, ".pi/settings.json")]) {
    let block: Record<string, unknown> | undefined;
    try {
      block = readBlock(readJsonSettingsFile(filePath));
    } catch {
      continue;
    }
    if (typeof block?.enabled === "boolean") settings.enabled = block.enabled;
    settings.backgroundAfterMs = readCount(block, "backgroundAfterMs", 0) ?? settings.backgroundAfterMs;
    settings.maxBackground = readCount(block, "maxBackground", 1) ?? settings.maxBackground;
  }

  settings.enabled = parseBoolEnv(readPreferredEnv(env, "AMPI_SHELL_ENABLE", "MMR_SHELL_ENABLE")?.value) ?? settings.enabled;
  return settings;
}
