import { homedir } from "node:os";
import path from "node:path";
import { isRecord } from "./internal/json.js";
import { readJsonSettingsFile } from "./internal/settings-file.js";

export interface MmrAnimationOptions {
  /** Project directory whose `.pi/settings.json` is read. Default: `process.cwd()`. */
  cwd?: string;
  /** Home directory whose `.pi/agent/settings.json` is read. Default: the user's home. */
  homeDirectory?: string;
  env?: NodeJS.ProcessEnv;
}

/** `ampiTui.animations` (or `ampi.tui.animations`) when a settings file sets it to a boolean. */
function readAnimations(value: unknown): boolean | undefined {
  if (!isRecord(value)) return undefined;
  const block = isRecord(value.ampiTui) ? value.ampiTui : isRecord(value.ampi) && isRecord(value.ampi.tui) ? value.ampi.tui : undefined;
  return typeof block?.animations === "boolean" ? block.animations : undefined;
}

/**
 * Whether the user asked for a still terminal: `NO_ANIMATION` is set to
 * anything but the empty string, or `ampiTui.animations` is `false` in the
 * global `~/.pi/agent/settings.json` or, overriding it, the project's
 * `<cwd>/.pi/settings.json`. Spinners then rest on their first glyph and
 * start no timer; other animations rest on their first frame. Callers ask
 * when a row or widget starts, so a change applies to the next one. A
 * settings file that cannot be read is skipped; `ampi-core` already reports
 * it in `/ampi-status`.
 */
export function isMmrAnimationDisabled(options: MmrAnimationOptions = {}): boolean {
  const env = options.env ?? process.env;
  if (env.NO_ANIMATION !== undefined && env.NO_ANIMATION !== "") return true;
  const homeDirectory = options.homeDirectory ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  let animations = true;
  for (const filePath of [path.join(homeDirectory, ".pi/agent/settings.json"), path.join(cwd, ".pi/settings.json")]) {
    try {
      animations = readAnimations(readJsonSettingsFile(filePath)) ?? animations;
    } catch {
      // Unreadable: keep the earlier value.
    }
  }
  return !animations;
}
