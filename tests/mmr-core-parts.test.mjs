// ampi-core/parts.ts: the record of the ampi parts a process loaded, and the
// warning when parts load without ampi-core (a selection in Pi's settings
// that leaves it out). The record is process-global, and node:test runs each
// file in its own process, so this file starts with an empty record.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

describe("ampi parts record", () => {
  it("warns once per load when parts start without ampi-core, and not once ampi-core loads first", async () => {
    const { getLoadedAmpiParts, markAmpiPartLoaded } = await importSource("extensions/ampi-core/parts.ts");
    const web = createMockPi();
    const tui = createMockPi();
    markAmpiPartLoaded(web.pi, "ampi-web");
    markAmpiPartLoaded(tui.pi, "ampi-tui");
    assert.equal(tui.handlers.get("session_start"), undefined, "only the first part without ampi-core warns");
    const { ctx, notifications } = createMockExtensionContext({ hasUI: true });
    await web.handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].level, "warning");
    assert.match(notifications[0].message, /ampi-web, ampi-tui loaded without ampi-core/);
    assert.match(notifications[0].message, /ampi setup/);

    // A reload with ampi-core: its factory runs first and starts the record afresh.
    const core = createMockPi();
    const github = createMockPi();
    markAmpiPartLoaded(core.pi, "ampi-core");
    markAmpiPartLoaded(github.pi, "ampi-github");
    assert.equal(github.handlers.get("session_start"), undefined);
    assert.deepEqual([...getLoadedAmpiParts()], ["ampi-core", "ampi-github"]);
  });
});
