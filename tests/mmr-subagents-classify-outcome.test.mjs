import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const RUNNER_MODULE = "extensions/mmr-workers/runner.ts";
const ROOT_MODULE = "index.ts";

// Minimal MmrWorkerResult shape sufficient for the classifier. The
// classifier reads only the structured discriminators and final-text
// fields; other fields exist so type-aware tests can drop the same
// object into other code paths without re-spelling each field.
function makeWorkerResult(overrides = {}) {
  return {
    spawnError: undefined,
    subagentActivationError: undefined,
    aborted: false,
    signal: null,
    exitCode: 0,
    finalOutput: "",
    truncatedFinalOutput: "",
    ...overrides,
  };
}

describe("classifyMmrWorkerOutcome precedence (shared subagent outcome classifier)", () => {
  it("returns 'spawn-error' when result.spawnError is set, even if every other field would otherwise indicate success", async () => {
    const { classifyMmrWorkerOutcome } = await importSource(RUNNER_MODULE);
    const status = classifyMmrWorkerOutcome(
      makeWorkerResult({
        spawnError: "spawn ENOENT",
        // Every other field implies success; precedence rule 1 wins.
        subagentActivationError: "should-not-win",
        aborted: true,
        signal: "SIGTERM",
        exitCode: 0,
        finalOutput: "usable output",
        truncatedFinalOutput: "usable output",
      }),
      { partialOutputPolicy: "prefer-usable-output" },
    );
    assert.equal(status, "spawn-error");
  });

  it("returns 'activation-error' when subagentActivationError is set (and spawnError is absent)", async () => {
    const { classifyMmrWorkerOutcome } = await importSource(RUNNER_MODULE);
    const status = classifyMmrWorkerOutcome(
      makeWorkerResult({
        subagentActivationError: "unknown profile \"history-reader\"",
        aborted: true,
        signal: "SIGKILL",
        exitCode: 1,
        finalOutput: "usable output",
      }),
      { partialOutputPolicy: "fail-on-nonzero" },
    );
    assert.equal(status, "activation-error");
  });

  it("returns 'aborted' when aborted=true (and earlier discriminators are absent)", async () => {
    const { classifyMmrWorkerOutcome } = await importSource(RUNNER_MODULE);
    const status = classifyMmrWorkerOutcome(
      makeWorkerResult({
        aborted: true,
        signal: "SIGTERM",
        exitCode: 1,
        finalOutput: "partial output",
      }),
      { partialOutputPolicy: "prefer-usable-output" },
    );
    assert.equal(status, "aborted");
  });

  it("returns 'worker-error' on signal-killed runs without usable final text", async () => {
    const { classifyMmrWorkerOutcome } = await importSource(RUNNER_MODULE);
    const status = classifyMmrWorkerOutcome(
      makeWorkerResult({
        signal: "SIGKILL",
        exitCode: null,
        finalOutput: "   \n  ",
        truncatedFinalOutput: "",
      }),
      { partialOutputPolicy: "fail-on-nonzero" },
    );
    assert.equal(status, "worker-error");
  });

  it("returns 'empty-output' on clean exit with no usable final text", async () => {
    const { classifyMmrWorkerOutcome } = await importSource(RUNNER_MODULE);
    const status = classifyMmrWorkerOutcome(
      makeWorkerResult({ exitCode: 0, finalOutput: "", truncatedFinalOutput: "" }),
      { partialOutputPolicy: "fail-on-nonzero" },
    );
    assert.equal(status, "empty-output");
  });

  it("returns 'no-agent-start' on clean exit with no usable text when the worker never entered the agent loop", async () => {
    // Distinguishes "worker ran but produced nothing" (empty-output) from
    // "worker exited before agent_start fired" (no-agent-start). The latter
    // is the signature of a sibling input-event handler swallowing the
    // prompt before the model is consulted; surfacing it as a distinct
    // outcome lets consumers replace the cheerful "no results" message
    // with a diagnostic that points operators at extension stderr.
    const { classifyMmrWorkerOutcome } = await importSource(RUNNER_MODULE);
    const status = classifyMmrWorkerOutcome(
      makeWorkerResult({
        exitCode: 0,
        finalOutput: "",
        truncatedFinalOutput: "",
        agentStarted: false,
      }),
      { partialOutputPolicy: "fail-on-nonzero" },
    );
    assert.equal(status, "no-agent-start");
  });

  it("keeps 'empty-output' when the worker entered the agent loop but produced no usable text", async () => {
    const { classifyMmrWorkerOutcome } = await importSource(RUNNER_MODULE);
    const status = classifyMmrWorkerOutcome(
      makeWorkerResult({
        exitCode: 0,
        finalOutput: "",
        truncatedFinalOutput: "",
        agentStarted: true,
      }),
      { partialOutputPolicy: "fail-on-nonzero" },
    );
    assert.equal(status, "empty-output");
  });

  it("treats agentStarted=undefined as agent ran (backwards-compatible default for older callers)", async () => {
    const { classifyMmrWorkerOutcome } = await importSource(RUNNER_MODULE);
    const status = classifyMmrWorkerOutcome(
      makeWorkerResult({ exitCode: 0, finalOutput: "", truncatedFinalOutput: "" }),
      { partialOutputPolicy: "fail-on-nonzero" },
    );
    assert.equal(status, "empty-output", "absent agentStarted must not silently flip the outcome");
  });

  it("keeps 'worker-error' precedence over 'no-agent-start' when the child exited nonzero", async () => {
    // worker-error is louder than no-agent-start; a nonzero exit dominates.
    const { classifyMmrWorkerOutcome } = await importSource(RUNNER_MODULE);
    const status = classifyMmrWorkerOutcome(
      makeWorkerResult({
        exitCode: 1,
        finalOutput: "",
        truncatedFinalOutput: "",
        agentStarted: false,
      }),
      { partialOutputPolicy: "fail-on-nonzero" },
    );
    assert.equal(status, "worker-error");
  });

  it("keeps 'aborted' precedence over 'no-agent-start'", async () => {
    const { classifyMmrWorkerOutcome } = await importSource(RUNNER_MODULE);
    const status = classifyMmrWorkerOutcome(
      makeWorkerResult({
        aborted: true,
        exitCode: 0,
        finalOutput: "",
        truncatedFinalOutput: "",
        agentStarted: false,
      }),
      { partialOutputPolicy: "fail-on-nonzero" },
    );
    assert.equal(status, "aborted");
  });

  it("keeps 'activation-error' precedence over 'no-agent-start'", async () => {
    const { classifyMmrWorkerOutcome } = await importSource(RUNNER_MODULE);
    const status = classifyMmrWorkerOutcome(
      makeWorkerResult({
        subagentActivationError: "Unknown subagent profile",
        exitCode: 0,
        finalOutput: "",
        truncatedFinalOutput: "",
        agentStarted: false,
      }),
      { partialOutputPolicy: "fail-on-nonzero" },
    );
    assert.equal(status, "activation-error");
  });

  it("returns 'success' on clean exit with usable final text", async () => {
    const { classifyMmrWorkerOutcome } = await importSource(RUNNER_MODULE);
    const status = classifyMmrWorkerOutcome(
      makeWorkerResult({
        exitCode: 0,
        finalOutput: "the worker produced this answer",
        truncatedFinalOutput: "the worker produced this answer",
      }),
      { partialOutputPolicy: "fail-on-nonzero" },
    );
    assert.equal(status, "success");
  });

  it("prefers truncatedFinalOutput when present (truncation must not hide a usable answer)", async () => {
    const { classifyMmrWorkerOutcome } = await importSource(RUNNER_MODULE);
    const status = classifyMmrWorkerOutcome(
      makeWorkerResult({
        exitCode: 0,
        finalOutput: "",
        truncatedFinalOutput: "truncated answer survives",
      }),
      { partialOutputPolicy: "fail-on-nonzero" },
    );
    assert.equal(status, "success");
  });
});

describe("classifyMmrWorkerOutcome partialOutputPolicy", () => {
  it("'fail-on-nonzero' returns 'worker-error' on nonzero exit even when usable text is present (finder/oracle/history-reader policy)", async () => {
    const { classifyMmrWorkerOutcome } = await importSource(RUNNER_MODULE);
    const status = classifyMmrWorkerOutcome(
      makeWorkerResult({
        exitCode: 1,
        finalOutput: "partial result before the failure",
        truncatedFinalOutput: "partial result before the failure",
      }),
      { partialOutputPolicy: "fail-on-nonzero" },
    );
    assert.equal(status, "worker-error");
  });

  it("'prefer-usable-output' returns 'success' on nonzero exit with usable final text (Task policy, spec §9.4)", async () => {
    const { classifyMmrWorkerOutcome } = await importSource(RUNNER_MODULE);
    const status = classifyMmrWorkerOutcome(
      makeWorkerResult({
        exitCode: 1,
        finalOutput: "the answer Task wants the parent to see",
        truncatedFinalOutput: "the answer Task wants the parent to see",
      }),
      { partialOutputPolicy: "prefer-usable-output" },
    );
    assert.equal(status, "success");
  });

  it("'prefer-usable-output' still returns 'worker-error' when nonzero exit and no usable text", async () => {
    const { classifyMmrWorkerOutcome } = await importSource(RUNNER_MODULE);
    const status = classifyMmrWorkerOutcome(
      makeWorkerResult({ exitCode: 1, finalOutput: "", truncatedFinalOutput: "" }),
      { partialOutputPolicy: "prefer-usable-output" },
    );
    assert.equal(status, "worker-error");
  });

  it("'prefer-usable-output' returns 'worker-error' on signal-killed-without-text regardless of policy", async () => {
    const { classifyMmrWorkerOutcome } = await importSource(RUNNER_MODULE);
    const status = classifyMmrWorkerOutcome(
      makeWorkerResult({ signal: "SIGTERM", finalOutput: "", truncatedFinalOutput: "" }),
      { partialOutputPolicy: "prefer-usable-output" },
    );
    assert.equal(status, "worker-error");
  });

  it("'prefer-usable-output' returns 'success' on signal-killed-with-usable-text (Task spec §9.4: usable output wins)", async () => {
    // Under prefer-usable-output, signal-killed runs that still produced
    // a usable final answer count as success. This is the policy that
    // lets Task surface a worker's last useful response even when the
    // child exits noisily.
    const { classifyMmrWorkerOutcome } = await importSource(RUNNER_MODULE);
    const status = classifyMmrWorkerOutcome(
      makeWorkerResult({
        signal: "SIGTERM",
        exitCode: null,
        finalOutput: "usable last answer",
        truncatedFinalOutput: "usable last answer",
      }),
      { partialOutputPolicy: "prefer-usable-output" },
    );
    assert.equal(status, "success");
  });
});

describe("hasUsableMmrWorkerFinalOutput predicate", () => {
  it("returns false for empty / whitespace-only output", async () => {
    const { hasUsableMmrWorkerFinalOutput } = await importSource(RUNNER_MODULE);
    assert.equal(hasUsableMmrWorkerFinalOutput({ finalOutput: "", truncatedFinalOutput: "" }), false);
    assert.equal(hasUsableMmrWorkerFinalOutput({ finalOutput: "  \n  ", truncatedFinalOutput: "" }), false);
  });

  it("returns true when truncatedFinalOutput is non-empty (truncation must not hide a usable answer)", async () => {
    const { hasUsableMmrWorkerFinalOutput } = await importSource(RUNNER_MODULE);
    assert.equal(
      hasUsableMmrWorkerFinalOutput({ finalOutput: "", truncatedFinalOutput: "answer" }),
      true,
    );
  });

  it("returns true when finalOutput has non-whitespace content", async () => {
    const { hasUsableMmrWorkerFinalOutput } = await importSource(RUNNER_MODULE);
    assert.equal(
      hasUsableMmrWorkerFinalOutput({ finalOutput: "ok", truncatedFinalOutput: "" }),
      true,
    );
  });
});

describe("deriveAsyncTerminalOutcome", () => {
  it("maps clean success, truncated success, worker failures, and aborts without adding a lifecycle status", async () => {
    const { deriveAsyncTerminalOutcome } = await importSource(RUNNER_MODULE);
    const policy = { partialOutputPolicy: "prefer-usable-output" };
    assert.equal(
      deriveAsyncTerminalOutcome(makeWorkerResult({ finalOutput: "done", outputTruncated: false }), policy),
      "success",
    );
    assert.equal(
      deriveAsyncTerminalOutcome(makeWorkerResult({ finalOutput: "done", outputTruncated: true }), policy),
      "partial",
    );
    assert.equal(
      deriveAsyncTerminalOutcome(makeWorkerResult({ spawnError: "spawn ENOENT", exitCode: null, outputTruncated: true }), policy),
      "failed",
    );
    assert.equal(
      deriveAsyncTerminalOutcome(makeWorkerResult({ subagentActivationError: "profile mismatch" }), policy),
      "failed",
    );
    assert.equal(
      deriveAsyncTerminalOutcome(makeWorkerResult({ exitCode: 0, finalOutput: "", truncatedFinalOutput: "" }), policy),
      "failed",
    );
    assert.equal(
      deriveAsyncTerminalOutcome(makeWorkerResult({ aborted: true, signal: "SIGTERM", exitCode: null }), policy),
      undefined,
    );
  });
});

describe("classifyMmrWorkerOutcome is exported from the package root", () => {
  it("the classifier, predicate, async terminal outcome adapter, and policy types are reachable through src/index.ts", async () => {
    const root = await importSource(ROOT_MODULE);
    assert.equal(typeof root.classifyMmrWorkerOutcome, "function");
    assert.equal(typeof root.hasUsableMmrWorkerFinalOutput, "function");
    assert.equal(typeof root.deriveAsyncTerminalOutcome, "function");
    // Smoke-test the root-exported function with one rule.
    const status = root.classifyMmrWorkerOutcome(
      makeWorkerResult({ spawnError: "spawn ENOENT" }),
      { partialOutputPolicy: "fail-on-nonzero" },
    );
    assert.equal(status, "spawn-error");
  });
});

describe("classifyTaskOutcome delegates to classifyMmrWorkerOutcome with Task policy", () => {
  it("preserves Task's existing semantics (non-zero exit with usable text → success)", async () => {
    const { classifyTaskOutcome } = await importSource("extensions/mmr-workers/task.ts");
    const status = classifyTaskOutcome({
      aborted: false,
      signal: null,
      exitCode: 137,
      finalOutput: "Task answer",
      truncatedFinalOutput: "Task answer",
    });
    assert.equal(status, "success");
  });

  it("returns spawn-error when spawnError is set, regardless of partial output", async () => {
    const { classifyTaskOutcome } = await importSource("extensions/mmr-workers/task.ts");
    const status = classifyTaskOutcome({
      spawnError: "spawn ENOENT",
      aborted: false,
      signal: null,
      exitCode: 1,
      finalOutput: "partial",
      truncatedFinalOutput: "partial",
    });
    assert.equal(status, "spawn-error");
  });
});

describe("profile-driven outcome policy (partialOutputPolicy lives on the subagent profile)", () => {
  const PROFILES_MODULE = "extensions/mmr-core/subagent-profiles.ts";

  it("declares prefer-usable-output only on the task-subagent profile", async () => {
    const { getMmrSubagentProfile, listMmrSubagentProfiles } = await importSource(PROFILES_MODULE);
    assert.equal(getMmrSubagentProfile("task-subagent")?.partialOutputPolicy, "prefer-usable-output");
    for (const profile of listMmrSubagentProfiles()) {
      if (profile.name === "task-subagent") continue;
      assert.equal(
        profile.partialOutputPolicy,
        undefined,
        `profile ${profile.name} must keep the fail-on-nonzero default`,
      );
    }
  });

  it("classifyMmrWorkerOutcomeForProfile applies the profile's declared policy", async () => {
    const { classifyMmrWorkerOutcomeForProfile } = await importSource(RUNNER_MODULE);
    const nonzeroWithOutput = makeWorkerResult({ exitCode: 1, finalOutput: "usable output" });
    assert.equal(
      classifyMmrWorkerOutcomeForProfile(nonzeroWithOutput, { partialOutputPolicy: "prefer-usable-output" }),
      "success",
    );
    assert.equal(
      classifyMmrWorkerOutcomeForProfile(nonzeroWithOutput, { partialOutputPolicy: "fail-on-nonzero" }),
      "worker-error",
    );
  });

  it("classifyMmrWorkerOutcomeForProfile falls back to fail-on-nonzero for profiles without the bit (and absent profiles)", async () => {
    const { classifyMmrWorkerOutcomeForProfile, resolveMmrWorkerPartialOutputPolicy, DEFAULT_MMR_WORKER_PARTIAL_OUTPUT_POLICY } =
      await importSource(RUNNER_MODULE);
    const nonzeroWithOutput = makeWorkerResult({ exitCode: 1, finalOutput: "usable output" });
    assert.equal(classifyMmrWorkerOutcomeForProfile(nonzeroWithOutput, {}), "worker-error");
    assert.equal(classifyMmrWorkerOutcomeForProfile(nonzeroWithOutput, undefined), "worker-error");
    assert.equal(resolveMmrWorkerPartialOutputPolicy(undefined), DEFAULT_MMR_WORKER_PARTIAL_OUTPUT_POLICY);
    assert.equal(DEFAULT_MMR_WORKER_PARTIAL_OUTPUT_POLICY, "fail-on-nonzero");
  });

  it("end-to-end: the real profiles drive Task vs finder classification of the same nonzero-exit result", async () => {
    const { classifyMmrWorkerOutcomeForProfile } = await importSource(RUNNER_MODULE);
    const { getMmrSubagentProfile } = await importSource(PROFILES_MODULE);
    const nonzeroWithOutput = makeWorkerResult({ exitCode: 1, finalOutput: "usable output" });
    assert.equal(
      classifyMmrWorkerOutcomeForProfile(nonzeroWithOutput, getMmrSubagentProfile("task-subagent")),
      "success",
    );
    assert.equal(
      classifyMmrWorkerOutcomeForProfile(nonzeroWithOutput, getMmrSubagentProfile("finder")),
      "worker-error",
    );
  });
});

describe("canonical details.status discriminator set", () => {
  it("MMR_SUBAGENT_DETAILS_STATUS_VALUES is every classifier outcome plus validation-error", async () => {
    const { MMR_WORKER_OUTCOME_STATUS_VALUES, MMR_SUBAGENT_DETAILS_STATUS_VALUES } = await importSource(RUNNER_MODULE);
    assert.deepEqual(
      [...MMR_SUBAGENT_DETAILS_STATUS_VALUES].sort(),
      [...MMR_WORKER_OUTCOME_STATUS_VALUES, "validation-error"].sort(),
    );
  });

  it("statusFromDetails trusts exactly the canonical set", async () => {
    const { MMR_SUBAGENT_DETAILS_STATUS_VALUES } = await importSource(RUNNER_MODULE);
    const { statusFromDetails } = await importSource("extensions/mmr-workers/subagent-render-format.ts");
    for (const status of MMR_SUBAGENT_DETAILS_STATUS_VALUES) {
      const expected = status === "success" ? "succeeded" : "failed";
      // exitCode 0 so only the stamped discriminator can drive the verdict.
      assert.equal(statusFromDetails({ status, exitCode: 0 }, false, undefined), expected);
    }
    // Unknown strings fall back to the raw-field heuristic.
    assert.equal(statusFromDetails({ status: "not-a-real-status", exitCode: 0 }, false, undefined), "succeeded");
  });
});
