// Public-safety lint coverage. Exercises the lint helper itself and runs it
// on a narrow set of committed surfaces: the renderer output, the
// effective-surface fixtures, and the PRIVATE_REFERENCE marker handling.
//
// The sensitive test inputs (maintainer username, private research repo name)
// are assembled from fragments so this test's own source never carries a
// contiguous, publishable copy of those tokens.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  auditPrivateReferenceRegistry,
  lintPublicSafetyText,
  stripPrivateReferenceRegions,
} from "./helpers/public-safety-lint.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

const joinFrag = (sep, ...parts) => parts.join(sep);
const RESEARCH_REPO_NAME = joinFrag("-", "multi", "model", "routing", "pi");
const LOCAL_HOME_PATH = `/home/${joinFrag("", "some", "other", "guy")}`;

describe("Phase B public-safety lint: helper behavior", () => {
  it("flags reverse-engineering claims", () => {
    const findings = lintPublicSafetyText("This is reverse-engineered from the binary.");
    assert.ok(findings.some((f) => f.rule === "reverse-engineering"));
  });

  it("flags decompilation claims", () => {
    const findings = lintPublicSafetyText("Notes from the decompiled bundle.");
    assert.ok(findings.some((f) => f.rule === "decompilation"));
  });

  it("flags extracted-bundle / extracted-prompt claims", () => {
    const findings = lintPublicSafetyText("Copied from the extracted bundle.");
    assert.ok(findings.some((f) => f.rule === "extraction-claim"));
  });

  it("flags the private research repo name", () => {
    const findings = lintPublicSafetyText(`See ~/projects/${RESEARCH_REPO_NAME}/...`);
    assert.ok(findings.some((f) => f.rule === "private-research-repo"));
  });

  it("flags absolute home paths", () => {
    const findings = lintPublicSafetyText(`Path ${LOCAL_HOME_PATH}/projects/foo`);
    assert.ok(findings.some((f) => f.rule === "absolute-home-path"));
  });

  it("flags docs/private/ path references", () => {
    const findings = lintPublicSafetyText("See docs/private/some-spec.md §6.");
    assert.ok(
      findings.some((f) => f.rule === "docs-private-path"),
      `expected docs-private-path finding; got ${JSON.stringify(findings)}`,
    );
  });

  it("flags secret-looking placeholders", () => {
    const findings = lintPublicSafetyText(["AKIA", "IOSFODNN7EXAMPLE"].join(""));
    assert.ok(findings.some((f) => f.rule === "aws-access-key"));
  });

  it("does not flag bare public product or tool names in ordinary prose", () => {
    // Naming a public product or tool in normal prose must not trip the
    // provenance-claim rules; only the claim shapes themselves are flagged.
    const findings = lintPublicSafetyText("Ripgrep is a fast search tool we rely on.");
    assert.equal(findings.length, 0);
  });

  it("skips text inside TypeScript PRIVATE_REFERENCE markers", () => {
    const text = [
      "Normal line.",
      "// PRIVATE_REFERENCE",
      "reverse-engineered from the binary",
      "// END PRIVATE_REFERENCE",
      "Another normal line.",
    ].join("\n");
    const findings = lintPublicSafetyText(text);
    assert.equal(findings.length, 0);
  });

  it("skips text inside Markdown PRIVATE_REFERENCE markers", () => {
    const text = [
      "Normal line.",
      "<!-- PRIVATE_REFERENCE -->",
      "Notes from the decompiled bundle.",
      "<!-- END PRIVATE_REFERENCE -->",
      "Another normal line.",
    ].join("\n");
    const findings = lintPublicSafetyText(text);
    assert.equal(findings.length, 0);
  });

  it("still flags forbidden tokens that sit outside markers in the same file", () => {
    const text = [
      "// PRIVATE_REFERENCE",
      "reverse-engineered",
      "// END PRIVATE_REFERENCE",
      "And here is a separate decompilation claim.",
    ].join("\n");
    const findings = lintPublicSafetyText(text);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].rule, "decompilation");
  });

  it("counts stripped regions", () => {
    const text = [
      "// PRIVATE_REFERENCE",
      "x",
      "// END PRIVATE_REFERENCE",
      "<!-- PRIVATE_REFERENCE -->",
      "y",
      "<!-- END PRIVATE_REFERENCE -->",
    ].join("\n");
    const { regionCount } = stripPrivateReferenceRegions(text);
    assert.equal(regionCount, 2);
  });
});

describe("Phase B public-safety lint: applied to Phase B surfaces", () => {
  it("Phase B effective-surface fixtures contain no forbidden tokens", () => {
    const dir = path.join(repoRoot, "tests/fixtures/mmr-effective-surface");
    const files = readdirSync(dir).filter((name) => name.endsWith(".md"));
    assert.ok(files.length > 0, "expected Phase B effective-surface fixtures to exist");
    const allFindings = [];
    for (const file of files) {
      const text = readFileSync(path.join(dir, file), "utf8");
      const findings = lintPublicSafetyText(text, { surface: `tests/fixtures/mmr-effective-surface/${file}` });
      allFindings.push(...findings);
    }
    assert.deepEqual(
      allFindings,
      [],
      `lint findings in effective-surface fixtures: ${JSON.stringify(allFindings, null, 2)}`,
    );
  });

  it("the renderer module contains no forbidden tokens", () => {
    const text = readFileSync(
      path.join(repoRoot, "src/extensions/ampi-core/prompt-debug-renderer.ts"),
      "utf8",
    );
    const findings = lintPublicSafetyText(text, { surface: "prompt-debug-renderer.ts" });
    assert.deepEqual(findings, []);
  });

  it("mmr-subagents source and tests do not reference docs/private/* spec paths", () => {
    // Public-safety guard for the gitignored private research folder.
    // Source files and deterministic tests must explain their rationale in
    // ampi-owned language; behavioral pins belong in the public surface
    // (types, JSDoc, tests) without anchoring to a private path.
    const surfaces = [
      "src/extensions/ampi-workers/builtin-workers/finder.ts",
      "src/extensions/ampi-workers/builtin-workers/oracle.ts",
      "src/extensions/ampi-workers/builtin-workers/task.ts",
      "src/extensions/ampi-workers/framework/runner.ts",
      "src/extensions/ampi-workers/rendering/worker-trail.ts",
      "src/extensions/ampi-core/subagent-resolver.ts",
      "src/extensions/ampi-core/subagent-profiles.ts",
      "tests/mmr-subagents-finder.test.mjs",
      "tests/mmr-subagents-oracle.test.mjs",
      "tests/mmr-subagents-task.test.mjs",
      "tests/mmr-subagents-runner.test.mjs",
      "tests/mmr-subagents-extension.test.mjs",
      "tests/mmr-subagents-progress-rendering.test.mjs",
    ];
    const allFindings = [];
    for (const file of surfaces) {
      const text = readFileSync(path.join(repoRoot, file), "utf8");
      const findings = lintPublicSafetyText(text, { surface: file });
      // Only assert on the docs-private-path rule here; other rules
      // are exercised by their own scoped tests above.
      allFindings.push(...findings.filter((f) => f.rule === "docs-private-path"));
    }
    assert.deepEqual(
      allFindings,
      [],
      `mmr-subagents docs/private leak findings: ${JSON.stringify(allFindings, null, 2)}`,
    );
  });

  it("Phase C-edited source files contain no forbidden tokens outside PRIVATE_REFERENCE regions", () => {
    const files = [
      "src/extensions/ampi-web/tools.ts",
      "src/extensions/ampi-patch/index.ts",
      "src/extensions/ampi-tasks/index.ts",
      "src/extensions/ampi-tasks/ask-user-choice-tool.ts",
      "src/extensions/ampi-tasks/README.md",
      "src/extensions/ampi-shell/tools.ts",
      "src/extensions/ampi-shell/README.md",
      "src/extensions/ampi-painter/tool.ts",
      "src/extensions/ampi-painter/model.ts",
      "src/extensions/ampi-painter/index.ts",
      "src/extensions/ampi-painter/README.md",
      "src/extensions/ampi-core/builtin-tool-guidance.ts",
      "src/extensions/ampi-core/tool-disable.ts",
      "src/extensions/ampi-core/mode-registry.ts",
      "src/extensions/ampi-core/subtree-guidance.ts",
      "src/extensions/ampi-core/subtree-guidance-hooks.ts",
      "src/extensions/ampi-core/README.md",
      "src/extensions/ampi-core/skill-paths.ts",
      "src/extensions/ampi-gui/README.md",
      "src/extensions/ampi-gui/index.ts",
      "src/extensions/ampi-gui/config.ts",
      "src/extensions/ampi-gui/server.ts",
      "src/extensions/ampi-gui/bridge.ts",
      "src/extensions/ampi-core/live-registry.ts",
      "src/extensions/ampi-core/thread-status-events.ts",
      "packages/ampi-cli/src/live-registry.js",
      "packages/ampi-cli/src/top.js",
      "packages/ampi-cli/src/run-output.js",
      "packages/ampi-cli/src/mcp-config.js",
      "src/extensions/ampi-gui/view-model.ts",
      "src/extensions/ampi-gui/client/index.html",
      "src/extensions/ampi-gui/client/app.js",
      "src/extensions/ampi-gui/client/app-mode.js",
      "src/extensions/ampi-gui/client/markdown.js",
      "src/extensions/ampi-gui/client/commands.js",
      "src/extensions/ampi-gui/client/keys.js",
      "src/extensions/ampi-gui/client/keymap.js",
      "src/extensions/ampi-gui/client/palette.js",
      "src/extensions/ampi-gui/client/fuzzy.js",
      "src/extensions/ampi-gui/client/titlebar.js",
      "src/extensions/ampi-gui/client/sidebar.js",
      "src/extensions/ampi-gui/client/composer.js",
      "src/extensions/ampi-gui/client/tokens.css",
      "src/extensions/ampi-gui/client/app.css",
      "src/extensions/ampi-core/session-query.ts",
      "src/cli-threads.ts",
      "src/cli-dev-keys.ts",
      "packages/ampi-cli/src/dev-keys.js",
      "src/extensions/ampi-tui/overlays/outline.ts",
      "src/extensions/ampi-core/thread-reports.ts",
      "packages/ampi-cli/src/threads.js",
      "packages/ampi-cli/src/pi-compat.js",
      "packages/ampi-cli/src/argv.js",
      "packages/ampi-cli/src/tools.js",
      "packages/ampi-cli/src/doctor.js",
      "packages/ampi-cli/src/review.js",
      "src/extensions/ampi-workers/builtin-workers/review-run.ts",
      "src/extensions/ampi-workers/review/findings.ts",
      "tests/mmr-cli-review.test.mjs",
      "packages/ampi-cli/src/update.js",
      "packages/ampi-cli/src/versions.js",
      "tests/mmr-cli-doctor-update.test.mjs",
      "packages/ampi-cli/src/skill.js",
      "packages/ampi-cli/src/skill-sources.js",
      "packages/ampi-cli/src/mcp.js",
      "src/extensions/ampi-core/README.md",
      "packages/ampi-cli/src/sdk-session.js",
      "packages/ampi-cli/src/log.js",
      "tests/mmr-cli-log.test.mjs",
      "packages/ampi-cli/README.md",
      "docs/quick-reference.md",
      "tests/mmr-cli-threads-context-usage.test.mjs",
      "src/extensions/ampi-tui/overlays/info.ts",
      "src/extensions/ampi-tui/overlays/mcp-info.ts",
      "src/extensions/ampi-tui/overlays/intro.ts",
      "src/extensions/ampi-tui/chrome/intro-record.ts",
      "src/extensions/ampi-core/skill-sources.ts",
      "src/extensions/ampi-tui/pi-compat/selection.ts",
      "src/extensions/ampi-core/permissions.ts",
      "src/extensions/ampi-core/permission-defaults.ts",
      "src/extensions/ampi-core/guarded-files.ts",
      "src/extensions/ampi-permissions/gate.ts",
      "src/extensions/ampi-permissions/config.ts",
      "src/extensions/ampi-permissions/index.ts",
      "src/extensions/ampi-permissions/delegate.ts",
      "src/extensions/ampi-permissions/README.md",
      "tests/mmr-permissions-delegate.test.mjs",
      "tests/mmr-permissions-subagents.test.mjs",
      "tests/mmr-permissions-guarded.test.mjs",
      "tests/helpers/permissions-gate.mjs",
      "tests/mmr-cli-tools.test.mjs",
      "tests/mmr-cli-skill.test.mjs",
      "tests/fixtures/ampi-cli/offline-guard.mjs",
      "src/extensions/ampi-workers/builtin-workers/reviewer.ts",
      "src/extensions/ampi-workers/builtin-workers/view-media.ts",
      "src/extensions/ampi-workers/profiles/prompts.ts",
      "src/extensions/ampi-workers/review/checks.ts",
      "src/extensions/ampi-workers/README.md",
      "tests/mmr-workers-review-checks.test.mjs",
      "tests/mmr-cli-mcp.test.mjs",
      "tests/fixtures/ampi-cli/mcp-echo-server.mjs",
      "packages/ampi-cli/src/import/index.js",
      "packages/ampi-cli/src/import/claude-code.js",
      "packages/ampi-cli/src/import/ledger.js",
      "packages/ampi-cli/src/import/messages.js",
      "packages/ampi-cli/src/import/codex.js",
      "packages/ampi-cli/src/import/opencode.js",
      "src/extensions/ampi-core/imported-session.ts",
      "src/extensions/ampi-threads/README.md",
      "tests/mmr-cli-import.test.mjs",
      "tests/mmr-core-imported-session.test.mjs",
      "packages/ampi-cli/src/command-tree.js",
      "packages/ampi-cli/src/completions.js",
      "tests/mmr-cli-completions.test.mjs",
      "tests/fixtures/ampi-cli/module-recorder.mjs",
    ];
    const allFindings = [];
    for (const file of files) {
      const text = readFileSync(path.join(repoRoot, file), "utf8");
      const findings = lintPublicSafetyText(text, { surface: file });
      allFindings.push(...findings);
    }
    assert.deepEqual(
      allFindings,
      [],
      `Phase C lint findings: ${JSON.stringify(allFindings, null, 2)}`,
    );
  });
});

describe("Phase B public-safety lint: PRIVATE_REFERENCE registry audit", () => {
  it("every PRIVATE_REFERENCE region is registered in PRIVATE_REWRITE.md", () => {
    const { hits, discrepancies } = auditPrivateReferenceRegistry();
    assert.deepEqual(
      discrepancies,
      [],
      [
        `PRIVATE_REFERENCE registry is out of sync.`,
        `Hits found via git grep: ${JSON.stringify(hits, null, 2)}`,
        `Discrepancies: ${discrepancies.join("\n  - ")}`,
      ].join("\n"),
    );
  });
});
