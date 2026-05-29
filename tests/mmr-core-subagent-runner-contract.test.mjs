import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const CONTRACT_MODULE = "extensions/mmr-core/subagent-runner-contract.ts";

describe("mmr-core subagent runner framework contract", () => {
  it("exports the generic run and tool-use status literals", async () => {
    const mod = await importSource(CONTRACT_MODULE);
    assert.equal(mod.MMR_IN_PROCESS_SUBAGENT_RUNNER_AVAILABLE, false);
    assert.deepEqual([...mod.MMR_SUBAGENT_RUN_STATUSES], ["in-progress", "done", "error", "cancelled"]);
    assert.deepEqual(
      [...mod.MMR_SUBAGENT_TOOL_USE_STATUSES],
      ["queued", "in-progress", "done", "error", "cancelled", "rejected-by-user"],
    );
  });

  it("fails closed through the in-process runner placeholder until Pi exposes the host seam", async () => {
    const mod = await importSource(CONTRACT_MODULE);
    assert.equal(typeof mod.runMmrSubagentInProcess, "function");
    assert.equal(typeof mod.MmrInProcessRunnerUnavailableError, "function");

    await assert.rejects(
      () =>
        mod.runMmrSubagentInProcess({
          profile: { name: "fixture", displayName: "Fixture" },
          prompt: "Do one bounded task.",
          cwd: "/repo",
        }),
      (error) => {
        assert.ok(error instanceof mod.MmrInProcessRunnerUnavailableError);
        assert.equal(error.name, "MmrInProcessRunnerUnavailableError");
        assert.match(error.message, /in-process subagent runner/i);
        assert.match(error.message, /host support/i);
        return true;
      },
    );
  });

  it("exports the framework contract from the package root", async () => {
    const root = await importSource("index.ts");
    assert.equal(root.MMR_IN_PROCESS_SUBAGENT_RUNNER_AVAILABLE, false);
    assert.deepEqual([...root.MMR_SUBAGENT_RUN_STATUSES], ["in-progress", "done", "error", "cancelled"]);
    assert.equal(typeof root.runMmrSubagentInProcess, "function");
    assert.equal(typeof root.MmrInProcessRunnerUnavailableError, "function");
  });
});
