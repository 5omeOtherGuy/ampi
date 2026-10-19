/**
 * Review checks: standing review rules kept in the repository as Markdown
 * files under `.agents/checks/`, one reviewer child per check that applies to
 * a change.
 *
 * This module owns everything that does not need a Pi tool context, so the
 * `reviewer` tool and a future command-line review share it:
 *
 *  - repository detection (git, or Jujutsu when a `.jj` directory is present);
 *  - check discovery among the tracked and untracked-but-not-ignored files;
 *  - check file parsing (optional `name` / `description` front matter);
 *  - changed-file resolution for a diff description;
 *  - selection of the checks that apply (changed files, `check_scope`,
 *    `check_filter`);
 *  - counting the findings in a reviewer report.
 *
 * Every function is pure over an injected {@link AmpiReviewCheckEnv} (file
 * reads, directory probes and a synchronous command runner), so tests need
 * neither child processes nor a real repository for the Jujutsu paths.
 * {@link createAmpiReviewCheckEnv} is the real implementation.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/** Result of one synchronous command. `exitCode` is non-zero (or -1) when the command could not run. */
export interface AmpiReviewCommandResult {
  stdout: string;
  exitCode: number;
}

/** Synchronous command runner: `command` with `args` in `cwd`, never through a shell. */
export type AmpiReviewCommandRunner = (command: string, args: readonly string[], cwd: string) => AmpiReviewCommandResult;

/** File system and command seams the review-check logic reads through. */
export interface AmpiReviewCheckEnv {
  runCommand: AmpiReviewCommandRunner;
  /** UTF-8 contents of a file, or `undefined` when it cannot be read. */
  readFile(absolutePath: string): string | undefined;
  isDirectory(absolutePath: string): boolean;
  /** Entry names of a directory, or `[]` when it cannot be read. */
  listDirectory(absolutePath: string): readonly string[];
  /** Canonical path with symlinks resolved, or `undefined` when it cannot be resolved. Optional: without it paths compare as given. */
  realpath?(absolutePath: string): string | undefined;
}

/** Commands get this long before they count as failed; discovery never blocks a review for longer. */
const COMMAND_TIMEOUT_MS = 15_000;

/** The real environment: `node:fs` reads and `spawnSync` without a shell. */
export function createAmpiReviewCheckEnv(): AmpiReviewCheckEnv {
  return {
    runCommand(command, args, cwd) {
      try {
        const result = spawnSync(command, [...args], {
          cwd,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
          timeout: COMMAND_TIMEOUT_MS,
          windowsHide: true,
        });
        if (result.error) return { stdout: "", exitCode: -1 };
        return { stdout: result.stdout ?? "", exitCode: result.status ?? -1 };
      } catch {
        return { stdout: "", exitCode: -1 };
      }
    },
    readFile(absolutePath) {
      try {
        return readFileSync(absolutePath, "utf8");
      } catch {
        return undefined;
      }
    },
    isDirectory(absolutePath) {
      try {
        return statSync(absolutePath).isDirectory();
      } catch {
        return false;
      }
    },
    listDirectory(absolutePath) {
      try {
        return readdirSync(absolutePath);
      } catch {
        return [];
      }
    },
    realpath(absolutePath) {
      try {
        return realpathSync.native(absolutePath);
      } catch {
        try {
          return realpathSync(absolutePath);
        } catch {
          return undefined;
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Repository detection
// ---------------------------------------------------------------------------

/** Which version control the review runs against. `none` reads only `<cwd>/.agents/checks`. */
export type AmpiReviewRepositoryKind = "git" | "jj" | "none";

export interface AmpiReviewRepository {
  kind: AmpiReviewRepositoryKind;
  /** Absolute repository root; `cwd` itself when there is no version control. */
  root: string;
}

function hasJujutsuDirectory(cwd: string, env: AmpiReviewCheckEnv): boolean {
  let current = path.resolve(cwd);
  for (;;) {
    if (env.isDirectory(path.join(current, ".jj"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function firstLine(text: string): string {
  return (text.split(/\r?\n/)[0] ?? "").trim();
}

/**
 * The repository `cwd` belongs to. A `.jj` directory in `cwd` or an ancestor
 * makes it a Jujutsu repository rooted at `jj root` (a colocated repository
 * also has `.git`, and Jujutsu is what tracks its working copy). Otherwise
 * `git rev-parse --show-toplevel`; without either, the root is `cwd`.
 */
export function detectAmpiReviewRepository(cwd: string, env: AmpiReviewCheckEnv): AmpiReviewRepository {
  const resolvedCwd = path.resolve(cwd);
  if (hasJujutsuDirectory(resolvedCwd, env)) {
    const jj = env.runCommand("jj", ["root"], resolvedCwd);
    const root = jj.exitCode === 0 ? firstLine(jj.stdout) : "";
    if (root.length > 0) return { kind: "jj", root: path.resolve(resolvedCwd, root) };
  }
  const git = env.runCommand("git", ["rev-parse", "--show-toplevel"], resolvedCwd);
  const root = git.exitCode === 0 ? firstLine(git.stdout) : "";
  if (root.length > 0) return { kind: "git", root: path.resolve(resolvedCwd, root) };
  return { kind: "none", root: resolvedCwd };
}

// ---------------------------------------------------------------------------
// Check files
// ---------------------------------------------------------------------------

/** One review check, with every path relative to the repository root in `/` form. */
export interface AmpiReviewCheck {
  /** Front-matter `name`, or the file stem. */
  name: string;
  /** Front-matter `description`, when present. */
  description?: string;
  /** The Markdown body after the front matter: the instructions the check child applies. */
  instructions: string;
  /** The check file, e.g. `packages/x/.agents/checks/input.md`. */
  file: string;
  /** Directory that contains `.agents`; `.` for the repository root. Changed files under it decide whether the check runs. */
  scope: string;
  /** Set when the front matter could not be read; the check then runs under its file stem. */
  warning?: string;
}

const CHECK_PATH = /^(?:(.+)\/)?\.agents\/checks\/([^/]+)\.md$/;

/** The scope directory and file stem of a check path, or `undefined` when the path is not a check file. */
export function matchAmpiReviewCheckPath(relativePath: string): { scope: string; stem: string } | undefined {
  const match = CHECK_PATH.exec(relativePath);
  if (!match) return undefined;
  const stem = match[2] as string;
  if (stem.length === 0) return undefined;
  return { scope: match[1] ?? ".", stem };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    if ((first === '"' || first === "'") && trimmed.endsWith(first)) return trimmed.slice(1, -1);
  }
  return trimmed;
}

const FRONT_MATTER_KEY = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:(.*)$/;

/**
 * Parse a check file. Front matter is the block between a leading `---` line
 * and the next `---` line; each non-blank line is `key: value`, an indented
 * line continues the previous value, `#` lines are comments, and keys other
 * than `name` and `description` are ignored. A front matter that cannot be
 * read (no closing `---`, a line that is not `key: value`) is not fatal: the
 * check keeps its file stem and carries a warning. CRLF line endings and a
 * leading byte-order mark are accepted.
 */
export function parseAmpiReviewCheckFile(
  relativePath: string,
  content: string,
): AmpiReviewCheck | undefined {
  const located = matchAmpiReviewCheckPath(relativePath);
  if (!located) return undefined;
  const text = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const base = { file: relativePath, scope: located.scope };

  if ((lines[0] ?? "").trimEnd() !== "---") {
    return { ...base, name: located.stem, instructions: text.trim() };
  }
  const closing = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (closing === -1) {
    return {
      ...base,
      name: located.stem,
      instructions: lines.slice(1).join("\n").trim(),
      warning: `${relativePath}: the front matter has no closing --- line; the check runs as "${located.stem}".`,
    };
  }

  const values = new Map<string, string>();
  let lastKey: string | undefined;
  let malformed: string | undefined;
  for (const line of lines.slice(1, closing)) {
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(line) && lastKey !== undefined) {
      const previous = values.get(lastKey) ?? "";
      values.set(lastKey, previous.length > 0 ? `${previous} ${line.trim()}` : line.trim());
      continue;
    }
    const match = FRONT_MATTER_KEY.exec(line);
    if (!match) {
      malformed = line.trim();
      break;
    }
    lastKey = (match[1] as string).toLowerCase();
    const raw = (match[2] as string).trim();
    // YAML block indicators (`|`, `>`) start an indented value on the next lines.
    values.set(lastKey, /^[|>][+-]?$/.test(raw) ? "" : unquote(raw));
  }
  const instructions = lines.slice(closing + 1).join("\n").trim();
  if (malformed !== undefined) {
    return {
      ...base,
      name: located.stem,
      instructions,
      warning: `${relativePath}: the front matter line "${malformed}" is not "key: value"; the check runs as "${located.stem}".`,
    };
  }
  const name = values.get("name")?.trim();
  const description = values.get("description")?.trim();
  return {
    ...base,
    name: name && name.length > 0 ? name : located.stem,
    ...(description && description.length > 0 ? { description } : {}),
    instructions,
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function splitNul(stdout: string): string[] {
  return stdout.split("\0").filter((entry) => entry.length > 0);
}

function splitLines(stdout: string): string[] {
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

/**
 * Candidate check paths relative to the root. Git lists the tracked files
 * plus the untracked files that are not ignored, filtered by a pathspec so a
 * large repository is never listed in full; Jujutsu lists the working-copy
 * files matching the same glob as a fileset (it tracks new files itself and
 * skips ignored ones). Without version
 * control only `<cwd>/.agents/checks/*.md` is read: there is no ignore list
 * to keep dependency and build folders out of a disk walk.
 */
function listCheckCandidates(repository: AmpiReviewRepository, env: AmpiReviewCheckEnv): string[] {
  if (repository.kind === "git") {
    const listed = env.runCommand(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ":(glob)**/.agents/checks/*.md"],
      repository.root,
    );
    return listed.exitCode === 0 ? splitNul(listed.stdout) : [];
  }
  if (repository.kind === "jj") {
    const listed = env.runCommand("jj", ["file", "list", 'glob:"**/.agents/checks/*.md"'], repository.root);
    return listed.exitCode === 0 ? splitLines(listed.stdout).map(toPosix) : [];
  }
  const dir = path.join(repository.root, ".agents", "checks");
  return env
    .listDirectory(dir)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => `.agents/checks/${entry}`);
}

function compareChecks(a: AmpiReviewCheck, b: AmpiReviewCheck): number {
  // Root checks first, then by scope, then by name and file.
  if (a.scope !== b.scope) {
    if (a.scope === ".") return -1;
    if (b.scope === ".") return 1;
    return a.scope < b.scope ? -1 : 1;
  }
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
}

/** Every check file in the repository, parsed, root checks first. Unreadable files are skipped. */
export function discoverAmpiReviewChecks(
  repository: AmpiReviewRepository,
  env: AmpiReviewCheckEnv,
): AmpiReviewCheck[] {
  const seen = new Set<string>();
  const checks: AmpiReviewCheck[] = [];
  for (const candidate of listCheckCandidates(repository, env)) {
    if (seen.has(candidate) || !matchAmpiReviewCheckPath(candidate)) continue;
    seen.add(candidate);
    const content = env.readFile(path.join(repository.root, ...candidate.split("/")));
    if (content === undefined) continue;
    const check = parseAmpiReviewCheckFile(candidate, content);
    if (check) checks.push(check);
  }
  return checks.sort(compareChecks);
}

// ---------------------------------------------------------------------------
// Changed files
// ---------------------------------------------------------------------------

/**
 * Diff descriptions that mean "the uncommitted changes", compared after
 * lower-casing, collapsing whitespace, dropping a trailing `.` and a leading
 * `all` / `the` / `my`. An empty description means the same.
 */
export const AMPI_REVIEW_UNCOMMITTED_PHRASES: readonly string[] = Object.freeze([
  "uncommitted",
  "uncommitted changes",
  "uncommitted work",
  "working tree",
  "working tree changes",
  "working copy",
  "working copy changes",
  "local changes",
  "unstaged changes",
  "pending changes",
  "outstanding changes",
]);

/** Whether a diff description means the uncommitted changes (see {@link AMPI_REVIEW_UNCOMMITTED_PHRASES}). */
export function isAmpiReviewUncommittedDescription(description: string): boolean {
  let normalized = description.toLowerCase().replace(/\s+/g, " ").trim().replace(/\.$/, "").trim();
  if (normalized.length === 0) return true;
  normalized = normalized.replace(/^(?:all|the|my)\s+/, "").replace(/^(?:the|my)\s+/, "");
  return AMPI_REVIEW_UNCOMMITTED_PHRASES.includes(normalized);
}

/**
 * Which files a diff description touches, relative to the repository root:
 * `uncommitted` (tracked changes plus untracked files), `revision` (a
 * revision or range git accepts), or `unknown` (every check runs and each
 * child is told its scope instead).
 */
export type AmpiReviewChangedFiles =
  | { kind: "uncommitted"; files: string[] }
  | { kind: "revision"; revision: string; files: string[] }
  | { kind: "unknown" };

/**
 * Parse `git status --porcelain=v1 -z`: `XY path` entries, where a rename or
 * copy (`R` / `C` in either column) is followed by its source path as the
 * next NUL-separated field. Both sides of a rename count as changed.
 */
export function parseAmpiGitStatusPorcelain(stdout: string): string[] {
  const fields = stdout.split("\0");
  const files: string[] = [];
  for (let index = 0; index < fields.length; index++) {
    const entry = fields[index] as string;
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    files.push(entry.slice(3));
    if (status.includes("R") || status.includes("C")) {
      const source = fields[index + 1];
      if (source !== undefined && source.length > 0) files.push(source);
      index++;
    }
  }
  return files;
}

function uniqueSorted(files: readonly string[]): string[] {
  return [...new Set(files.map(toPosix))].sort();
}

/** A single whitespace-free token that cannot be read as an option: the only shape tried as a revision. */
function revisionCandidate(description: string): string | undefined {
  const trimmed = description.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed) || trimmed.startsWith("-")) return undefined;
  return trimmed;
}

/**
 * Resolve the changed files for a diff description where it is cheap:
 *
 *  - empty or an uncommitted phrase: `git status --porcelain=v1 -z
 *    --untracked-files=all` (or `jj diff --name-only` in Jujutsu);
 *  - a single token git accepts (`A..B`, `A...B`, `HEAD~1`):
 *    `git diff --name-only <it>`. A single revision diffs against the
 *    working tree, so when that is empty (a description that names the
 *    commit to review, such as `HEAD` with a clean tree) the commit itself is
 *    read with `<rev>^!`. A failing command means unknown, not an error, and
 *    so does a revision that still yields no files: every check then runs,
 *    told its scope, rather than none;
 *  - anything else, or no version control: unknown.
 */
export function resolveAmpiReviewChangedFiles(
  description: string,
  repository: AmpiReviewRepository,
  env: AmpiReviewCheckEnv,
): AmpiReviewChangedFiles {
  if (repository.kind === "none") return { kind: "unknown" };
  if (isAmpiReviewUncommittedDescription(description)) {
    if (repository.kind === "jj") {
      const diff = env.runCommand("jj", ["diff", "--name-only"], repository.root);
      return diff.exitCode === 0 ? { kind: "uncommitted", files: uniqueSorted(splitLines(diff.stdout)) } : { kind: "unknown" };
    }
    const status = env.runCommand("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], repository.root);
    return status.exitCode === 0
      ? { kind: "uncommitted", files: uniqueSorted(parseAmpiGitStatusPorcelain(status.stdout)) }
      : { kind: "unknown" };
  }
  const revision = repository.kind === "git" ? revisionCandidate(description) : undefined;
  if (revision === undefined) return { kind: "unknown" };
  const namesOf = (spec: string): string[] | undefined => {
    const diff = env.runCommand(
      "git",
      ["diff", "--name-only", "-z", "--no-renames", "--end-of-options", spec, "--"],
      repository.root,
    );
    return diff.exitCode === 0 ? uniqueSorted(splitNul(diff.stdout)) : undefined;
  };
  let files = namesOf(revision);
  if (files === undefined) return { kind: "unknown" };
  if (files.length === 0 && !revision.includes("..")) files = namesOf(`${revision}^!`) ?? [];
  if (files.length === 0) return { kind: "unknown" };
  return { kind: "revision", revision, files };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** Whether a root-relative path lies in a scope directory (`.` holds everything). */
export function isInAmpiReviewScope(relativePath: string, scope: string): boolean {
  if (scope === ".") return true;
  return relativePath === scope || relativePath.startsWith(`${scope}/`);
}

/** A check that applies to the change, with its changed files when they are known. */
export interface AmpiReviewCheckSelection {
  check: AmpiReviewCheck;
  /** Changed files under the check's scope; absent when the changed files are unknown. */
  changedFiles?: string[];
}

/** Thrown for a `check_filter` name no check has, or a `check_scope` outside the repository. */
export class AmpiReviewCheckSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmpiReviewCheckSelectionError";
  }
}

export interface SelectAmpiReviewChecksInput {
  /** Resolves symlinks so `cwd` and the repository root compare as the same tree; see {@link AmpiReviewCheckEnv.realpath}. */
  realpath?: (absolutePath: string) => string | undefined;
  checks: readonly AmpiReviewCheck[];
  repository: AmpiReviewRepository;
  changes: AmpiReviewChangedFiles;
  /** Working directory `scope` is relative to. */
  cwd: string;
  /** Only checks whose scope is this directory (relative to `cwd`) or below it. */
  scope?: string;
  /** Only checks with these names; an unknown name throws {@link AmpiReviewCheckSelectionError}. */
  filter?: readonly string[];
}

function availableNames(checks: readonly AmpiReviewCheck[]): string {
  const names = [...new Set(checks.map((check) => check.name))].sort();
  return names.length > 0 ? names.join(", ") : "none (no .agents/checks/*.md files were found)";
}

/**
 * The checks that apply, in discovery order: `filter` by name, then `scope`,
 * then, when the changed files are known, the checks whose scope holds at
 * least one changed file.
 */
export function selectAmpiReviewChecks(input: SelectAmpiReviewChecksInput): AmpiReviewCheckSelection[] {
  let checks = [...input.checks];

  const names = (input.filter ?? []).map((name) => name.trim()).filter((name) => name.length > 0);
  if (names.length > 0) {
    const known = new Set(checks.map((check) => check.name));
    const unknown = names.filter((name) => !known.has(name));
    if (unknown.length > 0) {
      throw new AmpiReviewCheckSelectionError(
        `reviewer: no review check named ${unknown.map((name) => `"${name}"`).join(", ")}. Available checks: ${availableNames(input.checks)}.`,
      );
    }
    const wanted = new Set(names);
    checks = checks.filter((check) => wanted.has(check.name));
  }

  const scopeInput = input.scope?.trim();
  if (scopeInput) {
    // git reports the root with symlinks resolved, while cwd may run through
    // one (a symlinked temporary directory), so both sides are canonical.
    const real = (target: string): string => input.realpath?.(target) ?? target;
    const root = real(path.resolve(input.repository.root));
    const target = real(path.resolve(real(path.resolve(input.cwd)), scopeInput));
    const relative = toPosix(path.relative(root, target));
    if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
      throw new AmpiReviewCheckSelectionError(
        `reviewer: check_scope "${scopeInput}" is outside the repository (${input.repository.root}).`,
      );
    }
    const scope = relative.length === 0 ? "." : relative;
    checks = checks.filter((check) => isInAmpiReviewScope(check.scope, scope));
  }

  const changes = input.changes;
  if (changes.kind === "unknown") return checks.map((check) => ({ check }));
  const selections: AmpiReviewCheckSelection[] = [];
  for (const check of checks) {
    const changedFiles = changes.files.filter((file) => isInAmpiReviewScope(file, check.scope));
    if (changedFiles.length > 0) selections.push({ check, changedFiles });
  }
  return selections;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface AmpiReviewCheckPlan {
  repository: AmpiReviewRepository;
  changes: AmpiReviewChangedFiles;
  /** Every check file found, before selection. */
  discovered: AmpiReviewCheck[];
  /** The checks to run. */
  selected: AmpiReviewCheckSelection[];
}

export interface PlanAmpiReviewChecksInput {
  cwd: string;
  diffDescription: string;
  scope?: string;
  filter?: readonly string[];
  env?: AmpiReviewCheckEnv;
}

/**
 * Detect the repository, discover its checks, resolve the changed files and
 * select the checks that apply. The changed files are only resolved when a
 * check exists, so a repository without checks costs one or two commands.
 */
export function planAmpiReviewChecks(input: PlanAmpiReviewChecksInput): AmpiReviewCheckPlan {
  const env = input.env ?? createAmpiReviewCheckEnv();
  const repository = detectAmpiReviewRepository(input.cwd, env);
  const discovered = discoverAmpiReviewChecks(repository, env);
  const changes: AmpiReviewChangedFiles =
    discovered.length > 0 ? resolveAmpiReviewChangedFiles(input.diffDescription, repository, env) : { kind: "unknown" };
  const selected = selectAmpiReviewChecks({
    checks: discovered,
    repository,
    changes,
    cwd: input.cwd,
    ...(env.realpath ? { realpath: (target: string) => env.realpath?.(target) } : {}),
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.filter !== undefined ? { filter: input.filter } : {}),
  });
  return { repository, changes, discovered, selected };
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/** A line that starts (after list markers, emphasis or backticks) with `<path>:<start>-<end>` or `<path>:<line>`. */
const FINDING_LINE = /^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)?[*_`]*[^\s:`*]+:\d+(?:-\d+)?\b/;
const FINDINGS_HEADING = /^\s*(?:#{1,6}\s*)?[*_]*findings[*_]*\s*:?\s*[*_]*\s*$/i;

/**
 * Outcome label of a check that answered without a counted finding. The
 * counter only knows the entry shapes it recognizes, so this label never
 * claims the check passed; the report itself says whether it did.
 */
export const AMPI_REVIEW_NO_COUNTED_FINDINGS_LABEL = "0 counted findings (see report)";

/**
 * Count the findings in a reviewer report: the lines that begin with a
 * `<file path>:<startLine>-<endLine>` location, the entry shape the reviewer
 * system prompt asks for, or a single-line `<file path>:<line>`. When the
 * report has a `Findings` heading line only lines after it count, so a
 * location quoted in the summary is not a finding. Every entry counts,
 * compliments included. Findings in other shapes (a table row, a labelled
 * location) are not counted, which is why a zero count is reported as
 * {@link AMPI_REVIEW_NO_COUNTED_FINDINGS_LABEL}.
 */
export function countAmpiReviewFindings(report: string): number {
  const lines = report.replace(/\r\n?/g, "\n").split("\n");
  const heading = lines.findIndex((line) => FINDINGS_HEADING.test(line));
  const body = heading === -1 ? lines : lines.slice(heading + 1);
  return body.filter((line) => FINDING_LINE.test(line)).length;
}
