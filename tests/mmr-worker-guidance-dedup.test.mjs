// Single-render invariant for worker tool guidance (PR #181 follow-up).
//
// The model-visible worker policy has exactly one home per statement: each
// tool contributes its routing bullet to Pi's `Guidelines:` block, the
// cross-worker policy renders once in the `## Using workers` block, and the
// schema description carries only tool-specific mechanics. The post-#181
// wire capture showed three leaks: the task_cancel sentence rendered
// verbatim in both Guidelines and Using workers, the task_wait bullet
// restated the timeout semantics of the result-delivery paragraph, and the
// deprecated start_task description re-embedded the shared selection/
// blocking policy plus a second fleet fan-out paragraph.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const GUIDANCE_MODULE = "extensions/ampi-core/worker-tool-guidance.ts";
const SCHEMA_MODULE = "extensions/ampi-workers/background/async-task-tool-schemas.ts";

const FULL_WORKER_SURFACE = [
  "Task",
  "finder",
  "librarian",
  "oracle",
  "reviewer",
  "start_task",
  "task_poll",
  "task_wait",
  "task_cancel",
];

describe("worker guidance single-render invariant", () => {
  it("no routing guideline bullet renders again inside the Using workers block", async () => {
    const { buildUsingWorkersGuidance } = await importSource(GUIDANCE_MODULE);
    const block = buildUsingWorkersGuidance(FULL_WORKER_SURFACE);
    const guidelineSources = [
      ["extensions/ampi-workers/builtin-workers/task.ts", "TASK_PROMPT_GUIDELINES"],
      ["extensions/ampi-workers/builtin-workers/finder.ts", "FINDER_PROMPT_GUIDELINES"],
      ["extensions/ampi-workers/builtin-workers/librarian.ts", "LIBRARIAN_PROMPT_GUIDELINES"],
      ["extensions/ampi-workers/builtin-workers/oracle.ts", "ORACLE_PROMPT_GUIDELINES"],
      ["extensions/ampi-workers/builtin-workers/reviewer.ts", "REVIEWER_PROMPT_GUIDELINES"],
      [SCHEMA_MODULE, "START_TASK_PROMPT_GUIDELINES"],
      [SCHEMA_MODULE, "TASK_POLL_PROMPT_GUIDELINES"],
      [SCHEMA_MODULE, "TASK_WAIT_PROMPT_GUIDELINES"],
      [SCHEMA_MODULE, "TASK_CANCEL_PROMPT_GUIDELINES"],
    ];
    for (const [modulePath, exportName] of guidelineSources) {
      const mod = await importSource(modulePath);
      const guidelines = mod[exportName];
      assert.ok(Array.isArray(guidelines) && guidelines.length >= 1, `${exportName} missing`);
      for (const bullet of guidelines) {
        assert.ok(
          !block.includes(bullet),
          `${exportName} bullet must not also render in the Using workers block: "${bullet}"`,
        );
      }
    }
  });

  it("task_wait's routing bullet leaves the timeout semantics to the result-delivery paragraph", async () => {
    const { TASK_WAIT_PROMPT_GUIDELINES } = await importSource(SCHEMA_MODULE);
    const { WORKER_RESULT_DELIVERY_GUIDANCE } = await importSource(GUIDANCE_MODULE);
    assert.match(WORKER_RESULT_DELIVERY_GUIDANCE, /timeout is not a failure/);
    assert.doesNotMatch(TASK_WAIT_PROMPT_GUIDELINES[0], /timeout is not a failure/);
    // The bullet still has to convey the non-cancelling nature of a wait.
    assert.match(TASK_WAIT_PROMPT_GUIDELINES[0], /without cancelling/i);
  });

  it("the start_task description does not re-embed the shared cross-worker policy", async () => {
    const { buildStartTaskDescription } = await importSource(SCHEMA_MODULE);
    const {
      WORKER_BACKGROUND_SELECTION_GUIDANCE,
      ORACLE_ALWAYS_BLOCKING_GUIDANCE,
      WORKER_RESULT_DELIVERY_GUIDANCE,
    } = await importSource(GUIDANCE_MODULE);
    const description = buildStartTaskDescription();
    assert.ok(
      !description.includes(WORKER_BACKGROUND_SELECTION_GUIDANCE),
      "blocking-vs-background selection policy renders once, in the Using workers block",
    );
    assert.ok(
      !description.includes(ORACLE_ALWAYS_BLOCKING_GUIDANCE),
      "oracle's always-blocking constraint renders once, in the Using workers block",
    );
    assert.ok(
      !description.includes(WORKER_RESULT_DELIVERY_GUIDANCE),
      "result-delivery semantics render once, in the Using workers block",
    );
    assert.doesNotMatch(
      description,
      /timeout is not a failure/,
      "task_wait timeout semantics live in the result-delivery paragraph",
    );
  });

  it("the start_task description states the fleet fan-out mechanics exactly once", async () => {
    const { buildStartTaskDescription } = await importSource(SCHEMA_MODULE);
    const description = buildStartTaskDescription();
    const fleetMechanics = description.match(/renders every group card up front in a ready state/g) ?? [];
    assert.equal(fleetMechanics.length, 1, "fleet fan-out mechanics must render once");
    const notifyDefault = description.match(/notify/g) ?? [];
    assert.ok(notifyDefault.length <= 2, "notify semantics should not repeat across paragraphs");
    // The unique constraints survive the trim.
    assert.match(description, /Omit group_id inside fleet, and do not combine fleet with the single-task fields/);
    assert.match(description, /group_id is the legacy incremental path/);
    assert.match(description, /DEPRECATED compatibility alias/);
  });
});
