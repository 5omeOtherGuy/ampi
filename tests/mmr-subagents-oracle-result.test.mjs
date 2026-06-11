import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

const RESULT_MODULE = "extensions/mmr-workers/oracle-result.ts";
const ORACLE_MODULE = "extensions/mmr-workers/oracle.ts";

after(cleanupLoadedSource);

const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };

const CONFIG = {
  workerDiscriminator: "mmr-subagents.oracle",
  workerTools: ["read", "grep", "find"],
};

function makeWorkerResult(overrides = {}) {
  return {
    messages: [],
    finalOutput: "advisory answer",
    truncatedFinalOutput: "advisory answer",
    usage: EMPTY_USAGE,
    trail: [],
    prompt: "task",
    cwd: "/repo",
    command: "pi",
    args: [],
    exitCode: 0,
    signal: null,
    stderr: "",
    aborted: false,
    outputTruncated: false,
    ignoredJsonLines: 0,
    agentStarted: true,
    ...overrides,
  };
}

function makeSnapshot(overrides = {}) {
  return {
    messages: [],
    finalOutput: "",
    truncatedFinalOutput: "",
    usage: EMPTY_USAGE,
    trail: [],
    ...overrides,
  };
}

const ATTACHMENTS = [
  { record: { kind: "text", path: "a.ts", bytes: 5, truncated: false, originalBytes: 5 }, text: "const" },
  { record: { kind: "skipped", path: "/etc/passwd", reason: "outside the working directory; not attached" } },
];

describe("mmr-subagents oracle-result", () => {
  it("renders progress content as stream-or-placeholder", async () => {
    const { progressContent, ORACLE_PROGRESS_PLACEHOLDER } = await importSource(RESULT_MODULE);

    assert.equal(ORACLE_PROGRESS_PLACEHOLDER, "oracle: consulting…");
    assert.equal(progressContent(makeSnapshot(), ORACLE_PROGRESS_PLACEHOLDER), ORACLE_PROGRESS_PLACEHOLDER);
    assert.equal(progressContent(makeSnapshot({ truncatedFinalOutput: "draft…" }), ORACLE_PROGRESS_PLACEHOLDER), "draft…");
  });

  it("projects progress details with attachment records and no status", async () => {
    const { buildProgressDetails } = await importSource(RESULT_MODULE);

    const details = buildProgressDetails(CONFIG, makeSnapshot(), "provider/model-x", "/repo", ATTACHMENTS, 200_000);
    assert.equal(details.worker, "mmr-subagents.oracle");
    assert.equal(details.status, undefined, "progress details carry no final status");
    assert.equal(details.model, "provider/model-x");
    assert.equal(details.contextWindow, 200_000);
    assert.deepEqual(details.attachments, ATTACHMENTS.map((a) => a.record));
    assert.equal(details.workerTools, CONFIG.workerTools);
  });

  it("classifies final details with the fail-on-nonzero policy", async () => {
    const { buildDetails } = await importSource(RESULT_MODULE);

    const ok = buildDetails(CONFIG, makeWorkerResult(), undefined, "/repo", ATTACHMENTS, undefined);
    assert.equal(ok.status, "success");
    assert.deepEqual(ok.attachments, ATTACHMENTS.map((a) => a.record));

    // Oracle policy: nonzero exit fails even when usable output exists.
    const nonzero = buildDetails(CONFIG, makeWorkerResult({ exitCode: 1 }), undefined, "/repo", [], undefined);
    assert.equal(nonzero.status, "worker-error");
  });

  it("renders status-aware final content", async () => {
    const { buildFinalContent } = await importSource(RESULT_MODULE);

    assert.equal(buildFinalContent("oracle", makeWorkerResult()), "advisory answer");

    const empty = { finalOutput: "", truncatedFinalOutput: "" };
    assert.match(
      buildFinalContent("oracle", makeWorkerResult({ ...empty, spawnError: "spawn ENOENT", exitCode: null })),
      /^oracle: worker spawn failed: spawn ENOENT$/,
    );
    assert.match(
      buildFinalContent("oracle", makeWorkerResult({ ...empty, subagentActivationError: "unknown profile" })),
      /^oracle: subagent activation failed: unknown profile$/,
    );
    assert.match(
      buildFinalContent("oracle", makeWorkerResult({ ...empty, aborted: true })),
      /cancelled before producing a result/,
    );
    const workerError = buildFinalContent(
      "oracle",
      makeWorkerResult({ ...empty, exitCode: 2, stderr: "first\nsecond\nthird\nlast" }),
    );
    assert.match(workerError, /exited with code 2/);
    assert.match(workerError, /second\nthird\nlast/, "keeps only the last three stderr lines");
    assert.match(
      buildFinalContent("oracle", makeWorkerResult({ ...empty, agentStarted: false })),
      /before the agent loop started/,
    );
    assert.match(
      buildFinalContent("oracle", makeWorkerResult({ ...empty, errorMessage: "provider exploded" })),
      /worker reported an error: provider exploded/,
    );
    assert.match(
      buildFinalContent("oracle", makeWorkerResult(empty)),
      /no advisory output was produced/,
    );
  });

  it("keeps the moved surface resolving through the oracle entry file", async () => {
    const resultModule = await importSource(RESULT_MODULE);
    const oracle = await importSource(ORACLE_MODULE);

    // `importSource` cache-busts per call: compare values, not identity.
    assert.equal(oracle.ORACLE_PROGRESS_PLACEHOLDER, resultModule.ORACLE_PROGRESS_PLACEHOLDER);
  });
});
