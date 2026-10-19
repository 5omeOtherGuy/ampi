import { readlinkSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { GlobPatternError, globToRegExp, matchGlob } from "./glob.js";
import { isRecord } from "./internal/json.js";
import { patchTextPaths } from "./tool-activity.js";

/**
 * Guarded files: sensitive places (keys, credentials, environment files,
 * Git internals, agent configuration, databases, home and system
 * configuration) that `ampi-permissions` always asks about before a tool
 * changes a file there, even when a rule allows the tool.
 *
 * Unlike the rule engine in `permissions.ts`, this module reads the
 * filesystem: it follows symbolic links with `realpath`, and `readlink` for
 * links whose target does not exist yet (resolving their targets one name at
 * a time, as the system does), so a link that points into `~/.ssh` is
 * caught. Everything it reads from the machine (home, platform, temp
 * directory, cwd, Pi's agent directory, environment variables, `realpath`,
 * `readlink`) can be injected, so Windows and macOS cases run anywhere.
 */

export interface MmrGuardedFileCategory {
  /** A short kebab-case name. */
  readonly key: string;
  /** One phrase for the dialog and the block reasons. */
  readonly description: string;
}

/** What the classifier reads from the machine; each field defaults to the running process's value. */
export interface MmrGuardedFilesEnvironment {
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly tempDir?: string;
  /** The session's working directory, which relative paths resolve against. */
  readonly cwd?: string;
  /** Pi's agent directory (`getAgentDir()`). */
  readonly agentDir?: string;
  /** Read for the Windows directories (`SystemRoot`, `ProgramFiles`, `APPDATA`, ...). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Sync `realpath` (`fs.realpathSync.native`, which gives the on-disk case); throws for a path that does not exist. */
  readonly realpath?: (filePath: string) => string;
  /** Sync `readlink`; throws for a path that is not a symbolic link. */
  readonly readlink?: (filePath: string) => string;
}

/**
 * How a tool turns its path argument into a file: `pi` as Pi's `edit` and
 * `write` do (Unicode spaces, a leading `@`, `~`, `file://` URLs and, on
 * Windows, `/c/...` drive paths), `plain` with `path.resolve(cwd, raw)` as
 * `apply_patch` and `painter` do.
 */
export type MmrGuardedPathStyle = "pi" | "plain";

/** A guarded path: why it is guarded, and the forms an allowlist entry has to cover. */
export interface MmrGuardedFile {
  readonly category: MmrGuardedFileCategory;
  /** The absolute path, resolved without following links. */
  readonly path: string;
  /** The path with its links followed, dangling ones included, when that differs from `path`. */
  readonly realPath?: string;
  /** The forms (`path`, `realPath`) that are guarded on their own. */
  readonly guardedForms: readonly string[];
}

export const MMR_GUARDED_FILE_CATEGORIES = Object.freeze({
  ssh: Object.freeze({ key: "ssh", description: "SSH keys and settings" }),
  gnupg: Object.freeze({ key: "gnupg", description: "GnuPG keys" }),
  envFile: Object.freeze({ key: "env-file", description: "environment file" }),
  credentials: Object.freeze({ key: "cloud-credentials", description: "cloud or cluster credentials" }),
  git: Object.freeze({ key: "git", description: "Git internals" }),
  agentConfig: Object.freeze({ key: "agent-config", description: "agent configuration" }),
  database: Object.freeze({ key: "database", description: "database file" }),
  homeConfig: Object.freeze({ key: "home-config", description: "configuration in the home directory" }),
  system: Object.freeze({ key: "system", description: "system directory" }),
  link: Object.freeze({ key: "unresolved-link", description: "link or device path that cannot be followed" }),
} satisfies Record<string, MmrGuardedFileCategory>);

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const ENV_FILE = /^\.env(\..*)?$/;
const ENV_TEMPLATES: ReadonlySet<string> = new Set([".env.example", ".env.sample"]);
const DATABASE = /\.(db|sqlite|sqlite3)$/;
const UNIX_SYSTEM_ROOTS = ["/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/var", "/opt"];
const MACOS_SYSTEM_ROOTS = ["/private/etc", "/private/var", "/System", "/Library", "/Applications"];
/** Links followed for one path before it counts as one that cannot be followed, as Linux's own limit. */
const MAX_LINKS = 40;

interface Resolved {
  readonly platform: NodeJS.Platform;
  readonly path: typeof path.posix;
  readonly fold: boolean;
  readonly home: string;
  readonly cwd: string;
  readonly realpath: (filePath: string) => string;
  readonly readlink: (filePath: string) => string;
  /** Comparison keys of each anchor, in its given and its real form. */
  readonly homes: readonly string[];
  readonly agentDirs: readonly string[];
  readonly cwds: readonly string[];
  readonly temps: readonly string[];
  readonly systemRoots: readonly string[];
}

function envValue(env: Readonly<Record<string, string | undefined>>, name: string, platform: NodeJS.Platform): string | undefined {
  // Windows environment names are case-insensitive.
  if (platform !== "win32") return env[name] || undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) if (key.toLowerCase() === lower && value) return value;
  return undefined;
}

function resolveEnvironment(environment: MmrGuardedFilesEnvironment): Resolved {
  const platform = environment.platform ?? process.platform;
  const p = platform === "win32" ? path.win32 : path.posix;
  const fold = platform === "darwin" || platform === "win32";
  const realpath = environment.realpath ?? ((filePath: string) => realpathSync.native(filePath));
  const readlink = environment.readlink ?? ((filePath: string) => readlinkSync(filePath));
  const home = p.resolve(environment.homeDir ?? homedir());
  const cwd = p.resolve(environment.cwd ?? process.cwd());
  const env = environment.env ?? process.env;
  const base: Omit<Resolved, "homes" | "agentDirs" | "cwds" | "temps" | "systemRoots"> = { platform, path: p, fold, home, cwd, realpath, readlink };
  const anchor = (dir: string) => {
    const resolved = p.resolve(dir);
    return [...new Set([resolved, realForm(base, resolved) ?? resolved])].map((form) => key(base, form));
  };

  let roots: string[];
  if (platform === "win32") {
    const or = (name: string, fallback: string) => envValue(env, name, platform) ?? fallback;
    roots = [
      or("SystemRoot", or("windir", "C:\\Windows")),
      or("ProgramFiles", "C:\\Program Files"),
      or("ProgramFiles(x86)", "C:\\Program Files (x86)"),
      p.join(home, "AppData"),
      ...["APPDATA", "LOCALAPPDATA"].flatMap((name) => envValue(env, name, platform) ?? []),
    ];
  } else {
    roots = platform === "darwin" ? [...UNIX_SYSTEM_ROOTS, ...MACOS_SYSTEM_ROOTS] : UNIX_SYSTEM_ROOTS;
  }
  return {
    ...base,
    homes: anchor(home),
    agentDirs: anchor(environment.agentDir ?? getAgentDir()),
    cwds: anchor(cwd),
    temps: anchor(environment.tempDir ?? tmpdir()),
    systemRoots: [...new Set(roots.flatMap((root) => anchor(root)))],
  };
}

/**
 * Case folding close to how the macOS and Windows filesystems compare names:
 * through upper case first, so `ſ` (U+017F) folds to `s` as `S` does, and
 * the Kelvin sign to `k`.
 */
function foldCase(text: string): string {
  return text.toUpperCase().toLowerCase();
}

/**
 * A Windows device namespace path that names no drive or share, such as
 * `\\.\GLOBALROOT\...`, `\\?\Volume{...}\...`, `\\.\pipe\...` or the volume
 * `\\.\C:` itself: no rule here can tell what it leads to.
 */
function isDeviceNamespace(env: Pick<Resolved, "platform">, filePath: string): boolean {
  if (env.platform !== "win32") return false;
  const device = /^[\\/]{2}[?.][\\/](.*)$/s.exec(filePath);
  return device !== null && !/^([a-z]:|UNC)[\\/]/i.test(device[1] as string);
}

/** A Windows path without its `\\?\` or `\\.\` prefix (`\\?\UNC\` becomes `\\`), so it compares as the path Windows opens. */
function withoutDevicePrefix(text: string): string {
  return text.replace(/^[\\/]{2}[?.][\\/](UNC[\\/])?/i, (_match, unc: string | undefined) => (unc ? "\\\\" : ""));
}

/**
 * The comparison key of an absolute path: `/` as the separator, case folded
 * on macOS and Windows, and on Windows without a device prefix and each name
 * without the trailing dots and spaces and the `:stream` suffix that Windows
 * ignores when it opens a file.
 */
function key(env: Pick<Resolved, "platform" | "fold">, filePath: string): string {
  let text = filePath;
  if (env.platform === "win32") {
    text = withoutDevicePrefix(text);
    const root = path.win32.parse(text).root;
    const rest = text
      .slice(root.length)
      .split(/[\\/]/)
      .map((name) => name.replace(/:.*$/, "").replace(/[. ]+$/, ""));
    text = `${root.replaceAll("\\", "/")}${rest.join("/").replace(/\/+$/, "")}`;
  }
  return env.fold ? foldCase(text) : text;
}

function isUnder(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function isStrictlyUnder(candidate: string, root: string): boolean {
  return candidate !== root && isUnder(candidate, root);
}

/**
 * The path with its links followed: the real path of its nearest existing
 * ancestor joined with the rest, where a dangling link on the way is read and
 * its target followed the same way, since a write through it creates that
 * target. `undefined` for a link that cannot be followed: a loop, more than
 * `MAX_LINKS` links to follow, or one whose folder or target cannot be read.
 */
function realForm(env: Pick<Resolved, "path" | "realpath" | "readlink">, filePath: string, budget = { links: MAX_LINKS }): string | undefined {
  const p = env.path;
  const rest: string[] = [];
  let current = filePath;
  for (;;) {
    try {
      return p.join(env.realpath(current), ...rest.reverse());
    } catch {
      // Missing, or a link that does not lead anywhere yet.
    }
    let target: string | undefined;
    try {
      target = env.readlink(current);
    } catch {
      // Not a link: walk up to its folder.
    }
    if (target !== undefined) {
      let folder: string;
      try {
        folder = env.realpath(p.dirname(current));
      } catch {
        return undefined;
      }
      const real = followLink(env, folder, target, budget);
      return real === undefined ? undefined : p.join(real, ...rest.reverse());
    }
    const parent = p.dirname(current);
    if (parent === current) return p.join(current, ...rest.reverse());
    rest.push(p.basename(current));
    current = parent;
  }
}

/**
 * Where a link with `target` in the real folder `folder` leads, resolved as
 * the system resolves it: one name at a time from the folder (or from the
 * target's root), each name followed when it is a link before the next one
 * applies, so a `..` leaves the folder the name before it leads to, not the
 * folder that name sits in. A missing name is kept as it is, as the folder a
 * write would create. Every dangling link followed counts against `budget`.
 */
function followLink(
  env: Pick<Resolved, "path" | "realpath" | "readlink">,
  folder: string,
  target: string,
  budget: { links: number },
): string | undefined {
  if (budget.links <= 0) return undefined;
  budget.links -= 1;
  const p = env.path;
  const root = p.parse(target).root;
  // `folder` is real, so resolving it against the target's bare root follows no link.
  let resolved = root === "" ? folder : p.resolve(folder, root);
  for (const name of target.slice(root.length).split(p.sep === "\\" ? /[\\/]/ : "/")) {
    if (name === "" || name === ".") continue;
    if (name === "..") {
      resolved = p.dirname(resolved);
      continue;
    }
    const next = p.join(resolved, name);
    try {
      resolved = env.realpath(next);
      continue;
    } catch {
      // Missing, or a link that does not lead anywhere yet.
    }
    let inner: string | undefined;
    try {
      inner = env.readlink(next);
    } catch {
      resolved = next;
      continue;
    }
    const followed = followLink(env, resolved, inner, budget);
    if (followed === undefined) return undefined;
    resolved = followed;
  }
  return resolved;
}

function names(candidate: string): string[] {
  return candidate.split("/").filter((name) => name.length > 0);
}

function underAny(candidate: string, roots: readonly string[], ...sub: string[]): boolean {
  return roots.some((root) => isUnder(candidate, sub.length > 0 ? `${root.replace(/\/$/, "")}/${sub.join("/")}` : root));
}

function isSystemPath(env: Resolved, candidate: string): boolean {
  return env.systemRoots.some((root) => {
    if (!isUnder(candidate, root)) return false;
    // A temp directory or a project inside a system root exempts what is
    // under it; one that is the root itself, or above it, exempts nothing.
    const exempt = [...env.temps, ...env.cwds].some((dir) => isStrictlyUnder(dir, root) && isUnder(candidate, dir));
    return !exempt;
  });
}

function categoryOf(env: Resolved, candidate: string): MmrGuardedFileCategory | undefined {
  const c = MMR_GUARDED_FILE_CATEGORIES;
  const parts = names(candidate);
  const base = parts.at(-1) ?? "";
  const fold = (text: string) => (env.fold ? foldCase(text) : text);
  if (underAny(candidate, env.homes, fold(".ssh"))) return c.ssh;
  if (underAny(candidate, env.homes, fold(".gnupg"))) return c.gnupg;
  if (ENV_FILE.test(base) && !ENV_TEMPLATES.has(base)) return c.envFile;
  if (
    underAny(candidate, env.homes, fold(".aws")) ||
    underAny(candidate, env.homes, fold(".kube")) ||
    env.homes.some((home) => candidate === `${home}/${fold(".docker/config.json")}` || candidate === `${home}/${fold(".netrc")}`)
  ) {
    return c.credentials;
  }
  if (parts.includes(".git")) return c.git;
  if (
    underAny(candidate, env.agentDirs) ||
    parts.includes(".pi") ||
    underAny(candidate, env.homes, fold(".claude")) ||
    underAny(candidate, env.homes, fold(".codex"))
  ) {
    return c.agentConfig;
  }
  if (DATABASE.test(base)) return c.database;
  if (
    env.homes.some((home) => {
      const relative = isStrictlyUnder(candidate, home) ? candidate.slice(home.replace(/\/$/, "").length + 1) : undefined;
      return relative !== undefined && !relative.includes("/") && relative.startsWith(".");
    }) ||
    underAny(candidate, env.homes, fold(".config")) ||
    (env.platform === "darwin" && underAny(candidate, env.homes, fold("Library")))
  ) {
    return c.homeConfig;
  }
  if (isSystemPath(env, candidate)) return c.system;
  return undefined;
}

function piPath(env: Pick<Resolved, "platform" | "path" | "home">, raw: string): string {
  let text = raw.replace(UNICODE_SPACES, " ");
  if (text.startsWith("@")) text = text.slice(1);
  if (env.platform === "win32" && text.startsWith("/") && !text.startsWith("//") && !text.includes("\\")) {
    const drive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(text);
    if (drive) text = `${(drive[1] as string).toUpperCase()}:\\${drive[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  if (text === "~") return env.home;
  if (text.startsWith("~/") || (env.platform === "win32" && text.startsWith("~\\"))) return env.path.join(env.home, text.slice(2));
  if (/^file:\/\//.test(text)) return fileURLToPath(text, { windows: env.platform === "win32" });
  return text;
}

/** The absolute path a tool's path argument names, without following links. */
export function resolveMmrToolPath(raw: string, style: MmrGuardedPathStyle, environment: MmrGuardedFilesEnvironment = {}): string {
  const env = resolveEnvironment(environment);
  return resolveWith(env, raw, style);
}

function resolveWith(env: Resolved, raw: string, style: MmrGuardedPathStyle): string {
  let text = raw;
  if (style === "pi") {
    try {
      text = piPath(env, raw);
    } catch {
      // A malformed file URL: Pi refuses it too, so resolve it as written.
    }
  }
  return env.path.resolve(env.cwd, text);
}

function classifyWith(env: Resolved, raw: string, style: MmrGuardedPathStyle): MmrGuardedFile | undefined {
  const lexical = resolveWith(env, raw, style);
  const followed = realForm(env, lexical);
  const real = followed === lexical ? undefined : followed;
  // A link that cannot be followed, or a device path, may lead anywhere, so it is guarded itself.
  const unresolved = (form: string) => (isDeviceNamespace(env, form) ? MMR_GUARDED_FILE_CATEGORIES.link : undefined);
  const checked = [
    {
      form: lexical,
      category: categoryOf(env, key(env, lexical)) ?? (followed === undefined ? MMR_GUARDED_FILE_CATEGORIES.link : unresolved(lexical)),
    },
    ...(real === undefined ? [] : [{ form: real, category: categoryOf(env, key(env, real)) ?? unresolved(real) }]),
  ];
  const guarded = checked.filter((entry) => entry.category !== undefined);
  if (guarded.length === 0) return undefined;
  // Categories are checked in their order over both forms: the first wins.
  const order = Object.values(MMR_GUARDED_FILE_CATEGORIES) as MmrGuardedFileCategory[];
  const category = order.find((candidate) => guarded.some((entry) => entry.category === candidate)) as MmrGuardedFileCategory;
  return {
    category,
    path: lexical,
    ...(real !== undefined ? { realPath: real } : {}),
    guardedForms: guarded.map((entry) => entry.form),
  };
}

/** Whether a tool's path argument names a guarded file, and why; `undefined` when it does not. */
export function classifyMmrGuardedFile(
  raw: string,
  style: MmrGuardedPathStyle,
  environment: MmrGuardedFilesEnvironment = {},
): MmrGuardedFile | undefined {
  return classifyWith(resolveEnvironment(environment), raw, style);
}

/** The path arguments a tool call changes, and how the tool resolves them; empty for a tool that is not checked. */
export function mmrGuardedToolPaths(toolName: string, input: unknown): { raw: string; style: MmrGuardedPathStyle }[] {
  if (!isRecord(input)) return [];
  switch (toolName) {
    case "edit":
    case "write":
      return typeof input.path === "string" ? [{ raw: input.path, style: "pi" }] : [];
    case "apply_patch":
      return typeof input.patchText === "string" ? patchTextPaths(input.patchText).map((raw) => ({ raw, style: "plain" as const })) : [];
    case "painter":
      return typeof input.output_path === "string" ? [{ raw: input.output_path, style: "plain" }] : [];
    default:
      return [];
  }
}

/**
 * The guarded files a tool call changes that the allowlist does not cover,
 * one per resolved path, in the order the call names them.
 */
export function findMmrGuardedFiles(
  toolName: string,
  input: unknown,
  allowlist: readonly MmrGuardedFilesAllowlistEntry[],
  environment: MmrGuardedFilesEnvironment = {},
): MmrGuardedFile[] {
  const targets = mmrGuardedToolPaths(toolName, input);
  if (targets.length === 0) return [];
  const env = resolveEnvironment(environment);
  const found = new Map<string, MmrGuardedFile>();
  for (const target of targets) {
    if (target.raw.trim() === "") continue;
    const file = classifyWith(env, target.raw, target.style);
    if (file === undefined || found.has(file.path)) continue;
    if (file.guardedForms.every((form) => allowlist.some((entry) => allowlistEntryMatches(env, entry, form)))) continue;
    found.set(file.path, file);
  }
  return [...found.values()];
}

function allowlistKey(env: Pick<Resolved, "platform" | "fold">, text: string): string {
  const slashed = env.platform === "win32" ? withoutDevicePrefix(text).replaceAll("\\", "/") : text;
  return env.fold ? foldCase(slashed) : slashed;
}

function allowlistEntryMatches(env: Resolved, entry: MmrGuardedFilesAllowlistEntry, filePath: string): boolean {
  const candidate = allowlistKey(env, filePath);
  if (typeof entry !== "string") return allowlistKey(env, entry.path) === candidate;
  try {
    return matchGlob(allowlistKey(env, entry), candidate);
  } catch {
    return false;
  }
}

/**
 * One allowlist entry: a string is a glob; `{ path }` is one exact path,
 * compared only for equality, so `?`, `*`, `[` and `{` in it are plain
 * characters. "Always Allow This Path" saves the second form.
 */
export type MmrGuardedFilesAllowlistEntry = string | { readonly path: string };

/** A parsed `ampi.guardedFiles.allowlist`: its usable entries (with `~/` expanded) and what was wrong with the others. */
export interface MmrGuardedFilesAllowlist {
  readonly entries: readonly MmrGuardedFilesAllowlistEntry[];
  readonly problems: readonly { readonly index: number; readonly problem: string }[];
}

/**
 * Read an `ampi.guardedFiles.allowlist` value. An entry is an absolute glob
 * or an exact `{ "path": ... }` (`~/` at the start of either stands for the
 * home directory); one that is neither, not absolute or not a valid glob is
 * left out with a problem.
 */
export function parseMmrGuardedFilesAllowlist(
  value: readonly unknown[],
  environment: Pick<MmrGuardedFilesEnvironment, "homeDir" | "platform"> = {},
): MmrGuardedFilesAllowlist {
  const platform = environment.platform ?? process.platform;
  const p = platform === "win32" ? path.win32 : path.posix;
  const home = environment.homeDir ?? homedir();
  const entries: MmrGuardedFilesAllowlistEntry[] = [];
  const problems: { index: number; problem: string }[] = [];
  value.forEach((item, index) => {
    const exact = isRecord(item) ? item.path : undefined;
    if (typeof item !== "string" && typeof exact !== "string") {
      problems.push({ index, problem: 'expected a glob string or { "path": "..." }' });
      return;
    }
    let entry = typeof item === "string" ? item : (exact as string);
    if (entry.startsWith("~/") || (platform === "win32" && entry.startsWith("~\\"))) entry = `${home.replace(/[\\/]+$/, "")}/${entry.slice(2)}`;
    if (!p.isAbsolute(entry)) {
      problems.push({ index, problem: "expected an absolute path" });
      return;
    }
    if (typeof item !== "string") {
      entries.push({ path: entry });
      return;
    }
    try {
      globToRegExp(allowlistKey({ platform, fold: platform === "darwin" || platform === "win32" }, entry));
    } catch (error) {
      if (!(error instanceof GlobPatternError)) throw error;
      problems.push({ index, problem: error.message });
      return;
    }
    entries.push(entry);
  });
  return { entries, problems };
}
