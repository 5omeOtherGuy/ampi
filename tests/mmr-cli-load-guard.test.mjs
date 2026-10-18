// When the `ampi` command adds ampi's package to Pi itself and when it leaves
// that to Pi, so ampi never loads twice (packages/ampi-cli/src/packages.js).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { decideAmpiLoad, locateAmpiPackage, readPackageAt } from "../packages/ampi-cli/src/packages.js";

const CWD = "/work/project";
const NAMES = new Map([
  ["/work/ampi-checkout", "@skippermissions/ampi"],
  ["/work/project", "my-project"],
  ["/agent/git/github.com/5omeOtherGuy/ampi", "@skippermissions/ampi"],
  ["/agent/git/github.com/someone/ampi-fork", "@skippermissions/ampi"],
  ["/agent/tmp/extensions/git-github.com/1a2b3c4d/someone/ampi-fork", "@skippermissions/ampi"],
  ["/agent/npm/node_modules/@skippermissions/ampi", "@skippermissions/ampi"],
  ["/agent/npm/node_modules/@skippermissions/ampi-cli", "@skippermissions/ampi-cli"],
  ["/agent/npm/node_modules/pi-other", "pi-other"],
]);
/** Fake lookup: the name of the package whose root is a prefix of the path. */
const packageNameAt = (start) => {
  for (const [root, name] of NAMES) if (start === root || start.startsWith(`${root}/`)) return name;
  return undefined;
};
const CACHED = new Map([["git:github.com/someone/ampi-fork", "/agent/tmp/extensions/git-github.com/1a2b3c4d/someone/ampi-fork"]]);
/** What Pi reports: enabled extension entries, sources it would install, cached `-e` packages. */
const piSources = ({ enabled = [], missing = [] } = {}) => ({ enabled, missing, cachedPathOf: (source) => CACHED.get(source) });
const decide = (piArgs, pi = piSources()) => decideAmpiLoad({ piArgs, pi, cwd: CWD, packageNameAt });

describe("ampi load guard", () => {
  it("loads ampi when neither the arguments nor Pi provide it", () => {
    assert.deepEqual(decide([]), { load: true });
    const other = { path: "/agent/npm/node_modules/pi-other/index.ts", source: "npm:pi-other" };
    assert.deepEqual(decide(["--model", "a/b"], piSources({ enabled: [other], missing: ["npm:pi-missing"] })), { load: true });
  });

  it("leaves ampi to Pi when an enabled settings package belongs to ampi, from npm, git or a local path", () => {
    for (const entry of [
      { path: "/agent/npm/node_modules/@skippermissions/ampi/src/extensions/ampi-core/index.ts", source: "npm:@skippermissions/ampi" },
      { path: "/agent/git/github.com/5omeOtherGuy/ampi/src/extensions/ampi-core/index.ts", source: "git:github.com/5omeOtherGuy/ampi" },
      { path: "/work/ampi-checkout/src/extensions/ampi-core/index.ts", source: "../ampi-checkout" },
    ]) {
      assert.deepEqual(decide([], piSources({ enabled: [entry] })), { load: false, reason: "pi", source: entry.source });
    }
  });

  it("leaves ampi to Pi when the settings `extensions` key or an extension directory provides it", () => {
    const fromExtensions = { path: "/work/ampi-checkout/src/extensions/ampi-tui/index.ts", source: "/work/ampi-checkout/src/extensions/ampi-tui/index.ts" };
    assert.deepEqual(decide([], piSources({ enabled: [fromExtensions] })), { load: false, reason: "pi", source: fromExtensions.source });
    const discovered = { path: "/agent/git/github.com/someone/ampi-fork/src/extensions/ampi-core/index.ts", source: "/agent/git/github.com/someone/ampi-fork/src/extensions/ampi-core/index.ts" };
    assert.equal(decide([], piSources({ enabled: [discovered] })).load, false);
  });

  it("leaves ampi to Pi when its settings list ampi that Pi has not installed yet", () => {
    for (const source of ["npm:@skippermissions/ampi", "npm:@skippermissions/ampi@0.4.0", "git:github.com/5omeOtherGuy/ampi@v0.4.0", "https://github.com/5omeOtherGuy/ampi.git"]) {
      assert.deepEqual(decide([], piSources({ missing: [source] })), { load: false, reason: "pi", source });
    }
  });

  it("does not mistake the CLI package, a built-in or the project directory for ampi", () => {
    const cli = { path: "/agent/npm/node_modules/@skippermissions/ampi-cli/index.js", source: "npm:@skippermissions/ampi-cli" };
    assert.deepEqual(decide([], piSources({ enabled: [cli], missing: ["npm:@skippermissions/ampi-cli", "git:github.com/5omeOtherGuy/ampi-cli"] })), { load: true });
    // A built-in is not a path; resolved against an ampi checkout as cwd it would look like ampi.
    const builtin = { path: "builtin:mcp", source: "builtin" };
    assert.deepEqual(decideAmpiLoad({ piArgs: [], pi: piSources({ enabled: [builtin] }), cwd: "/work/ampi-checkout", packageNameAt }), { load: true });
  });

  it("leaves ampi to Pi when a -e argument already names it, relative paths and git sources included", () => {
    assert.deepEqual(decide(["-e", "npm:@skippermissions/ampi"]), {
      load: false,
      reason: "extension-flag",
      source: "npm:@skippermissions/ampi",
    });
    // How a worker child is started: only the extensions it needs, from ampi's own files.
    const child = ["--no-extensions", "-e", "../ampi-checkout/src/extensions/ampi-core/index.ts", "--mode", "json"];
    assert.equal(decide(child).load, false);
    assert.equal(decide(["--extension", "/work/ampi-checkout"]).load, false);
    assert.equal(decide(["-e", "git:github.com/5omeOtherGuy/ampi"]).load, false);
    assert.equal(decide(["-e", "git@github.com:5omeOtherGuy/ampi.git"]).load, false);
    // A fork is recognised once Pi has a cached checkout that names itself ampi.
    assert.equal(decide(["-e", "git:github.com/someone/ampi-fork"]).load, false);
    assert.equal(decide(["-e", "git:github.com/someone/other"]).load, true);
  });

  it("loads ampi under --no-extensions, which keeps Pi from loading anything but -e", () => {
    const pi = piSources({
      enabled: [{ path: "/work/ampi-checkout/src/extensions/ampi-core/index.ts", source: "../ampi-checkout" }],
      missing: ["npm:@skippermissions/ampi"],
    });
    assert.deepEqual(decide(["--no-extensions"], pi), { load: true });
    assert.deepEqual(decide(["-ne"], pi), { load: true });
  });

  it("ignores -e that is part of the message after --", () => {
    assert.deepEqual(decide(["--", "-e", "npm:@skippermissions/ampi"]), { load: true });
  });
});

describe("package lookup", () => {
  it("reads the nearest package.json above a file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ampi-cli-pkg-"));
    try {
      const root = path.join(dir, "pkg");
      mkdirSync(path.join(root, "src", "deep"), { recursive: true });
      writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@scope/pkg", version: "1.2.3" }));
      const file = path.join(root, "src", "deep", "entry.ts");
      writeFileSync(file, "");
      assert.deepEqual(readPackageAt(file), { name: "@scope/pkg", version: "1.2.3", root });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads ampi from the source checkout that contains the command, not from node_modules", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ampi-cli-checkout-"));
    try {
      const checkout = path.join(dir, "ampi");
      const cliRoot = path.join(checkout, "packages", "ampi-cli");
      mkdirSync(cliRoot, { recursive: true });
      writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ name: "@skippermissions/ampi", version: "9.8.7" }));
      writeFileSync(path.join(cliRoot, "package.json"), JSON.stringify({ name: "@skippermissions/ampi-cli", version: "0.0.0" }));
      assert.deepEqual(locateAmpiPackage(cliRoot), { name: "@skippermissions/ampi", version: "9.8.7", root: checkout });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
