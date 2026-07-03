// Architecture guardrail: the capability manifest must stay consistent with the
// real wiring. These checks are static and deterministic; they fail when an
// extension is added/renamed/retired without updating the manifest, when tool
// ownership collides, when the subagent child keep-set references an unknown
// extension, or when `ampi-core` gains a new sibling-extension import.
//
// As the greenfield extension split proceeds, each chunk updates
// `src/extensions/manifest.ts` in lockstep and these guardrails keep the
// manifest, package.json, on-disk layout, and child keep-set in agreement.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const repoRoot = path.resolve(import.meta.dirname, "..");
const extensionsDir = path.join(repoRoot, "src", "extensions");

function readPackageJson() {
  return JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
}

function listExtensionDirs() {
  return readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Recursively collect every `.ts` file under a directory. */
function collectTsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

async function loadManifest() {
  return importSource("extensions/manifest.ts");
}

describe("architecture manifest guardrails", () => {
  it("auto-loaded manifest entrypoints exactly match package.json pi.extensions", async () => {
    const { MMR_EXTENSION_MANIFEST } = await loadManifest();
    const pkg = readPackageJson();

    const manifestAutoLoaded = MMR_EXTENSION_MANIFEST.filter((e) => e.autoLoaded)
      .map((e) => e.entrypoint)
      .sort();
    const piExtensions = [...pkg.pi.extensions].sort();

    assert.deepEqual(
      manifestAutoLoaded,
      piExtensions,
      "manifest auto-loaded entrypoints must equal package.json pi.extensions",
    );
  });

  it("manifest export subpaths exactly match package.json exports for extensions", async () => {
    const { MMR_EXTENSION_MANIFEST } = await loadManifest();
    const pkg = readPackageJson();

    const exportedEntrypoints = new Set(Object.values(pkg.exports));
    // Every manifest entry with an exportSubpath must map to its entrypoint;
    // entries without one must not be publicly exported. Rebrand aliases are
    // also manifest-owned and intentionally map to the same entrypoint.
    for (const entry of MMR_EXTENSION_MANIFEST) {
      if (entry.exportSubpath === null) {
        assert.equal(
          exportedEntrypoints.has(entry.entrypoint),
          false,
          `${entry.name}: has no exportSubpath but is exported in package.json`,
        );
        continue;
      }
      assert.equal(
        pkg.exports[entry.exportSubpath],
        entry.entrypoint,
        `${entry.name}: exports["${entry.exportSubpath}"] must point at its entrypoint`,
      );
      for (const alias of entry.exportAliases ?? []) {
        assert.equal(
          pkg.exports[alias],
          entry.entrypoint,
          `${entry.name}: exports["${alias}"] must point at its entrypoint`,
        );
      }
    }

    // Every ./extensions/* export key must be owned by exactly one manifest entry.
    const exportKeys = Object.keys(pkg.exports).filter((k) => k.startsWith("./extensions/"));
    const manifestSubpaths = new Set();
    for (const entry of MMR_EXTENSION_MANIFEST) {
      if (entry.exportSubpath !== null) manifestSubpaths.add(entry.exportSubpath);
      for (const alias of entry.exportAliases ?? []) manifestSubpaths.add(alias);
    }
    for (const key of exportKeys) {
      assert.equal(
        manifestSubpaths.has(key),
        true,
        `package.json exports key ${key} has no manifest entry`,
      );
    }
    assert.equal(
      manifestSubpaths.size,
      exportKeys.length,
      "manifest export subpaths and package.json extension exports must be 1:1",
    );
  });

  it("every preferred ampi extension subpath has the matching mmr compatibility alias", async () => {
    const { MMR_EXTENSION_MANIFEST } = await loadManifest();
    const pkg = readPackageJson();

    for (const entry of MMR_EXTENSION_MANIFEST) {
      if (entry.exportSubpath === null) continue;
      assert.match(
        entry.name,
        /^ampi-/,
        `${entry.name}: manifest name must use canonical ampi-* extension id`,
      );
      assert.match(
        entry.entrypoint,
        /^\.\/src\/extensions\/ampi-[^/]+\/index\.ts$/,
        `${entry.name}: entrypoint must use canonical src/extensions/ampi-* path`,
      );
      assert.match(
        entry.exportSubpath,
        /^\.\/extensions\/ampi-/,
        `${entry.name}: exportSubpath must use preferred ./extensions/ampi-* namespace`,
      );
      const expectedAlias = entry.exportSubpath.replace("./extensions/ampi-", "./extensions/mmr-");
      assert.notEqual(
        expectedAlias,
        entry.exportSubpath,
        `${entry.name}: exportSubpath must use the ampi-* preferred namespace for alias derivation`,
      );
      assert.equal(
        (entry.exportAliases ?? []).includes(expectedAlias),
        true,
        `${entry.name}: manifest exportAliases must include ${expectedAlias}`,
      );
      assert.equal(
        pkg.exports[expectedAlias],
        entry.entrypoint,
        `${entry.name}: exports["${expectedAlias}"] must point at its entrypoint`,
      );
    }
  });

  it("manifest covers exactly the on-disk src/extensions directories", async () => {
    const { MMR_EXTENSION_MANIFEST } = await loadManifest();
    const manifestNames = MMR_EXTENSION_MANIFEST.map((e) => e.name).sort();
    const dirNames = listExtensionDirs();
    assert.deepEqual(
      manifestNames,
      dirNames,
      "manifest names must match the src/extensions directory set exactly",
    );
  });

  it("every manifest entrypoint exists on disk", async () => {
    const { MMR_EXTENSION_MANIFEST } = await loadManifest();
    for (const entry of MMR_EXTENSION_MANIFEST) {
      const abs = path.join(repoRoot, entry.entrypoint.replace(/^\.\//, ""));
      assert.equal(
        readdirSync(path.dirname(abs)).includes(path.basename(abs)),
        true,
        `${entry.name}: entrypoint ${entry.entrypoint} must exist`,
      );
    }
  });

  it("no active tool name is owned by more than one extension", async () => {
    const { MMR_EXTENSION_MANIFEST } = await loadManifest();
    const seen = new Map();
    for (const entry of MMR_EXTENSION_MANIFEST) {
      for (const tool of entry.tools) {
        assert.equal(
          seen.has(tool),
          false,
          `tool ${tool} owned by both ${seen.get(tool)} and ${entry.name}`,
        );
        seen.set(tool, entry.name);
      }
    }
  });

  it("ampi-workers manifest tools match the provider-owned worker tool set", async () => {
    const { MMR_EXTENSION_MANIFEST } = await loadManifest();
    const { MMR_WORKERS_OWNED_TOOLS } = await importSource("extensions/ampi-workers/provider.ts");
    const manifestTools = MMR_EXTENSION_MANIFEST.find((entry) => entry.name === "ampi-workers")?.tools ?? [];
    assert.deepEqual(
      [...manifestTools].sort(),
      [...MMR_WORKERS_OWNED_TOOLS].sort(),
      "ampi-workers manifest tools must match MMR_WORKERS_OWNED_TOOLS so ownership drift is caught",
    );
  });

  it("manifest tools never collide with the planned-tool catalog", async () => {
    const { MMR_EXTENSION_MANIFEST } = await loadManifest();
    const { MMR_PLANNED_TOOL_CATALOG } = await importSource("extensions/ampi-core/planned-catalog.ts");
    const plannedNames = new Set(MMR_PLANNED_TOOL_CATALOG.map((e) => e.name));
    for (const entry of MMR_EXTENSION_MANIFEST) {
      for (const tool of entry.tools) {
        assert.equal(
          plannedNames.has(tool),
          false,
          `active tool ${tool} (${entry.name}) must not collide with a planned-catalog name`,
        );
      }
    }
  });

  it("subagent child keep-set references only manifested extensions", async () => {
    const { MMR_EXTENSION_MANIFEST } = await loadManifest();
    const { MMR_SUBAGENT_CHILD_KEEP_EXTENSIONS } = await importSource(
      "extensions/ampi-workers/child-extension-scope.ts",
    );
    const names = new Set(MMR_EXTENSION_MANIFEST.map((e) => e.name));
    for (const [profile, keep] of Object.entries(MMR_SUBAGENT_CHILD_KEEP_EXTENSIONS)) {
      for (const ext of keep) {
        assert.equal(
          names.has(ext),
          true,
          `child keep-set for ${profile} references unknown extension ${ext}`,
        );
      }
    }
  });

  it("feature gate ids are unique across the manifest", async () => {
    const { MMR_EXTENSION_MANIFEST } = await loadManifest();
    const seen = new Map();
    for (const entry of MMR_EXTENSION_MANIFEST) {
      for (const gate of entry.featureGates) {
        assert.equal(
          seen.has(gate),
          false,
          `feature gate ${gate} declared by both ${seen.get(gate)} and ${entry.name}`,
        );
        seen.set(gate, entry.name);
      }
    }
  });

  it("ampi-core imports no sibling extension outside the recorded exception set", async () => {
    const { MMR_CORE_SIBLING_IMPORT_EXCEPTIONS } = await loadManifest();
    const allowed = new Set(MMR_CORE_SIBLING_IMPORT_EXCEPTIONS);
    const coreDir = path.join(extensionsDir, "ampi-core");
    const importRe = /from\s+"\.\.\/(ampi-[a-z-]+)\//g;

    const violations = [];
    for (const file of collectTsFiles(coreDir)) {
      const text = readFileSync(file, "utf8");
      let match;
      while ((match = importRe.exec(text)) !== null) {
        const sibling = match[1];
        if (sibling === "ampi-core") continue;
        if (!allowed.has(sibling)) {
          violations.push(`${path.relative(repoRoot, file)} -> ${sibling}`);
        }
      }
    }
    assert.deepEqual(
      violations,
      [],
      `ampi-core must not import siblings outside [${[...allowed].join(", ")}]. New couplings:\n${violations.join("\n")}`,
    );
  });

  it("records the current ampi-core sibling-import exceptions as still present (drift detector)", async () => {
    const { MMR_CORE_SIBLING_IMPORT_EXCEPTIONS } = await loadManifest();
    const coreDir = path.join(extensionsDir, "ampi-core");
    const importRe = /from\s+"\.\.\/(ampi-[a-z-]+)\//g;

    const found = new Set();
    for (const file of collectTsFiles(coreDir)) {
      const text = readFileSync(file, "utf8");
      let match;
      while ((match = importRe.exec(text)) !== null) {
        if (match[1] !== "ampi-core") found.add(match[1]);
      }
    }
    // Every recorded exception must still exist; once a chunk removes a coupling,
    // it must also drop it from MMR_CORE_SIBLING_IMPORT_EXCEPTIONS.
    for (const exception of MMR_CORE_SIBLING_IMPORT_EXCEPTIONS) {
      assert.equal(
        found.has(exception),
        true,
        `recorded exception ${exception} is no longer imported by mmr-core; remove it from MMR_CORE_SIBLING_IMPORT_EXCEPTIONS`,
      );
    }
  });
});
