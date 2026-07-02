#!/usr/bin/env node
// Configure this clone's hooksPath to `.githooks/`. Idempotent and
// silent on no-op paths so it never breaks `npm install` for downstream
// consumers (Pi packages, CI containers, etc.).
//
// Run automatically via the `prepare` script when `npm install` is run
// inside this repo. Safe to invoke manually at any time.
//
// Skip silently when:
//   - we are not inside a git working tree (e.g. installed as a tarball
//     dependency, or running in a docker layer that does not include
//     the .git/ dir);
//   - the repo's top-level package.json is not this one (defensive: do
//     not reconfigure unrelated git repos);
//   - the `.githooks/` directory is missing (the prepare step ran in a
//     clone that does not include the hooks);
//   - core.hooksPath is already set to the right value (idempotent).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

function quietGit(args, opts = {}) {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
      ...opts,
    })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

function note(msg) {
  // Visible enough to spot when running `npm install` manually, but no
  // noisy banner. Single line, prefixed.
  process.stderr.write(`ampi install-hooks: ${msg}\n`);
}

const top = quietGit(["rev-parse", "--show-toplevel"]);
if (!top) {
  // Not a git checkout (likely an extracted tarball). No-op.
  process.exit(0);
}
if (path.resolve(top) !== repoRoot) {
  // Running inside some other repo (e.g. a parent monorepo); do not
  // reconfigure that repo's hooks from here.
  process.exit(0);
}

// Defensive: confirm we are still in ampi (not a fork that lifted the
// scripts/ directory). Use the package.json `name` field as a sentinel.
const pkgPath = path.join(repoRoot, "package.json");
if (!existsSync(pkgPath)) process.exit(0);
let pkgName;
try {
  pkgName = JSON.parse(readFileSync(pkgPath, "utf8")).name;
} catch {
  process.exit(0);
}
if (pkgName !== "ampi") process.exit(0);

const hooksDir = path.join(repoRoot, ".githooks");
if (!existsSync(hooksDir) || !statSync(hooksDir).isDirectory()) {
  // Hooks directory missing; nothing to install.
  process.exit(0);
}

const current = quietGit(["config", "--get", "core.hooksPath"]);
if (current === ".githooks") {
  // Already configured. Silent success.
  process.exit(0);
}

const set = quietGit(["config", "core.hooksPath", ".githooks"]);
if (set === undefined) {
  // Could not write git config (read-only checkout? permission denied?).
  // Loud enough to spot, but do not fail npm install over it.
  note("could not set core.hooksPath; pre-commit/pre-push drift checks will not run");
  process.exit(0);
}

note("configured core.hooksPath=.githooks (pre-commit/pre-push drift checks active)");
process.exit(0);
