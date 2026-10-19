import { homedir } from "node:os";
import path from "node:path";
import { parseBoolEnv, readPreferredEnv } from "../ampi-core/internal/env.js";
import { isRecord } from "../ampi-core/internal/json.js";
import { readJsonSettingsFile } from "../ampi-core/internal/settings-file.js";

export interface MmrPainterSettings {
  /** Whether `ampi-painter` offers `painter`. Off by default. */
  enabled: boolean;
  /** The image model to use, as `provider/id`; unset picks the first usable one. */
  model?: string;
}

export const MMR_PAINTER_DEFAULTS: Readonly<MmrPainterSettings> = Object.freeze({ enabled: false });

/** A `provider/id` pair, split at the first `/`: image model ids often hold slashes of their own. */
export interface MmrPainterModelRef {
  provider: string;
  id: string;
}

/** Split `provider/id` at the first `/`; undefined when either side is empty. */
export function parseMmrPainterModelRef(value: string): MmrPainterModelRef | undefined {
  const slash = value.indexOf("/");
  if (slash <= 0) return undefined;
  const provider = value.slice(0, slash).trim();
  const id = value.slice(slash + 1).trim();
  return provider !== "" && id !== "" ? { provider, id } : undefined;
}

function readBlock(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.ampiPainter)) return value.ampiPainter;
  return isRecord(value.ampi) && isRecord(value.ampi.painter) ? value.ampi.painter : undefined;
}

/**
 * Load `ampi-painter` settings: `ampiPainter.enabled` and `ampiPainter.model`
 * (or the nested `ampi.painter.*` form) from the global
 * `~/.pi/agent/settings.json`, then the project `<cwd>/.pi/settings.json`,
 * then `AMPI_PAINTER_ENABLE` (legacy `MMR_PAINTER_ENABLE`) for `enabled`.
 * The latest source wins. Values of the wrong type are ignored; a `model`
 * string is kept as written (trimmed), so a malformed one gates the tool
 * with its own name instead of quietly picking another model. A settings
 * file that cannot be read is skipped; `ampi-core` already reports it in
 * `/ampi-status`.
 */
export function loadMmrPainterSettings(
  cwd: string,
  options: { homeDirectory?: string; env?: NodeJS.ProcessEnv } = {},
): MmrPainterSettings {
  const homeDirectory = options.homeDirectory ?? homedir();
  const env = options.env ?? process.env;
  const settings: MmrPainterSettings = { ...MMR_PAINTER_DEFAULTS };

  for (const filePath of [path.join(homeDirectory, ".pi/agent/settings.json"), path.join(cwd, ".pi/settings.json")]) {
    let block: Record<string, unknown> | undefined;
    try {
      block = readBlock(readJsonSettingsFile(filePath));
    } catch {
      continue;
    }
    if (typeof block?.enabled === "boolean") settings.enabled = block.enabled;
    if (typeof block?.model === "string" && block.model.trim() !== "") settings.model = block.model.trim();
  }

  settings.enabled = parseBoolEnv(readPreferredEnv(env, "AMPI_PAINTER_ENABLE", "MMR_PAINTER_ENABLE")?.value) ?? settings.enabled;
  return settings;
}
