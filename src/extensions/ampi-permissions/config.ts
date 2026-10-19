import { readFileSync } from "node:fs";
import { parseMmrGuardedFilesAllowlist } from "../ampi-core/guarded-files.js";
import { isRecord } from "../ampi-core/internal/json.js";
import { type MmrPermissionRule, parseMmrPermissionRules } from "../ampi-core/permissions.js";

/** The permission settings of one session, read from the user's and the trusted project's settings files. */
export interface MmrPermissionsSettings {
  /**
   * `ampi.permissions` is present, or `ampi.dangerouslyAllowAll` is `false`,
   * in either file, or the user's `ampi.guardedFiles.allowlist` is present.
   */
  readonly enabled: boolean;
  /** The user's `ampi.dangerouslyAllowAll` is `true`. */
  readonly allowAll: boolean;
  /** Set when a file's `ampi.permissions` is not a list: every call then asks, for this reason. */
  readonly failClosed?: string;
  /** The project's reject and ask rules. */
  readonly projectRules: readonly MmrPermissionRule[];
  readonly userRules: readonly MmrPermissionRule[];
  /** The user's `ampi.guardedFiles.allowlist`: absolute paths and globs, `~/` expanded, that guarded files may change without asking. */
  readonly guardedFilesAllowlist: readonly string[];
  /** Problems to show the user once per session. */
  readonly warnings: readonly string[];
}

export interface LoadMmrPermissionsSettingsOptions {
  /** `<agentDir>/settings.json`. */
  readonly userFile: string;
  /** `<cwd>/.pi/settings.json`, only when Pi trusts the project. */
  readonly projectFile?: string;
}

/**
 * Read a settings file the way Pi does: following a symlink, without a
 * byte-order mark. A missing file is undefined; an unreadable one is
 * undefined with a warning, as Pi then also runs without it.
 */
function readSettingsFile(filePath: string, warnings: string[]): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    warnings.push(`Could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(raw.replace(/^﻿/, ""));
    if (isRecord(value)) return value;
    warnings.push(`Ignoring ${filePath}: expected a JSON object.`);
  } catch (error) {
    warnings.push(`Could not read ${filePath}: it is not valid JSON (${error instanceof Error ? error.message : String(error)}).`);
  }
  return undefined;
}

/**
 * Load the permission settings. A project can only tighten what the user
 * set: its reject and ask rules apply ahead of the user's, while its allow
 * and delegate rules and a `dangerouslyAllowAll: true` are ignored with a
 * warning. Guarded files are the user's alone: a project's
 * `ampi.guardedFiles` is ignored with a warning.
 */
export function loadMmrPermissionsSettings(options: LoadMmrPermissionsSettingsOptions): MmrPermissionsSettings {
  const warnings: string[] = [];
  let enabled = false;
  let allowAll = false;
  let failClosed: string | undefined;
  let projectRules: MmrPermissionRule[] = [];
  let userRules: MmrPermissionRule[] = [];
  let guardedFilesAllowlist: readonly string[] = [];

  const files: ["user" | "project", string | undefined][] = [
    ["user", options.userFile],
    ["project", options.projectFile],
  ];
  for (const [scope, filePath] of files) {
    if (filePath === undefined) continue;
    const ampi = readSettingsFile(filePath, warnings)?.ampi;
    if (!isRecord(ampi)) continue;

    const allow = ampi.dangerouslyAllowAll;
    if (allow === false) enabled = true;
    else if (allow === true && scope === "user") allowAll = true;
    else if (allow === true) warnings.push(`Ignoring ampi.dangerouslyAllowAll in ${filePath}: project settings can only add restrictions.`);
    else if (allow !== undefined) warnings.push(`Ignoring ampi.dangerouslyAllowAll in ${filePath}: expected true or false.`);

    if (Object.hasOwn(ampi, "guardedFiles")) {
      if (scope === "project") {
        warnings.push(`Ignoring ampi.guardedFiles in ${filePath}: guarded files can only be allowed in the user settings.`);
      } else if (!isRecord(ampi.guardedFiles)) {
        warnings.push(`Ignoring ampi.guardedFiles in ${filePath}: expected an object.`);
      } else if (Object.hasOwn(ampi.guardedFiles, "allowlist")) {
        enabled = true;
        const allowlist = ampi.guardedFiles.allowlist;
        if (!Array.isArray(allowlist)) {
          warnings.push(`Ignoring ampi.guardedFiles.allowlist in ${filePath}: expected a list of paths, so every guarded file asks.`);
        } else {
          const parsed = parseMmrGuardedFilesAllowlist(allowlist);
          guardedFilesAllowlist = parsed.entries;
          for (const { index, problem } of parsed.problems) {
            warnings.push(`Skipping ampi.guardedFiles.allowlist[${index}] in ${filePath}: ${problem}.`);
          }
        }
      }
    }

    if (!Object.hasOwn(ampi, "permissions")) continue;
    enabled = true;
    if (!Array.isArray(ampi.permissions)) {
      failClosed ??= `ampi.permissions in ${filePath} is not a list of rules`;
      warnings.push(`${failClosed}, so every tool call asks for approval until it is fixed.`);
      continue;
    }
    const { rules, problems } = parseMmrPermissionRules(ampi.permissions);
    for (const problem of problems) {
      warnings.push(`Skipping ampi.permissions[${problem.index}] in ${filePath}: ${problem.problems.join("; ")}.`);
    }
    if (scope === "user") {
      userRules = rules;
      continue;
    }
    projectRules = rules.filter((rule) => rule.action === "reject" || rule.action === "ask");
    const ignored = rules.length - projectRules.length;
    if (ignored > 0) {
      warnings.push(
        `Ignoring ${ignored} allow or delegate rule${ignored === 1 ? "" : "s"} in ${filePath}: project settings can only add reject and ask rules.`,
      );
    }
  }

  return { enabled, allowAll, ...(failClosed ? { failClosed } : {}), projectRules, userRules, guardedFilesAllowlist, warnings };
}
