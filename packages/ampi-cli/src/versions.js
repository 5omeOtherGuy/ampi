// SemVer versions and the version ranges the ampi manifests use: `>=x.y.z`,
// `^x.y.z` and a plain `x.y.z`. Other range forms are reported as unknown
// rather than guessed at, so the command needs no SemVer dependency.

/** SemVer 2.0.0: major.minor.patch, an optional pre-release and optional build metadata. */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * @typedef {object} Version
 * @property {[number, number, number]} core Major, minor and patch.
 * @property {string[]} prerelease Pre-release identifiers; empty for a release.
 */

/**
 * @param {string} text
 * @returns {Version | undefined} The version, or undefined when `text` is not a SemVer version.
 */
export function parseVersion(text) {
  const match = SEMVER.exec(text);
  if (match === null) return undefined;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] === undefined ? [] : match[4].split(".") };
}

/**
 * Compare two versions by SemVer precedence (build metadata is ignored).
 *
 * @param {Version} a
 * @param {Version} b
 * @returns {number} Negative when `a` comes first, positive when `b` does, 0 when equal.
 */
export function compareVersions(a, b) {
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  // A release comes after its pre-releases.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) return b.prerelease.length - a.prerelease.length;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) return Number(left) - Number(right);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * Whether `version` lies in `range`. `^x.y.z` allows changes that leave the
 * first non-zero part of x.y.z alone (`^1.3.0` is below 2.0.0, `^0.3.1`
 * below 0.4.0, `^0.0.3` below 0.0.4). As npm decides, a pre-release version
 * is in a range only when the range's own version is a pre-release of the
 * same major.minor.patch.
 *
 * @param {string} version
 * @param {string} range
 * @returns {boolean | undefined} undefined when the version or the range has another form.
 */
export function satisfiesRange(version, range) {
  const parsed = parseVersion(version.trim());
  const match = /^(>=|\^)?\s*(\S+)$/.exec(range.trim());
  const base = match === null ? undefined : parseVersion(match[2]);
  if (parsed === undefined || match === null || base === undefined) return undefined;
  if (parsed.prerelease.length > 0 && (base.prerelease.length === 0 || parsed.core.some((part, index) => part !== base.core[index]))) {
    return false;
  }
  const operator = match[1];
  if (operator === undefined) return compareVersions(parsed, base) === 0;
  if (compareVersions(parsed, base) < 0) return false;
  if (operator === ">=") return true;
  const [major, minor, patch] = base.core;
  /** @type {[number, number, number]} */
  const limit = major > 0 ? [major + 1, 0, 0] : minor > 0 ? [0, minor + 1, 0] : [0, 0, patch + 1];
  // The limit's own pre-releases (2.0.0-beta) are already out: they are pre-releases of another version.
  return compareVersions(parsed, { core: limit, prerelease: [] }) < 0;
}
