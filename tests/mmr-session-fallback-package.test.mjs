import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const repoRoot = path.resolve(import.meta.dirname, "..");
const fallbackExtensionPath = "./src/extensions/mmr-session-fallback/index.ts";

async function readPackageJson() {
  return JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
}

describe("mmr-session-fallback package wiring", () => {
  it("registers after mmr-core so managed model updates are available", async () => {
    const pkg = await readPackageJson();
    const indexOfCore = pkg.pi.extensions.indexOf("./src/extensions/mmr-core/index.ts");
    const indexOfFallback = pkg.pi.extensions.indexOf(fallbackExtensionPath);

    assert.notEqual(indexOfCore, -1);
    assert.notEqual(indexOfFallback, -1);
    assert.ok(indexOfFallback > indexOfCore);
  });

  it("exposes extension and helper exports", async () => {
    const pkg = await readPackageJson();
    assert.equal(pkg.exports["./extensions/mmr-session-fallback"], fallbackExtensionPath);

    const root = await importSource("index.ts");
    assert.equal(typeof root.createMmrSessionFallbackExtension, "function");
    assert.equal(typeof root.classifyMmrSessionFallbackError, "function");
    assert.equal(root.MMR_SESSION_FALLBACK_ENTRY, "mmr-session-fallback.override");
  });
});
