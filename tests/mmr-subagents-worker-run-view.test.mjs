import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const VIEW_MODULE = "extensions/ampi-workers/worker-run-view.ts";

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
    assert.equal(group.gated, false);

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

const ENVELOPE_MODULE = "extensions/ampi-workers/worker-run-envelope.ts";

describe("buildWorkerRunFinal (rich N=1 projection)", () => {
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
    assert.equal(final.status, "succeeded");
    assert.equal(final.model, "gpt-5.4-mini");
    assert.match(final.diagnostic, /Spawn failed: pi not found/);
    assert.equal(final.collapsedBody, "short body");
    assert.equal(final.expandedBody, "long body");
    assert.equal(final.background, false);
    assert.equal(final.partial, false);
    assert.equal(final.showTerminalSections, true);
    assert.equal(final.spaceBeforeTrailWhenExpanded, "never");
    assert.equal(final.spaceBeforeOutputWhenExpanded, "conditional");
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
    assert.equal(final.showTerminalSections, false);
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
    assert.equal(final.status, "succeeded");
    assert.equal(final.model, "gpt-5.4-mini");
    assert.deepEqual(final.trail, [{ type: "assistant", text: "legacy trail" }]);
    assert.deepEqual(final.usage, { turns: 2 });
  });

  it("projects a cancelled background run as neutral (raw status kept, no error diagnostic)", async () => {
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
    assert.equal(final.backgroundStatus, "cancelled");
    assert.equal(final.status, "failed");
    assert.equal(final.diagnostic, undefined);
    assert.equal(final.background, true);
    assert.equal(final.model, "gemini-3");
    assert.equal(final.collapsedBody, "desc body");
    assert.equal(final.expandedBody, "full prompt body");
    assert.equal(final.spaceBeforeTrailWhenExpanded, "whenRawTrailNonEmpty");
    assert.equal(final.spaceBeforeOutputWhenExpanded, "always");
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
    assert.equal(final.status, "failed");
    assert.equal(final.diagnostic, "boom");
    assert.equal(final.partial, true);
    // final.reportedModel wins over final.model and details.resolvedModel.
    assert.equal(final.model, "rm");
    assert.equal(final.statusLineName, "Task");
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
    assert.equal(final.showTerminalSections, true);
  });
});
