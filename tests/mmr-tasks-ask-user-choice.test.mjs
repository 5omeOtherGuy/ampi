// ask_user_choice: the model asks the user to pick one of a few options.
//
// Covers the argument limits (schema and the tool's own check), the rows the
// select dialog receives, every way the dialog can end (a choice, a typed
// answer, a dismissal, an abort), the no-UI result, the tool's ownership
// surfaces and its transcript row.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { Check } from "typebox/value";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const TOOL_MODULE = "extensions/ampi-tasks/ask-user-choice-tool.ts";
const QUESTION = "Which database should the cache use?";
const OPTIONS = ["Postgres", "SQLite", "Redis"];

async function loadTool() {
  const mod = await importSource(TOOL_MODULE);
  return { mod, tool: mod.createAskUserChoiceTool() };
}

/** A UI context whose select and input answer from the given scripts and record their calls. */
function uiContext({ select, input } = {}) {
  const { ctx } = createMockExtensionContext({ hasUI: true });
  const calls = { select: [], input: [] };
  ctx.ui.select = async (title, rows, opts) => {
    calls.select.push({ title, rows, opts });
    return select ? select(title, rows, opts) : undefined;
  };
  ctx.ui.input = async (title, placeholder, opts) => {
    calls.input.push({ title, placeholder, opts });
    return input ? input(title, placeholder, opts) : undefined;
  };
  return { ctx, calls };
}

function run(tool, params, ctx, signal = new AbortController().signal) {
  return tool.execute("call-1", params, signal, undefined, ctx);
}

function text(result) {
  return result.content.map((block) => block.text).join("\n");
}

describe("ask_user_choice arguments", () => {
  const option = (length) => "o".repeat(length - 1) + "!";
  const cases = [
    { name: "1 option", params: { question: QUESTION, options: ["Only"] }, schema: false, error: /options must be an array of 2 to 8 strings \(got 1\)/ },
    { name: "2 options", params: { question: QUESTION, options: ["A", "B"] }, schema: true },
    { name: "8 options", params: { question: QUESTION, options: ["A", "B", "C", "D", "E", "F", "G", "H"] }, schema: true },
    { name: "9 options", params: { question: QUESTION, options: ["A", "B", "C", "D", "E", "F", "G", "H", "I"] }, schema: false, error: /got 9/ },
    // The schema cannot see a repeat that only differs by surrounding spaces.
    { name: "a repeat after trimming", params: { question: QUESTION, options: ["Postgres", " Postgres "] }, schema: true, error: /options\[1\] repeats options\[0\] \("Postgres"\)/ },
    { name: "an 80-character option", params: { question: QUESTION, options: [option(80), "B"] }, schema: true },
    { name: "an 81-character option", params: { question: QUESTION, options: [option(81), "B"] }, schema: false, error: /options\[0\] must be at most 80 characters \(got 81\)/ },
    { name: "an empty question", params: { question: "", options: ["A", "B"] }, schema: false, error: /question must be a non-empty string/ },
    { name: "a blank question", params: { question: "   ", options: ["A", "B"] }, schema: true, error: /question must be a non-empty string/ },
    { name: "a 200-character question", params: { question: "q".repeat(200), options: ["A", "B"] }, schema: true },
    { name: "a 201-character question", params: { question: "q".repeat(201), options: ["A", "B"] }, schema: false, error: /question must be at most 200 characters/ },
    { name: "a two-line question", params: { question: "Which one?\nReally?", options: ["A", "B"] }, schema: true, error: /question must be a single line/ },
    { name: "an unknown field", params: { question: QUESTION, options: ["A", "B"], multi: true }, schema: false, error: /unknown parameter "multi"/ },
  ];

  for (const { name, params, schema, error } of cases) {
    it(`${error ? "refuses" : "accepts"} ${name}`, async () => {
      const { mod, tool } = await loadTool();
      assert.equal(Check(mod.ASK_USER_CHOICE_PARAMS, params), schema, "schema verdict");
      const { ctx, calls } = uiContext({ select: (_title, rows) => rows[0] });
      const result = await run(tool, params, ctx);
      if (error) {
        assert.equal(result.isError, true);
        assert.match(text(result), /^ask_user_choice rejected: /);
        assert.match(text(result), error);
        assert.match(result.details.error, error);
        assert.equal(calls.select.length, 0, "no dialog opens for invalid input");
      } else {
        assert.notEqual(result.isError, true, text(result));
        assert.equal(calls.select.length, 1);
      }
    });
  }
});

describe("ask_user_choice with a UI", () => {
  it("offers exactly the options, with the typed-answer row last only when allow_other is true", async () => {
    const { mod, tool } = await loadTool();
    for (const [allowOther, expected] of [
      [undefined, OPTIONS],
      [false, OPTIONS],
      [true, [...OPTIONS, mod.ASK_USER_CHOICE_OTHER_ROW]],
    ]) {
      const { ctx, calls } = uiContext();
      const signal = new AbortController().signal;
      const params = { question: QUESTION, options: OPTIONS, ...(allowOther === undefined ? {} : { allow_other: allowOther }) };
      await run(tool, params, ctx, signal);
      assert.equal(calls.select.length, 1);
      assert.equal(calls.select[0].title, QUESTION);
      assert.deepEqual(calls.select[0].rows, expected, `allow_other: ${allowOther}`);
      assert.equal(calls.select[0].opts.signal, signal, "the dialog gets the call's abort signal");
    }
  });

  it("returns the chosen option verbatim with its index", async () => {
    const { tool } = await loadTool();
    const { ctx, calls } = uiContext({ select: () => "SQLite" });
    const result = await run(tool, { question: QUESTION, options: OPTIONS, allow_other: true }, ctx);
    assert.notEqual(result.isError, true);
    assert.equal(text(result), "The user chose: SQLite");
    assert.deepEqual(result.details, { question: QUESTION, options: OPTIONS, choice: "SQLite", index: 1 });
    assert.equal(calls.input.length, 0);
  });

  it("asks for a typed answer from the last row, and counts an empty one as dismissed", async () => {
    const { mod, tool } = await loadTool();
    const params = { question: QUESTION, options: OPTIONS, allow_other: true };
    const pickOther = () => mod.ASK_USER_CHOICE_OTHER_ROW;

    const typed = uiContext({ select: pickOther, input: () => "DuckDB, in memory" });
    const answered = await run(tool, params, typed.ctx);
    assert.equal(typed.calls.input.length, 1);
    assert.equal(typed.calls.input[0].title, QUESTION);
    assert.notEqual(answered.isError, true);
    assert.match(text(answered), /DuckDB, in memory$/);
    assert.deepEqual(answered.details, { question: QUESTION, options: OPTIONS, choice: "DuckDB, in memory", other: true });

    for (const empty of ["", "   ", undefined]) {
      const blank = uiContext({ select: pickOther, input: () => empty });
      const result = await run(tool, params, blank.ctx);
      assert.notEqual(result.isError, true);
      assert.deepEqual(result.details, { question: QUESTION, options: OPTIONS, dismissed: true }, JSON.stringify(empty));
    }
  });

  it("tells the model the user did not choose when the dialog is closed, without an error", async () => {
    const { tool } = await loadTool();
    const { ctx } = uiContext({ select: () => undefined });
    const result = await run(tool, { question: QUESTION, options: OPTIONS }, ctx);
    assert.notEqual(result.isError, true);
    assert.match(text(result), /without choosing/);
    assert.match(text(result), /plain text/);
    assert.match(text(result), /assum/);
    assert.deepEqual(result.details, { question: QUESTION, options: OPTIONS, dismissed: true });
  });

  it("closes the dialog when the call is aborted and reports the question as cancelled", async () => {
    const { tool } = await loadTool();
    const activity = await importSource("extensions/ampi-core/tool-activity.ts");
    const controller = new AbortController();
    let closedBySignal = false;
    // Like Pi's dialog: it stays open until the signal it was given fires.
    const { ctx } = uiContext({
      select: (_title, _rows, opts) =>
        new Promise((resolve) => {
          opts.signal.addEventListener("abort", () => {
            closedBySignal = true;
            resolve(undefined);
          });
        }),
    });
    const pending = run(tool, { question: QUESTION, options: OPTIONS }, ctx, controller.signal);
    await Promise.resolve();
    controller.abort();
    const result = await pending;
    assert.equal(closedBySignal, true);
    assert.equal(result.isError, true);
    assert.deepEqual(result.details, { question: QUESTION, options: OPTIONS, cancelled: true });
    assert.equal(activity.resultStatus(true, result), "cancelled");
  });
});

describe("ask_user_choice without a UI", () => {
  it("fails at once, saying nobody can answer, and never opens a dialog", async () => {
    const { tool } = await loadTool();
    const { ctx } = createMockExtensionContext({ hasUI: false });
    ctx.ui.select = () => {
      throw new Error("select must not be called without a UI");
    };
    const result = await run(tool, { question: QUESTION, options: OPTIONS, allow_other: true }, ctx);
    assert.equal(result.isError, true);
    assert.match(text(result), /No one can answer/);
    assert.match(text(result), /Decide yourself/);
    assert.deepEqual(result.details, { question: QUESTION, options: OPTIONS, noUI: true });
  });
});

describe("ask_user_choice ownership", () => {
  it("is registered by ampi-tasks as an ampi-owned tool", async () => {
    const tasks = await importSource("extensions/ampi-tasks/index.ts");
    const owned = await importSource("extensions/ampi-core/owned-tools.ts");
    const { pi, tools } = createMockPi();
    tasks.default(pi);
    assert.ok(tools.has("ask_user_choice"));
    assert.equal(tools.get("ask_user_choice").executionMode, "sequential");
    assert.equal(owned.isAmpiOwnedTool("ask_user_choice"), true);
    // Free mode drops it, like every ampi-owned tool.
    assert.equal(owned.shouldDropToolForFreeMode("ask_user_choice", [{ name: "ask_user_choice" }]), true);
  });

  it("is in the ampi-tasks manifest entry and credited to ampi-tasks by the status catalog", async () => {
    const { MMR_EXTENSION_MANIFEST } = await importSource("extensions/manifest.ts");
    const { resolveMmrTools } = await importSource("extensions/ampi-core/tool-registry.ts");
    const entry = MMR_EXTENSION_MANIFEST.find((candidate) => candidate.name === "ampi-tasks");
    assert.deepEqual(entry?.tools, ["task_list", "ask_user_choice"]);
    // Without the extension loaded, the catalog still names its owner.
    const [decision] = resolveMmrTools(["ask_user_choice"], []).decisions;
    assert.equal(decision.status, "deferred");
    assert.equal(decision.owner, "ampi-tasks");
  });

  it("is offered in every locked mode and to no subagent", async () => {
    const { MMR_MODES } = await importSource("extensions/ampi-core/modes.ts");
    const policy = await importSource("extensions/ampi-core/subagent-tool-policy.ts");
    const profiles = await importSource("extensions/ampi-core/subagent-profiles.ts");
    for (const mode of ["low", "medium", "high", "ultra"]) {
      assert.ok(MMR_MODES[mode].tools.includes("ask_user_choice"), mode);
    }
    assert.equal(MMR_MODES.free.tools.includes("ask_user_choice"), false);
    for (const list of [policy.MMR_SUBAGENT_READ_ONLY_TOOLS, policy.MMR_SUBAGENT_READ_WRITE_TOOLS, policy.MMR_SUBAGENT_CUSTOM_DEFAULT_TOOLS]) {
      assert.equal(list.includes("ask_user_choice"), false);
    }
    const names = profiles.listMmrSubagentProfiles();
    assert.ok(names.length > 0);
    for (const name of names) {
      assert.equal(profiles.getMmrSubagentProfile(name).tools.includes("ask_user_choice"), false, name);
    }
  });
});

describe("ask_user_choice transcript row", () => {
  const title = (mod, activity, status) => mod.activityTitle(activity, status).map((part) => part.text).join("");

  it("shows the question while asking and adds the answer once asked", async () => {
    const mod = await importSource("extensions/ampi-core/tool-activity.ts");
    const args = { question: QUESTION, options: OPTIONS, allow_other: true };
    const asking = mod.classifyToolCall("ask_user_choice", args);
    assert.equal(title(mod, asking, "running"), `Asking ${QUESTION}`);
    const chose = mod.classifyToolCall("ask_user_choice", args, {
      result: { content: [], details: { question: QUESTION, options: OPTIONS, choice: "SQLite", index: 1 } },
    });
    assert.equal(title(mod, chose, "done"), `Asked ${QUESTION} → SQLite`);
    const typed = mod.classifyToolCall("ask_user_choice", args, {
      result: { content: [], details: { question: QUESTION, options: OPTIONS, choice: "DuckDB", other: true } },
    });
    assert.equal(title(mod, typed, "done"), `Asked ${QUESTION} → DuckDB`);
    const dismissed = mod.classifyToolCall("ask_user_choice", args, {
      result: { content: [], details: { question: QUESTION, options: OPTIONS, dismissed: true } },
    });
    assert.equal(title(mod, dismissed, "done"), `Asked ${QUESTION} → no answer`);
  });

  it("keeps a row of its own instead of folding into a group of calls", async () => {
    const runs = await importSource("extensions/ampi-core/activity-runs.ts");
    assert.equal(runs.standsAlone("ask_user_choice", undefined, false), true);
    assert.equal(runs.standsAlone("task_list", undefined, false), false);
  });
});
