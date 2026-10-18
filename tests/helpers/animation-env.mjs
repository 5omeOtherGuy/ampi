import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before } from "node:test";

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/**
 * Keeps a suite that asserts spinners and other animations independent of the
 * developer's own setup: `NO_ANIMATION` in the shell or `ampiTui.animations:
 * false` in the real `~/.pi/agent/settings.json` would otherwise still them.
 * Call it once at the top level of the file; it runs every test without
 * `NO_ANIMATION` and with the home directory on an empty temporary directory,
 * and restores both when the file finishes.
 */
export function isolateAnimationEnv() {
  const saved = {};
  let home;
  before(() => {
    for (const name of ["NO_ANIMATION", "HOME", "USERPROFILE"]) saved[name] = process.env[name];
    home = mkdtempSync(path.join(os.tmpdir(), "ampi-animation-home-"));
    delete process.env.NO_ANIMATION;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });
  after(() => {
    for (const [name, value] of Object.entries(saved)) restore(name, value);
    if (home) rmSync(home, { recursive: true, force: true });
  });
}

/** Sets `NO_ANIMATION=1` for one test and restores the earlier value after it. */
export function setNoAnimation(t) {
  const previous = process.env.NO_ANIMATION;
  process.env.NO_ANIMATION = "1";
  t.after(() => restore("NO_ANIMATION", previous));
}
