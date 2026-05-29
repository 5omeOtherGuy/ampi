import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";

// Real Pi smoke test. Skipped by default to keep `npm test` deterministic and
// offline; opt in by setting PI_MMR_REAL_PI=1 in the environment. Requires the
// `pi` CLI on PATH. Verifies that Pi can load this package as an extension
// without crashing — `--list-models` exercises the extension registration path
// (commands, shortcuts, settings load, mode resolution) end-to-end.
const REAL_PI_ENABLED = process.env.PI_MMR_REAL_PI === "1";

describe("mmr-core real Pi integration", { skip: !REAL_PI_ENABLED }, () => {
  it("loads as an extension under `pi -e <repo> --list-models`", () => {
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const result = spawnSync("pi", ["-e", repoRoot, "--list-models"], {
      encoding: "utf8",
      timeout: 30_000,
    });

    assert.equal(result.error, undefined, `pi failed to spawn: ${result.error?.message}`);
    assert.equal(
      result.status,
      0,
      `pi exited with ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    // Pi writes the --list-models table to stderr in non-TTY mode; the header
    // line only appears after every registered extension finished loading
    // without throwing, so seeing it anywhere in the combined output proves
    // mmr-core's `extension(pi)` registration ran cleanly.
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.match(combined, /provider\s+model\s+context/);
  });
});
