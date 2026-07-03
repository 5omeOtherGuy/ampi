// Parity guard for the additive `Ampi*` / `AMPI_*` brand aliases in the
// package root barrel (`src/index.ts`).
//
// The barrel keeps the original `Mmr*` / `MMR_*` names as the primary contract
// and additionally re-exports each of them under its brand-aligned `Ampi*` /
// `AMPI_*` name. This test proves that aliasing stays COMPLETE (no `Mmr*`
// public export is left without an `Ampi*` counterpart) and HONEST (each
// counterpart is the same binding, or — for the handful of hand-authored
// sibling constants like env-var names — a value that differs only by the
// brand token).
//
// It is deliberately generic: it derives every pair from the live export
// surface and the barrel source text, so it needs no hand-maintained list of
// the ~240 aliased symbols.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

/** Brand-transform an `Mmr*` / `MMR_*` identifier to its `Ampi*` / `AMPI_*` form. */
function toAmpi(name) {
  return name.replace(/MMR_/g, "AMPI_").replace(/Mmr/g, "Ampi");
}

/** Collapse both brand tokens so brand-divergent constants compare equal. */
function neutralizeBrand(value) {
  return value.toLowerCase().replace(/ampi/g, "\u00a7").replace(/mmr/g, "\u00a7");
}

const MMR_NAME = /Mmr|MMR_/;

// The only pairs allowed to NOT be strict-identity re-exports: hand-authored
// sibling constants whose `Ampi*` value intentionally differs from the `Mmr*`
// value by the brand token (env-var names, provider names, feature-gate ids,
// persisted-entry keys). Every other value pair MUST be the same binding.
// Keep this list closed: a new divergent constant is a deliberate decision,
// not something the test should wave through.
const BRAND_DIVERGENT_CONSTANTS = new Set([
  "MMR_ASYNC_TASKS_FEATURE_GATE",
  "MMR_ASYNC_TASKS_PROVIDER_NAME",
  "MMR_CUSTOM_SUBAGENTS_FEATURE_GATE",
  "MMR_CUSTOM_SUBAGENTS_PROVIDER_NAME",
  "MMR_GITHUB_ENABLE_ENV",
  "MMR_GITHUB_FEATURE_GATE",
  "MMR_GITHUB_PROVIDER_NAME",
  "MMR_GITHUB_TOOL_OWNER",
  "MMR_HISTORY_ENABLE_ENV",
  "MMR_HISTORY_FEATURE_GATE",
  "MMR_HISTORY_PROVIDER_NAME",
  "MMR_MODE_STATE_ENTRY",
  "MMR_SESSION_FALLBACK_ENTRY",
  "MMR_SUBAGENTS_ASYNC_PUSH_ENV",
  "MMR_SUBAGENTS_ASYNC_TASKS_FEATURE_GATE",
  "MMR_SUBAGENTS_FEATURE_GATE",
  "MMR_SUBAGENTS_PROVIDER_NAME",
  "MMR_WEB_FEATURE_GATE",
  "MMR_WEB_PROVIDER_NAME",
  "MMR_WORKERS_FEATURE_GATE",
  "MMR_WORKERS_PROVIDER_NAME",
]);

describe("root barrel: Ampi* alias parity", () => {
  let root;
  let barrelText;

  before(async () => {
    root = await importSource("index.ts");
    const sourceRoot = getPreparedSourceRoot();
    barrelText = await fs.readFile(pathToFileURL(`${sourceRoot}/index.ts`), "utf8");
  });

  it("every Mmr*/MMR_* runtime (value) export has a defined Ampi*/AMPI_* counterpart", () => {
    const missing = [];
    for (const key of Object.keys(root)) {
      if (!MMR_NAME.test(key)) continue;
      const ampi = toAmpi(key);
      if (ampi === key) continue;
      if (!(ampi in root) || root[ampi] === undefined) missing.push(`${key} -> ${ampi}`);
    }
    assert.deepEqual(missing, [], `root barrel is missing Ampi aliases for: ${missing.join(", ")}`);
  });

  it("every non-allowlisted value pair is a strict-identity re-export", () => {
    const bad = [];
    for (const key of Object.keys(root)) {
      if (!MMR_NAME.test(key)) continue;
      const ampi = toAmpi(key);
      if (ampi === key || !(ampi in root)) continue;
      if (BRAND_DIVERGENT_CONSTANTS.has(key)) continue; // handled by the next test
      if (root[ampi] !== root[key]) {
        bad.push(`${key} (${typeof root[key]}) vs ${ampi} (${typeof root[ampi]})`);
      }
    }
    assert.deepEqual(
      bad,
      [],
      `Ampi alias must be the exact same binding as its Mmr export (add to BRAND_DIVERGENT_CONSTANTS only for a deliberate divergent constant): ${bad.join(", ")}`,
    );
  });

  it("each allowlisted divergent constant is a string differing only by brand token", () => {
    const bad = [];
    for (const key of BRAND_DIVERGENT_CONSTANTS) {
      const ampi = toAmpi(key);
      if (!(key in root) || !(ampi in root)) {
        bad.push(`${key}: missing ${key in root ? ampi : key}`);
        continue;
      }
      if (root[ampi] === root[key]) {
        bad.push(`${key}: identical binding — remove it from BRAND_DIVERGENT_CONSTANTS`);
        continue;
      }
      if (
        typeof root[ampi] !== "string" ||
        typeof root[key] !== "string" ||
        neutralizeBrand(root[key]) !== neutralizeBrand(root[ampi])
      ) {
        bad.push(`${key}: not a brand-only string divergence (${JSON.stringify(root[key])} vs ${JSON.stringify(root[ampi])})`);
      }
    }
    assert.deepEqual(bad, [], `allowlisted divergent constants failed validation: ${bad.join("; ")}`);
  });

  it("every Mmr*/MMR_* export name in the barrel source (incl. type-only) has an Ampi* export name", () => {
    // Runtime coverage above cannot see type-only exports (they are erased), so
    // assert type parity against the barrel source text. Collect every exported
    // identifier (the name after `as`, or the bare name) from each
    // `export [type] { ... } from "..."` statement.
    const exported = new Set();
    const stmtRe = /export\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*"[^"]+";/g;
    for (const match of barrelText.matchAll(stmtRe)) {
      for (const raw of match[1].split(",")) {
        const entry = raw.trim();
        if (!entry) continue;
        const parsed = entry.match(/^[A-Za-z0-9_]+(?:\s+as\s+([A-Za-z0-9_]+))?$/);
        assert.ok(parsed, `unparsed export entry in src/index.ts: ${JSON.stringify(entry)}`);
        exported.add(parsed[1] ?? entry.split(/\s+as\s+/)[0]);
      }
    }

    const missing = [];
    for (const name of exported) {
      if (!MMR_NAME.test(name)) continue;
      const ampi = toAmpi(name);
      if (ampi === name) continue;
      if (!exported.has(ampi)) missing.push(`${name} -> ${ampi}`);
    }
    assert.deepEqual(missing, [], `barrel exports these Mmr names without an Ampi export: ${missing.join(", ")}`);
  });
});
