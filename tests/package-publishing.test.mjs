import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const SCOPED_NAME = "@skippermissions/ampi";

async function readJson(rel) {
  return JSON.parse(await readFile(path.join(repoRoot, rel), "utf8"));
}

let packCache;
function packFiles() {
  // Run the ground-truth pack once and memoize. `--ignore-scripts` skips the
  // `prepare` lifecycle (which would otherwise run scripts/install-hooks.mjs
  // and touch git config in a checkout) without changing the packed file set.
  if (!packCache) {
    let raw;
    try {
      raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (error) {
      assert.fail(
        `Could not run "npm pack --dry-run --json": ${
          error instanceof Error ? error.message : String(error)
        }. This is the ground-truth packaging check; do not skip it.`,
      );
    }
    const parsed = JSON.parse(raw);
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    assert.ok(entry && Array.isArray(entry.files), "npm pack --json must report a files[] array.");
    packCache = { entry, paths: entry.files.map((f) => f.path) };
  }
  return packCache;
}

// Publishing readiness: ampi ships to npm as the scoped package
// `@skippermissions/ampi` (public), and the tarball must carry only the
// runtime/package-user surface — never local-only, dev-only, or private files.
describe("npm publishing metadata", () => {
  it("declares the scoped public package name in package.json", async () => {
    const pkg = await readJson("package.json");
    assert.equal(pkg.name, SCOPED_NAME);
    assert.equal(
      pkg.publishConfig?.access,
      "public",
      "a scoped package must set publishConfig.access = 'public' to publish publicly.",
    );
  });

  it("keeps the package-lock root name aligned with package.json", async () => {
    const lock = await readJson("package-lock.json");
    assert.equal(lock.name, SCOPED_NAME);
    assert.equal(lock.packages?.[""]?.name, SCOPED_NAME);
  });

  it("declares a files allowlist that ships runtime source and excludes ampi-debug", async () => {
    const pkg = await readJson("package.json");
    assert.ok(Array.isArray(pkg.files), "package.json must declare a files[] allowlist.");
    for (const required of ["src/", "docs/", "README.md", "LICENSE", "CHANGELOG.md"]) {
      assert.ok(
        pkg.files.includes(required),
        `files[] must include "${required}" so users get the runtime and docs.`,
      );
    }
    assert.ok(
      pkg.files.includes("!src/extensions/ampi-debug"),
      "files[] must negate the dev-only ampi-debug extension so it is never packaged.",
    );
    assert.ok(
      pkg.files.includes("!docs/private"),
      "files[] must negate docs/private so local-only planning notes are never packaged.",
    );
  });

  it("repeats the docs/private exclusion in .npmignore (npm ignores .gitignore when .npmignore exists)", async () => {
    const npmignore = await readFile(path.join(repoRoot, ".npmignore"), "utf8");
    const excludesPrivate = npmignore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .some((line) => line === "docs/private" || line === "docs/private/");
    assert.ok(
      excludesPrivate,
      "`.npmignore` must list `docs/private/`; npm consults .npmignore instead of .gitignore, so the gitignore rule alone would leak the directory.",
    );
  });
});

describe("npm pack tarball contents", () => {
  it("packs under the scoped name with the required user files", () => {
    const { entry, paths } = packFiles();
    assert.equal(entry.name, SCOPED_NAME);
    for (const required of ["README.md", "LICENSE", "CHANGELOG.md", "package.json", "src/index.ts"]) {
      assert.ok(paths.includes(required), `tarball must include "${required}"; got ${paths.length} files.`);
    }
    assert.ok(
      paths.some((p) => p.startsWith("src/extensions/ampi-core/")),
      "tarball must include the runtime extension source.",
    );
  });

  it("excludes local-only, dev-only, and private files", () => {
    const { paths } = packFiles();
    const forbidden = [
      ".claude",
      ".agents",
      ".codex",
      ".github",
      ".githooks",
      ".pi",
      ".test-src",
      "AGENTS.md",
      "CLAUDE.md",
      "PI_MMR_COMPETITOR_REPORT.md",
      "implementation-notes.html",
      "tests",
      "scripts",
      "tsconfig.json",
      ".editorconfig",
      "biome.json",
      "package-lock.json",
      ".npmignore",
      "docs/private",
    ];
    const leaks = paths.filter((p) => forbidden.some((f) => p === f || p.startsWith(`${f}/`)));
    assert.deepEqual(leaks, [], `tarball leaks local/dev-only files: ${leaks.join(", ")}`);
  });

  it("excludes the dev-only ampi-debug extension", () => {
    const { paths } = packFiles();
    const packaged = paths.filter((p) => p.startsWith("src/extensions/ampi-debug/"));
    assert.deepEqual(packaged, [], `ampi-debug must not be packaged; found: ${packaged.join(", ")}`);
  });

  // Ground-truth regression guard for the docs/private leak: `docs/private/` is
  // gitignored, so it is absent from a fresh checkout and a plain pack cannot
  // observe the leak. Materialize a sentinel file under docs/private, run a
  // dedicated pack, and assert the exclusion actually fires. Runs its own pack
  // (not the memoized packFiles) so the sentinel is present on disk.
  it("excludes docs/private even when the directory exists on disk", () => {
    const privateDir = path.join(repoRoot, "docs", "private");
    const sentinel = path.join(privateDir, "__leak_probe__.md");
    let createdDir = false;
    try {
      try {
        mkdirSync(privateDir);
        createdDir = true;
      } catch (error) {
        if (!(error && error.code === "EEXIST")) throw error;
      }
      writeFileSync(sentinel, "# leak probe — must never be packaged\n");

      const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const parsed = JSON.parse(raw);
      const entry = Array.isArray(parsed) ? parsed[0] : parsed;
      const leaks = entry.files.map((f) => f.path).filter((p) => p.startsWith("docs/private/"));
      assert.deepEqual(
        leaks,
        [],
        `docs/private/ must never be packaged; leaked: ${leaks.join(", ")}`,
      );
    } finally {
      rmSync(sentinel, { force: true });
      if (createdDir) rmSync(privateDir, { recursive: true, force: true });
    }
  });
});
