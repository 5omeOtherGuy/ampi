import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const VIEW_MODULE = "extensions/ampi-workers/rendering/worker-run-view.ts";

describe("worker-run-view", () => {
  it("classifies background payloads by the pinned branch order: fleet → board → group → spawn → final", async () => {
    const { buildWorkerRunView } = await importSource(VIEW_MODULE);
    const base = { worker: "ampi-workers.async-task" };

    const fleet = buildWorkerRunView({ ...base, fleet: { groups: [] }, board: {}, group: {} });
    assert.equal(fleet.surface, "fleet");
    assert.equal(fleet.gated, true);

    const board = buildWorkerRunView({ ...base, board: { version: 1 }, group: {} });
    assert.equal(board.surface, "board");

    const group = buildWorkerRunView({ ...base, group: { status: "running" }, groupId: "group_abc123" });
    assert.equal(group.surface, "group-control");
    assert.equal(group.groupId, "group_abc123");
    assert.equal(group.gated, true);

    const spawn = buildWorkerRunView({ ...base, tool: "start_task", taskId: "t1" });
    assert.equal(spawn.surface, "spawn");
    assert.equal(spawn.gated, true);
    assert.equal(spawn.groupOpener, false);

    const namedSpawn = buildWorkerRunView({ ...base, backgroundStart: true, taskId: "t2" });
    assert.equal(namedSpawn.surface, "spawn");

    const opener = buildWorkerRunView({ ...base, tool: "start_task", groupId: "g", groupOpener: true });
    assert.equal(opener.groupOpener, true);

    const final = buildWorkerRunView({
      ...base,
      taskId: "t3",
      agent: "finder",
      status: "succeeded",
      final: { usage: { turns: 2 } },
    });
    assert.equal(final.surface, "background-final");
    assert.deepEqual(final.final, { usage: { turns: 2 } });
  });

  it("treats a malformed final snapshot as an empty projection, never a throw", async () => {
    const { buildWorkerRunView } = await importSource(VIEW_MODULE);
    const view = buildWorkerRunView({
      worker: "mmr-subagents.async-task",
      taskId: "t",
      agent: "Task",
      status: "succeeded",
      final: "not-a-record",
    });
    assert.equal(view.surface, "background-final");
    assert.deepEqual(view.final, {});
  });

  it("classifies non-background record details (and undefined) as the blocking surface", async () => {
    const { buildWorkerRunView } = await importSource(VIEW_MODULE);
    const blocking = buildWorkerRunView({ model: "m", usage: { turns: 1 } });
    assert.equal(blocking.surface, "blocking");
    assert.deepEqual(blocking.details, { model: "m", usage: { turns: 1 } });
    assert.equal(buildWorkerRunView(undefined).surface, "blocking");
    assert.equal(buildWorkerRunView("plain text").surface, "plain");
  });

  it("classifies replayed section payloads without a worker discriminator (frozen-details replay contract)", async () => {
    const { buildWorkerRunView } = await importSource(VIEW_MODULE);
    // Older replayed records carry fleet/board/group sections without the
    // worker string; they must still resolve to their section surface.
    assert.equal(buildWorkerRunView({ fleet: { groups: [] } }).surface, "fleet");
    assert.equal(buildWorkerRunView({ board: { version: 1 } }).surface, "board");
    assert.equal(buildWorkerRunView({ group: {}, groupId: "g" }).surface, "group-control");
  });

  it("recognizes both current and legacy background worker discriminators", async () => {
    const { isMmrBackgroundWorkerDetails } = await importSource(VIEW_MODULE);
    assert.equal(isMmrBackgroundWorkerDetails({ worker: "ampi-workers.async-task" }), true);
    assert.equal(isMmrBackgroundWorkerDetails({ worker: "mmr-subagents.async-task" }), true);
    assert.equal(isMmrBackgroundWorkerDetails({ worker: "ampi-custom-subagents.sa__x" }), false);
    assert.equal(isMmrBackgroundWorkerDetails(undefined), false);
  });
});

const ENVELOPE_MODULE = "extensions/ampi-workers/rendering/worker-run-envelope.ts";

describe("buildWorkerRunFinal (N=1 row projection)", () => {
  it("projects blocking status/model/diagnostic/body precedence from legacy details", async () => {
    const { buildWorkerRunFinal } = await importSource(VIEW_MODULE);
    const final = buildWorkerRunFinal({
      surface: "blocking",
      toolName: "Task",
      details: {
        // details.status === "success" must win over a non-zero exit code.
        status: "success",
        exitCode: 2,
        // reportedModel wins over model; provider prefix is stripped.
        reportedModel: "openai-codex/gpt-5.4-mini",
        model: "other-provider/ignored",
        // spawnError has the highest diagnostic precedence.
        spawnError: "pi not found",
        errorMessage: "generic error",
        trail: [{ type: "assistant", text: "trail item" }],
        usage: { turns: 1 },
      },
      isPartial: false,
      context: undefined,
      collapsedBody: "short body",
      expandedBody: "long body",
      trailWorkerPrompt: "prompt",
      output: "final answer",
    });
    assert.equal(final.surface, "blocking");
    assert.equal(final.agent, "Task");
    assert.equal(final.status, "done");
    assert.equal(final.model, "gpt-5.4-mini");
    assert.match(final.diagnostic, /Spawn failed: pi not found/);
    // The run succeeded, so its diagnostic is a note, not an error.
    assert.equal(final.diagnosticColor, "warning");
    assert.equal(final.detail, "short body");
    assert.equal(final.prompt, "long body");
    assert.equal(final.tail, undefined);
    assert.equal(final.finished, true);
    assert.equal(final.usageName, "Task");
  });

  it("projects an aborted blocking run as cancelled and a failed one as an error", async () => {
    const { buildWorkerRunFinal } = await importSource(VIEW_MODULE);
    const project = (details, args) => buildWorkerRunFinal({
      surface: "blocking",
      toolName: "Task",
      details,
      isPartial: false,
      context: { args },
      collapsedBody: "Fix lint\nand tests",
      expandedBody: undefined,
      trailWorkerPrompt: undefined,
      output: "",
    });
    const aborted = project({ aborted: true, stopReason: "aborted" }, { capabilityProfile: "read-only" });
    assert.equal(aborted.status, "cancelled");
    assert.equal(aborted.variant, "read-only");
    assert.equal(aborted.detail, "Fix lint …", "the detail is the first line of what the worker was asked");
    const failed = project({ exitCode: 1, errorMessage: "worker crashed" });
    assert.equal(failed.status, "error");
    assert.equal(failed.diagnosticColor, "error");
    assert.equal(failed.variant, undefined);
  });

  it("marks a partial blocking run as running with terminal sections suppressed", async () => {
    const { buildWorkerRunFinal } = await importSource(VIEW_MODULE);
    const final = buildWorkerRunFinal({
      surface: "blocking",
      toolName: "finder",
      details: { reportedModel: "prov/m" },
      isPartial: true,
      context: undefined,
      collapsedBody: "c",
      expandedBody: "e",
      trailWorkerPrompt: undefined,
      output: "",
    });
    assert.equal(final.status, "running");
    assert.equal(final.finished, false);
    assert.equal(final.suppressDuplicateFinalOutput, false);
  });

  it("reads rich blocking fields from legacy details even when an envelope is present (dual-write)", async () => {
    const { buildWorkerRunFinal } = await importSource(VIEW_MODULE);
    const { buildWorkerRunEnvelope, attachWorkerRunEnvelope } = await importSource(ENVELOPE_MODULE);
    const envelope = buildWorkerRunEnvelope({
      profileName: "finder-profile",
      toolName: "finder",
      agent: "finder",
      runMode: "blocking",
      status: "succeeded",
      workerTools: [],
    });
    const details = attachWorkerRunEnvelope(
      {
        reportedModel: "openai-codex/gpt-5.4-mini",
        stopReason: "end_turn",
        trail: [{ type: "assistant", text: "legacy trail" }],
        usage: { turns: 2 },
      },
      envelope,
    );
    const final = buildWorkerRunFinal({
      surface: "blocking",
      toolName: "finder",
      details,
      isPartial: false,
      context: undefined,
      collapsedBody: "c",
      expandedBody: "e",
      trailWorkerPrompt: undefined,
      output: "o",
    });
    assert.equal(final.status, "done");
    assert.equal(final.model, "gpt-5.4-mini");
    assert.deepEqual(final.trail, [{ type: "assistant", text: "legacy trail" }]);
    assert.deepEqual(final.usage, { turns: 2 });
  });

  it("projects a cancelled background run as cancelled, with no error diagnostic", async () => {
    const { buildWorkerRunFinal } = await importSource(VIEW_MODULE);
    const final = buildWorkerRunFinal({
      surface: "background",
      details: {
        worker: "ampi-workers.async-task",
        tool: "task_poll",
        agent: "finder",
        taskId: "t1",
        status: "cancelled",
        description: "desc body",
        prompt: "full prompt body",
        resolvedModel: "google/gemini-3",
        errorMessage: "aborted by watchdog",
      },
      final: {},
      startDisplay: undefined,
      output: "",
    });
    assert.equal(final.surface, "background");
    assert.equal(final.agent, "finder");
    assert.equal(final.status, "cancelled");
    assert.equal(final.diagnostic, undefined);
    assert.equal(final.model, "gemini-3");
    assert.equal(final.detail, "desc body");
    assert.equal(final.prompt, "full prompt body");
    assert.equal(final.finished, true);
  });

  it("drops the agent name a run description starts with, as the row's phrase names it", async () => {
    const { buildWorkerRunFinal } = await importSource(VIEW_MODULE);
    const final = buildWorkerRunFinal({
      surface: "background",
      details: { worker: "ampi-workers.async-task", tool: "task_wait", agent: "oracle", taskId: "t9", status: "succeeded", description: "oracle: Review the plan" },
      final: {},
      startDisplay: undefined,
      output: "",
    });
    assert.equal(final.detail, "Review the plan");
  });

  it("surfaces the failed-background diagnostic, the partial chip, and final-model precedence", async () => {
    const { buildWorkerRunFinal } = await importSource(VIEW_MODULE);
    const final = buildWorkerRunFinal({
      surface: "background",
      details: {
        worker: "ampi-workers.async-task",
        tool: "task_poll",
        agent: "Task",
        taskId: "t2",
        status: "failed",
        errorMessage: "boom",
        terminalOutcome: "partial",
        resolvedModel: "z/rv",
      },
      final: { reportedModel: "x/rm", model: "y/m", trail: [{ type: "assistant", text: "leg" }] },
      startDisplay: undefined,
      output: "",
    });
    assert.equal(final.status, "error");
    assert.equal(final.diagnostic, "boom");
    assert.equal(final.diagnosticColor, "error");
    assert.equal(final.tail, "(partial)");
    // final.reportedModel wins over final.model and details.resolvedModel.
    assert.equal(final.model, "rm");
    assert.equal(final.usageName, "Task");
  });

  it("tolerates an empty background final snapshot without throwing", async () => {
    const { buildWorkerRunFinal } = await importSource(VIEW_MODULE);
    const final = buildWorkerRunFinal({
      surface: "background",
      details: { worker: "ampi-workers.async-task", tool: "task_poll", agent: "finder", taskId: "t3", status: "succeeded" },
      final: {},
      startDisplay: undefined,
      output: "",
    });
    assert.equal(final.trail.length, 0);
    assert.equal(final.usage, undefined);
    assert.equal(final.model, undefined);
    assert.equal(final.finished, true);
  });
});
