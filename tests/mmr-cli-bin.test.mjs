// Smoke test of the `ampi` executable: help, versions and usage errors are
// answered without starting Pi.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const bin = path.join(repoRoot, "packages", "ampi-cli", "bin", "ampi.js");
const helpFixture = path.join(import.meta.dirname, "fixtures", "ampi-cli", "help.txt");
const UPDATE_FIXTURES = process.env.PI_MMR_UPDATE_FIXTURES === "1";

const runBin = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd: repoRoot, encoding: "utf8" });
const versionOf = (manifest) => JSON.parse(readFileSync(path.join(repoRoot, manifest), "utf8")).version;

describe("ampi executable", () => {
  it("prints the help in the documented layout and exits 0", () => {
    const result = runBin("--help");
    assert.equal(result.status, 0, result.stderr);
    if (UPDATE_FIXTURES) writeFileSync(helpFixture, result.stdout);
    assert.equal(result.stdout, readFileSync(helpFixture, "utf8"));
    assert.equal(result.stderr, "");
  });

  it("prints the ampi-cli, ampi and Pi versions that are installed", () => {
    const result = runBin("version");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      [
        `ampi-cli ${versionOf("packages/ampi-cli/package.json")}`,
        `ampi ${versionOf("package.json")}`,
        `pi ${versionOf("node_modules/@earendil-works/pi-coding-agent/package.json")}`,
        "",
      ].join("\n"),
    );
    assert.equal(runBin("-V").stdout, result.stdout);
  });

  it("exits 2 with a message on a usage error", () => {
    const result = runBin("--settings-file", "settings.json");
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^ampi: --settings-file is not supported/);
  });
});
