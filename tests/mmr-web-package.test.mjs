import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const repoRoot = path.resolve(import.meta.dirname, "..");
const webExtensionPath = "./src/extensions/mmr-web/index.ts";

async function readPackageJson() {
  return JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
}

describe("mmr-web package wiring", () => {
  it("registers mmr-web as a Pi extension after mmr-core", async () => {
    const pkg = await readPackageJson();
    const indexOfCore = pkg.pi.extensions.indexOf("./src/extensions/mmr-core/index.ts");
    const indexOfWeb = pkg.pi.extensions.indexOf(webExtensionPath);
    assert.notEqual(indexOfCore, -1);
    assert.notEqual(indexOfWeb, -1);
    assert.ok(indexOfWeb > indexOfCore, "mmr-web must load after mmr-core so the runtime singleton is available.");
  });

  it("declares an engines.node floor matching AbortSignal.any (>=20.3.0)", async () => {
    const pkg = await readPackageJson();
    assert.ok(pkg.engines, "package.json must declare an engines field");
    assert.equal(typeof pkg.engines.node, "string");
    assert.match(pkg.engines.node, />=\s*20\.3(\.\d+)?/, `engines.node must require >=20.3.0; got ${pkg.engines.node}`);
  });

  it("exposes a package subpath for direct extension loading", async () => {
    const pkg = await readPackageJson();
    assert.equal(pkg.exports["./extensions/mmr-web"], webExtensionPath);
  });

  it("exports a default factory and a createMmrWebExtension test seam", async () => {
    const mod = await importSource("extensions/mmr-web/index.ts");
    assert.equal(typeof mod.default, "function");
    assert.equal(typeof mod.createMmrWebExtension, "function");
  });

  it("re-exports mmr-web settings, provider, and URL policy from the package root", async () => {
    const root = await importSource("index.ts");
    assert.equal(typeof root.loadMmrWebSettings, "function");
    assert.equal(typeof root.createMmrWebToolProvider, "function");
    assert.equal(typeof root.createMmrWebFeatureGateProvider, "function");
    assert.equal(typeof root.validateExternalHttpUrl, "function");
    assert.equal(typeof root.createMmrWebExtension, "function");
    assert.equal(root.MMR_WEB_PROVIDER_NAME, "mmr-web");
    assert.equal(root.MMR_WEB_FEATURE_GATE, "mmr-web");
  });
});
