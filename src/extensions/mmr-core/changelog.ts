import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export const MMR_CHANGELOG_STATE_VERSION = 1;
export const MMR_CHANGELOG_STATE_RELATIVE_PATH = "data/pi-mmr/changelog/state.json";

const PACKAGE_NAME = "pi-mmr";
const VERSION_HEADER_PATTERN = /^##\s+\[?v?(\d+)\.(\d+)\.(\d+)\]?(?:\s|$)/;
const UNRELEASED_HEADER_PATTERN = /^##\s+Unreleased\b/i;
const DEBUG_ENV_VAR = "PI_MMR_CHANGELOG_DEBUG";

function isChangelogDebugEnabled(): boolean {
  const raw = process.env[DEBUG_ENV_VAR];
  if (typeof raw !== "string") return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

function emitChangelogDebug(line: string): void {
  if (!isChangelogDebugEnabled()) return;
  try {
    process.stderr.write(`[pi-mmr changelog] ${line}\n`);
  } catch {
    // diagnostic must never block startup
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name || "Error";
    const message = error.message || "(no message)";
    return `${name}: ${message}`;
  }
  return `non-error: ${String(error)}`;
}

type SessionStartLikeEvent = {
  type?: "session_start";
  reason?: "startup" | "reload" | "new" | "resume" | "fork";
};

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface MmrChangelogEntry extends ParsedVersion {
  version: string;
  content: string;
}

export interface MmrUnreleasedChangeBlock {
  heading: string;
  content: string;
  fingerprint: string;
}

export interface MmrUnreleasedSection {
  content: string;
  contentHash: string;
  blocks: MmrUnreleasedChangeBlock[];
}

export interface ParsedMmrChangelog {
  versionedEntries: MmrChangelogEntry[];
  unreleased?: MmrUnreleasedSection;
}

export interface MmrChangelogDisplay {
  displayVersion: string;
  markdown: string;
  kind: "versioned" | "unreleased";
}

export interface MmrChangelogInstallState {
  lastSeenVersion?: string;
  lastSeenAt?: string;
  lastSeenUnreleasedHash?: string;
  seenUnreleasedFingerprints?: string[];
}

export interface MmrChangelogState {
  version: typeof MMR_CHANGELOG_STATE_VERSION;
  installs: Record<string, MmrChangelogInstallState>;
}

export interface EvaluateMmrChangelogOptions {
  packageRoot?: string;
  statePath?: string;
  now?: string;
}

interface PackageMetadata {
  version: string;
  private: boolean;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // ignore malformed JSON; changelog display must never block startup
  }
  return undefined;
}

function parseVersionParts(version: string | undefined): ParsedVersion | undefined {
  if (!version) return undefined;
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return undefined;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

function compareParsedVersions(left: ParsedVersion, right: ParsedVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

export function compareMmrVersions(leftVersion: string, rightVersion: string): number | undefined {
  const left = parseVersionParts(leftVersion);
  const right = parseVersionParts(rightVersion);
  if (!left || !right) return undefined;
  return compareParsedVersions(left, right);
}

function normalizeVersion(major: string, minor: string, patch: string): string {
  return `${Number.parseInt(major, 10)}.${Number.parseInt(minor, 10)}.${Number.parseInt(patch, 10)}`;
}

function extractUnreleasedChangeBlocks(content: string): MmrUnreleasedChangeBlock[] {
  const lines = content.split("\n");
  const blocks: MmrUnreleasedChangeBlock[] = [];
  let heading = "Changes";
  let currentLines: string[] | undefined;
  let currentHeading = heading;

  const flush = () => {
    if (!currentLines) return;
    while (currentLines.length > 0 && currentLines[currentLines.length - 1].trim() === "") {
      currentLines.pop();
    }
    const blockContent = currentLines.join("\n").trim();
    if (blockContent) {
      blocks.push({
        heading: currentHeading,
        content: blockContent,
        fingerprint: sha256(`${currentHeading}\n${blockContent}`),
      });
    }
    currentLines = undefined;
  };

  for (const line of lines.slice(1)) {
    const headingMatch = line.match(/^###\s+(.+?)\s*$/);
    if (headingMatch) {
      flush();
      heading = headingMatch[1];
      continue;
    }

    if (line.startsWith("## ")) {
      flush();
      break;
    }

    if (line.startsWith("- ")) {
      flush();
      currentHeading = heading;
      currentLines = [line];
      continue;
    }

    if (currentLines) {
      currentLines.push(line);
    }
  }

  flush();
  return blocks;
}

export function parseMmrChangelog(markdown: string): ParsedMmrChangelog {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const versionedEntries: MmrChangelogEntry[] = [];
  let unreleased: MmrUnreleasedSection | undefined;
  let currentLines: string[] = [];
  let currentVersion: MmrChangelogEntry | undefined;
  let currentIsUnreleased = false;

  const flush = () => {
    if (currentLines.length === 0) return;
    const content = currentLines.join("\n").trim();
    if (!content) return;
    if (currentVersion) {
      versionedEntries.push({ ...currentVersion, content });
    } else if (currentIsUnreleased) {
      unreleased = {
        content,
        contentHash: sha256(content),
        blocks: extractUnreleasedChangeBlocks(content),
      };
    }
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      currentLines = [line];
      currentVersion = undefined;
      currentIsUnreleased = false;

      const versionMatch = line.match(VERSION_HEADER_PATTERN);
      if (versionMatch) {
        const version = normalizeVersion(versionMatch[1], versionMatch[2], versionMatch[3]);
        currentVersion = {
          version,
          major: Number.parseInt(versionMatch[1], 10),
          minor: Number.parseInt(versionMatch[2], 10),
          patch: Number.parseInt(versionMatch[3], 10),
          content: "",
        };
      } else if (UNRELEASED_HEADER_PATTERN.test(line)) {
        currentIsUnreleased = true;
      } else {
        currentLines = [];
      }
      continue;
    }

    if (currentVersion || currentIsUnreleased) {
      currentLines.push(line);
    }
  }

  flush();
  return { versionedEntries, ...(unreleased ? { unreleased } : {}) };
}

export function getNewVersionedMmrChangelogEntries(
  entries: readonly MmrChangelogEntry[],
  lastSeenVersion: string | undefined,
  currentVersion: string | undefined,
): MmrChangelogEntry[] {
  const lastSeen = parseVersionParts(lastSeenVersion) ?? { major: 0, minor: 0, patch: 0 };
  const current = parseVersionParts(currentVersion);
  return entries.filter((entry) => {
    if (compareParsedVersions(entry, lastSeen) <= 0) return false;
    if (current && compareParsedVersions(entry, current) > 0) return false;
    return true;
  });
}

function getCurrentVersionedMmrChangelogEntries(
  entries: readonly MmrChangelogEntry[],
  currentVersion: string | undefined,
): MmrChangelogEntry[] {
  const current = parseVersionParts(currentVersion);
  if (!current) return [];
  return entries.filter((entry) => compareParsedVersions(entry, current) === 0);
}

function getPackageRootStartPath(): string {
  return fileURLToPath(import.meta.url);
}

export function resolveMmrPackageRoot(startPath = getPackageRootStartPath()): string | undefined {
  let dir = startPath;
  try {
    if (existsSync(dir) && statSync(dir).isFile()) {
      dir = dirname(dir);
    }
  } catch {
    dir = dirname(dir);
  }

  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "CHANGELOG.md"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return undefined;
}

export function resolveMmrAgentDir(): string {
  return getAgentDir();
}

export function resolveMmrChangelogStatePath(agentDir = resolveMmrAgentDir()): string {
  return join(agentDir, MMR_CHANGELOG_STATE_RELATIVE_PATH);
}

function readPackageMetadata(packageRoot: string): PackageMetadata | undefined {
  const packageJsonPath = join(packageRoot, "package.json");
  if (!existsSync(packageJsonPath)) return undefined;
  const pkg = parseJsonObject(readFileSync(packageJsonPath, "utf8"));
  if (!pkg) return undefined;
  const version = typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : "0.0.0";
  return { version, private: pkg.private === true };
}

function readPackageChangelog(packageRoot: string): string | undefined {
  const changelogPath = join(packageRoot, "CHANGELOG.md");
  if (!existsSync(changelogPath)) return undefined;
  return readFileSync(changelogPath, "utf8");
}

function createEmptyState(): MmrChangelogState {
  return { version: MMR_CHANGELOG_STATE_VERSION, installs: {} };
}

function sanitizeInstallState(value: unknown): MmrChangelogInstallState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const seenUnreleasedFingerprints = Array.isArray(candidate.seenUnreleasedFingerprints)
    ? candidate.seenUnreleasedFingerprints.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  return {
    ...(typeof candidate.lastSeenVersion === "string" ? { lastSeenVersion: candidate.lastSeenVersion } : {}),
    ...(typeof candidate.lastSeenAt === "string" ? { lastSeenAt: candidate.lastSeenAt } : {}),
    ...(typeof candidate.lastSeenUnreleasedHash === "string" ? { lastSeenUnreleasedHash: candidate.lastSeenUnreleasedHash } : {}),
    ...(seenUnreleasedFingerprints ? { seenUnreleasedFingerprints } : {}),
  };
}

export function readMmrChangelogState(statePath = resolveMmrChangelogStatePath()): MmrChangelogState {
  if (!existsSync(statePath)) return createEmptyState();
  const raw = parseJsonObject(readFileSync(statePath, "utf8"));
  if (!raw || raw.version !== MMR_CHANGELOG_STATE_VERSION) return createEmptyState();
  const installsValue = raw.installs;
  if (!installsValue || typeof installsValue !== "object" || Array.isArray(installsValue)) return createEmptyState();
  const installs: Record<string, MmrChangelogInstallState> = {};
  for (const [key, value] of Object.entries(installsValue)) {
    const installState = sanitizeInstallState(value);
    if (installState) installs[key] = installState;
  }
  return { version: MMR_CHANGELOG_STATE_VERSION, installs };
}

export function writeMmrChangelogState(state: MmrChangelogState, statePath = resolveMmrChangelogStatePath()): void {
  mkdirSync(dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tempPath, statePath);
}

function getInstallKey(packageRoot: string): string {
  return sha256(resolve(packageRoot));
}

function currentUnreleasedFingerprints(parsed: ParsedMmrChangelog): string[] {
  return parsed.unreleased?.blocks.map((block) => block.fingerprint) ?? [];
}

function buildInstallState(
  packageVersion: string,
  parsed: ParsedMmrChangelog,
  now: string,
): MmrChangelogInstallState {
  return {
    lastSeenVersion: packageVersion,
    lastSeenAt: now,
    ...(parsed.unreleased ? { lastSeenUnreleasedHash: parsed.unreleased.contentHash } : {}),
    seenUnreleasedFingerprints: currentUnreleasedFingerprints(parsed),
  };
}

function buildUnreleasedMarkdown(blocks: readonly MmrUnreleasedChangeBlock[]): string {
  const lines = ["## Unreleased"];
  let currentHeading: string | undefined;
  for (const block of blocks) {
    if (block.heading !== currentHeading) {
      lines.push("", `### ${block.heading}`, "");
      currentHeading = block.heading;
    } else {
      lines.push("");
    }
    lines.push(block.content);
  }
  return lines.join("\n").trim();
}

function shouldUseUnreleasedFallback(metadata: PackageMetadata, parsed: ParsedMmrChangelog): boolean {
  return metadata.private && metadata.version === "0.0.0" && Boolean(parsed.unreleased);
}

export function evaluateMmrChangelogForDisplay(options: EvaluateMmrChangelogOptions = {}): MmrChangelogDisplay | undefined {
  try {
    const packageRoot = options.packageRoot ?? resolveMmrPackageRoot();
    if (!packageRoot) return undefined;

    const metadata = readPackageMetadata(packageRoot);
    const changelog = readPackageChangelog(packageRoot);
    if (!metadata || changelog === undefined) return undefined;

    const statePath = options.statePath ?? resolveMmrChangelogStatePath();
    const now = options.now ?? new Date().toISOString();
    const parsed = parseMmrChangelog(changelog);
    const state = readMmrChangelogState(statePath);
    const installKey = getInstallKey(packageRoot);
    const previous = state.installs[installKey];

    if (!previous) {
      const initialVersionedEntries = getCurrentVersionedMmrChangelogEntries(parsed.versionedEntries, metadata.version);
      state.installs[installKey] = buildInstallState(metadata.version, parsed, now);
      writeMmrChangelogState(state, statePath);
      if (initialVersionedEntries.length > 0) {
        return {
          displayVersion: initialVersionedEntries[0].version,
          markdown: initialVersionedEntries.map((entry) => entry.content).join("\n\n"),
          kind: "versioned",
        };
      }
      if (shouldUseUnreleasedFallback(metadata, parsed) && parsed.unreleased && parsed.unreleased.blocks.length > 0) {
        return {
          displayVersion: metadata.version,
          markdown: buildUnreleasedMarkdown(parsed.unreleased.blocks),
          kind: "unreleased",
        };
      }
      return undefined;
    }

    const versionedEntries = getNewVersionedMmrChangelogEntries(
      parsed.versionedEntries,
      previous.lastSeenVersion,
      metadata.version,
    );
    if (versionedEntries.length > 0) {
      state.installs[installKey] = buildInstallState(metadata.version, parsed, now);
      writeMmrChangelogState(state, statePath);
      return {
        displayVersion: versionedEntries[0].version,
        markdown: versionedEntries.map((entry) => entry.content).join("\n\n"),
        kind: "versioned",
      };
    }

    if (shouldUseUnreleasedFallback(metadata, parsed) && parsed.unreleased) {
      const seen = new Set(previous.seenUnreleasedFingerprints ?? []);
      const newBlocks = parsed.unreleased.blocks.filter((block) => !seen.has(block.fingerprint));
      if (newBlocks.length > 0) {
        state.installs[installKey] = buildInstallState(metadata.version, parsed, now);
        writeMmrChangelogState(state, statePath);
        return {
          displayVersion: metadata.version,
          markdown: buildUnreleasedMarkdown(newBlocks),
          kind: "unreleased",
        };
      }
      if (previous.lastSeenUnreleasedHash !== parsed.unreleased.contentHash) {
        state.installs[installKey] = buildInstallState(metadata.version, parsed, now);
        writeMmrChangelogState(state, statePath);
      }
    }

    return undefined;
  } catch (error) {
    emitChangelogDebug(`evaluateMmrChangelogForDisplay failed: ${describeError(error)}`);
    return undefined;
  }
}

function hasExistingSessionEntries(ctx: ExtensionContext): boolean {
  const sessionManager = ctx.sessionManager as { getEntries?: () => unknown };
  try {
    const entries = sessionManager.getEntries?.();
    return Array.isArray(entries) && entries.length > 0;
  } catch {
    return false;
  }
}

type ChangelogSkipReason = "!hasUI" | `event.reason=${string}` | "existing-session-entries";

function getChangelogSkipReason(event: SessionStartLikeEvent, ctx: ExtensionContext): ChangelogSkipReason | undefined {
  if (!ctx.hasUI) return "!hasUI";
  if (event.reason === "reload" || event.reason === "resume" || event.reason === "fork") {
    return `event.reason=${event.reason}` as ChangelogSkipReason;
  }
  if (hasExistingSessionEntries(ctx)) return "existing-session-entries";
  return undefined;
}

export function shouldCheckMmrChangelogOnSessionStart(event: SessionStartLikeEvent, ctx: ExtensionContext): boolean {
  return getChangelogSkipReason(event, ctx) === undefined;
}

export function formatMmrChangelogNotice(display: MmrChangelogDisplay): string {
  const heading = display.kind === "versioned" ? `pi-mmr What's New (v${display.displayVersion})` : "pi-mmr What's New";
  return [
    heading,
    "",
    display.markdown.trim(),
    "",
    "Use /mmr-changelog to view the full pi-mmr changelog.",
  ].join("\n");
}

export function getFullMmrChangelogMarkdown(packageRoot = resolveMmrPackageRoot()): string {
  if (!packageRoot) return "No pi-mmr changelog entries found.";
  try {
    const changelog = readPackageChangelog(packageRoot);
    if (changelog === undefined) return "No pi-mmr changelog entries found.";
    const parsed = parseMmrChangelog(changelog);
    const sections = [
      ...(parsed.unreleased ? [parsed.unreleased.content] : []),
      ...parsed.versionedEntries.map((entry) => entry.content),
    ];
    return sections.length > 0 ? sections.join("\n\n") : "No pi-mmr changelog entries found.";
  } catch {
    return "No pi-mmr changelog entries found.";
  }
}

export function showMmrChangelogCommand(ctx: ExtensionContext, options: { packageRoot?: string } = {}): void {
  ctx.ui.notify(`${PACKAGE_NAME} Changelog\n\n${getFullMmrChangelogMarkdown(options.packageRoot)}`, "info");
}

export async function maybeShowMmrChangelogOnSessionStart(
  event: SessionStartLikeEvent,
  ctx: ExtensionContext,
  options: EvaluateMmrChangelogOptions = {},
): Promise<void> {
  const skipReason = getChangelogSkipReason(event, ctx);
  if (skipReason !== undefined) {
    emitChangelogDebug(`session_start skipped: ${skipReason}`);
    return;
  }
  const display = evaluateMmrChangelogForDisplay(options);
  if (!display) return;
  // Use Pi's persistent "warning" notification channel rather than the coalesced
  // "info" status line so the post-update notice remains visible at session start.
  // "error" would be semantically wrong for a release-notes banner.
  ctx.ui.notify(formatMmrChangelogNotice(display), "warning");
}
