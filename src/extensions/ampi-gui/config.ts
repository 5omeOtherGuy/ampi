import { homedir } from "node:os";
import path from "node:path";
import { parseBoolEnv } from "../ampi-core/internal/env.js";
import { isRecord } from "../ampi-core/internal/json.js";
import { readJsonSettingsFile } from "../ampi-core/internal/settings-file.js";

export interface MmrGuiSettings {
  /** Whether `ampi-gui` serves the local web GUI. Off by default. */
  enabled: boolean;
}

/** The `ampiGui` block, or the nested `ampi.gui` one. */
function readBlock(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.ampiGui)) return value.ampiGui;
  return isRecord(value.ampi) && isRecord(value.ampi.gui) ? value.ampi.gui : undefined;
}

/**
 * Load `ampi-gui` settings: `ampiGui.enabled` (or the nested
 * `ampi.gui.enabled`) from the global `~/.pi/agent/settings.json`, then the
 * project `<cwd>/.pi/settings.json`, then `AMPI_GUI_ENABLE`. The latest
 * source wins. A settings file that cannot be read is skipped; `ampi-core`
 * already reports it in `/ampi-status`.
 */
export function loadMmrGuiSettings(cwd: string, options: { homeDirectory?: string; env?: NodeJS.ProcessEnv } = {}): MmrGuiSettings {
  const homeDirectory = options.homeDirectory ?? homedir();
  const env = options.env ?? process.env;
  let enabled = false;

  for (const filePath of [path.join(homeDirectory, ".pi/agent/settings.json"), path.join(cwd, ".pi/settings.json")]) {
    let block: Record<string, unknown> | undefined;
    try {
      block = readBlock(readJsonSettingsFile(filePath));
    } catch {
      continue;
    }
    if (typeof block?.enabled === "boolean") enabled = block.enabled;
  }

  enabled = parseBoolEnv(env.AMPI_GUI_ENABLE) ?? enabled;
  return { enabled };
}
