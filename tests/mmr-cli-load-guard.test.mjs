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
  ["/agent/git/github.com/5omeOtherGuy/ampi", "@skippermissions/ampi"],
  ["/agent/npm/node_modules/@skippermissions/ampi-cli", "@skippermissions/ampi-cli"],
  ["/agent/npm/node_modules/pi-other", "pi-other"],
]);
/** Fake lookup: the name of the package whose root is a prefix of the path. */
const packageNameAt = (start) => {
  for (const [root, name] of NAMES) if (start === root || start.startsWith(`${root}/`)) return name;
  return undefined;
};
const decide = (piArgs, configured = []) => decideAmpiLoad({ piArgs, configured, cwd: CWD, packageNameAt });

describe("ampi load guard", () => {
  it("loads ampi when neither the arguments nor Pi's settings provide it", () => {
    assert.deepEqual(decide([]), { load: true });
    assert.deepEqual(
      decide(["--model", "a/b"], [{ source: "npm:pi-other", installedPath: "/agent/npm/node_modules/pi-other" }]),
      { load: true },
    );
  });

  it("leaves ampi to Pi when its settings list the npm package, pinned or not, installed or not", () => {
    for (const source of ["npm:@skippermissions/ampi", "npm:@skippermissions/ampi@0.4.0"]) {
      assert.deepEqual(decide([], [{ source }]), { load: false, reason: "settings", source });
    }
  });

  it("does not mistake the CLI package for ampi", () => {
    const configured = [
      {
        source: "npm:@skippermissions/ampi-cli",
        installedPath: "/agent/npm/node_modules/@skippermissions/ampi-cli",
      },
    ];
    assert.deepEqual(decide([], configured), { load: true });
  });

  it("recognises ampi installed from git or a local path by its package name", () => {
    const git = { source: "git:github.com/5omeOtherGuy/ampi", installedPath: "/agent/git/github.com/5omeOtherGuy/ampi" };
    assert.deepEqual(decide([], [git]), { load: false, reason: "settings", source: git.source });
    const local = { source: "../ampi-checkout", installedPath: "/work/ampi-checkout" };
    assert.deepEqual(decide([], [local]), { load: false, reason: "settings", source: local.source });
  });

  it("leaves ampi to Pi when a -e argument already names it, relative paths included", () => {
    assert.deepEqual(decide(["-e", "npm:@skippermissions/ampi"]), {
      load: false,
      reason: "extension-flag",
      source: "npm:@skippermissions/ampi",
    });
    // How a worker child is started: only the extensions it needs, from ampi's own files.
    const child = ["--no-extensions", "-e", "../ampi-checkout/src/extensions/ampi-core/index.ts", "--mode", "json"];
    assert.equal(decide(child).load, false);
    assert.equal(decide(["--extension", "/work/ampi-checkout"]).load, false);
  });

  it("loads ampi under --no-extensions, which keeps Pi from loading its settings packages", () => {
    const configured = [{ source: "npm:@skippermissions/ampi" }];
    assert.deepEqual(decide(["--no-extensions"], configured), { load: true });
    assert.deepEqual(decide(["-ne"], configured), { load: true });
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
