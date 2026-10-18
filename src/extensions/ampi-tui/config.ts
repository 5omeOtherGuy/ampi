import { homedir } from "node:os";
import path from "node:path";
import { parseBoolEnv, readPreferredEnv } from "../ampi-core/internal/env.js";
import { isRecord } from "../ampi-core/internal/json.js";
import { readJsonSettingsFile } from "../ampi-core/internal/settings-file.js";

/** When `ampi-tui` tells you a turn finished or needs you. */
export interface MmrTuiNotificationSettings {
  /** Master switch for notifications. On by default. */
  enabled: boolean;
  /** Desktop notification through the terminal (a bell over SSH). On by default. */
  system: boolean;
  /** A sound through `paplay`, where it is installed. Off by default. */
  sound: boolean;
}

export const MMR_TUI_NOTIFICATION_DEFAULTS: Readonly<MmrTuiNotificationSettings> = Object.freeze({
  enabled: true,
  system: true,
  sound: false,
});

export interface MmrTuiSettings {
  /** Whether `ampi-tui` takes over ampi's terminal chrome. On by default. */
  enabled: boolean;
  /** Pi's `quietStartup: true`: the user asked for no startup header, so ampi draws none. */
  quietStartup?: boolean;
  /** Notification switches; {@link MMR_TUI_NOTIFICATION_DEFAULTS} when absent. */
  notifications?: MmrTuiNotificationSettings;
  /** `ampi.terminal.detailsExpandedByDefault`: start sessions with tool output and thinking expanded. Off by default. */
  detailsExpandedByDefault?: boolean;
  /** `ampi.fuzzy.alwaysIncludePaths`: globs, relative to the working directory, that `@` file mentions offer even when git ignores them. */
  alwaysIncludePaths?: readonly string[];
  /** `ampiTui.intro`: `false` keeps the onboarding intro from opening by itself. On by default. */
  intro?: boolean;
}

/** The settings `ampi-tui` reads from the top-level `ampi` block, by their names there. */
type MmrAmpiBlockSettings = Pick<MmrTuiSettings, "detailsExpandedByDefault" | "alwaysIncludePaths">;

/**
 * `ampi.terminal.detailsExpandedByDefault` and `ampi.fuzzy.alwaysIncludePaths`
 * as the file sets them, each only when it has the right type. The one place
 * these names are read.
 */
function readAmpiBlock(value: unknown): MmrAmpiBlockSettings {
  const ampi = isRecord(value) && isRecord(value.ampi) ? value.ampi : undefined;
  const details = isRecord(ampi?.terminal) ? ampi.terminal.detailsExpandedByDefault : undefined;
  const paths = isRecord(ampi?.fuzzy) ? ampi.fuzzy.alwaysIncludePaths : undefined;
  return {
    detailsExpandedByDefault: typeof details === "boolean" ? details : undefined,
    alwaysIncludePaths:
      Array.isArray(paths) && paths.every((entry) => typeof entry === "string") ? (paths as string[]) : undefined,
  };
}

/** The `ampiTui` block, or the nested `ampi.tui` one. */
function tuiBlock(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.ampiTui)) return value.ampiTui;
  return isRecord(value.ampi) && isRecord(value.ampi.tui) ? value.ampi.tui : undefined;
}

function readSwitch(value: unknown, key: "enabled" | "intro"): boolean | undefined {
  const block = tuiBlock(value);
  return typeof block?.[key] === "boolean" ? block[key] : undefined;
}

/** Each switch the file sets as a boolean; the others keep their earlier value. */
function readNotifications(value: unknown, current: MmrTuiNotificationSettings): MmrTuiNotificationSettings {
  const block = tuiBlock(value)?.notifications;
  if (!isRecord(block)) return current;
  const next = { ...current };
  for (const key of ["enabled", "system", "sound"] as const) {
    if (typeof block[key] === "boolean") next[key] = block[key];
  }
  return next;
}

function readQuietStartup(value: unknown): boolean | undefined {
  if (!isRecord(value) || !("quietStartup" in value)) return undefined;
  return value.quietStartup === true;
}

/**
 * Load `ampi-tui` settings: `ampiTui.enabled`, `ampiTui.intro` and
 * `ampiTui.notifications` (or nested under `ampi.tui`),
 * `ampi.terminal.detailsExpandedByDefault`, `ampi.fuzzy.alwaysIncludePaths`
 * and Pi's own `quietStartup` from the global
 * `~/.pi/agent/settings.json`, then the project `<cwd>/.pi/settings.json`,
 * then `AMPI_TUI_ENABLE` (legacy `MMR_TUI_ENABLE`) for `enabled`. The latest
 * source wins, per key; a value of the wrong type is skipped. A settings file
 * that cannot be read is skipped; `ampi-core` already reports it in
 * `/ampi-status`.
 */
export function loadMmrTuiSettings(
  cwd: string,
  options: { homeDirectory?: string; env?: NodeJS.ProcessEnv } = {},
): MmrTuiSettings {
  const homeDirectory = options.homeDirectory ?? homedir();
  const env = options.env ?? process.env;
  let enabled = true;
  let quietStartup = false;
  let intro = true;
  let notifications: MmrTuiNotificationSettings = { ...MMR_TUI_NOTIFICATION_DEFAULTS };
  let detailsExpandedByDefault = false;
  let alwaysIncludePaths: readonly string[] = [];

  for (const filePath of [path.join(homeDirectory, ".pi/agent/settings.json"), path.join(cwd, ".pi/settings.json")]) {
    let value: unknown;
    try {
      value = readJsonSettingsFile(filePath);
    } catch {
      continue;
    }
    enabled = readSwitch(value, "enabled") ?? enabled;
    intro = readSwitch(value, "intro") ?? intro;
    quietStartup = readQuietStartup(value) ?? quietStartup;
    notifications = readNotifications(value, notifications);
    const ampi = readAmpiBlock(value);
    detailsExpandedByDefault = ampi.detailsExpandedByDefault ?? detailsExpandedByDefault;
    alwaysIncludePaths = ampi.alwaysIncludePaths ?? alwaysIncludePaths;
  }

  enabled = parseBoolEnv(readPreferredEnv(env, "AMPI_TUI_ENABLE", "MMR_TUI_ENABLE")?.value) ?? enabled;
  return { enabled, quietStartup, notifications, detailsExpandedByDefault, alwaysIncludePaths, intro };
}
