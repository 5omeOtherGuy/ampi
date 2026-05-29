// Negative-export test: after the task_list → session-local todo
// simplification, the package root must NOT re-export the old coordination
// surface. Future Task-agent reuse comes from the
// `archive/task-list-coordination-prototype-v1` tag, not from active root
// exports.
//

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const REMOVED_RUNTIME_EXPORTS = [
  "DEFAULT_CLAIM_TTL_MS",
  "TASK_STATUSES",
  "TaskStoreError",
  "TaskValidationError",
  "createTaskStore",
  "resolveTaskStorePath",
  "resolveDefaultTaskStoreBaseDir",
  "normalizeRepoURL",
  "resolveDefaultRepoURL",
  "resolveWorkspaceRoot",
  "__getTaskStoreInflightCount",
];

const REMOVED_TYPE_NAMES = [
  "Task",
  "TaskActor",
  "TaskStatus",
  "TaskAction",
  "ClaimTaskInput",
  "ReleaseTaskInput",
  "UpdateTaskInput",
  "CreateTaskInput",
  "ListTasksInput",
  "TaskStore",
  "TaskStoreDeps",
  "CompleteTaskResult",
];

describe("pi-mmr root exports: legacy task-list coordination surface is removed", () => {
  it("does not expose legacy runtime exports from the package root", async () => {
    const root = await importSource("index.ts");
    for (const name of REMOVED_RUNTIME_EXPORTS) {
      assert.equal(
        root[name],
        undefined,
        `package root must NOT export \`${name}\` (legacy task-list coordination); found ${typeof root[name]}`,
      );
    }
  });

  it("does not declare legacy type-name re-exports in src/index.ts", async () => {
    // Type-only exports are not observable at runtime, so we read the source
    // text and assert the legacy type names are gone (matches the positive
    // version of this test that was in mmr-pi-root-task-claims-exports.test.mjs).
    const fs = await import("node:fs/promises");
    const url = await import("node:url");
    const { getPreparedSourceRoot } = await import("./helpers/load-src.mjs");
    const root = getPreparedSourceRoot();
    const text = await fs.readFile(url.pathToFileURL(`${root}/index.ts`), "utf8");
    for (const name of REMOVED_TYPE_NAMES) {
      const pattern = new RegExp(`\\b${name}\\b`);
      assert.doesNotMatch(
        text,
        pattern,
        `src/index.ts must not reference legacy type \`${name}\``,
      );
    }
  });
});
