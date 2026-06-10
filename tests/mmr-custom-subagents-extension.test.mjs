import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const repoRoot = path.resolve(import.meta.dirname, "..");
const customExtensionPath = "./src/extensions/mmr-custom-subagents/index.ts";

async function readPackageJson() {
  return JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
}

describe("mmr-custom-subagents extension", () => {
  it("is registered as a Pi package extension after mmr-subagents", async () => {
    const pkg = await readPackageJson();
    const indexOfSubagents = pkg.pi.extensions.indexOf("./src/extensions/mmr-subagents/index.ts");
    const indexOfCustom = pkg.pi.extensions.indexOf(customExtensionPath);
    assert.notEqual(indexOfSubagents, -1, "mmr-subagents must be registered");
    assert.notEqual(indexOfCustom, -1, "mmr-custom-subagents must be registered");
    assert.ok(indexOfCustom > indexOfSubagents, "mmr-custom-subagents loads after the built-in worker bundle");
  });

  it("exposes a package subpath for direct extension loading", async () => {
    const pkg = await readPackageJson();
    assert.equal(pkg.exports["./extensions/mmr-custom-subagents"], customExtensionPath);
  });

  it("exports a loadable extension factory and root public surface", async () => {
    const mod = await importSource("extensions/mmr-custom-subagents/index.ts");
    const root = await importSource("index.ts");
    assert.equal(typeof mod.default, "function");
    assert.equal(typeof mod.createMmrCustomSubagentsExtension, "function");
    assert.equal(typeof root.createMmrCustomSubagentsExtension, "function");
    assert.equal(root.MMR_CUSTOM_SUBAGENTS_PROVIDER_NAME, "mmr-custom-subagents");
    assert.equal(root.MMR_CUSTOM_SUBAGENTS_FEATURE_GATE, "mmr-custom-subagents");
  });

  it("registers no tools when no custom subagents are enabled", async () => {
    const { createMmrCustomSubagentsExtension } = await importSource("extensions/mmr-custom-subagents/index.ts");
    const { pi, tools, handlers } = createMockPi();
    createMmrCustomSubagentsExtension({ customSubagents: { cwd: "/tmp/no-custom-subagents" } })(pi);
    assert.deepEqual([...tools.keys()], []);
    assert.equal(typeof handlers.get("session_start"), "function");
  });
});
