import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

// Characterization guard for the load-bearing registration ORDER of the
// mmr-core entrypoint. Pi resolves duplicate shortcut keys last-registered-wins
// and hook dispatch can depend on registration sequence, so the slim wiring
// shell must reproduce the exact insertion order asserted here. The mock pi
// records commands/shortcuts/handlers as insertion-ordered Maps.
describe("mmr-core registration order", () => {
  it("registers flags, commands, shortcuts, and hooks in a stable order", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const { pi, commands, shortcuts, handlers, flagDefs } = createMockPi();

    extension(pi);

    assert.deepEqual([...flagDefs.keys()], ["mmr-mode", "mmr-subagent", "mmr-parent-mode"]);

    assert.deepEqual([...commands.keys()], ["mode", "mmr-status", "mmr-changelog", "mmr-config"]);

    assert.deepEqual([...shortcuts.keys()], ["ctrl+shift+s", "alt+m", "ctrl+space", "alt+r"]);

    assert.deepEqual(
      [...handlers.keys()],
      [
        "session_start",
        "before_provider_request",
        "before_agent_start",
        "tool_call",
        "model_select",
        "input",
        "thinking_level_select",
      ],
    );
  });
});
