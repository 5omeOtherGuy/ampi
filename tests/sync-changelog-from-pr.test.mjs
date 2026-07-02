import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  CANONICAL_HEADINGS,
  appendBulletsToChangelog,
  computeUnreleasedFingerprints,
  extractBlock,
  parseBlock,
  stripFencedCodeBlocks,
  validateBuckets,
} from "../scripts/sync-changelog-from-pr.mjs";

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function makeChangelog(unreleasedBody, { trailing = "\n" } = {}) {
  return [
    "# Changelog",
    "",
    "All notable changes to `ampi` will be documented in this file.",
    "",
    "## Unreleased",
    ...(unreleasedBody ? ["", unreleasedBody] : []),
    "",
    "## [0.0.1] - 2025-01-01",
    "",
    "### Added",
    "",
    "- initial release.",
  ].join("\n") + trailing;
}

const BLOCK_START = "<!-- ampi changelog:start -->";
const BLOCK_END = "<!-- ampi changelog:end -->";

function prBody(block, extra = "") {
  return `Some PR description.\n\n${BLOCK_START}\n${block}\n${BLOCK_END}\n\n${extra}`;
}

describe("extractBlock", () => {
  it("returns undefined when no marker block is present", () => {
    assert.equal(extractBlock("just a PR body without markers"), undefined);
  });

  it("returns trimmed content between markers", () => {
    const body = prBody("### Fixed\n\n- `mmr-core`: foo.");
    const block = extractBlock(body);
    assert.equal(block, "### Fixed\n\n- `mmr-core`: foo.");
  });

  it("ignores marker blocks inside ``` fenced code blocks (documented examples)", () => {
    const body = [
      "## Example",
      "",
      "```md",
      "<!-- ampi changelog:start -->",
      "### Fixed",
      "",
      "- `mmr-core`: example bullet inside a fence.",
      "<!-- ampi changelog:end -->",
      "```",
      "",
      "No real block here.",
    ].join("\n");
    assert.equal(extractBlock(body), undefined);
  });

  it("ignores marker blocks inside ~~~ fenced code blocks", () => {
    const body = [
      "~~~",
      "<!-- ampi changelog:start -->",
      "### Fixed",
      "",
      "- `mmr-core`: fenced.",
      "<!-- ampi changelog:end -->",
      "~~~",
    ].join("\n");
    assert.equal(extractBlock(body), undefined);
  });

  it("extracts a real marker block when documentation fences also contain examples", () => {
    const body = [
      "## Example documentation",
      "",
      "```",
      "<!-- ampi changelog:start -->",
      "### Added",
      "- `mmr-core`: don't include me.",
      "<!-- ampi changelog:end -->",
      "```",
      "",
      "## The actual changelog",
      "",
      "<!-- ampi changelog:start -->",
      "### Fixed",
      "",
      "- `mmr-core`: real bullet.",
      "<!-- ampi changelog:end -->",
    ].join("\n");
    const block = extractBlock(body);
    assert.ok(block, "extractBlock should return the un-fenced marker block");
    assert.match(block, /real bullet/);
    assert.doesNotMatch(block, /don't include me/);
  });

  it("returns undefined when end marker comes before start marker", () => {
    const body = `${BLOCK_END}\n${BLOCK_START}\n### Fixed\n- foo`;
    assert.equal(extractBlock(body), undefined);
  });
});

describe("stripFencedCodeBlocks", () => {
  it("blanks lines inside ``` fences while preserving line numbers", () => {
    const input = ["keep1", "```", "inside1", "inside2", "```", "keep2"].join("\n");
    const out = stripFencedCodeBlocks(input);
    const lines = out.split("\n");
    assert.equal(lines.length, 6);
    assert.equal(lines[0], "keep1");
    assert.equal(lines[1], "");
    assert.equal(lines[2], "");
    assert.equal(lines[3], "");
    assert.equal(lines[4], "");
    assert.equal(lines[5], "keep2");
  });

  it("supports nested-looking fences via run-length matching (``` inside ~~~ stays inside)", () => {
    const input = ["~~~", "```", "still inside", "```", "~~~", "outside"].join("\n");
    const out = stripFencedCodeBlocks(input);
    assert.equal(out.split("\n")[5], "outside");
    assert.equal(out.split("\n")[2], "");
  });
});

describe("validateBuckets", () => {
  it("rejects an empty block with a 'no headings + bullets' message", () => {
    const buckets = parseBlock("");
    const errors = validateBuckets(buckets, prBody(""));
    assert.ok(errors.some((e) => /no headings \+ bullets/.test(e)), errors.join("\n"));
  });

  it("rejects disallowed headings and names the heading", () => {
    const block = "### Notes\n\n- `mmr-core`: something.";
    const buckets = parseBlock(block);
    const errors = validateBuckets(buckets, prBody(block));
    assert.ok(errors.some((e) => /'### Notes'/.test(e)), errors.join("\n"));
  });

  it("ignores public-unsafe wording inside fenced code blocks", () => {
    const buckets = new Map([["Fixed", ["- `mmr-core`: ok."]]]);
    const watchedPhrase = `${["rev", "erse"].join("")}-${["engine", "ered"].join("")} from the binary`;
    const body = [
      "## What NOT to write",
      "",
      "```",
      `Do not write '${watchedPhrase}'.`,
      "```",
      "",
      "<!-- ampi changelog:start -->",
      "### Fixed",
      "- `mmr-core`: ok.",
      "<!-- ampi changelog:end -->",
    ].join("\n");
    assert.deepEqual(validateBuckets(buckets, body), []);
  });

  it("rejects public-unsafe wording anywhere in the PR body", () => {
    const block = "### Fixed\n\n- `mmr-core`: ok.";
    const watchedPhrase = `${["rev", "erse"].join("")}-${["engine", "ering"].join("")} notes`;
    const body = prBody(block, `This PR is based on ${watchedPhrase}.`);
    const errors = validateBuckets(parseBlock(block), body);
    assert.ok(errors.some((e) => /public-unsafe wording/.test(e)), errors.join("\n"));
  });

  it("accepts a valid block + safe body", () => {
    const block = "### Fixed\n\n- `mmr-core`: ok.";
    const body = prBody(block);
    const errors = validateBuckets(parseBlock(block), body);
    assert.deepEqual(errors, []);
  });
});

describe("appendBulletsToChangelog — existing heading", () => {
  it("appends new bullet at end of an existing heading block", () => {
    const original = makeChangelog("### Fixed\n\n- `mmr-core`: existing bullet.");
    const buckets = new Map([["Fixed", ["- `mmr-core`: new bullet."]]]);
    const { text, added } = appendBulletsToChangelog(original, buckets);
    assert.equal(added, 1);
    assert.ok(text.includes("- `mmr-core`: existing bullet.\n- `mmr-core`: new bullet."), text);
    assert.ok(text.includes("## [0.0.1] - 2025-01-01"));
  });
});

describe("appendBulletsToChangelog — new heading", () => {
  it("inserts a new heading before the next canonical heading in Unreleased", () => {
    const original = makeChangelog("### Fixed\n\n- `mmr-core`: existing.");
    const buckets = new Map([["Added", ["- `mmr-web`: brand new bullet."]]]);
    const { text, added } = appendBulletsToChangelog(original, buckets);
    assert.equal(added, 1);
    const addedIdx = text.indexOf("### Added");
    const fixedIdx = text.indexOf("### Fixed");
    assert.ok(addedIdx > 0 && fixedIdx > 0 && addedIdx < fixedIdx, text);
    // The inserted heading lives under Unreleased, not after the released
    // section.
    const versionIdx = text.indexOf("## [0.0.1]");
    assert.ok(addedIdx < versionIdx, text);
  });

  it("inserts a new heading at end of Unreleased when no later canonical heading exists", () => {
    const original = makeChangelog("### Added\n\n- `mmr-core`: existing.");
    const buckets = new Map([["Documentation", ["- `docs`: brand new doc bullet."]]]);
    const { text, added } = appendBulletsToChangelog(original, buckets);
    assert.equal(added, 1);
    const docsIdx = text.indexOf("### Documentation");
    const addedIdx = text.indexOf("### Added");
    const versionIdx = text.indexOf("## [0.0.1]");
    assert.ok(addedIdx > 0 && docsIdx > addedIdx && docsIdx < versionIdx, text);
  });
});

describe("appendBulletsToChangelog — fingerprint dedup", () => {
  it("skips a bullet whose fingerprint already exists under Unreleased", () => {
    const bullet = "- `mmr-core`: duplicate bullet.";
    const original = makeChangelog(`### Fixed\n\n${bullet}`);
    const buckets = new Map([["Fixed", [bullet]]]);
    const { text, added } = appendBulletsToChangelog(original, buckets);
    assert.equal(added, 0);
    assert.equal(text, original);
  });

  it("appends only the new bullet when one of two is a duplicate", () => {
    const dup = "- `mmr-core`: duplicate.";
    const fresh = "- `mmr-core`: fresh bullet.";
    const original = makeChangelog(`### Fixed\n\n${dup}`);
    const buckets = new Map([["Fixed", [dup, fresh]]]);
    const { text, added } = appendBulletsToChangelog(original, buckets);
    assert.equal(added, 1);
    assert.ok(text.includes(`${dup}\n${fresh}`), text);
  });
});

describe("computeUnreleasedFingerprints — algorithm parity", () => {
  it("matches sha256('<heading>\\n<bulletContent>') for a single Unreleased bullet", () => {
    const bullet = "- `mmr-core`: foo.";
    const changelog = makeChangelog(`### Fixed\n\n${bullet}`);
    const fingerprints = computeUnreleasedFingerprints(changelog);
    const expected = sha256(`Fixed\n${bullet}`);
    assert.ok(fingerprints.has(expected), [...fingerprints].join(", "));
    assert.equal(fingerprints.size, 1);
  });

  it("uses default heading 'Changes' for bullets with no preceding ### heading", () => {
    const bullet = "- `mmr-core`: orphan bullet.";
    const changelog = makeChangelog(bullet);
    const fingerprints = computeUnreleasedFingerprints(changelog);
    assert.ok(fingerprints.has(sha256(`Changes\n${bullet}`)), [...fingerprints].join(", "));
  });
});

describe("appendBulletsToChangelog — idempotency", () => {
  it("returns added=0 the second time the same PR body is applied", () => {
    const original = makeChangelog("### Fixed\n\n- `mmr-core`: existing.");
    const buckets = new Map([["Fixed", ["- `mmr-core`: idem bullet."]]]);
    const first = appendBulletsToChangelog(original, buckets);
    assert.equal(first.added, 1);
    const second = appendBulletsToChangelog(first.text, buckets);
    assert.equal(second.added, 0);
    assert.equal(second.text, first.text);
  });
});

describe("appendBulletsToChangelog — canonical order", () => {
  it("inserts multiple new headings in canonical order when Unreleased has none", () => {
    const original = makeChangelog("");
    const buckets = new Map([
      ["Documentation", ["- `docs`: D."]],
      ["Added", ["- `mmr-core`: A."]],
      ["Security", ["- `mmr-core`: S."]],
      ["Fixed", ["- `mmr-core`: F."]],
      ["Removed", ["- `mmr-core`: R."]],
      ["Changed", ["- `mmr-core`: C."]],
    ]);
    const { text, added } = appendBulletsToChangelog(original, buckets);
    assert.equal(added, CANONICAL_HEADINGS.length);
    const positions = CANONICAL_HEADINGS.map((h) => ({ h, idx: text.indexOf(`### ${h}`) }));
    for (const p of positions) {
      assert.ok(p.idx > 0, `missing heading ${p.h}: ${text}`);
    }
    for (let i = 1; i < positions.length; i += 1) {
      assert.ok(
        positions[i].idx > positions[i - 1].idx,
        `canonical order violated: ${positions[i - 1].h}@${positions[i - 1].idx} should precede ${positions[i].h}@${positions[i].idx}\n${text}`,
      );
    }
    // All inserted headings stay inside the Unreleased section.
    const versionIdx = text.indexOf("## [0.0.1]");
    for (const p of positions) {
      assert.ok(p.idx < versionIdx, `${p.h} leaked past Unreleased`);
    }
  });
});

describe("appendBulletsToChangelog — missing Unreleased", () => {
  it("throws when CHANGELOG.md has no '## Unreleased' section", () => {
    const text = "# Changelog\n\n## [0.0.1]\n\n### Added\n\n- x.\n";
    assert.throws(() => appendBulletsToChangelog(text, new Map([["Fixed", ["- foo"]]])), /Unreleased/);
  });
});
