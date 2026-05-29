// Pure helpers for the subagent-activation failure stderr marker.
//
// Producer (mmr-core/index.ts:failClosedSubagent) writes the marker to
// the child's stderr; consumer (mmr-subagents/runner.ts) detects it and
// converts the run into a hard failure even when Pi exits 0. Keeping the
// marker + parser in a tiny pure module avoids string drift between the
// two sides.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const MODULE = "extensions/mmr-core/subagent-resolver.ts";

describe("MMR_SUBAGENT_ACTIVATION_FAILURE_STDERR_PREFIX", () => {
  it("exports a stable, non-empty prefix", async () => {
    const mod = await importSource(MODULE);
    assert.equal(typeof mod.MMR_SUBAGENT_ACTIVATION_FAILURE_STDERR_PREFIX, "string");
    assert.ok(mod.MMR_SUBAGENT_ACTIVATION_FAILURE_STDERR_PREFIX.length > 0);
    assert.match(
      mod.MMR_SUBAGENT_ACTIVATION_FAILURE_STDERR_PREFIX,
      /^pi-mmr:.+: $/,
      "prefix must be the literal `pi-mmr: subagent activation failed: ` shape so producer + consumer cannot drift",
    );
  });
});

describe("extractMmrSubagentActivationFailure(stderr)", () => {
  it("returns undefined when stderr contains no marker", async () => {
    const { extractMmrSubagentActivationFailure } = await importSource(MODULE);
    assert.equal(extractMmrSubagentActivationFailure(""), undefined);
    assert.equal(extractMmrSubagentActivationFailure("some unrelated warning\n"), undefined);
    assert.equal(extractMmrSubagentActivationFailure("Error: not the marker\n"), undefined);
  });

  it("extracts the message that follows the marker on a single line", async () => {
    const { extractMmrSubagentActivationFailure } = await importSource(MODULE);
    const stderr = 'pi-mmr: subagent activation failed: Unknown subagent profile "no-such-profile". Known profiles: finder.\n';
    const message = extractMmrSubagentActivationFailure(stderr);
    assert.equal(
      message,
      'Unknown subagent profile "no-such-profile". Known profiles: finder.',
    );
  });

  it("ignores noise before and after the marker line", async () => {
    const { extractMmrSubagentActivationFailure } = await importSource(MODULE);
    const stderr = [
      "Warning: something earlier",
      'pi-mmr: subagent activation failed: Subagent "finder" was invoked with --tools bash,write, but the profile tool allowlist is grep,find,read.',
      "Extension error (...): downstream noise",
      "",
    ].join("\n");
    const message = extractMmrSubagentActivationFailure(stderr);
    assert.equal(
      message,
      'Subagent "finder" was invoked with --tools bash,write, but the profile tool allowlist is grep,find,read.',
    );
  });

  it("returns the last occurrence when the marker appears multiple times", async () => {
    const { extractMmrSubagentActivationFailure } = await importSource(MODULE);
    const stderr = [
      "pi-mmr: subagent activation failed: first failure message.",
      "pi-mmr: subagent activation failed: later, more specific failure message.",
    ].join("\n");
    assert.equal(
      extractMmrSubagentActivationFailure(stderr),
      "later, more specific failure message.",
    );
  });

  it("returns undefined for non-string input", async () => {
    const { extractMmrSubagentActivationFailure } = await importSource(MODULE);
    assert.equal(extractMmrSubagentActivationFailure(undefined), undefined);
    assert.equal(extractMmrSubagentActivationFailure(null), undefined);
    assert.equal(extractMmrSubagentActivationFailure(42), undefined);
  });
});
