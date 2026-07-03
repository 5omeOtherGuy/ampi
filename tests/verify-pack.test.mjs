import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const script = path.join(repoRoot, "scripts", "verify-pack.mjs");

function runGuard() {
  return spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

// scripts/verify-pack.mjs is the publish-time gate wired into `prepublishOnly`.
// It must pass on a clean tree and fail closed the moment any file that npm
// would pack is not tracked in git (the exact class of bug that nearly shipped
// docs/private/).
describe("verify-pack publish guard", () => {
  it("is wired into prepublishOnly so npm publish cannot skip it", async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
    assert.equal(
      pkg.scripts?.prepublishOnly,
      "node scripts/verify-pack.mjs",
      "package.json must run the pack guard on the prepublishOnly lifecycle.",
    );
  });

  it("passes when every packaged file is tracked in git", () => {
    const result = runGuard();
    assert.equal(
      result.status,
      0,
      `verify-pack should pass on a clean tree; stderr:\n${result.stderr}`,
    );
    assert.match(result.stderr, /PASS/);
  });

  it("fails closed when an untracked file would be packaged", () => {
    // Plant an untracked file under docs/ (an allowlisted root) so npm pack
    // includes it, then assert the guard rejects the publish. Clean up always.
    const stray = path.join(repoRoot, "docs", "__verify_pack_probe__.md");
    try {
      writeFileSync(stray, "# untracked probe — must block publish\n");
      const result = runGuard();
      assert.equal(result.status, 1, "verify-pack must exit non-zero when an untracked file is packaged.");
      assert.match(result.stderr, /FAIL/);
      assert.match(result.stderr, /docs\/__verify_pack_probe__\.md/);
    } finally {
      rmSync(stray, { force: true });
    }
  });
});
