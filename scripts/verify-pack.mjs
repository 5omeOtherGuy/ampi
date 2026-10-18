#!/usr/bin/env node
// Publish-time safety gate: guarantee the npm tarballs (the root package and
// packages/ampi-cli) contain ONLY files that are tracked in git. The public git
// repository already defines what is safe to publish (everything gitignored is
// local-only: docs/private/, .env, capture logs, agent notes, ...), so "every
// packaged file is a tracked file" is a strong, general invariant that prevents
// any local-only file from shipping.
//
// This runs from the ACTUAL publish location via the `prepublishOnly`
// lifecycle, so — unlike a clean-checkout test — it can see stray local files
// that exist on the publisher's disk (this is exactly how docs/private/ nearly
// shipped). It fails closed: if the pack list or git index cannot be read, it
// blocks the publish rather than guessing.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, args) {
  return execFileSync(cmd, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function fail(message) {
  console.error(`verify-pack: FAIL — ${message}`);
  process.exit(1);
}

// 1. The files npm would actually publish, for the root package and every
//    package under packages/, as repository-relative paths.
//    `--ignore-scripts` avoids re-entering any lifecycle (and cannot recurse
//    into this guard).
const PACKAGE_DIRS = [".", "packages/ampi-cli"];
const tarballPaths = [];
for (const dir of PACKAGE_DIRS) {
  const folderArgs = dir === "." ? [] : [`./${dir}`];
  let packRaw;
  try {
    packRaw = run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", ...folderArgs]);
  } catch (error) {
    fail(`could not run "npm pack --dry-run --json" for ${dir}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const parsed = JSON.parse(packRaw);
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!entry || !Array.isArray(entry.files)) fail(`npm pack --json did not report a files[] array for ${dir}.`);
    for (const f of entry.files) tarballPaths.push(path.posix.join(dir, String(f.path).replace(/^package\//, "")));
  } catch (error) {
    fail(`could not parse npm pack --json output for ${dir}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// 2. The files tracked in git.
let tracked;
try {
  tracked = new Set(
    run("git", ["ls-files"])
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
} catch (error) {
  fail(
    `could not run "git ls-files": ${error instanceof Error ? error.message : String(error)}. ` +
      "Publishing must run from a git checkout so the tarball can be verified against tracked files.",
  );
}

// 3. Any packaged file that is not tracked in git is a local-only leak.
const untracked = tarballPaths.filter((p) => !tracked.has(p)).sort();
if (untracked.length > 0) {
  console.error("verify-pack: FAIL — an npm tarball contains files that are NOT tracked in git:");
  for (const p of untracked) console.error(`  !! ${p}`);
  console.error("");
  console.error("These are local-only / gitignored files and must never be published.");
  console.error("Exclude them in BOTH .npmignore and the package.json \"files\" allowlist, then retry.");
  process.exit(1);
}

console.error(`verify-pack: PASS — all ${tarballPaths.length} packaged files are tracked in git.`);
