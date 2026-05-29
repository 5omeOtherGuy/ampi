import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const repoRoot = path.resolve(import.meta.dirname, "..");
const toolboxExtensionPath = "./src/extensions/mmr-toolbox/index.ts";

async function readPackageJson() {
  return JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
}

describe("mmr-toolbox scaffold", () => {
  it("is registered as a Pi package extension after mmr-core", async () => {
    const pkg = await readPackageJson();

    const indexOfCore = pkg.pi.extensions.indexOf("./src/extensions/mmr-core/index.ts");
    const indexOfToolbox = pkg.pi.extensions.indexOf(toolboxExtensionPath);

    assert.notEqual(indexOfCore, -1, "mmr-core must be registered as a Pi extension");
    assert.notEqual(indexOfToolbox, -1, "mmr-toolbox must be registered as a Pi extension");
    assert.ok(indexOfToolbox > indexOfCore, "mmr-toolbox must load after mmr-core so providers can register with the runtime singleton");
  });

  it("exposes a package subpath for direct extension loading", async () => {
    const pkg = await readPackageJson();

    assert.equal(pkg.exports["./extensions/mmr-toolbox"], toolboxExtensionPath);
  });

  it("exports a loadable extension factory that registers tools and providers on a Pi-shaped host", async () => {
    const toolbox = await importSource("extensions/mmr-toolbox/index.ts");

    assert.equal(typeof toolbox.default, "function");
    const { pi, tools } = createMockPi();
    assert.doesNotThrow(() => toolbox.default(pi));
    assert.ok(tools.size >= 1, "toolbox extension should register at least one tool");
  });
});
