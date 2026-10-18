import { homedir } from "node:os";
import path from "node:path";
import { parseBoolEnv, readPreferredEnv } from "../ampi-core/internal/env.js";
import { isRecord } from "../ampi-core/internal/json.js";
import { readJsonSettingsFile } from "../ampi-core/internal/settings-file.js";

export interface MmrTuiSettings {
  /** Whether `ampi-tui` takes over ampi's terminal chrome. On by default. */
  enabled: boolean;
}

function readEnabled(value: unknown): boolean | undefined {
  if (!isRecord(value)) return undefined;
  const block = isRecord(value.ampiTui)
    ? value.ampiTui
    : isRecord(value.ampi) && isRecord(value.ampi.tui)
      ? value.ampi.tui
      : undefined;
  return typeof block?.enabled === "boolean" ? block.enabled : undefined;
}

/**
 * Load `ampi-tui` settings: `ampiTui.enabled` (or nested `ampi.tui.enabled`)
 * from the global `~/.pi/agent/settings.json`, then the project
 * `<cwd>/.pi/settings.json`, then `AMPI_TUI_ENABLE` (legacy `MMR_TUI_ENABLE`).
 * The latest source wins. A settings file that cannot be read is skipped;
 * `ampi-core` already reports it in `/ampi-status`.
 */
export function loadMmrTuiSettings(
  cwd: string,
  options: { homeDirectory?: string; env?: NodeJS.ProcessEnv } = {},
): MmrTuiSettings {
  const homeDirectory = options.homeDirectory ?? homedir();
  const env = options.env ?? process.env;
  let enabled = true;

  for (const filePath of [path.join(homeDirectory, ".pi/agent/settings.json"), path.join(cwd, ".pi/settings.json")]) {
    let value: unknown;
    try {
      value = readJsonSettingsFile(filePath);
    } catch {
      continue;
    }
    enabled = readEnabled(value) ?? enabled;
  }

  enabled = parseBoolEnv(readPreferredEnv(env, "AMPI_TUI_ENABLE", "MMR_TUI_ENABLE")?.value) ?? enabled;
  return { enabled };
}
