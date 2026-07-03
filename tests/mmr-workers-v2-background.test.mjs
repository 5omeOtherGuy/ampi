import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockPi } from "./helpers/pi-stub.mjs";

const TOOLS_MODULE = "extensions/ampi-workers/async-task-tools.ts";
const REGISTRY_MODULE = "extensions/ampi-workers/async-task-registry.ts";
const DISPATCH_MODULE = "extensions/ampi-workers/background-dispatch.ts";
const FINDER_MODULE = "extensions/ampi-workers/builtin-workers/finder.ts";
const LIBRARIAN_MODULE = "extensions/ampi-workers/builtin-workers/librarian.ts";
const TASK_MODULE = "extensions/ampi-workers/builtin-workers/task.ts";
const ORACLE_PROMPT_MODULE = "extensions/ampi-workers/builtin-workers/oracle-prompt.ts";

after(cleanupLoadedSource);

afterEach(async () => {
  const dispatch = await importSource(DISPATCH_MODULE);
  dispatch.registerMmrBackgroundDispatcher(undefined);
  dispatch.registerMmrBackgroundCardExtras(undefined);
});

const CTX = { cwd: "/repo" };

function makeWorkerResult(overrides = {}) {
  return {
    messages: [],
    finalOutput: "worker done",
    truncatedFinalOutput: "worker done",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 1, turns: 1 },
    prompt: "",
    cwd: "",
    command: "pi",
    args: [],
    exitCode: 0,
    signal: null,
    stderr: "",
    aborted: false,
    outputTruncated: false,
    ignoredJsonLines: 0,
    agentStarted: true,
    trail: [],
    ...overrides,
  };
}

async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

/**
 * Wire the background surface and build a blocking finder tool that shares
 * the same seams the dispatcher will use when it re-creates the worker tool.
 */
async function makeV2Harness({ taskIds = ["t1", "t2", "t3"] } = {}) {
  const tools = await importSource(TOOLS_MODULE);
  const finderModule = await importSource(FINDER_MODULE);
  const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
  let next = 0;
  const registry = createMmrAsyncTaskRegistry({ idFactory: () => taskIds[next++] ?? `t${next}` });
  const runner = { run: async () => makeWorkerResult() };
  const sharedDeps = { registry, sessionKey: "S", runner, buildSystemPrompt: () => "WORKER PROMPT" };
  const { pi } = createMockPi();
  tools.registerAsyncTaskTools(pi, sharedDeps);
  const finder = finderModule.createFinderTool({ runner, buildSystemPrompt: () => "WORKER PROMPT" });
  return { registry, finder, tools };
}

describe("v2 worker schemas", () => {
  it("adds background/group/notify to finder, librarian, and Task but not oracle", async () => {
    const finder = await importSource(FINDER_MODULE);
    const librarian = await importSource(LIBRARIAN_MODULE);
    const task = await importSource(TASK_MODULE);
    const oracle = await importSource(ORACLE_PROMPT_MODULE);
    for (const schema of [finder.FINDER_PARAMETERS_SCHEMA, librarian.LIBRARIAN_PARAMETERS_SCHEMA, task.TASK_PARAMETERS_SCHEMA]) {
      assert.equal(schema.properties.background?.type, "boolean");
      assert.equal(schema.properties.group?.type, "string");
      assert.equal(schema.properties.notify?.type, "boolean");
    }
    assert.equal(oracle.ORACLE_PARAMETERS_SCHEMA.properties.background, undefined, "oracle stays blocking-only");
    assert.equal(oracle.ORACLE_PARAMETERS_SCHEMA.properties.group, undefined);
    assert.equal(oracle.ORACLE_PARAMETERS_SCHEMA.properties.notify, undefined);
  });
});

describe("background: true through a named worker tool", () => {
  it("starts a background run and returns the spawn payload instead of blocking", async () => {
    const { finder } = await makeV2Harness();
    const result = await finder.execute(
      "call-1",
      { query: "find the flux capacitor", background: true },
      new AbortController().signal,
      undefined,
      CTX,
    );
    assert.equal(result.details.worker, "ampi-workers.async-task");
    assert.equal(result.details.tool, "finder");
    assert.equal(result.details.backgroundStart, true);
    assert.equal(result.details.agent, "finder");
    assert.equal(result.details.taskId, "t1");
    assert.match(result.content[0].text, /^finder: started background worker t1/);
    assert.doesNotMatch(result.content[0].text, /start_task is deprecated/);
    await flush();
  });

  it("lands parallel calls sharing a group key in ONE group, opener first", async () => {
    const { finder, registry } = await makeV2Harness();
    const first = await finder.execute(
      "call-1",
      { query: "scan module A", background: true, group: "swarm-review" },
      new AbortController().signal,
      undefined,
      CTX,
    );
    const second = await finder.execute(
      "call-2",
      { query: "scan module B", background: true, group: "swarm-review" },
      new AbortController().signal,
      undefined,
      CTX,
    );
    assert.ok(first.details.groupId, "the first call mints the group");
    assert.equal(second.details.groupId, first.details.groupId, "the shared key joins the same group");
    assert.equal(first.details.groupOpener, true, "the minting call owns the group card");
    assert.equal(second.details.groupOpener, undefined, "siblings render nothing inline");
    const group = registry.getGroup("S", first.details.groupId);
    assert.equal(group?.counts.total, 2);
    assert.equal(group?.label, "swarm-review", "the caller-chosen key labels the group");
    await flush();
  });

  it("honors notify:false on a background run", async () => {
    const { finder } = await makeV2Harness();
    const result = await finder.execute(
      "call-1",
      { query: "quiet run", background: true, notify: false },
      new AbortController().signal,
      undefined,
      CTX,
    );
    assert.match(result.content[0].text, /Automatic delivery is disabled/);
    await flush();
  });

  it("rejects group/notify without background: true and a non-boolean background", async () => {
    const { finder } = await makeV2Harness();
    await assert.rejects(
      () => finder.execute("c1", { query: "x", group: "g" }, new AbortController().signal, undefined, CTX),
      /group and notify require background: true/,
    );
    await assert.rejects(
      () => finder.execute("c2", { query: "x", notify: false }, new AbortController().signal, undefined, CTX),
      /group and notify require background: true/,
    );
    await assert.rejects(
      () => finder.execute("c3", { query: "x", background: "yes" }, new AbortController().signal, undefined, CTX),
      /background must be a boolean/,
    );
  });

  it("fails closed when the background surface is not registered", async () => {
    const finderModule = await importSource(FINDER_MODULE);
    const dispatch = await importSource(DISPATCH_MODULE);
    dispatch.registerMmrBackgroundDispatcher(undefined);
    const finder = finderModule.createFinderTool({
      runner: { run: async () => makeWorkerResult() },
      buildSystemPrompt: () => "P",
    });
    await assert.rejects(
      () => finder.execute("c1", { query: "x", background: true }, new AbortController().signal, undefined, CTX),
      /background runs are unavailable/,
    );
  });

  it("keeps an explicit background:false call on the blocking path", async () => {
    const { finder } = await makeV2Harness();
    const result = await finder.execute(
      "call-1",
      { query: "find it now", background: false },
      new AbortController().signal,
      undefined,
      CTX,
    );
    assert.notEqual(result.details?.worker, "ampi-workers.async-task");
    assert.match(result.content[0].text, /worker done/);
  });
});

describe("start_task deprecation alias", () => {
  it("appends the deprecation notice to a successful start result", async () => {
    const tools = await importSource(TOOLS_MODULE);
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const registry = createMmrAsyncTaskRegistry({ idFactory: () => "t1" });
    const runner = { run: async () => makeWorkerResult() };
    const startTask = tools.createStartTaskTool({ registry, sessionKey: "S", runner, buildSystemPrompt: () => "P" });
    const result = await startTask.execute(
      "call-1",
      { agent: "finder", params: { query: "find it" } },
      undefined,
      undefined,
      CTX,
    );
    assert.match(result.content[0].text, /start_task: started background worker t1/);
    assert.match(result.content[0].text, /start_task is deprecated; call the worker tool directly with background: true/);
    assert.match(startTask.description, /DEPRECATED compatibility alias/);
    await flush();
  });
});
