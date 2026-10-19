import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const user = (content) => ({ type: "message", message: { role: "user", content } });
const assistant = (...parts) => ({ type: "message", message: { role: "assistant", content: parts } });
const text = (value) => ({ type: "text", text: value });

const REQUEST = "Fix the crash when the parser reads an empty file";
const REPLY = "The parser assumed at least one token. I added a guard and a test.";
const MODELS = [{ provider: "openai-codex", id: "gpt-5.6-terra" }];

let dir;
let title;
let host;
let registry;
let workerHost;
/** Calls the fake worker host received, and what its next run returns. */
let runs;
let nextRun;

/** A worker result in the runner's shape; `overrides` change the outcome. */
function workerResult(finalOutput, overrides = {}) {
  return {
    messages: [],
    finalOutput,
    truncatedFinalOutput: finalOutput,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
    trail: [],
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
    ...overrides,
  };
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "ampi-threads-title-"));
  title = await importSource("extensions/ampi-threads/title.ts");
  const store = await importSource("extensions/ampi-threads/index-store.ts");
  registry = await importSource("extensions/ampi-core/command-registry.ts");
  workerHost = await importSource("extensions/ampi-core/worker-host.ts");
  registry.__resetMmrCommandsForTests();
  workerHost.__resetMmrWorkerHostForTests();
  runs = [];
  nextRun = async () => workerResult("Guard the parser against empty files.");
  workerHost.registerMmrWorkerHost("test", {
    runWorker: async (options) => {
      runs.push(options);
      return nextRun(options);
    },
  });
  host = { store: store.createMmrThreadIndexStore({ baseDir: dir }) };
});

afterEach(() => {
  workerHost.__resetMmrWorkerHostForTests();
  registry.__resetMmrCommandsForTests();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Register the titler on a mock Pi whose `setSessionName` names the session
 * the context reads, as Pi does.
 */
function setup({ entries = [user(REQUEST)], contextOptions = {}, settings = {} } = {}) {
  const mock = createMockPi();
  const debug = [];
  const context = createMockExtensionContext({ sessionId: "s-1", models: MODELS, entries, cwd: dir, ...contextOptions });
  let name = contextOptions.sessionName;
  context.ctx.sessionManager.getSessionName = () => name;
  context.ctx.sessionManager.getBranch = () => entries;
  const named = [];
  mock.pi.setSessionName = (value) => {
    named.push(value);
    name = value;
  };
  const titles = title.registerMmrThreadTitles({
    pi: mock.pi,
    index: host.store,
    loadCoreSettings: () => ({ settings }),
    onDebug: (message) => debug.push(message),
  });
  /** One agent run: start, the reply lands, the run settles; resolves once the title attempt is over. */
  const run = async (reply = assistant(text(REPLY)), settled = { type: "agent_settled", aborted: false }) => {
    await mock.handlers.get("agent_start")({ type: "agent_start" }, context.ctx);
    if (reply) entries.push(reply);
    await mock.handlers.get("agent_settled")(settled, context.ctx);
    await titles.idle();
  };
  return { ...mock, ...context, entries, named, debug, run, rename: (value) => (name = value) };
}

describe("thread title text", () => {
  it("keeps the first line and drops labels, quotes, emphasis and trailing periods", () => {
    const cases = [
      ["Guard the parser against empty files.", "Guard the parser against empty files"],
      ['"Guard empty parser input"', "Guard empty parser input"],
      ["“Fix login redirect loop”.", "Fix login redirect loop"],
      ["Title: Rename the build script...", "Rename the build script"],
      ["## **Add retry to uploads**", "Add retry to uploads"],
      ["\n\n  Port the CLI to Node 24  \nBecause the old one is end of life.", "Port the CLI to Node 24"],
      ["Why does CI fail on Windows?", "Why does CI fail on Windows?"],
    ];
    for (const [raw, expected] of cases) assert.equal(title.sanitizeMmrThreadTitle(raw), expected, raw);
  });

  it("cuts a title to six words, then to whole words within sixty characters", () => {
    assert.equal(
      title.sanitizeMmrThreadTitle("Investigate flaky upload tests in the storage layer today."),
      "Investigate flaky upload tests in the",
    );
    const long = title.sanitizeMmrThreadTitle("Internationalization configuration troubleshooting documentation regeneration walkthrough");
    assert.ok(long.length <= 60, long);
    assert.equal(long, "Internationalization configuration troubleshooting");
    assert.equal(title.sanitizeMmrThreadTitle("x".repeat(80)), "x".repeat(60));
  });

  it("returns nothing for an empty or punctuation-only answer", () => {
    for (const raw of ["", "  \n ", '"".', "..."]) assert.equal(title.sanitizeMmrThreadTitle(raw), undefined, JSON.stringify(raw));
  });

  it("builds the prompt from the first request and the first reply text, each cut to 400 characters", () => {
    const exchange = title.readMmrThreadFirstExchange([
      { type: "session_info", name: "ignored" },
      user([text("First   request\nwith lines "), { type: "image", data: "", mimeType: "image/png" }]),
      assistant({ type: "thinking", thinking: "hidden" }, { type: "toolCall", id: "t1", name: "read", arguments: {} }),
      { type: "message", message: { role: "assistant", content: [text("cut off")], stopReason: "aborted" } },
      assistant(text("y".repeat(500))),
      user("second request"),
      assistant(text("second reply")),
    ]);
    assert.equal(exchange.request, "First request with lines");
    assert.equal(exchange.reply, `${"y".repeat(399)}…`);
    assert.equal(
      title.buildMmrThreadTitlePrompt({ request: "Do the thing", reply: "Done." }),
      "First request:\nDo the thing\n\nStart of the reply:\nDone.",
    );
    assert.equal(title.readMmrThreadFirstExchange([user("only a prompt")]), undefined);
  });
});

describe("thread titles", () => {
  it("titles an unnamed session after its first exchange through the title worker", async () => {
    const t = setup();
    await t.run();

    assert.equal(runs.length, 1);
    const [call] = runs;
    assert.equal(call.profileName, "title");
    assert.equal(call.model, "openai-codex/gpt-5.6-terra");
    assert.deepEqual(call.tools, []);
    assert.equal(call.systemPromptDelivery, "replace");
    assert.equal(call.systemPrompt, title.MMR_THREAD_TITLE_SYSTEM_PROMPT);
    assert.equal(call.prompt, `First request:\n${REQUEST}\n\nStart of the reply:\n${REPLY}`);
    assert.deepEqual(t.named, ["Guard the parser against empty files"]);
    assert.deepEqual(await host.store.get("s-1"), { titleSource: "model" });
    assert.deepEqual(t.notifications, []);
  });

  it("uses a subagentModelPreferences.title override for the route", async () => {
    const t = setup({
      contextOptions: { models: [...MODELS, { provider: "anthropic", id: "claude-haiku-4-5" }] },
      settings: { subagentModelPreferences: { title: [{ model: "claude-haiku-4-5", providers: ["anthropic"] }] } },
    });
    await t.run();
    assert.equal(runs[0].model, "anthropic/claude-haiku-4-5");
  });

  it("never titles a session imported from another agent", async () => {
    const t = setup({ entries: [{ type: "custom", customType: "ampi-import", data: { agent: "claude-code" } }, user(REQUEST)] });
    await t.run();
    assert.equal(runs.length, 0);
    assert.deepEqual(t.named, []);
  });

  it("skips first prompts shorter than three words", async () => {
    const t = setup({ entries: [user("fix it")] });
    await t.run();
    assert.equal(runs.length, 0);
    assert.deepEqual(t.named, []);
  });

  it("never replaces a name the session already has, or one given while the model answers", async () => {
    const named = setup({ contextOptions: { sessionName: "My name" } });
    await named.run();
    assert.equal(runs.length, 0);

    await host.store.update("s-1", { titleSource: "user" });
    const userTitled = setup();
    await userTitled.run();
    assert.equal(runs.length, 0, "a user title, even one cleared since, is never replaced");
    await host.store.update("s-1", { titleSource: null });

    const renamed = setup();
    nextRun = async () => {
      renamed.rename("Typed while waiting");
      return workerResult("Generated title");
    };
    await renamed.run();
    assert.equal(runs.length, 1);
    assert.deepEqual(renamed.named, []);
    assert.equal(await host.store.get("s-1"), undefined);
  });

  it("titles only the run that answers the first prompt, and never retries", async () => {
    const resumed = setup({ entries: [user(REQUEST), assistant(text(REPLY)), user("and another thing please")] });
    await resumed.run();
    assert.equal(runs.length, 0, "a session that already had a reply is not titled");

    const aborted = setup();
    const stopped = { type: "message", message: { role: "assistant", content: [text("Look")], stopReason: "aborted" } };
    await aborted.run(stopped, { type: "agent_settled", aborted: true });
    assert.equal(runs.length, 0, "an aborted run gets no title");
    await aborted.run();
    await aborted.run();
    assert.equal(runs.length, 1, "the first completed reply gets one, once");
    runs.length = 0;

    const failed = setup({ contextOptions: { sessionId: "s-2" } });
    nextRun = async () => workerResult("", { exitCode: 1 });
    await failed.run();
    await failed.run();
    assert.equal(runs.length, 1);
    assert.deepEqual(failed.named, []);
    assert.deepEqual(failed.notifications, [], "failures stay silent");
    assert.deepEqual(failed.debug, ["the title worker ended with worker-error"]);
  });

  it("stays silent when no route or worker host is available, or the worker throws", async () => {
    const noRoute = setup({ contextOptions: { models: [] } });
    await noRoute.run();
    assert.match(noRoute.debug[0], /could not resolve any model route/);

    workerHost.__resetMmrWorkerHostForTests();
    const noHost = setup();
    await noHost.run();
    assert.deepEqual(noHost.debug, ["no worker host is registered (ampi-workers is not loaded)"]);

    workerHost.registerMmrWorkerHost("test", {
      runWorker: async () => {
        throw new Error("spawn failed");
      },
    });
    const thrown = setup();
    await thrown.run();
    assert.deepEqual(thrown.debug, ["spawn failed"]);
    assert.deepEqual([...noRoute.notifications, ...noHost.notifications, ...thrown.notifications], []);
  });

  it("does nothing outside the terminal UI, which includes subagent workers", async () => {
    for (const mode of ["print", "json", "rpc"]) {
      const t = setup({ contextOptions: { hasUI: false, mode } });
      await t.run();
    }
    assert.equal(runs.length, 0);
  });

  it("drops a title that arrives after the session ended", async () => {
    const t = setup();
    nextRun = async (options) => {
      await t.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "new" }, t.ctx);
      assert.equal(options.signal.aborted, true);
      return workerResult("Too late", { aborted: true });
    };
    await t.run();
    assert.deepEqual(t.named, []);
  });
});

describe("ampi-threads titles setting and rename", () => {
  async function loadExtension(settings) {
    const { createMmrThreadsExtension } = await importSource("extensions/ampi-threads/index.ts");
    const { createMmrPromptHistoryStore } = await importSource("extensions/ampi-threads/history-store.ts");
    const mock = createMockPi();
    createMmrThreadsExtension({
      loadSettings: () => ({ enabled: true, autoArchiveOnQuit: false, showCosts: true, titles: true, ...settings }),
      createStore: () => host.store,
      createHistoryStore: () => createMmrPromptHistoryStore({ baseDir: path.join(dir, "history") }),
      loadCoreSettings: () => ({ settings: {} }),
    })(mock.pi);
    return mock;
  }

  async function shutdown(mock, ctx) {
    await mock.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "new" }, ctx);
  }

  it("registers the titler only while ampiThreads.titles is on", async () => {
    const off = await loadExtension({ titles: false });
    assert.equal(off.handlers.has("agent_settled"), false);
    await shutdown(off, createMockExtensionContext({ sessionId: "s-1" }).ctx);

    const on = await loadExtension({});
    assert.equal(on.handlers.has("agent_settled"), true);
    await shutdown(on, createMockExtensionContext({ sessionId: "s-1" }).ctx);
  });

  it("renames the session from an empty input and records the title as the user's", async () => {
    const mock = await loadExtension({});
    const { ctx } = createMockExtensionContext({ sessionId: "s-1" });
    const asked = [];
    const answers = ["  Parser   fixes ", "", undefined];
    ctx.ui.input = async (...args) => {
      asked.push(args);
      return answers.shift();
    };
    const named = [];
    mock.pi.setSessionName = (value) => named.push(value);
    const rename = registry.getMmrCommand("thread.rename");
    assert.equal(`${rename.noun} ${rename.verb}`, "thread rename");

    await rename.run(ctx);
    assert.deepEqual(asked, [["Rename Thread", "Thread title"]]);
    assert.deepEqual(named, ["Parser fixes"]);
    assert.deepEqual(await host.store.get("s-1"), { titleSource: "user" });

    // An empty answer or Escape keeps the current title.
    await rename.run(ctx);
    await rename.run(ctx);
    assert.deepEqual(named, ["Parser fixes"]);
    await shutdown(mock, ctx);
  });
});
